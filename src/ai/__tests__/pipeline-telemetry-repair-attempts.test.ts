import { PipelineTelemetry } from "../orchestration/PipelineTelemetry";

function measurement(repairAttempts: number): string {
  return PipelineTelemetry.generateMeasurementText({
    s1Time: 0, s2Time: 0, s3Time: 0, s4Time: 0, s5Time: 0,
    s6Time: 0, s7Time: 0, s8Time: 0, s9Time: 0,
    totalPipelineDuration: 0,
    scannedCount: 0,
    extractedSymbolsCount: 0,
    inspectedFilesCount: 0,
    finalConfidence: 0,
    inputTokens: 0,
    outputTokens: 0,
    compressionRatio: "0",
    promptTokensK: "0",
    completionTokensK: "0",
    modifiedFilesCount: 0,
    validationCommands: ["npm run build"],
    buildSuccess: false,
    securityPass: true,
    repairAttempts,
  });
}

describe("PipelineTelemetry repair attempt accuracy", () => {
  test("reports zero repair attempts without fabricating a fallback", () => {
    expect(measurement(0)).toContain("Status: Failed (0 attempts)");
    expect(measurement(0)).not.toContain("5 attempts");
  });

  test("reports the actual nonzero repair attempt count", () => {
    expect(measurement(2)).toContain("Status: Failed (2 attempts)");
  });
});
