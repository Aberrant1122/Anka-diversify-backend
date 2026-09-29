import crypto from "crypto";
import { PhaseArtifact, PrismaClient } from "@prisma/client";
import { RequirementsContent } from "../../planning/requirements-schema";
import { PhaseService } from "../phase-service";
import { PlanningApprovalService } from "../planning-approval.service";
import { PlanningArtifactService } from "../planning-artifact.service";
import { PlanningReadinessService, RequirementsReadiness } from "../planning-readiness.service";

const databaseUrl = process.env.DATABASE_URL;
const isolatedSchema = databaseUrl ? new URL(databaseUrl).searchParams.get("schema") : null;
if (!isolatedSchema?.startsWith("planning_checkpoint_1c_a_")) {
  throw new Error(
    "planning-requirements-readiness-lifecycle.test.ts requires an isolated planning_checkpoint_1c_a_* PostgreSQL schema",
  );
}

const prisma = new PrismaClient();
const artifactService = new PlanningArtifactService(prisma);
const readinessService = new PlanningReadinessService();
const approvalService = new PlanningApprovalService(prisma, undefined, undefined, readinessService);
const phaseService = new PhaseService(prisma);
const ownerId = `checkpoint-1c-a-owner-${crypto.randomUUID()}`;
const outsiderId = `checkpoint-1c-a-outsider-${crypto.randomUUID()}`;
const projectIds: string[] = [];

function requirements(label: string, unresolvedQuestionIds: string[] = []): RequirementsContent {
  const suffix = label.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const functionalRequirementId = `FR-${suffix}`;
  const acceptanceCriterionId = `AC-${suffix}`;
  return {
    projectGoal: `Deliver ${label}`,
    problemStatement: `${label} needs deterministic Requirements readiness.`,
    usersAndActors: [{ id: `ACTOR-${suffix}`, name: "Project owner", description: "Owns approval." }],
    userStories: [{
      id: `US-${suffix}`,
      actor: "Project owner",
      capability: `review ${label}`,
      benefit: "approval is safe",
      acceptanceCriteriaIds: [acceptanceCriterionId],
    }],
    functionalRequirements: [{
      id: functionalRequirementId,
      title: `Approve ${label}`,
      description: `The system evaluates ${label} readiness.`,
    }],
    nonFunctionalRequirements: [{
      id: `NFR-${suffix}`,
      title: "Determinism",
      description: "Readiness uses deterministic backend rules.",
    }],
    constraints: [],
    integrations: [],
    assumptions: [],
    acceptanceCriteria: [{
      id: acceptanceCriterionId,
      description: `${label} is approval-ready only without blockers.`,
      relatedRequirementIds: [functionalRequirementId],
    }],
    outOfScope: [],
    unresolvedQuestions: unresolvedQuestionIds.map((id) => ({ id, question: `Resolve ${id}.` })),
  };
}

function hashOf(artifact: PhaseArtifact): string {
  if (!artifact.contentHash) throw new Error(`Artifact ${artifact.id} is missing its content hash`);
  return artifact.contentHash;
}

async function createProject(): Promise<string> {
  const id = `checkpoint-1c-a-project-${crypto.randomUUID()}`;
  await prisma.project.create({ data: { id, name: "Checkpoint 1C-A", userId: ownerId } });
  projectIds.push(id);
  return id;
}

async function createInitial(projectId: string, content: RequirementsContent): Promise<PhaseArtifact> {
  return artifactService.createInitialArtifact({
    projectId,
    actorId: ownerId,
    title: "Requirements v1",
    structuredContent: content,
  });
}

async function revise(projectId: string, base: PhaseArtifact, version: number, content: RequirementsContent): Promise<PhaseArtifact> {
  return artifactService.createManualRevision({
    projectId,
    actorId: ownerId,
    title: `Requirements v${version}`,
    baseArtifactId: base.id,
    baseContentHash: hashOf(base),
    structuredContent: content,
  });
}

beforeAll(async () => {
  await prisma.user.createMany({
    data: [
      { id: ownerId, email: `${ownerId}@anka.test`, password: "unused", role: "user" },
      { id: outsiderId, email: `${outsiderId}@anka.test`, password: "unused", role: "user" },
    ],
  });
});

afterAll(async () => {
  for (const projectId of projectIds.reverse()) {
    await prisma.project.delete({ where: { id: projectId } });
  }
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, outsiderId] } } });
  await prisma.$disconnect();
});

describe("Checkpoint 1C-A Requirements readiness lifecycle", () => {
  test("blocked v3 remains unchanged until a complete v4 is submitted and approved", async () => {
    const projectId = await createProject();
    const v1 = await createInitial(projectId, requirements("v1"));
    const v2 = await revise(projectId, v1, 2, requirements("v2"));
    const v3 = await revise(projectId, v2, 3, requirements("v3", ["UQ-001"]));
    const originalV3 = await prisma.phaseArtifact.findUniqueOrThrow({ where: { id: v3.id } });

    const v3Readiness = readinessService.evaluateRequirements({ artifact: v3, expectedHash: hashOf(v3) });
    expect(v3Readiness).toMatchObject({
      ready: false,
      blockers: [expect.objectContaining({
        code: "REQUIREMENTS_UNRESOLVED_QUESTIONS",
        itemIds: ["UQ-001"],
      })],
    });

    await expect(approvalService.requestApproval({
      projectId,
      phase: "requirements",
      artifactId: v3.id,
      expectedHash: hashOf(v3),
      actorId: ownerId,
    })).rejects.toMatchObject({
      code: "PLANNING_READINESS_BLOCKED",
      httpStatus: 422,
      details: expect.objectContaining({
        artifactId: v3.id,
        blockers: [expect.objectContaining({ code: "REQUIREMENTS_UNRESOLVED_QUESTIONS" })],
      }),
    });

    await expect(prisma.projectPhaseState.findUniqueOrThrow({
      where: { projectId_phase: { projectId, phase: "requirements" } },
    })).resolves.toMatchObject({
      status: "in_progress",
      currentArtifactId: v3.id,
      approvalCandidateArtifactId: null,
    });
    await expect(prisma.phaseArtifact.findUniqueOrThrow({ where: { id: v3.id } })).resolves.toEqual(originalV3);

    const v4 = await revise(projectId, v3, 4, requirements("v4"));
    expect(readinessService.evaluateRequirements({ artifact: v4, expectedHash: hashOf(v4) }).ready).toBe(true);

    const submitted = await approvalService.requestApproval({
      projectId,
      phase: "requirements",
      artifactId: v4.id,
      expectedHash: hashOf(v4),
      actorId: ownerId,
    });
    expect(submitted).toMatchObject({ status: "awaiting_approval", approvalCandidateArtifactId: v4.id });

    const approved = await approvalService.approveArtifact({
      projectId,
      phase: "requirements",
      artifactId: v4.id,
      expectedHash: hashOf(v4),
      actorId: ownerId,
    });
    expect(approved).toMatchObject({ status: "approved", currentApprovedArtifactId: v4.id });
    await expect(prisma.projectPhaseState.findUniqueOrThrow({
      where: { projectId_phase: { projectId, phase: "documentation" } },
    })).resolves.toMatchObject({ status: "not_started", currentArtifactId: null });
    await expect(prisma.workflowRun.count({ where: { projectId } })).resolves.toBe(0);

    const versions = await prisma.phaseArtifact.findMany({
      where: { projectId, phase: "requirements", type: "requirements_doc" },
      orderBy: { version: "asc" },
      select: { id: true, version: true, previousVersionId: true },
    });
    expect(versions).toEqual([
      { id: v1.id, version: 1, previousVersionId: null },
      { id: v2.id, version: 2, previousVersionId: v1.id },
      { id: v3.id, version: 3, previousVersionId: v2.id },
      { id: v4.id, version: 4, previousVersionId: v3.id },
    ]);
  });

  test("final owner approval independently reruns readiness and fails without downstream effects", async () => {
    const projectId = await createProject();
    const artifact = await createInitial(projectId, requirements("final-recheck"));
    const ready = readinessService.evaluateRequirements({ artifact, expectedHash: hashOf(artifact) });
    const blocked: RequirementsReadiness = {
      ...ready,
      ready: false,
      blockers: [{
        code: "REQUIREMENTS_UNRESOLVED_QUESTIONS",
        path: "unresolvedQuestions",
        message: "Resolve, remove, or explicitly reclassify all unresolved questions before approval.",
        itemIds: ["UQ-LATE"],
      }],
    };
    const recheckingReadiness = new PlanningReadinessService();
    const evaluate = jest.spyOn(recheckingReadiness, "evaluateRequirements")
      .mockReturnValueOnce(ready)
      .mockReturnValueOnce(blocked);
    const guardedApproval = new PlanningApprovalService(prisma, undefined, undefined, recheckingReadiness);

    await guardedApproval.requestApproval({
      projectId,
      phase: "requirements",
      artifactId: artifact.id,
      expectedHash: hashOf(artifact),
      actorId: ownerId,
    });
    await expect(guardedApproval.approveArtifact({
      projectId,
      phase: "requirements",
      artifactId: artifact.id,
      expectedHash: hashOf(artifact),
      actorId: ownerId,
    })).rejects.toMatchObject({ code: "PLANNING_READINESS_BLOCKED", httpStatus: 422 });

    expect(evaluate).toHaveBeenCalledTimes(2);
    await expect(prisma.projectPhaseState.findUniqueOrThrow({
      where: { projectId_phase: { projectId, phase: "requirements" } },
    })).resolves.toMatchObject({
      status: "awaiting_approval",
      approvalCandidateArtifactId: artifact.id,
      currentApprovedArtifactId: null,
    });
    await expect(prisma.phaseApproval.count({ where: { projectId, decision: "approved" } })).resolves.toBe(0);
    await expect(prisma.projectPhaseState.findUnique({
      where: { projectId_phase: { projectId, phase: "documentation" } },
    })).resolves.toBeNull();
  });

  test("readiness query service applies project read authorization and optional exact hash", async () => {
    const projectId = await createProject();
    const artifact = await createInitial(projectId, requirements("query"));

    await expect(phaseService.getRequirementsReadiness(
      projectId,
      artifact.id,
      outsiderId,
      hashOf(artifact),
    )).rejects.toMatchObject({ code: "PLANNING_PROJECT_NOT_FOUND", httpStatus: 404 });

    await expect(phaseService.getRequirementsReadiness(
      projectId,
      artifact.id,
      ownerId,
      hashOf(artifact),
    )).resolves.toMatchObject({ ready: true, artifactId: artifact.id, contentHash: hashOf(artifact) });
  });
});
