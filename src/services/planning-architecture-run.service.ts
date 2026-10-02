import crypto from "crypto";
import {
  ArtifactActorType, ArtifactChangeKind, ArtifactLifecycleStatus, PhaseArtifact, Prisma,
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
import { canonicalJson, hashCanonical } from "../planning/requirements-context";
import { ARCHITECTURE_CANONICAL_JSON_MAX_BYTES, ArchitectureContent, ArchitectureValidationError, hashArchitectureContent, parseArchitectureContent, renderArchitectureMarkdown, ARCHITECTURE_SCHEMA_VERSION } from "../planning/architecture-schema";
import { assembleArchitectureContent } from "../planning/architecture-assembly";
import { ArchitectureDeterministicDiff, ArchitectureRevisionOperation, ARCHITECTURE_REVISION_OPERATIONS, ComponentRetirement, IdentityRetirement, computeArchitectureDiff, normalizeComponentRetirements, normalizeIdentityRetirements, validateIdentityRetirementBase, validateArchitectureRevisionStableIds } from "../planning/architecture-revision-policy";
import { hashRequirementsContent, parseRequirementsContent, renderRequirementsMarkdown, REQUIREMENTS_ARTIFACT_TYPE, REQUIREMENTS_SCHEMA_VERSION } from "../planning/requirements-schema";
import { PlanningArchitectureArtifactService } from "./planning-architecture-artifact.service";
import { ArchitectureReadiness, PlanningArchitectureReadinessService } from "./planning-architecture-readiness.service";
import { PlanningAuthorizationService } from "./planning-authorization.service";

const MAX_TRANSACTION_ATTEMPTS = 3;
export interface ArchitectureRunAudit { modelUsage: Prisma.InputJsonObject; costUSD: number | null }
export interface ArchitectureRunResult { run: WorkflowRun; artifact: PhaseArtifact; readiness: ArchitectureReadiness }
export type ArchitectureStartResult = { run: WorkflowRun; context: BuiltArchitectureContext; reused: false }
  | { run: WorkflowRun; context: null; reused: true };
export interface ArchitectureRevisionManifest extends Omit<ArchitectureContextManifest, "operation"> {
  operation: ArchitectureRevisionOperation;
  baseArtifact: { id: string; version: number; contentHash: string; lifecycleStatus: ArtifactLifecycleStatus };
  instruction: string;
  rebaseToCurrentAuthorities: boolean;
  componentRetirements: ComponentRetirement[];
  identityRetirements: IdentityRetirement[];
}
export interface ArchitectureRevisionContext {
  manifest: ArchitectureRevisionManifest;
  payload: BuiltArchitectureContext["payload"] & { baseArchitecture: ArchitectureContent; instruction: string; operation: ArchitectureRevisionOperation; rebaseToCurrentAuthorities: boolean; componentRetirements: ComponentRetirement[]; identityRetirements: IdentityRetirement[] };
}
export type ArchitectureRevisionStart = { run: WorkflowRun; context: ArchitectureRevisionContext; reused: false } | { run: WorkflowRun; context: null; reused: true };
export interface ArchitectureRevisionResult extends ArchitectureRunResult { diff: ArchitectureDeterministicDiff }

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
function revisionManifestFrom(run: WorkflowRun): ArchitectureRevisionManifest | null {
  if (!run.contextManifest || typeof run.contextManifest !== "object" || Array.isArray(run.contextManifest)) return null;
  const value = run.contextManifest as Record<string, unknown>;
  if (value.target !== "architecture" || !ARCHITECTURE_REVISION_OPERATIONS.includes(value.operation as ArchitectureRevisionOperation) ||
    typeof value.contextHash !== "string" || typeof value.requestFingerprint !== "string" ||
    typeof value.instruction !== "string" || typeof value.rebaseToCurrentAuthorities !== "boolean" ||
    !value.baseArtifact || !value.sourceRequirements || !value.sourceDocumentation || !value.project) return null;
  try {
    if (value.componentRetirements !== undefined &&
        canonicalJson(normalizeComponentRetirements(value.componentRetirements)) !== canonicalJson(value.componentRetirements)) return null;
    if (value.identityRetirements !== undefined &&
        canonicalJson(normalizeIdentityRetirements(value.identityRetirements)) !== canonicalJson(value.identityRetirements)) return null;
  } catch { return null; }
  return { ...value, componentRetirements: value.componentRetirements ?? [], identityRetirements: value.identityRetirements ?? [] } as unknown as ArchitectureRevisionManifest;
}
function revisionFingerprint(input: { projectId: string; operation: ArchitectureRevisionOperation; baseArtifactId: string; baseVersion: number; baseContentHash: string; instruction: string; includeMemory: boolean; rebaseToCurrentAuthorities: boolean; componentRetirements: ComponentRetirement[]; identityRetirements: IdentityRetirement[] }): string {
  return hashCanonical({ projectId: input.projectId, operation: input.operation,
    baseArtifact: { id: input.baseArtifactId, version: input.baseVersion, contentHash: input.baseContentHash },
    instruction: input.instruction.trim().replace(/\r\n?/g, "\n"), includeMemory: input.includeMemory,
    rebaseToCurrentAuthorities: input.rebaseToCurrentAuthorities, componentRetirements: input.componentRetirements,
    identityRetirements: input.identityRetirements });
}
function componentOnlyRevisionFingerprint(input: Parameters<typeof revisionFingerprint>[0]): string {
  return hashCanonical({ projectId: input.projectId, operation: input.operation,
    baseArtifact: { id: input.baseArtifactId, version: input.baseVersion, contentHash: input.baseContentHash },
    instruction: input.instruction.trim().replace(/\r\n?/g, "\n"), includeMemory: input.includeMemory,
    rebaseToCurrentAuthorities: input.rebaseToCurrentAuthorities, componentRetirements: input.componentRetirements });
}
function legacyRevisionFingerprint(input: Parameters<typeof revisionFingerprint>[0]): string {
  return hashCanonical({ projectId: input.projectId, operation: input.operation,
    baseArtifact: { id: input.baseArtifactId, version: input.baseVersion, contentHash: input.baseContentHash },
    instruction: input.instruction.trim().replace(/\r\n?/g, "\n"), includeMemory: input.includeMemory,
    rebaseToCurrentAuthorities: input.rebaseToCurrentAuthorities });
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

  async startRevision(input: { projectId: string; actorId: string; idempotencyKey: string;
    operation: ArchitectureRevisionOperation; baseArtifactId: string; baseVersion: number; baseContentHash: string;
    instruction: string; includeMemory: boolean; rebaseToCurrentAuthorities: boolean; componentRetirements?: ComponentRetirement[]; identityRetirements?: IdentityRetirement[] }): Promise<ArchitectureRevisionStart> {
    if (!ARCHITECTURE_REVISION_OPERATIONS.includes(input.operation) ||
        (input.rebaseToCurrentAuthorities && input.operation !== "DOCUMENT_REVISION") ||
        !Number.isSafeInteger(input.baseVersion) || input.baseVersion < 1 ||
        !/^[a-f0-9]{64}$/.test(input.baseContentHash) ||
        !input.instruction.trim() || Buffer.byteLength(input.instruction, "utf8") > 8192)
      throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", "Architecture revision request is invalid.", 422);
    let componentRetirements: ComponentRetirement[];
    let identityRetirements: IdentityRetirement[];
    try {
      componentRetirements = normalizeComponentRetirements(input.componentRetirements);
      identityRetirements = normalizeIdentityRetirements(input.identityRetirements);
    }
    catch (error) {
      if (error instanceof ArchitectureValidationError) throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", error.message, 422, { path: error.path });
      throw error;
    }
    const accepted = { ...input, instruction: input.instruction.replace(/\r\n?/g, "\n").trim(), componentRetirements, identityRetirements };
    const idempotencyKey = scopedKey(input.idempotencyKey);
    const fingerprint = revisionFingerprint(accepted);
    for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          await this.authorization.assertCanEditInTransaction(tx, input.projectId, input.actorId);
          const existing = await tx.workflowRun.findUnique({ where: { projectId_idempotencyKey: { projectId: input.projectId, idempotencyKey } } });
          if (existing) {
            const manifest = revisionManifestFrom(existing);
            if (!manifest || existing.currentPhase !== ARCHITECTURE_PHASE || existing.operation !== input.operation ||
              existing.baseArtifactId !== input.baseArtifactId || existing.contextHash !== manifest.contextHash ||
              (manifest.requestFingerprint !== fingerprint &&
                !(identityRetirements.length === 0 &&
                  !(existing.contextManifest as Record<string, unknown>).identityRetirements &&
                  manifest.requestFingerprint === componentOnlyRevisionFingerprint(accepted)) &&
                !(identityRetirements.length === 0 && componentRetirements.length === 0 &&
                  !(existing.contextManifest as Record<string, unknown>).componentRetirements &&
                  manifest.requestFingerprint === legacyRevisionFingerprint(accepted))) || manifest.project.id !== input.projectId)
              throw new PlanningDomainError("PLANNING_IDEMPOTENCY_CONFLICT", "The Idempotency-Key was already used with different Architecture request content.", 409, { runId: existing.id });
            return { run: existing, context: null, reused: true };
          }
          const [project, base] = await Promise.all([
            tx.project.findUnique({ where: { id: input.projectId }, select: { currentPhase: true } }),
            tx.phaseArtifact.findUnique({ where: { id: input.baseArtifactId } }),
          ]);
          let state = await tx.projectPhaseState.findUnique({ where: { projectId_phase: { projectId: input.projectId, phase: ARCHITECTURE_PHASE } } });
          if (!project || !state ||
              !["in_progress", "changes_requested", "approved"].includes(state.status) || state.approvalCandidateArtifactId)
            throw new PlanningDomainError("PLANNING_ACTION_LOCKED", "Architecture revision is unavailable in the current phase state.", 409);
          if (!base || base.projectId !== input.projectId || base.phase !== ARCHITECTURE_PHASE || base.type !== ARCHITECTURE_ARTIFACT_TYPE)
            throw new PlanningDomainError("PLANNING_ARTIFACT_PROJECT_MISMATCH", "Architecture base was not found in this project.", 404);
          if (state.currentArtifactId !== base.id || base.version !== input.baseVersion || base.contentHash !== input.baseContentHash ||
              (base.lifecycleStatus !== ArtifactLifecycleStatus.DRAFT && base.lifecycleStatus !== ArtifactLifecycleStatus.APPROVED))
            throw new PlanningDomainError("PLANNING_ARTIFACT_BASE_CHANGED", "Architecture base is no longer current.", 409);
          if ((state.status === "approved") !== (base.lifecycleStatus === ArtifactLifecycleStatus.APPROVED) ||
              (state.status === "approved" && state.currentApprovedArtifactId !== base.id))
            throw new PlanningDomainError("PLANNING_ACTION_LOCKED", "Architecture baseline re-entry is not valid.", 409);
          if (project.currentPhase !== ARCHITECTURE_PHASE &&
              !(state.status === "approved" && base.lifecycleStatus === ArtifactLifecycleStatus.APPROVED &&
                state.currentApprovedArtifactId === base.id))
            throw new PlanningDomainError("PLANNING_ACTION_LOCKED", "Architecture revision is unavailable in the current project phase.", 409);
          const latest = await tx.phaseArtifact.findFirst({ where: { projectId: input.projectId, phase: ARCHITECTURE_PHASE, type: ARCHITECTURE_ARTIFACT_TYPE }, orderBy: { version: "desc" }, select: { id: true } });
          if (latest?.id !== base.id) throw new PlanningDomainError("PLANNING_ARTIFACT_BASE_CHANGED", "A newer Architecture version exists.", 409);
          const baseContent = this.validateBase(base);
          try { validateIdentityRetirementBase(baseContent, componentRetirements, identityRetirements); }
          catch (error) {
            if (error instanceof ArchitectureValidationError) throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", error.message, 422, { path: error.path });
            throw error;
          }
          const authority = await preflightArchitectureHandoff(tx, input.projectId);
          if (!input.rebaseToCurrentAuthorities &&
              (!this.sourceMatches(baseContent.sourceRequirements, authority.requirements.artifact) ||
               !this.sourceMatches(baseContent.sourceDocumentation, authority.documentation.artifact)))
            throw new PlanningDomainError("PLANNING_CONTEXT_CHANGED", "Architecture upstream authority is stale; request an explicit rebase.", 409);
          const built = await this.contexts.buildInTransaction(tx, { ...input, authority });
          const payload: ArchitectureRevisionContext["payload"] = { ...built.payload, baseArchitecture: baseContent,
            operation: input.operation, instruction: accepted.instruction, rebaseToCurrentAuthorities: input.rebaseToCurrentAuthorities, componentRetirements, identityRetirements };
          const unsigned = { ...built.manifest, operation: input.operation,
            baseArtifact: { id: base.id, version: base.version, contentHash: base.contentHash!, lifecycleStatus: base.lifecycleStatus },
            instruction: accepted.instruction, rebaseToCurrentAuthorities: input.rebaseToCurrentAuthorities, componentRetirements, identityRetirements,
            builderVersion: "architecture-revision-context-v1", promptVersion: "architecture-revision-v1" };
          const manifest: ArchitectureRevisionManifest = { ...unsigned, contextHash: hashCanonical({ ...unsigned, payload }), requestFingerprint: fingerprint };
          if (state.activeRunId) state = await this.recoverOrReject(tx, state);
          const run = await tx.workflowRun.create({ data: {
            projectId: input.projectId, triggerType: "manual", currentPhase: ARCHITECTURE_PHASE,
            status: "running", operation: input.operation, baseArtifactId: base.id, inputArtifactId: base.id,
            contextManifest: manifest as unknown as Prisma.InputJsonValue, contextHash: manifest.contextHash,
            initiatedById: input.actorId, initiatedByType: ArtifactActorType.HUMAN, idempotencyKey,
          } });
          const leased = await tx.projectPhaseState.updateMany({ where: { id: state.id, stateVersion: state.stateVersion,
            activeRunId: null, currentArtifactId: base.id, approvalCandidateArtifactId: null },
            data: { activeRunId: run.id, stateVersion: { increment: 1 } } });
          if (leased.count !== 1) throw contextChanged(run.id);
          return { run, context: { manifest, payload }, reused: false };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        if (error instanceof PlanningDomainError || !retryable(error)) throw error;
        if (attempt === MAX_TRANSACTION_ATTEMPTS) break;
      }
    }
    throw new PlanningDomainError("PLANNING_CONCURRENT_UPDATE", "Could not acquire the Architecture revision lease.", 409);
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

  async finalizeRevision(input: { projectId: string; runId: string; actorId: string;
    structuredContent: unknown; audit: ArchitectureRunAudit }): Promise<ArchitectureRevisionResult> {
    for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          await this.authorization.assertCanEditInTransaction(tx, input.projectId, input.actorId);
          const run = await tx.workflowRun.findFirst({ where: { id: input.runId, projectId: input.projectId, currentPhase: ARCHITECTURE_PHASE } });
          const manifest = run ? revisionManifestFrom(run) : null;
          if (!run || !manifest || run.status !== "running" || run.operation !== manifest.operation ||
              run.initiatedById !== input.actorId || run.baseArtifactId !== manifest.baseArtifact.id ||
              run.contextHash !== manifest.contextHash) throw contextChanged(input.runId);
          const [state, project, base] = await Promise.all([
            tx.projectPhaseState.findUnique({ where: { projectId_phase: { projectId: input.projectId, phase: ARCHITECTURE_PHASE } } }),
            tx.project.findUnique({ where: { id: input.projectId }, select: { id: true, name: true, description: true, currentPhase: true, memorySummary: true } }),
            tx.phaseArtifact.findUnique({ where: { id: manifest.baseArtifact.id } }),
          ]);
          if (!state || state.activeRunId !== run.id || state.currentArtifactId !== manifest.baseArtifact.id ||
              state.approvalCandidateArtifactId || !["in_progress", "changes_requested", "approved"].includes(state.status) ||
              !project ||
              canonicalJson(manifest.project) !== canonicalJson({ id: project.id, name: project.name, description: project.description, currentPhase: project.currentPhase }) ||
              !base || base.version !== manifest.baseArtifact.version || base.contentHash !== manifest.baseArtifact.contentHash ||
              base.lifecycleStatus !== manifest.baseArtifact.lifecycleStatus) throw contextChanged(run.id);
          if (project.currentPhase !== ARCHITECTURE_PHASE &&
              !(state.status === "approved" && base.lifecycleStatus === ArtifactLifecycleStatus.APPROVED &&
                state.currentApprovedArtifactId === base.id)) throw contextChanged(run.id);
          if ((state.status === "approved") !== (base.lifecycleStatus === ArtifactLifecycleStatus.APPROVED) ||
              (state.status === "approved" && state.currentApprovedArtifactId !== base.id)) throw contextChanged(run.id);
          const baseContent = this.validateBase(base);
          if (manifest.memory) {
            const summary = project.memorySummary?.summary.replace(/\r\n?/g, "\n").trim();
            const hash = summary === undefined ? null : crypto.createHash("sha256").update(summary, "utf8").digest("hex");
            if (!project.memorySummary || project.memorySummary.id !== manifest.memory.id ||
                project.memorySummary.version !== manifest.memory.version ||
                project.memorySummary.lastUpdated.toISOString() !== manifest.memory.lastUpdated || hash !== manifest.memory.hash)
              throw contextChanged(run.id);
          } else if (manifest.includeMemory && project.memorySummary) throw contextChanged(run.id);
          let authority: ArchitectureHandoffAuthority;
          try { authority = await preflightArchitectureHandoff(tx, input.projectId); }
          catch { throw contextChanged(run.id); }
          if (!sameSource(manifest.sourceRequirements, sourceOf(authority.requirements)) ||
              !sameSource(manifest.sourceDocumentation, sourceOf(authority.documentation))) throw contextChanged(run.id);
          if (!manifest.rebaseToCurrentAuthorities &&
              (!this.sourceMatches(baseContent.sourceRequirements, authority.requirements.artifact) ||
               !this.sourceMatches(baseContent.sourceDocumentation, authority.documentation.artifact))) throw contextChanged(run.id);
          let content: ArchitectureContent;
          try {
            content = assembleArchitectureContent(input.structuredContent,
              { artifactId: authority.requirements.artifact.id, version: authority.requirements.artifact.version, contentHash: authority.requirements.contentHash },
              { artifactId: authority.documentation.artifact.id, version: authority.documentation.artifact.version, contentHash: authority.documentation.contentHash },
              authority.requirements.content, authority.documentation.content);
            validateArchitectureRevisionStableIds(baseContent, content, manifest.componentRetirements, manifest.identityRetirements);
          } catch (error) {
            if (error instanceof ArchitectureValidationError) throw new PlanningDomainError("PLANNING_AI_INVALID_RESPONSE", error.message, 502, { path: error.path });
            throw error;
          }
          if (Buffer.byteLength(canonicalJson(content), "utf8") > ARCHITECTURE_CANONICAL_JSON_MAX_BYTES)
            throw new PlanningDomainError("PLANNING_AI_OUTPUT_TOO_LARGE", "Revised Architecture exceeds the canonical size limit.", 502);
          const diff = computeArchitectureDiff(baseContent, content);
          if (!diff.changedRootSections.length && !diff.provenanceChanged)
            throw new PlanningDomainError("PLANNING_REVISION_NO_CHANGES", "Architecture revision produced no canonical changes.", 422);
          const latest = await tx.phaseArtifact.findFirst({ where: { projectId: input.projectId, phase: ARCHITECTURE_PHASE,
            type: ARCHITECTURE_ARTIFACT_TYPE }, orderBy: { version: "desc" }, select: { id: true } });
          if (latest?.id !== base.id) throw contextChanged(run.id);
          const artifact = await tx.phaseArtifact.create({ data: {
            projectId: input.projectId, phase: ARCHITECTURE_PHASE, type: ARCHITECTURE_ARTIFACT_TYPE,
            title: base.title, content: renderArchitectureMarkdown(content), structuredContent: content as unknown as Prisma.InputJsonValue,
            schemaVersion: ARCHITECTURE_SCHEMA_VERSION, contentHash: hashArchitectureContent(content), version: base.version + 1,
            previousVersionId: base.id, basedOnArtifactId: base.id,
            changeKind: run.operation === "DOCUMENT_REVISION" ? ArtifactChangeKind.AI_DOCUMENT_REVISION : ArtifactChangeKind.FEEDBACK_APPLICATION,
            createdBy: input.actorId, createdByType: ArtifactActorType.AI,
            lifecycleStatus: ArtifactLifecycleStatus.DRAFT, approved: false,
          } });
          const advanced = await tx.projectPhaseState.updateMany({ where: { id: state.id, stateVersion: state.stateVersion,
            activeRunId: run.id, currentArtifactId: base.id, approvalCandidateArtifactId: null },
            data: { status: "in_progress", currentArtifactId: artifact.id, activeRunId: null,
              notes: null, stateVersion: { increment: 1 } } });
          if (advanced.count !== 1) throw contextChanged(run.id);
          await tx.project.update({ where: { id: input.projectId }, data: { currentPhase: ARCHITECTURE_PHASE } });
          this.artifacts.validatePersisted(artifact, authority);
          const readiness = this.readiness.evaluateArchitecture(artifact, authority);
          const completed = await tx.workflowRun.updateMany({ where: { id: run.id, status: "running", outputArtifactId: null },
            data: { status: "completed", outputArtifactId: artifact.id, modelUsage: input.audit.modelUsage,
              costUSD: input.audit.costUSD, completedAt: new Date(), errorCode: null, errorMessage: null } });
          if (completed.count !== 1) throw contextChanged(run.id);
          return { run: await tx.workflowRun.findUniqueOrThrow({ where: { id: run.id } }), artifact, readiness, diff };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        if (error instanceof PlanningDomainError || !retryable(error)) throw error;
        if (attempt === MAX_TRANSACTION_ATTEMPTS) break;
      }
    }
    throw new PlanningDomainError("PLANNING_CONCURRENT_UPDATE", "Architecture revision changed concurrently.", 409);
  }

  private validateBase(base: PhaseArtifact): ArchitectureContent {
    if (base.schemaVersion !== ARCHITECTURE_SCHEMA_VERSION || base.structuredContent === null)
      throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", "Architecture base is invalid.", 422);
    let content: ArchitectureContent;
    try { content = parseArchitectureContent(base.structuredContent); }
    catch { throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", "Architecture base is invalid.", 422); }
    if (canonicalJson(base.structuredContent) !== canonicalJson(content) ||
        base.contentHash !== hashArchitectureContent(content) || base.content !== renderArchitectureMarkdown(content) ||
        Buffer.byteLength(canonicalJson(content), "utf8") > ARCHITECTURE_CANONICAL_JSON_MAX_BYTES)
      throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", "Architecture base integrity check failed.", 422);
    return content;
  }
  private sourceMatches(source: { artifactId: string; version: number; contentHash: string }, artifact: PhaseArtifact): boolean {
    return source.artifactId === artifact.id && source.version === artifact.version && source.contentHash === artifact.contentHash;
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

  async historicalRevisionResult(projectId: string, run: WorkflowRun): Promise<ArchitectureRevisionResult> {
    const manifest = revisionManifestFrom(run);
    if (!manifest || run.status !== "completed" || !run.outputArtifactId || !run.baseArtifactId ||
        run.projectId !== projectId || run.operation !== manifest.operation || run.contextHash !== manifest.contextHash)
      throw new PlanningDomainError("PLANNING_RUN_INVARIANT", "Completed Architecture revision is invalid.", 500);
    return this.prisma.$transaction(async (tx) => {
      const source = async (identity: ArchitectureSourceIdentity, phase: string, type: string, schemaVersion: number) => {
        const [artifact, approval] = await Promise.all([
          tx.phaseArtifact.findUnique({ where: { id: identity.artifactId } }),
          tx.phaseApproval.findUnique({ where: { id: identity.approvalId } }),
        ]);
        if (!artifact || artifact.projectId !== projectId || artifact.phase !== phase || artifact.type !== type ||
            artifact.schemaVersion !== schemaVersion || artifact.version !== identity.version || artifact.contentHash !== identity.contentHash ||
            artifact.structuredContent === null || artifact.lifecycleStatus !== ArtifactLifecycleStatus.APPROVED || !artifact.approved ||
            !artifact.approvedAt || !approval || approval.projectId !== projectId || approval.phase !== phase ||
            approval.artifactId !== artifact.id || approval.artifactVersion !== artifact.version ||
            approval.artifactContentHash !== identity.contentHash || approval.decision !== "approved" || approval.legacyUnverified ||
            approval.approvedById !== identity.approvedById || approval.approvedAt.toISOString() !== identity.approvedAt ||
            artifact.approvedAt.toISOString() !== identity.approvedAt)
          throw new PlanningDomainError("PLANNING_RUN_INVARIANT", "Historical Architecture authority is invalid.", 500);
        return artifact;
      };
      const req = await source(manifest.sourceRequirements, "requirements", REQUIREMENTS_ARTIFACT_TYPE, REQUIREMENTS_SCHEMA_VERSION);
      const doc = await source(manifest.sourceDocumentation, "documentation", DOCUMENTATION_ARTIFACT_TYPE, DOCUMENTATION_SCHEMA_VERSION);
      const reqContent = parseRequirementsContent(req.structuredContent);
      const docContent = parseDocumentationContent(doc.structuredContent);
      if (hashRequirementsContent(reqContent) !== req.contentHash || req.content !== renderRequirementsMarkdown(reqContent) ||
          hashDocumentationContent(docContent) !== doc.contentHash || doc.content !== renderDocumentationMarkdown(docContent) ||
          canonicalJson(docContent.sourceRequirements) !== canonicalJson({ artifactId: req.id, version: req.version, contentHash: req.contentHash }))
        throw new PlanningDomainError("PLANNING_RUN_INVARIANT", "Historical Architecture authority is corrupted.", 500);
      const authority: ArchitectureHandoffAuthority = { projectId,
        requirements: { artifact: req, content: reqContent, contentHash: req.contentHash!, approvalId: manifest.sourceRequirements.approvalId,
          approvedAt: req.approvedAt!, approvedById: manifest.sourceRequirements.approvedById },
        documentation: { artifact: doc, content: docContent, contentHash: doc.contentHash!, approvalId: manifest.sourceDocumentation.approvalId,
          approvedAt: doc.approvedAt!, approvedById: manifest.sourceDocumentation.approvedById },
      };
      const [base, artifact] = await Promise.all([
        tx.phaseArtifact.findUnique({ where: { id: run.baseArtifactId! } }),
        tx.phaseArtifact.findUnique({ where: { id: run.outputArtifactId! } }),
      ]);
      if (!base || !artifact || base.projectId !== projectId || artifact.projectId !== projectId ||
          base.id !== manifest.baseArtifact.id || base.version !== manifest.baseArtifact.version ||
          base.contentHash !== manifest.baseArtifact.contentHash || artifact.previousVersionId !== base.id ||
          artifact.basedOnArtifactId !== base.id || artifact.version !== base.version + 1 ||
          artifact.createdByType !== ArtifactActorType.AI || artifact.createdBy !== run.initiatedById ||
          artifact.changeKind !== (run.operation === "DOCUMENT_REVISION" ? ArtifactChangeKind.AI_DOCUMENT_REVISION : ArtifactChangeKind.FEEDBACK_APPLICATION))
        throw new PlanningDomainError("PLANNING_RUN_INVARIANT", "Historical Architecture revision output is invalid.", 500);
      const baseContent = this.validateBase(base);
      const nextContent = this.artifacts.validatePersisted(artifact, authority);
      validateArchitectureRevisionStableIds(baseContent, nextContent, manifest.componentRetirements, manifest.identityRetirements);
      return { run, artifact, readiness: this.readiness.evaluateArchitecture(artifact, authority),
        diff: computeArchitectureDiff(baseContent, nextContent) };
    });
  }

  async getRun(projectId: string, runId: string, actorId: string): Promise<WorkflowRun> {
    await this.authorization.assertCanRead(projectId, actorId);
    const run = await this.prisma.workflowRun.findFirst({ where: { id: runId, projectId,
      currentPhase: ARCHITECTURE_PHASE, operation: { in: ["INITIAL_GENERATION", "DOCUMENT_REVISION", "FEEDBACK_APPLICATION"] } } });
    if (!run) throw new PlanningDomainError("PLANNING_PROJECT_NOT_FOUND", "Architecture run was not found or is not accessible.", 404);
    return run;
  }

  async finish(projectId: string, runId: string, status: "failed" | "conflicted" | "cancelled",
    failure: { code: string; message: string }, audit?: ArchitectureRunAudit): Promise<WorkflowRun> {
    return this.prisma.$transaction(async (tx) => {
      const run = await tx.workflowRun.findFirst({ where: { id: runId, projectId,
        currentPhase: ARCHITECTURE_PHASE, operation: { in: ["INITIAL_GENERATION", "DOCUMENT_REVISION", "FEEDBACK_APPLICATION"] } } });
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
