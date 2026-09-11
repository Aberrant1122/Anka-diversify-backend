import fs from "fs";
import os from "os";
import path from "path";
import { LLMGateway } from "../gateway/LLMGateway";
import { PipelineStages } from "../gateway/PipelineStage";
import { StageVerificationGate } from "../orchestration/StageExecutionTransaction";
import { RepositoryEvidenceStore } from "../repository/RepositoryEvidenceStore";
import { RepositoryInvestigationAgent } from "../repository/RepositoryInvestigationAgent";
import { SelfHealingEngine } from "../repair/SelfHealingEngine";
import { ValidationRunner } from "../validation/ValidationRunner";
import { ErrorClassifier } from "../validation/ErrorClassifier";

function gatewayDecision(readyToPlan: boolean, toolCalls: any[] = []) {
  return {
    content: { readyToPlan, reason: "test decision", toolCalls },
    rawResponse: {},
    finishReason: "stop",
    latencyMs: 1,
    model: "gpt-4o",
    stage: PipelineStages.REPOSITORY_REASONING,
  } as any;
}

function destructiveIntent(target = "src/target.ts") {
  return {
    goal: `Delete ${target}`,
    operations: [{ kind: "DELETE", subject: target }],
    constraints: [],
    acceptanceCriteria: [],
    destructive: true,
    requiresClarification: false,
    taskType: "DELETE_FILE",
    risk: "HIGH",
    estimatedComplexity: "SMALL",
    explicitUserPaths: [target],
  } as any;
}

function investigationAgent(store: RepositoryEvidenceStore, intent = destructiveIntent(), dispatch = jest.fn(() => "{}")) {
  return new RepositoryInvestigationAgent({
    maxRounds: 1,
    toolEngine: { readFile: jest.fn(() => ({ found: false })), dispatch } as any,
    evidenceStore: store,
    intentSpec: intent,
  });
}

const change = {
  path: "src/target.ts",
  content: "export const repaired = true;",
  action: "modify" as const,
  description: "Repair target",
};

const noOpFsManager = { apply: jest.fn(), snapshot: jest.fn(), rollback: jest.fn(), commit: jest.fn() } as any;

async function withIsolatedRuntimeCwd<T>(run: (temporaryCwd: string) => Promise<T>): Promise<T> {
  const temporaryCwd = fs.mkdtempSync(path.join(os.tmpdir(), "anka-cp1-remediation-"));
  const cwdSpy = jest.spyOn(process, "cwd").mockReturnValue(temporaryCwd);
  try {
    return await run(temporaryCwd);
  } finally {
    cwdSpy.mockRestore();
    fs.rmSync(temporaryCwd, { recursive: true, force: true });
  }
}

describe("Checkpoint 1 final remediation authority", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  test("destructive target A is not ready with materialized evidence only for unrelated B", async () => {
    jest.spyOn(LLMGateway.getInstance(), "callStructured").mockResolvedValue(gatewayDecision(false));
    const store = new RepositoryEvidenceStore("repo");
    store.addEvidence({ kind: "FILE", filePath: "src/unrelated.ts", provenance: "REPO_READ" });
    const result = await investigationAgent(store).investigate();
    expect(result.readyToPlan).toBe(false);
  });

  test("destructive target A becomes ready after production tool execution materializes exact evidence for A", async () => {
    jest.spyOn(LLMGateway.getInstance(), "callStructured").mockResolvedValue(gatewayDecision(false, [
      { tool: "repo_readFile", params: { filePath: "src/target.ts" }, reason: "Materialize the target" },
    ]));
    const store = new RepositoryEvidenceStore("repo");
    const dispatch = jest.fn(() => JSON.stringify({ found: true, filePath: "src/target.ts", totalLines: 1 }));
    const result = await investigationAgent(store, destructiveIntent(), dispatch).investigate();
    expect(result.readyToPlan).toBe(true);
  });

  test("model readyToPlan true cannot waive destructive target binding when evidence is unrelated", async () => {
    jest.spyOn(LLMGateway.getInstance(), "callStructured").mockResolvedValue(gatewayDecision(true));
    const store = new RepositoryEvidenceStore("repo");
    store.addEvidence({ kind: "FILE", filePath: "src/unrelated.ts", provenance: "REPO_READ" });
    const result = await investigationAgent(store).investigate();
    expect(result.readyToPlan).toBe(false);
    expect(result.missingEvidence.join(" ")).toContain("src/target.ts");
  });

  test("model readyToPlan true is accepted only when exact target evidence and deterministic conditions hold", async () => {
    jest.spyOn(LLMGateway.getInstance(), "callStructured").mockResolvedValue(gatewayDecision(true));
    const store = new RepositoryEvidenceStore("repo");
    store.addEvidence({ kind: "FILE", filePath: ".\\src\\target.ts", provenance: "REPO_READ" });
    const result = await investigationAgent(store).investigate();
    expect(result.readyToPlan).toBe(true);
  });

  test("an explicit user target path is not satisfied by unrelated evidence", async () => {
    jest.spyOn(LLMGateway.getInstance(), "callStructured").mockResolvedValue(gatewayDecision(true));
    const store = new RepositoryEvidenceStore("repo");
    store.addEvidence({ kind: "FILE", filePath: "src/unrelated.ts", provenance: "REPO_READ" });
    const intent = { ...destructiveIntent(), destructive: false, operations: [{ kind: "MODIFY", subject: "src/target.ts" }] };
    const result = await investigationAgent(store, intent).investigate();
    expect(result.readyToPlan).toBe(false);
  });

  test("a semantic search candidate for the exact target is insufficient without materialized repository evidence", async () => {
    jest.spyOn(LLMGateway.getInstance(), "callStructured").mockResolvedValue(gatewayDecision(true));
    const store = new RepositoryEvidenceStore("repo");
    store.addEvidence({ kind: "FILE", filePath: "src/target.ts", provenance: "SEMANTIC_SEARCH" });
    const result = await investigationAgent(store).investigate();
    expect(result.readyToPlan).toBe(false);
  });

  test("every resolved destructive delete obligation requires exact evidence", async () => {
    jest.spyOn(LLMGateway.getInstance(), "callStructured").mockResolvedValue(gatewayDecision(true));
    const store = new RepositoryEvidenceStore("repo");
    store.addEvidence({ kind: "FILE", filePath: "src/target.ts", provenance: "REPO_READ" });
    const intent = destructiveIntent();
    intent.explicitUserPaths = [];
    intent.resolvedTarget = {
      candidatePaths: ["src/target.ts", "src/second-target.ts"],
      actionObligations: [
        { path: "src/target.ts", requiredAction: "delete", role: "PRIMARY_TARGET", evidenceIds: [] },
        { path: "src/second-target.ts", requiredAction: "delete", role: "PRIMARY_TARGET", evidenceIds: [] },
      ],
    };
    const result = await investigationAgent(store, intent).investigate();
    expect(result.readyToPlan).toBe(false);
    expect(result.missingEvidence.join(" ")).toContain("src/second-target.ts");
  });

  test("empty changes without localPath remain unsuccessful and unverified", async () => {
    const result = await withIsolatedRuntimeCwd(() => SelfHealingEngine.runSelfHealingLoop([], null, [], "system", "repair"));
    expect(result).toMatchObject({ success: false, attempts: 0, buildAttemptsCount: 0, errorType: "VALIDATION_UNVERIFIED" });
    expect(result.errorLog).toContain("local repository path");
  });

  test("empty changes with localPath and zero commands remain unsuccessful", async () => {
    const result = await withIsolatedRuntimeCwd((temporaryCwd) => SelfHealingEngine.runSelfHealingLoop([], temporaryCwd, [], "system", "repair"));
    expect(result).toMatchObject({ success: false, attempts: 0, buildAttemptsCount: 0, errorType: "VALIDATION_UNVERIFIED" });
    expect(result.errorLog).toContain("no deterministic validation commands");
  });

  test("empty changes may be a verified no-op when deterministic validation passes", async () => {
    const validation = jest.spyOn(ValidationRunner, "validateWithShell").mockResolvedValue({ success: true, errors: "" });
    const result = await withIsolatedRuntimeCwd((temporaryCwd) => SelfHealingEngine.runSelfHealingLoop([], temporaryCwd, ["deterministic-check"], "system", "repair"));
    expect(result).toMatchObject({ success: true, repairApplied: false, repaired: false, buildAttemptsCount: 1 });
    expect(validation).toHaveBeenCalledTimes(1);
  });

  test("actual repair changes can succeed after deterministic validation passes", async () => {
    jest.spyOn(ValidationRunner, "validateWithShell").mockResolvedValue({ success: true, errors: "" });
    const result = await withIsolatedRuntimeCwd((temporaryCwd) => SelfHealingEngine.runSelfHealingLoop([change], temporaryCwd, ["deterministic-check"], "system", "repair", noOpFsManager));
    expect(result).toMatchObject({ success: true, buildAttemptsCount: 1 });
  });

  test("actual repair changes fail when deterministic validation fails", async () => {
    jest.spyOn(ValidationRunner, "validateWithShell").mockResolvedValue({ success: false, errors: "deterministic failure" });
    jest.spyOn(ErrorClassifier, "classify").mockReturnValue({ type: "INFRA", isInfrastructure: true, isCompile: false, canSurgicalPatch: false, diagnostics: [], rawErrors: "deterministic failure" } as any);
    const result = await withIsolatedRuntimeCwd((temporaryCwd) => SelfHealingEngine.runSelfHealingLoop([change], temporaryCwd, ["deterministic-check"], "system", "repair", noOpFsManager));
    expect(result.success).toBe(false);
    expect(result.errorLog).toContain("deterministic failure");
  });

  test("model/advisory success cannot establish repair success without deterministic validation", async () => {
    const advisory = jest.spyOn(ValidationRunner, "selfReviewChanges").mockResolvedValue({ success: true, errors: "" });
    const result = await withIsolatedRuntimeCwd(() => SelfHealingEngine.runSelfHealingLoop([change], null, [], "system", "repair"));
    expect(result.success).toBe(false);
    expect(advisory).not.toHaveBeenCalled();
  });

  test("unsafe SelfHealing result propagates as non-positive authority to the real stage gate", async () => {
    const repairResult = await withIsolatedRuntimeCwd(() => SelfHealingEngine.runSelfHealingLoop([], null, [], "system", "repair"));
    const gate = StageVerificationGate.evaluate({
      repairSuccess: repairResult.success,
      securityPass: true,
      featureValidationPassed: true,
    });
    expect(repairResult.success).toBe(false);
    expect(gate).toEqual({ passed: false, reasons: ["Build/repair validation failed"] });
  });
});
