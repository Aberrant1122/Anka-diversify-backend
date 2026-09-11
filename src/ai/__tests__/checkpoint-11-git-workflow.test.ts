import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { AgentWorkspaceState } from "../runtime/AgentWorkspaceState";
import { AuthorizedCapabilityScope, CapabilityGrant } from "../runtime/CapabilityGuard";
import { CompletionEvaluator } from "../runtime/CompletionEvaluator";
import { TaskRuntime } from "../runtime/TaskRuntime";
import { VerifiedCheckpointJournal } from "../runtime/VerifiedCheckpointJournal";
import { ValidationCoordinator } from "../orchestration/ValidationCoordinator";
import { GitWorktreeService, PreparedRepositoryRun } from "../../services/git-worktree.service";
import { CodeReviewMetadata, CodeReviewProvider, CodeReviewRequest } from "../../services/code-review-provider";
import { GitCommandExecutor, GitCommandResult, NodeGitCommandExecutor } from "../../services/git-command";
import { GitShippingRequest, GitWorkflowError, GitWorkflowService } from "../../services/git-workflow.service";
import { GitHubCodeReviewProvider, ReviewHttpResponse } from "../../services/github-code-review.provider";
import { GitLabCodeReviewProvider } from "../../services/gitlab-code-review.provider";
import type { AgentFileChange } from "../../types";

function run(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim();
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

class TrackingGit implements GitCommandExecutor {
  public readonly calls: string[][] = [];

  constructor(
    private readonly delegate: GitCommandExecutor = new NodeGitCommandExecutor(),
    private readonly override?: (cwd: string, args: readonly string[], result: GitCommandResult) => GitCommandResult,
  ) {}

  public async run(cwd: string, args: readonly string[]): Promise<GitCommandResult> {
    this.calls.push([...args]);
    const result = await this.delegate.run(cwd, args);
    return this.override ? this.override(cwd, args, result) : result;
  }
}

class StubReviewProvider implements CodeReviewProvider {
  public readonly type: "GITHUB" | "GITLAB";
  public readonly calls: string[] = [];
  public request?: CodeReviewRequest;

  constructor(
    type: "GITHUB" | "GITLAB",
    private readonly existing: CodeReviewMetadata | null = null,
    private readonly ci: "PENDING" | "FAILED" = "PENDING",
  ) {
    this.type = type;
  }

  public async findExistingReview(request: CodeReviewRequest): Promise<CodeReviewMetadata | null> {
    this.calls.push("find");
    this.request = request;
    return this.existing;
  }

  public async createReview(request: CodeReviewRequest): Promise<CodeReviewMetadata> {
    this.calls.push("create");
    this.request = request;
    return {
      provider: this.type,
      reviewId: "42",
      reviewUrl: "https://review.example/42",
      sourceBranch: request.sourceBranch,
      targetBranch: request.targetBranch,
    };
  }

  public async queryCiStatus(): Promise<"PENDING" | "FAILED"> {
    this.calls.push("ci");
    return this.ci;
  }
}

describe("Checkpoint 11 verified Git/GitHub/GitLab workflow", () => {
  let root: string;
  let source: string;
  let bareRemote: string;
  let baseRevision: string;
  const preparedRuns: PreparedRepositoryRun[] = [];

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "anka-cp11-"));
    source = path.join(root, "source");
    bareRemote = path.join(root, "remote.git");
    fs.mkdirSync(source, { recursive: true });
    run(source, ["init", "-b", "main"]);
    run(source, ["config", "user.name", "ANKA CP11 Test"]);
    run(source, ["config", "user.email", "cp11@anka.test"]);
    fs.mkdirSync(path.join(source, "src"), { recursive: true });
    fs.writeFileSync(path.join(source, "src", "value.ts"), "export const value = 'before';\n", "utf8");
    fs.writeFileSync(path.join(source, "src", "delete.ts"), "export const remove = true;\n", "utf8");
    run(source, ["add", "--", "src/value.ts", "src/delete.ts"]);
    run(source, ["commit", "-m", "baseline"]);
    baseRevision = run(source, ["rev-parse", "HEAD"]);
    run(root, ["init", "--bare", bareRemote]);
    run(source, ["remote", "add", "origin", bareRemote]);
    run(source, ["push", "origin", "main:refs/heads/main"]);
  });

  afterEach(async () => {
    for (const prepared of preparedRuns) {
      await GitWorktreeService.cleanupWorktree(
        prepared.worktreePath,
        prepared.repositoryRoot,
        prepared.branchName,
        path.basename(prepared.worktreePath),
      );
    }
    if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  async function prepare(runId: string): Promise<PreparedRepositoryRun> {
    const prepared = await GitWorktreeService.prepareRepositoryRun({ repositoryPath: source, runId });
    preparedRuns.push(prepared);
    return prepared;
  }

  function authority(worktree: string, stageId: string, grants: readonly CapabilityGrant[]): AuthorizedCapabilityScope {
    const scope = AuthorizedCapabilityScope.fromBackendConfiguration({
      workspaceRoot: worktree,
      authorityId: `cp11:${stageId}`,
      grants,
    });
    if (!scope) throw new Error("Test authority creation failed");
    return scope;
  }

  async function completed(
    prepared: PreparedRepositoryRun,
    changes: readonly AgentFileChange[],
  ): Promise<{ runtime: TaskRuntime; journal: VerifiedCheckpointJournal }> {
    const runtime = TaskRuntime.create({
      taskId: `task-${path.basename(prepared.worktreePath)}`,
      originalGoal: changes.length > 0 ? "Apply verified repository changes" : "Confirm repository already satisfies the task",
      workspace: AgentWorkspaceState.create({ projectId: "cp11", root: prepared.worktreePath, revision: prepared.baseCommitSha }),
    });
    runtime.start();
    const journal = new VerifiedCheckpointJournal();
    if (changes.length > 0) {
      const grants = changes.map((change): CapabilityGrant => ({
        path: change.path,
        action: change.action === "delete" || change.isDeleted ? "FILE_DELETE" : change.action === "create" ? "FILE_CREATE" : "FILE_MODIFY",
      }));
      const execution = await ValidationCoordinator.applyLocalActionGroup({
        stageId: "cp11-stage",
        localPath: prepared.worktreePath,
        authorizedCapabilityScope: authority(prepared.worktreePath, "cp11-stage", grants),
        changes: [...changes],
        journal,
      });
      runtime.updateWorkspace(runtime.workspaceState().withCheckpointReference({
        id: execution.journalEntry.journalId,
        sequence: execution.journalEntry.sequence,
        actionGroupId: execution.journalEntry.actionGroupId,
        status: execution.journalEntry.status,
        source: "VERIFIED_CHECKPOINT_JOURNAL",
      }));
    }
    const revision = `cp11-final-${path.basename(prepared.worktreePath)}`;
    runtime.updateWorkspace(runtime.workspaceState().withEvidence({
      id: `completion:${revision}`,
      kind: "MATERIALIZED_REPOSITORY",
      description: "Fresh final worktree facts",
      revision,
    }).withWorkingPlan({ id: "cp11-plan", revision: 1, status: "AWAITING_COMPLETION_EVALUATION" }));
    const checkpointIds = journal.verifiedCheckpoints().map((entry) => entry.journalId);
    const result = CompletionEvaluator.evaluate({
      runtime,
      handoff: { outcome: "AWAITING_COMPLETION_EVALUATION", workingPlanId: "cp11-plan", workingPlanRevision: 1 },
      journal,
      repository: {
        root: prepared.worktreePath,
        revision,
        changedPaths: changes.map((change) => change.path),
        source: "MATERIALIZED_REPOSITORY",
        coverage: "FULL_REPOSITORY_DELTA",
      },
      validation: { passed: true, repositoryRevision: revision, source: "VALIDATION_COORDINATOR" },
      requirements: [{
        id: "cp11-requirement",
        description: "Verified change or deterministic no-op",
        required: true,
        status: "SATISFIED",
        repositoryRevision: revision,
        checkpointIds,
      }],
    });
    if (result.outcome !== "COMPLETE") throw new Error(`Completion setup failed: ${result.code}`);
    runtime.complete(result.receipt);
    return { runtime, journal };
  }

  function request(
    prepared: PreparedRepositoryRun,
    state: { runtime: TaskRuntime; journal: VerifiedCheckpointJournal },
    overrides: Partial<GitShippingRequest> = {},
  ): GitShippingRequest {
    return {
      repositoryRoot: prepared.repositoryRoot,
      worktreePath: prepared.worktreePath,
      baseRevision: prepared.baseCommitSha,
      taskBranch: prepared.branchName,
      targetBranch: "main",
      trustedTargetRevision: baseRevision,
      shippingId: `ship-${path.basename(prepared.worktreePath)}`,
      taskRuntime: state.runtime,
      checkpointJournal: state.journal,
      validationPassed: true,
      mode: "LOCAL_ONLY",
      commitSummary: "implement verified CP11 change\n--no-verify",
      ...overrides,
    };
  }

  test("1, 2, 23. isolated worktrees bind exact base and do not share mutable state", async () => {
    const first = await prepare("isolation-a");
    const second = await prepare("isolation-b");
    expect(first.baseCommitSha).toBe(baseRevision);
    expect(second.baseCommitSha).toBe(baseRevision);
    expect(first.worktreePath).not.toBe(second.worktreePath);
    fs.writeFileSync(path.join(first.worktreePath, "src", "value.ts"), "first\n", "utf8");
    expect(fs.readFileSync(path.join(second.worktreePath, "src", "value.ts"), "utf8")).toContain("before");
    expect(fs.readFileSync(path.join(source, "src", "value.ts"), "utf8")).toContain("before");
  });

  test("3, 6, 11, 26, 27, 28. stages only journal-verified modify/delete bytes and uses actual Git SHA", async () => {
    const prepared = await prepare("verified-stage");
    const state = await completed(prepared, [
      { path: "src/value.ts", action: "modify", content: "export const value = 'after';\n", description: "verified modify" },
      { path: "src/delete.ts", action: "delete", content: "", description: "verified delete" },
      { path: "src/created.ts", action: "create", content: "export const created = true;\n", description: "verified create" },
    ]);
    const tracking = new TrackingGit();
    const result = await new GitWorkflowService(tracking).ship(request(prepared, state));
    expect(result.changedPaths).toEqual(["src/created.ts", "src/delete.ts", "src/value.ts"]);
    expect(result.commitCreated).toBe(true);
    expect(result.commitSha).toBe(run(prepared.worktreePath, ["rev-parse", "HEAD"]));
    expect(run(prepared.worktreePath, ["log", "-1", "--format=%B"])).not.toContain("--no-verify");
    expect(run(prepared.worktreePath, ["show", "--format=", "--name-status", "HEAD"])).toContain("D\tsrc/delete.ts");
    const addCalls = tracking.calls.filter((args) => args[0] === "add");
    expect(addCalls).toEqual([
      ["add", "--", "src/created.ts"],
      ["add", "--", "src/delete.ts"],
      ["add", "--", "src/value.ts"],
    ]);
    expect(fs.readFileSync(path.join(source, "src", "value.ts"), "utf8")).toContain("before");
  });

  test("4, 5. unexpected tracked or untracked paths fail closed before commit", async () => {
    for (const unexpected of ["src/delete.ts", "scratch.tmp"]) {
      const prepared = await prepare(`unexpected-${unexpected.includes("/") ? "tracked" : "untracked"}`);
      const state = await completed(prepared, [
        { path: "src/value.ts", action: "modify", content: "verified\n", description: "verified" },
      ]);
      fs.writeFileSync(path.join(prepared.worktreePath, unexpected), "unexpected\n", "utf8");
      await expect(new GitWorkflowService().ship(request(prepared, state))).rejects.toMatchObject({ code: "GIT_UNEXPECTED_DIFF" });
      expect(run(prepared.worktreePath, ["rev-parse", "HEAD"])).toBe(baseRevision);
    }
  });

  test("7. staged diff mismatch blocks commit", async () => {
    const prepared = await prepare("stage-mismatch");
    const state = await completed(prepared, [
      { path: "src/value.ts", action: "modify", content: "verified\n", description: "verified" },
    ]);
    const tracking = new TrackingGit(new NodeGitCommandExecutor(), (_cwd, args, result) => {
      if (args[0] === "diff" && args[1] === "--cached" && args.includes("--name-only")) {
        return { ...result, stdout: `${result.stdout}unexpected.ts\0` };
      }
      return result;
    });
    await expect(new GitWorkflowService(tracking).ship(request(prepared, state))).rejects.toMatchObject({ code: "GIT_STAGE_MISMATCH" });
    expect(run(prepared.worktreePath, ["rev-parse", "HEAD"])).toBe(baseRevision);
  });

  test("8, 9, 29. incomplete runtime/validation cannot commit and Git cannot mint authority receipts", async () => {
    const prepared = await prepare("incomplete");
    const incomplete = TaskRuntime.create({
      taskId: "incomplete",
      originalGoal: "not complete",
      workspace: AgentWorkspaceState.create({ projectId: "cp11", root: prepared.worktreePath }),
    });
    incomplete.start();
    const journal = new VerifiedCheckpointJournal();
    await expect(new GitWorkflowService().ship(request(prepared, { runtime: incomplete, journal }))).rejects.toBeInstanceOf(GitWorkflowError);
    const state = await completed(prepared, []);
    await expect(new GitWorkflowService().ship(request(prepared, state, { validationPassed: false }))).rejects.toBeInstanceOf(GitWorkflowError);
    expect(Object.getOwnPropertyNames(GitWorkflowService.prototype)).not.toEqual(expect.arrayContaining(["validate", "complete", "appendVerified"]));
  });

  test("10. deterministic no-op returns success without an empty commit", async () => {
    const prepared = await prepare("noop");
    const state = await completed(prepared, []);
    const result = await new GitWorkflowService().ship(request(prepared, state));
    expect(result).toMatchObject({ commitCreated: false, pushed: false, ciStatus: "NOT_REQUESTED" });
    expect(result.commitSha).toBeUndefined();
    expect(run(prepared.worktreePath, ["rev-parse", "HEAD"])).toBe(baseRevision);
  });

  test("12, 13, 14. rejects malicious refs and push argv contains task branch only with no force option", async () => {
    const malicious = await prepare("malicious-ref");
    const maliciousState = await completed(malicious, []);
    await expect(new GitWorkflowService().ship(request(malicious, maliciousState, { taskBranch: "-main;rm" })))
      .rejects.toMatchObject({ code: "GIT_INVALID_REF" });

    const prepared = await prepare("push-safe");
    const state = await completed(prepared, [
      { path: "src/value.ts", action: "modify", content: "push-safe\n", description: "verified" },
    ]);
    const tracking = new TrackingGit();
    const result = await new GitWorkflowService(tracking).ship(request(prepared, state, {
      mode: "PUSH_BRANCH",
      remote: "origin",
      expectedRepositoryIdentity: bareRemote,
    }));
    expect(result.pushed).toBe(true);
    const push = tracking.calls.find((args) => args[0] === "push");
    expect(push).toEqual(["push", "origin", `${prepared.branchName}:refs/heads/${prepared.branchName}`]);
    expect(tracking.calls.flat()).not.toContain("--force");
    expect(run(root, ["--git-dir", bareRemote, "rev-parse", `refs/heads/${prepared.branchName}`])).toBe(result.commitSha);
  });

  test("15, 21, 22. remote/review CI failures remain separate from completed runtime history", async () => {
    const prepared = await prepare("remote-failure");
    const state = await completed(prepared, [
      { path: "src/value.ts", action: "modify", content: "remote failure\n", description: "verified" },
    ]);
    const provider = new StubReviewProvider("GITHUB");
    await expect(new GitWorkflowService().ship(request(prepared, state, {
      mode: "CREATE_REVIEW",
      remote: "missing",
      reviewProvider: provider,
    }))).rejects.toMatchObject({ code: "GIT_REMOTE_NOT_FOUND" });
    expect(provider.calls).toEqual([]);
    expect(state.runtime.snapshot()).toMatchObject({ status: "COMPLETED", terminalOutcome: { type: "COMPLETED" } });
  });

  test("16, 18, 19, 21. GitHub PR receives audited metadata after push and duplicate retry is reused", async () => {
    const prepared = await prepare("github-review");
    const state = await completed(prepared, [
      { path: "src/value.ts", action: "modify", content: "github\n", description: "verified" },
    ]);
    const provider = new StubReviewProvider("GITHUB");
    const tracking = new TrackingGit();
    const result = await new GitWorkflowService(tracking).ship(request(prepared, state, {
      mode: "CREATE_REVIEW", remote: "origin", reviewProvider: provider,
    }));
    expect(result).toMatchObject({ provider: "GITHUB", reviewId: "42", pushed: true, ciStatus: "PENDING" });
    expect(provider.request).toMatchObject({ sourceBranch: prepared.branchName, targetBranch: "main", commitSha: result.commitSha });
    expect(tracking.calls.findIndex((args) => args[0] === "push")).toBeGreaterThanOrEqual(0);
    expect(provider.calls).toEqual(["find", "create", "ci"]);

    const existing: CodeReviewMetadata = {
      provider: "GITHUB", reviewId: "42", reviewUrl: "https://review.example/42",
      sourceBranch: prepared.branchName, targetBranch: "main",
    };
    const retryProvider = new StubReviewProvider("GITHUB", existing);
    const retry = await new GitWorkflowService().ship(request(prepared, state, {
      mode: "CREATE_REVIEW", remote: "origin", reviewProvider: retryProvider,
    }));
    expect(retry.commitCreated).toBe(false);
    expect(retry.reviewId).toBe("42");
    expect(retryProvider.calls).toEqual(["find", "ci"]);
    const failedCi = await new GitWorkflowService().ship(request(prepared, state, {
      mode: "CREATE_REVIEW", remote: "origin", reviewProvider: new StubReviewProvider("GITHUB", existing, "FAILED"),
    }));
    expect(failedCi.ciStatus).toBe("FAILED");
    expect(state.runtime.snapshot().status).toBe("COMPLETED");
  });

  test("17, 20. provider adapters distinguish GitHub PR/GitLab MR and never log credentials", async () => {
    const requests: Array<{ url: string; headers: Readonly<Record<string, string>>; body?: string }> = [];
    const transport = async (
      url: string,
      init: { readonly method: string; readonly headers: Readonly<Record<string, string>>; readonly body?: string },
    ): Promise<ReviewHttpResponse> => {
      requests.push({ url, headers: init.headers, body: init.body });
      return {
        ok: true,
        status: 200,
        json: async () => url.includes("merge_requests")
          ? { iid: 7, web_url: "https://gitlab.example/mr/7" }
          : { number: 6, html_url: "https://github.example/pr/6" },
      };
    };
    const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const reviewRequest: CodeReviewRequest = {
      sourceBranch: "anka/run-provider", targetBranch: "main", commitSha: "a".repeat(40),
      title: "verified", body: "audit facts", shippingId: "provider",
    };
    const github = new GitHubCodeReviewProvider("anka", "repo", () => "ghp_SUPERSECRET", transport);
    const gitlab = new GitLabCodeReviewProvider("anka/repo", () => "glpat-SUPERSECRET", transport);
    expect(await github.createReview(reviewRequest)).toMatchObject({ provider: "GITHUB", reviewId: "6" });
    expect(await gitlab.createReview(reviewRequest)).toMatchObject({ provider: "GITLAB", reviewId: "7" });
    expect(requests[0].body).toContain('"head":"anka/run-provider"');
    expect(requests[1].body).toContain('"source_branch":"anka/run-provider"');
    expect(consoleSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(requests.map((item) => ({ url: item.url, body: item.body })))).not.toContain("SUPERSECRET");
  });

  test("24. collision and cleanup ownership cannot delete unrelated worktrees, branches, or directories", async () => {
    const prepared = await prepare("owned-cleanup");
    const unrelated = path.join(GitWorktreeService.getRunsRoot(), "unrelated-cp11-directory");
    fs.mkdirSync(unrelated, { recursive: true });
    fs.writeFileSync(path.join(unrelated, "keep.txt"), "keep", "utf8");
    await expect(GitWorktreeService.prepareRepositoryRun({ repositoryPath: source, runId: "owned-cleanup" }))
      .rejects.toThrow(/WORKTREE_COLLISION/);
    await GitWorktreeService.cleanupWorktree(unrelated, source, "anka/run-unrelated", "unrelated-cp11-directory");
    expect(fs.existsSync(path.join(unrelated, "keep.txt"))).toBe(true);
    expect(run(source, ["show-ref", "--verify", `refs/heads/${prepared.branchName}`])).toBeTruthy();
    fs.rmSync(unrelated, { recursive: true, force: true });
  });

  test("25. target branch movement is detected without merge/rebase/integration", async () => {
    const prepared = await prepare("target-moved");
    const state = await completed(prepared, [
      { path: "src/value.ts", action: "modify", content: "task\n", description: "verified" },
    ]);
    fs.writeFileSync(path.join(source, "root-change.txt"), "target moved\n", "utf8");
    run(source, ["add", "--", "root-change.txt"]);
    run(source, ["commit", "-m", "move target"]);
    await expect(new GitWorkflowService().ship(request(prepared, state))).rejects.toMatchObject({ code: "GIT_BASE_REVISION_CHANGED" });
    expect(run(prepared.worktreePath, ["rev-parse", "HEAD"])).toBe(baseRevision);
  });

  test("30. CP5-CP10 authority boundaries remain imports, not Git-owned capabilities", () => {
    const workflow = fs.readFileSync(path.resolve(__dirname, "../../services/git-workflow.service.ts"), "utf8");
    const aiController = fs.readFileSync(path.resolve(__dirname, "../../controllers/ai-controller.ts"), "utf8");
    const projectController = fs.readFileSync(path.resolve(__dirname, "../../controllers/project-controller.ts"), "utf8");
    const githubService = fs.readFileSync(path.resolve(__dirname, "../../services/github.service.ts"), "utf8");
    expect(workflow).not.toMatch(/AgentResponse|FileManifest|ManifestGenerator|CapabilityGuard|EditingPrimitives|ValidationCoordinator\.validate|CompletionEvaluator\.evaluate/);
    expect(workflow).not.toMatch(/--no-verify|--force(?:-with-lease)?|\["(?:merge|rebase|cherry-pick)"/);
    expect(aiController).not.toMatch(/ProjectGitHubService\.pushChanges/);
    expect(projectController).not.toMatch(/ProjectGitHubService\.pushChanges/);
    expect(githubService).toContain("GIT_WORKFLOW_REQUIRED: Commits must be created from verified isolated-worktree disk reality");
    expect(sha256(workflow)).toHaveLength(64);
  });
});
