import { AgentFileChange, AgentProgressEvent, ExecutionContract, FeatureValidationResult, FileManifest } from "../shared/types";
import fs from "fs";
import path from "path";
import { BaselineDiagnostic } from "../../types";
import { SelfHealingEngine } from "../repair/SelfHealingEngine";
import { SecurityAuditResult, SecurityAuditor } from "../review/SecurityAuditor";
import { TaskExecutionPlan } from "../shared/TaskExecutionPlan";
import { createPreTaskSourceGetter } from "../../services/baseline-delta.verifier";
import { MonorepoDescriptor } from "../workspace/MonorepoDetector";
import { RepositorySnapshotData } from "../repository/RepositorySnapshot";
import { ValidationDetector } from "../validation/ValidationDetector";
import { ValidationPlanner } from "../validation/ValidationPlanner";
import { StageExecutionTransaction, StageVerificationGate } from "./StageExecutionTransaction";
import { TaskExecutionPlanManager } from "../planning/TaskExecutionPlanManager";
import { AuthorizedCapabilityScope, CapabilityGuard } from "../runtime/CapabilityGuard";
import { MutationTransaction } from "../runtime/MutationTransaction";
import { MutationFailure } from "../runtime/MutationCompiler";
import { reconcileExecutionManifest } from "../runtime/ExecutionManifest";
import {
  ActionGroup,
  ActionGroupExecutionResult,
  ActionGroupExecutor,
} from "./ActionGroup";
import { ActionGroupJournalEntry, VerifiedCheckpointJournal } from "../runtime/VerifiedCheckpointJournal";

type RepairResult = Awaited<ReturnType<typeof SelfHealingEngine.runSelfHealingLoop>>;

/** Read-only receipt shape. No public constructor or issuer exists. */
export interface ActionGroupValidationReceipt {
  readonly passed: boolean;
  readonly source: "VALIDATION_COORDINATOR";
  readonly reasons: readonly string[];
}

const authenticValidationReceipts = new WeakSet<object>();

class DeterministicValidationReceipt implements ActionGroupValidationReceipt {
  public readonly source = "VALIDATION_COORDINATOR" as const;
  public readonly reasons: readonly string[];

  private constructor(public readonly passed: boolean, reasons: readonly string[]) {
    this.reasons = Object.freeze([...reasons]);
    authenticValidationReceipts.add(this);
    Object.freeze(this);
  }

  public static issue(passed: boolean, reasons: readonly string[]): ActionGroupValidationReceipt {
    return new DeterministicValidationReceipt(passed, reasons);
  }
}

/** Runtime authenticity check for opaque ValidationCoordinator-issued receipts. */
export function isAuthenticActionGroupValidationReceipt(value: unknown): value is ActionGroupValidationReceipt {
  return typeof value === "object" && value !== null && authenticValidationReceipts.has(value);
}

export interface ValidationCoordinationInput {
  acceptedChanges: AgentFileChange[];
  effectiveLocalPath: string | null;
  effectiveSnapshot: RepositorySnapshotData;
  executionContract: ExecutionContract;
  monorepo: MonorepoDescriptor;
  activeStageId: string;
  taskExecutionPlan: TaskExecutionPlan;
  systemPrompt: string;
  requestMessage: string;
  projectId: string;
  approvedManifest: FileManifest | null;
  authorizedCapabilityScope?: AuthorizedCapabilityScope;
  onProgress?: (event: AgentProgressEvent) => void;
  baselineDiagnostics?: BaselineDiagnostic[];
  targetedBaselineDiagnostics?: BaselineDiagnostic[];
  baseCommitSha?: string;
  baselineBuildPassed?: boolean;
  checkpointJournal?: VerifiedCheckpointJournal;
}

export interface ValidationCoordinationResult {
  repairResult: RepairResult;
  auditResult: SecurityAuditResult;
  featureValidation: FeatureValidationResult;
  effectiveValidationCommands: string[];
  stageTransaction: StageExecutionTransaction;
  taskExecutionPlan: TaskExecutionPlan;
  overallGatePassed: boolean;
  rollbackErrorLog: string | null;
  stage8DurationMs: number;
  stage9DurationMs: number;
  isRepositoryClean: boolean;
  isTaskVerified: boolean;
  gateSuccess: boolean;
  isBuildVerified: boolean;
  actionGroupId: string;
  checkpointJournal: readonly ActionGroupJournalEntry[];
  verifiedCheckpoint?: ActionGroupJournalEntry;
}

/** Coordinates existing deterministic validation authorities and their transaction boundary. */
export class ValidationCoordinator {
  /** Bounded production entry point for authenticated controller-local writes. */
  public static async applyLocalActionGroup(input: {
    stageId: string;
    localPath: string;
    authorizedCapabilityScope: AuthorizedCapabilityScope;
    changes: AgentFileChange[];
    journal?: VerifiedCheckpointJournal;
  }): Promise<ActionGroupExecutionResult<readonly AgentFileChange[]>> {
    const mutationTransaction = MutationTransaction.create(input.authorizedCapabilityScope,
      reconcileExecutionManifest(input.authorizedCapabilityScope, null));
    try {
    const transaction = await StageExecutionTransaction.startTransaction(
      input.stageId,
      input.localPath,
      CapabilityGuard.forTransaction(mutationTransaction, mutationTransaction.primary),
      mutationTransaction,
    );
    const group = ActionGroup.create({
      stageId: input.stageId,
      authorizedScopeReference: input.authorizedCapabilityScope.authorityId,
      actions: input.changes,
    });
    const journal = input.journal ?? new VerifiedCheckpointJournal();
    return await ActionGroupExecutor.execute({
      group,
      transaction,
      journal,
      executeActions: async () => {
        await transaction.apply(input.changes);
        return input.changes;
      },
      validate: (changes) => {
        const passed = changes.every((change) => {
          const target = path.resolve(input.localPath, change.path);
          return change.action === "delete" || change.isDeleted
            ? !fs.existsSync(target)
            : fs.existsSync(target) && fs.readFileSync(target, "utf8") === change.content;
        });
        return DeterministicValidationReceipt.issue(
          passed,
          passed ? [] : ["Authenticated local write verification failed"],
        );
      },
    });
    } finally {
      if (mutationTransaction.status !== "COMPLETED") mutationTransaction.abort();
    }
  }

  public static async validate(input: ValidationCoordinationInput): Promise<ValidationCoordinationResult> {
    input.onProgress?.({
      step: 5,
      stageName: "STATIC_VALIDATION",
      label: "Validate & Verify",
      detail: "Running static type validation, import checks, and build verification...",
      badge: "VALIDATING",
      progress: 86,
      log: "[Validate] Running static AST, import checks, and verification...",
      executionContract: input.executionContract,
    });

    const effectiveValidationCommands = ValidationPlanner.detectValidationCommands(
      input.effectiveLocalPath,
      input.effectiveSnapshot,
      input.executionContract,
      {
        monorepo: input.monorepo,
        changedFiles: input.acceptedChanges.map((change) => change.path),
      },
    );
    if (!input.effectiveLocalPath || !input.authorizedCapabilityScope || !input.approvedManifest) {
      throw new MutationFailure("CAPABILITY_MANIFEST_MISMATCH", "Validation requires current capability, workspace and manifest.");
    }
    if (input.authorizedCapabilityScope.repositoryIdBinding !== input.projectId) {
      throw new MutationFailure("WORKSPACE_BINDING_INVALID", "Validation project does not match the authorized repository identity.");
    }
    const mutationTransaction = MutationTransaction.create(input.authorizedCapabilityScope, input.approvedManifest);
    try {
    const stageTransaction = await StageExecutionTransaction.startTransaction(
      input.activeStageId,
      input.effectiveLocalPath,
      CapabilityGuard.forTransaction(mutationTransaction, mutationTransaction.primary),
      mutationTransaction,
    );
    const fsManager = stageTransaction.fsManager;
    const checkpointJournal = input.checkpointJournal ?? new VerifiedCheckpointJournal();
    const actionGroup = ActionGroup.create({
      stageId: input.activeStageId,
      authorizedScopeReference: input.authorizedCapabilityScope?.authorityId ?? "UNAUTHORIZED",
      actions: input.acceptedChanges,
    });
    const groupedChanges = [...actionGroup.proposedChanges()];

    const execution = await ActionGroupExecutor.execute({
      group: actionGroup,
      transaction: stageTransaction,
      journal: checkpointJournal,
      executeActions: async () => {
      const stage8StartedAt = performance.now();
      const repairResult = await SelfHealingEngine.runSelfHealingLoop(
        groupedChanges,
        input.effectiveLocalPath,
        effectiveValidationCommands,
        input.systemPrompt,
        input.requestMessage,
        fsManager,
        input.projectId,
        input.onProgress,
        input.approvedManifest,
        input.executionContract,
        input.baselineDiagnostics,
        input.targetedBaselineDiagnostics,
        input.baseCommitSha,
        input.baselineBuildPassed,
      );

      const stage8DurationMs = performance.now() - stage8StartedAt;

      const stage9StartedAt = performance.now();
      input.onProgress?.({
        step: 9,
        stageName: "SECURITY_AUDIT",
        label: "Security & Reflection Audit",
        detail: "Auditing security constraints and reflection rules",
        color: "text-emerald-400 border-emerald-500/30 bg-emerald-500/10",
        badge: "STAGE 9 · SECURITY",
        progress: 90,
        log: "[Stage 9] Running Reflection & Security Audit...",
        durationMs: 0,
      });

      const preTaskSourceGetter = createPreTaskSourceGetter(
        input.effectiveLocalPath,
        fsManager,
        input.baseCommitSha,
      );
      const baselineSourceGetter = (filePath: string): string | undefined => preTaskSourceGetter(filePath)?.content;
      const auditResult = await SecurityAuditor.runReflectionAndSecurityAudit(
        repairResult.finalChanges,
        baselineSourceGetter,
      );
      const featureValidation = await ValidationDetector.runFeatureValidation(
        repairResult.finalChanges,
        input.effectiveSnapshot,
        input.requestMessage,
        input.executionContract,
      );
      const stage9DurationMs = performance.now() - stage9StartedAt;

      const gateEvaluation = StageVerificationGate.evaluate({
        repairSuccess: Boolean(repairResult.success),
        securityPass: Boolean(auditResult.securityPass),
        featureValidationPassed: Boolean(featureValidation.overallPassed),
        hasBuildErrors: Boolean(!repairResult.success && repairResult.errorLog),
      });
      const overallGatePassed = gateEvaluation.passed;
      if (!overallGatePassed) {
        const rootFailure = repairResult.rootFailure
          ? {
              command: repairResult.rootFailure.command,
              errorType: repairResult.rootFailure.errorType,
              filePath: repairResult.rootFailure.filePath,
              line: repairResult.rootFailure.line,
              column: repairResult.rootFailure.column,
            }
          : null;
        console.warn(
          `[VALIDATION_GATE] stage=${input.activeStageId} passed=false reasons=${JSON.stringify(gateEvaluation.reasons)} ` +
          `repairError=${JSON.stringify(repairResult.errorType ?? null)} rootFailure=${JSON.stringify(rootFailure)} ` +
          `failedChecks=${JSON.stringify(featureValidation.failedChecks ?? [])}`,
        );
      }
      const isRepositoryClean = repairResult.repositoryClean !== undefined
        ? Boolean(repairResult.repositoryClean)
        : Boolean(repairResult.success && !repairResult.errorLog);
      const isTaskVerified = Boolean(repairResult.taskVerified ?? repairResult.success);
      return {
        repairResult,
        auditResult,
        featureValidation,
        effectiveValidationCommands,
        overallGatePassed,
        stage8DurationMs,
        stage9DurationMs,
        isRepositoryClean,
        isTaskVerified,
        gateReasons: gateEvaluation.reasons,
      };
      },
      validate: (value) => DeterministicValidationReceipt.issue(
        value.overallGatePassed,
        value.overallGatePassed ? [] : value.gateReasons,
      ),
    });

    const gateSuccess = execution.journalEntry.status === "VERIFIED";
    const taskExecutionPlan = gateSuccess
      ? TaskExecutionPlanManager.markStageStatus(input.taskExecutionPlan, input.activeStageId, "VERIFIED")
      : TaskExecutionPlanManager.failStage(input.taskExecutionPlan, input.activeStageId);
    return {
      ...execution.value,
      stageTransaction,
      taskExecutionPlan,
      rollbackErrorLog: null,
      gateSuccess,
      isBuildVerified: Boolean(gateSuccess && execution.value.isRepositoryClean),
      actionGroupId: execution.group.id,
      checkpointJournal: checkpointJournal.snapshot(),
      ...(gateSuccess ? { verifiedCheckpoint: execution.journalEntry } : {}),
    };
    } finally {
      if (mutationTransaction.status === "ACTIVE" || mutationTransaction.status === "INVALIDATED") mutationTransaction.abort();
    }
  }
}
