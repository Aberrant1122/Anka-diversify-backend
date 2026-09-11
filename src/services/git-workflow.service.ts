import crypto from "crypto";
import fs from "fs";
import path from "path";
import { TaskRuntime } from "../ai/runtime/TaskRuntime";
import { VerifiedCheckpointJournal } from "../ai/runtime/VerifiedCheckpointJournal";
import type { ActionGroupJournalEntry } from "../ai/runtime/VerifiedCheckpointJournal";
import type { CiStatus, CodeReviewMetadata, CodeReviewProvider } from "./code-review-provider";
import { GitCommandExecutor, GitCommandError, NodeGitCommandExecutor } from "./git-command";

export type GitShippingMode = "LOCAL_ONLY" | "PUSH_BRANCH" | "CREATE_REVIEW";

export type GitWorkflowFailureCode =
  | "GIT_NOT_REPOSITORY"
  | "GIT_DIRTY_BASELINE"
  | "GIT_BASE_REVISION_CHANGED"
  | "GIT_UNEXPECTED_DIFF"
  | "GIT_STAGE_MISMATCH"
  | "GIT_COMMIT_FAILED"
  | "GIT_PUSH_FAILED"
  | "GIT_INVALID_REF"
  | "GIT_REMOTE_NOT_FOUND"
  | "GIT_RUNTIME_INCOMPLETE"
  | "REVIEW_PROVIDER_UNAVAILABLE"
  | "REVIEW_CREATE_FAILED";

export class GitWorkflowError extends Error {
  constructor(public readonly code: GitWorkflowFailureCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "GitWorkflowError";
  }
}

export interface VerifiedFinalChange {
  readonly path: string;
  readonly fingerprint: string;
  readonly source: "VERIFIED_ACTION_GROUP" | "TRUSTED_INFRASTRUCTURE_POLICY";
}

export interface TrustedInfrastructureChange {
  readonly path: string;
  readonly fingerprint: string;
  readonly policyAuthorized: true;
}

export interface GitShippingRequest {
  readonly repositoryRoot: string;
  readonly worktreePath: string;
  readonly baseRevision: string;
  readonly taskBranch: string;
  readonly targetBranch: string;
  readonly trustedTargetRevision: string;
  readonly shippingId: string;
  readonly taskRuntime: TaskRuntime;
  readonly checkpointJournal: VerifiedCheckpointJournal;
  readonly validationPassed: boolean;
  readonly mode?: GitShippingMode;
  readonly remote?: string;
  readonly expectedRepositoryIdentity?: string;
  readonly commitSummary?: string;
  readonly trustedInfrastructureChanges?: readonly TrustedInfrastructureChange[];
  readonly reviewProvider?: CodeReviewProvider;
  readonly validationSummary?: string;
}

export interface GitShippingResult {
  readonly baseRevision: string;
  readonly taskHeadRevision: string;
  readonly finalVerifiedRevision: string;
  readonly taskBranch: string;
  readonly commitCreated: boolean;
  readonly commitSha?: string;
  readonly changedPaths: readonly string[];
  readonly remote?: string;
  readonly pushed: boolean;
  readonly provider?: CodeReviewMetadata["provider"];
  readonly reviewId?: string;
  readonly reviewUrl?: string;
  readonly ciStatus: CiStatus;
}

interface RepositoryDelta {
  readonly paths: readonly string[];
  readonly patch: string;
}

function fingerprint(content: Buffer | string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function normalizeRelativePath(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  if (!normalized || path.posix.isAbsolute(normalized) || path.win32.isAbsolute(normalized)) {
    throw new GitWorkflowError("GIT_UNEXPECTED_DIFF", `Invalid repository-relative path: ${value}`);
  }
  const relative = path.posix.normalize(normalized).replace(/^\.\//, "");
  if (!relative || relative === "." || relative === ".." || relative.startsWith("../") || /[\0\r\n]/.test(relative)) {
    throw new GitWorkflowError("GIT_UNEXPECTED_DIFF", `Invalid repository-relative path: ${value}`);
  }
  return relative;
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort((a, b) => a.localeCompare(b)));
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function safeSummary(value: string | undefined): string {
  const cleaned = (value ?? "verified task changes")
    .replace(/[\r\n\0]/g, " ")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/--(?:no-verify|amend|author|reset-author|signoff)\b/gi, "")
    .replace(/[;&|`$<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 72);
  return cleaned || "verified task changes";
}

function validateShippingId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value)) {
    throw new GitWorkflowError("GIT_INVALID_REF", "Shipping identity is not backend-safe");
  }
}

function validateBranch(value: string, task = false): void {
  const valid = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,160}$/.test(value)
    && !value.startsWith("-")
    && !value.endsWith(".")
    && !value.endsWith("/")
    && !value.includes("..")
    && !value.includes("//")
    && !value.includes("@{")
    && !/[~^:?*\[\\\s\x00-\x1f\x7f]/.test(value);
  if (!valid || (task && !/^anka\/run-[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value))) {
    throw new GitWorkflowError("GIT_INVALID_REF", `Rejected unsafe ${task ? "task " : ""}branch name`);
  }
}

function validateRemote(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value) || value.startsWith("-")) {
    throw new GitWorkflowError("GIT_INVALID_REF", "Rejected unsafe remote name");
  }
}

function repositoryIdentity(remoteUrl: string): string {
  const withoutCredentials = remoteUrl.trim().replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]+@/i, "$1");
  const scpLike = withoutCredentials.match(/^(?:[^@]+@)?([^:]+):(.+)$/);
  const normalized = scpLike && !withoutCredentials.includes("://")
    ? `${scpLike[1]}/${scpLike[2]}`
    : withoutCredentials.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  return normalized.replace(/^\/+/, "").replace(/\.git\/?$/i, "").replace(/\/$/, "").toLowerCase();
}

function parseStatus(output: string): readonly string[] {
  const records = output.split("\0").filter(Boolean);
  const paths: string[] = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (record.length < 4 || record[2] !== " ") {
      throw new GitWorkflowError("GIT_UNEXPECTED_DIFF", "Git returned an unsupported status record");
    }
    const status = record.slice(0, 2);
    if (status.includes("R") || status.includes("C")) {
      throw new GitWorkflowError("GIT_UNEXPECTED_DIFF", "Rename/copy deltas require explicit delete/create evidence");
    }
    paths.push(normalizeRelativePath(record.slice(3)));
  }
  return sortedUnique(paths);
}

function changesFromEntries(entries: readonly ActionGroupJournalEntry[]): readonly VerifiedFinalChange[] {
  const byPath = new Map<string, VerifiedFinalChange>();
  for (const entry of entries) {
    if (entry.status !== "VERIFIED" || !entry.validation.passed || entry.validation.source !== "VALIDATION_COORDINATOR") continue;
    for (const action of entry.attemptedActions) {
      const relativePath = normalizeRelativePath(action.path);
      const finalFingerprint = entry.finalFingerprints[relativePath];
      if (!finalFingerprint || finalFingerprint === "UNAVAILABLE") {
        throw new GitWorkflowError("GIT_UNEXPECTED_DIFF", `Verified checkpoint lacks final disk evidence for ${relativePath}`);
      }
      byPath.set(relativePath, Object.freeze({
        path: relativePath,
        fingerprint: finalFingerprint,
        source: "VERIFIED_ACTION_GROUP" as const,
      }));
    }
  }
  return Object.freeze([...byPath.values()].sort((a, b) => a.path.localeCompare(b.path)));
}

/** Git records verified reality only; it cannot issue mutation, validation, checkpoint, or completion authority. */
export class GitWorkflowService {
  constructor(private readonly git: GitCommandExecutor = new NodeGitCommandExecutor()) {}

  public buildVerifiedChangeset(
    journal: VerifiedCheckpointJournal,
    infrastructure: readonly TrustedInfrastructureChange[] = [],
  ): readonly VerifiedFinalChange[] {
    const byPath = new Map(changesFromEntries(journal.snapshot()).map((change) => [change.path, change]));
    for (const change of infrastructure) {
      if (change.policyAuthorized !== true) continue;
      const relativePath = normalizeRelativePath(change.path);
      byPath.set(relativePath, Object.freeze({
        path: relativePath,
        fingerprint: change.fingerprint,
        source: "TRUSTED_INFRASTRUCTURE_POLICY" as const,
      }));
    }
    return Object.freeze([...byPath.values()].sort((a, b) => a.path.localeCompare(b.path)));
  }

  public async ship(request: GitShippingRequest): Promise<GitShippingResult> {
    this.requireCompletion(request);
    validateShippingId(request.shippingId);
    if (!/^[0-9a-f]{40}$/i.test(request.baseRevision) || !/^[0-9a-f]{40}$/i.test(request.trustedTargetRevision)) {
      throw new GitWorkflowError("GIT_INVALID_REF", "Base and target revisions must be full commit SHAs");
    }
    validateBranch(request.taskBranch, true);
    validateBranch(request.targetBranch);
    if (request.taskBranch === request.targetBranch) {
      throw new GitWorkflowError("GIT_INVALID_REF", "Task branch must differ from the target branch");
    }
    const mode = request.mode ?? "LOCAL_ONLY";
    const remote = request.remote ?? "origin";
    if (mode !== "LOCAL_ONLY") validateRemote(remote);

    const root = path.resolve(request.repositoryRoot);
    const worktree = path.resolve(request.worktreePath);
    await this.assertRepository(root);
    await this.assertRepository(worktree);
    await this.assertNativeRefs(worktree, request.taskBranch, request.targetBranch);
    const sourceStatus = (await this.git.run(root, ["status", "--porcelain"])).stdout.trim();
    if (sourceStatus) throw new GitWorkflowError("GIT_DIRTY_BASELINE", "Original repository changed during isolated task execution");
    await this.assertBranch(worktree, request.taskBranch);
    await this.assertBaseRevision(root, request.targetBranch, remote, request.trustedTargetRevision);

    const allowed = this.buildVerifiedChangeset(request.checkpointJournal, request.trustedInfrastructureChanges);
    const allowedPaths = allowed.map((change) => change.path);
    const taskHeadRevision = (await this.git.run(worktree, ["rev-parse", "HEAD"])).stdout.trim();

    const retryCommit = taskHeadRevision !== request.baseRevision
      ? await this.resolveExistingCommit(worktree, request, allowed, taskHeadRevision)
      : null;
    let commitSha = retryCommit;
    let commitCreated = false;
    let finalVerifiedRevision: string;

    if (retryCommit) {
      finalVerifiedRevision = fingerprint(`${request.baseRevision}\0${retryCommit}\0${allowedPaths.join("\0")}`);
    } else {
      const delta = await this.readAndVerifyDelta(worktree, request.baseRevision, allowed);
      finalVerifiedRevision = fingerprint(`${request.baseRevision}\0${allowed.map((item) => `${item.path}:${item.fingerprint}`).join("\0")}\0${delta.patch}`);
      if (allowed.length === 0) {
        return Object.freeze({
          baseRevision: request.baseRevision,
          taskHeadRevision,
          finalVerifiedRevision,
          taskBranch: request.taskBranch,
          commitCreated: false,
          changedPaths: Object.freeze([]),
          pushed: false,
          ciStatus: "NOT_REQUESTED",
        });
      }
      await this.stageAndVerify(worktree, request.baseRevision, allowed);
      const message = `anka: ${safeSummary(request.commitSummary)} [anka-shipping:${request.shippingId}]`;
      try {
        await this.git.run(worktree, ["commit", "-m", message]);
        commitSha = (await this.git.run(worktree, ["rev-parse", "HEAD"])).stdout.trim();
        if (!/^[0-9a-f]{40}$/i.test(commitSha)) throw new Error("Git returned an invalid commit SHA");
        commitCreated = true;
      } catch (error) {
        throw this.mapGitError("GIT_COMMIT_FAILED", error, "Commit hook or Git commit failed");
      }
    }

    if (!commitSha) throw new GitWorkflowError("GIT_COMMIT_FAILED", "Git did not return a commit SHA");
    if (mode === "LOCAL_ONLY") {
      return this.result(request, taskHeadRevision, finalVerifiedRevision, allowedPaths, commitCreated, commitSha, false, "NOT_REQUESTED");
    }

    await this.assertRemote(root, remote, request.expectedRepositoryIdentity);
    await this.assertRemoteTargetRevision(worktree, remote, request.targetBranch, request.trustedTargetRevision);
    const pushed = await this.pushTaskBranch(worktree, remote, request.taskBranch, commitSha);
    if (mode === "PUSH_BRANCH") {
      return this.result(request, taskHeadRevision, finalVerifiedRevision, allowedPaths, commitCreated, commitSha, pushed, "NOT_REQUESTED", remote);
    }
    if (!request.reviewProvider) {
      throw new GitWorkflowError("REVIEW_PROVIDER_UNAVAILABLE", "CREATE_REVIEW requires an injected provider adapter");
    }
    const reviewRequest = Object.freeze({
      sourceBranch: request.taskBranch,
      targetBranch: request.targetBranch,
      commitSha,
      title: safeSummary(request.commitSummary),
      body: this.reviewBody(request, allowedPaths, commitSha),
      shippingId: request.shippingId,
    });
    let review: CodeReviewMetadata;
    try {
      review = await request.reviewProvider.findExistingReview(reviewRequest)
        ?? await request.reviewProvider.createReview(reviewRequest);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Review provider failed";
      if (message.includes("UNAVAILABLE")) throw new GitWorkflowError("REVIEW_PROVIDER_UNAVAILABLE", "Review credentials/provider unavailable");
      throw new GitWorkflowError("REVIEW_CREATE_FAILED", "Review creation/query failed");
    }
    let ciStatus: CiStatus = "UNKNOWN";
    if (request.reviewProvider.queryCiStatus) {
      try {
        ciStatus = await request.reviewProvider.queryCiStatus(commitSha);
      } catch {
        ciStatus = "UNKNOWN";
      }
    }
    return this.result(request, taskHeadRevision, finalVerifiedRevision, allowedPaths, commitCreated, commitSha, pushed, ciStatus, remote, review);
  }

  private requireCompletion(request: GitShippingRequest): void {
    if (!(request.taskRuntime instanceof TaskRuntime) || !(request.checkpointJournal instanceof VerifiedCheckpointJournal)) {
      throw new GitWorkflowError("GIT_RUNTIME_INCOMPLETE", "Shipping requires authentic runtime and checkpoint authority objects");
    }
    const snapshot = request.taskRuntime.snapshot();
    if (snapshot.status !== "COMPLETED" || snapshot.terminalOutcome?.type !== "COMPLETED"
      || snapshot.terminalOutcome.validationSource !== "COMPLETION_EVALUATOR" || request.validationPassed !== true) {
      throw new GitWorkflowError("GIT_RUNTIME_INCOMPLETE", "Shipping requires deterministic validation and a COMPLETED TaskRuntime");
    }
  }

  private async assertRepository(cwd: string): Promise<void> {
    try {
      const result = await this.git.run(cwd, ["rev-parse", "--is-inside-work-tree"]);
      if (result.stdout.trim() !== "true") throw new Error("not a work tree");
    } catch (error) {
      throw this.mapGitError("GIT_NOT_REPOSITORY", error, "Path is not a Git worktree");
    }
  }

  private async assertBranch(worktree: string, taskBranch: string): Promise<void> {
    const branch = (await this.git.run(worktree, ["branch", "--show-current"])).stdout.trim();
    if (branch !== taskBranch) throw new GitWorkflowError("GIT_BASE_REVISION_CHANGED", "Worktree is not on its bound task branch");
  }

  private async assertNativeRefs(worktree: string, taskBranch: string, targetBranch: string): Promise<void> {
    try {
      await this.git.run(worktree, ["check-ref-format", "--branch", taskBranch]);
      await this.git.run(worktree, ["check-ref-format", "--branch", targetBranch]);
    } catch {
      throw new GitWorkflowError("GIT_INVALID_REF", "Git rejected the source or target branch name");
    }
  }

  private async assertBaseRevision(root: string, target: string, remote: string, trusted: string): Promise<void> {
    const candidates = [`refs/heads/${target}`, `refs/remotes/${remote}/${target}`];
    let current = "";
    for (const candidate of candidates) {
      try {
        current = (await this.git.run(root, ["rev-parse", "--verify", candidate])).stdout.trim();
        if (current) break;
      } catch {
        continue;
      }
    }
    if (!current || current !== trusted) {
      throw new GitWorkflowError("GIT_BASE_REVISION_CHANGED", "Target branch moved or cannot be resolved from its trusted revision");
    }
  }

  private async readAndVerifyDelta(worktree: string, base: string, allowed: readonly VerifiedFinalChange[]): Promise<RepositoryDelta> {
    const status = await this.git.run(worktree, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    const actualPaths = parseStatus(status.stdout);
    const expectedPaths = sortedUnique(allowed.map((change) => change.path));
    if (!samePaths(actualPaths, expectedPaths)) {
      throw new GitWorkflowError("GIT_UNEXPECTED_DIFF", `Actual worktree delta does not match verified paths`);
    }
    for (const change of allowed) {
      const absolute = path.resolve(worktree, change.path);
      if (change.fingerprint === "MISSING") {
        if (fs.existsSync(absolute)) throw new GitWorkflowError("GIT_UNEXPECTED_DIFF", `Verified deletion is present on disk: ${change.path}`);
        continue;
      }
      if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile() || fingerprint(fs.readFileSync(absolute)) !== change.fingerprint) {
        throw new GitWorkflowError("GIT_UNEXPECTED_DIFF", `Final disk fingerprint differs from verified evidence: ${change.path}`);
      }
    }
    const patch = (await this.git.run(worktree, ["diff", "--binary", base, "--", ...expectedPaths])).stdout;
    return Object.freeze({ paths: actualPaths, patch });
  }

  private async stageAndVerify(worktree: string, base: string, allowed: readonly VerifiedFinalChange[]): Promise<void> {
    const paths = allowed.map((change) => change.path);
    for (const relativePath of paths) await this.git.run(worktree, ["add", "--", relativePath]);
    const stagedPaths = sortedUnique((await this.git.run(worktree, ["diff", "--cached", "--name-only", "-z", base, "--"])).stdout.split("\0").filter(Boolean).map(normalizeRelativePath));
    if (!samePaths(stagedPaths, sortedUnique(paths))) {
      throw new GitWorkflowError("GIT_STAGE_MISMATCH", "Staged paths differ from verified changeset");
    }
    const stagedPatch = (await this.git.run(worktree, ["diff", "--cached", "--binary", base, "--", ...paths])).stdout;
    if (!stagedPatch.trim()) throw new GitWorkflowError("GIT_STAGE_MISMATCH", "Staged diff is unexpectedly empty");
    for (const change of allowed) {
      if (change.fingerprint === "MISSING") {
        const present = await this.git.run(worktree, ["cat-file", "-e", `:${change.path}`]).then(() => true, () => false);
        if (present) throw new GitWorkflowError("GIT_STAGE_MISMATCH", `Verified deletion remains in the index: ${change.path}`);
        continue;
      }
      const indexedContent = (await this.git.run(worktree, ["show", `:${change.path}`])).stdout;
      if (fingerprint(indexedContent) !== change.fingerprint) {
        throw new GitWorkflowError("GIT_STAGE_MISMATCH", `Indexed bytes differ from verified evidence: ${change.path}`);
      }
    }
  }

  private async resolveExistingCommit(
    worktree: string,
    request: GitShippingRequest,
    allowed: readonly VerifiedFinalChange[],
    head: string,
  ): Promise<string | null> {
    const ancestor = await this.git.run(worktree, ["merge-base", "--is-ancestor", request.baseRevision, head]).then(() => true, () => false);
    if (!ancestor) throw new GitWorkflowError("GIT_BASE_REVISION_CHANGED", "Task HEAD is not descended from its bound base revision");
    const message = (await this.git.run(worktree, ["log", "-1", "--format=%B", head])).stdout;
    if (!message.includes(`[anka-shipping:${request.shippingId}]`)) {
      throw new GitWorkflowError("GIT_BASE_REVISION_CHANGED", "Task HEAD contains an unrecognized commit");
    }
    const status = parseStatus((await this.git.run(worktree, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout);
    if (status.length > 0) throw new GitWorkflowError("GIT_UNEXPECTED_DIFF", "Retry worktree contains changes after the existing shipping commit");
    const committed = sortedUnique((await this.git.run(worktree, ["diff", "--name-only", "-z", request.baseRevision, head, "--"])).stdout.split("\0").filter(Boolean).map(normalizeRelativePath));
    if (!samePaths(committed, sortedUnique(allowed.map((change) => change.path)))) {
      throw new GitWorkflowError("GIT_UNEXPECTED_DIFF", "Existing shipping commit differs from verified paths");
    }
    for (const change of allowed) {
      const object = `${head}:${change.path}`;
      if (change.fingerprint === "MISSING") {
        const present = await this.git.run(worktree, ["cat-file", "-e", object]).then(() => true, () => false);
        if (present) throw new GitWorkflowError("GIT_UNEXPECTED_DIFF", `Existing commit contradicts verified deletion: ${change.path}`);
        continue;
      }
      const content = (await this.git.run(worktree, ["show", object])).stdout;
      if (fingerprint(content) !== change.fingerprint) {
        throw new GitWorkflowError("GIT_UNEXPECTED_DIFF", `Existing commit bytes differ from verified evidence: ${change.path}`);
      }
    }
    return head;
  }

  private async assertRemote(root: string, remote: string, expectedIdentity?: string): Promise<void> {
    let url: string;
    try {
      url = (await this.git.run(root, ["remote", "get-url", remote])).stdout.trim();
    } catch (error) {
      throw this.mapGitError("GIT_REMOTE_NOT_FOUND", error, "Configured remote was not found");
    }
    if (expectedIdentity && repositoryIdentity(url) !== repositoryIdentity(expectedIdentity)) {
      throw new GitWorkflowError("GIT_REMOTE_NOT_FOUND", "Remote repository identity does not match trusted configuration");
    }
  }

  private async assertRemoteTargetRevision(worktree: string, remote: string, target: string, trusted: string): Promise<void> {
    try {
      const output = (await this.git.run(worktree, ["ls-remote", "--heads", remote, `refs/heads/${target}`])).stdout.trim();
      const remoteSha = output ? output.split(/\s+/, 1)[0] : "";
      if (!remoteSha || remoteSha !== trusted) {
        throw new GitWorkflowError("GIT_BASE_REVISION_CHANGED", "Remote target branch moved from its trusted base revision");
      }
    } catch (error) {
      if (error instanceof GitWorkflowError) throw error;
      throw this.mapGitError("GIT_PUSH_FAILED", error, "Unable to verify remote target revision");
    }
  }

  private async pushTaskBranch(worktree: string, remote: string, branch: string, commitSha: string): Promise<boolean> {
    try {
      const remoteHead = (await this.git.run(worktree, ["ls-remote", "--heads", remote, `refs/heads/${branch}`])).stdout.trim();
      if (remoteHead) {
        const existingSha = remoteHead.split(/\s+/, 1)[0];
        if (existingSha === commitSha) return true;
        throw new GitWorkflowError("GIT_PUSH_FAILED", "Remote task branch already points to different history; refusing rewrite");
      }
      await this.git.run(worktree, ["push", remote, `${branch}:refs/heads/${branch}`]);
      return true;
    } catch (error) {
      if (error instanceof GitWorkflowError) throw error;
      throw this.mapGitError("GIT_PUSH_FAILED", error, "Task branch push failed");
    }
  }

  private reviewBody(request: GitShippingRequest, paths: readonly string[], commitSha: string): string {
    const validation = safeSummary(request.validationSummary ?? "Deterministic validation passed");
    const changed = paths.slice(0, 50).map((item) => `- ${item}`).join("\n");
    return `Verified ANKA shipping handoff\n\nCommit: ${commitSha}\nValidation: ${validation}\nChanged paths:\n${changed}`;
  }

  private result(
    request: GitShippingRequest,
    taskHeadRevision: string,
    finalVerifiedRevision: string,
    changedPaths: readonly string[],
    commitCreated: boolean,
    commitSha: string,
    pushed: boolean,
    ciStatus: CiStatus,
    remote?: string,
    review?: CodeReviewMetadata,
  ): GitShippingResult {
    return Object.freeze({
      baseRevision: request.baseRevision,
      taskHeadRevision,
      finalVerifiedRevision,
      taskBranch: request.taskBranch,
      commitCreated,
      commitSha,
      changedPaths: Object.freeze([...changedPaths]),
      ...(remote ? { remote } : {}),
      pushed,
      ...(review ? { provider: review.provider, reviewId: review.reviewId, reviewUrl: review.reviewUrl } : {}),
      ciStatus,
    });
  }

  private mapGitError(code: GitWorkflowFailureCode, error: unknown, fallback: string): GitWorkflowError {
    if (error instanceof GitWorkflowError) return error;
    const detail = error instanceof GitCommandError && error.stderr ? error.stderr : fallback;
    return new GitWorkflowError(code, detail);
  }
}
