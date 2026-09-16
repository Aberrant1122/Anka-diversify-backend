import { GitHubApiError, type GitHubErrorCode, parseGithubUrl, ProjectGitHubService } from "../github.service";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

function response(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response;
}

describe("GitHub pull request integration", () => {
  test("uses one canonical parser for supported repository URLs", () => {
    expect(parseGithubUrl("github.com/owner/repo")).toEqual({ owner: "owner", repo: "repo" });
    expect(parseGithubUrl("https://github.com/owner/repo.git")).toEqual({ owner: "owner", repo: "repo" });
    expect(parseGithubUrl("git@github.com:owner/repo.git")).toEqual({ owner: "owner", repo: "repo" });
    expect(parseGithubUrl("https://example.com/owner/repo")).toBeNull();
  });

  test("normalizes open pull request payloads", async () => {
    global.fetch = jest.fn().mockResolvedValue(response(200, [{
      number: 42,
      title: "Fix project task rendering",
      user: { login: "anka-dev" },
      state: "open",
      created_at: "2026-09-10T00:00:00Z",
      updated_at: "2026-09-15T00:00:00Z",
      html_url: "https://github.com/owner/repo/pull/42",
      draft: false,
      labels: [{ name: "bug" }],
      base: { ref: "main" },
      head: { ref: "feature/tasks" },
    }])) as typeof fetch;

    const result = await ProjectGitHubService.listPullRequests("https://github.com/owner/repo");
    expect(result).toEqual([expect.objectContaining({
      number: 42,
      title: "Fix project task rendering",
      author: "anka-dev",
      url: "https://github.com/owner/repo/pull/42",
      baseBranch: "main",
      headBranch: "feature/tasks",
      draft: false,
    })]);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/owner/repo/pulls?state=open&per_page=20",
      expect.any(Object),
    );
  });

  test("returns an empty list when GitHub has no open pull requests", async () => {
    global.fetch = jest.fn().mockResolvedValue(response(200, [])) as typeof fetch;
    await expect(ProjectGitHubService.listPullRequests("https://github.com/owner/repo")).resolves.toEqual([]);
  });

  test("rejects malformed repository URLs before making a request", async () => {
    global.fetch = jest.fn() as typeof fetch;
    await expect(ProjectGitHubService.listPullRequests("not a repository")).rejects.toThrow("Invalid GitHub URL");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test.each([
    [401, {}, "GITHUB_AUTH_MISSING", 401],
    [403, { message: "API rate limit exceeded" }, "GITHUB_RATE_LIMITED", 429],
    [404, {}, "GITHUB_REPOSITORY_NOT_FOUND", 404],
    [500, {}, "GITHUB_UNAVAILABLE", 502],
  ])("maps GitHub status %i to a typed error", async (status, body, code, mappedStatus) => {
    global.fetch = jest.fn().mockResolvedValue(response(status as number, body)) as typeof fetch;
    await expect(ProjectGitHubService.listPullRequests("https://github.com/owner/repo")).rejects.toMatchObject<Partial<GitHubApiError>>({
      code: code as GitHubErrorCode,
      status: mappedStatus,
    });
  });

  test("maps network failures without leaking transport details", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("socket secret")) as typeof fetch;
    await expect(ProjectGitHubService.listPullRequests("https://github.com/owner/repo")).rejects.toMatchObject({
      code: "GITHUB_NETWORK_ERROR",
      status: 502,
      message: "Unable to reach GitHub.",
    });
  });
});
