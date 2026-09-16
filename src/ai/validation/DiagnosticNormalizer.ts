import { authoritySnapshot, captureAuthoritySnapshot, withAuthoritySnapshot } from "../repository/AuthorityWorktree";
import { RepositoryObservationTools } from "../repository/RepositoryObservation";
import { ErrorDiagnosticsParser } from "../../services/surgical-repair.engine";
import { normalizeRepoPath } from "../repository/SemanticContextResolver";
import { RepositoryEvidenceStore, RepositoryEvidence } from "../repository/RepositoryEvidenceStore";

export type NormalizedDiagnosticCategory =
  | "SOURCE_DIAGNOSTIC"
  | "ENVIRONMENT_FAILURE"
  | "DEPENDENCY_FAILURE"
  | "TOOLCHAIN_FAILURE"
  | "UNKNOWN_FAILURE";

export interface NormalizedDiagnostic {
  category: NormalizedDiagnosticCategory;
  filePath?: string;
  line?: number;
  column?: number;
  code?: string;
  message: string;
  command?: string;
  repositoryId?: string;
  workspaceId?: string;
  checkpointId?: string;
  rawTrace?: string;
}

export interface NormalizationOptions {
  workspaceRoot?: string;
  repositoryId?: string;
  workspaceId?: string;
  checkpointId?: string;
  command?: string;
}

const TOOLCHAIN_PATTERNS = [
  /\bcommand not found\b/i,
  /is not recognized as an internal or external command/i,
  /spawn (?:[A-Za-z0-9_.-]+ )?(?:ENOENT|EACCES)/i,
  /\bexecutable not found\b/i,
  /\bbinary not found\b/i,
  /\bexit code 127\b/i,
  /\bexit code 126\b/i,
  /pnpm(?:\.cmd)? not installed/i,
  /npm(?:\.cmd)? not found/i,
  /yarn(?:\.cmd)? not found/i,
  /build command missing/i,
  /cannot be loaded because running scripts is disabled/i,
];

const ENVIRONMENT_PATTERNS = [
  /non-standard "NODE_ENV"/i,
  /invalid NODE_ENV/i,
  /NODE_ENV must be/i,
  /missing required environment variable/i,
  /incompatible environment/i,
  /unsupported environment/i,
  /network unavailable/i,
  /Failed to fetch[^\r\n]*from Google Fonts/i,
  /next\/font(?::|\s).*error[\s\S]*?(?:fetch|Google Fonts|network|ECONNRESET|ENETUNREACH|EAI_AGAIN|getaddrinfo)/i,
  /\bnetwork request failed\b/i,
  /\bgetaddrinfo\b/i,
  /\b(?:fetch|request|network|connect|socket|registry|download|dependency|Google Fonts|fonts\.googleapis\.com)\b[^\r\n]{0,200}\b(?:ECONNRESET|ENETUNREACH|EAI_AGAIN)\b/i,
  /\b(?:ECONNRESET|ENETUNREACH|EAI_AGAIN)\b[^\r\n]{0,200}\b(?:fetch|request|network|connect|socket|registry|download|dependency|Google Fonts|fonts\.googleapis\.com)\b/i,
  /\bENOTFOUND\b/i,
  /\bECONNREFUSED\b/i,
  /\bETIMEDOUT\b/i,
  /permission denied/i,
  /\bEACCES\b/i,
];

const DEPENDENCY_PATTERNS = [
  /Cannot resolve installed dependency because node_modules is absent/i,
  /node_modules (?:is )?(?:missing|absent)/i,
  /ERR_MODULE_NOT_FOUND/i,
  /Cannot find module/i,
  /Module not found/i,
  /package [^ ]+ is missing/i,
  /peer dep/i,
  /is not installed/i,
];

/**
 * DiagnosticNormalizer provides deterministic classification of build/validation errors.
 * Strictly separates SOURCE_DIAGNOSTIC (with deterministic file/line provenance) from
 * ENVIRONMENT_FAILURE, DEPENDENCY_FAILURE, and TOOLCHAIN_FAILURE.
 *
 * Invariant: Environment, dependency, and toolchain failures NEVER generate source file paths
 * or source write authority.
 */
const normalizedReceipts = new WeakMap<object, { workspace: string; revision: string }>();
const diagnosticEvidence = new WeakSet<object>();
export function isTrustedDiagnosticEvidence(value: RepositoryEvidence): boolean { return diagnosticEvidence.has(value); }

export class DiagnosticNormalizer {
  /** Trusted validation boundary: changed worktrees produce advisory diagnostics only. */
  public static async captureValidation<T extends { errors: string }>(workspaceRoot: string, validate: () => Promise<T>): Promise<{ result: T; diagnostics: NormalizedDiagnostic[] }> {
    const before = captureAuthoritySnapshot(workspaceRoot);
    const result = await validate();
    const after = captureAuthoritySnapshot(workspaceRoot);
    const unchanged = before.canonicalRoot === after.canonicalRoot && before.revision === after.revision;
    const diagnostics = this.parse(result.errors).map((diagnostic) => {
      Object.freeze(diagnostic);
      if (unchanged) normalizedReceipts.set(diagnostic, { workspace: workspaceRoot, revision: before.revision });
      return diagnostic;
    });
    return { result, diagnostics };
  }

  /**
   * Normalizes raw error logs into typed diagnostics.
   */
  public static normalize(rawErrorLog: string, options?: NormalizationOptions): NormalizedDiagnostic[] {
    const workspace = options?.workspaceRoot;
    const revision = workspace ? authoritySnapshot(workspace).revision : undefined;
    return this.parse(rawErrorLog, options).map((d) => {
      Object.freeze(d);
      if (workspace && revision) normalizedReceipts.set(d, { workspace, revision });
      return d;
    });
  }

  private static parse(
    rawErrorLog: string,
    options?: NormalizationOptions
  ): NormalizedDiagnostic[] {
    if (!rawErrorLog || !rawErrorLog.trim()) {
      return [];
    }

    const trimmed = rawErrorLog.trim();
    const repoId = options?.repositoryId;
    const wsId = options?.workspaceId;
    const chkId = options?.checkpointId;
    const cmd = options?.command;

    // 1. Toolchain Failure Check
    for (const pat of TOOLCHAIN_PATTERNS) {
      if (pat.test(trimmed)) {
        return [
          {
            category: "TOOLCHAIN_FAILURE",
            filePath: undefined,
            message: trimmed.slice(0, 300).replace(/[\r\n]+/g, " ").trim(),
            command: cmd,
            repositoryId: repoId,
            workspaceId: wsId,
            checkpointId: chkId,
            rawTrace: trimmed,
          },
        ];
      }
    }

    // 2. Environment Failure Check
    for (const pat of ENVIRONMENT_PATTERNS) {
      if (pat.test(trimmed)) {
        return [
          {
            category: "ENVIRONMENT_FAILURE",
            filePath: undefined,
            message: trimmed.slice(0, 300).replace(/[\r\n]+/g, " ").trim(),
            command: cmd,
            repositoryId: repoId,
            workspaceId: wsId,
            checkpointId: chkId,
            rawTrace: trimmed,
          },
        ];
      }
    }

    // 3. Dependency Failure Check (when generic and not a single-file relative import error)
    if (/node_modules (?:is )?(?:missing|absent)/i.test(trimmed) || /Cannot resolve installed dependency because node_modules is absent/i.test(trimmed)) {
      return [
        {
          category: "DEPENDENCY_FAILURE",
          filePath: undefined,
          message: trimmed.slice(0, 300).replace(/[\r\n]+/g, " ").trim(),
          command: cmd,
          repositoryId: repoId,
          workspaceId: wsId,
          checkpointId: chkId,
          rawTrace: trimmed,
        },
      ];
    }

    // 4. Source Diagnostic Extraction via Deterministic Parsers
    const parsedCompilerDiags = ErrorDiagnosticsParser.parse(trimmed);
    const sourceDiags: NormalizedDiagnostic[] = [];

    for (const d of parsedCompilerDiags) {
      if (d.file && typeof d.file === "string") {
        sourceDiags.push({
          category: "SOURCE_DIAGNOSTIC",
          filePath: normalizeRepoPath(d.file),
          line: d.line,
          column: d.column,
          code: d.code,
          message: d.message,
          command: cmd,
          repositoryId: repoId,
          workspaceId: wsId,
          checkpointId: chkId,
          rawTrace: d.rawTrace,
        });
      }
    }

    // Next.js client directive errors: Error: app/page.tsx: ... useState
    const clientDirectiveRegex = /(?:Error:\s*)?([a-zA-Z0-9_\-\/\\.]+\.(?:tsx|ts|jsx|js|mjs|cjs))[:\s\d]*[^\n]*\r?\n([^\n]*(?:useState|useEffect|useContext|"use client"|Client Component|Server Component)[^\n]*)/gi;
    let cdMatch: RegExpExecArray | null;
    while ((cdMatch = clientDirectiveRegex.exec(trimmed)) !== null) {
      const p = normalizeRepoPath(cdMatch[1]);
      if (!sourceDiags.some((s) => s.filePath === p)) {
        sourceDiags.push({
          category: "SOURCE_DIAGNOSTIC",
          filePath: p,
          code: "CLIENT_DIRECTIVE_REQUIRED",
          message: cdMatch[2].replace(/[\r\n]+/g, " ").trim(),
          command: cmd,
          repositoryId: repoId,
          workspaceId: wsId,
          checkpointId: chkId,
          rawTrace: cdMatch[0],
        });
      }
    }

    if (sourceDiags.length > 0) {
      return sourceDiags;
    }

    // Check if it's missing package dependency
    for (const pat of DEPENDENCY_PATTERNS) {
      if (pat.test(trimmed)) {
        return [
          {
            category: "DEPENDENCY_FAILURE",
            filePath: undefined,
            message: trimmed.slice(0, 300).replace(/[\r\n]+/g, " ").trim(),
            command: cmd,
            repositoryId: repoId,
            workspaceId: wsId,
            checkpointId: chkId,
            rawTrace: trimmed,
          },
        ];
      }
    }

    // 5. Fallback: Unknown failure
    return [
      {
        category: "UNKNOWN_FAILURE",
        filePath: undefined,
        message: trimmed.slice(0, 300).replace(/[\r\n]+/g, " ").trim(),
        command: cmd,
        repositoryId: repoId,
        workspaceId: wsId,
        checkpointId: chkId,
        rawTrace: trimmed,
      },
    ];
  }

  /**
   * Ingests normalized source diagnostics into the RepositoryEvidenceStore.
   * STRICT INVARIANT: Only SOURCE_DIAGNOSTIC with non-empty filePath can generate
   * DIAGNOSTIC evidence. Environment, dependency, and toolchain failures are ignored.
   */
  public static ingestSourceDiagnostics(
    diagnostics: NormalizedDiagnostic[],
    evidenceStore: RepositoryEvidenceStore,
    checkpointId?: string
  ): RepositoryEvidence[] {
    const workspace = evidenceStore.getDefaultWorkspace();
    if (!workspace || !evidenceStore.getCanonicalWorkspaceRoot()) return [];
    return withAuthoritySnapshot(workspace, () => this.ingestBatch(diagnostics, evidenceStore, checkpointId));
  }

  private static ingestBatch(diagnostics: NormalizedDiagnostic[], evidenceStore: RepositoryEvidenceStore, checkpointId?: string): RepositoryEvidence[] {
    const added: RepositoryEvidence[] = [];

    for (const d of diagnostics) {
      if (d.category !== "SOURCE_DIAGNOSTIC" || !d.filePath) {
        continue;
      }

      const workspace = evidenceStore.getDefaultWorkspace();
      const normalized = normalizedReceipts.get(d);
      if (!workspace || normalized?.workspace !== workspace || normalized.revision !== authoritySnapshot(workspace).revision) continue;
      const receipt = RepositoryObservationTools.observeDiagnostic(evidenceStore.getRepositoryId(), workspace, d.filePath, {
        code: d.code, line: d.line, column: d.column, checkpointId: checkpointId || d.checkpointId, stale: false,
      });
      if (!receipt) continue;
      const evidence = evidenceStore.recordObservation(receipt);
      if (!evidence) continue;
      diagnosticEvidence.add(evidence);

      added.push(evidence);
    }

    return added;
  }
}
