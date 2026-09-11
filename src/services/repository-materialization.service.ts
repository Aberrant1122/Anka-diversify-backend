import fs from "fs";
import path from "path";
import { prisma } from "./database";
import { decrypt } from "../utils/encryption";
import { GitWorktreeService } from "./git-worktree.service";
import { RepositoryCacheManager } from "./repository-cache.manager";
import { NodeGitCommandExecutor } from "./git-command";

const git = new NodeGitCommandExecutor();

export interface MaterializedRepositoryMetadata {
  canonicalRoot: string;
  headSha: string;
  branch: string;
  origin: string;
  trackedFilesCount: number;
}

export interface MaterializationResult {
  success: boolean;
  metadata?: MaterializedRepositoryMetadata;
  errorType?: "REPOSITORY_NOT_READY" | "INVALID_URL" | "CLONE_FAILED" | "VALIDATION_FAILED";
  error?: string;
}

export class RepositoryMaterializationService {
  /**
   * Deterministic directory for managed repository clones.
   * Resolves to ephemeral cache under os.tmpdir()/anka/repo-cache/<projectId>.
   */
  public static getManagedRepositoryPath(projectId: string): string {
    return RepositoryCacheManager.getProjectCachePath(projectId);
  }

  /**
   * Checks whether a directory is inside an ANKA managed repository cache (current ephemeral or legacy).
   * Robust across Windows and POSIX path separators and drive case differences.
   */
  public static isManagedRepositoryPath(dirPath: string): boolean {
    if (!dirPath) return false;
    const resolvedTarget = path.resolve(dirPath);
    const currentBase = path.resolve(RepositoryCacheManager.getCacheRoot());
    const legacyBase = path.resolve(process.cwd(), ".anka-cache", "managed-repos");

    const normalize = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
    const targetNorm = normalize(resolvedTarget);
    const currentNorm = normalize(currentBase);
    const legacyNorm = normalize(legacyBase);

    const isUnder = (base: string, target: string) => {
      const rel = path.relative(base, target);
      return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    };

    return isUnder(currentNorm, targetNorm) || isUnder(legacyNorm, targetNorm);
  }

  /**
   * Checks whether a path is a legacy .anka-cache managed repository path.
   */
  public static isLegacyManagedPath(dirPath: string): boolean {
    if (!dirPath) return false;
    const normalized = dirPath.replace(/\\/g, "/");
    return normalized.includes(".anka-cache/managed-repos");
  }

  /**
   * Validates a Git/GitHub URL format.
   */
  public static validateRepositoryUrl(url: string): boolean {
    if (!url || typeof url !== "string") return false;
    const trimmed = url.trim();
    return (
      /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\.git)?$/.test(trimmed) ||
      /^git@github\.com:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\.git)?$/.test(trimmed)
    );
  }

  /**
   * Builds an authenticated or clean Git URL for cloning/fetching with credentials.
   */
  private static buildGitTransport(rawUrl: string, encryptedToken?: string | null): {
    readonly url: string;
    readonly environment?: Readonly<Record<string, string>>;
  } {
    let token: string | undefined;
    if (encryptedToken) {
      token = decrypt(encryptedToken);
    }

    const url = rawUrl.trim();
    if (!token || !url.startsWith("https://github.com/")) return { url };
    const authorization = Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
    return {
      url,
      environment: Object.freeze({
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.extraHeader",
        GIT_CONFIG_VALUE_0: `Authorization: Basic ${authorization}`,
      }),
    };
  }

  /**
   * Ensures that a project's repository is materialized and fresh.
   * If it is an ANKA-managed clone, synchronizes it to the latest remote branch commit.
   * If it is a user-owned external localPath, leaves their checkout untouched and inspects local HEAD.
   */
  public static async ensureProjectRepositoryCurrent(projectId: string): Promise<MaterializationResult> {
    return RepositoryCacheManager.withProjectLock(projectId, async () => {
      // Runtime preflight verification for git
      try {
        const { RuntimePreflightService } = await import("./runtime-preflight.service");
        await RuntimePreflightService.verifyTool("git");
      } catch (preflightErr: any) {
        return {
          success: false,
          errorType: "RUNTIME_DEPENDENCY_MISSING" as any,
          error: preflightErr?.message || "RUNTIME_DEPENDENCY_MISSING: git",
        };
      }

      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { id: true, name: true, localPath: true, githubUrl: true, githubToken: true },
      });

      if (!project) {
        return {
          success: false,
          errorType: "REPOSITORY_NOT_READY",
          error: `Project "${projectId}" not found in database.`,
        };
      }

      // Check if project has a genuine user-owned external localPath (not any managed repository path)
      const isManagedPath = project.localPath ? this.isManagedRepositoryPath(project.localPath) : false;
      const hasConfiguredExternalPath = Boolean(
        project.localPath && !isManagedPath && fs.existsSync(path.resolve(project.localPath))
      );

      const managedPath = this.getManagedRepositoryPath(projectId);
      const isFresh = RepositoryCacheManager.isCacheFresh(projectId);
      const gitDirExists = fs.existsSync(path.join(managedPath, ".git"));
      const cacheAgeMs = RepositoryCacheManager.getCacheAgeMs(projectId);

      // If user-owned external localPath exists, inspect directly without touching
      if (hasConfiguredExternalPath) {
        const candidateRoot = path.resolve(project.localPath!);
        try {
          const canonicalRoot = await GitWorktreeService.resolveRepositoryRoot(candidateRoot);
          const headSha = await GitWorktreeService.getHeadCommitSha(canonicalRoot);

          let branch = "main";
          try {
            const { stdout } = await git.run(canonicalRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
            branch = stdout.trim() || "main";
          } catch {}

          let origin = "";
          try {
            const { stdout } = await git.run(canonicalRoot, ["remote", "get-url", "origin"]);
            origin = stdout.trim();
          } catch {}

          const { stdout: lsOut } = await git.run(canonicalRoot, ["ls-files"]);
          const trackedFilesCount = lsOut.split("\n").filter((l) => l.trim().length > 0).length;

          return {
            success: true,
            metadata: {
              canonicalRoot,
              headSha,
              branch,
              origin: RepositoryCacheManager.redactCredentials(origin),
              trackedFilesCount,
            },
          };
        } catch (err: any) {
          console.warn(`[RepoMaterialization] User configured localPath "${project.localPath}" error:`, err);
        }
      }

      // Log structured REPO_CACHE metrics for managed cache
      if (!gitDirExists) {
        RepositoryCacheManager.logStatus(projectId, "MISS");
      } else if (isFresh) {
        RepositoryCacheManager.logStatus(projectId, "HIT", cacheAgeMs ?? undefined);
      } else {
        RepositoryCacheManager.logStatus(projectId, "EXPIRED", cacheAgeMs ?? undefined);
      }

      // If no valid clone exists or cache expired, perform fresh clone / materialization
      if (!isFresh) {
        if (!project.githubUrl) {
          return {
            success: false,
            errorType: "REPOSITORY_NOT_READY",
            error: `Project "${projectId}" has no localPath configured and no githubUrl to materialize.`,
          };
        }
        return this.materializeProjectRepositoryInternal(projectId, project);
      }

      // Existing fresh managed cache: sync with remote HEAD
      try {
        const canonicalRoot = await GitWorktreeService.resolveRepositoryRoot(managedPath);
        const localHeadBefore = await GitWorktreeService.getHeadCommitSha(canonicalRoot);

        let branch = "main";
        try {
          const { stdout } = await git.run(canonicalRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
          branch = stdout.trim() || "main";
        } catch {}

        let origin = "";
        try {
          const { stdout } = await git.run(canonicalRoot, ["remote", "get-url", "origin"]);
          origin = stdout.trim();
        } catch {}

        let localHeadAfter = localHeadBefore;
        let updated = false;

        if (project.githubUrl) {
          const transport = this.buildGitTransport(project.githubUrl, project.githubToken);

          try {
            // Verify working tree is clean
            const { stdout: statusOut } = await git.run(canonicalRoot, ["status", "--porcelain"]);
            if (statusOut.trim().length > 0) {
              console.warn(`[RepoSync] Managed clone has uncommitted files. Cleaning.`);
              await git.run(canonicalRoot, ["reset", "--hard", "HEAD"]);
              await git.run(canonicalRoot, ["clean", "-fd"]);
            }

            // Ensure remote URL is configured
            try {
              await git.run(canonicalRoot, ["remote", "set-url", "origin", transport.url]);
            } catch {
              await git.run(canonicalRoot, ["remote", "add", "origin", transport.url]);
            }

            // Fetch from remote
            await git.run(canonicalRoot, ["fetch", "origin"], { timeoutMs: 60_000, environment: transport.environment });

            // Resolve remote branch HEAD SHA
            let remoteHead = "";
            try {
              const { stdout: remoteShaOut } = await git.run(canonicalRoot, ["rev-parse", `refs/remotes/origin/${branch}`]);
              remoteHead = remoteShaOut.trim();
            } catch {
              try {
                const { stdout: fetchHeadOut } = await git.run(canonicalRoot, ["rev-parse", "FETCH_HEAD"]);
                remoteHead = fetchHeadOut.trim();
              } catch {}
            }

            if (remoteHead && remoteHead !== localHeadBefore) {
              if (!/^[0-9a-f]{40}$/i.test(remoteHead)) throw new Error("GIT_INVALID_REVISION: Remote HEAD is not a commit SHA");
              await git.run(canonicalRoot, ["reset", "--hard", remoteHead]);
              localHeadAfter = await GitWorktreeService.getHeadCommitSha(canonicalRoot);
              updated = true;
            }

            console.log(`[REPO_SYNC] remoteHead=${(remoteHead || localHeadAfter).slice(0, 8)}`);
            console.log(`[REPO_SYNC] localHeadBefore=${localHeadBefore.slice(0, 8)}`);
            console.log(`[REPO_SYNC] localHeadAfter=${localHeadAfter.slice(0, 8)}`);
            console.log(`[REPO_SYNC] updated=${updated}`);
          } catch (syncErr: any) {
            console.warn(`[RepoSync] Fetch/reset warning on managed repo "${canonicalRoot}": ${RepositoryCacheManager.redactCredentials(syncErr?.message)}`);
          }
        }

        const { stdout: lsOut } = await git.run(canonicalRoot, ["ls-files"]);
        const trackedFilesCount = lsOut.split("\n").filter((l) => l.trim().length > 0).length;

        // Touch last-used timestamp in cache metadata
        RepositoryCacheManager.touch(projectId);

        return {
          success: true,
          metadata: {
            canonicalRoot,
            headSha: localHeadAfter,
            branch,
            origin: RepositoryCacheManager.redactCredentials(origin),
            trackedFilesCount,
          },
        };
      } catch (err: any) {
        if (project.githubUrl) {
          return this.materializeProjectRepositoryInternal(projectId, project);
        }
        return {
          success: false,
          errorType: "VALIDATION_FAILED",
          error: RepositoryCacheManager.redactCredentials(
            `Failed ensuring freshness for repository "${managedPath}": ${err?.message || err}`
          ),
        };
      }
    });
  }

  /**
   * Synchronizes an ANKA-managed clone directly to a specific commit SHA after an authorized push.
   */
  public static async syncManagedCloneToCommit(projectId: string, commitSha: string): Promise<boolean> {
    if (!projectId || !commitSha) return false;
    return RepositoryCacheManager.withProjectLock(projectId, async () => {
      const managedPath = this.getManagedRepositoryPath(projectId);
      if (!fs.existsSync(path.join(managedPath, ".git"))) {
        return false;
      }

      try {
        const canonicalRoot = await GitWorktreeService.resolveRepositoryRoot(managedPath);
        const localHeadBefore = await GitWorktreeService.getHeadCommitSha(canonicalRoot);

        if (localHeadBefore === commitSha) {
          console.log(`[REPO_SYNC] remoteHead=${commitSha.slice(0, 8)}`);
          console.log(`[REPO_SYNC] localHeadBefore=${localHeadBefore.slice(0, 8)}`);
          console.log(`[REPO_SYNC] localHeadAfter=${localHeadBefore.slice(0, 8)}`);
          console.log(`[REPO_SYNC] updated=false`);
          RepositoryCacheManager.touch(projectId);
          return true;
        }

        // Fetch and reset
        if (!/^[0-9a-f]{40}$/i.test(commitSha)) return false;
        await git.run(canonicalRoot, ["fetch", "origin"], { timeoutMs: 60_000 });
        await git.run(canonicalRoot, ["reset", "--hard", commitSha]);
        const localHeadAfter = await GitWorktreeService.getHeadCommitSha(canonicalRoot);

        console.log(`[REPO_SYNC] remoteHead=${commitSha.slice(0, 8)}`);
        console.log(`[REPO_SYNC] localHeadBefore=${localHeadBefore.slice(0, 8)}`);
        console.log(`[REPO_SYNC] localHeadAfter=${localHeadAfter.slice(0, 8)}`);
        console.log(`[REPO_SYNC] updated=${localHeadAfter !== localHeadBefore}`);

        RepositoryCacheManager.touch(projectId);
        return true;
      } catch (err: any) {
        console.warn(`[RepoSync] Could not sync managed clone to commit ${commitSha}: ${RepositoryCacheManager.redactCredentials(err?.message)}`);
        return false;
      }
    });
  }

  /**
   * Materializes and verifies a project's local Git repository.
   */
  public static async materializeProjectRepository(projectId: string): Promise<MaterializationResult> {
    return RepositoryCacheManager.withProjectLock(projectId, async () => {
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { id: true, name: true, localPath: true, githubUrl: true, githubToken: true },
      });

      if (!project) {
        return {
          success: false,
          errorType: "REPOSITORY_NOT_READY",
          error: `Project "${projectId}" not found in database.`,
        };
      }

      return this.materializeProjectRepositoryInternal(projectId, project);
    });
  }

  /**
   * Internal implementation of repository materialization.
   */
  private static async materializeProjectRepositoryInternal(
    projectId: string,
    project: { id: string; name: string; localPath?: string | null; githubUrl?: string | null; githubToken?: string | null }
  ): Promise<MaterializationResult> {
    // Case 1: Project has a user-owned external localPath (ignore managed paths)
    if (project.localPath && !this.isManagedRepositoryPath(project.localPath)) {
      const resolvedLocal = path.resolve(project.localPath);
      if (fs.existsSync(resolvedLocal)) {
        try {
          const canonicalRoot = await GitWorktreeService.resolveRepositoryRoot(resolvedLocal);
          const headSha = await GitWorktreeService.getHeadCommitSha(canonicalRoot);

          let branch = "main";
          try {
            const { stdout } = await git.run(canonicalRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
            branch = stdout.trim() || "main";
          } catch {}

          let origin = "";
          try {
            const { stdout } = await git.run(canonicalRoot, ["remote", "get-url", "origin"]);
            origin = stdout.trim();
          } catch {}

          const { stdout: lsOut } = await git.run(canonicalRoot, ["ls-files"]);
          const trackedFilesCount = lsOut.split("\n").filter((l) => l.trim().length > 0).length;

          return {
            success: true,
            metadata: {
              canonicalRoot,
              headSha,
              branch,
              origin: RepositoryCacheManager.redactCredentials(origin),
              trackedFilesCount,
            },
          };
        } catch (err: any) {
          console.warn(`[RepoMaterialization] Configured localPath "${project.localPath}" invalid: ${err?.message}`);
        }
      }
    }

    // Case 2: Project has a GitHub URL that requires materialization into ephemeral cache
    if (project.githubUrl) {
      const targetDir = this.getManagedRepositoryPath(projectId);
      const isFresh = RepositoryCacheManager.isCacheFresh(projectId);

      const transport = this.buildGitTransport(project.githubUrl, project.githubToken);

      try {
        if (!isFresh) {
          await RepositoryCacheManager.removeProjectCache(projectId);
          await fs.promises.mkdir(path.dirname(targetDir), { recursive: true });

          await git.run(path.dirname(targetDir), ["clone", transport.url, targetDir], {
            timeoutMs: 120_000,
            environment: transport.environment,
          });
        } else {
          try {
            await git.run(targetDir, ["fetch", "origin"], { timeoutMs: 60_000, environment: transport.environment });
          } catch (fetchErr: any) {
            console.warn(`[RepoMaterialization] git fetch failed on "${targetDir}": ${RepositoryCacheManager.redactCredentials(fetchErr?.message)}`);
          }
        }

        const canonicalRoot = await GitWorktreeService.resolveRepositoryRoot(targetDir);
        const headSha = await GitWorktreeService.getHeadCommitSha(canonicalRoot);

        let branch = "main";
        try {
          const { stdout } = await git.run(canonicalRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
          branch = stdout.trim() || "main";
        } catch {}

        let origin = "";
        try {
          const { stdout } = await git.run(canonicalRoot, ["remote", "get-url", "origin"]);
          origin = stdout.trim();
        } catch {}

        const { stdout: lsOut } = await git.run(canonicalRoot, ["ls-files"]);
        const trackedFilesCount = lsOut.split("\n").filter((l) => l.trim().length > 0).length;

        // Touch cache metadata (do NOT persist ephemeral path to Project.localPath in database)
        RepositoryCacheManager.touch(projectId);

        // Enforce maximum cache budget after new clone/fetch
        await RepositoryCacheManager.enforceMaxBudget();

        return {
          success: true,
          metadata: {
            canonicalRoot,
            headSha,
            branch,
            origin: RepositoryCacheManager.redactCredentials(origin),
            trackedFilesCount,
          },
        };
      } catch (err: any) {
        const cleanError = RepositoryCacheManager.redactCredentials(err?.message || String(err));
        // Clean partial failed clone to avoid corrupted cache remaining
        try {
          await RepositoryCacheManager.removeProjectCache(projectId);
        } catch {}
        return {
          success: false,
          errorType: "CLONE_FAILED",
          error: `Failed cloning repository from "${project.githubUrl}": ${cleanError}`,
        };
      }
    }

    return {
      success: false,
      errorType: "REPOSITORY_NOT_READY",
      error: `Project "${projectId}" has no localPath configured and no githubUrl to materialize.`,
    };
  }

  /**
   * Deterministic readiness check verifying repository exists on disk and is valid.
   */
  public static async isProjectReady(projectId: string): Promise<boolean> {
    const res = await this.ensureProjectRepositoryCurrent(projectId);
    return Boolean(res.success && res.metadata && res.metadata.trackedFilesCount > 0);
  }
}
