import fs from "fs";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { ErrorClassifier } from "../ai/validation/ErrorClassifier";
import { DependencyRepairService } from "./dependency-repair.service";
import { WorktreeDependencyService } from "./worktree-dependency.service";
import { ValidationRunner } from "../ai/validation/ValidationRunner";
import { AgentFileChange } from "../types";

const execAsync = promisify(exec);

export interface BaselineRepairResult {
  success: boolean;
  baselineReady: boolean;
  repairedPackages: string[];
  explanation: string;
  changes: AgentFileChange[];
  durationMs: number;
  error?: string;
}

export class BaselineRepairCoordinator {
  /**
   * Attempts to repair pre-existing baseline repository build failures (e.g. undeclared MISSING_DEP packages)
   * before starting any agent code generation.
   */
  public static async repairBaselineBuildFailure(
    worktreePath: string,
    baselineCommands: string[],
    rawBuildError: string,
    packageManager: string | null = "npm",
    executor: (cmd: string, cwd: string) => Promise<{ stdout: string; stderr: string }> = async (cmd, cwd) => {
      return execAsync(cmd, { cwd, timeout: 180000, maxBuffer: 10 * 1024 * 1024 });
    }
  ): Promise<BaselineRepairResult> {
    const startTime = performance.now();
    const pkgJsonPath = path.join(worktreePath, "package.json");

    if (!fs.existsSync(pkgJsonPath)) {
      return {
        success: false,
        baselineReady: false,
        repairedPackages: [],
        explanation: "Cannot repair baseline: package.json missing.",
        changes: [],
        durationMs: performance.now() - startTime,
        error: "MISSING_PACKAGE_JSON",
      };
    }

    let originalPkgContent = fs.readFileSync(pkgJsonPath, "utf8");
    let parsedPkg: any;
    try {
      parsedPkg = JSON.parse(originalPkgContent);
    } catch {
      return {
        success: false,
        baselineReady: false,
        repairedPackages: [],
        explanation: "Cannot repair baseline: package.json invalid JSON.",
        changes: [],
        durationMs: performance.now() - startTime,
        error: "INVALID_PACKAGE_JSON",
      };
    }

    const missingPkgs = ErrorClassifier.extractMissingPackageNames(rawBuildError);
    if (missingPkgs.length === 0) {
      return {
        success: false,
        baselineReady: false,
        repairedPackages: [],
        explanation: "Cannot auto-repair baseline build error: no missing package identified.",
        changes: [],
        durationMs: performance.now() - startTime,
        error: "NO_MISSING_PACKAGES_IDENTIFIED",
      };
    }

    console.log(`[BASELINE_REPAIR] Identified missing baseline packages: ${missingPkgs.join(", ")}`);
    parsedPkg.dependencies = parsedPkg.dependencies || {};
    parsedPkg.devDependencies = parsedPkg.devDependencies || {};

    const repairedPackages: string[] = [];

    for (const pkgName of missingPkgs) {
      // Check if already in dependencies or devDependencies
      if (parsedPkg.dependencies[pkgName] || parsedPkg.devDependencies[pkgName]) {
        continue;
      }

      // Resolve version deterministically from registry
      const resolvedVer = await DependencyRepairService.resolveValidPackageVersion(
        pkgName,
        undefined,
        executor,
        worktreePath
      );

      if (!resolvedVer) {
        console.warn(`[BASELINE_REPAIR] Could not resolve valid version for '${pkgName}' from registry.`);
        continue;
      }

      // Determine if dev dependency (e.g. postcss, tailwindcss, typescript, eslint)
      const isDev = /postcss|tailwind|@types|eslint|typescript|prettier|babel/i.test(pkgName);
      if (isDev) {
        parsedPkg.devDependencies[pkgName] = `^${resolvedVer}`;
      } else {
        parsedPkg.dependencies[pkgName] = `^${resolvedVer}`;
      }

      repairedPackages.push(`${pkgName}@^${resolvedVer}`);
    }

    if (repairedPackages.length === 0) {
      return {
        success: false,
        baselineReady: false,
        repairedPackages: [],
        explanation: "Failed to resolve any missing baseline package versions from registry.",
        changes: [],
        durationMs: performance.now() - startTime,
        error: "FAILED_VERSION_RESOLUTION",
      };
    }

    // Write updated package.json
    fs.writeFileSync(pkgJsonPath, JSON.stringify(parsedPkg, null, 2) + "\n", "utf8");

    // Regenerate lockfile
    const packageLockPath = path.join(worktreePath, "package-lock.json");
    const pnpmLockPath = path.join(worktreePath, "pnpm-lock.yaml");
    const yarnLockPath = path.join(worktreePath, "yarn.lock");

    let lockCmd = "npm install --package-lock-only --no-audit --no-fund";
    if (fs.existsSync(pnpmLockPath) || packageManager === "pnpm") {
      lockCmd = "pnpm install --lockfile-only";
    } else if (fs.existsSync(yarnLockPath) || packageManager === "yarn") {
      lockCmd = "yarn install --mode update-lockfile";
    }

    try {
      await executor(lockCmd, worktreePath);
    } catch {
      try {
        await executor("npm install --no-audit --no-fund", worktreePath);
      } catch (err: any) {
        return {
          success: false,
          baselineReady: false,
          repairedPackages,
          explanation: `Baseline lockfile regeneration failed: ${err?.message || err}`,
          changes: [],
          durationMs: performance.now() - startTime,
          error: "LOCKFILE_REGENERATION_FAILED",
        };
      }
    }

    // 1. Re-validate dependency preparation (npm ci)
    const depCheck = await WorktreeDependencyService.prepareDependencies(worktreePath, executor);
    if (!depCheck.success) {
      return {
        success: false,
        baselineReady: false,
        repairedPackages,
        explanation: `Baseline dependency preparation failed after adding missing packages: ${depCheck.error}`,
        changes: [],
        durationMs: performance.now() - startTime,
        error: depCheck.errorType || "DEP_PREP_FAILED",
      };
    }

    // 2. Re-validate baseline build (npm run build)
    const buildCheck = await ValidationRunner.validateWithShell([], worktreePath, baselineCommands);
    if (!buildCheck.success) {
      return {
        success: false,
        baselineReady: false,
        repairedPackages,
        explanation: `Baseline build failed after adding missing packages: ${buildCheck.errors}`,
        changes: [],
        durationMs: performance.now() - startTime,
        error: "BASELINE_BUILD_RETRY_FAILED",
      };
    }

    // Collect verified changes
    const changes: AgentFileChange[] = [];
    const newPkgContent = fs.readFileSync(pkgJsonPath, "utf8");
    if (newPkgContent !== originalPkgContent) {
      changes.push({
        path: "package.json",
        content: newPkgContent,
        action: "modify",
        description: `Baseline repair: add missing dependencies (${repairedPackages.join(", ")})`,
      });
    }

    if (fs.existsSync(packageLockPath)) {
      changes.push({
        path: "package-lock.json",
        content: fs.readFileSync(packageLockPath, "utf8"),
        action: "modify",
        description: "Baseline repair: regenerate package-lock.json for added dependencies",
      });
    } else if (fs.existsSync(pnpmLockPath)) {
      changes.push({
        path: "pnpm-lock.yaml",
        content: fs.readFileSync(pnpmLockPath, "utf8"),
        action: "modify",
        description: "Baseline repair: regenerate pnpm-lock.yaml for added dependencies",
      });
    } else if (fs.existsSync(yarnLockPath)) {
      changes.push({
        path: "yarn.lock",
        content: fs.readFileSync(yarnLockPath, "utf8"),
        action: "modify",
        description: "Baseline repair: regenerate yarn.lock for added dependencies",
      });
    }

    const durationMs = performance.now() - startTime;
    console.log(`[BASELINE_REPAIR] Baseline build successfully repaired: ${repairedPackages.join(", ")}`);

    return {
      success: true,
      baselineReady: true,
      repairedPackages,
      explanation: `Successfully repaired baseline build by adding missing dependencies (${repairedPackages.join(", ")}). Untouched build verified cleanly.`,
      changes,
      durationMs,
    };
  }
}
