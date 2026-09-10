import { PrismaClient } from "@prisma/client";
import fs from "fs";
import path from "path";
import { ChatRequest, ExtendedKnowledgeGraph, ProjectContext } from "../shared/types";
import { RepositoryContextBuilder } from "../repository/RepositoryContextBuilder";
import { RepositoryScanner } from "../repository/RepositoryScanner";
import { RepositorySnapshotData } from "../repository/RepositorySnapshot";
import { MonorepoDescriptor, MonorepoDetector, SnapshotFileInput } from "../workspace/MonorepoDetector";
import { AgentProgressEvent, ExecutionContract, BaselineDiagnostic } from "../shared/types";
import { TaskClassificationResult } from "../classification/TaskTypes";
import { PolicyContract } from "../contracts/PolicyContract";
import { TaskIntentSpec } from "../shared/TaskIntentSpec";
import { RepositoryEvidenceStore } from "../repository/RepositoryEvidenceStore";
import { RepositoryKnowledgeGraph, loadPersistedKnowledgeGraph, savePersistedKnowledgeGraph } from "../repository/RepositoryKnowledgeGraph";
import { RepositorySearch } from "../repository/RepositorySearch";
import { SemanticRetrievalEngine, SemanticSearchResult } from "../../services/semantic-retrieval.engine";
import { buildGroundedSemanticQueries } from "../repository/RetrievalQueryBuilder";
import { enrichFileContextWithSemanticResults } from "../repository/SemanticContextResolver";
import { rerankSemanticResults, RerankedSemanticResult } from "../repository/CodeAwareReranker";
import { ContextPackerResult, packFileContext } from "../context/ContextPacker";
import { loadPersistedRevision, savePersistedRevision } from "../repository/RepositorySnapshot";
import { CodeGenerator } from "../generation/CodeGenerator";
import { formatMs } from "../shared/utils";

const prisma = new PrismaClient();

export interface RepositoryObservationOptions {
  effectiveLocalPath?: string;
}

export interface RepositoryProjectFacts {
  projectContext: ProjectContext;
  project: {
    localPath: string | null;
    githubUrl: string | null;
    githubToken: string | null;
  } | null;
  approvedArchitecture: { content: string } | null;
  snapshot: ProjectContext["repoSnapshot"];
}

export interface RepositoryObservation extends RepositoryProjectFacts {
  effectiveLocalPath: string | null;
  effectiveSnapshot: RepositorySnapshotData;
  currentRevisionHash: string | undefined;
  snapshotFileList: SnapshotFileInput[];
  repoFileNames: string[];
  canonicalExistingFiles: string[];
  monorepo: MonorepoDescriptor;
}

export interface RepositoryContextAssemblyInput {
  projectId: string;
  effectiveGoal: string;
  requestMessage: string;
  projectContext: ProjectContext;
  effectiveSnapshot: RepositorySnapshotData;
  effectiveLocalPath: string | null;
  currentRevisionHash?: string;
  repoFileNames: string[];
  snapshotFileList: SnapshotFileInput[];
  intentResult: TaskClassificationResult;
  policyContract: PolicyContract;
  taskIntentSpec: TaskIntentSpec;
  evidenceStore: RepositoryEvidenceStore;
  approvedArchitecture: { content: string } | null;
  diagnosticTargetPaths: string[];
  baselineDiagnosticsList: BaselineDiagnostic[];
  executionContract: ExecutionContract;
  onProgress?: (event: AgentProgressEvent) => void;
}

export interface RepositoryContextAssemblyResult {
  knowledgeGraph: ExtendedKnowledgeGraph;
  optimizedContext: Awaited<ReturnType<typeof RepositorySearch.runIterativeRepositorySearch>>["optimizedContext"];
  systemPrompt: string;
  rawSnapshotFiles: SnapshotFileInput[];
  finalConfidence: number;
  searchSummary: string;
  inspectedFiles: string[];
  scannedCount: number;
  extractedSymbolsCount: number;
  inputTokens: number;
  outputTokens: number;
  compressionRatio: string;
  stage2DurationMs: number;
  stage3DurationMs: number;
  stage4DurationMs: number;
  stage5DurationMs: number;
}

/** Collects materialized repository facts. It grants no mutation or model authority. */
export class RepositoryObserver {
  public static async loadProjectFacts(projectId: string): Promise<RepositoryProjectFacts> {
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
    return { projectContext, project, approvedArchitecture, snapshot: projectContext.repoSnapshot };
  }

  public static async observe(
    projectId: string,
    request: ChatRequest,
    facts: RepositoryProjectFacts,
    options?: RepositoryObservationOptions,
  ): Promise<RepositoryObservation> {
    const { projectContext, project, approvedArchitecture, snapshot } = facts;
    const requestContext = request.context as { effectiveLocalPath?: string } | undefined;
    const requestedPath = options?.effectiveLocalPath || requestContext?.effectiveLocalPath || project?.localPath;
    console.log(`[ANKA_EXEC] AgentPipeline starting, localPath=${requestedPath || "none"}`);
    const effectiveLocalPath = await RepositoryScanner.ensureLocalWorkspace(projectId, requestedPath, snapshot);
    const effectiveSnapshot = RepositoryScanner.getEffectiveSnapshot(snapshot, effectiveLocalPath);
    const currentRevisionHash = effectiveSnapshot.revision?.contentHash;

    const effectiveValue = effectiveSnapshot as unknown;
    const effectiveRecord = effectiveValue && typeof effectiveValue === "object" && !Array.isArray(effectiveValue)
      ? effectiveValue as Record<string, unknown>
      : {};
    const rawSnapshotEntries = Array.isArray(effectiveRecord.keyFiles)
      ? effectiveRecord.keyFiles
      : Array.isArray(effectiveRecord.repoSnapshot)
      ? effectiveRecord.repoSnapshot
      : Array.isArray(effectiveValue)
      ? effectiveValue
      : [];
    const snapshotFileList: SnapshotFileInput[] = rawSnapshotEntries
      .map((entry: unknown) => typeof entry === "string"
        ? { path: entry }
        : entry && typeof entry === "object" && typeof (entry as { path?: unknown }).path === "string"
        ? entry as SnapshotFileInput
        : null)
      .filter((entry: SnapshotFileInput | null): entry is SnapshotFileInput => entry !== null);
    const repoFileNames = snapshotFileList.map((file) => file.path || "");
    const fileTree = Array.isArray(effectiveRecord.fileTree)
      ? effectiveRecord.fileTree.filter((file): file is string => typeof file === "string")
      : [];
    const rawCandidateFiles = fileTree.length > 0 ? fileTree : repoFileNames;
    const canonicalExistingFiles = Array.from(new Set(
      rawCandidateFiles
        .filter((file) => typeof file === "string" && file.trim().length > 0)
        .map((file) => file.replace(/\\/g, "/").replace(/^\.\//, "")),
    ));

    const monorepo = MonorepoDetector.detectMonorepo(effectiveLocalPath, snapshotFileList);
    if (monorepo.isMonorepo) {
      console.log(
        `[AgentPipeline] Detected monorepo (type=${monorepo.type}, pm=${monorepo.packageManager}, workspaces=${monorepo.workspaces.length}, turbo=${monorepo.hasTurbo})`,
      );
    }

    return {
      projectContext,
      project,
      approvedArchitecture,
      snapshot,
      effectiveLocalPath,
      effectiveSnapshot,
      currentRevisionHash,
      snapshotFileList,
      repoFileNames,
      canonicalExistingFiles,
      monorepo,
    };
  }

  public static async assembleContext(
    input: RepositoryContextAssemblyInput,
  ): Promise<RepositoryContextAssemblyResult> {
    const {
      projectId,
      effectiveGoal,
      requestMessage,
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
    } = input;

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
    const graphWithLegacySymbols = knowledgeGraph as ExtendedKnowledgeGraph & {
      symbols?: { size?: number };
    };
    const extractedSymbolsCount = graphWithLegacySymbols.symbols?.size || scannedCount * 5;

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
      await RepositorySearch.runIterativeRepositorySearch(
        effectiveGoal,
        effectiveSnapshot,
        projectContext,
        intentResult,
        effectiveLocalPath,
        policyContract,
        taskIntentSpec,
        evidenceStore
      );
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

    let candidateChunks: SemanticSearchResult[] = [];
    let rerankedResultsList: RerankedSemanticResult[] = [];
    let packedTelemetry: ContextPackerResult | null = null;
    let usedProviderName = "local_deterministic";

    try {
      const semanticEngine = new SemanticRetrievalEngine(undefined, projectCacheDir);
      usedProviderName = semanticEngine.providerName;
      const rawSnapshotFiles = snapshotFileList;

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
        message: requestMessage,
        targetPath: intentResult?.targetPath || diagnosticTargetPaths[0],
        discoveredSymbols: discoveredSymbolNames,
        discoveredServices: executionMemory?.discoveredServices || [],
        discoveredModels: executionMemory?.discoveredModels || [],
        discoveredRoutes: executionMemory?.discoveredRoutes || [],
        baselineDiagnostics: baselineDiagnosticsList,
      });

      console.log(`[AgentPipeline] Semantic retrieval queries: ${semanticQueries.length}`);
      if (process.env.NODE_ENV !== "production") {
        console.log(`[AgentPipeline] Grounded queries:`, semanticQueries);
      }

      const semanticCandidates = await semanticEngine.searchMany(semanticQueries, 10, 10);
      candidateChunks = semanticCandidates;

      const semanticResults = rerankSemanticResults(semanticCandidates, {
        targetPath: intentResult?.targetPath || diagnosticTargetPaths[0],
        discoveredSymbols: executionMemory?.discoveredSymbols,
        discoveredServices: executionMemory?.discoveredServices || [],
        discoveredModels: executionMemory?.discoveredModels || [],
        discoveredRoutes: executionMemory?.discoveredRoutes || [],
      });
      rerankedResultsList = semanticResults;

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

      // Semantic retrieval is context-only per Requirement 15 (never authorizes writes or expands targetPaths)

      // Enrich optimizedContext.fileContext with full repository file contents (never partial chunks)
      if (optimizedContext && optimizedContext.fileContext) {
        // Ensure proven compiler diagnostic target files are deterministically loaded into fileContext
        if (diagnosticTargetPaths.length > 0) {
          for (const diagPath of diagnosticTargetPaths) {
            if (!optimizedContext.fileContext[diagPath]) {
              const snap = rawSnapshotFiles.find(
                (file) => file.path?.replace(/\\/g, "/").replace(/^\.\//, "") === diagPath
              );
              if (snap && typeof snap.content === "string") {
                optimizedContext.fileContext[diagPath] = snap.content;
              } else if (effectiveLocalPath) {
                const abs = path.join(effectiveLocalPath, diagPath);
                if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
                  try {
                    optimizedContext.fileContext[diagPath] = fs.readFileSync(abs, "utf8");
                  } catch { }
                }
              }
            }
          }
        }

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
          targetPath: intentResult?.targetPath || diagnosticTargetPaths[0],
          targetPaths: executionContract?.targetPaths,
          discoveredSymbols: executionMemory?.discoveredSymbols,
          discoveredServices: executionMemory?.discoveredServices || [],
          discoveredModels: executionMemory?.discoveredModels || [],
          discoveredRoutes: executionMemory?.discoveredRoutes || [],
          semanticResults,
          maxTokens: 12000,
        });

        packedTelemetry = packed;
        optimizedContext.fileContext = packed.fileContext;

        if (process.env.NODE_ENV !== "production" || packed.excludedFiles.length > 0) {
          console.log(
            `[AgentPipeline] Context packed: ${packed.telemetry.contextFilesAfterPacking}/${packed.telemetry.contextFilesBeforePacking} files (${packed.telemetry.estimatedTokensAfterPacking} tokens)${packed.excludedFiles.length > 0 ? ` | Excluded by budget: ${packed.excludedFiles.join(", ")}` : ""
            }`
          );
        }
      }
    } catch (error: unknown) {
      console.warn(
        "[AgentPipeline] Semantic retrieval warning:",
        error instanceof Error ? error.message : String(error),
      );
    }
    const s4Time = performance.now() - s4Start;

    onProgress?.({
      step: 4,
      stageName: "SEMANTIC_RETRIEVAL",
      label: "Semantic Retrieval & Reranking",
      detail: `Reranked ${rerankedResultsList.length} chunks | Packed ${packedTelemetry?.telemetry?.contextFilesAfterPacking || Object.keys(optimizedContext?.fileContext || {}).length} files | Time: ${formatMs(s4Time)}`,
      color: "text-indigo-400 border-indigo-500/30 bg-indigo-500/10",
      badge: `STAGE 4 · ${formatMs(s4Time)}`,
      progress: 55,
      log: `[Stage 4] Semantic Retrieval complete:\n  Candidate chunks: ${candidateChunks.length}\n  Reranked results: ${rerankedResultsList.length}\n  Provider: ${usedProviderName}`,
      durationMs: s4Time,
      stageMetrics: {
        embeddingProvider: usedProviderName,
        rawSemanticCandidates: candidateChunks.map((c) => ({
          filePath: c.chunk?.filePath || "",
          name: c.chunk?.name || "",
          similarity: c.similarityScore,
          keywordScore: c.keywordScore,
          hybridScore: c.hybridScore,
        })),
        rawRankedFiles: Array.from(new Set(candidateChunks.map((c) => c.chunk?.filePath).filter(Boolean))),
        rerankedResults: rerankedResultsList.map((r) => ({
          filePath: r.chunk?.filePath || "",
          name: r.chunk?.name || "",
          hybridScore: r.hybridScore,
          rerankScore: r.rerankScore,
          reasons: r.rerankReasons,
        })),
        rerankedFiles: Array.from(new Set(rerankedResultsList.map((r) => r.chunk?.filePath).filter(Boolean))),
        includedFiles: packedTelemetry?.includedFiles || Object.keys(optimizedContext?.fileContext || {}),
        excludedFiles: packedTelemetry?.excludedFiles || [],
      },
    });

    // Stage 5: Exact Context Optimization & Token Measurement
    const s5Start = performance.now();
    let rawInputChars = 0;
    const rawSnapshotFiles = snapshotFileList;

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


    return {
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
    };
  }
}
