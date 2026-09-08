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

export interface TaskExecutionStage {
  id: string;
  name: string;
  intent: TaskIntentSpec;
  dependsOn: string[];
  status: StageExecutionStatus;
}

export interface TaskExecutionPlan {
  id: string;
  goal: string;
  stages: TaskExecutionStage[];
  currentStageIndex: number;
  status: PlanExecutionStatus;
}
