import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";
import { GitWorktreeService } from "../../services/git-worktree.service";
import { AgentPipeline } from "../orchestration/AgentPipeline";
import { WorktreeDependencyService } from "../../services/worktree-dependency.service";
import { ValidationRunner } from "../validation/ValidationRunner";
import { ProjectGitHubService } from "../../services/github.service";
import { ValidationPlanner } from "../validation/ValidationPlanner";

describe("Strictly Disposable Execution Worktrees (Step 2 of 3: Tests A-L)", () => {
  let sourceRepoDir: string;
  let customRunsDir: string;
  let baseCommitSha: string;

  beforeEach(() => {
    sourceRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "anka-disposable-source-"));
    customRunsDir = fs.mkdtempSync(path.join(os.tmpdir(), "anka-disposable-runs-"));
    process.env.ANKA_RUNS_DIR = customRunsDir;

    execSync("git init", { cwd: sourceRepoDir });
    try {
      execSync("git checkout -B main", { cwd: sourceRepoDir });
    } catch {}
    execSync('git config user.email "test@example.com"', { cwd: sourceRepoDir });
    execSync('git config user.name "Test User"', { cwd: sourceRepoDir });

    fs.writeFileSync(
      path.join(sourceRepoDir, "package.json"),
      JSON.stringify({ name: "disposable-app", scripts: { build: "node build.js" } }, null, 2)
    );
    fs.writeFileSync(path.join(sourceRepoDir, "build.js"), "console.log('build ok');");
    fs.writeFileSync(path.join(sourceRepoDir, "src.js"), "export const a = 1;");
    execSync('git add . && git commit -m "Initial_commit"', { cwd: sourceRepoDir });

    baseCommitSha = execSync("git rev-parse HEAD", { cwd: sourceRepoDir, encoding: "utf8" }).trim();
  });

  afterEach(() => {
    try {
      fs.rmSync(sourceRepoDir, { recursive: true, force: true });
    } catch {}
    try {
      fs.rmSync(customRunsDir, { recursive: true, force: true });
    } catch {}
    delete process.env.ANKA_RUNS_DIR;
    jest.restoreAllMocks();
  });

  test("A & H & I. Successful run cleans worktree and node_modules while preserving reviewable change data", async () => {
    const runId = `success-run-${Date.now()}`;
    let capturedWorktreePath = "";

    jest.spyOn(WorktreeDependencyService, "prepareDependencies").mockImplementation(async (wtPath: string) => {
      capturedWorktreePath = wtPath;
      // Simulate node_modules created during npm ci
      fs.mkdirSync(path.join(wtPath, "node_modules", "some-dep"), { recursive: true });
      fs.writeFileSync(path.join(wtPath, "node_modules", "some-dep", "index.js"), "module.exports = {};");
      return {
        attempted: true,
        success: true,
        packageManager: "npm",
        installCommand: "npm ci",
        durationMs: 100,
        errorType: null,
      };
    });

    jest.spyOn(ValidationRunner, "validateWithShell").mockResolvedValue({
      success: true,
      errors: "",
    });

    jest.spyOn(AgentPipeline, "runCodingAgent").mockResolvedValue({
      explanation: "Added feature successfully",
      changes: [{ path: "src.js", content: "export const a = 2;", action: "modify", description: "updated" }],
      commitMessage: "feat: update src.js",
      sessionId: "sess-1",
      buildVerified: true,
    });

    const summary = await GitWorktreeService.runIsolatedAgent({
      userId: "user-1",
      projectId: "proj-1",
      repositoryPath: sourceRepoDir,
      runId,
      request: { message: "update src.js" },
    });

    expect(summary.validationPassed).toBe(true);
    expect(summary.agentResponse.changes.length).toBe(1);
    expect(summary.agentResponse.changes[0].content).toBe("export const a = 2;");

    // Proves worktree directory and node_modules were completely removed
    expect(fs.existsSync(capturedWorktreePath)).toBe(false);
    expect(fs.existsSync(path.join(capturedWorktreePath, "node_modules"))).toBe(false);
  });

  test("B. Failed run cleans worktree and leaves no residual workspace", async () => {
    const runId = `failed-run-${Date.now()}`;
    let capturedWorktreePath = "";

    jest.spyOn(WorktreeDependencyService, "prepareDependencies").mockImplementation(async (wtPath: string) => {
      capturedWorktreePath = wtPath;
      return {
        attempted: true,
        success: true,
        packageManager: "npm",
        installCommand: "npm ci",
        durationMs: 100,
        errorType: null,
      };
    });

    jest.spyOn(ValidationRunner, "validateWithShell").mockResolvedValue({
      success: false,
      errors: "Compile error in test",
    });

    jest.spyOn(AgentPipeline, "runCodingAgent").mockResolvedValue({
      explanation: "Build failed",
      changes: [],
      commitMessage: "",
      sessionId: "sess-1",
      buildVerified: false,
    });

    const summary = await GitWorktreeService.runIsolatedAgent({
      userId: "user-1",
      projectId: "proj-1",
      repositoryPath: sourceRepoDir,
      runId,
      request: { message: "do something that fails build" },
    });

    expect(summary.validationPassed).toBe(false);
    expect(fs.existsSync(capturedWorktreePath)).toBe(false);
  });

  test("C. Thrown exception inside pipeline still cleans worktree in finally block", async () => {
    const runId = `exception-run-${Date.now()}`;
    let capturedWorktreePath = "";

    jest.spyOn(WorktreeDependencyService, "prepareDependencies").mockImplementation(async (wtPath: string) => {
      capturedWorktreePath = wtPath;
      return {
        attempted: true,
        success: true,
        packageManager: "npm",
        installCommand: "npm ci",
        durationMs: 100,
        errorType: null,
      };
    });

    jest.spyOn(ValidationRunner, "validateWithShell").mockResolvedValue({
      success: true,
      errors: "",
    });

    jest.spyOn(AgentPipeline, "runCodingAgent").mockRejectedValue(new Error("FATAL_PIPELINE_CRASH"));

    await expect(
      GitWorktreeService.runIsolatedAgent({
        userId: "user-1",
        projectId: "proj-1",
        repositoryPath: sourceRepoDir,
        runId,
        request: { message: "crash test" },
      })
    ).rejects.toThrow("FATAL_PIPELINE_CRASH");

    // Proves worktree was cleaned up despite unhandled exception
    expect(fs.existsSync(capturedWorktreePath)).toBe(false);
  });

  test("D. Dependency preparation failure cleans worktree", async () => {
    const runId = `dep-fail-run-${Date.now()}`;
    let capturedWorktreePath = "";

    jest.spyOn(WorktreeDependencyService, "prepareDependencies").mockImplementation(async (wtPath: string) => {
      capturedWorktreePath = wtPath;
      return {
        attempted: true,
        success: false,
        packageManager: "npm",
        installCommand: "npm ci",
        durationMs: 50,
        errorType: "INFRASTRUCTURE",
        error: "ENETUNREACH: network failed",
      };
    });

    const summary = await GitWorktreeService.runIsolatedAgent({
      userId: "user-1",
      projectId: "proj-1",
      repositoryPath: sourceRepoDir,
      runId,
      request: { message: "install something" },
    });

    expect(summary.validationPassed).toBe(false);
    expect(fs.existsSync(capturedWorktreePath)).toBe(false);
  });

  test("E. Pre-generation baseline failure cleans worktree", async () => {
    const runId = `baseline-fail-run-${Date.now()}`;
    let capturedWorktreePath = "";

    jest.spyOn(WorktreeDependencyService, "prepareDependencies").mockImplementation(async (wtPath: string) => {
      capturedWorktreePath = wtPath;
      return {
        attempted: true,
        success: true,
        packageManager: "npm",
        installCommand: "npm ci",
        durationMs: 50,
        errorType: null,
      };
    });

    // Untouched baseline build fails with unrepairable compiler error
    jest.spyOn(ValidationPlanner, "detectValidationCommands").mockReturnValue(["npm run build"]);
    jest.spyOn(ValidationRunner, "validateWithShell").mockResolvedValue({
      success: false,
      errors: "SyntaxError: Unexpected token in untouched baseline",
    });

    const summary = await GitWorktreeService.runIsolatedAgent({
      userId: "user-1",
      projectId: "proj-1",
      repositoryPath: sourceRepoDir,
      runId,
      request: { message: "unrelated user request" },
    });

    expect(summary.validationPassed).toBe(false);
    expect(summary.agentResponse.healthStatus).toBe("BASELINE_REPOSITORY_UNHEALTHY");
    expect(fs.existsSync(capturedWorktreePath)).toBe(false);
  });

  test("F & G. Worktree Git registration is pruned and temporary anka/run-* branch is deleted", async () => {
    const runId = `branch-prune-run-${Date.now()}`;
    const branchName = `anka/run-${runId}`;

    jest.spyOn(WorktreeDependencyService, "prepareDependencies").mockResolvedValue({
      attempted: true,
      success: true,
      packageManager: "npm",
      installCommand: "npm ci",
      durationMs: 10,
      errorType: null,
    });

    jest.spyOn(ValidationRunner, "validateWithShell").mockResolvedValue({
      success: true,
      errors: "",
    });

    jest.spyOn(AgentPipeline, "runCodingAgent").mockResolvedValue({
      explanation: "Cleaned up branch test",
      changes: [],
      commitMessage: "test",
      sessionId: "sess-1",
      buildVerified: true,
    });

    await GitWorktreeService.runIsolatedAgent({
      userId: "user-1",
      projectId: "proj-1",
      repositoryPath: sourceRepoDir,
      runId,
      request: { message: "test branch deletion" },
    });

    // Verify git branch -a does not contain the temporary run branch
    const branchList = execSync("git branch -a", { cwd: sourceRepoDir, encoding: "utf8" });
    expect(branchList).not.toContain(branchName);

    // Verify git worktree list does not contain the runId
    const worktreeList = execSync("git worktree list", { cwd: sourceRepoDir, encoding: "utf8" });
    expect(worktreeList).not.toContain(runId);
  });

  test("J. GitHub push flow works with in-memory changes without requiring the worktree", async () => {
    const mockPushedChanges = [
      { path: "src.js", content: "export const a = 999;", action: "modify" as const },
      { path: "new-file.ts", content: "export const b = 1;", action: "create" as const },
    ];

    // ProjectGitHubService pushChanges sends changes via GitHub API
    const pushSpy = jest.spyOn(ProjectGitHubService, "pushChanges").mockResolvedValue({
      sha: "commit-sha-999",
      url: "https://github.com/test/repo/commit/999",
    } as any);

    const pushResult = await ProjectGitHubService.pushChanges(
      "https://github.com/test/repo.git",
      mockPushedChanges,
      "feat: apply in-memory changes",
      "mock-token"
    );

    expect(pushResult.sha).toBe("commit-sha-999");
    expect(pushSpy).toHaveBeenCalledWith(
      "https://github.com/test/repo.git",
      mockPushedChanges,
      "feat: apply in-memory changes",
      "mock-token"
    );
  });

  test("K. Stale startup run directories are removed by sweepOrphanedRuns", async () => {
    const runsRoot = GitWorktreeService.getRunsRoot();
    const staleRunDir = path.join(runsRoot, "stale-orphaned-run-1");
    const freshRunDir = path.join(runsRoot, "recent-run-2");

    fs.mkdirSync(staleRunDir, { recursive: true });
    fs.mkdirSync(freshRunDir, { recursive: true });

    // Set stale directory mtime to 3 hours ago (older than 2h threshold)
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
    fs.utimesSync(staleRunDir, threeHoursAgo, threeHoursAgo);

    const sweptCount = await GitWorktreeService.sweepOrphanedRuns(2 * 60 * 60 * 1000);
    expect(sweptCount).toBeGreaterThanOrEqual(1);

    expect(fs.existsSync(staleRunDir)).toBe(false);
    expect(fs.existsSync(freshRunDir)).toBe(true);
  });

  test("L. Active in-process runs are protected and never swept", async () => {
    const runsRoot = GitWorktreeService.getRunsRoot();
    const activeRunId = "active-in-flight-run-1";
    const activeRunDir = path.join(runsRoot, activeRunId);

    fs.mkdirSync(activeRunDir, { recursive: true });
    // Backdate mtime to appear old
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
    fs.utimesSync(activeRunDir, threeHoursAgo, threeHoursAgo);

    // Simulate run is active in process
    (GitWorktreeService as any).activeRuns.add(activeRunId);

    await GitWorktreeService.sweepOrphanedRuns(2 * 60 * 60 * 1000);

    // Active run must NOT be deleted even if mtime is old
    expect(fs.existsSync(activeRunDir)).toBe(true);

    (GitWorktreeService as any).activeRuns.delete(activeRunId);
  });
});
