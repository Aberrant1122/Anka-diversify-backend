import crypto from "crypto";
import fs from "fs";
import path from "path";
import type { AgentLoopStopReason } from "../orchestration/AgentLoopCoordinator";
import type { TaskExecutionPlan } from "../shared/TaskExecutionPlan";
import {
  DiagnosticBaselineComparison,
  isAuthenticDiagnosticBaselineComparison,
} from "./BaselineDiagnosticVerifier";
import type { AgentWorkspaceSnapshot, AgentWorkspaceState } from "./AgentWorkspaceState";
import { VerifiedCheckpointJournal } from "./VerifiedCheckpointJournal";

export interface VerifiedCompletionReceipt {
  readonly source: "COMPLETION_EVALUATOR";
  readonly evaluationId: string;
  readonly taskId: string;
}

const authenticCompletionReceipts = new WeakSet<object>();
const receiptRuntimeOwners = new WeakMap<object, CompletionRuntimeView>();

class AuthenticCompletionReceipt implements VerifiedCompletionReceipt {
  public readonly source = "COMPLETION_EVALUATOR" as const;

  private constructor(public readonly evaluationId: string, public readonly taskId: string, runtime: CompletionRuntimeView) {
    authenticCompletionReceipts.add(this);
    receiptRuntimeOwners.set(this, runtime);
    Object.freeze(this);
  }

  public static issue(evaluationId: string, taskId: string, runtime: CompletionRuntimeView): VerifiedCompletionReceipt {
    return new AuthenticCompletionReceipt(evaluationId, taskId, runtime);
  }
}

export function isAuthenticCompletionReceiptFor(
  value: unknown,
  runtime: CompletionRuntimeView,
): value is VerifiedCompletionReceipt {
  return typeof value === "object" && value !== null
    && authenticCompletionReceipts.has(value)
    && receiptRuntimeOwners.get(value) === runtime;
}

export type CompletionRequirementStatus = "SATISFIED" | "UNSATISFIED" | "MISSING_INFORMATION";

export interface CompletionRequirementFact {
  readonly id: string;
  readonly description: string;
  readonly required: boolean;
  readonly status: CompletionRequirementStatus;
  readonly repositoryRevision?: string;
  readonly checkpointIds?: readonly string[];
  readonly clarification?: { readonly question: string; readonly reason: string };
}

export interface CompletionRepositoryFacts {
  readonly root: string;
  readonly revision: string;
  readonly changedPaths: readonly string[];
  readonly source: "MATERIALIZED_REPOSITORY";
  readonly coverage: "FULL_REPOSITORY_DELTA";
  readonly trustedChanges?: readonly {
    readonly path: string;
    readonly fingerprint: string;
    readonly source: "BASELINE_REPAIR_COORDINATOR";
  }[];
}

export interface CompletionValidationFacts {
  readonly passed: boolean;
  readonly repositoryRevision: string;
  readonly source: "VALIDATION_COORDINATOR" | "GIT_WORKTREE_VALIDATION" | "VALIDATION_RUNNER";
  readonly technicalFailure?: { readonly code: string; readonly message: string };
}

export interface CompletionHandoff {
  readonly outcome: AgentLoopStopReason;
  readonly workingPlanId: string;
  readonly workingPlanRevision: number;
}

interface CompletionRuntimeView {
  snapshot(): { readonly taskId: string; readonly status: string; readonly workspace: AgentWorkspaceSnapshot };
  workspaceState(): AgentWorkspaceState;
}

export interface CompletionEvaluationInput {
  readonly runtime: CompletionRuntimeView;
  readonly handoff: CompletionHandoff;
  readonly journal: VerifiedCheckpointJournal;
  readonly repository: CompletionRepositoryFacts;
  readonly validation: CompletionValidationFacts;
  readonly requirements: readonly CompletionRequirementFact[];
  readonly diagnosticComparison?: DiagnosticBaselineComparison;
  readonly diagnosticRepositoryRevision?: string;
  readonly diagnosticsRequired?: boolean;
  readonly externalValidationPending?: boolean;
}

export type CompletionEvaluationResult =
  | {
      readonly outcome: "COMPLETE";
      readonly code: "DETERMINISTIC_COMPLETION_PROVEN";
      readonly receipt: VerifiedCompletionReceipt;
      readonly satisfiedRequirementIds: readonly string[];
    }
  | {
      readonly outcome: "INCOMPLETE";
      readonly code: string;
      readonly category: "ACTIONABLE_WORK" | "VALIDATION_FAILURE" | "STALE_EVIDENCE" | "UNVERIFIED_MUTATION" | "UNSATISFIED_REQUIREMENT";
      readonly message: string;
    }
  | {
      readonly outcome: "BLOCKED";
      readonly code: string;
      readonly category: "AUTHORIZATION_DENIAL" | "POLICY_BLOCK";
      readonly message: string;
    }
  | {
      readonly outcome: "CLARIFICATION_REQUIRED";
      readonly code: "MISSING_USER_INFORMATION";
      readonly question: string;
      readonly reason: string;
    }
  | {
      readonly outcome: "TECHNICAL_FAILURE";
      readonly code: string;
      readonly message: string;
    };

function text(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function incomplete(
  code: string,
  category: Extract<CompletionEvaluationResult, { outcome: "INCOMPLETE" }>["category"],
  message: string,
): CompletionEvaluationResult {
  return Object.freeze({ outcome: "INCOMPLETE", code, category, message });
}

function normalizeRelativePath(value: string): string | undefined {
  if (!text(value)) return undefined;
  const slashPath = value.replace(/\\/g, "/");
  if (path.posix.isAbsolute(slashPath) || path.win32.isAbsolute(slashPath)) return undefined;
  const normalized = path.posix.normalize(slashPath).replace(/^\.\//, "");
  return normalized && normalized !== "." && normalized !== ".." && !normalized.startsWith("../")
    ? normalized
    : undefined;
}

function fileFingerprint(root: string, relativePath: string): string {
  const absoluteRoot = path.resolve(root);
  const absolutePath = path.resolve(absoluteRoot, relativePath);
  const relative = path.relative(absoluteRoot, absolutePath);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return "OUTSIDE_ROOT";
  try {
    return fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile()
      ? crypto.createHash("sha256").update(fs.readFileSync(absolutePath)).digest("hex")
      : "MISSING";
  } catch {
    return "UNAVAILABLE";
  }
}

function resultForHandoff(outcome: AgentLoopStopReason, failureCode?: string): CompletionEvaluationResult | undefined {
  if (outcome === "AWAITING_COMPLETION_EVALUATION") return undefined;
  if (outcome === "CLARIFICATION_REQUIRED") {
    return Object.freeze({
      outcome: "CLARIFICATION_REQUIRED",
      code: "MISSING_USER_INFORMATION",
      question: "Additional user information is required.",
      reason: "The bounded agent loop requested clarification before completion evaluation.",
    });
  }
  if (outcome === "AUTHORIZATION_DENIED") {
    return Object.freeze({
      outcome: "BLOCKED",
      code: failureCode ?? "AUTHORIZATION_DENIED",
      category: "AUTHORIZATION_DENIAL",
      message: "Required work remains authorization-denied.",
    });
  }
  if (outcome === "TECHNICAL_FAILURE" || outcome === "BUDGET_EXHAUSTED") {
    return Object.freeze({
      outcome: "TECHNICAL_FAILURE",
      code: failureCode ?? outcome,
      message: "The agent loop ended with a technical runtime failure.",
    });
  }
  return incomplete(
    failureCode ?? outcome,
    outcome === "VALIDATION_FAILURE" ? "VALIDATION_FAILURE" : "ACTIONABLE_WORK",
    "The bounded agent loop did not reach the completion-evaluation handoff.",
  );
}

/**
 * Final deterministic completion authority. It performs no planning, model calls,
 * mutation, validation orchestration, or autonomous-loop re-entry.
 */
export class CompletionEvaluator {
  public static evaluate(input: CompletionEvaluationInput): CompletionEvaluationResult {
    try {
      const runtime = input.runtime.snapshot();
      const handoffResult = resultForHandoff(input.handoff.outcome);
      if (handoffResult) return handoffResult;
      if (runtime.status !== "RUNNING") {
        return incomplete("RUNTIME_NOT_RUNNING", "ACTIONABLE_WORK", `TaskRuntime is ${runtime.status}, not RUNNING.`);
      }
      if (!(input.journal instanceof VerifiedCheckpointJournal)) {
        return incomplete("UNTRUSTED_CHECKPOINT_JOURNAL", "UNVERIFIED_MUTATION", "Checkpoint evidence is not an authentic journal instance.");
      }

      const workspace = runtime.workspace;
      const plan = workspace.workingPlan;
      if (!plan || plan.status !== "AWAITING_COMPLETION_EVALUATION"
        || plan.id !== input.handoff.workingPlanId || plan.revision !== input.handoff.workingPlanRevision) {
        return incomplete("UNRESOLVED_WORKING_PLAN", "ACTIONABLE_WORK", "The current WorkingPlan is not the exact CP7 completion-evaluation handoff.");
      }

      if (input.externalValidationPending) {
        return incomplete("EXTERNAL_VALIDATION_PENDING", "VALIDATION_FAILURE", "Required outer deterministic validation has not completed.");
      }

      if (input.validation.technicalFailure) {
        return Object.freeze({
          outcome: "TECHNICAL_FAILURE",
          code: input.validation.technicalFailure.code,
          message: input.validation.technicalFailure.message,
        });
      }
      const technicalFailure = workspace.failureFacts.find((fact) => fact.category === "TECHNICAL_FAILURE");
      if (technicalFailure) {
        return Object.freeze({ outcome: "TECHNICAL_FAILURE", code: technicalFailure.code, message: "A deterministic technical failure remains unresolved." });
      }
      const denial = workspace.failureFacts.find((fact) => fact.category === "AUTHORIZATION_DENIAL");
      if (denial) {
        return Object.freeze({
          outcome: "BLOCKED",
          code: denial.code,
          category: "AUTHORIZATION_DENIAL",
          message: "Required work remains authorization-denied.",
        });
      }

      if (input.repository.source !== "MATERIALIZED_REPOSITORY" || !text(input.repository.revision)) {
        return incomplete("INVALID_REPOSITORY_FACTS", "STALE_EVIDENCE", "Current materialized repository facts are missing.");
      }
      if (input.repository.coverage !== "FULL_REPOSITORY_DELTA") {
        return incomplete("INCOMPLETE_REPOSITORY_DELTA", "STALE_EVIDENCE", "Repository change facts do not cover the full current disk delta.");
      }
      const latestMaterialized = [...workspace.evidence].reverse().find((item) => item.kind === "MATERIALIZED_REPOSITORY");
      if (!latestMaterialized?.revision || latestMaterialized.revision !== input.repository.revision) {
        return incomplete("STALE_REPOSITORY_EVIDENCE", "STALE_EVIDENCE", "Workspace evidence does not describe the latest materialized repository revision.");
      }
      if (!input.validation.passed) {
        return incomplete("DETERMINISTIC_VALIDATION_FAILED", "VALIDATION_FAILURE", "Required deterministic validation did not pass.");
      }
      if (input.validation.repositoryRevision !== input.repository.revision) {
        return incomplete("STALE_VALIDATION_REVISION", "STALE_EVIDENCE", "Validation evidence belongs to a different repository revision.");
      }

      const journal = input.journal.snapshot();
      const latestEntry = journal[journal.length - 1];
      if (latestEntry?.status === "ROLLED_BACK") {
        return incomplete("LATEST_ACTION_GROUP_NOT_VERIFIED", "UNVERIFIED_MUTATION", "The latest ActionGroup was rolled back or remains unverified.");
      }
      for (const entry of journal) {
        const reference = workspace.checkpointReferences.find((item) => item.id === entry.journalId);
        if (!reference || reference.status !== entry.status || reference.actionGroupId !== entry.actionGroupId) {
          return incomplete("CHECKPOINT_REFERENCE_MISMATCH", "UNVERIFIED_MUTATION", "Runtime checkpoint references do not match the authentic journal.");
        }
      }

      const normalizedChangedPaths: string[] = [];
      for (const changedPath of input.repository.changedPaths) {
        const normalized = normalizeRelativePath(changedPath);
        if (!normalized) return incomplete("INVALID_CHANGED_PATH", "UNVERIFIED_MUTATION", "A current repository change is outside the repository root.");
        normalizedChangedPaths.push(normalized);
      }
      const verifiedByPath = new Map<string, typeof journal[number]>();
      for (const entry of journal) {
        if (entry.status !== "VERIFIED") continue;
        for (const action of entry.attemptedActions) verifiedByPath.set(action.path, entry);
      }
      if (journal.some((entry) => entry.status === "VERIFIED")
        && !normalizedChangedPaths.some((changedPath) => verifiedByPath.has(changedPath))) {
        return incomplete("EXPECTED_REPOSITORY_CHANGE_ABSENT", "UNSATISFIED_REQUIREMENT", "VERIFIED mutation evidence produced no surviving task repository change.");
      }
      const trustedByPath = new Map(
        (input.repository.trustedChanges ?? []).map((change) => [normalizeRelativePath(change.path), change] as const),
      );
      for (const changedPath of new Set(normalizedChangedPaths)) {
        const checkpoint = verifiedByPath.get(changedPath);
        const trusted = trustedByPath.get(changedPath);
        if (!checkpoint && (!trusted || trusted.source !== "BASELINE_REPAIR_COORDINATOR")) {
          return incomplete("UNVERIFIED_REPOSITORY_CHANGE", "UNVERIFIED_MUTATION", `No VERIFIED checkpoint backs ${changedPath}.`);
        }
        const expected = checkpoint?.finalFingerprints[changedPath] ?? trusted?.fingerprint;
        if (!expected || fileFingerprint(input.repository.root, changedPath) !== expected) {
          return incomplete("STALE_CHECKPOINT_FINGERPRINT", "STALE_EVIDENCE", `Current disk bytes for ${changedPath} differ from VERIFIED checkpoint evidence.`);
        }
      }

      if (input.diagnosticsRequired && !input.diagnosticComparison) {
        return incomplete("DIAGNOSTIC_COMPARISON_MISSING", "VALIDATION_FAILURE", "Required baseline diagnostic comparison is missing.");
      }
      if (input.diagnosticComparison) {
        if (input.diagnosticRepositoryRevision !== input.repository.revision) {
          return incomplete("STALE_DIAGNOSTIC_REVISION", "STALE_EVIDENCE", "Diagnostic comparison belongs to a different repository revision.");
        }
        if (!isAuthenticDiagnosticBaselineComparison(input.diagnosticComparison)) {
          return incomplete("UNTRUSTED_DIAGNOSTIC_COMPARISON", "VALIDATION_FAILURE", "Baseline diagnostic comparison is not authentic.");
        }
        if (!input.diagnosticComparison.verifiedSuccess || input.diagnosticComparison.counts.INTRODUCED > 0) {
          return incomplete("TASK_INTRODUCED_DIAGNOSTIC", "VALIDATION_FAILURE", "Current validation contains a task-introduced blocking diagnostic.");
        }
      }

      const required = input.requirements.filter((requirement) => requirement.required);
      if (required.length === 0) {
        return incomplete("NO_DETERMINISTIC_REQUIREMENTS", "UNSATISFIED_REQUIREMENT", "The user goal has no deterministic completion criterion in trusted runtime state.");
      }
      for (const requirement of required) {
        if (requirement.status === "MISSING_INFORMATION") {
          const question = text(requirement.clarification?.question);
          const reason = text(requirement.clarification?.reason);
          if (!question || !reason) {
            return incomplete("UNPROVEN_REQUIREMENT", "UNSATISFIED_REQUIREMENT", `Requirement ${requirement.id} lacks deterministic evidence.`);
          }
          return Object.freeze({ outcome: "CLARIFICATION_REQUIRED", code: "MISSING_USER_INFORMATION", question, reason });
        }
        if (requirement.status !== "SATISFIED") {
          return incomplete("UNRESOLVED_REQUIRED_WORK", "UNSATISFIED_REQUIREMENT", `Required criterion ${requirement.id} is not satisfied.`);
        }
        if (requirement.repositoryRevision && requirement.repositoryRevision !== input.repository.revision) {
          return incomplete("STALE_REQUIREMENT_EVIDENCE", "STALE_EVIDENCE", `Requirement ${requirement.id} was evaluated against stale repository facts.`);
        }
        for (const checkpointId of requirement.checkpointIds ?? []) {
          if (!journal.some((entry) => entry.journalId === checkpointId && entry.status === "VERIFIED")) {
            return incomplete("UNVERIFIED_REQUIREMENT_EVIDENCE", "UNVERIFIED_MUTATION", `Requirement ${requirement.id} references a non-VERIFIED checkpoint.`);
          }
        }
      }

      const evaluationId = crypto.createHash("sha256").update(JSON.stringify({
        taskId: runtime.taskId,
        revision: input.repository.revision,
        validationSource: input.validation.source,
        checkpoints: journal.filter((entry) => entry.status === "VERIFIED").map((entry) => entry.journalId),
        requirements: required.map((requirement) => requirement.id),
      })).digest("hex");
      return Object.freeze({
        outcome: "COMPLETE",
        code: "DETERMINISTIC_COMPLETION_PROVEN",
        receipt: AuthenticCompletionReceipt.issue(evaluationId, runtime.taskId, input.runtime),
        satisfiedRequirementIds: Object.freeze(required.map((requirement) => requirement.id)),
      });
    } catch (error) {
      return Object.freeze({
        outcome: "TECHNICAL_FAILURE",
        code: "COMPLETION_EVALUATION_FAILED",
        message: error instanceof Error ? error.message : "Unknown deterministic completion-evaluation failure",
      });
    }
  }

  public static requirementsFromPlan(
    plan: TaskExecutionPlan | undefined,
    repositoryRevision: string,
    journal: VerifiedCheckpointJournal,
    deterministicNoOp = false,
  ): readonly CompletionRequirementFact[] {
    if (!plan) return Object.freeze([]);
    const entries = journal.verifiedCheckpoints();
    return Object.freeze(plan.stages.map((stage) => {
      const checkpoints = entries.filter((entry) => entry.stageId === stage.id).map((entry) => entry.journalId);
      return Object.freeze({
        id: `plan-stage:${stage.id}`,
        description: stage.intent.goal,
        required: true,
        // TaskExecutionPlan status is advisory. Satisfaction is derived only
        // from VERIFIED journal evidence or a separately proven deterministic no-op.
        status: checkpoints.length > 0 || deterministicNoOp
          ? "SATISFIED" as const
          : "UNSATISFIED" as const,
        repositoryRevision,
        checkpointIds: Object.freeze(checkpoints),
      });
    }));
  }
}
