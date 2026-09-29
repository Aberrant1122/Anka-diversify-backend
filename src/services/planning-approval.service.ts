import {
  ArtifactLifecycleStatus,
  PhaseArtifact,
  Prisma,
  PrismaClient,
  ProjectPhaseState,
} from "@prisma/client";
import { PlanningDomainError } from "../planning/planning-errors";
import {
  REQUIREMENTS_ARTIFACT_TYPE,
  REQUIREMENTS_PHASE,
} from "../planning/requirements-schema";
import { PlanningAuthorizationService } from "./planning-authorization.service";
import { PlanningReadinessService, RequirementsReadiness } from "./planning-readiness.service";
import { PlanningTransitionPolicy } from "./planning-transition-policy";

export interface ExactArtifactDecisionInput {
  projectId: string;
  phase: string;
  artifactId: string;
  expectedHash: string;
  actorId: string;
  comments?: string;
}

function isRetryableTransactionError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034";
}

export class PlanningApprovalService {
  private readonly authorization: PlanningAuthorizationService;
  private readonly transitions: PlanningTransitionPolicy;
  private readonly readiness: PlanningReadinessService;

  constructor(
    private readonly prisma: PrismaClient,
    authorization?: PlanningAuthorizationService,
    transitions?: PlanningTransitionPolicy,
    readiness?: PlanningReadinessService,
  ) {
    this.authorization = authorization ?? new PlanningAuthorizationService(prisma);
    this.transitions = transitions ?? new PlanningTransitionPolicy();
    this.readiness = readiness ?? new PlanningReadinessService();
  }

  async requestApproval(input: ExactArtifactDecisionInput): Promise<ProjectPhaseState> {
    this.transitions.assertRequirementsPhase(input.phase);
    await this.authorization.assertCanEdit(input.projectId, input.actorId);

    return this.withTransactionRetry(() => this.prisma.$transaction(async (tx) => {
      const { state, artifact } = await this.loadCurrent(tx, input);
      this.transitions.assertAction(state.status, "request_approval");
      this.transitions.assertTransition(state.status, "awaiting_approval");
      this.assertReady(artifact, input.expectedHash);

      await tx.phaseArtifact.update({
        where: { id: artifact.id },
        data: { lifecycleStatus: ArtifactLifecycleStatus.AWAITING_APPROVAL },
      });
      const result = await tx.projectPhaseState.updateMany({
        where: { id: state.id, stateVersion: state.stateVersion, currentArtifactId: artifact.id },
        data: {
          status: "awaiting_approval",
          approvalCandidateArtifactId: artifact.id,
          stateVersion: { increment: 1 },
        },
      });
      if (result.count !== 1) this.concurrentUpdate();
      return tx.projectPhaseState.findUniqueOrThrow({ where: { id: state.id } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
  }

  async approveArtifact(input: ExactArtifactDecisionInput): Promise<ProjectPhaseState> {
    this.transitions.assertRequirementsPhase(input.phase);
    await this.authorization.assertOwner(input.projectId, input.actorId);
    const now = new Date();

    return this.withTransactionRetry(() => this.prisma.$transaction(async (tx) => {
      const phaseState = await tx.projectPhaseState.findUnique({
        where: { projectId_phase: { projectId: input.projectId, phase: REQUIREMENTS_PHASE } },
      });
      if (!phaseState) {
        throw new PlanningDomainError("PLANNING_ARTIFACT_NOT_FOUND", "Requirements has no current artifact.", 404);
      }
      this.transitions.assertAction(phaseState.status, "approve");
      this.transitions.assertTransition(phaseState.status, "approved");
      const { state, artifact } = await this.loadCandidate(tx, input);
      this.assertReady(artifact, input.expectedHash);

      await tx.phaseApproval.create({
        data: {
          projectId: input.projectId,
          phase: REQUIREMENTS_PHASE,
          artifactId: artifact.id,
          artifactVersion: artifact.version,
          artifactContentHash: artifact.contentHash,
          legacyUnverified: false,
          approvedById: input.actorId,
          approvedAt: now,
          decision: "approved",
          comments: input.comments?.trim() || null,
        },
      });

      if (state.currentApprovedArtifactId && state.currentApprovedArtifactId !== artifact.id) {
        await tx.phaseArtifact.update({
          where: { id: state.currentApprovedArtifactId },
          data: { supersededAt: now },
        });
      }
      await tx.phaseArtifact.update({
        where: { id: artifact.id },
        data: {
          lifecycleStatus: ArtifactLifecycleStatus.APPROVED,
          approved: true,
          approvedAt: now,
          supersededAt: null,
        },
      });

      const result = await tx.projectPhaseState.updateMany({
        where: {
          id: state.id,
          stateVersion: state.stateVersion,
          status: "awaiting_approval",
          approvalCandidateArtifactId: artifact.id,
        },
        data: {
          status: "approved",
          approvalCandidateArtifactId: null,
          currentApprovedArtifactId: artifact.id,
          approvedById: input.actorId,
          approvedAt: now,
          completedAt: now,
          notes: input.comments?.trim() || null,
          stateVersion: { increment: 1 },
        },
      });
      if (result.count !== 1) this.concurrentUpdate();

      await tx.projectPhaseState.upsert({
        where: { projectId_phase: { projectId: input.projectId, phase: "documentation" } },
        update: {},
        create: { projectId: input.projectId, phase: "documentation", status: "not_started" },
      });
      await tx.project.update({
        where: { id: input.projectId },
        data: { currentPhase: "documentation" },
      });

      return tx.projectPhaseState.findUniqueOrThrow({ where: { id: state.id } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
  }

  async requestChanges(input: ExactArtifactDecisionInput): Promise<ProjectPhaseState> {
    this.transitions.assertRequirementsPhase(input.phase);
    await this.authorization.assertOwner(input.projectId, input.actorId);
    const comments = input.comments?.trim();
    if (!comments) {
      throw new PlanningDomainError(
        "PLANNING_COMMENTS_REQUIRED",
        "Comments are required when requesting Requirements changes.",
        422,
      );
    }

    return this.withTransactionRetry(() => this.prisma.$transaction(async (tx) => {
      const phaseState = await tx.projectPhaseState.findUnique({
        where: { projectId_phase: { projectId: input.projectId, phase: REQUIREMENTS_PHASE } },
      });
      if (!phaseState) {
        throw new PlanningDomainError("PLANNING_ARTIFACT_NOT_FOUND", "Requirements has no current artifact.", 404);
      }
      this.transitions.assertAction(phaseState.status, "request_changes");
      this.transitions.assertTransition(phaseState.status, "changes_requested");
      const { state, artifact } = await this.loadCandidate(tx, input);
      this.readiness.evaluateRequirements({ artifact, expectedHash: input.expectedHash });

      await tx.phaseApproval.create({
        data: {
          projectId: input.projectId,
          phase: REQUIREMENTS_PHASE,
          artifactId: artifact.id,
          artifactVersion: artifact.version,
          artifactContentHash: artifact.contentHash,
          legacyUnverified: false,
          approvedById: input.actorId,
          decision: "changes_requested",
          comments,
        },
      });
      await tx.phaseArtifact.update({
        where: { id: artifact.id },
        data: { lifecycleStatus: ArtifactLifecycleStatus.DRAFT },
      });

      const result = await tx.projectPhaseState.updateMany({
        where: {
          id: state.id,
          stateVersion: state.stateVersion,
          status: "awaiting_approval",
          approvalCandidateArtifactId: artifact.id,
        },
        data: {
          status: "changes_requested",
          approvalCandidateArtifactId: null,
          notes: comments,
          stateVersion: { increment: 1 },
        },
      });
      if (result.count !== 1) this.concurrentUpdate();
      return tx.projectPhaseState.findUniqueOrThrow({ where: { id: state.id } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
  }

  private async loadCurrent(tx: Prisma.TransactionClient, input: ExactArtifactDecisionInput) {
    const state = await tx.projectPhaseState.findUnique({
      where: { projectId_phase: { projectId: input.projectId, phase: REQUIREMENTS_PHASE } },
    });
    if (!state) {
      throw new PlanningDomainError("PLANNING_ARTIFACT_NOT_FOUND", "Requirements has no current artifact.", 404);
    }
    const artifact = await tx.phaseArtifact.findUnique({ where: { id: input.artifactId } });
    this.assertArtifactScope(artifact, input.projectId);
    if (state.currentArtifactId !== artifact.id) {
      throw new PlanningDomainError(
        "PLANNING_ARTIFACT_NOT_CURRENT",
        "Only the current Requirements artifact can be submitted for approval.",
        409,
        { artifactId: artifact.id, currentArtifactId: state.currentArtifactId },
      );
    }
    return { state, artifact };
  }

  private async loadCandidate(tx: Prisma.TransactionClient, input: ExactArtifactDecisionInput) {
    const current = await this.loadCurrent(tx, input);
    if (current.state.approvalCandidateArtifactId !== current.artifact.id) {
      throw new PlanningDomainError(
        "PLANNING_ARTIFACT_NOT_CANDIDATE",
        "The specified Requirements artifact is not the current approval candidate.",
        409,
        {
          artifactId: current.artifact.id,
          approvalCandidateArtifactId: current.state.approvalCandidateArtifactId,
        },
      );
    }
    return current;
  }

  private assertArtifactScope(
    artifact: PhaseArtifact | null,
    projectId: string,
  ): asserts artifact is PhaseArtifact {
    if (!artifact || artifact.projectId !== projectId || artifact.phase !== REQUIREMENTS_PHASE || artifact.type !== REQUIREMENTS_ARTIFACT_TYPE) {
      throw new PlanningDomainError(
        "PLANNING_ARTIFACT_PROJECT_MISMATCH",
        "Requirements artifact was not found in this project.",
        404,
      );
    }
  }

  private assertReady(artifact: PhaseArtifact, expectedHash: string): RequirementsReadiness {
    const result = this.readiness.evaluateRequirements({ artifact, expectedHash });
    if (!result.ready) {
      throw new PlanningDomainError(
        "PLANNING_READINESS_BLOCKED",
        "Requirements is not ready for approval.",
        422,
        {
          phase: REQUIREMENTS_PHASE,
          artifactId: result.artifactId,
          contentHash: result.contentHash,
          blockers: result.blockers,
          warnings: result.warnings,
        },
      );
    }
    return result;
  }

  private concurrentUpdate(): never {
    throw new PlanningDomainError(
      "PLANNING_CONCURRENT_UPDATE",
      "Requirements changed concurrently; reload the current state and retry.",
      409,
    );
  }

  private async withTransactionRetry<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        if (error instanceof PlanningDomainError || !isRetryableTransactionError(error)) throw error;
      }
    }
    throw new PlanningDomainError(
      "PLANNING_CONCURRENT_UPDATE",
      "Requirements approval state changed concurrently; reload and retry.",
      409,
    );
  }
}
