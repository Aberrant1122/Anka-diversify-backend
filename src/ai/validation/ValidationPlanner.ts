import fs from "fs";
import path from "path";
import { ExecutionContract } from "../shared/types";

export class ValidationPlanner {
  static detectValidationCommands(
    workspacePath?: string | null,
    snapshot?: any,
    contract?: ExecutionContract,
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

          if (cmds.length > 0) return cmds;
        }
      } catch {}

      return ["npm run build", "npx tsc --noEmit"];
    }

    if (hasCargo) return ["cargo check"];
    if (hasGoMod) return ["go build ./..."];
    if (hasPy) return ["python -m py_compile"];

    return ["npm run build", "npx tsc --noEmit"];
  }
}
