import fs from "fs";
import path from "path";

describe("AgentPipeline - Single detectValidationCommands Call (P1-A Fix)", () => {
  it("should call detectValidationCommands exactly once in AgentPipeline source", () => {
    const pipelinePath = path.join(__dirname, "..", "orchestration", "AgentPipeline.ts");
    const content = fs.readFileSync(pipelinePath, "utf8");

    const matches = content.match(/detectValidationCommands\(/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBe(1);
  });

  it("should pass executionContract to the single detectValidationCommands call", () => {
    const pipelinePath = path.join(__dirname, "..", "orchestration", "AgentPipeline.ts");
    const content = fs.readFileSync(pipelinePath, "utf8");

    // Find the detectValidationCommands call and verify it includes executionContract
    const callIndex = content.indexOf("detectValidationCommands(");
    expect(callIndex).toBeGreaterThan(-1);

    // Extract the region around the call (up to 200 chars after)
    const callRegion = content.substring(callIndex, callIndex + 200);
    expect(callRegion).toContain("executionContract");
  });

  it("should store the result in effectiveValidationCommands, not validationCommands", () => {
    const pipelinePath = path.join(__dirname, "..", "orchestration", "AgentPipeline.ts");
    const content = fs.readFileSync(pipelinePath, "utf8");

    // The variable should be effectiveValidationCommands (with contract)
    expect(content).toContain("const effectiveValidationCommands = ValidationPlanner.detectValidationCommands(");
    // There should NOT be a separate validationCommands = detectValidationCommands
    const earlyCallPattern = /const validationCommands = ValidationPlanner\.detectValidationCommands\(/;
    expect(earlyCallPattern.test(content)).toBe(false);
  });

  it("should use effectiveValidationCommands in telemetry, not a separate validationCommands", () => {
    const pipelinePath = path.join(__dirname, "..", "orchestration", "AgentPipeline.ts");
    const content = fs.readFileSync(pipelinePath, "utf8");

    // Telemetry should reference effectiveValidationCommands
    expect(content).toContain("validationCommands: effectiveValidationCommands");
  });
});
