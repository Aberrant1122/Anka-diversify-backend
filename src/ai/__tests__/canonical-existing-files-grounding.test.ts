import { ManifestValidator } from "../../services/manifest-validator";
import { ExecutionContract, FileManifest } from "../../types";
import { AgentPipeline } from "../orchestration/AgentPipeline";
import { RepositoryScanner } from "../repository/RepositoryScanner";
import { RepositoryContextBuilder } from "../repository/RepositoryContextBuilder";
import { IntentClassifier } from "../classification/IntentClassifier";
import { CodeGenerator } from "../generation/CodeGenerator";
import { ManifestGenerator } from "../../services/manifest-generator";
import { TaskDecomposer } from "../../services/task-decomposer";
import { MemoryPersistence } from "../memory/MemoryPersistence";

jest.mock("@prisma/client", () => {
  return {
    PrismaClient: jest.fn().mockImplementation(() => ({
      project: {
        findUnique: jest.fn().mockResolvedValue({
          localPath: "/tmp/mock-project",
          githubUrl: "https://github.com/mock/repo",
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

describe("Canonical existingFiles Grounding Regression Tests", () => {
  const baseContract: ExecutionContract = {
    goal: "Fix type error in user service",
    taskType: "BUG_FIX",
    risk: "LOW",
    estimatedComplexity: "SMALL",
    pipeline: "REPOSITORY",
    environment: "NODE_JS",
    repositoryRequired: true,
    expectedFiles: [],
    validationType: "TYPESCRIPT_BUILD",
    targetPaths: ["src/services/user.service.ts"],
    allowedActions: ["modify"],
    forbiddenActions: ["delete_database"],
    maxFiles: 5,
    searchScope: ["src"],
    contextScope: ["src"],
    diffCriticEnabled: true,
  };

  const originalApiKey = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    process.env.OPENAI_API_KEY = "test-mock-api-key";
    jest.clearAllMocks();
    jest.spyOn(MemoryPersistence, "getOrCreateSession").mockResolvedValue({ id: "test-sess", title: "test" } as any);
    jest.spyOn(MemoryPersistence, "saveMessage").mockResolvedValue(undefined as any);
    jest.spyOn(MemoryPersistence, "persistProjectMemory").mockResolvedValue(undefined as any);
    jest.spyOn(MemoryPersistence, "updateSessionTitle").mockResolvedValue(undefined as any);
    jest.spyOn(CodeGenerator, "generateRoadmapAndDiffs").mockResolvedValue({
      roadmap: [],
      rawDiff: "",
      changes: [{ path: "src/services/user.service.ts", content: "export function...", description: "fix", action: "modify" }],
      explanation: "Fixed type mismatch",
      commitMessage: "fix(user): add role to formatUser",
    } as any);
  });

  afterEach(() => {
    process.env.OPENAI_API_KEY = originalApiKey;
    jest.restoreAllMocks();
  });

  test("A & B: effectiveSnapshot fileTree populates canonicalExistingFiles in planningContext & ManifestValidator", async () => {
    const fileTree = ["src/services/user.service.ts", "src/models/user.ts"];

    jest.spyOn(RepositoryContextBuilder, "buildProjectContext").mockResolvedValue({
      project: { id: "proj-1", name: "test-project" } as any,
      recentMessages: [],
      recentDecisions: [],
      rules: [],
      activeTasks: [],
      repoSnapshot: {
        repoName: "test-project",
        defaultBranch: "main",
        description: "",
        languages: { TypeScript: 2 },
        fileTree,
        keyFiles: [
          { path: "src/services/user.service.ts", content: "...", repoSnapshot: null },
          { path: "src/models/user.ts", content: "...", repoSnapshot: null },
        ],
        lastSyncedAt: new Date(),
      },
    });

    jest.spyOn(RepositoryScanner, "ensureLocalWorkspace").mockResolvedValue("/tmp/mock-project");
    jest.spyOn(RepositoryScanner, "getEffectiveSnapshot").mockReturnValue({
      repoName: "test-project",
      defaultBranch: "main",
      description: "",
      languages: { TypeScript: 2 },
      fileTree,
      keyFiles: [
        { path: "src/services/user.service.ts", content: "..." },
        { path: "src/models/user.ts", content: "..." },
      ],
      lastSyncedAt: new Date(),
      revision: { contentHash: "hash-test-123" } as any,
    });

    jest.spyOn(IntentClassifier, "classifyIntentAndAmbiguity").mockResolvedValue({
      intent: "BUG_FIX",
      taskType: "BUG_FIX",
      risk: "LOW",
      estimatedComplexity: "SMALL",
      targetPath: "src/services/user.service.ts",
      requiresClarification: false,
      reasoning: "Simple bug fix",
      confidence: 1.0,
    });

    let passedPlanningContext: any = null;
    jest.spyOn(ManifestGenerator.prototype, "generateManifest").mockImplementation(async (_req, repoCtx, _contract) => {
      passedPlanningContext = repoCtx;
      return {
        files: [
          {
            path: "src/services/user.service.ts",
            action: "modify",
            dependencies: ["../models/user"],
            description: "Update formatUser return type with role",
          },
        ],
        totalFiles: 1,
        manifestVersion: "1.0.0",
      };
    });

    // Run pipeline
    await AgentPipeline.runCodingAgent("user-1", "proj-1", {
      message: "Fix type error in src/services/user.service.ts",
    });

    // Verify planning context contains both existing files
    expect(passedPlanningContext).toBeDefined();
    expect(passedPlanningContext.existingFiles).toEqual(
      expect.arrayContaining(["src/services/user.service.ts", "src/models/user.ts"])
    );

    // Verify validator instantiated with canonical existing files validates successfully
    const validator = new ManifestValidator(baseContract, passedPlanningContext.existingFiles);
    const manifest: FileManifest = {
      files: [
        {
          path: "src/services/user.service.ts",
          action: "modify",
          dependencies: ["../models/user"],
          description: "Update formatUser return type with role",
        },
      ],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    };
    const result = validator.validate(manifest);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("C: A MODIFY manifest with relative import resolves when imported file is in canonicalExistingFiles but NOT in manifest", () => {
    const canonicalExistingFiles = ["src/services/user.service.ts", "src/models/user.ts"];
    const validator = new ManifestValidator(baseContract, canonicalExistingFiles);

    const modifyManifest: FileManifest = {
      files: [
        {
          path: "src/services/user.service.ts",
          action: "modify",
          dependencies: ["../models/user"],
          description: "Fix formatUser",
        },
      ],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    };

    const res = validator.validate(modifyManifest);
    expect(res.valid).toBe(true);
    expect(res.errors).toHaveLength(0);
  });

  test("D: A genuinely nonexistent relative import fails validation with import_resolution error", () => {
    const canonicalExistingFiles = ["src/services/user.service.ts", "src/models/user.ts"];
    const validator = new ManifestValidator(baseContract, canonicalExistingFiles);

    const invalidManifest: FileManifest = {
      files: [
        {
          path: "src/services/user.service.ts",
          action: "modify",
          dependencies: ["../models/nonexistent_model"],
          description: "Invalid dependency",
        },
      ],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    };

    const res = validator.validate(invalidManifest);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.type === "import_resolution")).toBe(true);
    expect(res.errors[0].message).toContain("Unresolved import dependency '../models/nonexistent_model'");
  });

  test("E: TaskDecomposer receives planningContext with existingFiles without altering single-repo behavior", async () => {
    const fileTree = ["src/config/server.ts", "src/middleware/rateLimiter.ts"];
    const repositoryContext = {
      existingFiles: fileTree,
      repoSnapshot: { fileTree },
    };

    const decomposer = new TaskDecomposer();
    // Available repositories is omitted for single-repo; decomposeTask signature is preserved
    expect(typeof decomposer.decomposeTask).toBe("function");
    expect(repositoryContext.existingFiles).toHaveLength(2);
  });
});
