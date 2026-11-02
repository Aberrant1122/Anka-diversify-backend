import { PrismaClient, Prisma } from "@prisma/client";
import { randomUUID } from "crypto";
import {
  parseMain,
  parseArchitecture,
  MainDocument,
  ArchitectureDocument,
  mainFromBrief,
  hash,
  changedRequirements,
  affectedUnits,
  WorkspaceError,
} from "./document-contract";

export type SaveDocumentInput = {
  kind: "MAIN" | "ARCHITECTURE";
  content: unknown;
  expectedVersion: number;
  reason: string;
  brief?: string;
};
type Tx = Prisma.TransactionClient;
export class WorkspaceService {
  constructor(private db: PrismaClient) {}
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
  private async transaction<T>(
    projectId: string,
    actor: string,
    work: (tx: Tx) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.db.$transaction(
        async (tx) => {
          await this.owner(tx, projectId, actor);
          return work(tx);
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          timeout: 30000,
        },
      );
    } catch (e: any) {
      if (["P2034", "P2002"].includes(e?.code))
        throw new WorkspaceError("STATE_CONFLICT");
      throw e;
    }
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
    version: number,
    data: object,
  ) {
    const result = await tx.workspaceHead.updateMany({
      where: { projectId, stateVersion: version },
      data: { ...data, stateVersion: { increment: 1 } },
    });
    if (result.count !== 1) throw new WorkspaceError("STATE_CONFLICT");
  }
  private async event(
    tx: Tx,
    projectId: string,
    actor: string,
    kind: string,
    payload: unknown,
    runId?: string,
  ) {
    return tx.workspaceEvent.create({
      data: {
        projectId,
        createdBy: actor,
        kind,
        payload: payload as Prisma.InputJsonValue,
        runId,
      },
    });
  }
  async view(projectId: string, actor: string) {
    const result = await this.transaction(projectId, actor, async (tx) => ({
      head: await this.head(tx, projectId),
      operations: await tx.workspaceOperation.findMany({
        where: { projectId },
        orderBy: { createdAt: "asc" },
      }),
      documents: await tx.workspaceDocument.findMany({
        where: { projectId },
        orderBy: { createdAt: "asc" },
      }),
      approvals: await tx.workspaceApproval.findMany({
        where: { projectId },
        orderBy: { createdAt: "asc" },
      }),
      runs: await tx.workspaceRun.findMany({
        where: { projectId },
        include: { events: { orderBy: { createdAt: "asc" } } },
        orderBy: { createdAt: "asc" },
      }),
      events: await tx.workspaceEvent.findMany({
        where: { projectId },
        orderBy: { createdAt: "asc" },
      }),
      repositories: await tx.projectRepository
        .findMany({
          where: { projectId },
          select: {
            id: true,
            name: true,
            currentIndexedCommit: true,
            localPath: true,
          },
        })
        .then((repositories) =>
          repositories.map((r) => ({
            id: r.id,
            name: r.name,
            currentIndexedCommit: r.currentIndexedCommit,
            materialized: !!r.localPath,
          })),
        ),
    }));
    const main = result.documents.find((d) => d.id === result.head.mainId);
    const approved = result.approvals.find(
      (a) => a.id === result.head.approvalId,
    );
    const snapshot = approved?.snapshot as any;
    const invalidatedUnitIds =
      main && snapshot?.architecture
        ? affectedUnits(
            snapshot.architecture,
            changedRequirements(snapshot.main, parseMain(main.content)),
          )
        : [];
    return {
      ...result,
      readiness: {
        invalidatedUnitIds,
        approvedMainId: approved?.mainId ?? null,
        currentMainId: main?.id ?? null,
      },
    };
  }
  async save(projectId: string, actor: string, input: SaveDocumentInput) {
    if (
      !["MAIN", "ARCHITECTURE"].includes(input.kind) ||
      typeof input.reason !== "string" ||
      !input.reason.trim()
    )
      throw new WorkspaceError("CHANGE_REASON_REQUIRED", 422);
    return this.transaction(projectId, actor, (tx) =>
      this.saveDocument(tx, projectId, actor, input),
    );
  }
  private async saveDocument(
    tx: Tx,
    projectId: string,
    actor: string,
    input: SaveDocumentInput,
  ) {
    const head = await this.head(tx, projectId);
    if (head.stateVersion !== input.expectedVersion)
      throw new WorkspaceError("STATE_CONFLICT");
    const main = head.mainId
      ? await tx.workspaceDocument.findFirst({
          where: { id: head.mainId, projectId, kind: "MAIN" },
        })
      : null;
    const content =
      input.kind === "MAIN"
        ? parseMain(input.brief ? mainFromBrief(input.brief) : input.content)
        : parseArchitecture(input.content, parseMain(main?.content));
    if (input.kind === "ARCHITECTURE") {
      const arch = content as ArchitectureDocument;
      if (
        !main ||
        arch.sourceMain.id !== main.id ||
        arch.sourceMain.hash !== main.contentHash
      )
        throw new WorkspaceError("MAIN_VERSION_MISMATCH");
      const repos = await tx.projectRepository.findMany({
        where: { projectId },
        select: { id: true },
      });
      if (arch.repositories.some((r) => !repos.some((p) => p.id === r.id)))
        throw new WorkspaceError("REPOSITORY_NOT_IN_PROJECT", 422);
    }
    const previousId =
      input.kind === "MAIN" ? head.mainId : head.architectureId;
    const previous = previousId
      ? await tx.workspaceDocument.findFirst({
          where: { id: previousId, projectId },
        })
      : null;
    if (previous?.contentHash === hash(content)) return previous;
    const revision = await tx.workspaceDocument.create({
      data: {
        projectId,
        kind: input.kind,
        version: (previous?.version ?? 0) + 1,
        content: content as any,
        contentHash: hash(content),
        previousId,
        sourceMainId: input.kind === "ARCHITECTURE" ? main!.id : null,
        createdBy: actor,
      },
    });
    await this.advance(
      tx,
      projectId,
      head.stateVersion,
      input.kind === "MAIN"
        ? { mainId: revision.id }
        : { architectureId: revision.id },
    );
    let changed: string[] = [],
      invalidated: string[] = [];
    if (input.kind === "MAIN" && main) {
      changed = changedRequirements(
        parseMain(main.content),
        content as MainDocument,
      );
      if (head.approvalId) {
        const approval = await tx.workspaceApproval.findFirst({
          where: { id: head.approvalId, projectId },
        });
        const snapshot = approval?.snapshot as any;
        if (snapshot?.architecture)
          invalidated = affectedUnits(snapshot.architecture, changed);
      }
    }
    await this.event(tx, projectId, actor, "DOCUMENT_CHANGED", {
      documentId: revision.id,
      kind: input.kind,
      reason: input.reason,
      changedRequirementIds: changed,
      invalidatedUnitIds: invalidated,
    });
    return revision;
  }
  async approve(
    projectId: string,
    actor: string,
    input: {
      architectureId: string;
      architectureHash: string;
      mainId: string;
      mainHash: string;
      expectedVersion: number;
    },
  ) {
    return this.transaction(projectId, actor, async (tx) => {
      const head = await this.head(tx, projectId);
      if (
        head.stateVersion !== input.expectedVersion ||
        head.mainId !== input.mainId ||
        head.architectureId !== input.architectureId
      )
        throw new WorkspaceError("STATE_CONFLICT");
      const [main, architecture] = await Promise.all([
        tx.workspaceDocument.findFirst({
          where: { id: input.mainId, projectId, kind: "MAIN" },
        }),
        tx.workspaceDocument.findFirst({
          where: { id: input.architectureId, projectId, kind: "ARCHITECTURE" },
        }),
      ]);
      if (
        !main ||
        !architecture ||
        main.contentHash !== input.mainHash ||
        architecture.contentHash !== input.architectureHash ||
        hash(main.content) !== main.contentHash ||
        hash(architecture.content) !== architecture.contentHash
      )
        throw new WorkspaceError("DOCUMENT_HASH_MISMATCH");
      const m = parseMain(main.content),
        a = parseArchitecture(architecture.content, m);
      if (a.sourceMain.id !== main.id || a.sourceMain.hash !== main.contentHash)
        throw new WorkspaceError("MAIN_VERSION_MISMATCH");
      if ([...m.questions, ...a.questions].some((q) => q.blocking))
        throw new WorkspaceError("BLOCKING_QUESTIONS");
      if (
        !a.units.length ||
        m.requirements.some(
          (r) => !a.units.some((u) => u.requirementIds.includes(r.id)),
        )
      )
        throw new WorkspaceError("REQUIREMENTS_NOT_MAPPED");
      if (head.approvalId) {
        const prior = await tx.workspaceApproval.findFirst({
          where: {
            id: head.approvalId,
            projectId,
            mainId: main.id,
            architectureId: architecture.id,
          },
        });
        if (prior) return prior;
      }
      const approval = await tx.workspaceApproval.create({
        data: {
          projectId,
          mainId: main.id,
          architectureId: architecture.id,
          createdBy: actor,
          snapshot: {
            main: m,
            architecture: a,
            mainHash: main.contentHash,
            architectureHash: architecture.contentHash,
            mainVersion: main.version,
            architectureVersion: architecture.version,
          } as any,
        },
      });
      await this.advance(tx, projectId, head.stateVersion, {
        approvalId: approval.id,
      });
      await this.event(tx, projectId, actor, "ARCHITECTURE_APPROVED", {
        approvalId: approval.id,
        mainId: main.id,
        architectureId: architecture.id,
      });
      return approval;
    });
  }
  private async readiness(
    tx: Tx,
    projectId: string,
    head: any,
    approval: any,
    unitIds: string[],
  ) {
    const snapshot = approval.snapshot as unknown as {
      main: MainDocument;
      architecture: ArchitectureDocument;
    };
    const main = await tx.workspaceDocument.findFirst({
      where: { id: head.mainId, projectId, kind: "MAIN" },
    });
    if (!main) throw new WorkspaceError("MAIN_REQUIRED");
    const invalid = affectedUnits(
      snapshot.architecture,
      changedRequirements(snapshot.main, parseMain(main.content)),
    );
    if (unitIds.some((id) => invalid.includes(id)))
      throw new WorkspaceError("DOCUMENT_RECONCILIATION_REQUIRED");
    const units = snapshot.architecture.units.filter((u) =>
      unitIds.includes(u.id),
    );
    if (!units.length || units.length !== new Set(unitIds).size)
      throw new WorkspaceError("IMPLEMENTATION_UNITS_REQUIRED", 422);
    for (const unit of units)
      for (const id of unit.dependsOn) {
        // A reviewed diff in a different isolated clone does not prove that
        // its changes exist in this run's baseline. Until publication lineage
        // is available, execute the complete dependency closure together.
        if (invalid.includes(id) || !unitIds.includes(id))
          throw new WorkspaceError("DEPENDENCY_CLOSURE_REQUIRED");
      }
    return { snapshot, units };
  }
  async authorize(
    projectId: string,
    actor: string,
    input: {
      approvalId: string;
      unitIds: string[];
      expectedVersion: number;
      idempotencyKey: string;
      retryOfRunId?: string;
    },
  ) {
    if (
      !Array.isArray(input.unitIds) ||
      input.unitIds.some((id) => typeof id !== "string") ||
      new Set(input.unitIds).size !== input.unitIds.length ||
      !/^[a-zA-Z0-9-]{8,100}$/.test(input.idempotencyKey ?? "")
    )
      throw new WorkspaceError("RUN_INPUT_INVALID", 422);
    return this.transaction(projectId, actor, async (tx) => {
      const old = await tx.workspaceRun.findUnique({
        where: {
          projectId_idempotencyKey: {
            projectId,
            idempotencyKey: input.idempotencyKey,
          },
        },
      });
      if (old) {
        if (
          old.approvalId !== input.approvalId ||
          hash((old.authority as any).unitIds) !== hash(input.unitIds) ||
          ((old.authority as any).retryOfRunId ?? null) !==
            (input.retryOfRunId ?? null)
        )
          throw new WorkspaceError("IDEMPOTENCY_CONFLICT");
        return old;
      }
      const head = await this.head(tx, projectId);
      if (
        head.stateVersion !== input.expectedVersion ||
        head.approvalId !== input.approvalId
      )
        throw new WorkspaceError("STATE_CONFLICT");
      const approval = await tx.workspaceApproval.findFirst({
        where: { id: input.approvalId, projectId },
      });
      if (!approval) throw new WorkspaceError("APPROVED_ARCHITECTURE_REQUIRED");
      const { snapshot, units } = await this.readiness(
        tx,
        projectId,
        head,
        approval,
        input.unitIds,
      );
      let retryEvidence: any = null;
      if (input.retryOfRunId) {
        const parent = await tx.workspaceRun.findFirst({
          where: { id: input.retryOfRunId, projectId },
          include: { events: true },
        });
        if (
          !parent ||
          parent.approvalId !== approval.id ||
          hash((parent.authority as any).unitIds) !== hash(input.unitIds) ||
          parent.events.some(
            (e) =>
              e.kind === "SCOPE_CHANGE_REQUIRED" ||
              e.kind === "REVIEW_VERIFIED",
          )
        )
          throw new WorkspaceError("RETRY_AUTHORITY_MISMATCH");
        const failure = parent.events.find(
          (e) =>
            e.kind === "RUN_FAILED" ||
            (e.kind === "SANDBOX_VALIDATED" &&
              (e.payload as any).result?.passed === false) ||
            (e.kind === "IMPLEMENTED" &&
              (e.payload as any).verification === "CHECKS_FAILED"),
        );
        if (!failure) throw new WorkspaceError("RETRY_NOT_AVAILABLE");
        retryEvidence = {
          kind: failure.kind,
          payload: failure.payload,
          implementation:
            parent.events.find((e) => e.kind === "IMPLEMENTED")?.payload ??
            null,
        };
      }
      const run = await tx.workspaceRun.create({
        data: {
          id: randomUUID(),
          projectId,
          approvalId: approval.id,
          idempotencyKey: input.idempotencyKey,
          createdBy: actor,
          authority: {
            ...snapshot,
            mainId: approval.mainId,
            architectureId: approval.architectureId,
            approvalId: approval.id,
            unitIds: input.unitIds,
            units,
            repositories: snapshot.architecture.repositories,
            stateVersion: head.stateVersion,
            retryOfRunId: input.retryOfRunId ?? null,
            retryEvidence,
          } as any,
        },
      });
      await this.event(
        tx,
        projectId,
        actor,
        "RUN_AUTHORIZED",
        { unitIds: input.unitIds },
        run.id,
      );
      return run;
    });
  }
  async assertRunnable(projectId: string, actor: string, runId: string) {
    return this.transaction(projectId, actor, async (tx) => {
      const run = await tx.workspaceRun.findFirst({
        where: { id: runId, projectId },
        include: { events: true },
      });
      if (!run) throw new WorkspaceError("RUN_NOT_FOUND", 404);
      const head = await this.head(tx, projectId);
      if (head.approvalId !== run.approvalId)
        throw new WorkspaceError("AUTHORITY_SUPERSEDED");
      const approval = await tx.workspaceApproval.findFirst({
        where: { id: run.approvalId, projectId },
      });
      await this.readiness(
        tx,
        projectId,
        head,
        approval,
        (run.authority as any).unitIds,
      );
      return run;
    });
  }
  async retry(
    projectId: string,
    actor: string,
    runId: string,
    input: { expectedVersion: number; idempotencyKey: string },
  ) {
    const parent = await this.assertRunnable(projectId, actor, runId);
    return this.authorize(projectId, actor, {
      approvalId: parent.approvalId,
      unitIds: (parent.authority as any).unitIds,
      expectedVersion: input.expectedVersion,
      idempotencyKey: input.idempotencyKey,
      retryOfRunId: parent.id,
    });
  }
  async record(
    projectId: string,
    actor: string,
    runId: string,
    kind: string,
    payload: unknown,
  ) {
    return this.transaction(projectId, actor, async (tx) => {
      if (
        !(await tx.workspaceRun.findFirst({ where: { id: runId, projectId } }))
      )
        throw new WorkspaceError("RUN_NOT_FOUND", 404);
      return this.event(tx, projectId, actor, kind, payload, runId);
    });
  }
  async executeWithAuthority<T>(
    projectId: string,
    actor: string,
    runId: string,
    work: (run: any) => Promise<T>,
  ) {
    return this.transaction(projectId, actor, async (tx) => {
      // Hold the project authority row while a bounded local mutation runs.
      // Concurrent document changes must serialize behind this same head.
      await tx.$queryRaw`SELECT "projectId" FROM "WorkspaceHead" WHERE "projectId" = ${projectId} FOR UPDATE`;
      const run = await tx.workspaceRun.findFirst({
        where: { id: runId, projectId },
        include: { events: true },
      });
      if (!run) throw new WorkspaceError("RUN_NOT_FOUND", 404);
      if (
        run.events.some((e) =>
          [
            "IMPLEMENTED",
            "REVIEW_VERIFIED",
            "RUN_FAILED",
            "SCOPE_CHANGE_REQUIRED",
          ].includes(e.kind),
        )
      )
        throw new WorkspaceError("RUN_ALREADY_ATTEMPTED");
      const head = await this.head(tx, projectId);
      if (head.approvalId !== run.approvalId)
        throw new WorkspaceError("AUTHORITY_SUPERSEDED");
      const approval = await tx.workspaceApproval.findFirst({
        where: { id: run.approvalId, projectId },
      });
      await this.readiness(
        tx,
        projectId,
        head,
        approval,
        (run.authority as any).unitIds,
      );
      const result = await work(run);
      await this.event(tx, projectId, actor, "IMPLEMENTED", result, runId);
      return result;
    });
  }
  async review(
    projectId: string,
    actor: string,
    runId: string,
    expectedChangeHash: string,
  ) {
    return this.transaction(projectId, actor, async (tx) => {
      const run = await tx.workspaceRun.findFirst({
        where: { id: runId, projectId },
        include: { events: true },
      });
      if (!run) throw new WorkspaceError("RUN_NOT_FOUND", 404);
      const head = await this.head(tx, projectId);
      if (head.approvalId !== run.approvalId)
        throw new WorkspaceError("AUTHORITY_SUPERSEDED");
      const approval = await tx.workspaceApproval.findFirst({
        where: { id: run.approvalId, projectId },
      });
      await this.readiness(
        tx,
        projectId,
        head,
        approval,
        (run.authority as any).unitIds,
      );
      const implemented = run.events.find((e) => e.kind === "IMPLEMENTED")
        ?.payload as any;
      if (!implemented || implemented.changeHash !== expectedChangeHash)
        throw new WorkspaceError("REVIEW_DIFF_MISMATCH");
      if (
        !implemented.checks?.length ||
        implemented.checks.some((c: any) => c.passed !== true)
      )
        throw new WorkspaceError("CHECKS_FAILED");
      if (run.events.some((e) => e.kind === "REVIEW_VERIFIED"))
        throw new WorkspaceError("ALREADY_REVIEWED");
      const commands = (run.authority as any).units.flatMap((u: any) =>
        (u.commands || []).map((c: any) => ({
          ...c,
          unitId: u.id,
          repositoryId: u.repositoryId,
        })),
      );
      const validation = (
        run.events.find((e) => e.kind === "SANDBOX_VALIDATED")?.payload as any
      )?.result;
      if (
        commands.length &&
        (!validation ||
          validation.changeHash !== implemented.changeHash ||
          validation.commandsHash !== hash(commands) ||
          validation.passed !== true ||
          validation.results?.length !== commands.length ||
          validation.results.some((r: any) => r.exitCode !== 0 || r.timedOut))
      )
        throw new WorkspaceError("ISOLATED_VALIDATION_REQUIRED");
      // This verifies only the declared built-in checks, never deployment or
      // real signed-in acceptance, and it cannot accept caller-supplied results.
      return this.event(
        tx,
        projectId,
        actor,
        "REVIEW_VERIFIED",
        {
          unitIds: implemented.unitIds,
          architectureHash: implemented.architectureHash,
          changeHash: implemented.changeHash,
          diffHash: hash(implemented.diffs),
          checks: implemented.checks,
          evidenceClass: commands.length
            ? validation.evidenceClass
            : "DECLARED_STATIC_CHECKS",
          isolatedValidation: commands.length ? validation : null,
        },
        runId,
      );
    });
  }
  async beginRunOperation(
    projectId: string,
    actor: string,
    runId: string,
    input: {
      kind: "VALIDATION" | "PUBLICATION_PREPARE" | "PUBLICATION";
      expectedVersion: number;
      expectedChangeHash: string;
      idempotencyKey: string;
      publicationApprovalId?: string;
    },
  ) {
    if (
      !["VALIDATION", "PUBLICATION_PREPARE", "PUBLICATION"].includes(
        input.kind,
      ) ||
      !/^[a-zA-Z0-9-]{8,100}$/.test(input.idempotencyKey || "") ||
      !/^[a-f0-9]{64}$/.test(input.expectedChangeHash || "")
    )
      throw new WorkspaceError("RUN_OPERATION_INVALID", 422);
    return this.transaction(projectId, actor, async (tx) => {
      const inputHash = hash({ runId, ...input });
      const old = await tx.workspaceOperation.findUnique({
        where: {
          projectId_kind_idempotencyKey: {
            projectId,
            kind: input.kind,
            idempotencyKey: input.idempotencyKey,
          },
        },
      });
      if (old) {
        if (old.inputHash !== inputHash)
          throw new WorkspaceError("IDEMPOTENCY_CONFLICT");
        return { operation: old, reused: true };
      }
      const head = await this.head(tx, projectId);
      if (head.stateVersion !== input.expectedVersion)
        throw new WorkspaceError("STATE_CONFLICT");
      const run = await tx.workspaceRun.findFirst({
        where: { id: runId, projectId },
        include: { events: true },
      });
      if (!run || head.approvalId !== run.approvalId)
        throw new WorkspaceError("AUTHORITY_SUPERSEDED");
      const approval = await tx.workspaceApproval.findFirst({
        where: { id: run.approvalId, projectId },
      });
      await this.readiness(
        tx,
        projectId,
        head,
        approval,
        (run.authority as any).unitIds,
      );
      const implementation = run.events.find((e) => e.kind === "IMPLEMENTED")
        ?.payload as any;
      if (
        !implementation ||
        implementation.changeHash !== input.expectedChangeHash
      )
        throw new WorkspaceError("REVIEW_DIFF_MISMATCH");
      const review = run.events.find((e) => e.kind === "REVIEW_VERIFIED");
      if (
        input.kind !== "VALIDATION" &&
        (!review ||
          (review.payload as any).changeHash !== implementation.changeHash ||
          (review.payload as any).diffHash !== hash(implementation.diffs))
      )
        throw new WorkspaceError("EXACT_REVIEW_REQUIRED");
      const previous = await tx.workspaceOperation.findFirst({
        where: { projectId, runId, kind: input.kind },
      });
      if (previous && input.kind !== "PUBLICATION_PREPARE")
        throw new WorkspaceError(
          input.kind === "PUBLICATION"
            ? "PUBLICATION_ALREADY_ATTEMPTED"
            : "VALIDATION_ALREADY_ATTEMPTED",
        );
      const active = await tx.workspaceOperation.findFirst({
        where: { projectId, runId, kind: input.kind, status: "RUNNING" },
      });
      if (active) throw new WorkspaceError("OPERATION_IN_PROGRESS");
      let publicationApproval: any = null,
        preparation: any = null;
      if (input.kind === "PUBLICATION") {
        publicationApproval = run.events.find(
          (e) =>
            e.id === input.publicationApprovalId &&
            e.kind === "PUBLICATION_APPROVED",
        );
        const permission = publicationApproval?.payload as any;
        preparation = run.events.find(
          (e) =>
            e.id === permission?.preparedEventId &&
            e.kind === "PUBLICATION_PREPARED",
        );
        if (
          !permission ||
          permission.headVersion !== head.stateVersion ||
          Date.parse(permission.expiresAt) <= Date.now() ||
          !preparation ||
          permission.bundleHash !==
            (preparation.payload as any).result.bundleHash
        )
          throw new WorkspaceError("PUBLICATION_APPROVAL_REQUIRED");
      }
      const operation = await tx.workspaceOperation.create({
        data: {
          id: randomUUID(),
          projectId,
          runId,
          kind: input.kind,
          idempotencyKey: input.idempotencyKey,
          stateVersion: head.stateVersion,
          inputHash,
          createdBy: actor,
          context: {
            input,
            authority: run.authority,
            implementation,
            review,
            publicationApproval,
            preparation,
          } as any,
        },
      });
      await this.event(
        tx,
        projectId,
        actor,
        input.kind + "_STARTED",
        { operationId: operation.id, changeHash: implementation.changeHash },
        runId,
      );
      return { operation, reused: false };
    });
  }
  async finishRunOperation(
    projectId: string,
    actor: string,
    operationId: string,
    result: any,
  ) {
    return this.transaction(projectId, actor, async (tx) => {
      const operation = await tx.workspaceOperation.findFirst({
        where: { id: operationId, projectId, status: "RUNNING" },
      });
      if (
        !operation ||
        !operation.runId ||
        !["VALIDATION", "PUBLICATION_PREPARE", "PUBLICATION"].includes(
          operation.kind,
        )
      )
        throw new WorkspaceError("OPERATION_NOT_RUNNING");
      const head = await this.head(tx, projectId),
        context = operation.context as any;
      const stale =
        head.stateVersion !== operation.stateVersion ||
        head.approvalId !== context.authority.approvalId;
      const external = operation.kind === "PUBLICATION";
      const kind =
        stale && !external
          ? operation.kind + "_CONFLICTED"
          : operation.kind === "VALIDATION"
            ? "SANDBOX_VALIDATED"
            : operation.kind === "PUBLICATION_PREPARE"
              ? "PUBLICATION_PREPARED"
              : result.evidenceClass === "CONTRACT_TEST"
                ? "PUBLICATION_CONTRACT_TESTED"
                : result.complete
                  ? "PUBLISHED"
                  : "PUBLICATION_PARTIAL";
      const event = await this.event(
        tx,
        projectId,
        actor,
        kind,
        { operationId, authorityCurrent: !stale, result },
        operation.runId,
      );
      return tx.workspaceOperation.update({
        where: { id: operationId },
        data: {
          status: stale && !external ? "CONFLICTED" : "COMPLETED",
          result: {
            output: result,
            eventId: event.id,
            authorityCurrent: !stale,
          } as any,
          completedAt: new Date(),
        },
      });
    });
  }
  async failRunOperation(
    projectId: string,
    actor: string,
    operationId: string,
    code: string,
  ) {
    return this.transaction(projectId, actor, async (tx) => {
      const op = await tx.workspaceOperation.findFirst({
        where: { id: operationId, projectId, status: "RUNNING" },
      });
      if (!op || !op.runId) return;
      const errorCode =
        op.kind === "PUBLICATION" ? "PUBLICATION_OUTCOME_UNCERTAIN" : code;
      await this.event(
        tx,
        projectId,
        actor,
        op.kind === "VALIDATION" ? "RUN_FAILED" : errorCode,
        { operationId, code: errorCode, stage: op.kind },
        op.runId,
      );
      return tx.workspaceOperation.update({
        where: { id: op.id },
        data: { status: "FAILED", errorCode, completedAt: new Date() },
      });
    });
  }
  async approvePublication(
    projectId: string,
    actor: string,
    runId: string,
    input: {
      preparedEventId: string;
      expectedVersion: number;
      expectedBundleHash: string;
    },
  ) {
    return this.transaction(projectId, actor, async (tx) => {
      const head = await this.head(tx, projectId);
      if (head.stateVersion !== input.expectedVersion)
        throw new WorkspaceError("STATE_CONFLICT");
      const run = await tx.workspaceRun.findFirst({
        where: { id: runId, projectId },
        include: { events: true },
      });
      if (!run || head.approvalId !== run.approvalId)
        throw new WorkspaceError("AUTHORITY_SUPERSEDED");
      const approval = await tx.workspaceApproval.findFirst({
        where: { id: run.approvalId, projectId },
      });
      await this.readiness(
        tx,
        projectId,
        head,
        approval,
        (run.authority as any).unitIds,
      );
      if (
        await tx.workspaceOperation.findFirst({
          where: { projectId, runId, kind: "PUBLICATION" },
        })
      )
        throw new WorkspaceError("PUBLICATION_ALREADY_ATTEMPTED");
      const prepared = run.events.find(
        (e) =>
          e.id === input.preparedEventId && e.kind === "PUBLICATION_PREPARED",
      );
      const bundle = (prepared?.payload as any)?.result;
      if (
        !bundle ||
        bundle.bundleHash !== input.expectedBundleHash ||
        !run.events.some((e) => e.kind === "REVIEW_VERIFIED")
      )
        throw new WorkspaceError("EXACT_REVIEW_REQUIRED");
      const existing = run.events.find(
        (e) =>
          e.kind === "PUBLICATION_APPROVED" &&
          (e.payload as any).preparedEventId === prepared!.id &&
          (e.payload as any).headVersion === head.stateVersion &&
          Date.parse((e.payload as any).expiresAt) > Date.now(),
      );
      return (
        existing ||
        this.event(
          tx,
          projectId,
          actor,
          "PUBLICATION_APPROVED",
          {
            preparedEventId: prepared!.id,
            bundleHash: bundle.bundleHash,
            headVersion: head.stateVersion,
            expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
          },
          runId,
        )
      );
    });
  }
  async importLegacy(
    projectId: string,
    actor: string,
    expectedVersion: number,
  ) {
    const view = await this.view(projectId, actor);
    const [project, artifacts, documents] = await Promise.all([
      this.db.project.findFirst({
        where: { id: projectId, userId: actor },
        select: { description: true },
      }),
      this.db.phaseArtifact.findMany({
        where: { projectId, phase: { in: ["requirements", "documentation"] } },
        orderBy: { createdAt: "asc" },
      }),
      this.db.projectDocument.findMany({
        where: { projectId },
        orderBy: { createdAt: "asc" },
      }),
    ]);
    const sources = [
      ...artifacts.map((a) => "PhaseArtifact:" + a.id + ":" + hash(a.content)),
      ...documents.map(
        (d) => "ProjectDocument:" + d.id + ":" + hash(d.content),
      ),
    ];
    const prior = view.documents.find(
      (d) =>
        d.kind === "MAIN" &&
        hash((d.content as any).legacySources) === hash(sources),
    );
    if (prior) return prior;
    const brief = [
      project?.description || "Legacy project import",
      ...artifacts.map((a) => a.title + "\n" + a.content),
      ...documents.map((d) => d.title + "\n" + d.content),
    ].join("\n\n");
    const content = mainFromBrief(brief);
    content.legacySources = sources;
    content.questions = [
      {
        id: "Q-LEGACY-IMPORT",
        question:
          "Reconcile overlapping legacy requirements and documentation. Historical approvals do not approve these new documents.",
        blocking: true,
      },
    ];
    return this.save(projectId, actor, {
      kind: "MAIN",
      content,
      expectedVersion,
      reason: "Preserve legacy sources as an unapproved Main draft",
    });
  }
  async startOperation(
    projectId: string,
    actor: string,
    input: {
      kind: "MAIN" | "ARCHITECTURE" | "CODE_PROPOSAL";
      expectedVersion: number;
      idempotencyKey: string;
      brief?: string;
      instruction: string;
      runId?: string;
    },
  ) {
    if (
      !["MAIN", "ARCHITECTURE", "CODE_PROPOSAL"].includes(input.kind) ||
      !/^[a-zA-Z0-9-]{8,100}$/.test(input.idempotencyKey ?? "") ||
      typeof input.instruction !== "string" ||
      !input.instruction.trim() ||
      input.instruction.length > 20000 ||
      (input.brief !== undefined &&
        (typeof input.brief !== "string" || input.brief.length > 100000))
    )
      throw new WorkspaceError("GENERATION_INPUT_INVALID", 422);
    return this.transaction(projectId, actor, async (tx) => {
      const inputHash = hash(input);
      const old = await tx.workspaceOperation.findUnique({
        where: {
          projectId_kind_idempotencyKey: {
            projectId,
            kind: input.kind,
            idempotencyKey: input.idempotencyKey,
          },
        },
      });
      if (old) {
        if (old.inputHash !== inputHash)
          throw new WorkspaceError("IDEMPOTENCY_CONFLICT");
        return { operation: old, reused: true };
      }
      const active = await tx.workspaceOperation.findFirst({
        where: { projectId, kind: input.kind, status: "RUNNING" },
      });
      if (active) {
        if (Date.now() - new Date(active.createdAt).getTime() < 5 * 60 * 1000)
          throw new WorkspaceError("OPERATION_IN_PROGRESS");
        await tx.workspaceOperation.update({
          where: { id: active.id },
          data: {
            status: "FAILED",
            errorCode: "INTERRUPTED_OPERATION",
            completedAt: new Date(),
          },
        });
      }
      const head = await this.head(tx, projectId);
      if (head.stateVersion !== input.expectedVersion)
        throw new WorkspaceError("STATE_CONFLICT");
      const main = head.mainId
        ? await tx.workspaceDocument.findFirst({
            where: { id: head.mainId, projectId, kind: "MAIN" },
          })
        : null;
      const architecture = head.architectureId
        ? await tx.workspaceDocument.findFirst({
            where: { id: head.architectureId, projectId, kind: "ARCHITECTURE" },
          })
        : null;
      let run = null;
      if (input.kind === "ARCHITECTURE" && !main)
        throw new WorkspaceError("MAIN_REQUIRED");
      if (input.kind === "CODE_PROPOSAL") {
        if (typeof input.runId !== "string")
          throw new WorkspaceError("RUN_NOT_FOUND", 404);
        run = await tx.workspaceRun.findFirst({
          where: { id: input.runId, projectId },
          include: { events: true },
        });
        if (!run) throw new WorkspaceError("RUN_NOT_FOUND", 404);
        if (head.approvalId !== run.approvalId)
          throw new WorkspaceError("AUTHORITY_SUPERSEDED");
        if (
          run.events.some((e) =>
            [
              "IMPLEMENTED",
              "REVIEW_VERIFIED",
              "RUN_FAILED",
              "SCOPE_CHANGE_REQUIRED",
            ].includes(e.kind),
          )
        )
          throw new WorkspaceError("RUN_ALREADY_ATTEMPTED");
        const approval = await tx.workspaceApproval.findFirst({
          where: { id: run.approvalId, projectId },
        });
        await this.readiness(
          tx,
          projectId,
          head,
          approval,
          (run.authority as any).unitIds,
        );
      }
      const repositories = await tx.projectRepository.findMany({
        where: { projectId },
        select: { id: true, name: true, currentIndexedCommit: true },
      });
      const operation = await tx.workspaceOperation.create({
        data: {
          projectId,
          runId: run?.id,
          kind: input.kind,
          idempotencyKey: input.idempotencyKey,
          stateVersion: head.stateVersion,
          inputHash,
          createdBy: actor,
          context: {
            input,
            main,
            architecture,
            repositories,
            authority: run?.authority ?? null,
          } as any,
        },
      });
      return { operation, reused: false };
    });
  }
  async completeOperation(
    projectId: string,
    actor: string,
    operationId: string,
    result: any,
    audit: unknown,
  ) {
    return this.transaction(projectId, actor, async (tx) => {
      const op = await tx.workspaceOperation.findFirst({
        where: { id: operationId, projectId, status: "RUNNING" },
      });
      if (!op) throw new WorkspaceError("OPERATION_NOT_RUNNING");
      const head = await this.head(tx, projectId),
        context = op.context as any;
      if (head.stateVersion !== op.stateVersion)
        throw new WorkspaceError("GENERATION_CONTEXT_CHANGED");
      let saved: any;
      if (op.kind === "CODE_PROPOSAL") {
        const run = await tx.workspaceRun.findFirst({
          where: { id: op.runId!, projectId },
          include: { events: true },
        });
        if (
          !run ||
          head.approvalId !== run.approvalId ||
          run.events.some((e) =>
            ["IMPLEMENTED", "RUN_FAILED", "SCOPE_CHANGE_REQUIRED"].includes(
              e.kind,
            ),
          )
        )
          throw new WorkspaceError("GENERATION_CONTEXT_CHANGED");
        const approval = await tx.workspaceApproval.findFirst({
          where: { id: run.approvalId, projectId },
        });
        await this.readiness(
          tx,
          projectId,
          head,
          approval,
          (run.authority as any).unitIds,
        );
        saved = result;
        await this.event(
          tx,
          projectId,
          actor,
          result.scopeChangeRequired
            ? "SCOPE_CHANGE_REQUIRED"
            : "CODE_PROPOSED",
          { operationId, result, audit },
          run.id,
        );
      } else {
        const document = await this.saveDocument(tx, projectId, actor, {
          kind: op.kind as "MAIN" | "ARCHITECTURE",
          content: result,
          expectedVersion: op.stateVersion,
          reason: context.input.instruction,
        });
        saved = { documentId: document.id, contentHash: document.contentHash };
        await this.event(tx, projectId, actor, "DOCUMENT_GENERATED", {
          operationId,
          documentId: document.id,
          audit,
        });
      }
      return tx.workspaceOperation.update({
        where: { id: op.id },
        data: {
          status: "COMPLETED",
          result: { output: saved, audit } as any,
          completedAt: new Date(),
        },
      });
    });
  }
  async failOperation(
    projectId: string,
    actor: string,
    operationId: string,
    code: string,
  ) {
    return this.transaction(projectId, actor, (tx) =>
      tx.workspaceOperation.updateMany({
        where: { id: operationId, projectId, status: "RUNNING" },
        data: {
          status: code.includes("CONTEXT") ? "CONFLICTED" : "FAILED",
          errorCode: code,
          completedAt: new Date(),
        },
      }),
    );
  }
}
