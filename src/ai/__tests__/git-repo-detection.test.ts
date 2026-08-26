import fs from "fs";
import path from "path";
import os from "os";
import { exec } from "child_process";
import { promisify } from "util";
import { GitWorktreeService } from "../../services/git-worktree.service";
import { CodingAgent } from "../application/CodingAgent";
import { AgentPipeline } from "../orchestration/AgentPipeline";
import { prisma } from "../../services/database";

const execAsync = promisify(exec);

jest.mock("../../services/database", () => ({
  prisma: {
    project: {
      findUnique: jest.fn(),
    },
  },
}));

describe("AI Step 13C & Safety Fix — Fail-Closed Git Repository Detection & No User Bypass", () => {
  let mainRepoDir: string;
  let subDir: string;
  let linkedWorktreeDir: string;
  let nonGitDir: string;

  beforeAll(async () => {
    // 1. Create main Git repository
    mainRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "anka-git-detect-main-"));
    await execAsync("git init -b main", { cwd: mainRepoDir });
    await execAsync('git config user.name "Anka Runner"', { cwd: mainRepoDir });
    await execAsync('git config user.email "runner@anka.local"', { cwd: mainRepoDir });

    fs.writeFileSync(path.join(mainRepoDir, "package.json"), JSON.stringify({ name: "test-main" }, null, 2), "utf8");

    subDir = path.join(mainRepoDir, "src", "nested", "controllers");
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, "app.ts"), "export const x = 1;\n", "utf8");

    await execAsync("git add .", { cwd: mainRepoDir });
    await execAsync('git commit -m "Initial commit"', { cwd: mainRepoDir });

    // 2. Create linked Git worktree (where .git is a file)
    linkedWorktreeDir = path.join(os.tmpdir(), `anka-linked-wt-${Date.now()}`);
    await execAsync(`git worktree add -b test-linked-wt "${linkedWorktreeDir}" HEAD`, { cwd: mainRepoDir });

    // 3. Create non-git plain directory
    nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), "anka-plain-nongit-"));
    fs.writeFileSync(path.join(nonGitDir, "index.js"), "console.log('not git');", "utf8");
  });

  afterAll(async () => {
    try {
      await execAsync(`git worktree remove --force "${linkedWorktreeDir}"`, { cwd: mainRepoDir });
    } catch {}
    try {
      if (fs.existsSync(linkedWorktreeDir)) fs.rmSync(linkedWorktreeDir, { recursive: true, force: true });
      if (fs.existsSync(mainRepoDir)) fs.rmSync(mainRepoDir, { recursive: true, force: true });
      if (fs.existsSync(nonGitDir)) fs.rmSync(nonGitDir, { recursive: true, force: true });
    } catch {}
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("1. Normal Git root is detected via Git itself", async () => {
    const root = await GitWorktreeService.resolveRepositoryRoot(mainRepoDir);
    expect(root.toLowerCase()).toBe(path.resolve(mainRepoDir).toLowerCase());

    const isGit = await GitWorktreeService.isGitRepository(mainRepoDir);
    expect(isGit).toBe(true);
  });

  test("2. Subdirectory inside a Git repo resolves to the canonical repository root", async () => {
    const root = await GitWorktreeService.resolveRepositoryRoot(subDir);
    expect(root.toLowerCase()).toBe(path.resolve(mainRepoDir).toLowerCase());

    const isGit = await GitWorktreeService.isGitRepository(subDir);
    expect(isGit).toBe(true);
  });

  test("3. Linked Git worktree where .git is a FILE is correctly detected and resolved", async () => {
    const gitStat = fs.statSync(path.join(linkedWorktreeDir, ".git"));
    expect(gitStat.isFile()).toBe(true); // .git is a file in linked worktrees

    const root = await GitWorktreeService.resolveRepositoryRoot(linkedWorktreeDir);
    expect(root.toLowerCase()).toBe(path.resolve(linkedWorktreeDir).toLowerCase());

    const isGit = await GitWorktreeService.isGitRepository(linkedWorktreeDir);
    expect(isGit).toBe(true);
  });

  test("A. request.context.directExecution=true does NOT bypass worktree isolation", async () => {
    (prisma.project.findUnique as jest.Mock).mockResolvedValue({
      localPath: nonGitDir,
    });

    const pipelineSpy = jest.spyOn(AgentPipeline, "runCodingAgent");

    // Even if user sends directExecution: true in request payload, non-Git path must still fail closed
    await expect(
      CodingAgent.runCodingAgent("user-1", "proj-1", {
        message: "bypass attempt",
        context: { directExecution: true } as any,
      })
    ).rejects.toThrow(/GIT_REPOSITORY_REQUIRED/);

    expect(pipelineSpy).not.toHaveBeenCalled();
  });

  test("B. request.context.isEvalFixture=true does NOT bypass worktree isolation", async () => {
    (prisma.project.findUnique as jest.Mock).mockResolvedValue({
      localPath: nonGitDir,
    });

    const pipelineSpy = jest.spyOn(AgentPipeline, "runCodingAgent");

    await expect(
      CodingAgent.runCodingAgent("user-1", "proj-1", {
        message: "bypass attempt 2",
        context: { isEvalFixture: true } as any,
      })
    ).rejects.toThrow(/GIT_REPOSITORY_REQUIRED/);

    expect(pipelineSpy).not.toHaveBeenCalled();
  });

  test("C. request.context.effectiveLocalPath does NOT redirect a normal user-facing run", async () => {
    (prisma.project.findUnique as jest.Mock).mockResolvedValue({
      localPath: nonGitDir,
    });

    const pipelineSpy = jest.spyOn(AgentPipeline, "runCodingAgent");

    await expect(
      CodingAgent.runCodingAgent("user-1", "proj-1", {
        message: "bypass attempt 3",
        context: { effectiveLocalPath: "/tmp/fake" } as any,
      })
    ).rejects.toThrow(/GIT_REPOSITORY_REQUIRED/);

    expect(pipelineSpy).not.toHaveBeenCalled();
  });

  test("D. Trusted backend internalOptions and runDirectAgent still work for EvalRunner/tests", async () => {
    (prisma.project.findUnique as jest.Mock).mockResolvedValue({
      localPath: nonGitDir,
    });

    const pipelineSpy = jest.spyOn(AgentPipeline, "runCodingAgent").mockResolvedValue({
      explanation: "trusted direct pass",
      changes: [],
      commitMessage: "test",
      sessionId: "s-1",
    });

    // 1. Via internalOptions argument
    const response1 = await CodingAgent.runCodingAgent(
      "user-1",
      "proj-1",
      { message: "trusted test" },
      undefined,
      { allowDirectExecution: true }
    );
    expect(response1.explanation).toBe("trusted direct pass");

    // 2. Via runDirectAgent
    const response2 = await CodingAgent.runDirectAgent("user-1", "proj-1", { message: "trusted direct test" });
    expect(response2.explanation).toBe("trusted direct pass");

    expect(pipelineSpy).toHaveBeenCalledTimes(2);
  });

  test("E. Git worktree preparation error fails closed and does NOT fall back to direct writes", async () => {
    (prisma.project.findUnique as jest.Mock).mockResolvedValue({
      localPath: mainRepoDir,
    });

    const dirtyFile = path.join(mainRepoDir, "dirty.txt");
    fs.writeFileSync(dirtyFile, "uncommitted changes", "utf8");

    const pipelineSpy = jest.spyOn(AgentPipeline, "runCodingAgent");

    try {
      await expect(
        CodingAgent.runCodingAgent("user-1", "proj-1", { message: "fix something" })
      ).rejects.toThrow(/SOURCE_REPOSITORY_DIRTY/);

      expect(pipelineSpy).not.toHaveBeenCalled();
    } finally {
      if (fs.existsSync(dirtyFile)) fs.rmSync(dirtyFile);
    }
  });

  test("F. Non-Git user-facing repository is rejected with GIT_REPOSITORY_REQUIRED", async () => {
    (prisma.project.findUnique as jest.Mock).mockResolvedValue({
      localPath: nonGitDir,
    });

    const pipelineSpy = jest.spyOn(AgentPipeline, "runCodingAgent");

    await expect(
      CodingAgent.runCodingAgent("user-1", "proj-1", { message: "add feature" })
    ).rejects.toThrow(/GIT_REPOSITORY_REQUIRED/);

    expect(pipelineSpy).not.toHaveBeenCalled();
  });
});
