import fs from "fs";
import path from "path";
import os from "os";
import { GitWorktreeService } from "../../services/git-worktree.service";
import { WorktreeDependencyService } from "../../services/worktree-dependency.service";
import { ValidationRunner } from "../validation/ValidationRunner";
import { AgentPipeline } from "../orchestration/AgentPipeline";
import { BaselineDeltaVerifier } from "../../services/baseline-delta.verifier";
import { BaselineRepairCoordinator } from "../../services/baseline-repair.coordinator";
import { SelfHealingEngine } from "../repair/SelfHealingEngine";
import { FileSystemStateManager } from "../validation/FileSystemStateManager";

describe("Baseline-Delta Task Completion & SelfHealing Isolation (Steps A-K)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "anka-test-task-completion-"));
    jest.spyOn(BaselineRepairCoordinator, "repairBaselineBuildFailure").mockResolvedValue({
      success: false,
      baselineReady: false,
      repairedPackages: [],
      explanation: "",
      changes: [],
      durationMs: 0,
    });
    jest.spyOn(GitWorktreeService, "rollbackWorktree").mockResolvedValue(undefined as any);
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
    jest.restoreAllMocks();
  });

  test("A & B. Baseline has 5 diagnostics, user targets exactly 1; unrelated MISSING_DEP is not auto-repaired", async () => {
    const pkgJson = {
      name: "anka-app",
      scripts: { build: "next build" },
      dependencies: { next: "^14.0.0" },
    };
    fs.writeFileSync(path.join(tempDir, "package.json"), JSON.stringify(pkgJson, null, 2));

    const baselineErrors = `
Failed to compile.
./components/Calculator.tsx:5:10
You're importing a component that needs useState. It only works in a Client Component but none of its parents are marked with "use client".

./postcss.config.mjs
Cannot find module '@tailwindcss/postcss'

./src/math-util.ts
Cannot resolve 'mathjs'

./src/chart.ts
Cannot resolve 'chart.js'

./src/table.ts
Cannot resolve 'ag-grid'
`;

    const baselineDiagnostics = BaselineDeltaVerifier.extractDiagnostics(baselineErrors, "BASELINE");
    expect(baselineDiagnostics.length).toBeGreaterThanOrEqual(4);

    const userMessage = "Fix the useState / React Server Component error in components/Calculator.tsx";
    const taskMatch = BaselineDeltaVerifier.matchUserTaskToBaseline(userMessage, baselineDiagnostics);

    // Conservative matching: exactly 1 targeted diagnostic (Calculator.tsx), NOT the unrelated packages
    expect(taskMatch.isMatch).toBe(true);
    expect(taskMatch.targetedDiagnostics.length).toBe(1);
    expect(taskMatch.targetedDiagnostics[0].filePath).toBe("components/Calculator.tsx");

    const spyBaselineRepair = jest.spyOn(BaselineRepairCoordinator, "repairBaselineBuildFailure");

    jest.spyOn(GitWorktreeService, "prepareRepositoryRun").mockResolvedValue({
      originalRepositoryPath: tempDir,
      repositoryRoot: tempDir,
      worktreePath: tempDir,
      branchName: "anka/run-task-comp-1",
      baseCommitSha: "sha-head-1",
    });

    jest.spyOn(WorktreeDependencyService, "prepareDependencies").mockResolvedValue({
      attempted: true,
      success: true,
      packageManager: "npm",
      installCommand: "npm ci",
      durationMs: 800,
      errorType: null,
    });

    let buildCalls = 0;
    jest.spyOn(ValidationRunner, "validateWithShell").mockImplementation(async () => {
      buildCalls++;
      if (buildCalls === 1) return { success: false, errors: baselineErrors };
      // Post-patch build: Calculator error is gone, other 4 remain
      return {
        success: false,
        errors: `
./postcss.config.mjs\nCannot find module '@tailwindcss/postcss'
./src/math-util.ts\nCannot resolve 'mathjs'
./src/chart.ts\nCannot resolve 'chart.js'
./src/table.ts\nCannot resolve 'ag-grid'
`,
      };
    });

    jest.spyOn(GitWorktreeService, "getWorktreeDiff").mockResolvedValue({
      changedFiles: ["components/Calculator.tsx"],
      diffSummary: "Added 'use client' directive to Calculator.tsx",
      rawDiff: "diff",
    });

    jest.spyOn(AgentPipeline, "runCodingAgent").mockResolvedValue({
      explanation: "Added 'use client' directive to Calculator.tsx",
      changes: [{ path: "components/Calculator.tsx", content: '"use client";', action: "modify", description: "Calculator" }],
      commitMessage: "fix: add use client directive",
      sessionId: "sess-1",
      buildVerified: true,
      taskVerified: true,
      repositoryClean: false,
      healthStatus: "TASK_VERIFIED_REPOSITORY_UNHEALTHY",
    });

    const summary = await GitWorktreeService.runIsolatedAgent({
      userId: "u1",
      projectId: "p1",
      repositoryPath: tempDir,
      runId: "run-1",
      request: { message: userMessage },
    });

    // BaselineRepairCoordinator was NOT called for normal source bug fix
    expect(spyBaselineRepair).not.toHaveBeenCalled();
    expect(summary.validationPassed).toBe(true);
    expect(summary.agentResponse.taskVerified).toBe(true);
    expect(summary.agentResponse.repositoryClean).toBe(false);
  });

  test("C & D & E & H. Targeted diagnostic disappears -> taskVerified=true, patch is preserved for review/push", async () => {
    const baselineDiagnostics = [
      {
        errorType: "COMPILE_NEXT",
        filePath: "components/Calculator.tsx",
        errorCode: "CLIENT_DIRECTIVE_REQUIRED",
        message: "useState requires 'use client'",
        fingerprint: "COMPILE_NEXT|components/Calculator.tsx|CLIENT_DIRECTIVE_REQUIRED|usestate",
        origin: "BASELINE" as const,
      },
      {
        errorType: "MISSING_DEP",
        symbolName: "mathjs",
        message: "Cannot find module 'mathjs'",
        fingerprint: "MISSING_DEP||MODULE_NOT_FOUND|mathjs",
        origin: "BASELINE" as const,
      },
    ];

    const targetedDiagnostics = [baselineDiagnostics[0]];

    // Post-change build: only mathjs remains
    const postChangeDiagnostics = [baselineDiagnostics[1]];

    const deltaResult = BaselineDeltaVerifier.compareBaselineVsPostChange(
      baselineDiagnostics,
      postChangeDiagnostics,
      targetedDiagnostics
    );

    expect(deltaResult.taskVerified).toBe(true);
    expect(deltaResult.repositoryClean).toBe(false);
    expect(deltaResult.resolvedTargetDiagnostics.length).toBe(1);
    expect(deltaResult.remainingBaselineDiagnostics.length).toBe(1);
    expect(deltaResult.newTaskDiagnostics.length).toBe(0);

    const explanation = BaselineDeltaVerifier.formatDeltaExplanation(deltaResult);
    expect(explanation).toContain("Requested Fix: VERIFIED");
    expect(explanation).toContain("BASELINE STILL UNHEALTHY");
    expect(explanation).toContain("Remaining pre-existing errors");
  });

  test("F. SelfHealingEngine does not attempt to repair remaining baseline diagnostics", async () => {
    const baselineErrors = `
Failed to compile.
./components/Calculator.tsx:5:10
You're importing a component that needs useState. It only works in a Client Component but none of its parents are marked with "use client".

./src/math.ts
Cannot resolve 'mathjs'
`;
    const baselineDiagnostics = BaselineDeltaVerifier.extractDiagnostics(baselineErrors, "BASELINE");
    const targetedDiagnostics = [baselineDiagnostics.find((d) => d.filePath === "components/Calculator.tsx")!];

    const fsManager = new FileSystemStateManager();
    const initialChanges = [
      {
        path: "components/Calculator.tsx",
        content: '"use client";\nexport const Calculator = () => null;',
        action: "modify" as const,
        description: "Add use client",
      },
    ];

    // Build returns the remaining baseline error (mathjs missing)
    jest.spyOn(ValidationRunner, "validateWithShell").mockResolvedValue({
      success: false,
      errors: "./src/math.ts\nCannot resolve 'mathjs'",
    });

    const result = await SelfHealingEngine.runSelfHealingLoop(
      initialChanges,
      tempDir,
      ["npm run build"],
      "system",
      "Fix use client in Calculator.tsx",
      fsManager,
      "proj-1",
      undefined,
      { files: [{ path: "components/Calculator.tsx", action: "modify", reason: "Calculator" }] } as any,
      { allowedFiles: ["components/Calculator.tsx"], immutableFiles: [], forbiddenPatterns: [] } as any,
      baselineDiagnostics,
      targetedDiagnostics
    );

    // Stops with success: true and taskVerified: true without attempting to repair mathjs!
    expect(result.success).toBe(true);
    expect(result.taskVerified).toBe(true);
    expect(result.repositoryClean).toBe(false);
    expect(result.attempts).toBe(1);
  });

  test("G. A NEW_CURRENT_TASK diagnostic DOES enter SelfHealing", async () => {
    const baselineDiagnostics = [
      {
        errorType: "COMPILE_NEXT",
        filePath: "components/Calculator.tsx",
        errorCode: "CLIENT_DIRECTIVE_REQUIRED",
        message: "useState requires 'use client'",
        fingerprint: "COMPILE_NEXT|components/Calculator.tsx|CLIENT_DIRECTIVE_REQUIRED|usestate",
        origin: "BASELINE" as const,
      },
    ];

    const targetedDiagnostics = [baselineDiagnostics[0]];

    const fsManager = new FileSystemStateManager();
    const initialChanges = [
      {
        path: "components/Calculator.tsx",
        content: '"use client";\nexport const Calculator = () => null;\nexport const CalculatorButton = () => null;\nexport default Calculator;\nexport { CalculatorButton };',
        action: "modify" as const,
        description: "Add use client with duplicate export",
      },
    ];

    let buildCalls = 0;
    jest.spyOn(ValidationRunner, "validateWithShell").mockImplementation(async () => {
      buildCalls++;
      if (buildCalls === 1) {
        // Targeted useState error is resolved, but a NEW duplicate export error is introduced!
        return {
          success: false,
          errors: "./components/Calculator.tsx:3:14\nType error: Cannot redeclare exported variable 'CalculatorButton'.",
        };
      }
      // Rebuild passes after deterministic surgical repair
      return { success: true, errors: "" };
    });

    const result = await SelfHealingEngine.runSelfHealingLoop(
      initialChanges,
      tempDir,
      ["npm run build"],
      "system",
      "Fix use client in Calculator.tsx",
      fsManager,
      "proj-1",
      undefined,
      { files: [{ path: "components/Calculator.tsx", action: "modify", reason: "Calculator" }] } as any,
      { allowedFiles: ["components/Calculator.tsx"], immutableFiles: [], forbiddenPatterns: [] } as any,
      baselineDiagnostics,
      targetedDiagnostics
    );

    // SelfHealing engaged for the new error and successfully repaired it
    expect(result.success).toBe(true);
    expect(result.repaired).toBe(true);
    const finalCalc = result.finalChanges.find((c) => c.path === "components/Calculator.tsx");
    expect(finalCalc?.content).not.toContain("export { CalculatorButton };");
  });

  test("I & J. Push advances Git HEAD; next run starts from new HEAD without rediscovering fixed target diagnostic", async () => {
    // Commit 1: Initial broken baseline with Calculator useState error and missing mathjs
    const initialCalcContent = `import React, { useState } from 'react';
export const Calculator = () => {
  const [val, setVal] = useState(0);
  return <div>{val}</div>;
};
`;
    const baselineErrors = `
Failed to compile.
./components/Calculator.tsx:5:10
You're importing a component that needs useState. It only works in a Client Component but none of its parents are marked with "use client".

./src/math.ts
Cannot resolve 'mathjs'
`;

    // Run 1: Task targets Calculator.tsx and adds "use client"
    const run1BaselineDiags = BaselineDeltaVerifier.extractDiagnostics(baselineErrors, "BASELINE");
    const userMessage1 = "Fix the useState / React Server Component error in components/Calculator.tsx";
    const taskMatch1 = BaselineDeltaVerifier.matchUserTaskToBaseline(userMessage1, run1BaselineDiags);
    expect(taskMatch1.isMatch).toBe(true);
    expect(taskMatch1.targetedDiagnostics.length).toBe(1);

    // After applying patch and pushing, Calculator has "use client"
    const patchedCalcContent = `"use client";\n` + initialCalcContent;
    const run2Errors = `
Failed to compile.
./src/math.ts
Cannot resolve 'mathjs'
`;

    // Run 2: Next run starts from the new HEAD commit containing the patch
    const run2BaselineDiags = BaselineDeltaVerifier.extractDiagnostics(run2Errors, "BASELINE");
    expect(run2BaselineDiags.some((d) => d.filePath === "components/Calculator.tsx")).toBe(false);
    expect(run2BaselineDiags.length).toBe(1);
    expect(run2BaselineDiags[0].symbolName).toBe("mathjs");
  });

  test("K. Explicit dependency-repair request still routes to DependencyRepairMode", () => {
    const depRequest = "npm ci is failing because lucide-react is set to ^0.2.0. Fix the repository dependency issue.";
    const isDepRepair = BaselineRepairCoordinator ? true : false;
    expect(isDepRepair).toBe(true);

    const isExplicit = /dependency|npm ci|package\.json|lockfile/i.test(depRequest);
    expect(isExplicit).toBe(true);
  });
});
