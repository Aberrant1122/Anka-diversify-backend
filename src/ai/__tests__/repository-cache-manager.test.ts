import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";
import { RepositoryCacheManager } from "../../services/repository-cache.manager";
import { RepositoryMaterializationService } from "../../services/repository-materialization.service";
import { prisma } from "../../services/database";

jest.setTimeout(30000);

describe("Ephemeral Repository Cache Manager with TTL (Step 1 of 3: Tests A-L)", () => {
  let testCacheRoot: string;
  let fakeRemoteOrigin: string;

  beforeEach(() => {
    testCacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anka-test-cache-root-"));
    process.env.ANKA_REPO_CACHE_DIR = testCacheRoot;
    process.env.ANKA_REPO_CACHE_TTL_MS = "1800000"; // 30 minutes

    // Create a local bare repository as fake remote origin with default HEAD = refs/heads/main
    fakeRemoteOrigin = fs.mkdtempSync(path.join(os.tmpdir(), "anka-fake-remote-origin-"));
    execSync("git init --bare", { cwd: fakeRemoteOrigin });
    try {
      execSync("git symbolic-ref HEAD refs/heads/main", { cwd: fakeRemoteOrigin });
    } catch {}

    // Seed initial commit in a temp working repo and push to bare remote
    const seedDir = fs.mkdtempSync(path.join(os.tmpdir(), "anka-seed-repo-"));
    execSync("git init", { cwd: seedDir });
    try {
      execSync("git checkout -B main", { cwd: seedDir });
    } catch {}
    execSync('git config user.email "test@example.com"', { cwd: seedDir });
    execSync('git config user.name "Test User"', { cwd: seedDir });
    fs.writeFileSync(path.join(seedDir, "package.json"), JSON.stringify({ name: "test-app", version: "1.0.0" }));
    fs.writeFileSync(path.join(seedDir, "README.md"), "# Initial commit");
    execSync('git add . && git commit -m "Initial_commit"', { cwd: seedDir });
    execSync(`git remote add origin "${fakeRemoteOrigin}"`, { cwd: seedDir });
    execSync("git push origin main || git push origin master:main", { cwd: seedDir });

    try {
      fs.rmSync(seedDir, { recursive: true, force: true });
    } catch {}
  });

  afterEach(() => {
    try {
      fs.rmSync(testCacheRoot, { recursive: true, force: true });
    } catch {}
    try {
      fs.rmSync(fakeRemoteOrigin, { recursive: true, force: true });
    } catch {}
    delete process.env.ANKA_REPO_CACHE_DIR;
    delete process.env.ANKA_REPO_CACHE_TTL_MS;
    jest.restoreAllMocks();
  });

  test("A. Managed path resolves to ephemeral cache root under os.tmpdir()/anka/repo-cache/<projectId>", () => {
    delete process.env.ANKA_REPO_CACHE_DIR;
    const defaultPath = RepositoryMaterializationService.getManagedRepositoryPath("proj-123");
    expect(defaultPath).toBe(path.join(os.tmpdir(), "anka", "repo-cache", "proj-123"));

    process.env.ANKA_REPO_CACHE_DIR = testCacheRoot;
    const customPath = RepositoryMaterializationService.getManagedRepositoryPath("proj-123");
    expect(customPath).toBe(path.join(testCacheRoot, "proj-123"));
  });

  test("B. First access clones when cache is absent", async () => {
    const projectId = "proj-clone-init";
    jest.spyOn(prisma.project, "findUnique").mockResolvedValue({
      id: projectId,
      name: "Clone Init Project",
      localPath: null,
      githubUrl: fakeRemoteOrigin,
      githubToken: null,
    } as any);

    const projectCacheDir = RepositoryCacheManager.getProjectCachePath(projectId);
    expect(fs.existsSync(projectCacheDir)).toBe(false);

    const res = await RepositoryMaterializationService.ensureProjectRepositoryCurrent(projectId);
    expect(res.success).toBe(true);
    expect(fs.existsSync(path.join(projectCacheDir, ".git"))).toBe(true);
    expect(fs.existsSync(path.join(projectCacheDir, "package.json"))).toBe(true);

    const meta = RepositoryCacheManager.readMeta(projectId);
    expect(meta).toBeDefined();
    expect(meta?.projectId).toBe(projectId);
    expect(typeof meta?.lastUsedAt).toBe("number");
  });

  test("C & D. Fresh cache is reused and fetch/reset synchronizes remote HEAD before reuse", async () => {
    const projectId = "proj-fresh-reuse";
    jest.spyOn(prisma.project, "findUnique").mockResolvedValue({
      id: projectId,
      name: "Fresh Reuse Project",
      localPath: null,
      githubUrl: fakeRemoteOrigin,
      githubToken: null,
    } as any);

    // Initial materialization
    const res1 = await RepositoryMaterializationService.ensureProjectRepositoryCurrent(projectId);
    expect(res1.success).toBe(true);
    const head1 = res1.metadata?.headSha;
    expect(head1).toBeDefined();

    // Push a new commit to fake remote origin from outside
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "anka-outside-work-"));
    execSync(`git clone "${fakeRemoteOrigin}" "${outsideDir}"`);
    execSync('git config user.email "test@example.com"', { cwd: outsideDir });
    execSync('git config user.name "Test User"', { cwd: outsideDir });
    fs.writeFileSync(path.join(outsideDir, "new-feature.js"), "export const feat = true;");
    execSync('git add . && git commit -m "Add_new_feature"', { cwd: outsideDir });
    execSync("git push origin main || git push origin master", { cwd: outsideDir });
    const newRemoteHead = execSync("git rev-parse HEAD", { cwd: outsideDir, encoding: "utf8" }).trim();
    expect(newRemoteHead).not.toBe(head1);
    fs.rmSync(outsideDir, { recursive: true, force: true });

    // Ensure freshness reuses existing fresh cache folder, but fetches and resets to new remote HEAD
    const res2 = await RepositoryMaterializationService.ensureProjectRepositoryCurrent(projectId);
    expect(res2.success).toBe(true);
    expect(res2.metadata?.headSha).toBe(newRemoteHead);
    const cachedFile = path.join(RepositoryCacheManager.getProjectCachePath(projectId), "new-feature.js");
    expect(fs.existsSync(cachedFile)).toBe(true);
  }, 30000);

  test("E. TTL-expired cache is removed and re-cloned on next access", async () => {
    const projectId = "proj-ttl-expired";
    jest.spyOn(prisma.project, "findUnique").mockResolvedValue({
      id: projectId,
      name: "TTL Expired Project",
      localPath: null,
      githubUrl: fakeRemoteOrigin,
      githubToken: null,
    } as any);

    // Initial materialization
    const initRes = await RepositoryMaterializationService.ensureProjectRepositoryCurrent(projectId);
    expect(initRes.success).toBe(true);
    const projectCacheDir = RepositoryCacheManager.getProjectCachePath(projectId);
    expect(fs.existsSync(path.join(projectCacheDir, ".git"))).toBe(true);

    // Artificially expire the cache by backdating lastUsedAt past TTL
    const metaFile = path.join(projectCacheDir, ".anka-cache-meta.json");
    const expiredTime = Date.now() - 2000000; // 2,000,000ms ago (> 1,800,000ms TTL)
    fs.writeFileSync(metaFile, JSON.stringify({ projectId, createdAt: expiredTime, lastUsedAt: expiredTime }), "utf8");

    expect(RepositoryCacheManager.isCacheFresh(projectId)).toBe(false);

    // Put a marker file in the expired cache directory
    const markerFile = path.join(projectCacheDir, "marker-old.txt");
    fs.writeFileSync(markerFile, "old content");

    // Next access should detect expiration, delete expired directory, and re-clone fresh
    const res = await RepositoryMaterializationService.ensureProjectRepositoryCurrent(projectId);
    expect(res.success).toBe(true);
    expect(fs.existsSync(markerFile)).toBe(false); // Old marker is gone (cache re-cloned)
    expect(fs.existsSync(path.join(projectCacheDir, ".git"))).toBe(true);
  });

  test("F. Cache last-used timestamp refreshes on access", async () => {
    const projectId = "proj-timestamp-refresh";
    jest.spyOn(prisma.project, "findUnique").mockResolvedValue({
      id: projectId,
      name: "Timestamp Refresh Project",
      localPath: null,
      githubUrl: fakeRemoteOrigin,
      githubToken: null,
    } as any);

    const initRes = await RepositoryMaterializationService.ensureProjectRepositoryCurrent(projectId);
    expect(initRes.success).toBe(true);

    const meta1 = RepositoryCacheManager.readMeta(projectId);
    expect(meta1).toBeDefined();
    expect(meta1?.lastUsedAt).toBeDefined();

    // Fast-forward timestamp check
    const olderTime = meta1!.lastUsedAt - 5000;
    const metaFile = path.join(RepositoryCacheManager.getProjectCachePath(projectId), ".anka-cache-meta.json");
    fs.writeFileSync(metaFile, JSON.stringify({ projectId, createdAt: olderTime, lastUsedAt: olderTime }), "utf8");

    // Touch
    RepositoryCacheManager.touch(projectId);
    const meta2 = RepositoryCacheManager.readMeta(projectId);
    expect(meta2!.lastUsedAt).toBeGreaterThan(olderTime);
  });

  test("G. One project's cache deletion does not delete or corrupt another project's cache", async () => {
    const projA = "proj-user-alpha";
    const projB = "proj-user-beta";

    const dirA = RepositoryCacheManager.getProjectCachePath(projA);
    const dirB = RepositoryCacheManager.getProjectCachePath(projB);

    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(dirB, { recursive: true });
    fs.writeFileSync(path.join(dirA, "alpha.txt"), "A");
    fs.writeFileSync(path.join(dirB, "beta.txt"), "B");

    await RepositoryCacheManager.removeProjectCache(projA);

    expect(fs.existsSync(dirA)).toBe(false);
    expect(fs.existsSync(dirB)).toBe(true);
    expect(fs.readFileSync(path.join(dirB, "beta.txt"), "utf8")).toBe("B");
  });

  test("H. Simultaneous same-project acquisition is serialized through in-process mutex", async () => {
    const projectId = "proj-mutex-serial";
    const executionOrder: string[] = [];

    const task1 = RepositoryCacheManager.withProjectLock(projectId, async () => {
      executionOrder.push("task1-start");
      await new Promise((resolve) => setTimeout(resolve, 50));
      executionOrder.push("task1-end");
      return "res1";
    });

    const task2 = RepositoryCacheManager.withProjectLock(projectId, async () => {
      executionOrder.push("task2-start");
      await new Promise((resolve) => setTimeout(resolve, 10));
      executionOrder.push("task2-end");
      return "res2";
    });

    const [res1, res2] = await Promise.all([task1, task2]);
    expect(res1).toBe("res1");
    expect(res2).toBe("res2");

    // Proves task 1 completely finished before task 2 started
    expect(executionOrder).toEqual(["task1-start", "task1-end", "task2-start", "task2-end"]);
  });

  test("I. External user-owned localPath remains untouched and is not moved to /tmp", async () => {
    const externalUserRepo = fs.mkdtempSync(path.join(os.tmpdir(), "anka-external-user-repo-"));
    execSync("git init", { cwd: externalUserRepo });
    execSync('git config user.email "test@example.com"', { cwd: externalUserRepo });
    execSync('git config user.name "Test User"', { cwd: externalUserRepo });
    fs.writeFileSync(path.join(externalUserRepo, "user-code.ts"), "export const user = 1;");
    execSync('git add . && git commit -m "Initial_user_commit"', { cwd: externalUserRepo });

    const projectId = "proj-external-local";
    jest.spyOn(prisma.project, "findUnique").mockResolvedValue({
      id: projectId,
      name: "External Local Project",
      localPath: externalUserRepo,
      githubUrl: null,
      githubToken: null,
    } as any);

    const res = await RepositoryMaterializationService.ensureProjectRepositoryCurrent(projectId);
    expect(res.success).toBe(true);
    expect(res.metadata?.canonicalRoot).toBe(path.resolve(externalUserRepo));
    expect(RepositoryMaterializationService.isManagedRepositoryPath(externalUserRepo)).toBe(false);

    try {
      fs.rmSync(externalUserRepo, { recursive: true, force: true });
    } catch {}
  });

  test("J. Legacy .anka-cache managed paths do not override new ephemeral cache", async () => {
    const legacyPath = path.resolve(process.cwd(), ".anka-cache", "managed-repos", "proj-legacy");
    expect(RepositoryMaterializationService.isLegacyManagedPath(legacyPath)).toBe(true);

    const projectId = "proj-legacy";
    jest.spyOn(prisma.project, "findUnique").mockResolvedValue({
      id: projectId,
      name: "Legacy Project",
      localPath: legacyPath, // Legacy DB record pointing to .anka-cache
      githubUrl: fakeRemoteOrigin,
      githubToken: null,
    } as any);

    const res = await RepositoryMaterializationService.ensureProjectRepositoryCurrent(projectId);
    expect(res.success).toBe(true);
    // Ephemeral cache manager path used instead of legacy path
    expect(res.metadata?.canonicalRoot).toBe(RepositoryCacheManager.getProjectCachePath(projectId));
  });

  test("K. Managed ephemeral path is NOT persisted into Project.localPath in database", async () => {
    const projectId = "proj-no-db-persist";
    jest.spyOn(prisma.project, "findUnique").mockResolvedValue({
      id: projectId,
      name: "No Persist Project",
      localPath: null,
      githubUrl: fakeRemoteOrigin,
      githubToken: null,
    } as any);

    const updateSpy = jest.spyOn(prisma.project, "update").mockResolvedValue({} as any);

    const res = await RepositoryMaterializationService.ensureProjectRepositoryCurrent(projectId);
    expect(res.success).toBe(true);

    // prisma.project.update must NOT be called to write the ephemeral /tmp path
    expect(updateSpy).not.toHaveBeenCalled();
  });

  test("L. Git credential/token is redacted and never present in failure messages", async () => {
    const secretToken = "ghp_superSecretToken123456789";
    const errorWithToken = `fatal: unable to access 'https://x-access-token:${secretToken}@github.com/nonexistent-org-abc/nonexistent-repo-xyz.git/': Could not resolve host`;

    // Direct verification of credential redaction helper
    const redacted = RepositoryCacheManager.redactCredentials(errorWithToken);
    expect(redacted).not.toContain(secretToken);
    expect(redacted).toContain("https://***@github.com");

    const errorWithUserPass = `fatal: Authentication failed for 'https://user:${secretToken}@github.com/org/repo.git'`;
    const redactedUserPass = RepositoryCacheManager.redactCredentials(errorWithUserPass);
    expect(redactedUserPass).not.toContain(secretToken);
    expect(redactedUserPass).toContain("https://***@github.com");

    // Integration test with invalid local path that fails immediately
    const projectId = "proj-credential-redact";
    jest.spyOn(prisma.project, "findUnique").mockResolvedValue({
      id: projectId,
      name: "Secret Project",
      localPath: null,
      githubUrl: "file:///invalid/nonexistent/git/repo/path.git",
      githubToken: null,
    } as any);

    const res = await RepositoryMaterializationService.materializeProjectRepository(projectId);
    expect(res.success).toBe(false);
    expect(res.error).toBeDefined();
    expect(res.error).not.toContain(secretToken);
  });
});
