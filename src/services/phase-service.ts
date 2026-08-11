import { PrismaClient } from "@prisma/client";
import { AiService } from "../ai/application/AiService";

const prisma = new PrismaClient();
const aiService = AiService.getInstance();

// Canonical phase order — mirrors the phase model in the workflow spec.
export const PHASE_ORDER = [
  "requirements",
  "documentation",
  "architecture",
  "implementation",
  "testing",
  "review",
] as const;

export type Phase = (typeof PHASE_ORDER)[number];

function nextPhase(phase: string): Phase | null {
  const idx = PHASE_ORDER.indexOf(phase as Phase);
  if (idx === -1 || idx === PHASE_ORDER.length - 1) return null;
  return PHASE_ORDER[idx + 1];
}

export class PhaseService {
  async getPhaseStates(projectId: string) {
    return prisma.projectPhaseState.findMany({
      where: { projectId },
      orderBy: { phase: "asc" },
    });
  }

  // Idempotently create a "not_started" row for every phase that doesn't have one yet.
  async ensurePhaseStates(projectId: string) {
    const existing = await prisma.projectPhaseState.findMany({
      where: { projectId },
      select: { phase: true },
    });
    const existingPhases = new Set(existing.map((s) => s.phase));
    const missing = PHASE_ORDER.filter((p) => !existingPhases.has(p));

    if (missing.length > 0) {
      await prisma.projectPhaseState.createMany({
        data: missing.map((phase) => ({ projectId, phase })),
        skipDuplicates: true,
      });
    }

    return this.getPhaseStates(projectId);
  }

  async startPhase(projectId: string, phase: string) {
    const state = await prisma.projectPhaseState.upsert({
      where: { projectId_phase: { projectId, phase } },
      update: { status: "in_progress", startedAt: new Date() },
      create: { projectId, phase, status: "in_progress", startedAt: new Date() },
    });
    await prisma.project.update({ where: { id: projectId }, data: { currentPhase: phase } });
    return state;
  }

  async requestApproval(projectId: string, phase: string) {
    return prisma.projectPhaseState.upsert({
      where: { projectId_phase: { projectId, phase } },
      update: { status: "awaiting_approval" },
      create: { projectId, phase, status: "awaiting_approval" },
    });
  }

  // Approve the given phase, record the approval, and advance the project to the next phase.
  async approvePhase(
    projectId: string,
    phase: string,
    approvedById: string,
    comments?: string,
  ) {
    const now = new Date();

    await prisma.phaseApproval.create({
      data: { projectId, phase, approvedById, decision: "approved", comments },
    });

    // Mark the artifact that was actually approved so consumers (e.g. the
    // coding agent) can query for approved content instead of just "latest".
    const latestArtifact = await prisma.phaseArtifact.findFirst({
      where: { projectId, phase },
      orderBy: { createdAt: "desc" },
    });
    if (latestArtifact) {
      await prisma.phaseArtifact.update({
        where: { id: latestArtifact.id },
        data: { approved: true },
      });
    }

    await prisma.projectPhaseState.upsert({
      where: { projectId_phase: { projectId, phase } },
      update: { status: "approved", completedAt: now, approvedById, approvedAt: now },
      create: {
        projectId,
        phase,
        status: "approved",
        completedAt: now,
        approvedById,
        approvedAt: now,
      },
    });

    const projectUpdate: Record<string, unknown> = {};
    if (phase === "architecture") projectUpdate.architectureApprovedAt = now;

    const next = nextPhase(phase);
    if (next) {
      await prisma.projectPhaseState.upsert({
        where: { projectId_phase: { projectId, phase: next } },
        update: { status: "in_progress", startedAt: now },
        create: { projectId, phase: next, status: "in_progress", startedAt: now },
      });
      projectUpdate.currentPhase = next;
    }

    if (Object.keys(projectUpdate).length > 0) {
      await prisma.project.update({ where: { id: projectId }, data: projectUpdate });
    }

    return this.getPhaseStates(projectId);
  }

  // Reject a phase — records the rejection and resets the phase to not_started.
  async rejectPhase(
    projectId: string,
    phase: string,
    approvedById: string,
    comments?: string,
  ) {
    await prisma.phaseApproval.create({
      data: { projectId, phase, approvedById, decision: "rejected", comments },
    });

    return prisma.projectPhaseState.upsert({
      where: { projectId_phase: { projectId, phase } },
      update: { status: "not_started", notes: comments, startedAt: null, completedAt: null },
      create: { projectId, phase, status: "not_started", notes: comments },
    });
  }

  // Send a phase back for rework — records the decision and reopens the phase.
  async requestChanges(
    projectId: string,
    phase: string,
    approvedById: string,
    comments?: string,
  ) {
    await prisma.phaseApproval.create({
      data: { projectId, phase, approvedById, decision: "changes_requested", comments },
    });

    return prisma.projectPhaseState.upsert({
      where: { projectId_phase: { projectId, phase } },
      update: { status: "in_progress", notes: comments },
      create: { projectId, phase, status: "in_progress", notes: comments },
    });
  }

  async getApprovalHistory(projectId: string, phase?: string) {
    return prisma.phaseApproval.findMany({
      where: { projectId, ...(phase ? { phase } : {}) },
      orderBy: { approvedAt: "desc" },
    });
  }

  // ── Artifacts ──────────────────────────────────────────────────────────────

  async listArtifacts(projectId: string, phase?: string) {
    return prisma.phaseArtifact.findMany({
      where: { projectId, ...(phase ? { phase } : {}) },
      orderBy: { createdAt: "desc" },
    });
  }

  async createArtifact(
    projectId: string,
    data: { phase: string; type: string; title: string; content: string; createdBy: string },
  ) {
    const previous = await prisma.phaseArtifact.findFirst({
      where: { projectId, phase: data.phase },
      orderBy: { createdAt: "desc" },
    });
    return prisma.phaseArtifact.create({
      data: { projectId, ...data, version: (previous?.version || 0) + 1 },
    });
  }

  // ── Automated runs ─────────────────────────────────────────────────────────

  // AI-drafts a proposal for the given phase, saves it as an artifact, and
  // logs a WorkflowRun with model usage/cost for auditability.
  async runAutomatedPhase(projectId: string, phase: string, createdBy: string, brief?: string) {
    const run = await prisma.workflowRun.create({
      data: { projectId, triggerType: "manual", currentPhase: phase, status: "running" },
    });

    try {
      // If the phase's most recent decision was "changes requested" and there's a
      // prior artifact, feed both into the regeneration so the AI revises the
      // existing draft to address the feedback rather than starting from scratch.
      const [previousArtifact, latestDecision] = await Promise.all([
        prisma.phaseArtifact.findFirst({ where: { projectId, phase }, orderBy: { createdAt: "desc" } }),
        prisma.phaseApproval.findFirst({ where: { projectId, phase }, orderBy: { approvedAt: "desc" } }),
      ]);
      const revision =
        previousArtifact && latestDecision?.decision === "changes_requested" && latestDecision.comments
          ? { previousContent: previousArtifact.content, feedback: latestDecision.comments }
          : undefined;

      const proposal = await aiService.generatePhaseProposal(projectId, phase, revision, brief);

      const artifact = await prisma.phaseArtifact.create({
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

      await this.startPhase(projectId, phase);

      await prisma.workflowRun.update({
        where: { id: run.id },
        data: {
          status: "completed",
          completedAt: new Date(),
          modelUsage: { model: proposal.model, ...proposal.usage },
          costUSD: proposal.costUSD,
        },
      });

      return { artifact, workflowRun: await prisma.workflowRun.findUnique({ where: { id: run.id } }) };
    } catch (err) {
      await prisma.workflowRun.update({
        where: { id: run.id },
        data: { status: "failed", completedAt: new Date() },
      });
      throw err;
    }
  }

  async getWorkflowRuns(projectId: string) {
    return prisma.workflowRun.findMany({
      where: { projectId },
      orderBy: { startedAt: "desc" },
      take: 20,
    });
  }
}
