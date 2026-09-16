import type { Request, Response } from "express";
import { AiController } from "../ai-controller";
import { AiService } from "../../ai/application/AiService";
import { GitHubApiError, ProjectGitHubService } from "../../services/github.service";
import { ProjectSidebarService } from "../../services/project-sidebar.service";

function request(projectId = "project-1", userId: string | undefined = "user-1"): Request {
  return { params: { projectId }, user: userId ? { userId } : undefined } as unknown as Request;
}

function response() {
  const res = {
    status: jest.fn(),
    json: jest.fn(),
  };
  res.status.mockReturnValue(res);
  return res as unknown as Response & { status: jest.Mock; json: jest.Mock };
}

beforeEach(() => {
  jest.restoreAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => undefined);
  jest.spyOn(console, "info").mockImplementation(() => undefined);
});

describe("project sidebar controller", () => {
  const controller = new AiController();

  test("rejects pull-request access to another user's project", async () => {
    jest.spyOn(ProjectSidebarService, "getAccessibleProject").mockResolvedValue(null);
    const list = jest.spyOn(ProjectGitHubService, "listPullRequests");
    const res = response();

    await controller.listPullRequests(request("project-b", "user-a"), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: "PROJECT_NOT_FOUND", message: "Project not found or access denied." });
    expect(list).not.toHaveBeenCalled();
  });

  test("returns a typed error when no repository is connected", async () => {
    jest.spyOn(ProjectSidebarService, "getAccessibleProject").mockResolvedValue({ id: "project-1", githubUrl: null, githubToken: null });
    const res = response();
    await controller.listPullRequests(request(), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: "GITHUB_REPOSITORY_REQUIRED" }));
  });

  test("returns normalized pull-request envelope metadata", async () => {
    jest.spyOn(ProjectSidebarService, "getAccessibleProject").mockResolvedValue({ id: "project-1", githubUrl: "https://github.com/owner/repo", githubToken: null });
    jest.spyOn(ProjectGitHubService, "listPullRequests").mockResolvedValue([{
      number: 1,
      title: "A PR",
      author: "dev",
      state: "open",
      createdAt: "2026-09-15T00:00:00Z",
      updatedAt: "2026-09-16T00:00:00Z",
      additions: 0,
      deletions: 0,
      changedFiles: 0,
      url: "https://github.com/owner/repo/pull/1",
      draft: false,
      labels: [],
      baseBranch: "main",
      headBranch: "feature",
    }]);
    const res = response();
    await controller.listPullRequests(request(), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ pullRequests: expect.any(Array), total: 1, fetchedAt: expect.any(String) }));
  });

  test.each([
    ["GITHUB_AUTH_FAILED", 401],
    ["GITHUB_RATE_LIMITED", 429],
  ] as const)("preserves typed GitHub error %s", async (code, status) => {
    jest.spyOn(ProjectSidebarService, "getAccessibleProject").mockResolvedValue({ id: "project-1", githubUrl: "https://github.com/owner/repo", githubToken: null });
    jest.spyOn(ProjectGitHubService, "listPullRequests").mockRejectedValue(new GitHubApiError(code, status, "GitHub problem"));
    const res = response();
    await controller.listPullRequests(request(), res);
    expect(res.status).toHaveBeenCalledWith(status);
    expect(res.json).toHaveBeenCalledWith({ error: code, message: "GitHub problem" });
  });

  test("rejects health access to another user's project", async () => {
    jest.spyOn(ProjectSidebarService, "getAccessibleProject").mockResolvedValue(null);
    const health = jest.spyOn(AiService.prototype, "getProjectHealth");
    const res = response();
    await controller.getProjectHealth(request("project-b", "user-a"), res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(health).not.toHaveBeenCalled();
  });
});
