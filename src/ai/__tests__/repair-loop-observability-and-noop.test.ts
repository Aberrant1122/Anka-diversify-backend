import fs from "fs";
import path from "path";
import os from "os";
import { SelfHealingEngine } from "../repair/SelfHealingEngine";
import { FileSystemStateManager } from "../validation/FileSystemStateManager";
import { ValidationRunner } from "../validation/ValidationRunner";
import { SecurityAuditor } from "../review/SecurityAuditor";
import { applyPatchToFile, FilePatchEdit } from "../patch/PatchApplicator";
import { PatchCorrectionEngine } from "../generation/PatchCorrectionEngine";
import { FileManifest, ExecutionContract } from "../../types";
import * as sharedUtils from "../shared/utils";

describe("Repair Loop Observability & No-Op Repair Handling (Section 10)", () => {
  let tempDir: string;

  const sampleManifest = (filePath: string): FileManifest => ({
    files: [{ path: filePath, action: "modify", dependencies: [], description: "Modify file" }],
    totalFiles: 1,
    manifestVersion: "1.0.0",
  });

  const sampleContract = (filePath: string): ExecutionContract => ({
    goal: "Fix bug",
    taskType: "BUG_FIX",
    risk: "LOW",
    estimatedComplexity: "SMALL",
    pipeline: "REPOSITORY",
    environment: "REACT_TS",
    repositoryRequired: true,
    expectedFiles: [filePath],
    validationType: "TYPESCRIPT_BUILD",
    targetPaths: [filePath],
    allowedActions: ["modify"],
    forbiddenActions: [],
    maxFiles: 1,
    searchScope: ["src", "app"],
    contextScope: [filePath],
    diffCriticEnabled: true,
  });

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "anka-repair-obs-test-"));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ── TEST A: initial compiler stderr remains rootFailure after repair failure ──
  test("TEST A: initial compiler stderr remains rootFailure after repair failure", async () => {
    const pageFile = path.join(tempDir, "app/page.tsx");
    fs.mkdirSync(path.dirname(pageFile), { recursive: true });
    fs.writeFileSync(pageFile, "export default function Page() { return <div>Original</div>; }\n");

    const initialBuildError = "Type error: Property 'Calculator' does not exist on type 'JSX.IntrinsicElements'.\n  at app/page.tsx:5:10";

    jest.spyOn(ValidationRunner, "validateWithShell").mockResolvedValue({
      success: false,
      errors: initialBuildError,
    });

    const mockOpenAI = {
      chat: {
        completions: {
          create: jest.fn().mockResolvedValue({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    changes: [
                      {
                        path: "app/page.tsx",
                        action: "modify",
                        description: "No-op edit",
                        edits: [
                          {
                            oldText: "export default function Page() { return <div>Original</div>; }\n",
                            newText: "export default function Page() { return <div>Original</div>; }\n",
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
    jest.spyOn(PatchCorrectionEngine, "correctPatch").mockResolvedValue({
      attempted: true,
      succeeded: false,
      error: "Could not correct no-op edit",
    });

    const result = await SelfHealingEngine.runSelfHealingLoop(
      [{ path: "app/page.tsx", action: "modify", content: "export default function Page() { return <div>Modified</div>; }\n", description: "initial" }],
      tempDir,
      ["npm run build"],
      "system prompt",
      "user message",
      new FileSystemStateManager(),
      "test-proj",
      undefined,
      sampleManifest("app/page.tsx"),
      sampleContract("app/page.tsx"),
    );

    expect(result.success).toBe(false);
    expect(result.errorType).toBe("NO_OP_PATCH_EDIT");
    expect(result.rootFailure).toBeDefined();
    expect(result.rootFailure?.stderr).toBe(initialBuildError);
    expect(result.errorLog).toContain("ROOT BUILD FAILURE:");
    expect(result.errorLog).toContain(initialBuildError);
    expect(result.errorLog).toContain("NO_OP_PATCH_EDIT");
  });

  // ── TEST B: oldText === newText returns NO_OP_PATCH_EDIT ───────────────────
  test("TEST B: oldText === newText returns NO_OP_PATCH_EDIT", () => {
    const source = "const a = 10;\n";
    const edit: FilePatchEdit = { oldText: "const a = 10;\n", newText: "const a = 10;\n" };
    const res = applyPatchToFile(source, [edit]);
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.code).toBe("NO_OP_PATCH_EDIT");
    }
  });

  // ── TEST C: a no-op repair is never written to disk ───────────────────────
  test("TEST C: a no-op repair is never written to disk", async () => {
    const filePath = path.join(tempDir, "src/index.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const originalContent = "const initial = 1;\n";
    fs.writeFileSync(filePath, originalContent);

    jest.spyOn(ValidationRunner, "validateWithShell").mockResolvedValue({
      success: false,
      errors: "Error: some compiler error",
    });

    const mockOpenAI = {
      chat: {
        completions: {
          create: jest.fn().mockResolvedValue({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    changes: [
                      {
                        path: "src/index.ts",
                        action: "modify",
                        description: "no-op",
                        edits: [{ oldText: "const initial = 1;\n", newText: "const initial = 1;\n" }],
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
    jest.spyOn(PatchCorrectionEngine, "correctPatch").mockResolvedValue({
      attempted: true,
      succeeded: false,
    });

    await SelfHealingEngine.runSelfHealingLoop(
      [{ path: "src/index.ts", action: "modify", content: "const initial = 1;\n", description: "initial" }],
      tempDir,
      ["npm run build"],
      "prompt",
      "message",
      new FileSystemStateManager(),
      "test-proj",
      undefined,
      sampleManifest("src/index.ts"),
      sampleContract("src/index.ts"),
    );

    // Verify disk content was not mutated
    const diskContent = fs.readFileSync(filePath, "utf8");
    expect(diskContent).toBe(originalContent);
  });

  // ── TEST D: same repair proposal cannot be retried repeatedly ────────────
  test("TEST D: same repair proposal cannot be retried repeatedly (REPEATED_REPAIR_PROPOSAL)", async () => {
    const filePath = path.join(tempDir, "src/index.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "const x = 1;\n");

    let buildCount = 0;
    jest.spyOn(ValidationRunner, "validateWithShell").mockImplementation(async () => {
      buildCount++;
      return { success: false, errors: "TS2322: Type 'number' is not assignable to type 'string'" };
    });

    // Model keeps returning the same repair proposal that fails verification
    const mockOpenAI = {
      chat: {
        completions: {
          create: jest.fn().mockResolvedValue({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    changes: [
                      {
                        path: "src/index.ts",
                        action: "modify",
                        description: "edit x",
                        edits: [{ oldText: "const x = 1;\n", newText: "const x = 2;\n" }],
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

    const result = await SelfHealingEngine.runSelfHealingLoop(
      [{ path: "src/index.ts", action: "modify", content: "const x = 1;\n", description: "initial" }],
      tempDir,
      ["npm run build"],
      "prompt",
      "message",
      new FileSystemStateManager(),
      "test-proj",
      undefined,
      sampleManifest("src/index.ts"),
      sampleContract("src/index.ts"),
    );

    expect(result.success).toBe(false);
    expect(result.errorType).toBe("REPEATED_REPAIR_PROPOSAL");
    expect(result.attempts).toBeLessThanOrEqual(2);
  });

  // ── TEST E: invalid repair gets max one bounded correction ───────────────
  test("TEST E: invalid repair gets max one bounded correction", async () => {
    const filePath = path.join(tempDir, "src/index.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "const target = 'real';\n");

    jest.spyOn(ValidationRunner, "validateWithShell").mockResolvedValue({
      success: false,
      errors: "TS error in src/index.ts",
    });

    const mockOpenAI = {
      chat: {
        completions: {
          create: jest.fn().mockResolvedValue({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    changes: [
                      {
                        path: "src/index.ts",
                        action: "modify",
                        description: "wrong target",
                        edits: [{ oldText: "const nonexistent = 'fake';", newText: "const fixed = 1;" }],
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

    let correctionCalls = 0;
    jest.spyOn(PatchCorrectionEngine, "correctPatch").mockImplementation(async () => {
      correctionCalls++;
      return { attempted: true, succeeded: false };
    });

    await SelfHealingEngine.runSelfHealingLoop(
      [{ path: "src/index.ts", action: "modify", content: "const target = 'real';\n", description: "initial" }],
      tempDir,
      ["npm run build"],
      "prompt",
      "message",
      new FileSystemStateManager(),
      "test-proj",
      undefined,
      sampleManifest("src/index.ts"),
      sampleContract("src/index.ts"),
    );

    expect(correctionCalls).toBe(1);
  });

  // ── TEST F: second no-op correction stops immediately ────────────────────
  test("TEST F: second no-op correction stops immediately without 5 loops", async () => {
    const filePath = path.join(tempDir, "src/index.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "const x = 1;\n");

    jest.spyOn(ValidationRunner, "validateWithShell").mockResolvedValue({
      success: false,
      errors: "Compiler error in src/index.ts",
    });

    const mockOpenAI = {
      chat: {
        completions: {
          create: jest.fn().mockResolvedValue({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    changes: [
                      {
                        path: "src/index.ts",
                        action: "modify",
                        description: "no-op",
                        edits: [{ oldText: "const x = 1;\n", newText: "const x = 1;\n" }],
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

    jest.spyOn(PatchCorrectionEngine, "correctPatch").mockResolvedValue({
      attempted: true,
      succeeded: true,
      correctedEdits: [{ oldText: "const x = 1;\n", newText: "const x = 1;\n" }],
    });

    const result = await SelfHealingEngine.runSelfHealingLoop(
      [{ path: "src/index.ts", action: "modify", content: "const x = 1;\n", description: "initial" }],
      tempDir,
      ["npm run build"],
      "prompt",
      "message",
      new FileSystemStateManager(),
      "test-proj",
      undefined,
      sampleManifest("src/index.ts"),
      sampleContract("src/index.ts"),
    );

    expect(result.success).toBe(false);
    expect(result.errorType).toBe("NO_OP_PATCH_EDIT");
    expect(result.attempts).toBe(1);
  });

  // ── TEST G: SelfHealing receives CURRENT post-generation file content ────
  test("TEST G: SelfHealing receives CURRENT post-generation file content directly from disk", async () => {
    const filePath = path.join(tempDir, "app/page.tsx");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    // Write post-generation content to disk
    fs.writeFileSync(filePath, "export default function Page() { return <Calculator />; }\n");

    jest.spyOn(ValidationRunner, "validateWithShell").mockResolvedValue({
      success: false,
      errors: "Build failed: Calculator component is not imported.",
    });

    let capturedPromptContent = "";
    const mockOpenAI = {
      chat: {
        completions: {
          create: jest.fn().mockImplementation(async (opts) => {
            capturedPromptContent = opts.messages[1].content;
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      changes: [
                        {
                          path: "app/page.tsx",
                          action: "modify",
                          description: "add import",
                          edits: [
                            {
                              oldText: "export default function Page() { return <Calculator />; }\n",
                              newText: "import Calculator from '@/components/Calculator';\nexport default function Page() { return <Calculator />; }\n",
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

    await SelfHealingEngine.runSelfHealingLoop(
      [{ path: "app/page.tsx", action: "modify", content: "export default function Page() { return <Calculator />; }\n", description: "initial" }],
      tempDir,
      ["npm run build"],
      "prompt",
      "message",
      new FileSystemStateManager(),
      "test-proj",
      undefined,
      sampleManifest("app/page.tsx"),
      sampleContract("app/page.tsx"),
    );

    expect(capturedPromptContent).toContain("export default function Page() { return <Calculator />; }");
  });

  // ── TEST H: current file SHA is verified before repair application ────────
  test("TEST H: current file SHA is verified before repair application", async () => {
    const filePath = path.join(tempDir, "src/index.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "const a = 1;\n");

    jest.spyOn(ValidationRunner, "validateWithShell").mockResolvedValue({
      success: false,
      errors: "Build error in src/index.ts",
    });

    const mockOpenAI = {
      chat: {
        completions: {
          create: jest.fn().mockImplementation(async () => {
            // Mutate file behind the back of the resolver to trigger stale source
            fs.writeFileSync(filePath, "const a = 99999;\n");
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      changes: [
                        {
                          path: "src/index.ts",
                          action: "modify",
                          description: "edit a",
                          edits: [{ oldText: "const a = 1;\n", newText: "const a = 2;\n" }],
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

    const result = await SelfHealingEngine.runSelfHealingLoop(
      [{ path: "src/index.ts", action: "modify", content: "const a = 1;\n", description: "initial" }],
      tempDir,
      ["npm run build"],
      "prompt",
      "message",
      new FileSystemStateManager(),
      "test-proj",
      undefined,
      sampleManifest("src/index.ts"),
      sampleContract("src/index.ts"),
    );

    expect(result.success).toBe(false);
  });

  // ── TEST I: valid repair applies and triggers another build ───────────────
  test("TEST I: valid repair applies and triggers another build successfully", async () => {
    const filePath = path.join(tempDir, "src/index.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "const a: number = 'hello';\n");

    let buildCalls = 0;
    jest.spyOn(ValidationRunner, "validateWithShell").mockImplementation(async () => {
      buildCalls++;
      if (buildCalls === 1) {
        return { success: false, errors: "Type error: string not assignable to number" };
      }
      return { success: true, errors: "" };
    });

    const mockOpenAI = {
      chat: {
        completions: {
          create: jest.fn().mockResolvedValue({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    changes: [
                      {
                        path: "src/index.ts",
                        action: "modify",
                        description: "fix type",
                        edits: [{ oldText: "const a: number = 'hello';\n", newText: "const a: string = 'hello';\n" }],
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

    const result = await SelfHealingEngine.runSelfHealingLoop(
      [{ path: "src/index.ts", action: "modify", content: "const a: number = 'hello';\n", description: "initial" }],
      tempDir,
      ["npm run build"],
      "prompt",
      "message",
      new FileSystemStateManager(),
      "test-proj",
      undefined,
      sampleManifest("src/index.ts"),
      sampleContract("src/index.ts"),
    );

    expect(result.success).toBe(true);
    expect(result.repairApplied).toBe(true);
    expect(buildCalls).toBe(2);
    expect(result.buildAttemptsCount).toBe(2);
  });

  // ── TEST J: invalid repair does not falsely increment successful patchesApplied ──
  test("TEST J: invalid repair does not falsely increment successful patchesAppliedCount", async () => {
    const filePath = path.join(tempDir, "src/index.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "const x = 1;\n");

    jest.spyOn(ValidationRunner, "validateWithShell").mockResolvedValue({
      success: false,
      errors: "Error",
    });

    const mockOpenAI = {
      chat: {
        completions: {
          create: jest.fn().mockResolvedValue({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    changes: [
                      {
                        path: "src/index.ts",
                        action: "modify",
                        description: "no-op",
                        edits: [{ oldText: "const x = 1;\n", newText: "const x = 1;\n" }],
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
    jest.spyOn(PatchCorrectionEngine, "correctPatch").mockResolvedValue({
      attempted: true,
      succeeded: false,
    });

    const result = await SelfHealingEngine.runSelfHealingLoop(
      [{ path: "src/index.ts", action: "modify", content: "const x = 1;\n", description: "initial" }],
      tempDir,
      ["npm run build"],
      "prompt",
      "message",
      new FileSystemStateManager(),
      "test-proj",
      undefined,
      sampleManifest("src/index.ts"),
      sampleContract("src/index.ts"),
    );

    expect(result.patchesAppliedCount).toBe(0);
  });

  // ── TEST K: buildAttempts only counts actual build command executions ────
  test("TEST K: buildAttempts only counts actual build command executions", async () => {
    const filePath = path.join(tempDir, "src/index.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "const x = 1;\n");

    let actualBuildRuns = 0;
    jest.spyOn(ValidationRunner, "validateWithShell").mockImplementation(async () => {
      actualBuildRuns++;
      return { success: false, errors: "Build error" };
    });

    const mockOpenAI = {
      chat: {
        completions: {
          create: jest.fn().mockResolvedValue({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    changes: [
                      {
                        path: "src/index.ts",
                        action: "modify",
                        description: "no-op",
                        edits: [{ oldText: "const x = 1;\n", newText: "const x = 1;\n" }],
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
    jest.spyOn(PatchCorrectionEngine, "correctPatch").mockResolvedValue({ attempted: true, succeeded: false });

    const result = await SelfHealingEngine.runSelfHealingLoop(
      [{ path: "src/index.ts", action: "modify", content: "const x = 1;\n", description: "initial" }],
      tempDir,
      ["npm run build"],
      "prompt",
      "message",
      new FileSystemStateManager(),
      "test-proj",
      undefined,
      sampleManifest("src/index.ts"),
      sampleContract("src/index.ts"),
    );

    expect(result.buildAttemptsCount).toBe(actualBuildRuns);
    expect(result.buildAttemptsCount).toBe(1);
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

    const audit = await SecurityAuditor.runReflectionAndSecurityAudit(safeCalcChanges);
    expect(audit.securityPass).toBe(true);
    expect(audit.riskLevel).toBe("LOW");
  });
});
