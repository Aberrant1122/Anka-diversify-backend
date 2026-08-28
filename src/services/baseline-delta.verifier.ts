import { ErrorDiagnosticsParser, DiagnosticError } from "./surgical-repair.engine";
import { ErrorClassifier } from "../ai/validation/ErrorClassifier";
import { BaselineDiagnostic, ExecutionContract } from "../types";
import { AgentFileChange } from "../ai/shared/types";

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
    change?: AgentFileChange
  ): { isPreExisting: boolean; isTouched: boolean } {
    if (!preTaskContent) {
      // File did not exist before task or content is unavailable -> fail safe to new task error
      return { isPreExisting: false, isTouched: true };
    }

    const postContent = change?.content;
    const msg = diag.message || "";
    const rawTrace = diag.rawTrace || "";
    const symbolName = diag.symbolName;

    // 1. Redeclaration / Duplicate export check (e.g. Cannot redeclare exported variable 'CalculatorButton')
    const redeclareMatch =
      msg.match(/(?:cannot redeclare exported variable|cannot redeclare block-scoped variable|identifier|duplicate identifier|already been declared)['"\s]+([a-zA-Z0-9_$]+)/i) ||
      rawTrace.match(/(?:cannot redeclare exported variable|cannot redeclare block-scoped variable|identifier|duplicate identifier|already been declared)['"\s]+([a-zA-Z0-9_$]+)/i);
    const targetSymbol = symbolName || (redeclareMatch ? redeclareMatch[1] : undefined);

    if (targetSymbol) {
      const symbolDeclRegex = new RegExp(`(?:export\\s+(?:const|let|var|function|class|type|interface)|(?:const|let|var|function|class|type|interface))\\s+${targetSymbol}\\b`, "g");
      const preMatches = preTaskContent.match(symbolDeclRegex) || [];
      const preSymbolOccurrences = (preTaskContent.match(new RegExp(`\\b${targetSymbol}\\b`, "g")) || []).length;

      // If pre-task source had 2+ declarations or multiple occurrences of this symbol
      if (preMatches.length >= 2 || (preMatches.length >= 1 && preSymbolOccurrences >= 2)) {
        if (postContent) {
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
        if (postContent && postContent.includes(failingSnippet)) {
          return { isPreExisting: true, isTouched: false };
        }
      }
    }

    // 3. Fallback check for exact message / error construct in preTaskContent
    if (diag.errorCode && diag.errorCode.startsWith("TS")) {
      const nameMatch = msg.match(/Cannot find (?:name|module) '([^']+)'/i);
      if (nameMatch && preTaskContent.includes(nameMatch[1])) {
        if (!postContent || postContent.includes(nameMatch[1])) {
          return { isPreExisting: true, isTouched: false };
        }
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

        const causality = this.isConstructPreExistingAndUntouched(diag, preContent, change);
        const isRevealed = causality.isPreExisting && !causality.isTouched;

        console.log(
          `[BASELINE_CAUSALITY] file=${cleanPath} diagnostic=${diag.errorCode || diag.message.slice(0, 50)} preExistingCause=${causality.isPreExisting} agentTouchedCause=${causality.isTouched} classification=${isRevealed ? "REVEALED_BASELINE" : "NEW_TASK"}`
        );

        if (isRevealed) {
          revealedBaselineDiagnostics.push(diag);
        } else {
          newTaskDiagnostics.push(diag);
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
