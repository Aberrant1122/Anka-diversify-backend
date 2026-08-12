import { AgentProgressEvent, TaskType, TaskRisk, TaskComplexity, ExecutionContract } from "../shared/types";

export interface PipelineStepContext {
  step: number;
  stageName: string;
  label: string;
  detail: string;
  color: string;
  badge: string;
  progress: number;
  log: string;
  taskType?: TaskType;
  risk?: TaskRisk;
  estimatedComplexity?: TaskComplexity;
  targetPath?: string;
  executionContract?: ExecutionContract;
  durationMs: number;
}

export type ProgressCallback = (event: AgentProgressEvent) => void;
