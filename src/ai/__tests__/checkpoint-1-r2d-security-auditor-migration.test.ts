import { LLMGateway } from "../gateway/LLMGateway";
import { PipelineStages } from "../gateway/PipelineStage";
import { LLMTruncationError } from "../gateway/LLMError";
import { SecurityAuditor } from "../review/SecurityAuditor";

function gatewayResult<T>(content: T, stage: string) {
  return { content, rawResponse: {}, finishReason: "stop", latencyMs: 1, model: "gpt-4o", stage } as any;
}

const passCritique = { score: 0.95, passed: true, critique: [], improvements: "" };
const passSecurity = { passed: true, riskLevel: "LOW", vulnerabilities: [], recommendations: [] };

describe("Checkpoint 1 R2D SecurityAuditor gateway migration", () => {
  afterEach(() => jest.restoreAllMocks());

  test("both security model calls route through SECURITY_AUDIT with deterministic schemas", async () => {
    const gatewaySpy = jest.spyOn(LLMGateway.getInstance(), "callStructured")
      .mockResolvedValueOnce(gatewayResult(passCritique, PipelineStages.SECURITY_AUDIT))
      .mockResolvedValueOnce(gatewayResult(passSecurity, PipelineStages.SECURITY_AUDIT));
    await SecurityAuditor.runReflectionAndSecurityAudit([{ path: "src/index.ts", content: "export const value = 1;", action: "modify", description: "change" }]);
    expect(gatewaySpy).toHaveBeenCalledTimes(2);
    expect(gatewaySpy.mock.calls.map((call) => call[0].stage)).toEqual([PipelineStages.SECURITY_AUDIT, PipelineStages.SECURITY_AUDIT]);
    expect(gatewaySpy.mock.calls[0][0].schema.validate({ score: 0.9, passed: true, critique: [], improvements: "" }).valid).toBe(true);
    expect(gatewaySpy.mock.calls[1][0].schema.validate({ passed: true, riskLevel: "LOW", vulnerabilities: [], recommendations: [], securityPassed: true }).valid).toBe(false);
  });

  test("deterministic policy failure beats model PASS", async () => {
    jest.spyOn(LLMGateway.getInstance(), "callStructured")
      .mockResolvedValueOnce(gatewayResult(passCritique, PipelineStages.SECURITY_AUDIT))
      .mockResolvedValueOnce(gatewayResult(passSecurity, PipelineStages.SECURITY_AUDIT));
    const result = await SecurityAuditor.runReflectionAndSecurityAudit([{ path: "src/index.ts", content: "eval(userInput);", action: "modify", description: "unsafe" }]);
    expect(result.securityPass).toBe(false);
    expect(result.passed).toBe(false);
  });

  test("deterministic PASS and model PASS may pass", async () => {
    jest.spyOn(LLMGateway.getInstance(), "callStructured")
      .mockResolvedValueOnce(gatewayResult(passCritique, PipelineStages.SECURITY_AUDIT))
      .mockResolvedValueOnce(gatewayResult(passSecurity, PipelineStages.SECURITY_AUDIT));
    const result = await SecurityAuditor.runReflectionAndSecurityAudit([{ path: "src/index.ts", content: "export const value = 1;", action: "modify", description: "safe" }]);
    expect(result.securityPass).toBe(true);
    expect(result.passed).toBe(true);
  });

  test("model security FAIL remains conservative even when deterministic policy passes", async () => {
    jest.spyOn(LLMGateway.getInstance(), "callStructured")
      .mockResolvedValueOnce(gatewayResult(passCritique, PipelineStages.SECURITY_AUDIT))
      .mockResolvedValueOnce(gatewayResult({ passed: false, riskLevel: "HIGH", vulnerabilities: [], recommendations: ["Review manually"] }, PipelineStages.SECURITY_AUDIT));
    const result = await SecurityAuditor.runReflectionAndSecurityAudit([{ path: "src/index.ts", content: "export const value = 1;", action: "modify", description: "review" }]);
    expect(result.securityPass).toBe(false);
    expect(result.passed).toBe(false);
  });

  test("critique timeout cannot become security PASS", async () => {
    jest.spyOn(LLMGateway.getInstance(), "callStructured").mockRejectedValue(new LLMTruncationError("timeout", { stage: PipelineStages.SECURITY_AUDIT }));
    const result = await SecurityAuditor.runReflectionAndSecurityAudit([{ path: "src/index.ts", content: "export const value = 1;", action: "modify", description: "change" }]);
    expect(result.securityPass).toBe(false);
    expect(result.passed).toBe(false);
  });

  test("security-review network failure cannot become security PASS", async () => {
    jest.spyOn(LLMGateway.getInstance(), "callStructured")
      .mockResolvedValueOnce(gatewayResult(passCritique, PipelineStages.SECURITY_AUDIT))
      .mockRejectedValueOnce(new Error("network failure"));
    const result = await SecurityAuditor.runReflectionAndSecurityAudit([{ path: "src/index.ts", content: "export const value = 1;", action: "modify", description: "change" }]);
    expect(result.securityPass).toBe(false);
    expect(result.passed).toBe(false);
  });

  test("schema-invalid security output fails closed through the production validator", async () => {
    const gatewaySpy = jest.spyOn(LLMGateway.getInstance(), "callStructured").mockImplementation(async (options: any) => {
      expect(options.schema.validate({ passed: true, riskLevel: "LOW", vulnerabilities: [{ file: "x", issue: "y", severity: "LOW", verified: true }], recommendations: [] }).valid).toBe(false);
      throw new Error("schema-invalid");
    });
    const result = await SecurityAuditor.runReflectionAndSecurityAudit([{ path: "src/index.ts", content: "export const value = 1;", action: "modify", description: "change" }]);
    expect(gatewaySpy).toHaveBeenCalledTimes(2);
    expect(result.securityPass).toBe(false);
    expect(result.passed).toBe(false);
  });

  test("unknown authority-like critique fields are rejected", async () => {
    const gatewaySpy = jest.spyOn(LLMGateway.getInstance(), "callStructured").mockImplementation(async (options: any) => {
      expect(options.schema.validate({ score: 0.9, passed: true, critique: [], improvements: "", securityPassed: true }).valid).toBe(false);
      throw new Error("schema-invalid");
    });
    const result = await SecurityAuditor.runReflectionAndSecurityAudit([{ path: "src/index.ts", content: "export const value = 1;", action: "modify", description: "change" }]);
    expect(gatewaySpy).toHaveBeenCalledTimes(2);
    expect(result.passed).toBe(false);
  });
});
