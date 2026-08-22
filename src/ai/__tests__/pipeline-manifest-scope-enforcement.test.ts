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

describe("Pipeline Manifest & Scope Enforcement Integration Tests", () => {
  let tempDir: string;
  let targetFilePath: string;
  const originalApiKey = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    process.env.OPENAI_API_KEY = "test-mock-api-key";
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "manifest-scope-test-"));
    targetFilePath = path.join(tempDir, "src", "index.ts");
    fs.mkdirSync(path.dirname(targetFilePath), { recursive: true });
    fs.writeFileSync(targetFilePath, "console.log('original');", "utf8");

    // Base stubs
    jest.spyOn(MemoryPersistence, "getOrCreateSession").mockResolvedValue({ id: "sess-1", title: "test" } as any);
    jest.spyOn(MemoryPersistence, "saveMessage").mockResolvedValue(undefined as any);
    jest.spyOn(MemoryPersistence, "persistProjectMemory").mockResolvedValue(undefined as any);
    jest.spyOn(MemoryPersistence, "updateSessionTitle").mockResolvedValue(undefined as any);

    const snapshotMock = {
      repoName: "test-repo",
      defaultBranch: "main",
      fileTree: ["src/index.ts", "package.json"],
      keyFiles: [{ path: "src/index.ts", content: "console.log('original');" }],
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
      intent: "Fix bug in index.ts",
      targetPath: "src/index.ts",
      confidence: 0.95,
      requiresClarification: false,
      reasoning: "Clear task",
    } as any);

    jest.spyOn(RepositorySearch, "runIterativeRepositorySearch").mockResolvedValue({
      optimizedContext: {
        fileContext: { "src/index.ts": "console.log('original');" },
        skeletonContext: {},
      },
      executionMemory: {
        searchPlanHistory: [],
        discoveredRoutes: [],
        discoveredServices: [],
        discoveredModels: [],
        discoveredSymbols: new Map([["index", { filePath: "src/index.ts", line: 1 }]]),
        currentConfidence: 0.95,
      },
      finalConfidence: 0.95,
      searchSummary: "Summary",
      inspectedFiles: ["src/index.ts"],
    } as any);

    jest.spyOn(SelfHealingEngine, "runSelfHealingLoop").mockResolvedValue({
      success: true,
      attempts: 1,
      finalChanges: [{ path: "src/index.ts", content: "console.log('updated');", description: "update", action: "modify" }],
      errorLog: "",
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
    message: "Fix bug in src/index.ts",
    sessionId: "sess-1",
  };

  test("CHANGE 5: Manifest failure prevents CodeGenerator invocation and file mutation", async () => {
    jest.spyOn(ManifestGenerator.prototype, "generateManifest").mockResolvedValue({
      files: [{ path: "src/unauthorized.ts", action: "modify", dependencies: [], description: "out of scope" }],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    });

    jest.spyOn(ManifestValidator.prototype, "validate").mockReturnValue({
      valid: false,
      errors: [
        {
          type: "path_constraint",
          message: "Path src/unauthorized.ts violates targetPaths",
          affectedFiles: ["src/unauthorized.ts"],
          suggestion: "Remove file",
        },
      ],
    });

    const codeGenSpy = jest.spyOn(CodeGenerator, "generateRoadmapAndDiffs");
    const fsApplySpy = jest.spyOn(FileSystemStateManager.prototype, "apply");

    const response = await AgentPipeline.runCodingAgent("user-1", "proj-1", sampleRequest);

    expect(response.changes).toHaveLength(0);
    expect(response.explanation).toContain("[Manifest Validation Failed]");
    expect(codeGenSpy).not.toHaveBeenCalled();
    expect(fsApplySpy).not.toHaveBeenCalled();
    expect(fs.readFileSync(targetFilePath, "utf8")).toBe("console.log('original');");
  });

  test("CHANGE 6: Scope failure on undeclared file halts pipeline before FileSystemStateManager mutation", async () => {
    jest.spyOn(ManifestGenerator.prototype, "generateManifest").mockResolvedValue({
      files: [{ path: "src/index.ts", action: "modify", dependencies: [], description: "update index" }],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    });

    jest.spyOn(ManifestValidator.prototype, "validate").mockReturnValue({
      valid: true,
      errors: [],
    });

    // CodeGenerator returns an undeclared extra file (package.json)
    jest.spyOn(CodeGenerator, "generateRoadmapAndDiffs").mockResolvedValue({
      roadmap: [],
      changes: [
        { path: "src/index.ts", content: "console.log('updated');", description: "update", action: "modify" },
        { path: "package.json", content: "{}", description: "undeclared change", action: "modify" },
      ],
      explanation: "Changes generated",
      commitMessage: "feat: update",
      validationCommands: [],
    });

    const fsApplySpy = jest.spyOn(FileSystemStateManager.prototype, "apply");

    const response = await AgentPipeline.runCodingAgent("user-1", "proj-1", sampleRequest);

    expect(response.changes).toHaveLength(0);
    expect(response.explanation).toContain("[Execution Scope Violation]");
    expect(response.explanation).toContain("UNDECLARED_FILE");
    expect(fsApplySpy).not.toHaveBeenCalled();
    // Verify disk content unchanged
    expect(fs.readFileSync(targetFilePath, "utf8")).toBe("console.log('original');");
  });

  test("CHANGE 7B: Approved manifest is passed directly into CodeGenerator.generateRoadmapAndDiffs", async () => {
    const approvedManifest = {
      files: [{ path: "src/index.ts", action: "modify" as const, dependencies: [], description: "update index" }],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    };

    jest.spyOn(ManifestGenerator.prototype, "generateManifest").mockResolvedValue(approvedManifest);
    jest.spyOn(ManifestValidator.prototype, "validate").mockReturnValue({
      valid: true,
      errors: [],
    });

    const codeGenSpy = jest.spyOn(CodeGenerator, "generateRoadmapAndDiffs").mockResolvedValue({
      roadmap: [],
      changes: [
        { path: "src/index.ts", content: "console.log('updated');", description: "update", action: "modify" },
      ],
      explanation: "Changes generated",
      commitMessage: "feat: update",
      validationCommands: [],
    });

    await AgentPipeline.runCodingAgent("user-1", "proj-1", sampleRequest);

    expect(codeGenSpy).toHaveBeenCalled();
    // Verify 6th parameter is approvedManifest
    expect(codeGenSpy.mock.calls[0][5]).toEqual(approvedManifest);
  });
});
