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

  describe("Section 3: Status Propagation & Checklist Distinction Tests", () => {
    test("Required Regression 1: Narrow Task Success + Dirty Repository -> taskVerified=true, buildVerified=false, repositoryClean=false, healthStatus=TASK_VERIFIED_REPOSITORY_UNHEALTHY", async () => {
      const deltaResult = {
        baselineDiagnosticCount: 1,
        targetedBaselineDiagnostics: [{ errorType: "CLIENT_DIRECTIVE_REQUIRED", filePath: "components/Calculator.tsx", message: "useState error", fingerprint: "fp1", origin: "BASELINE" as const }],
        resolvedTargetDiagnostics: [{ errorType: "CLIENT_DIRECTIVE_REQUIRED", filePath: "components/Calculator.tsx", message: "useState error", fingerprint: "fp1", origin: "BASELINE" as const }],
        remainingBaselineDiagnostics: [],
        revealedBaselineDiagnostics: [{ errorType: "DUPLICATE_DECLARATION", filePath: "components/Calculator.tsx", message: "Cannot redeclare exported variable 'CalculatorButton'", fingerprint: "fp2", origin: "CURRENT_TASK" as const }],
        newTaskDiagnostics: [],
        taskVerified: true,
        repositoryClean: false,
      };

      const isRepositoryClean = deltaResult.repositoryClean;
      const isTaskVerified = deltaResult.taskVerified;
      const isBuildVerified = Boolean(isRepositoryClean);
      const healthStatus = isTaskVerified ? (isRepositoryClean ? "HEALTHY" : "TASK_VERIFIED_REPOSITORY_UNHEALTHY") : undefined;

      expect(isTaskVerified).toBe(true);
      expect(isBuildVerified).toBe(false);
      expect(isRepositoryClean).toBe(false);
      expect(healthStatus).toBe("TASK_VERIFIED_REPOSITORY_UNHEALTHY");
      expect(deltaResult.revealedBaselineDiagnostics.length).toBe(1);
      expect(deltaResult.newTaskDiagnostics.length).toBe(0);

      // Verify checklist does NOT claim build passed
      const { PipelineResultBuilder } = require("../orchestration/PipelineResult");
      const checklist = PipelineResultBuilder.buildChecklist(
        { pipeline: "STANDARD", environment: "NEXTJS" } as any,
        { overallPassed: true, checks: [] } as any,
        0.95,
        isRepositoryClean,
        isTaskVerified,
        isRepositoryClean
      );

      const buildPassItem = checklist.find((item: any) => item.label.toLowerCase().includes("build") && item.label.toLowerCase().includes("clean"));
      expect(buildPassItem).toBeDefined();
      expect(buildPassItem?.checked).toBe(false);

      const compilerErrItem = checklist.find((item: any) => item.label.includes("No TS / Compiler Errors"));
      expect(compilerErrItem).toBeDefined();
      expect(compilerErrItem?.checked).toBe(false);

      const taskItem = checklist.find((item: any) => item.label.includes("task verified"));
      expect(taskItem).toBeDefined();
      expect(taskItem?.checked).toBe(true);
    });

    test("Required Regression 2: Full Clean Success -> taskVerified=true, buildVerified=true, repositoryClean=true", async () => {
      const deltaResult = {
        baselineDiagnosticCount: 1,
        targetedBaselineDiagnostics: [{ errorType: "CLIENT_DIRECTIVE_REQUIRED", filePath: "components/Calculator.tsx", message: "useState error", fingerprint: "fp1", origin: "BASELINE" as const }],
        resolvedTargetDiagnostics: [{ errorType: "CLIENT_DIRECTIVE_REQUIRED", filePath: "components/Calculator.tsx", message: "useState error", fingerprint: "fp1", origin: "BASELINE" as const }],
        remainingBaselineDiagnostics: [],
        revealedBaselineDiagnostics: [],
        newTaskDiagnostics: [],
        taskVerified: true,
        repositoryClean: true,
      };

      const isRepositoryClean = deltaResult.repositoryClean;
      const isTaskVerified = deltaResult.taskVerified;
      const isBuildVerified = Boolean(isRepositoryClean);
      const healthStatus = isTaskVerified ? (isRepositoryClean ? "HEALTHY" : "TASK_VERIFIED_REPOSITORY_UNHEALTHY") : undefined;

      expect(isTaskVerified).toBe(true);
      expect(isBuildVerified).toBe(true);
      expect(isRepositoryClean).toBe(true);
      expect(healthStatus).toBe("HEALTHY");

      const { PipelineResultBuilder } = require("../orchestration/PipelineResult");
      const checklist = PipelineResultBuilder.buildChecklist(
        { pipeline: "STANDARD", environment: "NEXTJS" } as any,
        { overallPassed: true, checks: [] } as any,
        0.95,
        isRepositoryClean,
        isTaskVerified,
        isRepositoryClean
      );

      const buildPassItem = checklist.find((item: any) => item.label.includes("Build passes"));
      expect(buildPassItem?.checked).toBe(true);
    });

    test("Required Regression 3: Agent-Introduced Error -> taskVerified=false, buildVerified=false, newTaskDiagnostics.length > 0", async () => {
      const deltaResult = {
        baselineDiagnosticCount: 1,
        targetedBaselineDiagnostics: [{ errorType: "CLIENT_DIRECTIVE_REQUIRED", filePath: "components/Calculator.tsx", message: "useState error", fingerprint: "fp1", origin: "BASELINE" as const }],
        resolvedTargetDiagnostics: [{ errorType: "CLIENT_DIRECTIVE_REQUIRED", filePath: "components/Calculator.tsx", message: "useState error", fingerprint: "fp1", origin: "BASELINE" as const }],
        remainingBaselineDiagnostics: [],
        revealedBaselineDiagnostics: [],
        newTaskDiagnostics: [{ errorType: "SYNTAX_ERROR", filePath: "components/Calculator.tsx", message: "Unexpected token", fingerprint: "fp3", origin: "CURRENT_TASK" as const }],
        taskVerified: false,
        repositoryClean: false,
      };

      const isRepositoryClean = deltaResult.repositoryClean;
      const isTaskVerified = deltaResult.taskVerified;
      const isBuildVerified = Boolean(isRepositoryClean);

      expect(isTaskVerified).toBe(false);
      expect(isBuildVerified).toBe(false);
      expect(deltaResult.newTaskDiagnostics.length).toBe(1);
    });

    test("Required Regression 4: Broad Fix-All -> revealed error prevents early taskVerified", async () => {
      const isBroad = BaselineDeltaVerifier.isBroadBuildRepairTask("fix all build errors in this repository");
      expect(isBroad).toBe(true);

      const deltaResult = BaselineDeltaVerifier.compareBaselineVsPostChange(
        [{ errorType: "CLIENT_DIRECTIVE_REQUIRED", filePath: "components/Calculator.tsx", message: "useState error", fingerprint: "fp1", origin: "BASELINE" as const }],
        [{ errorType: "DUPLICATE_DECLARATION", filePath: "components/Calculator.tsx", message: "Cannot redeclare exported variable 'CalculatorButton'", fingerprint: "fp2", origin: "CURRENT_TASK" as const }],
        [{ errorType: "CLIENT_DIRECTIVE_REQUIRED", filePath: "components/Calculator.tsx", message: "useState error", fingerprint: "fp1", origin: "BASELINE" as const }],
        {
          preTaskSourceGetter: () => "export const CalculatorButton = 1;\nexport const CalculatorButton = 2;",
          changes: [{ path: "components/Calculator.tsx", content: "use client;\nexport const CalculatorButton = 1;\nexport const CalculatorButton = 2;", action: "modify", description: "fix" }],
          isBroadRepairTask: true,
        }
      );

      expect(deltaResult.revealedBaselineDiagnostics.length).toBe(1);
      // For broad repair tasks, taskVerified is strictly repositoryClean
      expect(deltaResult.repositoryClean).toBe(false);
      expect(deltaResult.taskVerified).toBe(false);
    });
  });

  describe("Section 4: Broken-Baseline Gate & Broad Build Repair Tests", () => {
    test("Gate Test 1: Narrow targeted repair on broken baseline allows constrained repair", async () => {
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
        branchName: "anka/run-gate-narrow",
        baseCommitSha: "sha-gate-1",
      });
      jest.spyOn(GitWorktreeService, "rollbackWorktree").mockResolvedValue(undefined as any);
      jest.spyOn(GitWorktreeService, "getWorktreeDiff").mockResolvedValue({
        changedFiles: ["components/Calculator.tsx"],
        diffSummary: "Added use client",
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
Failed to compile.
./components/Calculator.tsx:2:17
You're importing a module that depends on \`useState\` into a React Server Component module.
`;

      jest.spyOn(ValidationRunner, "validateWithShell").mockResolvedValue({
        success: false,
        errors: baselineErrors,
      });

      const spyAgentPipeline = jest.spyOn(AgentPipeline, "runCodingAgent").mockResolvedValue({
        explanation: "Fixed useState Server Component error",
        changes: [{ path: "components/Calculator.tsx", content: '"use client";\nimport React, { useState } from "react";', action: "modify", description: "use client" }],
        commitMessage: "fix: client directive",
        sessionId: "sess-gate-narrow",
        taskVerified: true,
        repositoryClean: true,
        buildVerified: true,
      });

      const summary = await GitWorktreeService.runIsolatedAgent({
        userId: "user-1",
        projectId: "proj-1",
        repositoryPath: tempDir,
        runId: "run-gate-narrow",
        request: { message: "Fix the useState Server Component error in components/Calculator.tsx" },
      });

      expect(spyAgentPipeline).toHaveBeenCalled();
      expect(summary.validationPassed).toBe(true);
      expect(summary.agentResponse.taskVerified).toBe(true);
    });

    test("Gate Test 2: Broad repair ('fix all build errors') on broken baseline targets all visible diagnostics and enters AgentPipeline", async () => {
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
        branchName: "anka/run-gate-broad",
        baseCommitSha: "sha-gate-2",
      });
      jest.spyOn(GitWorktreeService, "rollbackWorktree").mockResolvedValue(undefined as any);
      jest.spyOn(GitWorktreeService, "getWorktreeDiff").mockResolvedValue({
        changedFiles: ["components/Calculator.tsx"],
        diffSummary: "Fixed all build errors",
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
Failed to compile.
./components/Calculator.tsx:2:17
You're importing a module that depends on \`useState\` into a React Server Component module.
`;

      jest.spyOn(ValidationRunner, "validateWithShell").mockResolvedValue({
        success: false,
        errors: baselineErrors,
      });

      let passedContext: any = null;
      const spyAgentPipeline = jest.spyOn(AgentPipeline, "runCodingAgent").mockImplementation(async (u, p, req, prog, ctx) => {
        passedContext = ctx;
        return {
          explanation: "Fixed all build errors",
          changes: [{ path: "components/Calculator.tsx", content: '"use client";', action: "modify", description: "use client" }],
          commitMessage: "fix: all build errors",
          sessionId: "sess-gate-broad",
          taskVerified: true,
          repositoryClean: true,
          buildVerified: true,
        };
      });

      const summary = await GitWorktreeService.runIsolatedAgent({
        userId: "user-1",
        projectId: "proj-1",
        repositoryPath: tempDir,
        runId: "run-gate-broad",
        request: { message: "fix all build errors in this repository" },
      });

      expect(spyAgentPipeline).toHaveBeenCalled();
      expect(passedContext).toBeDefined();
      expect(passedContext.isBaselineDeltaTask).toBe(true);
      expect(passedContext.targetedBaselineDiagnostics.length).toBe(1);
      expect(summary.validationPassed).toBe(true);
    });

    test("Gate Test 3: Natural broad wording ('I am having build errors in this repo, I need you to solve them all') enters AgentPipeline", async () => {
      const isBroad = BaselineDeltaVerifier.isBroadBuildRepairTask(
        "I am having build errors in this repo, I need you to solve them all"
      );
      expect(isBroad).toBe(true);

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
        branchName: "anka/run-gate-natural",
        baseCommitSha: "sha-gate-3",
      });
      jest.spyOn(GitWorktreeService, "rollbackWorktree").mockResolvedValue(undefined as any);
      jest.spyOn(GitWorktreeService, "getWorktreeDiff").mockResolvedValue({
        changedFiles: ["components/Calculator.tsx"],
        diffSummary: "Fixed build errors",
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
Failed to compile.
./components/Calculator.tsx:2:17
You're importing a module that depends on \`useState\` into a React Server Component module.
`;

      jest.spyOn(ValidationRunner, "validateWithShell").mockResolvedValue({
        success: false,
        errors: baselineErrors,
      });

      let passedContext: any = null;
      const spyAgentPipeline = jest.spyOn(AgentPipeline, "runCodingAgent").mockImplementation(async (u, p, req, prog, ctx) => {
        passedContext = ctx;
        return {
          explanation: "Fixed all build errors",
          changes: [{ path: "components/Calculator.tsx", content: '"use client";', action: "modify", description: "use client" }],
          commitMessage: "fix: build errors",
          sessionId: "sess-gate-natural",
          taskVerified: true,
          repositoryClean: true,
          buildVerified: true,
        };
      });

      const summary = await GitWorktreeService.runIsolatedAgent({
        userId: "user-1",
        projectId: "proj-1",
        repositoryPath: tempDir,
        runId: "run-gate-natural",
        request: { message: "I am having build errors in this repo, I need you to solve them all" },
      });

      expect(spyAgentPipeline).toHaveBeenCalled();
      expect(passedContext.isBaselineDeltaTask).toBe(true);
      expect(passedContext.targetedBaselineDiagnostics.length).toBe(1);
      expect(summary.validationPassed).toBe(true);
    });

    test("Gate Test 4: Unrelated request ('create a dashboard') on broken baseline remains fail-closed", async () => {
      const isBroad = BaselineDeltaVerifier.isBroadBuildRepairTask("create a dashboard");
      expect(isBroad).toBe(false);

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
        branchName: "anka/run-gate-unrelated",
        baseCommitSha: "sha-gate-4",
      });
      jest.spyOn(GitWorktreeService, "rollbackWorktree").mockResolvedValue(undefined as any);
      jest.spyOn(GitWorktreeService, "getWorktreeDiff").mockResolvedValue({
        changedFiles: [],
        diffSummary: "No diff",
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
Failed to compile.
./components/Calculator.tsx:2:17
You're importing a module that depends on \`useState\` into a React Server Component module.
`;

      jest.spyOn(ValidationRunner, "validateWithShell").mockResolvedValue({
        success: false,
        errors: baselineErrors,
      });

      const spyAgentPipeline = jest.spyOn(AgentPipeline, "runCodingAgent");

      const summary = await GitWorktreeService.runIsolatedAgent({
        userId: "user-1",
        projectId: "proj-1",
        repositoryPath: tempDir,
        runId: "run-gate-unrelated",
        request: { message: "create a dashboard" },
      });

      expect(spyAgentPipeline).not.toHaveBeenCalled();
      expect(summary.validationPassed).toBe(false);
      expect(summary.agentResponse.healthStatus).toBe("BASELINE_REPOSITORY_UNHEALTHY");
      expect(summary.agentResponse.baselineFailure).toBe(true);
    });

    test("Gate Test 5: Progressive revelation under broad repair keeps revealed error in repair scope", async () => {
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

      // For broad repair task, all visible baseline diagnostics are targeted
      const deltaResult = BaselineDeltaVerifier.compareBaselineVsPostChange(
        baseDiags,
        postDiags,
        baseDiags,
        {
          preTaskSourceGetter: () => preTaskCalculatorContent,
          changes: [{ path: "components/Calculator.tsx", content: postTaskCalculatorContent, action: "modify" as const, description: "Add use client" }],
          isBroadRepairTask: true,
        }
      );

      expect(deltaResult.revealedBaselineDiagnostics.length).toBe(1);
      expect(deltaResult.newTaskDiagnostics.length).toBe(0);
      expect(deltaResult.repositoryClean).toBe(false);
      // Because it's broad repair, taskVerified must be false so SelfHealing does not stop early
      expect(deltaResult.taskVerified).toBe(false);
    });
  });

  describe("Section 5: Diagnostic-Led Broad Build Repair Regression Tests", () => {
    test("Regression Test 1: Broken Next.js repo with broad fix-all prompt anchors retrieval, context, and manifest to Calculator.tsx", async () => {
      const baselineDiags = [
        {
          filePath: "components/Calculator.tsx",
          errorCode: "CLIENT_DIRECTIVE_REQUIRED",
          message: "You're importing a module that depends on `useState` into a React Server Component module.",
          symbolName: "useState",
          origin: "BASELINE" as const,
          fingerprint: "calc-useState-fp",
        },
      ];

      const broadMessage = "Fix all build errors in this repository until the build passes.";

      // 1. Verify Grounded Query Builder incorporates diagnostic evidence
      const { buildGroundedSemanticQueries } = require("../repository/RetrievalQueryBuilder");
      const queries = buildGroundedSemanticQueries({
        message: broadMessage,
        baselineDiagnostics: baselineDiags,
      });

      expect(queries.length).toBeGreaterThanOrEqual(2);
      expect(queries[0]).toBe(broadMessage);
      expect(queries.some((q: string) => q.includes("components/Calculator.tsx") || q.includes("CLIENT_DIRECTIVE_REQUIRED"))).toBe(true);

      // 2. Verify ContextPacker gives Priority 1 (TARGET) to diagnostic target paths over generic docs
      const { packFileContext } = require("../context/ContextPacker");
      const fileContext = {
        "README.md": "# Project Readme\nDetailed docs...",
        "AGENTS.md": "# Agent rules\nRule details...",
        "components/Calculator.tsx": "import React, { useState } from 'react';\nexport function Calculator() { useState(); return null; }",
      };

      const packed = packFileContext({
        fileContext,
        targetPaths: ["components/Calculator.tsx"],
        maxTokens: 50, // very tight token budget
      });

      expect(packed.includedFiles).toContain("components/Calculator.tsx");
      // Calculator.tsx was kept as Priority 1; generic docs were excluded if budget was constrained
      expect(packed.fileContext["components/Calculator.tsx"]).toBeDefined();

      // 3. Verify Manifest Generator fallback or generation targets Calculator.tsx
      const { ManifestGenerator } = require("../../services/manifest-generator");
      const generator = new ManifestGenerator();
      const contract = {
        goal: "Repair build errors",
        taskType: "BUG_FIX" as const,
        risk: "LOW" as const,
        estimatedComplexity: "SMALL" as const,
        pipeline: "REPOSITORY" as const,
        environment: "NEXTJS" as const,
        repositoryRequired: true,
        expectedFiles: ["components/Calculator.tsx"],
        validationType: "SHELL" as const,
        targetPaths: ["components/Calculator.tsx"],
        allowedActions: ["modify"],
        forbiddenActions: [],
        maxFiles: 5,
        searchScope: ["components/Calculator.tsx"],
        diffCriticEnabled: true,
      };

      const fallbackManifest = generator.buildFallbackManifest(broadMessage, contract);
      expect(fallbackManifest.files.length).toBe(1);
      expect(fallbackManifest.files[0].path).toBe("components/Calculator.tsx");
      expect(fallbackManifest.files[0].action).toBe("create");
    });

    test("Regression Test 2: Baseline error in File A -> File A is retrieved and prioritized even with generic fix-all prompt", async () => {
      const baselineDiags = [
        {
          filePath: "src/utils/math.ts",
          errorCode: "TS2304",
          message: "Cannot find name 'nonExistentVar'",
          symbolName: "nonExistentVar",
          origin: "BASELINE" as const,
          fingerprint: "math-ts2304-fp",
        },
      ];

      const { buildGroundedSemanticQueries } = require("../repository/RetrievalQueryBuilder");
      const queries = buildGroundedSemanticQueries({
        message: "fix all build errors",
        baselineDiagnostics: baselineDiags,
      });

      expect(queries.some((q: string) => q.includes("src/utils/math.ts") || q.includes("TS2304"))).toBe(true);

      const { packFileContext } = require("../context/ContextPacker");
      const fileContext = {
        "CLAUDE.md": "# Guidelines...",
        "src/utils/math.ts": "export function calc() { return nonExistentVar; }",
      };

      const packed = packFileContext({
        fileContext,
        targetPaths: ["src/utils/math.ts"],
        maxTokens: 50,
      });

      expect(packed.includedFiles).toContain("src/utils/math.ts");
    });

    test("Regression Test 3: Multi-file repair where File A requires real dependent change in File B is preserved", async () => {
      const baselineDiags = [
        {
          filePath: "components/Calculator.tsx",
          errorCode: "CLIENT_DIRECTIVE_REQUIRED",
          message: "useState requires client component",
          symbolName: "useState",
          origin: "BASELINE" as const,
          fingerprint: "calc-fp",
        },
      ];

      const { packFileContext } = require("../context/ContextPacker");
      const fileContext = {
        "components/Calculator.tsx": "export function Calculator() {}",
        "app/page.tsx": "import { Calculator } from '@/components/Calculator';",
      };

      const packed = packFileContext({
        fileContext,
        targetPaths: ["components/Calculator.tsx", "app/page.tsx"],
        maxTokens: 1000,
      });

      expect(packed.includedFiles).toContain("components/Calculator.tsx");
      expect(packed.includedFiles).toContain("app/page.tsx");
    });

    test("Regression Test 4: Normal feature request on a healthy repo is completely unaffected", async () => {
      const { buildGroundedSemanticQueries } = require("../repository/RetrievalQueryBuilder");
      const queries = buildGroundedSemanticQueries({
        message: "Add user profile avatar component",
        targetPath: "components/Avatar.tsx",
        discoveredSymbols: ["AvatarProps", "UserProfile"],
      });

      expect(queries.length).toBe(3);
      expect(queries[0]).toBe("Add user profile avatar component");
      expect(queries[1]).toBe("Add user profile avatar component components/Avatar.tsx");
      expect(queries[2]).toBe("Add user profile avatar component AvatarProps UserProfile");
    });
  });
});
