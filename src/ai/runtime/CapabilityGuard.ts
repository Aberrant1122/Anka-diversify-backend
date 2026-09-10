import fs from "fs";
import path from "path";

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
  grants: readonly CapabilityGrant[];
}

export interface AuthenticatedProjectAuthorityInput {
  workspaceRoot: string;
  authorityId: string;
  grants: readonly CapabilityGrant[];
}

export interface ExactBackendAuthorityInput {
  workspaceRoot: string;
  authorityId: string;
  grants: readonly CapabilityGrant[];
}

interface CapabilityPolicy {
  readonly workspaceRoot: string;
  readonly canonicalWorkspaceRoot: string;
  readonly scopeId: string;
  readonly grants: Readonly<Record<string, readonly CapabilityAction[]>>;
}

const KNOWN_ACTIONS: readonly CapabilityAction[] = ["FILE_CREATE", "FILE_MODIFY", "FILE_DELETE"];
const AUTHORITY_MARKER = Symbol("backend capability authority");

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
    public readonly source: "ISOLATED_GIT_WORKTREE" | "AUTHENTICATED_PROJECT_LOCAL_EDIT" | "BACKEND_TEST_CONFIGURATION",
    public readonly mode: AuthorizedCapabilityScopeMode,
  ) {
    Object.freeze(this);
  }

  public static fromIsolatedWorktree(input: IsolatedWorktreeAuthorityInput): AuthorizedCapabilityScope | null {
    return this.createExactAuthority(input, "ISOLATED_GIT_WORKTREE");
  }

  public static fromAuthenticatedProject(input: AuthenticatedProjectAuthorityInput): AuthorizedCapabilityScope | null {
    return this.createExactAuthority(input, "AUTHENTICATED_PROJECT_LOCAL_EDIT");
  }

  /** Exact deterministic grants for backend fixtures and narrowly configured runtimes. */
  public static fromBackendConfiguration(input: ExactBackendAuthorityInput): AuthorizedCapabilityScope | null {
    return this.createExactAuthority(input, "BACKEND_TEST_CONFIGURATION");
  }

  public isAuthentic(): boolean {
    return this.marker === AUTHORITY_MARKER;
  }

  private static createExactAuthority(
    input: ExactBackendAuthorityInput,
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
    return new AuthorizedCapabilityScope(authorityId, path.resolve(workspaceRootText), source, mode);
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
