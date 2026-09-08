import fs from "fs";
import path from "path";
import os from "os";
import { isJsxInTsDiagnostic, buildRepairUserPrompt } from "../prompts/repair";
import { DiagnosticError } from "../../services/surgical-repair.engine";
import { SelfHealingEngine } from "../repair/SelfHealingEngine";
import { ValidationRunner } from "../validation/ValidationRunner";
import { FileSystemStateManager } from "../validation/FileSystemStateManager";
import { FileManifest } from "../../types";
import { ExecutionContract, AgentFileChange } from "../shared/types";
import { getOpenAI } from "../shared/utils";

jest.mock("../shared/utils", () => {
  const actual = jest.requireActual("../shared/utils");
  return {
    ...actual,
    getOpenAI: jest.fn(),
  };
});

describe("JSX-in-.TS Diagnostic Guidance for Self-Healing", () => {
  const liveAppTsContent = `import React from 'react';
import { Calculator } from './components/calculator';

const App: React.FC = () => {
  return (
    <div className="app">
      <h1>Calculator App</h1>
      <Calculator />
    </div>
  );
};

export default App;
`;

  test("Part G — Live Scenario: Detects JSX in .ts file and produces specialized prompt guidance", () => {
    const liveDiag: DiagnosticError = {
      file: "src/app.ts",
      line: 6,
      column: 6,
      code: "TS2304",
      message: "Cannot find name 'div'.",
      symbolName: "div",
      rawTrace: "./src/app.ts:6:6\nType error: Cannot find name 'div'.",
    };

    const isDetected = isJsxInTsDiagnostic(liveDiag, liveAppTsContent);
    expect(isDetected).toBe(true);

    const userPrompt = buildRepairUserPrompt({
      errorLog: liveDiag.rawTrace,
      diagnostics: [liveDiag],
      currentFiles: {
        "src/app.ts": liveAppTsContent,
      },
    });

    expect(userPrompt).toContain("[JSX_IN_TS_FILE]");
    expect(userPrompt).toContain("SPECIALIZED COMPILER REPAIR GUIDANCE:");
    expect(userPrompt).toContain(".ts file contains JSX");
    expect(userPrompt).toContain("Do not add imports for JSX intrinsic element names");
    expect(userPrompt).toContain("React.createElement");
  });

  test("Part H — Negative Generic TS2304: Missing service identifier is NOT classified as JSX_IN_TS_FILE", () => {
    const serviceTsContent = `import { Database } from './db';

export function runJob() {
  const result = missingService.doWork();
  return result;
}
`;

    const genericDiag: DiagnosticError = {
      file: "src/service.ts",
      line: 4,
      column: 18,
      code: "TS2304",
      message: "Cannot find name 'missingService'.",
      symbolName: "missingService",
      rawTrace: "src/service.ts:4:18 - error TS2304: Cannot find name 'missingService'.",
    };

    const isDetected = isJsxInTsDiagnostic(genericDiag, serviceTsContent);
    expect(isDetected).toBe(false);

    const userPrompt = buildRepairUserPrompt({
      errorLog: genericDiag.rawTrace,
      diagnostics: [genericDiag],
      currentFiles: {
        "src/service.ts": serviceTsContent,
      },
    });

    expect(userPrompt).not.toContain("[JSX_IN_TS_FILE]");
    expect(userPrompt).not.toContain("SPECIALIZED COMPILER REPAIR GUIDANCE:");
  });

  test("Part I — Negative Comparison: 'if (count < div)' is NOT classified as JSX_IN_TS_FILE", () => {
    const mathTsContent = `export function compareValue(count: number): boolean {
  if (count < div) {
    return true;
  }
  return false;
}
`;

    const comparisonDiag: DiagnosticError = {
      file: "src/math.ts",
      line: 2,
      column: 15,
      code: "TS2304",
      message: "Cannot find name 'div'.",
      symbolName: "div",
      rawTrace: "src/math.ts:2:15 - error TS2304: Cannot find name 'div'.",
    };

    const isDetected = isJsxInTsDiagnostic(comparisonDiag, mathTsContent);
    expect(isDetected).toBe(false);

    const userPrompt = buildRepairUserPrompt({
      errorLog: comparisonDiag.rawTrace,
      diagnostics: [comparisonDiag],
      currentFiles: {
        "src/math.ts": mathTsContent,
      },
    });

    expect(userPrompt).not.toContain("[JSX_IN_TS_FILE]");
    expect(userPrompt).not.toContain("SPECIALIZED COMPILER REPAIR GUIDANCE:");
  });

  test("Part J — Negative TSX: Missing symbol in .tsx file is NOT classified as JSX_IN_TS_FILE", () => {
    const tsxContent = `import React from 'react';

export default function Page() {
  return <div>{Something}</div>;
}
`;

    const tsxDiag: DiagnosticError = {
      file: "src/app.tsx",
      line: 4,
      column: 17,
      code: "TS2304",
      message: "Cannot find name 'Something'.",
      symbolName: "Something",
      rawTrace: "./src/app.tsx:4:17\nType error: Cannot find name 'Something'.",
    };

    const isDetected = isJsxInTsDiagnostic(tsxDiag, tsxContent);
    expect(isDetected).toBe(false);

    const userPrompt = buildRepairUserPrompt({
      errorLog: tsxDiag.rawTrace,
      diagnostics: [tsxDiag],
      currentFiles: {
        "src/app.tsx": tsxContent,
      },
    });

    expect(userPrompt).not.toContain("[JSX_IN_TS_FILE]");
    expect(userPrompt).not.toContain("SPECIALIZED COMPILER REPAIR GUIDANCE:");
  });

  test("Part G Integration — Self-Healing executes JSX-to-React.createElement conversion cleanly", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "anka-test-jsx-in-ts-"));
    const srcDir = path.join(tempDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });

    const appPath = path.join(srcDir, "app.ts");
    fs.writeFileSync(appPath, liveAppTsContent, "utf8");

    const approvedManifest: FileManifest = {
      manifestVersion: "1.0.0",
      files: [
        {
          path: "src/app.ts",
          action: "modify",
          description: "Calculator app component",
          dependencies: [],
        },
      ],
      totalFiles: 1,
    };

    const executionContract: ExecutionContract = {
      goal: "Fix all build errors",
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
      maxFiles: 2,
      searchScope: ["src/app.ts"],
      contextScope: ["src/app.ts"],
      diffCriticEnabled: false,
    };

    let buildCallCount = 0;
    jest.spyOn(ValidationRunner, "validateWithShell").mockImplementation(async () => {
      buildCallCount++;
      if (buildCallCount === 1) {
        return {
          success: false,
          errors: "./src/app.ts:6:6\nType error: Cannot find name 'div'.",
          exitCode: 1,
          commandExecuted: "npm run build",
        };
      }
      return {
        success: true,
        errors: "",
        exitCode: 0,
        commandExecuted: "npm run build",
      };
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
                    patchExplanation: "Rewrote JSX into React.createElement calls to fix .ts compilation",
                    changes: [
                      {
                        path: "src/app.ts",
                        action: "modify",
                        description: "Convert JSX to React.createElement",
                        edits: [
                          {
                            oldText: `  return (
    <div className="app">
      <h1>Calculator App</h1>
      <Calculator />
    </div>
  );`,
                            newText: `  return React.createElement(
    'div',
    { className: 'app' },
    React.createElement('h1', null, 'Calculator App'),
    React.createElement(Calculator, null)
  );`,
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

    (getOpenAI as unknown as jest.Mock).mockReturnValue(mockOpenAI);

    const initialChanges: AgentFileChange[] = [
      {
        path: "src/app.ts",
        content: liveAppTsContent,
        action: "modify",
        description: "Calculator app component",
      },
    ];

    const fsManager = new FileSystemStateManager();
    await fsManager.snapshot(initialChanges, tempDir);

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
    );

    expect(result.success).toBe(true);
    expect(result.repaired).toBe(true);
    expect(result.errorType).not.toBe("NO_REPAIR_PROGRESS");

    // Assert that the repair model received the specialized JSX in .ts guidance in its prompt
    expect(mockOpenAI.chat.completions.create).toHaveBeenCalled();
    const promptArg = mockOpenAI.chat.completions.create.mock.calls[0][0];
    const userMsg = promptArg.messages.find((m: any) => m.role === "user")?.content || "";
    expect(userMsg).toContain(".ts file contains JSX");
    expect(userMsg).toContain("Do not add imports for JSX intrinsic element names");
    expect(userMsg).toContain("React.createElement");

    const finalDiskContent = fs.readFileSync(appPath, "utf8");
    expect(finalDiskContent).toContain("React.createElement");
    expect(finalDiskContent).toContain("'div'");

    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
