import { CodeGenerator } from "../generation/CodeGenerator";
import { enforceExecutionScope } from "../contracts/ExecutionScopeEnforcer";
import { ExecutionContract, FileManifest } from "../../types";

describe("CodeGenerator Manifest Action Fidelity", () => {
  const existingFiles = [
    "app/components/Calculator.tsx",
    "app/styles/calculator.css",
    "app/page.tsx",
    "package.json",
  ];

  test("Part K (Regression 1): When manifest is mixed (DELETE + MODIFY) and taskType=DELETE_FOLDER, deletion mandate only contains delete files", async () => {
    const manifest: FileManifest = {
      manifestVersion: "1.0.0",
      totalFiles: 3,
      files: [
        { path: "app/components/Calculator.tsx", action: "delete", description: "Delete calculator component", dependencies: [] },
        { path: "app/styles/calculator.css", action: "delete", description: "Delete calculator styles", dependencies: [] },
        { path: "app/page.tsx", action: "modify", description: "Remove calculator references and enhance dashboard UI", dependencies: [] },
      ],
    };

    const contract: ExecutionContract = {
      goal: "Delete calculator and enhance dashboard",
      taskType: "DELETE_FOLDER",
      risk: "MEDIUM",
      estimatedComplexity: "MEDIUM",
      pipeline: "REPOSITORY",
      environment: "REACT_TS",
      repositoryRequired: true,
      expectedFiles: ["app/components/Calculator.tsx", "app/styles/calculator.css", "app/page.tsx"],
      validationType: "TYPESCRIPT_BUILD",
      targetPaths: ["app/components/Calculator.tsx", "app/styles/calculator.css", "app/page.tsx"],
      allowedActions: ["delete_folder", "delete_file", "modify_file", "create_components"],
      forbiddenActions: ["rename"],
      maxFiles: 15,
      searchScope: ["app/components/Calculator.tsx", "app/styles/calculator.css", "app/page.tsx"],
      contextScope: ["app/components/Calculator.tsx", "app/styles/calculator.css", "app/page.tsx"],
      diffCriticEnabled: true,
    };

    const pageContent = 'import Calculator from "./components/Calculator";\nexport default function Page() { return <div><Calculator /></div>; }';
    const authoritativeSources = {
      "app/page.tsx": {
        path: "app/page.tsx",
        content: pageContent,
        sha256: "dummy-sha",
      },
    };

    // Spy on getOpenAI to capture prompts and mock LLM response
    const utils = require("../shared/utils");
    const originalGetOpenAI = utils.getOpenAI;
    let capturedUserPrompt = "";

    utils.getOpenAI = () => ({
      chat: {
        completions: {
          create: async (params: any) => {
            const userMsg = params.messages.find((m: any) => m.role === "user");
            if (userMsg) capturedUserPrompt = userMsg.content;

            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      explanation: "Removed calculator and enhanced dashboard",
                      changes: [
                        { path: "app/components/Calculator.tsx", action: "delete", isDeleted: true, content: "", description: "Delete Calculator" },
                        { path: "app/styles/calculator.css", action: "delete", isDeleted: true, content: "", description: "Delete styles" },
                        {
                          path: "app/page.tsx",
                          action: "modify",
                          description: "Enhance dashboard and remove calculator",
                          edits: [
                            {
                              oldText: 'import Calculator from "./components/Calculator";\nexport default function Page() { return <div><Calculator /></div>; }',
                              newText: 'export default function Page() { return <main className="dashboard"><h1>Enhanced Dashboard</h1></main>; }',
                            },
                          ],
                        },
                      ],
                    }),
                  },
                },
              ],
            };
          },
        },
      },
    });

    try {
      const result = await CodeGenerator.generateRoadmapAndDiffs(
        "Remove the calculator from the repository and enhance the dashboard UI.",
        { intent: "DELETE_FOLDER", taskType: "DELETE_FOLDER" },
        { fileContext: { "app/page.tsx": pageContent } },
        "system prompt",
        contract,
        manifest,
        authoritativeSources,
      );

      // Verify deletion mandate in prompt does NOT include app/page.tsx
      expect(capturedUserPrompt).toContain("DELETION MANDATE: This request asks to delete specific approved file(s): app/components/Calculator.tsx, app/styles/calculator.css");
      expect(capturedUserPrompt).not.toContain("delete specific approved file(s): app/components/Calculator.tsx, app/styles/calculator.css, app/page.tsx");

      // Verify result preservation
      const pageChange = result.changes.find((c) => c.path === "app/page.tsx");
      expect(pageChange).toBeDefined();
      expect(pageChange?.action).toBe("modify");
      expect(pageChange?.isDeleted).toBeUndefined();
      expect(pageChange?.content).toContain("Enhanced Dashboard");
    } finally {
      utils.getOpenAI = originalGetOpenAI;
    }
  });

  test("Part L (Regression 2): Post-generation processing preserves MODIFY action and content for page.tsx", async () => {
    const manifest: FileManifest = {
      manifestVersion: "1.0.0",
      totalFiles: 3,
      files: [
        { path: "app/components/Calculator.tsx", action: "delete", description: "Delete calculator component", dependencies: [] },
        { path: "app/styles/calculator.css", action: "delete", description: "Delete calculator styles", dependencies: [] },
        { path: "app/page.tsx", action: "modify", description: "Remove calculator references and enhance dashboard UI", dependencies: [] },
      ],
    };

    const contract: ExecutionContract = {
      goal: "Delete calculator and enhance dashboard",
      taskType: "DELETE_FOLDER",
      risk: "MEDIUM",
      estimatedComplexity: "MEDIUM",
      pipeline: "REPOSITORY",
      environment: "REACT_TS",
      repositoryRequired: true,
      expectedFiles: ["app/components/Calculator.tsx", "app/styles/calculator.css", "app/page.tsx"],
      validationType: "TYPESCRIPT_BUILD",
      targetPaths: ["app/components/Calculator.tsx", "app/styles/calculator.css", "app/page.tsx"],
      allowedActions: ["delete_folder", "delete_file", "modify_file", "create_components"],
      forbiddenActions: ["rename"],
      maxFiles: 15,
      searchScope: ["app/components/Calculator.tsx", "app/styles/calculator.css", "app/page.tsx"],
      contextScope: ["app/components/Calculator.tsx", "app/styles/calculator.css", "app/page.tsx"],
      diffCriticEnabled: true,
    };

    const pageContent = 'import Calculator from "./components/Calculator";\nexport default function Page() { return <div><Calculator /></div>; }';
    const authoritativeSources = {
      "app/page.tsx": {
        path: "app/page.tsx",
        content: pageContent,
        sha256: "dummy-sha",
      },
    };

    const utils = require("../shared/utils");
    const originalGetOpenAI = utils.getOpenAI;

    utils.getOpenAI = () => ({
      chat: {
        completions: {
          create: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    explanation: "Removed calculator and enhanced dashboard",
                    changes: [
                      { path: "app/components/Calculator.tsx", action: "delete", isDeleted: true, content: "", description: "Delete Calculator" },
                      { path: "app/styles/calculator.css", action: "delete", isDeleted: true, content: "", description: "Delete styles" },
                      {
                        path: "app/page.tsx",
                        action: "modify",
                        description: "Enhance dashboard and remove calculator",
                        edits: [
                          {
                            oldText: 'import Calculator from "./components/Calculator";\nexport default function Page() { return <div><Calculator /></div>; }',
                            newText: 'export default function Page() { return <main className="dashboard"><h1>Enhanced Dashboard</h1></main>; }',
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
    });

    try {
      const result = await CodeGenerator.generateRoadmapAndDiffs(
        "Remove the calculator from the repository and enhance the dashboard UI.",
        { intent: "DELETE_FOLDER", taskType: "DELETE_FOLDER" },
        { fileContext: { "app/page.tsx": pageContent } },
        "system prompt",
        contract,
        manifest,
        authoritativeSources,
      );

      const scopeCheck = enforceExecutionScope({
        proposedChanges: result.changes,
        manifest,
        contract,
        existingFilePaths: existingFiles,
      });

      expect(scopeCheck.valid).toBe(true);
      expect(scopeCheck.errors.length).toBe(0);
    } finally {
      utils.getOpenAI = originalGetOpenAI;
    }
  });

  test("Part M (Regression 3): Model incorrectly returning DELETE for manifest MODIFY is NOT coerced and is rejected by ExecutionScopeEnforcer", () => {
    const manifest: FileManifest = {
      manifestVersion: "1.0.0",
      totalFiles: 3,
      files: [
        { path: "app/components/Calculator.tsx", action: "delete", description: "Delete calculator", dependencies: [] },
        { path: "app/styles/calculator.css", action: "delete", description: "Delete calculator styles", dependencies: [] },
        { path: "app/page.tsx", action: "modify", description: "Update page", dependencies: [] },
      ],
    };

    const changes = [
      { path: "app/components/Calculator.tsx", action: "delete" as const, isDeleted: true, content: "", description: "Delete" },
      { path: "app/styles/calculator.css", action: "delete" as const, isDeleted: true, content: "", description: "Delete" },
      { path: "app/page.tsx", action: "delete" as const, isDeleted: true, content: "", description: "Delete page" },
    ];

    const scopeCheck = enforceExecutionScope({
      proposedChanges: changes,
      manifest,
      existingFilePaths: existingFiles,
    });

    expect(scopeCheck.valid).toBe(false);
    expect(scopeCheck.errors.some((e) => e.path === "app/page.tsx" && e.reason === "ACTION_MISMATCH")).toBe(true);
  });

  test("Part N (Regression 4): Pure remove prompt with cleanup modify preserves MODIFY for page.tsx", async () => {
    const manifest: FileManifest = {
      manifestVersion: "1.0.0",
      totalFiles: 2,
      files: [
        { path: "app/components/Calculator.tsx", action: "delete", description: "Delete calculator", dependencies: [] },
        { path: "app/page.tsx", action: "modify", description: "Clean up calculator import", dependencies: [] },
      ],
    };

    const contract: ExecutionContract = {
      goal: "Remove the calculator",
      taskType: "DELETE_FOLDER",
      risk: "LOW",
      estimatedComplexity: "SMALL",
      pipeline: "REPOSITORY",
      environment: "REACT_TS",
      repositoryRequired: true,
      expectedFiles: ["app/components/Calculator.tsx", "app/page.tsx"],
      validationType: "TYPESCRIPT_BUILD",
      targetPaths: ["app/components/Calculator.tsx", "app/page.tsx"],
      allowedActions: ["delete_folder", "delete_file", "modify_file"],
      forbiddenActions: ["rename"],
      maxFiles: 10,
      searchScope: ["app/components/Calculator.tsx", "app/page.tsx"],
      contextScope: ["app/components/Calculator.tsx", "app/page.tsx"],
      diffCriticEnabled: true,
    };

    const pageContent = 'import Calculator from "./components/Calculator";\nexport default function Page() { return <div><Calculator /></div>; }';
    const authoritativeSources = {
      "app/page.tsx": {
        path: "app/page.tsx",
        content: pageContent,
        sha256: "dummy-sha",
      },
    };

    const utils = require("../shared/utils");
    const originalGetOpenAI = utils.getOpenAI;

    utils.getOpenAI = () => ({
      chat: {
        completions: {
          create: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    explanation: "Removed calculator and cleaned imports",
                    changes: [
                      { path: "app/components/Calculator.tsx", action: "delete", isDeleted: true, content: "", description: "Delete Calculator" },
                      {
                        path: "app/page.tsx",
                        action: "modify",
                        description: "Remove calculator import",
                        edits: [
                          {
                            oldText: 'import Calculator from "./components/Calculator";\nexport default function Page() { return <div><Calculator /></div>; }',
                            newText: "export default function Page() { return <div>Empty</div>; }",
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
    });

    try {
      const result = await CodeGenerator.generateRoadmapAndDiffs(
        "Remove the calculator.",
        { intent: "DELETE_FOLDER", taskType: "DELETE_FOLDER" },
        { fileContext: { "app/page.tsx": pageContent } },
        "system prompt",
        contract,
        manifest,
        authoritativeSources,
      );

      const pageChange = result.changes.find((c) => c.path === "app/page.tsx");
      expect(pageChange?.action).toBe("modify");
      expect(pageChange?.content).toBe("export default function Page() { return <div>Empty</div>; }");
    } finally {
      utils.getOpenAI = originalGetOpenAI;
    }
  });

  test("Part O (Regression 5): Pure delete manifest works without regression", async () => {
    const manifest: FileManifest = {
      manifestVersion: "1.0.0",
      totalFiles: 2,
      files: [
        { path: "app/components/Calculator.tsx", action: "delete", description: "Delete", dependencies: [] },
        { path: "app/styles/calculator.css", action: "delete", description: "Delete", dependencies: [] },
      ],
    };

    const contract: ExecutionContract = {
      goal: "Delete files",
      taskType: "DELETE_FOLDER",
      risk: "LOW",
      estimatedComplexity: "SMALL",
      pipeline: "REPOSITORY",
      environment: "REACT_TS",
      repositoryRequired: true,
      expectedFiles: ["app/components/Calculator.tsx", "app/styles/calculator.css"],
      validationType: "TYPESCRIPT_BUILD",
      targetPaths: ["app/components/Calculator.tsx", "app/styles/calculator.css"],
      allowedActions: ["delete_folder", "delete_file"],
      forbiddenActions: ["rename"],
      maxFiles: 5,
      searchScope: ["app/components/Calculator.tsx", "app/styles/calculator.css"],
      contextScope: ["app/components/Calculator.tsx", "app/styles/calculator.css"],
      diffCriticEnabled: true,
    };

    const utils = require("../shared/utils");
    const originalGetOpenAI = utils.getOpenAI;

    utils.getOpenAI = () => ({
      chat: {
        completions: {
          create: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    explanation: "Deleted files",
                    changes: [
                      { path: "app/components/Calculator.tsx", action: "delete", isDeleted: true, content: "", description: "Delete" },
                      { path: "app/styles/calculator.css", action: "delete", isDeleted: true, content: "", description: "Delete" },
                    ],
                  }),
                },
              },
            ],
          }),
        },
      },
    });

    try {
      const result = await CodeGenerator.generateRoadmapAndDiffs(
        "Remove calculator files",
        { intent: "DELETE_FOLDER", taskType: "DELETE_FOLDER" },
        { fileContext: {} },
        "system prompt",
        contract,
        manifest,
      );

      expect(result.changes.length).toBe(2);
      expect(result.changes.every((c) => c.action === "delete")).toBe(true);
    } finally {
      utils.getOpenAI = originalGetOpenAI;
    }
  });

  test("Part P (Regression 6): Triple mixed manifest (CREATE + MODIFY + DELETE) preserves all distinct actions", async () => {
    const manifest: FileManifest = {
      manifestVersion: "1.0.0",
      totalFiles: 3,
      files: [
        { path: "app/components/Dashboard.tsx", action: "create", description: "Create dashboard", dependencies: [] },
        { path: "app/page.tsx", action: "modify", description: "Update page", dependencies: [] },
        { path: "app/components/Calculator.tsx", action: "delete", description: "Delete calculator", dependencies: [] },
      ],
    };

    const contract: ExecutionContract = {
      goal: "Refactor to dashboard",
      taskType: "DELETE_FOLDER",
      risk: "MEDIUM",
      estimatedComplexity: "MEDIUM",
      pipeline: "REPOSITORY",
      environment: "REACT_TS",
      repositoryRequired: true,
      expectedFiles: ["app/components/Dashboard.tsx", "app/page.tsx", "app/components/Calculator.tsx"],
      validationType: "TYPESCRIPT_BUILD",
      targetPaths: ["app/components/Dashboard.tsx", "app/page.tsx", "app/components/Calculator.tsx"],
      allowedActions: ["create_components", "modify_file", "delete_file"],
      forbiddenActions: ["rename"],
      maxFiles: 10,
      searchScope: ["app/components/Dashboard.tsx", "app/page.tsx", "app/components/Calculator.tsx"],
      contextScope: ["app/components/Dashboard.tsx", "app/page.tsx", "app/components/Calculator.tsx"],
      diffCriticEnabled: true,
    };

    const pageContent = 'export default function Page() { return <div>Old</div>; }';
    const authoritativeSources = {
      "app/page.tsx": {
        path: "app/page.tsx",
        content: pageContent,
        sha256: "dummy-sha",
      },
    };

    const utils = require("../shared/utils");
    const originalGetOpenAI = utils.getOpenAI;

    utils.getOpenAI = () => ({
      chat: {
        completions: {
          create: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    explanation: "Mixed changes",
                    changes: [
                      { path: "app/components/Dashboard.tsx", action: "create", content: "export function Dashboard() { return <div>Dashboard</div>; }", description: "Create Dashboard" },
                      {
                        path: "app/page.tsx",
                        action: "modify",
                        description: "Update page",
                        edits: [
                          {
                            oldText: "export default function Page() { return <div>Old</div>; }",
                            newText: 'import { Dashboard } from "./components/Dashboard";\nexport default function Page() { return <Dashboard />; }',
                          },
                        ],
                      },
                      { path: "app/components/Calculator.tsx", action: "delete", isDeleted: true, content: "", description: "Delete Calculator" },
                    ],
                  }),
                },
              },
            ],
          }),
        },
      },
    });

    try {
      const result = await CodeGenerator.generateRoadmapAndDiffs(
        "Remove calculator and create dashboard",
        { intent: "DELETE_FOLDER", taskType: "DELETE_FOLDER" },
        { fileContext: { "app/page.tsx": pageContent } },
        "system prompt",
        contract,
        manifest,
        authoritativeSources,
      );

      const createChange = result.changes.find((c) => c.path === "app/components/Dashboard.tsx");
      const modifyChange = result.changes.find((c) => c.path === "app/page.tsx");
      const deleteChange = result.changes.find((c) => c.path === "app/components/Calculator.tsx");

      expect(createChange?.action).toBe("create");
      expect(modifyChange?.action).toBe("modify");
      expect(deleteChange?.action).toBe("delete");

      const scopeCheck = enforceExecutionScope({
        proposedChanges: result.changes,
        manifest,
        contract,
        existingFilePaths: ["app/page.tsx", "app/components/Calculator.tsx"],
      });
      expect(scopeCheck.valid).toBe(true);
    } finally {
      utils.getOpenAI = originalGetOpenAI;
    }
  });
});
