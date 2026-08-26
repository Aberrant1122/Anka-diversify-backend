import { ErrorDiagnosticsParser, DiagnosticError } from "../../services/surgical-repair.engine";

// ─── Error Classification Types ────────────────────────────────────────────────

export type ErrorType =
  | "COMPILE_TS"
  | "COMPILE_ANGULAR"
  | "COMPILE_NEXT"
  | "COMPILE_RUST"
  | "COMPILE_GO"
  | "MISSING_DEP"
  | "ENVIRONMENT"
  | "TEST_FAILURE"
  | "LINT"
  | "INFRA"
  | "UNKNOWN";

export interface ErrorClassification {
  type: ErrorType;
  isInfrastructure: boolean;
  isCompile: boolean;
  canSurgicalPatch: boolean;
  diagnostics: DiagnosticError[];
  rawErrors: string;
  origin?: "BASELINE" | "CURRENT_TASK";
}

// ─── Pattern Definitions ──────────────────────────────────────────────────────

const MISSING_DEP_PATTERNS = [
  /Cannot find module/i,
  /Module not found/i,
  /ERR_MODULE_NOT_FOUND/i,
  /peer dep/i,
  /is not installed/i,
  /Could not resolve/i,
  /package [^ ]+ is missing/i,
];

const ENVIRONMENT_PATTERNS = [
  /non-standard "NODE_ENV"/i,
  /invalid NODE_ENV/i,
  /NODE_ENV must be/i,
  /missing required environment variable/i,
  /incompatible environment/i,
  /unsupported environment/i,
];

const TS_COMPILER_PATTERNS = [
  /\berror TS\d+\b/i,
  /Failed to type check/i,
  /\bType error:\s*/i,
  /\([0-9]+,[0-9]+\):\s*error\s*TS\d+/i,
  /:[0-9]+:[0-9]+\s*-\s*error\s*TS\d+/i,
];

const NEXT_COMPILER_PATTERNS = [
  /Turbopack build failed/i,
  /Build error occurred/i,
  /Failed to compile/i,
  /\bSyntaxError\b/i,
  /You're importing a module that depends on.*only available in Client Components/i,
  /React Server Component/i,
];

const TEST_FAILURE_PATTERNS = [
  /^FAIL /m,
  /Jest failed/i,
  /Tests failed/i,
  /AssertionError/i,
];

const LINT_PATTERNS = [
  /ESLint:/i,
  /eslint --fix/i,
  /linting error/i,
];

const TRUE_INFRA_PATTERNS = [
  /\bENOENT\b/i,
  /\bEACCES\b/i,
  /\bcommand not found\b/i,
  /timed out/i,
  /\bexit code 127\b/,
  /\bexit code 126\b/,
  /is not recognized as an internal or external command/i,
  /cannot be loaded because running scripts is disabled/i,
  /spawn (?:[A-Za-z0-9_.-]+ )?(?:ENOENT|EACCES)/i,
  /executable not found/i,
  /binary not found/i,
];

export class ErrorClassifier {
  /**
   * Classify a raw error string into a structured ErrorClassification with strict
   * ordered specificity: high-specificity source/compiler errors outrank generic shell text.
   *
   * Priority Order:
   * 1. MISSING_DEP
   * 2. ENVIRONMENT
   * 3. COMPILE_TS (TypeScript diagnostics / typecheck failures)
   * 4. COMPILE_NEXT / COMPILE_ANGULAR / COMPILE_RUST / COMPILE_GO
   * 5. TEST_FAILURE
   * 6. LINT
   * 7. True tool/runtime INFRA
   * 8. UNKNOWN
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

    // 1. Missing dependency — npm install needed, not code patch
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

    // 2. Environment errors — child process / NODE_ENV policy
    if (ENVIRONMENT_PATTERNS.some((p) => p.test(errorLog))) {
      return {
        type: "ENVIRONMENT",
        isInfrastructure: true,
        isCompile: false,
        canSurgicalPatch: false,
        diagnostics: [],
        rawErrors: errorLog,
      };
    }

    // 3. Structured Diagnostics Parsing
    const diagnostics = ErrorDiagnosticsParser.parse(errorLog);
    const hasTSDiagnostic = diagnostics.some((d) => d.code && /^TS\d+$/.test(d.code));
    const hasNGDiagnostic = diagnostics.some((d) => d.code && /^NG\d+$/.test(d.code));

    // 3A. TypeScript Compiler Errors (High Priority Source Category)
    if (hasTSDiagnostic || TS_COMPILER_PATTERNS.some((p) => p.test(errorLog))) {
      return {
        type: "COMPILE_TS",
        isInfrastructure: false,
        isCompile: true,
        canSurgicalPatch: true,
        diagnostics,
        rawErrors: errorLog,
      };
    }

    // 4A. Angular Compiler Errors
    if (hasNGDiagnostic) {
      return {
        type: "COMPILE_ANGULAR",
        isInfrastructure: false,
        isCompile: true,
        canSurgicalPatch: true,
        diagnostics,
        rawErrors: errorLog,
      };
    }

    // 4B. Rust Compiler Errors
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

    // 4C. Go Compiler Errors
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

    // 4D. Next.js / Webpack / Turbopack Compiler Errors
    if (diagnostics.length > 0 || NEXT_COMPILER_PATTERNS.some((p) => p.test(errorLog))) {
      return {
        type: "COMPILE_NEXT",
        isInfrastructure: false,
        isCompile: true,
        canSurgicalPatch: true,
        diagnostics,
        rawErrors: errorLog,
      };
    }

    // 5. Test Failures
    if (TEST_FAILURE_PATTERNS.some((p) => p.test(errorLog))) {
      return {
        type: "TEST_FAILURE",
        isInfrastructure: false,
        isCompile: false,
        canSurgicalPatch: false,
        diagnostics: [],
        rawErrors: errorLog,
      };
    }

    // 6. Lint Errors
    if (LINT_PATTERNS.some((p) => p.test(errorLog))) {
      return {
        type: "LINT",
        isInfrastructure: false,
        isCompile: false,
        canSurgicalPatch: false,
        diagnostics: [],
        rawErrors: errorLog,
      };
    }

    // 7. True Tool / Runtime Infrastructure Errors
    if (TRUE_INFRA_PATTERNS.some((p) => p.test(errorLog))) {
      return {
        type: "INFRA",
        isInfrastructure: true,
        isCompile: false,
        canSurgicalPatch: false,
        diagnostics: [],
        rawErrors: errorLog,
      };
    }

    // 8. Default fallback
    return {
      type: "UNKNOWN",
      isInfrastructure: false,
      isCompile: false,
      canSurgicalPatch: false,
      diagnostics: [],
      rawErrors: errorLog,
    };
  }

  /**
   * Extracts external missing package names from build/compiler/bundler error logs.
   */
  public static extractMissingPackageNames(errorLog: string): string[] {
    if (!errorLog) return [];
    const packages = new Set<string>();

    const patterns = [
      /Cannot find module ['"]([^'"]+)['"]/gi,
      /Module not found: Can't resolve ['"]([^'"]+)['"]/gi,
      /Cannot resolve ['"]([^'"]+)['"]/gi,
      /Package ['"]([^'"]+)['"] is missing/gi,
      /Package ['"]([^'"]+)['"] is not installed/gi,
      /Could not resolve ['"]([^'"]+)['"]/gi,
      /ERR_MODULE_NOT_FOUND.*['"]([^'"]+)['"]/gi,
    ];

    for (const pattern of patterns) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(errorLog)) !== null) {
        const rawPkg = match[1]?.trim();
        if (rawPkg && !rawPkg.startsWith(".") && !rawPkg.startsWith("/") && !rawPkg.startsWith("\\")) {
          const parts = rawPkg.split("/");
          if (rawPkg.startsWith("@")) {
            if (parts.length >= 2) {
              packages.add(`${parts[0]}/${parts[1]}`);
            } else {
              packages.add(rawPkg);
            }
          } else {
            packages.add(parts[0]);
          }
        }
      }
    }

    return Array.from(packages);
  }
}
