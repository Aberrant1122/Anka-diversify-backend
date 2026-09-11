import os from "os";
import fs from "fs";
import path from "path";
import { AuthorizedCapabilityScope } from "../runtime/CapabilityGuard";
import { AgentPipeline } from "../orchestration/AgentPipeline";
import { ManifestGenerator } from "../generation/ManifestGenerator";
import { CodeGenerator } from "../generation/CodeGenerator";
import { RepositorySearch } from "../repository/RepositorySearch";
import { RepositoryKnowledgeGraph } from "../repository/RepositoryKnowledgeGraph";
import { TaskExecutionPlanManager } from "../planning/TaskExecutionPlanManager";
import { TaskExecutionPlan } from "../shared/TaskExecutionPlan";
import { ValidationRunner } from "../validation/ValidationRunner";

import { MemoryPersistence } from "../memory/MemoryPersistence";
import { RepositoryContextBuilder } from "../repository/RepositoryContextBuilder";
import { RepositoryScanner } from "../repository/RepositoryScanner";
import { IntentClassifier } from "../classification/IntentClassifier";
import { SelfHealingEngine } from "../repair/SelfHealingEngine";
import { SecurityAuditor } from "../review/SecurityAuditor";
import { ValidationDetector } from "../validation/ValidationDetector";

// Mock PrismaClient to prevent foreign key errors in test runs
jest.mock("@prisma/client", () => {
  return {
    PrismaClient: jest.fn().mockImplementation(() => ({
      project: {
        findUnique: jest.fn().mockImplementation(async () => ({
          localPath: testTempDir,
          githubUrl: "https://github.com/mock/mock",
          githubToken: "mock-token",
        })),
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
      projectMemorySummary: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      aiChatMessage: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    })),
  };
});

let testTempDir: string;

describe("Deterministic Successful No-Op / ALREADY_SATISFIED (Pass 4)", () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = "test-mock-key";
    testTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pass4-test-"));
    fs.mkdirSync(path.join(testTempDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(testTempDir, "src", "app.ts"), "export const x = 1;");
    fs.writeFileSync(path.join(testTempDir, "package.json"), '{"name":"test-app"}');
    jest.clearAllMocks();
    jest.spyOn(MemoryPersistence, "getOrCreateSession").mockResolvedValue({ id: "sess-1", title: "test" } as any);
    jest.spyOn(MemoryPersistence, "saveMessage").mockResolvedValue(undefined as any);
    jest.spyOn(MemoryPersistence, "persistProjectMemory").mockResolvedValue(undefined as any);
    jest.spyOn(MemoryPersistence, "updateSessionTitle").mockResolvedValue(undefined as any);

    jest.spyOn(IntentClassifier, "classifyIntentAndAmbiguity").mockResolvedValue({
      intent: "BUG_FIX",
      taskType: "BUG_FIX",
      risk: "LOW",
      estimatedComplexity: "SMALL",
      requiresClarification: false,
      confidence: 0.95,
      reasoning: "Fix bug",
    } as any);

    jest.spyOn(RepositorySearch, "runIterativeRepositorySearch").mockResolvedValue({
      optimizedContext: {
        fileContext: { "src/app.ts": "export const x = 1;" },
        skeletonContext: {},
      },
      executionMemory: {
        searchPlanHistory: [],
        discoveredRoutes: [],
        discoveredServices: [],
        discoveredModels: [],
        discoveredSymbols: new Map(),
        currentConfidence: 0.95,
      },
      finalConfidence: 0.95,
      searchSummary: "Summary",
      inspectedFiles: ["src/app.ts"],
    } as any);

    jest.spyOn(SelfHealingEngine, "runSelfHealingLoop").mockResolvedValue({
      success: true,
      attempts: 1,
      finalChanges: [{ path: "src/app.ts", content: "export const x = 1;", description: "fix", action: "modify" }],
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

    jest.spyOn(RepositoryContextBuilder, "buildProjectContext").mockResolvedValue({
      project: { name: "Test Project" },
      activeTasks: [],
      repoSnapshot: {
        keyFiles: [
          { path: "package.json", content: '{"name":"test-app"}' },
          { path: "src/app.ts", content: "export const x = 1;" },
        ],
      },
    } as any);

    jest.spyOn(RepositoryScanner, "ensureLocalWorkspace").mockImplementation(async () => testTempDir);
    jest.spyOn(RepositoryScanner, "getEffectiveSnapshot").mockReturnValue({
      keyFiles: [
        { path: "package.json", content: '{"name":"test-app"}' },
        { path: "src/app.ts", content: "export const x = 1;" },
      ],
      fileTree: ["package.json", "src/app.ts"],
      repoName: "test-repo",
      defaultBranch: "main",
      revision: { contentHash: "hash-1" },
    } as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("10. Exact live test: clean baseline build with 0 diagnostics yields ALREADY_SATISFIED with 0 investigation/manifest/codegen calls", async () => {
    const kgSpy = jest.spyOn(RepositoryKnowledgeGraph, "buildKnowledgeGraph");
    const searchSpy = jest.spyOn(RepositorySearch, "runIterativeRepositorySearch");
    const manifestSpy = jest.spyOn(ManifestGenerator.prototype, "generateManifest");
    const codegenSpy = jest.spyOn(CodeGenerator, "generateRoadmapAndDiffs");

    const sampleRequest = {
      message: "resolve all the build errors",
      context: {},
      sessionId: "session-clean-baseline-test",
    };

    const response = await AgentPipeline.runCodingAgent("user-noop", "proj-noop-1", sampleRequest as any, undefined, {
      canonicalExistingFiles: ["package.json", "src/app.ts"],
      effectiveSnapshot: [
        { path: "package.json", content: '{"name":"test-app","scripts":{"build":"echo build"}}' },
        { path: "src/app.ts", content: "export const x = 1;" },
      ],
      baselineBuildPassed: true,
      dependenciesReady: true,
      baselineDiagnostics: [],
      targetedBaselineDiagnostics: [],
    });

    expect(response.successfulNoOp).toBe(true);
    expect(response.reason).toBe("ALREADY_SATISFIED");
    expect(response.status).toBe("ALREADY_SATISFIED");
    expect(response.changes).toEqual([]);
    expect(response.buildVerified).toBe(true);
    expect(response.taskVerified).toBe(true);
    expect(response.repositoryClean).toBe(true);
    expect(response.healthStatus).toBe("HEALTHY");

    // Zero investigation, zero manifest generation, zero code generation
    expect(kgSpy).not.toHaveBeenCalled();
    expect(searchSpy).not.toHaveBeenCalled();
    expect(manifestSpy).not.toHaveBeenCalled();
    expect(codegenSpy).not.toHaveBeenCalled();
  });

  test("11. Real error test: baseline with real source diagnostic TS1005 does NOT trigger no-op", async () => {
    const codegenSpy = jest.spyOn(CodeGenerator, "generateRoadmapAndDiffs").mockResolvedValue({
      roadmap: [],
      explanation: "Fixed syntax error",
      changes: [
        {
          path: "src/app.ts",
          action: "modify",
          description: "Fixed syntax error",
          content: "export const x: number = 1;",
        },
      ],
      commitMessage: "fix(app): syntax error",
      riskAnalysis: {
        breakingChanges: false,
        performanceImpact: "none",
        securityRisks: "none",
        dependencyRisk: "none",
      },
    } as any);

    const sampleRequest = {
      message: "resolve all the build errors",
      context: {},
      sessionId: "session-real-error-test",
    };

    const response = await AgentPipeline.runCodingAgent("user-noop", "proj-noop-2", sampleRequest as any, undefined, {
      authorizedCapabilityScope: AuthorizedCapabilityScope.fromBackendConfiguration({
        workspaceRoot: testTempDir,
        authorityId: "pass4-test-11",
        grants: [{ path: "src/app.ts", action: "FILE_MODIFY" }],
      })!,
      canonicalExistingFiles: ["package.json", "src/app.ts"],
      effectiveSnapshot: [
        { path: "package.json", content: '{"name":"test-app","scripts":{"build":"echo build"}}' },
        { path: "src/app.ts", content: "export const x = ;" },
      ],
      baselineBuildPassed: false,
      dependenciesReady: true,
      baselineErrorLog: "src/app.ts(1,18): error TS1005: Expression expected.",
      baselineDiagnostics: [
        {
          filePath: "src/app.ts",
          errorCode: "TS1005",
          message: "Expression expected.",
          origin: "BASELINE",
          errorType: "COMPILER_ERROR",
          fingerprint: "src/app.ts:1:18",
        },
      ],
    });

    // When real source errors exist, successfulNoOp must be false/undefined
    expect(response.successfulNoOp).toBeFalsy();
    expect(response.reason).not.toBe("ALREADY_SATISFIED");
  });

  test("12. Environment failure test: toolchain/environment failure (e.g. npm not found) does NOT trigger ALREADY_SATISFIED", async () => {
    jest.spyOn(CodeGenerator, "generateRoadmapAndDiffs").mockResolvedValue({
      roadmap: [],
      explanation: "Environment error handling",
      changes: [
        {
          path: "src/app.ts",
          action: "modify",
          description: "Environment error handling",
          content: "export const x = 1;",
        },
      ],
      commitMessage: "fix: env",
      riskAnalysis: {
        breakingChanges: false,
        performanceImpact: "none",
        securityRisks: "none",
        dependencyRisk: "none",
      },
    } as any);

    const sampleRequest = {
      message: "resolve all the build errors",
      context: {},
      sessionId: "session-env-fail-test",
    };

    const response = await AgentPipeline.runCodingAgent("user-noop", "proj-noop-3", sampleRequest as any, undefined, {
      authorizedCapabilityScope: AuthorizedCapabilityScope.fromBackendConfiguration({
        workspaceRoot: testTempDir,
        authorityId: "pass4-test-12",
        grants: [{ path: "src/app.ts", action: "FILE_MODIFY" }],
      })!,
      canonicalExistingFiles: ["package.json", "src/app.ts"],
      effectiveSnapshot: [
        { path: "package.json", content: '{"name":"test-app"}' },
        { path: "src/app.ts", content: "export const x = 1;" },
      ],
      baselineBuildPassed: false,
      dependenciesReady: false,
      baselineDependencyInstall: "FAIL",
      baselineErrorLog: "npm: command not found",
      healthStatus: "BASELINE_REPOSITORY_UNHEALTHY",
    });

    expect(response.successfulNoOp).toBeFalsy();
    expect(response.reason).not.toBe("ALREADY_SATISFIED");
    expect(response.status).not.toBe("ALREADY_SATISFIED");
  });

  test("13. Compound task no-op test: Stage 1 repair ALREADY_SATISFIED marks Stage 1 VERIFIED and makes Stage 2 eligible", async () => {
    jest.spyOn(IntentClassifier, "classifyIntentAndAmbiguity").mockResolvedValue({
      intent: "COMPOUND",
      taskType: "BUG_FIX",
      risk: "LOW",
      estimatedComplexity: "SMALL",
      requiresClarification: false,
      confidence: 0.95,
      reasoning: "Fix build errors then create calculator",
      stages: [
        { id: "stage-1", name: "Fix build errors", taskType: "BUG_FIX", goal: "Fix build errors" },
        { id: "stage-2", name: "Create calculator", taskType: "NEW_FEATURE", goal: "Create calculator", dependsOn: ["stage-1"] },
      ],
    } as any);

    const sampleRequest = {
      message: "fix the build errors and create a calculator",
      context: {},
      sessionId: "session-compound-test",
    };

    // Stage 1 execution: baseline is clean
    const stage1Response = await AgentPipeline.runCodingAgent(
      "user-noop",
      "proj-noop-4",
      sampleRequest as any,
      undefined,
      {
        canonicalExistingFiles: ["package.json", "src/app.ts"],
        effectiveSnapshot: [
          { path: "package.json", content: '{"name":"test-app"}' },
          { path: "src/app.ts", content: "export const x = 1;" },
        ],
        baselineBuildPassed: true,
        dependenciesReady: true,
        baselineDiagnostics: [],
      }
    );

    expect(stage1Response.successfulNoOp).toBe(true);
    expect(stage1Response.reason).toBe("ALREADY_SATISFIED");
    expect(stage1Response.taskExecutionPlan).toBeDefined();

    const plan = stage1Response.taskExecutionPlan!;
    expect(plan.stages.length).toBe(2);

    // Stage 1 must be VERIFIED
    const stage1 = plan.stages[0];
    expect(stage1.status).toBe("VERIFIED");

    // Plan must have advanced to currentStageIndex = 1
    expect(plan.currentStageIndex).toBe(1);

    // Stage 2 must now be ELIGIBLE
    const stage2 = plan.stages[1];
    const isStage2Eligible = TaskExecutionPlanManager.isStageEligible(plan, stage2.id);
    expect(isStage2Eligible).toBe(true);
  });

  test("14. Non-repair task test: clean baseline on FEATURE_ADD does NOT trigger ALREADY_SATISFIED no-op", async () => {
    jest.spyOn(IntentClassifier, "classifyIntentAndAmbiguity").mockResolvedValue({
      intent: "FEATURE",
      taskType: "NEW_FEATURE",
      risk: "LOW",
      estimatedComplexity: "SMALL",
      requiresClarification: false,
      confidence: 0.95,
      reasoning: "Create feature",
    } as any);

    jest.spyOn(ManifestGenerator.prototype, "generateManifest").mockResolvedValue({
      files: [{ path: "src/feature.ts", action: "create", dependencies: [], description: "new feature" }],
      totalFiles: 1,
    } as any);

    jest.spyOn(CodeGenerator, "generateRoadmapAndDiffs").mockResolvedValue({
      roadmap: [],
      explanation: "Created feature",
      changes: [
        {
          path: "src/feature.ts",
          action: "create",
          description: "Created feature",
          content: "export const feature = true;",
        },
      ],
      commitMessage: "feat: add feature",
      riskAnalysis: {
        breakingChanges: false,
        performanceImpact: "none",
        securityRisks: "none",
        dependencyRisk: "none",
      },
    } as any);

    const sampleRequest = {
      message: "create a calculator component in src/feature.ts",
      context: {},
      sessionId: "session-feature-test",
    };

    const searchSpy = jest.spyOn(RepositorySearch, "runIterativeRepositorySearch");

    const response = await AgentPipeline.runCodingAgent("user-noop", "proj-noop-5", sampleRequest as any, undefined, {
      canonicalExistingFiles: ["package.json", "src/app.ts"],
      effectiveSnapshot: [
        { path: "package.json", content: '{"name":"test-app"}' },
        { path: "src/app.ts", content: "export const x = 1;" },
      ],
      baselineBuildPassed: true,
      dependenciesReady: true,
      baselineDiagnostics: [],
    });

    expect(response.successfulNoOp).toBeFalsy();
    expect(response.reason).not.toBe("ALREADY_SATISFIED");
    expect(response.status).not.toBe("ALREADY_SATISFIED");
    expect(searchSpy).toHaveBeenCalled();
  });

  test("15. Deterministic check: no keyword dependency; structured BUG_FIX triggers ALREADY_SATISFIED", async () => {
    const sampleRequest = {
      message: "fix the issue with calculations",
      context: {},
      sessionId: "session-keyword-free-test",
    };

    const response = await AgentPipeline.runCodingAgent("user-noop", "proj-noop-6", sampleRequest as any, undefined, {
      canonicalExistingFiles: ["package.json", "src/app.ts"],
      effectiveSnapshot: [
        { path: "package.json", content: '{"name":"test-app"}' },
        { path: "src/app.ts", content: "export const x = 1;" },
      ],
      baselineBuildPassed: true,
      dependenciesReady: true,
      baselineDiagnostics: [],
    });

    expect(response.successfulNoOp).toBe(true);
    expect(response.reason).toBe("ALREADY_SATISFIED");
    expect(response.status).toBe("ALREADY_SATISFIED");
    expect(response.changes).toEqual([]);
  });
});
