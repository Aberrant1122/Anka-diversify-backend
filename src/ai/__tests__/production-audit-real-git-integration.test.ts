import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";
import { RepositoryCacheManager } from "../../services/repository-cache.manager";
import { RepositoryMaterializationService } from "../../services/repository-materialization.service";
import { GitWorktreeService } from "../../services/git-worktree.service";
import { RuntimePreflightService } from "../../services/runtime-preflight.service";
import { ProjectGitHubService } from "../../services/github.service";

describe("Production Audit — Real Git End-to-End Integration", () => {
  jest.setTimeout(30000);
  let customCacheDir: string;
  let customMetaDir: string;
  let customRunsDir: string;
  let sourceRepoDir: string;

  beforeEach(() => {
    customCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "anka-audit-cache-"));
    customMetaDir = fs.mkdtempSync(path.join(os.tmpdir(), "anka-audit-meta-"));
    customRunsDir = fs.mkdtempSync(path.join(os.tmpdir(), "anka-audit-runs-"));
    sourceRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "anka-audit-source-"));

    process.env.ANKA_REPO_CACHE_DIR = customCacheDir;
    process.env.ANKA_REPO_META_DIR = customMetaDir;
    process.env.ANKA_RUNS_DIR = customRunsDir;

    // 1. Initialize real Git source repository
    execSync("git init", { cwd: sourceRepoDir });
    try {
      execSync("git checkout -B main", { cwd: sourceRepoDir });
    } catch {}
    execSync('git config user.email "audit@example.com"', { cwd: sourceRepoDir });
    execSync('git config user.name "Audit Test"', { cwd: sourceRepoDir });
    fs.writeFileSync(path.join(sourceRepoDir, "app.ts"), 'console.log("initial");\n');
    execSync('git add . && git commit -m "initial commit"', { cwd: sourceRepoDir });
  });

  afterEach(() => {
    try {
      fs.rmSync(customCacheDir, { recursive: true, force: true });
    } catch {}
    try {
      fs.rmSync(customMetaDir, { recursive: true, force: true });
    } catch {}
    try {
      fs.rmSync(customRunsDir, { recursive: true, force: true });
    } catch {}
    try {
      fs.rmSync(sourceRepoDir, { recursive: true, force: true });
    } catch {}

    delete process.env.ANKA_REPO_CACHE_DIR;
    delete process.env.ANKA_REPO_META_DIR;
    delete process.env.ANKA_RUNS_DIR;
    delete process.env.ANKA_REPO_CACHE_MAX_BYTES;
    delete process.env.ANKA_REPO_CACHE_TTL_MS;
    jest.restoreAllMocks();
  });

  test("1-12. Real Git lifecycle: clone, touch, clean status, worktree, modify, diff, cleanup, clean parent", async () => {
    const projectId = "proj-audit-real";
    const managedPath = RepositoryCacheManager.getProjectCachePath(projectId);

    // 3. Create managed cache clone
    execSync(`git clone "${sourceRepoDir}" "${managedPath}"`);
    expect(fs.existsSync(path.join(managedPath, ".git"))).toBe(true);

    // 4. Cache touch
    RepositoryCacheManager.touch(projectId);

    // 5. Git status remains strictly clean (no untracked metadata files)
    const statusBefore = execSync("git status --porcelain", { cwd: managedPath, encoding: "utf8" }).trim();
    expect(statusBefore).toBe("");

    // 6. Create real worktree
    const runId = "audit-run-1";
    const prepared = await GitWorktreeService.prepareRepositoryRun({
      repositoryPath: managedPath,
      runId,
    });

    expect(fs.existsSync(prepared.worktreePath)).toBe(true);
    expect(prepared.worktreePath.startsWith(customRunsDir)).toBe(true);

    // 7. Execute real file modification inside worktree
    const worktreeFile = path.join(prepared.worktreePath, "app.ts");
    fs.writeFileSync(worktreeFile, 'console.log("modified by agent");\n');

    // 8. Collect real Git diff
    const diffInfo = await GitWorktreeService.getWorktreeDiff(prepared.worktreePath, prepared.baseCommitSha);
    expect(diffInfo.changedFiles).toContain("app.ts");
    expect(diffInfo.rawDiff).toContain('+console.log("modified by agent");');

    // 9. Cleanup worktree
    await GitWorktreeService.cleanupWorktree(
      prepared.worktreePath,
      prepared.repositoryRoot,
      prepared.branchName,
      runId
    );

    // 10. Parent repository remains valid and 100% clean
    const statusAfter = execSync("git status --porcelain", { cwd: managedPath, encoding: "utf8" }).trim();
    expect(statusAfter).toBe("");

    // 11. Temp branch removed from parent repo
    const branches = execSync("git branch", { cwd: managedPath, encoding: "utf8" });
    expect(branches).not.toContain(prepared.branchName);

    // 12. Run directory recursively removed
    expect(fs.existsSync(prepared.worktreePath)).toBe(false);
  });

  test("13. Active lease held during execution strictly prevents eviction / TTL deletion", async () => {
    const projectId = "proj-lease-protection";
    const managedPath = RepositoryCacheManager.getProjectCachePath(projectId);
    execSync(`git clone "${sourceRepoDir}" "${managedPath}"`);

    // Backdate timestamp past TTL (artificially expired)
    const metaPath = RepositoryCacheManager.getProjectMetaPath(projectId);
    const longAgo = Date.now() - 10000000;
    fs.writeFileSync(metaPath, JSON.stringify({ projectId, createdAt: longAgo, lastUsedAt: longAgo }), "utf8");

    expect(RepositoryCacheManager.isCacheFresh(projectId)).toBe(false);

    // Enter active lease
    await RepositoryCacheManager.withLease(projectId, async () => {
      expect(RepositoryCacheManager.isProjectActive(projectId)).toBe(true);

      // Trigger TTL sweep while leased
      const swept = await RepositoryCacheManager.sweepExpiredCaches();
      expect(swept).toBe(0);
      expect(fs.existsSync(managedPath)).toBe(true);

      // Trigger LRU max budget eviction while leased
      process.env.ANKA_REPO_CACHE_MAX_BYTES = "10";
      const eviction = await RepositoryCacheManager.enforceMaxBudget();
      expect(eviction.evictedCount).toBe(0);
      expect(fs.existsSync(managedPath)).toBe(true);
    });

    // Once lease is released, sweep can now evict
    expect(RepositoryCacheManager.isProjectActive(projectId)).toBe(false);
    const postSwept = await RepositoryCacheManager.sweepExpiredCaches();
    expect(postSwept).toBe(1);
    expect(fs.existsSync(managedPath)).toBe(false);
  });

  test("14. Concurrent runs on the same project maintain active protection until all runs complete", async () => {
    const projectId = "proj-concurrent";
    const managedPath = RepositoryCacheManager.getProjectCachePath(projectId);
    execSync(`git clone "${sourceRepoDir}" "${managedPath}"`);

    RepositoryCacheManager.acquireLease(projectId); // Run 1
    RepositoryCacheManager.acquireLease(projectId); // Run 2

    expect(RepositoryCacheManager.isProjectActive(projectId)).toBe(true);

    RepositoryCacheManager.releaseLease(projectId); // Run 1 finishes
    expect(RepositoryCacheManager.isProjectActive(projectId)).toBe(true); // Still active for Run 2!

    RepositoryCacheManager.releaseLease(projectId); // Run 2 finishes
    expect(RepositoryCacheManager.isProjectActive(projectId)).toBe(false); // Now inactive
  });

  test("15. Credential redaction sanitizes tokens across URLs and raw strings", () => {
    const raw1 = "Failed to clone https://x-access-token:ghp_SuperSecretPAT123456789@github.com/org/repo.git";
    const raw2 = "Error: Invalid token github_pat_11ABCD1234567890_XYZxyzSecret";
    const raw3 = "https://user:password123@example.com/repo.git";

    expect(RepositoryCacheManager.redactCredentials(raw1)).not.toContain("ghp_SuperSecretPAT123456789");
    expect(RepositoryCacheManager.redactCredentials(raw1)).toContain("https://***@github.com/org/repo.git");

    expect(RepositoryCacheManager.redactCredentials(raw2)).not.toContain("github_pat_11ABCD1234567890_XYZxyzSecret");
    expect(RepositoryCacheManager.redactCredentials(raw2)).toContain("***");

    expect(RepositoryCacheManager.redactCredentials(raw3)).not.toContain("password123");
  });

  test("16. isManagedRepositoryPath accurately differentiates managed cache vs external user repo", () => {
    const managedPath = RepositoryCacheManager.getProjectCachePath("test-proj");
    const externalUserRepo = path.join(os.tmpdir(), "user-custom-workspace");

    expect(RepositoryMaterializationService.isManagedRepositoryPath(managedPath)).toBe(true);
    expect(RepositoryMaterializationService.isManagedRepositoryPath(externalUserRepo)).toBe(false);
  });
});
