import crypto from "crypto";
import fs from "fs";
import path from "path";
import { AgentFileChange } from "../shared/types";
import { StageExecutionTransaction } from "./StageExecutionTransaction";
import { ActionGroupJournalEntry, ActionGroupJournalFailureCode, VerifiedCheckpointJournal } from "../runtime/VerifiedCheckpointJournal";
import { ActionGroupValidationReceipt, isAuthenticActionGroupValidationReceipt } from "./ValidationCoordinator";

export type ActionGroupLifecycle =
  | "PROPOSED"
  | "AUTHORIZED"
  | "SNAPSHOTTED"
  | "EXECUTING"
  | "VALIDATING"
  | "VERIFIED"
  | "ROLLED_BACK";

export interface ActionGroupAction {
  readonly order: number;
  readonly action: "FILE_CREATE" | "FILE_MODIFY" | "FILE_DELETE";
  readonly path: string;
  readonly contentFingerprint: string;
}

export interface ActionGroupInput {
  stageId: string;
  authorizedScopeReference: string;
  actions: readonly AgentFileChange[];
}

export interface ActionGroupSnapshot {
  id: string;
  stageId: string;
  authorizedScopeReference: string;
  lifecycle: ActionGroupLifecycle;
  actions: readonly ActionGroupAction[];
}

function requireText(value: string, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function normalizePath(value: string): string {
  const normalized = requireText(value, "action path").replace(/\\/g, "/");
  if (path.posix.isAbsolute(normalized) || path.win32.isAbsolute(normalized)) {
    throw new Error(`ActionGroup paths must be repository-relative: ${value}`);
  }
  const relative = path.posix.normalize(normalized).replace(/^\.\//, "");
  if (!relative || relative === "." || relative === ".." || relative.startsWith("../")) {
    throw new Error(`Invalid ActionGroup path: ${value}`);
  }
  return relative;
}

function fingerprint(content: Buffer | string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function typedAction(change: AgentFileChange, order: number): ActionGroupAction {
  const action = change.action === "delete" || change.isDeleted
    ? "FILE_DELETE"
    : change.action === "create"
      ? "FILE_CREATE"
      : "FILE_MODIFY";
  return Object.freeze({
    order,
    action,
    path: normalizePath(change.path),
    contentFingerprint: fingerprint(action === "FILE_DELETE" ? "" : change.content),
  });
}

function executedAction(
  mutation: { path: string; action: ActionGroupAction["action"]; content: string },
  order: number,
): ActionGroupAction {
  return Object.freeze({
    order,
    action: mutation.action,
    path: normalizePath(mutation.path),
    contentFingerprint: fingerprint(mutation.action === "FILE_DELETE" ? "" : mutation.content),
  });
}

function captureFingerprints(root: string | null, actions: readonly ActionGroupAction[]): Readonly<Record<string, string>> {
  const evidence: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const action of actions) {
    const absolutePath = root ? path.resolve(root, action.path) : null;
    try {
      evidence[action.path] = absolutePath && fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile()
        ? fingerprint(fs.readFileSync(absolutePath))
        : "MISSING";
    } catch {
      evidence[action.path] = "UNAVAILABLE";
    }
  }
  return Object.freeze(evidence);
}

function failureCode(error: unknown, phase: "AUTHORIZATION" | "EXECUTION" | "VALIDATION"): ActionGroupJournalFailureCode {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string" && error.code.startsWith("CAPABILITY_")) {
    return "AUTHORIZATION_FAILED";
  }
  return phase === "AUTHORIZATION"
    ? "AUTHORIZATION_FAILED"
    : phase === "EXECUTION"
      ? "ACTION_EXECUTION_FAILED"
      : "VALIDATION_EXCEPTION";
}

/** Immutable identity and ordered mutation proposal; it contains no mutation authority. */
export class ActionGroup {
  private lifecycle: ActionGroupLifecycle = "PROPOSED";
  private readonly changes: readonly AgentFileChange[];
  private readonly value: Omit<ActionGroupSnapshot, "lifecycle">;

  private constructor(input: ActionGroupInput) {
    const actions = input.actions.map(typedAction);
    if (actions.length === 0) throw new Error("ActionGroup requires at least one action");
    const stageId = requireText(input.stageId, "stageId");
    const authorizedScopeReference = requireText(input.authorizedScopeReference, "authorized scope reference");
    const canonicalIdentity = JSON.stringify({ stageId, authorizedScopeReference, actions });
    this.value = Object.freeze({
      id: `ag_${fingerprint(canonicalIdentity).slice(0, 20)}`,
      stageId,
      authorizedScopeReference,
      actions: Object.freeze(actions),
    });
    this.changes = Object.freeze(input.actions.map((change) => Object.freeze({ ...change })));
  }

  public static create(input: ActionGroupInput): ActionGroup {
    return new ActionGroup(input);
  }

  public snapshot(): ActionGroupSnapshot {
    return Object.freeze({ ...this.value, lifecycle: this.lifecycle });
  }

  public proposedChanges(): readonly AgentFileChange[] {
    return this.changes;
  }

  public executedActions(mutations: readonly { path: string; action: ActionGroupAction["action"]; content: string }[]): readonly ActionGroupAction[] {
    return Object.freeze(mutations.map(executedAction));
  }

  /** @internal Runtime executor transition; a lifecycle alone is never verification authority. */
  public transition(expected: ActionGroupLifecycle, next: ActionGroupLifecycle): void {
    if (this.lifecycle !== expected) {
      throw new Error(`Invalid ActionGroup lifecycle transition ${this.lifecycle} -> ${next}; expected ${expected}`);
    }
    this.lifecycle = next;
  }
}

export interface ActionGroupExecutionResult<T> {
  readonly group: ActionGroupSnapshot;
  readonly value: T;
  readonly journalEntry: ActionGroupJournalEntry;
}

/**
 * Executes an ActionGroup but cannot issue validation receipts.  It accepts only
 * the opaque receipts minted inside ValidationCoordinator and rejects lookalikes.
 */
export class ActionGroupExecutor {
  public static async execute<T>(input: {
    group: ActionGroup;
    transaction: StageExecutionTransaction;
    journal: VerifiedCheckpointJournal;
    executeActions: () => Promise<T>;
    validate: (value: T) => Promise<ActionGroupValidationReceipt> | ActionGroupValidationReceipt;
  }): Promise<ActionGroupExecutionResult<T>> {
    const proposed = input.group.snapshot();
    const root = input.transaction.localPath;
    const before = captureFingerprints(root, proposed.actions);
    let value: T | undefined;
    let receipt: ActionGroupValidationReceipt | undefined;
    let phase: "AUTHORIZATION" | "EXECUTION" | "VALIDATION" = "AUTHORIZATION";
    try {
      input.group.transition("PROPOSED", "AUTHORIZED");
      await input.transaction.snapshot([...input.group.proposedChanges()]);
      input.group.transition("AUTHORIZED", "SNAPSHOTTED");
      input.group.transition("SNAPSHOTTED", "EXECUTING");
      phase = "EXECUTION";
      value = await input.executeActions();
      input.group.transition("EXECUTING", "VALIDATING");
      phase = "VALIDATION";
      receipt = await input.validate(value);
      if (!isAuthenticActionGroupValidationReceipt(receipt)) {
        throw new Error("ActionGroup requires an authentic deterministic validation receipt");
      }
      const attemptedActions = input.group.executedActions(input.transaction.getExecutedMutations());
      const attemptedAfter = captureFingerprints(root, attemptedActions);
      if (!receipt.passed) {
        await input.transaction.rollback();
        input.group.transition("VALIDATING", "ROLLED_BACK");
        const entry = input.journal.appendRolledBack(input.group.snapshot(), attemptedActions, before, attemptedAfter,
          captureFingerprints(root, attemptedActions), "VALIDATION_FAILED", receipt);
        return { group: input.group.snapshot(), value, journalEntry: entry };
      }
      await input.transaction.commit();
      input.group.transition("VALIDATING", "VERIFIED");
      const entry = input.journal.appendVerified(input.group.snapshot(), attemptedActions, before, attemptedAfter,
        captureFingerprints(root, attemptedActions), receipt);
      return { group: input.group.snapshot(), value, journalEntry: entry };
    } catch (error) {
      const attemptedActions = input.group.executedActions(input.transaction.getExecutedMutations());
      const attemptedAfter = captureFingerprints(root, attemptedActions);
      await input.transaction.rollback();
      const current = input.group.snapshot().lifecycle;
      if (current !== "ROLLED_BACK" && current !== "VERIFIED") input.group.transition(current, "ROLLED_BACK");
      input.journal.appendRolledBack(input.group.snapshot(), attemptedActions, before, attemptedAfter,
        captureFingerprints(root, attemptedActions), failureCode(error, phase), receipt);
      throw error;
    }
  }
}
