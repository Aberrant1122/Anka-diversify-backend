import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { CodeGenerator } from "../generation/CodeGenerator";
import { PatchCorrectionEngine } from "../generation/PatchCorrectionEngine";
import { SelfHealingEngine } from "../repair/SelfHealingEngine";
import { FileSystemStateManager } from "../validation/FileSystemStateManager";
import { ValidationRunner } from "../validation/ValidationRunner";
import { GeneratedChangeProposal, resolveGenerationProposals, validateGenerationProposals } from "../generation/GenerationProposalResolver";
import { FileManifest, ExecutionContract } from "../../types";
import * as sharedUtils from "../shared/utils";

jest.mock("../shared/utils", () => {
  const original = jest.requireActual("../shared/utils");
  return {
    ...original,
    getOpenAI: jest.fn(),
  };
});

function makeAuthSource(p: string, content: string) {
  const sha256 = crypto.createHash("sha256").update(content).digest("hex");
  return { path: p, content, sha256 };
}

describe("Cluster D — Structured Patch Correction & Causal Self-Healing Progress", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "anka-cluster-d-test-"));
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // PART A, B, C: Bounded Multi-Proposal Correction
  // ─────────────────────────────────────────────────────────────────────────────

  test("1 & 2: Two independent malformed MODIFY proposals both receive bounded correction, while valid third proposal remains unchanged", async () => {
    const serviceContent = "export class UserService {\n  findUser(id: string) { return null; }\n}\n";
    const controllerContent = "export class UserController {\n  getUser(req: any) { return null; }\n}\n";
    const routesContent = "export const router = {\n  get: (path: string) => {}\n};\n";

    const authoritativeModifySources = {
      "src/services/user.service.ts": makeAuthSource("src/services/user.service.ts", serviceContent),
      "src/controllers/user.controller.ts": makeAuthSource("src/controllers/user.controller.ts", controllerContent),
      "src/routes/user.routes.ts": makeAuthSource("src/routes/user.routes.ts", routesContent),
    };

    const manifest: FileManifest = {
      files: [
        { path: "src/services/user.service.ts", action: "modify", dependencies: [], description: "service" },
        { path: "src/controllers/user.controller.ts", action: "modify", dependencies: [], description: "controller" },
        { path: "src/routes/user.routes.ts", action: "modify", dependencies: [], description: "routes" },
      ],
      totalFiles: 3,
      manifestVersion: "1.0.0",
    };

    const contract: ExecutionContract = {
      goal: "Repair user endpoints",
      taskType: "BUG_FIX",
      risk: "LOW",
      estimatedComplexity: "MEDIUM",
      pipeline: "REPOSITORY",
      environment: "NODE_JS",
      repositoryRequired: true,
      expectedFiles: [
        "src/services/user.service.ts",
        "src/controllers/user.controller.ts",
        "src/routes/user.routes.ts",
      ],
      validationType: "TYPESCRIPT_BUILD",
      targetPaths: [
        "src/services/user.service.ts",
        "src/controllers/user.controller.ts",
        "src/routes/user.routes.ts",
      ],
      allowedActions: ["modify"],
      forbiddenActions: [],
      maxFiles: 5,
      searchScope: ["src"],
      contextScope: ["src"],
      diffCriticEnabled: true,
    };

    // Proposal 0: malformed (empty edits)
    // Proposal 1: malformed (empty edits)
    // Proposal 2: valid exact edits
    const initialProposals: GeneratedChangeProposal[] = [
      {
        path: "src/services/user.service.ts",
        action: "modify",
        edits: [] as any,
        description: "service change with missing edits",
      },
      {
        path: "src/controllers/user.controller.ts",
        action: "modify",
        edits: [] as any,
        description: "controller change with missing edits",
      },
      {
        path: "src/routes/user.routes.ts",
        action: "modify",
        edits: [
          {
            oldText: "  get: (path: string) => {}\n",
            newText: "  get: (path: string) => {},\n  post: (path: string) => {}\n",
          },
        ],
        description: "routes change with valid exact edits",
      },
    ];

    const mockOpenAI = {
      chat: {
        completions: {
          create: jest.fn().mockResolvedValue({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    roadmap: "Update service, controller, and routes",
                    changes: initialProposals,
                  }),
                },
              },
            ],
          }),
        },
      },
    };
    (sharedUtils.getOpenAI as jest.Mock).mockReturnValue(mockOpenAI);

    // Mock PatchCorrectionEngine.correctPatch for each malformed proposal
    const correctPatchSpy = jest.spyOn(PatchCorrectionEngine, "correctPatch");
    correctPatchSpy
      .mockResolvedValueOnce({
        attempted: true,
        succeeded: true,
        correctedEdits: [
          {
            oldText: "findUser(id: string) { return null; }",
            newText: "findUser(id: string) { return { id, name: 'Repaired' }; }",
          },
        ],
      })
      .mockResolvedValueOnce({
        attempted: true,
        succeeded: true,
        correctedEdits: [
          {
            oldText: "getUser(req: any) { return null; }",
            newText: "getUser(req: any) { return { ok: true }; }",
          },
        ],
      });

    const result = await CodeGenerator.generateRoadmapAndDiffs(
      "Fix user endpoints",
      { targetPath: "src/routes/user.routes.ts", intent: "repair" },
      {
        fileContext: {
          "src/services/user.service.ts": serviceContent,
          "src/controllers/user.controller.ts": controllerContent,
          "src/routes/user.routes.ts": routesContent,
        },
      },
      "System prompt",
      contract,
      manifest,
      authoritativeModifySources,
    );

    // 1: Both malformed proposals received correction
    expect(correctPatchSpy).toHaveBeenCalledTimes(2);
    expect(correctPatchSpy).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        filePath: "src/services/user.service.ts",
        errorCode: "MODIFY_PATCH_REQUIRED",
      }),
    );
    expect(correctPatchSpy).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        filePath: "src/controllers/user.controller.ts",
        errorCode: "MODIFY_PATCH_REQUIRED",
      }),
    );

    // 2: Valid third proposal (routes) remained completely unchanged and all 3 changes resolved
    expect(result.changes).toHaveLength(3);
    const serviceChange = result.changes.find((c) => c.path === "src/services/user.service.ts");
    const controllerChange = result.changes.find((c) => c.path === "src/controllers/user.controller.ts");
    const routesChange = result.changes.find((c) => c.path === "src/routes/user.routes.ts");

    expect(serviceChange?.content).toContain("name: 'Repaired'");
    expect(controllerChange?.content).toContain("ok: true");
    expect(routesChange?.content).toContain("post: (path: string) => {}");
  });

  test("3: Correction budget cannot exceed configured cap (fails closed if > 3 malformed proposals)", async () => {
    const fileContext: Record<string, string> = {
      "src/f1.ts": "content 1",
      "src/f2.ts": "content 2",
      "src/f3.ts": "content 3",
      "src/f4.ts": "content 4",
    };

    const manifest: FileManifest = {
      files: [
        { path: "src/f1.ts", action: "modify", dependencies: [], description: "f1" },
        { path: "src/f2.ts", action: "modify", dependencies: [], description: "f2" },
        { path: "src/f3.ts", action: "modify", dependencies: [], description: "f3" },
        { path: "src/f4.ts", action: "modify", dependencies: [], description: "f4" },
      ],
      totalFiles: 4,
      manifestVersion: "1.0.0",
    };

    const contract: ExecutionContract = {
      goal: "Batch repair",
      taskType: "BUG_FIX",
      risk: "LOW",
      estimatedComplexity: "MEDIUM",
      pipeline: "REPOSITORY",
      environment: "NODE_JS",
      repositoryRequired: true,
      expectedFiles: ["src/f1.ts", "src/f2.ts", "src/f3.ts", "src/f4.ts"],
      validationType: "TYPESCRIPT_BUILD",
      targetPaths: ["src/f1.ts", "src/f2.ts", "src/f3.ts", "src/f4.ts"],
      allowedActions: ["modify"],
      forbiddenActions: [],
      maxFiles: 5,
      searchScope: ["src"],
      contextScope: ["src"],
      diffCriticEnabled: true,
    };

    // 4 malformed proposals
    const proposals: GeneratedChangeProposal[] = [
      { path: "src/f1.ts", action: "modify", edits: [], description: "bad 1" },
      { path: "src/f2.ts", action: "modify", edits: [], description: "bad 2" },
      { path: "src/f3.ts", action: "modify", edits: [], description: "bad 3" },
      { path: "src/f4.ts", action: "modify", edits: [], description: "bad 4" },
    ];

    const mockOpenAI = {
      chat: {
        completions: {
          create: jest.fn().mockResolvedValue({
            choices: [{ message: { content: JSON.stringify({ changes: proposals }) } }],
          }),
        },
      },
    };
    (sharedUtils.getOpenAI as jest.Mock).mockReturnValue(mockOpenAI);

    const correctPatchSpy = jest.spyOn(PatchCorrectionEngine, "correctPatch");

    await expect(
      CodeGenerator.generateRoadmapAndDiffs(
        "Batch repair",
        { targetPath: "src/f1.ts", intent: "repair" },
        { fileContext },
        "System prompt",
        contract,
        manifest,
        {
          "src/f1.ts": makeAuthSource("src/f1.ts", "content 1"),
          "src/f2.ts": makeAuthSource("src/f2.ts", "content 2"),
          "src/f3.ts": makeAuthSource("src/f3.ts", "content 3"),
          "src/f4.ts": makeAuthSource("src/f4.ts", "content 4"),
        },
      ),
    ).rejects.toThrow(/Bounded correction cap exceeded/);

    // CorrectPatch was never called because cap check aborted before unbounded attempts
    expect(correctPatchSpy).not.toHaveBeenCalled();
  });

  test("4: Failed correction still fails closed", async () => {
    const fileContent = "export const val = 1;\n";
    const manifest: FileManifest = {
      files: [{ path: "src/val.ts", action: "modify", dependencies: [], description: "val" }],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    };

    const contract: ExecutionContract = {
      goal: "Update val",
      taskType: "BUG_FIX",
      risk: "LOW",
      estimatedComplexity: "SMALL",
      pipeline: "REPOSITORY",
      environment: "NODE_JS",
      repositoryRequired: true,
      expectedFiles: ["src/val.ts"],
      validationType: "TYPESCRIPT_BUILD",
      targetPaths: ["src/val.ts"],
      allowedActions: ["modify"],
      forbiddenActions: [],
      maxFiles: 1,
      searchScope: ["src"],
      contextScope: ["src"],
      diffCriticEnabled: true,
    };

    const proposals: GeneratedChangeProposal[] = [
      { path: "src/val.ts", action: "modify", edits: [], description: "empty edits" },
    ];

    const mockOpenAI = {
      chat: {
        completions: {
          create: jest.fn().mockResolvedValue({
            choices: [{ message: { content: JSON.stringify({ changes: proposals }) } }],
          }),
        },
      },
    };
    (sharedUtils.getOpenAI as jest.Mock).mockReturnValue(mockOpenAI);

    // Mock correction failure
    jest.spyOn(PatchCorrectionEngine, "correctPatch").mockResolvedValueOnce({
      attempted: true,
      succeeded: false,
      error: "LLM refused to generate edits",
    });

    await expect(
      CodeGenerator.generateRoadmapAndDiffs(
        "Update val",
        { targetPath: "src/val.ts", intent: "repair" },
        { fileContext: { "src/val.ts": fileContent } },
        "System prompt",
        contract,
        manifest,
        { "src/val.ts": makeAuthSource("src/val.ts", fileContent) },
      ),
    ).rejects.toThrow(/\[PATCH_RESOLUTION_FAILED\]/);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // PART E, F, J, K: Causal Self-Healing & TS6133 Repair
  // ─────────────────────────────────────────────────────────────────────────────

  test("5: Post-delete TS6133 unused declaration is repaired (Repo 4 failure reproducer)", async () => {
    const dashboardPath = path.join(tempDir, "src/components/DashboardOverview.tsx");
    fs.mkdirSync(path.dirname(dashboardPath), { recursive: true });

    // Live file on disk after agent deleted the widget and its JSX reference:
    // Notice filteredActivities is declared but never read!
    const dashboardContent = `import React from 'react';

export const DashboardOverview: React.FC = () => {
  const filteredActivities = [{ id: 1, name: 'Active' }];

  return (
    <div className="dashboard">
      <h1>Overview</h1>
    </div>
  );
};
`;
    fs.writeFileSync(dashboardPath, dashboardContent);

    const ts6133Error = "src/components/DashboardOverview.tsx:4:9 - error TS6133: 'filteredActivities' is declared but its value is never read.";

    // Validation sequence:
    // Cycle 1: Build fails with TS6133
    // Cycle 2: Build succeeds after repair
    jest.spyOn(ValidationRunner, "validateWithShell")
      .mockResolvedValueOnce({ success: false, errors: ts6133Error })
      .mockResolvedValueOnce({ success: true, errors: "" });

    const manifest: FileManifest = {
      files: [
        { path: "src/components/DashboardOverview.tsx", action: "modify", dependencies: [], description: "dashboard" },
        { path: "src/components/LegacyActivityWidget.tsx", action: "delete", dependencies: [], description: "deleted widget" },
      ],
      totalFiles: 2,
      manifestVersion: "1.0.0",
    };

    const contract: ExecutionContract = {
      goal: "Remove the deprecated activity widget and clean every reference to it.",
      taskType: "REFACTOR",
      risk: "LOW",
      estimatedComplexity: "SMALL",
      pipeline: "REPOSITORY",
      environment: "REACT_TS",
      repositoryRequired: true,
      expectedFiles: ["src/components/DashboardOverview.tsx", "src/components/LegacyActivityWidget.tsx"],
      validationType: "TYPESCRIPT_BUILD",
      targetPaths: ["src/components/DashboardOverview.tsx", "src/components/LegacyActivityWidget.tsx"],
      allowedActions: ["modify", "delete"],
      forbiddenActions: [],
      maxFiles: 2,
      searchScope: ["src"],
      contextScope: ["src"],
      diffCriticEnabled: true,
    };

    // Model proposes removing the unused declaration
    const repairProposals = [
      {
        path: "src/components/DashboardOverview.tsx",
        action: "modify",
        edits: [
          {
            oldText: "  const filteredActivities = [{ id: 1, name: 'Active' }];\n\n",
            newText: "",
          },
        ],
        description: "Remove unused filteredActivities declaration",
      },
    ];

    const mockOpenAI = {
      chat: {
        completions: {
          create: jest.fn().mockResolvedValue({
            choices: [{ message: { content: JSON.stringify({ changes: repairProposals }) } }],
          }),
        },
      },
    };
    (sharedUtils.getOpenAI as jest.Mock).mockReturnValue(mockOpenAI);

    const result = await SelfHealingEngine.runSelfHealingLoop(
      [{ path: "src/components/DashboardOverview.tsx", action: "modify", content: dashboardContent, description: "initial" }],
      tempDir,
      ["npm run build"],
      "system prompt",
      "Remove the deprecated activity widget",
      new FileSystemStateManager(),
      "repo4",
      undefined,
      manifest,
      contract,
    );

    expect(result.success).toBe(true);
    expect(result.repaired).toBe(true);
    const finalFile = result.finalChanges.find((c) => c.path === "src/components/DashboardOverview.tsx");
    expect(finalFile?.content).not.toContain("filteredActivities");
  });

  test("6: Post-delete unused import is repaired", async () => {
    const compPath = path.join(tempDir, "src/components/App.tsx");
    fs.mkdirSync(path.dirname(compPath), { recursive: true });

    const initialContent = `import React from 'react';
import { LegacyWidget } from './LegacyWidget';

export const App = () => <div>App</div>;
`;
    fs.writeFileSync(compPath, initialContent);

    const ts6133ImportError = "src/components/App.tsx:2:10 - error TS6133: 'LegacyWidget' is declared but its value is never read.";

    jest.spyOn(ValidationRunner, "validateWithShell")
      .mockResolvedValueOnce({ success: false, errors: ts6133ImportError })
      .mockResolvedValueOnce({ success: true, errors: "" });

    const manifest: FileManifest = {
      files: [{ path: "src/components/App.tsx", action: "modify", dependencies: [], description: "App" }],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    };

    const contract: ExecutionContract = {
      goal: "Clean unused imports",
      taskType: "REFACTOR",
      risk: "LOW",
      estimatedComplexity: "SMALL",
      pipeline: "REPOSITORY",
      environment: "REACT_TS",
      repositoryRequired: true,
      expectedFiles: ["src/components/App.tsx"],
      validationType: "TYPESCRIPT_BUILD",
      targetPaths: ["src/components/App.tsx"],
      allowedActions: ["modify"],
      forbiddenActions: [],
      maxFiles: 1,
      searchScope: ["src"],
      contextScope: ["src"],
      diffCriticEnabled: true,
    };

    const repairProposals = [
      {
        path: "src/components/App.tsx",
        action: "modify",
        edits: [
          {
            oldText: "import { LegacyWidget } from './LegacyWidget';\n",
            newText: "",
          },
        ],
        description: "Remove unused LegacyWidget import",
      },
    ];

    const mockOpenAI = {
      chat: {
        completions: {
          create: jest.fn().mockResolvedValue({
            choices: [{ message: { content: JSON.stringify({ changes: repairProposals }) } }],
          }),
        },
      },
    };
    (sharedUtils.getOpenAI as jest.Mock).mockReturnValue(mockOpenAI);

    const result = await SelfHealingEngine.runSelfHealingLoop(
      [{ path: "src/components/App.tsx", action: "modify", content: initialContent, description: "initial" }],
      tempDir,
      ["npm run build"],
      "system prompt",
      "Clean unused imports",
      new FileSystemStateManager(),
      "test-app",
      undefined,
      manifest,
      contract,
    );

    expect(result.success).toBe(true);
    expect(result.repaired).toBe(true);
    const finalFile = result.finalChanges.find((c) => c.path === "src/components/App.tsx");
    expect(finalFile?.content).not.toContain("LegacyWidget");
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // PART G, H, I: Deterministic Progress & Repeated Proposal Detection
  // ─────────────────────────────────────────────────────────────────────────────

  test("7 & 8: Identical ineffective repair proposal is detected and bounded alternative repair runs once with feedback", async () => {
    const compPath = path.join(tempDir, "src/components/Widget.tsx");
    fs.mkdirSync(path.dirname(compPath), { recursive: true });

    const initialContent = `export const Widget = () => {
  const value: number = "bad";
  return <div>Widget</div>;
};
`;
    fs.writeFileSync(compPath, initialContent);

    const typeError = "src/components/Widget.tsx:2:9 - error TS2322: Type 'string' is not assignable to type 'number'.";

    // Validation sequence:
    // Initial: fails with TS2322
    // Attempt 1: patch applied (ineffective comment edit), validation fails with TS2322
    // Attempt 2: alternative repair applied (actual fix), validation passes
    jest.spyOn(ValidationRunner, "validateWithShell")
      .mockResolvedValueOnce({ success: false, errors: typeError })
      .mockResolvedValueOnce({ success: false, errors: typeError })
      .mockResolvedValueOnce({ success: true, errors: "" });

    const manifest: FileManifest = {
      files: [{ path: "src/components/Widget.tsx", action: "modify", dependencies: [], description: "Widget" }],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    };

    const contract: ExecutionContract = {
      goal: "Fix widget",
      taskType: "BUG_FIX",
      risk: "LOW",
      estimatedComplexity: "SMALL",
      pipeline: "REPOSITORY",
      environment: "REACT_TS",
      repositoryRequired: true,
      expectedFiles: ["src/components/Widget.tsx"],
      validationType: "TYPESCRIPT_BUILD",
      targetPaths: ["src/components/Widget.tsx"],
      allowedActions: ["modify"],
      forbiddenActions: [],
      maxFiles: 1,
      searchScope: ["src"],
      contextScope: ["src"],
      diffCriticEnabled: true,
    };

    // First attempt proposes an ineffective whitespace/comment change
    const ineffectiveProposal = [
      {
        path: "src/components/Widget.tsx",
        action: "modify",
        edits: [{ oldText: 'const value: number = "bad";', newText: 'const value: number = "bad"; // still bad' }],
        description: "Ineffective edit",
      },
    ];

    // Second attempt (alternative repair after receiving feedback) removes the declaration
    const effectiveProposal = [
      {
        path: "src/components/Widget.tsx",
        action: "modify",
        edits: [{ oldText: '  const value: number = "bad"; // still bad\n', newText: "  const value: number = 42;\n" }],
        description: "Fix type mismatch",
      },
    ];

    const mockOpenAI = {
      chat: {
        completions: {
          create: jest
            .fn()
            .mockResolvedValueOnce({
              choices: [{ message: { content: JSON.stringify({ changes: ineffectiveProposal }) } }],
            })
            .mockResolvedValueOnce({
              choices: [{ message: { content: JSON.stringify({ changes: effectiveProposal }) } }],
            }),
        },
      },
    };
    (sharedUtils.getOpenAI as jest.Mock).mockReturnValue(mockOpenAI);

    const result = await SelfHealingEngine.runSelfHealingLoop(
      [{ path: "src/components/Widget.tsx", action: "modify", content: initialContent, description: "initial" }],
      tempDir,
      ["npm run build"],
      "system prompt",
      "Fix widget",
      new FileSystemStateManager(),
      "test-widget",
      undefined,
      manifest,
      contract,
    );

    expect(result.success).toBe(true);
    expect(result.repaired).toBe(true);
    expect(mockOpenAI.chat.completions.create).toHaveBeenCalledTimes(2);

    // Verify that the second call received previous ineffective repair feedback
    const secondCallPrompt = mockOpenAI.chat.completions.create.mock.calls[1][0].messages[1].content;
    expect(secondCallPrompt).toContain("PREVIOUS INEFFECTIVE REPAIR FEEDBACK:");
  });

  test("9: Same diagnostic persisting after alternative repair halts safely with NO_REPAIR_PROGRESS (no 8 retries)", async () => {
    const compPath = path.join(tempDir, "src/components/Stub.tsx");
    fs.mkdirSync(path.dirname(compPath), { recursive: true });

    const initialContent = "export const Stub = 1;\n";
    fs.writeFileSync(compPath, initialContent);

    const stubbornError = "src/components/Stub.tsx:1:14 - error TS2322: Type 'number' is not assignable to type 'string'.";

    // Build keeps failing with identical error
    jest.spyOn(ValidationRunner, "validateWithShell").mockResolvedValue({
      success: false,
      errors: stubbornError,
    });

    const manifest: FileManifest = {
      files: [{ path: "src/components/Stub.tsx", action: "modify", dependencies: [], description: "Stub" }],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    };

    const contract: ExecutionContract = {
      goal: "Fix stub",
      taskType: "BUG_FIX",
      risk: "LOW",
      estimatedComplexity: "SMALL",
      pipeline: "REPOSITORY",
      environment: "REACT_TS",
      repositoryRequired: true,
      expectedFiles: ["src/components/Stub.tsx"],
      validationType: "TYPESCRIPT_BUILD",
      targetPaths: ["src/components/Stub.tsx"],
      allowedActions: ["modify"],
      forbiddenActions: [],
      maxFiles: 1,
      searchScope: ["src"],
      contextScope: ["src"],
      diffCriticEnabled: true,
    };

    // Repair attempts keep making no progress
    const mockOpenAI = {
      chat: {
        completions: {
          create: jest.fn().mockImplementation(() => {
            return Promise.resolve({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      changes: [
                        {
                          path: "src/components/Stub.tsx",
                          action: "modify",
                          edits: [{ oldText: "1;", newText: `1; // comment ${Date.now()}` }],
                          description: "Ineffective attempt",
                        },
                      ],
                    }),
                  },
                },
              ],
            });
          }),
        },
      },
    };
    (sharedUtils.getOpenAI as jest.Mock).mockReturnValue(mockOpenAI);

    const result = await SelfHealingEngine.runSelfHealingLoop(
      [{ path: "src/components/Stub.tsx", action: "modify", content: initialContent, description: "initial" }],
      tempDir,
      ["npm run build"],
      "system prompt",
      "Fix stub",
      new FileSystemStateManager(),
      "test-stub",
      undefined,
      manifest,
      contract,
    );

    expect(result.success).toBe(false);
    expect(result.errorType).toBe("NO_REPAIR_PROGRESS");
    // Halts quickly after initial repair + 1 bounded alternative attempt, far below MAX_TOTAL_REPAIR_CYCLES (8)
    expect(result.attempts).toBeLessThanOrEqual(3);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // PART L: Baseline Causality & Scope Isolation
  // ─────────────────────────────────────────────────────────────────────────────

  test("10 & 11: Agent-caused diagnostic on authorized file is repairable, while unrelated baseline diagnostic outside scope is NOT repaired", async () => {
    const authorizedPath = path.join(tempDir, "src/components/Authorized.tsx");
    const unrelatedBaselinePath = path.join(tempDir, "src/components/UnrelatedBaseline.tsx");
    fs.mkdirSync(path.dirname(authorizedPath), { recursive: true });

    fs.writeFileSync(authorizedPath, "export const Authorized = 1;\n");
    fs.writeFileSync(unrelatedBaselinePath, "export const Unrelated = 'bad' as number;\n");

    const unrelatedError = "src/components/UnrelatedBaseline.tsx:1:26 - error TS2352: Conversion of type 'string' to type 'number' may be a mistake.";

    jest.spyOn(ValidationRunner, "validateWithShell").mockResolvedValue({
      success: false,
      errors: unrelatedError,
    });

    const manifest: FileManifest = {
      files: [{ path: "src/components/Authorized.tsx", action: "modify", dependencies: [], description: "Authorized" }],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    };

    const contract: ExecutionContract = {
      goal: "Modify authorized component",
      taskType: "BUG_FIX",
      risk: "LOW",
      estimatedComplexity: "SMALL",
      pipeline: "REPOSITORY",
      environment: "REACT_TS",
      repositoryRequired: true,
      expectedFiles: ["src/components/Authorized.tsx"],
      validationType: "TYPESCRIPT_BUILD",
      targetPaths: ["src/components/Authorized.tsx"],
      allowedActions: ["modify"],
      forbiddenActions: [],
      maxFiles: 1,
      searchScope: ["src"],
      contextScope: ["src"],
      diffCriticEnabled: true,
    };

    const mockOpenAI = {
      chat: {
        completions: {
          create: jest.fn(),
        },
      },
    };
    (sharedUtils.getOpenAI as jest.Mock).mockReturnValue(mockOpenAI);

    const result = await SelfHealingEngine.runSelfHealingLoop(
      [{ path: "src/components/Authorized.tsx", action: "modify", content: "export const Authorized = 2;\n", description: "initial" }],
      tempDir,
      ["npm run build"],
      "system prompt",
      "Modify authorized component",
      new FileSystemStateManager(),
      "test-scope",
      undefined,
      manifest,
      contract,
    );

    // Fails closed as BASELINE_REPOSITORY_UNHEALTHY without touching UnrelatedBaseline.tsx
    expect(result.success).toBe(false);
    expect(result.errorType).toBe("BASELINE_REPOSITORY_UNHEALTHY");
    // Model repair was never called on the unrelated file
    expect(mockOpenAI.chat.completions.create).not.toHaveBeenCalled();
    // Unrelated baseline content was untouched
    expect(fs.readFileSync(unrelatedBaselinePath, "utf8")).toBe("export const Unrelated = 'bad' as number;\n");
  });

  test("12: Authorized diagnostic alongside unauthorized diagnostic: SelfHealing repairs authorized file first without failing as BASELINE_REPOSITORY_UNHEALTHY", async () => {
    const authorizedPath = path.join(tempDir, "src/components/dashboard/DashboardOverview.tsx");
    const unauthorizedPath = path.join(tempDir, "src/App.tsx");
    fs.mkdirSync(path.dirname(authorizedPath), { recursive: true });

    const initialAuthorizedContent = `import React from 'react';\nexport function DashboardOverview() {\n  const x: number = "bad";\n  return <div>Dashboard</div>;\n}\n`;
    fs.writeFileSync(authorizedPath, initialAuthorizedContent);
    fs.writeFileSync(unauthorizedPath, `export function App() { return <div>App</div>; }\n`);

    const mixedErrors = `
npm run build failed:
src/components/dashboard/DashboardOverview.tsx(3,9): error TS2322: Type 'string' is not assignable to type 'number'.
src/App.tsx:1:40 - error TS2322: Type 'string' is not assignable to type 'number'.
`;

    let validationCallCount = 0;
    jest.spyOn(ValidationRunner, "validateWithShell").mockImplementation(async () => {
      validationCallCount++;
      if (validationCallCount === 1) {
        return { success: false, errors: mixedErrors };
      }
      return { success: true, errors: "" };
    });

    const manifest: FileManifest = {
      files: [{ path: "src/components/dashboard/DashboardOverview.tsx", action: "modify", dependencies: [], description: "Dashboard" }],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    };

    const contract: ExecutionContract = {
      goal: "Clean up unused activity widget",
      taskType: "REFACTOR",
      risk: "LOW",
      estimatedComplexity: "SMALL",
      pipeline: "REPOSITORY",
      environment: "REACT_TS",
      repositoryRequired: true,
      expectedFiles: ["src/components/dashboard/DashboardOverview.tsx"],
      validationType: "TYPESCRIPT_BUILD",
      targetPaths: ["src/components/dashboard/DashboardOverview.tsx"],
      allowedActions: ["modify"],
      forbiddenActions: [],
      maxFiles: 1,
      searchScope: ["src"],
      contextScope: ["src"],
      diffCriticEnabled: true,
    };

    const mockRepairResponse = {
      repaired: true,
      patchExplanation: "Fixed type error in DashboardOverview",
      changes: [
        {
          path: "src/components/dashboard/DashboardOverview.tsx",
          action: "modify",
          description: "Fix type mismatch",
          edits: [
            {
              oldText: '  const x: number = "bad";\n',
              newText: "  const x: number = 42;\n",
            },
          ],
        },
      ],
    };

    const mockOpenAI = {
      chat: {
        completions: {
          create: jest.fn().mockResolvedValue({
            choices: [{ message: { content: JSON.stringify(mockRepairResponse) } }],
          }),
        },
      },
    };
    (sharedUtils.getOpenAI as jest.Mock).mockReturnValue(mockOpenAI);

    const result = await SelfHealingEngine.runSelfHealingLoop(
      [{ path: "src/components/dashboard/DashboardOverview.tsx", action: "modify", content: initialAuthorizedContent, description: "initial" }],
      tempDir,
      ["npm run build"],
      "system prompt",
      "Clean up unused activity widget",
      new FileSystemStateManager(),
      "test-scope",
      undefined,
      manifest,
      contract,
      [], // baselineDiagnostics (clean baseline)
      [],
      undefined,
      true, // baselineBuildPassed
    );

    // Self-healing succeeded by repairing the authorized file
    expect(result.success).toBe(true);
    expect(mockOpenAI.chat.completions.create).toHaveBeenCalled();
    const promptArg = mockOpenAI.chat.completions.create.mock.calls[0][0];
    const userPrompt = promptArg.messages.find((m: any) => m.role === "user").content;
    // Authorized diagnostic is highlighted as target
    expect(userPrompt).toContain("AUTHORIZED STRUCTURED DIAGNOSTICS TO REPAIR");
    expect(userPrompt).toContain("DashboardOverview.tsx");
    // External caller is flagged as read-only causal evidence
    expect(userPrompt).toContain("EXTERNAL CALLER / CONSUMER COMPILER EVIDENCE (READ-ONLY — DO NOT MODIFY THESE FILES)");
    expect(userPrompt).toContain("App.tsx");
  });

  test("13: When baseline is clean and only an unauthorized diagnostic appears: SelfHealing fails closed as UNAUTHORIZED_SCOPE_ERROR without claiming BASELINE_REPOSITORY_UNHEALTHY", async () => {
    const authorizedPath = path.join(tempDir, "src/components/Authorized.tsx");
    const unauthorizedPath = path.join(tempDir, "src/App.tsx");
    fs.mkdirSync(path.dirname(authorizedPath), { recursive: true });

    fs.writeFileSync(authorizedPath, "export const Authorized = 1;\n");
    fs.writeFileSync(unauthorizedPath, "export const App = 1;\n");

    const unauthorizedError = "src/App.tsx:1:14 - error TS2322: Type 'string' is not assignable to type 'number'.";

    jest.spyOn(ValidationRunner, "validateWithShell").mockResolvedValue({
      success: false,
      errors: unauthorizedError,
    });

    const manifest: FileManifest = {
      files: [{ path: "src/components/Authorized.tsx", action: "modify", dependencies: [], description: "Authorized" }],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    };

    const contract: ExecutionContract = {
      goal: "Modify authorized component",
      taskType: "BUG_FIX",
      risk: "LOW",
      estimatedComplexity: "SMALL",
      pipeline: "REPOSITORY",
      environment: "REACT_TS",
      repositoryRequired: true,
      expectedFiles: ["src/components/Authorized.tsx"],
      validationType: "TYPESCRIPT_BUILD",
      targetPaths: ["src/components/Authorized.tsx"],
      allowedActions: ["modify"],
      forbiddenActions: [],
      maxFiles: 1,
      searchScope: ["src"],
      contextScope: ["src"],
      diffCriticEnabled: true,
    };

    const mockOpenAI = {
      chat: {
        completions: {
          create: jest.fn(),
        },
      },
    };
    (sharedUtils.getOpenAI as jest.Mock).mockReturnValue(mockOpenAI);

    const result = await SelfHealingEngine.runSelfHealingLoop(
      [{ path: "src/components/Authorized.tsx", action: "modify", content: "export const Authorized = 2;\n", description: "initial" }],
      tempDir,
      ["npm run build"],
      "system prompt",
      "Modify authorized component",
      new FileSystemStateManager(),
      "test-scope",
      undefined,
      manifest,
      contract,
      [], // baseline had 0 diagnostics (clean baseline)
      [],
      undefined,
      true, // baselineBuildPassed = true
    );

    // Fails closed as UNAUTHORIZED_SCOPE_ERROR, NOT BASELINE_REPOSITORY_UNHEALTHY
    expect(result.success).toBe(false);
    expect(result.errorType).toBe("UNAUTHORIZED_SCOPE_ERROR");
    expect(result.errorType).not.toBe("BASELINE_REPOSITORY_UNHEALTHY");
    expect(mockOpenAI.chat.completions.create).not.toHaveBeenCalled();
  });

  test("14: Unused destructured parameter: interface retains activities, destructuring drops activities -> clean build pass, App.tsx untouched", async () => {
    const authorizedPath = path.join(tempDir, "src/components/dashboard/DashboardOverview.tsx");
    const callerPath = path.join(tempDir, "src/App.tsx");
    fs.mkdirSync(path.dirname(authorizedPath), { recursive: true });

    const baselineAuthorized = `import React from 'react';
import { ActivityItem } from '../../types/activity';
export interface DashboardOverviewProps {
  activities: ActivityItem[];
}
export const DashboardOverview: React.FC<DashboardOverviewProps> = ({ activities }) => {
  return <div>{activities.length}</div>;
};
`;
    fs.writeFileSync(authorizedPath, baselineAuthorized);
    const callerContent = `import React from 'react';
import { DashboardOverview } from './components/dashboard/DashboardOverview';
export const App = () => <DashboardOverview activities={[]} />;
`;
    fs.writeFileSync(callerPath, callerContent);

    // Initial change: removed widget usage from DashboardOverview, activities now unused in destructuring
    const postChangeAuthorized = `import React from 'react';
import { ActivityItem } from '../../types/activity';
export interface DashboardOverviewProps {
  activities: ActivityItem[];
}
export const DashboardOverview: React.FC<DashboardOverviewProps> = ({ activities }) => {
  return <div>No widget</div>;
};
`;

    const initialTs6133Error = `src/components/dashboard/DashboardOverview.tsx(6,71): error TS6133: 'activities' is declared but its value is never read.`;

    let validationCalls = 0;
    jest.spyOn(ValidationRunner, "validateWithShell").mockImplementation(async () => {
      validationCalls++;
      if (validationCalls === 1) {
        return { success: false, errors: initialTs6133Error };
      }
      return { success: true, errors: "" };
    });

    const manifest: FileManifest = {
      files: [{ path: "src/components/dashboard/DashboardOverview.tsx", action: "modify", dependencies: [], description: "Dashboard" }],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    };

    const contract: ExecutionContract = {
      goal: "Remove activity widget and clean references",
      taskType: "REFACTOR",
      risk: "LOW",
      estimatedComplexity: "SMALL",
      pipeline: "REPOSITORY",
      environment: "REACT_TS",
      repositoryRequired: true,
      expectedFiles: ["src/components/dashboard/DashboardOverview.tsx"],
      validationType: "TYPESCRIPT_BUILD",
      targetPaths: ["src/components/dashboard/DashboardOverview.tsx"],
      allowedActions: ["modify"],
      forbiddenActions: [],
      maxFiles: 1,
      searchScope: ["src"],
      contextScope: ["src"],
      diffCriticEnabled: true,
    };

    // Model correctly removes 'activities' from destructuring, preserving DashboardOverviewProps and ActivityItem import
    const mockRepairResponse = {
      repaired: true,
      patchExplanation: "Removed unused parameter from destructuring, kept interface intact",
      changes: [
        {
          path: "src/components/dashboard/DashboardOverview.tsx",
          action: "modify",
          description: "Remove activities from destructuring",
          edits: [
            {
              oldText: "export const DashboardOverview: React.FC<DashboardOverviewProps> = ({ activities }) => {",
              newText: "export const DashboardOverview: React.FC<DashboardOverviewProps> = () => {",
            },
          ],
        },
      ],
    };

    const mockOpenAI = {
      chat: {
        completions: {
          create: jest.fn().mockResolvedValue({
            choices: [{ message: { content: JSON.stringify(mockRepairResponse) } }],
          }),
        },
      },
    };
    (sharedUtils.getOpenAI as jest.Mock).mockReturnValue(mockOpenAI);

    const result = await SelfHealingEngine.runSelfHealingLoop(
      [{ path: "src/components/dashboard/DashboardOverview.tsx", action: "modify", content: postChangeAuthorized, description: "initial" }],
      tempDir,
      ["npm run build"],
      "system prompt",
      "Remove the deprecated activity widget and clean every reference to it.",
      new FileSystemStateManager(),
      "test-scope",
      undefined,
      manifest,
      contract,
      [],
      [],
      undefined,
      true,
    );

    expect(result.success).toBe(true);
    // App.tsx remains completely untouched
    expect(fs.readFileSync(callerPath, "utf8")).toBe(callerContent);
    // DashboardOverview.tsx preserved interface
    const finalContent = result.finalChanges.find((c) => c.path.includes("DashboardOverview.tsx"))?.content;
    expect(finalContent).toContain("export interface DashboardOverviewProps");
    expect(finalContent).toContain("activities: ActivityItem[];");
    expect(finalContent).toContain("import { ActivityItem }");
  });

  test("15: Diagnostic sequence A -> B -> A detected as OSCILLATING_REPAIR_CYCLE within 3 cycles", async () => {
    const authorizedPath = path.join(tempDir, "src/components/Test.tsx");
    fs.mkdirSync(path.dirname(authorizedPath), { recursive: true });
    fs.writeFileSync(authorizedPath, "export const Test = 1;\n");

    const errorA = `src/components/Test.tsx:1:14 - error TS2322: Type 'string' is not assignable to type 'number'.`;
    const errorB = `src/components/Test.tsx:2:1 - error TS2304: Cannot find name 'Foo'.`;

    let callCount = 0;
    jest.spyOn(ValidationRunner, "validateWithShell").mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return { success: false, errors: errorA };
      if (callCount === 2) return { success: false, errors: errorB };
      // Cycle 3: Error returns to errorA (A -> B -> A)
      return { success: false, errors: errorA };
    });

    const manifest: FileManifest = {
      files: [{ path: "src/components/Test.tsx", action: "modify", dependencies: [], description: "Test" }],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    };

    const contract: ExecutionContract = {
      goal: "Fix test component",
      taskType: "BUG_FIX",
      risk: "LOW",
      estimatedComplexity: "SMALL",
      pipeline: "REPOSITORY",
      environment: "REACT_TS",
      repositoryRequired: true,
      expectedFiles: ["src/components/Test.tsx"],
      validationType: "TYPESCRIPT_BUILD",
      targetPaths: ["src/components/Test.tsx"],
      allowedActions: ["modify"],
      forbiddenActions: [],
      maxFiles: 1,
      searchScope: ["src"],
      contextScope: ["src"],
      diffCriticEnabled: true,
    };

    let proposalCount = 0;
    let currentVal = 1;
    const mockOpenAI = {
      chat: {
        completions: {
          create: jest.fn().mockImplementation(async () => {
            proposalCount++;
            const prevVal = currentVal;
            currentVal = proposalCount + 1;
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      repaired: true,
                      patchExplanation: `Attempt ${proposalCount}`,
                      changes: [
                        {
                          path: "src/components/Test.tsx",
                          action: "modify",
                          description: `Patch ${proposalCount}`,
                          edits: [
                            {
                              oldText: `export const Test = ${prevVal};\n`,
                              newText: `export const Test = ${currentVal};\n`,
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
    (sharedUtils.getOpenAI as jest.Mock).mockReturnValue(mockOpenAI);

    const result = await SelfHealingEngine.runSelfHealingLoop(
      [{ path: "src/components/Test.tsx", action: "modify", content: "export const Test = 1;\n", description: "initial" }],
      tempDir,
      ["npm run build"],
      "system prompt",
      "Fix test component",
      new FileSystemStateManager(),
      "test-scope",
      undefined,
      manifest,
      contract,
      [],
      [],
      undefined,
      true,
    );

    // Should halt as OSCILLATING_REPAIR_CYCLE on attempt 3 (not exhausting all 15 cycles)
    expect(result.success).toBe(false);
    expect(result.errorType).toBe("OSCILLATING_REPAIR_CYCLE");
    expect(result.attempts).toBeLessThanOrEqual(3);
  });

  test("16: Progressive repair sequence A -> B -> C does not falsely detect oscillation", async () => {
    const authorizedPath = path.join(tempDir, "src/components/TestProgress.tsx");
    fs.mkdirSync(path.dirname(authorizedPath), { recursive: true });
    fs.writeFileSync(authorizedPath, "export const Test = 1;\n");

    const errorA = `src/components/TestProgress.tsx:1:14 - error TS2322: Type 'string' is not assignable to type 'number'.`;
    const errorB = `src/components/TestProgress.tsx:2:1 - error TS2304: Cannot find name 'Foo'.`;
    const errorC = `src/components/TestProgress.tsx:3:1 - error TS2552: Cannot find name 'Bar'.`;

    let callCount = 0;
    jest.spyOn(ValidationRunner, "validateWithShell").mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return { success: false, errors: errorA };
      if (callCount === 2) return { success: false, errors: errorB };
      if (callCount === 3) return { success: false, errors: errorC };
      return { success: true, errors: "" };
    });

    const manifest: FileManifest = {
      files: [{ path: "src/components/TestProgress.tsx", action: "modify", dependencies: [], description: "Test" }],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    };

    const contract: ExecutionContract = {
      goal: "Fix test component progressively",
      taskType: "BUG_FIX",
      risk: "LOW",
      estimatedComplexity: "SMALL",
      pipeline: "REPOSITORY",
      environment: "REACT_TS",
      repositoryRequired: true,
      expectedFiles: ["src/components/TestProgress.tsx"],
      validationType: "TYPESCRIPT_BUILD",
      targetPaths: ["src/components/TestProgress.tsx"],
      allowedActions: ["modify"],
      forbiddenActions: [],
      maxFiles: 1,
      searchScope: ["src"],
      contextScope: ["src"],
      diffCriticEnabled: true,
    };

    let step = 0;
    const mockOpenAI = {
      chat: {
        completions: {
          create: jest.fn().mockImplementation(async () => {
            step++;
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      repaired: true,
                      patchExplanation: `Step ${step}`,
                      changes: [
                        {
                          path: "src/components/TestProgress.tsx",
                          action: "modify",
                          description: `Step ${step}`,
                          edits: [
                            {
                              oldText: "export const Test = 1;\n",
                              newText: `export const Test = ${step + 10};\n`,
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
    (sharedUtils.getOpenAI as jest.Mock).mockReturnValue(mockOpenAI);

    const result = await SelfHealingEngine.runSelfHealingLoop(
      [{ path: "src/components/TestProgress.tsx", action: "modify", content: "export const Test = 1;\n", description: "initial" }],
      tempDir,
      ["npm run build"],
      "system prompt",
      "Fix test component progressively",
      new FileSystemStateManager(),
      "test-scope",
      undefined,
      manifest,
      contract,
      [],
      [],
      undefined,
      true,
    );

    // Clean resolution without premature false oscillation
    expect(result.success).toBe(true);
    expect(result.errorType).not.toBe("OSCILLATING_REPAIR_CYCLE");
  });

  test("17: Live Repo 4 sequence: filteredActivities TS6133 then activities TS6133 repaired deterministically without LLM calls, App.tsx untouched, public contract preserved", async () => {
    const authorizedPath = path.join(tempDir, "src/components/dashboard/DashboardOverview.tsx");
    const callerPath = path.join(tempDir, "src/App.tsx");
    fs.mkdirSync(path.dirname(authorizedPath), { recursive: true });

    const baselineDashboardSource = `import React from 'react';
import { ActivityItem } from '../../types/activity';
import { Project } from '../../types/project';

export interface DashboardOverviewProps {
  projects: Project[];
  activities: ActivityItem[];
}

export const DashboardOverview: React.FC<DashboardOverviewProps> = ({
  projects,
  activities,
}) => {
  const filteredActivities = activities;
  return <div>{filteredActivities.length}</div>;
};
`;

    const initialModifiedDashboardSource = `import React from 'react';
import { ActivityItem } from '../../types/activity';
import { Project } from '../../types/project';

export interface DashboardOverviewProps {
  projects: Project[];
  activities: ActivityItem[];
}

export const DashboardOverview: React.FC<DashboardOverviewProps> = ({
  projects,
  activities,
}) => {
  const filteredActivities = [];
  return <div>{projects.length}</div>;
};
`;

    const callerSource = `import React from 'react';
import { DashboardOverview } from './components/dashboard/DashboardOverview';

export const App = () => {
  return <DashboardOverview projects={[]} activities={[]} />;
};
`;

    fs.writeFileSync(authorizedPath, initialModifiedDashboardSource);
    fs.writeFileSync(callerPath, callerSource);

    // Baseline git commit setup
    const fsManager = new FileSystemStateManager();
    await fsManager.snapshot(
      [
        { path: "src/components/dashboard/DashboardOverview.tsx", content: baselineDashboardSource, action: "modify", description: "baseline" },
        { path: "src/App.tsx", content: callerSource, action: "create", description: "caller" },
      ],
      tempDir
    );

    const errorCycle1 = `src/components/dashboard/DashboardOverview.tsx:15:9 - error TS6133: 'filteredActivities' is declared but its value is never read.`;
    const errorCycle2 = `src/components/dashboard/DashboardOverview.tsx:12:3 - error TS6133: 'activities' is declared but its value is never read.`;

    let callCount = 0;
    jest.spyOn(ValidationRunner, "validateWithShell").mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return { success: false, errors: errorCycle1 };
      if (callCount === 2) return { success: false, errors: errorCycle2 };
      return { success: true, errors: "" };
    });

    const manifest: FileManifest = {
      files: [{ path: "src/components/dashboard/DashboardOverview.tsx", action: "modify", dependencies: [], description: "Dashboard" }],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    };

    const contract: ExecutionContract = {
      goal: "Remove the deprecated activity widget and clean every reference to it",
      taskType: "REFACTOR",
      risk: "LOW",
      estimatedComplexity: "SMALL",
      pipeline: "REPOSITORY",
      environment: "REACT_TS",
      repositoryRequired: true,
      expectedFiles: ["src/components/dashboard/DashboardOverview.tsx"],
      validationType: "TYPESCRIPT_BUILD",
      targetPaths: ["src/components/dashboard/DashboardOverview.tsx"],
      allowedActions: ["modify"],
      forbiddenActions: [],
      maxFiles: 1,
      searchScope: ["src"],
      contextScope: ["src"],
      diffCriticEnabled: true,
    };

    const mockOpenAI = {
      chat: {
        completions: {
          create: jest.fn(),
        },
      },
    };
    (sharedUtils.getOpenAI as jest.Mock).mockReturnValue(mockOpenAI);

    const result = await SelfHealingEngine.runSelfHealingLoop(
      [{ path: "src/components/dashboard/DashboardOverview.tsx", action: "modify", content: initialModifiedDashboardSource, description: "widget removed" }],
      tempDir,
      ["npm run build"],
      "system prompt",
      "Remove the deprecated activity widget and clean every reference to it.",
      fsManager,
      "test-repo-4",
      undefined,
      manifest,
      contract,
      [],
      [],
      undefined,
      true,
    );

    expect(result.success).toBe(true);
    expect(result.repaired).toBe(true);

    // Fast-path repair completed deterministically WITHOUT invoking LLM repair!
    expect(mockOpenAI.chat.completions.create).not.toHaveBeenCalled();

    const finalDashboard = result.finalChanges.find((c) => c.path === "src/components/dashboard/DashboardOverview.tsx");
    expect(finalDashboard).toBeDefined();

    // 1. filteredActivities removed
    expect(finalDashboard?.content).not.toContain("filteredActivities");
    // 2. activities removed from component destructuring
    expect(finalDashboard?.content).not.toContain("  activities,\n");
    // 3. Public interface preserves activities: ActivityItem[];
    expect(finalDashboard?.content).toContain("activities: ActivityItem[];");
    // 4. ActivityItem import preserved
    expect(finalDashboard?.content).toContain("import { ActivityItem } from '../../types/activity';");
    // 5. Caller App.tsx untouched on disk
    expect(fs.readFileSync(callerPath, "utf8")).toBe(callerSource);
  });
});
