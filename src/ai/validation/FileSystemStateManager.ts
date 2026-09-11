import fs from "fs";
import path from "path";
import { AgentFileChange, FileEditingPrimitive } from "../shared/types";
import { CapabilityAction, CapabilityDecision, CapabilityGuard } from "../runtime/CapabilityGuard";
import {
  EditingConflictError,
  fingerprintBytes,
  materializeEditingPrimitive,
  readCurrentBytes,
} from "../editing/EditingPrimitives";

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

function primitiveAction(primitive: FileEditingPrimitive): CapabilityAction {
  if (primitive.type === "CREATE_FILE") return "FILE_CREATE";
  if (primitive.type === "DELETE_FILE") return "FILE_DELETE";
  return "FILE_MODIFY";
}

function primitiveForChange(change: AgentFileChange): FileEditingPrimitive {
  const supplied = change.editPrimitive;
  if (supplied) {
    if (supplied.path.replace(/\\/g, "/") !== change.path.replace(/\\/g, "/")) {
      throw new EditingConflictError("EDIT_CONFLICT", "Primitive path does not match its file change path.", change.path);
    }
    const declaredAction = change.action === "create"
      ? "FILE_CREATE"
      : change.action === "delete" || change.isDeleted
        ? "FILE_DELETE"
        : "FILE_MODIFY";
    if (primitiveAction(supplied) !== declaredAction) {
      throw new EditingConflictError("EDIT_CONFLICT", "Primitive type conflicts with the declared mutation action.", change.path);
    }
    return supplied;
  }
  if (change.action === "create") {
    return { type: "CREATE_FILE", path: change.path, content: change.content, description: change.description };
  }
  if (change.action === "delete" || change.isDeleted) {
    return { type: "DELETE_FILE", path: change.path, description: change.description };
  }
  if (change.action !== undefined && change.action !== "modify") {
    throw new EditingConflictError("EDIT_CONFLICT", `Unsupported mutation action "${String(change.action)}".`, change.path);
  }
  return { type: "REPLACE_FILE", path: change.path, content: change.content, description: change.description };
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
      } catch (error) {
        throw new RepairInfrastructureError(`Failed to snapshot current bytes for "${change.path}".`, error);
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

    const primitives = changes.map(primitiveForChange);
    await this.applyPrimitiveBatch(primitives, localPath, changes);
  }

  /** Guarded primitive entry point. It has no authority to validate or verify a task. */
  async applyPrimitives(primitives: readonly FileEditingPrimitive[], localPath: string | null | undefined): Promise<void> {
    if (!localPath) throw new RepairInfrastructureError("Cannot apply editing primitives: localPath is null or undefined.");
    await this.applyPrimitiveBatch(primitives, localPath);
  }

  private async applyPrimitiveBatch(
    primitives: readonly FileEditingPrimitive[],
    localPath: string,
    expectedChanges?: readonly AgentFileChange[],
  ): Promise<void> {
    const authorizedActions = this.authorizePrimitives(primitives, localPath);
    for (const primitive of primitives) this.authorizedMutationPaths.add(primitive.path.replace(/\\/g, "/"));

    if (expectedChanges) await this.snapshot([...expectedChanges], localPath);
    else {
      await this.snapshot(primitives.map((primitive) => ({
        path: primitive.path,
        content: "",
        description: primitive.description,
        action: primitiveAction(primitive) === "FILE_CREATE" ? "create" : primitiveAction(primitive) === "FILE_DELETE" ? "delete" : "modify",
        isDeleted: primitiveAction(primitive) === "FILE_DELETE" || undefined,
        editPrimitive: primitive,
      })), localPath);
    }

    const initial = new Map<string, Buffer | null>();
    const virtual = new Map<string, Buffer | null>();
    const finalByPath = new Map<string, Buffer | null>();
    const materialized = primitives.map((primitive, index) => {
      const absolutePath = canonicalMutationPath(primitive.path, localPath);
      if (!initial.has(absolutePath)) {
        const current = readCurrentBytes(absolutePath);
        initial.set(absolutePath, current);
        virtual.set(absolutePath, current);
      }
      const result = materializeEditingPrimitive(primitive, virtual.get(absolutePath) ?? null);
      virtual.set(absolutePath, result.after);
      finalByPath.set(absolutePath, result.after);
      const expected = expectedChanges?.[index];
      if (expected) {
        const actualContent = result.after?.toString("utf8") ?? "";
        const expectsDelete = expected.action === "delete" || expected.isDeleted;
        if ((expectsDelete && result.after !== null) || (!expectsDelete && actualContent !== expected.content)) {
          throw new EditingConflictError("EDIT_CONFLICT", "Primitive result does not match the deterministically expected change bytes.", primitive.path);
        }
      }
      return result;
    });

    try {
      for (const [absolutePath, after] of finalByPath) {
        const observed = readCurrentBytes(absolutePath);
        const expectedBefore = initial.get(absolutePath) ?? null;
        const unchanged = observed === null
          ? expectedBefore === null
          : expectedBefore !== null && fingerprintBytes(observed) === fingerprintBytes(expectedBefore);
        if (!unchanged) {
          const primitive = primitives.find((item) => canonicalMutationPath(item.path, localPath) === absolutePath)!;
          throw new EditingConflictError("STALE_SOURCE", "Target bytes changed during primitive materialization.", primitive.path);
        }
        if (after === null) {
          await fs.promises.rm(absolutePath, { force: false });
        } else {
          await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true });
          await fs.promises.writeFile(absolutePath, after);
        }
      }
      materialized.forEach((result, index) => this.executedMutations.push(Object.freeze({
        path: result.primitive.path.replace(/\\/g, "/"),
        action: authorizedActions[index],
        content: result.after?.toString("utf8") ?? "",
        description: result.primitive.description,
      })));
    } catch (error) {
      await this.rollback(localPath);
      if (error instanceof EditingConflictError || error instanceof RepairInfrastructureError) throw error;
      throw new RepairInfrastructureError(`Failed applying deterministic editing primitive batch.`, error);
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
    return this.authorizePrimitives(changes.map(primitiveForChange), localPath);
  }

  private authorizePrimitives(primitives: readonly FileEditingPrimitive[], localPath: string): CapabilityAction[] {
    const actions: CapabilityAction[] = [];
    for (const primitive of primitives) {
      assertSafeWorktreePath(primitive.path, localPath);
      const action = primitiveAction(primitive);
      const decision = this.capabilityGuard.authorize({ action, path: primitive.path, scopeId: this.capabilityScopeId });
      if (!decision.allowed) {
        if ("technical" in decision) throw new RepairInfrastructureError(`[${decision.code}] ${decision.reason}`, decision.cause);
        throw new CapabilityAuthorizationError(decision.code, `[${decision.code}] ${decision.reason}`);
      }
      canonicalMutationPath(primitive.path, localPath);
      actions.push(action);
    }
    return actions;
  }
}
