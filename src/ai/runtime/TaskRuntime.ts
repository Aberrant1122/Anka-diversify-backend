import { AgentWorkspaceSnapshot, AgentWorkspaceState } from "./AgentWorkspaceState";

export type TaskRuntimeStatus = "CREATED" | "RUNNING" | "AWAITING_CLARIFICATION" | "COMPLETED" | "FAILED";
export type TaskFailureType = "TECHNICAL_FAILURE" | "VALIDATION_FAILURE" | "POLICY_BLOCKED" | "BUDGET_EXHAUSTED";

export type TaskTerminalOutcome =
  | { type: "COMPLETED"; validationSource: "DETERMINISTIC_VALIDATION" }
  | { type: "FAILED"; failureType: TaskFailureType; code: string; message: string };

export interface TaskClarificationState {
  question: string;
  reason: string;
}

export interface TaskRuntimeSnapshot {
  taskId: string;
  originalGoal: string;
  status: TaskRuntimeStatus;
  workspace: AgentWorkspaceSnapshot;
  runtimeScope: { budgetScopeId: string; contextScopeId: string };
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  clarification?: TaskClarificationState;
  terminalOutcome?: TaskTerminalOutcome;
  metadata: Readonly<Record<string, string>>;
}

export interface DeterministicValidationFacts {
  validationPassed: boolean;
  source: "GIT_WORKTREE_VALIDATION" | "VALIDATION_RUNNER";
}

const COMPLETION_RECEIPT = Symbol("TaskRuntime deterministic completion receipt");

/** Opaque receipt: JSON/model output cannot satisfy TaskRuntime's completion gate. */
export class VerifiedCompletionReceipt {
  private readonly marker = COMPLETION_RECEIPT;
  private constructor(public readonly source: DeterministicValidationFacts["source"]) {
    Object.freeze(this);
  }

  public static fromDeterministicValidation(facts: DeterministicValidationFacts): VerifiedCompletionReceipt {
    if (facts.validationPassed !== true) {
      throw new Error("Task completion requires passing deterministic validation");
    }
    if (facts.source !== "GIT_WORKTREE_VALIDATION" && facts.source !== "VALIDATION_RUNNER") {
      throw new Error("Task completion requires a recognized deterministic validation source");
    }
    return new VerifiedCompletionReceipt(facts.source);
  }

  public isAuthentic(): boolean {
    return this.marker === COMPLETION_RECEIPT;
  }
}

export interface TaskRuntimeInput {
  taskId: string;
  originalGoal: string;
  workspace: AgentWorkspaceState;
  runtimeScopeId?: string;
  metadata?: Record<string, string>;
  now?: () => Date;
}

function requireText(value: string | undefined, field: string): string {
  if (!value || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

/** State coordinator only; it performs no repository or provider operations. */
export class TaskRuntime {
  private status: TaskRuntimeStatus = "CREATED";
  private workspace: AgentWorkspaceState;
  private readonly createdAt: string;
  private startedAt?: string;
  private endedAt?: string;
  private clarification?: TaskClarificationState;
  private terminalOutcome?: TaskTerminalOutcome;
  private readonly now: () => Date;
  private readonly taskId: string;
  private readonly originalGoal: string;
  private readonly runtimeScopeId: string;
  private readonly metadata: Readonly<Record<string, string>>;

  private constructor(input: TaskRuntimeInput) {
    this.taskId = requireText(input.taskId, "taskId");
    this.originalGoal = requireText(input.originalGoal, "originalGoal");
    if (!(input.workspace instanceof AgentWorkspaceState)) throw new Error("workspace must be AgentWorkspaceState");
    this.workspace = input.workspace;
    this.runtimeScopeId = requireText(input.runtimeScopeId ?? this.taskId, "runtimeScopeId");
    this.metadata = Object.freeze({ ...(input.metadata ?? {}) });
    this.now = input.now ?? (() => new Date());
    this.createdAt = this.timestamp();
  }

  public static create(input: TaskRuntimeInput): TaskRuntime {
    return new TaskRuntime(input);
  }

  public start(): void {
    this.requireStatus("CREATED", "start");
    this.status = "RUNNING";
    this.startedAt = this.timestamp();
  }

  public requestClarification(clarification: TaskClarificationState): void {
    this.requireStatus("RUNNING", "request clarification");
    this.status = "AWAITING_CLARIFICATION";
    this.clarification = {
      question: requireText(clarification.question, "clarification question"),
      reason: requireText(clarification.reason, "clarification reason"),
    };
  }

  public resumeAfterClarification(): void {
    this.requireStatus("AWAITING_CLARIFICATION", "resume");
    this.status = "RUNNING";
    this.clarification = undefined;
  }

  public updateWorkspace(workspace: AgentWorkspaceState): void {
    if (this.status !== "CREATED" && this.status !== "RUNNING") {
      throw new Error(`Cannot update workspace while task runtime is ${this.status}`);
    }
    this.workspace = workspace;
  }

  /** Read-only state object for loop coordination; AgentWorkspaceState exposes no mutation authority. */
  public workspaceState(): AgentWorkspaceState {
    return this.workspace;
  }

  public complete(receipt: VerifiedCompletionReceipt): void {
    this.requireStatus("RUNNING", "complete");
    if (!(receipt instanceof VerifiedCompletionReceipt) || !receipt.isAuthentic()) {
      throw new Error("Task completion requires an authentic deterministic validation receipt");
    }
    this.status = "COMPLETED";
    this.endedAt = this.timestamp();
    this.terminalOutcome = { type: "COMPLETED", validationSource: "DETERMINISTIC_VALIDATION" };
  }

  public fail(failure: { failureType: TaskFailureType; code: string; message: string }): void {
    if (this.status === "COMPLETED" || this.status === "FAILED") {
      throw new Error(`Cannot fail terminal task runtime ${this.status}`);
    }
    const failureTypes: TaskFailureType[] = [
      "TECHNICAL_FAILURE", "VALIDATION_FAILURE", "POLICY_BLOCKED", "BUDGET_EXHAUSTED",
    ];
    if (!failureTypes.includes(failure.failureType)) {
      throw new Error(`Unsupported task failure type: ${String(failure.failureType)}`);
    }
    this.status = "FAILED";
    this.endedAt = this.timestamp();
    this.clarification = undefined;
    this.terminalOutcome = {
      type: "FAILED",
      failureType: failure.failureType,
      code: requireText(failure.code, "failure code"),
      message: requireText(failure.message, "failure message"),
    };
  }

  public snapshot(): TaskRuntimeSnapshot {
    const snapshot: TaskRuntimeSnapshot = {
      taskId: this.taskId,
      originalGoal: this.originalGoal,
      status: this.status,
      workspace: this.workspace.snapshot(),
      runtimeScope: { budgetScopeId: this.runtimeScopeId, contextScopeId: this.runtimeScopeId },
      createdAt: this.createdAt,
      ...(this.startedAt ? { startedAt: this.startedAt } : {}),
      ...(this.endedAt ? { endedAt: this.endedAt } : {}),
      ...(this.clarification ? { clarification: { ...this.clarification } } : {}),
      ...(this.terminalOutcome ? { terminalOutcome: { ...this.terminalOutcome } } : {}),
      metadata: this.metadata,
    };
    Object.freeze(snapshot.runtimeScope);
    if (snapshot.clarification) Object.freeze(snapshot.clarification);
    if (snapshot.terminalOutcome) Object.freeze(snapshot.terminalOutcome);
    return Object.freeze(snapshot);
  }

  private requireStatus(expected: TaskRuntimeStatus, operation: string): void {
    if (this.status !== expected) {
      throw new Error(`Cannot ${operation} task runtime from ${this.status}; expected ${expected}`);
    }
  }

  private timestamp(): string {
    const value = this.now();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new Error("Runtime clock returned an invalid date");
    return value.toISOString();
  }
}
