import { AgentFileChange, FileManifest } from "../../types";
import { normalizeRepoPath } from "../repository/SemanticContextResolver";

export type ManifestPlanningObservationReason = "UNPLANNED_PATH" | "PLANNED_ACTION_DIFFERED";

export interface ManifestPlanningObservation {
  path: string;
  reason: ManifestPlanningObservationReason;
  message: string;
  plannedAction?: "create" | "modify" | "delete";
  actualAction: "create" | "modify" | "delete";
}

/**
 * Compares executed proposals with the planning manifest for audit/provenance only.
 * Consumers must not use observations as mutation, validation, checkpoint, or
 * completion authority.
 */
export function auditManifestPlan(
  changes: readonly AgentFileChange[],
  manifest: FileManifest | null | undefined,
  resolveAction: (change: AgentFileChange) => "create" | "modify" | "delete",
): ManifestPlanningObservation[] {
  if (!manifest || !Array.isArray(manifest.files)) return [];
  const planned = new Map(
    manifest.files
      .filter((file) => file && typeof file.path === "string")
      .map((file) => [normalizeRepoPath(file.path), file.action] as const),
  );

  const observations: ManifestPlanningObservation[] = [];
  for (const change of changes) {
    if (!change || typeof change.path !== "string") continue;
    const actualAction = resolveAction(change);
    const plannedAction = planned.get(normalizeRepoPath(change.path));
    if (!plannedAction) {
      observations.push({
        path: change.path,
        reason: "UNPLANNED_PATH",
        message: `Executed proposal "${change.path}" was not present in the planning manifest.`,
        actualAction,
      });
    } else if (plannedAction !== actualAction) {
      observations.push({
        path: change.path,
        reason: "PLANNED_ACTION_DIFFERED",
        message: `Planning manifest proposed "${plannedAction}" for "${change.path}"; execution proposed "${actualAction}".`,
        plannedAction,
        actualAction,
      });
    }
  }
  return observations;
}
