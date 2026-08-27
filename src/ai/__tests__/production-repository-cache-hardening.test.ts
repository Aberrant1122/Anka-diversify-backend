import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";
import { RepositoryCacheManager } from "../../services/repository-cache.manager";
import { RuntimePreflightService } from "../../services/runtime-preflight.service";
import { GitWorktreeService } from "../../services/git-worktree.service";

describe("Production Ephemeral Repository Cache Hardening (Step 3 of 3)", () => {
  let customCacheDir: string;
  let customRunsDir: string;

  beforeEach(() => {
    customCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "anka-prod-cache-"));
    customRunsDir = fs.mkdtempSync(path.join(os.tmpdir(), "anka-prod-runs-"));
    process.env.ANKA_REPO_CACHE_DIR = customCacheDir;
    process.env.ANKA_RUNS_DIR = customRunsDir;
    RuntimePreflightService.resetCache();
  });

  afterEach(() => {
    try {
      fs.rmSync(customCacheDir, { recursive: true, force: true });
    } catch {}
    try {
      fs.rmSync(customRunsDir, { recursive: true, force: true });
    } catch {}
    delete process.env.ANKA_REPO_CACHE_DIR;
    delete process.env.ANKA_RUNS_DIR;
    delete process.env.ANKA_REPO_CACHE_MAX_BYTES;
    delete process.env.ANKA_REPO_CACHE_TTL_MS;
    RuntimePreflightService.resetCache();
    jest.restoreAllMocks();
  });

  test("1. Structured Cache Events: HIT, MISS, EXPIRED, EVICTED log correctly without token leakage", async () => {
    const consoleSpy = jest.spyOn(console, "log").mockImplementation(() => {});

    // MISS log
    RepositoryCacheManager.logStatus("proj-miss", "MISS");
    expect(consoleSpy).toHaveBeenCalledWith("[REPO_CACHE] project=proj-miss status=MISS");

    // HIT log with ageMs
    RepositoryCacheManager.logStatus("proj-hit", "HIT", 12345);
    expect(consoleSpy).toHaveBeenCalledWith("[REPO_CACHE] project=proj-hit status=HIT ageMs=12345");

    // EXPIRED log with ageMs
    RepositoryCacheManager.logStatus("proj-exp", "EXPIRED", 99999);
    expect(consoleSpy).toHaveBeenCalledWith("[REPO_CACHE] project=proj-exp status=EXPIRED ageMs=99999");

    // EVICTED log
    RepositoryCacheManager.logStatus("proj-evict", "EVICTED");
    expect(consoleSpy).toHaveBeenCalledWith("[REPO_CACHE] project=proj-evict status=EVICTED");

    // Credential redaction verification
    const secretUrl = "https://x-access-token:ghp_SuperSecretToken123456789@github.com/org/repo.git";
    const redacted = RepositoryCacheManager.redactCredentials(secretUrl);
    expect(redacted).toBe("https://***@github.com/org/repo.git");
    expect(redacted).not.toContain("ghp_SuperSecretToken123456789");
  });

  test("2. Max Cache Budget: LRU Eviction evicts oldest inactive project caches when budget is exceeded", async () => {
    // Set cache budget to 5 KB (5120 bytes)
    process.env.ANKA_REPO_CACHE_MAX_BYTES = "5120";

    const proj1Path = path.join(customCacheDir, "proj-old");
    const proj2Path = path.join(customCacheDir, "proj-medium");
    const proj3Path = path.join(customCacheDir, "proj-new");

    fs.mkdirSync(proj1Path, { recursive: true });
    fs.mkdirSync(proj2Path, { recursive: true });
    fs.mkdirSync(proj3Path, { recursive: true });

    // Write 3 KB file into each (total 9 KB > 5 KB budget)
    const payload3k = "x".repeat(3072);
    fs.writeFileSync(path.join(proj1Path, "data.bin"), payload3k);
    fs.writeFileSync(path.join(proj2Path, "data.bin"), payload3k);
    fs.writeFileSync(path.join(proj3Path, "data.bin"), payload3k);

    // Create metadata with distinct timestamps
    const now = Date.now();
    fs.writeFileSync(
      path.join(proj1Path, ".anka-cache-meta.json"),
      JSON.stringify({ projectId: "proj-old", createdAt: now - 30000, lastUsedAt: now - 30000 })
    );
    fs.writeFileSync(
      path.join(proj2Path, ".anka-cache-meta.json"),
      JSON.stringify({ projectId: "proj-medium", createdAt: now - 15000, lastUsedAt: now - 15000 })
    );
    fs.writeFileSync(
      path.join(proj3Path, ".anka-cache-meta.json"),
      JSON.stringify({ projectId: "proj-new", createdAt: now, lastUsedAt: now })
    );

    const evictionResult = await RepositoryCacheManager.enforceMaxBudget();
    expect(evictionResult.evictedCount).toBeGreaterThanOrEqual(1);

    // The oldest project cache (proj-old) must be evicted first
    expect(fs.existsSync(proj1Path)).toBe(false);
    // The newest project cache (proj-new) must remain
    expect(fs.existsSync(proj3Path)).toBe(true);
  });

  test("3. Active Leases: currently leased projects are never evicted by LRU budget enforcement or TTL sweep", async () => {
    process.env.ANKA_REPO_CACHE_MAX_BYTES = "1024"; // 1 KB budget

    const activeProjPath = path.join(customCacheDir, "proj-active");
    fs.mkdirSync(activeProjPath, { recursive: true });
    fs.writeFileSync(path.join(activeProjPath, "data.bin"), "x".repeat(4096)); // 4 KB

    const past = Date.now() - 100000;
    fs.writeFileSync(
      path.join(activeProjPath, ".anka-cache-meta.json"),
      JSON.stringify({ projectId: "proj-active", createdAt: past, lastUsedAt: past })
    );

    // Acquire lock/lease on proj-active
    await RepositoryCacheManager.withProjectLock("proj-active", async () => {
      expect(RepositoryCacheManager.isProjectActive("proj-active")).toBe(true);
      expect(RepositoryCacheManager.getActiveLeaseCount()).toBe(1);

      // Trigger budget enforcement while leased
      const result = await RepositoryCacheManager.enforceMaxBudget();
      expect(result.evictedCount).toBe(0);
      expect(fs.existsSync(activeProjPath)).toBe(true);

      // Trigger TTL sweep while leased
      const swept = await RepositoryCacheManager.sweepExpiredCaches();
      expect(swept).toBe(0);
      expect(fs.existsSync(activeProjPath)).toBe(true);
    });

    expect(RepositoryCacheManager.isProjectActive("proj-active")).toBe(false);
  });

  test("4. Startup Sweep: cleans expired caches and orphan runs without crashing", async () => {
    // Setup 1 expired cache
    const expiredProj = path.join(customCacheDir, "proj-expired");
    fs.mkdirSync(path.join(expiredProj, ".git"), { recursive: true });
    const longAgo = Date.now() - 100000000;
    fs.writeFileSync(
      path.join(expiredProj, ".anka-cache-meta.json"),
      JSON.stringify({ projectId: "proj-expired", createdAt: longAgo, lastUsedAt: longAgo })
    );

    // Setup 1 orphan run directory older than 2 hours
    const staleRun = path.join(customRunsDir, "stale-run-startup");
    fs.mkdirSync(staleRun, { recursive: true });
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
    fs.utimesSync(staleRun, threeHoursAgo, threeHoursAgo);

    const sweepSummary = await RepositoryCacheManager.performStartupSweep();
    expect(sweepSummary.sweptCaches).toBeGreaterThanOrEqual(1);
    expect(sweepSummary.sweptRuns).toBeGreaterThanOrEqual(1);

    expect(fs.existsSync(expiredProj)).toBe(false);
    expect(fs.existsSync(staleRun)).toBe(false);
  });

  test("5. Runtime Preflight: missing git produces clean RUNTIME_DEPENDENCY_MISSING: git error", async () => {
    // Test preflight verification on valid git (should pass on test host)
    await expect(RuntimePreflightService.verifyTool("git")).resolves.not.toThrow();
    expect(RuntimePreflightService.isToolVerified("git")).toBe(true);

    // Simulate missing tool
    await expect(
      RuntimePreflightService.verifyTool("nonexistent_tool_xyz" as any)
    ).rejects.toThrow("RUNTIME_DEPENDENCY_MISSING: nonexistent_tool_xyz");

    // In GitWorktreeService, verify prepareRepositoryRun fails fast if git tool verification fails
    jest.spyOn(RuntimePreflightService, "verifyTools").mockRejectedValueOnce(
      new Error("RUNTIME_DEPENDENCY_MISSING: git")
    );

    await expect(
      GitWorktreeService.prepareRepositoryRun({
        repositoryPath: customCacheDir,
        runId: "preflight-test-run",
      })
    ).rejects.toThrow("RUNTIME_DEPENDENCY_MISSING: git");
  });

  test("6. Health Telemetry: correctly reports repoCacheEntries, bytes, activeLeases, and lastSweepAt", async () => {
    const projPath = path.join(customCacheDir, "telemetry-proj");
    fs.mkdirSync(path.join(projPath, ".git"), { recursive: true });
    fs.writeFileSync(path.join(projPath, "test.txt"), "hello telemetry");
    const now = Date.now();
    fs.writeFileSync(
      path.join(projPath, ".anka-cache-meta.json"),
      JSON.stringify({ projectId: "telemetry-proj", createdAt: now, lastUsedAt: now })
    );

    await RepositoryCacheManager.performStartupSweep();

    const telemetry = await RepositoryCacheManager.getHealthTelemetry();
    expect(telemetry.repoCacheEntries).toBeGreaterThanOrEqual(1);
    expect(telemetry.repoCacheBytes).toBeGreaterThan(0);
    expect(telemetry.activeRepoLeases).toBe(0);
    expect(typeof telemetry.lastSweepAt).toBe("string");
  });
});
