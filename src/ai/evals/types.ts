export type EvalMode = "DETERMINISTIC" | "REAL_MODEL";

export type EvalCategory =
  | "BUG_FIX"
  | "CROSS_FILE"
  | "COMPILE_REPAIR"
  | "FEATURE_ADD"
  | "FILE_CREATION"
  | "FILE_DELETION"
  | "RETRIEVAL_CHALLENGE"
  | "SCOPE_CHALLENGE"
  | "STALE_STATE"
  | "DUPLICATE_SYMBOL"
  | "MISLEADING_FILENAMES"
  | "NESTED_SERVICE"
  | "IMPL_AND_TEST";

export type EvalFailureStage =
  | "INTENT"
  | "RETRIEVAL"
  | "CONTEXT"
  | "MANIFEST"
  | "GENERATION"
  | "PATCH_RESOLUTION"
  | "SCOPE"
  | "STALE_STATE"
  | "VALIDATION"
  | "REPAIR"
  | "INFRASTRUCTURE"
  | "UNKNOWN";

export interface ExpectedContentRule {
  path: string;
  contains?: string[];
  notContains?: string[];
}

export interface RagGroundTruth {
  expectedRelevantFiles: string[];
}

export interface AgentEvalCase {
  id: string;
  name: string;
  category: EvalCategory;
  description: string;
  userRequest: string;

  /** Relative path to fixture directory from src/ai/evals/fixtures */
  fixtureDir: string;

  /** Optional ground truth files expected to be retrieved during RAG */
  ragGroundTruth?: RagGroundTruth;

  expected: {
    allowedChangedFiles?: string[];
    requiredChangedFiles?: string[];
    forbiddenChangedFiles?: string[];

    /** Shell commands to run on mutated workspace (exit code 0 = pass) */
    validationCommands?: string[];

    /** Content verification rules */
    contentRules?: ExpectedContentRule[];

    /** Expected safe rejection code (e.g. STALE_SOURCE_FILE) */
    expectedSafeRejection?: {
      code: string;
    };

    /** Maximum repair retries allowed */
    maxRepairsAllowed?: number;
  };
}

export interface RankingMetrics {
  recallAt1: number;
  recallAt3: number;
  recallAt5: number;
  precisionAt1: number;
  precisionAt3: number;
  precisionAt5: number;
  mrr: number;
}

export interface RagContextMetrics {
  expectedFilesIncludedCount: number;
  expectedFilesTotal: number;
  inclusionRate: number;
  allExpectedIncluded: boolean;
}

export interface RagDeltaMetrics {
  mrrDelta: number;
  recallAt5Delta: number;
  precisionAt5Delta: number;
}

export interface RagEvalMetrics {
  embeddingProvider: string;
  raw: RankingMetrics;
  reranked: RankingMetrics;
  delta: RagDeltaMetrics;
  context: RagContextMetrics;
  rawRankedFiles: string[];
  rerankedFiles: string[];
  includedFiles: string[];
  excludedFiles: string[];

  // Backward-compatible accessors
  recallAt5?: number;
  precisionAt5?: number;
  mrr?: number;
  contextIncluded?: boolean;
}

export interface FilesystemDiffResult {
  modifiedFiles: string[];
  createdFiles: string[];
  deletedFiles: string[];
  allChangedFiles: string[];
}

export interface ModelCallEvent {
  stage?: string;
  operation?: string;
  provider: "openai";
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  durationMs: number;
  timestamp: string;
}

export interface ModelProfile {
  providers: string[];
  modelsObserved: string[];
  embeddingProvider: string;
  callCount: number;
  callsByModel: Record<string, number>;
}

export interface ActualTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface EvalCaseResult {
  caseId: string;
  name: string;
  category: EvalCategory;
  mode: EvalMode;
  status: "PASS" | "FAIL" | "SAFE_REJECTION";
  taskSuccess: boolean;
  firstPassSuccess: boolean;
  repaired: boolean;
  repairAttempted?: boolean;
  repairAttempts: number;
  repairApplied?: boolean;
  repairSuccess?: boolean;
  repairTrigger?: "SHELL_VALIDATION_FAILURE" | "LLM_REVIEW_REJECTION" | "NONE";
  failureStage?: EvalFailureStage;
  filesystemDiff: FilesystemDiffResult;
  unauthorizedFiles: string[];
  validationPassed: boolean;
  contentRulesPassed: boolean;
  ragMetrics?: RagEvalMetrics;
  safetyMetrics: {
    safeRejectionTriggered?: string;
    scopeViolations: number;
    patchFailures: number;
  };
  durationMs: number;
  estimatedTokenUsage?: {
    inputTokens: number;
    outputTokens: number;
  };
  actualTokenUsage?: ActualTokenUsage;
  modelCalls?: ModelCallEvent[];
  errorDetails?: string;
}

export interface EvalSuiteSummary {
  schemaVersion: string;
  runId: string;
  timestamp: string;
  gitCommit: string | null;
  mode: EvalMode;
  totalCases: number;
  passedCases: number;
  failedCases: number;
  safeRejections: number;
  passRatePct: number;
  firstPassSuccessRatePct: number;
  repairSuccessRatePct: number;
  avgDurationMs: number;
  avgRepairAttempts: number;

  // RAG Diagnostic Aggregate Metrics
  rawAvgRecallAt5: number;
  rawAvgMRR: number;
  rerankedAvgRecallAt5: number;
  rerankedAvgMRR: number;
  avgMrrDelta: number;
  avgRecallAt5Delta: number;
  avgContextInclusionRate: number;

  // Model Profile & Observed Usage
  modelProfile: ModelProfile;
  actualTokenUsage?: ActualTokenUsage;

  // Backward-compatible accessors
  ragAvgRecallAt5?: number;
  ragAvgPrecisionAt5?: number;
  ragAvgMrr?: number;
  embeddingProvider: string;

  results: EvalCaseResult[];
}

export interface RealEvalRunOptions {
  caseIds?: string[];
  runsPerCase?: number;
  maxCases?: number;
  saveResults?: boolean;
  outputDir?: string;
}
