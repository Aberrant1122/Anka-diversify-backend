import { ErrorDiagnosticsParser, DiagnosticError } from "../../services/surgical-repair.engine";

// ─── Error Classification Types ────────────────────────────────────────────────

export type ErrorType =
  | "COMPILE_TS"
  | "COMPILE_ANGULAR"
  | "COMPILE_NEXT"
  | "COMPILE_RUST"
  | "COMPILE_GO"
  | "MISSING_DEP"
  | "INFRA"
  | "UNKNOWN";

export interface ErrorClassification {
  type: ErrorType;
  isInfrastructure: boolean;
  isCompile: boolean;
  canSurgicalPatch: boolean;
  diagnostics: DiagnosticError[];
  rawErrors: string;
}

// ─── Error Classifier ──────────────────────────────────────────────────────────

const INFRA_PATTERNS = [
  /ENOENT/i,
  /EACCES/i,
  /command not found/i,
  /timed out/i,
  /exit code 127/,
  /exit code 126/,
  /is not recognized as/i,
  /cannot be loaded because running scripts is disabled/i,
];

const MISSING_DEP_PATTERNS = [
  /Cannot find module/i,
  /Module not found/i,
  /not installed/i,
  /peer dep/i,
  /ERR_MODULE_NOT_FOUND/i,
  /Could not resolve/i,
];

export class ErrorClassifier {
  /**
   * Classify a raw error string into a structured ErrorClassification
   * so the repair loop can route to the correct strategy.
   */
  static classify(errorLog: string): ErrorClassification {
    if (!errorLog || !errorLog.trim()) {
      return {
        type: "UNKNOWN",
        isInfrastructure: false,
        isCompile: false,
        canSurgicalPatch: false,
        diagnostics: [],
        rawErrors: errorLog || "",
      };
    }

    // 1. Infrastructure errors — cannot be fixed by patching code
    if (INFRA_PATTERNS.some((p) => p.test(errorLog))) {
      return {
        type: "INFRA",
        isInfrastructure: true,
        isCompile: false,
        canSurgicalPatch: false,
        diagnostics: [],
        rawErrors: errorLog,
      };
    }

    // 2. Missing dependency — npm install needed, not code patch
    if (MISSING_DEP_PATTERNS.some((p) => p.test(errorLog))) {
      return {
        type: "MISSING_DEP",
        isInfrastructure: false,
        isCompile: false,
        canSurgicalPatch: false,
        diagnostics: [],
        rawErrors: errorLog,
      };
    }

    // 3. Parse structured diagnostics
    const diagnostics = ErrorDiagnosticsParser.parse(errorLog);

    // 4. Classify based on diagnostic codes
    if (diagnostics.length > 0) {
      const hasTS = diagnostics.some((d) => d.code && /^TS\d+$/.test(d.code));
      const hasNG = diagnostics.some((d) => d.code && /^NG\d+$/.test(d.code));

      if (hasNG) {
        return {
          type: "COMPILE_ANGULAR",
          isInfrastructure: false,
          isCompile: true,
          canSurgicalPatch: true,
          diagnostics,
          rawErrors: errorLog,
        };
      }

      if (hasTS) {
        return {
          type: "COMPILE_TS",
          isInfrastructure: false,
          isCompile: true,
          canSurgicalPatch: true,
          diagnostics,
          rawErrors: errorLog,
        };
      }

      // Diagnostics parsed but no recognizable codes
      return {
        type: "COMPILE_NEXT",
        isInfrastructure: false,
        isCompile: true,
        canSurgicalPatch: true,
        diagnostics,
        rawErrors: errorLog,
      };
    }

    // 5. Pattern-based fallbacks when no structured diagnostics parsed
    if (/error\[E\d+\]/.test(errorLog)) {
      return {
        type: "COMPILE_RUST",
        isInfrastructure: false,
        isCompile: true,
        canSurgicalPatch: false,
        diagnostics: [],
        rawErrors: errorLog,
      };
    }

    if (/syntax error|undefined:/.test(errorLog) && /\.go[:\s]/.test(errorLog)) {
      return {
        type: "COMPILE_GO",
        isInfrastructure: false,
        isCompile: true,
        canSurgicalPatch: false,
        diagnostics: [],
        rawErrors: errorLog,
      };
    }

    if (/Failed to compile|SyntaxError/i.test(errorLog)) {
      return {
        type: "COMPILE_NEXT",
        isInfrastructure: false,
        isCompile: true,
        canSurgicalPatch: false,
        diagnostics: [],
        rawErrors: errorLog,
      };
    }

    return {
      type: "UNKNOWN",
      isInfrastructure: false,
      isCompile: false,
      canSurgicalPatch: false,
      diagnostics: [],
      rawErrors: errorLog,
    };
  }
}
