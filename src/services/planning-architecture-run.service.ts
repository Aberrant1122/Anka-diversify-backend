import crypto from "crypto";
import {
  ArtifactActorType, ArtifactLifecycleStatus, PhaseArtifact, Prisma,
  PrismaClient, ProjectPhaseState, WorkflowRun,
} from "@prisma/client";
import {
  architectureRequestFingerprint, ArchitectureContextManifest,
  ArchitectureSourceIdentity, BuiltArchitectureContext, PlanningArchitectureContextBuilder,
} from "../planning/architecture-context";
import { ARCHITECTURE_ACTIVE_RUN_STALE_MS } from "../planning/architecture-run-config";
import { ARCHITECTURE_ARTIFACT_TYPE } from "../planning/architecture-schema";
import { ARCHITECTURE_PHASE, ArchitectureHandoffAuthority, preflightArchitectureHandoff } from "../planning/documentation-architecture-preflight";
import { DOCUMENTATION_ARTIFACT_TYPE, DOCUMENTATION_SCHEMA_VERSION, hashDocumentationContent, parseDocumentationContent, renderDocumentationMarkdown } from "../planning/documentation-schema";
import { PlanningDomainError } from "../planning/planning-errors";
import { canonicalJson } from "../planning/requirements-context";
import { hashRequirementsContent, parseRequirementsContent, renderRequirementsMarkdown, REQUIREMENTS_ARTIFACT_TYPE, REQUIREMENTS_SCHEMA_VERSION } from "../planning/requirements-schema";
import { PlanningArchitectureArtifactService } from "./planning-architecture-artifact.service";
import { ArchitectureReadiness, PlanningArchitectureReadinessService } from "./planning-architecture-readiness.service";
import { PlanningAuthorizationService } from "./planning-authorization.service";

const MAX_TRANSACTION_ATTEMPTS = 3;
export interface ArchitectureRunAudit { modelUsage: Prisma.InputJsonObject; costUSD: number | null }
export interface ArchitectureRunResult { run: WorkflowRun; artifact: PhaseArtifact; readiness: ArchitectureReadiness }
export type ArchitectureStartResult = { run: WorkflowRun; context: BuiltArchitectureContext; reused: false }
  | { run: WorkflowRun; context: null; reused: true };

function retryable(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2002" || error.code === "P2034");
}
function scopedKey(raw: string): string {
  const normalized = raw.trim();
  if (!normalized || normalized.length > 256) throw new PlanningDomainError(
    "PLANNING_ARTIFACT_INVALID", "A valid Idempotency-Key is required for Architecture generation.", 422);
  return `architecture:${crypto.createHash("sha256").update(normalized, "utf8").digest("hex")}`;
}
function manifestFrom(run: WorkflowRun): ArchitectureContextManifest | null {
  if (!run.contextManifest || typeof run.contextManifest !== "object" || Array.isArray(run.contextManifest)) return null;
  const value = run.contextManifest as Record<string, unknown>;
  if (value.target !== "architecture" || value.operation !== "INITIAL_GENERATION" ||
      typeof value.contextHash !== "string" || typeof value.requestFingerprint !== "string" ||
      !value.sourceRequirements || !value.sourceDocumentation || !value.project) return null;
  return value as unknown as ArchitectureContextManifest;
}
function sameSource(a: ArchitectureSourceIdentity, b: ArchitectureSourceIdentity): boolean {
  return canonicalJson(a) === canonicalJson(b);
}
function sourceOf(record: Pick<ArchitectureHandoffAuthority["requirements"], "artifact" | "contentHash" | "approvalId" | "approvedAt" | "approvedById">): ArchitectureSourceIdentity {
  return { artifactId: record.artifact.id, version: record.artifact.version,
    contentHash: record.contentHash, schemaVersion: record.artifact.schemaVersion,
    approvalId: record.approvalId, approvedAt: record.approvedAt.toISOString(),
    approvedById: record.approvedById };
}
function contextChanged(runId: string): PlanningDomainError {
  return new PlanningDomainError("PLANNING_CONTEXT_CHANGED", "Architecture authority or generation state changed before finalization.", 409, { runId });
}

export class PlanningArchitectureRunService {
  private readonly authorization: PlanningAuthorizationService;
  private readonly contexts: PlanningArchitectureContextBuilder;
  private readonly artifacts: PlanningArchitectureArtifactService;
  private readonly readiness: PlanningArchitectureReadinessService;
  constructor(private readonly prisma: PrismaClient, dependencies: {
    authorization?: PlanningAuthorizationService;
    contexts?: PlanningArchitectureContextBuilder;
    artifacts?: PlanningArchitectureArtifactService;
    readiness?: PlanningArchitectureReadinessService;
  } = {}) {
    this.authorization = dependencies.authorization ?? new PlanningAuthorizationService(prisma);
    this.contexts = dependencies.contexts ?? new PlanningArchitectureContextBuilder();
    this.artifacts = dependencies.artifacts ?? new PlanningArchitectureArtifactService(prisma, this.authorization);
    this.readiness = dependencies.readiness ?? new PlanningArchitectureReadinessService();
  }

  async start(input: { projectId: string; actorId: string; idempotencyKey: string; includeMemory: boolean }): Promise<ArchitectureStartResult> {
    const idempotencyKey = scopedKey(input.idempotencyKey);
    for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          await this.authorization.assertCanEditInTransaction(tx, input.projectId, input.actorId);
          const existing = await tx.workflowRun.findUnique({
            where: { projectId_idempotencyKey: { projectId: input.projectId, idempotencyKey } },
          });
          if (existing) {
            const manifest = manifestFrom(existing);
            const fingerprint = manifest && architectureRequestFingerprint(input.projectId,
              manifest.sourceRequirements, manifest.sourceDocumentation, input.includeMemory);
            if (!manifest || existing.currentPhase !== ARCHITECTURE_PHASE ||
              existing.operation !== "INITIAL_GENERATION" ||
              existing.contextHash !== manifest.contextHash ||
              manifest.project.id !== input.projectId ||
              manifest.requestFingerprint !== fingerprint) throw new PlanningDomainError(
                "PLANNING_IDEMPOTENCY_CONFLICT", "The Idempotency-Key was already used with different Architecture request content.", 409,
                { runId: existing.id });
            return { run: existing, context: null, reused: true };
          }
          const project = await tx.project.findUnique({ where: { id: input.projectId }, select: { currentPhase: true } });
          let state = await tx.projectPhaseState.findUnique({
            where: { projectId_phase: { projectId: input.projectId, phase: ARCHITECTURE_PHASE } },
          });
          if (!project || project.currentPhase !== ARCHITECTURE_PHASE || !state) throw new PlanningDomainError(
            "PLANNING_ACTION_LOCKED", "Project is not in the Architecture phase.", 409);
          const authority = await preflightArchitectureHandoff(tx, input.projectId);
          if (state.status !== "not_started" || state.currentArtifactId ||
            state.currentApprovedArtifactId || state.approvalCandidateArtifactId ||
            await tx.phaseArtifact.findFirst({ where: { projectId: input.projectId, phase: ARCHITECTURE_PHASE,
              type: ARCHITECTURE_ARTIFACT_TYPE }, select: { id: true } })) throw new PlanningDomainError(
              "PLANNING_INITIAL_ARTIFACT_EXISTS", "Architecture already has an initial artifact or approval candidate.", 409);
          const context = await this.contexts.buildInTransaction(tx, { ...input, authority });
          if (state.activeRunId) state = await this.recoverOrReject(tx, state);
          const run = await tx.workflowRun.create({ data: {
            projectId: input.projectId, triggerType: "manual", currentPhase: ARCHITECTURE_PHASE,
            status: "running", operation: "INITIAL_GENERATION", inputArtifactId: authority.documentation.artifact.id,
            contextManifest: context.manifest as unknown as Prisma.InputJsonValue,
            contextHash: context.manifest.contextHash, initiatedById: input.actorId,
            initiatedByType: ArtifactActorType.HUMAN, idempotencyKey,
          } });
          const leased = await tx.projectPhaseState.updateMany({
            where: { id: state.id, stateVersion: state.stateVersion, activeRunId: null,
              currentArtifactId: null, currentApprovedArtifactId: null, approvalCandidateArtifactId: null },
            data: { activeRunId: run.id, stateVersion: { increment: 1 } },
          });
          if (leased.count !== 1) throw new PlanningDomainError("PLANNING_GENERATION_IN_PROGRESS",
            "Another Architecture AI operation acquired the lease.", 409);
          return { run, context, reused: false };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        if (error instanceof PlanningDomainError || !retryable(error)) throw error;
        if (attempt === MAX_TRANSACTION_ATTEMPTS) break;
      }
    }
    throw new PlanningDomainError("PLANNING_CONCURRENT_UPDATE", "Could not acquire the Architecture run lease.", 409);
  }

  async finalize(input: { projectId: string; runId: string; actorId: string;
    structuredContent: unknown; audit: ArchitectureRunAudit }): Promise<ArchitectureRunResult> {
    for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          await this.authorization.assertCanEditInTransaction(tx, input.projectId, input.actorId);
          const run = await tx.workflowRun.findFirst({ where: { id: input.runId, projectId: input.projectId,
            currentPhase: ARCHITECTURE_PHASE, operation: "INITIAL_GENERATION" } });
          const manifest = run ? manifestFrom(run) : null;
          if (!run || run.status !== "running" || !manifest ||
            run.initiatedById !== input.actorId || run.contextHash !== manifest.contextHash ||
            run.inputArtifactId !== manifest.sourceDocumentation.artifactId) throw contextChanged(input.runId);
          const [state, project] = await Promise.all([
            tx.projectPhaseState.findUnique({ where: { projectId_phase: { projectId: input.projectId, phase: ARCHITECTURE_PHASE } } }),
            tx.project.findUnique({ where: { id: input.projectId }, select: {
              id: true, name: true, description: true, currentPhase: true, memorySummary: true,
            } }),
          ]);
          if (!state || state.activeRunId !== run.id || state.status !== "not_started" ||
            state.currentArtifactId || state.currentApprovedArtifactId || state.approvalCandidateArtifactId ||
            !project || project.currentPhase !== ARCHITECTURE_PHASE ||
            canonicalJson(manifest.project) !== canonicalJson({ id: project.id, name: project.name,
              description: project.description, currentPhase: project.currentPhase })) throw contextChanged(run.id);
          if (manifest.memory) {
            const summary = project.memorySummary?.summary.replace(/\r\n?/g, "\n").trim();
            const hash = summary === undefined ? null : crypto.createHash("sha256").update(summary, "utf8").digest("hex");
            if (!project.memorySummary || project.memorySummary.id !== manifest.memory.id ||
              project.memorySummary.version !== manifest.memory.version ||
              project.memorySummary.lastUpdated.toISOString() !== manifest.memory.lastUpdated ||
              hash !== manifest.memory.hash) throw contextChanged(run.id);
          } else if (manifest.includeMemory && project.memorySummary) throw contextChanged(run.id);
          let authority: ArchitectureHandoffAuthority;
          try { authority = await preflightArchitectureHandoff(tx, input.projectId); }
          catch { throw contextChanged(run.id); }
          if (!sameSource(manifest.sourceRequirements, sourceOf(authority.requirements)) ||
              !sameSource(manifest.sourceDocumentation, sourceOf(authority.documentation))) throw contextChanged(run.id);
          const { artifact, state: artifactState } = await this.artifacts.createInitialAIInTransaction(tx, {
            ...input, authority,
          });
          if (artifactState.id !== state.id || artifactState.stateVersion !== state.stateVersion) throw contextChanged(run.id);
          const advanced = await tx.projectPhaseState.updateMany({
            where: { id: state.id, stateVersion: state.stateVersion, activeRunId: run.id,
              currentArtifactId: null, currentApprovedArtifactId: null, approvalCandidateArtifactId: null },
            data: { status: "in_progress", startedAt: state.startedAt ?? new Date(),
              currentArtifactId: artifact.id, activeRunId: null, stateVersion: { increment: 1 } },
          });
          if (advanced.count !== 1) throw contextChanged(run.id);
          this.artifacts.validatePersisted(artifact, authority);
          const readiness = this.readiness.evaluateArchitecture(artifact, authority);
          const completed = await tx.workflowRun.updateMany({ where: { id: run.id, status: "running", outputArtifactId: null },
            data: { status: "completed", outputArtifactId: artifact.id, modelUsage: input.audit.modelUsage,
              costUSD: input.audit.costUSD, completedAt: new Date(), errorCode: null, errorMessage: null } });
          if (completed.count !== 1) throw contextChanged(run.id);
          return { run: await tx.workflowRun.findUniqueOrThrow({ where: { id: run.id } }), artifact, readiness };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        if (error instanceof PlanningDomainError || !retryable(error)) throw error;
        if (attempt === MAX_TRANSACTION_ATTEMPTS) break;
      }
    }
    throw new PlanningDomainError("PLANNING_CONCURRENT_UPDATE", "Architecture finalization changed concurrently.", 409);
  }

  async historicalResult(projectId: string, run: WorkflowRun): Promise<ArchitectureRunResult> {
    const manifest = manifestFrom(run);
    if (!manifest || run.status !== "completed" || !run.outputArtifactId ||
      run.currentPhase !== ARCHITECTURE_PHASE || run.projectId !== projectId) throw new PlanningDomainError(
        "PLANNING_RUN_INVARIANT", "Completed Architecture run is invalid.", 500);
    return this.prisma.$transaction(async (tx) => {
      const source = async (identity: ArchitectureSourceIdentity, phase: string, type: string, schemaVersion: number) => {
        const [artifact, approval] = await Promise.all([
          tx.phaseArtifact.findUnique({ where: { id: identity.artifactId } }),
          tx.phaseApproval.findUnique({ where: { id: identity.approvalId } }),
        ]);
        if (!artifact || artifact.projectId !== projectId || artifact.phase !== phase || artifact.type !== type ||
          artifact.schemaVersion !== schemaVersion || artifact.version !== identity.version ||
          artifact.contentHash !== identity.contentHash || artifact.structuredContent === null ||
          artifact.lifecycleStatus !== ArtifactLifecycleStatus.APPROVED || !artifact.approved ||
          !artifact.approvedAt || typeof identity.approvedAt !== "string" ||
          !approval || approval.projectId !== projectId || approval.phase !== phase ||
          approval.artifactId !== artifact.id || approval.artifactVersion !== artifact.version ||
          approval.artifactContentHash !== identity.contentHash || approval.decision !== "approved" ||
          approval.legacyUnverified || approval.approvedById !== identity.approvedById ||
          approval.approvedAt.toISOString() !== artifact.approvedAt.toISOString() ||
          artifact.approvedAt.toISOString() !== identity.approvedAt) throw new PlanningDomainError(
            "PLANNING_RUN_INVARIANT", "Historical Architecture source is invalid.", 500);
        return artifact;
      };
      const req = await source(manifest.sourceRequirements, "requirements", REQUIREMENTS_ARTIFACT_TYPE, REQUIREMENTS_SCHEMA_VERSION);
      const doc = await source(manifest.sourceDocumentation, "documentation", DOCUMENTATION_ARTIFACT_TYPE, DOCUMENTATION_SCHEMA_VERSION);
      const reqContent = parseRequirementsContent(req.structuredContent);
      const docContent = parseDocumentationContent(doc.structuredContent);
      if (hashRequirementsContent(reqContent) !== req.contentHash || req.content !== renderRequirementsMarkdown(reqContent) ||
        hashDocumentationContent(docContent) !== doc.contentHash || doc.content !== renderDocumentationMarkdown(docContent) ||
        canonicalJson(docContent.sourceRequirements) !== canonicalJson({ artifactId: req.id, version: req.version, contentHash: req.contentHash }))
        throw new PlanningDomainError("PLANNING_RUN_INVARIANT", "Historical Architecture source is corrupted.", 500);
      const authority: ArchitectureHandoffAuthority = { projectId,
        requirements: { artifact: req, content: reqContent, contentHash: req.contentHash!,
          approvalId: manifest.sourceRequirements.approvalId, approvedAt: req.approvedAt!, approvedById: manifest.sourceRequirements.approvedById },
        documentation: { artifact: doc, content: docContent, contentHash: doc.contentHash!,
          approvalId: manifest.sourceDocumentation.approvalId, approvedAt: doc.approvedAt!, approvedById: manifest.sourceDocumentation.approvedById },
      };
      const artifact = await tx.phaseArtifact.findUnique({ where: { id: run.outputArtifactId! } });
      if (!artifact || artifact.projectId !== projectId || artifact.createdByType !== ArtifactActorType.AI ||
        artifact.version !== 1) throw new PlanningDomainError("PLANNING_RUN_INVARIANT", "Historical Architecture output is invalid.", 500);
      this.artifacts.validatePersisted(artifact, authority);
      return { run, artifact, readiness: this.readiness.evaluateArchitecture(artifact, authority) };
    });
  }

  async getRun(projectId: string, runId: string, actorId: string): Promise<WorkflowRun> {
    await this.authorization.assertCanRead(projectId, actorId);
    const run = await this.prisma.workflowRun.findFirst({ where: { id: runId, projectId,
      currentPhase: ARCHITECTURE_PHASE, operation: "INITIAL_GENERATION" } });
    if (!run) throw new PlanningDomainError("PLANNING_PROJECT_NOT_FOUND", "Architecture run was not found or is not accessible.", 404);
    return run;
  }

  async finish(projectId: string, runId: string, status: "failed" | "conflicted" | "cancelled",
    failure: { code: string; message: string }, audit?: ArchitectureRunAudit): Promise<WorkflowRun> {
    return this.prisma.$transaction(async (tx) => {
      const run = await tx.workflowRun.findFirst({ where: { id: runId, projectId,
        currentPhase: ARCHITECTURE_PHASE, operation: "INITIAL_GENERATION" } });
      if (!run) throw new PlanningDomainError("PLANNING_PROJECT_NOT_FOUND", "Architecture run was not found or is not accessible.", 404);
      if (run.status === status) return run;
      if (run.status !== "running") throw new PlanningDomainError("PLANNING_CONTEXT_CHANGED", "Architecture run is already terminal.", 409);
      const updated = await tx.workflowRun.update({ where: { id: run.id }, data: {
        status, completedAt: new Date(), errorCode: failure.code,
        errorMessage: canonicalJson({ message: failure.message.slice(0, 8192) }),
        ...(audit ? { modelUsage: audit.modelUsage, costUSD: audit.costUSD } : {}),
      } });
      await tx.projectPhaseState.updateMany({ where: { projectId, phase: ARCHITECTURE_PHASE, activeRunId: run.id },
        data: { activeRunId: null, stateVersion: { increment: 1 } } });
      return updated;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  private async recoverOrReject(tx: Prisma.TransactionClient, state: ProjectPhaseState): Promise<ProjectPhaseState> {
    if (!state.activeRunId) return state;
    const active = await tx.workflowRun.findUnique({ where: { id: state.activeRunId } });
    const stale = active?.status === "running" && Date.now() - active.startedAt.getTime() > ARCHITECTURE_ACTIVE_RUN_STALE_MS;
    if (active?.status === "running" && !stale) throw new PlanningDomainError(
      "PLANNING_GENERATION_IN_PROGRESS", "An Architecture AI operation is already in progress.", 409,
      { activeRunId: active.id });
    if (active && stale) await tx.workflowRun.update({ where: { id: active.id }, data: {
      status: "failed", completedAt: new Date(), errorCode: "PLANNING_STALE_RUN_RECOVERED",
      errorMessage: canonicalJson({ message: "The abandoned Architecture run lease expired and was recovered." }),
    } });
    return tx.projectPhaseState.update({ where: { id: state.id }, data: {
      activeRunId: null, stateVersion: { increment: 1 },
    } });
  }
}
