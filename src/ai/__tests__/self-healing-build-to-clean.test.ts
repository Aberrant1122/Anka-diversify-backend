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
    const initialChanges: AgentFileChange[] = [
      { path: "src/calculator.ts", content: "export const add = (a: number, b: number) => a + b;", action: "modify", description: "Implement add" },
    ];

    const validateSpy = jest.spyOn(ValidationRunner, "selfReviewChanges").mockResolvedValue({
      success: true,
      errors: "",
    });

    const res = await SelfHealingEngine.runSelfHealingLoop(
      initialChanges,
      null,
      [],
      "system prompt",
      "implement add",
      undefined,
      undefined,
      undefined,
      dummyManifest,
      { pipeline: "STANDALONE", targetPaths: ["src/calculator.ts"] } as any,
    );

    expect(res.success).toBe(true);
    expect(res.attempts).toBe(1);
    expect(res.validationDetails?.finalStatus).toBe("BUILD_CLEAN");
    expect(validateSpy).toHaveBeenCalledTimes(1);
  });

  test("4. GOLDEN SEQUENCE: 7 sequential distinct repairable errors exceed previous 5-repair ceiling and succeed", async () => {
    const initialChanges: AgentFileChange[] = [
      { path: "src/calculator.ts", content: "export const v = 1;", action: "modify", description: "Calculator variable" },
    ];

    // Simulate 6 distinct failing builds followed by a clean build on Build 7:
    // Build 1: TS2322 (Type mismatch)
    // Build 2: CLIENT_DIRECTIVE_REQUIRED (Next.js client directive)
    // Build 3: CSS_PARSE (CSS invalid selector)
    // Build 4: TS2307 (Cannot find module)
    // Build 5: TS2345 (Argument type mismatch)
    // Build 6: JSX_ERROR (JSX syntax error)
    // Build 7: Clean build (PASS)
    const failureOutputs = [
      "src/calculator.ts(10,5): error TS2322: Type 'number' is not assignable to type 'string'.",
      "src/calculator.tsx(5,1): error CLIENT_DIRECTIVE_REQUIRED: useState requires 'use client' directive.",
      "src/styles.css(12,1): error CSS_PARSE: Invalid pseudo-class selector.",
      "src/calculator.ts(2,1): error TS2304: Cannot find name 'computePercentage'.",
      "src/calculator.ts(15,8): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
      "src/calculator.tsx(20,3): error TS17004: Cannot use JSX unless the '--jsx' flag is provided.",
    ];

    let callCount = 0;
    jest.spyOn(ValidationRunner, "selfReviewChanges").mockImplementation(async () => {
      callCount++;
      if (callCount <= failureOutputs.length) {
        return {
          success: false,
          errors: failureOutputs[callCount - 1],
        };
      }
      return {
        success: true,
        errors: "",
      };
    });

    let repairIdx = 0;
    const mockOpenAI = {
      chat: {
        completions: {
          create: jest.fn().mockImplementation(async () => {
            repairIdx++;
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      repaired: true,
                      patchExplanation: `Resolve error step ${repairIdx}`,
                      changes: [
                        {
                          path: "src/calculator.ts",
                          action: "modify",
                          description: `Resolve error step ${repairIdx}`,
                          edits: [
                            {
                              oldText: `export const v = ${repairIdx};`,
                              newText: `export const v = ${repairIdx + 1};`,
                            },
                          ],
                        },
                      ],
                    }),
                  },
                },
              ],
            };
          }),
        },
      },
    };

    jest.spyOn(sharedUtils, "getOpenAI").mockReturnValue(mockOpenAI as any);

    const res = await SelfHealingEngine.runSelfHealingLoop(
      initialChanges,
      null,
      [],
      "system prompt",
      "fix all sequential errors",
      undefined,
      undefined,
      undefined,
      dummyManifest,
      { pipeline: "STANDALONE", targetPaths: ["src/calculator.ts"] } as any,
    );

    // Verified: Engine continued past attempt 5 and succeeded on attempt 7!
    expect(res.success).toBe(true);
    expect(res.attempts).toBe(7);
    expect(callCount).toBe(7);
    expect(res.validationDetails?.finalStatus).toBe("BUILD_CLEAN");
    expect(res.validationDetails?.modelRepairAttempts).toBe(6);
    expect(res.validationDetails?.patchesApplied).toBe(6);
    expect(res.validationDetails?.distinctFailuresResolvedCount).toBeGreaterThanOrEqual(5);
    expect(res.validationDetails?.resolvedFailureSequence).toEqual(
      expect.arrayContaining(["TS2322", "CLIENT_DIRECTIVE_REQUIRED", "CSS_PARSE", "TS2304", "TS2345", "TS17004"])
    );
  });

  test("5. Decreasing compiler error count (3 -> 2 -> 1 -> PASS) is valid progress and allows continuation", async () => {
    const initialChanges: AgentFileChange[] = [
      { path: "src/calculator.ts", content: "export const v = 1;", action: "modify", description: "Calculator variable" },
    ];

    let callCount = 0;
    jest.spyOn(ValidationRunner, "selfReviewChanges").mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          success: false,
          errors: "src/calculator.ts(1,1): error TS2304: Cannot find name 'a'.\nsrc/calculator.ts(2,1): error TS2304: Cannot find name 'b'.\nsrc/calculator.ts(3,1): error TS2304: Cannot find name 'c'.",
        };
      }
      if (callCount === 2) {
        return {
          success: false,
          errors: "src/calculator.ts(2,1): error TS2304: Cannot find name 'b'.\nsrc/calculator.ts(3,1): error TS2304: Cannot find name 'c'.",
        };
      }
      if (callCount === 3) {
        return {
          success: false,
          errors: "src/calculator.ts(3,1): error TS2304: Cannot find name 'c'.",
        };
      }
      return {
        success: true,
        errors: "",
      };
    });

    let repairIdx = 0;
    const mockOpenAI = {
      chat: {
        completions: {
          create: jest.fn().mockImplementation(async () => {
            repairIdx++;
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      repaired: true,
                      patchExplanation: `Resolve error ${repairIdx}`,
                      changes: [
                        {
                          path: "src/calculator.ts",
                          action: "modify",
                          description: `Resolve error ${repairIdx}`,
                          edits: [
                            {
                              oldText: `export const v = ${repairIdx};`,
                              newText: `export const v = ${repairIdx + 1};`,
                            },
                          ],
                        },
                      ],
                    }),
                  },
                },
              ],
            };
          }),
        },
      },
    };

    jest.spyOn(sharedUtils, "getOpenAI").mockReturnValue(mockOpenAI as any);

    const res = await SelfHealingEngine.runSelfHealingLoop(
      initialChanges,
      null,
      [],
      "system prompt",
      "fix all errors",
      undefined,
      undefined,
      undefined,
      dummyManifest,
      { pipeline: "STANDALONE", targetPaths: ["src/calculator.ts"] } as any,
    );

    expect(res.success).toBe(true);
    expect(res.attempts).toBe(4);
    expect(callCount).toBe(4);
    expect(res.validationDetails?.finalStatus).toBe("BUILD_CLEAN");
  });

  test("6. Identical failure persisting after 2 applied repairs halts with NO_REPAIR_PROGRESS", async () => {
    const initialChanges: AgentFileChange[] = [
      { path: "src/calculator.ts", content: "export const v = 1;", action: "modify", description: "Calculator variable" },
    ];

    let callCount = 0;
    jest.spyOn(ValidationRunner, "selfReviewChanges").mockImplementation(async () => {
      callCount++;
      return {
        success: false,
        errors: "src/calculator.ts(1, 1): error TS2322: Type 'number' is not assignable to type 'string'.",
      };
    });

    let proposalCount = 0;
    const mockOpenAI = {
      chat: {
        completions: {
          create: jest.fn().mockImplementation(async () => {
            proposalCount++;
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      repaired: true,
                      patchExplanation: `Attempt fix ${proposalCount}`,
                      changes: [
                        {
                          path: "src/calculator.ts",
                          action: "modify",
                          description: `Attempt fix ${proposalCount}`,
                          edits: [
                            {
                              oldText: `export const v = ${proposalCount};`,
                              newText: `export const v = ${proposalCount + 1};`,
                            },
                          ],
                        },
                      ],
                    }),
                  },
                },
              ],
            };
          }),
        },
      },
    };

    jest.spyOn(sharedUtils, "getOpenAI").mockReturnValue(mockOpenAI as any);

    const res = await SelfHealingEngine.runSelfHealingLoop(
      initialChanges,
      null,
      [],
      "system prompt",
      "fix error",
      undefined,
      undefined,
      undefined,
      dummyManifest,
      { pipeline: "STANDALONE", targetPaths: ["src/calculator.ts"] } as any,
    );

    expect(res.success).toBe(false);
    expect(res.errorType).toBe("NO_REPAIR_PROGRESS");
    expect(res.validationDetails?.finalStatus).toBe("FAILED");
    expect(callCount).toBeLessThanOrEqual(3);
  });

  test("7. Repeated identical repair proposal stops immediately with REPEATED_REPAIR_PROPOSAL", async () => {
    const initialChanges: AgentFileChange[] = [
      { path: "src/calculator.ts", content: "export const v = 1;", action: "modify", description: "Calculator variable" },
    ];

    jest.spyOn(ValidationRunner, "selfReviewChanges").mockResolvedValue({
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
      null,
      [],
      "system prompt",
      "fix error",
      undefined,
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
    const initialChanges: AgentFileChange[] = [
      { path: "src/calculator.ts", content: "export const v = 1;", action: "modify", description: "Calculator variable" },
    ];

    jest.spyOn(ValidationRunner, "selfReviewChanges").mockResolvedValue({
      success: false,
      errors: "src/calculator.ts(1, 1): error TS2304: Cannot find name 'helper'.",
    });

    const mockOpenAI = {
      chat: {
        completions: {
          create: jest.fn().mockResolvedValue({
            choices: [
              {
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

    const res = await SelfHealingEngine.runSelfHealingLoop(
      initialChanges,
      null,
      [],
      "system prompt",
      "fix error",
      undefined,
      undefined,
      undefined,
      dummyManifest,
      { pipeline: "REPOSITORY", targetPaths: ["src/calculator.ts"] } as any,
    );

    expect(res.success).toBe(false);
    expect(res.errorType).toBe("REPAIR_UNDECLARED_FILE");
  });

  test("9. Emergency Safety Budget constants and SPECIFIC_GATE_ERRORS are properly configured", () => {
    expect(MAX_TOTAL_REPAIR_CYCLES).toBe(15);
    expect(MAX_NO_PROGRESS_CYCLES).toBe(2);
    expect(MAX_IDENTICAL_FAILURES).toBe(2);
    expect(MAX_IDENTICAL_REPAIR_PROPOSAL).toBe(1);
    expect(MAX_REPAIR_WALL_TIME_MS).toBe(600000);
    expect(SPECIFIC_GATE_ERRORS.has("NO_REPAIR_PROGRESS")).toBe(true);
    expect(SPECIFIC_GATE_ERRORS.has("REPEATED_REPAIR_PROPOSAL")).toBe(true);
    expect(SPECIFIC_GATE_ERRORS.has("SCOPE_EXPANSION_REQUIRED")).toBe(true);
    expect(SPECIFIC_GATE_ERRORS.has("STALE_REPAIR_SOURCE")).toBe(true);
  });
});
