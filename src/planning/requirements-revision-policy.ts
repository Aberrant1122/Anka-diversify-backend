import { PlanningDomainError } from "./planning-errors";
import { canonicalJson } from "./requirements-context";
import {
  REQUIREMENTS_ROOT_FIELDS,
  RequirementsContent,
} from "./requirements-schema";

export const D1_REVISION_OPERATIONS = Object.freeze([
  "DOCUMENT_REVISION",
  "FEEDBACK_APPLICATION",
] as const);

export type D1RevisionOperation = (typeof D1_REVISION_OPERATIONS)[number];

export const ID_BEARING_REQUIREMENTS_FIELDS = Object.freeze([
  "usersAndActors",
  "userStories",
  "functionalRequirements",
  "nonFunctionalRequirements",
  "constraints",
  "integrations",
  "assumptions",
  "acceptanceCriteria",
  "outOfScope",
  "unresolvedQuestions",
] as const);

export interface RequirementsDeterministicDiff {
  changedRootSections: string[];
  addedIds: string[];
  removedIds: string[];
  retainedIds: string[];
  modifiedIds: string[];
}

interface ItemEntry {
  id: string;
  section: string;
  item: unknown;
  payloadJson: string;
}

function extractPayload(item: unknown): Record<string, unknown> {
  const record = { ...(item as Record<string, unknown>) };
  delete record.id;
  return record;
}

function extractIdEntries(content: RequirementsContent): Map<string, ItemEntry> {
  const entries = new Map<string, ItemEntry>();
  for (const section of ID_BEARING_REQUIREMENTS_FIELDS) {
    const list = content[section];
    if (Array.isArray(list)) {
      for (const item of list) {
        if (item && typeof item === "object" && "id" in item && typeof (item as { id: unknown }).id === "string") {
          const id = (item as { id: string }).id;
          entries.set(id, {
            id,
            section,
            item,
            payloadJson: canonicalJson(extractPayload(item)),
          });
        }
      }
    }
  }
  return entries;
}

export function validateRevisionOperation(operation: string): asserts operation is D1RevisionOperation {
  if (!D1_REVISION_OPERATIONS.includes(operation as D1RevisionOperation)) {
    throw new PlanningDomainError(
      "PLANNING_ARTIFACT_INVALID",
      `Unsupported revision operation '${operation}'. Only whole-document revision operations are supported in Checkpoint 1C-D1.`,
      422,
      { operation, allowed: D1_REVISION_OPERATIONS },
    );
  }
}

export function isNoOpRequirementsRevision(
  base: RequirementsContent,
  successor: RequirementsContent,
): boolean {
  return canonicalJson(base) === canonicalJson(successor);
}

export function validateRevisionStableIds(
  base: RequirementsContent,
  successor: RequirementsContent,
): void {
  const baseEntries = extractIdEntries(base);
  const successorEntries = extractIdEntries(successor);

  // Rule 1: No ID moving between root collections
  for (const [id, successorEntry] of successorEntries) {
    const baseEntry = baseEntries.get(id);
    if (baseEntry && baseEntry.section !== successorEntry.section) {
      throw new PlanningDomainError(
        "PLANNING_ARTIFACT_INVALID",
        `Stable ID violation: ID '${id}' cannot move from root section '${baseEntry.section}' to '${successorEntry.section}'.`,
        422,
        { id, fromSection: baseEntry.section, toSection: successorEntry.section },
      );
    }
  }

  // Rule 2: Churned IDs for byte/canonically unchanged entities where deterministic comparison can prove continuity violation
  for (const [baseId, baseEntry] of baseEntries) {
    if (!successorEntries.has(baseId)) {
      // baseId was removed in successor. Check if any newly added ID has the exact same payload.
      for (const [successorId, successorEntry] of successorEntries) {
        if (!baseEntries.has(successorId) && successorEntry.payloadJson === baseEntry.payloadJson) {
          throw new PlanningDomainError(
            "PLANNING_ARTIFACT_INVALID",
            `Stable ID violation: unchanged entity in section '${baseEntry.section}' churned ID from '${baseId}' to '${successorId}'.`,
            422,
            { previousId: baseId, newId: successorId, section: baseEntry.section },
          );
        }
      }
    }
  }
}

export function computeRequirementsDiff(
  base: RequirementsContent,
  successor: RequirementsContent,
): RequirementsDeterministicDiff {
  const changedRootSections: string[] = [];

  for (const field of REQUIREMENTS_ROOT_FIELDS) {
    if (field === "projectGoal" || field === "problemStatement") {
      if (base[field] !== successor[field]) {
        changedRootSections.push(field);
      }
    } else {
      if (canonicalJson(base[field]) !== canonicalJson(successor[field])) {
        changedRootSections.push(field);
      }
    }
  }

  const baseEntries = extractIdEntries(base);
  const successorEntries = extractIdEntries(successor);

  const baseIds = new Set(baseEntries.keys());
  const successorIds = new Set(successorEntries.keys());

  const addedIds: string[] = [];
  const removedIds: string[] = [];
  const retainedIds: string[] = [];
  const modifiedIds: string[] = [];

  for (const id of successorIds) {
    if (!baseIds.has(id)) {
      addedIds.push(id);
    } else {
      const basePayload = baseEntries.get(id)!.payloadJson;
      const successorPayload = successorEntries.get(id)!.payloadJson;
      if (basePayload === successorPayload) {
        retainedIds.push(id);
      } else {
        modifiedIds.push(id);
      }
    }
  }

  for (const id of baseIds) {
    if (!successorIds.has(id)) {
      removedIds.push(id);
    }
  }

  addedIds.sort();
  removedIds.sort();
  retainedIds.sort();
  modifiedIds.sort();

  return {
    changedRootSections,
    addedIds,
    removedIds,
    retainedIds,
    modifiedIds,
  };
}
