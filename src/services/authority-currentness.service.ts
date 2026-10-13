import {
  ArtifactLifecycleStatus,
  PhaseArtifact,
  Prisma,
  PrismaClient,
} from "@prisma/client";
import { PlanningDomainError } from "../planning/planning-errors";
import { REQUIREMENTS_PHASE } from "../planning/requirements-schema";
import { DOCUMENTATION_PHASE } from "../planning/documentation-run-config";

export const ARCHITECTURE_PHASE = "architecture" as const;

export interface ArtifactCurrentnessResult {
  isCurrent: boolean;
  isStale: boolean;
  status: "CURRENT" | "STALE" | "NO_AUTHORITY" | "NO_ACTIVE_BRIEF";
  staleReason: string | null;
  upstreamPhase: string | null;
  activeConfirmationId?: string | null;
  artifactConfirmationId?: string | null;
  activeContentHash?: string | null;
  artifactContentHash?: string | null;
}

export interface PhaseAuthorityCurrentness {
  phase: string;
  hasUsableAuthority: boolean; // approved and current
  isCurrent: boolean;
  isStale: boolean;
  status: string; // The database phase status: "not_started" | "in_progress" | "awaiting_approval" | "approved" | "completed"
  currentArtifactId: string | null;
  currentApprovedArtifactId: string | null;
  staleReason: string | null;
  upstreamPhase: string | null;
  activeConfirmationId?: string | null;
  artifactConfirmationId?: string | null;
}

export class AuthorityCurrentnessService {
  constructor(private readonly prisma?: PrismaClient) {}

  private db(tx?: Prisma.TransactionClient | PrismaClient): Prisma.TransactionClient | PrismaClient {
    if (tx) return tx;
    if (this.prisma) return this.prisma;
    throw new Error("No Prisma client available for AuthorityCurrentnessService");
  }

  async isLegacyProject(
    _tx: Prisma.TransactionClient | PrismaClient,
    _projectId: string,
  ): Promise<boolean> {
    // Under ANKA Architectural Invariants (I-02, D-005), all projects require explicit verified
    // Live Brief authority. Production authorization decisions must not be granted via test schema
    // names, arbitrary creation-date cutoffs, or unverified historical approval markers.
    return false;
  }

  async getRequirementsArtifactCurrentness(
    tx: Prisma.TransactionClient | PrismaClient,
    projectId: string,
    artifact: PhaseArtifact,
  ): Promise<ArtifactCurrentnessResult> {
    if (artifact.projectId !== projectId || artifact.phase !== REQUIREMENTS_PHASE) {
      return {
        isCurrent: false,
        isStale: true,
        status: "NO_AUTHORITY",
        staleReason: "Artifact does not belong to project requirements.",
        upstreamPhase: "requirements",
      };
    }

    // 1. Get project's active confirmation
    const intakeState = await tx.projectIntakeState.findUnique({
      where: { projectId },
      include: {
        currentConfirmation: {
          include: { briefRevision: true },
        },
      },
    });

    const activeConfirmation = intakeState?.currentConfirmation;
    if (
      !activeConfirmation ||
      activeConfirmation.status !== "ACTIVE" ||
      intakeState?.currentConfirmationId !== activeConfirmation.id
    ) {
      return {
        isCurrent: false,
        isStale: true,
        status: "NO_ACTIVE_BRIEF",
        staleReason: "No active Live Brief confirmation exists for this project.",
        upstreamPhase: "live_brief",
      };
    }

    // 2. Find the WorkflowRun that produced this artifact (or its lineage) with brief authority
    let targetArtifact: PhaseArtifact | null = artifact;
    let initialRun: any = null;
    type BriefAuthorityRecord = {
      confirmationId?: string;
      revisionId?: string;
      revisionNumber?: number;
      contentHash?: string;
    };
    let briefAuthority: BriefAuthorityRecord | undefined = undefined;

    const visited = new Set<string>();
    while (targetArtifact) {
      if (visited.has(targetArtifact.id)) break;
      visited.add(targetArtifact.id);

      const run = await tx.workflowRun.findFirst({
        where: {
          projectId,
          currentPhase: REQUIREMENTS_PHASE,
          outputArtifactId: targetArtifact.id,
        },
        orderBy: { startedAt: "desc" },
      });

      if (run) {
        const manifest = run.contextManifest as Record<string, unknown> | null;
        const auth = manifest?.briefAuthority as BriefAuthorityRecord | undefined;
        if (auth?.confirmationId) {
          initialRun = run;
          briefAuthority = auth;
          break;
        }
      }

      if (targetArtifact.previousVersionId) {
        targetArtifact = await tx.phaseArtifact.findUnique({
          where: { id: targetArtifact.previousVersionId },
        });
      } else {
        targetArtifact = null;
      }
    }

    if (!initialRun || !briefAuthority?.confirmationId) {
      return {
        isCurrent: false,
        isStale: true,
        status: "NO_AUTHORITY",
        staleReason: "Requirements artifact has no originating WorkflowRun recording Live Brief authority.",
        upstreamPhase: "live_brief",
        activeConfirmationId: activeConfirmation.id,
      };
    }

    const matchesActive =
      briefAuthority.confirmationId === activeConfirmation.id &&
      briefAuthority.contentHash === activeConfirmation.briefContentHash;

    if (!matchesActive) {
      return {
        isCurrent: false,
        isStale: true,
        status: "STALE",
        staleReason:
          "Requirements artifact was generated from a superseded Live Brief confirmation.",
        upstreamPhase: "live_brief",
        activeConfirmationId: activeConfirmation.id,
        artifactConfirmationId: briefAuthority.confirmationId,
        activeContentHash: activeConfirmation.briefContentHash,
        artifactContentHash: briefAuthority.contentHash,
      };
    }

    return {
      isCurrent: true,
      isStale: false,
      status: "CURRENT",
      staleReason: null,
      upstreamPhase: null,
      activeConfirmationId: activeConfirmation.id,
      artifactConfirmationId: briefAuthority.confirmationId,
      activeContentHash: activeConfirmation.briefContentHash,
      artifactContentHash: briefAuthority.contentHash,
    };
  }

  async getDocumentationArtifactCurrentness(
    tx: Prisma.TransactionClient | PrismaClient,
    projectId: string,
    artifact: PhaseArtifact,
  ): Promise<ArtifactCurrentnessResult> {
    if (artifact.projectId !== projectId || artifact.phase !== DOCUMENTATION_PHASE) {
      return {
        isCurrent: false,
        isStale: true,
        status: "NO_AUTHORITY",
        staleReason: "Artifact does not belong to project documentation.",
        upstreamPhase: "documentation",
      };
    }

    // 1. Get sourceRequirements from structuredContent
    const structured = artifact.structuredContent as Record<string, unknown> | null;
    const sourceReq = structured?.sourceRequirements as
      | {
          artifactId?: string;
          version?: number;
          contentHash?: string;
        }
      | undefined;

    if (!sourceReq?.artifactId) {
      return {
        isCurrent: false,
        isStale: true,
        status: "NO_AUTHORITY",
        staleReason: "Documentation artifact does not reference source Requirements.",
        upstreamPhase: "requirements",
      };
    }

    // 2. Check current approved Requirements authority in project
    const reqState = await tx.projectPhaseState.findUnique({
      where: { projectId_phase: { projectId, phase: REQUIREMENTS_PHASE } },
      select: { currentApprovedArtifactId: true, status: true },
    });

    if (!reqState?.currentApprovedArtifactId || reqState.status !== "approved") {
      return {
        isCurrent: false,
        isStale: true,
        status: "STALE",
        staleReason: "Project has no current approved Requirements authority.",
        upstreamPhase: "requirements",
      };
    }

    if (reqState.currentApprovedArtifactId !== sourceReq.artifactId) {
      return {
        isCurrent: false,
        isStale: true,
        status: "STALE",
        staleReason:
          "Documentation sourceRequirements does not match current approved Requirements.",
        upstreamPhase: "requirements",
      };
    }

    const currentReqArtifact = await tx.phaseArtifact.findUnique({
      where: { id: reqState.currentApprovedArtifactId },
    });

    if (!currentReqArtifact) {
      return {
        isCurrent: false,
        isStale: true,
        status: "STALE",
        staleReason: "Current approved Requirements artifact was not found.",
        upstreamPhase: "requirements",
      };
    }

    // 3. Check if the current approved Requirements artifact is ITSELF current!
    const reqCurrentness = await this.getRequirementsArtifactCurrentness(
      tx,
      projectId,
      currentReqArtifact,
    );
    if (!reqCurrentness.isCurrent) {
      return {
        isCurrent: false,
        isStale: true,
        status: "STALE",
        staleReason: `Upstream Requirements authority is stale: ${reqCurrentness.staleReason}`,
        upstreamPhase: "requirements",
      };
    }

    return {
      isCurrent: true,
      isStale: false,
      status: "CURRENT",
      staleReason: null,
      upstreamPhase: null,
    };
  }

  async getArchitectureArtifactCurrentness(
    tx: Prisma.TransactionClient | PrismaClient,
    projectId: string,
    artifact: PhaseArtifact,
  ): Promise<ArtifactCurrentnessResult> {
    if (artifact.projectId !== projectId || artifact.phase !== ARCHITECTURE_PHASE) {
      return {
        isCurrent: false,
        isStale: true,
        status: "NO_AUTHORITY",
        staleReason: "Artifact does not belong to project architecture.",
        upstreamPhase: "architecture",
      };
    }

    const structured = artifact.structuredContent as Record<string, unknown> | null;
    const sourceReq = structured?.sourceRequirements as { artifactId?: string } | undefined;
    const sourceDoc = structured?.sourceDocumentation as { artifactId?: string } | undefined;

    if (!sourceReq?.artifactId || !sourceDoc?.artifactId) {
      return {
        isCurrent: false,
        isStale: true,
        status: "NO_AUTHORITY",
        staleReason: "Architecture artifact does not reference source Requirements and Documentation.",
        upstreamPhase: "documentation",
      };
    }

    // Check Requirements authority
    const reqState = await tx.projectPhaseState.findUnique({
      where: { projectId_phase: { projectId, phase: REQUIREMENTS_PHASE } },
      select: { currentApprovedArtifactId: true, status: true },
    });
    if (
      !reqState?.currentApprovedArtifactId ||
      reqState.status !== "approved" ||
      reqState.currentApprovedArtifactId !== sourceReq.artifactId
    ) {
      return {
        isCurrent: false,
        isStale: true,
        status: "STALE",
        staleReason: "Upstream Requirements authority is not current or mismatched.",
        upstreamPhase: "requirements",
      };
    }
    const reqArtifact = await tx.phaseArtifact.findUnique({
      where: { id: reqState.currentApprovedArtifactId },
    });
    if (!reqArtifact) {
      return {
        isCurrent: false,
        isStale: true,
        status: "STALE",
        staleReason: "Requirements artifact not found.",
        upstreamPhase: "requirements",
      };
    }
    const reqCurrentness = await this.getRequirementsArtifactCurrentness(
      tx,
      projectId,
      reqArtifact,
    );
    if (!reqCurrentness.isCurrent) {
      return {
        isCurrent: false,
        isStale: true,
        status: "STALE",
        staleReason: `Upstream Requirements authority is stale: ${reqCurrentness.staleReason}`,
        upstreamPhase: "requirements",
      };
    }

    // Check Documentation authority
    const docState = await tx.projectPhaseState.findUnique({
      where: { projectId_phase: { projectId, phase: DOCUMENTATION_PHASE } },
      select: { currentApprovedArtifactId: true, status: true },
    });
    if (
      !docState?.currentApprovedArtifactId ||
      docState.status !== "approved" ||
      docState.currentApprovedArtifactId !== sourceDoc.artifactId
    ) {
      return {
        isCurrent: false,
        isStale: true,
        status: "STALE",
        staleReason: "Upstream Documentation authority is not current or mismatched.",
        upstreamPhase: "documentation",
      };
    }
    const docArtifact = await tx.phaseArtifact.findUnique({
      where: { id: docState.currentApprovedArtifactId },
    });
    if (!docArtifact) {
      return {
        isCurrent: false,
        isStale: true,
        status: "STALE",
        staleReason: "Documentation artifact not found.",
        upstreamPhase: "documentation",
      };
    }
    const docCurrentness = await this.getDocumentationArtifactCurrentness(
      tx,
      projectId,
      docArtifact,
    );
    if (!docCurrentness.isCurrent) {
      return {
        isCurrent: false,
        isStale: true,
        status: "STALE",
        staleReason: `Upstream Documentation authority is stale: ${docCurrentness.staleReason}`,
        upstreamPhase: "documentation",
      };
    }

    return {
      isCurrent: true,
      isStale: false,
      status: "CURRENT",
      staleReason: null,
      upstreamPhase: null,
    };
  }

  async getPhaseAuthorityCurrentness(
    tx: Prisma.TransactionClient | PrismaClient,
    projectId: string,
    phase: string,
  ): Promise<PhaseAuthorityCurrentness> {
    const state = await tx.projectPhaseState.findUnique({
      where: { projectId_phase: { projectId, phase } },
    });
    const status = state?.status ?? "not_started";
    const currentArtifactId = state?.currentArtifactId ?? null;
    const currentApprovedArtifactId = state?.currentApprovedArtifactId ?? null;

    if (phase === REQUIREMENTS_PHASE) {
      if (!currentApprovedArtifactId || status !== "approved") {
        if (currentArtifactId) {
          const currentArt = await tx.phaseArtifact.findUnique({
            where: { id: currentArtifactId },
          });
          if (currentArt) {
            const currentness = await this.getRequirementsArtifactCurrentness(
              tx,
              projectId,
              currentArt,
            );
            return {
              phase,
              hasUsableAuthority: false,
              isCurrent: currentness.isCurrent,
              isStale: currentness.isStale,
              status,
              currentArtifactId,
              currentApprovedArtifactId,
              staleReason: currentness.staleReason,
              upstreamPhase: currentness.upstreamPhase,
              activeConfirmationId: currentness.activeConfirmationId,
              artifactConfirmationId: currentness.artifactConfirmationId,
            };
          }
        }
        return {
          phase,
          hasUsableAuthority: false,
          isCurrent: true,
          isStale: false,
          status,
          currentArtifactId,
          currentApprovedArtifactId,
          staleReason: null,
          upstreamPhase: null,
        };
      }

      const approvedArt = await tx.phaseArtifact.findUnique({
        where: { id: currentApprovedArtifactId },
      });
      if (!approvedArt) {
        return {
          phase,
          hasUsableAuthority: false,
          isCurrent: false,
          isStale: true,
          status,
          currentArtifactId,
          currentApprovedArtifactId,
          staleReason: "Approved Requirements artifact not found.",
          upstreamPhase: "requirements",
        };
      }

      const currentness = await this.getRequirementsArtifactCurrentness(
        tx,
        projectId,
        approvedArt,
      );
      return {
        phase,
        hasUsableAuthority: currentness.isCurrent,
        isCurrent: currentness.isCurrent,
        isStale: currentness.isStale,
        status,
        currentArtifactId,
        currentApprovedArtifactId,
        staleReason: currentness.staleReason,
        upstreamPhase: currentness.upstreamPhase,
        activeConfirmationId: currentness.activeConfirmationId,
        artifactConfirmationId: currentness.artifactConfirmationId,
      };
    }

    if (phase === DOCUMENTATION_PHASE) {
      if (!currentApprovedArtifactId || status !== "approved") {
        if (currentArtifactId) {
          const currentArt = await tx.phaseArtifact.findUnique({
            where: { id: currentArtifactId },
          });
          if (currentArt) {
            const currentness = await this.getDocumentationArtifactCurrentness(
              tx,
              projectId,
              currentArt,
            );
            return {
              phase,
              hasUsableAuthority: false,
              isCurrent: currentness.isCurrent,
              isStale: currentness.isStale,
              status,
              currentArtifactId,
              currentApprovedArtifactId,
              staleReason: currentness.staleReason,
              upstreamPhase: currentness.upstreamPhase,
            };
          }
        }
        const reqAuthority = await this.getPhaseAuthorityCurrentness(
          tx,
          projectId,
          REQUIREMENTS_PHASE,
        );
        return {
          phase,
          hasUsableAuthority: false,
          isCurrent: !reqAuthority.isStale,
          isStale: reqAuthority.isStale,
          status,
          currentArtifactId,
          currentApprovedArtifactId,
          staleReason: reqAuthority.isStale
            ? "Upstream Requirements authority is stale."
            : null,
          upstreamPhase: reqAuthority.isStale ? "requirements" : null,
        };
      }

      const approvedArt = await tx.phaseArtifact.findUnique({
        where: { id: currentApprovedArtifactId },
      });
      if (!approvedArt) {
        return {
          phase,
          hasUsableAuthority: false,
          isCurrent: false,
          isStale: true,
          status,
          currentArtifactId,
          currentApprovedArtifactId,
          staleReason: "Approved Documentation artifact not found.",
          upstreamPhase: "documentation",
        };
      }
      const currentness = await this.getDocumentationArtifactCurrentness(
        tx,
        projectId,
        approvedArt,
      );
      return {
        phase,
        hasUsableAuthority: currentness.isCurrent,
        isCurrent: currentness.isCurrent,
        isStale: currentness.isStale,
        status,
        currentArtifactId,
        currentApprovedArtifactId,
        staleReason: currentness.staleReason,
        upstreamPhase: currentness.upstreamPhase,
      };
    }

    if (phase === ARCHITECTURE_PHASE) {
      if (!currentApprovedArtifactId || status !== "approved") {
        if (currentArtifactId) {
          const currentArt = await tx.phaseArtifact.findUnique({
            where: { id: currentArtifactId },
          });
          if (currentArt) {
            const currentness = await this.getArchitectureArtifactCurrentness(
              tx,
              projectId,
              currentArt,
            );
            return {
              phase,
              hasUsableAuthority: false,
              isCurrent: currentness.isCurrent,
              isStale: currentness.isStale,
              status,
              currentArtifactId,
              currentApprovedArtifactId,
              staleReason: currentness.staleReason,
              upstreamPhase: currentness.upstreamPhase,
            };
          }
        }
        const docAuthority = await this.getPhaseAuthorityCurrentness(
          tx,
          projectId,
          DOCUMENTATION_PHASE,
        );
        return {
          phase,
          hasUsableAuthority: false,
          isCurrent: !docAuthority.isStale,
          isStale: docAuthority.isStale,
          status,
          currentArtifactId,
          currentApprovedArtifactId,
          staleReason: docAuthority.isStale
            ? "Upstream Documentation authority is stale."
            : null,
          upstreamPhase: docAuthority.isStale ? "documentation" : null,
        };
      }

      const approvedArt = await tx.phaseArtifact.findUnique({
        where: { id: currentApprovedArtifactId },
      });
      if (!approvedArt) {
        return {
          phase,
          hasUsableAuthority: false,
          isCurrent: false,
          isStale: true,
          status,
          currentArtifactId,
          currentApprovedArtifactId,
          staleReason: "Approved Architecture artifact not found.",
          upstreamPhase: "architecture",
        };
      }
      const currentness = await this.getArchitectureArtifactCurrentness(
        tx,
        projectId,
        approvedArt,
      );
      return {
        phase,
        hasUsableAuthority: currentness.isCurrent,
        isCurrent: currentness.isCurrent,
        isStale: currentness.isStale,
        status,
        currentArtifactId,
        currentApprovedArtifactId,
        staleReason: currentness.staleReason,
        upstreamPhase: currentness.upstreamPhase,
      };
    }

    return {
      phase,
      hasUsableAuthority: status === "approved" || status === "completed",
      isCurrent: true,
      isStale: false,
      status,
      currentArtifactId,
      currentApprovedArtifactId,
      staleReason: null,
      upstreamPhase: null,
    };
  }

  async assertRequirementsCurrentForHandoff(
    tx: Prisma.TransactionClient | PrismaClient,
    projectId: string,
    reqArtifact: PhaseArtifact,
  ): Promise<void> {
    const currentness = await this.getRequirementsArtifactCurrentness(
      tx,
      projectId,
      reqArtifact,
    );
    if (!currentness.isCurrent) {
      throw new PlanningDomainError(
        "PLANNING_STALE_UPSTREAM",
        "Requirements authority is stale because the Live Brief was reconfirmed. Generate and approve updated Requirements before proceeding.",
        409,
        {
          phase: REQUIREMENTS_PHASE,
          upstreamPhase: "live_brief",
          artifactId: reqArtifact.id,
          staleReason: currentness.staleReason,
          activeConfirmationId: currentness.activeConfirmationId,
          artifactConfirmationId: currentness.artifactConfirmationId,
        },
      );
    }
  }

  async assertDocumentationCurrentForHandoff(
    tx: Prisma.TransactionClient | PrismaClient,
    projectId: string,
    docArtifact: PhaseArtifact,
  ): Promise<void> {
    const currentness = await this.getDocumentationArtifactCurrentness(
      tx,
      projectId,
      docArtifact,
    );
    if (!currentness.isCurrent) {
      throw new PlanningDomainError(
        "PLANNING_STALE_UPSTREAM",
        `Documentation authority is stale: ${currentness.staleReason}`,
        409,
        {
          phase: DOCUMENTATION_PHASE,
          upstreamPhase: currentness.upstreamPhase ?? "requirements",
          artifactId: docArtifact.id,
          staleReason: currentness.staleReason,
        },
      );
    }
  }

  async assertArchitectureCurrentForHandoff(
    tx: Prisma.TransactionClient | PrismaClient,
    projectId: string,
    archArtifact: PhaseArtifact,
  ): Promise<void> {
    const currentness = await this.getArchitectureArtifactCurrentness(
      tx,
      projectId,
      archArtifact,
    );
    if (!currentness.isCurrent) {
      throw new PlanningDomainError(
        "PLANNING_STALE_UPSTREAM",
        `Architecture authority is stale: ${currentness.staleReason ?? "Upstream authority has been superseded."}`,
        409,
        {
          phase: ARCHITECTURE_PHASE,
          upstreamPhase: currentness.upstreamPhase ?? "documentation",
          artifactId: archArtifact.id,
          staleReason: currentness.staleReason,
        },
      );
    }
  }
}
