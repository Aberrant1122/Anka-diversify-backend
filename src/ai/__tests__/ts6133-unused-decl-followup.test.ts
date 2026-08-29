import { ErrorDiagnosticsParser } from "../../services/surgical-repair.engine";
import { BaselineDeltaVerifier } from "../../services/baseline-delta.verifier";
import { SelfHealingEngine } from "../repair/SelfHealingEngine";
import { FileSystemStateManager } from "../validation/FileSystemStateManager";
import { ValidationRunner } from "../validation/ValidationRunner";
import { getOpenAI } from "../shared/utils";
import { FileManifest } from "../../types";
import { ExecutionContract, AgentFileChange } from "../shared/types";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

jest.mock("../shared/utils", () => ({
  getOpenAI: jest.fn(),
}));

describe("TS6133 Diagnostic Fidelity & Authorized Repair Follow-Up Causality", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  // =========================================================================
  // Section 1: ErrorDiagnosticsParser TS6133 Tests
  // =========================================================================

  describe("Section 1: ErrorDiagnosticsParser TS6133 Tests", () => {
    test("1. 'port' is declared but its value is never read -> TS6133 + symbolName port", () => {
      const rawLog = `./src/index.ts:3:7\nType error: 'port' is declared but its value is never read.`;
      const diags = ErrorDiagnosticsParser.parse(rawLog);

      expect(diags.length).toBe(1);
      expect(diags[0].file).toBe("src/index.ts");
      expect(diags[0].line).toBe(3);
      expect(diags[0].column).toBe(7);
      expect(diags[0].code).toBe("TS6133");
      expect(diags[0].symbolName).toBe("port");
    });

    test("2. 'foo' is declared but never used -> TS6133 + symbolName foo", () => {
      const rawLog = `./src/utils.ts:10:5\nType error: 'foo' is declared but never used.`;
      const diags = ErrorDiagnosticsParser.parse(rawLog);

      expect(diags.length).toBe(1);
      expect(diags[0].file).toBe("src/utils.ts");
      expect(diags[0].line).toBe(10);
      expect(diags[0].column).toBe(5);
      expect(diags[0].code).toBe("TS6133");
      expect(diags[0].symbolName).toBe("foo");
    });

    test("3. Unknown compiler messages remain BUILD_ERR", () => {
      const rawLog = `./src/index.ts:5:1\nType error: An export assignment cannot have modifiers.`;
      const diags = ErrorDiagnosticsParser.parse(rawLog);

      expect(diags.length).toBe(1);
      expect(diags[0].code).toBe("BUILD_ERR");
    });

    test("4. Existing TS codes remain preserved (TS2440, TS2304, TS2307, TS2614)", () => {
      const logs = [
        `./components/Calculator.tsx:7:14\nType error: Cannot redeclare exported variable 'CalculatorButton'.`,
        `./src/app.ts:6:6\nType error: Cannot find name 'div'.`,
        `./src/index.ts:1:21\nType error: Cannot find module 'express' or its corresponding type declarations.`,
        `./src/index.ts:2:10\nType error: Module '"./app"' has no exported member 'App'. Did you mean to use 'import App from "./app"' instead?`,
      ];

      const parsed = logs.map((l) => ErrorDiagnosticsParser.parse(l)[0]);
      expect(parsed[0].code).toBe("TS2440");
      expect(parsed[1].code).toBe("TS2304");
      expect(parsed[2].code).toBe("TS2307");
      expect(parsed[3].code).toBe("TS2614");
    });
  });

  // =========================================================================
  // Section 2: Authorized Repair Follow-Up Causality Tests
  // =========================================================================

  describe("Section 2: Authorized Repair Follow-Up Causality Tests", () => {
    const baselineIndexTs = `import express from 'express';\nimport { App } from './app';\n\nconst app = express();\nconst port = process.env.PORT || 3000;\n\napp.use('/', App);\n\napp.listen(port, () => {\n  console.log(\`Server is running on port \${port}\`);\n});\n\nexport { app, port };\n`;

    test("A. Baseline used port + authorized patch removed usage -> TS6133 authorized followup", () => {
      const currentContent = `import App from './app';\n\nconst port = process.env.PORT || 3000;\n\nexport default App;\n`;

      const modifiedIndexChange: AgentFileChange = {
        path: "src/index.ts",
        content: currentContent,
        action: "modify",
        description: "Removed express and fixed import",
      };

      const diag = {
        filePath: "src/index.ts",
        line: 3,
        column: 7,
        errorCode: "TS6133",
        message: `'port' is declared but its value is never read.`,
        symbolName: "port",
        errorType: "COMPILE_TS" as const,
        origin: "CURRENT_TASK" as const,
        fingerprint: "TS6133|src/index.ts|3",
      };

      const causality = BaselineDeltaVerifier.isConstructPreExistingAndUntouched(
        diag,
        baselineIndexTs,
        modifiedIndexChange,
        {
          preTaskSourceGetter: (p: string) => (p.includes("index.ts") ? baselineIndexTs : null),
          changes: [modifiedIndexChange],
          authorizedRevealedBaselinePaths: new Set(["src/index.ts"]),
        },
      );

      expect(causality.isAuthorizedRepairFollowup).toBe(true);
      expect(causality.isPreExisting).toBe(false);
      expect(causality.isTouched).toBe(true);
    });

    test("B. Negative: Agent introduced unused temp -> fail closed (not authorized followup)", () => {
      const currentContentWithTemp = `import App from './app';\n\nconst temp = 123;\n\nexport default App;\n`;

      const modifiedIndexChange: AgentFileChange = {
        path: "src/index.ts",
        content: currentContentWithTemp,
        action: "modify",
        description: "Added temp variable",
      };

      const diag = {
        filePath: "src/index.ts",
        line: 3,
        column: 7,
        errorCode: "TS6133",
        message: `'temp' is declared but its value is never read.`,
        symbolName: "temp",
        errorType: "COMPILE_TS" as const,
        origin: "CURRENT_TASK" as const,
        fingerprint: "TS6133|src/index.ts|3",
      };

      const causality = BaselineDeltaVerifier.isConstructPreExistingAndUntouched(
        diag,
        baselineIndexTs,
        modifiedIndexChange,
        {
          preTaskSourceGetter: (p: string) => (p.includes("index.ts") ? baselineIndexTs : null),
          changes: [modifiedIndexChange],
          authorizedRevealedBaselinePaths: new Set(["src/index.ts"]),
        },
      );

      expect(causality.isAuthorizedRepairFollowup).toBeUndefined();
      expect(causality.isPreExisting).toBe(false);
      expect(causality.isTouched).toBe(true);
    });

    test("C. Negative: Unrelated file (not in authorized paths) -> fail closed", () => {
      const unrelatedBaseline = `const port = 3000;\nconsole.log(port);\n`;
      const unrelatedCurrent = `const port = 3000;\n`;

      const modifiedChange: AgentFileChange = {
        path: "src/unrelated.ts",
        content: unrelatedCurrent,
        action: "modify",
        description: "Modified unrelated",
      };

      const diag = {
        filePath: "src/unrelated.ts",
        line: 1,
        column: 7,
        errorCode: "TS6133",
        message: `'port' is declared but its value is never read.`,
        symbolName: "port",
        errorType: "COMPILE_TS" as const,
        origin: "CURRENT_TASK" as const,
        fingerprint: "TS6133|src/unrelated.ts|1",
      };

      const causality = BaselineDeltaVerifier.isConstructPreExistingAndUntouched(
        diag,
        unrelatedBaseline,
        modifiedChange,
        {
          preTaskSourceGetter: (p: string) => (p.includes("unrelated.ts") ? unrelatedBaseline : null),
          changes: [modifiedChange],
          authorizedRevealedBaselinePaths: new Set(["src/index.ts"]), // does NOT contain unrelated.ts
        },
      );

      expect(causality.isAuthorizedRepairFollowup).toBeUndefined();
      expect(causality.isPreExisting).toBe(false);
      expect(causality.isTouched).toBe(true);
    });

    test("D. Negative: Symbol does not match -> fail closed", () => {
      const currentContent = `import App from './app';\n\nconst port = process.env.PORT || 3000;\n\nexport default App;\n`;

      const modifiedIndexChange: AgentFileChange = {
        path: "src/index.ts",
        content: currentContent,
        action: "modify",
        description: "Removed express",
      };

      const diag = {
        filePath: "src/index.ts",
        line: 3,
        column: 7,
        errorCode: "TS6133",
        message: `'host' is declared but its value is never read.`,
        symbolName: "host",
        errorType: "COMPILE_TS" as const,
        origin: "CURRENT_TASK" as const,
        fingerprint: "TS6133|src/index.ts|3",
      };

      const causality = BaselineDeltaVerifier.isConstructPreExistingAndUntouched(
        diag,
        baselineIndexTs,
        modifiedIndexChange,
        {
          preTaskSourceGetter: (p: string) => (p.includes("index.ts") ? baselineIndexTs : null),
          changes: [modifiedIndexChange],
          authorizedRevealedBaselinePaths: new Set(["src/index.ts"]),
        },
      );

      expect(causality.isAuthorizedRepairFollowup).toBeUndefined();
      expect(causality.isPreExisting).toBe(false);
      expect(causality.isTouched).toBe(true);
    });

    test("E. Negative: Baseline was already unused -> fail closed", () => {
      const baselineWithUnused = `const port = 3000;\nexport default null;\n`;
      const currentContent = `const port = 3000;\nexport default null;\n`;

      const modifiedIndexChange: AgentFileChange = {
        path: "src/index.ts",
        content: currentContent,
        action: "modify",
        description: "Touched file",
      };

      const diag = {
        filePath: "src/index.ts",
        line: 1,
        column: 7,
        errorCode: "TS6133",
        message: `'port' is declared but its value is never read.`,
        symbolName: "port",
        errorType: "COMPILE_TS" as const,
        origin: "CURRENT_TASK" as const,
        fingerprint: "TS6133|src/index.ts|1",
      };

      const causality = BaselineDeltaVerifier.isConstructPreExistingAndUntouched(
        diag,
        baselineWithUnused,
        modifiedIndexChange,
        {
          preTaskSourceGetter: (p: string) => (p.includes("index.ts") ? baselineWithUnused : null),
          changes: [modifiedIndexChange],
          authorizedRevealedBaselinePaths: new Set(["src/index.ts"]),
        },
      );

      expect(causality.isAuthorizedRepairFollowup).toBeUndefined();
      expect(causality.isPreExisting).toBe(false);
      expect(causality.isTouched).toBe(true);
    });
  });

  // =========================================================================
  // Section 3: Exact Full Live Self-Healing Regression Test
  // =========================================================================

  describe("Section 3: Exact Full Live Self-Healing Regression Test", () => {
    test("Live Multi-Cycle Flow: Express removed -> TS2614 fixed -> TS6133 port cleaned up -> clean build", async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "anka-test-ts6133-"));
      const srcDir = path.join(tempDir, "src");
      fs.mkdirSync(srcDir, { recursive: true });

      const initialAppContent = `import React from 'react';\nconst App: React.FC = () => React.createElement('div', { className: 'app' });\nexport default App;\n`;
      const initialIndexContent = `import express from 'express';\nimport { App } from './app';\n\nconst app = express();\nconst port = process.env.PORT || 3000;\n\napp.use('/', App);\n\napp.listen(port, () => {\n  console.log(\`Server is running on port \${port}\`);\n});\n\nexport { app, port };\n`;

      fs.writeFileSync(path.join(srcDir, "app.ts"), initialAppContent, "utf8");
      fs.writeFileSync(path.join(srcDir, "index.ts"), initialIndexContent, "utf8");

      const initialChanges: AgentFileChange[] = [
        {
          path: "src/app.ts",
          content: initialAppContent,
          action: "modify",
          description: "App component",
        },
      ];

      const approvedManifest: FileManifest = {
        manifestVersion: "1.0.0",
        totalFiles: 1,
        files: [
          {
            path: "src/app.ts",
            action: "modify",
            description: "App component",
            dependencies: [],
          },
        ],
      };

      const executionContract: ExecutionContract = {
        goal: "Fix all build errors until all the build errors pass.",
        taskType: "BUG_FIX",
        risk: "LOW",
        estimatedComplexity: "SMALL",
        pipeline: "REPOSITORY",
        environment: "REACT_TS",
        repositoryRequired: true,
        expectedFiles: ["src/app.ts"],
        validationType: "TYPESCRIPT_BUILD",
        targetPaths: ["src/app.ts"],
        allowedActions: ["modify"],
        forbiddenActions: [],
        maxFiles: 5,
        searchScope: ["src"],
        contextScope: ["src/app.ts"],
        diffCriticEnabled: false,
      };

      let buildCallCount = 0;
      jest.spyOn(ValidationRunner, "validateWithShell").mockImplementation(async () => {
        buildCallCount++;
        if (buildCallCount === 1) {
          // Cycle 1: initial check fails on missing express
          return {
            success: false,
            errors: `./src/index.ts:1:21\nType error: Cannot find module 'express' or its corresponding type declarations.`,
          };
        }
        if (buildCallCount === 2) {
          // Cycle 1: retry build after removing express reveals TS2614
          return {
            success: false,
            errors: `./src/index.ts:2:10\nType error: Module '"./app"' has no exported member 'App'. Did you mean to use 'import App from "./app"' instead?`,
          };
        }
        if (buildCallCount === 3) {
          // Cycle 2: initial check for Cycle 2 reveals TS2614
          return {
            success: false,
            errors: `./src/index.ts:2:10\nType error: Module '"./app"' has no exported member 'App'. Did you mean to use 'import App from "./app"' instead?`,
          };
        }
        if (buildCallCount === 4) {
          // Cycle 3: initial check for Cycle 3 reveals TS6133 unused port
          return {
            success: false,
            errors: `./src/index.ts:3:7\nType error: 'port' is declared but its value is never read.`,
          };
        }
        // Cycle 4: build succeeds after removing unused port
        return { success: true, errors: "" };
      });

      let completionCount = 0;
      const mockOpenAI = {
        chat: {
          completions: {
            create: jest.fn().mockImplementation(async () => {
              completionCount++;
              if (completionCount === 1) {
                // Cycle 1 MISSING_DEP repair: removes express and leaves unused port
                return {
                  choices: [
                    {
                      message: {
                        content: JSON.stringify({
                          changes: [
                            {
                              path: "src/index.ts",
                              content: `import { App } from './app';\n\nconst port = process.env.PORT || 3000;\n\nexport default App;\n`,
                            },
                          ],
                        }),
                      },
                    },
                  ],
                };
              }
              if (completionCount === 2) {
                // Cycle 2 normal repair: fixes TS2614 import { App } -> import App
                return {
                  choices: [
                    {
                      message: {
                        content: JSON.stringify({
                          repaired: true,
                          patchExplanation: "Fix default import of App",
                          changes: [
                            {
                              path: "src/index.ts",
                              action: "modify",
                              edits: [
                                {
                                  oldText: "import { App } from './app';",
                                  newText: "import App from './app';",
                                },
                              ],
                            },
                          ],
                        }),
                      },
                    },
                  ],
                };
              }
              // Cycle 3 normal repair: removes unused port
              return {
                choices: [
                  {
                    message: {
                      content: JSON.stringify({
                        repaired: true,
                        patchExplanation: "Remove unused port declaration",
                        changes: [
                          {
                            path: "src/index.ts",
                            action: "modify",
                            edits: [
                              {
                                oldText: "const port = process.env.PORT || 3000;\n\n",
                                newText: "",
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

      (getOpenAI as unknown as jest.Mock).mockReturnValue(mockOpenAI);

      const fsManager = new FileSystemStateManager();
      await fsManager.snapshot(
        [
          { path: "src/app.ts", content: initialAppContent, action: "modify", description: "App" },
          { path: "src/index.ts", content: initialIndexContent, action: "modify", description: "Index" },
        ],
        tempDir,
      );

      const result = await SelfHealingEngine.runSelfHealingLoop(
        initialChanges,
        tempDir,
        ["npm run build"],
        "You are a code repair assistant.",
        "Fix all build errors until all the build errors pass.",
        fsManager,
        undefined,
        undefined,
        approvedManifest,
        executionContract,
        undefined,
        undefined,
        "HEAD",
      );

      expect(result.success).toBe(true);
      expect(result.repaired).toBe(true);
      const diskContent = fs.readFileSync(path.join(srcDir, "index.ts"), "utf8");
      expect(diskContent).toBe("import App from './app';\n\nexport default App;\n");

      fs.rmSync(tempDir, { recursive: true, force: true });
    });
  });
});
