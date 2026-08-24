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
import { sha256 } from "../validation/FileVersionGuard";

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

describe("Pipeline Stale Source Protection Integration Tests (Step 8B3)", () => {
  let tempDir: string;
  let targetFilePath: string;
  const originalApiKey = process.env.OPENAI_API_KEY;

  const VERSION_A_CONTENT = "const timeout = 5000;\nconst retries = 3;\n";
  const VERSION_B_CONTENT = "const timeout = 7500;\nconst retries = 3;\n"; // concurrent edit on disk

  beforeEach(() => {
    process.env.OPENAI_API_KEY = "test-mock-api-key";
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "stale-pipeline-test-"));
    targetFilePath = path.join(tempDir, "src", "config.ts");
    fs.mkdirSync(path.dirname(targetFilePath), { recursive: true });
    fs.writeFileSync(targetFilePath, VERSION_A_CONTENT, "utf8");

    // Base stubs
    jest.spyOn(MemoryPersistence, "getOrCreateSession").mockResolvedValue({ id: "sess-1", title: "test" } as any);
    jest.spyOn(MemoryPersistence, "saveMessage").mockResolvedValue(undefined as any);
    jest.spyOn(MemoryPersistence, "persistProjectMemory").mockResolvedValue(undefined as any);
    jest.spyOn(MemoryPersistence, "updateSessionTitle").mockResolvedValue(undefined as any);

    const snapshotMock = {
      repoName: "test-repo",
      defaultBranch: "main",
      fileTree: ["src/config.ts", "package.json"],
      keyFiles: [{ path: "src/config.ts", content: VERSION_A_CONTENT }],
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
      intent: "Update timeout in config.ts",
      targetPath: "src/config.ts",
      confidence: 0.95,
      requiresClarification: false,
      reasoning: "Clear task",
    } as any);

    jest.spyOn(RepositorySearch, "runIterativeRepositorySearch").mockResolvedValue({
      optimizedContext: {
        fileContext: { "src/config.ts": VERSION_A_CONTENT },
        skeletonContext: {},
      },
      executionMemory: {
        searchPlanHistory: [],
        discoveredRoutes: [],
        discoveredServices: [],
        discoveredModels: [],
        discoveredSymbols: new Map([["config", { filePath: "src/config.ts", line: 1 }]]),
        currentConfidence: 0.95,
      },
      finalConfidence: 0.95,
      searchSummary: "Summary",
      inspectedFiles: ["src/config.ts"],
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
    message: "Update timeout in src/config.ts",
    sessionId: "sess-1",
  };

  // ── CHANGE 7: Matching version allows pipeline to proceed to apply ───────
  test("CHANGE 7: Matching disk content passes version guard and allows apply", async () => {
    const approvedManifest = {
      files: [{ path: "src/config.ts", action: "modify" as const, dependencies: [], description: "update config" }],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    };

    jest.spyOn(ManifestGenerator.prototype, "generateManifest").mockResolvedValue(approvedManifest);
    jest.spyOn(ManifestValidator.prototype, "validate").mockReturnValue({ valid: true, errors: [] });

    const resolvedContent = "const timeout = 10000;\nconst retries = 3;\n";

    jest.spyOn(CodeGenerator, "generateRoadmapAndDiffs").mockResolvedValue({
      roadmap: [],
      changes: [
        {
          path: "src/config.ts",
          content: resolvedContent,
          description: "Increase timeout",
          action: "modify",
        },
      ],
      explanation: "Updated timeout",
      commitMessage: "feat: update timeout",
      validationCommands: [],
      expectedSourceHashes: {
        "src/config.ts": sha256(VERSION_A_CONTENT),
      },
    });

    jest.spyOn(SelfHealingEngine, "runSelfHealingLoop").mockResolvedValue({
      success: true,
      attempts: 1,
      finalChanges: [{ path: "src/config.ts", content: resolvedContent, description: "Increase timeout", action: "modify" }],
      errorLog: "",
    } as any);

    // Disk still contains VERSION_A_CONTENT matching expected hash
    expect(fs.readFileSync(targetFilePath, "utf8")).toBe(VERSION_A_CONTENT);

    const response = await AgentPipeline.runCodingAgent("user-1", "proj-1", sampleRequest);

    expect(response.changes).toHaveLength(1);
    expect(response.changes[0].content).toBe(resolvedContent);
  });

  // ── CHANGE 8: Stale disk content halts pipeline BEFORE any disk mutation ─
  test("CHANGE 8: Stale source file (disk modified after generation context) halts pipeline and leaves disk untouched", async () => {
    const approvedManifest = {
      files: [{ path: "src/config.ts", action: "modify" as const, dependencies: [], description: "update config" }],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    };

    jest.spyOn(ManifestGenerator.prototype, "generateManifest").mockResolvedValue(approvedManifest);
    jest.spyOn(ManifestValidator.prototype, "validate").mockReturnValue({ valid: true, errors: [] });

    // CodeGenerator reasoned over VERSION_A_CONTENT
    const resolvedContent = "const timeout = 10000;\nconst retries = 3;\n";

    jest.spyOn(CodeGenerator, "generateRoadmapAndDiffs").mockResolvedValue({
      roadmap: [],
      changes: [
        {
          path: "src/config.ts",
          content: resolvedContent,
          description: "Increase timeout",
          action: "modify",
        },
      ],
      explanation: "Updated timeout",
      commitMessage: "feat: update timeout",
      validationCommands: [],
      expectedSourceHashes: {
        "src/config.ts": sha256(VERSION_A_CONTENT), // hash from generation context
      },
    });

    // SIMULATE CONCURRENT MODIFICATION ON DISK:
    // Disk now contains VERSION_B_CONTENT (different from what ANKA reasoned over)
    fs.writeFileSync(targetFilePath, VERSION_B_CONTENT, "utf8");

    const fsApplySpy = jest.spyOn(FileSystemStateManager.prototype, "apply");
    const selfHealSpy = jest.spyOn(SelfHealingEngine, "runSelfHealingLoop");

    const response = await AgentPipeline.runCodingAgent("user-1", "proj-1", sampleRequest);

    // Verification 1: response has 0 changes and contains STALE_SOURCE_FILE error
    expect(response.changes).toHaveLength(0);
    expect(response.explanation).toContain("[STALE_SOURCE_FILE]");
    expect(response.explanation).toContain("src/config.ts");

    // Verification 2: FileSystemStateManager.apply was NEVER called
    expect(fsApplySpy).not.toHaveBeenCalled();

    // Verification 3: SelfHealingEngine was NEVER called
    expect(selfHealSpy).not.toHaveBeenCalled();

    // Verification 4: Disk version B remains byte-for-byte untouched
    expect(fs.readFileSync(targetFilePath, "utf8")).toBe(VERSION_B_CONTENT);
  });
});
