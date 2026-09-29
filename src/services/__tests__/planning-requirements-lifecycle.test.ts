import crypto from "crypto";
import { ArtifactActorType, ArtifactChangeKind, PhaseArtifact, PrismaClient } from "@prisma/client";
import { RequirementsContent } from "../../planning/requirements-schema";
import { PlanningApprovalService } from "../planning-approval.service";
import { PlanningArtifactService } from "../planning-artifact.service";

const databaseUrl = process.env.DATABASE_URL;
const isolatedSchema = databaseUrl ? new URL(databaseUrl).searchParams.get("schema") : null;
if (!isolatedSchema?.startsWith("planning_checkpoint_1b_")) {
  throw new Error(
    "planning-requirements-lifecycle.test.ts requires an isolated planning_checkpoint_1b_* PostgreSQL schema",
  );
}

const prisma = new PrismaClient();
const artifactService = new PlanningArtifactService(prisma);
const approvalService = new PlanningApprovalService(prisma);
const projectIds: string[] = [];

const ownerId = `checkpoint-1b-owner-${crypto.randomUUID()}`;
const memberId = `checkpoint-1b-member-${crypto.randomUUID()}`;
const outsiderId = `checkpoint-1b-outsider-${crypto.randomUUID()}`;
const adminId = `checkpoint-1b-admin-${crypto.randomUUID()}`;

function requirements(label: string): RequirementsContent {
  const safe = label.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const functionalId = `fr-${safe}`;
  const acceptanceId = `ac-${safe}`;
  return {
    projectGoal: `Deliver ${label}`,
    problemStatement: `The project needs ${label}.`,
    usersAndActors: [{ id: `actor-${safe}`, name: "Project owner", description: "Owns the outcome." }],
    userStories: [{
      id: `story-${safe}`,
      actor: "project owner",
      capability: `review ${label}`,
      benefit: "the scope is explicit",
      acceptanceCriteriaIds: [acceptanceId],
    }],
    functionalRequirements: [{ id: functionalId, title: `Support ${label}`, description: `The system supports ${label}.` }],
    nonFunctionalRequirements: [{ id: `nfr-${safe}`, title: "Auditability", description: "Every version remains auditable." }],
    constraints: [{ id: `constraint-${safe}`, description: "Use the existing project aggregate." }],
    integrations: [{ id: `integration-${safe}`, name: "Anka OS", description: "Uses existing project services.", required: true }],
    assumptions: [{ id: `assumption-${safe}`, description: "The project owner is known." }],
    acceptanceCriteria: [{ id: acceptanceId, description: `${label} is reviewable.`, relatedRequirementIds: [functionalId] }],
    outOfScope: [{ id: `out-${safe}`, description: "Documentation generation." }],
    unresolvedQuestions: [],
  };
}

function hashOf(artifact: PhaseArtifact): string {
  if (!artifact.contentHash) throw new Error(`Artifact ${artifact.id} is missing its content hash`);
  return artifact.contentHash;
}

async function createProject(options?: { owner?: string; member?: boolean }): Promise<string> {
  const id = `checkpoint-1b-project-${crypto.randomUUID()}`;
  await prisma.project.create({
    data: { id, name: "Checkpoint 1B Requirements", userId: options?.owner ?? ownerId },
  });
  if (options?.member) {
    await prisma.projectMember.create({ data: { projectId: id, userId: memberId } });
  }
  projectIds.push(id);
  return id;
}

async function initial(projectId: string, label = "v1", actorId = ownerId): Promise<PhaseArtifact> {
  return artifactService.createInitialArtifact({
    projectId,
    actorId,
    title: `Requirements ${label}`,
    structuredContent: requirements(label),
  });
}

async function revise(projectId: string, base: PhaseArtifact, label: string, actorId = ownerId): Promise<PhaseArtifact> {
  return artifactService.createManualRevision({
    projectId,
    actorId,
    baseArtifactId: base.id,
    baseContentHash: hashOf(base),
    title: `Requirements ${label}`,
    structuredContent: requirements(label),
  });
}

async function submit(projectId: string, artifact: PhaseArtifact, actorId = ownerId) {
  return approvalService.requestApproval({
    projectId,
    phase: "requirements",
    artifactId: artifact.id,
    expectedHash: hashOf(artifact),
    actorId,
  });
}

async function approve(projectId: string, artifact: PhaseArtifact, actorId = ownerId) {
  return approvalService.approveArtifact({
    projectId,
    phase: "requirements",
    artifactId: artifact.id,
    expectedHash: hashOf(artifact),
    actorId,
  });
}

beforeAll(async () => {
  await prisma.user.createMany({
    data: [
      { id: ownerId, email: `${ownerId}@anka.test`, password: "unused", role: "user" },
      { id: memberId, email: `${memberId}@anka.test`, password: "unused", role: "user" },
      { id: outsiderId, email: `${outsiderId}@anka.test`, password: "unused", role: "user" },
      { id: adminId, email: `${adminId}@anka.test`, password: "unused", role: "admin" },
    ],
  });
});

afterAll(async () => {
  for (const projectId of projectIds.reverse()) {
    await prisma.project.delete({ where: { id: projectId } });
  }
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, memberId, outsiderId, adminId] } } });
  await prisma.$disconnect();
});

describe("Checkpoint 1B Requirements lifecycle", () => {
  test("1. NOT_STARTED -> IN_PROGRESS when the first immutable artifact is created", async () => {
    const projectId = await createProject();
    const artifact = await initial(projectId);
    const state = await prisma.projectPhaseState.findUniqueOrThrow({
      where: { projectId_phase: { projectId, phase: "requirements" } },
    });
    expect(state).toMatchObject({ status: "in_progress", currentArtifactId: artifact.id, stateVersion: 1 });
    expect(artifact).toMatchObject({ version: 1, lifecycleStatus: "DRAFT", previousVersionId: null });
    expect(artifact.content).toContain("# Requirements\n\n## Project Goal");
  });

  test("2. IN_PROGRESS -> AWAITING_APPROVAL binds the exact current artifact", async () => {
    const projectId = await createProject();
    const artifact = await initial(projectId);
    const state = await submit(projectId, artifact);
    expect(state).toMatchObject({ status: "awaiting_approval", approvalCandidateArtifactId: artifact.id });
    await expect(prisma.phaseArtifact.findUniqueOrThrow({ where: { id: artifact.id } })).resolves.toMatchObject({
      lifecycleStatus: "AWAITING_APPROVAL",
    });
  });

  test("3. AWAITING_APPROVAL -> APPROVED records exact authority and opens Documentation as not_started", async () => {
    const projectId = await createProject();
    const artifact = await initial(projectId);
    await submit(projectId, artifact);
    const state = await approve(projectId, artifact);
    expect(state).toMatchObject({ status: "approved", currentApprovedArtifactId: artifact.id, approvalCandidateArtifactId: null });
    await expect(prisma.phaseApproval.findFirstOrThrow({ where: { artifactId: artifact.id, decision: "approved" } })).resolves.toMatchObject({
      artifactVersion: artifact.version,
      artifactContentHash: hashOf(artifact),
      approvedById: ownerId,
    });
    await expect(prisma.projectPhaseState.findUniqueOrThrow({
      where: { projectId_phase: { projectId, phase: "documentation" } },
    })).resolves.toMatchObject({ status: "not_started", currentArtifactId: null });
  });

  test("4. AWAITING_APPROVAL -> CHANGES_REQUESTED records feedback", async () => {
    const projectId = await createProject();
    const artifact = await initial(projectId);
    await submit(projectId, artifact);
    const state = await approvalService.requestChanges({
      projectId,
      phase: "requirements",
      artifactId: artifact.id,
      expectedHash: hashOf(artifact),
      actorId: ownerId,
      comments: "Clarify the actor.",
    });
    expect(state).toMatchObject({ status: "changes_requested", approvalCandidateArtifactId: null, notes: "Clarify the actor." });
  });

  test("5. CHANGES_REQUESTED -> IN_PROGRESS only by creating a revised version", async () => {
    const projectId = await createProject();
    const v1 = await initial(projectId);
    await submit(projectId, v1);
    await approvalService.requestChanges({
      projectId,
      phase: "requirements",
      artifactId: v1.id,
      expectedHash: hashOf(v1),
      actorId: ownerId,
      comments: "Revise it.",
    });
    const v2 = await revise(projectId, v1, "v2");
    await expect(prisma.projectPhaseState.findUniqueOrThrow({
      where: { projectId_phase: { projectId, phase: "requirements" } },
    })).resolves.toMatchObject({ status: "in_progress", currentArtifactId: v2.id, notes: null });
  });

  test("6. APPROVED -> IN_PROGRESS successor draft preserves approved authority", async () => {
    const projectId = await createProject();
    const approvedV1 = await initial(projectId);
    await submit(projectId, approvedV1);
    await approve(projectId, approvedV1);
    const v2 = await revise(projectId, approvedV1, "v2");
    await expect(prisma.projectPhaseState.findUniqueOrThrow({
      where: { projectId_phase: { projectId, phase: "requirements" } },
    })).resolves.toMatchObject({
      status: "in_progress",
      currentArtifactId: v2.id,
      currentApprovedArtifactId: approvedV1.id,
    });
  });

  test("7. invalid state transitions return a structured domain error", async () => {
    const projectId = await createProject();
    const artifact = await initial(projectId);
    await expect(approve(projectId, artifact)).rejects.toMatchObject({ code: "PLANNING_ACTION_LOCKED", httpStatus: 409 });
  });

  test("8. approval requires the exact artifact content hash", async () => {
    const projectId = await createProject();
    const artifact = await initial(projectId);
    await submit(projectId, artifact);
    await expect(approvalService.approveArtifact({
      projectId,
      phase: "requirements",
      artifactId: artifact.id,
      expectedHash: "incorrect-hash",
      actorId: ownerId,
    })).rejects.toMatchObject({ code: "PLANNING_ARTIFACT_HASH_MISMATCH" });
  });

  test("9. an old or non-candidate artifact cannot be approved", async () => {
    const projectId = await createProject();
    const v1 = await initial(projectId);
    const v2 = await revise(projectId, v1, "v2");
    await submit(projectId, v2);
    await expect(approve(projectId, v1)).rejects.toMatchObject({ code: "PLANNING_ARTIFACT_NOT_CURRENT" });
  });

  test("10. only the project owner can approve; membership or system admin is insufficient", async () => {
    const projectId = await createProject({ member: true });
    const artifact = await initial(projectId, "v1", memberId);
    await submit(projectId, artifact, memberId);
    await expect(approve(projectId, artifact, memberId)).rejects.toMatchObject({ code: "PLANNING_OWNER_REQUIRED", httpStatus: 403 });
    await expect(approve(projectId, artifact, adminId)).rejects.toMatchObject({ code: "PLANNING_OWNER_REQUIRED", httpStatus: 403 });
  });

  test("11. unauthorized cross-project artifact access is hidden", async () => {
    const projectId = await createProject();
    const artifact = await initial(projectId);
    await expect(artifactService.getArtifact(projectId, artifact.id, outsiderId)).rejects.toMatchObject({
      code: "PLANNING_PROJECT_NOT_FOUND",
      httpStatus: 404,
    });
  });

  test("12. Requirements v1 -> v2 -> v3 forms an immutable linear lineage", async () => {
    const projectId = await createProject();
    const v1 = await initial(projectId);
    const v2 = await artifactService.createSuccessorVersion({
      projectId,
      actorId: ownerId,
      baseArtifactId: v1.id,
      baseContentHash: hashOf(v1),
      structuredContent: requirements("v2"),
      createdByType: ArtifactActorType.AI,
      changeKind: ArtifactChangeKind.AI_SECTION_REVISION,
    });
    const v3 = await revise(projectId, v2, "v3");
    expect([v1.version, v2.version, v3.version]).toEqual([1, 2, 3]);
    expect(v2).toMatchObject({ previousVersionId: v1.id, basedOnArtifactId: v1.id });
    expect(v3).toMatchObject({ previousVersionId: v2.id, basedOnArtifactId: v2.id });
  });

  test("13. approved v3 remains authoritative after v4 is drafted", async () => {
    const projectId = await createProject();
    const v1 = await initial(projectId);
    const v2 = await revise(projectId, v1, "v2");
    const v3 = await revise(projectId, v2, "v3");
    await submit(projectId, v3);
    await approve(projectId, v3);
    const v4 = await revise(projectId, v3, "v4");
    const state = await prisma.projectPhaseState.findUniqueOrThrow({
      where: { projectId_phase: { projectId, phase: "requirements" } },
    });
    expect(state).toMatchObject({ currentArtifactId: v4.id, currentApprovedArtifactId: v3.id, status: "in_progress" });
    await expect(prisma.phaseArtifact.findUniqueOrThrow({ where: { id: v3.id } })).resolves.toMatchObject({
      lifecycleStatus: "APPROVED",
      approved: true,
    });
  });

  test("14. concurrent version allocation cannot create duplicate versions", async () => {
    const projectId = await createProject();
    const v1 = await initial(projectId);
    const operation = (label: string) => artifactService.createManualRevision({
      projectId,
      actorId: ownerId,
      baseArtifactId: v1.id,
      baseContentHash: hashOf(v1),
      structuredContent: requirements(label),
    });
    const results = await Promise.allSettled([operation("concurrent-a"), operation("concurrent-b")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const versions = await prisma.phaseArtifact.findMany({
      where: { projectId, phase: "requirements", type: "requirements_doc" },
      orderBy: { version: "asc" },
      select: { version: true },
    });
    expect(versions.map((row) => row.version)).toEqual([1, 2]);
  });

  test("15. stale baseArtifactId/baseContentHash returns a conflict", async () => {
    const projectId = await createProject();
    const v1 = await initial(projectId);
    await revise(projectId, v1, "v2");
    await expect(revise(projectId, v1, "stale-v3")).rejects.toMatchObject({
      code: "PLANNING_ARTIFACT_BASE_CHANGED",
      httpStatus: 409,
    });
  });

  test("16. request changes preserves the reviewed artifact and append-only decision history", async () => {
    const projectId = await createProject();
    const artifact = await initial(projectId);
    await submit(projectId, artifact);
    await approvalService.requestChanges({
      projectId,
      phase: "requirements",
      artifactId: artifact.id,
      expectedHash: hashOf(artifact),
      actorId: ownerId,
      comments: "Add measurable outcomes.",
    });
    await expect(prisma.phaseArtifact.findUniqueOrThrow({ where: { id: artifact.id } })).resolves.toMatchObject({
      contentHash: hashOf(artifact),
      lifecycleStatus: "DRAFT",
    });
    await expect(prisma.phaseApproval.findMany({ where: { projectId }, orderBy: { approvedAt: "asc" } })).resolves.toEqual([
      expect.objectContaining({
        artifactId: artifact.id,
        artifactContentHash: hashOf(artifact),
        decision: "changes_requested",
        comments: "Add measurable outcomes.",
      }),
    ]);
  });
});
