import fs from "fs";
import path from "path";
import { ExecutionContract } from "../shared/types";
import { MonorepoDetector, MonorepoDescriptor, WorkspacePackage } from "../workspace/MonorepoDetector";

export interface ValidationPlannerOptions {
  monorepo?: MonorepoDescriptor | null;
  changedFiles?: string[];
}

export class ValidationPlanner {
  static detectValidationCommands(
    workspacePath?: string | null,
    snapshot?: any,
    contract?: ExecutionContract,
    options?: ValidationPlannerOptions,
  ): string[] {
    // Check contract overrides first
    if (contract) {
      if (
        contract.validationType === "NONE" ||
        contract.validationType === "BROWSER_HTML" ||
        contract.pipeline === "STANDALONE" ||
        contract.environment === "HTML_CSS_JS"
      ) {
        return [];
      }
      if (contract.validationType === "PYTHON_SYNTAX" || contract.environment === "PYTHON") {
        return ["python -m py_compile"];
      }
    }

    const fileList: Array<any> = Array.isArray(snapshot)
      ? snapshot
      : snapshot?.keyFiles || snapshot?.repoSnapshot || [];

    const files = fileList.map((f: any) => (typeof f === "string" ? f : f.path || ""));

    // Check monorepo configuration
    const monorepo = options?.monorepo || MonorepoDetector.detectMonorepo(workspacePath, fileList);

    if (monorepo.isMonorepo && monorepo.workspaces.length > 0) {
      const changedFiles =
        options?.changedFiles && options.changedFiles.length > 0
          ? options.changedFiles
          : contract?.targetPaths && contract.targetPaths.length > 0
          ? contract.targetPaths
          : [];

      const monorepoCmds = this.detectMonorepoCommands(monorepo, changedFiles);
      if (monorepoCmds.length > 0) {
        return monorepoCmds;
      }
    }

    let hasPkgJson = files.some((f: string) => f.endsWith("package.json"));
    let hasCargo = files.some((f: string) => f.endsWith("Cargo.toml"));
    let hasGoMod = files.some((f: string) => f.endsWith("go.mod"));
    let hasPy = files.some((f: string) => f.endsWith("requirements.txt") || f.endsWith("pyproject.toml"));

    if (workspacePath && fs.existsSync(workspacePath)) {
      if (fs.existsSync(path.join(workspacePath, "package.json"))) hasPkgJson = true;
      if (fs.existsSync(path.join(workspacePath, "Cargo.toml"))) hasCargo = true;
      if (fs.existsSync(path.join(workspacePath, "go.mod"))) hasGoMod = true;
    }

    if (hasPkgJson) {
      try {
        let pkgContent = "";
        if (workspacePath && fs.existsSync(path.join(workspacePath, "package.json"))) {
          pkgContent = fs.readFileSync(path.join(workspacePath, "package.json"), "utf8");
        } else {
          const pkgFile = fileList.find((f: any) => (f.path || f) === "package.json" || (f.path || f).endsWith("package.json"));
          if (pkgFile?.content) pkgContent = pkgFile.content;
        }

        if (pkgContent) {
          const pkg = JSON.parse(pkgContent);
          const scripts = pkg.scripts || {};
          const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
          const cmds: string[] = [];

          const isNext = Boolean(
            deps.next ||
              files.some((f: string) => f.includes("next.config") || f.startsWith("app/") || f.includes("/app/") || f.startsWith("pages/")),
          );
          const isAngular = Boolean(deps["@angular/core"] || files.some((f: string) => f.includes("angular.json")));

          if (isNext) {
            cmds.push(scripts.build ? "npm run build" : "npx next build");
            if (scripts.typecheck || scripts["type-check"]) {
              cmds.push(scripts.typecheck ? "npm run typecheck" : "npm run type-check");
            }
            return cmds;
          }

          if (isAngular) {
            cmds.push(scripts.build ? "npm run build" : "npx ng build");
            return cmds;
          }

          if (scripts.build) {
            cmds.push("npm run build");
          }

          if (scripts.typecheck || scripts["type-check"]) {
            cmds.push(scripts.typecheck ? "npm run typecheck" : "npm run type-check");
          } else if (deps.typescript) {
            cmds.push("npx tsc --noEmit");
          }

          if (scripts.test && !scripts.test.includes("no test specified")) {
            cmds.push("npm test");
          }

          if (cmds.length > 0) return cmds;
        }
      } catch {}

      return ["npm test"].filter(() => false);
    }

    if (hasCargo) return ["cargo check"];
    if (hasGoMod) return ["go build ./..."];
    if (hasPy) return ["python -m py_compile"];

    return [];
  }

  /**
   * Deterministically formulates package-aware and dependent-package validation commands for monorepos.
   */
  private static detectMonorepoCommands(
    monorepo: MonorepoDescriptor,
    changedFiles: string[]
  ): string[] {
    const cmds: string[] = [];

    // 1. Resolve affected workspaces from changed files
    const affectedWorkspaces: WorkspacePackage[] = [];
    const seenWorkspaces = new Set<string>();

    for (const file of changedFiles) {
      const ws = MonorepoDetector.getWorkspaceForFile(monorepo, file);
      if (ws && !seenWorkspaces.has(ws.name)) {
        seenWorkspaces.add(ws.name);
        affectedWorkspaces.push(ws);
      }
    }

    // If no specific workspace affected (e.g. root files only, or baseline check), return root or turbo commands
    if (affectedWorkspaces.length === 0) {
      if (monorepo.hasTurbo) {
        return ["npx turbo run build"];
      }
      return [];
    }

    // 2. Cascade direct dependents (depth = 1)
    const packagesToValidate: WorkspacePackage[] = [...affectedWorkspaces];
    const validatedNames = new Set<string>(affectedWorkspaces.map((w) => w.name));
    let hasDependents = false;

    for (const ws of affectedWorkspaces) {
      const dependents = MonorepoDetector.getDependents(monorepo, ws.name);
      for (const depName of dependents) {
        if (!validatedNames.has(depName)) {
          validatedNames.add(depName);
          const depPkg = MonorepoDetector.getWorkspaceByName(monorepo, depName);
          if (depPkg) {
            packagesToValidate.push(depPkg);
            hasDependents = true;
          }
        }
      }
    }

    const primaryPkg = affectedWorkspaces[0];

    // 3. Turborepo
    if (monorepo.hasTurbo) {
      if (hasDependents) {
        cmds.push(`npx turbo run build --filter=${primaryPkg.name}...`);
        const hasTestScript = packagesToValidate.some((p) => p.scripts.test && !p.scripts.test.includes("no test specified"));
        if (hasTestScript) {
          cmds.push(`npx turbo run test --filter=${primaryPkg.name}...`);
        }
      } else {
        if (primaryPkg.scripts.build) {
          cmds.push(`npx turbo run build --filter=${primaryPkg.name}`);
        } else {
          cmds.push(`npx turbo run build --filter=${primaryPkg.name}`);
        }
        if (primaryPkg.scripts.test && !primaryPkg.scripts.test.includes("no test specified")) {
          cmds.push(`npx turbo run test --filter=${primaryPkg.name}`);
        }
      }
      return cmds;
    }

    // 4. pnpm
    if (monorepo.packageManager === "pnpm") {
      if (hasDependents) {
        cmds.push(`pnpm --filter ${primaryPkg.name}... build`);
        const hasTestScript = packagesToValidate.some((p) => p.scripts.test && !p.scripts.test.includes("no test specified"));
        if (hasTestScript) {
          cmds.push(`pnpm --filter ${primaryPkg.name}... test`);
        }
      } else {
        if (primaryPkg.scripts.build) {
          cmds.push(`pnpm --filter ${primaryPkg.name} build`);
        }
        if (primaryPkg.scripts.test && !primaryPkg.scripts.test.includes("no test specified")) {
          cmds.push(`pnpm --filter ${primaryPkg.name} test`);
        }
      }
      return cmds;
    }

    // 5. yarn
    if (monorepo.packageManager === "yarn") {
      for (const ws of packagesToValidate) {
        if (ws.scripts.build) {
          cmds.push(`yarn workspace ${ws.name} build`);
        }
        if (ws.scripts.test && !ws.scripts.test.includes("no test specified")) {
          cmds.push(`yarn workspace ${ws.name} test`);
        }
      }
      return cmds;
    }

    // 6. npm workspaces (default)
    for (const ws of packagesToValidate) {
      if (ws.scripts.build) {
        cmds.push(`npm run build --workspace=${ws.name}`);
      }
      if (ws.scripts.test && !ws.scripts.test.includes("no test specified")) {
        cmds.push(`npm test --workspace=${ws.name}`);
      }
    }

    return cmds;
  }
}

