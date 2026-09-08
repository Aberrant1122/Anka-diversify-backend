import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";
import { SelfHealingEngine } from "../repair/SelfHealingEngine";
import {
  BaselineDeltaVerifier,
  createPreTaskSourceGetter,
} from "../../services/baseline-delta.verifier";
import { ValidationRunner } from "../validation/ValidationRunner";
import { FileSystemStateManager } from "../validation/FileSystemStateManager";
import { FileManifest, BaselineDiagnostic, ExecutionContract } from "../../types";
import { AgentFileChange } from "../shared/types";
import * as sharedUtils from "../shared/utils";

describe("Dynamic Revealed-Baseline Scope Expansion for Broad Build Repair (Tests 1-7)", () => {
  let tempDir: string;
  let fsManager: FileSystemStateManager;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "anka-test-revealed-scope-"));
    fsManager = new FileSystemStateManager();
    try {
      execSync("git init", { cwd: tempDir, stdio: "ignore" });
      execSync("git config user.email 'test@example.com'", { cwd: tempDir, stdio: "ignore" });
      execSync("git config user.name 'Test User'", { cwd: tempDir, stdio: "ignore" });
    } catch {}
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
    jest.restoreAllMocks();
  });

  test("Test 1 — Verified Live Scenario: Broad repair dynamically authorizes pre-existing unmanifested file (src/app.ts)", async () => {
    // 1. Create files on disk: components/Calculator.tsx and src/app.ts
    const calcPath = path.join(tempDir, "components", "Calculator.tsx");
    const appPath = path.join(tempDir, "src", "app.ts");
    fs.mkdirSync(path.dirname(calcPath), { recursive: true });
    fs.mkdirSync(path.dirname(appPath), { recursive: true });

    const initialCalcContent = `"use client";
import React from 'react';
export const CalculatorButton = () => <button>Calc</button>;
export default CalculatorButton;
export { CalculatorButton };
`;
    const initialAppContent = `import React from 'react';
export const AppHeader = () => <h1>Header</h1>;
export default AppHeader;
export { AppHeader };
`;

    fs.writeFileSync(calcPath, initialCalcContent, "utf8");
    fs.writeFileSync(appPath, initialAppContent, "utf8");

    // Commit baseline state to Git
    execSync("git add .", { cwd: tempDir, stdio: "ignore" });
    execSync('git commit -m "Initial commit"', { cwd: tempDir, stdio: "ignore" });

    // Snapshot only Calculator.tsx initially
    const initialChanges: AgentFileChange[] = [
      {
        path: "components/Calculator.tsx",
        content: initialCalcContent,
        action: "modify",
        description: "Initial change",
      },
    ];
    await fsManager.snapshot(initialChanges, tempDir);

    const approvedManifest: FileManifest = {
      files: [
        {
          path: "components/Calculator.tsx",
          action: "modify",
          description: "Calculator component",
          dependencies: [],
        },
      ],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    };

    const executionContract: ExecutionContract = {
      goal: "Fix all build errors in this repository until the build passes.",
      taskType: "BUG_FIX",
      risk: "LOW",
      estimatedComplexity: "SMALL",
      pipeline: "REPOSITORY",
      environment: "REACT_TS",
      repositoryRequired: true,
      expectedFiles: ["components/Calculator.tsx"],
      validationType: "TYPESCRIPT_BUILD",
      targetPaths: ["components/Calculator.tsx"],
      allowedActions: ["modify"],
      forbiddenActions: [],
      maxFiles: 10,
      searchScope: ["components/Calculator.tsx"],
      contextScope: ["components/Calculator.tsx"],
      diffCriticEnabled: true,
    };

    const baselineDiagnostics: BaselineDiagnostic[] = [
      {
        errorType: "COMPILE_NEXT",
        filePath: "components/Calculator.tsx",
        errorCode: "CLIENT_DIRECTIVE_REQUIRED",
        message: "Missing use client directive",
        origin: "BASELINE",
        fingerprint: "CLIENT_DIRECTIVE_REQUIRED|components/calculator.tsx",
      },
    ];

    let cycle = 0;
    jest.spyOn(ValidationRunner, "validateWithShell").mockImplementation(async () => {
      cycle++;
      if (cycle === 1) {
        // First build reveals duplicate export in Calculator.tsx AND duplicate export in pre-existing src/app.ts
        return {
          success: false,
          errors: `./components/Calculator.tsx:3:14\nType error: Cannot redeclare exported variable 'CalculatorButton'.\n\n./src/app.ts:2:14\nType error: Cannot redeclare exported variable 'AppHeader'.`,
        };
      }
      // After surgical repairs to both files, build passes cleanly
      return { success: true, errors: "" };
    });

    const result = await SelfHealingEngine.runSelfHealingLoop(
      initialChanges,
      tempDir,
      ["npm run build"],
      "system prompt",
      "Fix all build errors until all the build errors pass.",
      fsManager,
      "test-project-1",
      undefined,
      approvedManifest,
      executionContract,
      baselineDiagnostics,
      baselineDiagnostics
    );

    expect(result.success).toBe(true);
    // Verified that src/app.ts was dynamically added to approvedManifest
    expect(approvedManifest.files.some((f) => f.path === "src/app.ts")).toBe(true);
    // Verified that executionContract targetPaths now includes src/app.ts
    expect(executionContract.targetPaths).toContain("src/app.ts");
  });

  test("Test 2 — Agent-Introduced Error: Regression in FileB caused by agent editing FileA remains NEW_TASK and does NOT expand", () => {
    const fileA = "src/FileA.ts";
    const fileB = "src/FileB.ts";

    const baseDiag: BaselineDiagnostic = {
      errorType: "COMPILE_TS",
      filePath: fileB,
      line: 5,
      errorCode: "TS2305",
      message: "Module './FileA' has no exported member 'OldSymbol'.",
      origin: "CURRENT_TASK",
      fingerprint: "TS2305|src/fileb.ts|5",
      rawTrace: "src/FileB.ts:5:10 - error TS2305: Module './FileA' has no exported member 'OldSymbol'.",
    };

    // Pre-task content of FileB did not have an error, but agent changed FileA, causing FileB to break
    const preContentB = `import { OldSymbol } from './FileA';\nexport const b = OldSymbol();\n`;
    const changeB: AgentFileChange = {
      path: fileB,
      content: `import { OldSymbol } from './FileA';\nexport const b = OldSymbol();\n`,
      action: "modify",
      description: "Modified FileB",
    };

    const changes: AgentFileChange[] = [
      {
        path: fileA,
        content: `// FileA modified by agent (OldSymbol removed)`,
        action: "modify",
        description: "Modified FileA",
      },
      changeB,
    ];

    const causality = BaselineDeltaVerifier.isConstructPreExistingAndUntouched(
      baseDiag,
      preContentB,
      changeB,
      {
        preTaskSourceGetter: (p: string) => (p.includes("FileA") ? `export const OldSymbol = () => 1;` : preContentB),
        changes,
      }
    );

    // Because agent touched FileA which FileB depends on, causality rejects it as pre-existing
    expect(causality.isPreExisting).toBe(false);
    expect(causality.isTouched).toBe(true);
  });

  test("Test 3 — File did not exist at baseline: Fails closed and is NOT classified as revealed baseline", () => {
    const fileC = "src/FileC.ts";
    const baseDiag: BaselineDiagnostic = {
      errorType: "COMPILE_TS",
      filePath: fileC,
      line: 1,
      errorCode: "TS2304",
      message: "Cannot find name 'foo'",
      origin: "CURRENT_TASK",
      fingerprint: "TS2304|src/filec.ts|1",
    };

    // Pre-task content is null (file did not exist at base commit)
    const causality = BaselineDeltaVerifier.isConstructPreExistingAndUntouched(
      baseDiag,
      null,
      undefined
    );

    expect(causality.isPreExisting).toBe(false);
    expect(causality.isTouched).toBe(true);
  });

  test("Test 4 — Narrow bug fix does NOT dynamically expand scope to unrelated pre-existing errors", async () => {
    const calcPath = path.join(tempDir, "components", "Calculator.tsx");
    const appPath = path.join(tempDir, "src", "app.ts");
    fs.mkdirSync(path.dirname(calcPath), { recursive: true });
    fs.mkdirSync(path.dirname(appPath), { recursive: true });

    const initialCalcContent = `"use client";\nexport const Calc = () => <div />;\n`;
    const initialAppContent = `export const x = 1;\n`;
    fs.writeFileSync(calcPath, initialCalcContent, "utf8");
    fs.writeFileSync(appPath, initialAppContent, "utf8");

    execSync("git add .", { cwd: tempDir, stdio: "ignore" });
    execSync('git commit -m "Baseline commit"', { cwd: tempDir, stdio: "ignore" });

    const initialChanges: AgentFileChange[] = [
      {
        path: "components/Calculator.tsx",
        content: initialCalcContent,
        action: "modify",
        description: "Fix calculator only",
      },
    ];
    await fsManager.snapshot(initialChanges, tempDir);

    const approvedManifest: FileManifest = {
      files: [
        {
          path: "components/Calculator.tsx",
          action: "modify",
          description: "Fix calculator only",
          dependencies: [],
        },
      ],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    };

    const executionContract: ExecutionContract = {
      goal: "Fix this use-client error in Calculator.tsx",
      taskType: "BUG_FIX",
      risk: "LOW",
      estimatedComplexity: "SMALL",
      pipeline: "REPOSITORY",
      environment: "REACT_TS",
      repositoryRequired: true,
      expectedFiles: ["components/Calculator.tsx"],
      validationType: "TYPESCRIPT_BUILD",
      targetPaths: ["components/Calculator.tsx"],
      allowedActions: ["modify"],
      forbiddenActions: [],
      maxFiles: 5,
      searchScope: ["components/Calculator.tsx"],
      contextScope: ["components/Calculator.tsx"],
      diffCriticEnabled: true,
    };

    const targetedBaselineDiagnostics: BaselineDiagnostic[] = [
      {
        errorType: "COMPILE_NEXT",
        filePath: "components/Calculator.tsx",
        errorCode: "CLIENT_DIRECTIVE_REQUIRED",
        message: "Missing use client",
        origin: "BASELINE",
        fingerprint: "CLIENT_DIRECTIVE_REQUIRED|components/calculator.tsx",
      },
    ];

    jest.spyOn(ValidationRunner, "validateWithShell").mockResolvedValue({
      success: false,
      // Target is fixed, but unrelated error in src/app.ts remains
      errors: `./src/app.ts:1:14 - error TS2304: Cannot find name 'unrelated'.`,
    });

    const result = await SelfHealingEngine.runSelfHealingLoop(
      initialChanges,
      tempDir,
      ["npm run build"],
      "system prompt",
      "Fix this use-client error in Calculator.tsx",
      fsManager,
      "test-project-2",
      undefined,
      approvedManifest,
      executionContract,
      targetedBaselineDiagnostics,
      targetedBaselineDiagnostics
    );

    // Narrow task succeeds with taskVerified=true while repository is still unhealthy
    expect(result.taskVerified).toBe(true);
    expect(result.repositoryClean).toBe(false);
    // src/app.ts was NOT added to the narrow manifest
    expect(approvedManifest.files.some((f) => f.path === "src/app.ts")).toBe(false);
    expect(executionContract.targetPaths).toEqual(["components/Calculator.tsx"]);
  });

  test("Test 5 — Immutable PreTaskSourceGetter fallback order (FS_MANAGER -> GIT_BASE -> null)", () => {
    const fsSnapshotPath = "src/snapshotted.ts";
    const gitPath = "src/gitOnly.ts";
    const unknownPath = "src/unknown.ts";

    fs.writeFileSync(path.join(tempDir, "package.json"), "{}");

    const mockFsManager = {
      hasOriginalFile: (p: string) => p === fsSnapshotPath,
      getOriginalContent: (p: string) => (p === fsSnapshotPath ? "content from fsManager" : undefined),
    };

    const getter = createPreTaskSourceGetter(tempDir, mockFsManager as any);

    // 1. Snapshot hit
    const snapResult = getter(fsSnapshotPath);
    expect(snapResult).not.toBeNull();
    expect(snapResult?.origin).toBe("FS_MANAGER");
    expect(snapResult?.content).toBe("content from fsManager");

    // 2. Non-git unknown path returns null
    const unknownResult = getter(unknownPath);
    expect(unknownResult).toBeNull();
  });

  test("Test 6 — Normal healthy feature task: No revealed-baseline expansion activated", async () => {
    const featPath = path.join(tempDir, "src", "Feature.tsx");
    fs.mkdirSync(path.dirname(featPath), { recursive: true });
    const content = `export const Feature = () => <div>Feature</div>;\n`;
    fs.writeFileSync(featPath, content, "utf8");

    const changes: AgentFileChange[] = [
      {
        path: "src/Feature.tsx",
        content,
        action: "create",
        description: "New feature",
      },
    ];
    await fsManager.snapshot(changes, tempDir);

    const approvedManifest: FileManifest = {
      files: [{ path: "src/Feature.tsx", action: "create", description: "New feature", dependencies: [] }],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    };

    const executionContract: ExecutionContract = {
      goal: "Add feature component",
      taskType: "NEW_FEATURE",
      risk: "LOW",
      estimatedComplexity: "SMALL",
      pipeline: "REPOSITORY",
      environment: "REACT_TS",
      repositoryRequired: true,
      expectedFiles: ["src/Feature.tsx"],
      validationType: "TYPESCRIPT_BUILD",
      targetPaths: ["src/Feature.tsx"],
      allowedActions: ["create"],
      forbiddenActions: [],
      maxFiles: 5,
      searchScope: ["src/Feature.tsx"],
      contextScope: ["src/Feature.tsx"],
      diffCriticEnabled: true,
    };

    jest.spyOn(ValidationRunner, "validateWithShell").mockResolvedValue({
      success: true,
      errors: "",
    });

    const result = await SelfHealingEngine.runSelfHealingLoop(
      changes,
      tempDir,
      ["npm run build"],
      "system prompt",
      "Add feature component",
      fsManager,
      "test-project-3",
      undefined,
      approvedManifest,
      executionContract
    );

    expect(result.success).toBe(true);
    expect(approvedManifest.files).toHaveLength(1);
    expect(approvedManifest.files[0].path).toBe("src/Feature.tsx");
  });

  test("Test 7 — Scope Security: Unrelated LLM proposed files remain blocked without compiler diagnostic / baseline proof", () => {
    const { validateRepairManifestScope } = require("../repair/RepairProposalResolver");

    const approvedManifest: FileManifest = {
      files: [
        { path: "components/Calculator.tsx", action: "modify", description: "Calculator", dependencies: [] },
      ],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    };

    const invalidProposals = [
      {
        path: "README.md",
        action: "modify" as const,
        description: "Random edit",
        replacementBlocks: [],
      },
      {
        path: "src/random.ts",
        action: "modify" as const,
        description: "Random edit",
        replacementBlocks: [],
      },
    ];

    const validation = validateRepairManifestScope(invalidProposals, approvedManifest);
    expect(validation.valid).toBe(false);
    if (!validation.valid) {
      expect(validation.error.code).toBe("REPAIR_UNDECLARED_FILE");
      expect(validation.error.path).toBe("README.md");
      expect(validation.error.message).toContain('Repair proposal for "README.md" was rejected');
    }
  });

  test("Test 8 — Multi-cycle: Authorized revealed-baseline file retains baseline repair authority after surgical repair modifies content and Next.js reveals Cannot find name error", async () => {
    // This test covers the exact production failure:
    // Cycle 1: src/app.ts is authorized as REVEALED_BASELINE for duplicate export, then SurgicalPatchEngine repairs it
    // Cycle 2: Next.js build reveals pre-existing "Cannot find name 'preExistingSymbol'" in raw Next.js format
    // Expected: src/app.ts must NOT flip to NEW_TASK even if parsed as BUILD_ERR

    const calcPath = path.join(tempDir, "components", "Calculator.tsx");
    const appPath = path.join(tempDir, "src", "app.ts");
    fs.mkdirSync(path.dirname(calcPath), { recursive: true });
    fs.mkdirSync(path.dirname(appPath), { recursive: true });

    const initialCalcContent = `"use client";\nimport React from 'react';\nexport const CalculatorButton = () => <button>Calc</button>;\nexport default CalculatorButton;\nexport { CalculatorButton };\n`;
    // src/app.ts has TWO pre-existing issues: duplicate export AND pre-existing reference to preExistingSymbol
    const initialAppContent = `import React from 'react';\nexport const AppHeader = () => <h1>Header</h1>;\nexport const calc = () => preExistingSymbol + 1;\nexport default AppHeader;\nexport { AppHeader };\n`;

    fs.writeFileSync(calcPath, initialCalcContent, "utf8");
    fs.writeFileSync(appPath, initialAppContent, "utf8");

    execSync("git add .", { cwd: tempDir, stdio: "ignore" });
    execSync('git commit -m "Initial commit"', { cwd: tempDir, stdio: "ignore" });

    const initialChanges: AgentFileChange[] = [
      {
        path: "components/Calculator.tsx",
        content: initialCalcContent,
        action: "modify",
        description: "Initial change",
      },
    ];
    await fsManager.snapshot(initialChanges, tempDir);

    const approvedManifest: FileManifest = {
      files: [
        {
          path: "components/Calculator.tsx",
          action: "modify",
          description: "Calculator component",
          dependencies: [],
        },
      ],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    };

    const executionContract: ExecutionContract = {
      goal: "Fix all build errors in this repository until the build passes.",
      taskType: "BUG_FIX",
      risk: "LOW",
      estimatedComplexity: "SMALL",
      pipeline: "REPOSITORY",
      environment: "REACT_TS",
      repositoryRequired: true,
      expectedFiles: ["components/Calculator.tsx"],
      validationType: "TYPESCRIPT_BUILD",
      targetPaths: ["components/Calculator.tsx"],
      allowedActions: ["modify"],
      forbiddenActions: [],
      maxFiles: 10,
      searchScope: ["components/Calculator.tsx"],
      contextScope: ["components/Calculator.tsx"],
      diffCriticEnabled: true,
    };

    const baselineDiagnostics: BaselineDiagnostic[] = [
      {
        errorType: "COMPILE_NEXT",
        filePath: "components/Calculator.tsx",
        errorCode: "CLIENT_DIRECTIVE_REQUIRED",
        message: "Missing use client directive",
        origin: "BASELINE",
        fingerprint: "CLIENT_DIRECTIVE_REQUIRED|components/calculator.tsx",
      },
    ];

    let cycle = 0;
    jest.spyOn(ValidationRunner, "validateWithShell").mockImplementation(async () => {
      cycle++;
      if (cycle === 1) {
        // Cycle 1: Calculator.tsx fixed, but src/app.ts has duplicate export error
        return {
          success: false,
          errors: `./components/Calculator.tsx:3:14\nType error: Cannot redeclare exported variable 'CalculatorButton'.\n\n./src/app.ts:2:14\nType error: Cannot redeclare exported variable 'AppHeader'.`,
        };
      }
      if (cycle === 2) {
        // Cycle 2: SurgicalPatchEngine removed the redundant export from src/app.ts
        // Next.js now reveals the raw Type error: Cannot find name 'preExistingSymbol'.
        return {
          success: false,
          errors: `./src/app.ts:3:27\nType error: Cannot find name 'preExistingSymbol'.`,
        };
      }
      // Cycle 3: build passes
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
                        path: "src/app.ts",
                        action: "modify",
                        description: "Define preExistingSymbol",
                        edits: [
                          {
                            oldText: "export const calc = () => preExistingSymbol + 1;",
                            newText: "const preExistingSymbol = 10;\nexport const calc = () => preExistingSymbol + 1;",
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

    const result = await SelfHealingEngine.runSelfHealingLoop(
      initialChanges,
      tempDir,
      ["npm run build"],
      "system prompt",
      "Fix all build errors until all the build errors pass.",
      fsManager,
      "test-project-8",
      undefined,
      approvedManifest,
      executionContract,
      baselineDiagnostics,
      baselineDiagnostics
    );

    expect(result.success).toBe(true);
    // src/app.ts was dynamically authorized and STAYED authorized across cycles
    expect(approvedManifest.files.some((f) => f.path === "src/app.ts")).toBe(true);
    expect(executionContract.targetPaths).toContain("src/app.ts");
  });

  test("Test 9 — Second pre-existing error: Bug B revealed after Bug A is fixed in same authorized file", () => {
    // src/app.ts has two pre-existing bugs:
    //   Bug A: duplicate export of AppHeader (export const + export { AppHeader })
    //   Bug B: duplicate export of AppFooter (export const + export { AppFooter })
    // Bug A is fixed (redundant export removed), Bug B then surfaces.
    // File content now differs from baseline. Bug B must remain REVEALED_BASELINE.

    const preTaskContent = `import React from 'react';
export const AppHeader = () => <h1>Header</h1>;
export const AppFooter = () => <footer>Footer</footer>;
export default AppHeader;
export { AppHeader };
export { AppFooter };
`;

    // After Bug A fix: the export { AppHeader } line was removed
    const repairedContent = `import React from 'react';
export const AppHeader = () => <h1>Header</h1>;
export const AppFooter = () => <footer>Footer</footer>;
export default AppHeader;
export { AppFooter };
`;

    const bugBDiag: BaselineDiagnostic = {
      errorType: "COMPILE_TS",
      filePath: "src/app.ts",
      line: 5,
      errorCode: "TS2440",
      message: "Cannot redeclare exported variable 'AppFooter'.",
      symbolName: "AppFooter",
      origin: "CURRENT_TASK",
      fingerprint: "TS2440|src/app.ts|5",
    };

    const change: AgentFileChange = {
      path: "src/app.ts",
      content: repairedContent,
      action: "modify",
      description: "Repaired Bug A",
    };

    const authorizedPaths = new Set<string>();
    authorizedPaths.add("src/app.ts");

    const causality = BaselineDeltaVerifier.isConstructPreExistingAndUntouched(
      bugBDiag,
      preTaskContent,
      change,
      {
        preTaskSourceGetter: () => preTaskContent,
        changes: [change],
        isBroadRepairTask: true,
        authorizedRevealedBaselinePaths: authorizedPaths,
      }
    );

    // Bug B construct (AppFooter duplicate export) existed in pre-task source
    expect(causality.isPreExisting).toBe(true);
    expect(causality.isTouched).toBe(false);
  });

  test("Test 10 — Genuine regression in authorized file: New error NOT in baseline remains NEW_TASK", () => {
    // src/app.ts was authorized for pre-existing Bug A.
    // ANKA repair accidentally introduces a reference to newAgentIntroducedSymbol that did NOT exist at baseline.
    // Authorization must NOT hide the regression.

    const preTaskContent = `import React from 'react';
export const AppHeader = () => <h1>Header</h1>;
export default AppHeader;
export { AppHeader };
`;

    // After repair: Bug A fixed but a NEW missing symbol error introduced
    const repairedContent = `import React from 'react';
export const AppHeader = () => <h1>Header</h1>;
export default AppHeader;
export const calc = () => newAgentIntroducedSymbol + 1;
`;

    const regressionDiag: BaselineDiagnostic = {
      errorType: "COMPILE_NEXT",
      filePath: "src/app.ts",
      line: 4,
      errorCode: "BUILD_ERR",
      message: "Cannot find name 'newAgentIntroducedSymbol'.",
      symbolName: "newAgentIntroducedSymbol",
      origin: "CURRENT_TASK",
      fingerprint: "BUILD_ERR|src/app.ts|4",
    };

    const change: AgentFileChange = {
      path: "src/app.ts",
      content: repairedContent,
      action: "modify",
      description: "Repaired file with regression",
    };

    const authorizedPaths = new Set<string>();
    authorizedPaths.add("src/app.ts");

    const causality = BaselineDeltaVerifier.isConstructPreExistingAndUntouched(
      regressionDiag,
      preTaskContent,
      change,
      {
        preTaskSourceGetter: () => preTaskContent,
        changes: [change],
        isBroadRepairTask: true,
        authorizedRevealedBaselinePaths: authorizedPaths,
      }
    );

    // The newAgentIntroducedSymbol construct did NOT exist in pre-task source → genuine regression
    expect(causality.isPreExisting).toBe(false);
    expect(causality.isTouched).toBe(true);
  });

  test("Test 11 — Unknown BUILD_ERR fails closed to NEW_TASK: No blanket baseline permission for generic errors", () => {
    const preTaskContent = `export const x = 1;\n`;
    const repairedContent = `export const x = 2;\n`;

    const unknownDiag: BaselineDiagnostic = {
      errorType: "COMPILE_NEXT",
      filePath: "src/app.ts",
      errorCode: "BUILD_ERR",
      message: "Unexpected compiler failure",
      origin: "CURRENT_TASK",
      fingerprint: "BUILD_ERR|src/app.ts|0",
    };

    const change: AgentFileChange = {
      path: "src/app.ts",
      content: repairedContent,
      action: "modify",
      description: "Modified file",
    };

    const authorizedPaths = new Set<string>();
    authorizedPaths.add("src/app.ts");

    const causality = BaselineDeltaVerifier.isConstructPreExistingAndUntouched(
      unknownDiag,
      preTaskContent,
      change,
      {
        preTaskSourceGetter: () => preTaskContent,
        changes: [change],
        isBroadRepairTask: true,
        authorizedRevealedBaselinePaths: authorizedPaths,
      }
    );

    // Unknown BUILD_ERR with no baseline evidence fails closed to NEW_TASK
    expect(causality.isPreExisting).toBe(false);
    expect(causality.isTouched).toBe(true);
  });
});
