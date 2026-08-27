import fs from "fs";
import path from "path";
import os from "os";
import { GitWorktreeService } from "../../services/git-worktree.service";
import { WorktreeDependencyService } from "../../services/worktree-dependency.service";
import { ValidationRunner } from "../validation/ValidationRunner";
import { AgentPipeline } from "../orchestration/AgentPipeline";
import { BaselineDeltaVerifier } from "../../services/baseline-delta.verifier";
import { BaselineRepairCoordinator } from "../../services/baseline-repair.coordinator";

describe("Baseline-Delta Task Verification (Steps A-I)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "anka-test-baseline-delta-"));
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

  test("A & B & C & D. Baseline has 3 errors, task targets 1, targeted error disappears -> taskVerified=true, repositoryClean=false", async () => {
    const pkgJson = {
      name: "anka-app",
      scripts: { build: "next build" },
      dependencies: { next: "^14.0.0" },
    };
    fs.writeFileSync(path.join(tempDir, "package.json"), JSON.stringify(pkgJson, null, 2));

    jest.spyOn(GitWorktreeService, "prepareRepositoryRun").mockResolvedValue({
      originalRepositoryPath: tempDir,
      repositoryRoot: tempDir,
      worktreePath: tempDir,
      branchName: "anka/run-baseline-delta",
      baseCommitSha: "sha-delta-1",
    });
    jest.spyOn(GitWorktreeService, "rollbackWorktree").mockResolvedValue(undefined as any);
    jest.spyOn(GitWorktreeService, "getWorktreeDiff").mockResolvedValue({
      changedFiles: ["components/Calculator.tsx"],
      diffSummary: "Added 'use client' directive to Calculator.tsx",
      rawDiff: "diff",
    });

    // Dependencies PASS
    jest.spyOn(WorktreeDependencyService, "prepareDependencies").mockResolvedValue({
      attempted: true,
      success: true,
      packageManager: "npm",
      installCommand: "npm ci --no-audit --no-fund",
      durationMs: 1000,
      errorType: null,
    });

    const baselineErrors = `
Failed to compile.
./components/Calculator.tsx:5:10
You're importing a component that needs useState. It only works in a Client Component but none of its parents are marked with "use client", so they're Server Components by default.

./postcss.config.mjs
Cannot find module '@tailwindcss/postcss'

./src/math-util.ts
Cannot resolve 'mathjs'
`;

    const postPatchErrors = `
Failed to compile.
./postcss.config.mjs
Cannot find module '@tailwindcss/postcss'

./src/math-util.ts
Cannot resolve 'mathjs'
`;

    let buildCallCount = 0;
    jest.spyOn(ValidationRunner, "validateWithShell").mockImplementation(async () => {
      buildCallCount++;
      if (buildCallCount === 1) {
        // Untouched baseline build
        return { success: false, errors: baselineErrors };
      }
      // Post-patch build
      return { success: false, errors: postPatchErrors };
    });

    const spyAgentPipeline = jest.spyOn(AgentPipeline, "runCodingAgent").mockResolvedValue({
      explanation: "Added 'use client' directive to Calculator.tsx",
      changes: [{ path: "components/Calculator.tsx", content: '"use client";\nimport { useState } from "react";', action: "modify", description: "Calculator" }],
      commitMessage: "fix: add use client directive",
      sessionId: "sess-delta",
      buildVerified: true,
    });

    const summary = await GitWorktreeService.runIsolatedAgent({
      userId: "user-1",
      projectId: "proj-1",
      repositoryPath: tempDir,
      runId: "run-delta-success",
      request: { message: "Fix the useState / React Server Component error in components/Calculator.tsx" },
    });

    expect(spyAgentPipeline).toHaveBeenCalled();
    expect(summary.validationPassed).toBe(true);
    expect(summary.agentResponse.taskVerified).toBe(true);
    expect(summary.agentResponse.repositoryClean).toBe(false);
    expect(summary.agentResponse.healthStatus).toBe("TASK_VERIFIED_REPOSITORY_UNHEALTHY");
    expect(summary.agentResponse.resolvedTargetDiagnostics?.length).toBeGreaterThan(0);
    expect(summary.agentResponse.remainingBaselineDiagnostics?.length).toBe(2);
    expect(summary.agentResponse.newTaskDiagnostics?.length).toBe(0);
    expect(summary.agentResponse.explanation).toContain("Requested Fix: VERIFIED");
    expect(summary.agentResponse.explanation).toContain("BASELINE STILL UNHEALTHY");
  });

  test("E & F. New post-change error is marked CURRENT_TASK and task is not verified", async () => {
    const pkgJson = {
      name: "anka-app",
      scripts: { build: "next build" },
      dependencies: { next: "^14.0.0" },
    };
    fs.writeFileSync(path.join(tempDir, "package.json"), JSON.stringify(pkgJson, null, 2));

    jest.spyOn(GitWorktreeService, "prepareRepositoryRun").mockResolvedValue({
      originalRepositoryPath: tempDir,
      repositoryRoot: tempDir,
      worktreePath: tempDir,
      branchName: "anka/run-new-error",
      baseCommitSha: "sha-delta-2",
    });
    jest.spyOn(GitWorktreeService, "rollbackWorktree").mockResolvedValue(undefined as any);
    jest.spyOn(GitWorktreeService, "getWorktreeDiff").mockResolvedValue({
      changedFiles: ["components/Calculator.tsx"],
      diffSummary: "Modified Calculator.tsx",
      rawDiff: "diff",
    });

    jest.spyOn(WorktreeDependencyService, "prepareDependencies").mockResolvedValue({
      attempted: true,
      success: true,
      packageManager: "npm",
      installCommand: "npm ci",
      durationMs: 800,
      errorType: null,
    });

    const baselineErrors = `
./components/Calculator.tsx:5:10
You're importing a component that needs useState. It only works in a Client Component but none of its parents are marked with "use client".
`;

    const postPatchErrors = `
./components/Calculator.tsx(12,15): error TS2339: Property 'nonExistentMethod' does not exist on type 'CalculatorState'.
`;

    let buildCallCount = 0;
    jest.spyOn(ValidationRunner, "validateWithShell").mockImplementation(async () => {
      buildCallCount++;
      if (buildCallCount === 1) return { success: false, errors: baselineErrors };
      return { success: false, errors: postPatchErrors };
    });

    jest.spyOn(AgentPipeline, "runCodingAgent").mockResolvedValue({
      explanation: "Added use client but broke types",
      changes: [{ path: "components/Calculator.tsx", content: "broken", action: "modify", description: "Calculator" }],
      commitMessage: "fix: client",
      sessionId: "sess-new-err",
      buildVerified: true,
    });

    const summary = await GitWorktreeService.runIsolatedAgent({
      userId: "user-1",
      projectId: "proj-1",
      repositoryPath: tempDir,
      runId: "run-delta-fail",
      request: { message: "Fix the useState / React Server Component error in components/Calculator.tsx" },
    });

    expect(summary.validationPassed).toBe(false);
    expect(summary.agentResponse.taskVerified).toBe(false);
    expect(summary.agentResponse.newTaskDiagnostics?.length).toBeGreaterThan(0);
    expect(summary.agentResponse.origin).toBe("CURRENT_TASK");
    expect(summary.agentResponse.agentIntroduced).toBe(true);
  });

  test("G. Unrelated task against broken baseline remains blocked", async () => {
    const pkgJson = {
      name: "anka-app",
      scripts: { build: "next build" },
      dependencies: { next: "^14.0.0" },
    };
    fs.writeFileSync(path.join(tempDir, "package.json"), JSON.stringify(pkgJson, null, 2));

    jest.spyOn(GitWorktreeService, "prepareRepositoryRun").mockResolvedValue({
      originalRepositoryPath: tempDir,
      repositoryRoot: tempDir,
      worktreePath: tempDir,
      branchName: "anka/run-unrelated",
      baseCommitSha: "sha-delta-3",
    });
    jest.spyOn(GitWorktreeService, "rollbackWorktree").mockResolvedValue(undefined as any);

    jest.spyOn(WorktreeDependencyService, "prepareDependencies").mockResolvedValue({
      attempted: true,
      success: true,
      packageManager: "npm",
      installCommand: "npm ci",
      durationMs: 800,
      errorType: null,
    });

    const baselineErrors = `
./components/Calculator.tsx:5:10
You're importing a component that needs useState. It only works in a Client Component but none of its parents are marked with "use client".
`;

    jest.spyOn(ValidationRunner, "validateWithShell").mockResolvedValue({
      success: false,
      errors: baselineErrors,
    });

    const spyAgentPipeline = jest.spyOn(AgentPipeline, "runCodingAgent");

    // User asks for something unrelated (e.g. adding a banner or dark mode to Header)
    const summary = await GitWorktreeService.runIsolatedAgent({
      userId: "user-1",
      projectId: "proj-1",
      repositoryPath: tempDir,
      runId: "run-unrelated-blocked",
      request: { message: "Add promotional banner to Header.tsx" },
    });

    expect(spyAgentPipeline).not.toHaveBeenCalled();
    expect(summary.validationPassed).toBe(false);
    expect(summary.agentResponse.healthStatus).toBe("BASELINE_REPOSITORY_UNHEALTHY");
    expect(summary.agentResponse.baselineFailure).toBe(true);
  });

  test("I. Clean-baseline behavior remains completely unchanged (taskVerified=true, repositoryClean=true)", async () => {
    const pkgJson = {
      name: "anka-app",
      scripts: { build: "next build" },
      dependencies: { next: "^14.0.0" },
    };
    fs.writeFileSync(path.join(tempDir, "package.json"), JSON.stringify(pkgJson, null, 2));

    jest.spyOn(GitWorktreeService, "prepareRepositoryRun").mockResolvedValue({
      originalRepositoryPath: tempDir,
      repositoryRoot: tempDir,
      worktreePath: tempDir,
      branchName: "anka/run-clean",
      baseCommitSha: "sha-delta-4",
    });
    jest.spyOn(GitWorktreeService, "rollbackWorktree").mockResolvedValue(undefined as any);
    jest.spyOn(GitWorktreeService, "getWorktreeDiff").mockResolvedValue({
      changedFiles: ["components/Header.tsx"],
      diffSummary: "Added banner to Header.tsx",
      rawDiff: "diff",
    });

    jest.spyOn(WorktreeDependencyService, "prepareDependencies").mockResolvedValue({
      attempted: true,
      success: true,
      packageManager: "npm",
      installCommand: "npm ci",
      durationMs: 800,
      errorType: null,
    });

    // Untouched baseline build PASS
    jest.spyOn(ValidationRunner, "validateWithShell").mockResolvedValue({
      success: true,
      errors: "",
    });

    jest.spyOn(AgentPipeline, "runCodingAgent").mockResolvedValue({
      explanation: "Added banner to Header.tsx",
      changes: [{ path: "components/Header.tsx", content: "export function Header() {}", action: "modify", description: "Header" }],
      commitMessage: "feat: header banner",
      sessionId: "sess-clean",
      buildVerified: true,
    });

    const summary = await GitWorktreeService.runIsolatedAgent({
      userId: "user-1",
      projectId: "proj-1",
      repositoryPath: tempDir,
      runId: "run-clean-success",
      request: { message: "Add promotional banner to Header.tsx" },
    });

    expect(summary.validationPassed).toBe(true);
    expect(summary.agentResponse.taskVerified).toBe(true);
    expect(summary.agentResponse.repositoryClean).toBe(true);
    expect(summary.agentResponse.healthStatus).toBe("HEALTHY");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Regression Tests A - E: Causality-Aware Revealed Baseline Diagnostics
  // ──────────────────────────────────────────────────────────────────────────

  test("Regression Test A: Hidden pre-existing error is revealed after fixing blocker -> revealedBaselineDiagnostics, taskVerified=true", async () => {
    const preTaskCalculatorContent = `
import React, { useState } from 'react';
import { create, all } from 'mathjs';

const math = create(all);

export const CalculatorButton: React.FC<{ label: string; onClick: () => void }> = ({ label, onClick }) => (
  <button onClick={onClick}>{label}</button>
);

export const CalculatorButton: React.FC<{ label: string; onClick: () => void }> = ({ label, onClick }) => (
  <button onClick={onClick}>{label}</button>
);
`;
    const postTaskCalculatorContent = `
"use client";
import React, { useState } from 'react';
import { create, all } from 'mathjs';

const math = create(all);

export const CalculatorButton: React.FC<{ label: string; onClick: () => void }> = ({ label, onClick }) => (
  <button onClick={onClick}>{label}</button>
);

export const CalculatorButton: React.FC<{ label: string; onClick: () => void }> = ({ label, onClick }) => (
  <button onClick={onClick}>{label}</button>
);
`;

    const baselineErrors = `
Failed to compile.
./components/Calculator.tsx:2:17
You're importing a module that depends on \`useState\` into a React Server Component module. This API is only available in Client Components. To fix, mark the file (or its parent) with the \`"use client"\` directive.
`;

    const postPatchErrors = `
Failed to compile.
./components/Calculator.tsx:8:14
Type error: Cannot redeclare exported variable 'CalculatorButton'.
> 8 | export const CalculatorButton: React.FC<{ label: string; onClick: () => void }> = ({ label, onClick }) => (
    |              ^^^^^^^^^^^^^^^^
`;

    const baseDiags = BaselineDeltaVerifier.extractDiagnostics(baselineErrors, "BASELINE");
    const postDiags = BaselineDeltaVerifier.extractDiagnostics(postPatchErrors, "CURRENT_TASK");

    expect(baseDiags.length).toBe(1);
    expect(baseDiags[0].errorCode).toBe("CLIENT_DIRECTIVE_REQUIRED");

    const targeted = BaselineDeltaVerifier.matchUserTaskToBaseline(
      "Fix the useState Server Component error in components/Calculator.tsx",
      baseDiags
    ).targetedDiagnostics;

    expect(targeted.length).toBe(1);

    const causalityContext = {
      preTaskSourceGetter: (filePath: string) => {
        if (filePath.includes("Calculator.tsx")) return preTaskCalculatorContent;
        return null;
      },
      changes: [{ path: "components/Calculator.tsx", content: postTaskCalculatorContent, action: "modify" as const, description: "Add use client" }],
      isBroadRepairTask: false,
    };

    const deltaResult = BaselineDeltaVerifier.compareBaselineVsPostChange(
      baseDiags,
      postDiags,
      targeted,
      causalityContext
    );

    expect(deltaResult.resolvedTargetDiagnostics.length).toBe(1);
    expect(deltaResult.revealedBaselineDiagnostics.length).toBe(1);
    expect(deltaResult.revealedBaselineDiagnostics[0].message).toContain("Cannot redeclare exported variable");
    expect(deltaResult.newTaskDiagnostics.length).toBe(0);
    expect(deltaResult.taskVerified).toBe(true);
    expect(deltaResult.repositoryClean).toBe(false);

    const explanation = BaselineDeltaVerifier.formatDeltaExplanation(deltaResult);
    expect(explanation).toContain("Requested Fix: VERIFIED");
    expect(explanation).toContain("Revealed pre-existing errors");
    expect(explanation).toContain("Cannot redeclare exported variable");
  });

  test("Regression Test B: Agent introduces new error in the SAME file -> newTaskDiagnostics, taskVerified=false", async () => {
    const preTaskCalculatorContent = `
import React, { useState } from 'react';
import { create, all } from 'mathjs';

const math = create(all);

export const CalculatorButton: React.FC<{ label: string; onClick: () => void }> = ({ label, onClick }) => (
  <button onClick={onClick}>{label}</button>
);
`;

    // Agent adds "use client" AND also adds a duplicate CalculatorButton declaration that did NOT exist in pre-task source
    const postTaskCalculatorContent = `
"use client";
import React, { useState } from 'react';
import { create, all } from 'mathjs';

const math = create(all);

export const CalculatorButton: React.FC<{ label: string; onClick: () => void }> = ({ label, onClick }) => (
  <button onClick={onClick}>{label}</button>
);

export const CalculatorButton: React.FC<{ label: string; onClick: () => void }> = ({ label, onClick }) => (
  <button onClick={onClick}>{label}</button>
);
`;

    const baselineErrors = `
Failed to compile.
./components/Calculator.tsx:2:17
You're importing a module that depends on \`useState\` into a React Server Component module.
`;

    const postPatchErrors = `
Failed to compile.
./components/Calculator.tsx:14:14
Type error: Cannot redeclare exported variable 'CalculatorButton'.
`;

    const baseDiags = BaselineDeltaVerifier.extractDiagnostics(baselineErrors, "BASELINE");
    const postDiags = BaselineDeltaVerifier.extractDiagnostics(postPatchErrors, "CURRENT_TASK");
    const targeted = baseDiags;

    const causalityContext = {
      preTaskSourceGetter: (filePath: string) => {
        if (filePath.includes("Calculator.tsx")) return preTaskCalculatorContent;
        return null;
      },
      changes: [{ path: "components/Calculator.tsx", content: postTaskCalculatorContent, action: "modify" as const, description: "Add use client with accidental duplication" }],
      isBroadRepairTask: false,
    };

    const deltaResult = BaselineDeltaVerifier.compareBaselineVsPostChange(
      baseDiags,
      postDiags,
      targeted,
      causalityContext
    );

    expect(deltaResult.resolvedTargetDiagnostics.length).toBe(1);
    expect(deltaResult.revealedBaselineDiagnostics.length).toBe(0);
    expect(deltaResult.newTaskDiagnostics.length).toBe(1);
    expect(deltaResult.taskVerified).toBe(false);
  });

  test("Regression Test C: Broad fix-all request does not early-exit on revealed error", async () => {
    const preTaskCalculatorContent = `
import React, { useState } from 'react';
export const CalculatorButton = 1;
export const CalculatorButton = 2;
`;
    const postTaskCalculatorContent = `
"use client";
import React, { useState } from 'react';
export const CalculatorButton = 1;
export const CalculatorButton = 2;
`;

    const baselineErrors = `
./components/Calculator.tsx:2:17
You're importing a module that depends on \`useState\` into a React Server Component module.
`;
    const postPatchErrors = `
./components/Calculator.tsx:4:14
Cannot redeclare exported variable 'CalculatorButton'.
`;

    const baseDiags = BaselineDeltaVerifier.extractDiagnostics(baselineErrors, "BASELINE");
    const postDiags = BaselineDeltaVerifier.extractDiagnostics(postPatchErrors, "CURRENT_TASK");
    const targeted = baseDiags;

    const broadContext = {
      preTaskSourceGetter: () => preTaskCalculatorContent,
      changes: [{ path: "components/Calculator.tsx", content: postTaskCalculatorContent, action: "modify" as const, description: "Add use client" }],
      isBroadRepairTask: true, // "fix all build errors"
    };

    const deltaResult = BaselineDeltaVerifier.compareBaselineVsPostChange(
      baseDiags,
      postDiags,
      targeted,
      broadContext
    );

    expect(deltaResult.revealedBaselineDiagnostics.length).toBe(1);
    // For broad repair, repositoryClean is false, so taskVerified remains false so repair continues
    expect(deltaResult.taskVerified).toBe(false);
  });

  test("Regression Test D: Normal healthy baseline with agent-introduced error", async () => {
    const baseDiags: any[] = [];
    const postPatchErrors = `
./components/Header.tsx:10:5
Type error: Property 'title' does not exist on type 'HeaderProps'.
`;
    const postDiags = BaselineDeltaVerifier.extractDiagnostics(postPatchErrors, "CURRENT_TASK");

    const deltaResult = BaselineDeltaVerifier.compareBaselineVsPostChange(
      baseDiags,
      postDiags,
      [],
      {
        preTaskSourceGetter: () => "export function Header() {}",
        changes: [{ path: "components/Header.tsx", content: "broken", action: "modify" as const, description: "Header" }],
        isBroadRepairTask: false,
      }
    );

    expect(deltaResult.newTaskDiagnostics.length).toBe(1);
    expect(deltaResult.revealedBaselineDiagnostics.length).toBe(0);
    expect(deltaResult.taskVerified).toBe(false);
  });

  test("Regression Test E: Fix in File A causes a genuine new error in File B", async () => {
    const preTaskFileA = `
import { useState } from 'react';
export function A() { useState(); }
`;
    const preTaskFileB = `
export function B() { return 42; }
`;
    const postTaskFileA = `
"use client";
import { useState } from 'react';
export function A() { useState(); }
`;
    const postTaskFileB = `
export function B() { return nonExistentVar; }
`;

    const baselineErrors = `
./components/A.tsx:2:10
You're importing a module that depends on \`useState\` into a React Server Component module.
`;
    const postPatchErrors = `
./components/B.tsx:2:30
Cannot find name 'nonExistentVar'.
`;

    const baseDiags = BaselineDeltaVerifier.extractDiagnostics(baselineErrors, "BASELINE");
    const postDiags = BaselineDeltaVerifier.extractDiagnostics(postPatchErrors, "CURRENT_TASK");
    const targeted = baseDiags;

    const deltaResult = BaselineDeltaVerifier.compareBaselineVsPostChange(
      baseDiags,
      postDiags,
      targeted,
      {
        preTaskSourceGetter: (path: string) => (path.includes("A.tsx") ? preTaskFileA : preTaskFileB),
        changes: [
          { path: "components/A.tsx", content: postTaskFileA, action: "modify" as const, description: "A" },
          { path: "components/B.tsx", content: postTaskFileB, action: "modify" as const, description: "B" },
        ],
        isBroadRepairTask: false,
      }
    );

    expect(deltaResult.newTaskDiagnostics.length).toBe(1);
    expect(deltaResult.revealedBaselineDiagnostics.length).toBe(0);
    expect(deltaResult.taskVerified).toBe(false);
  });
});
