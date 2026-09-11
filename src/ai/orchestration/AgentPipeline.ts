import fs from "fs";
import { formatMs } from "../shared/utils";
import { ChatRequest, AgentResponse, AgentProgressEvent, ExecutionContract } from "../shared/types";
import {
  buildPolicyContract,
  detectReferenceCleanupIntent,
} from "../contracts/ExecutionContractBuilder";
import { TargetPathExtractor } from "../contracts/TargetPathExtractor";
import { ContractGuardrails } from "../contracts/ContractGuardrails";
import { TaskExecutionPlanManager } from "../planning/TaskExecutionPlanManager";
import { RepositoryEvidenceStore } from "../repository/RepositoryEvidenceStore";
import { CodeGenerator } from "../generation/CodeGenerator";
import { ValidationPlanner } from "../validation/ValidationPlanner";
import { ValidationRunner } from "../validation/ValidationRunner";
import { MemoryPersistence } from "../memory/MemoryPersistence";
import { PipelineTelemetry } from "./PipelineTelemetry";
import { PipelineResultBuilder } from "./PipelineResult";
import { normalizeRepoPath } from "../repository/SemanticContextResolver";
import { enforceExecutionScope } from "../contracts/ExecutionScopeEnforcer";
import { verifyFileVersionsFromDisk } from "../validation/FileVersionGuard";
import { BaselineDiagnostic } from "../../types";
import { decrypt } from "../../utils/encryption";
import { AuthoritativeSourceHydrator } from "../manifest/AuthoritativeSourceHydrator";
import { BaselineDeltaVerifier } from "../../services/baseline-delta.verifier";
import { DiagnosticNormalizer, NormalizedDiagnostic } from "../validation/DiagnosticNormalizer";
import { RepositoryObserver, RepositoryObservation, RepositoryProjectFacts } from "./RepositoryObserver";
import { AgentPlanner } from "./AgentPlanner";
import { ValidationCoordinator } from "./ValidationCoordinator";
import { AuthorizedCapabilityScope } from "../runtime/CapabilityGuard";
import { VerifiedCheckpointJournal } from "../runtime/VerifiedCheckpointJournal";
import { AgentLoopCoordinator } from "./AgentLoopCoordinator";
import { AgentWorkspaceState } from "../runtime/AgentWorkspaceState";
import { TaskRuntime } from "../runtime/TaskRuntime";
import { WorkingPlan } from "../runtime/WorkingPlan";

export class AgentPipeline {
  static async runCodingAgent(
    userId: string,
    projectId: string,
    request: ChatRequest,
    onProgress?: (event: AgentProgressEvent) => void,
    options?: {
      effectiveLocalPath?: string;
      baselineDiagnostics?: BaselineDiagnostic[];
      targetedBaselineDiagnostics?: BaselineDiagnostic[];
      isBaselineDeltaTask?: boolean;
      baseCommitSha?: string;
      baselineBuildPassed?: boolean;
      authorizedCapabilityScope?: AuthorizedCapabilityScope;
      checkpointJournal?: VerifiedCheckpointJournal;
      taskRuntime?: TaskRuntime;
      maxAgentIterations?: number;
      repositoryObservation?: RepositoryObservation;
      repositoryFacts?: RepositoryProjectFacts;
      persistConversation?: boolean;
      persistenceSession?: { id: string; title?: string | null };
      [key: string]: any;
    },
  ): Promise<AgentResponse> {
    const persistenceSession = await MemoryPersistence.getOrCreateSession(userId, "project", projectId, request.sessionId);
    await MemoryPersistence.saveMessage(persistenceSession.id, "user", request.message);
    const ownsRuntime = !options?.taskRuntime;
    const runtime = options?.taskRuntime ?? TaskRuntime.create({
      taskId: `pipeline-${Date.now()}`,
      originalGoal: request.message,
      workspace: AgentWorkspaceState.create({
        projectId,
        ...(request.repositoryId ? { repositoryId: request.repositoryId } : {}),
        root: options?.effectiveLocalPath ?? process.cwd(),
      }),
      metadata: { projectId, executionBoundary: "AgentPipeline.runCodingAgent" },
    });
    if (ownsRuntime) runtime.start();
    const journal = options?.checkpointJournal ?? new VerifiedCheckpointJournal();
    const configuredMax = options?.maxAgentIterations ?? Number(process.env.ANKA_AGENT_MAX_ITERATIONS ?? 8);
    const maxIterations = Number.isInteger(configuredMax) && configuredMax >= 1 && configuredMax <= 20 ? configuredMax : 8;
    let iterationRequest = request;
    let preparedObservation: RepositoryObservation | undefined;
    let preparedFacts: RepositoryProjectFacts | undefined;
    const workingPlan = WorkingPlan.create({ id: `working-plan:${runtime.snapshot().taskId}` });
    const result = await AgentLoopCoordinator.runPipeline({
      runtime,
      workingPlan,
      maxIterations,
      observe: async (iteration) => {
        const facts = await RepositoryObserver.loadProjectFacts(projectId);
        const observation = await RepositoryObserver.observe(projectId, iterationRequest, facts, options);
        preparedFacts = facts;
        preparedObservation = observation;
        const revision = observation.currentRevisionHash ?? `unversioned-iteration-${iteration}`;
        const workspace = runtime.workspaceState().withEvidence({
          id: `loop-observation:${iteration}:${revision}`,
          kind: "MATERIALIZED_REPOSITORY",
          description: `RepositoryObserver captured current repository bytes for agent-loop iteration ${iteration}.`,
          revision,
        });
        return { workspace, revision };
      },
      executeIteration: async () => {
        const before = journal.snapshot().length;
        const response = await this.runSingleIteration(userId, projectId, iterationRequest, onProgress, {
          ...options,
          taskRuntime: runtime,
          checkpointJournal: journal,
          repositoryFacts: preparedFacts,
          repositoryObservation: preparedObservation,
          persistConversation: false,
          persistenceSession,
        });
        if (response.taskExecutionPlan) {
          iterationRequest = {
            ...iterationRequest,
            context: { ...(iterationRequest.context ?? {}), taskExecutionPlan: response.taskExecutionPlan },
          };
        }
        return { response, journalEntry: journal.snapshot()[before] };
      },
      onRevisionRequired: (response) => {
        const failedPlan = response.taskExecutionPlan;
        if (!failedPlan) return;
        const retryStages = failedPlan.stages.map((stage, index) =>
          index === failedPlan.currentStageIndex && stage.status === "FAILED"
            ? { ...stage, status: "PENDING" as const }
            : stage,
        );
        iterationRequest = {
          ...iterationRequest,
          context: {
            ...(iterationRequest.context ?? {}),
            taskExecutionPlan: { ...failedPlan, stages: retryStages, status: "RUNNING" },
          },
        };
      },
    });
    await MemoryPersistence.saveMessage(persistenceSession.id, "assistant", result.response.explanation);
    const reachedUserFacingSuccess = result.response.lifecycleStage === "Done"
      || result.response.successfulNoOp === true
      || result.response.compoundTaskStatus === "RUNNING"
      || result.response.compoundTaskStatus === "COMPLETED";
    if (reachedUserFacingSuccess && !persistenceSession.title) {
      await MemoryPersistence.updateSessionTitle(persistenceSession.id, request.message);
    }
    return {
      ...result.response,
      agentLoop: {
        outcome: result.loop.outcome,
        iterations: result.loop.iterations,
        workingPlanId: result.loop.workingPlan.snapshot().id,
        workingPlanRevision: result.loop.workingPlan.snapshot().revision,
        verifiedCheckpointIds: result.loop.verifiedCheckpointIds,
        ...(result.loop.failureCode ? { failureCode: result.loop.failureCode } : {}),
      },
      taskRuntime: runtime.snapshot(),
    };
  }

  private static async runSingleIteration(
    userId: string,
    projectId: string,
    request: ChatRequest,
    onProgress?: (event: AgentProgressEvent) => void,
    options?: {
      effectiveLocalPath?: string;
      baselineDiagnostics?: BaselineDiagnostic[];
      targetedBaselineDiagnostics?: BaselineDiagnostic[];
      isBaselineDeltaTask?: boolean;
      baseCommitSha?: string;
      baselineBuildPassed?: boolean;
      authorizedCapabilityScope?: AuthorizedCapabilityScope;
      checkpointJournal?: VerifiedCheckpointJournal;
      taskRuntime?: TaskRuntime;
      maxAgentIterations?: number;
      repositoryObservation?: RepositoryObservation;
      repositoryFacts?: RepositoryProjectFacts;
      persistConversation?: boolean;
      persistenceSession?: { id: string; title?: string | null };
      [key: string]: any;
    },
  ): Promise<AgentResponse> {
    const session = options?.persistenceSession
      ?? await MemoryPersistence.getOrCreateSession(userId, "project", projectId, request.sessionId);
    const repositoryFacts = options?.repositoryFacts ?? await RepositoryObserver.loadProjectFacts(projectId);
    const saveConversationMessage = options?.persistConversation === false
      ? async (_role: "user" | "assistant", _content: string): Promise<void> => undefined
      : async (role: "user" | "assistant", content: string): Promise<void> => {
          await MemoryPersistence.saveMessage(session.id, role, content);
        };
    await saveConversationMessage("user", request.message);

    const observation = options?.repositoryObservation
      ?? await RepositoryObserver.observe(projectId, request, repositoryFacts, options);
    const pipelineStart = performance.now();
    onProgress?.({
      step: 1,
      stageName: "INITIALIZING",
      label: "Understand Goal & Scope",
      detail: "Initializing repository environment and workspace context...",
      badge: "INIT",
      progress: 5,
      log: "[Init] Initializing repository environment and analyzing workspace...",
    });
    const {
      projectContext,
      approvedArchitecture,
      effectiveLocalPath,
      effectiveSnapshot,
      currentRevisionHash,
      snapshotFileList,
      repoFileNames,
      canonicalExistingFiles,
      monorepo,
    } = observation;

    // Stage 1: Intent Analysis with Destructive Safety Grounding
    const planning = await AgentPlanner.plan({ request, projectContext, canonicalExistingFiles });
    const {
      clarificationData,
      effectiveMessageForIntent,
      intentResult,
      explicitUserPaths,
      stageDependencyViolation,
      failedOrPendingDependencies,
      dependentStagesSkipped,
    } = planning;
    const s1Time = planning.durationMs;

    if (planning.status === "FAILED") {
      const failureExplanation = `[Technical Failure] Intent classification failed: ${intentResult.reasoning}`;
      await saveConversationMessage("assistant", failureExplanation);
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
        compoundTaskStatus: "FAILED",
        needsClarification: false,
        reason: intentResult.reasoning,
        errorCode: "TECHNICAL_FAILURE",
      };
    }

    let taskExecutionPlan = planning.taskExecutionPlan;
    const activeStage = planning.activeStage;

    // Enforce Stage Dependency Eligibility (Pass 3A)
    if (stageDependencyViolation) {
      const failureExplanation = `[Stage Dependency Violation] Stage "${activeStage.id}" cannot execute because its dependencies are not VERIFIED: ${failedOrPendingDependencies.join(", ")}`;
      await saveConversationMessage("assistant", failureExplanation);

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
        taskExecutionPlan,
        compoundTaskStatus: "FAILED",
        failedStage: activeStage.id,
        dependentStagesSkipped,
      };
    }

    const taskIntentSpec = activeStage.intent;
    const effectiveGoal = activeStage.intent.goal;

    const baselineDiagnosticsList = options?.targetedBaselineDiagnostics || options?.baselineDiagnostics || [];

    const pipelineSnapshotFiles = snapshotFileList;

    const policyContract = buildPolicyContract(taskIntentSpec, canonicalExistingFiles, {
      snapshotFiles: pipelineSnapshotFiles,
      localPath: effectiveLocalPath,
      monorepo,
    });

    const evidenceStore = new RepositoryEvidenceStore(projectId, effectiveLocalPath || undefined);

    // Normalize and ingest baseline diagnostics strictly via DiagnosticNormalizer
    const currentCheckpointId = activeStage?.id;
    const rawErrorLog =
      options?.baselineErrorLog ||
      options?.baselineBuildErrors ||
      options?.rawBaselineErrors ||
      options?.baselineErrors;

    const normalizedDiagnostics: NormalizedDiagnostic[] = [];
    if (typeof rawErrorLog === "string" && rawErrorLog.trim().length > 0) {
      normalizedDiagnostics.push(
        ...DiagnosticNormalizer.normalize(rawErrorLog, {
          repositoryId: projectId,
          checkpointId: currentCheckpointId,
        })
      );
    }

    if (Array.isArray(baselineDiagnosticsList) && baselineDiagnosticsList.length > 0) {
      for (const bd of baselineDiagnosticsList) {
        if ((bd as any).category) {
          normalizedDiagnostics.push(bd as any);
        } else {
          const rawTrace =
            (bd as any).rawTrace ||
            ((bd as any).filePath
              ? `${(bd as any).filePath}(${(bd as any).line || 1},${(bd as any).column || 1}): error ${(bd as any).errorCode || "TS"}: ${(bd as any).message}`
              : (bd as any).message);
          const diags = DiagnosticNormalizer.normalize(rawTrace, {
            repositoryId: projectId,
            checkpointId: currentCheckpointId,
          });
          if (diags.length > 0) {
            normalizedDiagnostics.push(...diags);
          }
        }
      }
    }

    if (normalizedDiagnostics.length > 0) {
      DiagnosticNormalizer.ingestSourceDiagnostics(
        normalizedDiagnostics,
        evidenceStore,
        currentCheckpointId
      );
    }

    const diagnosticEvidences = evidenceStore.getAllEvidence().filter((e) => e.kind === "DIAGNOSTIC");
    const diagnosticTargetPaths = Array.from(
      new Set(
        [
          ...diagnosticEvidences.map((e) => e.filePath),
          ...baselineDiagnosticsList.map((d) => d.filePath || ""),
        ]
          .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
          .map((p) => normalizeRepoPath(p))
      )
    );

    let executionContract: ExecutionContract = {
      goal: policyContract.goal,
      taskType: policyContract.taskType,
      risk: policyContract.risk,
      estimatedComplexity: policyContract.estimatedComplexity,
      pipeline: policyContract.pipeline,
      environment: policyContract.environment,
      repositoryRequired: policyContract.repositoryRequired,
      expectedFiles: policyContract.expectedFiles,
      validationType: policyContract.validationType,
      targetPaths: explicitUserPaths, // ONLY explicit literal paths from user, NO guessed nouns
      contextScope: explicitUserPaths,
      searchScope: [],
      allowedActions: policyContract.allowedActions,
      forbiddenActions: policyContract.forbiddenActions,
      maxFiles: policyContract.maxFiles,
      diffCriticEnabled: policyContract.diffCriticEnabled,
      targetProvenance: {},
    };

    if (diagnosticTargetPaths.length > 0) {
      for (const dt of diagnosticTargetPaths) {
        if (!diagnosticEvidences.some((e) => normalizeRepoPath(e.filePath) === normalizeRepoPath(dt))) {
          evidenceStore.addEvidence({
            kind: "DIAGNOSTIC",
            filePath: dt,
            provenance: "BUILD_DIAGNOSTIC",
            metadata: {
              checkpointId: currentCheckpointId,
              stale: false,
            },
          });
        }
      }
      executionContract.searchScope = Array.from(new Set([...diagnosticTargetPaths, ...executionContract.searchScope]));
      if (executionContract.taskType === "NEW_FEATURE" || executionContract.taskType === "REFACTOR") {
        executionContract.taskType = "BUG_FIX";
      }
    }

    onProgress?.({
      step: 1,
      stageName: "INTENT_ANALYSIS",
      label: "Task",
      detail: `Task: ${intentResult.taskType} | Risk: ${intentResult.risk} | Complexity: ${intentResult.estimatedComplexity} | Time: ${formatMs(s1Time)}`,
      color: intentResult.risk === "HIGH" || intentResult.risk === "CRITICAL" ? "text-rose-400 border-rose-500/30 bg-rose-500/10" : "text-amber-400 border-amber-500/30 bg-amber-500/10",
      badge: `STAGE 1/7 · ${intentResult.taskType} · ${formatMs(s1Time)}`,
      progress: 15,
      log: `[Stage 1/7] Intent Analysis completed in ${formatMs(s1Time)}:\n  ✓ Task: ${intentResult.taskType}\n  ✓ Risk: ${intentResult.risk}\n  ✓ Allowed: ${policyContract.allowedActions.join(", ")}\n  ✗ Forbidden: ${policyContract.forbiddenActions.slice(0, 3).join(", ")}`,
      taskType: intentResult.taskType,
      risk: intentResult.risk,
      estimatedComplexity: intentResult.estimatedComplexity,
      targetPath: intentResult.targetPath,
      executionContract,
      durationMs: s1Time,
    });

    if (intentResult.requiresClarification && (!clarificationData || clarificationData.clarificationQas.length === 0)) {
      await saveConversationMessage("assistant", `[Agent] ❓ ${intentResult.question || "Please clarify your request."}`);
      return {
        explanation: intentResult.reasoning,
        changes: [],
        commitMessage: "",
        sessionId: session.id,
        needsClarification: true,
        question: intentResult.question || "Could you provide more specific details for this request?",
        options: intentResult.options || ["Proceed with default settings", "Specify target files"],
        intent: intentResult.intent,
        taskType: intentResult.taskType,
        risk: intentResult.risk,
        estimatedComplexity: intentResult.estimatedComplexity,
        targetPath: intentResult.targetPath,
        confidence: intentResult.confidence,
        taskExecutionPlan,
      };
    }

    // ── Deterministic Successful No-Op Gate for Repair Tasks (ALREADY_SATISFIED) ──
    const isRepairStage =
      activeStage.intent.taskType === "BUG_FIX" ||
      intentResult.taskType === "BUG_FIX" ||
      activeStage.intent.operations?.some((op) => op.kind === "REPAIR");

    const hasSourceDiagnostics =
      normalizedDiagnostics.some((d) => d.category === "SOURCE_DIAGNOSTIC") ||
      diagnosticEvidences.some((e) => e.kind === "DIAGNOSTIC" && !e.metadata?.stale);

    const hasEnvironmentFailure =
      normalizedDiagnostics.some(
        (d) =>
          d.category === "ENVIRONMENT_FAILURE" ||
          d.category === "TOOLCHAIN_FAILURE" ||
          d.category === "DEPENDENCY_FAILURE"
      ) ||
      options?.baselineDependencyInstall === "FAIL" ||
      options?.dependenciesReady === false ||
      options?.healthStatus === "BASELINE_REPOSITORY_UNHEALTHY";

    const dependenciesReady =
      options?.dependenciesReady !== false &&
      options?.baselineDependencyInstall !== "FAIL" &&
      !hasEnvironmentFailure;

    let baselinePassed: boolean | undefined =
      options?.baselineBuildPassed !== undefined
        ? Boolean(options.baselineBuildPassed)
        : options?.baselineBuild === "PASS"
        ? true
        : options?.baselineBuild === "FAIL"
        ? false
        : undefined;

    if (
      isRepairStage &&
      baselinePassed === undefined &&
      dependenciesReady &&
      effectiveLocalPath &&
      fs.existsSync(effectiveLocalPath)
    ) {
      const baselineCmds =
        options?.baselineCommands ||
        ValidationPlanner.detectValidationCommands(
          effectiveLocalPath,
          effectiveSnapshot,
          executionContract
        );
      if (baselineCmds.length > 0) {
        try {
          const baselineCheck = await ValidationRunner.validateWithShell(
            [],
            effectiveLocalPath,
            baselineCmds
          );
          baselinePassed = baselineCheck.success;
        } catch {
          baselinePassed = false;
        }
      } else {
        baselinePassed = true;
      }
    }

    const isAlreadySatisfied =
      isRepairStage &&
      dependenciesReady &&
      baselinePassed === true &&
      !hasSourceDiagnostics &&
      !hasEnvironmentFailure;

    if (isAlreadySatisfied) {
      console.log(
        `[AgentPipeline] Repair task is already satisfied: deterministic baseline validation passed with 0 source diagnostics. Returning ALREADY_SATISFIED successful no-op.`
      );

      const advancedPlanResult = TaskExecutionPlanManager.advancePlanStage(taskExecutionPlan);
      const updatedPlan = advancedPlanResult.plan;
      const compoundStatus = updatedPlan.stages.every((s) => s.status === "VERIFIED")
        ? "COMPLETED"
        : "RUNNING";

      const explanation =
        `[Deterministic No-Op: ALREADY_SATISFIED] Baseline verification succeeded and zero source diagnostics exist for this repository. The requested repair is already satisfied.`;

      onProgress?.({
        step: 10,
        stageName: "MEMORY_PERSISTENCE",
        label: "Verify & Done",
        detail: "Repair already satisfied by baseline verification. Zero changes needed.",
        color: "text-emerald-400 border-emerald-500/30 bg-emerald-500/10",
        badge: "ALREADY_SATISFIED · 0ms",
        progress: 100,
        log: `[Stage Complete] ${explanation}`,
        durationMs: 0,
      });

      await saveConversationMessage("assistant", explanation);
      if (options?.persistConversation !== false && !session.title) await MemoryPersistence.updateSessionTitle(session.id, request.message);

      return {
        explanation,
        changes: [],
        commitMessage: "",
        sessionId: session.id,
        intent: intentResult.intent,
        taskType: intentResult.taskType,
        risk: intentResult.risk,
        estimatedComplexity: intentResult.estimatedComplexity,
        targetPath: intentResult.targetPath,
        confidence: 1.0,
        successfulNoOp: true,
        reason: "ALREADY_SATISFIED",
        status: "ALREADY_SATISFIED",
        buildVerified: true,
        taskVerified: true,
        repositoryClean: true,
        healthStatus: "HEALTHY",
        taskExecutionPlan: updatedPlan,
        compoundTaskStatus: compoundStatus,
        lifecycleStage: "Done",
        baselineDiagnosticCount: 0,
        targetedBaselineDiagnostics: [],
        remainingBaselineDiagnostics: [],
        newTaskDiagnostics: [],
      };
    }

    const contextAssembly = await RepositoryObserver.assembleContext({
      projectId,
      effectiveGoal,
      requestMessage: request.message,
      projectContext,
      effectiveSnapshot,
      effectiveLocalPath,
      currentRevisionHash,
      repoFileNames,
      snapshotFileList,
      intentResult,
      policyContract,
      taskIntentSpec,
      evidenceStore,
      approvedArchitecture,
      diagnosticTargetPaths,
      baselineDiagnosticsList,
      executionContract,
      onProgress,
    });
    const {
      knowledgeGraph,
      optimizedContext,
      systemPrompt,
      rawSnapshotFiles,
      finalConfidence,
      searchSummary,
      inspectedFiles: inspectedFilesArr,
      scannedCount,
      extractedSymbolsCount,
      inputTokens,
      outputTokens,
      compressionRatio,
      stage2DurationMs: s2Time,
      stage3DurationMs: s3Time,
      stage4DurationMs: s4Time,
      stage5DurationMs: s5Time,
    } = contextAssembly;
    const manifestPlanning = await AgentPlanner.planManifest({
      projectId,
      sessionId: session.id,
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
      executionContract,
      evidenceStore,
      effectiveGoal,
      policyContract,
      knowledgeGraph,
      clarificationData,
      finalConfidence,
      onProgress,
    });
    if (!("planningComplete" in manifestPlanning)) {
      return manifestPlanning;
    }
    const { approvedManifest, durationMs: s6Time } = manifestPlanning;
    executionContract = manifestPlanning.executionContract;
    // Authoritative Manifest Source Hydration for MODIFY actions
    const hydrationResult = AuthoritativeSourceHydrator.hydrateModifySources(
      approvedManifest,
      effectiveLocalPath,
      canonicalExistingFiles,
      optimizedContext?.fileContext || {},
    );

    if (!hydrationResult.success) {
      const failureExplanation =
        hydrationResult.error ||
        `[MANIFEST_SOURCE_HYDRATION_FAILED] Failed to hydrate source for approved modify targets.`;
      await saveConversationMessage("assistant", failureExplanation);

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
      };
    }

    // Stage 7: Coding Agent File Generation
    onProgress?.({
      step: 4,
      stageName: "CODE_GENERATION",
      label: "Generate File Changes",
      detail: "Synthesizing exact code changes and targeted search/replace patch edits...",
      badge: "GENERATING",
      progress: 75,
      log: "[Generate] Synthesizing precise code changes and targeted search/replace patches...",
      executionContract,
    });

    const s7Start = performance.now();
    let roadmapAndDiff;
    try {
      roadmapAndDiff = await CodeGenerator.generateRoadmapAndDiffs(
        request.message,
        intentResult,
        optimizedContext,
        systemPrompt,
        executionContract,
        approvedManifest,
        hydrationResult.authoritativeModifySources,
        hydrationResult.mergedSourceMap,
      );
    } catch (genErr: any) {
      if (
        genErr?.code === "CODEGEN_MANIFEST_ACTION_VIOLATION" ||
        (genErr?.message && genErr.message.includes("[CODEGEN_MANIFEST_ACTION_VIOLATION]"))
      ) {
        const failureExplanation = `[Execution Scope Violation] [CODEGEN_MANIFEST_ACTION_VIOLATION] Generated file changes attempted action violating approved manifest contract:\n• ${genErr.message}`;
        await saveConversationMessage("assistant", failureExplanation);

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
          lifecycleStage: "CodegenManifestActionViolation",
          errorCode: "CODEGEN_MANIFEST_ACTION_VIOLATION",
        };
      }
      if (
        genErr?.code === "CODEGEN_MANIFEST_VIOLATION" ||
        (genErr?.message && genErr.message.includes("[CODEGEN_MANIFEST_VIOLATION]"))
      ) {
        const failureExplanation = `[Execution Scope Violation] Generated file changes failed deterministic scope validation:\n• [UNDECLARED_FILE] ${genErr.message}`;
        await saveConversationMessage("assistant", failureExplanation);

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
          lifecycleStage: "BuildFailed",
        };
      }
      throw genErr;
    }
    const s7Time = performance.now() - s7Start;

    onProgress?.({
      step: 4,
      stageName: "CHANGES_SYNTHESIZED",
      label: "Generate File Changes",
      detail: `Synthesized ${roadmapAndDiff.changes.length} change proposal(s) in ${formatMs(s7Time)}`,
      badge: `CODE · ${formatMs(s7Time)}`,
      progress: 82,
      log: `[Generate] Generated ${roadmapAndDiff.changes.length} file change(s) in ${formatMs(s7Time)}:\n${roadmapAndDiff.changes.map((c) => `  • ${c.action?.toUpperCase() || "MODIFY"}: ${c.path}`).join("\n")}`,
      executionContract,
    });

    // Execution Scope Enforcement Gate (Post-Generation / Pre-Disk)
    const existingFileList = Array.isArray(effectiveSnapshot)
      ? effectiveSnapshot.map((f: any) => (typeof f === "string" ? f : f.path || ""))
      : (effectiveSnapshot?.keyFiles || []).map((f: any) => (typeof f === "string" ? f : f.path || ""));

    const scopeCheck = enforceExecutionScope({
      proposedChanges: roadmapAndDiff.changes,
      manifest: approvedManifest,
      contract: executionContract,
      existingFilePaths: existingFileList,
    });

    if (!scopeCheck.valid) {
      const errorDetails = scopeCheck.errors
        .map((e) => `• [${e.reason}] ${e.path}: ${e.message}`)
        .join("\n");
      const failureExplanation = `[Execution Scope Violation] Generated file changes failed deterministic scope validation:\n${errorDetails}`;
      await saveConversationMessage("assistant", failureExplanation);

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
        roadmap: roadmapAndDiff.roadmap,
      };
    }

    // Diff Contract Critic Pass
    const criticResult = executionContract.diffCriticEnabled
      ? ContractGuardrails.runDiffContractCritic(roadmapAndDiff.changes, executionContract)
      : { accepted: roadmapAndDiff.changes, rejected: [], log: "[Diff Critic] Skipped" };

    // File Version Guard Gate (Pre-Disk / Stale Source Protection)
    if (
      roadmapAndDiff.expectedSourceHashes &&
      Object.keys(roadmapAndDiff.expectedSourceHashes).length > 0 &&
      effectiveLocalPath
    ) {
      const versionCheck = await verifyFileVersionsFromDisk(
        roadmapAndDiff.expectedSourceHashes,
        effectiveLocalPath,
      );

      if (!versionCheck.valid) {
        const failureExplanation = `[${versionCheck.error.code}] File version mismatch on "${versionCheck.error.path}": ${versionCheck.error.message}`;
        await saveConversationMessage("assistant", failureExplanation);

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
          roadmap: roadmapAndDiff.roadmap,
        };
      }
    }

    const validation = await ValidationCoordinator.validate({
      acceptedChanges: criticResult.accepted,
      effectiveLocalPath,
      effectiveSnapshot,
      executionContract,
      monorepo,
      activeStageId: activeStage.id,
      taskExecutionPlan,
      systemPrompt,
      requestMessage: request.message,
      projectId,
      approvedManifest,
      authorizedCapabilityScope: options?.authorizedCapabilityScope,
      onProgress,
      baselineDiagnostics: options?.baselineDiagnostics,
      targetedBaselineDiagnostics: options?.targetedBaselineDiagnostics,
      baseCommitSha: options?.baseCommitSha,
      baselineBuildPassed: options?.baselineBuildPassed,
      checkpointJournal: options?.checkpointJournal,
    });
    const {
      repairResult,
      auditResult,
      featureValidation,
      effectiveValidationCommands,
      stageTransaction,
      rollbackErrorLog,
      stage8DurationMs: s8Time,
      stage9DurationMs: s9Time,
      isRepositoryClean,
      isTaskVerified,
      gateSuccess,
      isBuildVerified,
      actionGroupId,
      checkpointJournal,
    } = validation;
    taskExecutionPlan = validation.taskExecutionPlan;

    const totalPipelineDuration = performance.now() - pipelineStart;
    const promptTokensK = (outputTokens / 1000).toFixed(1);
    const completionTokensK = (roadmapAndDiff.changes.length * 0.5 + 1.2).toFixed(1);

    const pipelineMeasurementText = PipelineTelemetry.generateMeasurementText({
      s1Time,
      s2Time,
      s3Time,
      s4Time,
      s5Time,
      s6Time,
      s7Time,
      s8Time,
      s9Time,
      totalPipelineDuration,
      scannedCount,
      extractedSymbolsCount,
      inspectedFilesCount: inspectedFilesArr.length,
      finalConfidence,
      inputTokens,
      outputTokens,
      compressionRatio,
      promptTokensK,
      completionTokensK,
      modifiedFilesCount: repairResult.finalChanges.length,
      validationCommands: effectiveValidationCommands,
      buildSuccess: isRepositoryClean,
      securityPass: auditResult.securityPass,
      repairAttempts: repairResult.attempts,
      errorType: repairResult.errorType,
      infrastructureError: repairResult.infrastructureError,
    });

    onProgress?.({
      step: 10,
      stageName: "MEMORY_PERSISTENCE",
      label: "Verify & Done",
      detail: `Pipeline End: Total Time ${formatMs(totalPipelineDuration)}`,
      color: "text-purple-400 border-purple-500/30 bg-purple-500/10",
      badge: `PIPELINE END · ${formatMs(totalPipelineDuration)}`,
      progress: 100,
      log: `[Pipeline Complete] Total execution time: ${formatMs(totalPipelineDuration)}\n${pipelineMeasurementText}`,
      durationMs: totalPipelineDuration,
      pipelineMeasurementText,
    });

    await MemoryPersistence.persistProjectMemory(projectId, request.message, auditResult);

    const defaultChecklist = PipelineResultBuilder.buildChecklist(
      executionContract,
      featureValidation,
      finalConfidence,
      isRepositoryClean,
      isTaskVerified,
      isRepositoryClean,
    );

    let buildStatusText = "❌ Build Verification Failed";
    if (isRepositoryClean) {
      buildStatusText = "✅ Build Verified / Passed";
    } else if (isTaskVerified) {
      buildStatusText = "⚠️ Task Verified (Repository Unhealthy: Pre-existing / Revealed Baseline Errors)";
    }

    const featureChecks = featureValidation.checks || [];
    const checklistMarkdown =
      `\n\n### ⏱️ Pipeline Stage Performance & Metrics\n${pipelineMeasurementText}\n\n### 📋 Repository Intelligence Verification Checklist\n` +
      `**Repository Search Confidence:** ${(finalConfidence * 100).toFixed(0)}%\n` +
      `**Build Status:** ${buildStatusText}\n\n` +
      `**Search Summary:**\n${searchSummary}\n\n` +
      defaultChecklist.map((item) => `${item.checked ? "✅" : "❌"} ${item.label}`).join("\n") +
      (!isRepositoryClean && repairResult.errorLog && !isTaskVerified
        ? `\n\n**❌ Build Verification Errors Captured:**\n\`\`\`\n${repairResult.errorLog.slice(0, 2000)}\n\`\`\``
        : "") +
      (featureValidation.failedChecks.length > 0
        ? `\n\n**⚠️ Feature Validation Issues:**\n` + featureChecks.filter((c: any) => c.status === "FAIL").map((c: any) => `- ${c.label}: ${c.details}`).join("\n")
        : "");

    const fileChangeLines =
      repairResult.finalChanges.length > 0
        ? repairResult.finalChanges.map((c: any) => `- ${c.path}: ${c.action === "delete" || c.isDeleted ? "[DELETED] " : ""}${c.description}`).join("\n")
        : "No files changed.";

    let combinedExplanation = roadmapAndDiff.explanation;
    if (repairResult.deltaResult && (!repairResult.repositoryClean || (repairResult.deltaResult.revealedBaselineDiagnostics && repairResult.deltaResult.revealedBaselineDiagnostics.length > 0))) {
      const deltaExplanation = BaselineDeltaVerifier.formatDeltaExplanation(repairResult.deltaResult);
      combinedExplanation = combinedExplanation + "\n\n" + deltaExplanation;
    }

    const summary = `[TaskType: ${intentResult.taskType} | Risk: ${intentResult.risk} | Complexity: ${intentResult.estimatedComplexity}] ${combinedExplanation}\n\n${auditResult.summary}${checklistMarkdown}\n\nFiles Modified / Deleted:\n${fileChangeLines}`;
    await saveConversationMessage("assistant", summary);

    if (options?.persistConversation !== false && !session.title) await MemoryPersistence.updateSessionTitle(session.id, request.message);

    return {
      explanation: combinedExplanation + "\n\n" + auditResult.summary + checklistMarkdown,
      changes: gateSuccess ? repairResult.finalChanges : [],
      commitMessage: roadmapAndDiff.commitMessage,
      sessionId: session.id,
      intent: intentResult.intent,
      taskType: intentResult.taskType,
      risk: intentResult.risk,
      estimatedComplexity: intentResult.estimatedComplexity,
      targetPath: intentResult.targetPath,
      confidence: finalConfidence,
      roadmap: roadmapAndDiff.roadmap,
      taskExecutionPlan: gateSuccess
        ? TaskExecutionPlanManager.advancePlanStage(taskExecutionPlan).plan
        : TaskExecutionPlanManager.failStage(taskExecutionPlan, activeStage.id),
      compoundTaskStatus: gateSuccess
        ? (taskExecutionPlan.stages.every((s) => s.status === "VERIFIED") ? "COMPLETED" : "RUNNING")
        : "FAILED",
      failedStage: gateSuccess ? undefined : activeStage.id,
      dependentStagesSkipped: gateSuccess
        ? undefined
        : TaskExecutionPlanManager.getDependentStages(taskExecutionPlan, activeStage.id),
      checkpointId: actionGroupId,
      actionGroupId,
      checkpointJournal,
      securityPass: auditResult.securityPass,
      critiqueScore: auditResult.critiqueScore,
      buildVerified: isBuildVerified,
      taskVerified: isTaskVerified,
      repositoryClean: isRepositoryClean,
      healthStatus: isTaskVerified ? (isRepositoryClean ? "HEALTHY" : "TASK_VERIFIED_REPOSITORY_UNHEALTHY") : (isBuildVerified ? "HEALTHY" : undefined),
      baselineDiagnosticCount: repairResult.deltaResult?.baselineDiagnosticCount,
      targetedBaselineDiagnostics: repairResult.deltaResult?.targetedBaselineDiagnostics,
      resolvedTargetDiagnostics: repairResult.deltaResult?.resolvedTargetDiagnostics,
      remainingBaselineDiagnostics: repairResult.deltaResult?.remainingBaselineDiagnostics,
      revealedBaselineDiagnostics: repairResult.deltaResult?.revealedBaselineDiagnostics,
      newTaskDiagnostics: repairResult.deltaResult?.newTaskDiagnostics,
      deltaResult: repairResult.deltaResult,
      repaired: Boolean(repairResult.repaired ?? repairResult.attempts > 1),
      repairAttempted: Boolean(repairResult.attempts > 1 || repairResult.repaired),
      repairAttempts: repairResult.attempts || 0,
      repairApplied: Boolean(repairResult.repairApplied),
      repairSuccess: Boolean(repairResult.success),
      repairTrigger: repairResult.repairTrigger || "NONE",
      buildErrors: [
        !isBuildVerified && !isTaskVerified && repairResult.errorLog ? repairResult.errorLog : "",
        !auditResult.securityPass ? "Security audit failed / flagged critical security violations." : "",
        !featureValidation.overallPassed ? "Feature / static validation failed required checks." : "",
        rollbackErrorLog ? rollbackErrorLog : "",
      ].filter(Boolean).join("\n\n") || (!isBuildVerified && !isTaskVerified ? repairResult.errorLog : ""),
      verificationChecklist: defaultChecklist,
      lifecycleStage: gateSuccess ? "Done" : "BuildFailed",
      pipelineMeasurementText,
      patchCorrectionAttempted: (roadmapAndDiff as any).patchTelemetry?.patchCorrectionAttempted,
      patchCorrectionSucceeded: (roadmapAndDiff as any).patchTelemetry?.patchCorrectionSucceeded,
      patchCorrectionAttempts: (roadmapAndDiff as any).patchTelemetry?.patchCorrectionAttempts,
      securityRiskLevel: auditResult.riskLevel,
      securityVulnerabilities: auditResult.vulnerabilities,
      securityRecommendations: auditResult.recommendations,
      rootBuildFailure: repairResult.rootFailure,
      currentFailure: repairResult.currentFailure,
      validationDetails: repairResult.validationDetails,
      modelRepairAttempts: repairResult.modelRepairAttempts,
      patchesAppliedCount: repairResult.patchesAppliedCount,
      buildAttemptsCount: repairResult.buildAttemptsCount,
    };
  }
}
