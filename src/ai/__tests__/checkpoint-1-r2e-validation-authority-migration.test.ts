import { LLMGateway } from "../gateway/LLMGateway";
import {
  LLMNetworkError,
  LLMProviderError,
  LLMRateLimitError,
  LLMTimeoutError,
  LLMTruncationError,
} from "../gateway/LLMError";
import { PipelineStages } from "../gateway/PipelineStage";
import { ValidationDetector } from "../validation/ValidationDetector";
import { ValidationRunner } from "../validation/ValidationRunner";
import { SelfHealingEngine } from "../repair/SelfHealingEngine";
import { ErrorClassifier } from "../validation/ErrorClassifier";
import { StaticValidationEngine } from "../../services/static-validator.engine";

function gatewayResult<T>(content: T, stage: string) {
  return { content, rawResponse: {}, finishReason: "stop", latencyMs: 1, model: "gpt-4o", stage } as any;
}

const change = {
  path: "config.json",
  content: "{}",
  action: "modify" as const,
  description: "Update configuration",
};

const runnerPassOpinion = {
  suspectedCriticalErrors: false,
  findings: [],
  analysis: "No suspected issues.",
  recommendations: ["Run the compiler."],
};

const detectorPassOpinion = {
  findings: [{ id: "feature", label: "Feature", assessment: "PASS" as const, details: "Appears integrated." }],
  analysis: "The feature appears complete.",
  recommendations: ["Run integration tests."],
};

describe("Checkpoint 1 R2E validation authority migration", () => {
  afterEach(() => jest.restoreAllMocks());

  test("ValidationRunner routes advisory review through STATIC_REVIEW and model PASS cannot establish success", async () => {
    const gatewaySpy = jest.spyOn(LLMGateway.getInstance(), "callStructured")
      .mockResolvedValue(gatewayResult(runnerPassOpinion, PipelineStages.STATIC_REVIEW));

    const result = await ValidationRunner.selfReviewChanges([change]);

    expect(result.success).toBe(false);
    expect(result.errors).toContain("validation remains unverified");
    expect(result.warnings?.join("\n")).toContain("Model advisory");
    expect(gatewaySpy).toHaveBeenCalledTimes(1);
    expect(gatewaySpy.mock.calls[0][0].stage).toBe(PipelineStages.STATIC_REVIEW);
    expect(gatewaySpy.mock.calls[0][0].schema.validate({ ...runnerPassOpinion, validationPassed: true }).valid).toBe(false);
  });

  test("ValidationRunner model FAIL remains advisory rather than deterministic failure", async () => {
    jest.spyOn(LLMGateway.getInstance(), "callStructured").mockResolvedValue(gatewayResult({
      suspectedCriticalErrors: true,
      findings: ["Possible syntax error"],
      analysis: "Compilation may fail.",
      recommendations: ["Run tsc."],
    }, PipelineStages.STATIC_REVIEW));

    const result = await ValidationRunner.selfReviewChanges([change]);

    expect(result.success).toBe(false);
    expect(result.errors).not.toContain("Possible syntax error");
    expect(result.warnings?.join("\n")).toContain("Possible syntax error");
  });

  test.each([
    new LLMTruncationError("truncated", { stage: PipelineStages.STATIC_REVIEW }),
    new LLMTimeoutError("timeout", { stage: PipelineStages.STATIC_REVIEW }),
    new LLMRateLimitError("rate limited", { stage: PipelineStages.STATIC_REVIEW }),
    new LLMNetworkError("network failure", { stage: PipelineStages.STATIC_REVIEW }),
    new LLMProviderError("provider 503", { stage: PipelineStages.STATIC_REVIEW, status: 503 }, true),
  ])("ValidationRunner model technical failure cannot create success", async (error) => {
    jest.spyOn(LLMGateway.getInstance(), "callStructured").mockRejectedValue(error);

    const result = await ValidationRunner.selfReviewChanges([change]);

    expect(result.success).toBe(false);
    expect(result.errors).toContain("validation remains unverified");
    expect(result.warnings).toEqual(["Advisory model review was unavailable."]);
  });

  test("ValidationRunner schema rejects malformed and authority-like output", async () => {
    const gatewaySpy = jest.spyOn(LLMGateway.getInstance(), "callStructured").mockImplementation(async (options: any) => {
      expect(options.schema.validate({ suspectedCriticalErrors: false, findings: [42], analysis: "", recommendations: [] }).valid).toBe(false);
      expect(options.schema.validate({ ...runnerPassOpinion, success: true }).valid).toBe(false);
      throw new Error("schema-invalid");
    });

    const result = await ValidationRunner.selfReviewChanges([change]);

    expect(gatewaySpy).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
  });

  test("ValidationRunner shell PASS remains deterministic and does not consult the model", async () => {
    const gatewaySpy = jest.spyOn(LLMGateway.getInstance(), "callStructured");
    const command = `"${process.execPath}" -e "process.exit(0)"`;

    const result = await ValidationRunner.validateWithShell([change], process.cwd(), [command]);

    expect(result.success).toBe(true);
    expect(gatewaySpy).not.toHaveBeenCalled();
  });

  test("ValidationRunner valid directory with zero commands remains unverified", async () => {
    const result = await ValidationRunner.validateWithShell([change], process.cwd(), []);

    expect(result.success).toBe(false);
    expect(result.errors).toContain("no deterministic validation commands were executed");
  });

  test("ValidationRunner shell FAIL remains deterministic and does not consult the model", async () => {
    const gatewaySpy = jest.spyOn(LLMGateway.getInstance(), "callStructured");
    const command = `"${process.execPath}" -e "process.exit(1)"`;

    const result = await ValidationRunner.validateWithShell([change], process.cwd(), [command]);

    expect(result.success).toBe(false);
    expect(gatewaySpy).not.toHaveBeenCalled();
  });

  test("ValidationRunner self-review no-change result remains distinct from zero-command validation", async () => {
    const noChanges = await ValidationRunner.selfReviewChanges([]);
    const noCommands = await ValidationRunner.validateWithShell([], process.cwd(), []);

    expect(noChanges).toEqual({ success: true, errors: "" });
    expect(noCommands.success).toBe(false);
    expect(noCommands.errors).toContain("no deterministic validation commands were executed");
  });

  test("SelfHealingEngine cannot convert zero validation commands into successful repair validation", async () => {
    jest.spyOn(ErrorClassifier, "classify").mockReturnValue({
      type: "INFRA",
      isInfrastructure: true,
      isCompile: false,
      canSurgicalPatch: false,
      diagnostics: [],
      rawErrors: "Validation remains unverified: no deterministic validation commands were executed.",
    });
    const result = await SelfHealingEngine.runSelfHealingLoop(
      [],
      process.cwd(),
      [],
      "system",
      "validate an empty change set",
    );

    expect(result.success).toBe(false);
    expect(result.errorLog).toContain("no deterministic validation commands were executed");
    expect(result.buildAttemptsCount).toBe(0);
  });

  test("ValidationDetector deterministic PASS ignores a hypothetical model FAIL", async () => {
    jest.spyOn(StaticValidationEngine, "validate").mockReturnValue({
      passed: true,
      status: "PASS",
      issues: [],
      dependencyGraph: new Map(),
    } as any);
    const gatewaySpy = jest.spyOn(LLMGateway.getInstance(), "callStructured").mockResolvedValue(gatewayResult({
      findings: [{ id: "feature", label: "Feature", assessment: "FAIL", details: "Suspected problem." }],
      analysis: "May fail.",
      recommendations: [],
    }, PipelineStages.FEATURE_VALIDATION));

    const result = await ValidationDetector.runFeatureValidation([change], { keyFiles: [{ path: "config.json", content: "{}" }] }, "update config");

    expect(result.overallPassed).toBe(true);
    expect(gatewaySpy).not.toHaveBeenCalled();
  });

  test("ValidationDetector deterministic FAIL cannot be overridden by a hypothetical model PASS", async () => {
    jest.spyOn(StaticValidationEngine, "validate").mockReturnValue({
      passed: false,
      status: "FAIL",
      issues: [{ checkId: "broken_import", file: "config.json", line: 1, severity: "FAIL", reason: "Broken", suggestedFix: "Fix import" }],
      dependencyGraph: new Map(),
    } as any);
    const gatewaySpy = jest.spyOn(LLMGateway.getInstance(), "callStructured")
      .mockResolvedValue(gatewayResult(detectorPassOpinion, PipelineStages.FEATURE_VALIDATION));

    const result = await ValidationDetector.runFeatureValidation([change], { keyFiles: [{ path: "config.json", content: "{}" }] }, "update config");

    expect(result.overallPassed).toBe(false);
    expect(gatewaySpy).not.toHaveBeenCalled();
  });

  test("ValidationDetector fallback routes through FEATURE_VALIDATION but remains operationally unverified", async () => {
    jest.spyOn(StaticValidationEngine, "validate").mockImplementation(() => { throw new Error("deterministic validator unavailable"); });
    const gatewaySpy = jest.spyOn(LLMGateway.getInstance(), "callStructured")
      .mockResolvedValue(gatewayResult(detectorPassOpinion, PipelineStages.FEATURE_VALIDATION));

    const result = await ValidationDetector.runFeatureValidation([change], { keyFiles: [] }, "update config");

    expect(result.overallPassed).toBe(false);
    expect(result.checks[0]).toMatchObject({ status: "WARN", checked: false });
    expect(result.checks[0].details).toContain("MODEL_ADVISORY:PASS");
    expect(gatewaySpy.mock.calls[0][0].stage).toBe(PipelineStages.FEATURE_VALIDATION);
    expect(gatewaySpy.mock.calls[0][0].schema.validate({ ...detectorPassOpinion, overallPassed: true }).valid).toBe(false);
  });

  test("ValidationDetector model FAIL is represented only as an unchecked advisory warning", async () => {
    jest.spyOn(StaticValidationEngine, "validate").mockImplementation(() => { throw new Error("deterministic validator unavailable"); });
    jest.spyOn(LLMGateway.getInstance(), "callStructured").mockResolvedValue(gatewayResult({
      findings: [{ id: "feature", label: "Feature", assessment: "FAIL", details: "Suspected problem." }],
      analysis: "May fail.",
      recommendations: [],
    }, PipelineStages.FEATURE_VALIDATION));

    const result = await ValidationDetector.runFeatureValidation([change], { keyFiles: [] }, "update config");

    expect(result.overallPassed).toBe(false);
    expect(result.checks[0]).toMatchObject({ status: "WARN", checked: false });
    expect(result.failedChecks[0]).toContain("Deterministic feature validation was unavailable");
  });

  test.each([
    new LLMTruncationError("truncated", { stage: PipelineStages.FEATURE_VALIDATION }),
    new LLMTimeoutError("timeout", { stage: PipelineStages.FEATURE_VALIDATION }),
    new LLMRateLimitError("rate limited", { stage: PipelineStages.FEATURE_VALIDATION }),
    new LLMNetworkError("network failure", { stage: PipelineStages.FEATURE_VALIDATION }),
    new LLMProviderError("provider 503", { stage: PipelineStages.FEATURE_VALIDATION, status: 503 }, true),
  ])("ValidationDetector model technical failure cannot default to PASS", async (error) => {
    jest.spyOn(StaticValidationEngine, "validate").mockImplementation(() => { throw new Error("deterministic validator unavailable"); });
    jest.spyOn(LLMGateway.getInstance(), "callStructured").mockRejectedValue(error);

    const result = await ValidationDetector.runFeatureValidation([change], { keyFiles: [] }, "update config");

    expect(result.overallPassed).toBe(false);
    expect(result.checks.every((check) => check.status === "WARN" && check.checked === false)).toBe(true);
  });

  test("ValidationDetector schema rejects malformed nested and authority-like output", async () => {
    jest.spyOn(StaticValidationEngine, "validate").mockImplementation(() => { throw new Error("deterministic validator unavailable"); });
    const gatewaySpy = jest.spyOn(LLMGateway.getInstance(), "callStructured").mockImplementation(async (options: any) => {
      expect(options.schema.validate({ findings: [{ id: "x", label: "X", assessment: "PASS", details: "ok", verified: true }], analysis: "", recommendations: [] }).valid).toBe(false);
      expect(options.schema.validate({ ...detectorPassOpinion, validationPassed: true }).valid).toBe(false);
      throw new Error("schema-invalid");
    });

    const result = await ValidationDetector.runFeatureValidation([change], { keyFiles: [] }, "update config");

    expect(gatewaySpy).toHaveBeenCalledTimes(1);
    expect(result.overallPassed).toBe(false);
  });
});
