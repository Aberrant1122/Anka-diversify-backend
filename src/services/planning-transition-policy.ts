import { PlanningDomainError } from "../planning/planning-errors";
import { REQUIREMENTS_PHASE } from "../planning/requirements-schema";

export const REQUIREMENTS_PHASE_STATUSES = [
  "not_started",
  "in_progress",
  "awaiting_approval",
  "approved",
  "changes_requested",
] as const;

export type RequirementsPhaseStatus = (typeof REQUIREMENTS_PHASE_STATUSES)[number];
export type RequirementsPlanningAction =
  | "create_initial_artifact"
  | "create_revision"
  | "request_approval"
  | "approve"
  | "request_changes"
  | "read";

export interface PlanningPolicySnapshot {
  status: RequirementsPhaseStatus;
  allowedActions: RequirementsPlanningAction[];
  locks: Partial<Record<RequirementsPlanningAction, { code: string; reason: string }>>;
}

const TRANSITIONS: Record<RequirementsPhaseStatus, readonly RequirementsPhaseStatus[]> = {
  not_started: ["in_progress"],
  in_progress: ["awaiting_approval"],
  awaiting_approval: ["approved", "changes_requested"],
  changes_requested: ["in_progress"],
  approved: ["in_progress"],
};

const ACTIONS: Record<RequirementsPhaseStatus, readonly RequirementsPlanningAction[]> = {
  not_started: ["read", "create_initial_artifact"],
  in_progress: ["read", "create_revision", "request_approval"],
  awaiting_approval: ["read", "approve", "request_changes"],
  changes_requested: ["read", "create_revision"],
  approved: ["read", "create_revision"],
};

export class PlanningTransitionPolicy {
  assertRequirementsPhase(phase: string): asserts phase is typeof REQUIREMENTS_PHASE {
    if (phase !== REQUIREMENTS_PHASE) {
      throw new PlanningDomainError(
        "PLANNING_INVALID_PHASE",
        `Checkpoint 1B supports only the Requirements phase, not '${phase}'.`,
        422,
        { phase },
      );
    }
  }

  parseStatus(status: string): RequirementsPhaseStatus {
    if (!REQUIREMENTS_PHASE_STATUSES.includes(status as RequirementsPhaseStatus)) {
      throw new PlanningDomainError(
        "PLANNING_INVALID_TRANSITION",
        `Unknown Requirements phase status '${status}'.`,
        409,
        { status },
      );
    }
    return status as RequirementsPhaseStatus;
  }

  assertTransition(from: string, to: RequirementsPhaseStatus): void {
    const current = this.parseStatus(from);
    if (!TRANSITIONS[current].includes(to)) {
      throw new PlanningDomainError(
        "PLANNING_INVALID_TRANSITION",
        `Requirements cannot transition from '${current}' to '${to}'.`,
        409,
        { from: current, to },
      );
    }
  }

  assertAction(status: string, action: RequirementsPlanningAction): void {
    const current = this.parseStatus(status);
    if (!ACTIONS[current].includes(action)) {
      throw new PlanningDomainError(
        "PLANNING_ACTION_LOCKED",
        `Action '${action}' is locked while Requirements is '${current}'.`,
        409,
        { status: current, action },
      );
    }
  }

  describe(status: string): PlanningPolicySnapshot {
    const current = this.parseStatus(status);
    const allowedActions = [...ACTIONS[current]];
    const locks: PlanningPolicySnapshot["locks"] = {};
    const allActions: RequirementsPlanningAction[] = [
      "create_initial_artifact",
      "create_revision",
      "request_approval",
      "approve",
      "request_changes",
      "read",
    ];
    for (const action of allActions) {
      if (!allowedActions.includes(action)) {
        locks[action] = {
          code: "PLANNING_ACTION_LOCKED",
          reason: `Action '${action}' is not allowed while Requirements is '${current}'.`,
        };
      }
    }
    return { status: current, allowedActions, locks };
  }
}
