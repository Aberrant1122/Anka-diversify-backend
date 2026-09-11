import { CiStatus, CodeReviewMetadata, CodeReviewProvider, CodeReviewRequest } from "./code-review-provider";
import type { ReviewHttpTransport } from "./github-code-review.provider";

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

export class GitLabCodeReviewProvider implements CodeReviewProvider {
  public readonly type = "GITLAB" as const;

  constructor(
    private readonly projectIdentity: string,
    private readonly token: () => string | undefined,
    private readonly transport: ReviewHttpTransport = (url, init) => fetch(url, init),
    private readonly apiBase = "https://gitlab.com/api/v4",
  ) {
    if (!projectIdentity.trim() || /[\r\n\0]/.test(projectIdentity)) throw new Error("Invalid GitLab repository identity");
  }

  public async findExistingReview(request: CodeReviewRequest): Promise<CodeReviewMetadata | null> {
    const query = new URLSearchParams({ state: "opened", source_branch: request.sourceBranch, target_branch: request.targetBranch });
    const data = await this.request(`/merge_requests?${query.toString()}`, "GET");
    const item = Array.isArray(data) ? record(data[0]) : {};
    return item.iid === undefined ? null : this.metadata(item, request);
  }

  public async createReview(request: CodeReviewRequest): Promise<CodeReviewMetadata> {
    const data = record(await this.request("/merge_requests", "POST", {
      title: request.title,
      source_branch: request.sourceBranch,
      target_branch: request.targetBranch,
      description: request.body,
    }));
    if (data.iid === undefined) throw new Error("REVIEW_CREATE_FAILED: GitLab response omitted merge request identity");
    return this.metadata(data, request);
  }

  public async queryCiStatus(commitSha: string): Promise<CiStatus> {
    const data = await this.request(`/repository/commits/${encodeURIComponent(commitSha)}/statuses`, "GET");
    const statuses = Array.isArray(data) ? data.map(record).map((item) => item.status) : [];
    if (statuses.some((status) => status === "failed" || status === "canceled")) return "FAILED";
    if (statuses.length > 0 && statuses.every((status) => status === "success" || status === "skipped")) return "PASSED";
    if (statuses.some((status) => status === "pending" || status === "running" || status === "created")) return "PENDING";
    return "UNKNOWN";
  }

  private metadata(data: Record<string, unknown>, request: CodeReviewRequest): CodeReviewMetadata {
    return Object.freeze({
      provider: this.type,
      reviewId: String(data.iid),
      reviewUrl: typeof data.web_url === "string" ? data.web_url : "",
      sourceBranch: request.sourceBranch,
      targetBranch: request.targetBranch,
    });
  }

  private async request(path: string, method: string, body?: unknown): Promise<unknown> {
    const token = this.token();
    if (!token) throw new Error("REVIEW_PROVIDER_UNAVAILABLE: GitLab credentials are unavailable");
    const project = encodeURIComponent(this.projectIdentity);
    const response = await this.transport(`${this.apiBase}/projects/${project}${path}`, {
      method,
      headers: { "PRIVATE-TOKEN": token, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`REVIEW_CREATE_FAILED: GitLab API returned status ${response.status}`);
    return response.json();
  }
}

