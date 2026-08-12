import fs from "fs";
import path from "path";
import { getOpenAI } from "../shared/utils";
import { AgentFileChange } from "../shared/types";
import { ValidationRunner } from "../validation/ValidationRunner";
import { FileSystemStateManager, RepairInfrastructureError } from "../validation/FileSystemStateManager";
import { ErrorDiagnosticsParser } from "./ErrorDiagnosticsParser";
import { SurgicalPatchEngine, SurgicalPatchChunk } from "./SurgicalPatchEngine";
import { RepairSessionTracker } from "./RepairSessionTracker";
import { buildSelfHealingRepairPrompt } from "../prompts/repair";

export class SelfHealingEngine {
  static async runSelfHealingLoop(
    initialChanges: AgentFileChange[],
    localPath: string | null | undefined,
    commands: string[],
    systemPrompt: string,
    originalMessage: string,
    fsManager?: FileSystemStateManager,
    projectId?: string,
  ): Promise<{
    finalChanges: AgentFileChange[];
    attempts: number;
    success: boolean;
    errorLog?: string;
    infrastructureError?: boolean;
  }> {
    const MAX_REPAIR_RETRIES = 5;
    let currentChanges = [...initialChanges];
    let previousErrors = "";
    const tracker = new RepairSessionTracker();

    for (let attempt = 1; attempt <= MAX_REPAIR_RETRIES; attempt++) {
      const attemptStart = performance.now();
      let validationSuccess = false;

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
          return { finalChanges: [], attempts: attempt, success: true };
        }
        previousErrors = initialCheck.errors;
      } else if (!currentChanges.length) {
        return { finalChanges: [], attempts: attempt, success: true };
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
              };
            }
          }
        } else if (localPath) {
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

          return { finalChanges: currentChanges, attempts: attempt, success: true };
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
        const openai = getOpenAI();
        const prompt = buildSelfHealingRepairPrompt({
          errorLog: previousErrors,
          changes: currentChanges,
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
          if (Array.isArray(repairParsed.changes) && repairParsed.changes.length > 0) {
            const repairMap = new Map<string, AgentFileChange>(repairParsed.changes.map((c: AgentFileChange) => [c.path, c]));
            const merged: AgentFileChange[] = currentChanges.map((c) => repairMap.get(c.path) || c);
            for (const [p, c] of repairMap) {
              if (!merged.find((m) => m.path === p)) merged.push(c as AgentFileChange);
            }
            currentChanges = merged;
          }
        } catch {}
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
    };
  }
}
