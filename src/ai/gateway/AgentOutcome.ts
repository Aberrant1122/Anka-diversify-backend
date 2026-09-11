import { LLMError } from "./LLMError";

/**
 * Locked five-state canonical AgentOutcome semantic contract.
 * Do NOT substitute alternative states.
 */
export type AgentOutcomeType =
  | "SUCCESS"
  | "CLARIFICATION_NEEDED"
  | "TECHNICAL_FAILURE"
  | "POLICY_BLOCKED"
  | "BUDGET_EXHAUSTED";

export interface ClarificationRequest {
  question: string;
  options?: string[];
  reason: string;
  source: "USER_AMBIGUITY" | "DESTRUCTIVE_AMBIGUITY" | "TASK_AMBIGUITY";
  targetPath?: string;
}

export interface AgentOutcome<T = any> {
  status: AgentOutcomeType;
  data?: T;
  error?: LLMError | Error;
  clarification?: ClarificationRequest;
  metadata?: Record<string, any>;
}

/**
 * Explicit Architecture Invariant:
 * MODEL PROPOSES. BACKEND VERIFIES.
 *
 * An LLM response must NEVER directly establish:
 * - buildPassed
 * - validationPassed
 * - stageVerified
 * - taskComplete
 * - transactionCommit
 * - securityPassed
 *
 * Note: LLMGateway and ClarificationPolicy define invocation and outcome shapes only.
 * They do NOT establish task completion or verification authority.
 * Actual deterministic completion authority belongs strictly to downstream Validator
 * and CompletionEvaluator engines backed by actual compiler/test execution.
 */
export const VERIFICATION_INVARIANT = "MODEL PROPOSES. BACKEND VERIFIES." as const;
