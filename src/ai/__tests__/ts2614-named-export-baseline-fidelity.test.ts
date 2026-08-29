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

describe("TS2614 Diagnostic Fidelity & Immutable Baseline Import/Export Proof", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  // =========================================================================
  // Section 1: ErrorDiagnosticsParser Diagnostic Fidelity
  // =========================================================================

  describe("Section 1: ErrorDiagnosticsParser Tests", () => {
    test("1. Exact TS2614 live message parses as TS2614 with symbolName App", () => {
      const rawLog = `./src/index.ts:2:10\nType error: Module '"./app"' has no exported member 'App'. Did you mean to use 'import App from "./app"' instead?`;
      const diags = ErrorDiagnosticsParser.parse(rawLog);

      expect(diags.length).toBe(1);
      expect(diags[0].file).toBe("src/index.ts");
      expect(diags[0].line).toBe(2);
      expect(diags[0].column).toBe(10);
      expect(diags[0].code).toBe("TS2614");
      expect(diags[0].symbolName).toBe("App");
    });

    test("2. Generic missing named export without default suggestion parses as TS2305", () => {
      const rawLog = `./src/index.ts:2:10\nType error: Module '"./utils"' has no exported member 'Helper'.`;
      const diags = ErrorDiagnosticsParser.parse(rawLog);

      expect(diags.length).toBe(1);
      expect(diags[0].code).toBe("TS2305");
      expect(diags[0].symbolName).toBe("Helper");
    });

    test("3. Unknown export-looking error remains BUILD_ERR", () => {
      const rawLog = `./src/index.ts:5:1\nType error: An export assignment cannot have modifiers.`;
      const diags = ErrorDiagnosticsParser.parse(rawLog);

      expect(diags.length).toBe(1);
      expect(diags[0].code).toBe("BUILD_ERR");
    });

    test("4. TS2304 Cannot find name remains TS2304", () => {
      const rawLog = `./src/app.ts:6:6\nType error: Cannot find name 'div'.`;
      const diags = ErrorDiagnosticsParser.parse(rawLog);

      expect(diags.length).toBe(1);
      expect(diags[0].code).toBe("TS2304");
      expect(diags[0].symbolName).toBe("div");
    });

    test("5. TS2307 Cannot find module remains TS2307", () => {
      const rawLog = `./src/index.ts:1:21\nType error: Cannot find module 'express' or its corresponding type declarations.`;
      const diags = ErrorDiagnosticsParser.parse(rawLog);

      expect(diags.length).toBe(1);
      expect(diags[0].code).toBe("TS2307");
      expect(diags[0].symbolName).toBe("express");
    });

    test("6. TS2440 Cannot redeclare exported variable remains TS2440", () => {
      const rawLog = `./components/Calculator.tsx:7:14\nType error: Cannot redeclare exported variable 'CalculatorButton'.`;
      const diags = ErrorDiagnosticsParser.parse(rawLog);

      expect(diags.length).toBe(1);
      expect(diags[0].code).toBe("TS2440");
      expect(diags[0].symbolName).toBe("CalculatorButton");
    });
  });

  // =========================================================================
  // Section 2: BaselineDeltaVerifier Immutable Import/Export Proof
  // =========================================================================

  describe("Section 2: BaselineDeltaVerifier Causality Proofs", () => {
    const baselineIndexTs = `import express from 'express';\nimport { App } from './app';\nconst PORT = 3000;\nexport default App;\n`;
    const baselineAppTs = `import React from 'react';\nconst App: React.FC = () => React.createElement('div');\nexport default App;\n`;
    const baselineAppTsWithNamed = `import React from 'react';\nexport const App: React.FC = () => React.createElement('div');\nexport default App;\n`;

    test("1. Named import + default-only export -> pre-existing (REVEALED_BASELINE)", () => {
      const preTaskSourceGetter = (p: string) => {
        if (p.includes("index.ts")) return baselineIndexTs;
        if (p.includes("app.ts")) return baselineAppTs;
        return null;
      };

      // File was touched by agent (e.g. Express removed)
      const modifiedIndexChange: AgentFileChange = {
        path: "src/index.ts",
        content: `import { App } from './app';\nconst PORT = 3000;\nexport default App;\n`,
        action: "modify",
        description: "Index file",
      };

      const diag = {
        filePath: "src/index.ts",
        line: 1,
        column: 10,
        errorCode: "TS2614",
        message: `Module '"./app"' has no exported member 'App'. Did you mean to use 'import App from "./app"' instead?`,
        symbolName: "App",
        errorType: "COMPILE_TS" as const,
        origin: "CURRENT_TASK" as const,
        fingerprint: "TS2614|src/index.ts|1",
      };

      const causality = BaselineDeltaVerifier.isConstructPreExistingAndUntouched(
        diag,
        baselineIndexTs,
        modifiedIndexChange,
        {
          preTaskSourceGetter,
          changes: [
            modifiedIndexChange,
            { path: "src/app.ts", content: baselineAppTs, action: "modify", description: "App component" },
          ],
          authorizedRevealedBaselinePaths: new Set(["src/index.ts", "src/app.ts"]),
        },
      );

      expect(causality.isPreExisting).toBe(true);
      expect(causality.isTouched).toBe(false);
    });

    test("2. Negative: Baseline target HAD named export -> NOT pre-existing (fail-closed)", () => {
      const preTaskSourceGetter = (p: string) => {
        if (p.includes("index.ts")) return baselineIndexTs;
        if (p.includes("app.ts")) return baselineAppTsWithNamed;
        return null;
      };

      const modifiedIndexChange: AgentFileChange = {
        path: "src/index.ts",
        content: `import { App } from './app';\nconst PORT = 3000;\nexport default App;\n`,
        action: "modify",
        description: "Index file",
      };

      const diag = {
        filePath: "src/index.ts",
        line: 1,
        column: 10,
        errorCode: "TS2614",
        message: `Module '"./app"' has no exported member 'App'. Did you mean to use 'import App from "./app"' instead?`,
        symbolName: "App",
        errorType: "COMPILE_TS" as const,
        origin: "CURRENT_TASK" as const,
        fingerprint: "TS2614|src/index.ts|1",
      };

      const causality = BaselineDeltaVerifier.isConstructPreExistingAndUntouched(
        diag,
        baselineIndexTs,
        modifiedIndexChange,
        {
          preTaskSourceGetter,
          changes: [
            modifiedIndexChange,
            { path: "src/app.ts", content: baselineAppTsWithNamed, action: "modify", description: "App component" },
          ],
          authorizedRevealedBaselinePaths: new Set(["src/index.ts", "src/app.ts"]),
        },
      );

      expect(causality.isPreExisting).toBe(false);
      expect(causality.isTouched).toBe(true);
    });

    test("3. Negative: Import was introduced by agent -> NOT pre-existing", () => {
      const baselineIndexWithoutApp = `import express from 'express';\nconst PORT = 3000;\n`;
      const preTaskSourceGetter = (p: string) => {
        if (p.includes("index.ts")) return baselineIndexWithoutApp;
        if (p.includes("app.ts")) return baselineAppTs;
        return null;
      };

      const modifiedIndexChange: AgentFileChange = {
        path: "src/index.ts",
        content: `import { App } from './app';\nconst PORT = 3000;\n`,
        action: "modify",
        description: "Index file",
      };

      const diag = {
        filePath: "src/index.ts",
        line: 1,
        column: 10,
        errorCode: "TS2614",
        message: `Module '"./app"' has no exported member 'App'. Did you mean to use 'import App from "./app"' instead?`,
        symbolName: "App",
        errorType: "COMPILE_TS" as const,
        origin: "CURRENT_TASK" as const,
        fingerprint: "TS2614|src/index.ts|1",
      };

      const causality = BaselineDeltaVerifier.isConstructPreExistingAndUntouched(
        diag,
        baselineIndexWithoutApp,
        modifiedIndexChange,
        {
          preTaskSourceGetter,
          changes: [modifiedIndexChange],
          authorizedRevealedBaselinePaths: new Set(["src/index.ts"]),
        },
      );

      expect(causality.isPreExisting).toBe(false);
      expect(causality.isTouched).toBe(true);
    });

    test("4. Negative: Symbol changed (Dashboard vs App) -> NOT pre-existing", () => {
      const preTaskSourceGetter = (p: string) => {
        if (p.includes("index.ts")) return baselineIndexTs;
        if (p.includes("app.ts")) return baselineAppTs;
        return null;
      };

      const modifiedIndexChange: AgentFileChange = {
        path: "src/index.ts",
        content: `import { Dashboard } from './app';\n`,
        action: "modify",
        description: "Index file",
      };

      const diag = {
        filePath: "src/index.ts",
        line: 1,
        column: 10,
        errorCode: "TS2614",
        message: `Module '"./app"' has no exported member 'Dashboard'.`,
        symbolName: "Dashboard",
        errorType: "COMPILE_TS" as const,
        origin: "CURRENT_TASK" as const,
        fingerprint: "TS2614|src/index.ts|1",
      };

      const causality = BaselineDeltaVerifier.isConstructPreExistingAndUntouched(
        diag,
        baselineIndexTs,
        modifiedIndexChange,
        {
          preTaskSourceGetter,
          changes: [modifiedIndexChange],
          authorizedRevealedBaselinePaths: new Set(["src/index.ts"]),
        },
      );

      expect(causality.isPreExisting).toBe(false);
      expect(causality.isTouched).toBe(true);
    });

    test("5. Negative: Module changed (./other vs ./app) -> NOT pre-existing", () => {
      const preTaskSourceGetter = (p: string) => {
        if (p.includes("index.ts")) return baselineIndexTs;
        if (p.includes("app.ts")) return baselineAppTs;
        return null;
      };

      const modifiedIndexChange: AgentFileChange = {
        path: "src/index.ts",
        content: `import { App } from './other';\n`,
        action: "modify",
        description: "Index file",
      };

      const diag = {
        filePath: "src/index.ts",
        line: 1,
        column: 10,
        errorCode: "TS2614",
        message: `Module '"./other"' has no exported member 'App'.`,
        symbolName: "App",
        errorType: "COMPILE_TS" as const,
        origin: "CURRENT_TASK" as const,
        fingerprint: "TS2614|src/index.ts|1",
      };

      const causality = BaselineDeltaVerifier.isConstructPreExistingAndUntouched(
        diag,
        baselineIndexTs,
        modifiedIndexChange,
        {
          preTaskSourceGetter,
          changes: [modifiedIndexChange],
          authorizedRevealedBaselinePaths: new Set(["src/index.ts"]),
        },
      );

      expect(causality.isPreExisting).toBe(false);
      expect(causality.isTouched).toBe(true);
    });
  });

  // =========================================================================
  // Section 3: Full End-to-End Live Self-Healing Regression
  // =========================================================================

  describe("Section 3: Live Self-Healing Regression Test", () => {
    test("Full flow: TS2307 Express -> Express removed -> TS2614 App -> REVEALED_BASELINE -> import repaired -> build passes", async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "anka-test-ts2614-"));
      const srcDir = path.join(tempDir, "src");
      fs.mkdirSync(srcDir, { recursive: true });

      const initialAppContent = `import React from 'react';\nimport { Calculator } from './components/calculator';\n\nconst App: React.FC = () => {\n  return React.createElement('div', { className: 'app' });\n};\n\nexport default App;\n`;
      const initialIndexContent = `import express from 'express';\nimport { App } from './app';\n\nconst app = express();\nexport default App;\n`;

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
          // Cycle 1 initial check
          return {
            success: false,
            errors: `./src/index.ts:1:21\nType error: Cannot find module 'express' or its corresponding type declarations.`,
          };
        }
        if (buildCallCount === 2) {
          // Cycle 1 retry build after removing express
          return {
            success: false,
            errors: `./src/index.ts:2:10\nType error: Module '"./app"' has no exported member 'App'. Did you mean to use 'import App from "./app"' instead?`,
          };
        }
        if (buildCallCount === 3) {
          // Cycle 2 initial check
          return {
            success: false,
            errors: `./src/index.ts:2:10\nType error: Module '"./app"' has no exported member 'App'. Did you mean to use 'import App from "./app"' instead?`,
          };
        }
        // Cycle 3 build after repairing import
        return { success: true, errors: "" };
      });

      let completionCount = 0;
      const mockOpenAI = {
        chat: {
          completions: {
            create: jest.fn().mockImplementation(async () => {
              completionCount++;
              if (completionCount === 1) {
                // Cycle 1 MISSING_DEP repair: removes express
                return {
                  choices: [
                    {
                      message: {
                        content: JSON.stringify({
                          changes: [
                            {
                              path: "src/index.ts",
                              content: `import { App } from './app';\nexport default App;\n`,
                            },
                          ],
                        }),
                      },
                    },
                  ],
                };
              }
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
      expect(diskContent).toBe("import App from './app';\nexport default App;\n");

      fs.rmSync(tempDir, { recursive: true, force: true });
    });
  });
});
