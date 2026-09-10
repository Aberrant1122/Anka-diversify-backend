import path from "path";

export type DiagnosticBaselinePhase = "BASELINE" | "CURRENT";
export type BaselineDiagnosticStatus = "UNCHANGED" | "RESOLVED";
export type CurrentDiagnosticClassification = "PRE_EXISTING" | "INTRODUCED";

export interface DiagnosticFactInput {
  category?: string;
  errorType?: string;
  filePath?: string;
  line?: number;
  column?: number;
  code?: string;
  errorCode?: string;
  message: string;
  symbolName?: string;
  fingerprint?: string;
  origin?: string;
}

export interface DeterministicDiagnosticFact {
  identity: string;
  category: string;
  filePath?: string;
  line?: number;
  column?: number;
  code?: string;
  message: string;
  symbolName?: string;
}

export interface DiagnosticValidationSnapshot {
  phase: DiagnosticBaselinePhase;
  passed: boolean;
  commands: readonly string[];
  diagnostics: readonly DeterministicDiagnosticFact[];
  source: "DETERMINISTIC_TOOL";
}

export interface BaselineDiagnosticOutcome {
  status: BaselineDiagnosticStatus;
  diagnostic: DeterministicDiagnosticFact;
}

export interface CurrentDiagnosticOutcome {
  classification: CurrentDiagnosticClassification;
  diagnostic: DeterministicDiagnosticFact;
}

export interface DiagnosticBaselineComparison {
  baseline: DiagnosticValidationSnapshot;
  current: DiagnosticValidationSnapshot;
  baselineOutcomes: readonly BaselineDiagnosticOutcome[];
  currentOutcomes: readonly CurrentDiagnosticOutcome[];
  counts: Readonly<Record<BaselineDiagnosticStatus | CurrentDiagnosticClassification, number>>;
  verifiedSuccess: boolean;
  source: "DETERMINISTIC_COMPARISON";
}

export interface CaptureDiagnosticSnapshotInput {
  phase: DiagnosticBaselinePhase;
  passed: boolean;
  commands: string[];
  diagnostics: DiagnosticFactInput[];
  repositoryRoot?: string;
  source: "DETERMINISTIC_TOOL";
}

const ANSI_ESCAPE = /\u001b\[[0-?]*[ -/]*[@-~]/g;

function normalizeOptionalToken(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function isWithinRoot(candidate: string, repositoryRoot: string): boolean {
  const relative = path.relative(repositoryRoot, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function normalizeDiagnosticPath(value: string | undefined, repositoryRoot?: string): string | undefined {
  const token = normalizeOptionalToken(value);
  if (!token) return undefined;

  const withoutFileScheme = token.replace(/^file:\/\//i, "");
  let normalized: string;
  if (path.isAbsolute(withoutFileScheme)) {
    const absolute = path.resolve(withoutFileScheme);
    normalized = repositoryRoot && isWithinRoot(absolute, path.resolve(repositoryRoot))
      ? path.relative(path.resolve(repositoryRoot), absolute)
      : absolute;
  } else {
    normalized = path.normalize(withoutFileScheme.replace(/^\.([\\/])/, ""));
  }

  return normalized.replace(/\\/g, "/");
}

function normalizeMessage(message: string, filePath?: string, repositoryRoot?: string): string {
  let normalized = message.replace(ANSI_ESCAPE, "").replace(/\\/g, "/");
  if (repositoryRoot) {
    const root = path.resolve(repositoryRoot).replace(/\\/g, "/").replace(/\/$/, "");
    normalized = normalized.split(root).join("<repo>");
  }
  normalized = normalized.replace(/[\r\n\t ]+/g, " ").trim();

  const location = normalized.match(/^(.+?)(?:\(\d+,\d+\)|:\d+(?::\d+)?):\s*(.+)$/);
  if (location && filePath) {
    const locationPath = normalizeDiagnosticPath(location[1].replace(/^<repo>\//, ""), repositoryRoot);
    if (locationPath === filePath) normalized = location[2].trim();
  }
  return normalized;
}

function freezeDiagnostic(diagnostic: DeterministicDiagnosticFact): DeterministicDiagnosticFact {
  return Object.freeze(diagnostic);
}

function freezeSnapshot(snapshot: DiagnosticValidationSnapshot): DiagnosticValidationSnapshot {
  snapshot.diagnostics.forEach(Object.freeze);
  Object.freeze(snapshot.commands);
  Object.freeze(snapshot.diagnostics);
  return Object.freeze(snapshot);
}

/**
 * Compares validation facts without trusting caller fingerprints, origins, ordering, or model labels.
 * Identity deliberately excludes line/column while retaining category, path, code, symbol, and message.
 */
export class BaselineDiagnosticVerifier {
  public static capture(input: CaptureDiagnosticSnapshotInput): DiagnosticValidationSnapshot {
    if (input.source !== "DETERMINISTIC_TOOL") {
      throw new Error("Diagnostic snapshots require deterministic tool provenance");
    }
    if (typeof input.passed !== "boolean") throw new Error("Diagnostic snapshot passed must be boolean");

    if (input.passed && input.diagnostics.length > 0) {
      throw new Error("Passing diagnostic snapshots cannot contain failure diagnostics");
    }
    const diagnosticInputs = !input.passed && input.diagnostics.length === 0
      ? [{ category: "UNKNOWN_FAILURE", message: "Deterministic validation failed without a diagnostic." }]
      : input.diagnostics;
    const diagnostics = diagnosticInputs.map((diagnostic) => this.canonicalize(diagnostic, input.repositoryRoot));
    diagnostics.sort((left, right) => left.identity.localeCompare(right.identity));
    return freezeSnapshot({
      phase: input.phase,
      passed: input.passed,
      commands: Object.freeze(input.commands.map((command) => command.trim()).filter(Boolean).sort()),
      diagnostics: Object.freeze(diagnostics),
      source: "DETERMINISTIC_TOOL",
    });
  }

  public static identityOf(diagnostic: DiagnosticFactInput, repositoryRoot?: string): string {
    return this.canonicalize(diagnostic, repositoryRoot).identity;
  }

  public static compare(
    baseline: DiagnosticValidationSnapshot,
    current: DiagnosticValidationSnapshot,
  ): DiagnosticBaselineComparison {
    if (baseline.source !== "DETERMINISTIC_TOOL" || current.source !== "DETERMINISTIC_TOOL") {
      throw new Error("Diagnostic comparison requires deterministic tool snapshots");
    }
    if (baseline.phase !== "BASELINE" || current.phase !== "CURRENT") {
      throw new Error("Diagnostic comparison requires BASELINE then CURRENT snapshots");
    }

    const baselineDiagnostics = baseline.diagnostics.map((diagnostic) => this.canonicalize(diagnostic));
    const currentDiagnostics = current.diagnostics.map((diagnostic) => this.canonicalize(diagnostic));
    baselineDiagnostics.sort((left, right) => left.identity.localeCompare(right.identity));
    currentDiagnostics.sort((left, right) => left.identity.localeCompare(right.identity));

    const remainingCurrent = new Map<string, DeterministicDiagnosticFact[]>();
    for (const diagnostic of currentDiagnostics) {
      const bucket = remainingCurrent.get(diagnostic.identity) ?? [];
      bucket.push(diagnostic);
      remainingCurrent.set(diagnostic.identity, bucket);
    }

    const baselineOutcomes: BaselineDiagnosticOutcome[] = [];
    const preExisting: DeterministicDiagnosticFact[] = [];
    for (const diagnostic of baselineDiagnostics) {
      const bucket = remainingCurrent.get(diagnostic.identity);
      const match = bucket?.shift();
      if (bucket && bucket.length === 0) remainingCurrent.delete(diagnostic.identity);
      baselineOutcomes.push(Object.freeze({
        status: match ? "UNCHANGED" : "RESOLVED",
        diagnostic,
      }));
      if (match) preExisting.push(match);
    }

    const introduced = [...remainingCurrent.values()].flat();
    const currentOutcomes: CurrentDiagnosticOutcome[] = [
      ...preExisting.map((diagnostic) => Object.freeze({ classification: "PRE_EXISTING" as const, diagnostic })),
      ...introduced.map((diagnostic) => Object.freeze({ classification: "INTRODUCED" as const, diagnostic })),
    ].sort((left, right) => left.diagnostic.identity.localeCompare(right.diagnostic.identity));

    const counts = Object.freeze({
      PRE_EXISTING: preExisting.length,
      INTRODUCED: introduced.length,
      RESOLVED: baselineOutcomes.filter((outcome) => outcome.status === "RESOLVED").length,
      UNCHANGED: baselineOutcomes.filter((outcome) => outcome.status === "UNCHANGED").length,
    });
    baselineOutcomes.sort((left, right) => left.diagnostic.identity.localeCompare(right.diagnostic.identity));
    baselineOutcomes.forEach(Object.freeze);
    currentOutcomes.forEach(Object.freeze);
    Object.freeze(baselineOutcomes);
    Object.freeze(currentOutcomes);

    return Object.freeze({
      baseline,
      current,
      baselineOutcomes,
      currentOutcomes,
      counts,
      verifiedSuccess: introduced.length === 0,
      source: "DETERMINISTIC_COMPARISON",
    });
  }

  private static canonicalize(
    diagnostic: DiagnosticFactInput,
    repositoryRoot?: string,
  ): DeterministicDiagnosticFact {
    if (!diagnostic || typeof diagnostic.message !== "string" || !diagnostic.message.trim()) {
      throw new Error("Diagnostic message must be a non-empty string");
    }
    const category = normalizeOptionalToken(diagnostic.category ?? diagnostic.errorType)?.toUpperCase() ?? "UNKNOWN";
    const filePath = normalizeDiagnosticPath(diagnostic.filePath, repositoryRoot);
    const code = normalizeOptionalToken(diagnostic.code ?? diagnostic.errorCode)?.toUpperCase();
    const symbolName = normalizeOptionalToken(diagnostic.symbolName);
    const message = normalizeMessage(diagnostic.message, filePath, repositoryRoot);
    const identity = JSON.stringify([category, filePath ?? "", code ?? "", symbolName ?? "", message]);

    return freezeDiagnostic({
      identity,
      category,
      ...(filePath ? { filePath } : {}),
      ...(Number.isInteger(diagnostic.line) && diagnostic.line! > 0 ? { line: diagnostic.line } : {}),
      ...(Number.isInteger(diagnostic.column) && diagnostic.column! > 0 ? { column: diagnostic.column } : {}),
      ...(code ? { code } : {}),
      message,
      ...(symbolName ? { symbolName } : {}),
    });
  }
}
