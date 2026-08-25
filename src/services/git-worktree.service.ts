import fs from "fs";
import path from "path";
import os from "os";
import { exec } from "child_process";
import { promisify } from "util";
import { AgentPipeline } from "../ai/orchestration/AgentPipeline";
import { AgentProgressEvent, AgentResponse, ChatRequest } from "../types";

const execAsync = promisify(exec);

export interface PrepareRepositoryRunOptions {
  repositoryPath: string;
  runId: string;
}

export interface PreparedRepositoryRun {
  originalRepositoryPath: string;
  repositoryRoot: string;
  worktreePath: string;
  branchName: string;
  baseCommitSha: string;
}

export interface WorktreeDiffResult {
  changedFiles: string[];
  diffSummary: string;
  rawDiff: string;
}

export interface RepositoryRunSummary {
  runId: string;
  branchName: string;
  baseCommitSha: string;
  worktreePath: string;
  changedFiles: string[];
  diffSummary: string;
  validationPassed: boolean;
  validationCommands: string[];
  validationErrors?: string;
  agentResponse: AgentResponse;
}

export interface RunIsolatedAgentOptions {
  userId: string;
  projectId: string;
  repositoryPath: string;
  runId: string;
  request: ChatRequest;
  onProgress?: (event: AgentProgressEvent) => void;
}

export class GitWorktreeService {
  /**
   * Validates and resolves the canonical root directory of a local Git repository.
   */
  static async resolveRepositoryRoot(repositoryPath: string): Promise<string> {
    if (!repositoryPath || typeof repositoryPath !== "string") {
      throw new Error("REPOSITORY_NOT_FOUND: Repository path must be a non-empty string.");
    }

    const resolvedPath = path.resolve(repositoryPath);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`REPOSITORY_NOT_FOUND: Path "${resolvedPath}" does not exist.`);
    }

    const stat = await fs.promises.stat(resolvedPath);
    if (!stat.isDirectory()) {
      throw new Error(`INVALID_REPOSITORY_PATH: Path "${resolvedPath}" is not a directory.`);
    }

    try {
      const { stdout } = await execAsync("git rev-parse --show-toplevel", { cwd: resolvedPath });
      const root = stdout.trim();
      return path.resolve(root);
    } catch (err: any) {
      throw new Error(`NOT_A_GIT_REPOSITORY: Path "${resolvedPath}" is not a valid Git repository: ${err?.message || err}`);
    }
  }

  /**
   * Retrieves current HEAD 40-character commit SHA.
   */
  static async getHeadCommitSha(repositoryRoot: string): Promise<string> {
    try {
      const { stdout } = await execAsync("git rev-parse HEAD", { cwd: repositoryRoot });
      const sha = stdout.trim();
      if (!sha || sha.length < 7) {
        throw new Error("Unable to resolve valid Git HEAD commit SHA.");
      }
      return sha;
    } catch (err: any) {
      throw new Error(`GIT_HEAD_RESOLUTION_FAILED: Failed to resolve HEAD commit: ${err?.message || err}`);
    }
  }

  /**
   * Asserts that the source repository working tree is clean.
   * Fails safely without modifying user files if uncommitted changes exist.
   */
  static async assertCleanWorkingTree(repositoryRoot: string): Promise<void> {
    try {
      const { stdout } = await execAsync("git status --porcelain", { cwd: repositoryRoot });
      if (stdout.trim().length > 0) {
        throw new Error(
          `SOURCE_REPOSITORY_DIRTY: Source repository at "${repositoryRoot}" contains uncommitted changes. ANKA requires a clean repository state before creating an isolated execution worktree.`
        );
      }
    } catch (err: any) {
      if (err.message && err.message.includes("SOURCE_REPOSITORY_DIRTY")) {
        throw err;
      }
      throw new Error(`GIT_STATUS_FAILED: Failed checking repository status: ${err?.message || err}`);
    }
  }

  /**
   * Prepares an isolated Git worktree on a unique branch `anka/run-<runId>`
   * branched from the source HEAD commit.
   */
  static async prepareRepositoryRun(options: PrepareRepositoryRunOptions): Promise<PreparedRepositoryRun> {
    const { repositoryPath, runId } = options;
    if (!runId || typeof runId !== "string") {
      throw new Error("INVALID_RUN_ID: runId must be a non-empty string.");
    }

    const repositoryRoot = await this.resolveRepositoryRoot(repositoryPath);
    await this.assertCleanWorkingTree(repositoryRoot);
    const baseCommitSha = await this.getHeadCommitSha(repositoryRoot);

    const branchName = `anka/run-${runId}`;
    const worktreePath = path.resolve(os.tmpdir(), "anka-worktrees", runId);

    // Ensure parent temp directory exists
    await fs.promises.mkdir(path.dirname(worktreePath), { recursive: true });

    // Clean prior stale worktree path if present
    if (fs.existsSync(worktreePath)) {
      try {
        await execAsync(`git worktree remove --force "${worktreePath}"`, { cwd: repositoryRoot });
      } catch {}
      try {
        await fs.promises.rm(worktreePath, { recursive: true, force: true });
      } catch {}
    }

    // Prune stale worktree registrations
    try {
      await execAsync("git worktree prune", { cwd: repositoryRoot });
    } catch {}

    // Delete existing branch with identical name if leftover
    try {
      await execAsync(`git branch -D "${branchName}"`, { cwd: repositoryRoot });
    } catch {}

    // Create branch and worktree from base commit SHA
    try {
      await execAsync(`git worktree add -b "${branchName}" "${worktreePath}" ${baseCommitSha}`, {
        cwd: repositoryRoot,
      });
    } catch (err: any) {
      throw new Error(
        `WORKTREE_CREATION_FAILED: Failed creating isolated worktree at "${worktreePath}": ${err?.message || err}`
      );
    }

    return {
      originalRepositoryPath: repositoryPath,
      repositoryRoot,
      worktreePath,
      branchName,
      baseCommitSha,
    };
  }

  /**
   * Computes changed files and diff summary inside the worktree relative to baseCommitSha.
   */
  static async getWorktreeDiff(worktreePath: string, baseCommitSha: string): Promise<WorktreeDiffResult> {
    try {
      const { stdout: statusOut } = await execAsync("git status --porcelain", { cwd: worktreePath });
      const changedFiles = statusOut
        .split("\n")
        .map((line) => {
          if (!line || line.trim().length === 0) return "";
          // Format is XY<space>path
          return line.slice(2).trim().replace(/\\/g, "/");
        })
        .filter(Boolean);

      const { stdout: diffOut } = await execAsync(`git diff ${baseCommitSha}`, { cwd: worktreePath });

      const diffLines = diffOut.split("\n");
      const summaryLines = diffLines.filter((l) => l.startsWith("diff --git") || l.startsWith("+++") || l.startsWith("---"));
      const diffSummary = summaryLines.slice(0, 50).join("\n") || (changedFiles.length > 0 ? `Changed files: ${changedFiles.join(", ")}` : "No file differences.");

      return {
        changedFiles,
        diffSummary,
        rawDiff: diffOut,
      };
    } catch {
      return {
        changedFiles: [],
        diffSummary: "Unable to retrieve git diff.",
        rawDiff: "",
      };
    }
  }

  /**
   * Resets and cleans the worktree back to baseCommitSha upon failure.
   */
  static async rollbackWorktree(worktreePath: string, baseCommitSha: string): Promise<void> {
    if (!worktreePath || !fs.existsSync(worktreePath)) return;
    try {
      await execAsync(`git reset --hard ${baseCommitSha}`, { cwd: worktreePath });
      await execAsync("git clean -fd", { cwd: worktreePath });
    } catch (err) {
      console.error(`[GitWorktreeService] Failed to rollback worktree at "${worktreePath}":`, err);
    }
  }

  /**
   * Safely removes worktree and prunes git metadata.
   */
  static async cleanupWorktree(worktreePath: string, repositoryRoot?: string): Promise<void> {
    if (repositoryRoot && fs.existsSync(repositoryRoot)) {
      try {
        await execAsync(`git worktree remove --force "${worktreePath}"`, { cwd: repositoryRoot });
        await execAsync("git worktree prune", { cwd: repositoryRoot });
      } catch {}
    }

    if (fs.existsSync(worktreePath)) {
      try {
        await fs.promises.rm(worktreePath, { recursive: true, force: true });
      } catch {}
    }
  }

  /**
   * High-level coordinator: runs AgentPipeline strictly inside an isolated Git worktree.
   * On success: preserves ANKA branch and worktree with a reviewable diff (NO auto-merge/push).
   * On failure: rolls worktree changes back cleanly.
   * The source repository is never modified at any point.
   */
  static async runIsolatedAgent(options: RunIsolatedAgentOptions): Promise<RepositoryRunSummary> {
    const { userId, projectId, repositoryPath, runId, request, onProgress } = options;

    const prepared = await this.prepareRepositoryRun({ repositoryPath, runId });

    let agentResponse: AgentResponse;
    let executionError: any = null;

    try {
      agentResponse = await AgentPipeline.runCodingAgent(
        userId,
        projectId,
        request,
        onProgress,
        { effectiveLocalPath: prepared.worktreePath }
      );
    } catch (err: any) {
      executionError = err;
      await this.rollbackWorktree(prepared.worktreePath, prepared.baseCommitSha);
      throw err;
    }

    const diffInfo = await this.getWorktreeDiff(prepared.worktreePath, prepared.baseCommitSha);
    const validationPassed = Boolean(agentResponse.buildVerified !== false && !executionError);

    if (!validationPassed) {
      await this.rollbackWorktree(prepared.worktreePath, prepared.baseCommitSha);
    }

    return {
      runId,
      branchName: prepared.branchName,
      baseCommitSha: prepared.baseCommitSha,
      worktreePath: prepared.worktreePath,
      changedFiles: diffInfo.changedFiles,
      diffSummary: diffInfo.diffSummary,
      validationPassed,
      validationCommands: (agentResponse as any).validationCommands || [],
      validationErrors: !validationPassed ? agentResponse.explanation : undefined,
      agentResponse,
    };
  }
}
