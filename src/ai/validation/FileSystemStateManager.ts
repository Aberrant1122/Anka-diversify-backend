import fs from "fs";
import path from "path";
import { AgentFileChange } from "../shared/types";

export class RepairInfrastructureError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "RepairInfrastructureError";
  }
}

const FORBIDDEN_PATH_SEGMENTS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
]);

/**
 * Asserts that a target path does not escape the worktree root and does not
 * touch protected repository metadata or build artifacts.
 */
export function assertSafeWorktreePath(targetPath: string, worktreeRoot: string): string {
  if (!targetPath || typeof targetPath !== "string") {
    throw new RepairInfrastructureError("Target file path must be a non-empty string.");
  }
  if (!worktreeRoot || typeof worktreeRoot !== "string") {
    throw new RepairInfrastructureError("Worktree root path must be a non-empty string.");
  }

  const normalizedTarget = targetPath.replace(/\\/g, "/");
  const segments = normalizedTarget.split("/").map((s) => s.trim()).filter(Boolean);

  for (const seg of segments) {
    if (FORBIDDEN_PATH_SEGMENTS.has(seg.toLowerCase())) {
      throw new RepairInfrastructureError(
        `Path safety violation: modifying protected directory or file "${seg}" is forbidden in path "${targetPath}".`
      );
    }
  }

  const resolvedRoot = path.resolve(worktreeRoot);
  const resolvedTarget = path.resolve(worktreeRoot, targetPath);

  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new RepairInfrastructureError(
      `Path traversal violation: target path "${targetPath}" escapes the worktree root "${worktreeRoot}".`
    );
  }

  return resolvedTarget;
}

export class FileSystemStateManager {
  private originalState: Map<string, string | null> = new Map();

  /**
   * Snapshot the current on-disk content of files affected by changes.
   * If a file exists, its content is saved. If it does not exist, null is saved.
   */
  async snapshot(changes: AgentFileChange[], localPath: string | null | undefined): Promise<void> {
    if (!localPath) return;

    for (const change of changes) {
      if (!change.path) continue;
      const normalizedPath = change.path.replace(/\\/g, "/");
      if (this.originalState.has(normalizedPath)) continue;

      const absPath = assertSafeWorktreePath(change.path, localPath);
      try {
        if (fs.existsSync(absPath)) {
          const content = await fs.promises.readFile(absPath, "utf8");
          this.originalState.set(normalizedPath, content);
        } else {
          this.originalState.set(normalizedPath, null);
        }
      } catch {
        this.originalState.set(normalizedPath, null);
      }
    }
  }

  /**
   * Single authoritative write point for applying changes to disk.
   * Also captures any newly touched files into the snapshot before mutating them.
   */
  async apply(changes: AgentFileChange[], localPath: string | null | undefined): Promise<void> {
    if (!localPath) {
      throw new RepairInfrastructureError("Cannot apply file changes: localPath is null or undefined.");
    }

    try {
      const stat = await fs.promises.stat(localPath);
      if (!stat.isDirectory()) {
        throw new RepairInfrastructureError(`Cannot apply file changes: localPath "${localPath}" is not a directory.`);
      }
    } catch (err: any) {
      if (err instanceof RepairInfrastructureError) throw err;
      throw new RepairInfrastructureError(`Cannot apply file changes: localPath "${localPath}" does not exist or is inaccessible.`, err);
    }

    // Ensure all changes being applied are snapshotted first if not already in originalState
    await this.snapshot(changes, localPath);

    for (const change of changes) {
      if (!change.path) continue;
      const abs = assertSafeWorktreePath(change.path, localPath);

      try {
        if (change.action === "delete" || change.isDeleted) {
          if (fs.existsSync(abs)) {
            await fs.promises.rm(abs, { recursive: true, force: true });
          }
        } else {
          await fs.promises.mkdir(path.dirname(abs), { recursive: true });
          await fs.promises.writeFile(abs, change.content || "", "utf8");
        }
      } catch (err: any) {
        if (err instanceof RepairInfrastructureError) throw err;
        throw new RepairInfrastructureError(`Failed writing file "${change.path}" to "${localPath}": ${err?.message || err}`, err);
      }
    }
  }

  /**
   * Restores all snapshotted files to their exact pre-repair state.
   */
  async rollback(localPath: string | null | undefined): Promise<void> {
    if (!localPath || this.originalState.size === 0) return;

    for (const [relativePath, originalContent] of this.originalState.entries()) {
      const absPath = assertSafeWorktreePath(relativePath, localPath);
      try {
        if (originalContent === null) {
          if (fs.existsSync(absPath)) {
            await fs.promises.rm(absPath, { recursive: true, force: true });
          }
        } else {
          await fs.promises.mkdir(path.dirname(absPath), { recursive: true });
          await fs.promises.writeFile(absPath, originalContent, "utf8");
        }
      } catch (err) {
        console.error(`[FileSystemStateManager] Failed to rollback file "${relativePath}":`, err);
      }
    }
  }

  /**
   * Commit transaction: clears the snapshot state map.
   */
  commit(): void {
    this.originalState.clear();
  }

  getSnapshotSize(): number {
    return this.originalState.size;
  }

  getOriginalContent(relativePath: string): string | null | undefined {
    const normalized = relativePath.replace(/\\/g, "/");
    return this.originalState.get(normalized);
  }

  hasOriginalFile(relativePath: string): boolean {
    const normalized = relativePath.replace(/\\/g, "/");
    return this.originalState.has(normalized);
  }
}
