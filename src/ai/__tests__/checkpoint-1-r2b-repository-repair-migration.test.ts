import { LLMGateway } from "../gateway/LLMGateway";
import { PipelineStages } from "../gateway/PipelineStage";
import { RepositorySearch } from "../repository/RepositorySearch";
import { RepositoryInvestigationAgent } from "../repository/RepositoryInvestigationAgent";
import { RepositoryEvidenceStore } from "../repository/RepositoryEvidenceStore";
import { SelfHealingEngine } from "../repair/SelfHealingEngine";
import { BuildErrorRepair } from "../repair/BuildErrorRepair";
import { PatchCorrectionEngine } from "../generation/PatchCorrectionEngine";
import { ValidationRunner } from "../validation/ValidationRunner";
import { LLMTruncationError } from "../gateway/LLMError";

function gatewayResult<T>(content: T, stage: string) {
  return {
    content,
    rawResponse: { choices: [{ message: { content: JSON.stringify(content) }, finish_reason: "stop" }] },
    finishReason: "stop",
    latencyMs: 1,
    model: "gpt-4o",
    stage,
  } as any;
}

function intentSpec() {
  return {
    goal: "Find the implementation",
    operations: [{ kind: "MODIFY", subject: "authentication" }],
    constraints: [],
    acceptanceCriteria: [],
    destructive: false,
    requiresClarification: false,
    taskType: "BUG_FIX",
    risk: "LOW",
    estimatedComplexity: "SMALL",
    explicitUserPaths: [],
  } as any;
}

describe("Checkpoint 1 R2B repository and repair gateway migration", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("RepositorySearch routes advisory planning through REPOSITORY_REASONING with deterministic validation", async () => {
    const gatewaySpy = jest.spyOn(LLMGateway.getInstance(), "callStructured").mockResolvedValue(
      gatewayResult(
        { approach: "Inspect auth service", filesToRead: ["src/auth.ts"], validationCommands: ["tsc --noEmit"] },
        PipelineStages.REPOSITORY_REASONING,
      ),
    );

    const result = await RepositorySearch.planTask("Fix auth", { fileTree: ["src/auth.ts"] });
    expect(result.filesToRead).toEqual(["src/auth.ts"]);
    const options = gatewaySpy.mock.calls[0][0] as any;
    expect(options.stage).toBe(PipelineStages.REPOSITORY_REASONING);
    expect(options.schema.validate({ approach: "bad", filesToRead: ["../outside.ts"], validationCommands: [], success: true }).valid).toBe(false);
  });

  test("RepositoryInvestigationAgent uses REPOSITORY_REASONING and model output creates no evidence", async () => {
    const gatewaySpy = jest.spyOn(LLMGateway.getInstance(), "callStructured").mockResolvedValue(
      gatewayResult({ readyToPlan: true, reason: "Enough", toolCalls: [] }, PipelineStages.REPOSITORY_REASONING),
    );
    const store = new RepositoryEvidenceStore("repo-1");
    const agent = new RepositoryInvestigationAgent({
      toolEngine: { readFile: jest.fn(() => ({ found: false })), dispatch: jest.fn(() => "{}") } as any,
      evidenceStore: store,
      intentSpec: intentSpec(),
      maxRounds: 1,
    });

    const result = await agent.investigate();
    expect(gatewaySpy.mock.calls[0][0].stage).toBe(PipelineStages.REPOSITORY_REASONING);
    expect(result.evidenceIds).toEqual([]);
    expect(store.getAllEvidence()).toEqual([]);
  });

  test("RepositoryInvestigationAgent rejects malformed decisions into its deterministic read-only fallback", async () => {
    const gatewaySpy = jest.spyOn(LLMGateway.getInstance(), "callStructured").mockImplementation(async (options: any) => {
      expect(options.schema.validate({ readyToPlan: false, reason: "bad", toolCalls: [{ tool: "repo_writeFile", params: {}, reason: "write" }] }).valid).toBe(false);
      throw new Error("schema-invalid");
    });
    const store = new RepositoryEvidenceStore("repo-1");
    const agent = new RepositoryInvestigationAgent({
      toolEngine: { readFile: jest.fn(() => ({ found: false })), dispatch: jest.fn(() => "{}") } as any,
      evidenceStore: store,
      intentSpec: intentSpec(),
      maxRounds: 1,
    });

    const result = await agent.investigate();
    expect(gatewaySpy).toHaveBeenCalledTimes(1);
    expect(result.evidenceIds).toEqual([]);
    expect(result.readyToPlan).toBe(false);
  });

  test("SelfHealingEngine missing-dependency repair uses REPAIR and rejects unauthorized paths", async () => {
    jest.spyOn(ValidationRunner, "validateWithShell").mockResolvedValue({ success: false, errors: "TS2307: Cannot find module 'left-pad' in src/index.ts" });
    const gatewaySpy = jest.spyOn(LLMGateway.getInstance(), "callStructured").mockImplementation(async (options: any) => {
      expect(options.stage).toBe(PipelineStages.REPAIR);
      expect(options.schema.name).toBe("MissingDependencyRepairSchema");
      expect(options.schema.validate({ changes: [{ path: "../outside.ts", content: "fixed" }] }).valid).toBe(false);
      throw new Error("network failure");
    });

    await expect(
      SelfHealingEngine.runSelfHealingLoop(
        [{ path: "src/index.ts", content: "import x from 'left-pad';", action: "modify", description: "initial" }],
        process.cwd(),
        ["deterministic-check"],
        "repair",
        "remove missing dependency",
        { apply: jest.fn() } as any,
      ),
    ).rejects.toThrow("network failure");
    expect(gatewaySpy).toHaveBeenCalledTimes(1);
  });

  test("SelfHealingEngine general repair uses REPAIR and propagates technical failure", async () => {
    jest.spyOn(ValidationRunner, "validateWithShell").mockResolvedValue({ success: false, errors: "TypeScript compilation failed in src/index.ts" });
    const technicalFailure = new Error("provider unavailable");
    const gatewaySpy = jest.spyOn(LLMGateway.getInstance(), "callStructured").mockImplementation(async (options: any) => {
      expect(options.stage).toBe(PipelineStages.REPAIR);
      expect(options.schema.name).toBe("SelfHealingRepairProposalSchema");
      expect(options.schema.validate({ changes: [{ path: "../outside.ts", action: "create", content: "x", description: "bad" }] }).valid).toBe(false);
      throw technicalFailure;
    });

    await expect(
      SelfHealingEngine.runSelfHealingLoop(
        [{ path: "src/index.ts", content: "const value: string = 1;", action: "modify", description: "initial" }],
        process.cwd(),
        ["deterministic-check"],
        "repair",
        "fix compile error",
        { apply: jest.fn() } as any,
      ),
    ).rejects.toBe(technicalFailure);
    expect(gatewaySpy).toHaveBeenCalledTimes(1);
  });

  test("BuildErrorRepair remains an unverified proposal until deterministic validation succeeds", async () => {
    const validProposal = { changes: [{ path: "src/index.ts", content: "const value = 2;", description: "repair", action: "modify" }] };
    const gatewaySpy = jest.spyOn(LLMGateway.getInstance(), "callStructured").mockImplementation(async (options: any) => {
      expect(options.schema.validate(validProposal)).toMatchObject({ valid: true });
      const effectivePrompt = options.messages.map((message: any) => message.content).join("\n");
      expect(effectivePrompt).toContain("MODIFY requires path, action \"modify\", description, and non-empty full replacement content");
      expect(effectivePrompt).not.toContain("edits[]");
      expect(effectivePrompt).not.toContain("\"repaired\"");
      expect(effectivePrompt).not.toContain("\"patchExplanation\"");
      return gatewayResult(validProposal, PipelineStages.REPAIR);
    });
    const result = await BuildErrorRepair.runBuildErrorRepairPass(
      [{ path: "src/index.ts", content: "constconst value = 1;", description: "initial", action: "modify" }],
      null,
      [],
      "fix build",
      "compiler error",
    );
    const options = gatewaySpy.mock.calls[0][0] as any;
    expect(options.stage).toBe(PipelineStages.REPAIR);
    expect(options.schema.validate({ changes: [{ path: "../outside.ts", content: "x", description: "bad", action: "modify", buildPassed: true }] }).valid).toBe(false);
    expect(result.finalChanges[0].content).toBe("const value = 2;");
    expect(result.success).toBe(false);
  });

  test("BuildErrorRepair rejects malformed or legacy modify shapes without normalizing them", async () => {
    const gatewaySpy = jest.spyOn(LLMGateway.getInstance(), "callStructured").mockImplementation(async (options: any) => {
      expect(options.schema.validate({ changes: [{ path: "src/index.ts", description: "missing content", action: "modify" }] }).valid).toBe(false);
      expect(options.schema.validate({ changes: [{ path: "src/index.ts", description: "legacy edits", action: "modify", edits: [{ oldText: "a", newText: "b" }] }] }).valid).toBe(false);
      expect(options.schema.validate({ changes: [{ path: "src/index.ts", content: "fixed", description: "extra", action: "modify", success: true }] }).valid).toBe(false);
      throw new Error("schema-invalid");
    });

    await expect(
      BuildErrorRepair.runBuildErrorRepairPass(
        [{ path: "src/index.ts", content: "broken", description: "initial", action: "modify" }],
        null,
        [],
        "fix build",
        "compiler error",
      ),
    ).resolves.toMatchObject({ success: false });
    expect(gatewaySpy).toHaveBeenCalledTimes(1);
  });

  test("BuildErrorRepair rejects delete proposals that contain replacement content", async () => {
    const gatewaySpy = jest.spyOn(LLMGateway.getInstance(), "callStructured").mockImplementation(async (options: any) => {
      expect(options.schema.validate({ changes: [{ path: "src/index.ts", content: "replacement", description: "bad delete", action: "delete", isDeleted: true }] }).valid).toBe(false);
      throw new Error("schema-invalid");
    });

    await expect(
      BuildErrorRepair.runBuildErrorRepairPass(
        [{ path: "src/index.ts", content: "broken", description: "initial", action: "modify" }],
        null,
        [],
        "fix build",
        "compiler error",
      ),
    ).resolves.toMatchObject({ success: false });
    expect(gatewaySpy).toHaveBeenCalledTimes(1);
  });

  test("BuildErrorRepair propagates typed gateway failures instead of reporting repair success", async () => {
    const truncated = new LLMTruncationError("truncated", { stage: PipelineStages.REPAIR });
    jest.spyOn(LLMGateway.getInstance(), "callStructured").mockRejectedValue(truncated);
    await expect(
      BuildErrorRepair.runBuildErrorRepairPass(
        [{ path: "src/index.ts", content: "broken", description: "initial", action: "modify" }],
        null,
        [],
        "fix build",
        "compiler error",
      ),
    ).rejects.toBe(truncated);
  });

  test("PatchCorrectionEngine uses CODE_CORRECTION and exact PatchApplicator authority", async () => {
    const gatewaySpy = jest.spyOn(LLMGateway.getInstance(), "callStructured").mockResolvedValue(
      gatewayResult({ edits: [{ oldText: "const value = 1;", newText: "const value = 2;" }] }, PipelineStages.CODE_CORRECTION),
    );
    const result = await PatchCorrectionEngine.correctPatch({
      filePath: "src/index.ts",
      currentContent: "const value = 1;",
      userMessage: "fix value",
      manifestAction: "modify",
      failedEdits: [],
      errorCode: "MODIFY_PATCH_REQUIRED",
      errorMessage: "edits required",
    });
    const options = gatewaySpy.mock.calls[0][0] as any;
    expect(options.stage).toBe(PipelineStages.CODE_CORRECTION);
    expect(options.schema.validate({ edits: [{ oldText: "", newText: "x" }], verified: true }).valid).toBe(false);
    expect(result).toMatchObject({ attempted: true, succeeded: true });
  });

  test("PatchCorrectionEngine propagates typed gateway truncation as technical failure", async () => {
    const truncated = new LLMTruncationError("truncated", { stage: PipelineStages.CODE_CORRECTION });
    jest.spyOn(LLMGateway.getInstance(), "callStructured").mockRejectedValue(truncated);
    await expect(
      PatchCorrectionEngine.correctPatch({
        filePath: "src/index.ts",
        currentContent: "const value = 1;",
        userMessage: "fix value",
        failedEdits: [],
        errorCode: "MODIFY_PATCH_REQUIRED",
        errorMessage: "edits required",
      }),
    ).rejects.toBe(truncated);
  });
});
