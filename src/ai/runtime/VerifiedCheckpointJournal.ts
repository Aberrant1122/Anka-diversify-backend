import {
  ActionGroupValidationReceipt,
  isAuthenticActionGroupValidationReceipt,
} from "../orchestration/ValidationCoordinator";
import type { ActionGroupSnapshot } from "../orchestration/ActionGroup";
import type { AgentFileChange } from "../shared/types";

export type ActionGroupJournalFailureCode =
  | "AUTHORIZATION_FAILED"
  | "ACTION_EXECUTION_FAILED"
  | "VALIDATION_FAILED"
  | "VALIDATION_EXCEPTION";

export interface ActionGroupJournalEntry {
  readonly journalId: string;
  readonly sequence: number;
  readonly recordedAt: string;
  readonly actionGroupId: string;
  readonly stageId: string;
  readonly authorizedScopeReference: string;
  readonly attemptedActions: ActionGroupSnapshot["actions"];
  readonly proposedActions: ActionGroupSnapshot["actions"];
  readonly beforeFingerprints: Readonly<Record<string, string>>;
  readonly attemptedAfterFingerprints: Readonly<Record<string, string>>;
  readonly finalFingerprints: Readonly<Record<string, string>>;
  /** Exact backend-observed payload for the mutations that passed validation. */
  readonly verifiedChanges: readonly AgentFileChange[];
  readonly repositoryRevisionBefore?: string;
  readonly repositoryRevisionAfter?: string;
  readonly validation: {
    readonly source: "VALIDATION_COORDINATOR" | "NOT_COMPLETED";
    readonly passed: boolean;
    readonly reasons: readonly string[];
  };
  readonly status: "VERIFIED" | "ROLLED_BACK";
  readonly failureCode?: ActionGroupJournalFailureCode;
}

function freezeFingerprints(value: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  return Object.freeze({ ...value });
}

function freezeEntry(entry: ActionGroupJournalEntry): ActionGroupJournalEntry {
  Object.freeze(entry.attemptedActions);
  Object.freeze(entry.verifiedChanges);
  Object.freeze(entry.validation.reasons);
  Object.freeze(entry.validation);
  return Object.freeze(entry);
}

/** Append-only runtime audit evidence. It grants no filesystem or verification authority. */
export class VerifiedCheckpointJournal {
  private readonly entries: ActionGroupJournalEntry[] = [];

  constructor(private readonly now: () => Date = () => new Date()) {}

  public appendVerified(
    group: ActionGroupSnapshot,
    attemptedActions: ActionGroupSnapshot["actions"],
    before: Readonly<Record<string, string>>,
    attemptedAfter: Readonly<Record<string, string>>,
    finalEvidence: Readonly<Record<string, string>>,
    verifiedChanges: readonly AgentFileChange[],
    receipt: ActionGroupValidationReceipt,
    repositoryRevisions?: { before?: string; after?: string },
  ): ActionGroupJournalEntry {
    if (group.lifecycle !== "VERIFIED" || !isAuthenticActionGroupValidationReceipt(receipt) || !receipt.passed) {
      throw new Error("Only deterministically validated ActionGroups can become VERIFIED checkpoints");
    }
    return this.append(group, attemptedActions, before, attemptedAfter, finalEvidence, verifiedChanges, {
      source: receipt.source,
      passed: true,
      reasons: receipt.reasons,
    }, "VERIFIED", undefined, repositoryRevisions);
  }

  public appendRolledBack(
    group: ActionGroupSnapshot,
    attemptedActions: ActionGroupSnapshot["actions"],
    before: Readonly<Record<string, string>>,
    attemptedAfter: Readonly<Record<string, string>>,
    finalEvidence: Readonly<Record<string, string>>,
    failureCode: ActionGroupJournalFailureCode,
    receipt?: ActionGroupValidationReceipt,
  ): ActionGroupJournalEntry {
    if (group.lifecycle !== "ROLLED_BACK") throw new Error("Rolled-back journal facts require a rolled-back ActionGroup");
    return this.append(group, attemptedActions, before, attemptedAfter, finalEvidence, [], receipt
      ? { source: receipt.source, passed: false, reasons: receipt.reasons }
      : { source: "NOT_COMPLETED", passed: false, reasons: Object.freeze([failureCode]) }, "ROLLED_BACK", failureCode);
  }

  public snapshot(): readonly ActionGroupJournalEntry[] {
    return Object.freeze([...this.entries]);
  }

  public verifiedCheckpoints(): readonly ActionGroupJournalEntry[] {
    return Object.freeze(this.entries.filter((entry) => entry.status === "VERIFIED"));
  }

  private append(
    group: ActionGroupSnapshot,
    attemptedActions: ActionGroupSnapshot["actions"],
    before: Readonly<Record<string, string>>,
    attemptedAfter: Readonly<Record<string, string>>,
    finalEvidence: Readonly<Record<string, string>>,
    verifiedChanges: readonly AgentFileChange[],
    validation: ActionGroupJournalEntry["validation"],
    status: ActionGroupJournalEntry["status"],
    failureCode?: ActionGroupJournalFailureCode,
    repositoryRevisions?: { before?: string; after?: string },
  ): ActionGroupJournalEntry {
    const sequence = this.entries.length + 1;
    const recordedAt = this.now();
    if (!(recordedAt instanceof Date) || Number.isNaN(recordedAt.getTime())) throw new Error("Journal clock returned an invalid date");
    const entry = freezeEntry({
      journalId: `journal_${String(sequence).padStart(6, "0")}_${group.id}`,
      sequence,
      recordedAt: recordedAt.toISOString(),
      actionGroupId: group.id,
      stageId: group.stageId,
      authorizedScopeReference: group.authorizedScopeReference,
      attemptedActions: Object.freeze([...attemptedActions]),
      proposedActions: group.actions,
      beforeFingerprints: freezeFingerprints(before),
      attemptedAfterFingerprints: freezeFingerprints(attemptedAfter),
      finalFingerprints: freezeFingerprints(finalEvidence),
      verifiedChanges: Object.freeze(verifiedChanges.map((change) => Object.freeze({ ...change }))),
      validation: Object.freeze({ ...validation, reasons: Object.freeze([...validation.reasons]) }),
      status,
      ...(failureCode ? { failureCode } : {}),
      ...(repositoryRevisions?.before ? { repositoryRevisionBefore: repositoryRevisions.before } : {}),
      ...(repositoryRevisions?.after ? { repositoryRevisionAfter: repositoryRevisions.after } : {}),
    });
    this.entries.push(entry);
    return entry;
  }
}
