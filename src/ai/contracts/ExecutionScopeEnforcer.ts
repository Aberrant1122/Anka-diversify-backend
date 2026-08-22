import { AgentFileChange, ExecutionContract, FileManifest } from "../../types";
import { normalizeRepoPath } from "../repository/SemanticContextResolver";

export type ScopeViolationReason =
  | "UNDECLARED_FILE"
  | "ACTION_MISMATCH"
  | "CREATE_FILE_ALREADY_EXISTS"
  | "MODIFY_FILE_NOT_FOUND"
  | "DELETE_FILE_NOT_FOUND"
  | "MAX_FILES_EXCEEDED"
  | "TARGET_PATH_VIOLATION";

export interface ScopeViolation {
  path: string;
  reason: ScopeViolationReason;
  message: string;
  expectedAction?: "create" | "modify" | "delete";
  actualAction?: "create" | "modify" | "delete";
}

export interface ExecutionScopeEnforcerParams {
  proposedChanges: AgentFileChange[];
  manifest?: FileManifest | null;
  contract?: ExecutionContract | null;
  existingFilePaths?: string[] | Set<string>;
}

export interface ExecutionScopeEnforcerResult {
  valid: boolean;
  errors: ScopeViolation[];
}

/**
 * Resolves the effective file action for an AgentFileChange.
 * If change.action is omitted, infers "modify" if the file exists or "create" if it does not.
 */
export function resolveEffectiveAction(
  change: AgentFileChange,
  exists: boolean
): "create" | "modify" | "delete" {
  if (change.action === "delete" || change.isDeleted === true) {
    return "delete";
  }
  if (change.action === "create" || change.action === "modify") {
    return change.action;
  }
  return exists ? "modify" : "create";
}

/**
 * Pure deterministic gate enforcing that generated file changes strictly adhere to:
 * 1. Approved FileManifest (declared paths and actions: create | modify | delete).
 * 2. Actual repository state (cannot create existing, cannot modify/delete missing).
 * 3. ExecutionContract bounds (maxFiles, targetPaths) without broad-task bypass.
 */
export function enforceExecutionScope(
  params: ExecutionScopeEnforcerParams
): ExecutionScopeEnforcerResult {
  const { proposedChanges, manifest, contract, existingFilePaths = [] } = params;

  const errors: ScopeViolation[] = [];

  if (!Array.isArray(proposedChanges) || proposedChanges.length === 0) {
    return { valid: true, errors: [] };
  }

  // 1. Max Files Check (defense in depth)
  if (contract && typeof contract.maxFiles === "number" && contract.maxFiles > 0) {
    if (proposedChanges.length > contract.maxFiles) {
      errors.push({
        path: "(total_changes)",
        reason: "MAX_FILES_EXCEEDED",
        message: `Generated ${proposedChanges.length} file changes, which exceeds the contract maxFiles limit of ${contract.maxFiles}.`,
      });
    }
  }

  // Build normalized existing file set
  const existingSet = new Set<string>();
  if (existingFilePaths instanceof Set) {
    for (const p of existingFilePaths) {
      if (typeof p === "string") existingSet.add(normalizeRepoPath(p));
    }
  } else if (Array.isArray(existingFilePaths)) {
    for (const p of existingFilePaths) {
      if (typeof p === "string") existingSet.add(normalizeRepoPath(p));
    }
  }

  // Build normalized manifest lookup
  const manifestLookup = new Map<
    string,
    { path: string; action: "create" | "modify" | "delete" }
  >();
  if (manifest && Array.isArray(manifest.files)) {
    for (const fileDecl of manifest.files) {
      if (fileDecl && typeof fileDecl.path === "string") {
        const norm = normalizeRepoPath(fileDecl.path);
        manifestLookup.set(norm, fileDecl);
      }
    }
  }

  // Target paths check helper
  const targetPaths = (contract?.targetPaths || []).map(normalizeRepoPath).filter(Boolean);

  for (const change of proposedChanges) {
    if (!change || typeof change.path !== "string") continue;

    const normPath = normalizeRepoPath(change.path);
    const exists = existingSet.has(normPath);
    const effectiveAction = resolveEffectiveAction(change, exists);

    // Rule 1: Manifest Declaration Check (Primary Authority)
    if (manifest && Array.isArray(manifest.files)) {
      const decl = manifestLookup.get(normPath);
      if (!decl) {
        errors.push({
          path: change.path,
          reason: "UNDECLARED_FILE",
          message: `File "${normPath}" was generated but not declared in the approved manifest.`,
          actualAction: effectiveAction,
        });
      } else if (decl.action !== effectiveAction) {
        errors.push({
          path: change.path,
          reason: "ACTION_MISMATCH",
          message: `File "${normPath}" was declared in manifest with action "${decl.action}", but generated change attempted action "${effectiveAction}".`,
          expectedAction: decl.action,
          actualAction: effectiveAction,
        });
      }
    }

    // Rule 2: Actual Repository State Verification
    if (effectiveAction === "create" && exists) {
      errors.push({
        path: change.path,
        reason: "CREATE_FILE_ALREADY_EXISTS",
        message: `Cannot CREATE file "${normPath}" because it already exists in the repository.`,
        actualAction: effectiveAction,
      });
    } else if (effectiveAction === "modify" && !exists) {
      errors.push({
        path: change.path,
        reason: "MODIFY_FILE_NOT_FOUND",
        message: `Cannot MODIFY file "${normPath}" because it does not exist in the repository.`,
        actualAction: effectiveAction,
      });
    } else if (effectiveAction === "delete" && !exists) {
      errors.push({
        path: change.path,
        reason: "DELETE_FILE_NOT_FOUND",
        message: `Cannot DELETE file "${normPath}" because it does not exist in the repository.`,
        actualAction: effectiveAction,
      });
    }

    // Rule 3: Contract Target Paths Defense-in-Depth
    if (targetPaths.length > 0) {
      const inTargetPath = targetPaths.some(
        (tp) => normPath === tp || normPath.startsWith(`${tp}/`) || normPath.startsWith(tp)
      );
      if (!inTargetPath) {
        errors.push({
          path: change.path,
          reason: "TARGET_PATH_VIOLATION",
          message: `File "${normPath}" is outside the authorized contract targetPaths [${targetPaths.join(", ")}].`,
          actualAction: effectiveAction,
        });
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
