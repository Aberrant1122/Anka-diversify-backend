/**
 * Canonical PipelineStage enumeration for all AI runtime operations.
 *
 * Invariant: Every generative LLM Gateway call MUST specify a valid PipelineStage.
 * Stage is strictly required and cannot be omitted or optional.
 */
export const PipelineStages = {
  INTENT_CLASSIFICATION: "INTENT_CLASSIFICATION",
  PLAN_REORDER: "PLAN_REORDER",
  TASK_DECOMPOSITION: "TASK_DECOMPOSITION",
  REPOSITORY_REASONING: "REPOSITORY_REASONING",
  MANIFEST_GENERATION: "MANIFEST_GENERATION",
  MANIFEST_CORRECTION: "MANIFEST_CORRECTION",
  ROADMAP_PLANNING: "ROADMAP_PLANNING",
  CODE_GENERATION: "CODE_GENERATION",
  CODE_CORRECTION: "CODE_CORRECTION",
  REPAIR: "REPAIR",
  STATIC_REVIEW: "STATIC_REVIEW",
  FEATURE_VALIDATION: "FEATURE_VALIDATION",
  SECURITY_AUDIT: "SECURITY_AUDIT",
  APPLICATION_SUPPORT: "APPLICATION_SUPPORT",
  SUMMARIZATION: "SUMMARIZATION",
} as const;

export type PipelineStage = (typeof PipelineStages)[keyof typeof PipelineStages];

export function isValidPipelineStage(stage: unknown): stage is PipelineStage {
  return typeof stage === "string" && Object.values(PipelineStages).includes(stage as PipelineStage);
}
