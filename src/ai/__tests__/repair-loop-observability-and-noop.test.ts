import fs from "fs";
import path from "path";
import os from "os";
import { SelfHealingEngine } from "../repair/SelfHealingEngine";
import { FileSystemStateManager } from "../validation/FileSystemStateManager";
import { ValidationRunner } from "../validation/ValidationRunner";
import { SecurityAuditor } from "../review/SecurityAuditor";
import { applyPatchToFile, FilePatchEdit } from "../patch/PatchApplicator";
import * as sharedUtils from "../shared/utils";
import { mutationFixtureScope } from "./helpers/mutation-fixture";
import { MutationTransaction } from "../runtime/MutationTransaction";
import { CapabilityGuard } from "../runtime/CapabilityGuard";
import { reconcileExecutionManifest } from "../runtime/ExecutionManifest";
import { fingerprintBytes } from "../editing/EditingPrimitives";
import { LLMGateway } from "../gateway/LLMGateway";

describe("Repair Loop Observability & No-Op Repair Handling (Section 10)", () => {
  let tempDir: string;
  let transaction: MutationTransaction | undefined;
  const relativePath = "src/index.ts";
  const initialError = "src/index.ts(1,1): error TS2304: Cannot find name missing.";
  const read = () => fs.readFileSync(path.join(tempDir, relativePath), "utf8");
  const fake = (content: unknown) => ({ content } as Awaited<ReturnType<LLMGateway["callStructured"]>>);
  const replacement = (oldText = "BAD", newText = "FIXED", source = oldText) => ({
    operations: [{ op: "replace_exact", path: relativePath, expectedFileHash: fingerprintBytes(source), oldText, newText }],
  });
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "anka-repair-obs-test-"));
  });
  afterEach(() => {
    jest.restoreAllMocks();
    transaction?.abort();
    transaction = undefined;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function fixture() {
    fs.mkdirSync(path.join(tempDir, "src"));
    fs.writeFileSync(path.join(tempDir, relativePath), "R0");
    const changes = [{ path: relativePath, action: "modify" as const, content: "BAD", description: "initial" }];
    const scope = mutationFixtureScope(tempDir, changes);
    const manifest = reconcileExecutionManifest(scope, null);
    const tx = MutationTransaction.create(scope, manifest);
    transaction = tx;
    const manager = new FileSystemStateManager(CapabilityGuard.forTransaction(tx, tx.primary), tx.id, tx);
    const builds = jest.spyOn(ValidationRunner, "validateWithShell").mockImplementation(async (_changes, root) => {
      const content = fs.readFileSync(path.join(root!, relativePath), "utf8");
      if (content === "R0" || content === "FIXED") return { success: true, errors: "" };
      return { success: false, errors: content === "WORSE"
        ? "src/index.ts(1,1): error TS2322: Type number is not assignable to string."
        : initialError };
    });
    const run = () => SelfHealingEngine.runSelfHealingLoop(changes, tempDir, ["fixture-check"], "system", "Modify src/index.ts",
      manager, "fixture-project", undefined, manifest);
    return { tx, builds, run };
  }

  test("TEST A: initial compiler stderr remains rootFailure after repair failure", async () => {
    const { run } = fixture();
    jest.spyOn(LLMGateway.getInstance(), "callStructured").mockResolvedValue(fake(replacement("BAD", "WORSE")));
    const result = await run();
    expect(result).toMatchObject({ success: false, errorType: "REPAIR_UNRESOLVED", rootFailure: { stderr: initialError } });
    expect(result.errorLog).toContain(initialError);
    expect(read()).toBe("BAD");
  });

  test("TEST B: oldText === newText returns NO_OP_PATCH_EDIT", () => {
    const edits: FilePatchEdit[] = [{ oldText: "const a = 1;", newText: "const a = 1;" }];
    const result = applyPatchToFile("const a = 1;", edits);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe("NO_OP_PATCH_EDIT");
  });

  test("TEST C: a no-op repair is never written to disk", async () => {
    const { run, tx } = fixture();
    const model = jest.spyOn(LLMGateway.getInstance(), "callStructured").mockResolvedValue(fake(replacement("BAD", "BAD")));
    await expect(run()).resolves.toMatchObject({ success: false, errorType: "REPAIR_UNRESOLVED" });
    expect(model).toHaveBeenCalledTimes(3);
    expect(read()).toBe("BAD");
    expect(tx.transitions).toHaveLength(1);
  });

  test("TEST D: repeating a proposal cannot repeatedly apply it to descendant bytes", async () => {
    const { run, tx } = fixture();
    const model = jest.spyOn(LLMGateway.getInstance(), "callStructured").mockResolvedValue(fake(replacement("BAD", "BAD2")));
    await expect(run()).resolves.toMatchObject({ success: false, errorType: "REPAIR_UNRESOLVED", patchesAppliedCount: 1 });
    expect(model).toHaveBeenCalledTimes(4);
    expect(read()).toBe("BAD2");
    expect(tx.transitions).toHaveLength(2);
  });

  test("TEST E: invalid repair receives at most two structured corrections", async () => {
    const { run } = fixture();
    const model = jest.spyOn(LLMGateway.getInstance(), "callStructured")
      .mockResolvedValueOnce(fake({ action: "modify", oldText: "" }))
      .mockResolvedValueOnce(fake(replacement("BAD", "BAD")))
      .mockResolvedValueOnce(fake(replacement()));
    await expect(run()).resolves.toMatchObject({ success: true, modelRepairAttempts: 3 });
    expect(model).toHaveBeenCalledTimes(3);
    expect(model.mock.calls[1][0].messages[1].content).toContain("Structured correction required");
    expect(read()).toBe("FIXED");
  });

  test("TEST F: repeated no-op corrections stop after the two-correction budget", async () => {
    const { run, builds } = fixture();
    const model = jest.spyOn(LLMGateway.getInstance(), "callStructured").mockResolvedValue(fake(replacement("BAD", "BAD")));
    await expect(run()).resolves.toMatchObject({ success: false, errorType: "REPAIR_UNRESOLVED", attempts: 3 });
    expect(model).toHaveBeenCalledTimes(3);
    expect(builds).toHaveBeenCalledTimes(2);
  });

  test("TEST G: SelfHealing receives CURRENT post-generation file content directly from disk", async () => {
    const { run, tx } = fixture();
    const model = jest.spyOn(LLMGateway.getInstance(), "callStructured").mockResolvedValue(fake(replacement()));
    await expect(run()).resolves.toMatchObject({ success: true });
    const context = JSON.parse(String(model.mock.calls[0][0].messages[1].content));
    expect(context.currentFiles).toEqual([{ path: relativePath, content: "BAD", expectedFileHash: fingerprintBytes("BAD") }]);
    expect(context.currentRevision).toBe(tx.transitions[0].childRevision);
    expect(context.originalTask).toBe("Modify src/index.ts");
    expect(context.introducedFailures).toHaveLength(1);
  });

  test("TEST H: external source changes while the model runs invalidate the transaction", async () => {
    const { run, tx } = fixture();
    jest.spyOn(LLMGateway.getInstance(), "callStructured").mockImplementation(async () => {
      fs.writeFileSync(path.join(tempDir, relativePath), "external");
      return fake(replacement());
    });
    await expect(run()).resolves.toMatchObject({ success: false, errorType: "TRANSACTION_REVISION_DIVERGED" });
    expect(read()).toBe("external");
    expect(tx.status).toBe("INVALIDATED");
    expect(tx.transitions).toHaveLength(1);
  });

  test("TEST I: valid repair applies and triggers validation in the disposable workspace", async () => {
    const { run, builds, tx } = fixture();
    jest.spyOn(LLMGateway.getInstance(), "callStructured").mockResolvedValue(fake(replacement()));
    await expect(run()).resolves.toMatchObject({ success: true, repairApplied: true, patchesAppliedCount: 1, buildAttemptsCount: 3 });
    expect(builds).toHaveBeenCalledTimes(3);
    expect(builds.mock.calls[2][1]).not.toBe(tempDir);
    expect(read()).toBe("FIXED");
    expect(tx.transitions).toHaveLength(2);
  });

  test("TEST J: rejected repair does not increment successful patchesAppliedCount", async () => {
    const { run } = fixture();
    jest.spyOn(LLMGateway.getInstance(), "callStructured").mockResolvedValue(fake(replacement("missing", "FIXED", "BAD")));
    await expect(run()).resolves.toMatchObject({ success: false, patchesAppliedCount: 0, repairApplied: false });
    expect(read()).toBe("BAD");
  });

  test("TEST K: buildAttempts only counts actual validation invocations", async () => {
    const { run, builds } = fixture();
    jest.spyOn(LLMGateway.getInstance(), "callStructured").mockResolvedValue(fake(replacement("missing", "FIXED", "BAD")));
    const result = await run();
    expect(result.buildAttemptsCount).toBe(builds.mock.calls.length);
    expect(result.buildAttemptsCount).toBe(2);
    expect(result.modelRepairAttempts).toBe(3);
  });

  // ── TEST L: raw eval() generation remains security-flagged ────────────────
  test("TEST L: raw eval() generation remains security-flagged", async () => {
    const evalChanges = [
      {
        path: "components/Calculator.tsx",
        content: `export function calculate(expr: string) { return eval(expr); }`,
        action: "create" as const,
        description: "Calculator with eval",
      },
    ];

    const audit = await SecurityAuditor.runReflectionAndSecurityAudit(evalChanges);
    expect(audit.securityPass).toBe(false);
    expect(audit.riskLevel).toBe("HIGH");
    expect(audit.vulnerabilities?.some((v) => v.issue.includes("eval"))).toBe(true);
  });

  // ── TEST M: normal safe calculator logic without eval is security-valid ──
  test("TEST M: normal safe calculator logic without eval is security-valid", async () => {
    const safeCalcChanges = [
      {
        path: "components/Calculator.tsx",
        content: `export function calculate(a: number, op: string, b: number) {
          switch(op) {
            case '+': return a + b;
            case '-': return a - b;
            case '*': return a * b;
            case '/': return b !== 0 ? a / b : 0;
            default: return 0;
          }
        }`,
        action: "create" as const,
        description: "Safe calculator",
      },
    ];

    const mockOpenAI = {
      chat: {
        completions: {
          create: jest.fn()
            .mockResolvedValueOnce({
              choices: [{
                finish_reason: "stop",
                message: {
                  content: JSON.stringify({
                    score: 0.95,
                    passed: true,
                    critique: [],
                    improvements: "",
                  }),
                },
              }],
            })
            .mockResolvedValueOnce({
              choices: [{
                finish_reason: "stop",
                message: {
                  content: JSON.stringify({
                    passed: true,
                    riskLevel: "LOW",
                    vulnerabilities: [],
                    recommendations: [],
                  }),
                },
              }],
            }),
        },
      },
    };
    jest.spyOn(sharedUtils, "getOpenAI").mockReturnValue(mockOpenAI as any);

    const audit = await SecurityAuditor.runReflectionAndSecurityAudit(safeCalcChanges);
    expect(audit.securityPass).toBe(true);
    expect(audit.riskLevel).toBe("LOW");
  });
});
