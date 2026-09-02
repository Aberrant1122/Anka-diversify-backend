import path from "path";
import { performance } from "perf_hooks";
import { WasmASTParserEngine } from "./ast-parser.engine";

// ─── Result & Issue Schemas ───────────────────────────────────────────────────

export type ValidationCheckType =
  | "broken_import"
  | "missing_export"
  | "orphan_component"
  | "unused_api"
  | "dead_route"
  | "missing_navigation"
  | "missing_stylesheet_import"
  | "invalid_prisma"
  | "circular_dependency"
  | "missing_provider";

export interface StaticValidationIssue {
  checkId: ValidationCheckType;
  severity: "FAIL" | "WARNING";
  file: string;
  line: number;
  reason: string;
  suggestedFix: string;
}

export interface StaticValidationResult {
  status: "PASS" | "WARNING" | "FAIL";
  passed: boolean;
  issues: StaticValidationIssue[];
  metrics: {
    totalFilesAnalyzed: number;
    totalImportsAnalyzed: number;
    totalRoutesAnalyzed: number;
    analysisTimeMs: number;
  };
}

export interface SnapshotFile {
  path: string;
  content?: string;
}

// ─── Helper AST & Parsing Utilities ──────────────────────────────────────────

interface FileAST {
  path: string;
  normalizedPath: string;
  content: string;
  lines: string[];
  imports: Array<{
    line: number;
    rawPath: string;
    resolvedPath: string | null;
    isLocal: boolean;
    defaultImport?: string;
    namedImports: string[];
  }>;
  exports: Array<{
    line: number;
    name: string;
    kind: "default" | "named";
    type: "function" | "class" | "interface" | "type" | "const" | "component";
  }>;
  components: Array<{
    name: string;
    line: number;
    renderedComponents: string[];
    usedHooks: string[];
  }>;
}

export class StaticValidationEngine {
  /**
   * Perform deterministic static analysis on codebase snapshot and modified files.
   */
  static validate(
    snapshotFiles: SnapshotFile[],
    modifiedFiles?: Array<{ path: string; content?: string; action?: string; isDeleted?: boolean }>,
  ): StaticValidationResult {
    const startTime = performance.now();
    const issues: StaticValidationIssue[] = [];

    // Merge snapshot and modified files
    const fileMap = new Map<string, string>();
    for (const f of snapshotFiles) {
      if (f.path && typeof f.content === "string") {
        fileMap.set(f.path.replace(/\\/g, "/"), f.content);
      }
    }
    if (modifiedFiles) {
      for (const mf of modifiedFiles) {
        if (!mf || !mf.path) continue;
        const normPath = mf.path.replace(/\\/g, "/");
        const isDelete = mf.action === "delete" || mf.isDeleted === true;
        if (isDelete) {
          fileMap.delete(normPath);
        } else {
          if (typeof mf.content === "string") {
            fileMap.set(normPath, mf.content);
          } else {
            issues.push({
              checkId: "broken_import",
              severity: "FAIL",
              file: normPath,
              line: 1,
              reason: `File change for '${normPath}' has action '${mf.action || "modify"}' but missing required string content`,
              suggestedFix: `Provide valid string content for file '${normPath}' or mark action as 'delete'`,
            });
          }
        }
      }
    }

    // 1. Build File ASTs
    const asts: FileAST[] = [];
    let totalImportsAnalyzed = 0;

    for (const [p, content] of fileMap.entries()) {
      const ast = StaticValidationEngine.parseFile(p, content, fileMap);
      asts.push(ast);
      totalImportsAnalyzed += ast.imports.length;
    }

    // 2. Check: Broken Imports & Missing Exports
    StaticValidationEngine.checkImportsAndExports(asts, fileMap, issues);

    // 3. Check: Circular Dependencies
    StaticValidationEngine.checkCircularDependencies(asts, issues);

    // 4. Check: Orphan Components & Missing Providers
    StaticValidationEngine.checkComponentsAndProviders(asts, issues);

    // 5. Check: Dead Routes & Missing Navigation
    StaticValidationEngine.checkRoutesAndNavigation(asts, fileMap, issues);

    // 6. Check: Unused APIs
    StaticValidationEngine.checkApis(asts, issues);

    // 7. Check: Invalid Prisma Usage
    StaticValidationEngine.checkPrismaUsage(asts, fileMap, issues);

    // 8. Check: Created/Modified Stylesheet Integration (Task-Delta Aware)
    StaticValidationEngine.checkStylesheetIntegration(modifiedFiles, asts, fileMap, issues);

    const endTime = performance.now();
    const hasFailures = issues.some((i) => i.severity === "FAIL");
    const hasWarnings = issues.some((i) => i.severity === "WARNING");

    const status: StaticValidationResult["status"] = hasFailures
      ? "FAIL"
      : hasWarnings
      ? "WARNING"
      : "PASS";

    return {
      status,
      passed: !hasFailures,
      issues,
      metrics: {
        totalFilesAnalyzed: asts.length,
        totalImportsAnalyzed,
        totalRoutesAnalyzed: asts.filter((a) => a.path.includes("app/") || a.path.includes("pages/")).length,
        analysisTimeMs: endTime - startTime,
      },
    };
  }

  // ── File AST Parser ─────────────────────────────────────────────────────────
  public static parseFile(p: string, content: string, fileMap: Map<string, string>): FileAST {
    const lines = content.split("\n");
    const imports: FileAST["imports"] = [];
    const exports: FileAST["exports"] = [];
    const components: FileAST["components"] = [];

    // Use WASM Tree-Sitter AST Engine for symbol extraction
    const tsSymbols = WasmASTParserEngine.extractSymbols(p, content);

    if (tsSymbols.imports.length > 0 || tsSymbols.exports.length > 0) {
      for (const imp of tsSymbols.imports) {
        let resolvedPath: string | null = null;
        if (imp.isLocal) {
          resolvedPath = StaticValidationEngine.resolveImportPath(p, imp.rawPath, fileMap);
        }
        imports.push({
          line: imp.line,
          rawPath: imp.rawPath,
          resolvedPath,
          isLocal: imp.isLocal,
          defaultImport: imp.defaultImport,
          namedImports: imp.namedImports,
        });
      }

      for (const exp of tsSymbols.exports) {
        const mappedType: FileAST["exports"][0]["type"] =
          exp.type === "variable"
            ? "const"
            : exp.type === "unknown"
            ? "const"
            : (exp.type as FileAST["exports"][0]["type"]) || "const";
        exports.push({
          line: exp.line,
          name: exp.name,
          kind: exp.isDefault ? "default" : "named",
          type: mappedType,
        });
      }
    } else {
      // Regex Fallback if AST Engine hasn't initialized or returned empty on custom file types
      const importRegex = /import\s+(?:type\s+)?(?:([A-Za-z0-9_]+)|(?:\{([^}]+)\}))?\s*(?:,\s*\{([^}]+)\})?\s*from\s*["']([^"']+)["']/g;
      let match: RegExpExecArray | null;

      while ((match = importRegex.exec(content)) !== null) {
        const line = content.slice(0, match.index).split("\n").length;
        const defaultImport = match[1]?.trim();
        const namedRaw = (match[2] || match[3] || "").split(",").map((s) => s.trim().split(" as ")[0]).filter(Boolean);
        const rawPath = match[4];
        const isLocal = rawPath.startsWith(".") || rawPath.startsWith("@/");

        let resolvedPath: string | null = null;
        if (isLocal) {
          resolvedPath = StaticValidationEngine.resolveImportPath(p, rawPath, fileMap);
        }

        imports.push({
          line,
          rawPath,
          resolvedPath,
          isLocal,
          defaultImport,
          namedImports: namedRaw,
        });
      }

      const exportRegex = /export\s+(default\s+)?(interface|class|function|type|const|let|var)\s+([A-Za-z0-9_]+)/g;
      while ((match = exportRegex.exec(content)) !== null) {
        const line = content.slice(0, match.index).split("\n").length;
        const isDefault = Boolean(match[1]);
        const rawType = match[2];
        const type: FileAST["exports"][0]["type"] =
          rawType === "let" || rawType === "var"
            ? "const"
            : (rawType as FileAST["exports"][0]["type"]);
        const name = match[3];

        exports.push({
          line,
          name,
          kind: isDefault ? "default" : "named",
          type,
        });
      }

      const defaultExportRegex = /export\s+default\s+([A-Za-z0-9_]+);?/g;
      while ((match = defaultExportRegex.exec(content)) !== null) {
        if (!["interface", "class", "function", "type", "const", "let", "var"].includes(match[1])) {
          const line = content.slice(0, match.index).split("\n").length;
          exports.push({
            line,
            name: "default",
            kind: "default",
            type: "const",
          });
        }
      }

      const clauseExportRegex = /export\s*\{([^}]+)\}/g;
      while ((match = clauseExportRegex.exec(content)) !== null) {
        const line = content.slice(0, match.index).split("\n").length;
        const clause = match[1];
        for (const item of clause.split(",")) {
          const trimmed = item.trim();
          if (!trimmed) continue;
          if (trimmed.includes(" as ")) {
            const parts = trimmed.split(/\s+as\s+/);
            const alias = parts[1]?.trim();
            if (alias === "default") {
              exports.push({ line, name: "default", kind: "default", type: "const" });
            } else if (alias) {
              exports.push({ line, name: alias, kind: "named", type: "const" });
            }
          } else {
            if (trimmed === "default") {
              exports.push({ line, name: "default", kind: "default", type: "const" });
            } else {
              exports.push({ line, name: trimmed, kind: "named", type: "const" });
            }
          }
        }
      }
    }

    // Parse Components & Hooks
    if (p.endsWith(".tsx") || p.endsWith(".jsx") || p.includes("components/")) {
      for (const exp of exports) {
        if (/^[A-Z][A-Za-z0-9]*$/.test(exp.name)) {
          const renderedComponents: string[] = [];
          const usedHooks: string[] = [];

          const jsxMatches = content.matchAll(/<([A-Z][A-Za-z0-9]*)/g);
          for (const jm of jsxMatches) renderedComponents.push(jm[1]);

          const hookMatches = content.matchAll(/\b(use[A-Z][A-Za-z0-9]*)\b/g);
          for (const hm of hookMatches) usedHooks.push(hm[1]);

          components.push({
            name: exp.name,
            line: exp.line,
            renderedComponents: [...new Set(renderedComponents)],
            usedHooks: [...new Set(usedHooks)],
          });
        }
      }
    }

    return {
      path: p,
      normalizedPath: p.replace(/\\/g, "/"),
      content,
      lines,
      imports,
      exports,
      components,
    };
  }

  // ── Import Path Resolver ─────────────────────────────────────────────────────
  private static resolveImportPath(
    currentFile: string,
    rawImport: string,
    fileMap: Map<string, string>,
  ): string | null {
    const extensions = [
      "",
      ".ts",
      ".tsx",
      ".js",
      ".jsx",
      "/index.ts",
      "/index.tsx",
      "/index.js",
      ".css",
      ".scss",
      ".sass",
      ".less",
      ".module.css",
      ".module.scss",
    ];

    const candidates: string[] = [];
    if (rawImport.startsWith("@/")) {
      candidates.push(rawImport.replace("@/", "src/"));
      candidates.push(rawImport.replace("@/", "app/"));
      candidates.push(rawImport.replace("@/", ""));
    } else if (rawImport.startsWith("~/")) {
      candidates.push(rawImport.replace("~/", "src/"));
      candidates.push(rawImport.replace("~/", ""));
    } else {
      const dir = path.dirname(currentFile);
      candidates.push(path.normalize(path.join(dir, rawImport)).replace(/\\/g, "/"));
    }

    for (const target of candidates) {
      for (const ext of extensions) {
        const candidate = target + ext;
        if (fileMap.has(candidate)) return candidate;
      }
    }

    return null;
  }

  // ── Check 1 & 2: Broken Imports & Missing Exports ────────────────────────────
  private static checkImportsAndExports(
    asts: FileAST[],
    fileMap: Map<string, string>,
    issues: StaticValidationIssue[],
  ) {
    for (const ast of asts) {
      for (const imp of ast.imports) {
        if (imp.isLocal) {
          if (!imp.resolvedPath) {
            issues.push({
              checkId: "broken_import",
              severity: "FAIL",
              file: ast.path,
              line: imp.line,
              reason: `Broken import: cannot resolve local module "${imp.rawPath}" in workspace`,
              suggestedFix: `Create file "${imp.rawPath}" or update import path in "${ast.path}"`,
            });
          } else {
            const targetAST = asts.find((a) => a.path === imp.resolvedPath);
            if (targetAST) {
              for (const named of imp.namedImports) {
                const hasExport = targetAST.exports.some((e) => e.name === named);
                if (!hasExport) {
                  issues.push({
                    checkId: "missing_export",
                    severity: "FAIL",
                    file: ast.path,
                    line: imp.line,
                    reason: `Missing export: module "${imp.rawPath}" does not export named symbol "${named}"`,
                    suggestedFix: `Add "export const ${named} = ..." to "${imp.resolvedPath}" or fix import name`,
                  });
                }
              }

              if (imp.defaultImport) {
                const hasDefault = targetAST.exports.some((e) => e.kind === "default");
                if (!hasDefault && targetAST.exports.length > 0) {
                  issues.push({
                    checkId: "missing_export",
                    severity: "WARNING",
                    file: ast.path,
                    line: imp.line,
                    reason: `Module "${imp.rawPath}" has no default export (exports named: [${targetAST.exports.map((e) => e.name).join(", ")}])`,
                    suggestedFix: `Change to named import: import { ${targetAST.exports[0]?.name || "Component"} } from "${imp.rawPath}"`,
                  });
                }
              }
            }
          }
        }
      }
    }
  }

  // ── Check 3: Circular Dependencies (DFS Cycle Detection) ───────────────────
  private static checkCircularDependencies(asts: FileAST[], issues: StaticValidationIssue[]) {
    const adjMap = new Map<string, string[]>();
    for (const ast of asts) {
      const deps = ast.imports.map((i) => i.resolvedPath).filter(Boolean) as string[];
      adjMap.set(ast.path, deps);
    }

    const visited = new Set<string>();
    const recStack = new Set<string>();

    const dfs = (node: string, pathStack: string[]) => {
      visited.add(node);
      recStack.add(node);
      pathStack.push(node);

      const neighbors = adjMap.get(node) || [];
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          dfs(neighbor, [...pathStack]);
        } else if (recStack.has(neighbor)) {
          const cycleStartIdx = pathStack.indexOf(neighbor);
          const cyclePath = pathStack.slice(cycleStartIdx).concat(neighbor);

          issues.push({
            checkId: "circular_dependency",
            severity: "WARNING",
            file: node,
            line: 1,
            reason: `Circular dependency detected: ${cyclePath.map((p) => path.basename(p)).join(" -> ")}`,
            suggestedFix: `Refactor shared interfaces/types into a separate utility or schema file to break cycle`,
          });
        }
      }

      recStack.delete(node);
    }

    for (const ast of asts) {
      if (!visited.has(ast.path)) {
        dfs(ast.path, []);
      }
    }
  }

  // ── Check 4: Orphan Components & Missing Providers ──────────────────────────
  private static checkComponentsAndProviders(asts: FileAST[], issues: StaticValidationIssue[]) {
    const allRendered = new Set<string>();
    const allImported = new Set<string>();

    for (const ast of asts) {
      for (const comp of ast.components) {
        for (const r of comp.renderedComponents) allRendered.add(r);
      }
      for (const imp of ast.imports) {
        if (imp.defaultImport) allImported.add(imp.defaultImport);
        for (const n of imp.namedImports) allImported.add(n);
      }
    }

    for (const ast of asts) {
      const isUIFile = ast.path.includes("components/") || ast.path.endsWith(".tsx");
      const isRouteFile = ast.path.includes("app/") || ast.path.includes("pages/");

      if (isUIFile && !isRouteFile) {
        for (const comp of ast.components) {
          const isUsed = allRendered.has(comp.name) || allImported.has(comp.name);
          if (!isUsed) {
            issues.push({
              checkId: "orphan_component",
              severity: "WARNING",
              file: ast.path,
              line: comp.line,
              reason: `Orphan component: "${comp.name}" is defined but never imported or rendered anywhere in workspace`,
              suggestedFix: `Import and render "${comp.name}" in a parent component or route page`,
            });
          }

          // Check Context Provider requirement (e.g., useRouter without Next.js / AuthContext without AuthProvider)
          if (comp.usedHooks.includes("useAuth") && !ast.content.includes("AuthProvider")) {
            const hasProviderInApp = asts.some((a) => a.content.includes("AuthProvider"));
            if (!hasProviderInApp) {
              issues.push({
                checkId: "missing_provider",
                severity: "FAIL",
                file: ast.path,
                line: comp.line,
                reason: `Missing provider: component "${comp.name}" calls useAuth() but AuthProvider is missing from component tree`,
                suggestedFix: `Wrap application root in <AuthProvider> in app/layout.tsx or _app.tsx`,
              });
            }
          }
        }
      }
    }
  }

  // ── Check 5: Dead Routes & Missing Navigation ────────────────────────────────
  private static checkRoutesAndNavigation(
    asts: FileAST[],
    fileMap: Map<string, string>,
    issues: StaticValidationIssue[],
  ) {
    const routeFiles = asts.filter(
      (a) => a.path.includes("app/") && (a.path.endsWith("page.tsx") || a.path.endsWith("page.jsx")),
    );

    const allLinkHrefs = new Set<string>();

    for (const ast of asts) {
      const hrefMatches = ast.content.matchAll(/href=["']([^"']+)["']/g);
      for (const hm of hrefMatches) allLinkHrefs.add(hm[1]);

      const pushMatches = ast.content.matchAll(/router\.push\(["']([^"']+)["']\)/g);
      for (const pm of pushMatches) allLinkHrefs.add(pm[1]);
    }

    for (const rAst of routeFiles) {
      const relativeRoute = "/" + rAst.path.split("app/")[1].replace(/\/page\.(tsx|jsx)$/, "");
      if (relativeRoute === "/page.tsx" || relativeRoute === "/") continue;

      const isLinked = allLinkHrefs.has(relativeRoute) || [...allLinkHrefs].some((h) => h.includes(relativeRoute));
      if (!isLinked) {
        const navFile = asts.find((a) => a.path.includes("Navigation") || a.path.includes("Header") || a.path.includes("Sidebar"));
        issues.push({
          checkId: "missing_navigation",
          severity: "WARNING",
          file: rAst.path,
          line: 1,
          reason: `Missing navigation: created route page "${relativeRoute}" is not linked in Navigation/Header/Sidebar components`,
          suggestedFix: `Add <Link href="${relativeRoute}"> to your navigation bar or sidebar component`,
        });
      }
    }
  }

  // ── Check 6: Unused APIs ─────────────────────────────────────────────────────
  private static checkApis(asts: FileAST[], issues: StaticValidationIssue[]) {
    const apiEndpoints: Array<{ file: string; line: number; endpoint: string }> = [];

    for (const ast of asts) {
      const expressMatches = ast.content.matchAll(/(?:router|app)\.(get|post|put|delete)\s*\(\s*['"`]([^'"`]+)['"`]/g);
      for (const m of expressMatches) {
        const line = ast.content.slice(0, m.index).split("\n").length;
        apiEndpoints.push({ file: ast.path, line, endpoint: m[2] });
      }
    }

    const allClientCalls = new Set<string>();
    for (const ast of asts) {
      const fetchMatches = ast.content.matchAll(/(?:fetch|axios|request)\s*\(\s*['"`]([^'"`]+)['"`]/g);
      for (const fm of fetchMatches) allClientCalls.add(fm[1]);
    }

    for (const api of apiEndpoints) {
      const isCalled = [...allClientCalls].some((call) => call.includes(api.endpoint));
      if (!isCalled) {
        issues.push({
          checkId: "unused_api",
          severity: "WARNING",
          file: api.file,
          line: api.line,
          reason: `Unused API: backend route handler "${api.endpoint}" is declared but never invoked by any client fetch call`,
          suggestedFix: `Connect client API service to call "${api.endpoint}" or verify endpoint path`,
        });
      }
    }
  }

  // ── Check 7: Invalid Prisma Usage ───────────────────────────────────────────
  private static checkPrismaUsage(
    asts: FileAST[],
    fileMap: Map<string, string>,
    issues: StaticValidationIssue[],
  ) {
    const prismaModels = new Set<string>();

    for (const [p, content] of fileMap.entries()) {
      if (p.endsWith(".prisma")) {
        const modelMatches = content.matchAll(/model\s+([A-Za-z0-9_]+)\s*\{/g);
        for (const mm of modelMatches) prismaModels.add(mm[1].toLowerCase());
      }
    }

    if (prismaModels.size === 0) return;

    for (const ast of asts) {
      const prismaCalls = ast.content.matchAll(/(?:prisma|p)\.([a-zA-Z0-9_]+)\.(findUnique|findMany|create|update|delete)/g);
      for (const pc of prismaCalls) {
        const modelProp = pc[1];
        const line = ast.content.slice(0, pc.index).split("\n").length;
        const normProp = modelProp.toLowerCase();

        if (!prismaModels.has(normProp)) {
          issues.push({
            checkId: "invalid_prisma",
            severity: "FAIL",
            file: ast.path,
            line,
            reason: `Invalid Prisma usage: "prisma.${modelProp}" does not exist in schema.prisma models`,
            suggestedFix: `Add "model ${modelProp.charAt(0).toUpperCase() + modelProp.slice(1)} { ... }" to schema.prisma or fix call`,
          });
        }
      }
    }
  }

  // ── Check 8: Created/Modified Stylesheet Integration (Task-Delta Aware) ────
  private static checkStylesheetIntegration(
    modifiedFiles: Array<{ path: string; content?: string; action?: string; isDeleted?: boolean }> | undefined,
    asts: FileAST[],
    fileMap: Map<string, string>,
    issues: StaticValidationIssue[],
  ): void {
    if (!modifiedFiles || !modifiedFiles.length) return;

    // Filter strictly to created/modified stylesheets in the current task delta
    const createdStylesheets = modifiedFiles.filter((mf) => {
      if (!mf || !mf.path) return false;
      const isDelete = mf.action === "delete" || mf.isDeleted === true;
      if (isDelete) return false;
      const norm = mf.path.replace(/\\/g, "/").toLowerCase();
      return (
        norm.endsWith(".css") ||
        norm.endsWith(".scss") ||
        norm.endsWith(".sass") ||
        norm.endsWith(".less")
      );
    });

    if (!createdStylesheets.length) return;

    // Collect all resolved import paths and raw import strings across all ASTs
    const allImportedPaths = new Set<string>();
    const allRawImports = new Set<string>();

    for (const ast of asts) {
      for (const imp of ast.imports) {
        if (imp.resolvedPath) {
          allImportedPaths.add(imp.resolvedPath.replace(/\\/g, "/").toLowerCase());
        }
        if (imp.rawPath) {
          allRawImports.add(imp.rawPath.replace(/\\/g, "/").toLowerCase());
        }
      }

      // Regex scan for side-effect imports or CSS imports in TS/TSX/JS/CSS
      const content = ast.content;
      const cssImports = content.matchAll(/(?:import\s+(?:[^"';]+\s+from\s+)?["']([^"']+\.(?:css|scss|sass|less))["']|@import\s+["']([^"']+)["'])/gi);
      for (const ci of cssImports) {
        const raw = (ci[1] || ci[2] || "").replace(/\\/g, "/").toLowerCase();
        if (raw) allRawImports.add(raw);
      }
    }

    for (const sf of createdStylesheets) {
      const normPath = sf.path.replace(/\\/g, "/").toLowerCase();
      const filename = path.basename(normPath);

      const isDirectlyResolved = allImportedPaths.has(normPath);
      const isRawMatched = Array.from(allRawImports).some((raw) => {
        return (
          normPath.endsWith(raw.replace(/^\.\//, "")) ||
          raw.endsWith(normPath) ||
          raw.endsWith(filename) ||
          raw === filename ||
          raw === normPath
        );
      });

      if (!isDirectlyResolved && !isRawMatched) {
        issues.push({
          checkId: "missing_stylesheet_import",
          severity: "FAIL",
          file: sf.path,
          line: 1,
          reason: `Created stylesheet '${sf.path}' is not imported by any component, layout, or page in the active render tree`,
          suggestedFix: `Import '${sf.path}' in the component that uses it (e.g. import './${filename}') or in 'app/layout.tsx'`,
        });
      }
    }
  }
}
