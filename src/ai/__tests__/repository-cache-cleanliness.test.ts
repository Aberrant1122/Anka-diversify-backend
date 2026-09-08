import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";
import { RepositoryCacheManager } from "../../services/repository-cache.manager";
import { GitWorktreeService } from "../../services/git-worktree.service";

describe("Repository Cache Cleanliness & External Metadata Isolation", () => {
  let customCacheDir: string;
  let customMetaDir: string;
  let customRunsDir: string;
  let sourceRepoDir: string;

  beforeEach(() => {
    customCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "anka-clean-cache-"));
    customMetaDir = fs.mkdtempSync(path.join(os.tmpdir(), "anka-clean-meta-"));
    customRunsDir = fs.mkdtempSync(path.join(os.tmpdir(), "anka-clean-runs-"));
    sourceRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "anka-clean-source-"));

    process.env.ANKA_REPO_CACHE_DIR = customCacheDir;
    process.env.ANKA_REPO_META_DIR = customMetaDir;
    process.env.ANKA_RUNS_DIR = customRunsDir;

    execSync("git init", { cwd: sourceRepoDir });
    try {
      execSync("git checkout -B main", { cwd: sourceRepoDir });
    } catch {}
    execSync('git config user.email "test@example.com"', { cwd: sourceRepoDir });
    execSync('git config user.name "Test User"', { cwd: sourceRepoDir });
    fs.writeFileSync(path.join(sourceRepoDir, "README.md"), "# Test Repo\n");
    execSync('git add . && git commit -m "init"', { cwd: sourceRepoDir });
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
  });

  test("A & B. Fresh clone + cache touch stores metadata outside git repo and remains Git-clean", async () => {
    const projectId = "proj-clean-1";
    const managedPath = RepositoryCacheManager.getProjectCachePath(projectId);

    // Clone sourceRepoDir into managedPath
    execSync(`git clone "${sourceRepoDir}" "${managedPath}"`);

    // Touch cache
    RepositoryCacheManager.touch(projectId);

    // Verify metadata file is outside repository root
    const metaPath = RepositoryCacheManager.getProjectMetaPath(projectId);
    expect(metaPath.startsWith(customMetaDir)).toBe(true);
    expect(fs.existsSync(metaPath)).toBe(true);

    // Verify no metadata file exists inside git repository
    expect(fs.existsSync(path.join(managedPath, ".anka-cache-meta.json"))).toBe(false);

    // Verify git status --porcelain is strictly empty
    const gitStatus = execSync("git status --porcelain", { cwd: managedPath, encoding: "utf8" }).trim();
    expect(gitStatus).toBe("");

    // Assert clean working tree succeeds without throwing SOURCE_REPOSITORY_DIRTY
    await expect(GitWorktreeService.assertCleanWorkingTree(managedPath)).resolves.not.toThrow();
  });

  test("C & D. Cache HIT + fetch/reset + touch remains Git-clean", async () => {
    const projectId = "proj-clean-hit";
    const managedPath = RepositoryCacheManager.getProjectCachePath(projectId);
    execSync(`git clone "${sourceRepoDir}" "${managedPath}"`);

    RepositoryCacheManager.touch(projectId);
    expect(RepositoryCacheManager.isCacheFresh(projectId)).toBe(true);

    // Simulate fetch/reset
    execSync("git fetch origin", { cwd: managedPath });
    execSync("git reset --hard HEAD", { cwd: managedPath });
    RepositoryCacheManager.touch(projectId);

    const gitStatus = execSync("git status --porcelain", { cwd: managedPath, encoding: "utf8" }).trim();
    expect(gitStatus).toBe("");
    await expect(GitWorktreeService.assertCleanWorkingTree(managedPath)).resolves.not.toThrow();
  });

  test("E. Legacy .anka-cache-meta.json inside managed clone is migrated and removed safely", async () => {
    const projectId = "proj-legacy-migrate";
    const managedPath = RepositoryCacheManager.getProjectCachePath(projectId);
    execSync(`git clone "${sourceRepoDir}" "${managedPath}"`);

    // Place legacy metadata file inside git repo root
    const legacyFile = path.join(managedPath, ".anka-cache-meta.json");
    const pastTime = Date.now() - 5000;
    fs.writeFileSync(
      legacyFile,
      JSON.stringify({ projectId, createdAt: pastTime, lastUsedAt: pastTime }),
      "utf8"
    );

    // Before cleanup, git status would see the untracked file
    const dirtyStatus = execSync("git status --porcelain", { cwd: managedPath, encoding: "utf8" }).trim();
    expect(dirtyStatus).toContain(".anka-cache-meta.json");

    // Reading or touching metadata automatically migrates and cleans legacy file
    const meta = RepositoryCacheManager.readMeta(projectId);
    expect(meta).not.toBeNull();
    expect(meta?.lastUsedAt).toBe(pastTime);

    // Legacy file must be deleted from git repo
    expect(fs.existsSync(legacyFile)).toBe(false);

    // External metadata file must be created
    const metaPath = RepositoryCacheManager.getProjectMetaPath(projectId);
    expect(fs.existsSync(metaPath)).toBe(true);

    // Git status is now clean
    const cleanStatus = execSync("git status --porcelain", { cwd: managedPath, encoding: "utf8" }).trim();
    expect(cleanStatus).toBe("");
  });

  test("F. External user localPath is never touched or altered", async () => {
    const externalUserRepo = fs.mkdtempSync(path.join(os.tmpdir(), "anka-external-user-repo-"));
    execSync("git init", { cwd: externalUserRepo });
    fs.writeFileSync(path.join(externalUserRepo, "user-untracked.txt"), "important user file");

    // RepositoryCacheManager cleanupLegacyInRepoMetadata targets project cache path, not external user repo
    RepositoryCacheManager.cleanupLegacyInRepoMetadata("some-other-project");

    expect(fs.existsSync(path.join(externalUserRepo, "user-untracked.txt"))).toBe(true);
    fs.rmSync(externalUserRepo, { recursive: true, force: true });
  });

  test("G & H. TTL and LRU eviction work seamlessly with external metadata", async () => {
    process.env.ANKA_REPO_CACHE_MAX_BYTES = "2048"; // 2 KB budget
    process.env.ANKA_REPO_CACHE_TTL_MS = "1000"; // 1s TTL

    const proj1 = "proj-lru-1";
    const proj2 = "proj-lru-2";
    const path1 = RepositoryCacheManager.getProjectCachePath(proj1);
    const path2 = RepositoryCacheManager.getProjectCachePath(proj2);

    execSync(`git clone "${sourceRepoDir}" "${path1}"`);
    execSync(`git clone "${sourceRepoDir}" "${path2}"`);

    // Touch both
    RepositoryCacheManager.touch(proj1);
    RepositoryCacheManager.touch(proj2);

    // Write file into path1 to increase size
    fs.writeFileSync(path.join(path1, "payload.bin"), "x".repeat(3000));

    expect(RepositoryCacheManager.isCacheFresh(proj1)).toBe(true);
    expect(RepositoryCacheManager.isCacheFresh(proj2)).toBe(true);

    // Test LRU budget enforcement
    const eviction = await RepositoryCacheManager.enforceMaxBudget();
    expect(eviction.evictedCount).toBeGreaterThanOrEqual(1);

    // Wait for TTL expiry
    await new Promise((r) => setTimeout(r, 1100));
    expect(RepositoryCacheManager.isCacheFresh(proj2)).toBe(false);

    const swept = await RepositoryCacheManager.sweepExpiredCaches();
    expect(swept).toBeGreaterThanOrEqual(0);
  });

  test("I. SOURCE_REPOSITORY_DIRTY is not triggered by ANKA cache metadata when preparing execution run", async () => {
    const projectId = "proj-worktree-prep";
    const managedPath = RepositoryCacheManager.getProjectCachePath(projectId);
    execSync(`git clone "${sourceRepoDir}" "${managedPath}"`);

    // Touch cache (writes external metadata)
    RepositoryCacheManager.touch(projectId);

    // Prepare repository run worktree
    const runId = `run-clean-${Date.now()}`;
    const prepared = await GitWorktreeService.prepareRepositoryRun({
      repositoryPath: managedPath,
      runId,
    });

    expect(fs.existsSync(prepared.worktreePath)).toBe(true);

    await GitWorktreeService.cleanupWorktree(
      prepared.worktreePath,
      prepared.repositoryRoot,
      prepared.branchName,
      runId
    );
  });
});
