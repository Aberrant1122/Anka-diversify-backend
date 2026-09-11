import fs from "fs";
import path from "path";
import { ExecutedFileMutation, FileSystemStateManager } from "../validation/FileSystemStateManager";
import { AgentFileChange, AgentResponse, ChatRequest, AgentProgressEvent } from "../../types";
import { TaskExecutionPlan, TaskExecutionStage } from "../shared/TaskExecutionPlan";
import { TaskExecutionPlanManager } from "../planning/TaskExecutionPlanManager";
import { RepositoryStateRefresher } from "../repository/RepositoryStateRefresher";
import { CapabilityGuard } from "../runtime/CapabilityGuard";

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  "__pycache__",
]);

/**
 * Recursively collects all relative file paths within a directory,
 * ignoring build artifacts, package managers, and version control directories.
 */
function collectTrackedFiles(dir: string, baseDir: string = dir): string[] {
  const files: string[] = [];
  if (!dir || !fs.existsSync(dir)) return files;

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...collectTrackedFiles(fullPath, baseDir));
      } else if (entry.isFile()) {
        const rel = path.relative(baseDir, fullPath).replace(/\\/g, "/");
        files.push(rel);
      }
    }
  } catch {
    // Ignore directory traversal errors (e.g. permission or transient locks)
  }
  return files;
}

export interface StageStartCheckpoint {
  checkpointId: string;
  stageId: string;
  localPath: string | null;
  timestamp: number;
  initialFiles: Set<string>;
  initialContentMap: Map<string, string>;
  fsManager: FileSystemStateManager;
  committed: boolean;
  rolledBack: boolean;
}

/**
 * Manages an isolated execution transaction for a single TaskExecutionPlan stage.
 * Captures an exact StageStartCheckpoint prior to worktree mutation and guarantees
 * exact rollback on failure without using blind git reset --hard or intermediate commits.
 */
export class StageExecutionTransaction {
  private checkpoint: StageStartCheckpoint;

  private constructor(checkpoint: StageStartCheckpoint) {
    this.checkpoint = checkpoint;
  }

  public get checkpointId(): string {
    return this.checkpoint.checkpointId;
  }

  public get stageId(): string {
    return this.checkpoint.stageId;
  }

  public get localPath(): string | null {
    return this.checkpoint.localPath;
  }

  public get fsManager(): FileSystemStateManager {
    return this.checkpoint.fsManager;
  }

  public getExecutedMutations(): readonly ExecutedFileMutation[] {
    return this.checkpoint.fsManager.getExecutedMutations();
  }

  public isCommitted(): boolean {
    return this.checkpoint.committed;
  }

  public isRolledBack(): boolean {
    return this.checkpoint.rolledBack;
  }

  /**
   * Captures the exact state of files at the start of the stage.
   */
  public static async startTransaction(
    stageId: string,
    localPath?: string | null,
    capabilityGuard: CapabilityGuard = CapabilityGuard.denyAll(),
  ): Promise<StageExecutionTransaction> {
    const checkpointId = `chk_${stageId}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const initialFiles = new Set<string>();
    const initialContentMap = new Map<string, string>();
    const fsManager = new FileSystemStateManager(capabilityGuard, stageId);

    const normalizedLocalPath = localPath ? path.resolve(localPath) : null;

    if (normalizedLocalPath && fs.existsSync(normalizedLocalPath)) {
      const tracked = collectTrackedFiles(normalizedLocalPath);
      for (const relPath of tracked) {
        initialFiles.add(relPath);
        try {
          const absPath = path.join(normalizedLocalPath, relPath);
          const content = fs.readFileSync(absPath, "utf8");
          initialContentMap.set(relPath, content);
        } catch {
          // Ignore read failures on unusual file descriptors
        }
      }
    }

    const checkpoint: StageStartCheckpoint = {
      checkpointId,
      stageId,
      localPath: normalizedLocalPath,
      timestamp: Date.now(),
      initialFiles,
      initialContentMap,
      fsManager,
      committed: false,
      rolledBack: false,
    };

    return new StageExecutionTransaction(checkpoint);
  }

  /**
   * Applies changes to disk, automatically snapshotting files inside fsManager before mutation.
   */
  public async apply(changes: AgentFileChange[]): Promise<void> {
    if (!this.checkpoint.localPath) return;
    await this.checkpoint.fsManager.apply(changes, this.checkpoint.localPath);
  }

  /** CP5-authoritative pre-mutation authorization and byte snapshot. */
  public async snapshot(changes: AgentFileChange[]): Promise<void> {
    if (!this.checkpoint.localPath) return;
    await this.checkpoint.fsManager.snapshot(changes, this.checkpoint.localPath);
  }

  /**
   * Commits the stage transaction upon successful verification.
   * Worktree changes become the permanent baseline for subsequent stages.
   */
  public async commit(): Promise<void> {
    if (this.checkpoint.rolledBack || this.checkpoint.committed) return;
    this.checkpoint.committed = true;
    this.checkpoint.fsManager.commit();
    if (this.checkpoint.localPath) {
      try {
        await RepositoryStateRefresher.refreshRepositoryState({
          projectId: this.checkpoint.stageId,
          localPath: this.checkpoint.localPath,
          persist: false,
        });
      } catch (err) {
        console.warn("[StageTransaction] RepositoryStateRefresher.refreshRepositoryState error:", err);
      }
    }
  }

  /**
   * Restores the exact StageStartCheckpoint:
   * 1. Restores modified tracked files to stage-start content.
   * 2. Re-creates deleted files with stage-start content.
   * 3. Deletes any files created during the stage that did not exist at stage start.
   * Does NOT affect verified changes from prior stages.
   */
  public async rollback(): Promise<void> {
    if (this.checkpoint.rolledBack || this.checkpoint.committed || !this.checkpoint.localPath) {
      return;
    }
    this.checkpoint.rolledBack = true;

    const localPath = this.checkpoint.localPath;

    // 1. FilesystemStateManager rollback for all tracked/snapshotted files
    try {
      await this.checkpoint.fsManager.rollback(localPath);
    } catch (err) {
      console.error(`[StageTransaction] fsManager.rollback error for stage "${this.checkpoint.stageId}":`, err);
    }

    // All rollback writes are restricted to paths previously authorized and touched by fsManager.
    if (fs.existsSync(localPath)) {
      try {
        await RepositoryStateRefresher.onRollback({
          projectId: this.checkpoint.stageId,
          localPath,
          persist: false,
        });
      } catch (err) {
        console.warn("[StageTransaction] RepositoryStateRefresher.onRollback error:", err);
      }
    }
  }
}

export interface StageGateEvaluation {
  passed: boolean;
  reasons: string[];
}

/**
 * StageVerificationGate evaluates whether a stage has met all required verification checks.
 * Consumes existing repository-aware validation results from ValidationPlanner,
 * SecurityAuditor, and FeatureValidation without adding universal npm run build commands.
 */
export class StageVerificationGate {
  static evaluate({
    repairSuccess,
    securityPass,
    featureValidationPassed,
    hasBuildErrors,
  }: {
    repairSuccess: boolean;
    securityPass: boolean;
    featureValidationPassed: boolean;
    hasBuildErrors?: boolean;
  }): StageGateEvaluation {
    const reasons: string[] = [];
    if (!repairSuccess || hasBuildErrors) {
      reasons.push("Build/repair validation failed");
    }
    if (!securityPass) {
      reasons.push("Security audit failed");
    }
    if (!featureValidationPassed) {
      reasons.push("Feature/static validation failed");
    }
    return {
      passed: reasons.length === 0,
      reasons,
    };
  }
}
