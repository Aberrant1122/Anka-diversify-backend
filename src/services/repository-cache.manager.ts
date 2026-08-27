import fs from "fs";
import path from "path";
import os from "os";

export interface RepositoryCacheMeta {
  projectId: string;
  createdAt: number;
  lastUsedAt: number;
}

export interface SweepResult {
  sweptCount: number;
  reclaimedBytes: number;
}

export interface EvictionResult {
  evictedCount: number;
  reclaimedBytes: number;
}

export interface HealthTelemetry {
  repoCacheEntries: number;
  repoCacheBytes: number;
  activeRepoLeases: number;
  activeRuns: number;
  lastSweepAt: string | null;
}

export class RepositoryCacheManager {
  private static locks = new Map<string, Promise<any>>();
  private static activeLeases = new Set<string>();
  private static lastSweepAt: string | null = null;

  /**
   * Logs structured cache events without leaking credentials.
   */
  public static logStatus(
    projectId: string,
    status: "HIT" | "MISS" | "EXPIRED" | "EVICTED",
    ageMs?: number
  ): void {
    if (typeof ageMs === "number" && !isNaN(ageMs)) {
      console.log(`[REPO_CACHE] project=${projectId} status=${status} ageMs=${Math.round(ageMs)}`);
    } else {
      console.log(`[REPO_CACHE] project=${projectId} status=${status}`);
    }
  }

  /**
   * Returns the root directory for ephemeral managed repository clones.
   * Defaults to os.tmpdir()/anka/repo-cache, overrideable via ANKA_REPO_CACHE_DIR.
   */
  public static getCacheRoot(): string {
    return process.env.ANKA_REPO_CACHE_DIR
      ? path.resolve(process.env.ANKA_REPO_CACHE_DIR)
      : path.join(os.tmpdir(), "anka", "repo-cache");
  }

  /**
   * Returns the TTL in milliseconds for managed repository clones.
   * Defaults to 30 minutes (1800000ms), overrideable via ANKA_REPO_CACHE_TTL_MS.
   */
  public static getTTLMs(): number {
    if (process.env.ANKA_REPO_CACHE_TTL_MS) {
      const parsed = parseInt(process.env.ANKA_REPO_CACHE_TTL_MS, 10);
      if (!isNaN(parsed) && parsed > 0) return parsed;
    }
    return 1800000; // 30 minutes
  }

  /**
   * Returns the maximum cache size budget in bytes.
   * Defaults to 2 GB (2147483648 bytes), overrideable via ANKA_REPO_CACHE_MAX_BYTES.
   */
  public static getMaxCacheBytes(): number {
    if (process.env.ANKA_REPO_CACHE_MAX_BYTES) {
      const parsed = parseInt(process.env.ANKA_REPO_CACHE_MAX_BYTES, 10);
      if (!isNaN(parsed) && parsed > 0) return parsed;
    }
    return 2 * 1024 * 1024 * 1024; // 2 GB
  }

  /**
   * Returns the ephemeral cache directory for a given project.
   */
  public static getProjectCachePath(projectId: string): string {
    return path.join(this.getCacheRoot(), projectId);
  }

  /**
   * Computes the age of a cached repository in milliseconds since last use.
   */
  public static getCacheAgeMs(projectId: string): number | null {
    const meta = this.readMeta(projectId);
    if (meta && typeof meta.lastUsedAt === "number") {
      return Math.max(0, Date.now() - meta.lastUsedAt);
    }
    const projectPath = this.getProjectCachePath(projectId);
    const gitDir = path.join(projectPath, ".git");
    if (fs.existsSync(gitDir)) {
      try {
        const stat = fs.statSync(gitDir);
        return Math.max(0, Date.now() - stat.mtimeMs);
      } catch {}
    }
    return null;
  }

  /**
   * Checks whether a cached repository exists and is younger than TTL.
   */
  public static isCacheFresh(projectId: string): boolean {
    const projectPath = this.getProjectCachePath(projectId);
    const gitDir = path.join(projectPath, ".git");
    if (!fs.existsSync(gitDir)) {
      return false;
    }

    const meta = this.readMeta(projectId);
    const now = Date.now();
    const ttl = this.getTTLMs();

    if (meta && typeof meta.lastUsedAt === "number") {
      return now - meta.lastUsedAt < ttl;
    }

    // Fallback: inspect directory stat mtime if metadata file is absent
    try {
      const stat = fs.statSync(gitDir);
      return now - stat.mtimeMs < ttl;
    } catch {
      return false;
    }
  }

  /**
   * Touches/refreshes the last-used timestamp for a project's cache.
   */
  public static touch(projectId: string): void {
    const projectPath = this.getProjectCachePath(projectId);
    if (!fs.existsSync(projectPath)) return;

    const metaFile = path.join(projectPath, ".anka-cache-meta.json");
    const existing = this.readMeta(projectId);
    const now = Date.now();
    const meta: RepositoryCacheMeta = {
      projectId,
      createdAt: existing?.createdAt || now,
      lastUsedAt: now,
    };

    try {
      fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2), "utf8");
    } catch (err) {
      console.warn(`[RepoCache] Failed writing metadata for project "${projectId}":`, err);
    }
  }

  /**
   * Reads metadata for a project's cache.
   */
  public static readMeta(projectId: string): RepositoryCacheMeta | null {
    const metaFile = path.join(this.getProjectCachePath(projectId), ".anka-cache-meta.json");
    if (fs.existsSync(metaFile)) {
      try {
        const raw = fs.readFileSync(metaFile, "utf8");
        return JSON.parse(raw);
      } catch {}
    }
    return null;
  }

  /**
   * Recursively computes the total size in bytes of a directory.
   */
  public static async getDirectorySize(dirPath: string): Promise<number> {
    if (!fs.existsSync(dirPath)) return 0;
    let totalSize = 0;
    try {
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        try {
          if (entry.isDirectory()) {
            totalSize += await this.getDirectorySize(fullPath);
          } else if (entry.isFile()) {
            const stat = await fs.promises.stat(fullPath);
            totalSize += stat.size;
          }
        } catch {}
      }
    } catch {}
    return totalSize;
  }

  /**
   * Safely deletes a project's cache directory.
   */
  public static async removeProjectCache(projectId: string): Promise<void> {
    const projectPath = this.getProjectCachePath(projectId);
    if (fs.existsSync(projectPath)) {
      try {
        await fs.promises.rm(projectPath, { recursive: true, force: true });
        console.log(`[RepoCache] Removed cache for project "${projectId}" at "${projectPath}"`);
      } catch (err) {
        console.warn(`[RepoCache] Failed removing cache for project "${projectId}":`, err);
      }
    }
  }

  /**
   * Sweeps all cached repositories and deletes any that have exceeded the TTL.
   * Active leased repositories are never removed.
   */
  public static async sweepExpiredCaches(): Promise<number> {
    const root = this.getCacheRoot();
    if (!fs.existsSync(root)) return 0;

    let sweptCount = 0;
    try {
      const entries = await fs.promises.readdir(root, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const projectId = entry.name;
          if (this.activeLeases.has(projectId)) {
            continue;
          }

          if (!this.isCacheFresh(projectId)) {
            const ageMs = this.getCacheAgeMs(projectId) || 0;
            this.logStatus(projectId, "EXPIRED", ageMs);
            await this.removeProjectCache(projectId);
            this.logStatus(projectId, "EVICTED");
            sweptCount++;
          }
        }
      }
    } catch (err) {
      console.warn(`[RepoCache] Error during cache sweep:`, err);
    }
    return sweptCount;
  }

  /**
   * Enforces the maximum cache size budget by evicting least-recently-used inactive repositories.
   * Active leased repositories are never evicted.
   */
  public static async enforceMaxBudget(): Promise<EvictionResult> {
    const maxBytes = this.getMaxCacheBytes();
    const root = this.getCacheRoot();
    if (!fs.existsSync(root)) return { evictedCount: 0, reclaimedBytes: 0 };

    let evictedCount = 0;
    let reclaimedBytes = 0;

    try {
      const entries = await fs.promises.readdir(root, { withFileTypes: true });
      const projectCaches: Array<{
        projectId: string;
        projectPath: string;
        lastUsedAt: number;
        sizeBytes: number;
        isActive: boolean;
      }> = [];

      let totalBytes = 0;

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const projectId = entry.name;
          const projectPath = path.join(root, projectId);
          const sizeBytes = await this.getDirectorySize(projectPath);
          totalBytes += sizeBytes;

          const meta = this.readMeta(projectId);
          let lastUsedAt = meta?.lastUsedAt || 0;
          if (!lastUsedAt) {
            try {
              const stat = await fs.promises.stat(projectPath);
              lastUsedAt = stat.mtimeMs;
            } catch {
              lastUsedAt = 0;
            }
          }

          projectCaches.push({
            projectId,
            projectPath,
            lastUsedAt,
            sizeBytes,
            isActive: this.activeLeases.has(projectId),
          });
        }
      }

      if (totalBytes <= maxBytes) {
        return { evictedCount: 0, reclaimedBytes: 0 };
      }

      // Sort inactive project caches by lastUsedAt ascending (LRU first)
      const evictable = projectCaches
        .filter((c) => !c.isActive)
        .sort((a, b) => a.lastUsedAt - b.lastUsedAt);

      for (const item of evictable) {
        if (totalBytes <= maxBytes) break;

        await this.removeProjectCache(item.projectId);
        this.logStatus(item.projectId, "EVICTED");
        evictedCount++;
        reclaimedBytes += item.sizeBytes;
        totalBytes -= item.sizeBytes;
      }
    } catch (err) {
      console.warn(`[RepoCache] Error enforcing max cache budget:`, err);
    }

    return { evictedCount, reclaimedBytes };
  }

  /**
   * Executes startup cleanup across cache mirrors and orphan run directories.
   */
  public static async performStartupSweep(): Promise<{
    sweptCaches: number;
    sweptRuns: number;
    reclaimedBytes: number;
  }> {
    this.lastSweepAt = new Date().toISOString();

    try {
      await fs.promises.mkdir(this.getCacheRoot(), { recursive: true });
    } catch (err) {
      console.warn(`[StartupSweep] Cache root directory creation warning:`, err);
    }

    let sweptCaches = 0;
    let reclaimedBytes = 0;

    try {
      sweptCaches += await this.sweepExpiredCaches();
      const budgetResult = await this.enforceMaxBudget();
      sweptCaches += budgetResult.evictedCount;
      reclaimedBytes += budgetResult.reclaimedBytes;
    } catch (err: any) {
      console.warn(`[StartupSweep] Cache sweep warning: ${err?.message || err}`);
    }

    let sweptRuns = 0;
    try {
      const { GitWorktreeService } = await import("./git-worktree.service");
      await fs.promises.mkdir(GitWorktreeService.getRunsRoot(), { recursive: true });
      sweptRuns = await GitWorktreeService.sweepOrphanedRuns();
    } catch (err: any) {
      console.warn(`[StartupSweep] Worktree sweep warning: ${err?.message || err}`);
    }

    console.log(
      `[STARTUP_SWEEP] Complete. Swept ${sweptCaches} cache(s), ${sweptRuns} run(s), reclaimed ${reclaimedBytes} bytes.`
    );

    return {
      sweptCaches,
      sweptRuns,
      reclaimedBytes,
    };
  }

  /**
   * Returns current health telemetry without exposing secrets or code.
   */
  public static async getHealthTelemetry(): Promise<HealthTelemetry> {
    const root = this.getCacheRoot();
    let repoCacheEntries = 0;
    let repoCacheBytes = 0;

    if (fs.existsSync(root)) {
      try {
        const entries = await fs.promises.readdir(root, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            repoCacheEntries++;
            const projectPath = path.join(root, entry.name);
            repoCacheBytes += await this.getDirectorySize(projectPath);
          }
        }
      } catch {}
    }

    let activeRuns = 0;
    try {
      const { GitWorktreeService } = await import("./git-worktree.service");
      activeRuns = GitWorktreeService.getActiveRunCount();
    } catch {}

    return {
      repoCacheEntries,
      repoCacheBytes,
      activeRepoLeases: this.activeLeases.size,
      activeRuns,
      lastSweepAt: this.lastSweepAt || null,
    };
  }

  /**
   * Returns whether a project is currently actively leased.
   */
  public static isProjectActive(projectId: string): boolean {
    return this.activeLeases.has(projectId);
  }

  /**
   * Returns count of active project leases.
   */
  public static getActiveLeaseCount(): number {
    return this.activeLeases.size;
  }

  /**
   * Serializes operations on the same project using an in-process project-scoped mutex.
   * Different projects run concurrently. Active lease is tracked during execution.
   */
  public static async withProjectLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const currentLock = this.locks.get(projectId) || Promise.resolve();

    let releaseLock: () => void;
    const newLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    this.locks.set(
      projectId,
      currentLock.then(() => newLock).catch(() => newLock)
    );

    try {
      await currentLock;
      this.activeLeases.add(projectId);
      return await fn();
    } finally {
      this.activeLeases.delete(projectId);
      releaseLock!();
      if (this.locks.get(projectId) === newLock) {
        this.locks.delete(projectId);
      }
    }
  }

  /**
   * Helper to redact sensitive credentials (e.g. GitHub personal access tokens or OAuth tokens) from URLs / logs.
   */
  public static redactCredentials(text: string): string {
    if (!text || typeof text !== "string") return text;
    return text
      .replace(/https:\/\/[^@\s]+@github\.com/gi, "https://***@github.com")
      .replace(/https:\/\/[^:\s]+:[^@\s]+@/gi, "https://***@");
  }
}
