import { LLMBudgetExhaustedError } from "../gateway/LLMError";
import { AgentWorkspaceState, WorkspaceValidationFact } from "../runtime/AgentWorkspaceState";
import { TaskRuntime } from "../runtime/TaskRuntime";
import { WorkingPlan } from "../runtime/WorkingPlan";
import type { DiagnosticBaselineComparison } from "../runtime/BaselineDiagnosticVerifier";
import type { ActionGroupJournalEntry } from "../runtime/VerifiedCheckpointJournal";
import type { AgentResponse } from "../shared/types";

export type AgentLoopStopReason =
  | "AWAITING_COMPLETION_EVALUATION"
  | "CLARIFICATION_REQUIRED"
  | "TECHNICAL_FAILURE"
  | "AUTHORIZATION_DENIED"
  | "VALIDATION_FAILURE"
  | "BUDGET_EXHAUSTED"
  | "MAX_ITERATIONS_REACHED";

export interface AgentLoopObservation {
  workspace: AgentWorkspaceState;
  revision: string;
}

export type AgentLoopProposal<TAction> =
  | { kind: "ACTION_GROUP"; actionGroup: TAction; workingPlan: WorkingPlan }
  | { kind: "NO_ACTION"; workingPlan: WorkingPlan }
  | { kind: "CLARIFICATION"; workingPlan: WorkingPlan; question: string; reason: string };

export interface AgentLoopExecution {
  journalEntry: ActionGroupJournalEntry;
  relevantPaths?: readonly string[];
  validationFact?: WorkspaceValidationFact;
  diagnosticComparison?: DiagnosticBaselineComparison;
}

export interface AgentLoopResult {
  outcome: AgentLoopStopReason;
  iterations: number;
  workingPlan: WorkingPlan;
  verifiedCheckpointIds: readonly string[];
  failureCode?: string;
}

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : "AGENT_LOOP_TECHNICAL_FAILURE";
}

function isAuthorizationError(error: unknown): boolean {
  const code = errorCode(error);
  return code.startsWith("CAPABILITY_") && code !== "CAPABILITY_TECHNICAL_FAILURE";
}

/**
 * Finite CP7 coordinator. Observation and planning are separate callbacks so the
 * planner can revise after deterministic facts; mutation remains delegated to
 * the existing CapabilityGuard/ActionGroup transaction path.
 */
export class AgentLoopCoordinator {
  /** Production adapter for the existing one-ActionGroup AgentPipeline iteration. */
  public static async runPipeline(input: {
    runtime: TaskRuntime;
    workingPlan: WorkingPlan;
    maxIterations: number;
    observe: (iteration: number) => Promise<AgentLoopObservation>;
    executeIteration: (iteration: number) => Promise<{
      response: AgentResponse;
      journalEntry?: ActionGroupJournalEntry;
    }>;
    onRevisionRequired?: (
      response: AgentResponse,
      journalEntry: ActionGroupJournalEntry,
      iteration: number,
    ) => Promise<void> | void;
  }): Promise<{ response: AgentResponse; loop: AgentLoopResult }> {
    if (!Number.isInteger(input.maxIterations) || input.maxIterations < 1) {
      throw new Error("Agent loop maxIterations must be a positive integer");
    }
    if (input.runtime.snapshot().status !== "RUNNING") {
      throw new Error(`Agent loop requires RUNNING TaskRuntime; received ${input.runtime.snapshot().status}`);
    }
    let workingPlan = input.workingPlan;
    let lastResponse: AgentResponse | undefined;
    const verifiedCheckpointIds: string[] = [];
    const failedActionFingerprints = new Set<string>();

    for (let iteration = 1; iteration <= input.maxIterations; iteration += 1) {
      try {
        const observation = await input.observe(iteration);
        input.runtime.updateWorkspace(observation.workspace.withWorkingPlan({
          id: workingPlan.snapshot().id,
          revision: workingPlan.snapshot().revision,
          status: workingPlan.snapshot().status,
        }));
        const executed = await input.executeIteration(iteration);
        lastResponse = executed.response;

        if (executed.response.needsClarification) {
          input.runtime.requestClarification({
            question: executed.response.question ?? "Additional user input is required.",
            reason: executed.response.reason ?? "The task cannot proceed deterministically without clarification.",
          });
          return {
            response: executed.response,
            loop: { outcome: "CLARIFICATION_REQUIRED", iterations: iteration, workingPlan, verifiedCheckpointIds },
          };
        }

        const entry = executed.journalEntry;
        if (!entry) {
          const code = executed.response.errorCode;
          if (code) {
            const category = code.startsWith("CAPABILITY_") && code !== "CAPABILITY_TECHNICAL_FAILURE"
              ? "AUTHORIZATION_DENIAL"
              : code.startsWith("PLANNING_")
                ? "VALIDATION_FAILURE"
                : "TECHNICAL_FAILURE";
            let workspace = input.runtime.workspaceState().withFailureFact({
              id: `pipeline:${iteration}:${code}`,
              code,
              category,
              source: "DETERMINISTIC_RUNTIME",
            });
            workingPlan = category === "VALIDATION_FAILURE"
              ? workingPlan.requireRevision({ code, category, deterministic: true })
              : workingPlan.block();
            workspace = workspace.withWorkingPlan({
              id: workingPlan.snapshot().id,
              revision: workingPlan.snapshot().revision,
              status: workingPlan.snapshot().status,
            });
            input.runtime.updateWorkspace(workspace);
            if (category !== "VALIDATION_FAILURE") {
              input.runtime.fail({
                failureType: category === "AUTHORIZATION_DENIAL" ? "POLICY_BLOCKED" : "TECHNICAL_FAILURE",
                code,
                message: executed.response.reason ?? executed.response.explanation,
              });
            }
            return {
              response: executed.response,
              loop: {
                outcome: category === "AUTHORIZATION_DENIAL"
                  ? "AUTHORIZATION_DENIED"
                  : category === "VALIDATION_FAILURE"
                    ? "VALIDATION_FAILURE"
                    : "TECHNICAL_FAILURE",
                iterations: iteration,
                workingPlan,
                verifiedCheckpointIds,
                failureCode: code,
              },
            };
          }
          workingPlan = workingPlan.awaitCompletionEvaluation();
          input.runtime.updateWorkspace(input.runtime.workspaceState().withWorkingPlan({
            id: workingPlan.snapshot().id,
            revision: workingPlan.snapshot().revision,
            status: workingPlan.snapshot().status,
          }));
          return {
            response: executed.response,
            loop: { outcome: "AWAITING_COMPLETION_EVALUATION", iterations: iteration, workingPlan, verifiedCheckpointIds },
          };
        }

        let workspace = input.runtime.workspaceState().withCheckpointReference({
          id: entry.journalId,
          sequence: entry.sequence,
          actionGroupId: entry.actionGroupId,
          status: entry.status,
          source: "VERIFIED_CHECKPOINT_JOURNAL",
        }).withValidationFact({
          id: `loop-validation:${entry.journalId}`,
          command: "ValidationCoordinator deterministic gate",
          passed: entry.validation.passed,
          source: "DETERMINISTIC_TOOL",
        });
        if (entry.status === "ROLLED_BACK") {
          const code = entry.failureCode ?? "VALIDATION_FAILED";
          const category = code === "AUTHORIZATION_FAILED" ? "AUTHORIZATION_DENIAL" : "VALIDATION_FAILURE";
          workingPlan = workingPlan.requireRevision({ code, category, deterministic: true });
          workspace = workspace.withFailureFact({
            id: `${entry.journalId}:${code}`,
            code,
            category,
            source: "DETERMINISTIC_RUNTIME",
          }).withWorkingPlan({
            id: workingPlan.snapshot().id,
            revision: workingPlan.snapshot().revision,
            status: workingPlan.snapshot().status,
          });
          input.runtime.updateWorkspace(workspace);
          const failureFingerprint = `${code}:${entry.proposedActions
            .map((action) => `${action.action}:${action.path}:${action.contentFingerprint}`)
            .join("|")}`;
          if (category === "VALIDATION_FAILURE" && !failedActionFingerprints.has(failureFingerprint)) {
            failedActionFingerprints.add(failureFingerprint);
            await input.onRevisionRequired?.(executed.response, entry, iteration);
            workingPlan = workingPlan.revise({
              reason: `Deterministic failure ${code} requires a fresh observation and revised proposal`,
            });
            continue;
          }
          return {
            response: executed.response,
            loop: {
              outcome: category === "AUTHORIZATION_DENIAL" ? "AUTHORIZATION_DENIED" : "VALIDATION_FAILURE",
              iterations: iteration,
              workingPlan,
              verifiedCheckpointIds,
              failureCode: code,
            },
          };
        }

        verifiedCheckpointIds.push(entry.journalId);
        workspace = workspace.withRelevantPaths([
          ...workspace.snapshot().relevantPaths,
          ...entry.attemptedActions.map((action) => action.path),
        ]);
        const nextStages = executed.response.taskExecutionPlan?.stages
          .filter((stage) => stage.status === "PENDING")
          .map((stage) => stage.id) ?? [];
        if (executed.response.compoundTaskStatus === "RUNNING" && nextStages.length > 0) {
          workingPlan = workingPlan.revise({
            advisoryStageIds: nextStages,
            reason: `VERIFIED checkpoint ${entry.journalId} changed repository reality`,
          });
          input.runtime.updateWorkspace(workspace.withWorkingPlan({
            id: workingPlan.snapshot().id,
            revision: workingPlan.snapshot().revision,
            status: workingPlan.snapshot().status,
          }));
          continue;
        }

        workingPlan = workingPlan.awaitCompletionEvaluation();
        input.runtime.updateWorkspace(workspace.withWorkingPlan({
          id: workingPlan.snapshot().id,
          revision: workingPlan.snapshot().revision,
          status: workingPlan.snapshot().status,
        }));
        return {
          response: executed.response,
          loop: { outcome: "AWAITING_COMPLETION_EVALUATION", iterations: iteration, workingPlan, verifiedCheckpointIds },
        };
      } catch (error) {
        const code = errorCode(error);
        const budget = error instanceof LLMBudgetExhaustedError || code === "LLM_BUDGET_EXHAUSTED";
        const authorization = isAuthorizationError(error);
        let workspace = input.runtime.workspaceState().withFailureFact({
          id: `pipeline-loop:${iteration}:${code}`,
          code,
          category: budget ? "BUDGET_EXHAUSTED" : authorization ? "AUTHORIZATION_DENIAL" : "TECHNICAL_FAILURE",
          source: "DETERMINISTIC_RUNTIME",
        });
        workingPlan = workingPlan.block();
        workspace = workspace.withWorkingPlan({
          id: workingPlan.snapshot().id,
          revision: workingPlan.snapshot().revision,
          status: workingPlan.snapshot().status,
        });
        input.runtime.updateWorkspace(workspace);
        input.runtime.fail({
          failureType: budget ? "BUDGET_EXHAUSTED" : authorization ? "POLICY_BLOCKED" : "TECHNICAL_FAILURE",
          code,
          message: error instanceof Error ? error.message : code,
        });
        if (!lastResponse) throw error;
        return {
          response: lastResponse,
          loop: {
            outcome: budget ? "BUDGET_EXHAUSTED" : authorization ? "AUTHORIZATION_DENIED" : "TECHNICAL_FAILURE",
            iterations: iteration,
            workingPlan,
            verifiedCheckpointIds,
            failureCode: code,
          },
        };
      }
    }

    if (!lastResponse) throw new Error("Agent loop reached its bound before producing an iteration result");
    return {
      response: lastResponse,
      loop: {
        outcome: "MAX_ITERATIONS_REACHED",
        iterations: input.maxIterations,
        workingPlan,
        verifiedCheckpointIds,
      },
    };
  }

  public static async run<TAction>(input: {
    runtime: TaskRuntime;
    workingPlan: WorkingPlan;
    maxIterations: number;
    observe: (iteration: number) => Promise<AgentLoopObservation>;
    plan: (context: {
      iteration: number;
      observation: AgentLoopObservation;
      workingPlan: WorkingPlan;
      lastFailure?: { code: string; category: "AUTHORIZATION_DENIAL" | "VALIDATION_FAILURE" };
    }) => Promise<AgentLoopProposal<TAction>>;
    execute: (actionGroup: TAction, iteration: number) => Promise<AgentLoopExecution>;
  }): Promise<AgentLoopResult> {
    if (!Number.isInteger(input.maxIterations) || input.maxIterations < 1) {
      throw new Error("Agent loop maxIterations must be a positive integer");
    }
    if (input.runtime.snapshot().status !== "RUNNING") {
      throw new Error(`Agent loop requires RUNNING TaskRuntime; received ${input.runtime.snapshot().status}`);
    }

    let workingPlan = input.workingPlan;
    let lastFailure: { code: string; category: "AUTHORIZATION_DENIAL" | "VALIDATION_FAILURE" } | undefined;
    let failurePlanRevision: number | undefined;
    const verifiedCheckpointIds: string[] = [];

    for (let iteration = 1; iteration <= input.maxIterations; iteration += 1) {
      try {
        const observation = await input.observe(iteration);
        let workspace = observation.workspace.withWorkingPlan({
          id: workingPlan.snapshot().id,
          revision: workingPlan.snapshot().revision,
          status: workingPlan.snapshot().status,
        });
        input.runtime.updateWorkspace(workspace);

        const proposal = await input.plan({ iteration, observation, workingPlan, ...(lastFailure ? { lastFailure } : {}) });
        workingPlan = proposal.workingPlan;
        if (lastFailure && failurePlanRevision !== undefined && workingPlan.snapshot().revision <= failurePlanRevision) {
          workingPlan = workingPlan.block();
          input.runtime.updateWorkspace(workspace.withWorkingPlan({
            id: workingPlan.snapshot().id,
            revision: workingPlan.snapshot().revision,
            status: workingPlan.snapshot().status,
          }));
          return {
            outcome: lastFailure.category === "AUTHORIZATION_DENIAL" ? "AUTHORIZATION_DENIED" : "VALIDATION_FAILURE",
            iterations: iteration,
            workingPlan,
            verifiedCheckpointIds: Object.freeze([...verifiedCheckpointIds]),
            failureCode: lastFailure.code,
          };
        }

        if (proposal.kind === "CLARIFICATION") {
          input.runtime.requestClarification({ question: proposal.question, reason: proposal.reason });
          return { outcome: "CLARIFICATION_REQUIRED", iterations: iteration, workingPlan, verifiedCheckpointIds };
        }
        if (proposal.kind === "NO_ACTION") {
          workingPlan = workingPlan.awaitCompletionEvaluation();
          input.runtime.updateWorkspace(workspace.withWorkingPlan({
            id: workingPlan.snapshot().id,
            revision: workingPlan.snapshot().revision,
            status: workingPlan.snapshot().status,
          }));
          return { outcome: "AWAITING_COMPLETION_EVALUATION", iterations: iteration, workingPlan, verifiedCheckpointIds };
        }

        const execution = await input.execute(proposal.actionGroup, iteration);
        const entry = execution.journalEntry;
        workspace = input.runtime.workspaceState().withCheckpointReference({
          id: entry.journalId,
          sequence: entry.sequence,
          actionGroupId: entry.actionGroupId,
          status: entry.status,
          source: "VERIFIED_CHECKPOINT_JOURNAL",
        });
        if (execution.validationFact) workspace = workspace.withValidationFact(execution.validationFact);
        if (execution.diagnosticComparison) workspace = workspace.withDiagnosticComparison(execution.diagnosticComparison);

        if (entry.status === "VERIFIED") {
          verifiedCheckpointIds.push(entry.journalId);
          workspace = workspace.withRelevantPaths([
            ...workspace.snapshot().relevantPaths,
            ...(execution.relevantPaths ?? entry.attemptedActions.map((action) => action.path)),
          ]);
          lastFailure = undefined;
          failurePlanRevision = undefined;
        } else {
          const code = entry.failureCode ?? "VALIDATION_FAILED";
          const category = code === "AUTHORIZATION_FAILED" ? "AUTHORIZATION_DENIAL" : "VALIDATION_FAILURE";
          lastFailure = { code, category };
          workingPlan = workingPlan.requireRevision({ code, category, deterministic: true });
          failurePlanRevision = workingPlan.snapshot().revision;
          workspace = workspace.withFailureFact({
            id: `${entry.journalId}:${code}`,
            code,
            category,
            source: "DETERMINISTIC_RUNTIME",
          });
        }
        workspace = workspace.withWorkingPlan({
          id: workingPlan.snapshot().id,
          revision: workingPlan.snapshot().revision,
          status: workingPlan.snapshot().status,
        });
        input.runtime.updateWorkspace(workspace);
      } catch (error) {
        const code = errorCode(error);
        const category = error instanceof LLMBudgetExhaustedError || code === "LLM_BUDGET_EXHAUSTED"
          ? "BUDGET_EXHAUSTED"
          : isAuthorizationError(error)
            ? "AUTHORIZATION_DENIAL"
            : "TECHNICAL_FAILURE";
        let workspace = input.runtime.workspaceState().withFailureFact({
          id: `loop:${iteration}:${code}`,
          code,
          category,
          source: "DETERMINISTIC_RUNTIME",
        });
        workingPlan = workingPlan.block();
        workspace = workspace.withWorkingPlan({
          id: workingPlan.snapshot().id,
          revision: workingPlan.snapshot().revision,
          status: workingPlan.snapshot().status,
        });
        input.runtime.updateWorkspace(workspace);
        if (category === "BUDGET_EXHAUSTED") {
          input.runtime.fail({ failureType: "BUDGET_EXHAUSTED", code, message: error instanceof Error ? error.message : code });
          return { outcome: "BUDGET_EXHAUSTED", iterations: iteration, workingPlan, verifiedCheckpointIds, failureCode: code };
        }
        if (category === "AUTHORIZATION_DENIAL") {
          return { outcome: "AUTHORIZATION_DENIED", iterations: iteration, workingPlan, verifiedCheckpointIds, failureCode: code };
        }
        input.runtime.fail({ failureType: "TECHNICAL_FAILURE", code, message: error instanceof Error ? error.message : code });
        return { outcome: "TECHNICAL_FAILURE", iterations: iteration, workingPlan, verifiedCheckpointIds, failureCode: code };
      }
    }

    return {
      outcome: "MAX_ITERATIONS_REACHED",
      iterations: input.maxIterations,
      workingPlan,
      verifiedCheckpointIds: Object.freeze([...verifiedCheckpointIds]),
    };
  }
}
