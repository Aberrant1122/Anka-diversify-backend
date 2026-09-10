import fs from "fs";
import path from "path";
import { AgentFileChange } from "../shared/types";
import { CapabilityAction, CapabilityDecision, CapabilityGuard } from "../runtime/CapabilityGuard";

export class RepairInfrastructureError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "RepairInfrastructureError";
  }
}

export class CapabilityAuthorizationError extends Error {
  constructor(
    public readonly code: Exclude<CapabilityDecision, { allowed: true }>["code"],
    message: string,
  ) {
    super(message);
    this.name = "CapabilityAuthorizationError";
  }
}

export interface ExecutedFileMutation {
  readonly path: string;
  readonly action: CapabilityAction;
  readonly content: string;
  readonly description: string;
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

function canonicalMutationPath(targetPath: string, worktreeRoot: string): string {
  const resolvedRoot = path.resolve(worktreeRoot);
  const canonicalRoot = fs.realpathSync(resolvedRoot);
  const resolvedTarget = path.resolve(resolvedRoot, targetPath);
  let existingAncestor = resolvedTarget;
  while (!fs.existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) throw new RepairInfrastructureError("Unable to resolve mutation target.");
    existingAncestor = parent;
  }
  const canonicalAncestor = fs.realpathSync(existingAncestor);
  const canonicalTarget = path.resolve(canonicalAncestor, path.relative(existingAncestor, resolvedTarget));
  const relative = path.relative(canonicalRoot, canonicalTarget);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new RepairInfrastructureError(`Path safety violation: mutation target "${targetPath}" resolves outside the worktree.`);
  }
  return canonicalTarget;
}

export class FileSystemStateManager {
  private originalState: Map<string, Buffer | null> = new Map();
  private readonly authorizedMutationPaths = new Set<string>();
  private readonly executedMutations: ExecutedFileMutation[] = [];

  constructor(
    private readonly capabilityGuard: CapabilityGuard = CapabilityGuard.denyAll(),
    private readonly capabilityScopeId: string = "UNAUTHORIZED",
  ) {}

  /**
   * Snapshot the current on-disk content of files affected by changes.
   * If a file exists, its content is saved. If it does not exist, null is saved.
   */
  async snapshot(changes: AgentFileChange[], localPath: string | null | undefined): Promise<void> {
    if (!localPath) return;

    this.authorizeChanges(changes, localPath);

    for (const change of changes) {
      if (!change.path) continue;
      const normalizedPath = change.path.replace(/\\/g, "/");
      if (this.originalState.has(normalizedPath)) continue;

      const absPath = assertSafeWorktreePath(change.path, localPath);
      try {
        if (fs.existsSync(absPath)) {
          const content = await fs.promises.readFile(absPath);
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

    // Authorize the complete batch before snapshotting or performing any mutation.
    const authorizedActions = this.authorizeChanges(changes, localPath);
    for (const change of changes) this.authorizedMutationPaths.add(change.path.replace(/\\/g, "/"));

    // Ensure all changes being applied are snapshotted first if not already in originalState
    await this.snapshot(changes, localPath);

    for (const [index, change] of changes.entries()) {
      if (!change.path) continue;
      const abs = canonicalMutationPath(change.path, localPath);

      try {
        if (change.action === "delete" || change.isDeleted) {
          const finalAbs = canonicalMutationPath(change.path, localPath);
          if (fs.existsSync(finalAbs)) {
            await fs.promises.rm(finalAbs, { recursive: true, force: true });
          }
        } else {
          await fs.promises.mkdir(path.dirname(abs), { recursive: true });
          const finalAbs = canonicalMutationPath(change.path, localPath);
          await fs.promises.writeFile(finalAbs, change.content || "", "utf8");
        }
        this.executedMutations.push(Object.freeze({
          path: change.path.replace(/\\/g, "/"),
          action: authorizedActions[index],
          content: change.content || "",
          description: change.description,
        }));
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
      if (!this.authorizedMutationPaths.has(relativePath)) continue;
      const absPath = canonicalMutationPath(relativePath, localPath);
      try {
        if (originalContent === null) {
          const finalAbs = canonicalMutationPath(relativePath, localPath);
          if (fs.existsSync(finalAbs)) {
            await fs.promises.rm(finalAbs, { recursive: true, force: true });
          }
        } else {
          await fs.promises.mkdir(path.dirname(absPath), { recursive: true });
          const finalAbs = canonicalMutationPath(relativePath, localPath);
          await fs.promises.writeFile(finalAbs, originalContent);
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
    this.authorizedMutationPaths.clear();
  }

  getExecutedMutations(): readonly ExecutedFileMutation[] {
    return Object.freeze([...this.executedMutations]);
  }

  getSnapshotSize(): number {
    return this.originalState.size;
  }

  getOriginalContent(relativePath: string): string | null | undefined {
    const normalized = relativePath.replace(/\\/g, "/");
    const content = this.originalState.get(normalized);
    return Buffer.isBuffer(content) ? content.toString("utf8") : content;
  }

  hasOriginalFile(relativePath: string): boolean {
    const normalized = relativePath.replace(/\\/g, "/");
    return this.originalState.has(normalized);
  }

  private authorizeChanges(changes: AgentFileChange[], localPath: string): CapabilityAction[] {
    const actions: CapabilityAction[] = [];
    for (const [index, change] of changes.entries()) {
      assertSafeWorktreePath(change.path, localPath);
      const action: CapabilityAction = change.action === "delete" || change.isDeleted
        ? "FILE_DELETE"
        : change.action === "create" || change.action === "modify" || change.action === undefined
          ? fs.existsSync(path.resolve(localPath, change.path))
            ? "FILE_MODIFY"
            : "FILE_CREATE"
          : `FILE_${String(change.action).toUpperCase()}` as CapabilityAction;
      const decision = this.capabilityGuard.authorize({ action, path: change.path, scopeId: this.capabilityScopeId });
      if (!decision.allowed) {
        if ("technical" in decision) throw new RepairInfrastructureError(`[${decision.code}] ${decision.reason}`, decision.cause);
        throw new CapabilityAuthorizationError(decision.code, `[${decision.code}] ${decision.reason}`);
      }
      canonicalMutationPath(change.path, localPath);
      actions.push(action);
    }
    return actions;
  }
}
