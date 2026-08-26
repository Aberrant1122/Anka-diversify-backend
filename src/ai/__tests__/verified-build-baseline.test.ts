import fs from "fs";
import path from "path";
import os from "os";
import { GitWorktreeService } from "../../services/git-worktree.service";
import { WorktreeDependencyService } from "../../services/worktree-dependency.service";
import { ValidationRunner } from "../validation/ValidationRunner";
import { AgentPipeline } from "../orchestration/AgentPipeline";
import { BaselineRepairCoordinator } from "../../services/baseline-repair.coordinator";
import { DependencyRepairService } from "../../services/dependency-repair.service";
import { ErrorClassifier } from "../validation/ErrorClassifier";

describe("Verified Build Baseline Before Agent Generation (Steps A-K)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "anka-test-verified-baseline-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
    jest.restoreAllMocks();
  });

  test("A & B. npm ci PASS + baseline build FAIL does NOT mean baselineReady; AgentPipeline is NOT entered", async () => {
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
      branchName: "anka/run-broken-build",
      baseCommitSha: "sha-123",
    });
    jest.spyOn(GitWorktreeService, "rollbackWorktree").mockResolvedValue(undefined as any);

    // npm ci PASS
    jest.spyOn(WorktreeDependencyService, "prepareDependencies").mockResolvedValue({
      attempted: true,
      success: true,
      packageManager: "npm",
      installCommand: "npm ci --no-audit --no-fund",
      durationMs: 1500,
      errorType: null,
    });

    // Untouched baseline build FAILS with syntax/type error
    jest.spyOn(ValidationRunner, "validateWithShell").mockResolvedValue({
      success: false,
      errors: "src/app.tsx(10,5): error TS2322: Type 'number' is not assignable to type 'string'.",
    });

    const spyAgentPipeline = jest.spyOn(AgentPipeline, "runCodingAgent");

    const summary = await GitWorktreeService.runIsolatedAgent({
      userId: "user-1",
      projectId: "proj-1",
      repositoryPath: tempDir,
      runId: "run-baseline-fail",
      request: { message: "add button to Calculator.tsx" },
    });

    expect(spyAgentPipeline).not.toHaveBeenCalled();
    expect(summary.validationPassed).toBe(false);
    expect(summary.agentResponse.healthStatus).toBe("BASELINE_REPOSITORY_UNHEALTHY");
    expect(summary.agentResponse.baselineReady).toBe(false);
    expect(summary.agentResponse.buildReady).toBe(false);
    expect(summary.agentResponse.baselineDependencyInstall).toBe("PASS");
    expect(summary.agentResponse.baselineBuild).toBe("FAIL");
    expect(summary.agentResponse.origin).toBe("BASELINE");
    expect(summary.agentResponse.baselineFailure).toBe(true);
    expect(summary.agentResponse.agentIntroduced).toBe(false);
  });

  test("C & D. Pre-existing MISSING_DEP is marked origin=BASELINE and does not enter normal task SelfHealing", async () => {
    const rawError = "Error: Cannot find module '@tailwindcss/postcss'\nRequire stack:\n- /workspace/postcss.config.mjs";
    const classification = ErrorClassifier.classify(rawError);
    classification.origin = "BASELINE";

    expect(classification.type).toBe("MISSING_DEP");
    expect(classification.origin).toBe("BASELINE");

    const missingPkgs = ErrorClassifier.extractMissingPackageNames(rawError);
    expect(missingPkgs).toEqual(["@tailwindcss/postcss"]);
  });

  test("E & F & G. Baseline dependency repair restores missing packages, reruns npm ci and build, making baselineReady true", async () => {
    const pkgJson = {
      name: "anka-app",
      scripts: { build: "next build" },
      dependencies: {
        next: "^14.0.0",
      },
    };
    fs.writeFileSync(path.join(tempDir, "package.json"), JSON.stringify(pkgJson, null, 2));
    fs.writeFileSync(path.join(tempDir, "package-lock.json"), "{}");

    jest.spyOn(GitWorktreeService, "prepareRepositoryRun").mockResolvedValue({
      originalRepositoryPath: tempDir,
      repositoryRoot: tempDir,
      worktreePath: tempDir,
      branchName: "anka/run-baseline-repair",
      baseCommitSha: "sha-234",
    });
    jest.spyOn(GitWorktreeService, "rollbackWorktree").mockResolvedValue(undefined as any);
    jest.spyOn(GitWorktreeService, "getWorktreeDiff").mockResolvedValue({
      changedFiles: ["package.json", "package-lock.json", "src/Calculator.tsx"],
      diffSummary: "Repaired baseline dependencies and updated Calculator",
      rawDiff: "diff",
    });

    fs.mkdirSync(path.join(tempDir, "node_modules", ".bin"), { recursive: true });
    fs.mkdirSync(path.join(tempDir, "node_modules", "next"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, "node_modules", ".bin", "next"), "#!/usr/bin/env node");
    fs.writeFileSync(path.join(tempDir, "node_modules", ".bin", "next.cmd"), "@echo off");

    // npm ci PASS
    jest.spyOn(WorktreeDependencyService, "prepareDependencies").mockResolvedValue({
      attempted: true,
      success: true,
      packageManager: "npm",
      installCommand: "npm ci --no-audit --no-fund",
      durationMs: 1500,
      errorType: null,
    });

    // Initial build fails with missing @tailwindcss/postcss and mathjs
    let buildAttempt = 0;
    jest.spyOn(ValidationRunner, "validateWithShell").mockImplementation(async () => {
      buildAttempt++;
      if (buildAttempt === 1) {
        return {
          success: false,
          errors: "Cannot find module '@tailwindcss/postcss'\nCannot resolve 'mathjs'",
        };
      }
      return {
        success: true,
        errors: "",
      };
    });

    // Baseline repair coordinator mock
    jest.spyOn(BaselineRepairCoordinator, "repairBaselineBuildFailure").mockResolvedValue({
      success: true,
      baselineReady: true,
      repairedPackages: ["@tailwindcss/postcss@^4.0.0", "mathjs@^12.4.0"],
      explanation: "Repaired baseline dependencies",
      changes: [
        { path: "package.json", content: "{}", action: "modify", description: "repaired" },
        { path: "package-lock.json", content: "{}", action: "modify", description: "repaired" },
      ],
      durationMs: 200,
    });

    // Pipeline succeeds on healthy baseline
    jest.spyOn(AgentPipeline, "runCodingAgent").mockResolvedValue({
      explanation: "Added backspace button to Calculator.tsx",
      changes: [{ path: "src/Calculator.tsx", content: "export function Calc() {}", action: "modify", description: "Calculator" }],
      commitMessage: "feat: add backspace button",
      sessionId: "sess-1",
      buildVerified: true,
    });

    const summary = await GitWorktreeService.runIsolatedAgent({
      userId: "user-1",
      projectId: "proj-1",
      repositoryPath: tempDir,
      runId: "run-repaired-baseline",
      request: { message: "Fix missing baseline dependencies and restore package build: @tailwindcss/postcss and mathjs" },
    });

    expect(summary.validationPassed).toBe(true);
    expect(summary.agentResponse.baselineReady).toBe(true);
    expect(summary.agentResponse.buildReady).toBe(true);
    expect(summary.agentResponse.baselineBuild).toBe("PASS");
    expect(summary.agentResponse.baselineDependencyInstall).toBe("PASS");
  });

  test("E2. BaselineRepairCoordinator unit test: adds missing packages to package.json and regenerates lockfile", async () => {
    const pkgJson = {
      name: "anka-app",
      scripts: { build: "next build" },
      dependencies: {},
      devDependencies: {},
    };
    fs.writeFileSync(path.join(tempDir, "package.json"), JSON.stringify(pkgJson, null, 2));

    jest.spyOn(DependencyRepairService, "resolveValidPackageVersion").mockImplementation(async (pkg) => {
      if (pkg === "@tailwindcss/postcss") return "4.0.0";
      if (pkg === "mathjs") return "12.4.0";
      return null;
    });

    jest.spyOn(WorktreeDependencyService, "prepareDependencies").mockResolvedValue({
      attempted: true,
      success: true,
      packageManager: "npm",
      installCommand: "npm ci",
      durationMs: 500,
      errorType: null,
    });

    jest.spyOn(ValidationRunner, "validateWithShell").mockResolvedValue({
      success: true,
      errors: "",
    });

    const mockExecutor = async (cmd: string) => {
      if (cmd.includes("install")) {
        fs.writeFileSync(path.join(tempDir, "package-lock.json"), "{}");
      }
      return { stdout: "ok", stderr: "" };
    };

    const repairRes = await BaselineRepairCoordinator.repairBaselineBuildFailure(
      tempDir,
      ["npm run build"],
      "Cannot find module '@tailwindcss/postcss'\nCannot resolve 'mathjs'",
      "npm",
      mockExecutor
    );

    expect(repairRes.success).toBe(true);
    expect(repairRes.baselineReady).toBe(true);
    expect(repairRes.repairedPackages).toEqual(["@tailwindcss/postcss@^4.0.0", "mathjs@^12.4.0"]);

    const updatedPkg = JSON.parse(fs.readFileSync(path.join(tempDir, "package.json"), "utf8"));
    expect(updatedPkg.devDependencies["@tailwindcss/postcss"]).toBe("^4.0.0");
    expect(updatedPkg.dependencies["mathjs"]).toBe("^12.4.0");
  });

  test("H & I. Once baseline is clean, normal coding request executes; new post-generation error is marked CURRENT_TASK", async () => {
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
      branchName: "anka/run-clean-baseline",
      baseCommitSha: "sha-345",
    });
    jest.spyOn(GitWorktreeService, "rollbackWorktree").mockResolvedValue(undefined as any);
    jest.spyOn(GitWorktreeService, "getWorktreeDiff").mockResolvedValue({
      changedFiles: ["src/Calculator.tsx"],
      diffSummary: "Modified Calculator.tsx",
      rawDiff: "diff",
    });

    // Untouched dependencies and build PASS
    jest.spyOn(WorktreeDependencyService, "prepareDependencies").mockResolvedValue({
      attempted: true,
      success: true,
      packageManager: "npm",
      installCommand: "npm ci --no-audit --no-fund",
      durationMs: 1200,
      errorType: null,
    });
    jest.spyOn(ValidationRunner, "validateWithShell").mockResolvedValue({
      success: true,
      errors: "",
    });

    // Agent introduced a type error during generation
    jest.spyOn(AgentPipeline, "runCodingAgent").mockResolvedValue({
      explanation: "Modified Calculator but build failed",
      changes: [{ path: "src/Calculator.tsx", content: "bad code", action: "modify", description: "Calculator" }],
      commitMessage: "feat: calc",
      sessionId: "sess-2",
      buildVerified: false,
    });

    const summary = await GitWorktreeService.runIsolatedAgent({
      userId: "user-1",
      projectId: "proj-1",
      repositoryPath: tempDir,
      runId: "run-task-fail",
      request: { message: "update calculator styling" },
    });

    expect(summary.validationPassed).toBe(false);
    expect(summary.agentResponse.baselineReady).toBe(true);
    expect(summary.agentResponse.buildReady).toBe(true);
    expect(summary.agentResponse.baselineBuild).toBe("PASS");
    expect(summary.agentResponse.origin).toBe("CURRENT_TASK");
    expect(summary.agentResponse.agentIntroduced).toBe(true);
  });

  test("J. extractMissingPackageNames extracts multiple distinct external packages accurately", () => {
    const errorOutput = `
Failed to compile.
./postcss.config.mjs
Cannot find module '@tailwindcss/postcss'
Require stack:
- /workspace/postcss.config.mjs

./src/calculator.ts
Module not found: Can't resolve 'mathjs' in '/workspace/src'

./src/utils.ts
Cannot resolve 'lodash/debounce' in '/workspace/src'
`;

    const pkgs = ErrorClassifier.extractMissingPackageNames(errorOutput);
    expect(pkgs).toEqual(expect.arrayContaining(["@tailwindcss/postcss", "mathjs", "lodash"]));
    expect(pkgs).not.toContain("/workspace/postcss.config.mjs");
  });
});
