import {
  ArtifactActorType, ArtifactChangeKind, ArtifactLifecycleStatus,
  PhaseArtifact, Prisma, PrismaClient,
} from "@prisma/client";
import { architectureTraceabilityMatches, assembleArchitectureContent } from "../planning/architecture-assembly";
import {
  ARCHITECTURE_ARTIFACT_TYPE, ARCHITECTURE_CANONICAL_JSON_MAX_BYTES,
  ARCHITECTURE_SCHEMA_VERSION, ArchitectureContent, ArchitectureValidationError,
  hashArchitectureContent, parseArchitectureContent, renderArchitectureMarkdown,
} from "../planning/architecture-schema";
import { preflightArchitectureHandoff, ARCHITECTURE_PHASE, ArchitectureHandoffAuthority } from "../planning/documentation-architecture-preflight";
import { PlanningDomainError } from "../planning/planning-errors";
import { canonicalJson } from "../planning/requirements-context";
import { PlanningAuthorizationService } from "./planning-authorization.service";
import { PlanningArchitectureReadinessService } from "./planning-architecture-readiness.service";

export interface CreateArchitectureInput {
  projectId: string; actorId: string; title: string; structuredContent: unknown;
  baseArtifactId?: string; baseContentHash?: string;
}

function retryable(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2002" || error.code === "P2034");
}

export class PlanningArchitectureArtifactService {
  private readonly authorization: PlanningAuthorizationService;
  private readonly readiness = new PlanningArchitectureReadinessService();
  constructor(private readonly prisma: PrismaClient, authorization?: PlanningAuthorizationService) {
    this.authorization = authorization ?? new PlanningAuthorizationService(prisma);
  }

  async create(input: CreateArchitectureInput): Promise<PhaseArtifact> {
    return this.withRetry(() => this.prisma.$transaction(async (tx) => {
      await this.authorization.assertCanEditInTransaction(tx, input.projectId, input.actorId);
      const project = await tx.project.findUnique({ where: { id: input.projectId }, select: { currentPhase: true } });
      const state = await tx.projectPhaseState.findUnique({ where: { projectId_phase: { projectId: input.projectId, phase: ARCHITECTURE_PHASE } } });
      if (!project || !state) throw new PlanningDomainError("PLANNING_ACTION_LOCKED", "Architecture phase has not been entered.", 409);
      const successor = Boolean(input.baseArtifactId || input.baseContentHash);
      if (!successor && project.currentPhase !== ARCHITECTURE_PHASE) throw new PlanningDomainError("PLANNING_ACTION_LOCKED", "Project is not in Architecture phase.", 409);
      if (successor && (!input.baseArtifactId || !input.baseContentHash)) throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", "Both baseArtifactId and baseContentHash are required.", 422);
      const authority = await preflightArchitectureHandoff(tx, input.projectId);
      const content = this.assemble(input.structuredContent, authority);
      this.assertSize(content);
      let base: PhaseArtifact | null = null;
      let version = 1;
      if (successor) {
        if (!["in_progress", "changes_requested", "approved"].includes(state.status) || state.approvalCandidateArtifactId) this.locked("Architecture cannot be revised in its current state.");
        base = await tx.phaseArtifact.findUnique({ where: { id: input.baseArtifactId! } });
        if (!base || base.projectId !== input.projectId || base.phase !== ARCHITECTURE_PHASE || base.type !== ARCHITECTURE_ARTIFACT_TYPE) throw new PlanningDomainError("PLANNING_ARTIFACT_PROJECT_MISMATCH", "Architecture base was not found in this project.", 404);
        if (state.currentArtifactId !== base.id || base.contentHash !== input.baseContentHash) throw new PlanningDomainError("PLANNING_ARTIFACT_BASE_CHANGED", "Architecture base is no longer current.", 409);
        this.validateHistoricalBase(base, input.baseContentHash!);
        const latest = await tx.phaseArtifact.findFirst({ where: { projectId: input.projectId, phase: ARCHITECTURE_PHASE, type: ARCHITECTURE_ARTIFACT_TYPE }, orderBy: { version: "desc" }, select: { id: true, version: true } });
        if (latest?.id !== base.id) throw new PlanningDomainError("PLANNING_ARTIFACT_BASE_CHANGED", "A newer Architecture version exists.", 409);
        version = base.version + 1;
      } else {
        if (state.status !== "not_started" || state.currentArtifactId || state.currentApprovedArtifactId || state.approvalCandidateArtifactId) this.locked("Architecture already has a current artifact.");
        const existing = await tx.phaseArtifact.findFirst({ where: { projectId: input.projectId, phase: ARCHITECTURE_PHASE, type: ARCHITECTURE_ARTIFACT_TYPE }, select: { id: true } });
        if (existing) this.locked("Architecture already has an initial artifact.");
      }
      const artifact = await tx.phaseArtifact.create({ data: {
        projectId: input.projectId, phase: ARCHITECTURE_PHASE, type: ARCHITECTURE_ARTIFACT_TYPE,
        title: input.title.trim() || `Architecture v${version}`,
        content: renderArchitectureMarkdown(content), structuredContent: content as unknown as Prisma.InputJsonValue,
        schemaVersion: ARCHITECTURE_SCHEMA_VERSION, contentHash: hashArchitectureContent(content), version,
        previousVersionId: base?.id ?? null, basedOnArtifactId: base?.id ?? null,
        changeKind: ArtifactChangeKind.MANUAL_EDIT, createdBy: input.actorId,
        createdByType: ArtifactActorType.HUMAN, lifecycleStatus: ArtifactLifecycleStatus.DRAFT, approved: false,
      } });
      const result = await tx.projectPhaseState.updateMany({
        where: { id: state.id, stateVersion: state.stateVersion, currentArtifactId: state.currentArtifactId },
        data: { status: "in_progress", startedAt: state.startedAt ?? new Date(), currentArtifactId: artifact.id, approvalCandidateArtifactId: null, notes: null, stateVersion: { increment: 1 } },
      });
      if (result.count !== 1) this.concurrent();
      await tx.project.update({ where: { id: input.projectId }, data: { currentPhase: ARCHITECTURE_PHASE } });
      return artifact;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
  }

  async getReadiness(projectId: string, artifactId: string, actorId: string, expectedHash?: string) {
    await this.authorization.assertCanRead(projectId, actorId);
    return this.prisma.$transaction(async (tx) => {
      const authority = await preflightArchitectureHandoff(tx, projectId);
      const artifact = await tx.phaseArtifact.findUnique({ where: { id: artifactId } });
      if (!artifact || artifact.projectId !== projectId || artifact.phase !== ARCHITECTURE_PHASE || artifact.type !== ARCHITECTURE_ARTIFACT_TYPE) throw new PlanningDomainError("PLANNING_ARTIFACT_PROJECT_MISMATCH", "Architecture artifact was not found in this project.", 404);
      if (expectedHash && artifact.contentHash !== expectedHash) throw new PlanningDomainError("PLANNING_ARTIFACT_HASH_MISMATCH", "Architecture hash does not match.", 409);
      return this.readiness.evaluateArchitecture(artifact, authority);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  validatePersisted(artifact: PhaseArtifact, authority: ArchitectureHandoffAuthority, expectedHash?: string): ArchitectureContent {
    if (artifact.phase !== ARCHITECTURE_PHASE || artifact.type !== ARCHITECTURE_ARTIFACT_TYPE || artifact.projectId !== authority.projectId || artifact.schemaVersion !== ARCHITECTURE_SCHEMA_VERSION || artifact.structuredContent === null) this.invalid();
    let content: ArchitectureContent;
    try { content = parseArchitectureContent(artifact.structuredContent); this.assertSize(content); }
    catch (error) { if (error instanceof PlanningDomainError) throw error; this.invalid(); }
    if (canonicalJson(artifact.structuredContent) !== canonicalJson(content) || artifact.contentHash !== hashArchitectureContent(content) || artifact.content !== renderArchitectureMarkdown(content)) this.invalid();
    if (expectedHash !== undefined && expectedHash !== artifact.contentHash) throw new PlanningDomainError("PLANNING_ARTIFACT_HASH_MISMATCH", "Architecture hash does not match.", 409);
    if (content.sourceRequirements.artifactId !== authority.requirements.artifact.id || content.sourceRequirements.version !== authority.requirements.artifact.version || content.sourceRequirements.contentHash !== authority.requirements.contentHash || content.sourceDocumentation.artifactId !== authority.documentation.artifact.id || content.sourceDocumentation.version !== authority.documentation.artifact.version || content.sourceDocumentation.contentHash !== authority.documentation.contentHash) this.locked("Architecture upstream authority is stale.");
    try { if (!architectureTraceabilityMatches(content, authority.documentation.content, authority.requirements.content)) this.invalid(); }
    catch { this.invalid(); }
    return content;
  }

  private validateHistoricalBase(artifact: PhaseArtifact, expectedHash: string): void {
    if (artifact.schemaVersion !== ARCHITECTURE_SCHEMA_VERSION || artifact.structuredContent === null) this.invalid();
    let content: ArchitectureContent;
    try { content = parseArchitectureContent(artifact.structuredContent); this.assertSize(content); }
    catch (error) { if (error instanceof PlanningDomainError) throw error; this.invalid(); }
    if (canonicalJson(artifact.structuredContent) !== canonicalJson(content) || artifact.contentHash !== hashArchitectureContent(content) || artifact.content !== renderArchitectureMarkdown(content)) this.invalid();
    if (artifact.contentHash !== expectedHash) throw new PlanningDomainError("PLANNING_ARTIFACT_HASH_MISMATCH", "Architecture base hash does not match.", 409);
  }

  private assemble(input: unknown, authority: ArchitectureHandoffAuthority): ArchitectureContent {
    try { return assembleArchitectureContent(input,
      { artifactId: authority.requirements.artifact.id, version: authority.requirements.artifact.version, contentHash: authority.requirements.contentHash },
      { artifactId: authority.documentation.artifact.id, version: authority.documentation.artifact.version, contentHash: authority.documentation.contentHash },
      authority.requirements.content, authority.documentation.content);
    } catch (error) { if (error instanceof ArchitectureValidationError) throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", error.message, 422, { path: error.path }); throw error; }
  }
  private assertSize(content: ArchitectureContent): void {
    const byteLength = Buffer.byteLength(canonicalJson(content), "utf8");
    if (byteLength > ARCHITECTURE_CANONICAL_JSON_MAX_BYTES) throw new PlanningDomainError("PLANNING_INPUT_TOO_LARGE", "Canonical Architecture JSON exceeds the 128 KiB UTF-8 limit.", 413, { byteLength, maxBytes: ARCHITECTURE_CANONICAL_JSON_MAX_BYTES });
  }
  private invalid(): never { throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", "Architecture artifact is invalid.", 422); }
  private locked(message: string): never { throw new PlanningDomainError("PLANNING_ACTION_LOCKED", message, 409); }
  private concurrent(): never { throw new PlanningDomainError("PLANNING_CONCURRENT_UPDATE", "Architecture state changed concurrently; reload and retry.", 409); }
  private async withRetry<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try { return await operation(); } catch (error) { if (error instanceof PlanningDomainError || !retryable(error)) throw error; }
    }
    this.concurrent();
  }
}
