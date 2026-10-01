import crypto from "crypto";
import {
  ArtifactActorType, ArtifactChangeKind, PhaseArtifact, Prisma, PrismaClient,
  ProjectPhaseState, WorkflowOperation, WorkflowRun,
} from "@prisma/client";
import {
  BuiltDocumentationContext, DocumentationContextManifest,
  PlanningDocumentationContextBuilder,
} from "../planning/documentation-context";
import {
  DOCUMENTATION_ACTIVE_RUN_STALE_MS, DOCUMENTATION_OPERATION, DOCUMENTATION_PHASE,
} from "../planning/documentation-run-config";
import { PlanningDomainError } from "../planning/planning-errors";
import { canonicalJson } from "../planning/requirements-context";
import {
  hashRequirementsContent, parseRequirementsContent, REQUIREMENTS_PHASE,
} from "../planning/requirements-schema";
import { PlanningAuthorizationService } from "./planning-authorization.service";
import { PlanningDocumentationArtifactService } from "./planning-documentation-artifact.service";
import {
  DocumentationReadiness, PlanningDocumentationReadinessService,
} from "./planning-documentation-readiness.service";

const MAX_TRANSACTION_ATTEMPTS = 3;
type PersistedManifest = DocumentationContextManifest & { requestFingerprint: string };

export interface DocumentationGenerationAudit {
  modelUsage: Prisma.InputJsonObject;
  costUSD: number | null;
}

export interface DocumentationRunFailure {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface StartDocumentationRunResult {
  run: WorkflowRun;
  context: BuiltDocumentationContext;
  reused: boolean;
}

export interface FinalizeDocumentationRunResult {
  run: WorkflowRun;
  artifact: PhaseArtifact;
  readiness: DocumentationReadiness;
}

function isRetryable(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2002" || error.code === "P2034");
}

function scopedKey(raw: string): string {
  const key = raw.trim();
  if (!key) throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", "Idempotency-Key is required for a Documentation AI operation.", 422, { field: "Idempotency-Key" });
  return `documentation:${crypto.createHash("sha256").update(key, "utf8").digest("hex")}`;
}

function manifestFrom(run: WorkflowRun): PersistedManifest | null {
  if (!run.contextManifest || typeof run.contextManifest !== "object" || Array.isArray(run.contextManifest)) return null;
  const value = run.contextManifest as Record<string, unknown>;
  return typeof value.requestFingerprint === "string" ? value as unknown as PersistedManifest : null;
}

function failureJson(failure: DocumentationRunFailure): string {
  return canonicalJson({ message: failure.message.slice(0, 8_192), ...(failure.details ? { details: failure.details } : {}) });
}

export class PlanningDocumentationRunService {
  private readonly authorization: PlanningAuthorizationService;
  private readonly contexts: PlanningDocumentationContextBuilder;
  private readonly artifacts: PlanningDocumentationArtifactService;
  private readonly readiness: PlanningDocumentationReadinessService;

  constructor(private readonly prisma: PrismaClient, dependencies: {
    authorization?: PlanningAuthorizationService;
    contexts?: PlanningDocumentationContextBuilder;
    artifacts?: PlanningDocumentationArtifactService;
    readiness?: PlanningDocumentationReadinessService;
  } = {}) {
    this.authorization = dependencies.authorization ?? new PlanningAuthorizationService(prisma);
    this.contexts = dependencies.contexts ?? new PlanningDocumentationContextBuilder();
    this.artifacts = dependencies.artifacts ?? new PlanningDocumentationArtifactService(prisma, this.authorization);
    this.readiness = dependencies.readiness ?? new PlanningDocumentationReadinessService();
  }

  async start(input: { projectId: string; actorId: string; idempotencyKey: string; includeMemory: boolean }): Promise<StartDocumentationRunResult> {
    const idempotencyKey = scopedKey(input.idempotencyKey);
    for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          await this.authorization.assertCanEditInTransaction(tx, input.projectId, input.actorId);
          const context = await this.contexts.buildInTransaction(tx, input);
          const existing = await tx.workflowRun.findUnique({
            where: { projectId_idempotencyKey: { projectId: input.projectId, idempotencyKey } },
          });
          if (existing) {
            const manifest = manifestFrom(existing);
            if (!manifest || manifest.requestFingerprint !== context.requestFingerprint) {
              throw new PlanningDomainError("PLANNING_IDEMPOTENCY_CONFLICT", "The Idempotency-Key was already used with different Documentation request content.", 409, { runId: existing.id });
            }
            return { run: existing, context, reused: true };
          }
          let state = await tx.projectPhaseState.upsert({
            where: { projectId_phase: { projectId: input.projectId, phase: DOCUMENTATION_PHASE } },
            update: {}, create: { projectId: input.projectId, phase: DOCUMENTATION_PHASE },
          });
          if (state.currentArtifactId) {
            throw new PlanningDomainError("PLANNING_INITIAL_ARTIFACT_EXISTS", "Documentation already has an initial artifact.", 409, { currentArtifactId: state.currentArtifactId });
          }
          if (state.activeRunId) state = await this.recoverOrReject(tx, state);
          const persistedManifest: PersistedManifest = { ...context.manifest, requestFingerprint: context.requestFingerprint };
          const run = await tx.workflowRun.create({ data: {
            projectId: input.projectId, triggerType: "manual", currentPhase: DOCUMENTATION_PHASE,
            status: "running", operation: DOCUMENTATION_OPERATION, baseArtifactId: null,
            inputArtifactId: context.manifest.sourceRequirements.artifactId, outputArtifactId: null,
            contextManifest: persistedManifest as unknown as Prisma.InputJsonValue,
            contextHash: context.contextHash, targetSectionKey: null,
            initiatedById: input.actorId, initiatedByType: ArtifactActorType.HUMAN, idempotencyKey,
          } });
          const leased = await tx.projectPhaseState.updateMany({
            where: { id: state.id, stateVersion: state.stateVersion, activeRunId: null, currentArtifactId: null },
            data: { activeRunId: run.id, stateVersion: { increment: 1 } },
          });
          if (leased.count !== 1) throw new PlanningDomainError("PLANNING_GENERATION_IN_PROGRESS", "Another Documentation AI operation acquired the active run lease.", 409);
          return { run, context, reused: false };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        if (error instanceof PlanningDomainError || !isRetryable(error)) throw error;
        if (attempt === MAX_TRANSACTION_ATTEMPTS) break;
      }
    }
    throw new PlanningDomainError("PLANNING_CONCURRENT_UPDATE", "Could not acquire the Documentation run lease.", 409);
  }

  async finalize(input: {
    projectId: string; runId: string; actorId: string; structuredContent: unknown; audit: DocumentationGenerationAudit;
  }): Promise<FinalizeDocumentationRunResult> {
    for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          await this.authorization.assertCanEditInTransaction(tx, input.projectId, input.actorId);
          const run = await tx.workflowRun.findFirst({ where: {
            id: input.runId, projectId: input.projectId, currentPhase: DOCUMENTATION_PHASE,
            operation: WorkflowOperation.INITIAL_GENERATION,
          } });
          const manifest = run ? manifestFrom(run) : null;
          if (!run || run.status !== "running" || !manifest || run.initiatedById !== input.actorId
            || manifest.target !== "documentation" || manifest.operation !== DOCUMENTATION_OPERATION
            || run.contextHash !== manifest.contextHash || run.inputArtifactId !== manifest.sourceRequirements.artifactId) {
            throw new PlanningDomainError("PLANNING_CONTEXT_CHANGED", "The Documentation generation run is no longer current.", 409, { runId: input.runId });
          }
          const [state, requirementsState, requirementsArtifact, project] = await Promise.all([
            tx.projectPhaseState.findUnique({ where: { projectId_phase: { projectId: input.projectId, phase: DOCUMENTATION_PHASE } } }),
            tx.projectPhaseState.findUnique({ where: { projectId_phase: { projectId: input.projectId, phase: REQUIREMENTS_PHASE } }, select: { currentApprovedArtifactId: true } }),
            tx.phaseArtifact.findUnique({ where: { id: manifest.sourceRequirements.artifactId } }),
            tx.project.findUnique({ where: { id: input.projectId }, select: { id: true, name: true, description: true, currentPhase: true, memorySummary: true } }),
          ]);
          if (!state || state.activeRunId !== run.id || state.currentArtifactId !== null
            || requirementsState?.currentApprovedArtifactId !== manifest.sourceRequirements.artifactId
            || !requirementsArtifact || requirementsArtifact.version !== manifest.sourceRequirements.version
            || requirementsArtifact.contentHash !== manifest.sourceRequirements.contentHash || !project) {
            throw new PlanningDomainError("PLANNING_CONTEXT_CHANGED", "Documentation authority changed before generation could be persisted.", 409, { runId: run.id });
          }
          const requirements = parseRequirementsContent(requirementsArtifact.structuredContent);
          if (hashRequirementsContent(requirements) !== manifest.sourceRequirements.contentHash
            || canonicalJson(manifest.project) !== canonicalJson({ id: project.id, name: project.name, description: project.description, currentPhase: project.currentPhase })) {
            throw new PlanningDomainError("PLANNING_CONTEXT_CHANGED", "Documentation context changed before generation could be persisted.", 409, { runId: run.id });
          }
          if (manifest.memory) {
            const summary = project.memorySummary?.summary.replace(/\r\n?/g, "\n").trim();
            const hash = summary === undefined ? null : crypto.createHash("sha256").update(summary, "utf8").digest("hex");
            if (!project.memorySummary || project.memorySummary.id !== manifest.memory.id
              || project.memorySummary.version !== manifest.memory.version || hash !== manifest.memory.hash) {
              throw new PlanningDomainError("PLANNING_CONTEXT_CHANGED", "Opted-in project memory changed during Documentation generation.", 409, { runId: run.id });
            }
          }
          const { artifact, state: artifactState } = await this.artifacts.createInitialArtifactInTransaction(tx, {
            projectId: input.projectId, actorId: input.actorId, title: "Documentation v1",
            structuredContent: input.structuredContent, createdByType: ArtifactActorType.AI,
            changeKind: ArtifactChangeKind.INITIAL_GENERATION,
          });
          if (artifactState.id !== state.id || artifactState.stateVersion !== state.stateVersion) {
            throw new PlanningDomainError("PLANNING_CONTEXT_CHANGED", "Documentation state changed during finalization.", 409, { runId: run.id });
          }
          const advanced = await tx.projectPhaseState.updateMany({
            where: { id: state.id, stateVersion: state.stateVersion, activeRunId: run.id, currentArtifactId: null },
            data: { status: "in_progress", startedAt: state.startedAt ?? new Date(), currentArtifactId: artifact.id,
              approvalCandidateArtifactId: null, activeRunId: null, stateVersion: { increment: 1 } },
          });
          if (advanced.count !== 1) throw new PlanningDomainError("PLANNING_CONTEXT_CHANGED", "Documentation changed concurrently during finalization.", 409, { runId: run.id });
          await tx.project.update({ where: { id: input.projectId }, data: { currentPhase: DOCUMENTATION_PHASE } });
          const validated = await this.artifacts.validatePersistedArtifactInTransaction(tx, input.projectId, artifact);
          const readiness = this.readiness.evaluateDocumentation({
            artifact, historicalRequirements: validated.historicalRequirements,
            currentApprovedRequirements: validated.currentApprovedRequirements,
          });
          const completed = await tx.workflowRun.updateMany({
            where: { id: run.id, status: "running", outputArtifactId: null },
            data: { status: "completed", outputArtifactId: artifact.id, modelUsage: input.audit.modelUsage,
              costUSD: input.audit.costUSD, completedAt: new Date(), errorCode: null, errorMessage: null },
          });
          if (completed.count !== 1) throw new PlanningDomainError("PLANNING_CONTEXT_CHANGED", "Documentation run changed concurrently during completion.", 409, { runId: run.id });
          return { run: await tx.workflowRun.findUniqueOrThrow({ where: { id: run.id } }), artifact, readiness };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        if (error instanceof PlanningDomainError || !isRetryable(error)) throw error;
        if (attempt === MAX_TRANSACTION_ATTEMPTS) break;
      }
    }
    throw new PlanningDomainError("PLANNING_CONCURRENT_UPDATE", "Documentation generation could not be finalized because planning state changed concurrently.", 409);
  }

  async finish(projectId: string, runId: string, status: "failed" | "conflicted" | "cancelled", failure: DocumentationRunFailure, audit?: DocumentationGenerationAudit): Promise<WorkflowRun> {
    return this.prisma.$transaction(async (tx) => {
      const run = await tx.workflowRun.findFirst({ where: { id: runId, projectId, currentPhase: DOCUMENTATION_PHASE } });
      if (!run) throw new PlanningDomainError("PLANNING_PROJECT_NOT_FOUND", "Documentation run was not found or is not accessible.", 404);
      if (run.status === status) return run;
      if (run.status !== "running") throw new PlanningDomainError("PLANNING_CONTEXT_CHANGED", "Documentation run is already terminal.", 409, { runId, status: run.status });
      const updated = await tx.workflowRun.update({ where: { id: run.id }, data: {
        status, completedAt: new Date(), errorCode: failure.code, errorMessage: failureJson(failure),
        ...(audit ? { modelUsage: audit.modelUsage, costUSD: audit.costUSD } : {}),
      } });
      await tx.projectPhaseState.updateMany({
        where: { projectId, phase: DOCUMENTATION_PHASE, activeRunId: run.id },
        data: { activeRunId: null, stateVersion: { increment: 1 } },
      });
      return updated;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  private async recoverOrReject(tx: Prisma.TransactionClient, state: ProjectPhaseState): Promise<ProjectPhaseState> {
    if (!state.activeRunId) return state;
    const active = await tx.workflowRun.findUnique({ where: { id: state.activeRunId } });
    const stale = active?.status === "running" && Date.now() - active.startedAt.getTime() > DOCUMENTATION_ACTIVE_RUN_STALE_MS;
    if (active?.status === "running" && !stale) throw new PlanningDomainError("PLANNING_GENERATION_IN_PROGRESS", "A Documentation AI operation is already in progress.", 409, { activeRunId: active.id });
    if (active && stale) await tx.workflowRun.update({ where: { id: active.id }, data: {
      status: "failed", completedAt: new Date(), errorCode: "PLANNING_STALE_RUN_RECOVERED",
      errorMessage: failureJson({ code: "PLANNING_STALE_RUN_RECOVERED", message: "The abandoned Documentation run lease expired and was recovered by a later request." }),
    } });
    return tx.projectPhaseState.update({ where: { id: state.id }, data: { activeRunId: null, stateVersion: { increment: 1 } } });
  }
}
