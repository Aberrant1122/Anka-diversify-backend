import fs from "fs";
import path from "path";
import os from "os";
import { exec } from "child_process";
import { promisify } from "util";
import { GitWorktreeService, PreparedRepositoryRun } from "../../services/git-worktree.service";
import { FileSystemStateManager, RepairInfrastructureError, assertSafeWorktreePath } from "../validation/FileSystemStateManager";
import { ValidationRunner } from "../validation/ValidationRunner";
import { verifyFileVersionsFromDisk, sha256 } from "../validation/FileVersionGuard";
import { enforceExecutionScope } from "../contracts/ExecutionScopeEnforcer";
import { AgentPipeline } from "../orchestration/AgentPipeline";
import { RepositoryContextBuilder } from "../repository/RepositoryContextBuilder";
import { IntentClassifier } from "../classification/IntentClassifier";
import { CodeGenerator } from "../generation/CodeGenerator";
import { ManifestGenerator } from "../../services/manifest-generator";
import { MemoryPersistence } from "../memory/MemoryPersistence";
import { AgentFileChange, ExecutionContract, FileManifest } from "../shared/types";

const execAsync = promisify(exec);

jest.mock("@prisma/client", () => {
  return {
    PrismaClient: jest.fn().mockImplementation(() => ({
      project: {
        findUnique: jest.fn().mockResolvedValue({
          localPath: "/tmp/mock-db-path",
          githubUrl: "https://github.com/mock/repo",
          githubToken: "mock-token",
        }),
      },
      phaseArtifact: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      taskDecomposition: {
        create: jest.fn().mockResolvedValue({}),
      },
      agentManifest: {
        create: jest.fn().mockResolvedValue({}),
      },
    })),
  };
});

describe("AI Step 12 — Safe Real Repository Execution & Git Worktree Isolation", () => {
  let sourceRepoDir: string;
  let baseCommitSha: string;
  const createdWorktrees: string[] = [];

  const originalApiKey = process.env.OPENAI_API_KEY;

  beforeAll(async () => {
    // Create a real temporary Git repository
    sourceRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "anka-test-source-repo-"));
    await execAsync("git init -b main", { cwd: sourceRepoDir });
    await execAsync('git config user.name "Anka Test Runner"', { cwd: sourceRepoDir });
    await execAsync('git config user.email "runner@anka-test.local"', { cwd: sourceRepoDir });

    fs.writeFileSync(
      path.join(sourceRepoDir, "package.json"),
      JSON.stringify({ name: "test-worktree-repo", version: "1.0.0", scripts: { test: "node test.js" } }, null, 2),
      "utf8"
    );

    fs.mkdirSync(path.join(sourceRepoDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(sourceRepoDir, "src", "index.ts"), "export const appVersion = '1.0.0';\n", "utf8");
    fs.writeFileSync(path.join(sourceRepoDir, "src", "helper.ts"), "export function getGreeting() { return 'hello'; }\n", "utf8");

    fs.writeFileSync(
      path.join(sourceRepoDir, "test.js"),
      "const fs = require('fs');\nconst content = fs.readFileSync('src/index.ts', 'utf8');\nif (!content.includes('appVersion')) process.exit(1);\nconsole.log('Tests passed.');\n",
      "utf8"
    );

    await execAsync("git add .", { cwd: sourceRepoDir });
    await execAsync('git commit -m "Initial commit"', { cwd: sourceRepoDir });

    const { stdout } = await execAsync("git rev-parse HEAD", { cwd: sourceRepoDir });
    baseCommitSha = stdout.trim();
  });

  beforeEach(() => {
    process.env.OPENAI_API_KEY = "test-mock-api-key";
    jest.clearAllMocks();
    jest.spyOn(MemoryPersistence, "getOrCreateSession").mockResolvedValue({ id: "test-sess", title: "test" } as any);
    jest.spyOn(MemoryPersistence, "saveMessage").mockResolvedValue(undefined as any);
    jest.spyOn(MemoryPersistence, "persistProjectMemory").mockResolvedValue(undefined as any);
    jest.spyOn(MemoryPersistence, "updateSessionTitle").mockResolvedValue(undefined as any);
  });

  afterEach(async () => {
    process.env.OPENAI_API_KEY = originalApiKey;
    jest.restoreAllMocks();
    for (const wt of createdWorktrees) {
      await GitWorktreeService.cleanupWorktree(wt, sourceRepoDir);
    }
    createdWorktrees.length = 0;
  });

  afterAll(async () => {
    if (fs.existsSync(sourceRepoDir)) {
      try {
        fs.rmSync(sourceRepoDir, { recursive: true, force: true });
      } catch {}
    }
  });

  test("A, B, E: Valid Git repository creates isolated worktree from exact source HEAD on branch anka/run-<runId>", async () => {
    const runId = `test-run-${Date.now()}`;
    const prepared: PreparedRepositoryRun = await GitWorktreeService.prepareRepositoryRun({
      repositoryPath: sourceRepoDir,
      runId,
    });
    createdWorktrees.push(prepared.worktreePath);

    expect(prepared.repositoryRoot.toLowerCase()).toBe(path.resolve(sourceRepoDir).toLowerCase());
    expect(prepared.baseCommitSha).toBe(baseCommitSha);
    expect(prepared.branchName).toBe(`anka/run-${runId}`);
    expect(fs.existsSync(prepared.worktreePath)).toBe(true);

    // Verify worktree commit SHA matches source HEAD
    const { stdout: wtHead } = await execAsync("git rev-parse HEAD", { cwd: prepared.worktreePath });
    expect(wtHead.trim()).toBe(baseCommitSha);

    // Verify worktree branch name
    const { stdout: wtBranch } = await execAsync("git rev-parse --abbrev-ref HEAD", { cwd: prepared.worktreePath });
    expect(wtBranch.trim()).toBe(`anka/run-${runId}`);
  });

  test("C, D: Worktree receives intended modification while source repository files remain strictly byte-identical", async () => {
    const runId = `modify-run-${Date.now()}`;
    const prepared = await GitWorktreeService.prepareRepositoryRun({
      repositoryPath: sourceRepoDir,
      runId,
    });
    createdWorktrees.push(prepared.worktreePath);

    const sourceIndexPath = path.join(sourceRepoDir, "src", "index.ts");
    const sourceInitialBytes = fs.readFileSync(sourceIndexPath, "utf8");

    // Apply change strictly to worktree
    const manager = new FileSystemStateManager();
    const changes: AgentFileChange[] = [
      {
        path: "src/index.ts",
        content: "export const appVersion = '2.0.0';\nexport const modified = true;\n",
        description: "Bump version to 2.0.0",
        action: "modify",
      },
    ];

    await manager.apply(changes, prepared.worktreePath);

    // Worktree reflects change
    const wtContent = fs.readFileSync(path.join(prepared.worktreePath, "src", "index.ts"), "utf8");
    expect(wtContent).toContain("appVersion = '2.0.0'");

    // Source repository remains strictly byte-identical
    const sourceAfterBytes = fs.readFileSync(sourceIndexPath, "utf8");
    expect(sourceAfterBytes).toBe(sourceInitialBytes);
  });

  test("F: Dirty source repository is rejected with SOURCE_REPOSITORY_DIRTY without changing its files", async () => {
    // Create an uncommitted change in the source repo
    const sourceHelperPath = path.join(sourceRepoDir, "src", "helper.ts");
    const originalContent = fs.readFileSync(sourceHelperPath, "utf8");
    fs.writeFileSync(sourceHelperPath, originalContent + "// uncommitted work in progress\n", "utf8");

    try {
      await expect(
        GitWorktreeService.prepareRepositoryRun({
          repositoryPath: sourceRepoDir,
          runId: `dirty-test-${Date.now()}`,
        })
      ).rejects.toThrow(/SOURCE_REPOSITORY_DIRTY/);

      // Verify uncommitted file was NOT reset, deleted, or stashed
      const currentContent = fs.readFileSync(sourceHelperPath, "utf8");
      expect(currentContent).toContain("// uncommitted work in progress");
    } finally {
      // Restore clean state for subsequent tests
      fs.writeFileSync(sourceHelperPath, originalContent, "utf8");
    }
  });

  test("G: Path traversal outside worktree root is rejected", async () => {
    const runId = `traversal-test-${Date.now()}`;
    const prepared = await GitWorktreeService.prepareRepositoryRun({
      repositoryPath: sourceRepoDir,
      runId,
    });
    createdWorktrees.push(prepared.worktreePath);

    const manager = new FileSystemStateManager();

    // Relative escape
    expect(() => assertSafeWorktreePath("../outside.ts", prepared.worktreePath)).toThrow(RepairInfrastructureError);
    expect(() => assertSafeWorktreePath("../../production/file.ts", prepared.worktreePath)).toThrow(RepairInfrastructureError);

    // Absolute path escape
    const outsideAbs = path.resolve(sourceRepoDir, "src", "index.ts");
    expect(() => assertSafeWorktreePath(outsideAbs, prepared.worktreePath)).toThrow(RepairInfrastructureError);

    await expect(
      manager.apply([{ path: "../outside.ts", content: "bad", description: "malicious" }], prepared.worktreePath)
    ).rejects.toThrow(RepairInfrastructureError);
  });

  test("H: Generated .git and protected directory modifications are rejected", async () => {
    const runId = `protected-test-${Date.now()}`;
    const prepared = await GitWorktreeService.prepareRepositoryRun({
      repositoryPath: sourceRepoDir,
      runId,
    });
    createdWorktrees.push(prepared.worktreePath);

    const manager = new FileSystemStateManager();

    const protectedPaths = [
      ".git/config",
      ".git/HEAD",
      "node_modules/lodash/index.js",
      "dist/bundle.js",
      "build/main.js",
      "coverage/lcov.info",
    ];

    for (const p of protectedPaths) {
      expect(() => assertSafeWorktreePath(p, prepared.worktreePath)).toThrow(RepairInfrastructureError);
      await expect(
        manager.apply([{ path: p, content: "bad", description: "malicious" }], prepared.worktreePath)
      ).rejects.toThrow(RepairInfrastructureError);
    }
  });

  test("I: Validation executes strictly with cwd = worktree", async () => {
    const runId = `val-cwd-test-${Date.now()}`;
    const prepared = await GitWorktreeService.prepareRepositoryRun({
      repositoryPath: sourceRepoDir,
      runId,
    });
    createdWorktrees.push(prepared.worktreePath);

    // Modify test.js in worktree to verify cwd
    const wtTestPath = path.join(prepared.worktreePath, "test.js");
    fs.writeFileSync(
      wtTestPath,
      `const fs = require('fs');\nconst cwd = process.cwd();\nfs.writeFileSync('cwd-output.txt', cwd, 'utf8');\nconsole.log('cwd test passed');\n`,
      "utf8"
    );

    const res = await ValidationRunner.validateWithShell([], prepared.worktreePath, ["node test.js"]);
    expect(res.success).toBe(true);

    const cwdRecorded = fs.readFileSync(path.join(prepared.worktreePath, "cwd-output.txt"), "utf8");
    expect(path.resolve(cwdRecorded).toLowerCase()).toBe(path.resolve(prepared.worktreePath).toLowerCase());
    expect(fs.existsSync(path.join(sourceRepoDir, "cwd-output.txt"))).toBe(false);
  });

  test("J: Validation failure rolls worktree changes back cleanly", async () => {
    const runId = `rollback-test-${Date.now()}`;
    const prepared = await GitWorktreeService.prepareRepositoryRun({
      repositoryPath: sourceRepoDir,
      runId,
    });
    createdWorktrees.push(prepared.worktreePath);

    // Make broken edit and add new file in worktree
    const wtIndex = path.join(prepared.worktreePath, "src", "index.ts");
    const wtBroken = path.join(prepared.worktreePath, "src", "broken.ts");
    fs.writeFileSync(wtIndex, "syntax error invalid code !!!", "utf8");
    fs.writeFileSync(wtBroken, "export const broken = true;", "utf8");

    // Execute rollback
    await GitWorktreeService.rollbackWorktree(prepared.worktreePath, prepared.baseCommitSha);

    // Verify worktree is restored to baseline
    const restoredIndex = fs.readFileSync(wtIndex, "utf8").replace(/\r\n/g, "\n");
    expect(restoredIndex).toBe("export const appVersion = '1.0.0';\n");
    expect(fs.existsSync(wtBroken)).toBe(false);
  });

  test("K: Validation success leaves a reviewable git diff", async () => {
    const runId = `diff-test-${Date.now()}`;
    const prepared = await GitWorktreeService.prepareRepositoryRun({
      repositoryPath: sourceRepoDir,
      runId,
    });
    createdWorktrees.push(prepared.worktreePath);

    const wtIndex = path.join(prepared.worktreePath, "src", "index.ts");
    fs.writeFileSync(wtIndex, "export const appVersion = '1.1.0';\n", "utf8");

    const diffResult = await GitWorktreeService.getWorktreeDiff(prepared.worktreePath, prepared.baseCommitSha);

    expect(diffResult.changedFiles).toContain("src/index.ts");
    expect(diffResult.rawDiff).toContain("appVersion = '1.1.0'");
  });

  test("L: FileVersionGuard (stale source protection) works accurately inside worktree", async () => {
    const runId = `stale-guard-test-${Date.now()}`;
    const prepared = await GitWorktreeService.prepareRepositoryRun({
      repositoryPath: sourceRepoDir,
      runId,
    });
    createdWorktrees.push(prepared.worktreePath);

    const content = fs.readFileSync(path.join(prepared.worktreePath, "src", "index.ts"), "utf8");
    const validHash = sha256(content);

    // 1. Matching hash passes
    const passRes = await verifyFileVersionsFromDisk({ "src/index.ts": validHash }, prepared.worktreePath);
    expect(passRes.valid).toBe(true);

    // 2. Modified file on disk causes STALE_SOURCE_FILE rejection
    fs.writeFileSync(path.join(prepared.worktreePath, "src", "index.ts"), "export const modified = true;\n", "utf8");
    const staleRes = await verifyFileVersionsFromDisk({ "src/index.ts": validHash }, prepared.worktreePath);
    expect(staleRes.valid).toBe(false);
    if (!staleRes.valid) {
      expect(staleRes.error.code).toBe("STALE_SOURCE_FILE");
    }
  });

  test("M: ExecutionScopeEnforcer validates manifest declarations against worktree", () => {
    const manifest: FileManifest = {
      files: [{ path: "src/index.ts", action: "modify", dependencies: [], description: "update version" }],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    };

    const contract: ExecutionContract = {
      goal: "Update version",
      taskType: "BUG_FIX",
      risk: "LOW",
      estimatedComplexity: "SMALL",
      pipeline: "REPOSITORY",
      environment: "NODE_JS",
      repositoryRequired: true,
      expectedFiles: [],
      validationType: "TYPESCRIPT_BUILD",
      targetPaths: ["src/index.ts"],
      allowedActions: ["modify"],
      forbiddenActions: [],
      maxFiles: 5,
      searchScope: ["src"],
      contextScope: ["src"],
      diffCriticEnabled: true,
    };

    // Valid modify in scope
    const validCheck = enforceExecutionScope({
      proposedChanges: [{ path: "src/index.ts", content: "...", description: "fix", action: "modify" }],
      manifest,
      contract,
      existingFilePaths: ["src/index.ts", "src/helper.ts"],
    });
    expect(validCheck.valid).toBe(true);

    // Undeclared file rejected
    const invalidCheck = enforceExecutionScope({
      proposedChanges: [{ path: "src/unauthorized.ts", content: "...", description: "bad", action: "create" }],
      manifest,
      contract,
      existingFilePaths: ["src/index.ts", "src/helper.ts"],
    });
    expect(invalidCheck.valid).toBe(false);
  });

  test("N: Windows backslash paths are handled correctly and normalized", async () => {
    const runId = `win-path-test-${Date.now()}`;
    const prepared = await GitWorktreeService.prepareRepositoryRun({
      repositoryPath: sourceRepoDir.replace(/\//g, "\\"),
      runId,
    });
    createdWorktrees.push(prepared.worktreePath);

    expect(fs.existsSync(prepared.worktreePath)).toBe(true);

    // assertSafeWorktreePath handles windows backslashes
    const normalized = assertSafeWorktreePath("src\\index.ts", prepared.worktreePath);
    expect(normalized.toLowerCase()).toBe(path.resolve(prepared.worktreePath, "src/index.ts").toLowerCase());
  });
});
