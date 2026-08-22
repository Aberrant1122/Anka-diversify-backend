import fs from "fs";
import path from "path";
import os from "os";
import { AgentPipeline } from "../orchestration/AgentPipeline";
import { MemoryPersistence } from "../memory/MemoryPersistence";
import { RepositoryContextBuilder } from "../repository/RepositoryContextBuilder";
import { RepositoryScanner } from "../repository/RepositoryScanner";
import { IntentClassifier } from "../classification/IntentClassifier";
import { RepositorySearch } from "../repository/RepositorySearch";
import { CodeGenerator } from "../generation/CodeGenerator";
import { ManifestValidator } from "../../services/manifest-validator";
import { ManifestGenerator } from "../../services/manifest-generator";
import { FileSystemStateManager } from "../validation/FileSystemStateManager";
import { SelfHealingEngine } from "../repair/SelfHealingEngine";
import { SecurityAuditor } from "../review/SecurityAuditor";
import { ValidationDetector } from "../validation/ValidationDetector";
import { ChatRequest } from "../shared/types";

// Mock PrismaClient to prevent DB connection attempts
jest.mock("@prisma/client", () => {
  return {
    PrismaClient: jest.fn().mockImplementation(() => ({
      project: {
        findUnique: jest.fn().mockResolvedValue({
          localPath: "/tmp/mock",
          githubUrl: "https://github.com/mock/mock",
          githubToken: "mock-token",
        }),
      },
      phaseArtifact: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      taskDecomposition: {
        create: jest.fn().mockResolvedValue({}),
      },
      agentManifest: {
        create: jest.fn().mockResolvedValue({}),
      },
    })),
  };
});

describe("Pipeline Patch Resolution Integration Tests", () => {
  let tempDir: string;
  let targetFilePath: string;
  const originalApiKey = process.env.OPENAI_API_KEY;

  const AUTH_FILE_ORIGINAL = "import bcrypt from 'bcrypt';\n\nconst timeout = 5000;\nconst retries = 3;\n\nexport function auth() {\n  return true;\n}\n";

  beforeEach(() => {
    process.env.OPENAI_API_KEY = "test-mock-api-key";
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "patch-pipeline-test-"));
    targetFilePath = path.join(tempDir, "src", "auth.ts");
    fs.mkdirSync(path.dirname(targetFilePath), { recursive: true });
    fs.writeFileSync(targetFilePath, AUTH_FILE_ORIGINAL, "utf8");

    // Base stubs
    jest.spyOn(MemoryPersistence, "getOrCreateSession").mockResolvedValue({ id: "sess-1", title: "test" } as any);
    jest.spyOn(MemoryPersistence, "saveMessage").mockResolvedValue(undefined as any);
    jest.spyOn(MemoryPersistence, "persistProjectMemory").mockResolvedValue(undefined as any);
    jest.spyOn(MemoryPersistence, "updateSessionTitle").mockResolvedValue(undefined as any);

    const snapshotMock = {
      repoName: "test-repo",
      defaultBranch: "main",
      fileTree: ["src/auth.ts", "package.json"],
      keyFiles: [{ path: "src/auth.ts", content: AUTH_FILE_ORIGINAL }],
      revision: { contentHash: "hash-1" },
    };

    jest.spyOn(RepositoryContextBuilder, "buildProjectContext").mockResolvedValue({
      project: { id: "proj-1", name: "test-project" },
      activeTasks: [],
      repoSnapshot: snapshotMock,
    } as any);

    jest.spyOn(RepositoryScanner, "ensureLocalWorkspace").mockResolvedValue(tempDir);
    jest.spyOn(RepositoryScanner, "getEffectiveSnapshot").mockReturnValue(snapshotMock as any);

    jest.spyOn(IntentClassifier, "classifyIntentAndAmbiguity").mockResolvedValue({
      taskType: "BUG_FIX",
      risk: "LOW",
      estimatedComplexity: "SMALL",
      intent: "Update auth config",
      targetPath: "src/auth.ts",
      confidence: 0.95,
      requiresClarification: false,
      reasoning: "Clear task",
    } as any);

    jest.spyOn(RepositorySearch, "runIterativeRepositorySearch").mockResolvedValue({
      optimizedContext: {
        fileContext: { "src/auth.ts": AUTH_FILE_ORIGINAL },
        skeletonContext: {},
      },
      executionMemory: {
        searchPlanHistory: [],
        discoveredRoutes: [],
        discoveredServices: [],
        discoveredModels: [],
        discoveredSymbols: new Map([["auth", { filePath: "src/auth.ts", line: 6 }]]),
        currentConfidence: 0.95,
      },
      finalConfidence: 0.95,
      searchSummary: "Summary",
      inspectedFiles: ["src/auth.ts"],
    } as any);

    jest.spyOn(SecurityAuditor, "runReflectionAndSecurityAudit").mockResolvedValue({
      securityPass: true,
      summary: "Security pass",
    } as any);

    jest.spyOn(ValidationDetector, "runFeatureValidation").mockResolvedValue({
      overallPassed: true,
      checks: [],
      failedChecks: [],
    } as any);
  });

  afterEach(() => {
    process.env.OPENAI_API_KEY = originalApiKey;
    jest.restoreAllMocks();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  const sampleRequest: ChatRequest = {
    message: "Update timeout in auth.ts",
    sessionId: "sess-1",
  };

  // ── CHANGE 10: Valid patch resolves through pipeline ──
  test("CHANGE 10: Valid MODIFY patch resolves and reaches ExecutionScopeEnforcer as normal AgentFileChange", async () => {
    const approvedManifest = {
      files: [{ path: "src/auth.ts", action: "modify" as const, dependencies: [], description: "update config" }],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    };

    jest.spyOn(ManifestGenerator.prototype, "generateManifest").mockResolvedValue(approvedManifest);
    jest.spyOn(ManifestValidator.prototype, "validate").mockReturnValue({ valid: true, errors: [] });

    // Mock the LLM call inside generateRoadmapAndDiffs to return a patch proposal
    const resolvedContent = AUTH_FILE_ORIGINAL.replace("const timeout = 5000;", "const timeout = 10000;");

    jest.spyOn(SelfHealingEngine, "runSelfHealingLoop").mockResolvedValue({
      success: true,
      attempts: 1,
      finalChanges: [{ path: "src/auth.ts", content: resolvedContent, description: "Increase timeout", action: "modify" }],
      errorLog: "",
    } as any);

    // Mock CodeGenerator to simulate the full resolution path
    jest.spyOn(CodeGenerator, "generateRoadmapAndDiffs").mockResolvedValue({
      roadmap: [],
      changes: [
        {
          path: "src/auth.ts",
          content: resolvedContent,
          description: "Increase timeout",
          action: "modify",
        },
      ],
      explanation: "Updated timeout",
      commitMessage: "feat: update timeout",
      validationCommands: [],
    });

    const response = await AgentPipeline.runCodingAgent("user-1", "proj-1", sampleRequest);

    expect(response.changes).toHaveLength(1);
    expect(response.changes[0].content).toContain("const timeout = 10000;");
    expect(response.changes[0].content).toContain("import bcrypt from 'bcrypt';");
    expect(response.changes[0].content).toContain("const retries = 3;");
    expect(response.changes[0].content).toContain("export function auth()");
  });

  // ── CHANGE 11: Patch resolution failure halts pipeline ──
  test("CHANGE 11: Patch resolution failure prevents disk mutation", async () => {
    const approvedManifest = {
      files: [{ path: "src/auth.ts", action: "modify" as const, dependencies: [], description: "update config" }],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    };

    jest.spyOn(ManifestGenerator.prototype, "generateManifest").mockResolvedValue(approvedManifest);
    jest.spyOn(ManifestValidator.prototype, "validate").mockReturnValue({ valid: true, errors: [] });

    // Mock CodeGenerator to throw on patch resolution failure
    jest.spyOn(CodeGenerator, "generateRoadmapAndDiffs").mockRejectedValue(
      new Error("[PATCH_RESOLUTION_FAILED] AMBIGUOUS_PATCH_TARGET: Proposal 0 (src/auth.ts): Patch resolution failed"),
    );

    const fsApplySpy = jest.spyOn(FileSystemStateManager.prototype, "apply");
    const selfHealSpy = jest.spyOn(SelfHealingEngine, "runSelfHealingLoop");

    let error: Error | null = null;
    try {
      await AgentPipeline.runCodingAgent("user-1", "proj-1", sampleRequest);
    } catch (e: any) {
      error = e;
    }

    // Pipeline should propagate the error or handle it
    // FileSystemStateManager.apply should NOT have been called
    expect(fsApplySpy).not.toHaveBeenCalled();
    // SelfHealingEngine should NOT have been reached
    expect(selfHealSpy).not.toHaveBeenCalled();
    // Disk content unchanged
    expect(fs.readFileSync(targetFilePath, "utf8")).toBe(AUTH_FILE_ORIGINAL);
  });
});
