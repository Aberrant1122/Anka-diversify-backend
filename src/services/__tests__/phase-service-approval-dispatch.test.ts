import { PrismaClient, ProjectPhaseState } from "@prisma/client";
import { PlanningApprovalService } from "../planning-approval.service";
import { PhaseService } from "../phase-service";

const state: ProjectPhaseState = {
  id: "state-1",
  projectId: "project-1",
  phase: "requirements",
  status: "in_progress",
  startedAt: null,
  completedAt: null,
  approvedById: null,
  approvedAt: null,
  notes: null,
  currentArtifactId: "artifact-1",
  approvalCandidateArtifactId: null,
  currentApprovedArtifactId: null,
  activeRunId: null,
  stateVersion: 0,
};

describe("PhaseService approval dispatch", () => {
  const prisma = new PrismaClient();
  const phases = new PhaseService(prisma);

  afterEach(() => jest.restoreAllMocks());
  afterAll(() => prisma.$disconnect());

  test("routes Documentation operations to the dedicated lifecycle", async () => {
    const request = jest.spyOn(PlanningApprovalService.prototype, "requestDocumentationApproval").mockResolvedValue(state);
    const approve = jest.spyOn(PlanningApprovalService.prototype, "approveDocumentationArtifact").mockResolvedValue(state);
    const changes = jest.spyOn(PlanningApprovalService.prototype, "requestDocumentationChanges").mockResolvedValue(state);

    await phases.requestApproval("project-1", "documentation", "artifact-1", "hash-1", "editor-1");
    await phases.approvePhase("project-1", "documentation", "artifact-1", "hash-1", "owner-1", "Approved");
    await phases.requestChanges("project-1", "documentation", "artifact-1", "hash-1", "owner-1", "Revise");

    expect(request).toHaveBeenCalledWith({ projectId: "project-1", artifactId: "artifact-1", expectedHash: "hash-1", actorId: "editor-1" });
    expect(approve).toHaveBeenCalledWith({ projectId: "project-1", artifactId: "artifact-1", expectedHash: "hash-1", actorId: "owner-1", comments: "Approved" });
    expect(changes).toHaveBeenCalledWith({ projectId: "project-1", artifactId: "artifact-1", expectedHash: "hash-1", actorId: "owner-1", comments: "Revise" });
  });

  test("preserves Requirements and Architecture dispatch", async () => {
    const requestRequirements = jest.spyOn(PlanningApprovalService.prototype, "requestApproval").mockResolvedValue(state);
    const approveRequirements = jest.spyOn(PlanningApprovalService.prototype, "approveArtifact").mockResolvedValue(state);
    const changeRequirements = jest.spyOn(PlanningApprovalService.prototype, "requestChanges").mockResolvedValue(state);
    const requestArchitecture = jest.spyOn(PlanningApprovalService.prototype, "requestArchitectureApproval").mockResolvedValue(state);
    const approveArchitecture = jest.spyOn(PlanningApprovalService.prototype, "approveArchitectureArtifact").mockResolvedValue(state);
    const changeArchitecture = jest.spyOn(PlanningApprovalService.prototype, "requestArchitectureChanges").mockResolvedValue(state);

    await phases.requestApproval("project-1", "requirements", "artifact-1", "hash-1", "editor-1");
    await phases.approvePhase("project-1", "requirements", "artifact-1", "hash-1", "owner-1");
    await phases.requestChanges("project-1", "requirements", "artifact-1", "hash-1", "owner-1", "Revise");
    await phases.requestApproval("project-1", "architecture", "artifact-1", "hash-1", "editor-1");
    await phases.approvePhase("project-1", "architecture", "artifact-1", "hash-1", "owner-1");
    await phases.requestChanges("project-1", "architecture", "artifact-1", "hash-1", "owner-1", "Revise");

    expect(requestRequirements).toHaveBeenCalledTimes(1);
    expect(approveRequirements).toHaveBeenCalledTimes(1);
    expect(changeRequirements).toHaveBeenCalledTimes(1);
    expect(requestArchitecture).toHaveBeenCalledTimes(1);
    expect(approveArchitecture).toHaveBeenCalledTimes(1);
    expect(changeArchitecture).toHaveBeenCalledTimes(1);
  });

  test.each(["implementation", "testing", "review", "unknown"])("rejects unsupported phase %s", async (phase) => {
    const request = jest.spyOn(PlanningApprovalService.prototype, "requestApproval").mockResolvedValue(state);
    const approve = jest.spyOn(PlanningApprovalService.prototype, "approveArtifact").mockResolvedValue(state);
    const changes = jest.spyOn(PlanningApprovalService.prototype, "requestChanges").mockResolvedValue(state);
    const documentation = jest.spyOn(PlanningApprovalService.prototype, "requestDocumentationApproval").mockResolvedValue(state);
    const approveDocumentation = jest.spyOn(PlanningApprovalService.prototype, "approveDocumentationArtifact").mockResolvedValue(state);
    const changeDocumentation = jest.spyOn(PlanningApprovalService.prototype, "requestDocumentationChanges").mockResolvedValue(state);
    const architecture = jest.spyOn(PlanningApprovalService.prototype, "requestArchitectureApproval").mockResolvedValue(state);
    const approveArchitecture = jest.spyOn(PlanningApprovalService.prototype, "approveArchitectureArtifact").mockResolvedValue(state);
    const changeArchitecture = jest.spyOn(PlanningApprovalService.prototype, "requestArchitectureChanges").mockResolvedValue(state);

    await expect(phases.requestApproval("project-1", phase, "artifact-1", "hash-1", "actor-1"))
      .rejects.toMatchObject({ code: "PLANNING_INVALID_PHASE", httpStatus: 422 });
    await expect(phases.approvePhase("project-1", phase, "artifact-1", "hash-1", "actor-1"))
      .rejects.toMatchObject({ code: "PLANNING_INVALID_PHASE", httpStatus: 422 });
    await expect(phases.requestChanges("project-1", phase, "artifact-1", "hash-1", "actor-1", "Revise"))
      .rejects.toMatchObject({ code: "PLANNING_INVALID_PHASE", httpStatus: 422 });
    expect([
      request, approve, changes,
      documentation, approveDocumentation, changeDocumentation,
      architecture, approveArchitecture, changeArchitecture,
    ].every((handler) => handler.mock.calls.length === 0)).toBe(true);
  });
});
