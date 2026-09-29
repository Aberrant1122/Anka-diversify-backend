import crypto from "crypto";
import {
  ArtifactActorType,
  ArtifactChangeKind,
  PhaseArtifact,
  Prisma,
  PrismaClient,
  WorkflowOperation,
  WorkflowRun,
} from "@prisma/client";
import {
  BuiltRequirementsContext,
  canonicalJson,
  hashCanonical,
  InitialRequirementsContextPayload,
  PlanningRequirementsContextBuilder,
  RequirementsContextManifest,
  REQUIREMENTS_RUN_OPERATIONS,
  RequirementsRevisionOperation,
  RevisionRequirementsContextPayload,
} from "../planning/requirements-context";
import { PlanningDomainError } from "../planning/planning-errors";
import {
  parseRequirementsContent,
  isRequirementsSectionKey,
  REQUIREMENTS_ARTIFACT_TYPE,
  REQUIREMENTS_PHASE,
  validateRequirementsRevisionTarget,
} from "../planning/requirements-schema";
import { REQUIREMENTS_ACTIVE_RUN_STALE_MS } from "../planning/requirements-run-config";
import {
  computeRequirementsDiff,
  isNoOpRequirementsRevision,
  RequirementsDeterministicDiff,
  validateRequirementsSectionScope,
  validateRevisionStableIds,
} from "../planning/requirements-revision-policy";
import { PlanningArtifactService } from "./planning-artifact.service";
import { PlanningAuthorizationService } from "./planning-authorization.service";
import { PlanningReadinessService, RequirementsReadiness } from "./planning-readiness.service";
import { PlanningTransitionPolicy } from "./planning-transition-policy";

const MAX_TRANSACTION_ATTEMPTS = 3;
const TERMINAL_STATUSES = ["completed", "failed", "conflicted", "cancelled"] as const;
export type RequirementsRunTerminalStatus = (typeof TERMINAL_STATUSES)[number];

export interface RequirementsRunFailure {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export type StartRequirementsRunInput =
  | {
      projectId: string;
      actorId: string;
      operation: "INITIAL_GENERATION";
      idempotencyKey: string;
      brief: string;
      includeMemory?: boolean;
    }
  | {
      projectId: string;
      actorId: string;
      operation: RequirementsRevisionOperation;
      idempotencyKey: string;
      baseArtifactId: string;
      instruction: string;
      targetSectionKey?: string | null;
      includeMemory?: boolean;
    };

export type PreparedRequirementsContext =
  | BuiltRequirementsContext<InitialRequirementsContextPayload>
  | BuiltRequirementsContext<RevisionRequirementsContextPayload>;

export interface StartRequirementsRunResult {
  run: WorkflowRun;
  context: PreparedRequirementsContext;
  reused: boolean;
}

export interface RequirementsGenerationAudit {
  modelUsage: Prisma.InputJsonObject;
  costUSD: number | null;
}

export interface FinalizeInitialRequirementsGenerationInput {
  projectId: string;
  runId: string;
  actorId: string;
  structuredContent: unknown;
  audit: RequirementsGenerationAudit;
}

export interface FinalizeInitialRequirementsGenerationResult {
  run: WorkflowRun;
  artifact: PhaseArtifact;
  readiness: RequirementsReadiness;
}

export interface FinalizeRequirementsRevisionInput {
  projectId: string;
  runId: string;
  actorId: string;
  structuredContent: unknown;
  audit: RequirementsGenerationAudit;
}

export interface FinalizeRequirementsRevisionResult {
  run: WorkflowRun;
  artifact: PhaseArtifact;
  readiness: RequirementsReadiness;
  diff: RequirementsDeterministicDiff;
}

type PersistedManifest = RequirementsContextManifest & { requestFingerprint: string };
type LeaseState = {
  id: string;
  activeRunId: string | null;
  stateVersion: number;
  currentArtifactId: string | null;
  status: string;
};

function isRetryable(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === "P2002" || error.code === "P2034");
}

function normalizeIdempotencyKey(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new PlanningDomainError(
      "PLANNING_ARTIFACT_INVALID",
      "Idempotency-Key is required for a Requirements AI operation.",
      422,
      { field: "Idempotency-Key" },
    );
  }
  return normalized;
}

// One key space for every Requirements operation: the operation is bound by the request
// fingerprint, so reusing a key for a different operation is detected as a conflict.
function scopedIdempotencyKey(key: string): string {
  const digest = crypto.createHash("sha256").update(key, "utf8").digest("hex");
  return `requirements:${digest}`;
}

function manifestFrom(run: WorkflowRun): PersistedManifest | null {
  if (!run.contextManifest || typeof run.contextManifest !== "object" || Array.isArray(run.contextManifest)) return null;
  const manifest = run.contextManifest as Record<string, unknown>;
  return typeof manifest.requestFingerprint === "string" ? manifest as unknown as PersistedManifest : null;
}

function serializedFailure(failure: RequirementsRunFailure): string {
  return canonicalJson({
    message: failure.message.slice(0, 8_192),
    ...(failure.details ? { details: failure.details } : {}),
  });
}

function requestFingerprint(input: StartRequirementsRunInput, context: PreparedRequirementsContext): string {
  return input.operation === WorkflowOperation.INITIAL_GENERATION
    ? hashCanonical({
      projectId: input.projectId,
      operation: input.operation,
      brief: context.manifest.brief?.normalizedText,
      includeMemory: input.includeMemory === true,
    })
    : hashCanonical({
      projectId: input.projectId,
      operation: input.operation,
      baseArtifactId: input.baseArtifactId,
      baseVersion: context.manifest.baseArtifact?.version,
      baseContentHash: context.manifest.baseArtifact?.hash,
      instruction: context.manifest.instruction?.normalizedText,
      targetSectionKey: context.manifest.targetSectionKey ?? null,
      includeMemory: input.includeMemory === true,
    });
}

function manifestContextHash(manifest: PersistedManifest): string {
  const { contextHash: _contextHash, requestFingerprint: _requestFingerprint, ...unsigned } = manifest;
  return hashCanonical(unsigned);
}

function revisionChangeKind(operation: WorkflowOperation): ArtifactChangeKind {
  switch (operation) {
    case WorkflowOperation.DOCUMENT_REVISION:
      return ArtifactChangeKind.AI_DOCUMENT_REVISION;
    case WorkflowOperation.FEEDBACK_APPLICATION:
      return ArtifactChangeKind.FEEDBACK_APPLICATION;
    case WorkflowOperation.SECTION_REVISION:
      return ArtifactChangeKind.AI_SECTION_REVISION;
    case WorkflowOperation.SECTION_REGENERATION:
      return ArtifactChangeKind.AI_SECTION_REGENERATION;
    default:
      throw new PlanningDomainError(
        "PLANNING_ARTIFACT_INVALID",
        `Invalid operation '${operation}' for Requirements revision finalization.`,
        422,
        { operation },
      );
  }
}

export class PlanningRequirementsRunService {
  private readonly authorization: PlanningAuthorizationService;
  private readonly contexts: PlanningRequirementsContextBuilder;
  private readonly artifacts: PlanningArtifactService;
  private readonly readiness: PlanningReadinessService;
  private readonly transitions: PlanningTransitionPolicy;

  constructor(
    private readonly prisma: PrismaClient,
    authorization?: PlanningAuthorizationService,
    contexts?: PlanningRequirementsContextBuilder,
    artifacts?: PlanningArtifactService,
    readiness?: PlanningReadinessService,
    transitions?: PlanningTransitionPolicy,
  ) {
    this.authorization = authorization ?? new PlanningAuthorizationService(prisma);
    this.contexts = contexts ?? new PlanningRequirementsContextBuilder(prisma);
    this.artifacts = artifacts ?? new PlanningArtifactService(prisma, this.authorization);
    this.readiness = readiness ?? new PlanningReadinessService();
    this.transitions = transitions ?? new PlanningTransitionPolicy();
  }

  async startRequirementsRun(input: StartRequirementsRunInput): Promise<StartRequirementsRunResult> {
    if (!REQUIREMENTS_RUN_OPERATIONS.includes(input.operation)) {
      throw new PlanningDomainError(
        "PLANNING_ARTIFACT_INVALID",
        "Unsupported Requirements run operation.",
        422,
        { operation: input.operation },
      );
    }
    const revisionTarget = input.operation === WorkflowOperation.INITIAL_GENERATION
      ? null
      : validateRequirementsRevisionTarget(input.operation, input.targetSectionKey);
    await this.authorization.assertCanEdit(input.projectId, input.actorId);
    const key = normalizeIdempotencyKey(input.idempotencyKey);
    const context: PreparedRequirementsContext = input.operation === WorkflowOperation.INITIAL_GENERATION
      ? await this.contexts.buildInitial({
        projectId: input.projectId,
        actorId: input.actorId,
        brief: input.brief,
        includeMemory: input.includeMemory,
      })
      : await this.contexts.buildRevision({
        projectId: input.projectId,
        actorId: input.actorId,
        operation: input.operation,
        baseArtifactId: input.baseArtifactId,
        instruction: input.instruction,
        targetSectionKey: revisionTarget?.targetSectionKey,
        includeMemory: input.includeMemory,
      });
    const fingerprint = requestFingerprint(input, context);
    const persistedManifest: PersistedManifest = { ...context.manifest, requestFingerprint: fingerprint };
    const persistedKey = scopedIdempotencyKey(key);

    for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
      try {
        const result = await this.prisma.$transaction(async (tx) => {
          const existing = await tx.workflowRun.findUnique({
            where: { projectId_idempotencyKey: { projectId: input.projectId, idempotencyKey: persistedKey } },
          });
          if (existing) {
            this.assertMatchingFingerprint(existing, fingerprint);
            return { run: existing, reused: true };
          }

          let state: LeaseState = await tx.projectPhaseState.upsert({
            where: { projectId_phase: { projectId: input.projectId, phase: REQUIREMENTS_PHASE } },
            update: {},
            create: { projectId: input.projectId, phase: REQUIREMENTS_PHASE },
          });
          if (input.operation === WorkflowOperation.INITIAL_GENERATION && state.currentArtifactId) {
            throw new PlanningDomainError(
              "PLANNING_CONTEXT_CHANGED",
              "Requirements already has a current artifact; initial generation context is no longer current.",
              409,
              { currentArtifactId: state.currentArtifactId },
            );
          }
          if (input.operation !== WorkflowOperation.INITIAL_GENERATION) {
            if (state.currentArtifactId !== input.baseArtifactId) {
              throw new PlanningDomainError(
                "PLANNING_CONTEXT_CHANGED",
                "The Requirements base artifact changed before the run lease was acquired.",
                409,
                { baseArtifactId: input.baseArtifactId, currentArtifactId: state.currentArtifactId },
              );
            }
            this.transitions.assertAction(state.status, "create_revision");
          }
          if (state.activeRunId) {
            state = await this.recoverOrRejectActiveRun(tx, state);
          }

          const run = await tx.workflowRun.create({
            data: {
              projectId: input.projectId,
              triggerType: "manual",
              currentPhase: REQUIREMENTS_PHASE,
              status: "running",
              operation: input.operation,
              baseArtifactId: input.operation === WorkflowOperation.INITIAL_GENERATION ? null : input.baseArtifactId,
              inputArtifactId: input.operation === WorkflowOperation.INITIAL_GENERATION ? null : input.baseArtifactId,
              contextManifest: persistedManifest as unknown as Prisma.InputJsonValue,
              contextHash: context.contextHash,
              targetSectionKey: revisionTarget?.targetSectionKey ?? null,
              initiatedById: input.actorId,
              initiatedByType: ArtifactActorType.HUMAN,
              idempotencyKey: persistedKey,
            },
          });
          const lease = await tx.projectPhaseState.updateMany({
            where: { id: state.id, activeRunId: null, stateVersion: state.stateVersion },
            data: { activeRunId: run.id, stateVersion: { increment: 1 } },
          });
          if (lease.count !== 1) {
            throw new PlanningDomainError(
              "PLANNING_GENERATION_IN_PROGRESS",
              "Another Requirements AI operation acquired the active run lease.",
              409,
            );
          }
          return { run, reused: false };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
        return { ...result, context };
      } catch (error) {
        if (isRetryable(error) && attempt < MAX_TRANSACTION_ATTEMPTS) continue;
        throw error;
      }
    }
    throw new PlanningDomainError("PLANNING_CONCURRENT_UPDATE", "Could not acquire the Requirements run lease.", 409);
  }

  async completeRequirementsRun(projectId: string, runId: string): Promise<WorkflowRun> {
    return this.finish(projectId, runId, "completed");
  }

  async failRequirementsRun(
    projectId: string,
    runId: string,
    failure: RequirementsRunFailure,
    audit?: RequirementsGenerationAudit,
  ): Promise<WorkflowRun> {
    return this.finish(projectId, runId, "failed", failure, audit);
  }

  async markRequirementsRunConflicted(
    projectId: string,
    runId: string,
    failure: RequirementsRunFailure,
    audit?: RequirementsGenerationAudit,
  ): Promise<WorkflowRun> {
    return this.finish(projectId, runId, "conflicted", failure, audit);
  }

  async cancelRequirementsRun(
    projectId: string,
    runId: string,
    failure?: RequirementsRunFailure,
    audit?: RequirementsGenerationAudit,
  ): Promise<WorkflowRun> {
    return this.finish(projectId, runId, "cancelled", failure, audit);
  }

  async getRequirementsRun(projectId: string, runId: string, actorId: string): Promise<WorkflowRun> {
    await this.authorization.assertCanRead(projectId, actorId);
    const run = await this.prisma.workflowRun.findFirst({ where: { id: runId, projectId, currentPhase: REQUIREMENTS_PHASE } });
    if (!run) {
      throw new PlanningDomainError("PLANNING_PROJECT_NOT_FOUND", "Requirements run was not found or is not accessible.", 404);
    }
    return run;
  }

  async assertRequirementsRunCurrent(projectId: string, runId: string, actorId: string): Promise<WorkflowRun> {
    await this.authorization.assertCanEdit(projectId, actorId);
    const run = await this.prisma.workflowRun.findFirst({ where: { id: runId, projectId, currentPhase: REQUIREMENTS_PHASE } });
    if (!run || run.status !== "running") {
      throw new PlanningDomainError("PLANNING_CONTEXT_CHANGED", "The Requirements run is no longer active.", 409, { runId });
    }
    const [state, project] = await Promise.all([
      this.prisma.projectPhaseState.findUnique({
        where: { projectId_phase: { projectId, phase: REQUIREMENTS_PHASE } },
        select: { activeRunId: true, currentArtifactId: true, status: true, approvalCandidateArtifactId: true },
      }),
      this.prisma.project.findUnique({
        where: { id: projectId },
        select: { id: true, name: true, description: true, currentPhase: true, memorySummary: true },
      }),
    ]);
    const manifest = manifestFrom(run);
    if (!state || state.activeRunId !== run.id || !project || !manifest) {
      throw new PlanningDomainError("PLANNING_CONTEXT_CHANGED", "Requirements run context is no longer current.", 409, { runId });
    }
    if (
      run.operation !== manifest.operation || run.contextHash !== manifest.contextHash ||
      manifest.contextHash !== manifestContextHash(manifest)
    ) {
      throw new PlanningDomainError("PLANNING_CONTEXT_CHANGED", "Requirements run authority is inconsistent.", 409, { runId });
    }
    if (run.operation !== WorkflowOperation.INITIAL_GENERATION) {
      const target = validateRequirementsRevisionTarget(run.operation!, run.targetSectionKey);
      if (
        (target.targetSectionKey ?? null) !== (manifest.targetSectionKey ?? null) ||
        (run.targetSectionKey ?? null) !== (manifest.targetSectionKey ?? null)
      ) {
        throw new PlanningDomainError("PLANNING_INVALID_SECTION", "Requirements run target authority is inconsistent.", 422, { runId });
      }
    }
    if (run.operation !== WorkflowOperation.INITIAL_GENERATION) {
      if (state.status === "awaiting_approval" || state.approvalCandidateArtifactId !== null) {
        throw new PlanningDomainError(
          "PLANNING_CONTEXT_CHANGED",
          "Requirements is awaiting approval; revision cannot proceed.",
          409,
          { runId, status: state.status },
        );
      }
    }
    if (canonicalJson(manifest.project) !== canonicalJson({
      id: project.id,
      name: project.name,
      description: project.description,
      currentPhase: project.currentPhase,
    })) {
      throw new PlanningDomainError("PLANNING_CONTEXT_CHANGED", "Project metadata changed during the Requirements operation.", 409, { runId });
    }
    if (run.operation === WorkflowOperation.INITIAL_GENERATION && state.currentArtifactId !== null) {
      throw new PlanningDomainError(
        "PLANNING_CONTEXT_CHANGED",
        "A Requirements artifact was created during the initial generation operation.",
        409,
        { runId, currentArtifactId: state.currentArtifactId },
      );
    }
    if (run.baseArtifactId) {
      const base = await this.prisma.phaseArtifact.findUnique({
        where: { id: run.baseArtifactId },
        select: { id: true, version: true, contentHash: true },
      });
      if (
        !base || state.currentArtifactId !== base.id ||
        base.version !== manifest.baseArtifact?.version || base.contentHash !== manifest.baseArtifact?.hash
      ) {
        throw new PlanningDomainError("PLANNING_CONTEXT_CHANGED", "The Requirements base artifact changed during the operation.", 409, { runId });
      }
    }
    if (manifest.memory) {
      const memory = project.memorySummary;
      if (
        !memory || memory.id !== manifest.memory.id || memory.version !== manifest.memory.version ||
        crypto.createHash("sha256").update(memory.summary.trim().replace(/\r\n?/g, "\n"), "utf8").digest("hex") !== manifest.memory.hash
      ) {
        throw new PlanningDomainError("PLANNING_CONTEXT_CHANGED", "The opted-in project memory changed during the operation.", 409, { runId });
      }
    }
    return run;
  }

  async finalizeInitialGeneration(
    input: FinalizeInitialRequirementsGenerationInput,
  ): Promise<FinalizeInitialRequirementsGenerationResult> {
    for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          await this.authorization.assertCanEditInTransaction(tx, input.projectId, input.actorId);
          const run = await tx.workflowRun.findFirst({
            where: {
              id: input.runId,
              projectId: input.projectId,
              currentPhase: REQUIREMENTS_PHASE,
              operation: WorkflowOperation.INITIAL_GENERATION,
            },
          });
          if (!run || run.status !== "running") {
            throw new PlanningDomainError(
              "PLANNING_CONTEXT_CHANGED",
              "The initial Requirements generation run is no longer active.",
              409,
              { runId: input.runId },
            );
          }

          const manifest = manifestFrom(run);
          const [state, project, existingArtifact] = await Promise.all([
            tx.projectPhaseState.findUnique({
              where: { projectId_phase: { projectId: input.projectId, phase: REQUIREMENTS_PHASE } },
            }),
            tx.project.findUnique({
              where: { id: input.projectId },
              select: { id: true, name: true, description: true, currentPhase: true, memorySummary: true },
            }),
            tx.phaseArtifact.findFirst({
              where: {
                projectId: input.projectId,
                phase: REQUIREMENTS_PHASE,
                type: REQUIREMENTS_ARTIFACT_TYPE,
              },
              select: { id: true },
            }),
          ]);
          if (
            !manifest || manifest.target !== "requirements" ||
            manifest.operation !== WorkflowOperation.INITIAL_GENERATION || !manifest.brief ||
            manifest.initiator.id !== input.actorId || run.initiatedById !== input.actorId ||
            run.contextHash !== manifest.contextHash || !state || !project ||
            state.activeRunId !== run.id || state.currentArtifactId !== null || existingArtifact
          ) {
            throw new PlanningDomainError(
              "PLANNING_CONTEXT_CHANGED",
              "Requirements context changed before initial generation could be persisted.",
              409,
              { runId: run.id, currentArtifactId: state?.currentArtifactId ?? existingArtifact?.id ?? null },
            );
          }
          if (canonicalJson(manifest.project) !== canonicalJson({
            id: project.id,
            name: project.name,
            description: project.description,
            currentPhase: project.currentPhase,
          })) {
            throw new PlanningDomainError(
              "PLANNING_CONTEXT_CHANGED",
              "Project metadata changed during initial Requirements generation.",
              409,
              { runId: run.id },
            );
          }
          if (manifest.memory) {
            const memory = project.memorySummary;
            const memoryHash = memory
              ? crypto.createHash("sha256").update(memory.summary.trim().replace(/\r\n?/g, "\n"), "utf8").digest("hex")
              : null;
            if (
              !memory || memory.id !== manifest.memory.id || memory.version !== manifest.memory.version ||
              memoryHash !== manifest.memory.hash
            ) {
              throw new PlanningDomainError(
                "PLANNING_CONTEXT_CHANGED",
                "The opted-in project memory changed during initial Requirements generation.",
                409,
                { runId: run.id },
              );
            }
          }

          const { artifact, state: artifactState } = await this.artifacts.createInitialArtifactInTransaction(tx, {
            projectId: input.projectId,
            actorId: input.actorId,
            title: "Requirements v1",
            structuredContent: input.structuredContent,
            createdByType: ArtifactActorType.AI,
            changeKind: ArtifactChangeKind.INITIAL_GENERATION,
          });
          if (artifactState.id !== state.id || artifactState.stateVersion !== state.stateVersion) {
            throw new PlanningDomainError(
              "PLANNING_CONTEXT_CHANGED",
              "Requirements phase state changed during initial generation finalization.",
              409,
              { runId: run.id },
            );
          }

          const advanced = await tx.projectPhaseState.updateMany({
            where: {
              id: state.id,
              stateVersion: state.stateVersion,
              activeRunId: run.id,
              currentArtifactId: null,
            },
            data: {
              status: "in_progress",
              startedAt: state.startedAt ?? new Date(),
              currentArtifactId: artifact.id,
              approvalCandidateArtifactId: null,
              activeRunId: null,
              stateVersion: { increment: 1 },
            },
          });
          if (advanced.count !== 1) {
            throw new PlanningDomainError(
              "PLANNING_CONTEXT_CHANGED",
              "Requirements changed concurrently during initial generation finalization.",
              409,
              { runId: run.id },
            );
          }

          await tx.project.update({
            where: { id: input.projectId },
            data: { currentPhase: REQUIREMENTS_PHASE },
          });
          const readiness = this.readiness.evaluateRequirements({ artifact });
          const completed = await tx.workflowRun.updateMany({
            where: { id: run.id, status: "running", outputArtifactId: null },
            data: {
              status: "completed",
              outputArtifactId: artifact.id,
              modelUsage: input.audit.modelUsage,
              costUSD: input.audit.costUSD,
              completedAt: new Date(),
              errorCode: null,
              errorMessage: null,
            },
          });
          if (completed.count !== 1) {
            throw new PlanningDomainError(
              "PLANNING_CONTEXT_CHANGED",
              "Requirements run changed concurrently during completion.",
              409,
              { runId: run.id },
            );
          }
          const completedRun = await tx.workflowRun.findUniqueOrThrow({ where: { id: run.id } });
          return { run: completedRun, artifact, readiness };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        if (isRetryable(error) && attempt < MAX_TRANSACTION_ATTEMPTS) continue;
        throw error;
      }
    }
    throw new PlanningDomainError(
      "PLANNING_PERSISTENCE_FAILED",
      "Initial Requirements generation could not be finalized.",
      503,
    );
  }

  async finalizeRequirementsRevision(
    input: FinalizeRequirementsRevisionInput,
  ): Promise<FinalizeRequirementsRevisionResult> {
    for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          await this.authorization.assertCanEditInTransaction(tx, input.projectId, input.actorId);
          const run = await tx.workflowRun.findFirst({
            where: {
              id: input.runId,
              projectId: input.projectId,
              currentPhase: REQUIREMENTS_PHASE,
            },
          });
          if (!run || run.status !== "running") {
            throw new PlanningDomainError(
              "PLANNING_CONTEXT_CHANGED",
              "The Requirements revision run is no longer active.",
              409,
              { runId: input.runId },
            );
          }
          const target = validateRequirementsRevisionTarget(run.operation ?? "", run.targetSectionKey);

          const manifest = manifestFrom(run);
          const [state, project] = await Promise.all([
            tx.projectPhaseState.findUnique({
              where: { projectId_phase: { projectId: input.projectId, phase: REQUIREMENTS_PHASE } },
            }),
            tx.project.findUnique({
              where: { id: input.projectId },
              select: { id: true, name: true, description: true, currentPhase: true, memorySummary: true },
            }),
          ]);

          if (
            !manifest || manifest.target !== "requirements" || manifest.operation !== run.operation ||
            !manifest.baseArtifact || manifest.initiator.id !== input.actorId ||
            run.initiatedById !== input.actorId || run.contextHash !== manifest.contextHash ||
            manifest.contextHash !== manifestContextHash(manifest) ||
            !state || !project || state.activeRunId !== run.id ||
            state.currentArtifactId !== run.baseArtifactId
          ) {
            throw new PlanningDomainError(
              "PLANNING_CONTEXT_CHANGED",
              "Requirements context changed before revision could be persisted.",
              409,
              { runId: run.id, currentArtifactId: state?.currentArtifactId ?? null },
            );
          }

          const manifestTarget = manifest.targetSectionKey ?? null;
          if (target.targetSectionKey !== manifestTarget || (run.targetSectionKey ?? null) !== manifestTarget) {
            throw new PlanningDomainError(
              "PLANNING_INVALID_SECTION",
              "Requirements run target does not match its authoritative manifest.",
              422,
              { runId: run.id },
            );
          }
          const allowedSectionKeys = manifest.allowedSectionKeys;
          if (target.targetSectionKey) {
            if (
              !Array.isArray(allowedSectionKeys) || allowedSectionKeys.length === 0 ||
              allowedSectionKeys[0] !== target.targetSectionKey ||
              new Set(allowedSectionKeys).size !== allowedSectionKeys.length ||
              !allowedSectionKeys.every(isRequirementsSectionKey)
            ) {
              throw new PlanningDomainError(
                "PLANNING_INVALID_SECTION",
                "Requirements section policy snapshot is invalid.",
                422,
                { runId: run.id, targetSectionKey: target.targetSectionKey },
              );
            }
          } else if (allowedSectionKeys !== undefined) {
            throw new PlanningDomainError(
              "PLANNING_INVALID_SECTION",
              "Whole-document Requirements revision cannot carry a section policy snapshot.",
              422,
              { runId: run.id },
            );
          }

          if (state.status === "awaiting_approval" || state.approvalCandidateArtifactId !== null) {
            throw new PlanningDomainError(
              "PLANNING_CONTEXT_CHANGED",
              "Requirements is awaiting approval; revision cannot proceed.",
              409,
              { runId: run.id, status: state.status },
            );
          }

          this.transitions.assertAction(state.status, "create_revision");

          if (canonicalJson(manifest.project) !== canonicalJson({
            id: project.id,
            name: project.name,
            description: project.description,
            currentPhase: project.currentPhase,
          })) {
            throw new PlanningDomainError(
              "PLANNING_CONTEXT_CHANGED",
              "Project metadata changed during Requirements revision.",
              409,
              { runId: run.id },
            );
          }

          if (manifest.memory) {
            const memory = project.memorySummary;
            const memoryHash = memory
              ? crypto.createHash("sha256").update(memory.summary.trim().replace(/\r\n?/g, "\n"), "utf8").digest("hex")
              : null;
            if (
              !memory || memory.id !== manifest.memory.id || memory.version !== manifest.memory.version ||
              memoryHash !== manifest.memory.hash
            ) {
              throw new PlanningDomainError(
                "PLANNING_CONTEXT_CHANGED",
                "The opted-in project memory changed during Requirements revision.",
                409,
                { runId: run.id },
              );
            }
          }

          const base = await tx.phaseArtifact.findUnique({ where: { id: run.baseArtifactId! } });
          if (
            !base || base.projectId !== input.projectId || base.phase !== REQUIREMENTS_PHASE ||
            base.type !== REQUIREMENTS_ARTIFACT_TYPE ||
            base.version !== manifest.baseArtifact.version ||
            base.contentHash !== manifest.baseArtifact.hash ||
            base.structuredContent === null
          ) {
            throw new PlanningDomainError(
              "PLANNING_CONTEXT_CHANGED",
              "The Requirements base artifact changed or was not found.",
              409,
              { runId: run.id, baseArtifactId: run.baseArtifactId },
            );
          }

          const baseContent = parseRequirementsContent(base.structuredContent);
          const newContent = parseRequirementsContent(input.structuredContent);

          if (isNoOpRequirementsRevision(baseContent, newContent)) {
            throw new PlanningDomainError(
              "PLANNING_REVISION_NO_CHANGES",
              "The revision produced no changes to the Requirements document.",
              422,
              { runId: run.id },
            );
          }

          const diff = computeRequirementsDiff(baseContent, newContent);
          if (target.targetSectionKey) {
            validateRequirementsSectionScope(target.targetSectionKey, allowedSectionKeys!, diff.changedRootSections);
          }
          validateRevisionStableIds(baseContent, newContent);

          const changeKind = revisionChangeKind(run.operation!);

          const { artifact } = await this.artifacts.createSuccessorVersionInTransaction(tx, {
            projectId: input.projectId,
            actorId: input.actorId,
            baseArtifactId: base.id,
            baseContentHash: base.contentHash,
            title: `Requirements v${base.version + 1}`,
            structuredContent: newContent,
            createdByType: ArtifactActorType.AI,
            changeKind,
          });

          const advanced = await tx.projectPhaseState.updateMany({
            where: {
              id: state.id,
              stateVersion: state.stateVersion,
              activeRunId: run.id,
              currentArtifactId: base.id,
            },
            data: {
              status: "in_progress",
              currentArtifactId: artifact.id,
              approvalCandidateArtifactId: null,
              notes: null,
              activeRunId: null,
              stateVersion: { increment: 1 },
            },
          });
          if (advanced.count !== 1) {
            throw new PlanningDomainError(
              "PLANNING_CONTEXT_CHANGED",
              "Requirements changed concurrently during revision finalization.",
              409,
              { runId: run.id },
            );
          }

          await tx.project.update({
            where: { id: input.projectId },
            data: { currentPhase: REQUIREMENTS_PHASE },
          });

          const readiness = this.readiness.evaluateRequirements({ artifact });
          const completed = await tx.workflowRun.updateMany({
            where: { id: run.id, status: "running", outputArtifactId: null },
            data: {
              status: "completed",
              outputArtifactId: artifact.id,
              modelUsage: input.audit.modelUsage,
              costUSD: input.audit.costUSD,
              completedAt: new Date(),
              errorCode: null,
              errorMessage: null,
            },
          });
          if (completed.count !== 1) {
            throw new PlanningDomainError(
              "PLANNING_CONTEXT_CHANGED",
              "Requirements run changed concurrently during completion.",
              409,
              { runId: run.id },
            );
          }

          const completedRun = await tx.workflowRun.findUniqueOrThrow({ where: { id: run.id } });
          return { run: completedRun, artifact, readiness, diff };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        if (isRetryable(error) && attempt < MAX_TRANSACTION_ATTEMPTS) continue;
        throw error;
      }
    }
    throw new PlanningDomainError(
      "PLANNING_PERSISTENCE_FAILED",
      "Requirements revision could not be finalized.",
      503,
    );
  }

  private assertMatchingFingerprint(run: WorkflowRun, fingerprint: string): void {
    const manifest = manifestFrom(run);
    if (!manifest || manifest.requestFingerprint !== fingerprint) {
      throw new PlanningDomainError(
        "PLANNING_IDEMPOTENCY_CONFLICT",
        "The Idempotency-Key was already used with different Requirements request content.",
        409,
        { runId: run.id },
      );
    }
  }

  private async recoverOrRejectActiveRun(
    tx: Prisma.TransactionClient,
    state: LeaseState,
  ): Promise<LeaseState> {
    if (!state.activeRunId) return state;
    const active = await tx.workflowRun.findUnique({ where: { id: state.activeRunId } });
    const stale = active?.status === "running" &&
      Date.now() - active.startedAt.getTime() > REQUIREMENTS_ACTIVE_RUN_STALE_MS;
    if (active?.status === "running" && !stale) {
      throw new PlanningDomainError(
        "PLANNING_GENERATION_IN_PROGRESS",
        "A Requirements AI operation is already in progress.",
        409,
        { activeRunId: active.id },
      );
    }
    if (stale && active) {
      await tx.workflowRun.update({
        where: { id: active.id },
        data: {
          status: "failed",
          completedAt: new Date(),
          errorCode: "PLANNING_STALE_RUN_RECOVERED",
          errorMessage: serializedFailure({
            code: "PLANNING_STALE_RUN_RECOVERED",
            message: "The abandoned Requirements run lease expired and was recovered by a later request.",
          }),
        },
      });
    }
    return tx.projectPhaseState.update({
      where: { id: state.id },
      data: { activeRunId: null, stateVersion: { increment: 1 } },
    });
  }

  private async finish(
    projectId: string,
    runId: string,
    status: RequirementsRunTerminalStatus,
    failure?: RequirementsRunFailure,
    audit?: RequirementsGenerationAudit,
  ): Promise<WorkflowRun> {
    return this.prisma.$transaction(async (tx) => {
      const run = await tx.workflowRun.findFirst({ where: { id: runId, projectId, currentPhase: REQUIREMENTS_PHASE } });
      if (!run) {
        throw new PlanningDomainError("PLANNING_PROJECT_NOT_FOUND", "Requirements run was not found or is not accessible.", 404);
      }
      if (run.status === status) return run;
      if (run.status !== "running") {
        throw new PlanningDomainError(
          "PLANNING_CONTEXT_CHANGED",
          `Requirements run is already terminal with status '${run.status}'.`,
          409,
          { runId, status: run.status },
        );
      }
      const updated = await tx.workflowRun.update({
        where: { id: run.id },
        data: {
          status,
          completedAt: new Date(),
          errorCode: failure?.code ?? null,
          errorMessage: failure ? serializedFailure(failure) : null,
          ...(audit ? { modelUsage: audit.modelUsage, costUSD: audit.costUSD } : {}),
        },
      });
      await tx.projectPhaseState.updateMany({
        where: { projectId, phase: REQUIREMENTS_PHASE, activeRunId: run.id },
        data: { activeRunId: null, stateVersion: { increment: 1 } },
      });
      return updated;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }
}
