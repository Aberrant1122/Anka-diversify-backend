import { LLMBudgetExhaustedError } from "../gateway/LLMError";
import { AgentWorkspaceState, WorkspaceValidationFact } from "../runtime/AgentWorkspaceState";
import { TaskRuntime } from "../runtime/TaskRuntime";
import { WorkingPlan } from "../runtime/WorkingPlan";
import type { DiagnosticBaselineComparison } from "../runtime/BaselineDiagnosticVerifier";
import { VerifiedCheckpointJournal, type ActionGroupJournalEntry } from "../runtime/VerifiedCheckpointJournal";
import type { AgentFileChange, AgentResponse } from "../shared/types";
import { normalizeRepoPath } from "../repository/SemanticContextResolver";
import {
  canonicalWorkspaceIdentity,
  createCanonicalPlanRecoveryEvent,
  StagePlanningRecoveryRecord,
  StagePlanningRecoveryEvent,
  MAX_STAGE_PLANNING_ATTEMPTS,
} from "../planning/PlanningFailureFacts";

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
  return (code.startsWith("CAPABILITY_") && code !== "CAPABILITY_TECHNICAL_FAILURE") || REINVESTIGATION_OUTCOMES.has(code);
}

function recoveryContractFailure(
  response: AgentResponse,
  message: string,
): AgentResponse {
  return {
    ...response,
    errorCode: "INTERNAL_RECOVERY_CONTRACT_ERROR",
    explanation: `[Internal Recovery Contract Error] ${message}`,
  };
}

function recoveryEventFromResponse(input: {
  response: AgentResponse;
  stageId: string;
  workspaceRoot: string;
  observedRevision: string;
}): StagePlanningRecoveryEvent {
  const event = input.response.planningRecoveryEvent;
  if (event) {
    if (event.stageId !== input.stageId) {
      throw new Error("recovery event stage does not match the active stage");
    }
    if (event.workspaceIdentity !== canonicalWorkspaceIdentity(input.workspaceRoot)) {
      throw new Error("recovery event workspace does not match the active workspace");
    }
    if (!event.repositoryRevision?.trim() || event.failureFacts.length === 0) {
      throw new Error("recovery event revision and failure facts must be non-empty");
    }
    if (event.kind === "PRE_CANONICAL") {
      if (!event.recoveryIdentity?.trim() || !event.progressMarker?.trim()) {
        throw new Error("pre-canonical recovery identity and progress marker must be non-empty");
      }
    } else if (!event.manifestFingerprint?.trim()) {
      throw new Error("canonical plan fingerprint must be non-empty");
    }
    return event;
  }

  // Compatibility boundary for older callers. Absence is never coerced to an
  // empty plan identity: only a complete canonical event may be reconstructed.
  const legacyFingerprint = input.response.manifestFingerprint;
  const legacyFailureFacts = input.response.planningFailureFacts;
  if (!legacyFingerprint?.trim()) {
    throw new Error("legacy canonical recovery response is missing a non-empty manifest fingerprint");
  }
  if (!legacyFailureFacts || legacyFailureFacts.length === 0) {
    throw new Error("legacy canonical recovery response is missing typed failure facts");
  }
  return createCanonicalPlanRecoveryEvent({
    phase: legacyFailureFacts.some((fact) => fact.kind === "AUTHORITY_REJECTION")
      ? "AUTHORIZATION"
      : "MANIFEST_VALIDATION",
    stageId: input.stageId,
    workspaceRoot: input.workspaceRoot,
    repositoryRevision: input.response.repositoryRevision || input.observedRevision,
    manifestFingerprint: legacyFingerprint,
    failureFacts: legacyFailureFacts,
  });
}

const REINVESTIGATION_OUTCOMES = new Set([
  "REPAIR_SCOPE_EXPANSION_REQUIRED", "REINVESTIGATION_REQUIRED", "TRANSACTION_REVISION_DIVERGED",
  "WORKSPACE_BINDING_INVALID", "TRANSACTION_INVALIDATED", "CAPABILITY_MANIFEST_MISMATCH", "TRANSACTION_CONFLICT",
]);

function normalizedAction(change: AgentFileChange): "create" | "modify" | "delete" {
  return change.action === "delete" || change.isDeleted ? "delete" : change.action ?? "modify";
}

function verifiedCheckpointLineage(
  checkpoints: readonly ActionGroupJournalEntry[],
): ActionGroupJournalEntry[] {
  const ordered = [...checkpoints]
    .filter((entry) => entry.status === "VERIFIED" && entry.validation.passed)
    .sort((left, right) => left.sequence - right.sequence);
  const lineage: ActionGroupJournalEntry[] = [];
  let previousSequence = 0;
  let previousRevision: string | undefined;
  for (const checkpoint of ordered) {
    const revisionBound = Boolean(checkpoint.repositoryRevisionBefore && checkpoint.repositoryRevisionAfter);
    if (ordered.length > 1 && !revisionBound) break;
    if (checkpoint.sequence <= previousSequence) break;
    if (previousRevision && checkpoint.repositoryRevisionBefore !== previousRevision) break;
    lineage.push(checkpoint);
    previousSequence = checkpoint.sequence;
    previousRevision = checkpoint.repositoryRevisionAfter;
  }
  return lineage;
}

/** Projects only deterministically VERIFIED journal payloads in checkpoint order. */
export function projectVerifiedTaskChanges(
  checkpoints: readonly ActionGroupJournalEntry[],
): AgentFileChange[] {
  const finalByPath = new Map<string, AgentFileChange>();
  for (const checkpoint of verifiedCheckpointLineage(checkpoints)) {
    for (const change of checkpoint.verifiedChanges ?? []) {
      const normalizedPath = normalizeRepoPath(change.path);
      if (!normalizedPath) continue;
      finalByPath.delete(normalizedPath);
      finalByPath.set(normalizedPath, { ...change, path: normalizedPath });
    }
  }
  return [...finalByPath.values()];
}

function sameProjectedChanges(left: readonly AgentFileChange[], right: readonly AgentFileChange[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((change, index) => {
    const projected = right[index];
    return normalizeRepoPath(change.path) === normalizeRepoPath(projected.path)
      && normalizedAction(change) === normalizedAction(projected)
      && change.content === projected.content
      && change.description === projected.description;
  });
}

function withFileCount(text: string | undefined, count: number): string | undefined {
  return text?.replace(/Files modified: \d+/g, `Files modified: ${count}`);
}

/** Builds the task-level response without consulting planned or merely authorized candidates. */
export function buildVerifiedTaskResult(
  response: AgentResponse,
  checkpoints: readonly ActionGroupJournalEntry[],
): AgentResponse {
  const verified = verifiedCheckpointLineage(checkpoints);
  if (verified.length === 0) return { ...response, changes: [] };

  const changes = projectVerifiedTaskChanges(verified);
  const isCompound = verified.length > 1 || (response.taskExecutionPlan?.stages.length ?? 0) > 1;
  if (!isCompound && sameProjectedChanges(response.changes, changes)) return response;

  const stagesById = new Map(response.taskExecutionPlan?.stages.map((stage) => [stage.id, stage.name]) ?? []);
  const stageIds = [...new Set(verified.map((entry) => entry.stageId))];
  const verifiedStageSummary = stageIds
    .map((stageId, index) => `- Stage ${index + 1}: ${stagesById.get(stageId) ?? stageId}`)
    .join("\n");
  const explanation = verifiedStageSummary
    ? `Verified compound stages:\n${verifiedStageSummary}\n\n${response.explanation}`
    : response.explanation;
  return {
    ...response,
    explanation: withFileCount(explanation, changes.length) ?? explanation,
    changes,
    modifiedFilesCount: changes.length,
    pipelineMeasurementText: withFileCount(response.pipelineMeasurementText, changes.length),
  };
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
    checkpointJournal?: VerifiedCheckpointJournal;
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
    const verifiedCheckpoints: ActionGroupJournalEntry[] = [];
    const finalize = (response: AgentResponse): AgentResponse => buildVerifiedTaskResult(
      response,
      input.checkpointJournal?.snapshot() ?? verifiedCheckpoints,
    );
    const failedActionFingerprints = new Set<string>();
    const stagePlanningAttempts = new Map<string, StagePlanningRecoveryRecord[]>();

    for (let iteration = 1; iteration <= input.maxIterations; iteration += 1) {
      try {
        const observation = await input.observe(iteration);
        input.runtime.updateWorkspace(observation.workspace.withWorkingPlan({
          id: workingPlan.snapshot().id,
          revision: workingPlan.snapshot().revision,
          status: workingPlan.snapshot().status,
        }));
        const previousResponse = lastResponse;
        const executed = await input.executeIteration(iteration);
        lastResponse = executed.response;

        if (executed.response.needsClarification) {
          input.runtime.requestClarification({
            question: executed.response.question ?? "Additional user input is required.",
            reason: executed.response.reason ?? "The task cannot proceed deterministically without clarification.",
          });
          return {
            response: finalize(executed.response),
            loop: { outcome: "CLARIFICATION_REQUIRED", iterations: iteration, workingPlan, verifiedCheckpointIds },
          };
        }

        const entry = executed.journalEntry;
        if (!entry) {
          const code = executed.response.errorCode;
          if (code) {
            if (code === "PLANNING_IDENTICAL_FAILED_ACTION" && previousResponse) {
              return {
                response: finalize(previousResponse),
                loop: {
                  outcome: "VALIDATION_FAILURE",
                  iterations: iteration,
                  workingPlan,
                  verifiedCheckpointIds,
                  failureCode: code,
                },
              };
            }

            if (code === "PLANNING_REINVESTIGATION_REQUIRED") {
              const activeStageId = executed.response.taskExecutionPlan?.stages[
                executed.response.taskExecutionPlan.currentStageIndex
              ]?.id || "stage-default";
              const history = stagePlanningAttempts.get(activeStageId) || [];
              let recoveryEvent: StagePlanningRecoveryEvent;
              try {
                recoveryEvent = recoveryEventFromResponse({
                  response: executed.response,
                  stageId: activeStageId,
                  workspaceRoot: input.runtime.workspaceState().snapshot().repository.root,
                  observedRevision: observation.revision,
                });
              } catch (contractError) {
                const message = contractError instanceof Error ? contractError.message : "invalid recovery event";
                const failureCode = "INTERNAL_RECOVERY_CONTRACT_ERROR";
                workingPlan = workingPlan.requireRevision({ code: failureCode, category: "VALIDATION_FAILURE", deterministic: true });
                return {
                  response: finalize(recoveryContractFailure(executed.response, message)),
                  loop: {
                    outcome: "VALIDATION_FAILURE",
                    iterations: iteration,
                    workingPlan,
                    verifiedCheckpointIds,
                    failureCode,
                  },
                };
              }
              const sameKindHistory = history.filter((record) => record.kind === recoveryEvent.kind);
              const currentAttemptNumber = sameKindHistory.length + 1;
              const planningFacts = recoveryEvent.failureFacts;
              const isScopeRecovery = planningFacts.some((fact) => fact.kind === "AUTHORITY_REJECTION");
              const recoverableCount = planningFacts.filter(
                (fact) => fact.classification === "RECOVERABLE_CANDIDATE",
              ).length;
              const hardCandidateCount = planningFacts.filter(
                (fact) => fact.classification === "HARD_CANDIDATE",
              ).length;
              const terminalCount = planningFacts.filter(
                (fact) => fact.classification === "TERMINAL_TASK",
              ).length;

              const canonicalDuplicate = recoveryEvent.kind === "CANONICAL_PLAN" && history.some(
                (record) => record.kind === "CANONICAL_PLAN"
                  && record.manifestFingerprint === recoveryEvent.manifestFingerprint
                  && record.repositoryRevision === recoveryEvent.repositoryRevision
                  && record.workspaceIdentity === recoveryEvent.workspaceIdentity,
              );
              if (canonicalDuplicate && recoveryEvent.kind === "CANONICAL_PLAN") {
                if (isScopeRecovery) {
                  console.warn(
                    `[PLAN_SCOPE_RECOVERY]\nstage=${activeStageId}\nattempt=${currentAttemptNumber}/${MAX_STAGE_PLANNING_ATTEMPTS}\nfingerprint=${recoveryEvent.manifestFingerprint.slice(0, 32)}\nresult=DUPLICATE`
                  );
                }
                console.warn(
                  `[RECOVERY] kind=CANONICAL_PLAN stage=${activeStageId} attempt=${currentAttemptNumber}/${MAX_STAGE_PLANNING_ATTEMPTS} fingerprint=${recoveryEvent.manifestFingerprint.slice(0, 32)} result=DUPLICATE`
                );
                const failureCode = "DUPLICATE_RECOVERY_PLAN";
                let workspace = input.runtime.workspaceState().withFailureFact({
                  id: `pipeline:${iteration}:${failureCode}`,
                  code: failureCode,
                  category: "VALIDATION_FAILURE",
                  source: "DETERMINISTIC_RUNTIME",
                });
                workingPlan = workingPlan.requireRevision({ code: failureCode, category: "VALIDATION_FAILURE", deterministic: true });
                input.runtime.updateWorkspace(workspace.withWorkingPlan({
                  id: workingPlan.snapshot().id,
                  revision: workingPlan.snapshot().revision,
                  status: workingPlan.snapshot().status,
                }));
                return {
                  response: finalize({
                    ...executed.response,
                    errorCode: failureCode,
                    explanation: isScopeRecovery
                      ? "[Duplicate Recovery Plan] The active stage repeated a previously rejected planning topology without materially new repository facts."
                      : "[Duplicate Recovery Plan] The active stage repeated a previously failed canonical plan at the same repository revision.",
                  }),
                  loop: {
                    outcome: "VALIDATION_FAILURE",
                    iterations: iteration,
                    workingPlan,
                    verifiedCheckpointIds,
                    failureCode,
                  },
                };
              }

              const preCanonicalStall = recoveryEvent.kind === "PRE_CANONICAL" && history.some(
                (record) => record.kind === "PRE_CANONICAL"
                  && record.recoveryIdentity === recoveryEvent.recoveryIdentity
                  && record.progressMarker === recoveryEvent.progressMarker
                  && record.repositoryRevision === recoveryEvent.repositoryRevision
                  && record.workspaceIdentity === recoveryEvent.workspaceIdentity,
              );
              if (preCanonicalStall && recoveryEvent.kind === "PRE_CANONICAL") {
                const failureCode = recoveryEvent.phase === "INVESTIGATION"
                  ? "INVESTIGATION_STALLED"
                  : "PRE_CANONICAL_RECOVERY_STALLED";
                console.warn(
                  `[RECOVERY] kind=PRE_CANONICAL phase=${recoveryEvent.phase} stage=${activeStageId} attempt=${currentAttemptNumber} identity=${recoveryEvent.recoveryIdentity.slice(0, 32)} progress=${recoveryEvent.progressMarker.slice(0, 32)} result=STALLED`,
                );
                workingPlan = workingPlan.requireRevision({ code: failureCode, category: "VALIDATION_FAILURE", deterministic: true });
                return {
                  response: finalize({
                    ...executed.response,
                    errorCode: failureCode,
                    explanation: recoveryEvent.phase === "INVESTIGATION"
                      ? "[Investigation Stalled] Deterministic repository investigation repeated without new materialized facts or reduced missing evidence."
                      : "[Pre-Canonical Recovery Stalled] The same pre-canonical blocker repeated without deterministic progress.",
                  }),
                  loop: {
                    outcome: "VALIDATION_FAILURE",
                    iterations: iteration,
                    workingPlan,
                    verifiedCheckpointIds,
                    failureCode,
                  },
                };
              }

              // Recovery budget check (max 3 planning attempts total per stage: 1 initial + 2 recoveries)
              if (recoveryEvent.kind === "CANONICAL_PLAN" && currentAttemptNumber >= MAX_STAGE_PLANNING_ATTEMPTS) {
                if (isScopeRecovery) {
                  console.warn(
                    `[PLAN_SCOPE_RECOVERY]\nstage=${activeStageId}\nattempt=${currentAttemptNumber}/${MAX_STAGE_PLANNING_ATTEMPTS}\nresult=EXHAUSTED`
                  );
                }
                console.warn(
                  `[PLAN_RECOVERY] stage=${activeStageId} attempt=${currentAttemptNumber}/${MAX_STAGE_PLANNING_ATTEMPTS} result=EXHAUSTED`
                );
                const failureCode = "PLANNING_RECOVERY_EXHAUSTED";
                let workspace = input.runtime.workspaceState().withFailureFact({
                  id: `pipeline:${iteration}:${failureCode}`,
                  code: failureCode,
                  category: "VALIDATION_FAILURE",
                  source: "DETERMINISTIC_RUNTIME",
                });
                workingPlan = workingPlan.requireRevision({ code: failureCode, category: "VALIDATION_FAILURE", deterministic: true });
                input.runtime.updateWorkspace(workspace.withWorkingPlan({
                  id: workingPlan.snapshot().id,
                  revision: workingPlan.snapshot().revision,
                  status: workingPlan.snapshot().status,
                }));
                return {
                  response: finalize({
                    ...executed.response,
                    errorCode: failureCode,
                    explanation: isScopeRecovery
                      ? `[Planning Recovery Exhausted] Active stage ${activeStageId} exhausted its ${MAX_STAGE_PLANNING_ATTEMPTS}-attempt planning budget without finding a safe authorized topology.`
                      : `[Planning Recovery Exhausted] Active stage ${activeStageId} exceeded planning recovery budget (${MAX_STAGE_PLANNING_ATTEMPTS} attempts). Final validation errors:\n${executed.response.explanation}`,
                  }),
                  loop: {
                    outcome: "VALIDATION_FAILURE",
                    iterations: iteration,
                    workingPlan,
                    verifiedCheckpointIds,
                    failureCode,
                  },
                };
              }

              const record: StagePlanningRecoveryRecord = {
                ...recoveryEvent,
                attemptNumber: currentAttemptNumber,
                rejectedPaths: executed.response.rejectedPaths || [],
                authorizedPaths: executed.response.authorizedPaths || [],
                validationErrors: executed.response.validationErrors,
              };
              history.push(record);
              stagePlanningAttempts.set(activeStageId, history);

              workingPlan = workingPlan.withPlanningRecovery(record);
              let workspace = input.runtime.workspaceState().withFailureFact({
                id: `pipeline:${iteration}:PLANNING_REINVESTIGATION_REQUIRED`,
                code: "PLANNING_REINVESTIGATION_REQUIRED",
                category: "VALIDATION_FAILURE",
                source: "DETERMINISTIC_RUNTIME",
              });
              workspace = workspace.withWorkingPlan({
                id: workingPlan.snapshot().id,
                revision: workingPlan.snapshot().revision,
                status: workingPlan.snapshot().status,
              });
              input.runtime.updateWorkspace(workspace);

              const failureKinds = Array.from(new Set(record.failureFacts.map((f) => f.kind))).join(",");
              if (record.kind === "PRE_CANONICAL") {
                console.log(
                  `[RECOVERY] kind=PRE_CANONICAL phase=${record.phase} stage=${activeStageId} attempt=${currentAttemptNumber} identity=${record.recoveryIdentity.slice(0, 32)} progress=${record.progressMarker.slice(0, 32)} failureKinds=${failureKinds}`,
                );
              } else {
                console.log(
                  `[RECOVERY] kind=CANONICAL_PLAN phase=${record.phase} stage=${activeStageId} attempt=${currentAttemptNumber}/${MAX_STAGE_PLANNING_ATTEMPTS} fingerprint=${record.manifestFingerprint.slice(0, 32)} failureKinds=${failureKinds}`,
                );
              }
              console.log(`[PLAN_RECOVERY]\nresult=REINVESTIGATE`);
              if (isScopeRecovery) {
                console.log(
                  `[PLAN_SCOPE_RECOVERY]\nstage=${activeStageId}\nattempt=${currentAttemptNumber}/${MAX_STAGE_PLANNING_ATTEMPTS}\nrejected=${record.rejectedPaths.length}\nrecoverable=${recoverableCount}\nhardCandidates=${hardCandidateCount}\nterminal=${terminalCount}\nresult=REINVESTIGATE`
                );
              }

              await input.onRevisionRequired?.(executed.response, undefined as any, iteration);
              continue;
            }

            if (
              code === "PLANNING_SCOPE_REJECTED" &&
              executed.response.planningFailureFacts?.some((fact) => fact.kind === "AUTHORITY_REJECTION")
            ) {
              const activeStageId = executed.response.taskExecutionPlan?.stages[
                executed.response.taskExecutionPlan.currentStageIndex
              ]?.id || "stage-default";
              console.warn(`[PLAN_SCOPE_RECOVERY]\nstage=${activeStageId}\nresult=TERMINAL`);
            }

            const category = REINVESTIGATION_OUTCOMES.has(code) || code === "REPAIR_UNRESOLVED"
              ? "VALIDATION_FAILURE"
              : code.startsWith("CAPABILITY_") && code !== "CAPABILITY_TECHNICAL_FAILURE"
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
            if (REINVESTIGATION_OUTCOMES.has(code) && !failedActionFingerprints.has(code)) {
              failedActionFingerprints.add(code);
              workingPlan = workingPlan.revise({ reason: `${code} requires fresh repository observation, investigation and authorization.` });
              continue;
            }
            if (category !== "VALIDATION_FAILURE") {
              input.runtime.fail({
                failureType: category === "AUTHORIZATION_DENIAL" ? "POLICY_BLOCKED" : "TECHNICAL_FAILURE",
                code,
                message: executed.response.reason ?? executed.response.explanation,
              });
            }
            return {
              response: finalize(executed.response),
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
            response: finalize(executed.response),
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
            response: finalize(executed.response),
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
        verifiedCheckpoints.push(entry);
        const currentStageId = executed.response.taskExecutionPlan?.stages[
          executed.response.taskExecutionPlan.currentStageIndex
        ]?.id || "stage-default";
        const stageHistory = stagePlanningAttempts.get(currentStageId);
        if (stageHistory && stageHistory.length > 0) {
          const prev = stageHistory[stageHistory.length - 1];
          const previousIdentity = prev.kind === "CANONICAL_PLAN"
            ? prev.manifestFingerprint
            : prev.recoveryIdentity;
          console.log(
            `[RECOVERY] kind=${prev.kind} stage=${currentStageId} previousIdentity=${previousIdentity.slice(0, 32)} result=RECOVERED`,
          );
          console.log(`[PLAN_RECOVERY]\nresult=RECOVERED`);
        }
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
          response: finalize(executed.response),
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
          response: finalize(lastResponse),
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
      response: finalize(lastResponse),
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
