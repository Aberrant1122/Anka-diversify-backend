import { ArtifactActorType, ArtifactChangeKind, Prisma, PrismaClient } from "@prisma/client";
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
import { PlanningArchitectureArtifactService, CreateArchitectureInput } from "./planning-architecture-artifact.service";
import { GenerateInitialArchitectureInput, PlanningArchitectureGenerationService, ReviseArchitectureInput } from "./planning-architecture-generation.service";
import { PlanningArchitectureRunService } from "./planning-architecture-run.service";
import { resolveImplementationAuthority } from "../planning/implementation-authority-preflight";
import { AuthorityCurrentnessService, ARCHITECTURE_PHASE, ArtifactCurrentnessResult } from "./authority-currentness.service";
import { DOCUMENTATION_PHASE } from "../planning/documentation-run-config";
import { parseRequirementsContent } from "../planning/requirements-schema";
import { computeRequirementsDiff } from "../planning/requirements-revision-policy";
import { parseDocumentationContent } from "../planning/documentation-schema";
import { computeDocumentationDiff } from "../planning/documentation-revision-policy";
import { parseArchitectureContent } from "../planning/architecture-schema";
import { computeArchitectureDiff } from "../planning/architecture-revision-policy";

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
  private readonly architectureArtifacts: PlanningArchitectureArtifactService;
  private readonly architectureGeneration: PlanningArchitectureGenerationService;
  private readonly architectureRuns: PlanningArchitectureRunService;
  private readonly currentness: AuthorityCurrentnessService;

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
    this.architectureArtifacts = new PlanningArchitectureArtifactService(prisma, this.authorization);
    this.architectureRuns = new PlanningArchitectureRunService(prisma, {
      authorization: this.authorization, artifacts: this.architectureArtifacts,
    });
    this.architectureGeneration = new PlanningArchitectureGenerationService(prisma, { runs: this.architectureRuns });
    this.currentness = new AuthorityCurrentnessService(prisma);
  }

  async getPhaseStates(projectId: string, actorId: string) {
    await this.authorization.assertCanRead(projectId, actorId);
    const states = await this.prisma.projectPhaseState.findMany({ where: { projectId }, orderBy: { phase: "asc" } });
    return Promise.all(
      states.map(async (state) => {
        const currentness = await this.currentness.getPhaseAuthorityCurrentness(
          this.prisma,
          projectId,
          state.phase,
        );
        return {
          ...state,
          isCurrent: currentness.isCurrent,
          hasUsableAuthority: currentness.hasUsableAuthority,
          isStale: currentness.isStale,
          staleReason: currentness.staleReason,
          upstreamPhase: currentness.upstreamPhase,
          activeConfirmationId: currentness.activeConfirmationId,
          artifactConfirmationId: currentness.artifactConfirmationId,
        };
      })
    );
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
    if (phase === REQUIREMENTS_PHASE || phase === "architecture" || phase === "documentation" || phase === "testing" || phase === "review") {
      throw new PlanningDomainError(
        "PLANNING_ACTION_LOCKED",
        `${phase} cannot be started through the generic phase route.`,
        409,
      );
    }
    if (!PHASE_ORDER.includes(phase as Phase)) {
      throw new PlanningDomainError("PLANNING_INVALID_PHASE", `Unknown phase '${phase}'.`, 422, { phase });
    }
    return this.prisma.$transaction(async (tx) => {
      await resolveImplementationAuthority(tx, projectId, actorId);
      const state = await tx.projectPhaseState.update({
        where: { projectId_phase: { projectId, phase } },
        data: { status: "in_progress", startedAt: new Date() },
      });
      await tx.project.update({ where: { id: projectId }, data: { currentPhase: phase } });
      return state;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async requestApproval(
    projectId: string,
    phase: string,
    artifactId: string,
    expectedHash: string,
    actorId: string,
  ) {
    if (phase === REQUIREMENTS_PHASE) {
      return this.approvals.requestApproval({ projectId, phase, artifactId, expectedHash, actorId });
    }
    if (phase === "documentation") {
      return this.approvals.requestDocumentationApproval({ projectId, artifactId, expectedHash, actorId });
    }
    if (phase === "architecture") {
      return this.approvals.requestArchitectureApproval({ projectId, artifactId, expectedHash, actorId });
    }
    throw new PlanningDomainError("PLANNING_INVALID_PHASE", `Unknown approval phase '${phase}'.`, 422, { phase });
  }

  async approvePhase(
    projectId: string,
    phase: string,
    artifactId: string,
    expectedHash: string,
    approvedById: string,
    comments?: string,
  ) {
    if (phase === REQUIREMENTS_PHASE) {
      return this.approvals.approveArtifact({
        projectId, phase, artifactId, expectedHash, actorId: approvedById, comments,
      });
    }
    if (phase === "documentation") {
      return this.approvals.approveDocumentationArtifact({
        projectId, artifactId, expectedHash, actorId: approvedById, comments,
      });
    }
    if (phase === "architecture") {
      return this.approvals.approveArchitectureArtifact({
        projectId, artifactId, expectedHash, actorId: approvedById, comments,
      });
    }
    throw new PlanningDomainError("PLANNING_INVALID_PHASE", `Unknown approval phase '${phase}'.`, 422, { phase });
  }

  async requestChanges(
    projectId: string,
    phase: string,
    artifactId: string,
    expectedHash: string,
    approvedById: string,
    comments: string,
  ) {
    if (phase === REQUIREMENTS_PHASE) {
      return this.approvals.requestChanges({
        projectId, phase, artifactId, expectedHash, actorId: approvedById, comments,
      });
    }
    if (phase === "documentation") {
      return this.approvals.requestDocumentationChanges({
        projectId, artifactId, expectedHash, actorId: approvedById, comments,
      });
    }
    if (phase === "architecture") {
      return this.approvals.requestArchitectureChanges({
        projectId, artifactId, expectedHash, actorId: approvedById, comments,
      });
    }
    throw new PlanningDomainError("PLANNING_INVALID_PHASE", `Unknown approval phase '${phase}'.`, 422, { phase });
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

  async createArchitectureArtifact(input: CreateArchitectureInput) {
    return this.architectureArtifacts.create(input);
  }

  async getArchitectureReadiness(projectId: string, artifactId: string, actorId: string, expectedHash?: string) {
    return this.architectureArtifacts.getReadiness(projectId, artifactId, actorId, expectedHash);
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
    if (PHASE_ORDER.includes(phase as Phase)) {
      throw new PlanningDomainError(
        "PLANNING_ACTION_LOCKED",
        `${phase} cannot generate an authoritative artifact through the generic automated route.`,
        409,
      );
    }
    throw new PlanningDomainError("PLANNING_INVALID_PHASE", `Unknown phase '${phase}'.`, 422, { phase });

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

  async generateInitialArchitecture(input: GenerateInitialArchitectureInput) {
    return this.architectureGeneration.generateInitial(input);
  }

  async reviseArchitecture(input: ReviseArchitectureInput) {
    return this.architectureGeneration.reviseArchitecture(input);
  }

  async getArchitectureRun(projectId: string, runId: string, actorId: string) {
    return this.architectureRuns.getRun(projectId, runId, actorId);
  }

  async reviseDocumentation(input: ReviseDocumentationInput) {
    return this.documentationGeneration.reviseDocumentation(input);
  }

  async getArtifactCurrentness(projectId: string, artifactId: string, actorId: string) {
    await this.authorization.assertCanRead(projectId, actorId);
    const artifact = await this.prisma.phaseArtifact.findUnique({
      where: { id: artifactId },
    });
    if (!artifact || artifact.projectId !== projectId) {
      throw new PlanningDomainError(
        "PLANNING_ARTIFACT_NOT_FOUND",
        "Artifact was not found in this project.",
        404,
        { artifactId },
      );
    }
    let currentness: ArtifactCurrentnessResult;
    if (artifact.phase === REQUIREMENTS_PHASE) {
      currentness = await this.currentness.getRequirementsArtifactCurrentness(
        this.prisma,
        projectId,
        artifact,
      );
    } else if (artifact.phase === DOCUMENTATION_PHASE) {
      currentness = await this.currentness.getDocumentationArtifactCurrentness(
        this.prisma,
        projectId,
        artifact,
      );
    } else if (artifact.phase === ARCHITECTURE_PHASE) {
      currentness = await this.currentness.getArchitectureArtifactCurrentness(
        this.prisma,
        projectId,
        artifact,
      );
    } else {
      currentness = {
        isCurrent: true,
        isStale: false,
        status: "CURRENT",
        staleReason: null,
        upstreamPhase: null,
      };
    }
    return {
      artifactId: artifact.id,
      phase: artifact.phase,
      version: artifact.version,
      ...currentness,
    };
  }

  async compareArtifactVersions(
    projectId: string,
    artifactId: string,
    compareArtifactId: string,
    actorId: string,
  ) {
    await this.authorization.assertCanRead(projectId, actorId);
    if (!compareArtifactId || !compareArtifactId.trim()) {
      throw new PlanningDomainError(
        "PLANNING_ARTIFACT_INVALID",
        "compareArtifactId is required for artifact version comparison.",
        422,
        { field: "compareArtifactId" },
      );
    }
    const [art1, art2] = await Promise.all([
      this.prisma.phaseArtifact.findUnique({ where: { id: artifactId } }),
      this.prisma.phaseArtifact.findUnique({ where: { id: compareArtifactId.trim() } }),
    ]);
    if (!art1 || art1.projectId !== projectId) {
      throw new PlanningDomainError(
        "PLANNING_ARTIFACT_NOT_FOUND",
        "Primary artifact was not found in this project.",
        404,
        { artifactId },
      );
    }
    if (!art2 || art2.projectId !== projectId) {
      throw new PlanningDomainError(
        "PLANNING_ARTIFACT_NOT_FOUND",
        "Comparison artifact was not found in this project.",
        404,
        { artifactId: compareArtifactId },
      );
    }
    if (art1.phase !== art2.phase) {
      throw new PlanningDomainError(
        "PLANNING_ARTIFACT_INVALID",
        `Cannot compare artifacts from different phases: '${art1.phase}' vs '${art2.phase}'.`,
        422,
        { phase1: art1.phase, phase2: art2.phase },
      );
    }
    if (!art1.structuredContent || !art2.structuredContent) {
      throw new PlanningDomainError(
        "PLANNING_ARTIFACT_INVALID",
        "Both artifacts must have structured content for comparison.",
        422,
      );
    }

    const base = art1.version <= art2.version ? art1 : art2;
    const target = art1.version <= art2.version ? art2 : art1;

    let diff: unknown;
    if (art1.phase === REQUIREMENTS_PHASE) {
      const baseContent = parseRequirementsContent(base.structuredContent);
      const targetContent = parseRequirementsContent(target.structuredContent);
      diff = computeRequirementsDiff(baseContent, targetContent);
    } else if (art1.phase === DOCUMENTATION_PHASE) {
      const baseContent = parseDocumentationContent(base.structuredContent);
      const targetContent = parseDocumentationContent(target.structuredContent);
      diff = computeDocumentationDiff(baseContent, targetContent);
    } else if (art1.phase === ARCHITECTURE_PHASE) {
      const baseContent = parseArchitectureContent(base.structuredContent);
      const targetContent = parseArchitectureContent(target.structuredContent);
      diff = computeArchitectureDiff(baseContent, targetContent);
    } else {
      throw new PlanningDomainError(
        "PLANNING_ARTIFACT_INVALID",
        `Diff comparison is not supported for phase '${art1.phase}'.`,
        422,
        { phase: art1.phase },
      );
    }

    return {
      phase: art1.phase,
      baseArtifact: {
        id: base.id,
        version: base.version,
        title: base.title,
        contentHash: base.contentHash,
      },
      targetArtifact: {
        id: target.id,
        version: target.version,
        title: target.title,
        contentHash: target.contentHash,
      },
      diff,
    };
  }
}
