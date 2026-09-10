import { AgentFileChange, AgentProgressEvent, ExecutionContract, FeatureValidationResult, FileManifest } from "../shared/types";
import { BaselineDiagnostic } from "../../types";
import { BuildErrorRepair } from "../repair/BuildErrorRepair";
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

type RepairResult = Awaited<ReturnType<typeof SelfHealingEngine.runSelfHealingLoop>>;

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
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createExecutionCapabilityGuard(input: ValidationCoordinationInput): CapabilityGuard {
  if (!input.effectiveLocalPath || !input.authorizedCapabilityScope) return CapabilityGuard.denyAll();
  return CapabilityGuard.create({
    workspaceRoot: input.effectiveLocalPath,
    scopeId: input.activeStageId,
    authorizedScope: input.authorizedCapabilityScope,
  });
}

/** Coordinates existing deterministic validation authorities and their transaction boundary. */
export class ValidationCoordinator {
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
    const stageTransaction = await StageExecutionTransaction.startTransaction(
      input.activeStageId,
      input.effectiveLocalPath,
      createExecutionCapabilityGuard(input),
    );
    const fsManager = stageTransaction.fsManager;
    let transactionCommitted = false;
    let transactionRolledBack = false;
    let rollbackErrorLog: string | null = null;

    if (input.effectiveLocalPath) {
      await fsManager.snapshot(input.acceptedChanges, input.effectiveLocalPath);
    }

    const safeRollback = async (): Promise<void> => {
      if (transactionCommitted || transactionRolledBack || !input.effectiveLocalPath) return;
      transactionRolledBack = true;
      try {
        await stageTransaction.rollback();
      } catch (error: unknown) {
        rollbackErrorLog = `[CRITICAL] Filesystem rollback failed: ${errorMessage(error)}`;
        console.error(rollbackErrorLog, error);
      }
    };

    let taskExecutionPlan = input.taskExecutionPlan;
    try {
      const stage8StartedAt = performance.now();
      const repairResult = await SelfHealingEngine.runSelfHealingLoop(
        input.acceptedChanges,
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

      if (!repairResult.success && !repairResult.infrastructureError && input.effectiveLocalPath && effectiveValidationCommands.length > 0) {
        const buildRepairResult = await BuildErrorRepair.runBuildErrorRepairPass(
          repairResult.finalChanges,
          input.effectiveLocalPath,
          effectiveValidationCommands,
          input.requestMessage,
          repairResult.errorLog || "",
          fsManager,
          input.executionContract,
        );
        repairResult.finalChanges = buildRepairResult.finalChanges;
        repairResult.errorLog = buildRepairResult.success ? "" : buildRepairResult.errorLog;
        if (buildRepairResult.success) repairResult.success = true;
      }
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

      const overallGatePassed = StageVerificationGate.evaluate({
        repairSuccess: Boolean(repairResult.success),
        securityPass: Boolean(auditResult.securityPass),
        featureValidationPassed: Boolean(featureValidation.overallPassed),
        hasBuildErrors: Boolean(!repairResult.success && repairResult.errorLog),
      }).passed;

      if (overallGatePassed) {
        transactionCommitted = true;
        await stageTransaction.commit();
        taskExecutionPlan = TaskExecutionPlanManager.markStageStatus(taskExecutionPlan, input.activeStageId, "VERIFIED");
      } else {
        await safeRollback();
        taskExecutionPlan = TaskExecutionPlanManager.failStage(taskExecutionPlan, input.activeStageId);
      }

      const isRepositoryClean = repairResult.repositoryClean !== undefined
        ? Boolean(repairResult.repositoryClean)
        : Boolean(repairResult.success && !repairResult.errorLog);
      const isTaskVerified = Boolean(repairResult.taskVerified ?? repairResult.success);
      const gateSuccess = overallGatePassed && !rollbackErrorLog;

      return {
        repairResult,
        auditResult,
        featureValidation,
        effectiveValidationCommands,
        stageTransaction,
        taskExecutionPlan,
        overallGatePassed,
        rollbackErrorLog,
        stage8DurationMs,
        stage9DurationMs,
        isRepositoryClean,
        isTaskVerified,
        gateSuccess,
        isBuildVerified: Boolean(gateSuccess && isRepositoryClean),
      };
    } catch (error: unknown) {
      await safeRollback();
      TaskExecutionPlanManager.failStage(taskExecutionPlan, input.activeStageId);
      throw error;
    }
  }
}
