import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { AuthorizedCapabilityScope, CapabilityGrant, CapabilityGuard } from "../runtime/CapabilityGuard";
import { FileSystemStateManager } from "../validation/FileSystemStateManager";
import {
  SelfHealingEngine,
  MAX_TOTAL_REPAIR_CYCLES,
  MAX_NO_PROGRESS_CYCLES,
  MAX_IDENTICAL_FAILURES,
  MAX_IDENTICAL_REPAIR_PROPOSAL,
  MAX_REPAIR_WALL_TIME_MS,
  isRepairableSourceFailure,
  computeFailureFingerprint,
  SPECIFIC_GATE_ERRORS,
} from "../repair/SelfHealingEngine";
import { ValidationRunner } from "../validation/ValidationRunner";
import * as sharedUtils from "../shared/utils";
import { AgentFileChange } from "../shared/types";
import { FileManifest } from "../../types";
import { mutationFixtureScope } from "./helpers/mutation-fixture";
import { MutationTransaction } from "../runtime/MutationTransaction";
import { reconcileExecutionManifest } from "../runtime/ExecutionManifest";
import { LLMGateway } from "../gateway/LLMGateway";
import { fingerprintBytes } from "../editing/EditingPrimitives";


function createScopedFsManager(
  worktree: string,
  stageId: string,
  grants: Array<{ path: string; action: "FILE_MODIFY" | "FILE_CREATE" | "FILE_DELETE" }>,
): FileSystemStateManager {
  const authorizedScope = AuthorizedCapabilityScope.fromBackendConfiguration({
    workspaceRoot: worktree,
    authorityId: stageId,
    grants: grants.map((g) => ({ path: g.path, action: g.action })),
  });
  if (!authorizedScope) {
    throw new Error(`Failed to create AuthorizedCapabilityScope for ${stageId}`);
  }
  const guard = CapabilityGuard.create({
    workspaceRoot: worktree,
    scopeId: stageId,
    authorizedScope,
  });
  return new FileSystemStateManager(guard, stageId);
}

describe("Step 1, 2 & 3 — BUILD-TO-CLEAN SelfHealing with Golden Sequence & Telemetry", () => {
  const dummyManifest: FileManifest = {
    manifestVersion: "1.0.0",
    totalFiles: 1,
    files: [
      {
        path: "src/calculator.ts",
        action: "modify",
        description: "Calculator implementation",
        dependencies: [],
      },
    ],
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("1. computeFailureFingerprint normalizes volatile values and creates deterministic signatures", () => {
    const rawError1 = "\u001b[31mC:\\temp\\anka-worktrees\\run-12345\\src\\calculator.ts(10,5): error TS2322: Type 'number' is not assignable to type 'string'.\u001b[39m";
    const diags1 = [{ file: "src/calculator.ts", line: 10, code: "TS2322", message: "Type mismatch" }];

    const fp1 = computeFailureFingerprint("COMPILE_TS", rawError1, diags1);
    expect(fp1).toBe("COMPILE_TS|src/calculator.ts:TS2322:10");

    // Same error in a different temp worktree with different ANSI styling must produce the EXACT same fingerprint
    const rawError2 = "/tmp/anka-worktrees/run-99999/src/calculator.ts(10,5): error TS2322: Type 'number' is not assignable to type 'string'.";
    const diags2 = [{ file: "src/calculator.ts", line: 10, code: "TS2322", message: "Type mismatch" }];

    const fp2 = computeFailureFingerprint("COMPILE_TS", rawError2, diags2);
    expect(fp2).toBe(fp1);
  });

  test("2. isRepairableSourceFailure correctly filters baseline/infra failures and permits source errors", () => {
    // Repairable
    expect(isRepairableSourceFailure({ type: "COMPILE_TS", isCompile: true })).toBe(true);
    expect(isRepairableSourceFailure({ type: "COMPILE_NEXT", isCompile: true })).toBe(true);
    expect(isRepairableSourceFailure({ type: "COMPILE_JS", isCompile: true })).toBe(true);
    expect(isRepairableSourceFailure({ type: "TEST_FAILURE" })).toBe(true);
    expect(isRepairableSourceFailure({ type: "LINT" })).toBe(true);
    expect(isRepairableSourceFailure({ type: "CSS_PARSE" })).toBe(true);

    // Non-repairable (must fast-halt)
    expect(isRepairableSourceFailure({ type: "INFRA", isInfrastructure: true })).toBe(false);
    expect(isRepairableSourceFailure({ type: "ENVIRONMENT" })).toBe(false);
    expect(isRepairableSourceFailure({ type: "INVALID_PACKAGE_DEPENDENCY" })).toBe(false);
    expect(isRepairableSourceFailure({ type: "PEER_DEPENDENCY_CONFLICT" })).toBe(false);
    expect(isRepairableSourceFailure({ type: "LOCKFILE_OUT_OF_SYNC" })).toBe(false);
    expect(isRepairableSourceFailure({ type: "DEPENDENCY_NETWORK" })).toBe(false);
    expect(isRepairableSourceFailure({ type: "SYSTEM_INFRASTRUCTURE" })).toBe(false);
    expect(isRepairableSourceFailure({ type: "BASELINE_REPOSITORY_UNHEALTHY" })).toBe(false);
  });

  test("3. Build success stops immediately on attempt 1 without entering unnecessary repair loops", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "anka-test-sh-"));
    const srcDir = path.join(tempDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    const initialContent = "export const add = (a: number, b: number) => a + b;";
    fs.writeFileSync(path.join(srcDir, "calculator.ts"), initialContent, "utf8");

    const initialChanges: AgentFileChange[] = [
      { path: "src/calculator.ts", content: initialContent, action: "modify", description: "Implement add" },
    ];

    const fsManager = createScopedFsManager(tempDir, "sh-stage", [{ path: "src/calculator.ts", action: "FILE_MODIFY" }]);
    await fsManager.snapshot(initialChanges, tempDir);

    const validateSpy = jest.spyOn(ValidationRunner, "validateWithShell").mockResolvedValue({
      success: true,
      errors: "",
    });

    const res = await SelfHealingEngine.runSelfHealingLoop(
      initialChanges,
      tempDir,
      ["npm run build"],
      "system prompt",
      "implement add",
      fsManager,
      undefined,
      undefined,
      dummyManifest,
      { pipeline: "STANDALONE", targetPaths: ["src/calculator.ts"] } as any,
    );

    expect(res.success).toBe(true);
    expect(res.attempts).toBe(1);
    expect(res.validationDetails?.finalStatus).toBe("BUILD_CLEAN");
    expect(validateSpy).toHaveBeenCalledTimes(1);

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function runProgressFixture(initialCount: number, neutral = false) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "anka-monotonic-progress-"));
    const file = "src/calculator.ts";
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, file), "0");
    const changes: AgentFileChange[] = [{ path: file, action: "modify", content: String(initialCount), description: "initial" }];
    const scope = mutationFixtureScope(root, changes);
    const manifest = reconcileExecutionManifest(scope, null);
    const tx = MutationTransaction.create(scope, manifest);
    const manager = new FileSystemStateManager(CapabilityGuard.forTransaction(tx, tx.primary), tx.id, tx);
    const builds = jest.spyOn(ValidationRunner, "validateWithShell").mockImplementation(async (_changes, workspace) => {
      const count = Number(fs.readFileSync(path.join(workspace!, file), "utf8"));
      const remaining = neutral && count ? 1 : count;
      return { success: !remaining, errors: Array.from({ length: remaining }, (_, index) =>
        file + "(1,1): error TS2304: Cannot find name missing_" + index + ".").join("\n") };
    });
    const model = jest.spyOn(LLMGateway.getInstance(), "callStructured").mockImplementation(async () => {
      const before = fs.readFileSync(path.join(root, file), "utf8");
      return { content: { operations: [{ op: "replace_exact", path: file, expectedFileHash: fingerprintBytes(before),
        oldText: before, newText: String(Number(before) + (neutral ? 1 : -1)) }] } } as Awaited<ReturnType<LLMGateway["callStructured"]>>;
    });
    try {
      const result = await SelfHealingEngine.runSelfHealingLoop(changes, root, ["fixture-check"], "system", "Modify src/calculator.ts",
        manager, "fixture-project", undefined, manifest);
      return { result, builds: builds.mock.calls.length, modelCalls: model.mock.calls.length,
        receipts: tx.transitions.length, content: fs.readFileSync(path.join(root, file), "utf8") };
    } finally {
      tx.abort();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  test("4. GOLDEN SEQUENCE: seven monotonic repairs exceed the previous five-repair ceiling", async () => {
    const { result, modelCalls, builds, receipts, content } = await runProgressFixture(7);
    expect(result).toMatchObject({ success: true, attempts: 7, patchesAppliedCount: 7, repositoryClean: true });
    expect(modelCalls).toBe(7);
    expect(builds).toBe(9); // Baseline, initial candidate, and seven disposable validations.
    expect(receipts).toBe(8);
    expect(content).toBe("0");
  });

  test("5. Decreasing compiler error count (3 -> 2 -> 1 -> PASS) permits promotion", async () => {
    const { result, modelCalls, builds, receipts } = await runProgressFixture(3);
    expect(result).toMatchObject({ success: true, patchesAppliedCount: 3 });
    expect(modelCalls).toBe(3);
    expect(builds).toBe(5);
    expect(receipts).toBe(4);
  });

  test("6. Identical failure after two neutral repairs halts with REPAIR_UNRESOLVED", async () => {
    const { result, modelCalls, builds, receipts } = await runProgressFixture(1, true);
    expect(result).toMatchObject({ success: false, errorType: "REPAIR_UNRESOLVED", attempts: 2 });
    expect(modelCalls).toBe(2);
    expect(builds).toBe(4);
    expect(receipts).toBe(3);
  });

  test("7. Repeated identical repair proposal stops immediately with REPEATED_REPAIR_PROPOSAL", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "anka-test-sh-"));
    const srcDir = path.join(tempDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, "calculator.ts"), "export const v = 1;", "utf8");

    const initialChanges: AgentFileChange[] = [
      { path: "src/calculator.ts", content: "export const v = 1;", action: "modify", description: "Calculator variable" },
    ];

    const fsManager = createScopedFsManager(tempDir, "sh-stage", [{ path: "src/calculator.ts", action: "FILE_MODIFY" }]);
    await fsManager.snapshot(initialChanges, tempDir);

    jest.spyOn(ValidationRunner, "validateWithShell").mockResolvedValue({
      success: false,
      errors: "src/calculator.ts(1, 1): error TS2322: Type 'number' is not assignable to type 'string'.",
    });

    // Mock returns identical proposal on both attempts
    const mockOpenAI = {
      chat: {
        completions: {
          create: jest.fn().mockResolvedValue({
            choices: [
              {
                finish_reason: "stop",
                  message: {
                  content: JSON.stringify({
                    repaired: true,
                    patchExplanation: "Static duplicate fix",
                    changes: [
                      {
                        path: "src/calculator.ts",
                        action: "modify",
                        description: "Static fix",
                        edits: [
                          {
                            oldText: "export const v = 1;",
                            newText: "export const v = 2;",
                          },
                        ],
                      },
                    ],
                  }),
                },
              },
            ],
          }),
        },
      },
    };

    jest.spyOn(sharedUtils, "getOpenAI").mockReturnValue(mockOpenAI as any);

        const res = await SelfHealingEngine.runSelfHealingLoop(
      initialChanges,
      tempDir,
      ["npm run build"],
      "system prompt",
      "fix error",
      fsManager,
      undefined,
      undefined,
      dummyManifest,
      { pipeline: "STANDALONE", targetPaths: ["src/calculator.ts"] } as any,
    );

    expect(res.success).toBe(false);
    expect(res.errorType).toBe("REPEATED_REPAIR_PROPOSAL");
    expect(res.validationDetails?.repeatedProposalsBlockedCount).toBe(1);
    expect(res.validationDetails?.finalStatus).toBe("FAILED");
  });

  test("8. Repair proposal targeting undeclared file is rejected by scope enforcer", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "anka-test-sh-"));
    const srcDir = path.join(tempDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, "calculator.ts"), "export const v = 1;", "utf8");

    const initialChanges: AgentFileChange[] = [
      { path: "src/calculator.ts", content: "export const v = 1;", action: "modify", description: "Calculator variable" },
    ];

    const fsManager = createScopedFsManager(tempDir, "sh-stage", [{ path: "src/calculator.ts", action: "FILE_MODIFY" }]);
    await fsManager.snapshot(initialChanges, tempDir);

    jest.spyOn(ValidationRunner, "validateWithShell").mockResolvedValue({
      success: false,
      errors: "src/calculator.ts(1, 1): error TS2304: Cannot find name 'helper'.",
    });

    const mockOpenAI = {
      chat: {
        completions: {
          create: jest.fn().mockResolvedValue({
            choices: [
              {
                finish_reason: "stop",
                  message: {
                  content: JSON.stringify({
                    repaired: true,
                    patchExplanation: "Create undeclared helper",
                    changes: [
                      {
                        path: "src/undeclared-helper.ts",
                        action: "create",
                        description: "Undeclared helper",
                        content: "export const helper = () => 42;",
                      },
                    ],
                  }),
                },
              },
            ],
          }),
        },
      },
    };

    jest.spyOn(sharedUtils, "getOpenAI").mockReturnValue(mockOpenAI as any);

    await expect(
      SelfHealingEngine.runSelfHealingLoop(
        initialChanges,
        tempDir,
        ["npm run build"],
        "system prompt",
        "fix error",
        fsManager,
        undefined,
        undefined,
        dummyManifest,
        { pipeline: "REPOSITORY", targetPaths: ["src/calculator.ts"] } as any,
      )
    ).resolves.toMatchObject({ success: false, errorType: "REPAIR_UNRESOLVED" });
    expect(fs.existsSync(path.join(tempDir, "src/undeclared-helper.ts"))).toBe(false);

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test("9. Emergency Safety Budget constants and SPECIFIC_GATE_ERRORS are properly configured", () => {
    expect(MAX_TOTAL_REPAIR_CYCLES).toBe(15);
    expect(MAX_NO_PROGRESS_CYCLES).toBe(2);
    expect(MAX_IDENTICAL_FAILURES).toBe(2);
    expect(MAX_IDENTICAL_REPAIR_PROPOSAL).toBe(1);
    expect(MAX_REPAIR_WALL_TIME_MS).toBe(600000);
    expect(SPECIFIC_GATE_ERRORS.has("NO_REPAIR_PROGRESS")).toBe(true);
    expect(SPECIFIC_GATE_ERRORS.has("REPEATED_REPAIR_PROPOSAL")).toBe(true);
    expect(SPECIFIC_GATE_ERRORS.has("SCOPE_VIOLATION")).toBe(true);
    expect(SPECIFIC_GATE_ERRORS.has("STALE_REPAIR_SOURCE")).toBe(true);
  });
});
