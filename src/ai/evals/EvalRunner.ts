import fs from "fs";
import path from "path";
import os from "os";
import { exec } from "child_process";
import { promisify } from "util";
import {
  AgentEvalCase,
  EvalCaseResult,
  EvalFailureStage,
  EvalMode,
  EvalSuiteSummary,
  FilesystemDiffResult,
  RagEvalMetrics,
  RankingMetrics,
} from "./types";
import { AgentPipeline } from "../orchestration/AgentPipeline";
import { AgentProgressEvent, ChatRequest } from "../shared/types";
import { RepositoryScanner } from "../repository/RepositoryScanner";
import { sha256 } from "../validation/FileVersionGuard";
import { normalizeRepoPath } from "../repository/SemanticContextResolver";
import { ModelObserver } from "./ModelObserver";
import { EvalDatabaseFixture, ProvisionedEvalContext } from "./EvalDatabaseFixture";

declare const jest: any;

const execAsync = promisify(exec);

// ─── Git Commit Detection ───────────────────────────────────────────────────

/**
 * Retrieves the current Git commit SHA, or null if Git metadata is unavailable.
 */
export async function getGitCommitSha(): Promise<string | null> {
  try {
    const { stdout } = await execAsync("git rev-parse HEAD", { timeout: 5000 });
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

// ─── Filesystem Snapshot & Diff ──────────────────────────────────────────────

/**
 * Scans a directory recursively and returns a map of normalized relative paths to SHA-256 hashes.
 */
export function captureFilesystemSnapshot(dir: string): Map<string, string> {
  const snapshot = new Map<string, string>();
  if (!fs.existsSync(dir)) return snapshot;

  function scan(currentDir: string) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relPath = normalizeRepoPath(path.relative(dir, fullPath));

      if (
        entry.name === ".git" ||
        entry.name === "node_modules" ||
        entry.name === ".anka-cache"
      ) {
        continue;
      }

      if (entry.isDirectory()) {
        scan(fullPath);
      } else if (entry.isFile()) {
        try {
          const content = fs.readFileSync(fullPath, "utf8");
          snapshot.set(relPath, sha256(content));
        } catch {
          // Unreadable file
        }
      }
    }
  }

  scan(dir);
  return snapshot;
}

/**
 * Compares two filesystem snapshots and produces a structured diff.
 */
export function computeFilesystemDiff(
  before: Map<string, string>,
  after: Map<string, string>,
): FilesystemDiffResult {
  const modifiedFiles: string[] = [];
  const createdFiles: string[] = [];
  const deletedFiles: string[] = [];

  // Check for modified and deleted files
  for (const [relPath, beforeHash] of before.entries()) {
    if (!after.has(relPath)) {
      deletedFiles.push(relPath);
    } else {
      const afterHash = after.get(relPath);
      if (afterHash !== beforeHash) {
        modifiedFiles.push(relPath);
      }
    }
  }

  // Check for created files
  for (const relPath of after.keys()) {
    if (!before.has(relPath)) {
      createdFiles.push(relPath);
    }
  }

  const allChangedFiles = [...modifiedFiles, ...createdFiles, ...deletedFiles].sort();
  return {
    modifiedFiles: modifiedFiles.sort(),
    createdFiles: createdFiles.sort(),
    deletedFiles: deletedFiles.sort(),
    allChangedFiles,
  };
}

// ─── Failure Stage Classification ───────────────────────────────────────────

/**
 * Classifies the exact pipeline stage where a task failed.
 */
export function classifyFailureStage(
  taskSuccess: boolean,
  unauthorizedFiles: string[],
  missingRequired: string[],
  validationPassed: boolean,
  contentRulesPassed: boolean,
  agentResponse?: any,
  safeRejectionCode?: string,
): EvalFailureStage | undefined {
  if (taskSuccess) return undefined;

  if (agentResponse?.infrastructureError) return "INFRASTRUCTURE";
  if (safeRejectionCode === "STALE_SOURCE_FILE") return "STALE_STATE";
  if (unauthorizedFiles.length > 0) return "SCOPE";

  const isExplicitManifestFailure =
    agentResponse?.explanation?.includes("Manifest Validation Failed") ||
    agentResponse?.explanation?.includes("APPROVED_MANIFEST_REQUIRED") ||
    agentResponse?.manifestRejected;

  if (isExplicitManifestFailure) return "MANIFEST";
  if (agentResponse?.buildErrors && !agentResponse.buildVerified) return "REPAIR";
  if (!validationPassed) return "VALIDATION";
  if (!contentRulesPassed) return "GENERATION";

  if (missingRequired.length > 0) {
    if (agentResponse?.repaired || (agentResponse?.repairAttempts && agentResponse.repairAttempts > 0)) {
      return "REPAIR";
    }
    return "MANIFEST";
  }

  return "UNKNOWN";
}

// ─── RAG Metric Calculation ──────────────────────────────────────────────────

/**
 * Computes ranking metrics (Recall@1/3/5, Precision@1/3/5, MRR) over a deduplicated file list.
 * Deduplication preserves the first occurrence order of each unique file.
 */
export function computeRankingMetrics(
  expectedFiles: string[],
  rankedFiles: string[],
): RankingMetrics {
  const expectedNorm = expectedFiles.map(normalizeRepoPath);

  // Deduplicate rankedFiles while preserving first occurrence
  const uniqueRanked: string[] = [];
  const seen = new Set<string>();
  for (const f of rankedFiles) {
    const norm = normalizeRepoPath(f);
    if (!seen.has(norm)) {
      seen.add(norm);
      uniqueRanked.push(norm);
    }
  }

  const computeRecallAtK = (k: number): number => {
    if (expectedNorm.length === 0) return 1.0;
    const topK = uniqueRanked.slice(0, k);
    const hits = topK.filter((f) => expectedNorm.includes(f)).length;
    return parseFloat((hits / expectedNorm.length).toFixed(4));
  };

  const computePrecisionAtK = (k: number): number => {
    const topK = uniqueRanked.slice(0, k);
    const hits = topK.filter((f) => expectedNorm.includes(f)).length;
    return parseFloat((hits / k).toFixed(4));
  };

  const firstHitIndex = uniqueRanked.findIndex((f) => expectedNorm.includes(f));
  const mrr = firstHitIndex >= 0 ? parseFloat((1 / (firstHitIndex + 1)).toFixed(4)) : 0.0;

  return {
    recallAt1: computeRecallAtK(1),
    recallAt3: computeRecallAtK(3),
    recallAt5: computeRecallAtK(5),
    precisionAt1: computePrecisionAtK(1),
    precisionAt3: computePrecisionAtK(3),
    precisionAt5: computePrecisionAtK(5),
    mrr,
  };
}

/**
 * Computes separate raw vs reranked RAG metrics, diagnostic deltas, and ContextPacker inclusion telemetry.
 */
export function computeRagMetrics(
  expectedFiles: string[],
  stageMetrics?: Record<string, any>,
  _legacyK: number = 5,
): RagEvalMetrics {
  const expectedNorm = expectedFiles.map(normalizeRepoPath);
  const rawRankedRaw: string[] = stageMetrics?.rawRankedFiles || [];
  const rerankedRaw: string[] = stageMetrics?.rerankedFiles || [];
  const included: string[] = (stageMetrics?.includedFiles || []).map(normalizeRepoPath);
  const excluded: string[] = (stageMetrics?.excludedFiles || []).map(normalizeRepoPath);
  const embeddingProvider: string = stageMetrics?.embeddingProvider || "unknown";

  const raw = computeRankingMetrics(expectedFiles, rawRankedRaw);
  const reranked = computeRankingMetrics(expectedFiles, rerankedRaw);

  const mrrDelta = parseFloat((reranked.mrr - raw.mrr).toFixed(4));
  const recallAt5Delta = parseFloat((reranked.recallAt5 - raw.recallAt5).toFixed(4));
  const precisionAt5Delta = parseFloat((reranked.precisionAt5 - raw.precisionAt5).toFixed(4));

  // Context inclusion telemetry
  const includedHits = expectedNorm.filter((f) => included.includes(f)).length;
  const totalExpected = expectedNorm.length;
  const inclusionRate = totalExpected > 0 ? parseFloat((includedHits / totalExpected).toFixed(4)) : 1.0;
  const allExpectedIncluded = totalExpected === 0 || includedHits === totalExpected;

  // Deduplicated file lists for diagnostic reporting
  const rawRankedFiles = Array.from(new Set(rawRankedRaw.map(normalizeRepoPath)));
  const rerankedFiles = Array.from(new Set(rerankedRaw.map(normalizeRepoPath)));

  return {
    embeddingProvider,
    raw,
    reranked,
    delta: {
      mrrDelta,
      recallAt5Delta,
      precisionAt5Delta,
    },
    context: {
      expectedFilesIncludedCount: includedHits,
      expectedFilesTotal: totalExpected,
      inclusionRate,
      allExpectedIncluded,
    },
    rawRankedFiles,
    rerankedFiles,
    includedFiles: included,
    excludedFiles: excluded,
    recallAt5: reranked.recallAt5,
    precisionAt5: reranked.precisionAt5,
    mrr: reranked.mrr,
    contextIncluded: allExpectedIncluded,
  };
}

// ─── Eval Runner Engine ──────────────────────────────────────────────────────

export class EvalRunner {
  /**
   * Runs a single evaluation case against an isolated temporary repository copy.
   */
  static async runCase(
    evalCase: AgentEvalCase,
    fixturesBaseDir: string,
    options?: {
      mode?: EvalMode;
      observer?: ModelObserver;
    },
  ): Promise<EvalCaseResult> {
    const mode: EvalMode = options?.mode || "DETERMINISTIC";
    const startTime = performance.now();
    const fixtureSourceDir = path.join(fixturesBaseDir, evalCase.fixtureDir, "repo");
    const tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), `anka-eval-${evalCase.id}-`));

    let evalUserId = "eval-user";
    let evalProjectId = `eval-${evalCase.id}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    let dbFixture: ProvisionedEvalContext | undefined;

    let stage4Metrics: Record<string, any> | undefined;
    let safeRejectionCode: string | undefined;
    let pipelineError: any = null;
    let agentResponse: any = null;

    const caseObserverEventsBefore = options?.observer ? options.observer.getEvents().length : 0;

    try {
      // 1. Copy fixture files into isolated temp workspace
      if (fs.existsSync(fixtureSourceDir)) {
        fs.cpSync(fixtureSourceDir, tempWorkspace, { recursive: true });
      }

      if (typeof jest !== "undefined") {
        jest.spyOn(RepositoryScanner, "ensureLocalWorkspace").mockResolvedValue(tempWorkspace);
      }

      // 2. In REAL_MODEL mode, provision legitimate ephemeral User & Project records
      if (mode === "REAL_MODEL") {
        dbFixture = await EvalDatabaseFixture.provision(evalCase.id, tempWorkspace);
        evalUserId = dbFixture.userId;
        evalProjectId = dbFixture.projectId;
      }

      const evalProjectCacheDir = path.join(process.cwd(), ".anka-cache", "projects", evalProjectId);

      // 3. Capture pre-run filesystem snapshot
      const beforeSnapshot = captureFilesystemSnapshot(tempWorkspace);

      // 4. Setup progress listener to capture Stage-4 RAG telemetry
      const onProgress = (event: AgentProgressEvent) => {
        if (event.step === 4 && event.stageMetrics) {
          stage4Metrics = event.stageMetrics;
        }
      };

      const request: ChatRequest = {
        message: evalCase.userRequest,
        sessionId: `session-${evalProjectId}`,
      };

      // 5. Run production AgentPipeline (catching any infrastructure or unhandled errors)
      try {
        agentResponse = await AgentPipeline.runCodingAgent(
          evalUserId,
          evalProjectId,
          request,
          onProgress,
        );
      } catch (err: any) {
        pipelineError = err;
      }

      // 6. Capture post-run filesystem snapshot & compute diff
      const afterSnapshot = captureFilesystemSnapshot(tempWorkspace);
      const fsDiff = computeFilesystemDiff(beforeSnapshot, afterSnapshot);

      // 7. Check for Safe Rejection if expected
      if (evalCase.expected.expectedSafeRejection && agentResponse) {
        const expectedCode = evalCase.expected.expectedSafeRejection.code;
        const responseText = agentResponse.explanation || "";
        const buildErrorsText = agentResponse.buildErrors || "";

        if (
          responseText.includes(`[${expectedCode}]`) ||
          buildErrorsText.includes(`[${expectedCode}]`) ||
          responseText.includes(expectedCode)
        ) {
          safeRejectionCode = expectedCode;
        }
      }

      // 8. Verify Scope (unauthorized files check)
      const allowedSet = new Set(
        (evalCase.expected.allowedChangedFiles || evalCase.expected.requiredChangedFiles || []).map(normalizeRepoPath),
      );
      const forbiddenSet = new Set(
        (evalCase.expected.forbiddenChangedFiles || []).map(normalizeRepoPath),
      );

      const unauthorizedFiles: string[] = [];
      for (const changedFile of fsDiff.allChangedFiles) {
        if (forbiddenSet.has(changedFile)) {
          unauthorizedFiles.push(changedFile);
        } else if (allowedSet.size > 0 && !allowedSet.has(changedFile)) {
          unauthorizedFiles.push(changedFile);
        }
      }

      // 9. Required files check
      const requiredList = (evalCase.expected.requiredChangedFiles || []).map(normalizeRepoPath);
      const missingRequired = requiredList.filter((f) => !fsDiff.allChangedFiles.includes(f));

      // 10. Run behavioral validation commands on workspace
      let validationPassed = true;
      const validationErrors: string[] = [];

      if (!pipelineError && evalCase.expected.validationCommands && evalCase.expected.validationCommands.length > 0) {
        for (const cmd of evalCase.expected.validationCommands) {
          try {
            await execAsync(cmd, { cwd: tempWorkspace, timeout: 30000 });
          } catch (err: any) {
            validationPassed = false;
            validationErrors.push(`${cmd} failed: ${err.message || err}`);
          }
        }
      }

      // 11. Check content rules
      let contentRulesPassed = true;
      if (!pipelineError && evalCase.expected.contentRules && evalCase.expected.contentRules.length > 0) {
        for (const rule of evalCase.expected.contentRules) {
          const targetAbs = path.join(tempWorkspace, rule.path);
          let content = "";
          try {
            content = fs.readFileSync(targetAbs, "utf8");
          } catch {
            contentRulesPassed = false;
            break;
          }

          if (rule.contains) {
            for (const sub of rule.contains) {
              if (!content.includes(sub)) {
                contentRulesPassed = false;
                break;
              }
            }
          }

          if (rule.notContains) {
            for (const sub of rule.notContains) {
              if (content.includes(sub)) {
                contentRulesPassed = false;
                break;
              }
            }
          }
        }
      }

      // 12. Compute RAG metrics
      const ragMetrics = evalCase.ragGroundTruth
        ? computeRagMetrics(evalCase.ragGroundTruth.expectedRelevantFiles, stage4Metrics)
        : undefined;

      // 13. Evaluate overall outcome
      const durationMs = parseFloat((performance.now() - startTime).toFixed(1));
      const isSafeRejectionExpected = Boolean(evalCase.expected.expectedSafeRejection);

      let status: "PASS" | "FAIL" | "SAFE_REJECTION" = "FAIL";
      let taskSuccess = false;

      if (pipelineError) {
        status = "FAIL";
        taskSuccess = false;
      } else if (isSafeRejectionExpected && safeRejectionCode) {
        // Safe rejection passed: agent safely halted and left workspace unchanged
        status = "SAFE_REJECTION";
        taskSuccess = fsDiff.allChangedFiles.length === 0;
      } else if (!isSafeRejectionExpected && agentResponse) {
        const scopePass = unauthorizedFiles.length === 0 && missingRequired.length === 0;
        const buildPass = agentResponse.buildVerified !== false && validationPassed && contentRulesPassed;
        taskSuccess = scopePass && buildPass;
        status = taskSuccess ? "PASS" : "FAIL";
      }

      const failureStage: EvalFailureStage | undefined = pipelineError
        ? "INFRASTRUCTURE"
        : classifyFailureStage(
            taskSuccess,
            unauthorizedFiles,
            missingRequired,
            validationPassed,
            contentRulesPassed,
            agentResponse,
            safeRejectionCode,
          );

      // 14. Extract Model Call Events if observer active
      const caseModelCalls = options?.observer
        ? options.observer.getEvents().slice(caseObserverEventsBefore)
        : undefined;

      let actualTokenUsage;
      if (caseModelCalls && caseModelCalls.length > 0) {
        let p = 0;
        let c = 0;
        let t = 0;
        let foundUsage = false;
        for (const call of caseModelCalls) {
          if (typeof call.promptTokens === "number" || typeof call.completionTokens === "number") {
            foundUsage = true;
            p += call.promptTokens || 0;
            c += call.completionTokens || 0;
            t += call.totalTokens || (call.promptTokens || 0) + (call.completionTokens || 0);
          }
        }
        if (foundUsage) {
          actualTokenUsage = { promptTokens: p, completionTokens: c, totalTokens: t };
        }
      }

      return {
        caseId: evalCase.id,
        name: evalCase.name,
        category: evalCase.category,
        mode,
        status,
        taskSuccess,
        firstPassSuccess: taskSuccess && !Boolean(agentResponse?.repaired),
        repaired: Boolean(agentResponse?.repaired),
        repairAttempted: Boolean(agentResponse?.repairAttempted ?? agentResponse?.repaired),
        repairAttempts: typeof agentResponse?.repairAttempts === "number" ? agentResponse.repairAttempts : (agentResponse?.repaired ? 1 : 0),
        repairApplied: Boolean(agentResponse?.repairApplied),
        repairSuccess: agentResponse?.repaired || agentResponse?.repairAttempted ? (agentResponse?.repairSuccess ?? taskSuccess) : undefined,
        repairTrigger: agentResponse?.repairTrigger,
        failureStage,
        filesystemDiff: fsDiff,
        unauthorizedFiles,
        validationPassed,
        contentRulesPassed,
        ragMetrics,
        safetyMetrics: {
          safeRejectionTriggered: safeRejectionCode,
          scopeViolations: unauthorizedFiles.length,
          patchFailures: 0,
        },
        durationMs,
        estimatedTokenUsage: {
          inputTokens: 0,
          outputTokens: 0,
        },
        actualTokenUsage,
        modelCalls: caseModelCalls,
        errorDetails: pipelineError ? pipelineError.message || String(pipelineError) : validationErrors.join("\n") || undefined,
      };
    } finally {
      // 15. Complete isolation teardown
      if (dbFixture) {
        await dbFixture.cleanup();
      }
      if (fs.existsSync(tempWorkspace)) {
        fs.rmSync(tempWorkspace, { recursive: true, force: true });
      }
      const cacheDir = path.join(process.cwd(), ".anka-cache", "projects", evalProjectId);
      if (fs.existsSync(cacheDir)) {
        fs.rmSync(cacheDir, { recursive: true, force: true });
      }
    }
  }

  /**
   * Runs an entire suite of evaluation cases and generates an aggregate summary.
   */
  static async runSuite(
    cases: AgentEvalCase[],
    fixturesBaseDir: string,
    options?: {
      mode?: EvalMode;
      saveResults?: boolean;
      outputDir?: string;
    },
  ): Promise<EvalSuiteSummary> {
    const mode: EvalMode = options?.mode || "DETERMINISTIC";
    const runId = `eval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const timestamp = new Date().toISOString();
    const gitCommit = await getGitCommitSha();

    let observer: ModelObserver | undefined;
    if (mode === "REAL_MODEL" || ModelObserver.getActive()) {
      observer = ModelObserver.getActive() || ModelObserver.start();
    }

    const results: EvalCaseResult[] = [];

    for (const evalCase of cases) {
      const result = await this.runCase(evalCase, fixturesBaseDir, { mode, observer });
      results.push(result);
    }

    const totalCases = results.length;
    const passedCases = results.filter((r) => r.status === "PASS").length;
    const safeRejections = results.filter((r) => r.status === "SAFE_REJECTION").length;
    const failedCases = results.filter((r) => r.status === "FAIL").length;

    const passRatePct = totalCases > 0 ? parseFloat((((passedCases + safeRejections) / totalCases) * 100).toFixed(2)) : 0;
    const firstPassSuccessRatePct = totalCases > 0 ? parseFloat(((results.filter((r) => r.firstPassSuccess).length / totalCases) * 100).toFixed(2)) : 0;
    const repairedCases = results.filter((r) => r.repaired && r.taskSuccess).length;
    const repairSuccessRatePct = totalCases > 0 ? parseFloat(((repairedCases / totalCases) * 100).toFixed(2)) : 0;

    const avgDurationMs = totalCases > 0 ? parseFloat((results.reduce((a, b) => a + b.durationMs, 0) / totalCases).toFixed(1)) : 0;
    const avgRepairAttempts = totalCases > 0 ? parseFloat((results.reduce((a, b) => a + b.repairAttempts, 0) / totalCases).toFixed(2)) : 0;

    const ragCases = results.filter((r) => r.ragMetrics !== undefined);
    const ragCount = ragCases.length;

    const rawAvgRecallAt5 = ragCount > 0
      ? parseFloat((ragCases.reduce((a, b) => a + (b.ragMetrics?.raw.recallAt5 || 0), 0) / ragCount).toFixed(4))
      : 1.0;
    const rawAvgMRR = ragCount > 0
      ? parseFloat((ragCases.reduce((a, b) => a + (b.ragMetrics?.raw.mrr || 0), 0) / ragCount).toFixed(4))
      : 1.0;

    const rerankedAvgRecallAt5 = ragCount > 0
      ? parseFloat((ragCases.reduce((a, b) => a + (b.ragMetrics?.reranked.recallAt5 || 0), 0) / ragCount).toFixed(4))
      : 1.0;
    const rerankedAvgMRR = ragCount > 0
      ? parseFloat((ragCases.reduce((a, b) => a + (b.ragMetrics?.reranked.mrr || 0), 0) / ragCount).toFixed(4))
      : 1.0;

    const avgMrrDelta = ragCount > 0
      ? parseFloat((ragCases.reduce((a, b) => a + (b.ragMetrics?.delta.mrrDelta || 0), 0) / ragCount).toFixed(4))
      : 0.0;
    const avgRecallAt5Delta = ragCount > 0
      ? parseFloat((ragCases.reduce((a, b) => a + (b.ragMetrics?.delta.recallAt5Delta || 0), 0) / ragCount).toFixed(4))
      : 0.0;

    const avgContextInclusionRate = ragCount > 0
      ? parseFloat((ragCases.reduce((a, b) => a + (b.ragMetrics?.context.inclusionRate || 0), 0) / ragCount).toFixed(4))
      : 1.0;

    const embeddingProvider = results.find((r) => r.ragMetrics?.embeddingProvider)?.ragMetrics?.embeddingProvider || "local_deterministic";

    const modelProfile = observer
      ? observer.buildModelProfile(embeddingProvider)
      : {
          providers: ["openai"],
          modelsObserved: [],
          embeddingProvider,
          callCount: 0,
          callsByModel: {},
        };

    const actualTokenUsage = observer ? observer.aggregateActualTokenUsage() : undefined;

    const summary: EvalSuiteSummary = {
      schemaVersion: "1.0.0",
      runId,
      timestamp,
      gitCommit,
      mode,
      totalCases,
      passedCases,
      failedCases,
      safeRejections,
      passRatePct,
      firstPassSuccessRatePct,
      repairSuccessRatePct,
      avgDurationMs,
      avgRepairAttempts,
      rawAvgRecallAt5,
      rawAvgMRR,
      rerankedAvgRecallAt5,
      rerankedAvgMRR,
      avgMrrDelta,
      avgRecallAt5Delta,
      avgContextInclusionRate,
      modelProfile,
      actualTokenUsage,
      ragAvgRecallAt5: rerankedAvgRecallAt5,
      ragAvgPrecisionAt5: ragCount > 0
        ? parseFloat((ragCases.reduce((a, b) => a + (b.ragMetrics?.reranked.precisionAt5 || 0), 0) / ragCount).toFixed(4))
        : 1.0,
      ragAvgMrr: rerankedAvgMRR,
      embeddingProvider,
      results,
    };

    // Persist real model results if requested or in REAL_MODEL mode
    if (mode === "REAL_MODEL" || options?.saveResults) {
      try {
        const outputDir = options?.outputDir || path.join(process.cwd(), "eval-results", "real");
        fs.mkdirSync(outputDir, { recursive: true });
        const safeTimestamp = timestamp.replace(/[:.]/g, "-");
        const resultPath = path.join(outputDir, `${safeTimestamp}-${runId}.json`);
        fs.writeFileSync(resultPath, JSON.stringify(summary, null, 2), "utf8");
      } catch {
        // Result save error handled gracefully
      }
    }

    if (observer && !options?.saveResults) {
      observer.stop();
    }

    return summary;
  }
}
