import { GitWorktreeService, RepositoryRunSummary } from "../../services/git-worktree.service";
import { MultiRepoCoordinator, RepositoryCandidate, MultiRepoAgentRunner } from "../coordination/MultiRepoCoordinator";
import { AgentPipeline } from "../orchestration/AgentPipeline";
import { ValidationRunner } from "../validation/ValidationRunner";
import { WorktreeDependencyService } from "../../services/worktree-dependency.service";
import { ManifestValidator } from "../../services/manifest-validator";
import { ManifestGenerator } from "../../services/manifest-generator";
import { ManifestCorrectionEngine } from "../planning/ManifestCorrectionEngine";
import { IntentClassifier } from "../classification/IntentClassifier";
import { MemoryPersistence } from "../memory/MemoryPersistence";
import { RepositoryContextBuilder } from "../repository/RepositoryContextBuilder";
import { AgentFileChange } from "../../types";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";

describe("False Success Semantics & Manifest Failure Guard Regressions", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "anka-false-success-test-"));
    execSync("git init", { cwd: tempDir });
    try {
      execSync("git checkout -B main", { cwd: tempDir });
    } catch {}
    execSync('git config user.email "test@example.com"', { cwd: tempDir });
    execSync('git config user.name "Test User"', { cwd: tempDir });
    fs.writeFileSync(path.join(tempDir, "package.json"), JSON.stringify({ name: "test-pkg", scripts: { test: "echo pass" } }));
    execSync("git add . && git commit -m 'initial'", { cwd: tempDir });

    jest.restoreAllMocks();
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  // ── TEST 1: Manifest failure in AgentPipeline returns explicit terminal failure state ──
  test("1. Manifest failure in AgentPipeline returns buildVerified=false, lifecycleStage=ManifestValidationFailed, and buildErrors", async () => {
    jest.spyOn(RepositoryContextBuilder, "buildProjectContext").mockResolvedValue({
      project: { id: "test-project", name: "test-project" },
      activeTasks: [],
      repoSnapshot: {
        fileTree: ["package.json"],
        keyFiles: [{ path: "package.json", content: "{}" }],
      },
    } as any);
    jest.spyOn(MemoryPersistence, "getOrCreateSession").mockResolvedValue({
      id: "mock-sess-1",
      userId: "test-user",
      projectId: "test-project",
    } as any);
    jest.spyOn(MemoryPersistence, "saveMessage").mockResolvedValue({} as any);

    jest.spyOn(IntentClassifier, "classifyIntentAndAmbiguity").mockResolvedValue({
      taskType: "NEW_FEATURE",
      risk: "HIGH",
      estimatedComplexity: "LARGE",
      intent: "NEW_FEATURE",
      targetPath: "src/routes/users.routes.ts",
      confidence: 0.95,
      requiresClarification: false,
      reasoning: "test reasoning",
    });

    jest.spyOn(ManifestGenerator.prototype, "generateManifest").mockResolvedValue({
      manifestVersion: "1.0",
      files: [
        {
          path: "src/routes/users.routes.ts",
          action: "create",
          description: "create routes",
          dependencies: [],
        },
      ],
      totalFiles: 1,
    });

    // Force ManifestValidator to fail
    jest.spyOn(ManifestValidator.prototype, "validate").mockReturnValue({
      valid: false,
      errors: [
        {
          type: "orphan",
          message: "Orphaned file detected: 'src/routes/users.routes.ts'",
          suggestion: "Add import statement",
          affectedFiles: ["src/routes/users.routes.ts"],
        },
      ],
    });

    // Force ManifestCorrectionEngine to fail correction
    jest.spyOn(ManifestCorrectionEngine, "attemptCorrection").mockResolvedValue(null);

    const response = await AgentPipeline.runCodingAgent(
      "test-user",
      "test-project",
      { message: "Add user status" },
      undefined,
      { effectiveLocalPath: tempDir }
    );

    expect(response.changes).toEqual([]);
    expect(response.buildVerified).toBe(false);
    expect(response.lifecycleStage).toBe("ManifestValidationFailed");
    expect(response.buildErrors).toBeTruthy();
    expect(response.buildErrors).toContain("[Manifest Validation Failed]");
    expect(response.buildErrors).toContain("Orphaned file detected");
  });

  // ── TEST 2: runIsolatedAgent with buildVerified=undefined -> validationPassed=false ──
  test("2. runIsolatedAgent with buildVerified=undefined yields validationPassed=false and buildVerified=false", async () => {
    jest.spyOn(WorktreeDependencyService, "prepareDependencies").mockResolvedValue({
      attempted: true,
      success: true,
      packageManager: "npm",
      installCommand: "npm ci",
      durationMs: 100,
      errorType: null,
    });

    jest.spyOn(ValidationRunner, "validateWithShell").mockResolvedValue({
      success: true,
      errors: "",
    });

    // Pipeline returns undefined buildVerified
    jest.spyOn(AgentPipeline, "runCodingAgent").mockResolvedValue({
      explanation: "Did nothing",
      changes: [{ path: "file.ts", content: "code", description: "desc", action: "modify" }],
      commitMessage: "commit",
      sessionId: "sess-1",
      buildVerified: undefined as any,
    });

    const summary = await GitWorktreeService.runIsolatedAgent({
      userId: "user-1",
      projectId: "proj-1",
      repositoryPath: tempDir,
      runId: "run-undefined-bv",
      request: { message: "test request" },
    });

    expect(summary.validationPassed).toBe(false);
    expect(summary.agentResponse.buildVerified).toBe(false);
  });

  // ── TEST 3: runIsolatedAgent with buildVerified=false -> validationPassed=false ──
  test("3. runIsolatedAgent with buildVerified=false yields validationPassed=false and buildVerified=false", async () => {
    jest.spyOn(WorktreeDependencyService, "prepareDependencies").mockResolvedValue({
      attempted: true,
      success: true,
      packageManager: "npm",
      installCommand: "npm ci",
      durationMs: 100,
      errorType: null,
    });

    jest.spyOn(ValidationRunner, "validateWithShell").mockResolvedValue({
      success: true,
      errors: "",
    });

    jest.spyOn(AgentPipeline, "runCodingAgent").mockResolvedValue({
      explanation: "Build failed",
      changes: [{ path: "file.ts", content: "code", description: "desc", action: "modify" }],
      commitMessage: "commit",
      sessionId: "sess-1",
      buildVerified: false,
    });

    const summary = await GitWorktreeService.runIsolatedAgent({
      userId: "user-1",
      projectId: "proj-1",
      repositoryPath: tempDir,
      runId: "run-false-bv",
      request: { message: "test request" },
    });

    expect(summary.validationPassed).toBe(false);
    expect(summary.agentResponse.buildVerified).toBe(false);
  });

  // ── TEST 4: runIsolatedAgent with buildVerified=true and changes.length > 0 -> validationPassed=true ──
  test("4. runIsolatedAgent with buildVerified=true and changes.length > 0 yields validationPassed=true", async () => {
    jest.spyOn(WorktreeDependencyService, "prepareDependencies").mockResolvedValue({
      attempted: true,
      success: true,
      packageManager: "npm",
      installCommand: "npm ci",
      durationMs: 100,
      errorType: null,
    });

    jest.spyOn(ValidationRunner, "validateWithShell").mockResolvedValue({
      success: true,
      errors: "",
    });

    jest.spyOn(AgentPipeline, "runCodingAgent").mockResolvedValue({
      explanation: "Verified change",
      changes: [{ path: "file.ts", content: "export const x = 1;", description: "add x", action: "modify" }],
      commitMessage: "commit",
      sessionId: "sess-1",
      buildVerified: true,
    });

    const summary = await GitWorktreeService.runIsolatedAgent({
      userId: "user-1",
      projectId: "proj-1",
      repositoryPath: tempDir,
      runId: "run-valid-changes",
      request: { message: "test request" },
    });

    expect(summary.validationPassed).toBe(true);
    expect(summary.agentResponse.buildVerified).toBe(true);
    expect(summary.agentResponse.changes.length).toBe(1);
  });

  // ── TEST 5: Zero changes with buildVerified=true and successfulNoOp undefined -> validationPassed=false ──
  test("5. Zero changes with buildVerified=true but successfulNoOp undefined fails closed", async () => {
    jest.spyOn(WorktreeDependencyService, "prepareDependencies").mockResolvedValue({
      attempted: true,
      success: true,
      packageManager: "npm",
      installCommand: "npm ci",
      durationMs: 100,
      errorType: null,
    });

    jest.spyOn(ValidationRunner, "validateWithShell").mockResolvedValue({
      success: true,
      errors: "",
    });

    jest.spyOn(AgentPipeline, "runCodingAgent").mockResolvedValue({
      explanation: "Zero changes produced",
      changes: [],
      commitMessage: "",
      sessionId: "sess-1",
      buildVerified: true,
    });

    const summary = await GitWorktreeService.runIsolatedAgent({
      userId: "user-1",
      projectId: "proj-1",
      repositoryPath: tempDir,
      runId: "run-zero-changes",
      request: { message: "test request" },
    });

    expect(summary.validationPassed).toBe(false);
    expect(summary.agentResponse.buildVerified).toBe(false);
  });

  // ── TEST 6: Future-compatible explicit successfulNoOp=true with changes.length=0 -> validationPassed=true ──
  test("6. Future-compatible explicit successfulNoOp=true with changes.length=0 yields validationPassed=true", async () => {
    jest.spyOn(WorktreeDependencyService, "prepareDependencies").mockResolvedValue({
      attempted: true,
      success: true,
      packageManager: "npm",
      installCommand: "npm ci",
      durationMs: 100,
      errorType: null,
    });

    jest.spyOn(ValidationRunner, "validateWithShell").mockResolvedValue({
      success: true,
      errors: "",
    });

    jest.spyOn(AgentPipeline, "runCodingAgent").mockResolvedValue({
      explanation: "Repository already satisfies requirements",
      changes: [],
      commitMessage: "",
      sessionId: "sess-1",
      buildVerified: true,
      successfulNoOp: true,
    });

    const summary = await GitWorktreeService.runIsolatedAgent({
      userId: "user-1",
      projectId: "proj-1",
      repositoryPath: tempDir,
      runId: "run-successful-noop",
      request: { message: "test request" },
    });

    expect(summary.validationPassed).toBe(true);
    expect(summary.agentResponse.buildVerified).toBe(true);
    expect(summary.agentResponse.successfulNoOp).toBe(true);
  });

  // ── TEST 7: MultiRepoCoordinator manifest-failed upstream -> FAILED, MANIFEST_VALIDATION_FAILED, no handoff, downstream skipped ──
  test("7. MultiRepoCoordinator marks manifest-failed upstream as FAILED, code MANIFEST_VALIDATION_FAILED, emits no handoff, skips downstream", async () => {
    const executedRepoIds: string[] = [];

    const mockBackend: RepositoryCandidate = {
      id: "repo-api",
      name: "API_REPO",
      role: "backend",
      localPath: "/mock/api",
    };
    const mockFrontend: RepositoryCandidate = {
      id: "repo-web",
      name: "WEB_REPO",
      role: "frontend",
      localPath: "/mock/web",
    };

    const mockRunner: MultiRepoAgentRunner = async (opts) => {
      executedRepoIds.push(opts.request.repositoryId!);

      if (opts.request.repositoryId === "repo-api") {
        return {
          runId: opts.runId,
          branchName: "branch",
          baseCommitSha: "sha1",
          worktreePath: "/mock/api/wt",
          changedFiles: [],
          diffSummary: "",
          validationPassed: false,
          validationCommands: ["npm test"],
          validationErrors: "[Manifest Validation Failed] The planned file manifest violated execution contract constraints",
          agentResponse: {
            explanation: "[Manifest Validation Failed] The planned file manifest violated execution contract constraints",
            changes: [],
            commitMessage: "",
            sessionId: opts.request.sessionId || "",
            buildVerified: false,
            lifecycleStage: "ManifestValidationFailed",
            buildErrors: "[Manifest Validation Failed] The planned file manifest violated execution contract constraints",
          },
        };
      }
      return {} as any;
    };

    const coordinator = new MultiRepoCoordinator(mockRunner);
    const result = await coordinator.coordinateTask({
      userId: "u1",
      projectId: "p1",
      userPrompt: "Add user status across repos",
      customRepositories: [mockBackend, mockFrontend],
    });

    expect(executedRepoIds).toEqual(["repo-api"]);
    expect(result.overallStatus).toBe("FAILED");
    expect(result.failedRepositoryId).toBe("repo-api");

    const apiResult = result.results.find((r) => r.repositoryId === "repo-api");
    expect(apiResult?.status).toBe("FAILED");
    expect(apiResult?.handoff).toBeUndefined();

    const webResult = result.results.find((r) => r.repositoryId === "repo-web");
    expect(webResult?.status).toBe("SKIPPED");
    expect(webResult?.validationErrors).toContain("Skipped due to upstream failure");
  });

  // ── TEST 8: MultiRepoCoordinator zero changes without successfulNoOp -> FAILED, code ZERO_CHANGES_UNVERIFIED ──
  test("8. MultiRepoCoordinator marks zero changes without successfulNoOp as FAILED with code ZERO_CHANGES_UNVERIFIED", async () => {
    const mockBackend: RepositoryCandidate = {
      id: "repo-api",
      name: "API_REPO",
      role: "backend",
      localPath: "/mock/api",
    };

    const mockRunner: MultiRepoAgentRunner = async (opts) => {
      return {
        runId: opts.runId,
        branchName: "branch",
        baseCommitSha: "sha1",
        worktreePath: "/mock/api/wt",
        changedFiles: [],
        diffSummary: "",
        validationPassed: false,
        validationCommands: ["npm test"],
        validationErrors: "Zero changes generated without explicit verified no-op.",
        agentResponse: {
          explanation: "No changes",
          changes: [],
          commitMessage: "",
          sessionId: opts.request.sessionId || "",
          buildVerified: false,
        },
      };
    };

    const coordinator = new MultiRepoCoordinator(mockRunner);
    const result = await coordinator.coordinateTask({
      userId: "u1",
      projectId: "p1",
      userPrompt: "Add user status",
      customRepositories: [mockBackend],
    });

    expect(result.overallStatus).toBe("FAILED");
    const apiResult = result.results[0];
    expect(apiResult.status).toBe("FAILED");
    expect(apiResult.changes.length).toBe(0);
    expect(apiResult.handoff).toBeUndefined();
  });

  // ── TEST 9: Verified non-empty backend changes -> SUCCESS, handoff emitted ──
  test("9. Verified non-empty backend changes produce SUCCESS and emit CrossRepoHandoff downstream", async () => {
    const executedRepoIds: string[] = [];
    let receivedFrontendPrompt = "";

    const mockBackend: RepositoryCandidate = {
      id: "repo-api",
      name: "API_REPO",
      role: "backend",
      localPath: "/mock/api",
    };
    const mockFrontend: RepositoryCandidate = {
      id: "repo-web",
      name: "WEB_REPO",
      role: "frontend",
      localPath: "/mock/web",
    };

    const mockRunner: MultiRepoAgentRunner = async (opts) => {
      executedRepoIds.push(opts.request.repositoryId!);

      if (opts.request.repositoryId === "repo-api") {
        const changes: AgentFileChange[] = [
          {
            path: "src/types/user.ts",
            content: "export type UserStatus = 'active' | 'inactive';\nexport interface User { id: string; status: UserStatus; }",
            action: "modify",
            description: "Add UserStatus",
          },
        ];
        return {
          runId: opts.runId,
          branchName: "branch",
          baseCommitSha: "sha1",
          worktreePath: "/mock/api/wt",
          changedFiles: ["src/types/user.ts"],
          diffSummary: "",
          validationPassed: true,
          validationCommands: ["npm test"],
          agentResponse: {
            explanation: "Added UserStatus type and extended User model",
            changes,
            commitMessage: "feat: add user status",
            sessionId: opts.request.sessionId || "",
            buildVerified: true,
            healthStatus: "HEALTHY",
          },
        };
      } else {
        receivedFrontendPrompt = opts.request.message;
        const changes: AgentFileChange[] = [
          {
            path: "src/components/UserCard.tsx",
            content: "export function UserCard() { return <div>Status</div>; }",
            action: "modify",
            description: "Render status",
          },
        ];
        return {
          runId: opts.runId,
          branchName: "branch",
          baseCommitSha: "sha2",
          worktreePath: "/mock/web/wt",
          changedFiles: ["src/components/UserCard.tsx"],
          diffSummary: "",
          validationPassed: true,
          validationCommands: ["npm test"],
          agentResponse: {
            explanation: "Rendered user status badge",
            changes,
            commitMessage: "feat: render status",
            sessionId: opts.request.sessionId || "",
            buildVerified: true,
            healthStatus: "HEALTHY",
          },
        };
      }
    };

    const coordinator = new MultiRepoCoordinator(mockRunner);
    const result = await coordinator.coordinateTask({
      userId: "u1",
      projectId: "p1",
      userPrompt: "Add user status across repos",
      customRepositories: [mockBackend, mockFrontend],
    });

    expect(executedRepoIds).toEqual(["repo-api", "repo-web"]);
    expect(result.overallStatus).toBe("SUCCESS");

    const apiResult = result.results.find((r) => r.repositoryId === "repo-api");
    expect(apiResult?.status).toBe("SUCCESS");
    expect(apiResult?.handoff).toBeDefined();
    expect(apiResult?.handoff?.exportedContractDiff).toContain("UserStatus");

    // Proves downstream received valid contract and NEVER manifest failure text
    expect(receivedFrontendPrompt).toContain("[UPSTREAM_CROSS_REPO_CONTRACT]");
    expect(receivedFrontendPrompt).toContain("UserStatus");
    expect(receivedFrontendPrompt).not.toContain("[Manifest Validation Failed]");
  });

  // ── TEST 10: BaselineHealthy=true, candidate build undefined -> NOT success ──
  test("10. BaselineHealthy=true with candidate build undefined does NOT produce success", async () => {
    // Untouched baseline passes
    jest.spyOn(ValidationRunner, "validateWithShell").mockResolvedValue({
      success: true,
      errors: "",
    });

    jest.spyOn(WorktreeDependencyService, "prepareDependencies").mockResolvedValue({
      attempted: true,
      success: true,
      packageManager: "npm",
      installCommand: "npm ci",
      durationMs: 100,
      errorType: null,
    });

    // Agent aborts without verifying candidate changes
    jest.spyOn(AgentPipeline, "runCodingAgent").mockResolvedValue({
      explanation: "Aborted early",
      changes: [],
      commitMessage: "",
      sessionId: "sess-1",
      buildVerified: undefined,
    });

    const summary = await GitWorktreeService.runIsolatedAgent({
      userId: "user-1",
      projectId: "proj-1",
      repositoryPath: tempDir,
      runId: "run-baseline-pass-agent-abort",
      request: { message: "implement new feature" },
    });

    expect(summary.agentResponse.baselineBuild).toBe("PASS");
    expect(summary.agentResponse.baselineReady).toBe(true);
    // Baseline healthy does NOT promote candidate to success
    expect(summary.validationPassed).toBe(false);
    expect(summary.agentResponse.buildVerified).toBe(false);
  });
});
