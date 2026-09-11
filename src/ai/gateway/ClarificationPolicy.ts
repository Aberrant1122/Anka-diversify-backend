import { AgentOutcomeType, ClarificationRequest } from "./AgentOutcome";
import { LLMError } from "./LLMError";
import { LLMTelemetry } from "./LLMTelemetry";

export type ClarificationCategory =
  | "REPOSITORY_RESOLVABLE"
  | "USER_AMBIGUITY"
  | "TECHNICAL_FAILURE";

export type ClarificationDecisionType =
  | "CONTINUE_INVESTIGATION"
  | "ASK_USER"
  | "TECHNICAL_FAILURE";

export interface ClarificationInput {
  category: ClarificationCategory;
  question?: string;
  options?: string[];
  reason?: string;
  targetPath?: string;
  technicalError?: LLMError | Error;
  runId?: string;
  projectId?: string;
  repositoryId?: string;
}

export interface ClarificationDecision {
  decision: ClarificationDecisionType;
  requiresClarification: boolean;
  canClarify: boolean;
  outcome?: AgentOutcomeType;
  clarification?: ClarificationRequest;
  technicalError?: LLMError | Error;
  reason: string;
}

/**
 * Deterministic ClarificationPolicy.
 *
 * Invariants:
 * 1. ClarificationPolicy itself NEVER calls an LLM.
 * 2. REPOSITORY_RESOLVABLE:
 *    - decision: "CONTINUE_INVESTIGATION"
 *    - requiresClarification: false
 *    - canClarify: false
 *    - outcome: undefined (NEVER terminal AgentOutcome.SUCCESS; investigation must continue)
 * 3. USER_AMBIGUITY:
 *    - decision: "ASK_USER"
 *    - requiresClarification: true
 *    - canClarify: true
 *    - outcome: "CLARIFICATION_NEEDED"
 * 4. TECHNICAL_FAILURE:
 *    - decision: "TECHNICAL_FAILURE"
 *    - requiresClarification: false
 *    - canClarify: false
 *    - outcome: "TECHNICAL_FAILURE"
 *    Technical network, timeout, provider, rate-limit, and JSON syntax errors MUST NEVER become user clarification.
 */
export class ClarificationPolicy {
  public static evaluate(input: ClarificationInput): ClarificationDecision {
    const telemetry = LLMTelemetry.getInstance();

    switch (input.category) {
      case "REPOSITORY_RESOLVABLE":
        telemetry.emit("clarification.repo_resolvable", {
          runId: input.runId,
          projectId: input.projectId,
          repositoryId: input.repositoryId,
        });
        return {
          decision: "CONTINUE_INVESTIGATION",
          requiresClarification: false,
          canClarify: false,
          reason: input.reason || "Ambiguity is resolvable from repository ground truth without user input.",
        };

      case "USER_AMBIGUITY":
        telemetry.emit("clarification.user_ambiguity", {
          runId: input.runId,
          projectId: input.projectId,
          repositoryId: input.repositoryId,
        });
        return {
          decision: "ASK_USER",
          outcome: "CLARIFICATION_NEEDED",
          requiresClarification: true,
          canClarify: true,
          clarification: {
            question: input.question || "Could you please clarify your request?",
            options: input.options || [],
            reason: input.reason || "Request contains genuine irreconcilable user ambiguity.",
            source: "USER_AMBIGUITY",
            targetPath: input.targetPath,
          },
          reason: input.reason || "User clarification required.",
        };

      case "TECHNICAL_FAILURE":
        telemetry.emit("clarification.technical_failure", {
          runId: input.runId,
          projectId: input.projectId,
          repositoryId: input.repositoryId,
        });
        const err = input.technicalError || new Error(input.reason || "Technical failure occurred");
        return {
          decision: "TECHNICAL_FAILURE",
          outcome: "TECHNICAL_FAILURE",
          requiresClarification: false,
          canClarify: false,
          technicalError: err,
          reason: input.reason || err.message || "Technical failure cannot be converted into user clarification.",
        };
    }
  }
}
