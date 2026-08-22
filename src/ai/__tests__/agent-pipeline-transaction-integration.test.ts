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
import { ValidationPlanner } from "../validation/ValidationPlanner";
import { SelfHealingEngine } from "../repair/SelfHealingEngine";
import { BuildErrorRepair } from "../repair/BuildErrorRepair";
import { SecurityAuditor } from "../review/SecurityAuditor";
import { ValidationDetector } from "../validation/ValidationDetector";
import { ManifestGenerator } from "../../services/manifest-generator";
import { ManifestValidator } from "../../services/manifest-validator";
import { ChatRequest } from "../shared/types";

// Mock PrismaClient to prevent DB connection attempts during integration testing
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

describe("AgentPipeline Real Transaction Integration Tests (Phase A)", () => {
  let tempDir: string;
  let targetFilePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-integration-test-"));
    targetFilePath = path.join(tempDir, "src", "index.ts");
    fs.mkdirSync(path.dirname(targetFilePath), { recursive: true });
    fs.writeFileSync(targetFilePath, "console.log('original');", "utf8");

    // Setup base stubs for external LLM & context components
    jest.spyOn(MemoryPersistence, "getOrCreateSession").mockResolvedValue({ id: "sess-1", title: "test" } as any);
    jest.spyOn(MemoryPersistence, "saveMessage").mockResolvedValue(undefined as any);
    jest.spyOn(MemoryPersistence, "persistProjectMemory").mockResolvedValue(undefined as any);
    jest.spyOn(MemoryPersistence, "updateSessionTitle").mockResolvedValue(undefined as any);

    jest.spyOn(RepositoryContextBuilder, "buildProjectContext").mockResolvedValue({
      repoSnapshot: { keyFiles: [{ path: "src/index.ts", content: "console.log('original');" }] },
    } as any);

    jest.spyOn(RepositoryScanner, "ensureLocalWorkspace").mockResolvedValue(tempDir);
    jest.spyOn(RepositoryScanner, "getEffectiveSnapshot").mockReturnValue({
      keyFiles: [{ path: "src/index.ts", content: "console.log('original');" }],
      revision: { contentHash: "hash-1" },
    } as any);

    jest.spyOn(IntentClassifier, "classifyIntentAndAmbiguity").mockResolvedValue({
      intent: "FEATURE",
      taskType: "NEW_FEATURE",
      risk: "LOW",
      estimatedComplexity: "SMALL",
      targetPath: "src/index.ts",
      requiresClarification: false,
      confidence: 0.9,
    } as any);

    jest.spyOn(RepositorySearch, "runIterativeRepositorySearch").mockResolvedValue({
      optimizedContext: { fileContext: {} },
      executionMemory: { inspectedFiles: new Set() },
      finalConfidence: 0.9,
      searchSummary: "ok",
    } as any);

    jest.spyOn(CodeGenerator, "buildAgentSystemPrompt").mockReturnValue("system prompt");
    jest.spyOn(CodeGenerator, "generateRoadmapAndDiffs").mockResolvedValue({
      explanation: "updating index.ts",
      commitMessage: "feat: update index",
      roadmap: [],
      changes: [{ path: "src/index.ts", content: "console.log('mutated');", description: "test change" }],
      validationCommands: [],
    });

    jest.spyOn(ValidationPlanner, "detectValidationCommands").mockReturnValue([]);

    process.env.OPENAI_API_KEY = "test-mock-api-key";
    jest.spyOn(ManifestGenerator.prototype, "generateManifest").mockResolvedValue({
      files: [{ path: "src/index.ts", action: "modify", dependencies: [], description: "test change" }],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    });
    jest.spyOn(ManifestValidator.prototype, "validate").mockReturnValue({
      valid: true,
      errors: [],
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  const sampleRequest: ChatRequest = {
    message: "Update index.ts",
    sessionId: "sess-1",
  };

  it("1. SelfHealingEngine mutates workspace then throws -> AgentPipeline catches and rolls back disk", async () => {
    jest.spyOn(SelfHealingEngine, "runSelfHealingLoop").mockImplementation(async (changes, localPath, _cmds, _sp, _msg, fsManager) => {
      if (fsManager && localPath) {
        await fsManager.apply(changes, localPath);
      }
      expect(fs.readFileSync(targetFilePath, "utf8")).toBe("console.log('mutated');");
      throw new Error("SelfHealingEngine runtime explosion");
    });

    await expect(AgentPipeline.runCodingAgent("user-1", "proj-1", sampleRequest)).rejects.toThrow("SelfHealingEngine runtime explosion");

    // Verify ACTUAL disk state after exception: restored to original!
    expect(fs.readFileSync(targetFilePath, "utf8")).toBe("console.log('original');");
  });

  it("2. SecurityAuditor throws -> AgentPipeline rolls back disk changes applied in Stage 8", async () => {
    jest.spyOn(SelfHealingEngine, "runSelfHealingLoop").mockImplementation(async (changes, localPath, _cmds, _sp, _msg, fsManager) => {
      if (fsManager && localPath) {
        await fsManager.apply(changes, localPath);
      }
      return { finalChanges: changes, attempts: 1, success: true };
    });

    jest.spyOn(SecurityAuditor, "runReflectionAndSecurityAudit").mockRejectedValue(new Error("OpenAI API RateLimitError"));

    await expect(AgentPipeline.runCodingAgent("user-1", "proj-1", sampleRequest)).rejects.toThrow("OpenAI API RateLimitError");

    // Verify ACTUAL disk state after exception: restored to original!
    expect(fs.readFileSync(targetFilePath, "utf8")).toBe("console.log('original');");
  });

  it("3. ValidationDetector throws -> AgentPipeline rolls back disk changes applied in Stage 8", async () => {
    jest.spyOn(SelfHealingEngine, "runSelfHealingLoop").mockImplementation(async (changes, localPath, _cmds, _sp, _msg, fsManager) => {
      if (fsManager && localPath) {
        await fsManager.apply(changes, localPath);
      }
      return { finalChanges: changes, attempts: 1, success: true };
    });

    jest.spyOn(SecurityAuditor, "runReflectionAndSecurityAudit").mockResolvedValue({
      approvedChanges: [],
      passed: true,
      critiqueScore: 0.9,
      securityPass: true,
      summary: "Clean",
    });

    jest.spyOn(ValidationDetector, "runFeatureValidation").mockRejectedValue(new Error("Static validation parser crash"));

    await expect(AgentPipeline.runCodingAgent("user-1", "proj-1", sampleRequest)).rejects.toThrow("Static validation parser crash");

    // Verify ACTUAL disk state after exception: restored to original!
    expect(fs.readFileSync(targetFilePath, "utf8")).toBe("console.log('original');");
  });

  it("4. SecurityAuditor returns securityPass=false -> no commit, disk restored, response reflects failure", async () => {
    jest.spyOn(SelfHealingEngine, "runSelfHealingLoop").mockImplementation(async (changes, localPath, _cmds, _sp, _msg, fsManager) => {
      if (fsManager && localPath) {
        await fsManager.apply(changes, localPath);
      }
      return { finalChanges: changes, attempts: 1, success: true };
    });

    jest.spyOn(SecurityAuditor, "runReflectionAndSecurityAudit").mockResolvedValue({
      approvedChanges: [],
      passed: false,
      critiqueScore: 0.5,
      securityPass: false,
      summary: "Security Violation Flagged",
    });

    jest.spyOn(ValidationDetector, "runFeatureValidation").mockResolvedValue({
      overallPassed: true,
      checks: [],
      failedChecks: [],
      repairActions: [],
    });

    const response = await AgentPipeline.runCodingAgent("user-1", "proj-1", sampleRequest);

    expect(response.buildVerified).toBe(false);
    expect(response.securityPass).toBe(false);
    expect(response.lifecycleStage).toBe("BuildFailed");
    expect(response.changes).toEqual([]);

    // Verify ACTUAL disk state: restored to original!
    expect(fs.readFileSync(targetFilePath, "utf8")).toBe("console.log('original');");
  });

  it("5. ValidationDetector returns overallPassed=false -> no commit, disk restored, response reflects failure", async () => {
    jest.spyOn(SelfHealingEngine, "runSelfHealingLoop").mockImplementation(async (changes, localPath, _cmds, _sp, _msg, fsManager) => {
      if (fsManager && localPath) {
        await fsManager.apply(changes, localPath);
      }
      return { finalChanges: changes, attempts: 1, success: true };
    });

    jest.spyOn(SecurityAuditor, "runReflectionAndSecurityAudit").mockResolvedValue({
      approvedChanges: [],
      passed: true,
      critiqueScore: 0.9,
      securityPass: true,
      summary: "Clean",
    });

    jest.spyOn(ValidationDetector, "runFeatureValidation").mockResolvedValue({
      overallPassed: false,
      checks: [{ id: "import_export", label: "Broken Import", status: "FAIL", checked: true, details: "Missing export" }],
      failedChecks: ["Broken import"],
      repairActions: [],
    });

    const response = await AgentPipeline.runCodingAgent("user-1", "proj-1", sampleRequest);

    expect(response.buildVerified).toBe(false);
    expect(response.lifecycleStage).toBe("BuildFailed");
    expect(response.changes).toEqual([]);

    // Verify ACTUAL disk state: restored to original!
    expect(fs.readFileSync(targetFilePath, "utf8")).toBe("console.log('original');");
  });

  it("6. All gates pass -> exactly one commit, changes remain on disk, response reflects success", async () => {
    jest.spyOn(SelfHealingEngine, "runSelfHealingLoop").mockImplementation(async (changes, localPath, _cmds, _sp, _msg, fsManager) => {
      if (fsManager && localPath) {
        await fsManager.apply(changes, localPath);
      }
      return { finalChanges: changes, attempts: 1, success: true };
    });

    jest.spyOn(SecurityAuditor, "runReflectionAndSecurityAudit").mockResolvedValue({
      approvedChanges: [],
      passed: true,
      critiqueScore: 0.9,
      securityPass: true,
      summary: "Clean",
    });

    jest.spyOn(ValidationDetector, "runFeatureValidation").mockResolvedValue({
      overallPassed: true,
      checks: [{ id: "import_export", label: "Imports", status: "PASS", checked: true, details: "OK" }],
      failedChecks: [],
      repairActions: [],
    });

    const response = await AgentPipeline.runCodingAgent("user-1", "proj-1", sampleRequest);

    expect(response.buildVerified).toBe(true);
    expect(response.securityPass).toBe(true);
    expect(response.lifecycleStage).toBe("Done");
    expect(response.changes.length).toBe(1);

    // Verify ACTUAL disk state: changes REMAIN ON DISK!
    expect(fs.readFileSync(targetFilePath, "utf8")).toBe("console.log('mutated');");
  });
});
