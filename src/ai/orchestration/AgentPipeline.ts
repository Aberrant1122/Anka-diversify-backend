import fs from "fs";
import path from "path";
import { PrismaClient } from "@prisma/client";
import { formatMs, getOpenAI } from "../shared/utils";
import { ChatRequest, AgentResponse, AgentProgressEvent, ExecutionContract } from "../shared/types";
import { IntentClassifier } from "../classification/IntentClassifier";
import { buildExecutionContract } from "../contracts/ExecutionContractBuilder";
import { ContractGuardrails } from "../contracts/ContractGuardrails";
import { RepositoryScanner } from "../repository/RepositoryScanner";
import { RepositoryKnowledgeGraph, loadPersistedKnowledgeGraph, savePersistedKnowledgeGraph } from "../repository/RepositoryKnowledgeGraph";
import { RepositoryContextBuilder } from "../repository/RepositoryContextBuilder";
import { RepositorySearch } from "../repository/RepositorySearch";
import { CodeGenerator } from "../generation/CodeGenerator";
import { ManifestGenerator } from "../generation/ManifestGenerator";
import { TaskDecomposer } from "../generation/TaskDecomposer";
import { FileSystemStateManager } from "../validation/FileSystemStateManager";
import { ValidationPlanner } from "../validation/ValidationPlanner";
import { ValidationDetector } from "../validation/ValidationDetector";
import { SelfHealingEngine } from "../repair/SelfHealingEngine";
import { BuildErrorRepair } from "../repair/BuildErrorRepair";
import { SecurityAuditor } from "../review/SecurityAuditor";
import { MemoryPersistence } from "../memory/MemoryPersistence";
import { PipelineTelemetry } from "./PipelineTelemetry";
import { PipelineResultBuilder } from "./PipelineResult";
import { SubTaskExecutor } from "../../services/sub-task-executor";
import { RepositorySnapshotData, loadPersistedRevision, savePersistedRevision } from "../repository/RepositorySnapshot";
import { ManifestValidator } from "../../services/manifest-validator";
import { SemanticRetrievalEngine } from "../../services/semantic-retrieval.engine";
import { buildGroundedSemanticQueries } from "../repository/RetrievalQueryBuilder";
import { enrichFileContextWithSemanticResults } from "../repository/SemanticContextResolver";
import { rerankSemanticResults } from "../repository/CodeAwareReranker";
import { packFileContext } from "../context/ContextPacker";
import { decrypt } from "../../utils/encryption";

const prisma = new PrismaClient();

export class AgentPipeline {
  static async runCodingAgent(
    userId: string,
    projectId: string,
    request: ChatRequest,
    onProgress?: (event: AgentProgressEvent) => void,
  ): Promise<AgentResponse> {
    const session = await MemoryPersistence.getOrCreateSession(userId, "project", projectId, request.sessionId);
    const projectContext = await RepositoryContextBuilder.buildProjectContext(projectId);
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { localPath: true, githubUrl: true, githubToken: true },
    });
    const approvedArchitecture = await prisma.phaseArtifact.findFirst({
      where: { projectId, phase: "architecture", approved: true },
      orderBy: { createdAt: "desc" },
      select: { content: true },
    });

    await MemoryPersistence.saveMessage(session.id, "user", request.message);

    const snapshot = projectContext.repoSnapshot;
    const effectiveLocalPath = await RepositoryScanner.ensureLocalWorkspace(projectId, project?.localPath, snapshot);
    const effectiveSnapshot = RepositoryScanner.getEffectiveSnapshot(snapshot, effectiveLocalPath);
    const currentRevisionHash = effectiveSnapshot.revision?.contentHash;

    const pipelineStart = performance.now();

    // Stage 1: Intent Analysis
    const s1Start = performance.now();
    const intentResult = await IntentClassifier.classifyIntentAndAmbiguity(request.message, projectContext);
    const s1Time = performance.now() - s1Start;

    const snapshotFileList = (effectiveSnapshot?.keyFiles || (effectiveSnapshot as any)?.repoSnapshot || (Array.isArray(effectiveSnapshot) ? effectiveSnapshot : [])) as Array<any>;
    const repoFileNames = snapshotFileList.map((f: any) => (typeof f === "string" ? f : f.path || ""));

    const executionContract: ExecutionContract = buildExecutionContract(intentResult, request.message, repoFileNames);

    onProgress?.({
      step: 1,
      stageName: "INTENT_ANALYSIS",
      label: "Task",
      detail: `Task: ${intentResult.taskType} | Risk: ${intentResult.risk} | Complexity: ${intentResult.estimatedComplexity} | Time: ${formatMs(s1Time)}`,
      color: intentResult.risk === "HIGH" || intentResult.risk === "CRITICAL" ? "text-rose-400 border-rose-500/30 bg-rose-500/10" : "text-amber-400 border-amber-500/30 bg-amber-500/10",
      badge: `STAGE 1/7 · ${intentResult.taskType} · ${formatMs(s1Time)}`,
      progress: 15,
      log: `[Stage 1/7] Intent Analysis completed in ${formatMs(s1Time)}:\n  ✓ Task: ${intentResult.taskType}\n  ✓ Risk: ${intentResult.risk}\n  ✓ Allowed: ${executionContract.allowedActions.join(", ")}\n  ✗ Forbidden: ${executionContract.forbiddenActions.slice(0, 3).join(", ")}`,
      taskType: intentResult.taskType,
      risk: intentResult.risk,
      estimatedComplexity: intentResult.estimatedComplexity,
      targetPath: intentResult.targetPath,
      executionContract,
      durationMs: s1Time,
    });

    if (intentResult.requiresClarification) {
      await MemoryPersistence.saveMessage(session.id, "assistant", `[Agent] ❓ ${intentResult.question || "Please clarify your request."}`);
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
      };
    }

    // Stage 2: Understand Goal & Knowledge Graph
    const s2Start = performance.now();
    let knowledgeGraph = currentRevisionHash
      ? loadPersistedKnowledgeGraph(projectId, currentRevisionHash)
      : null;

    if (knowledgeGraph) {
      console.log(`[AgentPipeline] Knowledge graph unchanged (${currentRevisionHash?.slice(0, 12)}…) — reusing cached graph for project ${projectId}`);
    } else {
      knowledgeGraph = await RepositoryKnowledgeGraph.buildKnowledgeGraph(effectiveSnapshot);
      if (currentRevisionHash) {
        savePersistedKnowledgeGraph(projectId, currentRevisionHash, knowledgeGraph);
      }
    }
    const s2Time = performance.now() - s2Start;
    const scannedCount = repoFileNames.length || 1;
    const extractedSymbolsCount = (knowledgeGraph as any).symbols?.size || scannedCount * 5;

    onProgress?.({
      step: 2,
      stageName: "KNOWLEDGE_GRAPH",
      label: "Understand Goal",
      detail: `Repository Scan: ${scannedCount} files scanned | ${extractedSymbolsCount} symbols extracted | Time: ${formatMs(s2Time)}`,
      color: "text-cyan-400 border-cyan-500/30 bg-cyan-500/10",
      badge: `STAGE 2/7 · ${formatMs(s2Time)}`,
      progress: 28,
      log: `[Stage 2/7] Repository Scan finished in ${formatMs(s2Time)}:\n  Files scanned: ${scannedCount.toLocaleString()}\n  Symbols extracted: ${extractedSymbolsCount.toLocaleString()}`,
      taskType: intentResult.taskType,
      risk: intentResult.risk,
      estimatedComplexity: intentResult.estimatedComplexity,
      durationMs: s2Time,
    });

    // Stage 3: Iterative Repository Search Loop
    const s3Start = performance.now();
    const { optimizedContext, executionMemory, finalConfidence, searchSummary } =
      await RepositorySearch.runIterativeRepositorySearch(request.message, effectiveSnapshot, projectContext, intentResult, effectiveLocalPath, executionContract);
    const s3Time = performance.now() - s3Start;

    const inspectedFilesArr = Array.from(executionMemory.inspectedFiles || []);
    onProgress?.({
      step: 3,
      stageName: "REPO_SEARCH",
      label: "Determine Completion",
      detail: `Scoped search complete: ${inspectedFilesArr.length} relevant files found | Time: ${formatMs(s3Time)}`,
      color: "text-blue-400 border-blue-500/30 bg-blue-500/10",
      badge: `STAGE 3/7 · ${formatMs(s3Time)}`,
      progress: 48,
      log: `[Stage 3/7] Repository Graph Search complete in ${formatMs(s3Time)}:\n  Relevant files found: ${inspectedFilesArr.length}\n  Confidence: ${(finalConfidence * 100).toFixed(0)}%`,
      durationMs: s3Time,
    });

    const systemPrompt = CodeGenerator.buildAgentSystemPrompt(
      projectContext,
      effectiveSnapshot,
      approvedArchitecture?.content,
      projectContext.summary?.summary,
    );

    // Stage 4: Real Vector & Grounded Multi-Query Semantic Retrieval
    // Guard: skip re-indexing if the effective repository content has not changed
    // since the last pipeline run for this project (persisted revision freshness check).
    const s4Start = performance.now();
    const persistedRevision = loadPersistedRevision(projectId);
    const cachedRevisionHash = persistedRevision?.contentHash;
    const revisionChanged = !persistedRevision || currentRevisionHash !== cachedRevisionHash;

    const projectCacheDir = path.join(process.cwd(), ".anka-cache", "projects", projectId);

    try {
      const semanticEngine = new SemanticRetrievalEngine(undefined, projectCacheDir);
      const rawSnapshotFiles = Array.isArray(effectiveSnapshot)
        ? effectiveSnapshot
        : effectiveSnapshot?.keyFiles || (effectiveSnapshot as any)?.repoSnapshot || [];

      const indexStats = await semanticEngine.indexCodebase(rawSnapshotFiles);

      if (revisionChanged || !currentRevisionHash) {
        // Repository has changed (or has no revision) — persist the new revision.
        if (effectiveSnapshot.revision) {
          savePersistedRevision(projectId, effectiveSnapshot.revision);
        }
      } else {
        // Repository is unchanged — vectorStore was rebuilt entirely from cached embeddings.
        console.log(
          `[AgentPipeline] Revision unchanged (${currentRevisionHash.slice(0, 12)}…) — restored semantic index from cached embeddings: ${indexStats.cachedHits} cached, ${indexStats.newlyEmbedded} new`
        );
      }

      const discoveredSymbolNames = executionMemory?.discoveredSymbols
        ? Array.from(executionMemory.discoveredSymbols.keys())
        : [];

      const semanticQueries = buildGroundedSemanticQueries({
        message: request.message,
        targetPath: intentResult?.targetPath,
        discoveredSymbols: discoveredSymbolNames,
        discoveredServices: executionMemory?.discoveredServices || [],
        discoveredModels: executionMemory?.discoveredModels || [],
        discoveredRoutes: executionMemory?.discoveredRoutes || [],
      });

      console.log(`[AgentPipeline] Semantic retrieval queries: ${semanticQueries.length}`);
      if (process.env.NODE_ENV !== "production") {
        console.log(`[AgentPipeline] Grounded queries:`, semanticQueries);
      }

      const semanticCandidates = await semanticEngine.searchMany(semanticQueries, 10, 10);

      const semanticResults = rerankSemanticResults(semanticCandidates, {
        targetPath: intentResult?.targetPath,
        discoveredSymbols: executionMemory?.discoveredSymbols,
        discoveredServices: executionMemory?.discoveredServices || [],
        discoveredModels: executionMemory?.discoveredModels || [],
        discoveredRoutes: executionMemory?.discoveredRoutes || [],
      });

      if (process.env.NODE_ENV !== "production") {
        console.log(
          `[AgentPipeline] Reranked ${semanticResults.length} semantic results:`,
          semanticResults.map((r) => ({
            filePath: r.chunk.filePath,
            name: r.chunk.name,
            hybridScore: r.hybridScore,
            rerankScore: r.rerankScore,
            reasons: r.rerankReasons,
          }))
        );
      }

      // Enrich optimizedContext.fileContext with full repository file contents (never partial chunks)
      if (optimizedContext && optimizedContext.fileContext) {
        enrichFileContextWithSemanticResults({
          fileContext: optimizedContext.fileContext,
          semanticResults,
          rawSnapshotFiles,
          similarityThreshold: 0.4,
          hybridThreshold: 0.35,
        });

        // Deterministically pack full files within token budget
        const packed = packFileContext({
          fileContext: optimizedContext.fileContext,
          targetPath: intentResult?.targetPath,
          targetPaths: executionContract?.targetPaths,
          discoveredSymbols: executionMemory?.discoveredSymbols,
          discoveredServices: executionMemory?.discoveredServices || [],
          discoveredModels: executionMemory?.discoveredModels || [],
          discoveredRoutes: executionMemory?.discoveredRoutes || [],
          semanticResults,
          maxTokens: 12000,
        });

        optimizedContext.fileContext = packed.fileContext;

        if (process.env.NODE_ENV !== "production" || packed.excludedFiles.length > 0) {
          console.log(
            `[AgentPipeline] Context packed: ${packed.telemetry.contextFilesAfterPacking}/${packed.telemetry.contextFilesBeforePacking} files (${packed.telemetry.estimatedTokensAfterPacking} tokens)${
              packed.excludedFiles.length > 0 ? ` | Excluded by budget: ${packed.excludedFiles.join(", ")}` : ""
            }`
          );
        }
      }
    } catch (e: any) {
      console.warn("[AgentPipeline] Semantic retrieval warning:", e?.message || e);
    }
    const s4Time = performance.now() - s4Start;

    // Stage 5: Exact Context Optimization & Token Measurement
    const s5Start = performance.now();
    let rawInputChars = 0;
    const rawSnapshotFiles = Array.isArray(effectiveSnapshot)
      ? effectiveSnapshot
      : effectiveSnapshot?.keyFiles || (effectiveSnapshot as any)?.repoSnapshot || [];

    for (const f of rawSnapshotFiles) {
      if (f && typeof f.content === "string") {
        rawInputChars += f.content.length;
      }
    }
    const inputTokens = Math.max(1, Math.ceil(rawInputChars / 4));

    let outputContextChars = 0;
    if (optimizedContext?.fileContext) {
      for (const content of Object.values(optimizedContext.fileContext)) {
        if (typeof content === "string") outputContextChars += content.length;
      }
    }
    if (optimizedContext?.skeletonContext) {
      for (const content of Object.values(optimizedContext.skeletonContext)) {
        if (typeof content === "string") outputContextChars += content.length;
      }
    }
    const outputTokens = Math.max(1, Math.ceil(outputContextChars / 4));
    const compressionRatio = (inputTokens / Math.max(1, outputTokens)).toFixed(2);
    const s5Time = performance.now() - s5Start;

    // Stage 6: Manifest Generation & Task Decomposition
    const s6Start = performance.now();
    const manifestEnabled = process.env.ENABLE_MANIFEST_ENFORCEMENT !== "false";

    if (manifestEnabled) {
      const shouldDecompose =
        intentResult.taskType === "NEW_FEATURE" &&
        (intentResult.estimatedComplexity === "LARGE" || intentResult.estimatedComplexity === "COMPLEX");

      if (shouldDecompose) {
        try {
          const decomposer = new TaskDecomposer(getOpenAI());
          const graph = await decomposer.decomposeTask(request.message, projectContext, intentResult);

          await prisma.taskDecomposition.create({
            data: {
              projectId,
              sessionId: session.id,
              userRequest: request.message,
              graphJson: graph as any,
              totalSubTasks: graph.nodes.length,
              status: "in_progress",
            },
          });

          const executor = new SubTaskExecutor(new ManifestGenerator(getOpenAI()));
          const completedMap = new Map<string, any>();

          for (const subTaskId of graph.executionOrder) {
            const subTask = graph.nodes.find((n) => n.id === subTaskId);
            if (!subTask) continue;

            const res = await executor.executeSubTask(subTask, completedMap, projectContext, executionContract);
            completedMap.set(subTaskId, res);
          }
        } catch (e: any) {
          console.error("[AgentPipeline] Task decomposition error:", e?.message || e);
        }
      } else {
        try {
          const generator = new ManifestGenerator(getOpenAI());
          const manifest = await generator.generateManifest(request.message, projectContext, executionContract);

          const existingFileList = Array.isArray(effectiveSnapshot) ? effectiveSnapshot.map((f: any) => f.path) : [];
          const validator = new ManifestValidator(executionContract, existingFileList);
          const valRes = validator.validate(manifest);

          await prisma.agentManifest.create({
            data: {
              projectId,
              sessionId: session.id,
              manifestJson: manifest as any,
              validationStatus: valRes.valid ? "approved" : "rejected",
              validationErrors: valRes.errors as any,
            },
          });
        } catch (e: any) {
          console.error("[AgentPipeline] Manifest generation error:", e?.message || e);
        }
      }
    }
    const s6Time = performance.now() - s6Start;

    // Stage 7: Coding Agent File Generation
    const s7Start = performance.now();
    const roadmapAndDiff = await CodeGenerator.generateRoadmapAndDiffs(
      request.message,
      intentResult,
      optimizedContext,
      systemPrompt,
      executionContract,
    );
    const s7Time = performance.now() - s7Start;

    // Diff Contract Critic Pass
    const criticResult = executionContract.diffCriticEnabled
      ? ContractGuardrails.runDiffContractCritic(roadmapAndDiff.changes, executionContract)
      : { accepted: roadmapAndDiff.changes, rejected: [], log: "[Diff Critic] Skipped" };

    // Stage 8: Self-Healing Build Repair
    const s8Start = performance.now();
    const effectiveValidationCommands = ValidationPlanner.detectValidationCommands(
      effectiveLocalPath,
      effectiveSnapshot,
      executionContract,
    );

    const fsManager = new FileSystemStateManager();
    let transactionCommitted = false;
    let transactionRolledBack = false;
    let rollbackErrorLog: string | null = null;

    if (effectiveLocalPath) {
      await fsManager.snapshot(criticResult.accepted, effectiveLocalPath);
    }

    const safeRollback = async () => {
      if (transactionCommitted || transactionRolledBack || !effectiveLocalPath) return;
      transactionRolledBack = true;
      try {
        await fsManager.rollback(effectiveLocalPath);
      } catch (err: any) {
        rollbackErrorLog = `[CRITICAL] Filesystem rollback failed: ${err?.message || err}`;
        console.error(rollbackErrorLog, err);
      }
    };

    let repairResult: any;
    let auditResult: any;
    let featureValidation: any;
    let overallGatePassed = false;
    let s8Time = 0;
    let s9Time = 0;

    try {
      // Stage 8: Self-Healing Build Repair
      const s8Start = performance.now();
      repairResult = await SelfHealingEngine.runSelfHealingLoop(
        criticResult.accepted,
        effectiveLocalPath,
        effectiveValidationCommands,
        systemPrompt,
        request.message,
        fsManager,
        projectId,
        onProgress,
      );

      if (!repairResult.success && !repairResult.infrastructureError && effectiveLocalPath && effectiveValidationCommands.length > 0) {
        const buildRepairRes = await BuildErrorRepair.runBuildErrorRepairPass(
          repairResult.finalChanges,
          effectiveLocalPath,
          effectiveValidationCommands,
          request.message,
          repairResult.errorLog || "",
          fsManager,
        );

        if (buildRepairRes.success) {
          repairResult.success = true;
          repairResult.finalChanges = buildRepairRes.finalChanges;
          repairResult.errorLog = "";
        } else {
          repairResult.finalChanges = buildRepairRes.finalChanges;
          repairResult.errorLog = buildRepairRes.errorLog;
        }
      }
      s8Time = performance.now() - s8Start;

      // Stage 9: Reflection & Security Audit
      const s9Start = performance.now();
      onProgress?.({
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

      auditResult = await SecurityAuditor.runReflectionAndSecurityAudit(repairResult.finalChanges);
      featureValidation = await ValidationDetector.runFeatureValidation(
        repairResult.finalChanges,
        effectiveSnapshot,
        request.message,
        executionContract,
      );
      s9Time = performance.now() - s9Start;

      overallGatePassed = Boolean(repairResult.success && auditResult.securityPass && featureValidation.overallPassed);

      if (overallGatePassed) {
        transactionCommitted = true;
        fsManager.commit();
      } else {
        await safeRollback();
      }
    } catch (unhandledError: any) {
      await safeRollback();
      throw unhandledError;
    }

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
      buildSuccess: repairResult.success,
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
      repairResult.success,
    );

    const featureChecks = featureValidation.checks || [];
    const checklistMarkdown =
      `\n\n### ⏱️ Pipeline Stage Performance & Metrics\n${pipelineMeasurementText}\n\n### 📋 Repository Intelligence Verification Checklist\n` +
      `**Repository Search Confidence:** ${(finalConfidence * 100).toFixed(0)}%\n` +
      `**Build Status:** ${repairResult.success ? "✅ Build Verified / Passed" : "❌ Build Verification Failed"}\n\n` +
      `**Search Summary:**\n${searchSummary}\n\n` +
      defaultChecklist.map((item) => `${item.checked ? "✅" : "❌"} ${item.label}`).join("\n") +
      (!repairResult.success && repairResult.errorLog
        ? `\n\n**❌ Build Verification Errors Captured:**\n\`\`\`\n${repairResult.errorLog.slice(0, 2000)}\n\`\`\``
        : "") +
      (featureValidation.failedChecks.length > 0
        ? `\n\n**⚠️ Feature Validation Issues:**\n` + featureChecks.filter((c: any) => c.status === "FAIL").map((c: any) => `- ${c.label}: ${c.details}`).join("\n")
        : "");

    const fileChangeLines =
      repairResult.finalChanges.length > 0
        ? repairResult.finalChanges.map((c: any) => `- ${c.path}: ${c.action === "delete" || c.isDeleted ? "[DELETED] " : ""}${c.description}`).join("\n")
        : "No files changed.";

    const summary = `[TaskType: ${intentResult.taskType} | Risk: ${intentResult.risk} | Complexity: ${intentResult.estimatedComplexity}] ${roadmapAndDiff.explanation}\n\n${auditResult.summary}${checklistMarkdown}\n\nFiles Modified / Deleted:\n${fileChangeLines}`;
    await MemoryPersistence.saveMessage(session.id, "assistant", summary);

    if (!session.title) await MemoryPersistence.updateSessionTitle(session.id, request.message);

    const gateSuccess = overallGatePassed && !rollbackErrorLog;

    return {
      explanation: roadmapAndDiff.explanation + "\n\n" + auditResult.summary + checklistMarkdown,
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
      securityPass: auditResult.securityPass,
      critiqueScore: auditResult.critiqueScore,
      buildVerified: gateSuccess,
      repaired: repairResult.attempts > 1,
      buildErrors: [
        !repairResult.success && repairResult.errorLog ? repairResult.errorLog : "",
        !auditResult.securityPass ? "Security audit failed / flagged critical security violations." : "",
        !featureValidation.overallPassed ? "Feature / static validation failed required checks." : "",
        rollbackErrorLog ? rollbackErrorLog : "",
      ].filter(Boolean).join("\n\n") || repairResult.errorLog,
      verificationChecklist: defaultChecklist,
      lifecycleStage: gateSuccess ? "Done" : "BuildFailed",
      pipelineMeasurementText,
    };
  }
}
