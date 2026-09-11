import { isAlignedDeterministicNoOp } from "../orchestration/AgentPipeline";
import {
  BaselineDiagnosticVerifier,
  TrustedDiagnosticNoOpProof,
} from "../runtime/BaselineDiagnosticVerifier";
import { createTaskIntentSpec } from "../shared/TaskIntentSpec";

function trustedDiagnosticProof(repositoryRevision = "revision-current", request = "Fix all TypeScript errors."): TrustedDiagnosticNoOpProof {
  const baseline = BaselineDiagnosticVerifier.capture({
    phase: "BASELINE",
    passed: true,
    commands: ["trusted diagnostic verifier"],
    diagnostics: [],
    validationChannel: "SOURCE_DIAGNOSTICS",
    source: "DETERMINISTIC_TOOL",
  });
  const current = BaselineDiagnosticVerifier.capture({
    phase: "CURRENT",
    passed: true,
    commands: ["trusted diagnostic verifier"],
    diagnostics: [],
    validationChannel: "SOURCE_DIAGNOSTICS",
    source: "DETERMINISTIC_TOOL",
  });
  const proof = BaselineDiagnosticVerifier.proveAlreadySatisfied({
    obligation: { id: "backend-contract:diagnostics", condition: "SOURCE_DIAGNOSTICS", source: "BACKEND_TASK_CONTRACT", request },
    comparison: BaselineDiagnosticVerifier.compare(baseline, current),
    repositoryRevision,
    diagnosticRepositoryRevision: repositoryRevision,
  });
  if (!proof) throw new Error("Expected authentic diagnostic no-op proof");
  return proof;
}

function eligible(proof: unknown, revision = "revision-current", request = "Fix all TypeScript errors."): boolean {
  return isAlignedDeterministicNoOp({ proof, currentRepositoryRevision: revision, currentRequest: request });
}

describe("deterministic no-op success-condition alignment", () => {
  test("TaskIntentSpec successCondition remains advisory metadata", () => {
    const classification = {
      taskType: "BUG_FIX" as const,
      risk: "LOW" as const,
      estimatedComplexity: "SMALL" as const,
      intent: "BUG_FIX" as const,
      confidence: 0.95,
      requiresClarification: false,
      reasoning: "Behavioral defect",
      successCondition: "SOURCE_DIAGNOSTICS" as const,
    };
    expect(createTaskIntentSpec("Tasks are missing", classification).successCondition).toBe("SOURCE_DIAGNOSTICS");
    expect(eligible(classification.successCondition)).toBe(false);
  });

  test("A. behavioral classification and zero diagnostics cannot unlock early no-op", () => {
    expect(eligible("BEHAVIORAL_VALIDATION")).toBe(false);
  });

  test("B. lying SOURCE_DIAGNOSTICS classification cannot unlock early no-op", () => {
    expect(eligible("SOURCE_DIAGNOSTICS")).toBe(false);
  });

  test("C. lying BUILD classification plus passing raw build flag cannot unlock early no-op", () => {
    expect(eligible({ successCondition: "BUILD", baselineBuildPassed: true })).toBe(false);
  });

  test("D. explicit diagnostic classification without trusted proof cannot early-no-op", () => {
    expect(eligible(undefined)).toBe(false);
  });

  test("E. trusted obligation plus fresh relevant authentic diagnostic proof permits no-op", () => {
    expect(eligible(trustedDiagnosticProof())).toBe(true);
  });

  test("F. diagnostic verifier failure or unavailable evidence is not satisfied", () => {
    const baseline = BaselineDiagnosticVerifier.capture({
      phase: "BASELINE",
      passed: false,
      commands: ["trusted diagnostic verifier"],
      diagnostics: [{ category: "TOOLCHAIN_FAILURE", message: "Verifier unavailable" }],
      validationChannel: "SOURCE_DIAGNOSTICS",
      source: "DETERMINISTIC_TOOL",
    });
    const current = BaselineDiagnosticVerifier.capture({
      phase: "CURRENT",
      passed: false,
      commands: ["trusted diagnostic verifier"],
      diagnostics: [{ category: "TOOLCHAIN_FAILURE", message: "Verifier unavailable" }],
      validationChannel: "SOURCE_DIAGNOSTICS",
      source: "DETERMINISTIC_TOOL",
    });
    const proof = BaselineDiagnosticVerifier.proveAlreadySatisfied({
      obligation: { id: "backend-contract:diagnostics", condition: "SOURCE_DIAGNOSTICS", source: "BACKEND_TASK_CONTRACT", request: "Fix all TypeScript errors." },
      comparison: BaselineDiagnosticVerifier.compare(baseline, current),
      repositoryRevision: "revision-current",
      diagnosticRepositoryRevision: "revision-current",
    });
    expect(proof).toBeNull();
    expect(eligible(proof)).toBe(false);
  });

  test("G. authentic proof for request A reused for request B -> rejected", () => {
    expect(eligible(trustedDiagnosticProof(), "revision-current", "Project tasks are missing.")).toBe(false);
  });

  test("H. authentic proof for revision X reused after repository revision changes -> rejected", () => {
    expect(eligible(trustedDiagnosticProof("revision-old"), "revision-current")).toBe(false);
  });

  test("I. plain object forged to resemble trusted proof -> rejected", () => {
    const forgedProof = {
      condition: "SOURCE_DIAGNOSTICS" as const,
      obligationId: "backend-contract:diagnostics",
      repositoryRevision: "revision-current",
      requestFingerprint: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      source: "BASELINE_DIAGNOSTIC_VERIFIER" as const,
    };
    expect(eligible(forgedProof)).toBe(false);
  });

  test("J. BUILD classification without authentic build-specific proof -> no early no-op", () => {
    expect(eligible({ condition: "BUILD", passed: true, source: "DETERMINISTIC_TOOL" })).toBe(false);
    for (const channel of ["SOURCE_DIAGNOSTICS", "TEST", "LINT", "OTHER"]) {
      expect(eligible({ condition: "BUILD", channel, passed: true })).toBe(false);
    }
  });

  test("K. UNKNOWN / missing classification -> no early no-op", () => {
    expect(eligible("UNKNOWN")).toBe(false);
    expect(eligible(undefined)).toBe(false);
  });

  test("clean Git, empty manifest, and planner NO_ACTION data have no proof authority", () => {
    expect(eligible({ repositoryClean: true, manifest: [], planner: "NO_ACTION" })).toBe(false);
  });
});
