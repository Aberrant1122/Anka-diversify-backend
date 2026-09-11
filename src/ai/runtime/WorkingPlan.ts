export type WorkingPlanStatus =
  | "ACTIVE"
  | "REVISION_REQUIRED"
  | "AWAITING_COMPLETION_EVALUATION"
  | "BLOCKED";

export interface WorkingPlanFailure {
  readonly code: string;
  readonly category: "TECHNICAL_FAILURE" | "AUTHORIZATION_DENIAL" | "VALIDATION_FAILURE";
  readonly deterministic: true;
}

export interface WorkingPlanSnapshot {
  readonly id: string;
  readonly revision: number;
  readonly status: WorkingPlanStatus;
  readonly advisoryStageIds: readonly string[];
  readonly advisoryHypothesis?: string;
  readonly revisionReason?: string;
  readonly lastFailure?: WorkingPlanFailure;
  readonly authority: "ADVISORY_ONLY_NO_FILESYSTEM_AUTHORITY";
}

function requireText(value: string, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function freeze(snapshot: WorkingPlanSnapshot): WorkingPlanSnapshot {
  Object.freeze(snapshot.advisoryStageIds);
  if (snapshot.lastFailure) Object.freeze(snapshot.lastFailure);
  return Object.freeze(snapshot);
}

/** Mutable-by-replacement loop plan. It contains suggestions, never authority or verified facts. */
export class WorkingPlan {
  private constructor(private readonly value: WorkingPlanSnapshot) {}

  public static create(input: {
    id: string;
    advisoryStageIds?: readonly string[];
    advisoryHypothesis?: string;
  }): WorkingPlan {
    return new WorkingPlan(freeze({
      id: requireText(input.id, "working plan id"),
      revision: 1,
      status: "ACTIVE",
      advisoryStageIds: Object.freeze([...(input.advisoryStageIds ?? [])].map((id) => requireText(id, "stage id"))),
      ...(input.advisoryHypothesis
        ? { advisoryHypothesis: requireText(input.advisoryHypothesis, "advisory hypothesis") }
        : {}),
      authority: "ADVISORY_ONLY_NO_FILESYSTEM_AUTHORITY",
    }));
  }

  public revise(input: {
    advisoryStageIds?: readonly string[];
    advisoryHypothesis?: string;
    reason: string;
  }): WorkingPlan {
    return this.copy({
      revision: this.value.revision + 1,
      status: "ACTIVE",
      advisoryStageIds: Object.freeze(
        [...(input.advisoryStageIds ?? this.value.advisoryStageIds)].map((id) => requireText(id, "stage id")),
      ),
      ...(input.advisoryHypothesis
        ? { advisoryHypothesis: requireText(input.advisoryHypothesis, "advisory hypothesis") }
        : {}),
      revisionReason: requireText(input.reason, "working plan revision reason"),
      lastFailure: undefined,
    });
  }

  public requireRevision(failure: WorkingPlanFailure): WorkingPlan {
    if (failure.deterministic !== true) throw new Error("Working plan failures require deterministic provenance");
    return this.copy({
      status: "REVISION_REQUIRED",
      lastFailure: {
        code: requireText(failure.code, "failure code"),
        category: failure.category,
        deterministic: true,
      },
    });
  }

  public awaitCompletionEvaluation(): WorkingPlan {
    return this.copy({ status: "AWAITING_COMPLETION_EVALUATION" });
  }

  public block(): WorkingPlan {
    return this.copy({ status: "BLOCKED" });
  }

  public snapshot(): WorkingPlanSnapshot {
    return this.value;
  }

  private copy(changes: Partial<WorkingPlanSnapshot>): WorkingPlan {
    const next: WorkingPlanSnapshot = {
      ...this.value,
      ...changes,
      advisoryStageIds: Object.freeze([...(changes.advisoryStageIds ?? this.value.advisoryStageIds)]),
      ...(changes.lastFailure === undefined && "lastFailure" in changes
        ? { lastFailure: undefined }
        : this.value.lastFailure
          ? { lastFailure: { ...this.value.lastFailure } }
          : {}),
    };
    return new WorkingPlan(freeze(next));
  }
}
