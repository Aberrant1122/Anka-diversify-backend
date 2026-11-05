import { baselineOperationView } from "./baseline-read-model";
import {
  Prisma,
  PrismaClient,
  BaselineValidationOperation,
} from "@prisma/client";
import { randomUUID } from "crypto";
import {
  BaselineValidationBinding,
  bindBaselineValidation,
  hash,
  WorkspaceError,
} from "./document-contract";

type Tx = Prisma.TransactionClient;
export function baselinePlan(binding: BaselineValidationBinding) {
  const commands = binding.profiles.flatMap((p) =>
    p.commands.map((c) => ({
      profileId: p.id,
      repositoryId: p.repositoryId,
      baseline: p.baseline,
      runtimeProfileHash: p.runtimeProfileHash,
      budgetProfileHash: p.budgetProfile.hash,
      ...c,
    })),
  );
  const totalTimeoutMs = binding.profiles.reduce(
    (n, p) => n + p.budgetProfile.limits.totalTimeoutMs,
    0,
  );
  if (
    !commands.length ||
    commands.length > 8 ||
    totalTimeoutMs > 120000 ||
    new Set(commands.map((c) => JSON.stringify([c.profileId, c.id]))).size !==
      commands.length
  )
    throw new WorkspaceError("COMMAND_BUDGET_EXCEEDED", 422);
  if (new Set(binding.profiles.map((p) => p.runtimeProfileHash)).size !== 1)
    throw new WorkspaceError("BASELINE_RUNTIME_PROFILE_CONFLICT", 422);
  // V3 must execute these profiles sequentially, never sum their concurrency.
  const limits = {
    totalTimeoutMs,
    ...Object.fromEntries(
      ["memoryMiB", "workMiB", "tmpMiB", "stdoutBytes", "stderrBytes"].map(
        (k) => [
          k,
          Math.max(
            ...binding.profiles.map((p) => (p.budgetProfile.limits as any)[k]),
          ),
        ],
      ),
    ),
  };
  return { commands, limits, executionOrder: "SEQUENTIAL_PROFILES" as const };
}
export interface AdmissionReceipt {
  operationId: string;
  jobId: string;
  bindingHash: string;
  planHash: string;
  evidenceClass: "CONTRACT_TEST" | "DYNAMIC_ISOLATED_COMMAND_CHECKS";
  imageDigest: string;
  runtime: "runsc" | "kata-runtime";
  profiles: {
    profileId: string;
    runtimeProfileHash: string;
    budgetProfileHash: string;
    measurementHash: string;
    acceptedRecordId: string;
    runtimeAcceptanceVerified: boolean;
    measurementAcceptanceVerified: boolean;
  }[];
}
export interface ExecutionReceipt extends AdmissionReceipt {
  results: {
    profileId: string;
    repositoryId: string;
    id: string;
    criterionId: string;
    exitCode: number | null;
    timedOut: boolean;
    outputLimitExceeded: boolean;
  }[];
}
export interface CleanupReceipt {
  operationId: string;
  jobId: string;
  confirmed: boolean;
  recordId: string;
}
// Only trusted server composition may supply this read-only store. No HTTP path
// registers attestations or accepts receipt bodies. Matching user digests alone
// can never establish admission, completion, or cleanup.
export interface BaselineEvidenceStore {
  admission(
    operation: BaselineValidationOperation,
    recordId: string,
  ): Promise<AdmissionReceipt | null>;
  execution(
    operation: BaselineValidationOperation,
    recordId: string,
  ): Promise<ExecutionReceipt | null>;
  cleanup(
    operation: BaselineValidationOperation,
    recordId: string,
  ): Promise<CleanupReceipt | null>;
}
const unavailable: BaselineEvidenceStore = {
  admission: async () => null,
  execution: async () => null,
  cleanup: async () => null,
};
export interface BaselineDocumentSelection {
  mainId: string;
  mainHash: string;
  architectureId: string;
  architectureHash: string;
  selectedProfileIds: string[];
}
export interface BaselineApprovalInput extends BaselineDocumentSelection {
  expectedVersion: number;
  idempotencyKey: string;
  expectedBindingHash: string;
  expectedPlanHash: string;
}
export interface BaselineRunInput {
  approvalId: string;
  expectedVersion: number;
  idempotencyKey: string;
  expectedBindingHash: string;
  expectedPlanHash: string;
  retryOfOperationId: string | null;
}
export interface BaselineClaimInput {
  runId: string;
  expectedVersion: number;
  idempotencyKey: string;
  expectedBindingHash: string;
  expectedPlanHash: string;
}
const selectionKeys = [
  "mainId",
  "mainHash",
  "architectureId",
  "architectureHash",
  "selectedProfileIds",
];
function input(raw: any, keys: string[]) {
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    Object.keys(raw).some((k) => !keys.includes(k)) ||
    keys.some((k) => !(k in raw))
  )
    throw new WorkspaceError("BASELINE_INPUT_INVALID", 422);
  if (
    "expectedVersion" in raw &&
    (!Number.isSafeInteger(raw.expectedVersion) || raw.expectedVersion < 0)
  )
    throw new WorkspaceError("BASELINE_INPUT_INVALID", 422);
  if (
    "idempotencyKey" in raw &&
    !/^[a-zA-Z0-9-]{8,100}$/.test(raw.idempotencyKey || "")
  )
    throw new WorkspaceError("BASELINE_INPUT_INVALID", 422);
}
const requireHash = (actual: string, expected: string) => {
  if (actual !== expected)
    throw new WorkspaceError("BASELINE_BINDING_MISMATCH");
};
export class BaselineValidationService {
  constructor(
    private db: PrismaClient,
    private evidence: BaselineEvidenceStore = unavailable,
  ) {}
  private async tx<T>(work: (tx: Tx) => Promise<T>) {
    try {
      return await this.db.$transaction(work, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 30000,
      });
    } catch (e: any) {
      if (["P2034", "P2002"].includes(e?.code))
        throw new WorkspaceError("STATE_CONFLICT");
      throw e;
    }
  }
  private async owner(tx: Tx, projectId: string, actor: string) {
    if (
      !actor ||
      !projectId ||
      !(await tx.project.findFirst({
        where: { id: projectId, userId: actor, user: { status: "active" } },
        select: { id: true },
      }))
    )
      throw new WorkspaceError("PROJECT_RESOURCE_NOT_FOUND", 404);
  }
  private async head(tx: Tx, projectId: string) {
    return tx.workspaceHead.upsert({
      where: { projectId },
      create: { projectId },
      update: {},
    });
  }
  private async advance(
    tx: Tx,
    projectId: string,
    expectedVersion: number,
    data: object = {},
  ) {
    const r = await tx.workspaceHead.updateMany({
      where: { projectId, stateVersion: expectedVersion },
      data: { ...data, stateVersion: { increment: 1 } },
    });
    if (r.count !== 1) throw new WorkspaceError("STATE_CONFLICT");
  }
  private async event(
    tx: Tx,
    projectId: string,
    actor: string,
    kind: string,
    payload: any,
    runId?: string,
  ) {
    return tx.workspaceEvent.create({
      data: {
        projectId,
        createdBy: actor,
        kind: "BASELINE_VALIDATION_" + kind,
        payload,
        runId,
      },
    });
  }
  private async binding(
    tx: Tx,
    projectId: string,
    selection: BaselineDocumentSelection,
  ) {
    const head = await this.head(tx, projectId);
    if (
      head.mainId !== selection.mainId ||
      head.architectureId !== selection.architectureId
    )
      throw new WorkspaceError("BASELINE_AUTHORITY_CHANGED");
    const main = await tx.workspaceDocument.findFirst({
        where: { id: selection.mainId, projectId, kind: "MAIN" },
      }),
      architecture = await tx.workspaceDocument.findFirst({
        where: {
          id: selection.architectureId,
          projectId,
          kind: "ARCHITECTURE",
        },
      });
    if (
      !main ||
      !architecture ||
      main.contentHash !== selection.mainHash ||
      architecture.contentHash !== selection.architectureHash
    )
      throw new WorkspaceError("DOCUMENT_HASH_MISMATCH");
    if (!Array.isArray(selection.selectedProfileIds))
      throw new WorkspaceError("BASELINE_INPUT_INVALID", 422);
    const binding = bindBaselineValidation(
      main,
      architecture,
      [...selection.selectedProfileIds].sort(),
    );
    const repositories = await tx.projectRepository.findMany({
      where: {
        projectId,
        id: { in: [...new Set(binding.profiles.map((p) => p.repositoryId))] },
      },
    });
    if (
      binding.profiles.some(
        (p) =>
          !repositories.some(
            (r) =>
              r.id === p.repositoryId && r.currentIndexedCommit === p.baseline,
          ),
      )
    )
      throw new WorkspaceError("BASELINE_REPOSITORY_CHANGED");
    const plan = baselinePlan(binding);
    return { binding, bindingHash: hash(binding), plan, planHash: hash(plan) };
  }
  private async authority(
    tx: Tx,
    projectId: string,
    actor: string,
    approvalId: string,
  ) {
    await this.owner(tx, projectId, actor);
    const head = await this.head(tx, projectId),
      approval = await tx.workspaceApproval.findFirst({
        where: { id: approvalId, projectId, purpose: "BASELINE_VALIDATION" },
      });
    if (
      !approval ||
      head.baselineApprovalId !== approval.id ||
      approval.createdBy !== actor
    )
      throw new WorkspaceError("BASELINE_AUTHORITY_CHANGED");
    const saved = approval.snapshot as any;
    const current = await this.binding(tx, projectId, {
      mainId: approval.mainId,
      mainHash: saved.binding?.main?.hash,
      architectureId: approval.architectureId,
      architectureHash: saved.binding?.architecture?.hash,
      selectedProfileIds: saved.binding?.selectedProfileIds,
    });
    requireHash(current.bindingHash, saved.bindingHash);
    requireHash(current.planHash, saved.planHash);
    return { approval, head, snapshot: saved, ...current };
  }
  private async operation(tx: Tx, projectId: string, id: string) {
    const op = await tx.baselineValidationOperation.findFirst({
      where: { id, projectId },
    });
    if (!op) throw new WorkspaceError("BASELINE_OPERATION_NOT_FOUND", 404);
    return op;
  }
  private publicOperation(op: BaselineValidationOperation, current = false) {
    return baselineOperationView(op,current);
  }
  async preview(
    projectId: string,
    actor: string,
    selection: BaselineDocumentSelection,
  ) {
    input(selection, selectionKeys);
    return this.tx(async (tx) => {
      await this.owner(tx, projectId, actor);
      return {
        ...(await this.binding(tx, projectId, selection)),
        dispatchAvailable: false,
        runtimeAcceptanceVerified: false,
      };
    });
  }
  async approve(
    projectId: string,
    actor: string,
    request: BaselineApprovalInput,
  ) {
    input(request, [
      ...selectionKeys,
      "expectedVersion",
      "idempotencyKey",
      "expectedBindingHash",
      "expectedPlanHash",
    ]);
    return this.tx(async (tx) => {
      await this.owner(tx, projectId, actor);
      const exact = await this.binding(tx, projectId, request);
      requireHash(exact.bindingHash, request.expectedBindingHash);
      requireHash(exact.planHash, request.expectedPlanHash);
      const requestHash = hash({
          ...request,
          selectedProfileIds: exact.binding.selectedProfileIds,
        }),
        head = await this.head(tx, projectId);
      const old = await tx.workspaceApproval.findUnique({
        where: {
          projectId_purpose_baselineRequestKey: {
            projectId,
            purpose: "BASELINE_VALIDATION",
            baselineRequestKey: request.idempotencyKey,
          },
        },
      });
      if (old) {
        if ((old.snapshot as any).requestHash !== requestHash)
          throw new WorkspaceError("IDEMPOTENCY_CONFLICT");
        if (old.createdBy !== actor || old.id !== head.baselineApprovalId)
          throw new WorkspaceError("BASELINE_AUTHORITY_CHANGED");
        return old;
      }
      if (head.stateVersion !== request.expectedVersion)
        throw new WorkspaceError("STATE_CONFLICT");
      const approval = await tx.workspaceApproval.create({
        data: {
          projectId,
          purpose: "BASELINE_VALIDATION",
          baselineRequestKey: request.idempotencyKey,
          mainId: request.mainId,
          architectureId: request.architectureId,
          createdBy: actor,
          snapshot: {
            ...exact,
            requestHash,
            idempotencyKey: request.idempotencyKey,
          } as any,
        },
      });
      await this.advance(tx, projectId, request.expectedVersion, {
        baselineApprovalId: approval.id,
      });
      await this.event(tx, projectId, actor, "APPROVED", {
        approvalId: approval.id,
        bindingHash: exact.bindingHash,
        planHash: exact.planHash,
        dispatchAvailable: false,
      });
      return approval;
    });
  }
  private async outstanding(tx: Tx, projectId: string) {
    if (await tx.baselineValidationOperation.findFirst({ where: { projectId, status: { in: ['PREPARING','RUNNING','CLEANUP_REQUIRED'] } } }))
      throw new WorkspaceError('BASELINE_CLEANUP_REQUIRED');
  }
  async authorize(projectId: string, actor: string, request: BaselineRunInput) {
    input(request, [
      "approvalId",
      "expectedVersion",
      "idempotencyKey",
      "expectedBindingHash",
      "expectedPlanHash",
      "retryOfOperationId",
    ]);
    if (
      request.retryOfOperationId !== null &&
      typeof request.retryOfOperationId !== "string"
    )
      throw new WorkspaceError("BASELINE_INPUT_INVALID", 422);
    return this.tx(async (tx) => {
      const current = await this.authority(
          tx,
          projectId,
          actor,
          request.approvalId,
        ),
        requestHash = hash(request);
      requireHash(current.bindingHash, request.expectedBindingHash);
      requireHash(current.planHash, request.expectedPlanHash);
      const old = await tx.workspaceRun.findUnique({
        where: {
          projectId_idempotencyKey: {
            projectId,
            idempotencyKey: request.idempotencyKey,
          },
        },
      });
      if (old) {
        if (
          old.purpose !== "BASELINE_VALIDATION" ||
          (old.authority as any).requestHash !== requestHash
        )
          throw new WorkspaceError("IDEMPOTENCY_CONFLICT");
        return old;
      }
      if (current.head.stateVersion !== request.expectedVersion)
        throw new WorkspaceError("STATE_CONFLICT");
      await this.outstanding(tx, projectId);
      const predecessor = await tx.baselineValidationOperation.findFirst({where:{projectId},orderBy:{createdAt:'desc'}});
      if (predecessor && ['FAILED','CONFLICTED'].includes(predecessor.status) && request.retryOfOperationId !== predecessor.id)
        throw new WorkspaceError('BASELINE_RETRY_LINK_REQUIRED');
      if (request.retryOfOperationId) {
        const prior = await this.operation(
          tx,
          projectId,
          request.retryOfOperationId,
        );
        if (!["FAILED", "CONFLICTED"].includes(prior.status) || !(prior.result as any)?.cleanup?.confirmed || (prior.result as any).cleanup.jobId !== prior.jobId || (prior.result as any).cleanup.operationId !== prior.id)
          throw new WorkspaceError("BASELINE_CLEANUP_REQUIRED");
      }
      const run = await tx.workspaceRun.create({
        data: {
          projectId,
          approvalId: current.approval.id,
          purpose: "BASELINE_VALIDATION",
          idempotencyKey: request.idempotencyKey,
          createdBy: actor,
          authority: {
            ...current.snapshot,
            approvalId: current.approval.id,
            requestHash,
            retryOfOperationId: request.retryOfOperationId,
          } as any,
        },
      });
      await this.advance(tx, projectId, request.expectedVersion);
      await this.event(
        tx,
        projectId,
        actor,
        "AUTHORIZED",
        {
          bindingHash: current.bindingHash,
          planHash: current.planHash,
          approvalId: current.approval.id,
        },
        run.id,
      );
      return run;
    });
  }
  async claim(projectId: string, actor: string, request: BaselineClaimInput) {
    input(request, [
      "runId",
      "expectedVersion",
      "idempotencyKey",
      "expectedBindingHash",
      "expectedPlanHash",
    ]);
    return this.tx(async (tx) => {
      await this.owner(tx, projectId, actor);
      const run = await tx.workspaceRun.findFirst({
        where: { id: request.runId, projectId, purpose: "BASELINE_VALIDATION" },
      });
      if (!run || run.createdBy !== actor)
        throw new WorkspaceError("BASELINE_RUN_NOT_FOUND", 404);
      const current = await this.authority(
          tx,
          projectId,
          actor,
          run.approvalId,
        ),
        runAuthority = run.authority as any;
      requireHash(current.bindingHash, runAuthority.bindingHash);
      requireHash(current.planHash, runAuthority.planHash);
      requireHash(current.bindingHash, request.expectedBindingHash);
      requireHash(current.planHash, request.expectedPlanHash);
      const inputHash = hash(request),
        old = await tx.baselineValidationOperation.findUnique({
          where: {
            projectId_idempotencyKey: {
              projectId,
              idempotencyKey: request.idempotencyKey,
            },
          },
        });
      if (old) {
        if (old.inputHash !== inputHash || old.runId !== run.id)
          throw new WorkspaceError("IDEMPOTENCY_CONFLICT");
        if (current.head.stateVersion !== old.stateVersion)
          throw new WorkspaceError("BASELINE_AUTHORITY_CHANGED");
        return { operation: this.publicOperation(old, true), reused: true };
      }
      if (
        await tx.baselineValidationOperation.findUnique({
          where: { runId: run.id },
        })
      )
        throw new WorkspaceError("BASELINE_OPERATION_ALREADY_CLAIMED");
      if (current.head.stateVersion !== request.expectedVersion)
        throw new WorkspaceError("STATE_CONFLICT");
      await this.outstanding(tx, projectId);
      const predecessor = await tx.baselineValidationOperation.findFirst({where:{projectId},orderBy:{createdAt:'desc'}});
      if (predecessor && ['FAILED','CONFLICTED'].includes(predecessor.status) && runAuthority.retryOfOperationId !== predecessor.id)
        throw new WorkspaceError('BASELINE_RETRY_LINK_REQUIRED');
      const id = randomUUID();
      await this.advance(tx, projectId, request.expectedVersion);
      const operation = await tx.baselineValidationOperation.create({
        data: {
          id,
          projectId,
          runId: run.id,
          purpose: "BASELINE_VALIDATION",
          idempotencyKey: request.idempotencyKey,
          inputHash,
          stateVersion: request.expectedVersion + 1,
          authority: runAuthority,
          createdBy: actor,
          jobId: "anka-baseline-" + id,
          status: "PREPARING",
        },
      });
      await this.event(
        tx,
        projectId,
        actor,
        "PREPARING",
        {
          operationId: id,
          bindingHash: current.bindingHash,
          planHash: current.planHash,
          dispatchAvailable: false,
        },
        run.id,
      );
      return { operation: this.publicOperation(operation), reused: false };
    });
  }
  async view(projectId: string, actor: string) {
    return this.tx(async (tx) => {
      await this.owner(tx, projectId, actor);
      return {
        head: await this.head(tx, projectId),
        operations: await Promise.all(
          (
            await tx.baselineValidationOperation.findMany({
              where: { projectId },
              orderBy: { createdAt: "asc" },
            })
          ).map(async (op) => {
            const id=(op.authority as any)?.binding?.main?.id;
            const main=typeof id==='string'?await tx.workspaceDocument.findFirst({where:{id,projectId,kind:'MAIN'}}):null;
            return baselineOperationView(op,await this.current(tx,op),main);
          }),
        ),
        dispatchAvailable: false,
        runtimeAcceptanceVerified: false,
      };
    });
  }
  async dispatch(projectId: string, actor: string, id: string): Promise<never> {
    return this.tx(async (tx) => {
      await this.owner(tx, projectId, actor);
      await this.operation(tx, projectId, id);
      throw new WorkspaceError("BASELINE_RUNTIME_UNAVAILABLE", 503);
    });
  }
  private async current(tx: Tx, op: BaselineValidationOperation) {
    try {
      const a = await this.authority(
        tx,
        op.projectId,
        op.createdBy,
        (op.authority as any).approvalId,
      );
      return (
        a.head.stateVersion === op.stateVersion &&
        a.bindingHash === (op.authority as any).bindingHash &&
        a.planHash === (op.authority as any).planHash
      );
    } catch (e) {
      if (e instanceof WorkspaceError) return false;
      throw e;
    }
  }
  private verifyAdmission(
    op: BaselineValidationOperation,
    r: AdmissionReceipt | null,
  ): asserts r is AdmissionReceipt {
    const a = op.authority as any;
    if (
      !r ||
      r.operationId !== op.id ||
      r.jobId !== op.jobId ||
      r.bindingHash !== a.bindingHash ||
      r.planHash !== a.planHash ||
      !["CONTRACT_TEST", "DYNAMIC_ISOLATED_COMMAND_CHECKS"].includes(
        r.evidenceClass,
      ) ||
      !/^sha256:[a-f0-9]{64}$/.test(r.imageDigest) ||
      !["runsc", "kata-runtime"].includes(r.runtime) ||
      !Array.isArray(r.profiles) ||
      r.profiles.length !== a.binding.profiles.length
    )
      throw new WorkspaceError("TRUSTED_BASELINE_EVIDENCE_REQUIRED", 503);
    for (let i = 0; i < r.profiles.length; i++) {
      const p = a.binding.profiles[i],
        v = r.profiles[i];
      if (
        v.profileId !== p.id ||
        v.runtimeProfileHash !== p.runtimeProfileHash ||
        v.budgetProfileHash !== p.budgetProfile.hash ||
        v.measurementHash !== p.budgetProfile.measurementHash ||
        !v.acceptedRecordId ||
        (r.evidenceClass !== "CONTRACT_TEST" &&
          (!v.runtimeAcceptanceVerified || !v.measurementAcceptanceVerified))
      )
        throw new WorkspaceError("TRUSTED_BASELINE_EVIDENCE_REQUIRED", 503);
    }
    // Typed assertions alone cannot enable an unaccepted runtime.
    if (r.evidenceClass === 'DYNAMIC_ISOLATED_COMMAND_CHECKS')
      throw new WorkspaceError('BASELINE_RUNTIME_UNAVAILABLE', 503);
  }
  // Worker-only receipt consumers. Never routed to HTTP and never launch jobs.
  async recordStarted(projectId: string, id: string, recordId: string) {
    return this.tx(async (tx) => {
      const op = await this.operation(tx, projectId, id),
        receipt = await this.evidence.admission(op, recordId);
      this.verifyAdmission(op, receipt);
      if (op.status !== "PREPARING")
        throw new WorkspaceError("BASELINE_STATE_CONFLICT");
      if (!(await this.current(tx, op)))
        throw new WorkspaceError("BASELINE_AUTHORITY_CHANGED");
      await this.transition(tx, op, "RUNNING", {
        admission: receipt,
        admissionRecordId: recordId,
      });
    });
  }
  private async transition(
    tx: Tx,
    op: BaselineValidationOperation,
    status: string,
    result: any,
    actor = op.createdBy,
    origin = "TRUSTED_WORKER_RECEIPT",
  ) {
    const updated = await tx.baselineValidationOperation.updateMany({
      where: { id: op.id, projectId: op.projectId, status: op.status },
      data: { status, result, updatedAt: new Date() },
    });
    if (updated.count !== 1)
      throw new WorkspaceError("BASELINE_STATE_CONFLICT");
    await this.event(
      tx,
      op.projectId,
      actor,
      status,
      { operationId: op.id, origin, initiatingActor: op.createdBy, result },
      op.runId,
    );
    return { operationId: op.id, status };
  }
  async recordResult(projectId: string, id: string, recordId: string) {
    return this.tx(async (tx) => {
      const op = await this.operation(tx, projectId, id);
      if (op.status !== "RUNNING")
        throw new WorkspaceError("BASELINE_STATE_CONFLICT");
      const receipt = await this.evidence.execution(op, recordId);
      this.verifyAdmission(op, receipt);
      const r = receipt as ExecutionReceipt,
        plan = (op.authority as any).plan;
      if (
        !Array.isArray(r.results) ||
        r.results.length !== plan.commands.length ||
        r.results.some((v, i) => {
          const c = plan.commands[i];
          return (
            v.profileId !== c.profileId ||
            v.repositoryId !== c.repositoryId ||
            v.id !== c.id ||
            v.criterionId !== c.criterionId ||
            !(v.exitCode === null || Number.isInteger(v.exitCode)) ||
            typeof v.timedOut !== "boolean" ||
            typeof v.outputLimitExceeded !== "boolean"
          );
        })
      )
        throw new WorkspaceError("BASELINE_RESULT_INVALID");
      const { results: _, ...admission } = r;
      if (hash(admission) !== hash((op.result as any).admission))
        throw new WorkspaceError("BASELINE_ADMISSION_CHANGED");
      return this.transition(tx, op, "CLEANUP_REQUIRED", {
        execution: r,
        executionRecordId: recordId,
        authorityCurrentAtResult: await this.current(tx, op),
      });
    });
  }
  async requestCleanup(projectId: string, actor: string, id: string) {
    return this.tx(async (tx) => {
      await this.owner(tx, projectId, actor);
      const op = await this.operation(tx, projectId, id);
      if (op.status === "CLEANUP_REQUIRED")
        return { operationId: id, status: op.status };
      if (!["PREPARING", "RUNNING"].includes(op.status))
        throw new WorkspaceError("BASELINE_STATE_CONFLICT");
      return this.transition(
        tx,
        op,
        "CLEANUP_REQUIRED",
        { interrupted: true, requestedBy: actor },
        actor,
        "OWNER_REQUEST",
      );
    });
  }
  async confirmCleanup(projectId: string, id: string, recordId: string) {
    return this.tx(async (tx) => {
      const op = await this.operation(tx, projectId, id);
      if (op.status !== "CLEANUP_REQUIRED")
        throw new WorkspaceError("BASELINE_STATE_CONFLICT");
      const cleanup = await this.evidence.cleanup(op, recordId);
      if (
        !cleanup ||
        !cleanup.confirmed ||
        cleanup.operationId !== op.id ||
        cleanup.jobId !== op.jobId ||
        cleanup.recordId !== recordId
      )
        throw new WorkspaceError("BASELINE_CLEANUP_UNCONFIRMED", 503);
      const pending = op.result as any,
        current =
          (await this.current(tx, op)) &&
          pending?.authorityCurrentAtResult !== false,
        execution = pending?.execution as ExecutionReceipt | undefined;
      const passed =
          !!execution &&
          execution.results.every(
            (r) => r.exitCode === 0 && !r.timedOut && !r.outputLimitExceeded,
          ),
        contract = execution?.evidenceClass === "CONTRACT_TEST";
      const status = !current ? "CONFLICTED" : passed ? "COMPLETED" : "FAILED";
      return this.transition(tx, op, status, {
        ...pending,
        cleanup,
        cleanupRecordId: recordId,
        authorityCurrent: current,
        passed,
        acceptedForCurrentAuthority: current && passed && !contract,
        evidenceClass: execution?.evidenceClass ?? "NO_EXECUTION",
        outcome: !current
          ? "STALE"
          : contract && passed
            ? "CONTRACT_TEST_PASSED"
            : passed
              ? "PASSED"
              : "FAILED",
      });
    });
  }
}
