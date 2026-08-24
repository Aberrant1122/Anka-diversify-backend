import fs from "fs";
import path from "path";
import os from "os";
import { FileManifest, ExecutionContract } from "../../types";
import {
  RepairChangeProposal,
  validateRepairManifestScope,
  resolveRepairProposals,
} from "../repair/RepairProposalResolver";
import { SelfHealingEngine } from "../repair/SelfHealingEngine";
import { BuildErrorRepair } from "../repair/BuildErrorRepair";
import { FileSystemStateManager } from "../validation/FileSystemStateManager";
import { ValidationRunner } from "../validation/ValidationRunner";
import * as utils from "../shared/utils";

describe("AI Step 9A — Repair Safety Gates & Structured Self-Healing Tests", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "repair-safety-test-"));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ── TEST A: Approved structured MODIFY repair succeeds ────────────────────
  test("TEST A: Approved structured MODIFY repair succeeds", () => {
    const manifest: FileManifest = {
      files: [{ path: "src/auth.ts", action: "modify", dependencies: [], description: "Auth fix" }],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    };

    const currentFiles = {
      "src/auth.ts": "export const value = 1;\nexport const timeout = 5000;\n",
    };

    const proposals: RepairChangeProposal[] = [
      {
        path: "src/auth.ts",
        action: "modify",
        description: "Fix value",
        edits: [
          {
            oldText: "export const value = 1;",
            newText: "export const value = 2;",
          },
        ],
      },
    ];

    const scopeCheck = validateRepairManifestScope(proposals, manifest);
    expect(scopeCheck.valid).toBe(true);

    const resolution = resolveRepairProposals(proposals, currentFiles);
    expect(resolution.success).toBe(true);
    if (resolution.success) {
      expect(resolution.changes).toHaveLength(1);
      expect(resolution.changes[0].content).toBe("export const value = 2;\nexport const timeout = 5000;\n");
      expect(resolution.expectedSourceHashes["src/auth.ts"]).toBeDefined();
    }
  });

  // ── TEST B: Undeclared repair file rejected ────────────────────────────────
  test("TEST B: Undeclared repair file rejected with REPAIR_UNDECLARED_FILE", () => {
    const manifest: FileManifest = {
      files: [{ path: "src/auth.ts", action: "modify", dependencies: [], description: "Auth fix" }],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    };

    const proposals: RepairChangeProposal[] = [
      {
        path: "src/auth.ts",
        action: "modify",
        description: "Fix auth",
        edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }],
      },
      {
        path: "package.json",
        action: "modify",
        description: "Add dependency",
        edits: [{ oldText: `"version": "1.0.0"`, newText: `"version": "1.0.1"` }],
      },
    ];

    const check = validateRepairManifestScope(proposals, manifest);
    expect(check.valid).toBe(false);
    if (!check.valid) {
      expect(check.error.code).toBe("REPAIR_UNDECLARED_FILE");
      expect(check.error.path).toBe("package.json");
    }
  });

  // ── TEST C: Repair action mismatch rejected ────────────────────────────────
  test("TEST C: Repair action mismatch rejected with REPAIR_ACTION_MISMATCH", () => {
    const manifest: FileManifest = {
      files: [{ path: "src/auth.ts", action: "modify", dependencies: [], description: "Auth fix" }],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    };

    const proposals: RepairChangeProposal[] = [
      {
        path: "src/auth.ts",
        action: "delete",
        description: "Delete auth file",
      },
    ];

    const check = validateRepairManifestScope(proposals, manifest);
    expect(check.valid).toBe(false);
    if (!check.valid) {
      expect(check.error.code).toBe("REPAIR_ACTION_MISMATCH");
      expect(check.error.path).toBe("src/auth.ts");
    }
  });

  // ── TEST D: Full-file MODIFY repair rejected ──────────────────────────────
  test("TEST D: Full-file MODIFY repair rejected with MODIFY_PATCH_REQUIRED", () => {
    const currentFiles = {
      "src/auth.ts": "const x = 1;",
    };

    const proposals: RepairChangeProposal[] = [
      {
        path: "src/auth.ts",
        action: "modify",
        description: "Rewrite file",
        edits: [], // Empty edits array
      },
    ];

    const resolution = resolveRepairProposals(proposals, currentFiles);
    expect(resolution.success).toBe(false);
    if (!resolution.success) {
      expect(resolution.error.code).toBe("MODIFY_PATCH_REQUIRED");
    }
  });

  // ── TEST E: Ambiguous repair patch rejected ────────────────────────────────
  test("TEST E: Ambiguous repair patch rejected with AMBIGUOUS_PATCH_TARGET", () => {
    const currentFiles = {
      "src/auth.ts": "const x = 1;\nconst x = 1;\n",
    };

    const proposals: RepairChangeProposal[] = [
      {
        path: "src/auth.ts",
        action: "modify",
        description: "Fix x",
        edits: [{ oldText: "const x = 1;", newText: "const x = 2;" }],
      },
    ];

    const resolution = resolveRepairProposals(proposals, currentFiles);
    expect(resolution.success).toBe(false);
    if (!resolution.success) {
      expect(resolution.error.code).toBe("AMBIGUOUS_PATCH_TARGET");
    }
  });

  // ── TEST F: Missing repair target rejected ─────────────────────────────────
  test("TEST F: Missing repair target rejected with PATCH_TARGET_NOT_FOUND", () => {
    const currentFiles = {
      "src/auth.ts": "const x = 1;\n",
    };

    const proposals: RepairChangeProposal[] = [
      {
        path: "src/auth.ts",
        action: "modify",
        description: "Fix missing",
        edits: [{ oldText: "nonExistentFunction()", newText: "newFunction()" }],
      },
    ];

    const resolution = resolveRepairProposals(proposals, currentFiles);
    expect(resolution.success).toBe(false);
    if (!resolution.success) {
      expect(resolution.error.code).toBe("PATCH_TARGET_NOT_FOUND");
    }
  });

  // ── TEST G: SelfHealingEngine integration - STALE_REPAIR_SOURCE prevents apply
  test("TEST G: Stale current-state file before repair apply halts repair and prevents mutation", async () => {
    const filePath = path.join(tempDir, "src", "auth.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "const state = 'initial';\n", "utf8");

    const manifest: FileManifest = {
      files: [{ path: "src/auth.ts", action: "modify", dependencies: [], description: "Auth" }],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    };

    const contract: ExecutionContract = {
      goal: "fix auth",
      taskType: "BUG_FIX",
      risk: "LOW",
      estimatedComplexity: "SMALL",
      pipeline: "REPOSITORY",
      environment: "NODE_JS",
      repositoryRequired: true,
      expectedFiles: ["src/auth.ts"],
      validationType: "TYPESCRIPT_BUILD",
      targetPaths: ["src"],
      allowedActions: ["modify"],
      forbiddenActions: [],
      maxFiles: 5,
      searchScope: ["src"],
      contextScope: ["src"],
      diffCriticEnabled: false,
    };

    const fsManager = new FileSystemStateManager();
    await fsManager.snapshot([{ path: "src/auth.ts", content: "const state = 'initial';\n", description: "init", action: "modify" }], tempDir);

    // Initial validation fails
    jest.spyOn(ValidationRunner, "validateWithShell").mockResolvedValue({
      success: false,
      errors: "src/auth.ts:1:1 error TS2304: Cannot find name 'state'",
    });

    // Mock OpenAI repair response reasoning over State B ("const state = 'initial';\n")
    const mockOpenAI = {
      chat: {
        completions: {
          create: jest.fn().mockImplementation(async () => {
            // Concurrent disk modification occurs right before repair resolves/applies:
            fs.writeFileSync(filePath, "const state = 'concurrent_modification';\n", "utf8");

            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      repaired: true,
                      changes: [
                        {
                          path: "src/auth.ts",
                          action: "modify",
                          description: "Update state",
                          edits: [
                            {
                              oldText: "const state = 'initial';",
                              newText: "const state = 'repaired';",
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
    jest.spyOn(utils, "getOpenAI").mockReturnValue(mockOpenAI as any);

    const applySpy = jest.spyOn(fsManager, "apply");

    const result = await SelfHealingEngine.runSelfHealingLoop(
      [{ path: "src/auth.ts", content: "const state = 'initial';\n", description: "init", action: "modify" }],
      tempDir,
      ["npm run build"],
      "system prompt",
      "fix error",
      fsManager,
      "proj-1",
      undefined,
      manifest,
      contract,
    );

    // Stale repair source prevents application of repair
    expect(result.success).toBe(false);
    expect(result.errorType).toBe("STALE_REPAIR_SOURCE");
    // Verify file on disk was NOT mutated with the repaired content
    expect(fs.readFileSync(filePath, "utf8")).toBe("const state = 'concurrent_modification';\n");
  });

  // ── TEST H: Subsequent repair uses latest state ────────────────────────────
  test("TEST H: Subsequent repair uses latest disk state from attempt N-1", async () => {
    const filePath = path.join(tempDir, "src", "auth.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "const step = 1;\n", "utf8");

    const manifest: FileManifest = {
      files: [{ path: "src/auth.ts", action: "modify", dependencies: [], description: "Auth" }],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    };

    const contract: ExecutionContract = {
      goal: "fix auth",
      taskType: "BUG_FIX",
      risk: "LOW",
      estimatedComplexity: "SMALL",
      pipeline: "REPOSITORY",
      environment: "NODE_JS",
      repositoryRequired: true,
      expectedFiles: ["src/auth.ts"],
      validationType: "TYPESCRIPT_BUILD",
      targetPaths: ["src"],
      allowedActions: ["modify"],
      forbiddenActions: [],
      maxFiles: 5,
      searchScope: ["src"],
      contextScope: ["src"],
      diffCriticEnabled: false,
    };

    const fsManager = new FileSystemStateManager();
    await fsManager.snapshot([{ path: "src/auth.ts", content: "const step = 1;\n", description: "init", action: "modify" }], tempDir);

    let valAttempts = 0;
    jest.spyOn(ValidationRunner, "validateWithShell").mockImplementation(async () => {
      valAttempts++;
      if (valAttempts === 1) return { success: false, errors: "error 1" };
      if (valAttempts === 2) return { success: false, errors: "error 2" };
      return { success: true, errors: "" };
    });

    let repairCalls = 0;
    let attempt2PromptContent = "";

    const mockOpenAI = {
      chat: {
        completions: {
          create: jest.fn().mockImplementation(async (args: any) => {
            repairCalls++;
            const userPrompt = args.messages.find((m: any) => m.role === "user")?.content || "";

            if (repairCalls === 1) {
              return {
                choices: [
                  {
                    message: {
                      content: JSON.stringify({
                        repaired: true,
                        changes: [
                          {
                            path: "src/auth.ts",
                            action: "modify",
                            description: "Go to step 2",
                            edits: [{ oldText: "const step = 1;", newText: "const step = 2;" }],
                          },
                        ],
                      }),
                    },
                  },
                ],
              };
            }

            if (repairCalls === 2) {
              attempt2PromptContent = userPrompt;
              return {
                choices: [
                  {
                    message: {
                      content: JSON.stringify({
                        repaired: true,
                        changes: [
                          {
                            path: "src/auth.ts",
                            action: "modify",
                            description: "Go to step 3",
                            edits: [{ oldText: "const step = 2;", newText: "const step = 3;" }],
                          },
                        ],
                      }),
                    },
                  },
                ],
              };
            }

            return { choices: [{ message: { content: "{}" } }] };
          }),
        },
      },
    };
    jest.spyOn(utils, "getOpenAI").mockReturnValue(mockOpenAI as any);

    const result = await SelfHealingEngine.runSelfHealingLoop(
      [{ path: "src/auth.ts", content: "const step = 1;\n", description: "init", action: "modify" }],
      tempDir,
      ["npm run build"],
      "system prompt",
      "fix error",
      fsManager,
      "proj-1",
      undefined,
      manifest,
      contract,
    );

    expect(result.success).toBe(true);
    // Verify attempt 2 user prompt contained "const step = 2;" (the state produced in attempt 1)
    expect(attempt2PromptContent).toContain("const step = 2;");
    // Verify final disk content is step 3
    expect(fs.readFileSync(filePath, "utf8")).toBe("const step = 3;\n");
  });

  // ── TEST I: Scope rechecked every attempt ──────────────────────────────────
  test("TEST I: Scope rechecked on every repair attempt (Attempt 2 undeclared file rejected)", async () => {
    const filePath = path.join(tempDir, "src", "auth.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "const step = 1;\n", "utf8");

    const manifest: FileManifest = {
      files: [{ path: "src/auth.ts", action: "modify", dependencies: [], description: "Auth" }],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    };

    const contract: ExecutionContract = {
      goal: "fix auth",
      taskType: "BUG_FIX",
      risk: "LOW",
      estimatedComplexity: "SMALL",
      pipeline: "REPOSITORY",
      environment: "NODE_JS",
      repositoryRequired: true,
      expectedFiles: ["src/auth.ts"],
      validationType: "TYPESCRIPT_BUILD",
      targetPaths: ["src"],
      allowedActions: ["modify"],
      forbiddenActions: [],
      maxFiles: 5,
      searchScope: ["src"],
      contextScope: ["src"],
      diffCriticEnabled: false,
    };

    const fsManager = new FileSystemStateManager();
    await fsManager.snapshot([{ path: "src/auth.ts", content: "const step = 1;\n", description: "init", action: "modify" }], tempDir);

    jest.spyOn(ValidationRunner, "validateWithShell").mockResolvedValue({
      success: false,
      errors: "error TS2304",
    });

    let repairCalls = 0;
    const mockOpenAI = {
      chat: {
        completions: {
          create: jest.fn().mockImplementation(async () => {
            repairCalls++;
            if (repairCalls === 1) {
              // Attempt 1: valid patch on src/auth.ts
              return {
                choices: [
                  {
                    message: {
                      content: JSON.stringify({
                        repaired: true,
                        changes: [
                          {
                            path: "src/auth.ts",
                            action: "modify",
                            description: "Fix step",
                            edits: [{ oldText: "const step = 1;", newText: "const step = 2;" }],
                          },
                        ],
                      }),
                    },
                  },
                ],
              };
            }
            // Attempt 2: introduces undeclared package.json
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      repaired: true,
                      changes: [
                        {
                          path: "package.json",
                          action: "modify",
                          description: "Illegal file",
                          edits: [{ oldText: "{}", newText: "{\"foo\": 1}" }],
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
    jest.spyOn(utils, "getOpenAI").mockReturnValue(mockOpenAI as any);

    const result = await SelfHealingEngine.runSelfHealingLoop(
      [{ path: "src/auth.ts", content: "const step = 1;\n", description: "init", action: "modify" }],
      tempDir,
      ["npm run build"],
      "system prompt",
      "fix error",
      fsManager,
      "proj-1",
      undefined,
      manifest,
      contract,
    );

    expect(result.success).toBe(false);
    expect(result.errorType).toBe("REPAIR_UNDECLARED_FILE");
    // package.json was never created or written to disk
    expect(fs.existsSync(path.join(tempDir, "package.json"))).toBe(false);
  });

  // ── TEST J: All-or-nothing multi-file repair ───────────────────────────────
  test("TEST J: All-or-nothing multi-file repair (one invalid patch rejects entire batch)", () => {
    const currentFiles = {
      "src/auth.ts": "export const auth = true;\n",
      "src/utils.ts": "export const util = 1;\n",
    };

    const proposals: RepairChangeProposal[] = [
      {
        path: "src/auth.ts",
        action: "modify",
        description: "Valid patch",
        edits: [{ oldText: "export const auth = true;", newText: "export const auth = false;" }],
      },
      {
        path: "src/utils.ts",
        action: "modify",
        description: "Invalid patch (target not found)",
        edits: [{ oldText: "nonExistentString()", newText: "replacement()" }],
      },
    ];

    const resolution = resolveRepairProposals(proposals, currentFiles);
    expect(resolution.success).toBe(false);
    if (!resolution.success) {
      expect(resolution.error.code).toBe("PATCH_TARGET_NOT_FOUND");
    }
  });

  // ── TEST K: Rollback restores original pre-run content after repair failure
  test("TEST K: Rollback restores original pre-run content after repair failure", async () => {
    const filePath = path.join(tempDir, "src", "config.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const ORIGINAL_CONTENT = "export const timeout = 1000;\n";
    fs.writeFileSync(filePath, ORIGINAL_CONTENT, "utf8");

    const fsManager = new FileSystemStateManager();
    // Snapshot initial pre-run state
    await fsManager.snapshot([{ path: "src/config.ts", content: ORIGINAL_CONTENT, description: "orig", action: "modify" }], tempDir);

    // Apply attempt 1 modification
    await fsManager.apply([{ path: "src/config.ts", content: "export const timeout = 2000;\n", description: "mod1", action: "modify" }], tempDir);
    expect(fs.readFileSync(filePath, "utf8")).toBe("export const timeout = 2000;\n");

    // Apply attempt 2 modification
    await fsManager.apply([{ path: "src/config.ts", content: "export const timeout = 3000;\n", description: "mod2", action: "modify" }], tempDir);
    expect(fs.readFileSync(filePath, "utf8")).toBe("export const timeout = 3000;\n");

    // Pipeline fails -> trigger rollback
    await fsManager.rollback(tempDir);

    // Rollback restores original pre-run content byte-for-byte
    expect(fs.readFileSync(filePath, "utf8")).toBe(ORIGINAL_CONTENT);
  });

  // ── TEST L: BuildErrorRepair cannot bypass patch/scope safety ─────────────
  test("TEST L: BuildErrorRepair in REPOSITORY mode returns failure without LLM invocation or disk mutation", async () => {
    const filePath = path.join(tempDir, "src", "auth.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "export const auth = 1;\n", "utf8");

    const contract: ExecutionContract = {
      goal: "fix auth",
      taskType: "BUG_FIX",
      risk: "LOW",
      estimatedComplexity: "SMALL",
      pipeline: "REPOSITORY",
      environment: "NODE_JS",
      repositoryRequired: true,
      expectedFiles: ["src/auth.ts"],
      validationType: "TYPESCRIPT_BUILD",
      targetPaths: ["src"],
      allowedActions: ["modify"],
      forbiddenActions: [],
      maxFiles: 5,
      searchScope: ["src"],
      contextScope: ["src"],
      diffCriticEnabled: false,
    };

    const fsManager = new FileSystemStateManager();
    const openAISpy = jest.spyOn(utils, "getOpenAI");

    const result = await BuildErrorRepair.runBuildErrorRepairPass(
      [{ path: "src/auth.ts", content: "export const auth = 1;\n", description: "test", action: "modify" }],
      tempDir,
      ["npm run build"],
      "fix error",
      "TS error log",
      fsManager,
      contract,
    );

    expect(result.success).toBe(false);
    expect(openAISpy).not.toHaveBeenCalled();
    expect(fs.readFileSync(filePath, "utf8")).toBe("export const auth = 1;\n");
  });
});
