import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";
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

describe("MISSING_DEP Repair Context Hydration for Dynamically Authorized Files", () => {
  const liveAppTsContent = `import React from 'react';
import { Calculator } from './components/calculator';

const App: React.FC = () => {
  return React.createElement('div', { className: 'app' });
};

export default App;
`;

  const liveIndexTsContent = `import express from 'express';
import { App } from './app';

const app = express();
const port = process.env.PORT || 3000;

app.use('/', App);

app.listen(port, () => {
  console.log(\`Server is running on port \${port}\`);
});

export { app, port };
`;

  const packageJsonContent = JSON.stringify({
    name: "anka-test-project",
    dependencies: {
      next: "latest",
      react: "^18.0.0",
      "react-dom": "^18.0.0",
    },
    devDependencies: {
      typescript: "6.0.3",
    },
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("Part G — Exact Live Scenario: Dynamically authorized src/index.ts is hydrated into MISSING_DEP repair context and rewritten", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "anka-test-missing-dep-"));
    const srcDir = path.join(tempDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });

    fs.writeFileSync(path.join(tempDir, "package.json"), packageJsonContent, "utf8");
    fs.writeFileSync(path.join(srcDir, "app.ts"), liveAppTsContent, "utf8");
    fs.writeFileSync(path.join(srcDir, "index.ts"), liveIndexTsContent, "utf8");

    execSync("git init", { cwd: tempDir, stdio: "ignore" });
    execSync("git config user.name 'Test'", { cwd: tempDir, stdio: "ignore" });
    execSync("git config user.email 'test@test.com'", { cwd: tempDir, stdio: "ignore" });
    execSync("git add .", { cwd: tempDir, stdio: "ignore" });
    execSync('git commit -m "Initial commit"', { cwd: tempDir, stdio: "ignore" });

    // Initial currentChanges strictly contains ONLY src/app.ts (lacks src/index.ts)
    const initialChanges: AgentFileChange[] = [
      {
        path: "src/app.ts",
        content: liveAppTsContent,
        action: "modify",
        description: "App component",
      },
    ];

    const approvedManifest: FileManifest = {
      manifestVersion: "1.0.0",
      files: [
        {
          path: "src/app.ts",
          action: "modify",
          description: "App component",
          dependencies: [],
        },
      ],
      totalFiles: 1,
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
        return {
          success: false,
          errors: "./src/index.ts:1:21\nType error: Cannot find module 'express' or its corresponding type declarations.",
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

    let promptReceivedChanges: any[] = [];
    const mockOpenAI = {
      chat: {
        completions: {
          create: jest.fn().mockImplementation(async (args: any) => {
            const userMsg = args.messages.find((m: any) => m.role === "user")?.content || "";
            const match = userMsg.match(/CURRENT CHANGES:\n(.*)/s);
            if (match) {
              try {
                promptReceivedChanges = JSON.parse(match[1]);
              } catch {}
            }
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      repaired: true,
                      patchExplanation: "Removed express and exported standard app handlers",
                      changes: [
                        {
                          path: "src/index.ts",
                          action: "modify",
                          description: "Clean up missing express dependency",
                          content: "export * from './app';\n",
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
      undefined,
      undefined,
      "HEAD",
    );

    expect(result.success).toBe(true);
    expect(result.repaired).toBe(true);

    // Verify that src/index.ts was hydrated into the prompt despite being absent from initialChanges
    expect(promptReceivedChanges.some((c: any) => c.path === "src/index.ts")).toBe(true);
    const indexEntry = promptReceivedChanges.find((c: any) => c.path === "src/index.ts");
    expect(indexEntry.content).toContain("import express from 'express';");

    // Verify on disk and finalChanges
    const diskContent = fs.readFileSync(path.join(srcDir, "index.ts"), "utf8");
    expect(diskContent).toBe("export * from './app';\n");
    expect(result.finalChanges.some((c) => c.path === "src/index.ts")).toBe(true);
    expect(result.finalChanges.some((c) => c.path === "src/app.ts")).toBe(true);

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test("Part H — Current Content vs Stale Baseline: Uses updated disk content if file was modified earlier", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "anka-test-current-content-"));
    const srcDir = path.join(tempDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });

    fs.writeFileSync(path.join(tempDir, "package.json"), packageJsonContent, "utf8");
    const modifiedIndexContent = `import express from 'express';\n// already modified in cycle 1\nexport const v = 2;`;
    fs.writeFileSync(path.join(srcDir, "index.ts"), modifiedIndexContent, "utf8");

    const initialChanges: AgentFileChange[] = [
      {
        path: "src/index.ts",
        content: modifiedIndexContent,
        action: "modify",
        description: "Modified index",
      },
    ];

    const approvedManifest: FileManifest = {
      manifestVersion: "1.0.0",
      files: [
        {
          path: "src/index.ts",
          action: "modify",
          description: "Index",
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
      expectedFiles: ["src/index.ts"],
      validationType: "TYPESCRIPT_BUILD",
      targetPaths: ["src/index.ts"],
      allowedActions: ["modify"],
      forbiddenActions: [],
      maxFiles: 5,
      searchScope: ["src"],
      contextScope: ["src/index.ts"],
      diffCriticEnabled: false,
    };

    let buildCallCount = 0;
    jest.spyOn(ValidationRunner, "validateWithShell").mockImplementation(async () => {
      buildCallCount++;
      if (buildCallCount === 1) {
        return {
          success: false,
          errors: "./src/index.ts:1:21\nType error: Cannot find module 'express' or its corresponding type declarations.",
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

    let promptReceivedChanges: any[] = [];
    const mockOpenAI = {
      chat: {
        completions: {
          create: jest.fn().mockImplementation(async (args: any) => {
            const userMsg = args.messages.find((m: any) => m.role === "user")?.content || "";
            const match = userMsg.match(/CURRENT CHANGES:\n(.*)/s);
            if (match) {
              try {
                promptReceivedChanges = JSON.parse(match[1]);
              } catch {}
            }
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      repaired: true,
                      changes: [
                        {
                          path: "src/index.ts",
                          action: "modify",
                          description: "Clean up express",
                          content: "export const v = 2;\n",
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
    await fsManager.snapshot(initialChanges, tempDir);

    const result = await SelfHealingEngine.runSelfHealingLoop(
      initialChanges,
      tempDir,
      ["npm run build"],
      "You are a code repair assistant.",
      "Fix all build errors",
      fsManager,
      undefined,
      undefined,
      approvedManifest,
      executionContract,
    );

    expect(result.success).toBe(true);
    const indexEntry = promptReceivedChanges.find((c: any) => c.path === "src/index.ts");
    expect(indexEntry.content).toContain("// already modified in cycle 1");

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test("Part I — Unauthorized File Negative Test: Diagnostic file not in manifest or revealed scope is NOT hydrated", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "anka-test-unauth-"));
    const srcDir = path.join(tempDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });

    fs.writeFileSync(path.join(tempDir, "package.json"), packageJsonContent, "utf8");
    fs.writeFileSync(path.join(srcDir, "unknown.ts"), "import x from 'uninstalled-x';", "utf8");
    fs.writeFileSync(path.join(srcDir, "app.ts"), liveAppTsContent, "utf8");

    const initialChanges: AgentFileChange[] = [
      {
        path: "src/app.ts",
        content: liveAppTsContent,
        action: "modify",
        description: "App",
      },
    ];

    // Narrow task contract: ONLY src/app.ts allowed
    const approvedManifest: FileManifest = {
      manifestVersion: "1.0.0",
      files: [
        {
          path: "src/app.ts",
          action: "modify",
          description: "App",
          dependencies: [],
        },
      ],
      totalFiles: 1,
    };

    const executionContract: ExecutionContract = {
      goal: "Narrow fix app.ts only",
      taskType: "BUG_FIX",
      risk: "LOW",
      estimatedComplexity: "SMALL",
      pipeline: "STANDALONE",
      environment: "REACT_TS",
      repositoryRequired: false,
      expectedFiles: ["src/app.ts"],
      validationType: "TYPESCRIPT_BUILD",
      targetPaths: ["src/app.ts"],
      allowedActions: ["modify"],
      forbiddenActions: [],
      maxFiles: 1,
      searchScope: ["src/app.ts"],
      contextScope: ["src/app.ts"],
      diffCriticEnabled: false,
    };

    jest.spyOn(ValidationRunner, "validateWithShell").mockResolvedValue({
      success: false,
      errors: "./src/unknown.ts:1:1\nType error: Cannot find module 'uninstalled-x' or its corresponding type declarations.",
    });

    let promptReceivedChanges: any[] = [];
    const mockOpenAI = {
      chat: {
        completions: {
          create: jest.fn().mockImplementation(async (args: any) => {
            const userMsg = args.messages.find((m: any) => m.role === "user")?.content || "";
            const match = userMsg.match(/CURRENT CHANGES:\n(.*)/s);
            if (match) {
              try {
                promptReceivedChanges = JSON.parse(match[1]);
              } catch {}
            }
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({ repaired: false, changes: [] }),
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
    await fsManager.snapshot(initialChanges, tempDir);

    const result = await SelfHealingEngine.runSelfHealingLoop(
      initialChanges,
      tempDir,
      ["npm run build"],
      "You are a code repair assistant.",
      "Fix app.ts only",
      fsManager,
      undefined,
      undefined,
      approvedManifest,
      executionContract,
    );

    expect(result.success).toBe(false);
    expect(promptReceivedChanges.some((c: any) => c.path === "src/unknown.ts")).toBe(false);

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test("Part J — Deduplication: If a file already exists in currentChanges, exactly 1 entry appears in repair context", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "anka-test-dedupe-"));
    const srcDir = path.join(tempDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });

    fs.writeFileSync(path.join(tempDir, "package.json"), packageJsonContent, "utf8");
    fs.writeFileSync(path.join(srcDir, "index.ts"), liveIndexTsContent, "utf8");

    const initialChanges: AgentFileChange[] = [
      {
        path: "src/index.ts",
        content: liveIndexTsContent,
        action: "modify",
        description: "Index",
      },
    ];

    const approvedManifest: FileManifest = {
      manifestVersion: "1.0.0",
      files: [
        {
          path: "src/index.ts",
          action: "modify",
          description: "Index",
          dependencies: [],
        },
      ],
      totalFiles: 1,
    };

    const executionContract: ExecutionContract = {
      goal: "Fix index.ts",
      taskType: "BUG_FIX",
      risk: "LOW",
      estimatedComplexity: "SMALL",
      pipeline: "REPOSITORY",
      environment: "REACT_TS",
      repositoryRequired: true,
      expectedFiles: ["src/index.ts"],
      validationType: "TYPESCRIPT_BUILD",
      targetPaths: ["src/index.ts"],
      allowedActions: ["modify"],
      forbiddenActions: [],
      maxFiles: 5,
      searchScope: ["src"],
      contextScope: ["src/index.ts"],
      diffCriticEnabled: false,
    };

    jest.spyOn(ValidationRunner, "validateWithShell").mockResolvedValue({
      success: false,
      errors: "./src/index.ts:1:21\nType error: Cannot find module 'express' or its corresponding type declarations.",
    });

    let promptReceivedChanges: any[] = [];
    const mockOpenAI = {
      chat: {
        completions: {
          create: jest.fn().mockImplementation(async (args: any) => {
            const userMsg = args.messages.find((m: any) => m.role === "user")?.content || "";
            const match = userMsg.match(/CURRENT CHANGES:\n(.*)/s);
            if (match) {
              try {
                promptReceivedChanges = JSON.parse(match[1]);
              } catch {}
            }
            return {
              choices: [{ message: { content: JSON.stringify({ repaired: false, changes: [] }) } }],
            };
          }),
        },
      },
    };

    (getOpenAI as unknown as jest.Mock).mockReturnValue(mockOpenAI);

    const fsManager = new FileSystemStateManager();
    await fsManager.snapshot(initialChanges, tempDir);

    await SelfHealingEngine.runSelfHealingLoop(
      initialChanges,
      tempDir,
      ["npm run build"],
      "You are a code repair assistant.",
      "Fix index.ts",
      fsManager,
      undefined,
      undefined,
      approvedManifest,
      executionContract,
    );

    const indexEntries = promptReceivedChanges.filter((c: any) => c.path === "src/index.ts");
    expect(indexEntries.length).toBe(1);

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test("Part J — Exact Live Regression Test: TS2307 express -> TS2614 revealed -> cycle 2 repairs TS2614 -> clean build", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "anka-test-transition-live-"));
    const srcDir = path.join(tempDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });

    fs.writeFileSync(path.join(tempDir, "package.json"), packageJsonContent, "utf8");
    fs.writeFileSync(path.join(srcDir, "app.ts"), liveAppTsContent, "utf8");
    fs.writeFileSync(path.join(srcDir, "index.ts"), liveIndexTsContent, "utf8");

    execSync("git init", { cwd: tempDir, stdio: "ignore" });
    execSync("git config user.name 'Test'", { cwd: tempDir, stdio: "ignore" });
    execSync("git config user.email 'test@test.com'", { cwd: tempDir, stdio: "ignore" });
    execSync("git add .", { cwd: tempDir, stdio: "ignore" });
    execSync('git commit -m "Initial commit"', { cwd: tempDir, stdio: "ignore" });

    const initialChanges: AgentFileChange[] = [
      {
        path: "src/app.ts",
        content: liveAppTsContent,
        action: "modify",
        description: "App component",
      },
    ];

    const approvedManifest: FileManifest = {
      manifestVersion: "1.0.0",
      files: [
        {
          path: "src/app.ts",
          action: "modify",
          description: "App component",
          dependencies: [],
        },
      ],
      totalFiles: 1,
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
        // Initial build / baseline check fails with missing express
        return {
          success: false,
          errors: "./src/index.ts:1:21\nType error: Cannot find module 'express' or its corresponding type declarations.",
        };
      }
      if (buildCallCount === 2) {
        // Retry build after express is removed reveals TS2614
        return {
          success: false,
          errors: "./src/index.ts:2:10\nType error: Module '\"./app\"' has no exported member 'App'. Did you mean to use 'import App from \"./app\"' instead?",
        };
      }
      if (buildCallCount === 3) {
        // Start of cycle 2 validation confirms TS2614
        return {
          success: false,
          errors: "./src/index.ts:2:10\nType error: Module '\"./app\"' has no exported member 'App'. Did you mean to use 'import App from \"./app\"' instead?",
        };
      }
      // After cycle 2 repairs TS2614, build passes cleanly!
      return {
        success: true,
        errors: "",
      };
    });

    let completionCount = 0;
    const mockOpenAI = {
      chat: {
        completions: {
          create: jest.fn().mockImplementation(async (args: any) => {
            completionCount++;
            if (completionCount === 1) {
              // MISSING_DEP bounded correction: removes express, retains import { App } from './app'
              return {
                choices: [
                  {
                    message: {
                      content: JSON.stringify({
                        repaired: true,
                        patchExplanation: "Removed express, keeping App import",
                        changes: [
                          {
                            path: "src/index.ts",
                            action: "modify",
                            description: "Remove express",
                            content: "import { App } from './app';\nexport default App;\n",
                          },
                        ],
                      }),
                    },
                  },
                ],
              };
            }
            // Cycle 2 normal repair: fixes TS2614 (import App from './app')
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
      undefined,
      undefined,
      "HEAD",
    );

    console.log("PART J FINAL CHANGES:", JSON.stringify(result.finalChanges), "COMPLETION COUNT:", completionCount, "BUILD CALLS:", buildCallCount);
    expect(result.success).toBe(true);
    expect(result.repaired).toBe(true);
    const diskContent = fs.readFileSync(path.join(srcDir, "index.ts"), "utf8");
    expect(diskContent).toBe("import App from './app';\nexport default App;\n");

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test("Part K — Same Dependency Negative Test: If retry build still fails on same express TS2307, stops with MISSING_DEP", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "anka-test-same-dep-"));
    const srcDir = path.join(tempDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });

    fs.writeFileSync(path.join(tempDir, "package.json"), packageJsonContent, "utf8");
    fs.writeFileSync(path.join(srcDir, "app.ts"), liveAppTsContent, "utf8");
    fs.writeFileSync(path.join(srcDir, "index.ts"), liveIndexTsContent, "utf8");

    execSync("git init", { cwd: tempDir, stdio: "ignore" });
    execSync("git config user.name 'Test'", { cwd: tempDir, stdio: "ignore" });
    execSync("git config user.email 'test@test.com'", { cwd: tempDir, stdio: "ignore" });
    execSync("git add .", { cwd: tempDir, stdio: "ignore" });
    execSync('git commit -m "Initial commit"', { cwd: tempDir, stdio: "ignore" });

    const initialChanges: AgentFileChange[] = [
      {
        path: "src/app.ts",
        content: liveAppTsContent,
        action: "modify",
        description: "App component",
      },
    ];

    const approvedManifest: FileManifest = {
      manifestVersion: "1.0.0",
      files: [
        {
          path: "src/app.ts",
          action: "modify",
          description: "App component",
          dependencies: [],
        },
      ],
      totalFiles: 1,
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

    jest.spyOn(ValidationRunner, "validateWithShell").mockResolvedValue({
      success: false,
      errors: "./src/index.ts:1:21\nType error: Cannot find module 'express' or its corresponding type declarations.",
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
                    changes: [
                      {
                        path: "src/index.ts",
                        action: "modify",
                        description: "Attempted change",
                        content: liveIndexTsContent,
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
      undefined,
      undefined,
      "HEAD",
    );

    expect(result.success).toBe(false);
    expect(result.errorType).toBe("MISSING_DEP");

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test("Part L — Different Dependency Progress Test: Express resolved, reveals different missing package -> continues repair loop", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "anka-test-diff-dep-"));
    const srcDir = path.join(tempDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });

    fs.writeFileSync(path.join(tempDir, "package.json"), packageJsonContent, "utf8");
    fs.writeFileSync(path.join(srcDir, "app.ts"), liveAppTsContent, "utf8");
    fs.writeFileSync(path.join(srcDir, "index.ts"), liveIndexTsContent, "utf8");

    execSync("git init", { cwd: tempDir, stdio: "ignore" });
    execSync("git config user.name 'Test'", { cwd: tempDir, stdio: "ignore" });
    execSync("git config user.email 'test@test.com'", { cwd: tempDir, stdio: "ignore" });
    execSync("git add .", { cwd: tempDir, stdio: "ignore" });
    execSync('git commit -m "Initial commit"', { cwd: tempDir, stdio: "ignore" });

    const initialChanges: AgentFileChange[] = [
      {
        path: "src/app.ts",
        content: liveAppTsContent,
        action: "modify",
        description: "App component",
      },
    ];

    const approvedManifest: FileManifest = {
      manifestVersion: "1.0.0",
      files: [
        {
          path: "src/app.ts",
          action: "modify",
          description: "App component",
          dependencies: [],
        },
      ],
      totalFiles: 1,
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
        return {
          success: false,
          errors: "./src/index.ts:1:21\nType error: Cannot find module 'express' or its corresponding type declarations.",
        };
      }
      if (buildCallCount === 2) {
        // Retry build after express is removed reveals different package 'legacy-pkg'
        return {
          success: false,
          errors: "./src/index.ts:1:21\nType error: Cannot find module 'legacy-pkg' or its corresponding type declarations.",
        };
      }
      if (buildCallCount === 3) {
        return {
          success: false,
          errors: "./src/index.ts:1:21\nType error: Cannot find module 'legacy-pkg' or its corresponding type declarations.",
        };
      }
      // After cycle 2 fixes legacy-pkg, passes
      return {
        success: true,
        errors: "",
      };
    });

    let completionCount = 0;
    const mockOpenAI = {
      chat: {
        completions: {
          create: jest.fn().mockImplementation(async () => {
            completionCount++;
            if (completionCount === 1) {
              return {
                choices: [
                  {
                    message: {
                      content: JSON.stringify({
                        repaired: true,
                        changes: [
                          {
                            path: "src/index.ts",
                            action: "modify",
                            description: "Remove express",
                            content: "export default null;\n",
                          },
                        ],
                      }),
                    },
                  },
                ],
              };
            }
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      repaired: true,
                      changes: [
                        {
                          path: "src/index.ts",
                          action: "modify",
                          description: "Remove legacy-pkg",
                          content: "export default null;\n",
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
      undefined,
      undefined,
      "HEAD",
    );

    expect(result.success).toBe(true);
    expect(result.repaired).toBe(true);
    expect(completionCount).toBeGreaterThanOrEqual(2);

    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
