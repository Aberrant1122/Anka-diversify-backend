import fs from "fs";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export interface DependencyPreparationResult {
  attempted: boolean;
  success: boolean;
  packageManager: string | null;
  installCommand: string | null;
  durationMs: number;
  errorType: string | null;
  error?: string;
  packageName?: string;
  requestedVersion?: string;
}

export class WorktreeDependencyService {
  /**
   * Deterministically resolves the package manager and install command without executing it.
   */
  public static resolveDependencyInstallPlan(worktreePath: string): {
    needed: boolean;
    packageManager: string | null;
    installCommand: string | null;
    errorType: string | null;
    error?: string;
  } {
    const pkgPath = path.join(worktreePath, "package.json");
    if (!fs.existsSync(pkgPath)) {
      return {
        needed: false,
        packageManager: null,
        installCommand: null,
        errorType: null,
      };
    }

    let parsedPkg: any = null;
    try {
      parsedPkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    } catch {
      return {
        needed: true,
        packageManager: null,
        installCommand: null,
        errorType: "INVALID_PACKAGE_JSON",
        error: "Failed to parse package.json in worktree.",
      };
    }

    const hasDeps = Boolean(
      (parsedPkg.dependencies && Object.keys(parsedPkg.dependencies).length > 0) ||
      (parsedPkg.devDependencies && Object.keys(parsedPkg.devDependencies).length > 0)
    );

    if (!hasDeps) {
      return {
        needed: false,
        packageManager: null,
        installCommand: null,
        errorType: null,
      };
    }

    const hasPackageLock = fs.existsSync(path.join(worktreePath, "package-lock.json"));
    const hasPnpmLock = fs.existsSync(path.join(worktreePath, "pnpm-lock.yaml"));
    const hasYarnLock = fs.existsSync(path.join(worktreePath, "yarn.lock"));

    let packageManager: string = "npm";
    let installCommand: string = "npm ci --no-audit --no-fund";

    if (typeof parsedPkg.packageManager === "string" && parsedPkg.packageManager.trim()) {
      const pmField = parsedPkg.packageManager.toLowerCase();
      if (pmField.startsWith("pnpm")) {
        packageManager = "pnpm";
        installCommand = "corepack pnpm install --frozen-lockfile";
      } else if (pmField.startsWith("yarn")) {
        packageManager = "yarn";
        installCommand = "yarn install --immutable";
      } else if (pmField.startsWith("npm")) {
        packageManager = "npm";
        installCommand = "npm ci --no-audit --no-fund";
      }
    } else if (hasPnpmLock) {
      packageManager = "pnpm";
      installCommand = "pnpm install --frozen-lockfile";
    } else if (hasYarnLock) {
      packageManager = "yarn";
      installCommand = "yarn install --frozen-lockfile";
    } else if (hasPackageLock) {
      packageManager = "npm";
      installCommand = "npm ci --no-audit --no-fund";
    } else {
      return {
        needed: true,
        packageManager: null,
        installCommand: null,
        errorType: "MISSING_LOCKFILE",
        error: "package.json exists with dependencies but no supported lockfile (package-lock.json, pnpm-lock.yaml, yarn.lock) is present in the worktree.",
      };
    }

    return {
      needed: true,
      packageManager,
      installCommand,
      errorType: null,
    };
  }

  /**
   * Prepares dependencies inside an isolated Git worktree before build validation.
   */
  public static async prepareDependencies(
    worktreePath: string,
    executor: (cmd: string, cwd: string) => Promise<{ stdout: string; stderr: string }> = async (cmd, cwd) => {
      return execAsync(cmd, { cwd, timeout: 180000, maxBuffer: 10 * 1024 * 1024 });
    }
  ): Promise<DependencyPreparationResult> {
    const plan = this.resolveDependencyInstallPlan(worktreePath);

    if (!plan.needed) {
      return {
        attempted: false,
        success: true,
        packageManager: null,
        installCommand: null,
        durationMs: 0,
        errorType: null,
      };
    }

    if (plan.errorType || !plan.installCommand) {
      return {
        attempted: true,
        success: false,
        packageManager: plan.packageManager,
        installCommand: plan.installCommand,
        durationMs: 0,
        errorType: plan.errorType || "SETUP_FAILED",
        error: plan.error,
      };
    }

    const startTime = performance.now();
    console.log(`[ANKA_DEP] preparation entered`);
    console.log(`[ANKA_DEP] packageManager=${plan.packageManager}`);
    console.log(`[ANKA_DEP] installCommand=${plan.installCommand}`);

    try {
      await executor(plan.installCommand, worktreePath);
      const durationMs = performance.now() - startTime;

      // Post-condition validation: Verify node_modules and required local binaries exist
      const nodeModulesPath = path.join(worktreePath, "node_modules");
      const nodeModulesExists = fs.existsSync(nodeModulesPath);

      if (!nodeModulesExists) {
        console.log(`[ANKA_DEP] attempted=true`);
        console.log(`[ANKA_DEP] success=false`);
        console.log(`[ANKA_DEP] errorType=DEPENDENCY_TOOL_MISSING`);
        console.log(`[ANKA_DEP] nodeModulesExists=false`);
        console.log(`[ANKA_DEP] nextBinaryExists=false`);
        return {
          attempted: true,
          success: false,
          packageManager: plan.packageManager,
          installCommand: plan.installCommand,
          durationMs,
          errorType: "DEPENDENCY_TOOL_MISSING",
          error: "node_modules directory is missing after running dependency installation.",
        };
      }

      // Check for build tools referenced in package.json scripts (e.g. next, vite, tsc)
      let parsedPkg: any = {};
      try {
        parsedPkg = JSON.parse(fs.readFileSync(path.join(worktreePath, "package.json"), "utf8"));
      } catch {}

      const buildScript = String(parsedPkg?.scripts?.build || "");
      const hasNextBuild = buildScript.includes("next");
      const hasViteBuild = buildScript.includes("vite");
      const hasTscBuild = buildScript.includes("tsc");

      const nextBinaryExists =
        fs.existsSync(path.join(nodeModulesPath, ".bin", "next")) ||
        fs.existsSync(path.join(nodeModulesPath, ".bin", "next.cmd")) ||
        fs.existsSync(path.join(nodeModulesPath, "next"));

      const viteBinaryExists =
        fs.existsSync(path.join(nodeModulesPath, ".bin", "vite")) ||
        fs.existsSync(path.join(nodeModulesPath, ".bin", "vite.cmd")) ||
        fs.existsSync(path.join(nodeModulesPath, "vite"));

      const tscBinaryExists =
        fs.existsSync(path.join(nodeModulesPath, ".bin", "tsc")) ||
        fs.existsSync(path.join(nodeModulesPath, ".bin", "tsc.cmd")) ||
        fs.existsSync(path.join(nodeModulesPath, "typescript"));

      console.log(`[ANKA_DEP] nodeModulesExists=${nodeModulesExists}`);
      console.log(`[ANKA_DEP] nextBinaryExists=${nextBinaryExists}`);

      if (hasNextBuild && !nextBinaryExists) {
        console.log(`[ANKA_DEP] attempted=true`);
        console.log(`[ANKA_DEP] success=false`);
        console.log(`[ANKA_DEP] errorType=DEPENDENCY_TOOL_MISSING`);
        return {
          attempted: true,
          success: false,
          packageManager: plan.packageManager,
          installCommand: plan.installCommand,
          durationMs,
          errorType: "DEPENDENCY_TOOL_MISSING",
          error: "Required build tool 'next' was not found in node_modules after dependency installation.",
        };
      }

      if (hasViteBuild && !viteBinaryExists) {
        console.log(`[ANKA_DEP] attempted=true`);
        console.log(`[ANKA_DEP] success=false`);
        console.log(`[ANKA_DEP] errorType=DEPENDENCY_TOOL_MISSING`);
        return {
          attempted: true,
          success: false,
          packageManager: plan.packageManager,
          installCommand: plan.installCommand,
          durationMs,
          errorType: "DEPENDENCY_TOOL_MISSING",
          error: "Required build tool 'vite' was not found in node_modules after dependency installation.",
        };
      }

      if (hasTscBuild && !tscBinaryExists) {
        console.log(`[ANKA_DEP] attempted=true`);
        console.log(`[ANKA_DEP] success=false`);
        console.log(`[ANKA_DEP] errorType=DEPENDENCY_TOOL_MISSING`);
        return {
          attempted: true,
          success: false,
          packageManager: plan.packageManager,
          installCommand: plan.installCommand,
          durationMs,
          errorType: "DEPENDENCY_TOOL_MISSING",
          error: "Required build tool 'typescript/tsc' was not found in node_modules after dependency installation.",
        };
      }

      console.log(`[ANKA_DEP] attempted=true`);
      console.log(`[ANKA_DEP] success=true`);
      console.log(`[ANKA_DEP] errorType=null`);

      return {
        attempted: true,
        success: true,
        packageManager: plan.packageManager,
        installCommand: plan.installCommand,
        durationMs,
        errorType: null,
      };
    } catch (err: any) {
      const durationMs = performance.now() - startTime;
      const errorMsg = err?.stderr || err?.stdout || err?.message || String(err);
      const classified = WorktreeDependencyService.classifyDependencyFailure(errorMsg, plan.installCommand);

      console.log(`[ANKA_DEP] attempted=true`);
      console.log(`[ANKA_DEP] success=false`);
      console.log(`[ANKA_DEP] errorType=${classified.errorType}`);
      if (classified.packageName) console.log(`[ANKA_DEP] packageName=${classified.packageName}`);
      if (classified.requestedVersion) console.log(`[ANKA_DEP] requestedVersion=${classified.requestedVersion}`);

      return {
        attempted: true,
        success: false,
        packageManager: plan.packageManager,
        installCommand: plan.installCommand,
        durationMs,
        errorType: classified.errorType,
        packageName: classified.packageName,
        requestedVersion: classified.requestedVersion,
        error: classified.error,
      };
    }
  }

  /**
   * Classifies raw package manager stderr/stdout into a deterministic dependency failure taxonomy.
   */
  public static classifyDependencyFailure(rawOutput: string, installCommand: string): {
    errorType: DependencyPreparationResult["errorType"];
    packageName?: string;
    requestedVersion?: string;
    error: string;
  } {
    const text = rawOutput || "";

    // 1. INVALID_PACKAGE_DEPENDENCY (ETARGET / E404)
    const etargetMatch =
      text.match(/No matching version found for ([^@\s]+)@([^\s,\r\n]+)/i) ||
      text.match(/notarget\s+No matching version found for ([^@\s]+)@([^\s,\r\n]+)/i) ||
      text.match(/ETARGET[\s\S]*?([a-zA-Z0-9@/_-]+)@([^\s,\r\n]+)/i);

    const e404Match =
      text.match(/404 Not Found.*?(?:registry\.npmjs\.org\/|https:\/\/registry\.[^\s]+\/)(@[^/\s]+\/[^/\s]+|[^/\s]+)/i) ||
      text.match(/code E404[\s\S]*?'([^']+)' is not in the npm registry/i);

    if (text.includes("ETARGET") || etargetMatch) {
      const pkgName = etargetMatch ? etargetMatch[1] : undefined;
      const reqVer = etargetMatch ? etargetMatch[2].replace(/\.+$/, "") : undefined;
      return {
        errorType: "INVALID_PACKAGE_DEPENDENCY",
        packageName: pkgName,
        requestedVersion: reqVer,
        error: `Invalid package dependency${pkgName ? ` '${pkgName}'` : ""}${reqVer ? `@'${reqVer}'` : ""}: version does not exist in registry. (ETARGET)`,
      };
    }

    if (text.includes("E404") || e404Match) {
      const pkgName = e404Match ? e404Match[1] : undefined;
      return {
        errorType: "INVALID_PACKAGE_DEPENDENCY",
        packageName: pkgName,
        error: `Package not found in registry${pkgName ? ` '${pkgName}'` : ""}. (E404)`,
      };
    }

    // 2. PEER_DEPENDENCY_CONFLICT (ERESOLVE)
    if (
      text.includes("ERESOLVE") ||
      /conflicting peer dependency/i.test(text) ||
      /unable to resolve dependency tree/i.test(text)
    ) {
      return {
        errorType: "PEER_DEPENDENCY_CONFLICT",
        error: `Peer dependency conflict detected during dependency resolution (ERESOLVE).`,
      };
    }

    // 3. LOCKFILE_OUT_OF_SYNC
    if (
      /package-lock\.json.*in sync/i.test(text) ||
      /npm ci can only install/i.test(text) ||
      /Frozen lockfile error/i.test(text) ||
      /Immutable lockfile error/i.test(text) ||
      /EUSAGE/i.test(text)
    ) {
      return {
        errorType: "LOCKFILE_OUT_OF_SYNC",
        error: `Lockfile is out of sync with package.json. Run package manager install to update lockfile.`,
      };
    }

    // 4. DEPENDENCY_NETWORK
    if (
      /ECONNREFUSED/i.test(text) ||
      /ETIMEDOUT/i.test(text) ||
      /EAI_AGAIN/i.test(text) ||
      /ENOTFOUND (?:registry|http)/i.test(text) ||
      /fetch failed/i.test(text)
    ) {
      return {
        errorType: "DEPENDENCY_NETWORK",
        error: `Network connectivity error during dependency resolution.`,
      };
    }

    // 5. SYSTEM_INFRASTRUCTURE
    if (
      /spawn (?:ENOENT|EACCES)/i.test(text) ||
      /command not found/i.test(text) ||
      /is not recognized as an internal or external command/i.test(text) ||
      /exit code 127/i.test(text) ||
      /exit code 126/i.test(text)
    ) {
      return {
        errorType: "SYSTEM_INFRASTRUCTURE",
        error: `System infrastructure error: package manager binary could not be executed.`,
      };
    }

    return {
      errorType: "INFRASTRUCTURE",
      error: `Dependency installation failed via '${installCommand}': ${text.slice(0, 300)}`,
    };
  }
}
