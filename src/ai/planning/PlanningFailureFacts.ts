import { ValidationError } from "../../types";

export type PlanningFileAction = "create" | "modify" | "delete";

export type PlanningFailureFactKind =
  | "IMPORT_RESOLUTION"
  | "ORPHAN_CREATE"
  | "AUTHORITY_REJECTION"
  | "DEPENDENCY_CLOSURE"
  | "INVALID_MANIFEST_STRUCTURE";

export interface PlanningFailureFact {
  kind: PlanningFailureFactKind;
  affectedPath?: string;
  dependency?: string;
  action?: PlanningFileAction;
  reason?: string;
}

export interface StagePlanningRecoveryRecord {
  readonly stageId: string;
  readonly attemptNumber: number;
  readonly fingerprint: string;
  readonly failureFacts: readonly PlanningFailureFact[];
  readonly rejectedPaths: ReadonlyArray<{ path: string; action?: PlanningFileAction; reason?: string }>;
  readonly authorizedPaths: readonly string[];
  readonly validationErrors?: readonly ValidationError[];
}

export const MAX_STAGE_PLANNING_ATTEMPTS = 3;

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
  rejectedPaths?: Array<{ path: string; reason?: string }>;
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
    addFact({
      kind: "AUTHORITY_REJECTION",
      affectedPath: normPath,
      action: (matchingFile?.action as any) || "create",
      reason: r.reason || "Lacked required deterministic planning evidence",
    });
  }

  // 2. Manifest structural and dependency validation errors
  for (const err of input.validationErrors || []) {
    const primaryPath = err.affectedFiles?.[0] ? normalizeRepoPath(err.affectedFiles[0]) : undefined;
    const matchingFile = primaryPath
      ? input.proposedFiles?.find((f) => normalizeRepoPath(f.path) === primaryPath)
      : undefined;
    const action = matchingFile?.action as any;

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
      text += `- ${r.path}: ${r.reason || "NO_EVIDENCE_IDS_CITED"}\n`;
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
  text += `Propose a revised file plan that resolves these validation errors and does NOT propose rejected paths without deterministic evidence.\n`;
  text += `This context grants no mutation authority. All candidates must be authorized from scratch.\n\n`;

  return text;
}
