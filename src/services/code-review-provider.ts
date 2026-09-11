export type CodeReviewProviderType = "GITHUB" | "GITLAB";
export type CiStatus = "NOT_REQUESTED" | "PENDING" | "PASSED" | "FAILED" | "UNKNOWN";

export interface CodeReviewRequest {
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly commitSha: string;
  readonly title: string;
  readonly body: string;
  readonly shippingId: string;
}

export interface CodeReviewMetadata {
  readonly provider: CodeReviewProviderType;
  readonly reviewId: string;
  readonly reviewUrl: string;
  readonly sourceBranch: string;
  readonly targetBranch: string;
}

/** Review providers create/query handoff records only. They have no Git, validation, or completion authority. */
export interface CodeReviewProvider {
  readonly type: CodeReviewProviderType;
  findExistingReview(request: CodeReviewRequest): Promise<CodeReviewMetadata | null>;
  createReview(request: CodeReviewRequest): Promise<CodeReviewMetadata>;
  queryCiStatus?(commitSha: string): Promise<CiStatus>;
}

