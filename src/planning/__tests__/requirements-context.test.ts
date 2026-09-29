import { PrismaClient, WorkflowOperation } from "@prisma/client";
import { PlanningRequirementsContextBuilder } from "../requirements-context";
import { REQUIREMENTS_INPUT_LIMITS } from "../requirements-run-config";
import { RequirementsContent } from "../requirements-schema";

const content: RequirementsContent = {
  projectGoal: "Build an auditable planner",
  problemStatement: "Planning inputs need deterministic provenance.",
  usersAndActors: [{ id: "actor-owner", name: "Owner", description: "Owns planning." }],
  userStories: [{ id: "story-1", actor: "Owner", capability: "prepare requirements", benefit: "scope is reviewable", acceptanceCriteriaIds: ["ac-1"] }],
  functionalRequirements: [{ id: "fr-1", title: "Prepare", description: "Prepare a run." }],
  nonFunctionalRequirements: [{ id: "nfr-1", title: "Audit", description: "Retain provenance." }],
  constraints: [{ id: "constraint-1", description: "Do not call an LLM." }],
  integrations: [],
  assumptions: [],
  acceptanceCriteria: [{ id: "ac-1", description: "Run is recorded.", relatedRequirementIds: ["fr-1"] }],
  outOfScope: [{ id: "out-1", description: "Documentation generation." }],
  unresolvedQuestions: [],
};

function prismaMock(includeMemory = false): {
  prisma: PrismaClient;
  projectFind: jest.Mock;
  artifactFind: jest.Mock;
  stateFind: jest.Mock;
} {
  const projectFind = jest.fn().mockResolvedValue({
    id: "project-1",
    name: "Safe project",
    description: "Mutable description is metadata, not the submitted brief.",
    currentPhase: "requirements",
    githubToken: "must-never-appear",
    memorySummary: includeMemory ? {
      id: "memory-1",
      version: 2,
      lastUpdated: new Date("2026-09-27T00:00:00.000Z"),
      summary: "Advisory memory only.",
    } : null,
  });
  const artifactFind = jest.fn().mockResolvedValue({
    id: "artifact-v3",
    projectId: "project-1",
    phase: "requirements",
    type: "requirements_doc",
    version: 3,
    contentHash: "hash-v3",
    structuredContent: content,
  });
  const stateFind = jest.fn().mockResolvedValue({ currentArtifactId: "artifact-v3" });
  const prisma = {
    project: { findUnique: projectFind },
    phaseArtifact: { findUnique: artifactFind },
    projectPhaseState: { findUnique: stateFind },
  } as unknown as PrismaClient;
  return { prisma, projectFind, artifactFind, stateFind };
}

describe("PlanningRequirementsContextBuilder", () => {
  test("persists the exact normalized submitted brief and hashes identical normalized context deterministically", async () => {
    const first = new PlanningRequirementsContextBuilder(prismaMock().prisma);
    const second = new PlanningRequirementsContextBuilder(prismaMock().prisma);
    const a = await first.buildInitial({ projectId: "project-1", actorId: "owner-1", brief: "  Line one\r\nLine two  " });
    const b = await second.buildInitial({ projectId: "project-1", actorId: "owner-1", brief: "Line one\nLine two" });

    expect(a.manifest.brief).toMatchObject({
      normalizedText: "Line one\nLine two",
      source: "submitted_brief",
      byteLength: Buffer.byteLength("Line one\nLine two", "utf8"),
    });
    expect(a.contextHash).toBe(b.contextHash);
    expect(a.manifest.contextHash).toBe(a.contextHash);
  });

  test("changed brief changes the deterministic context hash and project description is never substituted for it", async () => {
    const builder = new PlanningRequirementsContextBuilder(prismaMock().prisma);
    const first = await builder.buildInitial({ projectId: "project-1", actorId: "owner-1", brief: "Submitted brief A" });
    const second = await builder.buildInitial({ projectId: "project-1", actorId: "owner-1", brief: "Submitted brief B" });
    expect(first.contextHash).not.toBe(second.contextHash);
    expect(first.payload.brief).toBe("Submitted brief A");
    expect(first.payload.brief).not.toBe(first.payload.project.description);
  });

  test("excludes memory by default and includes only explicitly requested bounded memory", async () => {
    const without = await new PlanningRequirementsContextBuilder(prismaMock(true).prisma).buildInitial({
      projectId: "project-1",
      actorId: "owner-1",
      brief: "Brief",
    });
    const withMemoryMock = prismaMock(true);
    const withMemory = await new PlanningRequirementsContextBuilder(withMemoryMock.prisma).buildInitial({
      projectId: "project-1",
      actorId: "owner-1",
      brief: "Brief",
      includeMemory: true,
    });
    expect(without.manifest).not.toHaveProperty("memory");
    expect(withMemory.manifest.memory).toMatchObject({ id: "memory-1", version: 2, summary: "Advisory memory only." });
    expect(withMemoryMock.projectFind).toHaveBeenCalledWith(expect.objectContaining({
      select: expect.objectContaining({ memorySummary: expect.any(Object) }),
    }));
  });

  test("rejects oversized UTF-8 brief before any database/context acquisition", async () => {
    const mock = prismaMock();
    const oversized = "é".repeat(Math.floor(REQUIREMENTS_INPUT_LIMITS.briefOrFeedbackBytes / 2) + 1);
    await expect(new PlanningRequirementsContextBuilder(mock.prisma).buildInitial({
      projectId: "project-1",
      actorId: "owner-1",
      brief: oversized,
    })).rejects.toMatchObject({ code: "PLANNING_INPUT_TOO_LARGE", httpStatus: 413 });
    expect(mock.projectFind).not.toHaveBeenCalled();
  });

  test("revision records exact v3 authority and target section with canonical content", async () => {
    const mock = prismaMock(true);
    const result = await new PlanningRequirementsContextBuilder(mock.prisma).buildRevision({
      projectId: "project-1",
      actorId: "owner-1",
      operation: WorkflowOperation.SECTION_REVISION,
      baseArtifactId: "artifact-v3",
      instruction: "Revise the actors.",
      targetSectionKey: "usersAndActors",
    });
    expect(result.manifest.baseArtifact).toEqual({ id: "artifact-v3", version: 3, hash: "hash-v3" });
    expect(result.manifest.targetSectionKey).toBe("usersAndActors");
    expect(result.manifest.allowedSectionKeys).toEqual(["usersAndActors", "userStories"]);
    expect(result.payload.allowedSectionKeys).toEqual(["usersAndActors", "userStories"]);
    expect(result.payload.versions.prompt).toBe("requirements-section-revision-v1");
    expect(result.payload.baseArtifact.content).toEqual(content);
    expect(result.manifest).not.toHaveProperty("memory");
  });

  test("section target and closure change the deterministic context hash", async () => {
    const builder = new PlanningRequirementsContextBuilder(prismaMock().prisma);
    const actors = await builder.buildRevision({
      projectId: "project-1", actorId: "owner-1", operation: WorkflowOperation.SECTION_REVISION,
      baseArtifactId: "artifact-v3", instruction: "Revise.", targetSectionKey: "usersAndActors",
    });
    const constraints = await builder.buildRevision({
      projectId: "project-1", actorId: "owner-1", operation: WorkflowOperation.SECTION_REVISION,
      baseArtifactId: "artifact-v3", instruction: "Revise.", targetSectionKey: "constraints",
    });
    expect(actors.contextHash).not.toBe(constraints.contextHash);
    expect(constraints.manifest.allowedSectionKeys).toEqual(["constraints"]);
  });

  test.each([undefined, null, "", "unknown"])("rejects invalid section target %p before database reads", async (targetSectionKey) => {
    const mock = prismaMock();
    await expect(new PlanningRequirementsContextBuilder(mock.prisma).buildRevision({
      projectId: "project-1", actorId: "owner-1", operation: WorkflowOperation.SECTION_REGENERATION,
      baseArtifactId: "artifact-v3", instruction: "Regenerate.", targetSectionKey,
    })).rejects.toMatchObject({ code: "PLANNING_INVALID_SECTION", httpStatus: 422 });
    expect(mock.projectFind).not.toHaveBeenCalled();
    expect(mock.artifactFind).not.toHaveBeenCalled();
  });

  test("manifest and payload exclude unrelated artifacts, decisions, credentials, chats, tasks, and repository context", async () => {
    const mock = prismaMock();
    const result = await new PlanningRequirementsContextBuilder(mock.prisma).buildInitial({
      projectId: "project-1",
      actorId: "owner-1",
      brief: "Explicit authority",
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("must-never-appear");
    expect(serialized).not.toMatch(/ProjectDecision|documentation|architecture|githubToken|chat|tasks|repository/i);
    expect(mock.projectFind).toHaveBeenCalledWith({
      where: { id: "project-1" },
      select: { id: true, name: true, description: true, currentPhase: true, memorySummary: false },
    });
  });
});
