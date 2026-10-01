import { ArtifactActorType, ArtifactChangeKind, PrismaClient } from "@prisma/client";
import { AiService } from "../ai/application/AiService";
import { PlanningDomainError } from "../planning/planning-errors";
import { REQUIREMENTS_PHASE } from "../planning/requirements-schema";
import { PlanningApprovalService } from "./planning-approval.service";
import { PlanningArtifactService } from "./planning-artifact.service";
import { PlanningAuthorizationService } from "./planning-authorization.service";
import {
  GenerateInitialDocumentationInput,
  PlanningDocumentationGenerationService,
  ReviseDocumentationInput,
} from "./planning-documentation-generation.service";
import { PlanningDocumentationArtifactService } from "./planning-documentation-artifact.service";
import { PlanningDocumentationReadinessService } from "./planning-documentation-readiness.service";
import { PlanningDocumentationRunService } from "./planning-documentation-run.service";
import {
  GenerateInitialRequirementsInput,
  PlanningGenerationService,
  ReviseRequirementsInput,
} from "./planning-generation.service";
import { PlanningReadinessService } from "./planning-readiness.service";
import { PlanningRequirementsRunService } from "./planning-requirements-run.service";
import { PlanningTransitionPolicy } from "./planning-transition-policy";

export const PHASE_ORDER = [
  "requirements",
  "documentation",
  "architecture",
  "implementation",
  "testing",
  "review",
] as const;

export type Phase = (typeof PHASE_ORDER)[number];

export class PhaseService {
  private readonly authorization: PlanningAuthorizationService;
  private readonly artifacts: PlanningArtifactService;
  private readonly approvals: PlanningApprovalService;
  private readonly readiness: PlanningReadinessService;
  private readonly transitions: PlanningTransitionPolicy;
  private readonly requirementsRuns: PlanningRequirementsRunService;
  private readonly generation: PlanningGenerationService;
  private readonly documentationGeneration: PlanningDocumentationGenerationService;
  private readonly aiService = AiService.getInstance();

  constructor(private readonly prisma: PrismaClient = new PrismaClient()) {
    this.authorization = new PlanningAuthorizationService(prisma);
    this.transitions = new PlanningTransitionPolicy();
    this.readiness = new PlanningReadinessService();
    this.artifacts = new PlanningArtifactService(prisma, this.authorization, this.transitions);
    this.approvals = new PlanningApprovalService(prisma, this.authorization, this.transitions, this.readiness);
    this.requirementsRuns = new PlanningRequirementsRunService(
      prisma,
      this.authorization,
      undefined,
      this.artifacts,
      this.readiness,
    );
    this.generation = new PlanningGenerationService(prisma, {
      authorization: this.authorization,
      artifacts: this.artifacts,
      readiness: this.readiness,
      runs: this.requirementsRuns,
    });
    const documentationArtifacts = new PlanningDocumentationArtifactService(prisma, this.authorization);
    const documentationReadiness = new PlanningDocumentationReadinessService();
    const documentationRuns = new PlanningDocumentationRunService(prisma, {
      authorization: this.authorization,
      artifacts: documentationArtifacts,
      readiness: documentationReadiness,
    });
    this.documentationGeneration = new PlanningDocumentationGenerationService(prisma, {
      authorization: this.authorization,
      artifacts: documentationArtifacts,
      readiness: documentationReadiness,
      runs: documentationRuns,
    });
  }

  async getPhaseStates(projectId: string, actorId: string) {
    await this.authorization.assertCanRead(projectId, actorId);
    return this.prisma.projectPhaseState.findMany({ where: { projectId }, orderBy: { phase: "asc" } });
  }

  async ensurePhaseStates(projectId: string, actorId: string) {
    await this.authorization.assertCanRead(projectId, actorId);
    const existing = await this.prisma.projectPhaseState.findMany({
      where: { projectId },
      select: { phase: true },
    });
    const existingPhases = new Set(existing.map((state) => state.phase));
    const missing = PHASE_ORDER.filter((phase) => !existingPhases.has(phase));
    if (missing.length > 0) {
      await this.prisma.projectPhaseState.createMany({
        data: missing.map((phase) => ({ projectId, phase })),
        skipDuplicates: true,
      });
    }
    return this.getPhaseStates(projectId, actorId);
  }

  async getRequirementsPolicy(projectId: string, actorId: string) {
    await this.authorization.assertCanRead(projectId, actorId);
    const state = await this.prisma.projectPhaseState.findUnique({
      where: { projectId_phase: { projectId, phase: REQUIREMENTS_PHASE } },
    });
    return this.transitions.describe(state?.status ?? "not_started");
  }

  async startPhase(projectId: string, phase: string, actorId: string) {
    await this.authorization.assertCanEdit(projectId, actorId);
    if (phase === REQUIREMENTS_PHASE) {
      throw new PlanningDomainError(
        "PLANNING_ACTION_LOCKED",
        "Requirements starts only when its first immutable artifact is created.",
        409,
      );
    }
    if (!PHASE_ORDER.includes(phase as Phase)) {
      throw new PlanningDomainError("PLANNING_INVALID_PHASE", `Unknown phase '${phase}'.`, 422, { phase });
    }
    const state = await this.prisma.projectPhaseState.upsert({
      where: { projectId_phase: { projectId, phase } },
      update: { status: "in_progress", startedAt: new Date() },
      create: { projectId, phase, status: "in_progress", startedAt: new Date() },
    });
    await this.prisma.project.update({ where: { id: projectId }, data: { currentPhase: phase } });
    return state;
  }

  async requestApproval(
    projectId: string,
    phase: string,
    artifactId: string,
    expectedHash: string,
    actorId: string,
  ) {
    return this.approvals.requestApproval({ projectId, phase, artifactId, expectedHash, actorId });
  }

  async approvePhase(
    projectId: string,
    phase: string,
    artifactId: string,
    expectedHash: string,
    approvedById: string,
    comments?: string,
  ) {
    return this.approvals.approveArtifact({
      projectId,
      phase,
      artifactId,
      expectedHash,
      actorId: approvedById,
      comments,
    });
  }

  async requestChanges(
    projectId: string,
    phase: string,
    artifactId: string,
    expectedHash: string,
    approvedById: string,
    comments: string,
  ) {
    return this.approvals.requestChanges({
      projectId,
      phase,
      artifactId,
      expectedHash,
      actorId: approvedById,
      comments,
    });
  }

  async rejectPhase(
    projectId: string,
    phase: string,
    artifactId: string,
    expectedHash: string,
    actorId: string,
    comments: string,
  ) {
    await this.authorization.assertOwner(projectId, actorId);
    this.transitions.assertRequirementsPhase(phase);
    if (!artifactId || !expectedHash || !comments.trim()) {
      throw new PlanningDomainError(
        "PLANNING_ARTIFACT_INVALID",
        "Rejecting a planning artifact requires its exact ID, hash, and comments.",
        422,
      );
    }
    throw new PlanningDomainError(
      "PLANNING_ACTION_NOT_IMPLEMENTED",
      "A terminal Requirements rejection is not part of Checkpoint 1B; request changes instead.",
      422,
    );
  }

  async getApprovalHistory(projectId: string, actorId: string, phase?: string) {
    await this.authorization.assertCanRead(projectId, actorId);
    return this.prisma.phaseApproval.findMany({
      where: { projectId, ...(phase ? { phase } : {}) },
      orderBy: { approvedAt: "desc" },
    });
  }

  async listArtifacts(projectId: string, actorId: string, phase?: string) {
    await this.authorization.assertCanRead(projectId, actorId);
    if (phase === REQUIREMENTS_PHASE) return this.artifacts.listVersions(projectId, actorId);
    return this.prisma.phaseArtifact.findMany({
      where: { projectId, ...(phase ? { phase } : {}) },
      orderBy: [{ version: "desc" }, { createdAt: "desc" }],
    });
  }

  async getArtifact(projectId: string, artifactId: string, actorId: string) {
    return this.artifacts.getArtifact(projectId, artifactId, actorId);
  }

  async getRequirementsReadiness(
    projectId: string,
    artifactId: string,
    actorId: string,
    expectedHash?: string,
  ) {
    const artifact = await this.artifacts.getArtifact(projectId, artifactId, actorId);
    return this.readiness.evaluateRequirements({ artifact, expectedHash });
  }

  async createArtifact(
    projectId: string,
    data: {
      phase: string;
      title: string;
      structuredContent: unknown;
      createdBy: string;
      baseArtifactId?: string;
      baseContentHash?: string;
    },
  ) {
    this.transitions.assertRequirementsPhase(data.phase);
    if (!data.baseArtifactId && !data.baseContentHash) {
      return this.artifacts.createInitialArtifact({
        projectId,
        actorId: data.createdBy,
        title: data.title,
        structuredContent: data.structuredContent,
      });
    }
    if (!data.baseArtifactId || !data.baseContentHash) {
      throw new PlanningDomainError(
        "PLANNING_ARTIFACT_INVALID",
        "Both baseArtifactId and baseContentHash are required for a Requirements revision.",
        422,
      );
    }
    return this.artifacts.createManualRevision({
      projectId,
      actorId: data.createdBy,
      title: data.title,
      structuredContent: data.structuredContent,
      baseArtifactId: data.baseArtifactId,
      baseContentHash: data.baseContentHash,
    });
  }

  async createRequirementsSuccessor(input: {
    projectId: string;
    actorId: string;
    title?: string;
    structuredContent: unknown;
    baseArtifactId: string;
    baseContentHash: string;
    createdByType: ArtifactActorType;
    changeKind: ArtifactChangeKind;
  }) {
    return this.artifacts.createSuccessorVersion(input);
  }

  async runAutomatedPhase(projectId: string, phase: string, createdBy: string, brief?: string) {
    await this.authorization.assertCanEdit(projectId, createdBy);
    if (phase === REQUIREMENTS_PHASE || phase === "documentation") {
      throw new PlanningDomainError(
        "PLANNING_ACTION_LOCKED",
        `${phase === REQUIREMENTS_PHASE ? "Requirements" : "Documentation"} uses its dedicated structured generation API.`,
        409,
      );
    }

    const run = await this.prisma.workflowRun.create({
      data: { projectId, triggerType: "manual", currentPhase: phase, status: "running" },
    });
    try {
      const [previousArtifact, latestDecision] = await Promise.all([
        this.prisma.phaseArtifact.findFirst({ where: { projectId, phase }, orderBy: { createdAt: "desc" } }),
        this.prisma.phaseApproval.findFirst({ where: { projectId, phase }, orderBy: { approvedAt: "desc" } }),
      ]);
      const revision = previousArtifact && latestDecision?.decision === "changes_requested" && latestDecision.comments
        ? { previousContent: previousArtifact.content, feedback: latestDecision.comments }
        : undefined;
      const proposal = await this.aiService.generatePhaseProposal(projectId, phase, revision, brief);
      const artifact = await this.prisma.phaseArtifact.create({
        data: {
          projectId,
          phase,
          type: `${phase}_doc`,
          title: proposal.title,
          content: proposal.content,
          version: (previousArtifact?.version || 0) + 1,
          createdBy,
        },
      });
      await this.startPhase(projectId, phase, createdBy);
      await this.prisma.workflowRun.update({
        where: { id: run.id },
        data: {
          status: "completed",
          completedAt: new Date(),
          modelUsage: { model: proposal.model, ...proposal.usage },
          costUSD: proposal.costUSD,
          outputArtifactId: artifact.id,
        },
      });
      return { artifact, workflowRun: await this.prisma.workflowRun.findUnique({ where: { id: run.id } }) };
    } catch (error) {
      await this.prisma.workflowRun.update({
        where: { id: run.id },
        data: { status: "failed", completedAt: new Date() },
      });
      throw error;
    }
  }

  async getWorkflowRuns(projectId: string, actorId: string) {
    await this.authorization.assertCanRead(projectId, actorId);
    return this.prisma.workflowRun.findMany({
      where: { projectId },
      orderBy: { startedAt: "desc" },
      take: 20,
    });
  }

  async getRequirementsRun(projectId: string, runId: string, actorId: string) {
    return this.requirementsRuns.getRequirementsRun(projectId, runId, actorId);
  }

  async generateInitialRequirements(input: GenerateInitialRequirementsInput) {
    return this.generation.generateInitialRequirements(input);
  }

  async reviseRequirements(input: ReviseRequirementsInput) {
    return this.generation.reviseRequirements(input);
  }

  async generateInitialDocumentation(input: GenerateInitialDocumentationInput) {
    return this.documentationGeneration.generateInitial(input);
  }

  async reviseDocumentation(input: ReviseDocumentationInput) {
    return this.documentationGeneration.reviseDocumentation(input);
  }
}
