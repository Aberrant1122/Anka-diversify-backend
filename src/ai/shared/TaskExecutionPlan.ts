import { TaskIntentSpec } from "./TaskIntentSpec";
import { TaskClassificationResult, TaskType } from "../classification/TaskTypes";

export type StageExecutionStatus = "PENDING" | "RUNNING" | "VERIFIED" | "FAILED";
export type PlanExecutionStatus = "PENDING" | "RUNNING" | "FAILED" | "COMPLETED";

export interface TaskExecutionStageSpec {
  id: string;
  name?: string;
  taskType: TaskType;
  goal: string;
  targetPath?: string;
  dependsOn?: string[];
}

export interface ResolvedTaskTarget {
  logicalTargetId: string;
  featureName: string;
  candidatePaths: string[];
  evidenceIds: string[];
  importerPaths: string[];
  resolutionSource: "DETERMINISTIC_ACTIVE_GRAPH" | "DETERMINISTIC_UNIQUE" | "EXPLICIT_PATH" | "USER_CLARIFICATION";
  status: "RESOLVED" | "AMBIGUOUS" | "NOT_FOUND";
}

export interface TaskExecutionStage {
  id: string;
  name: string;
  intent: TaskIntentSpec;
  dependsOn: string[];
  status: StageExecutionStatus;
  resolvedTarget?: ResolvedTaskTarget;
}

export interface TaskExecutionPlan {
  id: string;
  goal: string;
  stages: TaskExecutionStage[];
  currentStageIndex: number;
  status: PlanExecutionStatus;
}
