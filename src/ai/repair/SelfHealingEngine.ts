import fs from "fs";
import path from "path";
import crypto from "crypto";
import { getOpenAI } from "../shared/utils";
import { AgentFileChange, AgentProgressEvent, ExecutionContract } from "../shared/types";
import { FileManifest, RootBuildFailure, ValidationDetails, BaselineDiagnostic } from "../../types";
import { ValidationRunner } from "../validation/ValidationRunner";
import { FileSystemStateManager, RepairInfrastructureError } from "../validation/FileSystemStateManager";
import { SecurityPolicy } from "../security/SecurityPolicy";
import { ImportValidator } from "../validation/ImportValidator";
import { detectRepositoryArchitecture } from "../planning/RepositoryArchitectureDetector";
import { ErrorClassifier } from "../validation/ErrorClassifier";
import { ErrorDiagnosticsParser, DiagnosticError } from "../../services/surgical-repair.engine";
import { SurgicalPatchEngine, SurgicalPatchChunk } from "./SurgicalPatchEngine";

function extractMissingDepKeys(diags: DiagnosticError[], rawErrors?: string): Set<string> {
  const keys = new Set<string>();
  for (const diag of diags) {
    if (diag.code === "TS2307" || /cannot find module|module not found|err_module_not_found|could not resolve/i.test(diag.message || "")) {
      const normFile = diag.file ? normalizeRepoPath(diag.file) : "";
      let sym = (diag.symbolName || "").toLowerCase();
      if (!sym && diag.message) {
        const m = diag.message.match(/['"`]([^'"`]+)['"`]/);
        if (m) sym = m[1].toLowerCase();
      }
      keys.add(`${normFile}|${sym}`);
    }
  }
  if (keys.size === 0 && rawErrors) {
    const quoteMatches = rawErrors.matchAll(/(?:cannot find module|module not found|could not resolve|cannot find name)\s+['"`]([^'"`]+)['"`]/gi);
    for (const qm of quoteMatches) {
      if (qm[1]) keys.add(`*|${qm[1].toLowerCase()}`);
    }
  }
  return keys;
}
import { RepairSessionTracker } from "./RepairSessionTracker";
import { buildSelfHealingRepairPrompt } from "../prompts/repair";
import {
  RepairChangeProposal,
  validateRepairManifestScope,
  resolveRepairProposals,
} from "./RepairProposalResolver";
import { enforceExecutionScope } from "../contracts/ExecutionScopeEnforcer";
import { verifyFileVersionsFromDisk } from "../validation/FileVersionGuard";
import { normalizeRepoPath } from "../repository/SemanticContextResolver";
import { PatchCorrectionEngine } from "../generation/PatchCorrectionEngine";
import {
  BaselineDeltaVerifier,
  BaselineDeltaResult,
  createPreTaskSourceGetter,
  PreTaskSourceInfo,
} from "../../services/baseline-delta.verifier";

export const MAX_TOTAL_REPAIR_CYCLES = 15;
export const MAX_NO_PROGRESS_CYCLES = 2;
export const MAX_IDENTICAL_FAILURES = 2;
export const MAX_IDENTICAL_REPAIR_PROPOSAL = 1;
export const MAX_REPAIR_WALL_TIME_MS = 600000; // 10 minutes

export const SPECIFIC_GATE_ERRORS = new Set([
  "STALE_REPAIR_SOURCE",
  "REPAIR_UNDECLARED_FILE",
  "SCOPE_EXPANSION_REQUIRED",
  "REPAIR_ACTION_MISMATCH",
  "SCOPE_VIOLATION",
  "MODIFY_PATCH_REQUIRED",
  "NO_OP_PATCH_EDIT",
  "PATCH_TARGET_NOT_FOUND",
  "NO_REPAIR_PROGRESS",
  "FILE_VERSION_MISMATCH",
  "BASELINE_REPOSITORY_UNHEALTHY",
  "NON_REPAIRABLE_FAILURE",
  "REPEATED_REPAIR_PROPOSAL",
]);

/**
 * Generates a stable, normalized failure fingerprint from errorType, file path, compiler/error code,
 * and normalized error message (stripping ANSI codes, volatile temp directories, worker IDs).
 */
export function computeFailureFingerprint(
  errorType: string,
  errorLog: string,
  diagnostics: Array<{ file: string; line?: number; column?: number; code?: string; message?: string }> = []
): string {
  const cleanLog = (errorLog || "").replace(/\u001b\[\d+m/g, "");

  // Strip temporary worktree paths (Windows and POSIX)
  const normalizedLog = cleanLog
    .replace(/[a-zA-Z]:\\[^\s:]*anka-worktrees\\[^\s:]*[\/\\]/gi, "")
    .replace(/\/tmp\/anka-worktrees\/[^\s:\/]*\//gi, "")
    .replace(/\s+/g, " ")
    .trim();

  if (diagnostics.length > 0) {
    const diagParts = diagnostics.map((d) => {
      const normFile = (d.file || "").replace(/\\/g, "/").replace(/^\.\//, "");
      const code = d.code || "ERR";
      return `${normFile}:${code}${d.line ? `:${d.line}` : ""}`;
    });
    return `${errorType}|${diagParts.sort().join(",")}`;
  }

  return `${errorType}|${normalizedLog.slice(0, 120)}`;
}

export function isRepairableSourceFailure(classification: {
  type: string;
  isCompile?: boolean;
  isInfrastructure?: boolean;
  canSurgicalPatch?: boolean;
}): boolean {
  if (
    classification.isInfrastructure ||
    classification.type === "INFRA" ||
    classification.type === "ENVIRONMENT" ||
    classification.type === "INVALID_PACKAGE_DEPENDENCY" ||
    classification.type === "PEER_DEPENDENCY_CONFLICT" ||
    classification.type === "LOCKFILE_OUT_OF_SYNC" ||
    classification.type === "DEPENDENCY_NETWORK" ||
    classification.type === "SYSTEM_INFRASTRUCTURE" ||
    classification.type === "BASELINE_REPOSITORY_UNHEALTHY" ||
    classification.type === "REPAIR_SCOPE_REQUIRED"
  ) {
    return false;
  }

  const repairableTypes = new Set([
    "COMPILE_TS",
    "COMPILE_NEXT",
    "COMPILE_JS",
    "COMPILE_ANGULAR",
    "COMPILE_RUST",
    "COMPILE_GO",
    "CSS_PARSE",
    "TEST_FAILURE",
    "LINT",
    "LINT_FAILURE",
    "MISSING_DEP",
    "UNKNOWN",
  ]);

  return repairableTypes.has(classification.type) || Boolean(classification.isCompile);
}

export class SelfHealingEngine {
  static async runSelfHealingLoop(
    initialChanges: AgentFileChange[],
    localPath: string | null | undefined,
    commands: string[],
    systemPrompt: string,
    originalMessage: string,
    fsManager?: FileSystemStateManager,
    projectId?: string,
    onProgress?: (event: AgentProgressEvent) => void,
    approvedManifest?: FileManifest | null,
    executionContract?: ExecutionContract | null,
    baselineDiagnostics?: BaselineDiagnostic[],
    targetedBaselineDiagnostics?: BaselineDiagnostic[],
    baseCommitSha?: string,
  ): Promise<{
    finalChanges: AgentFileChange[];
    attempts: number;
    success: boolean;
    errorLog?: string;
    infrastructureError?: boolean;
    errorType?: string;
    repairTrigger?: "SHELL_VALIDATION_FAILURE" | "LLM_REVIEW_REJECTION" | "NONE";
    repairApplied?: boolean;
    repaired?: boolean;
    rootFailure?: RootBuildFailure;
    currentFailure?: string;
    validationDetails?: ValidationDetails;
    modelRepairAttempts?: number;
    patchesAppliedCount?: number;
    buildAttemptsCount?: number;
    taskVerified?: boolean;
    repositoryClean?: boolean;
    deltaResult?: BaselineDeltaResult;
  }> {
    const isRepositoryMode = executionContract?.pipeline === "REPOSITORY";

    // Fail closed if repository self-healing is invoked without required approved scope
    if (
      isRepositoryMode &&
      !approvedManifest &&
      executionContract?.taskType !== "DOCS"
    ) {
      return {
        finalChanges: initialChanges,
        attempts: 0,
        success: false,
        errorLog: "[REPAIR_SCOPE_REQUIRED] Execution halted: An approved file manifest is required for repository self-healing.",
        errorType: "REPAIR_SCOPE_REQUIRED",
        buildAttemptsCount: 0,
        modelRepairAttempts: 0,
        patchesAppliedCount: 0,
      };
    }

    const repairLoopStartTime = performance.now();
    let currentChanges = [...initialChanges];
    let previousErrors = "";
    let lastErrorType = "UNKNOWN";
    let repairTrigger: "SHELL_VALIDATION_FAILURE" | "LLM_REVIEW_REJECTION" | "NONE" = "NONE";
    let repairApplied = false;
    let appliedPatchesInPrevCycle = false;
    const tracker = new RepairSessionTracker();

    let rootFailure: RootBuildFailure | undefined;
    let buildAttempts = 0;
    let modelRepairAttempts = 0;
    let patchesAppliedCount = 0;
    let noProgressCyclesCount = 0;
    let repeatedProposalsBlockedCount = 0;
    let previousFailureCode: string | null = null;
    const resolvedFailureSequence: string[] = [];

    const attemptedProposalFingerprints = new Set<string>();
    /** Per-run memory of dynamically authorized revealed-baseline repair targets */
    const authorizedRevealedBaselinePaths = new Set<string>();
    const repairAttemptsHistory: Array<{
      attempt: number;
      proposalResult?: string;
      patchResult?: string;
      validationResult?: string;
    }> = [];

    let previousFingerprint: string | null = null;
    let identicalFailureCount = 0;
    let noProgressCount = 0;
    let previousDiagnosticCount: number | null = null;
    let totalCyclesExecuted = 0;

    for (let attempt = 1; attempt <= MAX_TOTAL_REPAIR_CYCLES; attempt++) {
      totalCyclesExecuted = attempt;
      const attemptStart = performance.now();

      // Emergency Breaker 1: Wall-clock timeout
      if (performance.now() - repairLoopStartTime > MAX_REPAIR_WALL_TIME_MS) {
        console.warn(`[SelfHealingEngine] Emergency wall-time budget exceeded (${MAX_REPAIR_WALL_TIME_MS}ms). Halting repair loop.`);
        lastErrorType = "EMERGENCY_REPAIR_BUDGET_EXCEEDED";
        previousErrors = `[EMERGENCY_REPAIR_BUDGET_EXCEEDED] Emergency wall-time budget exceeded (${MAX_REPAIR_WALL_TIME_MS}ms).`;
        break;
      }

      let validationSuccess = false;

      const classification = ErrorClassifier.classify(previousErrors);
      const bracketMatch = previousErrors.match(/^\[([A-Z_]+)\]/);
      if (bracketMatch) {
        lastErrorType = bracketMatch[1];
      } else {
        lastErrorType = classification.type;
      }

      onProgress?.({
        step: 8,
        stageName: "SELF_HEALING",
        label: "Build Repair",
        detail: `Repair attempt ${attempt}/${MAX_TOTAL_REPAIR_CYCLES} — ${classification.type}`,
        color: "text-orange-400 border-orange-500/30 bg-orange-500/10",
        badge: `STAGE 8 · Cycle ${attempt}`,
        progress: 75 + Math.min(15, Math.round((attempt / MAX_TOTAL_REPAIR_CYCLES) * 15)),
        log: `[Stage 8] Repair cycle ${attempt}: ${previousErrors ? previousErrors.slice(0, 200) : "Running initial validation"}`,
        durationMs: performance.now() - attemptStart,
      });

      if (!currentChanges.length && localPath) {
        buildAttempts++;
        const initialCheck = await ValidationRunner.validateWithShell([], localPath, commands);
        if (initialCheck.success) {
          tracker.recordAttempt({
            attempt,
            timestamp: new Date().toISOString(),
            diagnostics: [],
            patchesApplied: [],
            totalFileLines: 0,
            linesChanged: 0,
            patchSizePct: 0,
            repairTimeMs: performance.now() - attemptStart,
            compileSuccess: true,
          });
          return {
            finalChanges: [],
            attempts: attempt,
            success: true,
            errorType: classification.type,
            repairTrigger: "NONE",
            repairApplied: false,
            repaired: false,
            buildAttemptsCount: buildAttempts,
            modelRepairAttempts,
            patchesAppliedCount,
          };
        }
        repairTrigger = "SHELL_VALIDATION_FAILURE";
        previousErrors = initialCheck.errors;

        const parsedDiags = ErrorDiagnosticsParser.parse(initialCheck.errors);
        if (!rootFailure) {
          rootFailure = {
            command: commands[0] || "npm run build",
            exitCode: 1,
            errorType: classification.type,
            stdout: "",
            stderr: initialCheck.errors,
            filePath: parsedDiags[0]?.file,
            line: parsedDiags[0]?.line,
            column: parsedDiags[0]?.column,
          };
        }

        const initErrClassification = ErrorClassifier.classify(initialCheck.errors);
        if (!isRepairableSourceFailure(initErrClassification)) {
          return {
            finalChanges: [],
            attempts: attempt,
            success: false,
            errorLog: initialCheck.errors,
            infrastructureError: initErrClassification.isInfrastructure,
            errorType: initErrClassification.type,
            repairTrigger: "SHELL_VALIDATION_FAILURE",
            repairApplied: false,
            repaired: false,
            rootFailure,
            buildAttemptsCount: buildAttempts,
            modelRepairAttempts,
            patchesAppliedCount,
          };
        }
      } else if (!currentChanges.length) {
        return {
          finalChanges: [],
          attempts: attempt,
          success: true,
          errorType: classification.type,
          repairTrigger: "NONE",
          repairApplied: false,
          repaired: false,
          buildAttemptsCount: buildAttempts,
          modelRepairAttempts,
          patchesAppliedCount,
        };
      } else {
        if (fsManager && localPath) {
          try {
            await fsManager.apply(currentChanges, localPath);
          } catch (err: any) {
            if (err instanceof RepairInfrastructureError) {
              return {
                finalChanges: currentChanges,
                attempts: attempt,
                success: false,
                errorLog: err.message,
                infrastructureError: true,
                errorType: "INFRA",
                repairTrigger,
                repairApplied,
                repaired: attempt > 1 || repairApplied,
                rootFailure,
                buildAttemptsCount: buildAttempts,
                modelRepairAttempts,
                patchesAppliedCount,
              };
            }
          }
        } else if (localPath && !isRepositoryMode) {
          for (const change of currentChanges) {
            try {
              const abs = path.join(localPath, change.path);
              if (change.action === "delete" || change.isDeleted) {
                if (fs.existsSync(abs)) await fs.promises.rm(abs, { recursive: true, force: true });
              } else {
                await fs.promises.mkdir(path.dirname(abs), { recursive: true });
                await fs.promises.writeFile(abs, change.content, "utf8");
              }
            } catch {}
          }
        }

        if (localPath && commands.length > 0) {
          buildAttempts++;
        }

        const validation =
          localPath && commands.length > 0
            ? await ValidationRunner.validateWithShell(currentChanges, localPath, commands)
            : await ValidationRunner.selfReviewChanges(currentChanges);

        validationSuccess = validation.success;
        if (validationSuccess) {
          tracker.recordAttempt({
            attempt,
            timestamp: new Date().toISOString(),
            diagnostics: [],
            patchesApplied: [],
            totalFileLines: 0,
            linesChanged: 0,
            patchSizePct: 0,
            repairTimeMs: performance.now() - attemptStart,
            compileSuccess: true,
          });

          const summaryMd = tracker.generateSummaryMarkdown(true);
          try {
            const cacheDir = projectId
              ? path.join(process.cwd(), ".anka-cache", "projects", projectId)
              : path.join(process.cwd(), ".anka-cache");
            if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
            fs.writeFileSync(path.join(cacheDir, "repair-metrics.md"), summaryMd, "utf8");
          } catch {}

          if (previousFailureCode) {
            resolvedFailureSequence.push(previousFailureCode);
          }

          return {
            finalChanges: currentChanges,
            attempts: attempt,
            success: true,
            errorType: classification.type,
            repairTrigger: attempt > 1 ? repairTrigger : "NONE",
            repairApplied,
            repaired: attempt > 1 || repairApplied,
            rootFailure,
            validationDetails: {
              rootFailure,
              repairAttempts: repairAttemptsHistory,
              finalFailure: undefined,
              modelRepairAttempts,
              patchesApplied: patchesAppliedCount,
              buildAttempts,
              distinctFailuresResolvedCount: resolvedFailureSequence.length,
              noProgressCyclesCount,
              repeatedProposalsBlockedCount,
              finalStatus: "BUILD_CLEAN",
              resolvedFailureSequence,
            },
            buildAttemptsCount: buildAttempts,
            modelRepairAttempts,
            patchesAppliedCount,
          };
        }

        repairTrigger = localPath && commands.length > 0 ? "SHELL_VALIDATION_FAILURE" : "LLM_REVIEW_REJECTION";
        previousErrors = validation.errors;

        const sourceInfoGetter = createPreTaskSourceGetter(localPath, fsManager, baseCommitSha);
        const preTaskSourceGetter = (filePath: string) => {
          const info = sourceInfoGetter(filePath);
          return info ? info.content : undefined;
        };

        if (baselineDiagnostics && baselineDiagnostics.length > 0) {
          const currentDiags = BaselineDeltaVerifier.extractDiagnostics(validation.errors, "CURRENT_TASK");
          const isBroad = BaselineDeltaVerifier.isBroadBuildRepairTask(originalMessage, executionContract);

          const deltaResult = BaselineDeltaVerifier.compareBaselineVsPostChange(
            baselineDiagnostics,
            currentDiags,
            targetedBaselineDiagnostics || [],
            {
              preTaskSourceGetter,
              changes: currentChanges,
              isBroadRepairTask: isBroad,
              authorizedRevealedBaselinePaths,
            }
          );

          if (deltaResult.taskVerified) {
            console.log(`[SelfHealingEngine] Task verified: All targeted baseline diagnostic(s) resolved with no new errors. Halting repair with success.`);
            return {
              finalChanges: currentChanges,
              attempts: attempt,
              success: true,
              errorType: classification.type,
              repairTrigger: attempt > 1 ? repairTrigger : "NONE",
              repairApplied,
              repaired: attempt > 1 || repairApplied,
              rootFailure,
              taskVerified: true,
              repositoryClean: deltaResult.repositoryClean,
              deltaResult,
              validationDetails: {
                rootFailure,
                repairAttempts: repairAttemptsHistory,
                finalFailure: undefined,
                modelRepairAttempts,
                patchesApplied: patchesAppliedCount,
                buildAttempts,
                distinctFailuresResolvedCount: resolvedFailureSequence.length,
                noProgressCyclesCount,
                repeatedProposalsBlockedCount,
                finalStatus: deltaResult.repositoryClean ? "BUILD_CLEAN" : "TASK_VERIFIED_REPOSITORY_UNHEALTHY",
                resolvedFailureSequence,
              },
              buildAttemptsCount: buildAttempts,
              modelRepairAttempts,
              patchesAppliedCount,
            };
          }
        }

        const parsedDiags = ErrorDiagnosticsParser.parse(validation.errors);
        if (!rootFailure) {
          rootFailure = {
            command: commands[0] || "npm run build",
            exitCode: 1,
            errorType: classification.type,
            stdout: "",
            stderr: validation.errors,
            filePath: parsedDiags[0]?.file,
            line: parsedDiags[0]?.line,
            column: parsedDiags[0]?.column,
          };
        }

        const valErrClassification = ErrorClassifier.classify(validation.errors);
        if (!isRepairableSourceFailure(valErrClassification)) {
          return {
            finalChanges: currentChanges,
            attempts: attempt,
            success: false,
            errorLog: validation.errors,
            infrastructureError: valErrClassification.isInfrastructure,
            errorType: valErrClassification.type,
            repairTrigger,
            repairApplied,
            repaired: false,
            rootFailure,
            currentFailure: validation.errors,
            buildAttemptsCount: buildAttempts,
            modelRepairAttempts,
            patchesAppliedCount,
          };
        }

        // For BROAD BUILD REPAIR ONLY: Dynamically authorize proven revealed baseline compiler targets
        const isBroad = BaselineDeltaVerifier.isBroadBuildRepairTask(originalMessage, executionContract);
        if (isBroad && approvedManifest && localPath) {
          for (const diag of parsedDiags) {
            if (!diag.file) continue;
            const cleanPath = diag.file.replace(/^\.\//, "").replace(/\\/g, "/");
            const sourceInfo = sourceInfoGetter(cleanPath);

            if (sourceInfo) {
              const changeForFile = currentChanges.find(
                (c) => (c.path || "").replace(/^\.\//, "").replace(/\\/g, "/").toLowerCase() === cleanPath.toLowerCase()
              );
              const baseDiag: BaselineDiagnostic = {
                errorType: diag.code?.startsWith("TS") ? "COMPILE_TS" : "COMPILE_NEXT",
                filePath: cleanPath,
                line: diag.line,
                column: diag.column,
                errorCode: diag.code,
                message: diag.message,
                symbolName: diag.symbolName,
                rawTrace: diag.rawTrace,
                origin: "CURRENT_TASK",
                fingerprint: `${diag.code || "ERR"}|${cleanPath}|${diag.line || 0}`,
              };
              const causality = BaselineDeltaVerifier.isConstructPreExistingAndUntouched(
                baseDiag,
                sourceInfo.content,
                changeForFile,
                {
                  preTaskSourceGetter,
                  changes: currentChanges,
                  isBroadRepairTask: isBroad,
                  authorizedRevealedBaselinePaths,
                }
              );

              if ((causality.isPreExisting && !causality.isTouched) || causality.isAuthorizedRepairFollowup) {
                const abs = path.join(localPath, cleanPath);
                if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
                  // 1. Extend approved manifest
                  const normPath = normalizeRepoPath(cleanPath);
                  if (!approvedManifest.files.some((f) => normalizeRepoPath(f.path) === normPath)) {
                    approvedManifest.files.push({
                      path: cleanPath,
                      action: "modify",
                      description: "Dynamically authorized revealed baseline diagnostic target",
                      dependencies: [],
                    });
                    approvedManifest.totalFiles = approvedManifest.files.length;
                  }

                  // 2. Extend execution contract target paths and search scope
                  if (executionContract) {
                    if (!executionContract.targetPaths.some((p) => normalizeRepoPath(p) === normPath)) {
                      executionContract.targetPaths.push(cleanPath);
                    }
                    if (!executionContract.searchScope.some((p) => normalizeRepoPath(p) === normPath)) {
                      executionContract.searchScope.push(cleanPath);
                    }
                  }

                  // 3. Hydrate on-disk content into currentChanges & snapshot into fsManager
                  if (!currentChanges.some((c) => normalizeRepoPath(c.path) === normPath)) {
                    try {
                      const currentDiskContent = fs.readFileSync(abs, "utf8");
                      currentChanges.push({
                        path: cleanPath,
                        content: currentDiskContent,
                        action: "modify",
                        description: "Hydrated revealed baseline target for repair",
                      });
                      if (fsManager) {
                        await fsManager.snapshot(currentChanges, localPath);
                      }
                    } catch {}
                  }

                  // 4. Record authorization lineage for this repair run
                  authorizedRevealedBaselinePaths.add(normPath);

                  if (causality.isAuthorizedRepairFollowup) {
                    console.log(
                      `[REPAIR_FOLLOWUP] file=${cleanPath} diagnostic=${diag.code} symbol=${diag.symbolName} causedByAuthorizedRepair=true authorized=true`
                    );
                  } else {
                    console.log(
                      `[REVEALED_SCOPE] file=${cleanPath} baselineSource=${sourceInfo.origin} classification=REVEALED_BASELINE authorized=true`
                    );
                  }
                }
              } else {
                console.log(
                  `[REVEALED_SCOPE] file=${cleanPath} authorized=false reason=AGENT_TOUCHED_OR_REGRESSION`
                );
              }
            } else {
              console.log(
                `[REVEALED_SCOPE] file=${cleanPath} authorized=false reason=NO_BASELINE_PROOF`
              );
            }
          }
        }

        // Dedicated MISSING_DEP routing: stop generic repair loop; allow at most 1 bounded dependency correction
        if (valErrClassification.type === "MISSING_DEP") {
          console.warn(`[SelfHealingEngine] Detected MISSING_DEP. Routing to bounded dependency-safe correction.`);

          let installedPackages: string[] = [];
          if (localPath) {
            const pkgPath = path.join(localPath, "package.json");
            if (fs.existsSync(pkgPath)) {
              try {
                const pkgContent = fs.readFileSync(pkgPath, "utf8");
                const arch = detectRepositoryArchitecture([], pkgContent);
                installedPackages = arch.installedPackages;
              } catch {}
            }
          }

          // Build effective repair context for MISSING_DEP:
          // 1. Start with existing currentChanges (deduplicated by normalized path)
          const effectiveRepairContextChanges: AgentFileChange[] = [];
          const seenPaths = new Set<string>();

          for (const c of currentChanges) {
            const norm = normalizeRepoPath(c.path);
            if (!seenPaths.has(norm)) {
              seenPaths.add(norm);
              effectiveRepairContextChanges.push(c);
            }
          }

          // 2. Hydrate any authorized diagnostic files from parsedDiags not already in currentChanges
          for (const diag of parsedDiags) {
            const rawPath = diag.file || (diag as any).filePath;
            if (!rawPath) continue;
            const cleanPath = rawPath.replace(/^\.\//, "").replace(/\\/g, "/");
            const norm = normalizeRepoPath(cleanPath);

            if (seenPaths.has(norm)) continue;

            const isApprovedInManifest = approvedManifest?.files?.some((f) => normalizeRepoPath(f.path) === norm);
            const isAuthorizedRevealed = authorizedRevealedBaselinePaths.has(norm);

            if (isApprovedInManifest || isAuthorizedRevealed) {
              let currentContent: string | null = null;
              if (localPath) {
                const abs = path.join(localPath, cleanPath);
                if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
                  try {
                    currentContent = fs.readFileSync(abs, "utf8");
                  } catch {}
                }
              }

              if (currentContent !== null) {
                seenPaths.add(norm);
                effectiveRepairContextChanges.push({
                  path: cleanPath,
                  content: currentContent,
                  action: "modify",
                  description: "Hydrated authorized target for dependency repair",
                });
              }
            }
          }

          modelRepairAttempts++;
          let depCorrectionSucceeded = false;
          let depChanges: AgentFileChange[] = [...currentChanges];

          try {
            const openai = getOpenAI();
            const depCompletion = await openai.chat.completions.create({
              model: "gpt-4o",
              messages: [
                {
                  role: "system",
                  content: `You are a Dependency-Safe Code Repair Assistant. The build failed with MISSING_DEP:\n${validation.errors}\nYou MUST NOT import uninstalled packages. Available installed packages: [${installedPackages.join(", ")}]. Rewrite the affected code using ONLY available packages or native JavaScript/TypeScript standard APIs. Respond with JSON: { "changes": [{ "path": "...", "content": "..." }] }`,
                },
                {
                  role: "user",
                  content: `ORIGINAL REQUEST: ${originalMessage}\nCURRENT CHANGES:\n${JSON.stringify(effectiveRepairContextChanges.map(c => ({ path: c.path, content: c.content })))}`,
                },
              ],
              temperature: 0.0,
              response_format: { type: "json_object" },
            });

            const parsed = JSON.parse(depCompletion.choices[0]?.message?.content || "{}");
            if (Array.isArray(parsed.changes) && parsed.changes.length > 0) {
              const importCheck = ImportValidator.validateChangesImports(parsed.changes, installedPackages);
              const secCheck = SecurityPolicy.checkChanges(parsed.changes);

              if (importCheck.valid && secCheck.safe) {
                const appliedDepChanges: AgentFileChange[] = parsed.changes.map((c: any) => ({
                  path: c.path,
                  content: c.content || "",
                  action: "modify" as const,
                  description: "Fix missing dependency",
                }));

                const merged = [...currentChanges];
                for (const change of appliedDepChanges) {
                  const norm = normalizeRepoPath(change.path);
                  const existingIdx = merged.findIndex((c) => normalizeRepoPath(c.path) === norm);
                  if (existingIdx !== -1) {
                    merged[existingIdx] = change;
                  } else {
                    merged.push(change);
                  }
                }
                depChanges = merged;
                if (localPath && fsManager) {
                  await fsManager.apply(appliedDepChanges, localPath);
                }
                depCorrectionSucceeded = true;
                patchesAppliedCount += appliedDepChanges.length;
              }
            }
          } catch (e: any) {
            console.warn("[SelfHealingEngine] Bounded missing dependency correction error:", e?.message);
          }

          if (depCorrectionSucceeded && localPath && commands.length > 0) {
            buildAttempts++;
            const retryBuild = await ValidationRunner.validateWithShell([], localPath, commands);
            if (retryBuild.success) {
              return {
                finalChanges: depChanges,
                attempts: attempt,
                success: true,
                errorType: "MISSING_DEP",
                repairTrigger: "SHELL_VALIDATION_FAILURE",
                repairApplied: true,
                repaired: true,
                rootFailure,
                currentFailure: undefined,
                buildAttemptsCount: buildAttempts,
                modelRepairAttempts,
                patchesAppliedCount,
              };
            }

            // Retry build failed. Determine whether the ORIGINAL missing dependency diagnostic is still present.
            const originalMissingDeps = extractMissingDepKeys(parsedDiags, validation.errors);
            const retryDiags = ErrorDiagnosticsParser.parse(retryBuild.errors);
            const retryMissingDeps = extractMissingDepKeys(retryDiags, retryBuild.errors);

            let sameDepStillPresent = false;
            if (originalMissingDeps.size > 0) {
              for (const depKey of originalMissingDeps) {
                if (retryMissingDeps.has(depKey)) {
                  sameDepStillPresent = true;
                  break;
                }
                const pkgOnly = depKey.split("|")[1];
                if (pkgOnly) {
                  for (const retryKey of retryMissingDeps) {
                    if (retryKey.split("|")[1] === pkgOnly) {
                      sameDepStillPresent = true;
                      break;
                    }
                  }
                }
                if (sameDepStillPresent) break;
              }
            } else {
              const retryClass = ErrorClassifier.classify(retryBuild.errors);
              if (retryClass.type === "MISSING_DEP" && retryBuild.errors.trim() === validation.errors.trim()) {
                sameDepStillPresent = true;
              }
            }

            if (!sameDepStillPresent) {
              // PROGRESS: Original missing dependency was resolved; next cycle will handle the newly revealed diagnostic
              console.log(`[SelfHealingEngine] MISSING_DEP progress: original missing dependency resolved. Transitioning to next repair cycle.`);
              currentChanges = depChanges;
              previousErrors = retryBuild.errors;
              appliedPatchesInPrevCycle = true;
              repairApplied = true;
              continue;
            }

            return {
              finalChanges: depChanges,
              attempts: attempt,
              success: false,
              errorLog: `[MISSING_DEP] Unresolved missing dependency: ${retryBuild.errors}\n\nROOT BUILD FAILURE:\n${rootFailure?.stderr || validation.errors}`,
              errorType: "MISSING_DEP",
              rootFailure,
              currentFailure: retryBuild.errors,
              validationDetails: {
                rootFailure,
                currentFailure: retryBuild.errors,
                repairAttempts: repairAttemptsHistory,
                finalFailure: "MISSING_DEP",
                modelRepairAttempts,
                patchesApplied: patchesAppliedCount,
                buildAttempts,
              },
              buildAttemptsCount: buildAttempts,
              modelRepairAttempts,
              patchesAppliedCount,
            };
          }

          return {
            finalChanges: depChanges,
            attempts: attempt,
            success: false,
            errorLog: `[MISSING_DEP] Unresolved missing dependency: ${validation.errors}\n\nROOT BUILD FAILURE:\n${rootFailure?.stderr || validation.errors}`,
            errorType: "MISSING_DEP",
            rootFailure,
            currentFailure: validation.errors,
            validationDetails: {
              rootFailure,
              currentFailure: validation.errors,
              repairAttempts: repairAttemptsHistory,
              finalFailure: "MISSING_DEP",
              modelRepairAttempts,
              patchesApplied: patchesAppliedCount,
              buildAttempts,
            },
            buildAttemptsCount: buildAttempts,
            modelRepairAttempts,
            patchesAppliedCount,
          };
        }

        // Progress Tracking & Identical Failure Breakers
        const currentDiagCount = parsedDiags.length;
        const currentFingerprint = computeFailureFingerprint(valErrClassification.type, validation.errors, parsedDiags);
        const currentFailureCode = parsedDiags[0]?.code || valErrClassification.type;

        let progressMade = false;
        if (previousFingerprint === null) {
          progressMade = true;
        } else if (appliedPatchesInPrevCycle) {
          if (currentDiagCount < (previousDiagnosticCount ?? Infinity)) {
            progressMade = true; // Error count decreased
          } else if (currentFingerprint !== previousFingerprint) {
            progressMade = true; // Failure fingerprint evolved
          }
        }

        if (progressMade) {
          if (previousFailureCode && previousFailureCode !== currentFailureCode) {
            resolvedFailureSequence.push(previousFailureCode);
          }
          identicalFailureCount = 0;
          noProgressCount = 0;
        } else {
          if (currentFingerprint === previousFingerprint) {
            identicalFailureCount++;
          }
          noProgressCount++;
          noProgressCyclesCount++;
        }

        previousFailureCode = currentFailureCode;
        previousFingerprint = currentFingerprint;
        previousDiagnosticCount = currentDiagCount;
        appliedPatchesInPrevCycle = false;

        // Emergency Breaker 2: Identical failure repeated
        if (identicalFailureCount >= MAX_IDENTICAL_FAILURES) {
          console.warn(`[SelfHealingEngine] Emergency breaker tripped: Identical failure repeated ${identicalFailureCount} times. Halting repair.`);
          if (!SPECIFIC_GATE_ERRORS.has(lastErrorType)) {
            lastErrorType = "NO_REPAIR_PROGRESS";
          }
          previousErrors = `[${lastErrorType}] Failure fingerprint persisted without progress (${identicalFailureCount} consecutive repairs).`;
          break;
        }

        // Emergency Breaker 3: No progress cycles
        if (noProgressCount >= MAX_NO_PROGRESS_CYCLES) {
          console.warn(`[SelfHealingEngine] Emergency breaker tripped: No progress made across ${noProgressCount} consecutive cycles. Halting repair.`);
          if (!SPECIFIC_GATE_ERRORS.has(lastErrorType)) {
            lastErrorType = "NO_REPAIR_PROGRESS";
          }
          previousErrors = `[${lastErrorType}] No repair progress made across ${noProgressCount} consecutive repair cycles.`;
          break;
        }
      }

      const diagnostics = ErrorDiagnosticsParser.parse(previousErrors);
      const patchesApplied: SurgicalPatchChunk[] = [];
      let totalLinesChanged = 0;
      let totalFileLines = 0;

      if (diagnostics.length > 0) {
        for (const diag of diagnostics.slice(0, 3)) {
          let targetChangeIdx = currentChanges.findIndex(
            (c) => c.path.replace(/\\/g, "/").endsWith(diag.file) || diag.file.endsWith(c.path.replace(/\\/g, "/")),
          );

          if (targetChangeIdx < 0 && localPath && approvedManifest) {
            const manifestMatch = approvedManifest.files.find(
              (f) => f.path.replace(/\\/g, "/").endsWith(diag.file) || diag.file.endsWith(f.path.replace(/\\/g, "/")),
            );
            if (manifestMatch) {
              const abs = path.join(localPath, manifestMatch.path);
              if (fs.existsSync(abs)) {
                try {
                  const content = fs.readFileSync(abs, "utf8");
                  currentChanges.push({
                    path: manifestMatch.path,
                    content,
                    action: manifestMatch.action as any,
                    description: "Hydrated for surgical repair",
                  });
                  targetChangeIdx = currentChanges.length - 1;
                } catch {}
              }
            }
          }

          if (targetChangeIdx >= 0) {
            const originalFile = currentChanges[targetChangeIdx];
            totalFileLines = originalFile.content.split("\n").length;

            const minPatch = SurgicalPatchEngine.generateMinimalPatch(originalFile.content, originalFile.path, diag);

            if (minPatch.replacementContent !== minPatch.targetContent) {
              const res = SurgicalPatchEngine.applyPatch(originalFile.content, minPatch);
              currentChanges[targetChangeIdx].content = res.newContent;
              patchesApplied.push(minPatch);
              patchesAppliedCount++;
              totalLinesChanged += res.linesChanged;
              appliedPatchesInPrevCycle = true;
              repairApplied = true;

              repairAttemptsHistory.push({
                attempt,
                proposalResult: "APPLIED",
                patchResult: `[SURGICAL_REPAIR] Deterministic patch applied to ${originalFile.path} (${minPatch.affectedNodeName || "AST"})`,
                validationResult: "PENDING_VERIFICATION",
              });
            }
          }
        }
      }

      if (patchesApplied.length === 0) {
        // Read CURRENT live worktree file contents directly from disk
        const currentFileContext: Record<string, string> = {};
        if (localPath) {
          const pathsToRead = approvedManifest
            ? approvedManifest.files.map((f) => f.path)
            : currentChanges.map((c) => c.path);

          for (const relPath of pathsToRead) {
            const abs = path.join(localPath, relPath);
            try {
              if (fs.existsSync(abs)) {
                currentFileContext[relPath] = await fs.promises.readFile(abs, "utf8");
              }
            } catch {}
          }
        } else {
          for (const c of currentChanges) {
            currentFileContext[c.path] = c.content;
          }
        }

        modelRepairAttempts++;
        const openai = getOpenAI();
        const prompt = buildSelfHealingRepairPrompt({
          errorLog: previousErrors,
          diagnostics,
          currentFiles: currentFileContext,
          approvedManifest,
          contract: executionContract,
          originalMessage,
          attempt,
          maxRetries: MAX_TOTAL_REPAIR_CYCLES,
        });

        const repairCompletion = await openai.chat.completions.create({
          model: "gpt-4o",
          messages: [
            { role: "system", content: prompt.system },
            { role: "user", content: prompt.user },
          ],
          temperature: 0.1,
          max_tokens: 8000,
          response_format: { type: "json_object" },
        });

        try {
          const repairParsed = JSON.parse(repairCompletion.choices[0]?.message?.content || "{}");
          const proposals: RepairChangeProposal[] = Array.isArray(repairParsed.changes)
            ? repairParsed.changes
            : [];

          if (proposals.length > 0) {
            // Emergency Breaker 4: Proposal fingerprint check
            const proposalFingerprint = proposals
              .map(
                (p) =>
                  `${p.path}:${p.action}:${
                    p.action === "modify"
                      ? p.edits?.map((e) => `${e.oldText}->${e.newText}`).join(";")
                      : p.content
                  }`,
              )
              .join("|");

            if (attemptedProposalFingerprints.has(proposalFingerprint)) {
              repeatedProposalsBlockedCount++;
              repairAttemptsHistory.push({
                attempt,
                proposalResult: "REPEATED",
                patchResult: "[REPEATED_REPAIR_PROPOSAL] Model proposed identical repair proposal",
                validationResult: "UNRESOLVED",
              });

              if (!SPECIFIC_GATE_ERRORS.has(lastErrorType)) {
                lastErrorType = "REPEATED_REPAIR_PROPOSAL";
              }
              previousErrors = `[${lastErrorType}] Stopping repair loop: Model proposed identical repair that was already attempted.`;
              break;
            }
            attemptedProposalFingerprints.add(proposalFingerprint);

            if (isRepositoryMode || approvedManifest) {
              const manifestPrecheck = validateRepairManifestScope(proposals, approvedManifest);
              if (!manifestPrecheck.valid) {
                previousErrors = `[${manifestPrecheck.error.code}] ${manifestPrecheck.error.message}`;
                lastErrorType = manifestPrecheck.error.code;
                repairAttemptsHistory.push({
                  attempt,
                  proposalResult: "SCOPE_REJECTED",
                  patchResult: `[${manifestPrecheck.error.code}] ${manifestPrecheck.error.message}`,
                  validationResult: "UNRESOLVED",
                });
                continue;
              }

              let resolution = resolveRepairProposals(proposals, currentFileContext);

              // Bounded repair correction (max 1 correction attempt)
              if (!resolution.success) {
                const err = resolution.error;
                const isEligibleForCorrection =
                  (err.code === "NO_OP_PATCH_EDIT" ||
                    err.code === "PATCH_TARGET_NOT_FOUND" ||
                    err.code === "AMBIGUOUS_PATCH_TARGET") &&
                  typeof err.proposalIndex === "number" &&
                  proposals[err.proposalIndex]?.action === "modify";

                if (isEligibleForCorrection) {
                  const failedProposal = proposals[err.proposalIndex!] as {
                    path: string;
                    action: "modify";
                    edits: any[];
                    description: string;
                  };

                  const correction = await PatchCorrectionEngine.correctPatch({
                    filePath: failedProposal.path,
                    currentContent: currentFileContext[failedProposal.path] || "",
                    userMessage: `Fix compiler build error: ${rootFailure?.stderr || previousErrors}`,
                    manifestAction: "modify",
                    failedEdits: failedProposal.edits,
                    errorCode: err.code === "AMBIGUOUS_PATCH_TARGET" ? "AMBIGUOUS_PATCH_TARGET" : "PATCH_TARGET_NOT_FOUND",
                    errorMessage: err.message,
                  });

                  if (correction.succeeded && correction.correctedEdits) {
                    failedProposal.edits = correction.correctedEdits;
                    const retryRes = resolveRepairProposals(proposals, currentFileContext);
                    if (retryRes.success) {
                      resolution = retryRes;
                    }
                  }
                }
              }

              if (!resolution.success) {
                previousErrors = `[${resolution.error.code}] ${resolution.error.message}`;
                lastErrorType = resolution.error.code;
                repairAttemptsHistory.push({
                  attempt,
                  proposalResult: "PATCH_FAILED",
                  patchResult: `[${resolution.error.code}] ${resolution.error.message}`,
                  validationResult: "UNRESOLVED",
                });

                // If resolution failed with NO_OP_PATCH_EDIT and bounded correction could not fix it, fail closed fast
                if (resolution.error.code === "NO_OP_PATCH_EDIT") {
                  return {
                    finalChanges: currentChanges,
                    attempts: attempt,
                    success: false,
                    errorLog: `[NO_OP_PATCH_EDIT] Repair proposal rejected: oldText and newText are identical. A modify edit must change something.\n\nROOT BUILD FAILURE:\n${rootFailure?.stderr || previousErrors}`,
                    errorType: "NO_OP_PATCH_EDIT",
                    rootFailure,
                    validationDetails: {
                      rootFailure,
                      repairAttempts: repairAttemptsHistory,
                      finalFailure: "NO_OP_PATCH_EDIT",
                      modelRepairAttempts,
                      patchesApplied: patchesAppliedCount,
                      buildAttempts,
                      distinctFailuresResolvedCount: resolvedFailureSequence.length,
                      noProgressCyclesCount,
                      repeatedProposalsBlockedCount,
                      finalStatus: "FAILED",
                      resolvedFailureSequence,
                    },
                    buildAttemptsCount: buildAttempts,
                    modelRepairAttempts,
                    patchesAppliedCount,
                  };
                }
                continue;
              }

              // ExecutionScopeEnforcer on resolved changes
              const existingFileList = Object.keys(currentFileContext);
              const scopeCheck = enforceExecutionScope({
                proposedChanges: resolution.changes,
                manifest: approvedManifest,
                contract: executionContract,
                existingFilePaths: existingFileList,
                isRepair: true,
              });

              if (!scopeCheck.valid) {
                previousErrors = `[SCOPE_VIOLATION] Execution scope violation in repair: ${scopeCheck.errors.map((e) => e.message).join("; ")}`;
                lastErrorType = "SCOPE_VIOLATION";
                repairAttemptsHistory.push({
                  attempt,
                  proposalResult: "SCOPE_VIOLATION",
                  patchResult: scopeCheck.errors.map((e) => `[${e.reason}] ${e.path}: ${e.message}`).join("; "),
                  validationResult: "UNRESOLVED",
                });
                continue;
              }

              // Current-State Version Guard (pre-write disk verification)
              if (
                localPath &&
                resolution.expectedSourceHashes &&
                Object.keys(resolution.expectedSourceHashes).length > 0
              ) {
                const versionCheck = await verifyFileVersionsFromDisk(
                  resolution.expectedSourceHashes,
                  localPath,
                );

                if (!versionCheck.valid) {
                  previousErrors = `[STALE_REPAIR_SOURCE] File "${versionCheck.error.path}" changed on disk during repair resolution.`;
                  lastErrorType = "STALE_REPAIR_SOURCE";
                  repairAttemptsHistory.push({
                    attempt,
                    proposalResult: "STALE_SOURCE",
                    patchResult: `File "${versionCheck.error.path}" changed on disk during repair resolution.`,
                    validationResult: "UNRESOLVED",
                  });
                  return {
                    finalChanges: currentChanges,
                    attempts: attempt,
                    success: false,
                    errorLog: `[STALE_REPAIR_SOURCE] File "${versionCheck.error.path}" changed on disk during repair resolution.\n\nROOT BUILD FAILURE:\n${rootFailure?.stderr || previousErrors}`,
                    errorType: "STALE_REPAIR_SOURCE",
                    rootFailure,
                    validationDetails: {
                      rootFailure,
                      repairAttempts: repairAttemptsHistory,
                      finalFailure: "STALE_REPAIR_SOURCE",
                      modelRepairAttempts,
                      patchesApplied: patchesAppliedCount,
                      buildAttempts,
                      distinctFailuresResolvedCount: resolvedFailureSequence.length,
                      noProgressCyclesCount,
                      repeatedProposalsBlockedCount,
                      finalStatus: "FAILED",
                      resolvedFailureSequence,
                    },
                    buildAttemptsCount: buildAttempts,
                    modelRepairAttempts,
                    patchesAppliedCount,
                  };
                }
              }

              // Merge resolved changes into current state
              const repairMap = new Map<string, AgentFileChange>(
                resolution.changes.map((c) => [normalizeRepoPath(c.path), c]),
              );
              const merged: AgentFileChange[] = currentChanges.map(
                (c) => repairMap.get(normalizeRepoPath(c.path)) || c,
              );
              for (const [p, c] of repairMap) {
                if (!merged.find((m) => normalizeRepoPath(m.path) === p)) {
                  merged.push(c);
                }
              }
              currentChanges = merged;
              repairApplied = true;
              appliedPatchesInPrevCycle = true;
              patchesAppliedCount += resolution.changes.length;

              repairAttemptsHistory.push({
                attempt,
                proposalResult: "APPLIED",
                patchResult: `Applied ${resolution.changes.length} repair change(s)`,
                validationResult: "PENDING_VERIFICATION",
              });
            } else {
              // Standalone fallback
              const legacyProposals = proposals as any[];
              const repairMap = new Map<string, AgentFileChange>(
                legacyProposals.map((c: AgentFileChange) => [c.path, c]),
              );
              const merged: AgentFileChange[] = currentChanges.map((c) => repairMap.get(c.path) || c);
              for (const [p, c] of repairMap) {
                if (!merged.find((m) => m.path === p)) merged.push(c as AgentFileChange);
              }
              currentChanges = merged;
              repairApplied = true;
              appliedPatchesInPrevCycle = true;
              patchesAppliedCount += legacyProposals.length;
            }
          }
        } catch (parseErr: any) {
          previousErrors = `[REPAIR_JSON_PARSE_ERROR] Failed parsing repair proposal: ${parseErr?.message || parseErr}`;
        }
      }
    }

    if (!lastErrorType || lastErrorType === "UNKNOWN" || totalCyclesExecuted >= MAX_TOTAL_REPAIR_CYCLES) {
      if (!SPECIFIC_GATE_ERRORS.has(lastErrorType)) {
        lastErrorType = "EMERGENCY_REPAIR_BUDGET_EXCEEDED";
      }
    }

    const finalErrorLog = rootFailure?.stderr
      ? `ROOT BUILD FAILURE:\n${rootFailure.stderr}\n\nFINAL REPAIR STATE:\n${lastErrorType}: ${previousErrors}`
      : previousErrors;

    return {
      finalChanges: currentChanges,
      attempts: totalCyclesExecuted,
      success: false,
      errorLog: finalErrorLog,
      errorType: lastErrorType,
      rootFailure,
      validationDetails: {
        rootFailure,
        repairAttempts: repairAttemptsHistory,
        finalFailure: lastErrorType,
        modelRepairAttempts,
        patchesApplied: patchesAppliedCount,
        buildAttempts,
        distinctFailuresResolvedCount: resolvedFailureSequence.length,
        noProgressCyclesCount,
        repeatedProposalsBlockedCount,
        finalStatus: "FAILED",
        resolvedFailureSequence,
      },
      buildAttemptsCount: buildAttempts,
      modelRepairAttempts,
      patchesAppliedCount,
    };
  }
}
