import { ErrorDiagnosticsParser, DiagnosticError } from "./surgical-repair.engine";
import { ErrorClassifier } from "../ai/validation/ErrorClassifier";
import { BaselineDiagnostic } from "../types";

export interface BaselineDeltaResult {
  baselineDiagnosticCount: number;
  targetedBaselineDiagnostics: BaselineDiagnostic[];
  resolvedTargetDiagnostics: BaselineDiagnostic[];
  remainingBaselineDiagnostics: BaselineDiagnostic[];
  newTaskDiagnostics: BaselineDiagnostic[];
  taskVerified: boolean;
  repositoryClean: boolean;
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
   * Compares baseline diagnostics with post-change diagnostics.
   */
  public static compareBaselineVsPostChange(
    baselineDiagnostics: BaselineDiagnostic[],
    postChangeDiagnostics: BaselineDiagnostic[],
    targetedDiagnostics: BaselineDiagnostic[]
  ): BaselineDeltaResult {
    const postFpSet = new Set(postChangeDiagnostics.map((p) => p.fingerprint));
    const baseFpSet = new Set(baselineDiagnostics.map((b) => b.fingerprint));

    // Targeted diagnostics that disappeared
    const resolvedTargetDiagnostics = targetedDiagnostics.filter((t) => !postFpSet.has(t.fingerprint));

    // Pre-existing baseline diagnostics that remain
    const remainingBaselineDiagnostics = baselineDiagnostics.filter((b) => postFpSet.has(b.fingerprint));

    // Diagnostics in post-change that did NOT exist in baseline
    const newTaskDiagnostics = postChangeDiagnostics.filter((p) => !baseFpSet.has(p.fingerprint));

    const allTargetedResolved =
      targetedDiagnostics.length > 0 && resolvedTargetDiagnostics.length === targetedDiagnostics.length;
    const noNewErrors = newTaskDiagnostics.length === 0;

    const taskVerified = allTargetedResolved && noNewErrors;
    const repositoryClean = postChangeDiagnostics.length === 0;

    return {
      baselineDiagnosticCount: baselineDiagnostics.length,
      targetedBaselineDiagnostics: targetedDiagnostics,
      resolvedTargetDiagnostics,
      remainingBaselineDiagnostics,
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
