import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { ErrorDiagnosticsParser, DiagnosticError } from "./surgical-repair.engine";
import { ErrorClassifier } from "../ai/validation/ErrorClassifier";
import { BaselineDiagnostic, ExecutionContract } from "../types";
import { AgentFileChange, ExtendedKnowledgeGraph } from "../ai/shared/types";
import { ImportValidator } from "../ai/validation/ImportValidator";
import { matchesModuleSpecifier } from "../ai/contracts/TargetScopeExpander";
import { normalizeRepoPath } from "../ai/repository/SemanticContextResolver";
import { StaticValidationEngine } from "./static-validator.engine";

export const GLOBAL_CONFIG_FILE_PATTERNS = [
  /^package\.json$/i,
  /^package-lock\.json$/i,
  /^pnpm-lock\.yaml$/i,
  /^yarn\.lock$/i,
  /^tsconfig(?:.*)?\.json$/i,
  /^jsconfig(?:.*)?\.json$/i,
  /^(?:next|vite|webpack|rollup|babel|postcss|tailwind)\.config\.[a-zA-Z0-9]+$/i,
];

/**
 * Deterministically proves whether a TS2614 / TS2305 "has no exported member" mismatch
 * existed in the immutable baseline before the agent touched any file.
 */
function isMissingNamedExportPreExisting(
  importerFilePath: string,
  preTaskImporterContent: string,
  symbol: string,
  moduleSpecifier: string | undefined,
  preTaskSourceGetter?: (path: string) => string | null | undefined,
): boolean {
  if (!symbol || !preTaskImporterContent) return false;

  const diagNorm = normalizeRepoPath(importerFilePath);
  const importerDir = path.dirname(diagNorm);

  // 1. Parse imports from pre-task importer
  const importerAST = StaticValidationEngine.parseFile(diagNorm, preTaskImporterContent, new Map());

  // Find the import corresponding to moduleSpecifier or matching target
  const matchingImports = importerAST.imports.filter((imp) => {
    if (!imp.isLocal) return false;
    if (moduleSpecifier) {
      const cleanMod = moduleSpecifier.replace(/^\.\//, "").replace(/\\/g, "/");
      const cleanImp = imp.rawPath.replace(/^\.\//, "").replace(/\\/g, "/");
      if (cleanImp === cleanMod || cleanImp.endsWith("/" + cleanMod) || cleanMod.endsWith("/" + cleanImp)) {
        return true;
      }
      return false;
    }
    return imp.namedImports.includes(symbol);
  });

  // Verify baseline importer actually requested `symbol` as a named import
  const hasNamedImportInBaseline = matchingImports.some((imp) => imp.namedImports.includes(symbol));
  if (!hasNamedImportInBaseline) {
    return false;
  }

  // 2. Resolve candidate target module paths
  const resolvedTargetPaths: string[] = [];
  for (const imp of matchingImports) {
    if (imp.rawPath) {
      let targetBase = "";
      if (imp.rawPath.startsWith("@/")) {
        targetBase = imp.rawPath.replace("@/", "src/");
      } else {
        targetBase = path.normalize(path.join(importerDir, imp.rawPath)).replace(/\\/g, "/");
      }
      const exts = ["", ".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx", "/index.js", "/index.jsx"];
      for (const ext of exts) {
        resolvedTargetPaths.push(normalizeRepoPath(targetBase + ext));
      }
    }
  }

  // 3. Obtain immutable pre-task content of target module
  let targetPreTaskContent: string | null = null;
  let targetResolvedPath: string | null = null;

  if (preTaskSourceGetter) {
    for (const candidate of resolvedTargetPaths) {
      const content = preTaskSourceGetter(candidate);
      if (typeof content === "string") {
        targetPreTaskContent = content;
        targetResolvedPath = candidate;
        break;
      }
    }
  }

  if (!targetPreTaskContent || !targetResolvedPath) {
    return false;
  }

  // 4. Parse exports from immutable target module
  const targetAST = StaticValidationEngine.parseFile(targetResolvedPath, targetPreTaskContent, new Map());

  // Check if target module had a NAMED export matching `symbol`
  const hasNamedExport = targetAST.exports.some(
    (exp) => exp.kind === "named" && exp.name === symbol,
  );

  // If baseline target had NO named export for `symbol` and baseline importer requested it:
  // PROOF COMPLETE: The named-import / missing-named-export mismatch pre-existed in immutable baseline.
  return !hasNamedExport;
}

/**
 * Deterministically proves whether a TS6133 unused declaration in an already-authorized file
 * is an AUTHORIZED_REPAIR_FOLLOWUP caused by an earlier authorized repair removing its usage/export.
 */
function isUnusedDeclAuthorizedRepairFollowup(
  filePath: string,
  preTaskContent: string,
  currentContent: string | undefined,
  symbol: string,
  causalityContext?: CausalityContext,
): boolean {
  if (!symbol || !preTaskContent || !currentContent) return false;

  const diagNorm = normalizeRepoPath(filePath);

  // 1. File must have been already formally authorized in this run
  if (!causalityContext?.authorizedRevealedBaselinePaths?.has(diagNorm)) {
    return false;
  }

  // 2. File must be present in repair history / currentChanges
  const changeForFile = (causalityContext?.changes || []).find(
    (c) => normalizeRepoPath(c.path) === diagNorm,
  );
  if (!changeForFile) {
    return false;
  }

  // 3. Immutable baseline MUST contain the declaration of `symbol`
  const declRegex = new RegExp(`(?:const|let|var|function|class|type|interface)\\s+${symbol}\\b`);
  if (!declRegex.test(preTaskContent)) {
    return false;
  }

  // 4. Immutable baseline MUST ALSO contain actual usage / export references preventing TS6133
  const preSymbolOccurrences = (preTaskContent.match(new RegExp(`\\b${symbol}\\b`, "g")) || []).length;
  if (preSymbolOccurrences < 2) {
    // If only 1 occurrence in baseline, it was already unused at baseline (not caused by repair)
    return false;
  }

  // 5. Current source MUST still contain the declaration
  if (!declRegex.test(currentContent)) {
    return false;
  }

  // 6. Current source no longer contains the baseline usage/export references (only declaration remains)
  const currentSymbolOccurrences = (currentContent.match(new RegExp(`\\b${symbol}\\b`, "g")) || []).length;
  if (currentSymbolOccurrences > 1) {
    // If occurrences > 1, usages still exist in currentContent
    return false;
  }

  // 7. That disappearance is attributable to an authorized repair patch in this run
  return true;
}

export interface PreTaskSourceInfo {
  content: string;
  origin: "FS_MANAGER" | "GIT_BASE";
}

/**
 * Creates an immutable pre-task source getter for baseline causality verification.
 * Fallback order:
 * 1. FileSystemStateManager snapshot (if already snapshotted)
 * 2. Immutable Git base commit content via `git show <baseCommitSha>:<filePath>`
 * 3. Returns null (fail closed)
 */
export function createPreTaskSourceGetter(
  localPath: string | null | undefined,
  fsManager?: { getOriginalContent: (p: string) => string | null | undefined; hasOriginalFile: (p: string) => boolean },
  baseCommitSha?: string,
): (filePath: string) => PreTaskSourceInfo | null {
  return (filePath: string) => {
    if (!filePath || typeof filePath !== "string") return null;
    const normPath = filePath.replace(/\\/g, "/").replace(/^\.\//, "");

    // 1. Check FileSystemStateManager snapshot
    if (fsManager && fsManager.hasOriginalFile(normPath)) {
      const orig = fsManager.getOriginalContent(normPath);
      if (typeof orig === "string") {
        return { content: orig, origin: "FS_MANAGER" };
      }
    }

    // 2. If unavailable in snapshot, check Git immutable base commit
    if (localPath && fs.existsSync(localPath)) {
      try {
        const gitTarget = baseCommitSha ? `${baseCommitSha}:${normPath}` : `HEAD:${normPath}`;
        const content = execSync(`git show ${gitTarget}`, {
          cwd: localPath,
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
          maxBuffer: 10 * 1024 * 1024,
        });
        if (typeof content === "string") {
          return { content, origin: "GIT_BASE" };
        }
      } catch {
        // File did not exist at base commit or git failed -> return null
      }
    }

    return null;
  };
}

export interface BaselineDeltaResult {
  baselineDiagnosticCount: number;
  targetedBaselineDiagnostics: BaselineDiagnostic[];
  resolvedTargetDiagnostics: BaselineDiagnostic[];
  remainingBaselineDiagnostics: BaselineDiagnostic[];
  revealedBaselineDiagnostics: BaselineDiagnostic[];
  newTaskDiagnostics: BaselineDiagnostic[];
  taskVerified: boolean;
  repositoryClean: boolean;
}

export interface CausalityContext {
  preTaskSourceGetter?: (filePath: string) => string | null | undefined;
  changes?: AgentFileChange[];
  isBroadRepairTask?: boolean;
  knowledgeGraph?: ExtendedKnowledgeGraph | null;
  /** Normalized paths of files dynamically authorized as REVEALED_BASELINE during this repair run */
  authorizedRevealedBaselinePaths?: Set<string>;
}

export class BaselineDeltaVerifier {
  /**
   * Normalizes a message string for stable fingerprinting.
   */
  private static normalizeMessage(msg: string): string {
    return (msg || "")
      .toLowerCase()
      .replace(/[\r\n]+/g, " ")
      .replace(/\s+/g, " ")
      .replace(/[\\/]/g, "/")
      .trim();
  }

  /**
   * Extracts structured baseline diagnostics from build error logs.
   */
  public static extractDiagnostics(
    rawErrorLog: string,
    origin: "BASELINE" | "CURRENT_TASK" = "BASELINE"
  ): BaselineDiagnostic[] {
    if (!rawErrorLog || !rawErrorLog.trim()) return [];

    const diagnostics: BaselineDiagnostic[] = [];
    const seenFingerprints = new Set<string>();

    const addDiag = (d: Omit<BaselineDiagnostic, "fingerprint">) => {
      const cleanPath = (d.filePath || "").replace(/^\.\//, "").replace(/\\/g, "/").toLowerCase();
      let fp: string;
      if (d.errorType === "MISSING_DEP" && d.symbolName) {
        fp = `MISSING_DEP|${d.symbolName.toLowerCase()}`;
      } else if (d.errorCode === "CLIENT_DIRECTIVE_REQUIRED" && cleanPath) {
        fp = `CLIENT_DIRECTIVE_REQUIRED|${cleanPath}`;
      } else {
        const normMsg = this.normalizeMessage(d.message);
        fp = `${d.errorType}|${cleanPath}|${d.errorCode || ""}|${normMsg.slice(0, 120)}`;
      }

      if (!seenFingerprints.has(fp)) {
        seenFingerprints.add(fp);
        diagnostics.push({
          ...d,
          filePath: d.filePath ? d.filePath.replace(/^\.\//, "").replace(/\\/g, "/") : undefined,
          fingerprint: fp,
          origin,
        });
      }
    };

    // 1. Next.js Client Directive / Server Component errors
    const clientDirectiveRegex = /(?:Error:\s*)?([a-zA-Z0-9_\-\/\\.]+\.(?:tsx|ts|jsx|js|mjs|cjs))[:\s\d]*[^\n]*\r?\n([^\n]*(?:useState|useEffect|useContext|useReducer|useCallback|useMemo|useRef|createContext|Client Component|"use client"|Server Component)[^\n]*)/gi;
    let cdMatch: RegExpExecArray | null;
    while ((cdMatch = clientDirectiveRegex.exec(rawErrorLog)) !== null) {
      const filePath = cdMatch[1].replace(/^\.\//, "").replace(/\\/g, "/");
      addDiag({
        errorType: "COMPILE_NEXT",
        filePath,
        errorCode: "CLIENT_DIRECTIVE_REQUIRED",
        message: cdMatch[2].replace(/[\r\n]+/g, " ").trim(),
        symbolName: "useState",
        origin,
        rawTrace: cdMatch[0],
      });
    }

    // 2. Missing module / dependencies
    const missingPkgs = ErrorClassifier.extractMissingPackageNames(rawErrorLog);
    for (const pkg of missingPkgs) {
      addDiag({
        errorType: "MISSING_DEP",
        errorCode: "MODULE_NOT_FOUND",
        message: `Cannot find module '${pkg}'`,
        symbolName: pkg,
        origin,
      });
    }

    // 3. Compiler diagnostics from ErrorDiagnosticsParser
    const parsedCompilerDiags = ErrorDiagnosticsParser.parse(rawErrorLog);
    for (const d of parsedCompilerDiags) {
      const isClientDir = /useState|useEffect|useRef|"use client"|Client Component/i.test(d.message);
      addDiag({
        errorType: isClientDir ? "COMPILE_NEXT" : d.code?.startsWith("TS") ? "COMPILE_TS" : "COMPILE_NEXT",
        filePath: d.file,
        line: d.line,
        column: d.column,
        errorCode: isClientDir ? "CLIENT_DIRECTIVE_REQUIRED" : d.code,
        message: d.message,
        symbolName: d.symbolName,
        origin,
        rawTrace: d.rawTrace,
      });
    }

    // 4. CSS / PostCSS errors
    if (/is not recognized as a valid pseudo-class|CssSyntaxError/i.test(rawErrorLog)) {
      const cssFileMatch = rawErrorLog.match(/([a-zA-Z0-9_\-\/\\.]+\.(?:css|scss))/i);
      addDiag({
        errorType: "CSS_PARSE",
        filePath: cssFileMatch ? cssFileMatch[1].replace(/^\.\//, "").replace(/\\/g, "/") : undefined,
        errorCode: "CSS_SYNTAX",
        message: "Invalid CSS pseudo-class or PostCSS configuration warning/error.",
        origin,
      });
    }

    // 5. Fallback diagnostic if none extracted but errorLog exists
    if (diagnostics.length === 0 && rawErrorLog.trim().length > 0) {
      const classified = ErrorClassifier.classify(rawErrorLog);
      addDiag({
        errorType: classified.type,
        message: rawErrorLog.slice(0, 300).replace(/[\r\n]+/g, " ").trim(),
        origin,
      });
    }

    return diagnostics;
  }

  /**
   * Evaluates whether a user prompt explicitly targets any of the pre-existing baseline diagnostics.
   * Matching is conservative: a diagnostic is targeted ONLY when supported by strong evidence.
   */
  public static matchUserTaskToBaseline(
    userMessage: string,
    baselineDiagnostics: BaselineDiagnostic[]
  ): { isMatch: boolean; targetedDiagnostics: BaselineDiagnostic[] } {
    if (!userMessage || !baselineDiagnostics.length) {
      return { isMatch: false, targetedDiagnostics: [] };
    }

    const msg = userMessage.toLowerCase();
    const targetedDiagnostics: BaselineDiagnostic[] = [];

    for (const diag of baselineDiagnostics) {
      let isTargeted = false;

      // 1. File-specific diagnostic (compiler, client directive, syntax, type error)
      if (diag.filePath) {
        const fullPath = diag.filePath.toLowerCase();
        const baseName = (fullPath.split("/").pop() || "").toLowerCase();
        const nameWithoutExt = baseName.replace(/\.[^.]+$/, "");

        const fileMentioned =
          msg.includes(fullPath) ||
          msg.includes(baseName) ||
          (nameWithoutExt.length > 3 && msg.includes(nameWithoutExt));

        if (fileMentioned) {
          const isClientDirective =
            diag.errorCode === "CLIENT_DIRECTIVE_REQUIRED" ||
            /useState|useEffect|client component|server component|"use client"/i.test(diag.message);

          const clientMentioned =
            /usestate|useeffect|client component|server component|use client|directive|react server component/i.test(msg);

          if (isClientDirective) {
            if (clientMentioned) {
              isTargeted = true;
            }
          } else {
            isTargeted = true;
          }
        }
      }

      // 2. Specific named missing package (ONLY if package name itself is explicitly mentioned in message)
      if (!isTargeted && diag.errorType === "MISSING_DEP" && diag.symbolName) {
        const pkg = diag.symbolName.toLowerCase();
        if (msg.includes(pkg)) {
          isTargeted = true;
        }
      }

      // 3. Specific error code mentioned explicitly in message (e.g. TS2304, TS2440)
      if (!isTargeted && diag.errorCode && diag.errorCode.startsWith("TS")) {
        const code = diag.errorCode.toLowerCase();
        if (msg.includes(code)) {
          isTargeted = true;
        }
      }

      if (isTargeted) {
        targetedDiagnostics.push(diag);
      }
    }

    return {
      isMatch: targetedDiagnostics.length > 0,
      targetedDiagnostics,
    };
  }

  /**
   * Deterministically determines whether an error appearing after a fix was caused by a pre-existing
   * construct in the authoritative pre-task source that was NOT created or modified by the agent's patch.
   */
  public static isConstructPreExistingAndUntouched(
    diag: BaselineDiagnostic,
    preTaskContent: string | null | undefined,
    change?: AgentFileChange,
    causalityContext?: CausalityContext
  ): { isPreExisting: boolean; isTouched: boolean; isAuthorizedRepairFollowup?: boolean } {
    if (!preTaskContent) {
      // File did not exist before task or content is unavailable -> fail safe to new task error
      return { isPreExisting: false, isTouched: true };
    }

    const postContent = change?.content;
    const normalizeSourceForComparison = (content: string) =>
      content.replace(/\r\n?/g, "\n");

    const isSelfContentUnchanged =
      !change ||
      (typeof postContent === "string" &&
        normalizeSourceForComparison(postContent) === normalizeSourceForComparison(preTaskContent));

    const msg = diag.message || "";
    const rawTrace = diag.rawTrace || "";
    const symbolName = diag.symbolName;

    // 1. Redeclaration / Duplicate export check (e.g. Cannot redeclare exported variable 'CalculatorButton')
    const redeclareMatch =
      msg.match(/(?:cannot redeclare exported variable|cannot redeclare block-scoped variable|identifier|duplicate identifier|already been declared)['"\s]+([a-zA-Z0-9_$]+)/i) ||
      rawTrace.match(/(?:cannot redeclare exported variable|cannot redeclare block-scoped variable|identifier|duplicate identifier|already been declared)['"\s]+([a-zA-Z0-9_$]+)/i);
    const targetSymbol = (diag.errorCode === "TS2440" || redeclareMatch) ? (symbolName || (redeclareMatch ? redeclareMatch[1] : undefined)) : undefined;

    if (targetSymbol) {
      const symbolDeclRegex = new RegExp(`(?:export\\s+(?:const|let|var|function|class|type|interface)|(?:const|let|var|function|class|type|interface))\\s+${targetSymbol}\\b`, "g");
      const preMatches = preTaskContent.match(symbolDeclRegex) || [];
      const preSymbolOccurrences = (preTaskContent.match(new RegExp(`\\b${targetSymbol}\\b`, "g")) || []).length;

      // If pre-task source had 2+ declarations or multiple occurrences of this symbol
      if (preMatches.length >= 2 || (preMatches.length >= 1 && preSymbolOccurrences >= 2)) {
        if (postContent && !isSelfContentUnchanged) {
          const postMatches = postContent.match(symbolDeclRegex) || [];
          const agentAddedDeclarations = postMatches.length > preMatches.length;
          if (!agentAddedDeclarations) {
            return { isPreExisting: true, isTouched: false };
          } else {
            return { isPreExisting: true, isTouched: true };
          }
        }
        return { isPreExisting: true, isTouched: false };
      }
    }

    // 2. Syntax / Type / Snippet Check: if error snippet or line exists in rawTrace
    const codeSnippetMatch = rawTrace.match(/>\s*\d+\s*\|\s*(.+)/);
    if (codeSnippetMatch) {
      const failingSnippet = codeSnippetMatch[1].trim();
      if (failingSnippet.length > 5 && preTaskContent.includes(failingSnippet)) {
        if (!postContent || postContent.includes(failingSnippet)) {
          return { isPreExisting: true, isTouched: false };
        }
      }
    }

    // 3. Fallback check for exact message / error construct in preTaskContent
    const cannotFindMatch = msg.match(/Cannot find (?:name|module) '([^']+)'/i);
    if (cannotFindMatch && preTaskContent.includes(cannotFindMatch[1])) {
      if (!postContent || postContent.includes(cannotFindMatch[1])) {
        return { isPreExisting: true, isTouched: false };
      }
    }

    // 3a. Deterministic TS2614 / TS2305 baseline import/export mismatch proof
    const isNamedExportMismatchDiag =
      diag.errorCode === "TS2614" ||
      diag.errorCode === "TS2305" ||
      /has no exported member/i.test(msg) ||
      /has no exported member/i.test(rawTrace);

    const missingExportSymbol =
      symbolName ||
      msg.match(/has no exported member\s+['"`]([A-Za-z0-9_$]+)['"`]/i)?.[1] ||
      rawTrace.match(/has no exported member\s+['"`]([A-Za-z0-9_$]+)['"`]/i)?.[1];

    const missingExportModule =
      msg.match(/Module\s+['"`]+([^'"`]+)['"`]+\s+has no exported member/i)?.[1] ||
      rawTrace.match(/Module\s+['"`]+([^'"`]+)['"`]+\s+has no exported member/i)?.[1];

    if (isNamedExportMismatchDiag && missingExportSymbol && causalityContext?.preTaskSourceGetter && isSelfContentUnchanged) {
      if (
        isMissingNamedExportPreExisting(
          diag.filePath || "",
          preTaskContent,
          missingExportSymbol,
          missingExportModule,
          causalityContext.preTaskSourceGetter
        )
      ) {
        return { isPreExisting: true, isTouched: false };
      }
    }

    // 3c. TS6133 unused declaration authorized repair follow-up
    const isUnusedDiag =
      diag.errorCode === "TS6133" ||
      /is declared but (?:its value is never read|never used)/i.test(msg) ||
      /is declared but (?:its value is never read|never used)/i.test(rawTrace);

    const unusedSymbol =
      symbolName ||
      msg.match(/['"`]([A-Za-z0-9_$]+)['"`]\s+is declared but/i)?.[1] ||
      rawTrace.match(/['"`]([A-Za-z0-9_$]+)['"`]\s+is declared but/i)?.[1];

    if (isUnusedDiag) {
      if (unusedSymbol && postContent) {
        const isFollowup = isUnusedDeclAuthorizedRepairFollowup(
          diag.filePath || "",
          preTaskContent,
          postContent,
          unusedSymbol,
          causalityContext
        );
        if (isFollowup) {
          return { isPreExisting: false, isTouched: true, isAuthorizedRepairFollowup: true };
        }
      }
      // TS6133 is NEVER an untouched pre-existing baseline error
      return { isPreExisting: false, isTouched: true };
    }

    // 3b. Refined causality for previously authorized revealed-baseline repair targets.
    //     When a file was authorized for baseline repair and its content has since changed
    //     (due to an authorized surgical repair), we must NOT automatically fail to NEW_TASK.
    //     Instead, re-check whether the CURRENT diagnostic construct can be deterministically
    //     proven to have existed in immutable pre-task source.
    if (
      !isSelfContentUnchanged &&
      causalityContext?.authorizedRevealedBaselinePaths &&
      diag.filePath
    ) {
      const diagFilePath = (diag.filePath || "").replace(/^\.\//, "").replace(/\\/g, "/");
      const diagNormPath = normalizeRepoPath(diagFilePath);

      if (causalityContext.authorizedRevealedBaselinePaths.has(diagNormPath)) {
        // Deterministic TS2614 / TS2305 proof takes precedence over cross-file dependency heuristic
        if (isNamedExportMismatchDiag && missingExportSymbol && causalityContext?.preTaskSourceGetter) {
          const isProvenMismatch = isMissingNamedExportPreExisting(
            diagFilePath,
            preTaskContent,
            missingExportSymbol,
            missingExportModule,
            causalityContext.preTaskSourceGetter
          );
          if (isProvenMismatch) {
            return { isPreExisting: true, isTouched: false };
          }
        }

        // Safety: check dependency/global-config fail-closed before granting continued authority
        const modifiedOtherFiles = (causalityContext.changes || []).filter((c) => {
          const cPath = (c.path || "").replace(/^\.\//, "").replace(/\\/g, "/");
          if (cPath.toLowerCase() === diagFilePath.toLowerCase()) return false;
          if (causalityContext.preTaskSourceGetter) {
            const orig = causalityContext.preTaskSourceGetter(cPath);
            if (orig && normalizeSourceForComparison(orig) === normalizeSourceForComparison(c.content || "")) {
              return false;
            }
          }
          return true;
        });

        // Fail closed if agent modified a global config file
        const hasGlobalConfigModified = modifiedOtherFiles.some((c) => {
          const baseName = path.basename(c.path).toLowerCase();
          return GLOBAL_CONFIG_FILE_PATTERNS.some((pat) => pat.test(baseName));
        });
        if (hasGlobalConfigModified) {
          return { isPreExisting: false, isTouched: true };
        }

        // Fail closed if this file depends on another file the agent actually modified
        if (modifiedOtherFiles.length > 0) {
          const importSpecifiers = ImportValidator.extractImportSpecifiers(preTaskContent);
          for (const modFile of modifiedOtherFiles) {
            const modNorm = normalizeRepoPath(modFile.path);
            for (const spec of importSpecifiers) {
              if (matchesModuleSpecifier(diagFilePath, spec, modNorm)) {
                return { isPreExisting: false, isTouched: true };
              }
            }
            const modBase = path.basename(modNorm, path.extname(modNorm));
            if (msg.includes(modNorm) || msg.includes(`./${modBase}`) || rawTrace.includes(modNorm)) {
              return { isPreExisting: false, isTouched: true };
            }
          }
        }

        // Check knowledge graph if available
        if (causalityContext?.knowledgeGraph) {
          const kg = causalityContext.knowledgeGraph;
          for (const modFile of modifiedOtherFiles) {
            const modNorm = normalizeRepoPath(modFile.path);
            const diagNorm = normalizeRepoPath(diagFilePath);

            if (Array.isArray(kg.imports)) {
              if (
                kg.imports.some(
                  (imp) =>
                    normalizeRepoPath(imp.file) === diagNorm &&
                    matchesModuleSpecifier(diagNorm, imp.source, modNorm)
                )
              ) {
                return { isPreExisting: false, isTouched: true };
              }
            }

            if (kg.dependencyGraph) {
              const deps = kg.dependencyGraph[diagNorm] || [];
              if (deps.some((dep) => matchesModuleSpecifier(diagNorm, dep, modNorm))) {
                return { isPreExisting: false, isTouched: true };
              }
            }
          }
        }

        // Now check if the current diagnostic construct existed in immutable pre-task source.
        // This uses stable evidence (errorCode, symbolName, construct text) NOT line/column.

        // R1. Duplicate export / redeclare: check if pre-task had the problematic symbol
        if (targetSymbol) {
          const symbolDeclRegex = new RegExp(`(?:export\\s+(?:const|let|var|function|class|type|interface)|(?:const|let|var|function|class|type|interface))\\s+${targetSymbol}\\b`, "g");
          const preMatches = preTaskContent.match(symbolDeclRegex) || [];
          const preSymbolOccurrences = (preTaskContent.match(new RegExp(`\\b${targetSymbol}\\b`, "g")) || []).length;
          if (preMatches.length >= 2 || (preMatches.length >= 1 && preSymbolOccurrences >= 2)) {
            // Verify the repair didn't ADD more declarations than baseline
            if (postContent) {
              const postMatches = postContent.match(symbolDeclRegex) || [];
              if (postMatches.length <= preMatches.length) {
                return { isPreExisting: true, isTouched: false };
              }
            } else {
              return { isPreExisting: true, isTouched: false };
            }
          }
        }

        // R2. Named construct / cannot find name/module: verify construct exists in pre-task source
        const authCannotFindMatch = msg.match(/Cannot find (?:name|module) '([^']+)'/i);
        if (authCannotFindMatch && preTaskContent.includes(authCannotFindMatch[1])) {
          return { isPreExisting: true, isTouched: false };
        }

        // R3. Raw trace snippet: if the failing code snippet exists in pre-task source
        const authSnippetMatch = rawTrace.match(/>\s*\d+\s*\|\s*(.+)/);
        if (authSnippetMatch) {
          const failingSnippet = authSnippetMatch[1].trim();
          if (failingSnippet.length > 5 && preTaskContent.includes(failingSnippet)) {
            return { isPreExisting: true, isTouched: false };
          }
        }

        // R4. TS6133 unused declaration authorized repair follow-up
        const isUnusedDiag =
          diag.errorCode === "TS6133" ||
          /is declared but (?:its value is never read|never used)/i.test(msg) ||
          /is declared but (?:its value is never read|never used)/i.test(rawTrace);

        const unusedSymbol =
          symbolName ||
          msg.match(/['"`]([A-Za-z0-9_$]+)['"`]\s+is declared but/i)?.[1] ||
          rawTrace.match(/['"`]([A-Za-z0-9_$]+)['"`]\s+is declared but/i)?.[1];

        if (isUnusedDiag && unusedSymbol && postContent) {
          const isFollowup = isUnusedDeclAuthorizedRepairFollowup(
            diagFilePath,
            preTaskContent,
            postContent,
            unusedSymbol,
            causalityContext
          );
          if (isFollowup) {
            return { isPreExisting: false, isTouched: true, isAuthorizedRepairFollowup: true };
          }
        }

        // Could not deterministically prove this diagnostic construct existed at baseline
        // -> Fail closed to NEW_TASK. Authorization does NOT grant blanket immunity.
        return { isPreExisting: false, isTouched: true };
      }
    }

    // 4. If the file itself is unchanged (never modified by agent, or hydrated with identical content):
    if (isSelfContentUnchanged) {
      const diagFilePath = (diag.filePath || "").replace(/^\.\//, "").replace(/\\/g, "/");

      // Deterministic TS2614 / TS2305 proof takes precedence over cross-file dependency heuristic
      if (isNamedExportMismatchDiag && missingExportSymbol && causalityContext?.preTaskSourceGetter) {
        const isProvenMismatch = isMissingNamedExportPreExisting(
          diagFilePath,
          preTaskContent,
          missingExportSymbol,
          missingExportModule,
          causalityContext.preTaskSourceGetter
        );
        if (isProvenMismatch) {
          return { isPreExisting: true, isTouched: false };
        }
      }

      // Identify any other files that were actually modified by the agent
      const modifiedOtherFiles = (causalityContext?.changes || []).filter((c) => {
        const cPath = (c.path || "").replace(/^\.\//, "").replace(/\\/g, "/");
        if (cPath.toLowerCase() === diagFilePath.toLowerCase()) return false;
        if (causalityContext?.preTaskSourceGetter) {
          const orig = causalityContext.preTaskSourceGetter(cPath);
          if (orig && normalizeSourceForComparison(orig) === normalizeSourceForComparison(c.content || "")) {
            return false;
          }
        }
        return true;
      });

      // A) Global config modification check: if agent modified a global build/config file, fail closed
      const hasGlobalConfigModified = modifiedOtherFiles.some((c) => {
        const baseName = path.basename(c.path).toLowerCase();
        return GLOBAL_CONFIG_FILE_PATTERNS.some((pat) => pat.test(baseName));
      });

      if (hasGlobalConfigModified) {
        return { isPreExisting: false, isTouched: true };
      }

      // B) Dependency check against modified files
      if (modifiedOtherFiles.length > 0) {
        const importSpecifiers = ImportValidator.extractImportSpecifiers(preTaskContent);

        for (const modFile of modifiedOtherFiles) {
          const modNorm = normalizeRepoPath(modFile.path);

          // Does preTaskContent import modFile?
          for (const spec of importSpecifiers) {
            if (matchesModuleSpecifier(diagFilePath, spec, modNorm)) {
              return { isPreExisting: false, isTouched: true };
            }
          }

          // Does diagnostic message or trace mention the modified file or its relative specifier?
          const modBase = path.basename(modNorm, path.extname(modNorm));
          if (msg.includes(modNorm) || msg.includes(`./${modBase}`) || rawTrace.includes(modNorm)) {
            return { isPreExisting: false, isTouched: true };
          }
        }

        // Check knowledge graph if available
        if (causalityContext?.knowledgeGraph) {
          const kg = causalityContext.knowledgeGraph;
          for (const modFile of modifiedOtherFiles) {
            const modNorm = normalizeRepoPath(modFile.path);
            const diagNorm = normalizeRepoPath(diagFilePath);

            if (Array.isArray(kg.imports)) {
              if (
                kg.imports.some(
                  (imp) =>
                    normalizeRepoPath(imp.file) === diagNorm &&
                    matchesModuleSpecifier(diagNorm, imp.source, modNorm)
                )
              ) {
                return { isPreExisting: false, isTouched: true };
              }
            }

            if (kg.dependencyGraph) {
              const deps = kg.dependencyGraph[diagNorm] || [];
              if (deps.some((dep) => matchesModuleSpecifier(diagNorm, dep, modNorm))) {
                return { isPreExisting: false, isTouched: true };
              }
            }
          }
        }
      }

      // C) File is unchanged AND does not depend on any modified file AND no global config modified
      const lines = preTaskContent.split("\n");
      if (diag.line && diag.line <= lines.length) {
        return { isPreExisting: true, isTouched: false };
      }
      if (!diag.line) {
        return { isPreExisting: true, isTouched: false };
      }
    }

    // Fail safe: could not prove pre-existence with deterministic evidence
    return { isPreExisting: false, isTouched: true };
  }

  /**
   * Helper to check if a user message or execution contract represents a broad build repair task.
   */
  public static isBroadBuildRepairTask(message?: string, contract?: ExecutionContract | null): boolean {
    if (contract?.goal && /(?:fix|solve|resolve|repair|clear)\s+(?:all|every)\s+(?:build |compiler |compilation |typescript )?(?:errors?|issues?|broken build)|repair (?:the )?(?:entire |all )?build/i.test(contract.goal)) {
      return true;
    }
    if (!message) return false;

    const msg = message.toLowerCase();

    // 1. Direct broad action phrases targeting build/compiler errors or repository buildability
    if (
      /(?:fix|solve|resolve|repair|clear|clean\s+up)\s+(?:all|every|the)\s+(?:build|compiler|compilation|typescript|ts)?\s*(?:errors?|issues?|failures?|broken\s+build)/i.test(msg) ||
      /make\s+(?:the\s+)?(?:repository|repo|project|codebase|build)\s+build(?:ing| successfully)?/i.test(msg) ||
      /get\s+(?:the\s+)?(?:repository|repo|project|codebase|build)\s+(?:to\s+)?build(?:ing| successfully)?/i.test(msg) ||
      /repair\s+(?:the\s+)?(?:entire|all|whole)\s+(?:broken\s+)?build/i.test(msg)
    ) {
      return true;
    }

    // 2. Compound phrases: message contains build/compiler error context AND broad solve intent
    // e.g. "I am having build errors in this repo, I need you to solve them all"
    const hasBuildErrorContext =
      /(?:build|compiler|compilation|typescript|tsc)\s*(?:errors?|issues?|failures?|broken|failing)|broken\s+(?:build|repository|repo|project)/i.test(msg);
    const hasBroadSolveIntent =
      /(?:solve|fix|resolve|repair|clear|address)\s+(?:them\s+all|all\s+of\s+them|all\s+the\s+errors|all\s+errors|everything|each\s+and\s+every\s+one)/i.test(msg) ||
      /(?:all|every)\s+(?:of\s+them|errors?|issues?)\s*(?:need\s+to\s+be\s+)?(?:fixed|solved|resolved|repaired|cleared)/i.test(msg);

    if (hasBuildErrorContext && hasBroadSolveIntent) {
      return true;
    }

    return false;
  }

  /**
   * Compares baseline diagnostics with post-change diagnostics.
   */
  public static compareBaselineVsPostChange(
    baselineDiagnostics: BaselineDiagnostic[],
    postChangeDiagnostics: BaselineDiagnostic[],
    targetedDiagnostics: BaselineDiagnostic[],
    causalityContext?: CausalityContext
  ): BaselineDeltaResult {
    const postFpSet = new Set(postChangeDiagnostics.map((p) => p.fingerprint));
    const baseFpSet = new Set(baselineDiagnostics.map((b) => b.fingerprint));

    // Targeted diagnostics that disappeared
    const resolvedTargetDiagnostics = targetedDiagnostics.filter((t) => !postFpSet.has(t.fingerprint));

    // Pre-existing baseline diagnostics that remain explicitly
    const remainingBaselineDiagnostics = baselineDiagnostics.filter((b) => postFpSet.has(b.fingerprint));

    // Diagnostics in post-change that did NOT exist in original baseline output
    const unpredictedDiagnostics = postChangeDiagnostics.filter((p) => !baseFpSet.has(p.fingerprint));

    const revealedBaselineDiagnostics: BaselineDiagnostic[] = [];
    const newTaskDiagnostics: BaselineDiagnostic[] = [];

    const isBaselineDeltaMode = targetedDiagnostics.length > 0 && resolvedTargetDiagnostics.length > 0;

    for (const diag of unpredictedDiagnostics) {
      if (isBaselineDeltaMode && causalityContext?.preTaskSourceGetter && diag.filePath) {
        const cleanPath = diag.filePath.replace(/^\.\//, "").replace(/\\/g, "/");
        const preContent = causalityContext.preTaskSourceGetter(cleanPath);
        const change = causalityContext.changes?.find(
          (c) => (c.path || "").replace(/^\.\//, "").replace(/\\/g, "/").toLowerCase() === cleanPath.toLowerCase()
        );

        const causality = this.isConstructPreExistingAndUntouched(diag, preContent, change, causalityContext);
        const isRevealed = causality.isPreExisting && !causality.isTouched;
        const isFollowup = Boolean(causality.isAuthorizedRepairFollowup);

        if (isFollowup) {
          console.log(
            `[BASELINE_CAUSALITY] file=${cleanPath} diagnostic=${diag.errorCode || diag.message.slice(0, 50)} preExistingCause=false agentTouchedCause=true classification=AUTHORIZED_REPAIR_FOLLOWUP`
          );
          revealedBaselineDiagnostics.push(diag);
        } else {
          console.log(
            `[BASELINE_CAUSALITY] file=${cleanPath} diagnostic=${diag.errorCode || diag.message.slice(0, 50)} preExistingCause=${causality.isPreExisting} agentTouchedCause=${causality.isTouched} classification=${isRevealed ? "REVEALED_BASELINE" : "NEW_TASK"}`
          );

          if (isRevealed) {
            revealedBaselineDiagnostics.push(diag);
          } else {
            newTaskDiagnostics.push(diag);
          }
        }
      } else {
        newTaskDiagnostics.push(diag);
      }
    }

    const allTargetedResolved =
      targetedDiagnostics.length > 0 && resolvedTargetDiagnostics.length === targetedDiagnostics.length;
    const noNewErrors = newTaskDiagnostics.length === 0;

    // For broad repair requests ("fix all build errors"), revealed errors remain in repair scope
    const isBroad = Boolean(causalityContext?.isBroadRepairTask);
    const repositoryClean = postChangeDiagnostics.length === 0;
    const taskVerified = isBroad ? repositoryClean : allTargetedResolved && noNewErrors;

    console.log(
      `[BASELINE_DELTA] targetResolved=${allTargetedResolved} remainingBaseline=${remainingBaselineDiagnostics.length} revealedBaseline=${revealedBaselineDiagnostics.length} newTask=${newTaskDiagnostics.length}`
    );

    return {
      baselineDiagnosticCount: baselineDiagnostics.length,
      targetedBaselineDiagnostics: targetedDiagnostics,
      resolvedTargetDiagnostics,
      remainingBaselineDiagnostics,
      revealedBaselineDiagnostics,
      newTaskDiagnostics,
      taskVerified,
      repositoryClean,
    };
  }

  /**
   * Generates a clear explanation for partial baseline-delta verification.
   */
  public static formatDeltaExplanation(delta: BaselineDeltaResult): string {
    const lines: string[] = [];

    if (delta.taskVerified) {
      lines.push("Requested Fix: VERIFIED");
      lines.push("");
      lines.push(`Repository Status: ${delta.repositoryClean ? "CLEAN" : "BASELINE STILL UNHEALTHY"}`);
      lines.push("");
      lines.push("Resolved:");
      for (const res of delta.resolvedTargetDiagnostics) {
        lines.push(`- ${res.filePath ? `${res.filePath} (${res.errorCode || res.message})` : res.message}`);
      }

      if (delta.revealedBaselineDiagnostics && delta.revealedBaselineDiagnostics.length > 0) {
        lines.push("");
        lines.push("Revealed pre-existing errors (unmasked after requested fix):");
        for (const rev of delta.revealedBaselineDiagnostics) {
          lines.push(`- ${rev.filePath ? `${rev.filePath}: ${rev.message}` : rev.message}`);
        }
        lines.push("");
        lines.push("These pre-existing errors already existed in the baseline and were not caused by this change.");
      }

      if (delta.remainingBaselineDiagnostics.length > 0) {
        lines.push("");
        lines.push("Remaining pre-existing errors:");
        for (const rem of delta.remainingBaselineDiagnostics) {
          lines.push(`- ${rem.filePath ? `${rem.filePath}: ${rem.message}` : rem.message}`);
        }
        lines.push("");
        lines.push("Full build still fails due to unrelated baseline issues.");
      }
    } else {
      lines.push("Requested Fix: UNVERIFIED");
      if (delta.newTaskDiagnostics.length > 0) {
        lines.push("");
        lines.push("New task-introduced errors detected:");
        for (const err of delta.newTaskDiagnostics) {
          lines.push(`- ${err.filePath ? `${err.filePath}: ${err.message}` : err.message}`);
        }
      }
    }

    return lines.join("\n");
  }
}
