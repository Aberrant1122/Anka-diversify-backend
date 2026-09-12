import fs from "fs";
import path from "path";
import { PrismaClient } from "@prisma/client";
import {
  AgentProgressEvent,
  AgentResponse,
  ChatRequest,
  ExecutionContract,
  ExtendedKnowledgeGraph,
  ProjectContext,
} from "../shared/types";
import { IntentClassifier } from "../classification/IntentClassifier";
import { TaskClassificationResult } from "../classification/TaskTypes";
import {
  FileActionObligation,
  ResolvedTaskTarget,
  TaskExecutionPlan,
  TaskExecutionStage,
} from "../shared/TaskExecutionPlan";
import { TaskExecutionPlanManager } from "../planning/TaskExecutionPlanManager";
import { BaselineDiagnostic, FileManifest } from "../../types";
import { SnapshotFileInput, MonorepoDescriptor } from "../workspace/MonorepoDetector";
import { TaskIntentSpec } from "../shared/TaskIntentSpec";
import { PolicyContract } from "../contracts/PolicyContract";
import { RepositoryEvidenceStore } from "../repository/RepositoryEvidenceStore";
import type { RepositoryContextAssemblyResult } from "./RepositoryObserver";
import { DestructiveTargetResolver } from "../contracts/DestructiveTargetResolver";
import { detectCompoundIntent, buildFinalExecutionContract } from "../contracts/ExecutionContractBuilder";
import { TargetPathExtractor } from "../contracts/TargetPathExtractor";
import { AuthorizedCapabilityScope, CapabilityAction, CapabilityGrant, CapabilityGuard } from "../runtime/CapabilityGuard";
import { MemoryPersistence } from "../memory/MemoryPersistence";
import { ManifestGenerator } from "../generation/ManifestGenerator";
import { getOpenAI } from "../shared/utils";
import { normalizeRepoPath } from "../repository/SemanticContextResolver";
import { BaselineDeltaVerifier } from "../../services/baseline-delta.verifier";
import { TargetScopeExpander } from "../contracts/TargetScopeExpander";
import { EvidenceBoundWriteSetResolver, PlannedChange } from "../contracts/EvidenceBoundWriteSetResolver";
import { ManifestValidator } from "../../services/manifest-validator";
import { ManifestCorrectionEngine } from "../planning/ManifestCorrectionEngine";
import { detectRepositoryArchitecture } from "../planning/RepositoryArchitectureDetector";
import { TaskDecomposer } from "../generation/TaskDecomposer";

const prisma = new PrismaClient();

export interface AgentPlanningInput {
  request: ChatRequest;
  projectContext: ProjectContext;
  canonicalExistingFiles: string[];
}

interface AgentPlanningResultBase {
  clarificationData: ReturnType<typeof TaskExecutionPlanManager.parseClarificationInput>;
  effectiveMessageForIntent: string;
  intentResult: TaskClassificationResult;
  explicitUserPaths: string[];
  stageDependencyViolation: boolean;
  failedOrPendingDependencies: string[];
  dependentStagesSkipped: string[];
  durationMs: number;
}

export interface AgentPlanningFailure extends AgentPlanningResultBase {
  status: "FAILED";
  taskExecutionPlan: null;
  activeStage: null;
}

export interface AgentPlanningReady extends AgentPlanningResultBase {
  status: "READY";
  taskExecutionPlan: TaskExecutionPlan;
  activeStage: TaskExecutionStage;
}

export type AgentPlanningResult = AgentPlanningFailure | AgentPlanningReady;

export interface AgentManifestPlanningInput {
  projectId: string;
  sessionId: string;
  request: ChatRequest;
  projectContext: ProjectContext;
  canonicalExistingFiles: string[];
  rawSnapshotFiles: SnapshotFileInput[];
  pipelineSnapshotFiles: SnapshotFileInput[];
  optimizedContext: RepositoryContextAssemblyResult["optimizedContext"];
  monorepo: MonorepoDescriptor;
  effectiveLocalPath: string | null;
  diagnosticTargetPaths: string[];
  baselineDiagnosticsList: BaselineDiagnostic[];
  activeStage: TaskExecutionStage;
  taskIntentSpec: TaskIntentSpec;
  intentResult: TaskClassificationResult;
  executionContract: ExecutionContract;
  evidenceStore: RepositoryEvidenceStore;
  effectiveGoal: string;
  policyContract: PolicyContract;
  knowledgeGraph: ExtendedKnowledgeGraph;
  clarificationData: ReturnType<typeof TaskExecutionPlanManager.parseClarificationInput>;
  finalConfidence: number;
  onProgress?: (event: AgentProgressEvent) => void;
  authorizedCapabilityScope?: AuthorizedCapabilityScope;
  baseCommitSha?: string;
}

export interface AgentManifestPlanningSuccess {
  planningComplete: true;
  approvedManifest: FileManifest | null;
  executionContract: ExecutionContract;
  authorizedCapabilityScope?: AuthorizedCapabilityScope;
  durationMs: number;
}

export type AgentManifestPlanningResult = AgentManifestPlanningSuccess | AgentResponse;

/** Produces the current typed execution plan; it performs no provider calls directly. */
export class AgentPlanner {
  public static async plan(input: AgentPlanningInput): Promise<AgentPlanningResult> {
    const startedAt = performance.now();
    const clarificationData = TaskExecutionPlanManager.parseClarificationInput(input.request.message);
    const effectiveMessageForIntent = clarificationData?.initialRequest || input.request.message;
    const intentResult = await IntentClassifier.classifyIntentAndAmbiguity(
      effectiveMessageForIntent,
      input.projectContext,
      input.canonicalExistingFiles,
    );
    const durationMs = performance.now() - startedAt;

    if (intentResult.outcome === "TECHNICAL_FAILURE" || intentResult.intent === "CLASSIFICATION_FAILED") {
      return {
        status: "FAILED",
        clarificationData,
        effectiveMessageForIntent,
        intentResult,
        explicitUserPaths: [],
        stageDependencyViolation: false,
        taskExecutionPlan: null,
        activeStage: null,
        failedOrPendingDependencies: [],
        dependentStagesSkipped: [],
        durationMs,
      };
    }

    // Do NOT alias model-derived classification target into explicitUserPaths.
    // explicitUserPaths must be derived strictly and deterministically from user input.
    const explicitUserPaths = TargetPathExtractor.extractExplicitUserPaths(
      effectiveMessageForIntent,
      input.canonicalExistingFiles,
    );
    const requestContext = input.request.context as { taskExecutionPlan?: TaskExecutionPlan } | undefined;
    let taskExecutionPlan = requestContext?.taskExecutionPlan || TaskExecutionPlanManager.createTaskExecutionPlan(
      effectiveMessageForIntent,
      intentResult,
      explicitUserPaths,
    );

    if (clarificationData && clarificationData.clarificationQas.length > 0) {
      const latestQa = clarificationData.clarificationQas[clarificationData.clarificationQas.length - 1];
      taskExecutionPlan = await TaskExecutionPlanManager.reorderPlanWithClarification(
        taskExecutionPlan,
        latestQa.answer,
        latestQa.question,
      );
    }

    const activeStage = taskExecutionPlan.stages[taskExecutionPlan.currentStageIndex] || taskExecutionPlan.stages[0];
    const isStageEligible = TaskExecutionPlanManager.isStageEligible(taskExecutionPlan, activeStage.id);
    const stageDependencyViolation = !isStageEligible && activeStage.status !== "RUNNING";
    const failedOrPendingDependencies = stageDependencyViolation
      ? (activeStage.dependsOn || []).filter((dependencyId) => {
          const dependency = taskExecutionPlan.stages.find((stage) => stage.id === dependencyId);
          return !dependency || dependency.status !== "VERIFIED";
        })
      : [];
    const dependentStagesSkipped = stageDependencyViolation
      ? TaskExecutionPlanManager.getDependentStages(taskExecutionPlan, activeStage.id)
      : [];

    if (!stageDependencyViolation) {
      activeStage.status = "RUNNING";
    }

    return {
      status: "READY",
      clarificationData,
      effectiveMessageForIntent,
      intentResult,
      explicitUserPaths,
      stageDependencyViolation,
      taskExecutionPlan,
      activeStage,
      failedOrPendingDependencies,
      dependentStagesSkipped,
      durationMs,
    };
  }
  /** Plans, corrects, structurally validates, and records an advisory manifest. */
  public static async planManifest(
    input: AgentManifestPlanningInput,
  ): Promise<AgentManifestPlanningResult> {
    const {
      projectId,
      sessionId,
      request,
      projectContext,
      canonicalExistingFiles,
      rawSnapshotFiles,
      pipelineSnapshotFiles,
      optimizedContext,
      monorepo,
      effectiveLocalPath,
      diagnosticTargetPaths,
      baselineDiagnosticsList,
      activeStage,
      taskIntentSpec,
      intentResult,
      evidenceStore,
      effectiveGoal,
      policyContract,
      knowledgeGraph,
      clarificationData,
      finalConfidence,
      onProgress,
    } = input;
    let executionContract = input.executionContract;
    let activeCapabilityScope = input.authorizedCapabilityScope;
    const session = { id: sessionId };
    // Stage 6: Advisory Manifest Generation & Planning Validation
    const s6Start = performance.now();
    let approvedManifest: FileManifest | null = null;
    let manifestGenerationError: string | null = null;
    const manifestEnabled = process.env.ENABLE_MANIFEST_ENFORCEMENT !== "false";

    if (manifestEnabled) {
      // Extract package.json content if available in snapshot
      let packageJsonContent: string | undefined;
      const pkgFile = rawSnapshotFiles.find((f: any) => f?.path === "package.json" || f?.path?.endsWith("/package.json"));
      if (pkgFile && typeof pkgFile.content === "string") {
        packageJsonContent = pkgFile.content;
      }

      const architectureSummary = detectRepositoryArchitecture(canonicalExistingFiles, packageJsonContent, monorepo);

      // Select top bounded relevant files for manifest planning
      const relevantPlanningFiles: Array<{ path: string; content: string }> = [];
      if (optimizedContext?.fileContext) {
        for (const [filePath, content] of Object.entries(optimizedContext.fileContext)) {
          if (typeof content === "string" && content.trim().length > 0) {
            relevantPlanningFiles.push({ path: filePath, content });
          }
        }
      }
      for (const snapFile of rawSnapshotFiles) {
        if (snapFile?.path && typeof snapFile?.content === "string") {
          const normPath = snapFile.path.replace(/\\/g, "/").replace(/^\.\//, "");
          if (
            (normPath === "package.json" || architectureSummary.existingEntryPoints.includes(normPath)) &&
            !relevantPlanningFiles.some((rf) => rf.path === normPath)
          ) {
            relevantPlanningFiles.push({ path: normPath, content: snapFile.content });
          }
        }
      }

      // Check effective local path for existing query-relevant components (e.g. Calculator)
      if (effectiveLocalPath && fs.existsSync(effectiveLocalPath)) {
        const queryTerms = request.message.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
        for (const f of canonicalExistingFiles) {
          const norm = f.replace(/\\/g, "/").replace(/^\.\//, "");
          const isQueryRelevant = queryTerms.some((term) => norm.toLowerCase().includes(term));
          const isEntry = architectureSummary.existingEntryPoints.includes(norm);
          if ((isQueryRelevant || isEntry) && !relevantPlanningFiles.some((rf) => rf.path === norm)) {
            const abs = path.join(effectiveLocalPath, norm);
            if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
              try {
                const content = fs.readFileSync(abs, "utf8");
                relevantPlanningFiles.push({ path: norm, content });
              } catch { }
            }
          }
        }
      }

      // Ensure diagnostic target files are prioritized at the top of relevantPlanningFiles
      if (diagnosticTargetPaths.length > 0) {
        for (const diagPath of diagnosticTargetPaths) {
          const existingIdx = relevantPlanningFiles.findIndex((rf) => rf.path === diagPath);
          if (existingIdx >= 0) {
            const [item] = relevantPlanningFiles.splice(existingIdx, 1);
            relevantPlanningFiles.unshift(item);
          } else {
            const snap = rawSnapshotFiles.find((f: any) => f?.path?.replace(/\\/g, "/").replace(/^\.\//, "") === diagPath);
            if (snap && typeof snap.content === "string") {
              relevantPlanningFiles.unshift({ path: diagPath, content: snap.content });
            } else if (effectiveLocalPath) {
              const abs = path.join(effectiveLocalPath, diagPath);
              if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
                try {
                  relevantPlanningFiles.unshift({ path: diagPath, content: fs.readFileSync(abs, "utf8") });
                } catch { }
              }
            }
          }
        }
      }

      // Deterministic feature resolution and evidence hydration before manifest planning
      const compound = detectCompoundIntent(request.message);
      const isDestructiveStage =
        activeStage.intent.destructive ||
        taskIntentSpec.destructive ||
        intentResult.taskType === "DELETE_FOLDER" ||
        intentResult.taskType === "DELETE_FILE" ||
        intentResult.intent === "DELETE_FOLDER" ||
        intentResult.intent === "DELETE_FILE" ||
        activeStage.intent.taskType === "DELETE_FOLDER" ||
        activeStage.intent.taskType === "DELETE_FILE" ||
        compound.hasDeletion ||
        (Array.isArray(executionContract.allowedActions) &&
          (executionContract.allowedActions.includes("delete_file") ||
            executionContract.allowedActions.includes("delete_folder")));

      let resolvedTaskTarget: ResolvedTaskTarget | undefined =
        activeStage.resolvedTarget || taskIntentSpec.resolvedTarget;

      if (isDestructiveStage) {
        const resolution = DestructiveTargetResolver.resolve(
          effectiveGoal,
          canonicalExistingFiles,
          {
            isDestructive: true,
            taskType: activeStage.intent.taskType,
            targetPath: activeStage.intent.explicitUserPaths?.[0] || executionContract.targetPaths[0],
            evidenceStore,
            repositoryId: projectId,
            fileContext: optimizedContext?.fileContext,
            snapshotFiles: pipelineSnapshotFiles,
            localPath: effectiveLocalPath,
            monorepo,
            knowledgeGraph,
            selectedLogicalTarget: clarificationData?.clarificationQas[clarificationData.clarificationQas.length - 1]?.answer,
          }
        );

        if (resolution.status === "RESOLVED" && resolution.resolvedTarget) {
          resolvedTaskTarget = resolution.resolvedTarget;
          activeStage.resolvedTarget = resolvedTaskTarget;
          taskIntentSpec.resolvedTarget = resolvedTaskTarget;
          activeStage.actionObligations = resolvedTaskTarget.actionObligations;
          executionContract.actionObligations = resolvedTaskTarget.actionObligations;

          const newTargetPaths = Array.from(
            new Set([
              ...executionContract.targetPaths,
              ...resolvedTaskTarget.candidatePaths,
              ...resolvedTaskTarget.importerPaths,
            ])
          );
          executionContract.targetPaths = newTargetPaths;

          if (!executionContract.targetProvenance) {
            executionContract.targetProvenance = {};
          }
          for (const p of resolvedTaskTarget.candidatePaths) {
            executionContract.targetProvenance[p] =
              resolvedTaskTarget.resolutionSource === "EXPLICIT_PATH"
                ? "EXPLICIT_USER_PATH"
                : "UNIQUE_NAMED_ENTITY";
          }
          for (const imp of resolvedTaskTarget.importerPaths) {
            executionContract.targetProvenance[imp] = "DETERMINISTIC_REFERENCE_CLEANUP";
          }

          executionContract.searchScope = Array.from(
            new Set([...executionContract.searchScope, ...newTargetPaths])
          );
        } else if (resolution.status === "AMBIGUOUS") {
          const failureExplanation = `[Target Ambiguous] ${resolution.reason}`;
          await MemoryPersistence.saveMessage(session.id, "assistant", failureExplanation);
          return {
            explanation: failureExplanation,
            changes: [],
            commitMessage: "",
            sessionId: session.id,
            intent: intentResult.intent,
            taskType: intentResult.taskType,
            risk: intentResult.risk,
            estimatedComplexity: intentResult.estimatedComplexity,
            targetPath: intentResult.targetPath,
            confidence: intentResult.confidence,
            buildVerified: false,
            buildErrors: failureExplanation,
            lifecycleStage: "TargetAmbiguous",
            errorCode: "TARGET_AMBIGUOUS",
          };
        } else if (resolution.status === "NOT_FOUND" || resolution.targetCertainty === "NONEXISTENT") {
          const failureExplanation = `[Insufficient Repository Evidence] ${resolution.reason}`;
          await MemoryPersistence.saveMessage(session.id, "assistant", failureExplanation);
          return {
            explanation: failureExplanation,
            changes: [],
            commitMessage: "",
            sessionId: session.id,
            intent: intentResult.intent,
            taskType: intentResult.taskType,
            risk: intentResult.risk,
            estimatedComplexity: intentResult.estimatedComplexity,
            targetPath: intentResult.targetPath,
            confidence: intentResult.confidence,
            buildVerified: false,
            buildErrors: failureExplanation,
            lifecycleStage: "InsufficientRepositoryEvidence",
            errorCode: "INSUFFICIENT_REPOSITORY_EVIDENCE",
          };
        }
      }

      const planningContext = {
        ...projectContext,
        existingFiles: canonicalExistingFiles,
        architecture: architectureSummary,
        relevantFiles: relevantPlanningFiles.slice(0, 8),
        baselineDiagnostics: baselineDiagnosticsList,
        monorepo,
        evidenceStore,
        resolvedTarget: resolvedTaskTarget,
        actionObligations: executionContract.actionObligations || resolvedTaskTarget?.actionObligations,
      };

      onProgress?.({
        step: 3,
        stageName: "MANIFEST_PLANNING",
        label: "Plan File Actions",
        detail: "Formulating advisory file action plan (create / modify / delete)...",
        badge: "PLANNING",
        progress: 58,
        log: "[Plan] Formulating advisory file manifest...",
        executionContract,
      });

      // 1. Advisory FileManifest generation for planning and provenance
      let rawManifest: FileManifest | null = null;
      try {
        const generator = new ManifestGenerator(getOpenAI());
        rawManifest = await generator.generateManifest(effectiveGoal, planningContext, executionContract);
      } catch (e: any) {
        manifestGenerationError = e?.message || String(e);
        console.error("[AgentPipeline] Manifest generation error:", manifestGenerationError);
      }

      if (rawManifest && Array.isArray(rawManifest.files)) {
        const obligations: FileActionObligation[] =
          executionContract.actionObligations || planningContext.actionObligations || [];

        if (obligations.length > 0) {
          const checkManifestActionMismatches = (
            manifest: FileManifest
          ): Array<{ path: string; expected: string; actual: string }> => {
            const mismatches: Array<{ path: string; expected: string; actual: string }> = [];
            const obMap = new Map<string, FileActionObligation>();
            for (const ob of obligations) {
              obMap.set(normalizeRepoPath(ob.path), ob);
            }
            for (const f of manifest.files || []) {
              const norm = normalizeRepoPath(f.path);
              const ob = obMap.get(norm);
              if (ob && f.action !== ob.requiredAction) {
                mismatches.push({ path: f.path, expected: ob.requiredAction, actual: f.action });
              }
            }
            return mismatches;
          };

          let actionMismatches = checkManifestActionMismatches(rawManifest);

          if (actionMismatches.length > 0) {
            console.warn(
              `[AgentPipeline] Manifest action contract violation: ${actionMismatches.map((m) => `${m.path} (expected ${m.expected}, got ${m.actual})`).join(", ")}. Triggering bounded manifest correction (Attempt 1/1)...`
            );

            try {
              const generator = new ManifestGenerator(getOpenAI());
              const correctionNote =
                `\n[MANIFEST_ACTION_MISMATCH] Corrective Mandate:\n` +
                actionMismatches
                  .map(
                    (m) =>
                      `File "${m.path}" was planned with action "${m.actual}", but required action is "${m.expected}".`
                  )
                  .join("\n") +
                `\nYou MUST emit EXACTLY the required actions without modifying action types.`;
              const correctedGoal = `${effectiveGoal}\n${correctionNote}`;
              const retryManifest = await generator.generateManifest(
                correctedGoal,
                planningContext,
                executionContract
              );
              if (retryManifest && Array.isArray(retryManifest.files)) {
                const retryMismatches = checkManifestActionMismatches(retryManifest);
                if (retryMismatches.length === 0) {
                  console.log("[AgentPipeline] Bounded manifest action correction succeeded.");
                  rawManifest = retryManifest;
                  actionMismatches = [];
                } else {
                  actionMismatches = retryMismatches;
                }
              }
            } catch (retryErr: any) {
              console.warn(
                "[AgentPipeline] Bounded manifest correction error:",
                retryErr?.message || retryErr
              );
            }

            if (actionMismatches.length > 0) {
              const mismatchDetails = actionMismatches
                .map(
                  (m) =>
                    `• ${m.path}: manifest declared action "${m.actual}", but required action is "${m.expected}"`
                )
                .join("\n");
              const failureExplanation = `[Planning Contract Mismatch] Manifest action request conflicts with deterministic task action obligations:\n${mismatchDetails}`;
              await MemoryPersistence.saveMessage(session.id, "assistant", failureExplanation);

              return {
                explanation: failureExplanation,
                changes: [],
                commitMessage: "",
                sessionId: session.id,
                intent: intentResult.intent,
                taskType: intentResult.taskType,
                risk: intentResult.risk,
                estimatedComplexity: intentResult.estimatedComplexity,
                targetPath: intentResult.targetPath,
                confidence: finalConfidence,
                buildVerified: false,
                buildErrors: failureExplanation,
                lifecycleStage: "ManifestActionMismatch",
                errorCode: "PLANNING_MANIFEST_ACTION_MISMATCH",
              };
            }
          }
        }
      }

      if (rawManifest) {
        // Evidence-backed target path expansion for BROAD build repair tasks only
        const isBroadRepair = BaselineDeltaVerifier.isBroadBuildRepairTask(request.message, executionContract);
        if (isBroadRepair && Array.isArray(rawManifest.files)) {
          const candidatePaths = rawManifest.files.map((f) => f.path).filter(Boolean);
          const expansionResult = TargetScopeExpander.expandBroadRepairTargetPaths({
            contract: executionContract,
            candidatePaths,
            knowledgeGraph,
            snapshotFiles: rawSnapshotFiles,
            localPath: effectiveLocalPath,
            fileContext: optimizedContext?.fileContext,
            baselineDiagnostics: baselineDiagnosticsList,
            monorepo,
          });

          if (expansionResult.approvedExpansions.length > 0) {
            executionContract.targetPaths = expansionResult.expandedTargetPaths;
            executionContract.searchScope = Array.from(
              new Set([...executionContract.searchScope, ...expansionResult.expandedTargetPaths])
            );
          }
          if (expansionResult.rejectedCandidates.length > 0) {
            const rejectedPaths = new Set(
              expansionResult.rejectedCandidates.map((candidate) =>
                normalizeRepoPath(candidate.path)
              )
            );

            const reconciledFiles = rawManifest.files.filter(
              (file) => !rejectedPaths.has(normalizeRepoPath(file.path))
            );

            const removedCount = rawManifest.files.length - reconciledFiles.length;

            if (removedCount > 0) {
              console.log(
                `[MANIFEST_RECONCILE] mode=BROAD_BUILD_REPAIR removed=${removedCount} remaining=${reconciledFiles.length}`
              );

              rawManifest = {
                ...rawManifest,
                files: reconciledFiles,
                totalFiles: reconciledFiles.length,
              };
            }
          }
        }

        // Supporting reverse-reference cleanup expansion for grounded DELETE targets (Fix 2)
        const compound = detectCompoundIntent(request.message);
        const isDestructiveOrDeletion =
          intentResult.taskType === "DELETE_FOLDER" ||
          intentResult.taskType === "DELETE_FILE" ||
          intentResult.intent === "DELETE_FOLDER" ||
          intentResult.intent === "DELETE_FILE" ||
          compound.hasDeletion;

        if (isDestructiveOrDeletion && Array.isArray(rawManifest.files)) {
          const cleanupResult = TargetScopeExpander.expandReverseReferenceCleanupTargets({
            contract: executionContract,
            manifestFiles: rawManifest.files,
            knowledgeGraph,
            snapshotFiles: rawSnapshotFiles,
            localPath: effectiveLocalPath,
            fileContext: optimizedContext?.fileContext,
            monorepo,
          });

          if (cleanupResult.approvedExpansions.length > 0) {
            const newApprovedPaths = cleanupResult.approvedExpansions.map((e) => e.path);
            executionContract.targetPaths = Array.from(
              new Set([...executionContract.targetPaths, ...newApprovedPaths])
            );
            if (!executionContract.targetProvenance) {
              executionContract.targetProvenance = {};
            }
            for (const exp of cleanupResult.approvedExpansions) {
              executionContract.targetProvenance[exp.path] = "DETERMINISTIC_REFERENCE_CLEANUP";
            }
            executionContract.searchScope = Array.from(
              new Set([...executionContract.searchScope, ...executionContract.targetPaths])
            );
          }
        }

        // Bounded direct UI neighbor expansion for directly imported sibling styles and child components (Fix 7)
        const isUI = executionContract.environment === "REACT_TS" || (executionContract.environment as string) === "HTML_CSS_JS";
        const isNonDestructive =
          executionContract.taskType !== "DELETE_FOLDER" &&
          executionContract.taskType !== "DELETE_FILE" &&
          !compound.hasDeletion;

        if (isUI && isNonDestructive && Array.isArray(rawManifest.files)) {
          const uiNeighborResult = TargetScopeExpander.expandDirectUIReferences({
            contract: executionContract,
            manifestFiles: rawManifest.files,
            fileContext: optimizedContext?.fileContext,
            snapshotFiles: rawSnapshotFiles,
            localPath: effectiveLocalPath,
            monorepo,
          });

          if (uiNeighborResult.approvedExpansions.length > 0) {
            const newApprovedPaths = uiNeighborResult.approvedExpansions.map((e) => e.path);
            executionContract.targetPaths = Array.from(
              new Set([...executionContract.targetPaths, ...newApprovedPaths])
            );
            if (!executionContract.targetProvenance) {
              executionContract.targetProvenance = {};
            }
            for (const exp of uiNeighborResult.approvedExpansions) {
              executionContract.targetProvenance[exp.path] = "DETERMINISTIC_ARCHITECTURE_DEPENDENCY";
            }
            executionContract.searchScope = Array.from(
              new Set([...executionContract.searchScope, ...executionContract.targetPaths])
            );
          }
        }

        // Ground manifest requests in deterministic repository evidence. This
        // selects planning candidates and never grants a capability.
        const proposedPlannedChanges: PlannedChange[] = (rawManifest.files || []).map((f) => {
          return {
            path: f.path,
            action: f.action,
            reason: f.description || `Proposed ${f.action} for ${f.path}`,
            evidenceIds: Array.isArray(f.evidenceIds) ? f.evidenceIds : [],
            dependencies: f.dependencies || [],
          };
        });

        const effectiveRevision = input.baseCommitSha || (input.projectContext?.repoSnapshot as any)?.revision?.contentHash;
        const planningEvidenceResult = EvidenceBoundWriteSetResolver.resolve({
          policy: policyContract,
          intentSpec: taskIntentSpec,
          proposedChanges: proposedPlannedChanges,
          evidenceStore,
          existingFiles: canonicalExistingFiles,
          monorepo,
          targetRepositoryId: projectId,
          workspaceRoot: effectiveLocalPath || undefined,
          baseRevision: effectiveRevision,
          stageId: activeStage.id,
          runId: input.authorizedCapabilityScope?.runId,
        });

        // Blocker 5 fail-closed: If proposed changes exist but none were approved by evidence authority,
        // targetPaths MUST be [] and pipeline returns a controlled planning failure immediately.
        if (proposedPlannedChanges.length > 0 && planningEvidenceResult.approvedPaths.length === 0) {
          const rejectedReasons = planningEvidenceResult.rejectedPaths
            .map((r) => `• ${r.path}: ${r.reason}`)
            .join("\n");
          const failureExplanation = `[Planning Scope Rejected] Manifest requests lacked required deterministic planning evidence:\n${rejectedReasons}`;
          await MemoryPersistence.saveMessage(session.id, "assistant", failureExplanation);

          return {
            explanation: failureExplanation,
            changes: [],
            commitMessage: "",
            sessionId: session.id,
            intent: intentResult.intent,
            taskType: intentResult.taskType,
            risk: intentResult.risk,
            estimatedComplexity: intentResult.estimatedComplexity,
            targetPath: intentResult.targetPath,
            confidence: finalConfidence,
            buildVerified: false,
            buildErrors: failureExplanation,
            lifecycleStage: "ManifestValidationFailed",
            errorCode: "PLANNING_SCOPE_REJECTED",
          };
        }

        if (input.authorizedCapabilityScope && planningEvidenceResult.evidenceAuthorization) {
          const derived = input.authorizedCapabilityScope.deriveExecutionScope(
            planningEvidenceResult.evidenceAuthorization,
            {
              stageId: activeStage.id,
              workspaceRoot: effectiveLocalPath || undefined,
              baseRevision: effectiveRevision,
            }
          );
          if (derived) {
            activeCapabilityScope = derived;
          }
        }

        const groundedPlanningPaths = Array.from(new Set([
          ...executionContract.targetPaths,
          ...planningEvidenceResult.approvedPaths,
        ].map(normalizeRepoPath).filter(Boolean)));
        executionContract = buildFinalExecutionContract(
          policyContract,
          groundedPlanningPaths,
          canonicalExistingFiles,
          executionContract.actionObligations
        );

        // Construct a coherent evidence-grounded planning manifest.
        const approvedSet = new Set(planningEvidenceResult.approvedPaths.map(normalizeRepoPath));
        const coherentFiles = (rawManifest.files || []).filter((f) => approvedSet.has(normalizeRepoPath(f.path)));
        const coherentPlanningManifest: FileManifest = {
          files: coherentFiles,
          totalFiles: coherentFiles.length,
          manifestVersion: rawManifest.manifestVersion || "1.0.0",
        };

        const validator = new ManifestValidator(executionContract, {
          existingFiles: canonicalExistingFiles,
          installedPackages: architectureSummary.installedPackages,
          packageVersions: architectureSummary.packageVersions,
          monorepo,
        });
        let valRes = validator.validate(coherentPlanningManifest);

        try {
          await prisma.agentManifest.create({
            data: {
              projectId,
              sessionId: session.id,
              manifestJson: coherentPlanningManifest as any,
              validationStatus: valRes.valid ? "approved" : "rejected",
              validationErrors: valRes.errors as any,
            },
          });
        } catch (manifestSaveErr: any) {
          console.warn("[AgentPipeline] Failed to save initial manifest:", manifestSaveErr?.message || manifestSaveErr);
        }

        if (valRes.valid) {
          approvedManifest = coherentPlanningManifest;
        } else {
          console.warn("[AgentPipeline] Initial manifest validation failed. Attempting 1 bounded correction...");
          try {
            const correctedManifest = await ManifestCorrectionEngine.attemptCorrection(
              coherentPlanningManifest,
              valRes.errors,
              request.message,
              planningContext,
              executionContract,
              getOpenAI()
            );

            if (correctedManifest) {
              const reValRes = validator.validate(correctedManifest);
              await prisma.agentManifest.create({
                data: {
                  projectId,
                  sessionId: session.id,
                  manifestJson: correctedManifest as any,
                  validationStatus: reValRes.valid ? "approved" : "rejected",
                  validationErrors: reValRes.errors as any,
                },
              });

              if (reValRes.valid) {
                approvedManifest = correctedManifest;
              } else {
                valRes = reValRes;
              }
            }
          } catch (corrErr: any) {
            console.warn("[AgentPipeline] Manifest correction exception:", corrErr?.message || corrErr);
          }

          if (!approvedManifest) {
            const errorDetails = valRes.errors.map((e) => `• [${e.type}] ${e.message} (${e.suggestion})`).join("\n");
            const failureExplanation = `[Manifest Validation Failed] The planned file manifest violated execution contract constraints:\n${errorDetails}`;
            await MemoryPersistence.saveMessage(session.id, "assistant", failureExplanation);

            return {
              explanation: failureExplanation,
              changes: [],
              commitMessage: "",
              sessionId: session.id,
              intent: intentResult.intent,
              taskType: intentResult.taskType,
              risk: intentResult.risk,
              estimatedComplexity: intentResult.estimatedComplexity,
              targetPath: intentResult.targetPath,
              confidence: finalConfidence,
              buildVerified: false,
              buildErrors: failureExplanation,
              lifecycleStage: "ManifestValidationFailed",
            };
          }
        }
      }

      if (approvedManifest && Array.isArray(approvedManifest.files)) {
        const fileListStr = approvedManifest.files.map((f) => `${f.action.toUpperCase()} ${f.path}`).join(", ");
        onProgress?.({
          step: 3,
          stageName: "MANIFEST_APPROVED",
          label: "Plan File Actions",
          detail: `Approved plan: ${approvedManifest.files.length} file(s) [${fileListStr}]`,
          badge: `PLAN · ${approvedManifest.files.length} FILES`,
          progress: 68,
          log: `[Plan] Validated planning manifest: ${fileListStr}`,
          executionContract,
        });
      }

      // 2. Optional advisory decomposition for LARGE/COMPLEX NEW_FEATURE tasks
      const shouldDecompose =
        intentResult.taskType === "NEW_FEATURE" &&
        (intentResult.estimatedComplexity === "LARGE" || intentResult.estimatedComplexity === "COMPLEX");

      if (shouldDecompose) {
        try {
          const decomposer = new TaskDecomposer(getOpenAI());
          const graph = await decomposer.decomposeTask(request.message, planningContext, intentResult);

          await prisma.taskDecomposition.create({
            data: {
              projectId,
              sessionId: session.id,
              userRequest: request.message,
              graphJson: graph as any,
              totalSubTasks: graph.nodes.length,
              status: "completed",
            },
          });
          // Advisory decomposition and manifest remain mutable planning artifacts.
        } catch (e: any) {
          console.warn("[AgentPipeline] Advisory task decomposition error (non-blocking):", e?.message || e);
        }
      }
    }
    const s6Time = performance.now() - s6Start;

    if (manifestEnabled && !approvedManifest && manifestGenerationError) {
      console.info(`[MANIFEST_AUDIT] Planning manifest unavailable; continuing from trusted task, repository, and capability facts: ${manifestGenerationError}`);
    }

    return {
      planningComplete: true,
      approvedManifest,
      executionContract,
      authorizedCapabilityScope: activeCapabilityScope,
      durationMs: s6Time,
    };
  }
}
