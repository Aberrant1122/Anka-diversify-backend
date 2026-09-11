import {
  CiStatus,
  CodeReviewMetadata,
  CodeReviewProvider,
  CodeReviewRequest,
} from "./code-review-provider";

export interface ReviewHttpResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export type ReviewHttpTransport = (
  url: string,
  init: { readonly method: string; readonly headers: Readonly<Record<string, string>>; readonly body?: string },
) => Promise<ReviewHttpResponse>;

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

export class GitHubCodeReviewProvider implements CodeReviewProvider {
  public readonly type = "GITHUB" as const;

  constructor(
    private readonly owner: string,
    private readonly repository: string,
    private readonly token: () => string | undefined,
    private readonly transport: ReviewHttpTransport = (url, init) => fetch(url, init),
  ) {
    if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repository)) {
      throw new Error("Invalid GitHub repository identity");
    }
  }

  public async findExistingReview(request: CodeReviewRequest): Promise<CodeReviewMetadata | null> {
    const query = new URLSearchParams({ state: "open", head: `${this.owner}:${request.sourceBranch}`, base: request.targetBranch });
    const data = await this.request(`/pulls?${query.toString()}`, "GET");
    const item = Array.isArray(data) ? record(data[0]) : {};
    return item.number === undefined ? null : this.metadata(item, request);
  }

  public async createReview(request: CodeReviewRequest): Promise<CodeReviewMetadata> {
    const data = record(await this.request("/pulls", "POST", {
      title: request.title,
      head: request.sourceBranch,
      base: request.targetBranch,
      body: request.body,
    }));
    if (data.number === undefined) throw new Error("REVIEW_CREATE_FAILED: GitHub response omitted pull request identity");
    return this.metadata(data, request);
  }

  public async queryCiStatus(commitSha: string): Promise<CiStatus> {
    const data = record(await this.request(`/commits/${encodeURIComponent(commitSha)}/status`, "GET"));
    if (data.state === "success") return "PASSED";
    if (data.state === "failure" || data.state === "error") return "FAILED";
    if (data.state === "pending") return "PENDING";
    return "UNKNOWN";
  }

  private metadata(data: Record<string, unknown>, request: CodeReviewRequest): CodeReviewMetadata {
    return Object.freeze({
      provider: this.type,
      reviewId: String(data.number),
      reviewUrl: typeof data.html_url === "string" ? data.html_url : "",
      sourceBranch: request.sourceBranch,
      targetBranch: request.targetBranch,
    });
  }

  private async request(path: string, method: string, body?: unknown): Promise<unknown> {
    const token = this.token();
    if (!token) throw new Error("REVIEW_PROVIDER_UNAVAILABLE: GitHub credentials are unavailable");
    const response = await this.transport(`https://api.github.com/repos/${this.owner}/${this.repository}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`REVIEW_CREATE_FAILED: GitHub API returned status ${response.status}`);
    return response.json();
  }
}

