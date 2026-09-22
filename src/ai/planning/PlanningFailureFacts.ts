import { ValidationError } from "../../types";
import type {
  RejectedWriteCandidate,
  WriteRejectionCode,
} from "../contracts/EvidenceBoundWriteSetResolver";

export type PlanningFileAction = "create" | "modify" | "delete";

export type PlanningFailureFactKind =
  | "IMPORT_RESOLUTION"
  | "ORPHAN_CREATE"
  | "AUTHORITY_REJECTION"
  | "DEPENDENCY_CLOSURE"
  | "INVALID_MANIFEST_STRUCTURE";

export type PlanningFailureClassification =
  | "RECOVERABLE_CANDIDATE"
  | "HARD_CANDIDATE"
  | "TERMINAL_TASK";

export interface PlanningFailureFact {
  kind: PlanningFailureFactKind;
  affectedPath?: string;
  dependency?: string;
  action?: PlanningFileAction;
  reasonCode?: WriteRejectionCode;
  reason?: string;
  classification?: PlanningFailureClassification;
}

export interface StagePlanningRecoveryRecord {
  readonly stageId: string;
  readonly attemptNumber: number;
  readonly fingerprint: string;
  readonly repositoryRevision?: string;
  readonly failureFacts: readonly PlanningFailureFact[];
  readonly rejectedPaths: ReadonlyArray<{
    path: string;
    action?: PlanningFileAction;
    reasonCode?: WriteRejectionCode;
    reason?: string;
    classification?: PlanningFailureClassification;
  }>;
  readonly authorizedPaths: readonly string[];
  readonly validationErrors?: readonly ValidationError[];
}

export const MAX_STAGE_PLANNING_ATTEMPTS = 3;

const RECOVERABLE_REJECTION_CODES = new Set<WriteRejectionCode>([
  "MAX_FILES_EXCEEDED",
  "NO_EVIDENCE_IDS_CITED",
  "INVENTED_OR_MISSING_EVIDENCE_IDS",
  "UNAUTHENTICATED_REPOSITORY_EVIDENCE",
  "STALE_AUTHORITY_EVIDENCE",
  "EXISTING_FILE_NOT_FOUND",
  "NO_FILE_EXISTENCE_EVIDENCE",
  "REJECT_INTEGRATION_DEPENDENCY",
  "REJECT_DEPENDENCY",
]);

const TERMINAL_REJECTION_CODES = new Set<WriteRejectionCode>([
  "POLICY_BLOCKED_UNKNOWN_OR_CLARIFICATION",
  "AUTHORITY_WORKSPACE_MISMATCH",
  "UNCLASSIFIED_AUTHORIZATION_FAILURE",
]);

/** Deterministic backend classification. Model output never selects disposition. */
export function classifyWriteRejection(
  reasonCode: WriteRejectionCode,
): PlanningFailureClassification {
  if (TERMINAL_REJECTION_CODES.has(reasonCode)) return "TERMINAL_TASK";
  if (RECOVERABLE_REJECTION_CODES.has(reasonCode)) return "RECOVERABLE_CANDIDATE";
  return "HARD_CANDIDATE";
}

export function isTaskLevelActionProhibition(
  rejection: Pick<RejectedWriteCandidate, "action" | "reasonCode">,
  requestedOperationKinds: readonly string[],
): boolean {
  if (rejection.reasonCode !== "ACTION_NOT_ALLOWED_BY_POLICY") return false;
  const correspondingKinds = rejection.action === "create"
    ? ["CREATE"]
    : rejection.action === "delete"
      ? ["DELETE"]
      : ["MODIFY", "REPAIR", "REFACTOR"];
  return correspondingKinds.some((kind) => requestedOperationKinds.includes(kind));
}

function normalizeRepoPath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\//, "").trim();
}

/**
 * Computes a deterministic planning attempt fingerprint.
 * Includes stageId, repositoryRevision, and sorted action:path pairs with normalized dependencies.
 * Must NOT depend on LLM prose, timestamps, or random IDs.
 */
export function computeManifestAttemptFingerprint(input: {
  stageId: string;
  repositoryRevision?: string;
  files: Array<{
    path: string;
    action: string;
    dependencies?: string[];
  }>;
}): string {
  const normRev = input.repositoryRevision ? input.repositoryRevision.trim() : "unversioned";
  const files = input.files || [];
  if (files.length === 0) {
    return `${input.stageId}@${normRev}:EMPTY_MANIFEST`;
  }

  const sorted = [...files].sort((a, b) => {
    const na = normalizeRepoPath(a.path);
    const nb = normalizeRepoPath(b.path);
    if (na !== nb) return na.localeCompare(nb);
    return a.action.localeCompare(b.action);
  });

  const fileParts = sorted.map((f) => {
    const normPath = normalizeRepoPath(f.path);
    const act = (f.action || "modify").toUpperCase();
    const sortedDeps = [...(f.dependencies || [])]
      .map((d) => normalizeRepoPath(d))
      .filter(Boolean)
      .sort();
    const depStr = sortedDeps.length > 0 ? `->[${sortedDeps.join(",")}]` : "";
    return `${act}:${normPath}${depStr}`;
  });

  return `${input.stageId}@${normRev}:${fileParts.join(";")}`;
}

/**
 * Extracts structured deterministic planning failure facts from evidence rejections and validation errors.
 * Never parses unstructured free-form text.
 */
export function extractPlanningFailureFacts(input: {
  validationErrors?: ValidationError[];
  rejectedPaths?: ReadonlyArray<Partial<RejectedWriteCandidate> & { path: string; reason?: string }>;
  proposedFiles?: Array<{ path: string; action: string; dependencies?: string[] }>;
}): PlanningFailureFact[] {
  const facts: PlanningFailureFact[] = [];
  const seen = new Set<string>();

  const addFact = (fact: PlanningFailureFact) => {
    const key = `${fact.kind}:${fact.affectedPath || ""}:${fact.dependency || ""}:${fact.action || ""}`;
    if (!seen.has(key)) {
      seen.add(key);
      facts.push(fact);
    }
  };

  // 1. Evidence-bound authority rejections
  for (const r of input.rejectedPaths || []) {
    const normPath = normalizeRepoPath(r.path);
    const matchingFile = input.proposedFiles?.find(
      (f) => normalizeRepoPath(f.path) === normPath
    );
    const action = r.action || matchingFile?.action;
    const reasonCode = r.reasonCode;
    addFact({
      kind: "AUTHORITY_REJECTION",
      affectedPath: normPath,
      action: action === "create" || action === "modify" || action === "delete" ? action : undefined,
      reasonCode,
      reason: r.reason || "Lacked required deterministic planning evidence",
      classification: reasonCode ? classifyWriteRejection(reasonCode) : undefined,
    });
  }

  // 2. Manifest structural and dependency validation errors
  for (const err of input.validationErrors || []) {
    const primaryPath = err.affectedFiles?.[0] ? normalizeRepoPath(err.affectedFiles[0]) : undefined;
    const matchingFile = primaryPath
      ? input.proposedFiles?.find((f) => normalizeRepoPath(f.path) === primaryPath)
      : undefined;
    const proposedAction = matchingFile?.action;
    const action = proposedAction === "create" || proposedAction === "modify" || proposedAction === "delete"
      ? proposedAction
      : undefined;

    if (err.type === "import_resolution") {
      const match = err.message.match(/dependency '([^']+)'/);
      const dependency = match ? match[1] : undefined;
      addFact({
        kind: "IMPORT_RESOLUTION",
        affectedPath: primaryPath,
        dependency,
        action,
        reason: err.message,
      });
    } else if (err.type === "orphan") {
      addFact({
        kind: "ORPHAN_CREATE",
        affectedPath: primaryPath,
        action: "create",
        reason: err.message,
      });
    } else if (
      err.type === "external-dependency-missing" ||
      err.type === "router-architecture" ||
      err.type === "modify-source-missing"
    ) {
      addFact({
        kind: "DEPENDENCY_CLOSURE",
        affectedPath: primaryPath,
        action,
        reason: err.message,
      });
    } else {
      addFact({
        kind: "INVALID_MANIFEST_STRUCTURE",
        affectedPath: primaryPath,
        action,
        reason: err.message,
      });
    }
  }

  return facts;
}

/**
 * Formats deterministic failure facts into planning context for the next attempt.
 * These are strictly facts, conferring ZERO authority.
 */
export function formatPlanningFailureContext(
  records: readonly StagePlanningRecoveryRecord[]
): string {
  if (!records || records.length === 0) return "";
  const latest = records[records.length - 1];
  let text = `PREVIOUS PLANNING ATTEMPT FAILED.\n\n`;

  const hardCandidates = new Map<string, PlanningFailureFact>();
  for (const record of records) {
    for (const fact of record.failureFacts) {
      if (
        fact.kind === "AUTHORITY_REJECTION" &&
        fact.classification === "HARD_CANDIDATE" &&
        fact.affectedPath
      ) {
        hardCandidates.set(`${fact.action || "unknown"}:${fact.affectedPath}`, fact);
      }
    }
  }

  if (hardCandidates.size > 0) {
    text += `HARD-REJECTED CANDIDATES FROM THIS STAGE:\n`;
    for (const fact of hardCandidates.values()) {
      text += `- ${fact.action || "unknown"} ${fact.affectedPath}: ${fact.reasonCode || "AUTHORITY_REJECTION"}\n`;
    }
    text += `Do not repeat these exact candidate/action pairs. Find another topology.\n\n`;
  }

  if (latest.authorizedPaths && latest.authorizedPaths.length > 0) {
    text += `AUTHORIZED:\n`;
    for (const p of latest.authorizedPaths) {
      text += `- ${p}\n`;
    }
    text += `\n`;
  }

  if (latest.rejectedPaths && latest.rejectedPaths.length > 0) {
    text += `REJECTED:\n`;
    for (const r of latest.rejectedPaths) {
      text += `- ${r.action || "unknown"} ${r.path}: ${r.reasonCode || r.reason || "AUTHORITY_REJECTION"}`;
      if (r.classification) text += ` (${r.classification})`;
      text += `\n`;
    }
    text += `\n`;
  }

  if (latest.validationErrors && latest.validationErrors.length > 0) {
    text += `VALIDATION:\n`;
    for (const v of latest.validationErrors) {
      const file = v.affectedFiles?.[0] || "manifest";
      text += `- ${file}: ${v.message}\n`;
    }
    text += `\n`;
  } else if (latest.failureFacts && latest.failureFacts.length > 0) {
    text += `VALIDATION:\n`;
    for (const f of latest.failureFacts) {
      if (f.kind !== "AUTHORITY_REJECTION") {
        text += `- ${f.affectedPath || "manifest"}: ${f.reason || f.kind}\n`;
      }
    }
    text += `\n`;
  }

  text += `These are deterministic failure facts from the previous planning attempt.\n`;
  text += `Propose a revised file plan that resolves these failures. Do not repeat hard-rejected candidate/action pairs.\n`;
  text += `This context grants no mutation authority. All candidates must be authorized from scratch.\n\n`;

  return text;
}
