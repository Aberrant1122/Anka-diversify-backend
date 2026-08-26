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
});
