import fs from "fs";
import path from "path";

export interface WorkspacePackage {
  name: string;
  relativePath: string;
  packageJsonPath: string;
  dependencies: Set<string>;
  scripts: Record<string, string>;
  tsconfigPath?: string;
}

export interface MonorepoDescriptor {
  isMonorepo: boolean;
  type: "npm" | "pnpm" | "yarn" | "turbo" | "none";
  packageManager: "npm" | "pnpm" | "yarn";
  rootPath: string;
  hasTurbo: boolean;
  workspaces: WorkspacePackage[];
  packageByPath: Map<string, WorkspacePackage>;
  packageByName: Map<string, WorkspacePackage>;
  packageDependencies: Map<string, Set<string>>;
  packageDependents: Map<string, Set<string>>;
}

export interface SnapshotFileInput {
  path: string;
  content?: string;
}

/**
 * Normalizes file and directory paths to forward-slash repo-relative format.
 */
function normalizePath(p: string): string {
  if (!p) return "";
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\//, "").replace(/\/$/, "");
}

/**
 * Parses pnpm-workspace.yaml without external dependencies.
 * Extracts glob patterns under the `packages:` key.
 */
function parsePnpmWorkspaceYaml(content: string): string[] {
  const patterns: string[] = [];
  const lines = content.split(/\r?\n/);
  let inPackagesSection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (/^packages\s*:/i.test(trimmed)) {
      inPackagesSection = true;
      continue;
    }

    if (inPackagesSection) {
      if (/^[a-zA-Z0-9_\-]+:/.test(trimmed)) {
        // Next YAML top-level section
        break;
      }
      const match = trimmed.match(/^-\s*['"]?([^'"]+)['"]?/);
      if (match) {
        patterns.push(normalizePath(match[1]));
      }
    }
  }

  return patterns;
}

/**
 * Matches a workspace directory (e.g. "packages/ui") against a glob pattern (e.g. "packages/*").
 */
function matchGlobPattern(dirPath: string, pattern: string): boolean {
  const normDir = normalizePath(dirPath);
  const normPattern = normalizePath(pattern);

  if (normPattern === normDir) return true;

  if (normPattern.endsWith("/*")) {
    const prefix = normPattern.slice(0, -2);
    if (!prefix) {
      return !normDir.includes("/");
    }
    if (normDir.startsWith(prefix + "/")) {
      const remainder = normDir.slice(prefix.length + 1);
      return remainder.length > 0 && !remainder.includes("/");
    }
    return false;
  }

  if (normPattern.endsWith("/**")) {
    const prefix = normPattern.slice(0, -3);
    if (!prefix) return true;
    return normDir === prefix || normDir.startsWith(prefix + "/");
  }

  return false;
}

export class MonorepoDetector {
  /**
   * Deterministically detects monorepo configuration from filesystem and/or snapshot files.
   */
  public static detectMonorepo(
    rootPath?: string | null,
    snapshotFiles?: Array<SnapshotFileInput | any>
  ): MonorepoDescriptor {
    const defaultDescriptor: MonorepoDescriptor = {
      isMonorepo: false,
      type: "none",
      packageManager: "npm",
      rootPath: rootPath || "",
      hasTurbo: false,
      workspaces: [],
      packageByPath: new Map(),
      packageByName: new Map(),
      packageDependencies: new Map(),
      packageDependents: new Map(),
    };

    // Helper to get file text from snapshot or disk
    const getFile = (relPath: string): string | null => {
      const norm = normalizePath(relPath);
      if (Array.isArray(snapshotFiles)) {
        const snap = snapshotFiles.find((f) => normalizePath(f?.path || "") === norm);
        if (snap && typeof snap.content === "string") return snap.content;
      }
      if (rootPath && fs.existsSync(path.join(rootPath, norm))) {
        try {
          return fs.readFileSync(path.join(rootPath, norm), "utf8");
        } catch { }
      }
      return null;
    };

    // Helper to check file existence
    const fileExists = (relPath: string): boolean => {
      const norm = normalizePath(relPath);
      if (Array.isArray(snapshotFiles)) {
        if (snapshotFiles.some((f) => normalizePath(f?.path || "") === norm)) return true;
      }
      if (rootPath && fs.existsSync(path.join(rootPath, norm))) {
        return true;
      }
      return false;
    };

    // 1. Check turbo.json
    const hasTurbo = fileExists("turbo.json");

    // 2. Check pnpm-workspace.yaml
    const pnpmWorkspaceContent = getFile("pnpm-workspace.yaml");

    // 3. Check root package.json
    const rootPkgJsonContent = getFile("package.json");
    let rootPkg: any = null;
    if (rootPkgJsonContent) {
      try {
        rootPkg = JSON.parse(rootPkgJsonContent);
      } catch {
        rootPkg = null;
      }
    }

    // 4. Resolve package manager
    let packageManager: "npm" | "pnpm" | "yarn" = "npm";
    if (rootPkg && typeof rootPkg.packageManager === "string") {
      const pm = rootPkg.packageManager.toLowerCase();
      if (pm.startsWith("pnpm")) packageManager = "pnpm";
      else if (pm.startsWith("yarn")) packageManager = "yarn";
      else if (pm.startsWith("npm")) packageManager = "npm";
    } else if (pnpmWorkspaceContent || fileExists("pnpm-lock.yaml")) {
      packageManager = "pnpm";
    } else if (fileExists("yarn.lock")) {
      packageManager = "yarn";
    } else if (fileExists("package-lock.json")) {
      packageManager = "npm";
    }

    // 5. Collect workspace glob patterns
    let rawPatterns: string[] = [];
    let detectedType: "npm" | "pnpm" | "yarn" | "turbo" | "none" = "none";

    if (pnpmWorkspaceContent) {
      detectedType = "pnpm";
      packageManager = "pnpm";
      rawPatterns = parsePnpmWorkspaceYaml(pnpmWorkspaceContent);
    } else if (rootPkg && rootPkg.workspaces) {
      if (packageManager === "yarn") {
        detectedType = "yarn";
      } else {
        detectedType = "npm";
      }

      if (Array.isArray(rootPkg.workspaces)) {
        rawPatterns = rootPkg.workspaces.map((p: any) => String(p));
      } else if (typeof rootPkg.workspaces === "object" && Array.isArray(rootPkg.workspaces.packages)) {
        rawPatterns = rootPkg.workspaces.packages.map((p: any) => String(p));
      }
    }

    if (rawPatterns.length === 0) {
      // Not a configured monorepo
      return defaultDescriptor;
    }

    if (hasTurbo) {
      detectedType = "turbo";
    }

    // 6. Discover package.json files matching the patterns
    // Collect all candidate package.json paths
    const candidatePkgPaths = new Set<string>();

    if (Array.isArray(snapshotFiles)) {
      for (const f of snapshotFiles) {
        const norm = normalizePath(f?.path || "");
        if (norm.endsWith("/package.json") && norm !== "package.json") {
          candidatePkgPaths.add(norm);
        }
      }
    }

    if (rootPath && fs.existsSync(rootPath)) {
      // Find package.json files on disk matching patterns
      for (const pattern of rawPatterns) {
        const prefix = pattern.replace(/\/\*+$/, "").replace(/^\.\//, "");
        const searchDir = path.join(rootPath, prefix);
        if (fs.existsSync(searchDir)) {
          try {
            const entries = fs.readdirSync(searchDir, { withFileTypes: true });
            for (const entry of entries) {
              if (entry.isDirectory()) {
                const subPkgPath = path.join(prefix, entry.name, "package.json");
                if (fs.existsSync(path.join(rootPath, subPkgPath))) {
                  candidatePkgPaths.add(normalizePath(subPkgPath));
                }
              }
            }
          } catch { }
        }
      }
    }

    // 7. Parse each candidate package
    const workspaces: WorkspacePackage[] = [];
    const packageByPath = new Map<string, WorkspacePackage>();
    const packageByName = new Map<string, WorkspacePackage>();

    for (const pkgJsonPath of candidatePkgPaths) {
      const dirPath = normalizePath(path.dirname(pkgJsonPath));
      // Check whether this directory matches any workspace pattern
      const isMatched = rawPatterns.some((pattern) => matchGlobPattern(dirPath, pattern));
      if (!isMatched && rawPatterns.length > 0) continue;

      const content = getFile(pkgJsonPath);
      if (!content) continue;

      let parsed: any = null;
      try {
        parsed = JSON.parse(content);
      } catch {
        continue;
      }

      const pkgName = String(parsed.name || path.basename(dirPath)).trim();
      const allDeps = new Set<string>([
        ...Object.keys(parsed.dependencies || {}),
        ...Object.keys(parsed.devDependencies || {}),
        ...Object.keys(parsed.peerDependencies || {}),
      ]);
      const scripts: Record<string, string> = parsed.scripts && typeof parsed.scripts === "object" ? parsed.scripts : {};

      let tsconfigPath: string | undefined;
      const candidateTsconfig = `${dirPath}/tsconfig.json`;
      if (fileExists(candidateTsconfig)) {
        tsconfigPath = candidateTsconfig;
      }

      const wsPackage: WorkspacePackage = {
        name: pkgName,
        relativePath: dirPath,
        packageJsonPath: pkgJsonPath,
        dependencies: allDeps,
        scripts,
        tsconfigPath,
      };

      workspaces.push(wsPackage);
      packageByPath.set(dirPath, wsPackage);
      packageByName.set(pkgName, wsPackage);
    }

    if (workspaces.length === 0) {
      return defaultDescriptor;
    }

    // 8. Build Package Dependency Graph and Reverse Dependents
    const packageDependencies = new Map<string, Set<string>>();
    const packageDependents = new Map<string, Set<string>>();

    for (const ws of workspaces) {
      packageDependencies.set(ws.name, new Set());
      packageDependents.set(ws.name, new Set());
    }

    for (const ws of workspaces) {
      for (const depName of ws.dependencies) {
        if (packageByName.has(depName)) {
          packageDependencies.get(ws.name)!.add(depName);
          packageDependents.get(depName)!.add(ws.name);
        }
      }
    }

    return {
      isMonorepo: true,
      type: detectedType,
      packageManager,
      rootPath: rootPath || "",
      hasTurbo,
      workspaces,
      packageByPath,
      packageByName,
      packageDependencies,
      packageDependents,
    };
  }

  /**
   * Deterministically maps a file path to its owning workspace package.
   */
  public static getWorkspaceForFile(
    descriptor: MonorepoDescriptor,
    filePath: string
  ): WorkspacePackage | null {
    if (!descriptor.isMonorepo || !filePath) return null;
    const normPath = normalizePath(filePath);

    // Find the longest matching workspace relativePath
    let bestMatch: WorkspacePackage | null = null;
    let longestPrefix = -1;

    for (const ws of descriptor.workspaces) {
      if (normPath === ws.relativePath || normPath.startsWith(ws.relativePath + "/")) {
        if (ws.relativePath.length > longestPrefix) {
          longestPrefix = ws.relativePath.length;
          bestMatch = ws;
        }
      }
    }

    return bestMatch;
  }

  /**
   * Deterministically looks up a workspace package by its declared package name.
   */
  public static getWorkspaceByName(
    descriptor: MonorepoDescriptor,
    name: string
  ): WorkspacePackage | null {
    if (!descriptor.isMonorepo || !name) return null;
    return descriptor.packageByName.get(name) || null;
  }

  /**
   * Returns the set of workspace dependencies that pkgName relies on.
   */
  public static getDependencies(
    descriptor: MonorepoDescriptor,
    pkgName: string
  ): Set<string> {
    if (!descriptor.isMonorepo || !pkgName) return new Set();
    return descriptor.packageDependencies.get(pkgName) || new Set();
  }

  /**
   * Returns the set of workspace packages that depend on pkgName.
   */
  public static getDependents(
    descriptor: MonorepoDescriptor,
    pkgName: string
  ): Set<string> {
    if (!descriptor.isMonorepo || !pkgName) return new Set();
    return descriptor.packageDependents.get(pkgName) || new Set();
  }
}
