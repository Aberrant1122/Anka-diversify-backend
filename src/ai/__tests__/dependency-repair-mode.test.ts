import fs from "fs";
import path from "path";
import os from "os";
import { DependencyRepairService, ALLOWED_DEPENDENCY_FILES } from "../../services/dependency-repair.service";
import { GitWorktreeService } from "../../services/git-worktree.service";
import { WorktreeDependencyService } from "../../services/worktree-dependency.service";

jest.setTimeout(30000);

describe("Constrained Dependency-Repair Mode on Broken Baseline (Steps A-I)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "anka-test-dep-repair-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
    jest.restoreAllMocks();
  });

  test("A. Unrelated source task + ETARGET halts with BASELINE_REPOSITORY_UNHEALTHY and does not enter dependency repair", async () => {
    jest.spyOn(GitWorktreeService, "prepareRepositoryRun").mockResolvedValue({
      originalRepositoryPath: tempDir,
      repositoryRoot: tempDir,
      worktreePath: tempDir,
      branchName: "anka/run-source-task",
      baseCommitSha: "sha-111",
    });
    jest.spyOn(GitWorktreeService, "rollbackWorktree").mockResolvedValue(undefined as any);

    jest.spyOn(WorktreeDependencyService, "prepareDependencies").mockResolvedValue({
      attempted: true,
      success: false,
      packageManager: "npm",
      installCommand: "npm ci --no-audit --no-fund",
      durationMs: 3100,
      errorType: "INVALID_PACKAGE_DEPENDENCY",
      packageName: "lucide-react",
      requestedVersion: "^0.2.0",
      error: "Invalid package dependency 'lucide-react'@'^0.2.0': version does not exist in registry. (ETARGET)",
    });

    const spyDepRepair = jest.spyOn(DependencyRepairService, "runConstrainedDependencyRepair");

    const summary = await GitWorktreeService.runIsolatedAgent({
      userId: "user-1",
      projectId: "proj-1",
      repositoryPath: tempDir,
      runId: "run-unrelated",
      request: { message: "Improve the existing calculator and center it on the screen" },
    });

    expect(spyDepRepair).not.toHaveBeenCalled();
    expect(summary.validationPassed).toBe(false);
    expect(summary.agentResponse.healthStatus).toBe("BASELINE_REPOSITORY_UNHEALTHY");
    expect(summary.agentResponse.errorType).toBe("INVALID_PACKAGE_DEPENDENCY");
    expect(summary.validationErrors).toContain("[BASELINE_REPOSITORY_UNHEALTHY]");
    expect(summary.changedFiles).toHaveLength(0);
  });

  test("B. Explicit dependency repair task + ETARGET enters DEPENDENCY_REPAIR mode and succeeds", async () => {
    // Setup broken package.json
    const pkgJson = {
      name: "anka-app",
      dependencies: {
        "lucide-react": "^0.2.0",
      },
    };
    fs.writeFileSync(path.join(tempDir, "package.json"), JSON.stringify(pkgJson, null, 2));
    fs.writeFileSync(path.join(tempDir, "package-lock.json"), "{}");

    jest.spyOn(GitWorktreeService, "prepareRepositoryRun").mockResolvedValue({
      originalRepositoryPath: tempDir,
      repositoryRoot: tempDir,
      worktreePath: tempDir,
      branchName: "anka/run-dep-repair",
      baseCommitSha: "sha-222",
    });
    jest.spyOn(GitWorktreeService, "rollbackWorktree").mockResolvedValue(undefined as any);
    jest.spyOn(GitWorktreeService, "getWorktreeDiff").mockResolvedValue({
      changedFiles: ["package.json", "package-lock.json"],
      diffSummary: "Updated dependencies and regenerated lockfile.",
      rawDiff: "diff --git a/package.json b/package.json",
    });

    // Mock initial prepareDependencies failing with ETARGET
    let prepCount = 0;
    jest.spyOn(WorktreeDependencyService, "prepareDependencies").mockImplementation(async () => {
      prepCount++;
      if (prepCount === 1) {
        return {
          attempted: true,
          success: false,
          packageManager: "npm",
          installCommand: "npm ci --no-audit --no-fund",
          durationMs: 3100,
          errorType: "INVALID_PACKAGE_DEPENDENCY",
          packageName: "lucide-react",
          requestedVersion: "^0.2.0",
          error: "Invalid package dependency 'lucide-react'@'^0.2.0': version does not exist in registry. (ETARGET)",
        };
      }
      // Revalidation after repair passes
      return {
        attempted: true,
        success: true,
        packageManager: "npm",
        installCommand: "npm ci --no-audit --no-fund",
        durationMs: 2500,
        errorType: null,
      };
    });

    // Mock version resolver to resolve valid 1.34.0
    jest.spyOn(DependencyRepairService, "resolveValidPackageVersion").mockResolvedValue("1.34.0");

    const summary = await GitWorktreeService.runIsolatedAgent({
      userId: "user-1",
      projectId: "proj-1",
      repositoryPath: tempDir,
      runId: "run-repair",
      request: {
        message:
          "npm ci is failing because the repository has an invalid dependency. lucide-react is set to ^0.2.0 and npm returns ETARGET. Fix the repository dependency issue and restore a healthy installable baseline. Do not change application source files.",
      },
    });

    expect(summary.validationPassed).toBe(true);
    expect(summary.agentResponse.healthStatus).toBe("HEALTHY");
    expect(summary.agentResponse.baselineFailure).toBe(false);
    expect(summary.agentResponse.buildVerificationBlocked).toBe(false);
    expect(summary.agentResponse.explanation).toContain("Successfully repaired repository dependency baseline");
    expect(summary.agentResponse.changes.map((c) => c.path)).toEqual(expect.arrayContaining(["package.json"]));
  });

  test("C. Dependency repair modifies package.json and lockfile only", async () => {
    const pkgJson = {
      name: "anka-app",
      dependencies: {
        "lucide-react": "^0.2.0",
      },
    };
    fs.writeFileSync(path.join(tempDir, "package.json"), JSON.stringify(pkgJson, null, 2));
    fs.writeFileSync(path.join(tempDir, "package-lock.json"), "{}");

    jest.spyOn(DependencyRepairService, "resolveValidPackageVersion").mockResolvedValue("0.470.0");
    jest.spyOn(WorktreeDependencyService, "prepareDependencies").mockResolvedValue({
      attempted: true,
      success: true,
      packageManager: "npm",
      installCommand: "npm ci --no-audit --no-fund",
      durationMs: 1200,
      errorType: null,
    });

    const mockExecutor = async (cmd: string) => {
      if (cmd.includes("install")) {
        fs.writeFileSync(path.join(tempDir, "package-lock.json"), '{"lockfileVersion": 3}');
      }
      return { stdout: "success", stderr: "" };
    };

    const repairRes = await DependencyRepairService.runConstrainedDependencyRepair({
      worktreePath: tempDir,
      depPrep: {
        attempted: true,
        success: false,
        packageManager: "npm",
        installCommand: "npm ci --no-audit --no-fund",
        durationMs: 2000,
        errorType: "INVALID_PACKAGE_DEPENDENCY",
        packageName: "lucide-react",
        requestedVersion: "^0.2.0",
      },
      userMessage: "Fix lucide-react dependency version in package.json",
      executor: mockExecutor,
    });

    expect(repairRes.success).toBe(true);
    const changedPaths = repairRes.changes.map((c) => c.path);
    for (const p of changedPaths) {
      expect(ALLOWED_DEPENDENCY_FILES.has(p)).toBe(true);
    }
  });

  test("D. Calculator.tsx cannot be modified in dependency repair mode (violating scope rejects change)", async () => {
    jest.spyOn(GitWorktreeService, "prepareRepositoryRun").mockResolvedValue({
      originalRepositoryPath: tempDir,
      repositoryRoot: tempDir,
      worktreePath: tempDir,
      branchName: "anka/run-illegal-diff",
      baseCommitSha: "sha-333",
    });
    jest.spyOn(GitWorktreeService, "rollbackWorktree").mockResolvedValue(undefined as any);

    jest.spyOn(WorktreeDependencyService, "prepareDependencies").mockResolvedValue({
      attempted: true,
      success: false,
      packageManager: "npm",
      installCommand: "npm ci --no-audit --no-fund",
      durationMs: 1500,
      errorType: "INVALID_PACKAGE_DEPENDENCY",
      packageName: "lucide-react",
      requestedVersion: "^0.2.0",
    });

    jest.spyOn(DependencyRepairService, "runConstrainedDependencyRepair").mockResolvedValue({
      success: true,
      explanation: "Repaired dependencies",
      changes: [],
      durationMs: 1000,
    });

    // Simulate worktree diff containing illegal application file
    jest.spyOn(GitWorktreeService, "getWorktreeDiff").mockResolvedValue({
      changedFiles: ["package.json", "src/Calculator.tsx"],
      diffSummary: "Modified package.json and Calculator.tsx",
      rawDiff: "diff",
    });

    const summary = await GitWorktreeService.runIsolatedAgent({
      userId: "user-1",
      projectId: "proj-1",
      repositoryPath: tempDir,
      runId: "run-scope-violation",
      request: { message: "repair lockfile and dependencies" },
    });

    expect(summary.validationPassed).toBe(false);
    expect(summary.validationErrors).toContain("[DEPENDENCY_REPAIR_VIOLATION]");
    expect(summary.validationErrors).toContain("src/Calculator.tsx");
    expect(summary.agentResponse.healthStatus).toBe("BASELINE_REPOSITORY_UNHEALTHY");
  });

  test("E. Valid registry version is resolved deterministically through package manager registry", async () => {
    const mockExecutor = async (cmd: string) => {
      if (cmd.includes("versions")) {
        return {
          stdout: JSON.stringify(["0.1.0", "0.16.8", "0.200.0", "0.470.0", "1.0.0"]),
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    };

    const resolvedMajor0 = await DependencyRepairService.resolveValidPackageVersion(
      "lucide-react",
      "^0.2.0",
      mockExecutor,
      tempDir
    );
    expect(resolvedMajor0).toBe("0.470.0");

    const resolvedMajor1 = await DependencyRepairService.resolveValidPackageVersion(
      "lucide-react",
      "^1.0.0",
      mockExecutor,
      tempDir
    );
    expect(resolvedMajor1).toBe("1.0.0");
  });

  test("F. Offline / unavailable registry lookup fails explicitly without guessing", async () => {
    const mockExecutor = async () => {
      throw new Error("EAI_AGAIN registry.npmjs.org not reachable");
    };

    const resolved = await DependencyRepairService.resolveValidPackageVersion(
      "lucide-react",
      "^0.2.0",
      mockExecutor,
      tempDir
    );

    expect(resolved).toBeNull();
  });

  test("G. Revalidation failure after repair reports error cleanly", async () => {
    const pkgJson = {
      name: "anka-app",
      dependencies: { "some-pkg": "^0.2.0" },
    };
    fs.writeFileSync(path.join(tempDir, "package.json"), JSON.stringify(pkgJson, null, 2));

    jest.spyOn(DependencyRepairService, "resolveValidPackageVersion").mockResolvedValue("1.0.0");

    // Revalidation fails
    jest.spyOn(WorktreeDependencyService, "prepareDependencies").mockResolvedValue({
      attempted: true,
      success: false,
      packageManager: "npm",
      installCommand: "npm ci --no-audit --no-fund",
      durationMs: 1200,
      errorType: "PEER_DEPENDENCY_CONFLICT",
      error: "Peer dependency conflict after update",
    });

    const repairRes = await DependencyRepairService.runConstrainedDependencyRepair({
      worktreePath: tempDir,
      depPrep: {
        attempted: true,
        success: false,
        packageManager: "npm",
        installCommand: "npm ci --no-audit --no-fund",
        durationMs: 1000,
        errorType: "INVALID_PACKAGE_DEPENDENCY",
        packageName: "some-pkg",
      },
      userMessage: "fix package.json dependency issue",
      executor: async () => ({ stdout: "", stderr: "" }),
    });

    expect(repairRes.success).toBe(false);
    expect(repairRes.error).toBe("PEER_DEPENDENCY_CONFLICT");
    expect(repairRes.explanation).toContain("Revalidation after dependency repair failed");
  });

  test("H. isDependencyRepairIntent accurately classifies user prompts", () => {
    expect(DependencyRepairService.isDependencyRepairIntent("fix package.json dependencies")).toBe(true);
    expect(
      DependencyRepairService.isDependencyRepairIntent(
        "npm ci is failing because of ETARGET. Fix the dependency baseline."
      )
    ).toBe(true);
    expect(DependencyRepairService.isDependencyRepairIntent("repair lockfile")).toBe(true);
    expect(DependencyRepairService.isDependencyRepairIntent("restore installable dependencies")).toBe(true);
    expect(DependencyRepairService.isDependencyRepairIntent("fix lucide-react version")).toBe(true);

    // Unrelated tasks must return false
    expect(DependencyRepairService.isDependencyRepairIntent("center the calculator on the screen")).toBe(false);
    expect(DependencyRepairService.isDependencyRepairIntent("update the UI it's too simple")).toBe(false);
    expect(DependencyRepairService.isDependencyRepairIntent("add backspace button to Calculator.tsx")).toBe(false);
  });

  test("I. Non-repairable baseline failure (e.g. SYSTEM_INFRASTRUCTURE) halts normally without entering dependency repair", async () => {
    jest.spyOn(GitWorktreeService, "prepareRepositoryRun").mockResolvedValue({
      originalRepositoryPath: tempDir,
      repositoryRoot: tempDir,
      worktreePath: tempDir,
      branchName: "anka/run-infra",
      baseCommitSha: "sha-444",
    });
    jest.spyOn(GitWorktreeService, "rollbackWorktree").mockResolvedValue(undefined as any);

    jest.spyOn(WorktreeDependencyService, "prepareDependencies").mockResolvedValue({
      attempted: true,
      success: false,
      packageManager: "npm",
      installCommand: "npm ci --no-audit --no-fund",
      durationMs: 500,
      errorType: "SYSTEM_INFRASTRUCTURE",
      error: "spawn npm ENOENT: npm binary not found",
    });

    const spyDepRepair = jest.spyOn(DependencyRepairService, "runConstrainedDependencyRepair");

    const summary = await GitWorktreeService.runIsolatedAgent({
      userId: "user-1",
      projectId: "proj-1",
      repositoryPath: tempDir,
      runId: "run-infra",
      request: { message: "fix package.json dependencies" },
    });

    expect(spyDepRepair).not.toHaveBeenCalled();
    expect(summary.validationPassed).toBe(false);
    expect(summary.agentResponse.healthStatus).toBe("BASELINE_REPOSITORY_UNHEALTHY");
    expect(summary.agentResponse.errorType).toBe("SYSTEM_INFRASTRUCTURE");
  });
});
