import path from "path";
import {
  BaselineDiagnosticVerifier,
  DiagnosticFactInput,
} from "../runtime/BaselineDiagnosticVerifier";

const repositoryRoot = path.resolve("fixture-repository");

function diagnostic(overrides: Partial<DiagnosticFactInput> = {}): DiagnosticFactInput {
  return {
    errorType: "COMPILE_TS",
    filePath: "src/example.ts",
    line: 4,
    column: 2,
    errorCode: "TS2304",
    message: "Cannot find name 'missingValue'.",
    symbolName: "missingValue",
    ...overrides,
  };
}

function capture(
  phase: "BASELINE" | "CURRENT",
  diagnostics: DiagnosticFactInput[],
) {
  return BaselineDiagnosticVerifier.capture({
    phase,
    passed: diagnostics.length === 0,
    commands: ["npx tsc --noEmit"],
    diagnostics,
    repositoryRoot,
    source: "DETERMINISTIC_TOOL",
  });
}

describe("Checkpoint 3B baseline diagnostic verifier", () => {
  test("identical baseline/current diagnostics are unchanged and pre-existing", () => {
    const result = BaselineDiagnosticVerifier.compare(
      capture("BASELINE", [diagnostic()]),
      capture("CURRENT", [diagnostic({ line: 99, column: 8 })]),
    );

    expect(result.baselineOutcomes.map((outcome) => outcome.status)).toEqual(["UNCHANGED"]);
    expect(result.currentOutcomes.map((outcome) => outcome.classification)).toEqual(["PRE_EXISTING"]);
    expect(result.verifiedSuccess).toBe(true);
  });

  test("new diagnostics are introduced and block verified success", () => {
    const result = BaselineDiagnosticVerifier.compare(
      capture("BASELINE", []),
      capture("CURRENT", [diagnostic()]),
    );

    expect(result.counts).toEqual({ PRE_EXISTING: 0, INTRODUCED: 1, RESOLVED: 0, UNCHANGED: 0 });
    expect(result.verifiedSuccess).toBe(false);
  });

  test("a missing current diagnostic is resolved", () => {
    const result = BaselineDiagnosticVerifier.compare(
      capture("BASELINE", [diagnostic()]),
      capture("CURRENT", []),
    );

    expect(result.baselineOutcomes[0].status).toBe("RESOLVED");
    expect(result.counts.RESOLVED).toBe(1);
  });

  test("multiple diagnostics compare deterministically independent of ordering", () => {
    const first = diagnostic();
    const second = diagnostic({ filePath: "src/other.ts", errorCode: "TS2322", message: "Type 'string' is not assignable to type 'number'.", symbolName: undefined });
    const forward = BaselineDiagnosticVerifier.compare(
      capture("BASELINE", [first, second]),
      capture("CURRENT", [second, first]),
    );
    const reverse = BaselineDiagnosticVerifier.compare(
      capture("BASELINE", [second, first]),
      capture("CURRENT", [first, second]),
    );

    expect(forward.counts).toEqual({ PRE_EXISTING: 2, INTRODUCED: 0, RESOLVED: 0, UNCHANGED: 2 });
    expect(forward).toEqual(reverse);
  });

  test("materially different diagnostics are not merged", () => {
    const result = BaselineDiagnosticVerifier.compare(
      capture("BASELINE", [diagnostic()]),
      capture("CURRENT", [diagnostic({ message: "Cannot find name 'differentValue'.", symbolName: "differentValue" })]),
    );

    expect(result.counts).toEqual({ PRE_EXISTING: 0, INTRODUCED: 1, RESOLVED: 1, UNCHANGED: 0 });
  });

  test("path normalization equates only paths safely inside the known repository root", () => {
    const absoluteInside = path.join(repositoryRoot, "src", "example.ts");
    const inside = BaselineDiagnosticVerifier.compare(
      capture("BASELINE", [diagnostic({ filePath: absoluteInside })]),
      capture("CURRENT", [diagnostic({ filePath: "./src\\example.ts" })]),
    );
    const outside = BaselineDiagnosticVerifier.compare(
      capture("BASELINE", [diagnostic({ filePath: path.resolve("outside", "example.ts") })]),
      capture("CURRENT", [diagnostic({ filePath: "src/example.ts" })]),
    );

    expect(inside.counts.UNCHANGED).toBe(1);
    expect(outside.counts).toMatchObject({ INTRODUCED: 1, RESOLVED: 1 });
  });

  test("caller fingerprints and model-like origin labels cannot override classification", () => {
    const baseline = diagnostic({ fingerprint: "trusted-looking", origin: "BASELINE" });
    const current = diagnostic({
      filePath: "src/new.ts",
      message: "New failure",
      symbolName: undefined,
      fingerprint: "trusted-looking",
      origin: "BASELINE",
    });
    const result = BaselineDiagnosticVerifier.compare(
      capture("BASELINE", [baseline]),
      capture("CURRENT", [current]),
    );

    expect(result.currentOutcomes[0].classification).toBe("INTRODUCED");
    expect(result.verifiedSuccess).toBe(false);
  });

  test("caller-supplied canonical identity data cannot forge pre-existing status", () => {
    const baseline = capture("BASELINE", [diagnostic()]);
    const current = capture("CURRENT", [diagnostic({ filePath: "src/new.ts", message: "New failure" })]);
    const forgedCurrent = {
      ...current,
      diagnostics: [{ ...current.diagnostics[0], identity: baseline.diagnostics[0].identity }],
    };
    const result = BaselineDiagnosticVerifier.compare(baseline, forgedCurrent);

    expect(result.currentOutcomes[0].classification).toBe("INTRODUCED");
  });

  test("empty baseline never produces pre-existing classifications", () => {
    const result = BaselineDiagnosticVerifier.compare(
      capture("BASELINE", []),
      capture("CURRENT", [diagnostic(), diagnostic({ filePath: "src/two.ts" })]),
    );

    expect(result.currentOutcomes.every((outcome) => outcome.classification === "INTRODUCED")).toBe(true);
  });

  test("an unparsed current tool failure is still introduced against a clean baseline", () => {
    const current = BaselineDiagnosticVerifier.capture({
      phase: "CURRENT",
      passed: false,
      commands: ["npx tsc --noEmit"],
      diagnostics: [],
      repositoryRoot,
      source: "DETERMINISTIC_TOOL",
    });
    const result = BaselineDiagnosticVerifier.compare(capture("BASELINE", []), current);

    expect(result.counts.INTRODUCED).toBe(1);
    expect(result.verifiedSuccess).toBe(false);
  });
});
