import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { AgentFileChange, FileEditingPrimitive, FileManifest } from "../../types";
import { AuthorizedCapabilityScope, CapabilityAction, CapabilityGrant, CapabilityGuard } from "./CapabilityGuard";
import { AuthoritySnapshot, captureAuthoritySnapshot } from "../repository/AuthorityWorktree";
import { canonicalRepositoryPath } from "../repository/RepositoryBoundary";
import { fingerprintBytes, materializeEditingPrimitive, EditingConflictError } from "../editing/EditingPrimitives";
import { executionManifestUpdate, ExecutionManifestUpdate } from "./ExecutionManifest";
import { EvidenceBoundAuthorization, isAuthenticEvidenceBoundAuthorization } from "../contracts/EvidenceBoundWriteSetResolver";
import { CompiledMutation, MutationCompiler, MutationFailure, MutationFailureCode, MutationOperation, mutationPath } from "./MutationCompiler";

export interface RevisionTransitionReceipt {
  readonly transactionId: string;
  readonly repositoryIdentity: string;
  readonly parentRevision: string;
  readonly childRevision: string;
  readonly operations: readonly CompiledMutation[];
  readonly capabilityIds: readonly string[];
  readonly manifestVersion: string;
  readonly createdBy: "TRUSTED_MUTATION_RUNTIME";
}
export interface ExecutionWorkspaceBinding {
  readonly id: string;
  readonly transactionId: string;
  readonly repositoryIdentity: string;
  readonly workspaceRoot: string;
  readonly sourceRevision: string;
  readonly purpose: "PRIMARY_MUTATION" | "REPAIR_ATTEMPT";
}
interface WorkspaceState {
  revision: string;
  status: "ACTIVE" | "DISCARDED" | "PROMOTED";
  readonly snapshot: AuthoritySnapshot;
  operations: readonly CompiledMutation[];
}
interface TransactionState {
  readonly initialAuthorization: EvidenceBoundAuthorization;
  status: "ACTIVE" | "COMPLETED" | "INVALIDATED" | "ABORTED";
  revision: string;
  readonly canonicalRoot: string;
  readonly initial: AuthoritySnapshot;
  readonly bindings: Map<ExecutionWorkspaceBinding, WorkspaceState>;
  readonly receipts: RevisionTransitionReceipt[];
  readonly executed: AgentFileChange[];
  rollbackCompleted?: boolean;
}
const transactions = new WeakMap<MutationTransaction, TransactionState>();
const receipts = new WeakSet<object>();
const owners = new Map<string, MutationTransaction>();
const actionOf = (op: MutationOperation): CapabilityAction => op.op === "create_file" ? "FILE_CREATE" : op.op === "delete_file" ? "FILE_DELETE" : "FILE_MODIFY";
const manifestAction = (action: CapabilityAction) => action === "FILE_CREATE" ? "create" : action === "FILE_DELETE" ? "delete" : "modify";
function frozenCopy<T>(value: T): T {
  const copy: T = JSON.parse(JSON.stringify(value));
  const freeze = (v: unknown): void => {
    if (v && typeof v === "object") { Object.values(v).forEach(freeze); Object.freeze(v); }
  };
  freeze(copy);
  return copy;
}

/** Run-scoped authority. No restore-by-ID, public receipt issuer or revision setter exists.
 * Synchronous checked writes/promotion are indivisible to other JS operations. The
 * repository run also holds its existing project lock. Crashes lose all credentials.
 */
export class MutationTransaction {
  readonly id = crypto.randomUUID();
  readonly repositoryIdentity: string;
  readonly capabilities: readonly CapabilityGrant[];
  readonly capabilityScopeId: string;
  readonly authorityProofIds: readonly string[];
  readonly manifest: FileManifest;
  readonly manifestVersion: string;
  readonly manifestUpdates: readonly ExecutionManifestUpdate[];
  readonly baseRevision: string;
  readonly primary: ExecutionWorkspaceBinding;

  private constructor(scope: AuthorizedCapabilityScope, manifest: FileManifest, initial: AuthoritySnapshot, authorization: EvidenceBoundAuthorization) {
    this.repositoryIdentity = scope.repositoryIdBinding!;
    this.capabilityScopeId = scope.authorityId;
    this.capabilities = frozenCopy(scope.mode.grants);
    this.authorityProofIds = Object.freeze([authorization.authorizationId, ...authorization.getEvidenceIds()]);
    this.manifest = frozenCopy(manifest);
    this.manifestVersion = this.manifest.manifestVersion!;
    const update = executionManifestUpdate(manifest);
    this.manifestUpdates = Object.freeze(update ? [update] : []);
    this.baseRevision = initial.revision;
    this.primary = Object.freeze({ id: crypto.randomUUID(), transactionId: this.id, repositoryIdentity: this.repositoryIdentity,
      workspaceRoot: initial.canonicalRoot, sourceRevision: initial.revision, purpose: "PRIMARY_MUTATION" });
    transactions.set(this, { initialAuthorization: authorization, status: "ACTIVE", revision: initial.revision, canonicalRoot: initial.canonicalRoot, initial,
      bindings: new Map([[this.primary, { revision: initial.revision, status: "ACTIVE", snapshot: initial, operations: [] }]]), receipts: [], executed: [] });
    owners.set(initial.canonicalRoot, this);
    Object.freeze(this);
  }

  static create(scope: AuthorizedCapabilityScope, manifest: FileManifest): MutationTransaction {
    if (!(scope instanceof AuthorizedCapabilityScope) || !scope.isAuthentic()) throw new MutationFailure("TRANSACTION_INVALIDATED", "Authentic scope required.");
    const authorization = scope.currentExecutionAuthorization();
    if (!authorization || !scope.repositoryIdBinding || authorization.repositoryId !== scope.repositoryIdBinding) throw new MutationFailure("TRANSACTION_INVALIDATED", "Current independently established authority required.");
    const initial = captureAuthoritySnapshot(scope.workspaceRoot);
    if (initial.hasUnsupportedLinks || initial.revision !== authorization.getWorktreeRevision()) throw new MutationFailure("WORKSPACE_BINDING_INVALID", "Initial workspace is not the authorized snapshot.");
    if (owners.has(initial.canonicalRoot)) throw new MutationFailure("TRANSACTION_CONFLICT", "Workspace already has an active transaction.");
    if (!manifest?.manifestVersion || !Array.isArray(manifest.files)) throw new MutationFailure("CAPABILITY_MANIFEST_MISMATCH", "Current manifest required.");
    const update = executionManifestUpdate(manifest);
    if (update && update.authorizationId !== authorization.authorizationId) throw new MutationFailure("CAPABILITY_MANIFEST_MISMATCH", "Manifest update belongs to another authorization.");
    const initialGuard = CapabilityGuard.create({ workspaceRoot: scope.workspaceRoot, scopeId: authorization.getStageId()!, authorizedScope: scope });
    for (const grant of scope.mode.grants) {
      if (!initialGuard.authorize({ path: grant.path, action: grant.action, scopeId: authorization.getStageId()! }).allowed) {
        throw new MutationFailure("TRANSACTION_INVALIDATED", "Initial guard rejected repository/root/revision binding.");
      }
      if (!mutationPath(grant.path) || !manifest.files.some(f => f.path === grant.path && f.action === manifestAction(grant.action))) {
        throw new MutationFailure("CAPABILITY_MANIFEST_MISMATCH", `Manifest does not permit ${grant.action} ${grant.path}.`);
      }
    }
    return new MutationTransaction(scope, manifest, initial, authorization);
  }

  get currentRevision(): string { return this.state().revision; }
  get status(): TransactionState["status"] { return this.state().status; }
  get transitions(): readonly RevisionTransitionReceipt[] { return Object.freeze([...this.state().receipts]); }
  get changes(): AgentFileChange[] { return frozenCopy(this.state().executed); }

  private state(): TransactionState {
    const state = transactions.get(this);
    if (!state) throw new MutationFailure("TRANSACTION_INVALIDATED", "Unknown transaction; IDs are not credentials.");
    return state;
  }
  private fail(code: MutationFailureCode, message: string): never {
    const state = this.state();
    state.status = "INVALIDATED";
    // Keep ownership until explicit abort/completion. A stale transaction cannot reactivate.
    throw new MutationFailure(code, message);
  }
  private active(): TransactionState {
    const state = this.state();
    if (state.status !== "ACTIVE") throw new MutationFailure("TRANSACTION_INVALIDATED", "Transaction is no longer active.");
    if (!isAuthenticEvidenceBoundAuthorization(state.initialAuthorization)) this.fail("TRANSACTION_INVALIDATED", "Original authority provenance is missing.");
    let parent = this.baseRevision;
    for (const receipt of state.receipts) {
      if (!receipts.has(receipt) || receipt.transactionId !== this.id || receipt.repositoryIdentity !== this.repositoryIdentity
        || receipt.parentRevision !== parent || receipt.manifestVersion !== this.manifestVersion) this.fail("TRANSACTION_INVALIDATED", "Broken trusted lineage.");
      parent = receipt.childRevision;
    }
    if (parent !== state.revision) this.fail("TRANSACTION_INVALIDATED", "Current revision is not reachable through trusted receipts.");
    return state;
  }

  verify(binding: ExecutionWorkspaceBinding = this.primary): AuthoritySnapshot {
    const state = this.active();
    const workspace = state.bindings.get(binding);
    if (!workspace || workspace.status !== "ACTIVE" || binding.transactionId !== this.id || binding.repositoryIdentity !== this.repositoryIdentity) this.fail("WORKSPACE_BINDING_INVALID", "Workspace binding is not backend-issued for this transaction.");
    if (binding !== this.primary && binding.sourceRevision !== state.revision) this.fail("TRANSACTION_CONFLICT", "Repair was prepared against an obsolete parent revision.");
    let snapshot: AuthoritySnapshot;
    try { snapshot = captureAuthoritySnapshot(binding.workspaceRoot); }
    catch { return this.fail("WORKSPACE_BINDING_INVALID", "Cannot verify canonical workspace bytes."); }
    if (snapshot.canonicalRoot !== binding.workspaceRoot || snapshot.hasUnsupportedLinks) this.fail("WORKSPACE_BINDING_INVALID", "Workspace root or link boundary changed.");
    if (snapshot.revision !== workspace.revision) this.fail("TRANSACTION_REVISION_DIVERGED", "Workspace changed outside trusted mutation lineage; reacquire and reinvestigate.");
    if (binding === this.primary && snapshot.revision !== state.revision) this.fail("TRANSACTION_REVISION_DIVERGED", "Primary revision diverged.");
    return snapshot;
  }

  assertPrimaryRoot(root: string): void {
    this.verify();
    let canonical: string;
    try { canonical = fs.realpathSync(root); }
    catch { return this.fail("WORKSPACE_BINDING_INVALID", "Caller workspace cannot be verified."); }
    if (canonical !== this.primary.workspaceRoot) this.fail("WORKSPACE_BINDING_INVALID", "Caller workspace is not the bound primary workspace.");
  }

  authorize(binding: ExecutionWorkspaceBinding, target: string, action: CapabilityAction): void {
    this.verify(binding);
    if (!this.capabilities.some(g => g.path === target && (g.action === action || (action === "FILE_MODIFY" && g.action === "FILE_CREATE")))) this.fail("REPAIR_SCOPE_EXPANSION_REQUIRED", "Requested path/action needs independent investigation and authorization.");
    if (!this.manifest.files.some(f => f.path === target && (f.action === manifestAction(action) || (action === "FILE_MODIFY" && f.action === "create")))) this.fail("CAPABILITY_MANIFEST_MISMATCH", "Both capability and current manifest are mandatory.");
    if (!mutationPath(target) || !canonicalRepositoryPath(binding.workspaceRoot, target, true)) this.fail("WORKSPACE_BINDING_INVALID", "Mutation target escapes the canonical workspace.");
  }

  /** Backend creates the path and copies actual source bytes; callers cannot supply a root. */
  createRepairWorkspace(): ExecutionWorkspaceBinding {
    const snapshot = this.verify();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "anka-repair-"));
    try {
      for (const [file, bytes] of snapshot.files) {
        const target = path.join(root, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, Buffer.from(bytes, "base64"));
      }
      // Dependencies are copied, never junctioned to the primary. Validation cannot
      // write through a shared dependency link into last-known-good state.
      const dependencies = path.join(this.primary.workspaceRoot, "node_modules");
      if (fs.existsSync(dependencies)) fs.cpSync(dependencies, path.join(root, "node_modules"), { recursive: true, dereference: true });
      const copied = captureAuthoritySnapshot(root);
      this.verify();
      if (copied.revision !== snapshot.revision || copied.hasUnsupportedLinks) this.fail("WORKSPACE_BINDING_INVALID", "Copied bytes differ from the trusted source.");
      const binding: ExecutionWorkspaceBinding = Object.freeze({ id: crypto.randomUUID(), transactionId: this.id, repositoryIdentity: this.repositoryIdentity,
        workspaceRoot: copied.canonicalRoot, sourceRevision: snapshot.revision, purpose: "REPAIR_ATTEMPT" });
      this.state().bindings.set(binding, { status: "ACTIVE", revision: copied.revision, snapshot: copied, operations: [] });
      return binding;
    } catch (error) {
      fs.rmSync(root, { recursive: true, force: true });
      throw error;
    }
  }

  apply(operations: unknown, binding: ExecutionWorkspaceBinding = this.primary): void {
    const parent = this.verify(binding);
    const parsed = MutationCompiler.parse(operations);
    const guard = CapabilityGuard.forTransaction(this, binding);
    for (const operation of parsed) {
      const decision = guard.authorize({ path: operation.path, action: actionOf(operation), scopeId: this.id });
      if (!decision.allowed) throw new MutationFailure("code" in decision && decision.code === "REPAIR_SCOPE_EXPANSION_REQUIRED" ? "REPAIR_SCOPE_EXPANSION_REQUIRED" : "TRANSACTION_INVALIDATED", decision.reason);
    }
    const compiled = MutationCompiler.compile(parsed, parent.files);
    const expected = new Map(parent.files);
    for (const mutation of compiled) {
      if (mutation.after === null) expected.delete(mutation.operation.path); else expected.set(mutation.operation.path, mutation.after);
    }
    if (expected.size === parent.files.size && [...expected].every(([file, bytes]) => parent.files.get(file) === bytes)) {
      throw new MutationFailure("MUTATION_IR_INVALID", "Mutation batch has no effective byte change.");
    }
    this.verify(binding);
    try {
      this.writeCompiled(binding.workspaceRoot, compiled);
      const child = captureAuthoritySnapshot(binding.workspaceRoot);
      if (child.hasUnsupportedLinks || child.files.size !== expected.size || [...expected].some(([file, bytes]) => child.files.get(file) !== bytes)) this.fail("TRANSACTION_REVISION_DIVERGED", "Result contains an untrusted change.");
      const workspace = this.state().bindings.get(binding)!;
      workspace.revision = child.revision;
      workspace.operations = Object.freeze([...workspace.operations, ...compiled]);
      if (binding === this.primary) this.advance(parent.revision, child.revision, compiled);
    } catch (error) {
      this.state().status = "INVALIDATED";
      // An I/O failure can occur after an earlier operation wrote successfully.
      // Restore the checked parent before returning, without publishing lineage.
      if (!(error instanceof MutationFailure)) this.restoreTargets(binding.workspaceRoot, parent, compiled);
      throw error;
    }
  }

  private restoreTargets(root: string, snapshot: AuthoritySnapshot, operations: readonly CompiledMutation[]): void {
    if (fs.realpathSync(root) !== snapshot.canonicalRoot) this.fail("WORKSPACE_BINDING_INVALID", "Cannot restore a changed workspace root.");
    for (const file of new Set(operations.map(m => m.operation.path))) {
      const target = canonicalRepositoryPath(root, file, true);
      if (!target) this.fail("WORKSPACE_BINDING_INVALID", "Cannot restore a target outside its workspace.");
      const original = snapshot.files.get(file);
      if (original === undefined) { if (fs.existsSync(target)) fs.unlinkSync(target); }
      else { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, Buffer.from(original, "base64")); }
    }
    const restored = captureAuthoritySnapshot(root);
    if (restored.hasUnsupportedLinks || restored.revision !== snapshot.revision) this.fail("TRANSACTION_REVISION_DIVERGED", "Rollback did not restore the trusted parent bytes.");
  }

  private writeCompiled(root: string, operations: readonly CompiledMutation[]): void {
    for (const mutation of operations) {
      const target = canonicalRepositoryPath(root, mutation.operation.path, true);
      if (!target) this.fail("WORKSPACE_BINDING_INVALID", "Mutation destination escaped.");
      const before = fs.existsSync(target) ? fs.readFileSync(target).toString("base64") : null;
      if (before !== mutation.before) this.fail("TRANSACTION_REVISION_DIVERGED", "Mutation source changed before write.");
      if (mutation.after === null) fs.unlinkSync(target);
      else {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        if (canonicalRepositoryPath(root, mutation.operation.path, true) !== target) this.fail("WORKSPACE_BINDING_INVALID", "Destination changed during preparation.");
        fs.writeFileSync(target, Buffer.from(mutation.after, "base64"));
      }
    }
  }

  private advance(parentRevision: string, childRevision: string, operations: readonly CompiledMutation[]): void {
    const state = this.active();
    if (state.revision !== parentRevision) this.fail("TRANSACTION_CONFLICT", "Another transition advanced this transaction.");
    const receipt: RevisionTransitionReceipt = Object.freeze({ transactionId: this.id, repositoryIdentity: this.repositoryIdentity,
      parentRevision, childRevision, operations: Object.freeze([...operations]), capabilityIds: Object.freeze([this.capabilityScopeId]),
      manifestVersion: this.manifestVersion, createdBy: "TRUSTED_MUTATION_RUNTIME" });
    receipts.add(receipt);
    state.receipts.push(receipt);
    state.revision = childRevision;
    state.bindings.get(this.primary)!.revision = childRevision;
    for (const mutation of operations) {
      const change: AgentFileChange = { path: mutation.operation.path, action: manifestAction(actionOf(mutation.operation)),
        content: mutation.after === null ? "" : Buffer.from(mutation.after, "base64").toString("utf8"), description: mutation.operation.op };
      const existing = state.executed.findIndex(c => c.path === change.path);
      if (existing >= 0) state.executed[existing] = { ...change, action: state.executed[existing].action }; else state.executed.push(change);
    }
  }

  /** Validation executes inside the runtime; booleans/receipt metadata cannot promote. */
  async validateAndPromote(binding: ExecutionWorkspaceBinding, validate: (workspaceRoot: string) => Promise<boolean>): Promise<boolean> {
    this.verify(binding);
    if (binding === this.primary) this.fail("WORKSPACE_BINDING_INVALID", "Promotion requires a disposable repair workspace.");
    const passed = await validate(binding.workspaceRoot);
    this.verify(binding);
    this.verify();
    if (!passed) { this.discard(binding); return false; }
    const state = this.active();
    const workspace = state.bindings.get(binding)!;
    const parent = this.verify();
    // No await from the last parent check through byte verification and publication.
    try {
      this.writeCompiled(this.primary.workspaceRoot, workspace.operations);
      const promoted = captureAuthoritySnapshot(this.primary.workspaceRoot);
      if (promoted.revision !== workspace.revision || promoted.hasUnsupportedLinks) this.fail("TRANSACTION_REVISION_DIVERGED", "Promotion bytes do not match validated candidate.");
      this.advance(parent.revision, promoted.revision, workspace.operations);
      workspace.status = "PROMOTED";
      return true;
    } catch (error) {
      state.status = "INVALIDATED";
      // Restore only candidate mutation targets. Never publish a partial transition.
      this.restoreTargets(this.primary.workspaceRoot, parent, workspace.operations);
      throw error;
    }
  }

  /** Abort restores only runtime-authored paths, and only from a known descendant.
   * Unknown external bytes are left untouched and must be reinvestigated.
   */
  rollbackPrimary(root: string): void {
    const state = this.state();
    if (state.rollbackCompleted) return;
    if (state.status === "COMPLETED" || state.status === "ABORTED") throw new MutationFailure("TRANSACTION_INVALIDATED", "Inactive transaction cannot roll back.");
    let snapshot: AuthoritySnapshot;
    try { snapshot = captureAuthoritySnapshot(root); }
    catch { return this.fail("WORKSPACE_BINDING_INVALID", "Cannot verify rollback workspace."); }
    if (snapshot.canonicalRoot !== state.canonicalRoot || snapshot.hasUnsupportedLinks) this.fail("WORKSPACE_BINDING_INVALID", "Rollback workspace binding changed.");
    if (snapshot.revision !== state.revision) this.fail("TRANSACTION_REVISION_DIVERGED", "Unknown external bytes cannot be overwritten by rollback.");
    state.status = "INVALIDATED";
    this.restoreTargets(root, state.initial, state.receipts.flatMap(receipt => [...receipt.operations]));
    this.abort();
    state.rollbackCompleted = true;
  }

  discard(binding: ExecutionWorkspaceBinding): void {
    const workspace = this.state().bindings.get(binding);
    if (!workspace || binding === this.primary) this.fail("WORKSPACE_BINDING_INVALID", "Cannot discard an unowned workspace.");
    // Deletion is restricted to the exact minted canonical directory.
    if (fs.existsSync(binding.workspaceRoot) && fs.realpathSync(binding.workspaceRoot) === binding.workspaceRoot) fs.rmSync(binding.workspaceRoot, { recursive: true, force: true });
    workspace.status = "DISCARDED";
  }

  complete(): void {
    this.verify();
    for (const binding of this.state().bindings.keys()) if (binding !== this.primary) this.discard(binding);
    this.state().status = "COMPLETED";
    owners.delete(this.primary.workspaceRoot);
  }
  abort(): void {
    const state = this.state();
    if (state.status === "COMPLETED" || state.status === "ABORTED") return;
    state.status = "ABORTED";
    owners.delete(state.canonicalRoot);
    for (const binding of state.bindings.keys()) if (binding !== this.primary) this.discard(binding);
  }

  /** Adapter for already resolved initial generation proposals. Repair uses explicit IR. */
  applyChanges(changes: readonly AgentFileChange[]): void {
    const snapshot = this.verify();
    const operations: MutationOperation[] = [];
    for (const change of changes) {
      const before = snapshot.files.get(change.path);
      const beforeText = before === undefined ? "" : Buffer.from(before, "base64").toString("utf8");
      if ((change.action === "modify" || !change.action) && !change.isDeleted && before !== undefined && beforeText === change.content) {
        continue;
      }
      if (change.editPrimitive) {
        if (change.editPrimitive.path !== change.path) throw new MutationFailure("MUTATION_IR_INVALID", "Primitive and change paths differ.");
        const primitiveAction = change.editPrimitive.type === "CREATE_FILE" ? "create" : change.editPrimitive.type === "DELETE_FILE" ? "delete" : "modify";
        const declaredAction = change.isDeleted ? "delete" : change.action ?? "modify";
        if (primitiveAction !== declaredAction) throw new MutationFailure("MUTATION_IR_INVALID", "Primitive and change actions differ.");
        try {
          const materialized = materializeEditingPrimitive(change.editPrimitive, before === undefined ? null : Buffer.from(before, "base64"));
          if ((materialized.after?.toString("utf8") ?? "") !== change.content) throw new MutationFailure("MUTATION_IR_INVALID", "Primitive result and resolved generation bytes differ.");
        } catch (error) {
          if (!(error instanceof EditingConflictError)) throw error;
          throw MutationCompiler.editingConflict(error);
        }
      }
      const expectedFileHash = before === undefined ? null : fingerprintBytes(Buffer.from(before, "base64"));
      if (change.action === "create") {
        operations.push({ op: "create_file", path: change.path, expectedFileHash: null, content: change.content });
      } else if (change.action === "delete" || change.isDeleted) {
        operations.push({ op: "delete_file", path: change.path, expectedFileHash });
      } else {
        operations.push({ op: "replace_exact", path: change.path, expectedFileHash, oldText: before === undefined ? "" : Buffer.from(before, "base64").toString("utf8"), newText: change.content });
      }
    }
    if (operations.length === 0) return;
    this.apply(operations);
  }

  /** Existing editing tools compile into the same canonical IR; none write around lineage. */
  applyPrimitives(primitives: readonly FileEditingPrimitive[]): void {
    const files = new Map(this.verify().files);
    const operations: MutationOperation[] = [];
    const append = (operation: MutationOperation) => {
      const [compiled] = MutationCompiler.compile([operation], files);
      if (compiled.after === null) files.delete(operation.path); else files.set(operation.path, compiled.after);
      operations.push(operation);
    };
    for (const primitive of primitives) {
      const source = files.get(primitive.path);
      const bytes = source === undefined ? null : Buffer.from(source, "base64");
      let expected: Buffer | null;
      try { expected = materializeEditingPrimitive(primitive, bytes).after; }
      catch (error) {
        if (!(error instanceof EditingConflictError)) throw error;
        throw MutationCompiler.editingConflict(error);
      }
      const common = { path: primitive.path, expectedFileHash: bytes === null ? null : fingerprintBytes(bytes) };
      if (primitive.type === "CREATE_FILE") append({ ...common, op: "create_file", content: primitive.content });
      else if (primitive.type === "DELETE_FILE") append({ ...common, op: "delete_file" });
      else if (primitive.type === "INSERT_BEFORE" || primitive.type === "INSERT_AFTER") append({ ...common,
        op: primitive.type === "INSERT_BEFORE" ? "insert_before" : "insert_after", anchor: primitive.anchor, content: primitive.content });
      else if (primitive.type === "PATCH_HUNK") {
        for (const edit of primitive.edits) append({ op: "replace_exact", path: primitive.path,
          expectedFileHash: fingerprintBytes(Buffer.from(files.get(primitive.path)!, "base64")), oldText: edit.oldText, newText: edit.newText });
      } else append({ ...common, op: "replace_exact", oldText: primitive.type === "EXACT_REPLACE" ? primitive.oldText : bytes?.toString("utf8") ?? "",
        newText: primitive.type === "EXACT_REPLACE" ? primitive.newText : primitive.content });
      if ((files.get(primitive.path) ?? null) !== (expected?.toString("base64") ?? null)) throw new MutationFailure("MUTATION_IR_INVALID", "Primitive semantics differ from canonical mutation IR.");
    }
    this.apply(operations);
  }
}
