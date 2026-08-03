import fs from "fs";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { performance } from "perf_hooks";
import { StaticValidationEngine, SnapshotFile } from "./static-validator.engine";
import { ErrorDiagnosticsParser, SurgicalPatchEngine } from "./surgical-repair.engine";

const execAsync = promisify(exec);

// ─── Interfaces & Schemas ─────────────────────────────────────────────────────

export type PipelineStage =
  | "compile"
  | "lint"
  | "unit_tests"
  | "integration_tests"
  | "playwright_e2e"
  | "api_tests"
  | "feature_static_validation";

export interface StageResult {
  stage: PipelineStage;
  passed: boolean;
  durationMs: number;
  commandExecuted?: string;
  errorLog?: string;
  failureCause?: string;
}

export interface PipelineExecutionOptions {
  workspacePath?: string;
  snapshotFiles?: SnapshotFile[];
  commands?: {
    compile?: string;
    lint?: string;
    unitTests?: string;
    integrationTests?: string;
    playwright?: string;
    apiTests?: string;
  };
  maxRepairRetries?: number;
}

export interface AgentFileChange {
  path: string;
  content: string;
}

export interface ValidationPipelineResult {
  passed: boolean;
  totalDurationMs: number;
  attempts: number;
  stageResults: StageResult[];
  failedStage?: PipelineStage;
  repairHistory: Array<{ attempt: number; repaired: boolean; linesChanged: number }>;
  metrics: {
    passRatePct: number;
    failureCause: string | null;
    repairSuccess: boolean;
    stageDurations: Record<PipelineStage, number>;
  };
}

// ─── Automated Feature Validation Pipeline Engine ─────────────────────────────

export class AutomatedValidationPipelineEngine {
  private options: PipelineExecutionOptions;

  constructor(options?: PipelineExecutionOptions) {
    this.options = options || {};
  }

  /**
   * Execute the full 7-stage automated validation pipeline with surgical repair loops.
   */
  public async executePipeline(
    changes: AgentFileChange[],
  ): Promise<ValidationPipelineResult> {
    const startTime = performance.now();
    const maxRetries = this.options.maxRepairRetries || 3;
    const workspace = this.options.workspacePath || process.cwd();

    let currentChanges = [...changes];
    let finalPassed = false;
    let failedStage: PipelineStage | undefined;
    let stageResults: StageResult[] = [];
    const repairHistory: Array<{ attempt: number; repaired: boolean; linesChanged: number }> = [];

    let attempt = 1;

    for (; attempt <= maxRetries; attempt++) {
      stageResults = [];
      let currentAttemptFailed = false;

      // ── Stage 1: Compile Check ─────────────────────────────────────────────
      const compileRes = await this.runShellStage(
        "compile",
        this.options.commands?.compile || "npx tsc --noEmit",
        workspace,
      );
      stageResults.push(compileRes);
      if (!compileRes.passed) {
        currentAttemptFailed = true;
        failedStage = "compile";
      }

      // ── Stage 2: Linter Check ──────────────────────────────────────────────
      if (!currentAttemptFailed && this.options.commands?.lint) {
        const lintRes = await this.runShellStage("lint", this.options.commands.lint, workspace);
        stageResults.push(lintRes);
        if (!lintRes.passed) {
          currentAttemptFailed = true;
          failedStage = "lint";
        }
      }

      // ── Stage 3: Unit Tests ────────────────────────────────────────────────
      if (!currentAttemptFailed && this.options.commands?.unitTests) {
        const unitRes = await this.runShellStage("unit_tests", this.options.commands.unitTests, workspace);
        stageResults.push(unitRes);
        if (!unitRes.passed) {
          currentAttemptFailed = true;
          failedStage = "unit_tests";
        }
      }

      // ── Stage 4: Integration Tests ─────────────────────────────────────────
      if (!currentAttemptFailed && this.options.commands?.integrationTests) {
        const intRes = await this.runShellStage("integration_tests", this.options.commands.integrationTests, workspace);
        stageResults.push(intRes);
        if (!intRes.passed) {
          currentAttemptFailed = true;
          failedStage = "integration_tests";
        }
      }

      // ── Stage 5: Playwright E2E Tests ──────────────────────────────────────
      if (!currentAttemptFailed && this.options.commands?.playwright) {
        const pwRes = await this.runShellStage("playwright_e2e", this.options.commands.playwright, workspace);
        stageResults.push(pwRes);
        if (!pwRes.passed) {
          currentAttemptFailed = true;
          failedStage = "playwright_e2e";
        }
      }

      // ── Stage 6: API Endpoint Tests ────────────────────────────────────────
      if (!currentAttemptFailed && this.options.commands?.apiTests) {
        const apiRes = await this.runShellStage("api_tests", this.options.commands.apiTests, workspace);
        stageResults.push(apiRes);
        if (!apiRes.passed) {
          currentAttemptFailed = true;
          failedStage = "api_tests";
        }
      }

      // ── Stage 7: Static Feature Validation ─────────────────────────────
      if (!currentAttemptFailed) {
        const staticStart = performance.now();
        const snapshot = this.options.snapshotFiles || [];
        const staticRes = StaticValidationEngine.validate(snapshot, currentChanges);
        const staticMs = performance.now() - staticStart;

        stageResults.push({
          stage: "feature_static_validation",
          passed: staticRes.passed,
          durationMs: parseFloat(staticMs.toFixed(2)),
          commandExecuted: "StaticValidationEngine.validate()",
          errorLog: staticRes.issues.map((i) => `[${i.severity}] ${i.file}:${i.line} ${i.reason}`).join("\n"),
          failureCause: staticRes.issues[0]?.reason,
        });

        if (!staticRes.passed) {
          currentAttemptFailed = true;
          failedStage = "feature_static_validation";
        }
      }

      // If ALL active stages passed cleanly -> Accept and break!
      if (!currentAttemptFailed) {
        finalPassed = true;
        break;
      }

      // ── Failure Handling: Invoke Surgical Repair Loop ─────────────────────
      if (attempt < maxRetries) {
        const failedStageObj = stageResults.find((s) => !s.passed);
        const errorLog = failedStageObj?.errorLog || "";

        const diags = ErrorDiagnosticsParser.parse(errorLog);
        let linesChanged = 0;
        let repaired = false;

        if (diags.length > 0) {
          for (const diag of diags.slice(0, 2)) {
            const targetIdx = currentChanges.findIndex((c) => c.path.includes(diag.file));
            if (targetIdx >= 0) {
              const fileObj = currentChanges[targetIdx];
              const patch = SurgicalPatchEngine.generateMinimalPatch(fileObj.content, fileObj.path, diag);
              if (patch.replacementContent !== patch.targetContent) {
                const res = SurgicalPatchEngine.applyPatch(fileObj.content, patch);
                currentChanges[targetIdx].content = res.newContent;
                linesChanged += res.linesChanged;
                repaired = true;
              }
            }
          }
        }

        repairHistory.push({ attempt, repaired, linesChanged });
      }
    }

    const totalDurationMs = parseFloat((performance.now() - startTime).toFixed(2));
    const passedStagesCount = stageResults.filter((s) => s.passed).length;
    const passRatePct = parseFloat(((passedStagesCount / (stageResults.length || 1)) * 100).toFixed(1));

    const stageDurations: Record<PipelineStage, number> = {
      compile: 0,
      lint: 0,
      unit_tests: 0,
      integration_tests: 0,
      playwright_e2e: 0,
      api_tests: 0,
      feature_static_validation: 0,
    };

    for (const sr of stageResults) {
      stageDurations[sr.stage] = sr.durationMs;
    }

    const failedObj = stageResults.find((s) => !s.passed);

    const result: ValidationPipelineResult = {
      passed: finalPassed,
      totalDurationMs,
      attempts: Math.min(attempt, maxRetries),
      stageResults,
      failedStage,
      repairHistory,
      metrics: {
        passRatePct,
        failureCause: failedObj?.failureCause || failedObj?.errorLog || null,
        repairSuccess: finalPassed && attempt > 1,
        stageDurations,
      },
    };

    this.saveValidationReport(result);
    return result;
  }

  private async runShellStage(
    stage: PipelineStage,
    cmd: string,
    cwd: string,
  ): Promise<StageResult> {
    const start = performance.now();
    try {
      const { stdout, stderr } = await execAsync(cmd, { cwd, timeout: 60000 });
      const durationMs = parseFloat((performance.now() - start).toFixed(2));
      return {
        stage,
        passed: true,
        durationMs,
        commandExecuted: cmd,
        errorLog: stderr || stdout,
      };
    } catch (err: any) {
      const durationMs = parseFloat((performance.now() - start).toFixed(2));
      const log = err.stderr || err.stdout || err.message || "Command execution failed";
      return {
        stage,
        passed: false,
        durationMs,
        commandExecuted: cmd,
        errorLog: log,
        failureCause: `Stage "${stage}" failed executing "${cmd}"`,
      };
    }
  }

  private saveValidationReport(res: ValidationPipelineResult) {
    let md = `# AUTOMATED FEATURE VALIDATION PIPELINE REPORT\n\n`;
    md += `**Overall Status**: ${res.passed ? "✅ **ACCEPTED (PASSED ALL STAGES)**" : "❌ **REJECTED (FAILED)**"}  \n`;
    md += `**Total Attempts**: ${res.attempts}  \n`;
    md += `**Total Pipeline Latency**: ${res.totalDurationMs} ms  \n`;
    md += `**Pipeline Pass Rate**: **${res.metrics.passRatePct}%**  \n\n`;

    if (res.metrics.failureCause) {
      md += `> [!CAUTION]\n> **Primary Failure Cause**: ${res.metrics.failureCause.slice(0, 200)}\n\n`;
    }

    md += `---\n\n`;
    md += `## 🏁 Stage Execution Breakdown\n\n`;
    md += `| Stage | Command | Status | Duration | Failure Log |\n`;
    md += `| :--- | :--- | :--- | :--- | :--- |\n`;

    for (const sr of res.stageResults) {
      md += `| \`${sr.stage}\` | \`${sr.commandExecuted || "N/A"}\` | ${sr.passed ? "✅ PASS" : "❌ FAIL"} | ${sr.durationMs} ms | ${sr.passed ? "None" : `\`${(sr.failureCause || sr.errorLog || "").slice(0, 60)}\``} |\n`;
    }

    try {
      const outputDir = path.join(process.cwd(), "benchmarks");
      if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
      fs.writeFileSync(path.join(outputDir, "validation-pipeline-summary.md"), md, "utf8");
    } catch {}
  }
}
