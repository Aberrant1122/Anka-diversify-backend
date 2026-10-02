import {
  ArtifactLifecycleStatus,
  PhaseArtifact,
  Prisma,
  PrismaClient,
  ProjectPhaseState,
} from "@prisma/client";
import { PlanningDomainError } from "../planning/planning-errors";
import { DOCUMENTATION_ARTIFACT_TYPE } from "../planning/documentation-schema";
import {
  REQUIREMENTS_ARTIFACT_TYPE,
  REQUIREMENTS_PHASE,
} from "../planning/requirements-schema";
import { PlanningAuthorizationService } from "./planning-authorization.service";
import {
  DOCUMENTATION_PHASE,
  PlanningDocumentationArtifactService,
  ValidatedDocumentationArtifact,
} from "./planning-documentation-artifact.service";
import {
  DocumentationReadiness,
  PlanningDocumentationReadinessService,
} from "./planning-documentation-readiness.service";
import { PlanningReadinessService, RequirementsReadiness } from "./planning-readiness.service";
import { PlanningTransitionPolicy } from "./planning-transition-policy";
import { ARCHITECTURE_PHASE, preflightArchitectureHandoff } from "../planning/documentation-architecture-preflight";
import { ARCHITECTURE_ARTIFACT_TYPE } from "../planning/architecture-schema";
import { PlanningArchitectureArtifactService } from "./planning-architecture-artifact.service";
import { PlanningArchitectureReadinessService } from "./planning-architecture-readiness.service";

export interface ExactArtifactDecisionInput {
  projectId: string;
  phase: string;
  artifactId: string;
  expectedHash: string;
  actorId: string;
  comments?: string;
}

export type DocumentationArtifactDecisionInput = Omit<ExactArtifactDecisionInput, "phase">;

function isRetryableTransactionError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034";
}

export class PlanningApprovalService {
  private readonly authorization: PlanningAuthorizationService;
  private readonly transitions: PlanningTransitionPolicy;
  private readonly readiness: PlanningReadinessService;
  private readonly documentationArtifacts: PlanningDocumentationArtifactService;
  private readonly documentationReadiness: PlanningDocumentationReadinessService;
  private readonly architectureArtifacts: PlanningArchitectureArtifactService;
  private readonly architectureReadiness = new PlanningArchitectureReadinessService();

  constructor(
    private readonly prisma: PrismaClient,
    authorization?: PlanningAuthorizationService,
    transitions?: PlanningTransitionPolicy,
    readiness?: PlanningReadinessService,
    documentationArtifacts?: PlanningDocumentationArtifactService,
    documentationReadiness?: PlanningDocumentationReadinessService,
  ) {
    this.authorization = authorization ?? new PlanningAuthorizationService(prisma);
    this.transitions = transitions ?? new PlanningTransitionPolicy();
    this.readiness = readiness ?? new PlanningReadinessService();
    this.documentationArtifacts = documentationArtifacts
      ?? new PlanningDocumentationArtifactService(prisma, this.authorization);
    this.documentationReadiness = documentationReadiness ?? new PlanningDocumentationReadinessService();
    this.architectureArtifacts = new PlanningArchitectureArtifactService(prisma, this.authorization);
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

  async requestDocumentationApproval(
    input: DocumentationArtifactDecisionInput,
  ): Promise<ProjectPhaseState> {
    return this.withDocumentationTransactionRetry(() => this.prisma.$transaction(async (tx) => {
      await this.authorization.assertCanEditInTransaction(tx, input.projectId, input.actorId);
      const { state, artifact } = await this.loadCurrentDocumentation(tx, input);
      this.assertDocumentationAction(state.status, "request_approval");
      if (artifact.lifecycleStatus !== ArtifactLifecycleStatus.DRAFT) {
        throw new PlanningDomainError(
          "PLANNING_INVALID_TRANSITION",
          "Only a draft Documentation artifact can be submitted for approval.",
          409,
        );
      }
      const validated = await this.documentationArtifacts.validatePersistedArtifactInTransaction(
        tx,
        input.projectId,
        artifact,
        { expectedHash: input.expectedHash, requireCurrentRequirements: true },
      );
      this.assertDocumentationReady(artifact, validated);

      const artifactUpdate = await tx.phaseArtifact.updateMany({
        where: { id: artifact.id, lifecycleStatus: ArtifactLifecycleStatus.DRAFT },
        data: { lifecycleStatus: ArtifactLifecycleStatus.AWAITING_APPROVAL },
      });
      if (artifactUpdate.count !== 1) this.documentationConcurrentUpdate();
      const stateUpdate = await tx.projectPhaseState.updateMany({
        where: {
          id: state.id,
          stateVersion: state.stateVersion,
          status: "in_progress",
          currentArtifactId: artifact.id,
        },
        data: {
          status: "awaiting_approval",
          approvalCandidateArtifactId: artifact.id,
          stateVersion: { increment: 1 },
        },
      });
      if (stateUpdate.count !== 1) this.documentationConcurrentUpdate();
      return tx.projectPhaseState.findUniqueOrThrow({ where: { id: state.id } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
  }

  async approveDocumentationArtifact(
    input: DocumentationArtifactDecisionInput,
  ): Promise<ProjectPhaseState> {
    return this.withDocumentationTransactionRetry(() => this.prisma.$transaction(async (tx) => {
      await this.authorization.assertOwnerInTransaction(tx, input.projectId, input.actorId);
      const { state, artifact } = await this.loadDocumentationCandidate(tx, input);
      this.assertDocumentationAction(state.status, "approve");
      if (artifact.lifecycleStatus !== ArtifactLifecycleStatus.AWAITING_APPROVAL) {
        throw new PlanningDomainError(
          "PLANNING_INVALID_TRANSITION",
          "Only an awaiting-approval Documentation artifact can be approved.",
          409,
        );
      }
      const validated = await this.documentationArtifacts.validatePersistedArtifactInTransaction(
        tx,
        input.projectId,
        artifact,
        { expectedHash: input.expectedHash, requireCurrentRequirements: true },
      );
      this.assertDocumentationReady(artifact, validated);
      const now = new Date();

      await tx.phaseApproval.create({
        data: {
          projectId: input.projectId,
          phase: DOCUMENTATION_PHASE,
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
      const artifactUpdate = await tx.phaseArtifact.updateMany({
        where: { id: artifact.id, lifecycleStatus: ArtifactLifecycleStatus.AWAITING_APPROVAL },
        data: {
          lifecycleStatus: ArtifactLifecycleStatus.APPROVED,
          approved: true,
          approvedAt: now,
          supersededAt: null,
        },
      });
      if (artifactUpdate.count !== 1) this.documentationConcurrentUpdate();
      const stateUpdate = await tx.projectPhaseState.updateMany({
        where: {
          id: state.id,
          stateVersion: state.stateVersion,
          status: "awaiting_approval",
          currentArtifactId: artifact.id,
          approvalCandidateArtifactId: artifact.id,
        },
        data: {
          status: "approved",
          currentApprovedArtifactId: artifact.id,
          approvalCandidateArtifactId: null,
          approvedById: input.actorId,
          approvedAt: now,
          completedAt: now,
          notes: input.comments?.trim() || null,
          stateVersion: { increment: 1 },
        },
      });
      if (stateUpdate.count !== 1) this.documentationConcurrentUpdate();

      await tx.projectPhaseState.upsert({
        where: { projectId_phase: { projectId: input.projectId, phase: "architecture" } },
        update: {},
        create: { projectId: input.projectId, phase: "architecture", status: "not_started" },
      });
      await tx.project.update({
        where: { id: input.projectId },
        data: { currentPhase: "architecture" },
      });
      return tx.projectPhaseState.findUniqueOrThrow({ where: { id: state.id } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
  }

  async requestDocumentationChanges(
    input: DocumentationArtifactDecisionInput,
  ): Promise<ProjectPhaseState> {
    const comments = input.comments?.trim();
    if (!comments) {
      throw new PlanningDomainError(
        "PLANNING_COMMENTS_REQUIRED",
        "Comments are required when requesting Documentation changes.",
        422,
      );
    }
    return this.withDocumentationTransactionRetry(() => this.prisma.$transaction(async (tx) => {
      await this.authorization.assertOwnerInTransaction(tx, input.projectId, input.actorId);
      const { state, artifact } = await this.loadDocumentationCandidate(tx, input);
      this.assertDocumentationAction(state.status, "request_changes");
      if (artifact.lifecycleStatus !== ArtifactLifecycleStatus.AWAITING_APPROVAL) {
        throw new PlanningDomainError(
          "PLANNING_INVALID_TRANSITION",
          "Only an awaiting-approval Documentation artifact can receive requested changes.",
          409,
        );
      }
      await this.documentationArtifacts.validatePersistedArtifactInTransaction(
        tx,
        input.projectId,
        artifact,
        { expectedHash: input.expectedHash, requireCurrentRequirements: false },
      );

      await tx.phaseApproval.create({
        data: {
          projectId: input.projectId,
          phase: DOCUMENTATION_PHASE,
          artifactId: artifact.id,
          artifactVersion: artifact.version,
          artifactContentHash: artifact.contentHash,
          legacyUnverified: false,
          approvedById: input.actorId,
          decision: "changes_requested",
          comments,
        },
      });
      const artifactUpdate = await tx.phaseArtifact.updateMany({
        where: { id: artifact.id, lifecycleStatus: ArtifactLifecycleStatus.AWAITING_APPROVAL },
        data: { lifecycleStatus: ArtifactLifecycleStatus.DRAFT },
      });
      if (artifactUpdate.count !== 1) this.documentationConcurrentUpdate();
      const stateUpdate = await tx.projectPhaseState.updateMany({
        where: {
          id: state.id,
          stateVersion: state.stateVersion,
          status: "awaiting_approval",
          currentArtifactId: artifact.id,
          approvalCandidateArtifactId: artifact.id,
        },
        data: {
          status: "changes_requested",
          approvalCandidateArtifactId: null,
          notes: comments,
          stateVersion: { increment: 1 },
        },
      });
      if (stateUpdate.count !== 1) this.documentationConcurrentUpdate();
      return tx.projectPhaseState.findUniqueOrThrow({ where: { id: state.id } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
  }

  async requestArchitectureApproval(input: DocumentationArtifactDecisionInput): Promise<ProjectPhaseState> {
    return this.withDocumentationTransactionRetry(() => this.prisma.$transaction(async (tx) => {
      await this.authorization.assertCanEditInTransaction(tx, input.projectId, input.actorId);
      const { state, artifact } = await this.loadCurrentArchitecture(tx, input);
      if (state.status !== "in_progress" || state.approvalCandidateArtifactId || artifact.lifecycleStatus !== ArtifactLifecycleStatus.DRAFT) this.architectureLocked("Architecture draft cannot request approval in its current state.");
      const authority = await preflightArchitectureHandoff(tx, input.projectId);
      this.architectureArtifacts.validatePersisted(artifact, authority, input.expectedHash);
      this.assertArchitectureReady(artifact, authority);
      const updated = await tx.phaseArtifact.updateMany({ where: { id: artifact.id, lifecycleStatus: ArtifactLifecycleStatus.DRAFT }, data: { lifecycleStatus: ArtifactLifecycleStatus.AWAITING_APPROVAL } });
      if (updated.count !== 1) this.documentationConcurrentUpdate();
      const result = await tx.projectPhaseState.updateMany({ where: { id: state.id, stateVersion: state.stateVersion, status: "in_progress", currentArtifactId: artifact.id, approvalCandidateArtifactId: null }, data: { status: "awaiting_approval", approvalCandidateArtifactId: artifact.id, stateVersion: { increment: 1 } } });
      if (result.count !== 1) this.documentationConcurrentUpdate();
      return tx.projectPhaseState.findUniqueOrThrow({ where: { id: state.id } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
  }

  async approveArchitectureArtifact(input: DocumentationArtifactDecisionInput): Promise<ProjectPhaseState> {
    return this.withDocumentationTransactionRetry(() => this.prisma.$transaction(async (tx) => {
      await this.authorization.assertOwnerInTransaction(tx, input.projectId, input.actorId);
      const { state, artifact } = await this.loadArchitectureCandidate(tx, input);
      if (state.status !== "awaiting_approval" || artifact.lifecycleStatus !== ArtifactLifecycleStatus.AWAITING_APPROVAL) this.architectureLocked("Architecture artifact is not awaiting approval.");
      const authority = await preflightArchitectureHandoff(tx, input.projectId);
      this.architectureArtifacts.validatePersisted(artifact, authority, input.expectedHash);
      this.assertArchitectureReady(artifact, authority);
      const now = new Date();
      await tx.phaseApproval.create({ data: { projectId: input.projectId, phase: ARCHITECTURE_PHASE, artifactId: artifact.id, artifactVersion: artifact.version, artifactContentHash: artifact.contentHash, legacyUnverified: false, approvedById: input.actorId, approvedAt: now, decision: "approved", comments: input.comments?.trim() || null } });
      if (state.currentApprovedArtifactId && state.currentApprovedArtifactId !== artifact.id) await tx.phaseArtifact.update({ where: { id: state.currentApprovedArtifactId }, data: { supersededAt: now } });
      const updated = await tx.phaseArtifact.updateMany({ where: { id: artifact.id, lifecycleStatus: ArtifactLifecycleStatus.AWAITING_APPROVAL }, data: { lifecycleStatus: ArtifactLifecycleStatus.APPROVED, approved: true, approvedAt: now, supersededAt: null } });
      if (updated.count !== 1) this.documentationConcurrentUpdate();
      const result = await tx.projectPhaseState.updateMany({ where: { id: state.id, stateVersion: state.stateVersion, status: "awaiting_approval", currentArtifactId: artifact.id, approvalCandidateArtifactId: artifact.id }, data: { status: "approved", currentApprovedArtifactId: artifact.id, approvalCandidateArtifactId: null, approvedById: input.actorId, approvedAt: now, completedAt: now, notes: input.comments?.trim() || null, stateVersion: { increment: 1 } } });
      if (result.count !== 1) this.documentationConcurrentUpdate();
      await tx.projectPhaseState.upsert({ where: { projectId_phase: { projectId: input.projectId, phase: "implementation" } }, update: {}, create: { projectId: input.projectId, phase: "implementation", status: "not_started" } });
      await tx.project.update({ where: { id: input.projectId }, data: { currentPhase: "implementation" } });
      return tx.projectPhaseState.findUniqueOrThrow({ where: { id: state.id } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
  }

  async requestArchitectureChanges(input: DocumentationArtifactDecisionInput): Promise<ProjectPhaseState> {
    const comments = input.comments?.trim();
    if (!comments) throw new PlanningDomainError("PLANNING_COMMENTS_REQUIRED", "Comments are required when requesting Architecture changes.", 422);
    return this.withDocumentationTransactionRetry(() => this.prisma.$transaction(async (tx) => {
      await this.authorization.assertOwnerInTransaction(tx, input.projectId, input.actorId);
      const { state, artifact } = await this.loadArchitectureCandidate(tx, input);
      if (state.status !== "awaiting_approval" || artifact.lifecycleStatus !== ArtifactLifecycleStatus.AWAITING_APPROVAL) this.architectureLocked("Architecture artifact is not awaiting approval.");
      const authority = await preflightArchitectureHandoff(tx, input.projectId);
      this.architectureArtifacts.validatePersisted(artifact, authority, input.expectedHash);
      await tx.phaseApproval.create({ data: { projectId: input.projectId, phase: ARCHITECTURE_PHASE, artifactId: artifact.id, artifactVersion: artifact.version, artifactContentHash: artifact.contentHash, legacyUnverified: false, approvedById: input.actorId, decision: "changes_requested", comments } });
      const updated = await tx.phaseArtifact.updateMany({ where: { id: artifact.id, lifecycleStatus: ArtifactLifecycleStatus.AWAITING_APPROVAL }, data: { lifecycleStatus: ArtifactLifecycleStatus.DRAFT } });
      if (updated.count !== 1) this.documentationConcurrentUpdate();
      const result = await tx.projectPhaseState.updateMany({ where: { id: state.id, stateVersion: state.stateVersion, status: "awaiting_approval", currentArtifactId: artifact.id, approvalCandidateArtifactId: artifact.id }, data: { status: "changes_requested", approvalCandidateArtifactId: null, notes: comments, stateVersion: { increment: 1 } } });
      if (result.count !== 1) this.documentationConcurrentUpdate();
      return tx.projectPhaseState.findUniqueOrThrow({ where: { id: state.id } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
  }

  private async loadCurrentArchitecture(tx: Prisma.TransactionClient, input: DocumentationArtifactDecisionInput): Promise<{ state: ProjectPhaseState; artifact: PhaseArtifact }> {
    const state = await tx.projectPhaseState.findUnique({ where: { projectId_phase: { projectId: input.projectId, phase: ARCHITECTURE_PHASE } } });
    const artifact = await tx.phaseArtifact.findUnique({ where: { id: input.artifactId } });
    if (!state || !artifact || artifact.projectId !== input.projectId || artifact.phase !== ARCHITECTURE_PHASE || artifact.type !== ARCHITECTURE_ARTIFACT_TYPE) throw new PlanningDomainError("PLANNING_ARTIFACT_PROJECT_MISMATCH", "Architecture artifact was not found in this project.", 404);
    if (state.currentArtifactId !== artifact.id) throw new PlanningDomainError("PLANNING_ARTIFACT_NOT_CURRENT", "Only the current Architecture artifact can be used.", 409);
    return { state, artifact };
  }

  private async loadArchitectureCandidate(tx: Prisma.TransactionClient, input: DocumentationArtifactDecisionInput): Promise<{ state: ProjectPhaseState; artifact: PhaseArtifact }> {
    const current = await this.loadCurrentArchitecture(tx, input);
    if (current.state.approvalCandidateArtifactId !== current.artifact.id) throw new PlanningDomainError("PLANNING_ARTIFACT_NOT_CANDIDATE", "Architecture artifact is not the approval candidate.", 409);
    return current;
  }

  private assertArchitectureReady(artifact: PhaseArtifact, authority: Awaited<ReturnType<typeof preflightArchitectureHandoff>>): void {
    const result = this.architectureReadiness.evaluateArchitecture(artifact, authority);
    if (!result.ready) throw new PlanningDomainError("PLANNING_READINESS_BLOCKED", "Architecture is not ready for approval.", 422, { phase: ARCHITECTURE_PHASE, artifactId: result.artifactId, blockers: result.blockers, warnings: result.warnings });
  }

  private architectureLocked(message: string): never { throw new PlanningDomainError("PLANNING_ACTION_LOCKED", message, 409); }

  private async loadCurrentDocumentation(
    tx: Prisma.TransactionClient,
    input: DocumentationArtifactDecisionInput,
  ): Promise<{ state: ProjectPhaseState; artifact: PhaseArtifact }> {
    const state = await tx.projectPhaseState.findUnique({
      where: { projectId_phase: { projectId: input.projectId, phase: DOCUMENTATION_PHASE } },
    });
    if (!state) {
      throw new PlanningDomainError("PLANNING_ARTIFACT_NOT_FOUND", "Documentation has no current artifact.", 404);
    }
    const artifact = await tx.phaseArtifact.findUnique({ where: { id: input.artifactId } });
    if (!artifact
      || artifact.projectId !== input.projectId
      || artifact.phase !== DOCUMENTATION_PHASE
      || artifact.type !== DOCUMENTATION_ARTIFACT_TYPE) {
      throw new PlanningDomainError(
        "PLANNING_ARTIFACT_PROJECT_MISMATCH",
        "Documentation artifact was not found in this project.",
        404,
      );
    }
    if (state.currentArtifactId !== artifact.id) {
      throw new PlanningDomainError(
        "PLANNING_ARTIFACT_NOT_CURRENT",
        "Only the current Documentation artifact can be submitted for approval.",
        409,
        { artifactId: artifact.id, currentArtifactId: state.currentArtifactId },
      );
    }
    return { state, artifact };
  }

  private async loadDocumentationCandidate(
    tx: Prisma.TransactionClient,
    input: DocumentationArtifactDecisionInput,
  ): Promise<{ state: ProjectPhaseState; artifact: PhaseArtifact }> {
    const current = await this.loadCurrentDocumentation(tx, input);
    if (current.state.approvalCandidateArtifactId !== current.artifact.id) {
      throw new PlanningDomainError(
        "PLANNING_ARTIFACT_NOT_CANDIDATE",
        "The specified Documentation artifact is not the current approval candidate.",
        409,
        {
          artifactId: current.artifact.id,
          approvalCandidateArtifactId: current.state.approvalCandidateArtifactId,
        },
      );
    }
    return current;
  }

  private assertDocumentationReady(
    artifact: PhaseArtifact,
    validated: ValidatedDocumentationArtifact,
  ): DocumentationReadiness {
    const result = this.documentationReadiness.evaluateDocumentation({
      artifact: {
        id: artifact.id,
        content: artifact.content,
        structuredContent: validated.content,
        contentHash: artifact.contentHash,
      },
      historicalRequirements: validated.historicalRequirements,
      currentApprovedRequirements: validated.currentApprovedRequirements,
    });
    if (!result.ready) {
      throw new PlanningDomainError(
        "PLANNING_READINESS_BLOCKED",
        "Documentation is not ready for approval.",
        422,
        {
          phase: DOCUMENTATION_PHASE,
          artifactId: result.artifactId,
          contentHash: result.contentHash,
          blockers: result.blockers,
          warnings: result.warnings,
        },
      );
    }
    return result;
  }

  private assertDocumentationAction(
    status: string,
    action: "request_approval" | "approve" | "request_changes",
  ): void {
    const allowed = action === "request_approval" ? status === "in_progress" : status === "awaiting_approval";
    if (!allowed) {
      throw new PlanningDomainError(
        "PLANNING_ACTION_LOCKED",
        `Action '${action}' is locked while Documentation is '${status}'.`,
        409,
        { status, action },
      );
    }
  }

  private documentationConcurrentUpdate(): never {
    throw new PlanningDomainError(
      "PLANNING_CONCURRENT_UPDATE",
      "Documentation approval state changed concurrently; reload and retry.",
      409,
    );
  }

  private async withDocumentationTransactionRetry<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        if (error instanceof PlanningDomainError || !isRetryableTransactionError(error)) throw error;
      }
    }
    throw new PlanningDomainError(
      "PLANNING_CONCURRENT_UPDATE",
      "Documentation approval state changed concurrently; reload and retry.",
      409,
    );
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
