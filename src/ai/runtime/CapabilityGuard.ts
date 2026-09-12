import fs from "fs";
import path from "path";
import {
  EvidenceBoundAuthorization,
  isAuthenticEvidenceBoundAuthorization,
} from "../contracts/EvidenceBoundWriteSetResolver";

export type CapabilityAction = "FILE_CREATE" | "FILE_MODIFY" | "FILE_DELETE";

export type CapabilityDenialCode =
  | "CAPABILITY_POLICY_MISSING"
  | "CAPABILITY_REQUEST_MALFORMED"
  | "CAPABILITY_ACTION_UNKNOWN"
  | "CAPABILITY_SCOPE_MISMATCH"
  | "CAPABILITY_PATH_OUTSIDE_WORKSPACE"
  | "CAPABILITY_PATH_NOT_DECLARED"
  | "CAPABILITY_ACTION_NOT_DECLARED";

export interface CapabilityGrant {
  action: CapabilityAction;
  path: string;
}

export interface CapabilityRequest {
  action: CapabilityAction;
  path: string;
  scopeId: string;
}

export type CapabilityDecision =
  | { allowed: true; code: "CAPABILITY_ALLOWED"; normalizedPath: string }
  | { allowed: false; code: CapabilityDenialCode; reason: string }
  | { allowed: false; code: "CAPABILITY_TECHNICAL_FAILURE"; reason: string; technical: true; cause?: unknown };

export interface CapabilityPolicyInput {
  workspaceRoot: string;
  scopeId: string;
  authorizedScope: AuthorizedCapabilityScope;
}

export interface IsolatedWorktreeAuthorityInput {
  workspaceRoot: string;
  authorityId: string;
  repositoryId: string;
  runId: string;
  grants: readonly CapabilityGrant[];
  baseRevision?: string;
}

interface RejectedRawGrantInput {
  workspaceRoot: string;
  authorityId: string;
  grants: readonly CapabilityGrant[];
  baseRevision?: string;
}

export interface ExecutionDerivationContext {
  stageId?: string;
  workspaceRoot?: string;
  baseRevision?: string;
  authorityId?: string;
}

interface CapabilityPolicy {
  readonly workspaceRoot: string;
  readonly canonicalWorkspaceRoot: string;
  readonly scopeId: string;
  readonly grants: Readonly<Record<string, readonly CapabilityAction[]>>;
}

const KNOWN_ACTIONS: readonly CapabilityAction[] = ["FILE_CREATE", "FILE_MODIFY", "FILE_DELETE"];
const AUTHORITY_MARKER = Symbol("backend capability authority");

const authenticCapabilityScopes = new WeakSet<object>();

function requireText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeRelativePath(value: string): string | null {
  if (value.includes("\0")) return null;
  const candidate = value.replace(/\\/g, "/");
  if (path.posix.isAbsolute(candidate) || path.win32.isAbsolute(candidate)) return null;
  const normalized = path.posix.normalize(candidate).replace(/^\.\//, "");
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) return null;
  return normalized;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function canonicalizeTarget(workspaceRoot: string, normalizedPath: string): string {
  const absoluteTarget = path.resolve(workspaceRoot, normalizedPath);
  let existingAncestor = absoluteTarget;
  while (!fs.existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) break;
    existingAncestor = parent;
  }
  const canonicalAncestor = fs.realpathSync(existingAncestor);
  const unresolvedSuffix = path.relative(existingAncestor, absoluteTarget);
  return path.resolve(canonicalAncestor, unresolvedSuffix);
}

function readLiveGitHead(workspaceRoot: string): string | null {
  try {
    const dotGitPath = path.join(workspaceRoot, ".git");
    const stat = fs.statSync(dotGitPath);
    let gitDirectory = dotGitPath;
    if (stat.isFile()) {
      const pointer = fs.readFileSync(dotGitPath, "utf8").trim();
      if (!pointer.startsWith("gitdir:")) return null;
      gitDirectory = path.resolve(workspaceRoot, pointer.slice("gitdir:".length).trim());
    }
    const head = fs.readFileSync(path.join(gitDirectory, "HEAD"), "utf8").trim();
    if (/^[0-9a-f]{40}$/i.test(head)) return head.toLowerCase();
    if (!head.startsWith("ref:")) return null;
    const refName = head.slice("ref:".length).trim();
    const looseRefPath = path.join(gitDirectory, ...refName.split("/"));
    if (fs.existsSync(looseRefPath)) return fs.readFileSync(looseRefPath, "utf8").trim().toLowerCase();
    const commonDirPath = path.join(gitDirectory, "commondir");
    const commonDirectory = fs.existsSync(commonDirPath)
      ? path.resolve(gitDirectory, fs.readFileSync(commonDirPath, "utf8").trim())
      : gitDirectory;
    const commonLooseRef = path.join(commonDirectory, ...refName.split("/"));
    if (fs.existsSync(commonLooseRef)) return fs.readFileSync(commonLooseRef, "utf8").trim().toLowerCase();
    const packedRefs = path.join(commonDirectory, "packed-refs");
    if (!fs.existsSync(packedRefs)) return null;
    const match = fs.readFileSync(packedRefs, "utf8")
      .split(/\r?\n/)
      .find((line) => line.endsWith(` ${refName}`));
    return match ? match.slice(0, 40).toLowerCase() : null;
  } catch {
    return null;
  }
}

type AuthorizedCapabilityScopeMode = { kind: "EXACT_PATHS"; grants: readonly CapabilityGrant[] };

/**
 * Immutable authority issued only from deterministic backend execution state.
 * It deliberately accepts no manifest, planner, resolver, retrieval, or model data.
 */
export class AuthorizedCapabilityScope {
  private readonly marker = AUTHORITY_MARKER;

  private constructor(
    public readonly authorityId: string,
    public readonly workspaceRoot: string,
    public readonly source: "ISOLATED_GIT_WORKTREE",
    public readonly mode: AuthorizedCapabilityScopeMode,
    public readonly baseRevision?: string,
    public readonly repositoryIdBinding?: string,
    public readonly runId?: string,
  ) {
    authenticCapabilityScopes.add(this);
    Object.freeze(this);
  }

  public static fromIsolatedWorktree(input: IsolatedWorktreeAuthorityInput): AuthorizedCapabilityScope | null {
    // An isolated worktree is a trusted execution root, never a raw-grant issuer.
    // Stage writes are derived only from evidence authorization.
    if (input.grants.length !== 0 || !requireText(input.repositoryId) || !requireText(input.runId)) return null;
    return this.createExactAuthority(input, "ISOLATED_GIT_WORKTREE");
  }

  /** Compatibility rejection surface: raw backend grants cannot mint authority. */
  public static fromBackendConfiguration(_input: RejectedRawGrantInput): AuthorizedCapabilityScope | null {
    return null;
  }

  /** Compatibility rejection surface: project authentication is not file authority. */
  public static fromAuthenticatedProject(_input: RejectedRawGrantInput): AuthorizedCapabilityScope | null {
    return null;
  }

  public isAuthentic(): boolean {
    return this.marker === AUTHORITY_MARKER && authenticCapabilityScopes.has(this);
  }

  /**
   * Derives a new immutable execution capability scope ONLY from an authentic base scope
   * AND an authentic EvidenceBoundAuthorization artifact issued by EvidenceBoundWriteSetResolver.
   */
  public deriveExecutionScope(
    evidenceAuthorization: EvidenceBoundAuthorization,
    context?: ExecutionDerivationContext,
  ): AuthorizedCapabilityScope | null {
    if (!this.isAuthentic() || !(this instanceof AuthorizedCapabilityScope)) {
      return null;
    }
    if (!isAuthenticEvidenceBoundAuthorization(evidenceAuthorization)) {
      return null;
    }

    // Workspace / repository binding check
    const authWorkspaceRoot = evidenceAuthorization.getWorkspaceRoot();
    if (authWorkspaceRoot) {
      const canonicalScopeRoot = path.resolve(this.workspaceRoot);
      const canonicalAuthRoot = path.resolve(authWorkspaceRoot);
      if (canonicalScopeRoot !== canonicalAuthRoot) {
        try {
          if (fs.realpathSync(canonicalScopeRoot) !== fs.realpathSync(canonicalAuthRoot)) {
            return null;
          }
        } catch {
          return null;
        }
      }
    }

    if (!this.repositoryIdBinding || evidenceAuthorization.repositoryId !== this.repositoryIdBinding) {
      return null;
    }
    const authRunId = evidenceAuthorization.getRunId();
    if (!this.runId || authRunId !== this.runId) {
      return null;
    }

    if (context?.workspaceRoot) {
      const canonicalScopeRoot = path.resolve(this.workspaceRoot);
      const canonicalContextRoot = path.resolve(context.workspaceRoot);
      if (canonicalScopeRoot !== canonicalContextRoot) {
        try {
          if (fs.realpathSync(canonicalScopeRoot) !== fs.realpathSync(canonicalContextRoot)) {
            return null;
          }
        } catch {
          return null;
        }
      }
    }

    // Base revision binding check
    const authRevision = evidenceAuthorization.getBaseRevision();
    if (this.baseRevision && authRevision && this.baseRevision !== authRevision) {
      return null;
    }
    if (this.baseRevision && context?.baseRevision && this.baseRevision !== context.baseRevision) {
      return null;
    }

    const approvedGrants = evidenceAuthorization.getApprovedGrants();
    for (const grant of approvedGrants) {
      if (!grant || !KNOWN_ACTIONS.includes(grant.action)) return null;
      const grantPath = requireText(grant.path);
      const normalizedPath = grantPath ? normalizeRelativePath(grantPath) : null;
      if (!normalizedPath) return null;
    }

    const artifactStageId = evidenceAuthorization.getStageId();
    if (!artifactStageId || !context?.stageId || context.stageId !== artifactStageId) return null;
    const stageId = artifactStageId;
    const suffix = stageId && !this.authorityId.includes(`:stage:${stageId}`)
      ? `:stage:${stageId}`
      : stageId ? "" : (this.authorityId.endsWith(":execution") ? "" : ":execution");
    const derivedAuthorityId = `${this.authorityId}${suffix}`;
    // A derived scope is exact to this authorization; it never carries base or prior-stage writes.
    const mode = Object.freeze({ kind: "EXACT_PATHS" as const, grants: Object.freeze([...approvedGrants]) });
    const effectiveRevision = this.baseRevision || authRevision || context?.baseRevision;
    return new AuthorizedCapabilityScope(derivedAuthorityId, this.workspaceRoot, this.source, mode, effectiveRevision, this.repositoryIdBinding, this.runId);
  }

  private static createExactAuthority(
    input: IsolatedWorktreeAuthorityInput,
    source: AuthorizedCapabilityScope["source"],
  ): AuthorizedCapabilityScope | null {
    const authorityId = requireText(input.authorityId);
    const workspaceRootText = requireText(input.workspaceRoot);
    if (!authorityId || !workspaceRootText || !Array.isArray(input.grants)) return null;
    const grants: CapabilityGrant[] = [];
    for (const grant of input.grants) {
      if (!grant || !KNOWN_ACTIONS.includes(grant.action)) return null;
      const grantPath = requireText(grant.path);
      const normalizedPath = grantPath ? normalizeRelativePath(grantPath) : null;
      if (!normalizedPath) return null;
      grants.push(Object.freeze({ action: grant.action, path: normalizedPath }));
    }
    const mode = Object.freeze({ kind: "EXACT_PATHS" as const, grants: Object.freeze(grants) });
    const baseRevision = input.baseRevision ? requireText(input.baseRevision) ?? undefined : undefined;
    return new AuthorizedCapabilityScope(
      authorityId,
      path.resolve(workspaceRootText),
      source,
      mode,
      baseRevision,
      input.repositoryId,
      input.runId,
    );
  }
}

/**
 * Immutable deterministic authorization boundary for agent filesystem actions.
 * It consumes only backend-issued scope, path and action grants; evidence/model data
 * is intentionally absent from both the policy and request shapes.
 */
export class CapabilityGuard {
  private constructor(private readonly policy: CapabilityPolicy | null) {}

  public static denyAll(): CapabilityGuard {
    const guard = new CapabilityGuard(null);
    Object.freeze(guard);
    return guard;
  }

  public static create(input: CapabilityPolicyInput): CapabilityGuard {
    const workspaceRootText = requireText(input.workspaceRoot);
    const scopeId = requireText(input.scopeId);
    const authorizedScope = input.authorizedScope;
    if (!workspaceRootText || !scopeId || !(authorizedScope instanceof AuthorizedCapabilityScope) || !authorizedScope.isAuthentic()) {
      return CapabilityGuard.denyAll();
    }

    const workspaceRoot = path.resolve(workspaceRootText);
    let canonicalWorkspaceRoot: string;
    try {
      canonicalWorkspaceRoot = fs.realpathSync(workspaceRoot);
    } catch {
      return CapabilityGuard.denyAll();
    }

    let canonicalAuthorityRoot: string;
    try {
      canonicalAuthorityRoot = fs.realpathSync(authorizedScope.workspaceRoot);
    } catch {
      return CapabilityGuard.denyAll();
    }
    if (canonicalAuthorityRoot !== canonicalWorkspaceRoot) return CapabilityGuard.denyAll();

    if (authorizedScope.baseRevision && /^[0-9a-f]{40}$/i.test(authorizedScope.baseRevision)) {
      const liveHead = readLiveGitHead(canonicalWorkspaceRoot);
      if (!liveHead || liveHead !== authorizedScope.baseRevision.toLowerCase()) return CapabilityGuard.denyAll();
    }

    const authorityGrants = authorizedScope.mode.grants;
    const mutableGrants = new Map<string, Set<CapabilityAction>>();
    for (const grant of authorityGrants) {
      if (!grant || !KNOWN_ACTIONS.includes(grant.action)) return CapabilityGuard.denyAll();
      const grantPath = requireText(grant.path);
      const normalizedPath = grantPath ? normalizeRelativePath(grantPath) : null;
      if (!normalizedPath) return CapabilityGuard.denyAll();
      const actions = mutableGrants.get(normalizedPath) ?? new Set<CapabilityAction>();
      actions.add(grant.action);
      mutableGrants.set(normalizedPath, actions);
    }

    const immutableGrants: Record<string, readonly CapabilityAction[]> = Object.create(null) as Record<string, readonly CapabilityAction[]>;
    for (const [grantPath, actions] of mutableGrants) {
      immutableGrants[grantPath] = Object.freeze([...actions].sort());
    }
    const policy: CapabilityPolicy = Object.freeze({
      workspaceRoot,
      canonicalWorkspaceRoot,
      scopeId,
      grants: Object.freeze(immutableGrants),
    });
    const guard = new CapabilityGuard(policy);
    Object.freeze(guard);
    return guard;
  }

  public authorize(request: CapabilityRequest): CapabilityDecision {
    if (!this.policy) {
      return { allowed: false, code: "CAPABILITY_POLICY_MISSING", reason: "No valid capability policy was supplied." };
    }
    if (!request || !requireText(request.path) || !requireText(request.scopeId)) {
      return { allowed: false, code: "CAPABILITY_REQUEST_MALFORMED", reason: "Capability request is malformed." };
    }
    if (!KNOWN_ACTIONS.includes(request.action)) {
      return { allowed: false, code: "CAPABILITY_ACTION_UNKNOWN", reason: `Unknown capability action: ${String(request.action)}` };
    }
    if (request.scopeId !== this.policy.scopeId) {
      return { allowed: false, code: "CAPABILITY_SCOPE_MISMATCH", reason: `Capability scope "${request.scopeId}" does not match the active scope.` };
    }

    const normalizedPath = normalizeRelativePath(request.path);
    if (!normalizedPath) {
      return { allowed: false, code: "CAPABILITY_PATH_OUTSIDE_WORKSPACE", reason: `Path "${request.path}" is not repository-relative.` };
    }
    const lexicalTarget = path.resolve(this.policy.workspaceRoot, normalizedPath);
    if (!isWithin(this.policy.workspaceRoot, lexicalTarget)) {
      return { allowed: false, code: "CAPABILITY_PATH_OUTSIDE_WORKSPACE", reason: `Path "${request.path}" escapes the authorized workspace.` };
    }

    try {
      const canonicalTarget = canonicalizeTarget(this.policy.workspaceRoot, normalizedPath);
      if (!isWithin(this.policy.canonicalWorkspaceRoot, canonicalTarget)) {
        return { allowed: false, code: "CAPABILITY_PATH_OUTSIDE_WORKSPACE", reason: `Path "${request.path}" resolves outside the authorized workspace.` };
      }
    } catch (cause: unknown) {
      return { allowed: false, code: "CAPABILITY_TECHNICAL_FAILURE", reason: `Unable to canonicalize capability target "${request.path}".`, technical: true, cause };
    }

    const declaredActions = this.policy.grants[normalizedPath];
    if (!declaredActions) {
      return { allowed: false, code: "CAPABILITY_PATH_NOT_DECLARED", reason: `Path "${normalizedPath}" is not in the authorized write-set.` };
    }
    if (!declaredActions.includes(request.action)) {
      return { allowed: false, code: "CAPABILITY_ACTION_NOT_DECLARED", reason: `Action "${request.action}" is not authorized for "${normalizedPath}".` };
    }
    return { allowed: true, code: "CAPABILITY_ALLOWED", normalizedPath };
  }
}
