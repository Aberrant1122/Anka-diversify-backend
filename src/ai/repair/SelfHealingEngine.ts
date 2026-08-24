import fs from "fs";
import path from "path";
import { getOpenAI } from "../shared/utils";
import { AgentFileChange, AgentProgressEvent, ExecutionContract } from "../shared/types";
import { FileManifest } from "../../types";
import { ValidationRunner } from "../validation/ValidationRunner";
import { FileSystemStateManager, RepairInfrastructureError } from "../validation/FileSystemStateManager";
import { ErrorClassifier } from "../validation/ErrorClassifier";
import { ErrorDiagnosticsParser } from "./ErrorDiagnosticsParser";
import { SurgicalPatchEngine, SurgicalPatchChunk } from "./SurgicalPatchEngine";
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
  ): Promise<{
    finalChanges: AgentFileChange[];
    attempts: number;
    success: boolean;
    errorLog?: string;
    infrastructureError?: boolean;
    errorType?: string;
  }> {
    const isRepositoryMode = executionContract?.pipeline === "REPOSITORY";

    // Change 1: Fail closed if repository self-healing is invoked without required approved scope
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
      };
    }

    const MAX_REPAIR_RETRIES = 5;
    let currentChanges = [...initialChanges];
    let previousErrors = "";
    let lastErrorType = "UNKNOWN";
    const tracker = new RepairSessionTracker();

    for (let attempt = 1; attempt <= MAX_REPAIR_RETRIES; attempt++) {
      const attemptStart = performance.now();
      let validationSuccess = false;

      const classification = ErrorClassifier.classify(previousErrors);
      lastErrorType = classification.type;

      onProgress?.({
        step: 8,
        stageName: "SELF_HEALING",
        label: "Build Repair",
        detail: `Repair attempt ${attempt}/${MAX_REPAIR_RETRIES} — ${classification.type}`,
        color: "text-orange-400 border-orange-500/30 bg-orange-500/10",
        badge: `STAGE 8 · Attempt ${attempt}/${MAX_REPAIR_RETRIES}`,
        progress: 75 + Math.round((attempt / MAX_REPAIR_RETRIES) * 10),
        log: `[Stage 8] Repair attempt ${attempt}/${MAX_REPAIR_RETRIES}: ${previousErrors ? previousErrors.slice(0, 200) : "Running initial validation"}`,
        durationMs: performance.now() - attemptStart,
      });

      if (!currentChanges.length && localPath) {
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
          return { finalChanges: [], attempts: attempt, success: true, errorType: classification.type };
        }
        previousErrors = initialCheck.errors;
      } else if (!currentChanges.length) {
        return { finalChanges: [], attempts: attempt, success: true, errorType: classification.type };
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
              };
            }
          }
        } else if (localPath && !isRepositoryMode) {
          // Preserve standalone direct write only where fsManager is omitted and not in repository mode
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

          return { finalChanges: currentChanges, attempts: attempt, success: true, errorType: classification.type };
        }

        previousErrors = validation.errors;
      }

      const diagnostics = ErrorDiagnosticsParser.parse(previousErrors);
      const patchesApplied: SurgicalPatchChunk[] = [];
      let totalLinesChanged = 0;
      let totalFileLines = 0;

      if (diagnostics.length > 0) {
        for (const diag of diagnostics.slice(0, 3)) {
          const targetChangeIdx = currentChanges.findIndex(
            (c) => c.path.replace(/\\/g, "/").endsWith(diag.file) || diag.file.endsWith(c.path.replace(/\\/g, "/")),
          );

          if (targetChangeIdx >= 0) {
            const originalFile = currentChanges[targetChangeIdx];
            totalFileLines = originalFile.content.split("\n").length;

            const minPatch = SurgicalPatchEngine.generateMinimalPatch(originalFile.content, originalFile.path, diag);

            if (minPatch.replacementContent !== minPatch.targetContent) {
              const res = SurgicalPatchEngine.applyPatch(originalFile.content, minPatch);
              currentChanges[targetChangeIdx].content = res.newContent;
              patchesApplied.push(minPatch);
              totalLinesChanged += res.linesChanged;
            }
          }
        }
      }

      if (patchesApplied.length === 0) {
        // Change 8: Read CURRENT file contents from bounded localPath
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

        const openai = getOpenAI();
        const prompt = buildSelfHealingRepairPrompt({
          errorLog: previousErrors,
          diagnostics,
          currentFiles: currentFileContext,
          approvedManifest,
          contract: executionContract,
          originalMessage,
          attempt,
          maxRetries: MAX_REPAIR_RETRIES,
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
            if (isRepositoryMode || approvedManifest) {
              // Change 5: Deterministic Manifest Precheck on Repair Proposals
              const manifestPrecheck = validateRepairManifestScope(proposals, approvedManifest);
              if (!manifestPrecheck.valid) {
                previousErrors = `[${manifestPrecheck.error.code}] ${manifestPrecheck.error.message}`;
                lastErrorType = manifestPrecheck.error.code;
                continue;
              }

              // Change 4: Structured Repair Proposal Resolution
              const resolution = resolveRepairProposals(proposals, currentFileContext);
              if (!resolution.success) {
                previousErrors = `[${resolution.error.code}] ${resolution.error.message}`;
                lastErrorType = resolution.error.code;
                continue;
              }

              // Change 6: ExecutionScopeEnforcer on resolved changes
              const existingFileList = Object.keys(currentFileContext);
              const scopeCheck = enforceExecutionScope({
                proposedChanges: resolution.changes,
                manifest: approvedManifest,
                contract: executionContract,
                existingFilePaths: existingFileList,
              });

              if (!scopeCheck.valid) {
                const errorDetails = scopeCheck.errors
                  .map((e) => `• [${e.reason}] ${e.path}: ${e.message}`)
                  .join("\n");
                previousErrors = `[Execution Scope Violation in Repair Attempt ${attempt}]\n${errorDetails}`;
                lastErrorType = "SCOPE_VIOLATION";
                continue;
              }

              // Change 7: Current-State Version Guard (pre-write disk verification)
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
                  previousErrors = `[STALE_REPAIR_SOURCE] File "${versionCheck.error.path}" changed on disk during repair resolution. Expected current hash ${versionCheck.error.expectedHashPrefix || ""}.`;
                  lastErrorType = "STALE_REPAIR_SOURCE";
                  continue;
                }
              }

              // Change 9: Merge resolved changes into current state
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
            }
          }
        } catch (parseErr: any) {
          previousErrors = `[REPAIR_JSON_PARSE_ERROR] Failed parsing repair proposal: ${parseErr?.message || parseErr}`;
        }
      }

      const attemptTimeMs = performance.now() - attemptStart;
      const patchSizePct = totalFileLines > 0 ? parseFloat(((totalLinesChanged / totalFileLines) * 100).toFixed(2)) : 0;

      tracker.recordAttempt({
        attempt,
        timestamp: new Date().toISOString(),
        diagnostics,
        patchesApplied,
        totalFileLines,
        linesChanged: totalLinesChanged,
        patchSizePct,
        repairTimeMs: attemptTimeMs,
        compileSuccess: false,
      });
    }

    return {
      finalChanges: currentChanges,
      attempts: MAX_REPAIR_RETRIES,
      success: false,
      errorLog: previousErrors,
      errorType: lastErrorType,
    };
  }
}
