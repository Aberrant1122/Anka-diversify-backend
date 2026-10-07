import { Request, Response } from "express";
import { AiController } from "../../controllers/ai-controller";
import { MultiRepoAuthorityConflictError, MultiRepoAuthorityConflictResult, MultiRepoCoordinator } from "../coordination/MultiRepoCoordinator";
import { PlanningDomainError } from "../../planning/planning-errors";
import { currentImplementationAuthority } from "../../planning/implementation-authority-preflight";
import { GitWorktreeService } from "../../services/git-worktree.service";

jest.mock("../../planning/implementation-authority-preflight", () => ({
  currentImplementationAuthority: jest.fn().mockResolvedValue({ fingerprint: "fixture" }),
  assertImplementationAuthorityCurrent: jest.fn().mockResolvedValue({ fingerprint: "fixture" }),
}));

const preflight = jest.mocked(currentImplementationAuthority);
const partialResult: MultiRepoAuthorityConflictResult = {
  planId: "plan-1", overallStatus: "AUTHORITY_CONFLICT", authorityCurrent: false,
  failedRepositoryId: "repo-web", changes: [],
  results: [
    { repositoryId: "repo-api", repositoryName: "API", role: "backend", status: "SUCCESS", changes: [],
      buildVerified: true, validationPassed: true, validationCommands: [], runId: "run-1",
      observedChangedFiles: ["src/api.ts"], sideEffects: { status: "UNKNOWN" } },
    { repositoryId: "repo-web", repositoryName: "Web", role: "frontend", status: "REJECTED", changes: [],
      buildVerified: false, validationPassed: false, validationCommands: [], sideEffects: { status: "NOT_EXECUTED" } },
  ],
};

function response() {
  const result = {
    headersSent: false,
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    setHeader: jest.fn(),
    flushHeaders: jest.fn(),
    write: jest.fn(),
    end: jest.fn(),
  };
  result.flushHeaders.mockImplementation(() => { result.headersSent = true; });
  return result;
}

function request(stream: boolean, actor = "actor"): Request {
  return { user: { userId: actor }, params: { projectId: "project" }, body: { message: "Implement" },
    headers: { accept: stream ? "text/event-stream" : "application/json" }, query: {} } as unknown as Request;
}

describe("multi-repository authority conflict response", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    preflight.mockReset();
    preflight.mockResolvedValue({ fingerprint: "fixture" } as Awaited<ReturnType<typeof currentImplementationAuthority>>);
  });

  test("HTTP 409 exposes the partial result without a success envelope", async () => {
    jest.spyOn(MultiRepoCoordinator.prototype, "coordinateTask").mockRejectedValue(
      new MultiRepoAuthorityConflictError(new PlanningDomainError("PLANNING_CONTEXT_CHANGED", "Authority changed", 409), partialResult));
    const res = response();
    await new AiController().runMultiRepoAgent(request(false), res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({ error: "PLANNING_CONTEXT_CHANGED", message: "Authority changed", partialResult });
  });

  test("streaming error event includes the same partial result", async () => {
    jest.spyOn(MultiRepoCoordinator.prototype, "coordinateTask").mockRejectedValue(
      new MultiRepoAuthorityConflictError(new PlanningDomainError("PLANNING_CONTEXT_CHANGED", "Authority changed", 409), partialResult));
    const res = response();
    await new AiController().runMultiRepoAgent(request(true), res as unknown as Response);
    expect(res.write).toHaveBeenCalledWith(`event: error\ndata: ${JSON.stringify({
      error: "PLANNING_CONTEXT_CHANGED", message: "Authority changed", partialResult,
    })}\n\n`);
    expect(res.end).toHaveBeenCalledTimes(1);
  });

  test("unauthorized preflight exposes no execution information", async () => {
    preflight.mockRejectedValue(new PlanningDomainError("PLANNING_PROJECT_NOT_FOUND", "Project was not found or is not accessible.", 404));
    const coordinate = jest.spyOn(MultiRepoCoordinator.prototype, "coordinateTask");
    const res = response();
    await new AiController().runMultiRepoAgent(request(false, "outsider"), res as unknown as Response);
    expect(coordinate).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: "PLANNING_PROJECT_NOT_FOUND",
      message: "Project was not found or is not accessible." });
  });

  test("agent push rejects a foreign project approval before Git shipping", async () => {
    const approvalId = "foreign-project-approval";
    const pending = (GitWorktreeService as any).pendingShippingApprovals as Map<string, unknown>;
    pending.set(approvalId, {
      userId: "actor", projectId: "project-b", repositoryId: "repo-b", state: "AVAILABLE",
      approval: { approvalId, expiresAt: new Date(Date.now() + 60_000).toISOString() },
    });
    const ship = jest.spyOn(GitWorktreeService, "shipApprovedRun");
    try {
      const req = request(false);
      req.params.projectId = "project-a";
      req.body = { approvalId, commitMessage: "Do not ship", changes: [{ path: "src/a.ts", content: "safe" }] };
      const res = response();
      await new AiController().pushAgentChanges(req, res as unknown as Response);
      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: "GIT_APPROVAL_NOT_FOUND", message: "Approval was not found in this project." });
      expect(ship).not.toHaveBeenCalled();
    } finally {
      pending.delete(approvalId);
    }
  });
});
