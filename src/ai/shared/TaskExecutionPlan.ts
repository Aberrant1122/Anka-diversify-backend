import { TaskIntentSpec } from "./TaskIntentSpec";
import { TaskClassificationResult, TaskType } from "../classification/TaskTypes";
import { TaskSuccessCondition } from "../../types";

export type StageExecutionStatus = "PENDING" | "RUNNING" | "VERIFIED" | "FAILED";
export type PlanExecutionStatus = "PENDING" | "RUNNING" | "FAILED" | "COMPLETED";

export interface TaskExecutionStageSpec {
  id: string;
  name?: string;
  taskType: TaskType;
  goal: string;
  successCondition?: TaskSuccessCondition;
  targetPath?: string;
  dependsOn?: string[];
}

export interface FileActionObligation {
  path: string;
  requiredAction: "create" | "modify" | "delete";
  role: "PRIMARY_TARGET" | "DEPENDENCY_CLEANUP" | "INTEGRATION" | "FEATURE_CREATION";
  evidenceIds: string[];
}

export interface ResolvedTaskTarget {
  logicalTargetId: string;
  featureName: string;
  candidatePaths: string[];
  evidenceIds: string[];
  importerPaths: string[];
  resolutionSource: "DETERMINISTIC_ACTIVE_GRAPH" | "DETERMINISTIC_UNIQUE" | "EXPLICIT_PATH" | "USER_CLARIFICATION";
  status: "RESOLVED" | "AMBIGUOUS" | "NOT_FOUND";
  actionObligations?: FileActionObligation[];
}

export interface TaskExecutionStage {
  id: string;
  name: string;
  intent: TaskIntentSpec;
  dependsOn: string[];
  status: StageExecutionStatus;
  resolvedTarget?: ResolvedTaskTarget;
  actionObligations?: FileActionObligation[];
}

export interface TaskExecutionPlan {
  id: string;
  goal: string;
  stages: TaskExecutionStage[];
  currentStageIndex: number;
  status: PlanExecutionStatus;
}
