import fs from "fs";
import path from "path";

const mockProjectFindUnique = jest.fn();
const mockPhaseArtifactFindFirst = jest.fn();

jest.mock("@prisma/client", () => ({
  PrismaClient: jest.fn(() => ({
    project: { findUnique: mockProjectFindUnique },
    phaseArtifact: { findFirst: mockPhaseArtifactFindFirst },
  })),
}));

import { AgentPipeline } from "../orchestration/AgentPipeline";
import { AgentPlanner } from "../orchestration/AgentPlanner";
import { RepositoryObserver } from "../orchestration/RepositoryObserver";
import { ValidationCoordinator } from "../orchestration/ValidationCoordinator";
import { RepositoryContextBuilder } from "../repository/RepositoryContextBuilder";
import { RepositoryScanner } from "../repository/RepositoryScanner";
import { MonorepoDescriptor, MonorepoDetector } from "../workspace/MonorepoDetector";
import { IntentClassifier } from "../classification/IntentClassifier";
import { TaskClassificationResult } from "../classification/TaskTypes";
import { ProjectContext } from "../shared/types";
import { RepositorySnapshotData } from "../repository/RepositorySnapshot";
import { TaskExecutionPlan } from "../shared/TaskExecutionPlan";
import { ValidationPlanner } from "../validation/ValidationPlanner";
import { StageExecutionTransaction } from "../orchestration/StageExecutionTransaction";
import { SelfHealingEngine } from "../repair/SelfHealingEngine";
import { SecurityAuditor } from "../review/SecurityAuditor";
import { ValidationDetector } from "../validation/ValidationDetector";
import { MemoryPersistence } from "../memory/MemoryPersistence";

function projectContext(snapshot?: RepositorySnapshotData): ProjectContext {
  return {
    project: { id: "project-1" },
    recentMessages: [],
    recentDecisions: [],
    rules: [],
    activeTasks: [],
    ...(snapshot ? { repoSnapshot: snapshot } : {}),
  } as unknown as ProjectContext;
}

function repositorySnapshot(): RepositorySnapshotData {
  return {
    repoName: "fixture",
    defaultBranch: "main",
    description: "",
    languages: { TypeScript: 1 },
    fileTree: ["src/index.ts"],
    keyFiles: [{ path: "src/index.ts", content: "export const value = 1;" }],
    lastSyncedAt: new Date("2026-09-10T00:00:00.000Z"),
    revision: {
      contentHash: "revision-1",
      fileCount: 1,
      generatedAt: new Date("2026-09-10T00:00:00.000Z"),
    },
  };
}

function monorepoDescriptor(): MonorepoDescriptor {
  return {
    isMonorepo: false,
    type: "none",
    packageManager: "npm",
    rootPath: "C:\\fixture",
    hasTurbo: false,
    workspaces: [],
    packageByPath: new Map(),
    packageByName: new Map(),
    packageDependencies: new Map(),
    packageDependents: new Map(),
  };
}

function classification(overrides: Partial<TaskClassificationResult> = {}): TaskClassificationResult {
  return {
    taskType: "BUG_FIX",
    risk: "LOW",
    estimatedComplexity: "SMALL",
    intent: "BUG_FIX",
    confidence: 0.9,
    requiresClarification: false,
    reasoning: "typed plan",
    ...overrides,
  };
}

describe("Checkpoint 4 AgentPipeline decomposition", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    mockProjectFindUnique.mockReset();
    mockPhaseArtifactFindFirst.mockReset();
  });

  test("RepositoryObserver returns normalized materialized repository facts", async () => {
    const snapshot = repositorySnapshot();
    mockProjectFindUnique.mockResolvedValue({ localPath: "C:\\fixture", githubUrl: null, githubToken: null });
    mockPhaseArtifactFindFirst.mockResolvedValue({ content: "approved architecture" });
    jest.spyOn(RepositoryContextBuilder, "buildProjectContext").mockResolvedValue(projectContext(snapshot));
    jest.spyOn(RepositoryScanner, "ensureLocalWorkspace").mockResolvedValue("C:\\fixture");
    jest.spyOn(RepositoryScanner, "getEffectiveSnapshot").mockReturnValue(snapshot);
    jest.spyOn(MonorepoDetector, "detectMonorepo").mockReturnValue(monorepoDescriptor());

    const facts = await RepositoryObserver.loadProjectFacts("project-1");
    const result = await RepositoryObserver.observe("project-1", { message: "fix it" }, facts);

    expect(result.effectiveLocalPath).toBe("C:\\fixture");
    expect(result.currentRevisionHash).toBe("revision-1");
    expect(result.canonicalExistingFiles).toEqual(["src/index.ts"]);
    expect(result.approvedArchitecture?.content).toBe("approved architecture");
  });

  test("AgentPlanner produces and activates a typed execution stage", async () => {
    jest.spyOn(IntentClassifier, "classifyIntentAndAmbiguity").mockResolvedValue(classification());

    const result = await AgentPlanner.plan({
      request: { message: "fix src/index.ts" },
      projectContext: projectContext(),
      canonicalExistingFiles: ["src/index.ts"],
    });

    expect(result.taskExecutionPlan?.stages).toHaveLength(1);
    expect(result.activeStage?.status).toBe("RUNNING");
    expect(result.failedOrPendingDependencies).toEqual([]);
  });

  test("AgentPlanner preserves the existing fail-closed gate for a non-pending stage", async () => {
    jest.spyOn(IntentClassifier, "classifyIntentAndAmbiguity").mockResolvedValue(classification());
    const existingPlan: TaskExecutionPlan = {
      id: "plan-complete",
      goal: "fix it",
      currentStageIndex: 0,
      status: "COMPLETED",
      stages: [{
        id: "stage-1",
        name: "done",
        dependsOn: [],
        status: "VERIFIED",
        intent: {
          goal: "fix it",
          taskType: "BUG_FIX",
          risk: "LOW",
          estimatedComplexity: "SMALL",
          operations: [],
          constraints: [],
          acceptanceCriteria: [],
          destructive: false,
          requiresClarification: false,
          explicitUserPaths: [],
        },
      }],
    };

    const result = await AgentPlanner.plan({
      request: { message: "fix it", context: { taskExecutionPlan: existingPlan } },
      projectContext: projectContext(),
      canonicalExistingFiles: [],
    });

    expect(result.status).toBe("READY");
    expect(result.stageDependencyViolation).toBe(true);
    expect(result.activeStage?.status).toBe("VERIFIED");
  });

  test("ValidationCoordinator commits only after deterministic validation gates pass", async () => {
    const snapshot = repositorySnapshot();
    const plan: TaskExecutionPlan = {
      id: "plan-1",
      goal: "fix it",
      currentStageIndex: 0,
      status: "PENDING",
      stages: [{
        id: "stage-1",
        name: "fix",
        dependsOn: [],
        status: "RUNNING",
        intent: {
          goal: "fix it",
          taskType: "BUG_FIX",
          risk: "LOW",
          estimatedComplexity: "SMALL",
          operations: [],
          constraints: [],
          acceptanceCriteria: [],
          destructive: false,
          requiresClarification: false,
          explicitUserPaths: [],
        },
      }],
    };
    const fsManager = {
      snapshot: jest.fn().mockResolvedValue(undefined),
      getOriginalContent: jest.fn(),
      hasOriginalFile: jest.fn().mockReturnValue(false),
    };
    const transaction = {
      checkpointId: "checkpoint-1",
      fsManager,
      localPath: "C:\\fixture",
      snapshot: jest.fn().mockResolvedValue(undefined),
      apply: jest.fn().mockResolvedValue(undefined),
      getExecutedMutations: jest.fn().mockReturnValue([
        { path: "src/index.ts", action: "FILE_MODIFY", content: "export const value = 2;" },
      ]),
      commit: jest.fn().mockResolvedValue(undefined),
      rollback: jest.fn().mockResolvedValue(undefined),
    } as unknown as StageExecutionTransaction;
    jest.spyOn(ValidationPlanner, "detectValidationCommands").mockReturnValue(["npx tsc --noEmit"]);
    jest.spyOn(StageExecutionTransaction, "startTransaction").mockResolvedValue(transaction);
    jest.spyOn(SelfHealingEngine, "runSelfHealingLoop").mockResolvedValue({
      finalChanges: [{ path: "src/index.ts", content: "export const value = 2;", action: "modify", description: "fix" }],
      attempts: 1,
      success: true,
      taskVerified: true,
      repositoryClean: true,
    });
    jest.spyOn(SecurityAuditor, "runReflectionAndSecurityAudit").mockResolvedValue({
      approvedChanges: [],
      passed: true,
      critiqueScore: 100,
      securityPass: true,
      summary: "safe",
    });
    jest.spyOn(ValidationDetector, "runFeatureValidation").mockResolvedValue({
      overallPassed: true,
      checks: [],
      failedChecks: [],
      repairActions: [],
    });

    const result = await ValidationCoordinator.validate({
      acceptedChanges: [{ path: "src/index.ts", content: "export const value = 2;", action: "modify", description: "fix" }],
      effectiveLocalPath: "C:\\fixture",
      effectiveSnapshot: snapshot,
      executionContract: {
        goal: "fix it",
        taskType: "BUG_FIX",
        risk: "LOW",
        estimatedComplexity: "SMALL",
        pipeline: "REPOSITORY",
        environment: "NODE_JS",
        repositoryRequired: true,
        expectedFiles: [],
        validationType: "TYPESCRIPT_BUILD",
        targetPaths: ["src/index.ts"],
        contextScope: ["src/index.ts"],
        searchScope: [],
        allowedActions: ["MODIFY"],
        forbiddenActions: [],
        maxFiles: 1,
        diffCriticEnabled: true,
        targetProvenance: {},
      },
      monorepo: monorepoDescriptor(),
      activeStageId: "stage-1",
      taskExecutionPlan: plan,
      systemPrompt: "system",
      requestMessage: "fix it",
      projectId: "project-1",
      approvedManifest: null,
    });

    expect(result.gateSuccess).toBe(true);
    expect(result.isBuildVerified).toBe(true);
    expect(result.taskExecutionPlan.stages[0].status).toBe("VERIFIED");
    expect(transaction.commit).toHaveBeenCalledTimes(1);
    expect(transaction.rollback).not.toHaveBeenCalled();
  });

  test("production AgentPipeline delegates observation and planning without changing technical-failure behavior", async () => {
    const snapshot = repositorySnapshot();
    jest.spyOn(MemoryPersistence, "getOrCreateSession").mockResolvedValue({ id: "session-1" } as never);
    const saveMessage = jest.spyOn(MemoryPersistence, "saveMessage").mockResolvedValue(undefined);
    jest.spyOn(RepositoryObserver, "loadProjectFacts").mockResolvedValue({
      projectContext: projectContext(snapshot),
      project: { localPath: "C:\\fixture", githubUrl: null, githubToken: null },
      approvedArchitecture: null,
      snapshot: snapshot as unknown as ProjectContext["repoSnapshot"],
    });
    const observeSpy = jest.spyOn(RepositoryObserver, "observe").mockResolvedValue({
      projectContext: projectContext(snapshot),
      project: { localPath: "C:\\fixture", githubUrl: null, githubToken: null },
      approvedArchitecture: null,
      snapshot: snapshot as unknown as ProjectContext["repoSnapshot"],
      effectiveLocalPath: "C:\\fixture",
      effectiveSnapshot: snapshot,
      currentRevisionHash: "revision-1",
      snapshotFileList: snapshot.keyFiles,
      repoFileNames: ["src/index.ts"],
      canonicalExistingFiles: ["src/index.ts"],
      monorepo: monorepoDescriptor(),
    });
    jest.spyOn(IntentClassifier, "classifyIntentAndAmbiguity").mockResolvedValue(classification({
      intent: "CLASSIFICATION_FAILED",
      outcome: "TECHNICAL_FAILURE",
      reasoning: "provider unavailable",
    }));

    const result = await AgentPipeline.runCodingAgent("user-1", "project-1", { message: "fix it" });

    expect(observeSpy).toHaveBeenCalledTimes(1);
    expect(saveMessage.mock.calls.map((call) => call[1])).toEqual(["user", "assistant"]);
    expect(result.errorCode).toBe("TECHNICAL_FAILURE");
    expect(result.changes).toEqual([]);
  });

  test("AgentPipeline orchestrates observation and manifest planning without retaining their implementations", () => {
    const pipelineSource = fs.readFileSync(
      path.join(__dirname, "..", "orchestration", "AgentPipeline.ts"),
      "utf8",
    );

    expect(pipelineSource).toContain("RepositoryObserver.assembleContext({");
    expect(pipelineSource).toContain("AgentPlanner.planManifest({");
    expect(pipelineSource).not.toContain("RepositorySearch.runIterativeRepositorySearch(");
    expect(pipelineSource).not.toContain("new SemanticRetrievalEngine(");
    expect(pipelineSource).not.toContain("new ManifestGenerator(");
    expect(pipelineSource).not.toContain("ManifestCorrectionEngine.attemptCorrection(");
    expect(pipelineSource).not.toContain("new ManifestValidator(");
  });
});
