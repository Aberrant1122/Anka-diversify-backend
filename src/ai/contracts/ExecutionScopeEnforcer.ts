import { AgentFileChange, ExecutionContract, FileManifest } from "../../types";
import { normalizeRepoPath } from "../repository/SemanticContextResolver";
import { auditManifestPlan, ManifestPlanningObservation } from "../manifest/ManifestAudit";

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
  isRepair?: boolean;
}

export interface ExecutionScopeEnforcerResult {
  valid: boolean;
  errors: ScopeViolation[];
  /** Non-authoritative comparison retained solely for planning audit/provenance. */
  manifestObservations: ManifestPlanningObservation[];
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
 * Pure deterministic gate enforcing actual repository state and the trusted
 * execution contract. Manifest differences are returned as non-authoritative
 * audit observations and never affect `valid`.
 */
export function enforceExecutionScope(
  params: ExecutionScopeEnforcerParams
): ExecutionScopeEnforcerResult {
  const { proposedChanges, manifest, contract, existingFilePaths = [], isRepair = false } = params;

  const errors: ScopeViolation[] = [];

  if (!Array.isArray(proposedChanges) || proposedChanges.length === 0) {
    return { valid: true, errors: [], manifestObservations: [] };
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

  // Target paths check helper
  const targetPaths = (contract?.targetPaths || []).map(normalizeRepoPath).filter(Boolean);

  for (const change of proposedChanges) {
    if (!change || typeof change.path !== "string") continue;

    const normPath = normalizeRepoPath(change.path);
    const exists = existingSet.has(normPath);
    const effectiveAction = resolveEffectiveAction(change, exists);

    // Rule 1: Actual Repository State Verification
    if (!isRepair) {
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
    } else {
      // Repair inputs must still be materialized in the supplied current-state view.
      if (effectiveAction === "modify" && !exists) {
        errors.push({
          path: change.path,
          reason: "MODIFY_FILE_NOT_FOUND",
          message: `Cannot MODIFY file "${normPath}" during repair because it does not exist in the worktree.`,
          actualAction: effectiveAction,
        });
      }
    }

    // Rule 2: Contract Target Paths Defense-in-Depth
    if (targetPaths.length > 0) {
      const inTargetPath = targetPaths.some(
        (tp) => normPath === tp || normPath.startsWith(`${tp}/`) || normPath.startsWith(tp)
      );
      if (!inTargetPath) {
        errors.push({
          path: change.path,
          reason: "TARGET_PATH_VIOLATION",
          message: `File "${normPath}" is outside contract targetPaths [${targetPaths.join(", ")}].`,
          actualAction: effectiveAction,
        });
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    manifestObservations: auditManifestPlan(
      proposedChanges,
      manifest,
      (change) => resolveEffectiveAction(change, existingSet.has(normalizeRepoPath(change.path))),
    ),
  };
}
