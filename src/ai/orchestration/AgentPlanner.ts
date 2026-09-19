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
  PriorVerifiedTarget,
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
import { matchesModuleSpecifier, TargetScopeExpander } from "../contracts/TargetScopeExpander";
import { EvidenceBoundWriteSetResolver, PlannedChange } from "../contracts/EvidenceBoundWriteSetResolver";
import { ManifestValidator } from "../../services/manifest-validator";
import { ManifestCorrectionEngine } from "../planning/ManifestCorrectionEngine";
import { detectRepositoryArchitecture } from "../planning/RepositoryArchitectureDetector";
import { TaskDecomposer } from "../generation/TaskDecomposer";
import { DeterministicRelationEvidenceAcquirer } from "../contracts/DeterministicRelationEvidenceAcquirer";
import { authoritySnapshot } from "../repository/AuthorityWorktree";

const prisma = new PrismaClient();

/**
 * Converts model planning fields into resolver input by replacing every
 * evidenceIds value with current, backend-authenticated evidence. Legacy model
 * IDs are never read, so they cannot grant, deny, or poison authorization.
 */
export function bindBackendManifestEvidence(input: {
  files: FileManifest["files"];
  obligations: readonly FileActionObligation[];
  acquiredEvidence: ReadonlyMap<string, readonly string[]>;
  evidenceStore: RepositoryEvidenceStore;
  currentRevision?: string;
}): PlannedChange[] {
  const obligationByPath = new Map(
    input.obligations.map((obligation) => [normalizeRepoPath(obligation.path), obligation])
  );
  const isCurrentAuthorityId = (id: string): boolean => {
    const evidence = input.evidenceStore.getEvidence(id);
    return !!evidence &&
      input.evidenceStore.isAuthorityEligible(evidence) &&
      (!input.currentRevision || evidence.repositoryRevision === input.currentRevision);
  };

  return input.files.map((file) => {
    const normalizedPath = normalizeRepoPath(file.path);
    const obligation = obligationByPath.get(normalizedPath);
    const trustedObligationIds = (obligation?.evidenceIds || []).filter(isCurrentAuthorityId);
    const acquiredIds = (input.acquiredEvidence.get(normalizedPath) || []).filter(isCurrentAuthorityId);
    return {
      path: normalizedPath,
      action: obligation?.requiredAction ?? file.action,
      reason: file.description || `Proposed ${file.action} for ${normalizedPath}`,
      evidenceIds: Array.from(new Set(trustedObligationIds.length > 0 ? trustedObligationIds : acquiredIds)),
      dependencies: file.dependencies || [],
    };
  });
}

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
  priorVerifiedTargets?: PriorVerifiedTarget[];
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
      priorVerifiedTargets,
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
      const dependencyConfigurationFiles: Array<{ path: string; content: string }> = [];
      for (const filePath of canonicalExistingFiles) {
        const normalizedPath = normalizeRepoPath(filePath);
        if (!/(^|\/)(?:tsconfig|jsconfig)(?:\.[^/]*)?\.json$/i.test(normalizedPath)) continue;
        const snapshotFile = rawSnapshotFiles.find((file) => normalizeRepoPath(file.path || "") === normalizedPath);
        if (snapshotFile && typeof snapshotFile.content === "string") {
          dependencyConfigurationFiles.push({ path: normalizedPath, content: snapshotFile.content });
          continue;
        }
        if (effectiveLocalPath) {
          const absolutePath = path.join(effectiveLocalPath, normalizedPath);
          if (fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile()) {
            try {
              dependencyConfigurationFiles.push({ path: normalizedPath, content: fs.readFileSync(absolutePath, "utf8") });
            } catch { }
          }
        }
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

      // A prior verified path is a discovery hint only. Re-read it from the
      // current repository so no prior evidence or revision state crosses the
      // iteration boundary.
      for (const target of priorVerifiedTargets || []) {
        const targetPath = normalizeRepoPath(target.path);
        const existingIdx = relevantPlanningFiles.findIndex((file) => normalizeRepoPath(file.path) === targetPath);
        if (existingIdx >= 0) {
          const [currentFile] = relevantPlanningFiles.splice(existingIdx, 1);
          relevantPlanningFiles.unshift(currentFile);
          continue;
        }
        const currentSnapshot = rawSnapshotFiles.find((file) => normalizeRepoPath(file.path || "") === targetPath);
        if (currentSnapshot && typeof currentSnapshot.content === "string") {
          relevantPlanningFiles.unshift({ path: targetPath, content: currentSnapshot.content });
        } else if (effectiveLocalPath) {
          const absolutePath = path.join(effectiveLocalPath, targetPath);
          if (fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile()) {
            try {
              relevantPlanningFiles.unshift({ path: targetPath, content: fs.readFileSync(absolutePath, "utf8") });
            } catch { }
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
      const isDestructiveStage = activeStage
        ? Boolean(
            activeStage.intent?.destructive ||
            activeStage.intent?.taskType === "DELETE_FOLDER" ||
            activeStage.intent?.taskType === "DELETE_FILE" ||
            (activeStage.intent as any)?.intent === "DELETE_FOLDER" ||
            (activeStage.intent as any)?.intent === "DELETE_FILE" ||
            activeStage.intent?.operations?.some((op) => op.kind === "DELETE")
          )
        : Boolean(
            taskIntentSpec?.destructive ||
            intentResult.taskType === "DELETE_FOLDER" ||
            intentResult.taskType === "DELETE_FILE" ||
            intentResult.intent === "DELETE_FOLDER" ||
            intentResult.intent === "DELETE_FILE" ||
            compound.hasDeletion ||
            (Array.isArray(executionContract.allowedActions) &&
              (executionContract.allowedActions.includes("delete_file") ||
                executionContract.allowedActions.includes("delete_folder")))
          );

      let resolvedTaskTarget: ResolvedTaskTarget | undefined =
        activeStage?.resolvedTarget || taskIntentSpec?.resolvedTarget;

      const rawClarificationAnswer =
        clarificationData?.clarificationQas[clarificationData.clarificationQas.length - 1]?.answer;
      const validClarificationTarget =
        rawClarificationAnswer &&
        TargetPathExtractor.isValidTargetClarificationAnswer(rawClarificationAnswer, canonicalExistingFiles)
          ? rawClarificationAnswer.trim()
          : undefined;

      if (isDestructiveStage) {
        const resolution = DestructiveTargetResolver.resolve(
          effectiveGoal,
          canonicalExistingFiles,
          {
            isDestructive: true,
            taskType: activeStage?.intent?.taskType || intentResult.taskType,
            targetPath:
              activeStage?.intent?.explicitUserPaths?.[0] ||
              executionContract.targetPaths[0] ||
              (validClarificationTarget &&
              TargetPathExtractor.isValidPathCandidate(validClarificationTarget, canonicalExistingFiles)
                ? validClarificationTarget
                : undefined),
            evidenceStore,
            repositoryId: projectId,
            fileContext: optimizedContext?.fileContext,
            snapshotFiles: pipelineSnapshotFiles,
            localPath: effectiveLocalPath,
            monorepo,
            knowledgeGraph,
            selectedLogicalTarget: validClarificationTarget,
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
        priorVerifiedTargets,
        configurationFiles: dependencyConfigurationFiles,
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

      if (!rawManifest && manifestGenerationError) {
        const failureExplanation = `[Manifest Generation Failed] A valid evidence-citing file plan could not be produced. No code generation or mutation was attempted.\n${manifestGenerationError}`;
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
          errorCode: "PLANNING_MANIFEST_GENERATION_FAILED",
        };
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
        const isDestructiveOrDeletion = isDestructiveStage;

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
            if (!executionContract.actionObligations) {
              executionContract.actionObligations = [];
            }
            for (const exp of cleanupResult.approvedExpansions) {
              executionContract.targetProvenance[exp.path] = "DETERMINISTIC_REFERENCE_CLEANUP";
              if (!executionContract.actionObligations.some((o) => normalizeRepoPath(o.path) === normalizeRepoPath(exp.path))) {
                executionContract.actionObligations.push({
                  path: exp.path,
                  requiredAction: "modify",
                  role: "DEPENDENCY_CLEANUP",
                  evidenceIds: exp.evidence ? [String(exp.evidence)] : [],
                });
              }
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
          !isDestructiveStage;

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
        const manifestObligations: FileActionObligation[] =
          executionContract.actionObligations || planningContext.actionObligations || [];

        // Planning candidates are lookup keys only. Re-observe the current
        // worktree from independently task-grounded roots before resolving the
        // planning write set; generated paths never seed or widen traversal.
        const acquiredPlanningEvidence = DeterministicRelationEvidenceAcquirer.acquire({
          candidatePaths: (rawManifest.files || []).map((file) => file.path),
          intentSpec: taskIntentSpec,
          evidenceStore,
          repositoryId: projectId,
          workspaceRoot: effectiveLocalPath || undefined,
          existingFiles: canonicalExistingFiles,
        });
        const currentPlanningRevision = effectiveLocalPath
          ? authoritySnapshot(effectiveLocalPath).revision
          : undefined;
        const evidenceGroundedPlannedChanges = bindBackendManifestEvidence({
          files: rawManifest.files || [],
          obligations: manifestObligations,
          acquiredEvidence: acquiredPlanningEvidence,
          evidenceStore,
          currentRevision: currentPlanningRevision,
        });
        const proposedPlannedChanges = evidenceGroundedPlannedChanges;

        const effectiveRevision = input.baseCommitSha || (input.projectContext?.repoSnapshot as any)?.revision?.contentHash;
        const planningEvidenceResult = EvidenceBoundWriteSetResolver.resolve({
          policy: policyContract,
          intentSpec: taskIntentSpec,
          proposedChanges: evidenceGroundedPlannedChanges,
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
        const rejectedManifestPaths = (rawManifest.files || [])
          .map((file) => normalizeRepoPath(file.path))
          .filter((filePath) => !approvedSet.has(filePath));
        const coherentFiles = evidenceGroundedPlannedChanges
          .filter((change) => approvedSet.has(normalizeRepoPath(change.path)))
          .map((change) => ({
            ...(() => {
              const source = rawManifest?.files.find((file) => normalizeRepoPath(file.path) === normalizeRepoPath(change.path));
              return {
                repositoryDependencies: source?.repositoryDependencies,
                externalPackages: source?.externalPackages,
              };
            })(),
            path: change.path,
            action: change.action,
            description: change.reason,
            evidenceIds: [...change.evidenceIds],
            dependencies: (change.dependencies || []).filter((dependency) =>
              !rejectedManifestPaths.some((rejectedPath) =>
                matchesModuleSpecifier(change.path, dependency, rejectedPath, monorepo)
              )
            ),
          }));
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
          configurationFiles: dependencyConfigurationFiles,
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

    return {
      planningComplete: true,
      approvedManifest,
      executionContract,
      authorizedCapabilityScope: activeCapabilityScope,
      durationMs: s6Time,
    };
  }
}
