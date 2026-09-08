import fs from "fs";
import path from "path";
import { DiagnosticError } from "../../services/surgical-repair.engine";
import { ExecutionContract, FileManifest } from "../../types";

export interface ComponentContractResult {
  componentPath: string;
  componentName?: string;
  contractText: string;
}

export class ComponentContractGrounder {
  private static readonly EXTENSIONS = [
    ".tsx",
    ".ts",
    ".jsx",
    ".js",
    "/index.tsx",
    "/index.ts",
    "/index.jsx",
    "/index.js",
  ];

  /**
   * Resolves a local relative import specifier to a repository file path.
   */
  public static resolveImportedComponentPath(
    containingFilePath: string,
    importSpecifier: string,
    availableFiles: string[] | Set<string>,
    localPath?: string | null
  ): string | null {
    if (!importSpecifier || typeof importSpecifier !== "string") return null;
    const cleanSpecifier = importSpecifier.trim().replace(/['"]/g, "");
    if (!cleanSpecifier.startsWith("./") && !cleanSpecifier.startsWith("../")) {
      return null;
    }

    const normContaining = containingFilePath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\//, "");
    const containingDir = path.posix.dirname(normContaining);
    const resolvedBase = path.posix.normalize(path.posix.join(containingDir, cleanSpecifier));

    const fileSet = availableFiles instanceof Set
      ? availableFiles
      : new Set(availableFiles.map((f) => f.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\//, "")));

    // 1. Direct match if specifier already has an extension
    if (fileSet.has(resolvedBase)) {
      return resolvedBase;
    }

    // 2. Candidate extension checks
    for (const ext of this.EXTENSIONS) {
      const candidate = `${resolvedBase}${ext}`;
      if (fileSet.has(candidate)) {
        return candidate;
      }
    }

    // 3. Filesystem check on localPath if available
    if (localPath) {
      for (const ext of ["", ...this.EXTENSIONS]) {
        const candidate = `${resolvedBase}${ext}`;
        const abs = path.resolve(localPath, candidate);
        try {
          if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
            return candidate.replace(/\\/g, "/");
          }
        } catch {}
      }
    }

    return null;
  }

  /**
   * Resolves authoritative existing local component contracts for initial code generation.
   * Scans authorized modify sources, manifest dependencies, and contract UI components.
   */
  public static resolveComponentContractsForGeneration(options: {
    authorizedModifySources?: Record<string, { path: string; content: string; sha256?: string }>;
    approvedManifest?: FileManifest | null;
    contract?: ExecutionContract;
    effectiveResolutionSourceMap?: Record<string, string>;
    effectiveLocalPath?: string | null;
    userMessage?: string;
  }): ComponentContractResult[] {
    const {
      authorizedModifySources = {},
      approvedManifest,
      contract,
      effectiveResolutionSourceMap = {},
      effectiveLocalPath,
      userMessage = "",
    } = options;

    const results: ComponentContractResult[] = [];
    const seenPaths = new Set<string>();

    const authorizedPaths = new Set(
      Object.keys(authorizedModifySources).map((p) => p.replace(/\\/g, "/").replace(/^\.\//, ""))
    );

    const availableFiles = new Set<string>([
      ...Object.keys(effectiveResolutionSourceMap).map((p) => p.replace(/\\/g, "/").replace(/^\.\//, "")),
      ...Object.keys(authorizedModifySources).map((p) => p.replace(/\\/g, "/").replace(/^\.\//, "")),
    ]);

    const tryAddComponent = (compPath: string) => {
      const norm = compPath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\//, "");
      if (seenPaths.has(norm) || authorizedPaths.has(norm)) return;

      let content: string | null = null;
      if (effectiveResolutionSourceMap[norm]) {
        content = effectiveResolutionSourceMap[norm];
      } else if (effectiveLocalPath) {
        const abs = path.resolve(effectiveLocalPath, norm);
        try {
          if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
            content = fs.readFileSync(abs, "utf8");
          }
        } catch {}
      }

      if (content && typeof content === "string") {
        seenPaths.add(norm);
        results.push({
          componentPath: norm,
          contractText: `═══════════════════════════════════════════════════\nAUTHORITATIVE EXISTING LOCAL COMPONENT CONTRACT (READ-ONLY)\nFILE: ${norm}\n═══════════════════════════════════════════════════\n${content.trim()}`,
        });
      }
    };

    // 1. Scan relative imports from authorized modify sources
    const importRegex = /import\s+(?:\{[^}]*\}|[A-Za-z0-9_$]+|\*\s+as\s+[A-Za-z0-9_$]+)\s+from\s+['"]([^'"]+)['"]/g;
    for (const [filePath, src] of Object.entries(authorizedModifySources)) {
      if (!src || !src.content) continue;
      let match: RegExpExecArray | null;
      while ((match = importRegex.exec(src.content)) !== null) {
        const specifier = match[1];
        const resolved = this.resolveImportedComponentPath(filePath, specifier, availableFiles, effectiveLocalPath);
        if (resolved) {
          tryAddComponent(resolved);
        }
      }
    }

    // 2. Scan relative dependencies in approved manifest
    if (approvedManifest && Array.isArray(approvedManifest.files)) {
      for (const f of approvedManifest.files) {
        if (!f || !f.path || !Array.isArray(f.dependencies)) continue;
        for (const dep of f.dependencies) {
          if (typeof dep === "string" && (dep.startsWith("./") || dep.startsWith("../"))) {
            const resolved = this.resolveImportedComponentPath(f.path, dep, availableFiles, effectiveLocalPath);
            if (resolved) {
              tryAddComponent(resolved);
            }
          }
        }
      }
    }

    // 3. Scan existingUIComponents from contract referenced in message or manifest
    const existingComps = (contract as any)?.existingUIComponents;
    if (Array.isArray(existingComps)) {
      for (const comp of existingComps) {
        if (!comp || !comp.path) continue;
        const compName = comp.name || path.basename(comp.path, path.extname(comp.path));
        const nameRegex = new RegExp(`\\b${compName}\\b`, "i");
        const isMentionedInMessage = nameRegex.test(userMessage);
        const isMentionedInManifest = approvedManifest?.files?.some(
          (f) => nameRegex.test(f.description || "") || f.dependencies?.some((d) => nameRegex.test(d))
        );

        if (isMentionedInMessage || isMentionedInManifest) {
          tryAddComponent(comp.path);
        }
      }
    }

    return results;
  }

  /**
   * Resolves component contract for compiler diagnostics (e.g. TS2322 on component props).
   */
  public static resolveComponentContractsForDiagnostics(
    diagnostics: DiagnosticError[],
    currentFiles: Record<string, string>,
    localPath?: string | null,
    approvedManifest?: FileManifest | null
  ): ComponentContractResult[] {
    const results: ComponentContractResult[] = [];
    const seenPaths = new Set<string>();

    const availableFiles = new Set<string>([
      ...Object.keys(currentFiles).map((p) => p.replace(/\\/g, "/").replace(/^\.\//, "")),
    ]);

    for (const diag of diagnostics) {
      if (!diag.file) continue;

      const normDiagFile = diag.file.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\//, "");
      const fileContent =
        currentFiles[diag.file] ||
        currentFiles[normDiagFile] ||
        Object.entries(currentFiles).find(
          ([k]) =>
            k.replace(/\\/g, "/").endsWith(normDiagFile) ||
            normDiagFile.endsWith(k.replace(/\\/g, "/"))
        )?.[1];

      if (!fileContent) continue;

      const isPropMismatch =
        diag.code === "TS2322" ||
        diag.code === "TS2339" ||
        diag.code === "TS2741" ||
        /does not exist on type.*Props/i.test(diag.message || "") ||
        /not assignable to type.*Props/i.test(diag.message || "") ||
        /IntrinsicAttributes/i.test(diag.message || "");

      if (!isPropMismatch) continue;

      // Extract candidate component names
      const candidateNames = new Set<string>();

      // 1. From message: e.g. "BadgeProps" -> "Badge"
      const propsMatch = (diag.message || "").match(/\b([A-Za-z0-9_$]+)Props\b/);
      if (propsMatch && propsMatch[1]) {
        candidateNames.add(propsMatch[1]);
      }

      // 2. From failing file source line: e.g. `<Badge ...`
      if (diag.line) {
        const lines = fileContent.split("\n");
        const lineIdx = diag.line - 1;
        const surrounding = lines.slice(Math.max(0, lineIdx - 1), Math.min(lines.length, lineIdx + 2)).join(" ");
        const tagMatches = surrounding.matchAll(/<([A-Z][A-Za-z0-9_$]*)\b/g);
        for (const tm of tagMatches) {
          if (tm[1]) candidateNames.add(tm[1]);
        }
      }

      // Find local imports matching candidate component names
      const importRegex = /import\s+(?:\{([^}]*)\}|([A-Za-z0-9_$]+))\s+from\s+['"]([^'"]+)['"]/g;
      let match: RegExpExecArray | null;
      while ((match = importRegex.exec(fileContent)) !== null) {
        const namedImports = match[1] ? match[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0].trim()) : [];
        const defaultImport = match[2]?.trim();
        const specifier = match[3];

        const allImported = [...namedImports, defaultImport].filter(Boolean);
        const matchesCandidate = allImported.some((name) => candidateNames.has(name));
        const specifierMatchesCandidate = [...candidateNames].some((name) =>
          specifier.endsWith(`/${name}`) || specifier === `./${name}`
        );

        if (matchesCandidate || specifierMatchesCandidate) {
          const resolved = this.resolveImportedComponentPath(normDiagFile, specifier, availableFiles, localPath);
          if (resolved && !seenPaths.has(resolved)) {
            let compContent: string | null = currentFiles[resolved] || null;
            if (!compContent && localPath) {
              const abs = path.resolve(localPath, resolved);
              try {
                if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
                  compContent = fs.readFileSync(abs, "utf8");
                }
              } catch {}
            }

            if (compContent) {
              seenPaths.add(resolved);
              const matchedName = allImported.find((n) => candidateNames.has(n)) || [...candidateNames][0];
              results.push({
                componentPath: resolved,
                componentName: matchedName,
                contractText: compContent.trim(),
              });
            }
          }
        }
      }
    }

    return results;
  }
}
