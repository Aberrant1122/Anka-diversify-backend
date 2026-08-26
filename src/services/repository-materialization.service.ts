import fs from "fs";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { prisma } from "./database";
import { decrypt } from "../utils/encryption";
import { GitWorktreeService } from "./git-worktree.service";

const execAsync = promisify(exec);

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
   */
  public static getManagedRepositoryPath(projectId: string): string {
    return path.resolve(process.cwd(), ".anka-cache", "managed-repos", projectId);
  }

  /**
   * Checks whether a directory is inside the internal ANKA managed repository cache.
   */
  public static isManagedRepositoryPath(dirPath: string): boolean {
    if (!dirPath) return false;
    const resolvedTarget = path.resolve(dirPath);
    const managedBase = path.resolve(process.cwd(), ".anka-cache", "managed-repos");
    return (
      resolvedTarget.startsWith(managedBase + path.sep) ||
      resolvedTarget.startsWith(managedBase + "/") ||
      resolvedTarget === managedBase
    );
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
   * Ensures that a project's repository is materialized and fresh.
   * If it is an ANKA-managed clone, synchronizes it to the latest remote branch commit.
   * If it is a user-owned external localPath, leaves their checkout untouched and inspects local HEAD.
   */
  public static async ensureProjectRepositoryCurrent(projectId: string): Promise<MaterializationResult> {
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

    const managedPath = this.getManagedRepositoryPath(projectId);
    const hasConfiguredPath = Boolean(project.localPath && fs.existsSync(path.resolve(project.localPath)));
    const hasManagedClone = fs.existsSync(path.join(managedPath, ".git"));

    // If no local clone exists anywhere, perform initial clone
    if (!hasConfiguredPath && !hasManagedClone) {
      if (!project.githubUrl) {
        return {
          success: false,
          errorType: "REPOSITORY_NOT_READY",
          error: `Project "${projectId}" has no localPath configured and no githubUrl to materialize.`,
        };
      }
      return this.materializeProjectRepository(projectId);
    }

    const candidateRoot = project.localPath && fs.existsSync(path.resolve(project.localPath))
      ? path.resolve(project.localPath)
      : managedPath;

    const isManaged = this.isManagedRepositoryPath(candidateRoot);

    try {
      const canonicalRoot = await GitWorktreeService.resolveRepositoryRoot(candidateRoot);
      const localHeadBefore = await GitWorktreeService.getHeadCommitSha(canonicalRoot);

      let branch = "main";
      try {
        const { stdout } = await execAsync("git rev-parse --abbrev-ref HEAD", { cwd: canonicalRoot });
        branch = stdout.trim() || "main";
      } catch {}

      let origin = "";
      try {
        const { stdout } = await execAsync("git remote get-url origin", { cwd: canonicalRoot });
        origin = stdout.trim();
      } catch {}

      let localHeadAfter = localHeadBefore;
      let updated = false;

      // For ANKA-managed clones backed by githubUrl: sync to latest remote commit
      if (isManaged && project.githubUrl) {
        let token: string | undefined;
        if (project.githubToken) {
          try {
            token = decrypt(project.githubToken);
          } catch {}
        }

        let fetchUrl = project.githubUrl.trim();
        if (token && fetchUrl.startsWith("https://github.com/")) {
          const repoPath = fetchUrl.replace("https://github.com/", "");
          fetchUrl = `https://x-access-token:${token}@github.com/${repoPath}`;
        }

        try {
          // Verify working tree is clean
          const { stdout: statusOut } = await execAsync("git status --porcelain", { cwd: canonicalRoot });
          if (statusOut.trim().length > 0) {
            console.warn(`[RepoSync] Managed clone has uncommitted files. Cleaning.`);
            await execAsync("git reset --hard HEAD", { cwd: canonicalRoot });
            await execAsync("git clean -fd", { cwd: canonicalRoot });
          }

          // Ensure remote URL is configured
          try {
            await execAsync(`git remote set-url origin "${fetchUrl}"`, { cwd: canonicalRoot });
          } catch {
            await execAsync(`git remote add origin "${fetchUrl}"`, { cwd: canonicalRoot });
          }

          // Fetch from remote
          await execAsync("git fetch origin", { cwd: canonicalRoot, timeout: 60000 });

          // Resolve remote branch HEAD SHA
          let remoteHead = "";
          try {
            const { stdout: remoteShaOut } = await execAsync(`git rev-parse origin/${branch}`, { cwd: canonicalRoot });
            remoteHead = remoteShaOut.trim();
          } catch {
            // Fallback to FETCH_HEAD or main/master
            try {
              const { stdout: fetchHeadOut } = await execAsync("git rev-parse FETCH_HEAD", { cwd: canonicalRoot });
              remoteHead = fetchHeadOut.trim();
            } catch {}
          }

          if (remoteHead && remoteHead !== localHeadBefore) {
            await execAsync(`git reset --hard ${remoteHead}`, { cwd: canonicalRoot });
            localHeadAfter = await GitWorktreeService.getHeadCommitSha(canonicalRoot);
            updated = true;
          }

          console.log(`[REPO_SYNC] remoteHead=${(remoteHead || localHeadAfter).slice(0, 8)}`);
          console.log(`[REPO_SYNC] localHeadBefore=${localHeadBefore.slice(0, 8)}`);
          console.log(`[REPO_SYNC] localHeadAfter=${localHeadAfter.slice(0, 8)}`);
          console.log(`[REPO_SYNC] updated=${updated}`);
        } catch (syncErr: any) {
          console.warn(`[RepoSync] Fetch/reset warning on managed repo "${canonicalRoot}": ${syncErr?.message}`);
        }
      }

      const { stdout: lsOut } = await execAsync("git ls-files", { cwd: canonicalRoot });
      const trackedFilesCount = lsOut.split("\n").filter((l) => l.trim().length > 0).length;

      // Update Project.localPath in database to canonicalRoot if needed
      if (project.localPath !== canonicalRoot) {
        await prisma.project.update({
          where: { id: projectId },
          data: { localPath: canonicalRoot },
        });
      }

      return {
        success: true,
        metadata: {
          canonicalRoot,
          headSha: localHeadAfter,
          branch,
          origin,
          trackedFilesCount,
        },
      };
    } catch (err: any) {
      if (project.githubUrl) {
        return this.materializeProjectRepository(projectId);
      }
      return {
        success: false,
        errorType: "VALIDATION_FAILED",
        error: `Failed ensuring freshness for repository "${candidateRoot}": ${err?.message || err}`,
      };
    }
  }

  /**
   * Synchronizes an ANKA-managed clone directly to a specific commit SHA after an authorized push.
   */
  public static async syncManagedCloneToCommit(projectId: string, commitSha: string): Promise<boolean> {
    if (!projectId || !commitSha) return false;
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
        return true;
      }

      // Fetch and reset
      await execAsync("git fetch origin", { cwd: canonicalRoot, timeout: 60000 });
      await execAsync(`git reset --hard ${commitSha}`, { cwd: canonicalRoot });
      const localHeadAfter = await GitWorktreeService.getHeadCommitSha(canonicalRoot);

      console.log(`[REPO_SYNC] remoteHead=${commitSha.slice(0, 8)}`);
      console.log(`[REPO_SYNC] localHeadBefore=${localHeadBefore.slice(0, 8)}`);
      console.log(`[REPO_SYNC] localHeadAfter=${localHeadAfter.slice(0, 8)}`);
      console.log(`[REPO_SYNC] updated=${localHeadAfter !== localHeadBefore}`);
      return true;
    } catch (err: any) {
      console.warn(`[RepoSync] Could not sync managed clone to commit ${commitSha}: ${err?.message}`);
      return false;
    }
  }

  /**
   * Materializes and verifies a project's local Git repository.
   * If a project only has a githubUrl, this clones or refreshes the repository
   * into a deterministic managed directory and persists Project.localPath.
   */
  public static async materializeProjectRepository(projectId: string): Promise<MaterializationResult> {
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

    // Case 1: Project already has an existing valid localPath on disk
    if (project.localPath) {
      const resolvedLocal = path.resolve(project.localPath);
      if (fs.existsSync(resolvedLocal)) {
        try {
          const canonicalRoot = await GitWorktreeService.resolveRepositoryRoot(resolvedLocal);
          
          // If it is a managed clone and has githubUrl, ensure freshness
          if (this.isManagedRepositoryPath(canonicalRoot) && project.githubUrl) {
            return this.ensureProjectRepositoryCurrent(projectId);
          }

          const headSha = await GitWorktreeService.getHeadCommitSha(canonicalRoot);
          
          let branch = "main";
          try {
            const { stdout } = await execAsync("git rev-parse --abbrev-ref HEAD", { cwd: canonicalRoot });
            branch = stdout.trim() || "main";
          } catch {}

          let origin = "";
          try {
            const { stdout } = await execAsync("git remote get-url origin", { cwd: canonicalRoot });
            origin = stdout.trim();
          } catch {}

          const { stdout: lsOut } = await execAsync("git ls-files", { cwd: canonicalRoot });
          const trackedFilesCount = lsOut.split("\n").filter((l) => l.trim().length > 0).length;

          return {
            success: true,
            metadata: {
              canonicalRoot,
              headSha,
              branch,
              origin,
              trackedFilesCount,
            },
          };
        } catch (err: any) {
          console.warn(`[RepoMaterialization] Configured localPath "${project.localPath}" invalid: ${err?.message}`);
        }
      }
    }

    // Case 2: Project has a GitHub URL that requires materialization
    if (project.githubUrl) {
      const targetDir = this.getManagedRepositoryPath(projectId);
      await fs.promises.mkdir(path.dirname(targetDir), { recursive: true });

      let token: string | undefined;
      if (project.githubToken) {
        try {
          token = decrypt(project.githubToken);
        } catch {}
      }

      let cloneUrl = project.githubUrl.trim();
      if (token && cloneUrl.startsWith("https://github.com/")) {
        const repoPath = cloneUrl.replace("https://github.com/", "");
        cloneUrl = `https://x-access-token:${token}@github.com/${repoPath}`;
      }

      const isAlreadyCloned = fs.existsSync(path.join(targetDir, ".git"));

      try {
        if (!isAlreadyCloned) {
          if (fs.existsSync(targetDir)) {
            await fs.promises.rm(targetDir, { recursive: true, force: true });
          }
          await execAsync(`git clone "${cloneUrl}" "${targetDir}"`, {
            timeout: 120000,
          });
        } else {
          try {
            await execAsync("git fetch origin", { cwd: targetDir, timeout: 60000 });
          } catch (fetchErr: any) {
            console.warn(`[RepoMaterialization] git fetch failed on "${targetDir}": ${fetchErr?.message}`);
          }
        }

        const canonicalRoot = await GitWorktreeService.resolveRepositoryRoot(targetDir);
        const headSha = await GitWorktreeService.getHeadCommitSha(canonicalRoot);

        let branch = "main";
        try {
          const { stdout } = await execAsync("git rev-parse --abbrev-ref HEAD", { cwd: canonicalRoot });
          branch = stdout.trim() || "main";
        } catch {}

        let origin = "";
        try {
          const { stdout } = await execAsync("git remote get-url origin", { cwd: canonicalRoot });
          origin = stdout.trim();
        } catch {}

        const { stdout: lsOut } = await execAsync("git ls-files", { cwd: canonicalRoot });
        const trackedFilesCount = lsOut.split("\n").filter((l) => l.trim().length > 0).length;

        // Persist localPath in Project database record
        await prisma.project.update({
          where: { id: projectId },
          data: { localPath: canonicalRoot },
        });

        return {
          success: true,
          metadata: {
            canonicalRoot,
            headSha,
            branch,
            origin,
            trackedFilesCount,
          },
        };
      } catch (err: any) {
        return {
          success: false,
          errorType: "CLONE_FAILED",
          error: `Failed cloning repository from "${project.githubUrl}": ${err?.message || err}`,
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
