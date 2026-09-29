import {
  ArtifactActorType,
  ArtifactChangeKind,
  ArtifactLifecycleStatus,
  PhaseArtifact,
  ProjectPhaseState,
  Prisma,
  PrismaClient,
} from "@prisma/client";
import { PlanningDomainError } from "../planning/planning-errors";
import {
  hashRequirementsContent,
  parseRequirementsContent,
  renderRequirementsMarkdown,
  REQUIREMENTS_ARTIFACT_TYPE,
  REQUIREMENTS_PHASE,
  REQUIREMENTS_SCHEMA_VERSION,
  RequirementsContent,
} from "../planning/requirements-schema";
import { PlanningAuthorizationService } from "./planning-authorization.service";
import { PlanningTransitionPolicy } from "./planning-transition-policy";

const MAX_TRANSACTION_ATTEMPTS = 3;

export interface CreateInitialRequirementsArtifactInput {
  projectId: string;
  actorId: string;
  title: string;
  structuredContent: unknown;
  createdByType?: ArtifactActorType;
  changeKind?: ArtifactChangeKind;
}

export interface CreateRequirementsRevisionInput {
  projectId: string;
  actorId: string;
  baseArtifactId: string;
  baseContentHash: string;
  title?: string;
  structuredContent: unknown;
  createdByType?: ArtifactActorType;
  changeKind?: ArtifactChangeKind;
}

function isRetryableTransactionError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === "P2002" || error.code === "P2034");
}

export class PlanningArtifactService {
  private readonly authorization: PlanningAuthorizationService;
  private readonly transitions: PlanningTransitionPolicy;

  constructor(
    private readonly prisma: PrismaClient,
    authorization?: PlanningAuthorizationService,
    transitions?: PlanningTransitionPolicy,
  ) {
    this.authorization = authorization ?? new PlanningAuthorizationService(prisma);
    this.transitions = transitions ?? new PlanningTransitionPolicy();
  }

  async createInitialArtifact(input: CreateInitialRequirementsArtifactInput): Promise<PhaseArtifact> {
    await this.authorization.assertCanEdit(input.projectId, input.actorId);
    return this.withVersionRetry(() => this.prisma.$transaction(async (tx) => {
      const { artifact, state } = await this.createInitialArtifactInTransaction(tx, input);

      const advanced = await tx.projectPhaseState.updateMany({
        where: { id: state.id, stateVersion: state.stateVersion, status: state.status },
        data: {
          status: "in_progress",
          startedAt: state.startedAt ?? new Date(),
          currentArtifactId: artifact.id,
          approvalCandidateArtifactId: null,
          stateVersion: { increment: 1 },
        },
      });
      if (advanced.count !== 1) this.concurrentUpdate();

      await tx.project.update({
        where: { id: input.projectId },
        data: { currentPhase: REQUIREMENTS_PHASE },
      });
      return artifact;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
  }

  /** Internal transaction-aware primitive used by manual creation and WorkflowRun finalization. */
  async createInitialArtifactInTransaction(
    tx: Prisma.TransactionClient,
    input: CreateInitialRequirementsArtifactInput,
  ): Promise<{ artifact: PhaseArtifact; state: ProjectPhaseState }> {
    const content = parseRequirementsContent(input.structuredContent);
    const state = await tx.projectPhaseState.upsert({
      where: { projectId_phase: { projectId: input.projectId, phase: REQUIREMENTS_PHASE } },
      update: {},
      create: { projectId: input.projectId, phase: REQUIREMENTS_PHASE },
    });
    this.transitions.assertAction(state.status, "create_initial_artifact");
    this.transitions.assertTransition(state.status, "in_progress");

    const existing = await tx.phaseArtifact.findFirst({
      where: {
        projectId: input.projectId,
        phase: REQUIREMENTS_PHASE,
        type: REQUIREMENTS_ARTIFACT_TYPE,
      },
      select: { id: true },
    });
    if (existing) {
      throw new PlanningDomainError(
        "PLANNING_INITIAL_ARTIFACT_EXISTS",
        "Requirements already has an initial artifact; create a successor version instead.",
        409,
        { currentArtifactId: state.currentArtifactId ?? existing.id },
      );
    }

    const artifact = await this.createVersion(tx, {
      projectId: input.projectId,
      actorId: input.actorId,
      title: input.title,
      content,
      version: 1,
      previousVersionId: null,
      basedOnArtifactId: null,
      createdByType: input.createdByType ?? ArtifactActorType.HUMAN,
      changeKind: input.changeKind ?? ArtifactChangeKind.INITIAL_GENERATION,
    });
    return { artifact, state };
  }

  async createManualRevision(input: CreateRequirementsRevisionInput): Promise<PhaseArtifact> {
    return this.createSuccessorVersion({
      ...input,
      createdByType: ArtifactActorType.HUMAN,
      changeKind: ArtifactChangeKind.MANUAL_EDIT,
    });
  }

  async createSuccessorVersion(input: CreateRequirementsRevisionInput): Promise<PhaseArtifact> {
    await this.authorization.assertCanEdit(input.projectId, input.actorId);
    return this.withVersionRetry(() => this.prisma.$transaction(async (tx) => {
      const { artifact, base, state } = await this.createSuccessorVersionInTransaction(tx, input);

      const advanced = await tx.projectPhaseState.updateMany({
        where: { id: state.id, stateVersion: state.stateVersion, currentArtifactId: base.id },
        data: {
          status: "in_progress",
          currentArtifactId: artifact.id,
          approvalCandidateArtifactId: null,
          notes: null,
          stateVersion: { increment: 1 },
        },
      });
      if (advanced.count !== 1) this.concurrentUpdate();
      await tx.project.update({
        where: { id: input.projectId },
        data: { currentPhase: REQUIREMENTS_PHASE },
      });
      return artifact;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
  }

  /** Internal transaction-aware primitive used by manual creation and WorkflowRun revision finalization. */
  async createSuccessorVersionInTransaction(
    tx: Prisma.TransactionClient,
    input: CreateRequirementsRevisionInput,
  ): Promise<{ artifact: PhaseArtifact; base: PhaseArtifact; state: ProjectPhaseState; latest: { id: string; version: number } }> {
    const content = parseRequirementsContent(input.structuredContent);
    const state = await tx.projectPhaseState.findUnique({
      where: { projectId_phase: { projectId: input.projectId, phase: REQUIREMENTS_PHASE } },
    });
    if (!state) {
      throw new PlanningDomainError(
        "PLANNING_ARTIFACT_NOT_FOUND",
        "Requirements has no current artifact to revise.",
        404,
      );
    }
    this.transitions.assertAction(state.status, "create_revision");
    if (state.status !== "in_progress") this.transitions.assertTransition(state.status, "in_progress");

    const base = await tx.phaseArtifact.findUnique({ where: { id: input.baseArtifactId } });
    this.assertRequirementsArtifact(base, input.projectId);
    if (state.currentArtifactId !== base.id) {
      throw new PlanningDomainError(
        "PLANNING_ARTIFACT_BASE_CHANGED",
        "The Requirements base artifact is no longer current.",
        409,
        { expectedBaseArtifactId: input.baseArtifactId, currentArtifactId: state.currentArtifactId },
      );
    }
    if (base.contentHash !== input.baseContentHash) {
      throw new PlanningDomainError(
        "PLANNING_ARTIFACT_BASE_CHANGED",
        "The Requirements base content hash no longer matches.",
        409,
        { artifactId: base.id, expectedHash: input.baseContentHash, actualHash: base.contentHash },
      );
    }

    const latest = await tx.phaseArtifact.findFirst({
      where: {
        projectId: input.projectId,
        phase: REQUIREMENTS_PHASE,
        type: REQUIREMENTS_ARTIFACT_TYPE,
      },
      orderBy: [{ version: "desc" }, { id: "desc" }],
      select: { version: true, id: true },
    });
    if (!latest || latest.id !== base.id) {
      throw new PlanningDomainError(
        "PLANNING_ARTIFACT_BASE_CHANGED",
        "A newer Requirements version already exists.",
        409,
        { expectedBaseArtifactId: base.id, latestArtifactId: latest?.id },
      );
    }

    const artifact = await this.createVersion(tx, {
      projectId: input.projectId,
      actorId: input.actorId,
      title: input.title ?? base.title,
      content,
      version: latest.version + 1,
      previousVersionId: base.id,
      basedOnArtifactId: base.id,
      createdByType: input.createdByType ?? ArtifactActorType.HUMAN,
      changeKind: input.changeKind ?? ArtifactChangeKind.MANUAL_EDIT,
    });

    return { artifact, base, state, latest };
  }

  async getArtifact(projectId: string, artifactId: string, actorId: string): Promise<PhaseArtifact> {
    await this.authorization.assertCanRead(projectId, actorId);
    const artifact = await this.prisma.phaseArtifact.findUnique({ where: { id: artifactId } });
    this.assertRequirementsArtifact(artifact, projectId);
    return artifact;
  }

  async listVersions(projectId: string, actorId: string): Promise<PhaseArtifact[]> {
    await this.authorization.assertCanRead(projectId, actorId);
    return this.prisma.phaseArtifact.findMany({
      where: {
        projectId,
        phase: REQUIREMENTS_PHASE,
        type: REQUIREMENTS_ARTIFACT_TYPE,
      },
      orderBy: [{ version: "desc" }, { id: "desc" }],
    });
  }

  private async createVersion(
    tx: Prisma.TransactionClient,
    input: {
      projectId: string;
      actorId: string;
      title: string;
      content: RequirementsContent;
      version: number;
      previousVersionId: string | null;
      basedOnArtifactId: string | null;
      createdByType: ArtifactActorType;
      changeKind: ArtifactChangeKind;
    },
  ): Promise<PhaseArtifact> {
    const markdown = renderRequirementsMarkdown(input.content);
    const contentHash = hashRequirementsContent(input.content);
    return tx.phaseArtifact.create({
      data: {
        projectId: input.projectId,
        phase: REQUIREMENTS_PHASE,
        type: REQUIREMENTS_ARTIFACT_TYPE,
        title: input.title.trim() || `Requirements v${input.version}`,
        content: markdown,
        structuredContent: input.content as unknown as Prisma.InputJsonValue,
        schemaVersion: REQUIREMENTS_SCHEMA_VERSION,
        contentHash,
        version: input.version,
        previousVersionId: input.previousVersionId,
        basedOnArtifactId: input.basedOnArtifactId,
        changeKind: input.changeKind,
        createdBy: input.actorId,
        createdByType: input.createdByType,
        lifecycleStatus: ArtifactLifecycleStatus.DRAFT,
        approved: false,
      },
    });
  }

  private assertRequirementsArtifact(
    artifact: PhaseArtifact | null,
    projectId: string,
  ): asserts artifact is PhaseArtifact {
    if (!artifact) {
      throw new PlanningDomainError("PLANNING_ARTIFACT_NOT_FOUND", "Requirements artifact was not found.", 404);
    }
    if (artifact.projectId !== projectId || artifact.phase !== REQUIREMENTS_PHASE || artifact.type !== REQUIREMENTS_ARTIFACT_TYPE) {
      throw new PlanningDomainError(
        "PLANNING_ARTIFACT_PROJECT_MISMATCH",
        "Requirements artifact was not found in this project.",
        404,
      );
    }
  }

  private async withVersionRetry<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        if (error instanceof PlanningDomainError || !isRetryableTransactionError(error)) throw error;
        lastError = error;
      }
    }
    throw new PlanningDomainError(
      "PLANNING_CONCURRENT_UPDATE",
      "Requirements changed concurrently; reload the current version and retry.",
      409,
      { cause: lastError instanceof Error ? lastError.message : "concurrent transaction" },
    );
  }

  private concurrentUpdate(): never {
    throw new PlanningDomainError(
      "PLANNING_CONCURRENT_UPDATE",
      "Requirements changed concurrently; reload the current version and retry.",
      409,
    );
  }
}
