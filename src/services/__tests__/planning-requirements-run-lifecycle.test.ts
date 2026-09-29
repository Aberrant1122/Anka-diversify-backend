import crypto from "crypto";
import { PrismaClient, WorkflowOperation } from "@prisma/client";
import { RequirementsContent } from "../../planning/requirements-schema";
import { REQUIREMENTS_INPUT_LIMITS } from "../../planning/requirements-run-config";
import { PlanningArtifactService } from "../planning-artifact.service";
import { PlanningRequirementsRunService } from "../planning-requirements-run.service";

const databaseUrl = process.env.DATABASE_URL;
const isolatedSchema = databaseUrl ? new URL(databaseUrl).searchParams.get("schema") : null;
const describeIsolated = isolatedSchema?.startsWith("planning_checkpoint_1c_b_") ? describe : describe.skip;

const prisma = new PrismaClient();
const runs = new PlanningRequirementsRunService(prisma);
const artifacts = new PlanningArtifactService(prisma);
const ownerId = `checkpoint-1c-b-owner-${crypto.randomUUID()}`;
const memberId = `checkpoint-1c-b-member-${crypto.randomUUID()}`;
const outsiderId = `checkpoint-1c-b-outsider-${crypto.randomUUID()}`;
const adminId = `checkpoint-1c-b-admin-${crypto.randomUUID()}`;
const projectIds: string[] = [];

function requirements(label: string): RequirementsContent {
  return {
    projectGoal: `Deliver ${label}`,
    problemStatement: `Need ${label}`,
    usersAndActors: [{ id: "actor-1", name: "Owner", description: "Owns the result." }],
    userStories: [{ id: "story-1", actor: "Owner", capability: label, benefit: "scope", acceptanceCriteriaIds: ["ac-1"] }],
    functionalRequirements: [{ id: "fr-1", title: label, description: `Support ${label}.` }],
    nonFunctionalRequirements: [{ id: "nfr-1", title: "Audit", description: "Keep provenance." }],
    constraints: [], integrations: [], assumptions: [],
    acceptanceCriteria: [{ id: "ac-1", description: "It works.", relatedRequirementIds: ["fr-1"] }],
    outOfScope: [], unresolvedQuestions: [],
  };
}

async function project(owner = ownerId, member = false): Promise<string> {
  const id = `checkpoint-1c-b-project-${crypto.randomUUID()}`;
  await prisma.project.create({ data: { id, name: "Checkpoint 1C-B", description: "Metadata only", userId: owner } });
  if (member) await prisma.projectMember.create({ data: { projectId: id, userId: memberId } });
  projectIds.push(id);
  return id;
}

describeIsolated("Checkpoint 1C-B Requirements run lifecycle", () => {
  beforeAll(async () => {
    await prisma.user.createMany({ data: [
      { id: ownerId, email: `${ownerId}@anka.test`, password: "unused", role: "user" },
      { id: memberId, email: `${memberId}@anka.test`, password: "unused", role: "user" },
      { id: outsiderId, email: `${outsiderId}@anka.test`, password: "unused", role: "user" },
      { id: adminId, email: `${adminId}@anka.test`, password: "unused", role: "admin" },
    ] });
  });

  afterAll(async () => {
    for (const id of projectIds.reverse()) await prisma.project.delete({ where: { id } });
    await prisma.user.deleteMany({ where: { id: { in: [ownerId, memberId, outsiderId, adminId] } } });
    await prisma.$disconnect();
  });

  test("acceptance flow records, reuses, conflicts, leases, fails, releases, and permits a new run without creating artifacts", async () => {
    const projectId = await project();
    const before = await prisma.phaseArtifact.count({ where: { projectId } });
    const first = await runs.startRequirementsRun({
      projectId, actorId: ownerId, operation: WorkflowOperation.INITIAL_GENERATION,
      idempotencyKey: "initial-1", brief: "  Exact brief\r\nwith scope  ",
    });
    expect(first.reused).toBe(false);
    expect(first.run).toMatchObject({ status: "running", operation: "INITIAL_GENERATION", initiatedById: ownerId });
    expect((first.run.contextManifest as Record<string, unknown>).brief).toMatchObject({ normalizedText: "Exact brief\nwith scope" });
    await expect(prisma.projectPhaseState.findUniqueOrThrow({
      where: { projectId_phase: { projectId, phase: "requirements" } },
    })).resolves.toMatchObject({ activeRunId: first.run.id });

    const reused = await runs.startRequirementsRun({
      projectId, actorId: ownerId, operation: WorkflowOperation.INITIAL_GENERATION,
      idempotencyKey: "initial-1", brief: "Exact brief\nwith scope",
    });
    expect(reused.reused).toBe(true);
    expect(reused.run.id).toBe(first.run.id);
    await expect(runs.startRequirementsRun({
      projectId, actorId: ownerId, operation: WorkflowOperation.INITIAL_GENERATION,
      idempotencyKey: "initial-1", brief: "Different brief",
    })).rejects.toMatchObject({ code: "PLANNING_IDEMPOTENCY_CONFLICT", httpStatus: 409 });
    await expect(runs.startRequirementsRun({
      projectId, actorId: ownerId, operation: WorkflowOperation.INITIAL_GENERATION,
      idempotencyKey: "initial-2", brief: "Competing brief",
    })).rejects.toMatchObject({ code: "PLANNING_GENERATION_IN_PROGRESS", httpStatus: 409 });

    await runs.failRequirementsRun(projectId, first.run.id, { code: "SIMULATED_FAILURE", message: "No LLM was called." });
    await expect(prisma.projectPhaseState.findUniqueOrThrow({
      where: { projectId_phase: { projectId, phase: "requirements" } },
    })).resolves.toMatchObject({ activeRunId: null });
    const next = await runs.startRequirementsRun({
      projectId, actorId: ownerId, operation: WorkflowOperation.INITIAL_GENERATION,
      idempotencyKey: "initial-3", brief: "New run after release",
    });
    expect(next.run.id).not.toBe(first.run.id);
    expect(await prisma.phaseArtifact.count({ where: { projectId } })).toBe(before);
    await runs.cancelRequirementsRun(projectId, next.run.id);
    await expect(prisma.projectPhaseState.findUniqueOrThrow({
      where: { projectId_phase: { projectId, phase: "requirements" } },
    })).resolves.toMatchObject({ activeRunId: null });
  });

  test("initial-generation currentness succeeds while no Requirements artifact exists", async () => {
    const projectId = await project();
    await prisma.project.update({ where: { id: projectId }, data: { currentPhase: "requirements" } });
    const started = await runs.startRequirementsRun({
      projectId, actorId: ownerId, operation: WorkflowOperation.INITIAL_GENERATION,
      idempotencyKey: "initial-current", brief: "No competing artifact",
    });

    await expect(runs.assertRequirementsRunCurrent(projectId, started.run.id, ownerId)).resolves.toMatchObject({
      id: started.run.id,
      status: "running",
    });
    await runs.cancelRequirementsRun(projectId, started.run.id);
  });

  test("initial-generation currentness rejects a manually created v1 without moving artifact or approval pointers", async () => {
    const projectId = await project();
    await prisma.project.update({ where: { id: projectId }, data: { currentPhase: "requirements" } });
    const started = await runs.startRequirementsRun({
      projectId, actorId: ownerId, operation: WorkflowOperation.INITIAL_GENERATION,
      idempotencyKey: "initial-manual-race", brief: "AI draft in progress",
    });
    await expect(prisma.projectPhaseState.findUniqueOrThrow({
      where: { projectId_phase: { projectId, phase: "requirements" } },
    })).resolves.toMatchObject({ activeRunId: started.run.id, currentArtifactId: null });

    const manualV1 = await artifacts.createInitialArtifact({
      projectId,
      actorId: ownerId,
      title: "Manual Requirements v1",
      structuredContent: requirements("manual-v1"),
    });
    const beforeAssertion = await prisma.projectPhaseState.findUniqueOrThrow({
      where: { projectId_phase: { projectId, phase: "requirements" } },
    });
    expect(beforeAssertion).toMatchObject({
      activeRunId: started.run.id,
      currentArtifactId: manualV1.id,
      approvalCandidateArtifactId: null,
      currentApprovedArtifactId: null,
    });

    await expect(runs.assertRequirementsRunCurrent(projectId, started.run.id, ownerId)).rejects.toMatchObject({
      code: "PLANNING_CONTEXT_CHANGED",
      httpStatus: 409,
      details: { runId: started.run.id, currentArtifactId: manualV1.id },
    });
    await expect(prisma.projectPhaseState.findUniqueOrThrow({
      where: { projectId_phase: { projectId, phase: "requirements" } },
    })).resolves.toMatchObject({
      activeRunId: started.run.id,
      currentArtifactId: manualV1.id,
      approvalCandidateArtifactId: null,
      currentApprovedArtifactId: null,
    });
    await expect(prisma.workflowRun.findUniqueOrThrow({ where: { id: started.run.id } })).resolves.toMatchObject({
      status: "running",
      contextHash: started.run.contextHash,
    });
    await runs.markRequirementsRunConflicted(projectId, started.run.id, {
      code: "PLANNING_CONTEXT_CHANGED",
      message: "Manual Requirements v1 became current during initial generation.",
    });
  });

  test.each(["completed", "conflicted"] as const)("%s terminal transition releases the active lease", async (terminal) => {
    const projectId = await project();
    const started = await runs.startRequirementsRun({
      projectId, actorId: ownerId, operation: WorkflowOperation.INITIAL_GENERATION,
      idempotencyKey: terminal, brief: `Run ${terminal}`,
    });
    if (terminal === "completed") await runs.completeRequirementsRun(projectId, started.run.id);
    else await runs.markRequirementsRunConflicted(projectId, started.run.id, { code: "TEST_CONFLICT", message: "Simulated." });
    await expect(prisma.projectPhaseState.findUniqueOrThrow({
      where: { projectId_phase: { projectId, phase: "requirements" } },
    })).resolves.toMatchObject({ activeRunId: null });
  });

  test("authorization occurs before lease acquisition and admin read authority does not grant generation authority", async () => {
    const projectId = await project();
    for (const actorId of [outsiderId, adminId]) {
      await expect(runs.startRequirementsRun({
        projectId, actorId, operation: WorkflowOperation.INITIAL_GENERATION,
        idempotencyKey: actorId, brief: "Unauthorized",
      })).rejects.toMatchObject({ code: "PLANNING_PROJECT_NOT_FOUND", httpStatus: 404 });
    }
    expect(await prisma.workflowRun.count({ where: { projectId } })).toBe(0);
    expect(await prisma.projectPhaseState.findUnique({ where: { projectId_phase: { projectId, phase: "requirements" } } })).toBeNull();
  });

  test("project member may initiate and cross-project run lookup is non-disclosing", async () => {
    const projectId = await project(ownerId, true);
    const otherProjectId = await project();
    const started = await runs.startRequirementsRun({
      projectId, actorId: memberId, operation: WorkflowOperation.INITIAL_GENERATION,
      idempotencyKey: "member", brief: "Member brief",
    });
    await expect(runs.getRequirementsRun(otherProjectId, started.run.id, ownerId)).rejects.toMatchObject({
      code: "PLANNING_PROJECT_NOT_FOUND", httpStatus: 404,
    });
    await runs.cancelRequirementsRun(projectId, started.run.id);
  });

  test("oversized UTF-8 brief is rejected before a run or phase state is created", async () => {
    const projectId = await project();
    const brief = "é".repeat(Math.floor(REQUIREMENTS_INPUT_LIMITS.briefOrFeedbackBytes / 2) + 1);
    await expect(runs.startRequirementsRun({
      projectId, actorId: ownerId, operation: WorkflowOperation.INITIAL_GENERATION,
      idempotencyKey: "oversized", brief,
    })).rejects.toMatchObject({ code: "PLANNING_INPUT_TOO_LARGE", httpStatus: 413 });
    expect(await prisma.workflowRun.count({ where: { projectId } })).toBe(0);
    expect(await prisma.projectPhaseState.findUnique({ where: { projectId_phase: { projectId, phase: "requirements" } } })).toBeNull();
  });

  test("revision run binds exact Requirements v3 ID/version/hash and captures target section", async () => {
    const projectId = await project();
    const v1 = await artifacts.createInitialArtifact({ projectId, actorId: ownerId, title: "v1", structuredContent: requirements("v1") });
    const v2 = await artifacts.createManualRevision({ projectId, actorId: ownerId, title: "v2", structuredContent: requirements("v2"), baseArtifactId: v1.id, baseContentHash: v1.contentHash! });
    const v3 = await artifacts.createManualRevision({ projectId, actorId: ownerId, title: "v3", structuredContent: requirements("v3"), baseArtifactId: v2.id, baseContentHash: v2.contentHash! });
    const count = await prisma.phaseArtifact.count({ where: { projectId } });
    const started = await runs.startRequirementsRun({
      projectId, actorId: ownerId, operation: WorkflowOperation.SECTION_REGENERATION,
      idempotencyKey: "revise-v3", baseArtifactId: v3.id,
      instruction: "Regenerate actors.", targetSectionKey: "usersAndActors",
    });
    expect((started.run.contextManifest as Record<string, unknown>).baseArtifact).toEqual({
      id: v3.id, version: 3, hash: v3.contentHash,
    });
    expect(started.run).toMatchObject({ baseArtifactId: v3.id, inputArtifactId: v3.id, targetSectionKey: "usersAndActors" });
    expect(await prisma.phaseArtifact.count({ where: { projectId } })).toBe(count);
    await runs.failRequirementsRun(projectId, started.run.id, { code: "SIMULATED", message: "Stop before 1C-C." });

    await artifacts.createManualRevision({
      projectId,
      actorId: ownerId,
      title: "v4",
      structuredContent: requirements("v4"),
      baseArtifactId: v3.id,
      baseContentHash: v3.contentHash!,
    });
    const historicalRetry = await runs.startRequirementsRun({
      projectId, actorId: ownerId, operation: WorkflowOperation.SECTION_REGENERATION,
      idempotencyKey: "revise-v3", baseArtifactId: v3.id,
      instruction: "Regenerate actors.", targetSectionKey: "usersAndActors",
    });
    expect(historicalRetry).toMatchObject({ reused: true, run: { id: started.run.id } });
    await expect(runs.startRequirementsRun({
      projectId, actorId: ownerId, operation: WorkflowOperation.SECTION_REGENERATION,
      idempotencyKey: "revise-v3", baseArtifactId: v3.id,
      instruction: "Different instruction.", targetSectionKey: "usersAndActors",
    })).rejects.toMatchObject({ code: "PLANNING_IDEMPOTENCY_CONFLICT" });
  });

  test("a bounded next-request check recovers an abandoned running lease", async () => {
    const projectId = await project();
    const abandoned = await runs.startRequirementsRun({
      projectId, actorId: ownerId, operation: WorkflowOperation.INITIAL_GENERATION,
      idempotencyKey: "abandoned", brief: "Abandoned run",
    });
    await prisma.workflowRun.update({
      where: { id: abandoned.run.id },
      data: { startedAt: new Date("2000-01-01T00:00:00.000Z") },
    });
    const recovered = await runs.startRequirementsRun({
      projectId, actorId: ownerId, operation: WorkflowOperation.INITIAL_GENERATION,
      idempotencyKey: "recovery", brief: "Recovery run",
    });
    await expect(prisma.workflowRun.findUniqueOrThrow({ where: { id: abandoned.run.id } })).resolves.toMatchObject({
      status: "failed",
      errorCode: "PLANNING_STALE_RUN_RECOVERED",
    });
    expect(recovered.run.status).toBe("running");
    await runs.cancelRequirementsRun(projectId, recovered.run.id);
  });
});
