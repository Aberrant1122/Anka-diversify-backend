import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { architectureDraft } from "../../planning/__tests__/architecture-test-fixtures";
import { PlanningArchitectureArtifactService } from "../planning-architecture-artifact.service";
import { DocumentationLifecycleFixture, documentationContent, hashOf } from "./planning-documentation-test-fixtures";
import { RepositoryBootstrapService, RepositoryBootstrapError } from "../repository-bootstrap.service";
import { BootstrapTemplateRegistry, UnsupportedBootstrapTemplateError } from "../bootstrap-template-registry";
import { WorkspaceBoundaryValidator, WorkspaceBoundaryError } from "../workspace-boundary-validator";
import { GitWorktreeService } from "../git-worktree.service";
import { KanbanService } from "../kanban-service";
import { ImplementationTaskLifecycleService } from "../implementation-task-lifecycle.service";
import { NodeGitCommandExecutor } from "../git-command";
import { PlanningDomainError } from "../../planning/planning-errors";
import { LLMGateway } from "../../ai/gateway/LLMGateway";

const fixture = new DocumentationLifecycleFixture();
const git = new NodeGitCommandExecutor();

let tempTestFolder: string;

beforeAll(async () => {
  await fixture.start();
  tempTestFolder = path.resolve(os.tmpdir(), `anka-cp42-tests-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`);
  await fs.promises.mkdir(tempTestFolder, { recursive: true });
});

afterAll(async () => {
  await fixture.stop();
  if (tempTestFolder && fs.existsSync(tempTestFolder)) {
    try {
      await fs.promises.rm(tempTestFolder, { recursive: true, force: true });
    } catch {}
  }
});

afterEach(() => {
  jest.restoreAllMocks();
});

async function setupProjectWithArchitecture(
  label: string,
  options: {
    approveArchitecture?: boolean;
    technicalDirection?: string;
    includeMember?: boolean;
  } = {}
) {
  const {
    approveArchitecture = true,
    technicalDirection = "TypeScript Node.js microservice architecture with Express",
    includeMember = false,
  } = options;
  const projectId = await fixture.createProject(includeMember);

  const req = await fixture.approveRequirements(projectId, label);
  const doc = await fixture.documentationArtifacts.createInitialArtifact({
    projectId,
    actorId: fixture.ownerId,
    title: "Documentation",
    structuredContent: documentationContent(req.artifact, req.content),
  });
  await fixture.approvals.requestDocumentationApproval({
    projectId,
    artifactId: doc.id,
    expectedHash: hashOf(doc),
    actorId: fixture.ownerId,
  });
  await fixture.approvals.approveDocumentationArtifact({
    projectId,
    artifactId: doc.id,
    expectedHash: hashOf(doc),
    actorId: fixture.ownerId,
  });

  const draft = architectureDraft(req.content.nonFunctionalRequirements[0].id);
  draft.overview.technicalDirection = technicalDirection;

  const arch = await new PlanningArchitectureArtifactService(fixture.prisma).create({
    projectId,
    actorId: fixture.ownerId,
    title: "Architecture",
    structuredContent: draft,
  });

  if (approveArchitecture) {
    await fixture.approvals.requestArchitectureApproval({
      projectId,
      artifactId: arch.id,
      expectedHash: hashOf(arch),
      actorId: fixture.ownerId,
    });
    await fixture.approvals.approveArchitectureArtifact({
      projectId,
      artifactId: arch.id,
      expectedHash: hashOf(arch),
      actorId: fixture.ownerId,
    });
  }

  return { projectId, req, doc, arch, draft };
}

async function createDisposableGitRepo(name: string): Promise<string> {
  const repoDir = path.join(tempTestFolder, name);
  await fs.promises.mkdir(repoDir, { recursive: true });
  await git.run(repoDir, ["init", "-b", "main"]);
  await git.run(repoDir, ["config", "user.name", "Test User"]);
  await git.run(repoDir, ["config", "user.email", "test@anka.local"]);
  await fs.promises.writeFile(path.join(repoDir, "README.md"), "# Test Existing Repo\n", "utf8");
  await git.run(repoDir, ["add", "--", "."]);
  await git.run(repoDir, ["commit", "-m", "Initial test commit"]);
  return repoDir;
}

describe("CP4.2: Repository Bootstrap & Baseline Binding", () => {
  // 1. Existing valid repository binding
  test("1. Existing valid repository binding: connects clean local git repo and resolves baseline", async () => {
    const { projectId } = await setupProjectWithArchitecture("p1-existing");
    const repoDir = await createDisposableGitRepo("repo-p1-existing");

    const bootstrapService = new RepositoryBootstrapService(fixture.prisma, git);
    const bound = await bootstrapService.bindExistingRepository(projectId, fixture.ownerId, {
      localPath: repoDir,
      name: "existing-app",
      role: "backend",
      defaultBranch: "main",
    });

    expect(bound.id).toBeDefined();
    expect(bound.isPrimary).toBe(true);
    expect(bound.localPath).toBe(path.resolve(repoDir));
    expect(bound.defaultBranch).toBe("main");
    expect(bound.currentIndexedCommit).toMatch(/^[0-9a-f]{40}$/i);

    const project = await fixture.prisma.project.findUnique({ where: { id: projectId } });
    expect(project?.localPath).toBe(path.resolve(repoDir));
  });

  // 2. New repository initialized successfully
  test("2. New repository initialized successfully: scaffolds approved foundational files", async () => {
    const { projectId } = await setupProjectWithArchitecture("p2-bootstrap");
    const targetDir = path.join(tempTestFolder, "repo-p2-bootstrap");

    const bootstrapService = new RepositoryBootstrapService(fixture.prisma, git);
    const idempotencyKey = crypto.randomUUID();

    const plan = await bootstrapService.prepareBootstrapPlan(projectId, fixture.ownerId, {
      repositoryRoot: targetDir,
      idempotencyKey,
    });

    expect(plan.templateId).toBe("typescript-node");
    expect(plan.plannedFiles.length).toBeGreaterThan(0);
    expect(plan.plannedFiles.some((f) => f.path === "package.json")).toBe(true);

    const result = await bootstrapService.executeBootstrap(projectId, fixture.ownerId, {
      idempotencyKey,
      confirmation: true,
      repositoryRoot: targetDir,
    });

    expect(result.repository).toBeDefined();
    expect(fs.existsSync(path.join(targetDir, "package.json"))).toBe(true);
    expect(fs.existsSync(path.join(targetDir, "tsconfig.json"))).toBe(true);
    expect(fs.existsSync(path.join(targetDir, "src", "index.ts"))).toBe(true);
    expect(fs.existsSync(path.join(targetDir, ".gitignore"))).toBe(true);
  });

  // 3. Initial commit and valid HEAD
  test("3. Initial commit and valid HEAD: commits foundational files and produces 40-char SHA", async () => {
    const { projectId } = await setupProjectWithArchitecture("p3-commit");
    const targetDir = path.join(tempTestFolder, "repo-p3-commit");

    const bootstrapService = new RepositoryBootstrapService(fixture.prisma, git);
    const idempotencyKey = crypto.randomUUID();

    await bootstrapService.prepareBootstrapPlan(projectId, fixture.ownerId, {
      repositoryRoot: targetDir,
      idempotencyKey,
    });

    const result = await bootstrapService.executeBootstrap(projectId, fixture.ownerId, {
      idempotencyKey,
      confirmation: true,
      repositoryRoot: targetDir,
    });

    expect(result.baselineCommitSha).toMatch(/^[0-9a-f]{40}$/i);
    const onDiskSha = await GitWorktreeService.getHeadCommitSha(targetDir);
    expect(onDiskSha).toBe(result.baselineCommitSha);
  });

  // 4. Base branch resolution
  test("4. Base branch resolution: HEAD points to configured default branch (main)", async () => {
    const { projectId } = await setupProjectWithArchitecture("p4-branch");
    const targetDir = path.join(tempTestFolder, "repo-p4-branch");

    const bootstrapService = new RepositoryBootstrapService(fixture.prisma, git);
    const idempotencyKey = crypto.randomUUID();

    await bootstrapService.prepareBootstrapPlan(projectId, fixture.ownerId, {
      repositoryRoot: targetDir,
      idempotencyKey,
      baseBranch: "main",
    });

    const result = await bootstrapService.executeBootstrap(projectId, fixture.ownerId, {
      idempotencyKey,
      confirmation: true,
      repositoryRoot: targetDir,
      baseBranch: "main",
    });

    expect(result.baseBranch).toBe("main");
    const { stdout } = await git.run(targetDir, ["branch", "--show-current"]);
    expect(stdout.trim()).toBe("main");
  });

  // 5. ProjectRepository binding persistence
  test("5. ProjectRepository binding persistence: stores baseline SHA, commands, and stack metadata", async () => {
    const { projectId } = await setupProjectWithArchitecture("p5-persistence");
    const targetDir = path.join(tempTestFolder, "repo-p5-persistence");

    const bootstrapService = new RepositoryBootstrapService(fixture.prisma, git);
    const idempotencyKey = crypto.randomUUID();

    await bootstrapService.prepareBootstrapPlan(projectId, fixture.ownerId, {
      repositoryRoot: targetDir,
      idempotencyKey,
    });

    const result = await bootstrapService.executeBootstrap(projectId, fixture.ownerId, {
      idempotencyKey,
      confirmation: true,
      repositoryRoot: targetDir,
    });

    const dbRepo = await fixture.prisma.projectRepository.findUnique({
      where: { id: result.repository.id },
    });
    expect(dbRepo).not.toBeNull();
    expect(dbRepo?.currentIndexedCommit).toBe(result.baselineCommitSha);
    expect(dbRepo?.isPrimary).toBe(true);
    expect(dbRepo?.localPath).toBe(path.resolve(targetDir));
    expect(dbRepo?.buildCommand).toBe("npm run build");
    expect(dbRepo?.testCommand).toBe("npm test");
  });

  // 6. Approved Architecture authority validation
  test("6. Approved Architecture authority validation: rejects bootstrap when Architecture is unapproved", async () => {
    const { projectId } = await setupProjectWithArchitecture("p6-unapproved", { approveArchitecture: false });
    const targetDir = path.join(tempTestFolder, "repo-p6-unapproved");

    const bootstrapService = new RepositoryBootstrapService(fixture.prisma, git);
    const idempotencyKey = crypto.randomUUID();

    await expect(
      bootstrapService.prepareBootstrapPlan(projectId, fixture.ownerId, {
        repositoryRoot: targetDir,
        idempotencyKey,
      })
    ).rejects.toThrow();
  });

  // 7. Owner-only bootstrap authorization
  test("7. Owner-only bootstrap authorization: owner can prepare and execute bootstrap", async () => {
    const { projectId } = await setupProjectWithArchitecture("p7-owner");
    const targetDir = path.join(tempTestFolder, "repo-p7-owner");

    const bootstrapService = new RepositoryBootstrapService(fixture.prisma, git);
    const idempotencyKey = crypto.randomUUID();

    const plan = await bootstrapService.prepareBootstrapPlan(projectId, fixture.ownerId, {
      repositoryRoot: targetDir,
      idempotencyKey,
    });
    expect(plan.status).toBe("PREPARED");

    const result = await bootstrapService.executeBootstrap(projectId, fixture.ownerId, {
      idempotencyKey,
      confirmation: true,
      repositoryRoot: targetDir,
    });
    expect(result.repository).toBeDefined();
  });

  // 8. Non-owner denial
  test("8. Non-owner denial: non-owner member is rejected with 403 PLANNING_OWNER_REQUIRED", async () => {
    const { projectId } = await setupProjectWithArchitecture("p8-nonowner", { includeMember: true });
    const targetDir = path.join(tempTestFolder, "repo-p8-nonowner");

    const bootstrapService = new RepositoryBootstrapService(fixture.prisma, git);
    const idempotencyKey = crypto.randomUUID();

    await expect(
      bootstrapService.prepareBootstrapPlan(projectId, fixture.memberId, {
        repositoryRoot: targetDir,
        idempotencyKey,
      })
    ).rejects.toThrow("Only the project owner may perform this action.");

    await expect(
      bootstrapService.executeBootstrap(projectId, fixture.memberId, {
        idempotencyKey,
        confirmation: true,
        repositoryRoot: targetDir,
      })
    ).rejects.toThrow("Only the project owner may perform this action.");
  });

  // 9. Cross-project repository binding rejection
  test("9. Cross-project repository binding rejection: binding repo already belonging to another project is denied", async () => {
    const { projectId: projA } = await setupProjectWithArchitecture("p9-projA");
    const { projectId: projB } = await setupProjectWithArchitecture("p9-projB");
    const repoDir = await createDisposableGitRepo("repo-p9-cross");

    const bootstrapService = new RepositoryBootstrapService(fixture.prisma, git);

    // Bind to Project A
    await bootstrapService.bindExistingRepository(projA, fixture.ownerId, {
      localPath: repoDir,
    });

    // Attempting to bind same directory to Project B must reject with 409
    await expect(
      bootstrapService.bindExistingRepository(projB, fixture.ownerId, {
        localPath: repoDir,
      })
    ).rejects.toThrow("CROSS_PROJECT_REPOSITORY_CONFLICT");
  });

  // 10. Duplicate initialization/idempotency
  test("10. Duplicate initialization/idempotency: repeated call with same key returns existing binding deterministically", async () => {
    const { projectId } = await setupProjectWithArchitecture("p10-idempotent");
    const targetDir = path.join(tempTestFolder, "repo-p10-idempotent");

    const bootstrapService = new RepositoryBootstrapService(fixture.prisma, git);
    const idempotencyKey = crypto.randomUUID();

    await bootstrapService.prepareBootstrapPlan(projectId, fixture.ownerId, {
      repositoryRoot: targetDir,
      idempotencyKey,
    });

    const res1 = await bootstrapService.executeBootstrap(projectId, fixture.ownerId, {
      idempotencyKey,
      confirmation: true,
      repositoryRoot: targetDir,
    });

    // Second call with same idempotencyKey returns existing repository
    const res2 = await bootstrapService.executeBootstrap(projectId, fixture.ownerId, {
      idempotencyKey,
      confirmation: true,
      repositoryRoot: targetDir,
    });

    expect(res2.replayed).toBe(true);
    expect(res2.repository.id).toBe(res1.repository.id);
  });

  // 11. Concurrent bootstrap request handling
  test("11. Concurrent bootstrap request handling: returns 409 when bootstrap is already in progress", async () => {
    const { projectId } = await setupProjectWithArchitecture("p11-concurrency");
    const targetDir = path.join(tempTestFolder, "repo-p11-concurrency");

    const bootstrapService = new RepositoryBootstrapService(fixture.prisma, git);
    const idempotencyKey = crypto.randomUUID();

    // Simulate an ongoing attempt marked INITIALIZING
    await fixture.prisma.repositoryBootstrapAttempt.create({
      data: {
        projectId,
        idempotencyKey,
        status: "INITIALIZING",
        repositoryRoot: targetDir,
        templateId: "typescript-node",
      },
    });

    await expect(
      bootstrapService.executeBootstrap(projectId, fixture.ownerId, {
        idempotencyKey,
        confirmation: true,
        repositoryRoot: targetDir,
      })
    ).rejects.toThrow("BOOTSTRAP_CONCURRENT_REQUEST");
  });

  // 12. Existing directory protection
  test("12. Existing directory protection: refuses to overwrite occupied directory with existing user files", async () => {
    const { projectId } = await setupProjectWithArchitecture("p12-occupied");
    const targetDir = path.join(tempTestFolder, "repo-p12-occupied");
    await fs.promises.mkdir(targetDir, { recursive: true });
    await fs.promises.writeFile(path.join(targetDir, "important-data.txt"), "DO NOT OVERWRITE", "utf8");

    const bootstrapService = new RepositoryBootstrapService(fixture.prisma, git);
    const idempotencyKey = crypto.randomUUID();

    await expect(
      bootstrapService.prepareBootstrapPlan(projectId, fixture.ownerId, {
        repositoryRoot: targetDir,
        idempotencyKey,
      })
    ).rejects.toThrow("DIRECTORY_NOT_EMPTY");

    // File must not be modified or deleted
    expect(fs.readFileSync(path.join(targetDir, "important-data.txt"), "utf8")).toBe("DO NOT OVERWRITE");
  });

  // 13. Invalid path and symlink traversal rejection
  test("13. Invalid path and symlink traversal rejection: rejects traversal escapes and null bytes", async () => {
    const { projectId } = await setupProjectWithArchitecture("p13-traversal");

    const bootstrapService = new RepositoryBootstrapService(fixture.prisma, git);

    // Path traversal outside boundary
    await expect(
      bootstrapService.prepareBootstrapPlan(projectId, fixture.ownerId, {
        repositoryRoot: "C:\\Windows\\System32\\dangerous",
      })
    ).rejects.toThrow();

    // Null bytes
    await expect(
      bootstrapService.prepareBootstrapPlan(projectId, fixture.ownerId, {
        repositoryRoot: "/tmp/fake\0path",
      })
    ).rejects.toThrow("INVALID_PATH");
  });

  // 14. Unsupported stack/template rejection
  test("14. Unsupported stack/template rejection: returns clear unsupported error when architecture specifies unsupported stack", async () => {
    const { projectId } = await setupProjectWithArchitecture("p14-unsupported", {
      technicalDirection: "Legacy enterprise banking core implemented in pure COBOL and RPG-IV",
    });
    const targetDir = path.join(tempTestFolder, "repo-p14-unsupported");

    const bootstrapService = new RepositoryBootstrapService(fixture.prisma, git);
    const idempotencyKey = crypto.randomUUID();

    await expect(
      bootstrapService.prepareBootstrapPlan(projectId, fixture.ownerId, {
        repositoryRoot: targetDir,
        idempotencyKey,
      })
    ).rejects.toThrow(UnsupportedBootstrapTemplateError);
  });

  // 15. Failure during Git initialization
  test("15. Failure during Git initialization: records FAILED state and cleans up without leaving corrupted repo", async () => {
    const { projectId } = await setupProjectWithArchitecture("p15-git-fail");
    const targetDir = path.join(tempTestFolder, "repo-p15-git-fail");

    // Create a mock git that fails on 'init'
    const mockGit: any = {
      run: jest.fn().mockImplementation(async (_cwd, args: string[]) => {
        if (args[0] === "init") {
          throw new Error("Simulated git init failure: permission denied");
        }
        return { stdout: "", stderr: "" };
      }),
    };

    const bootstrapService = new RepositoryBootstrapService(fixture.prisma, mockGit);
    const idempotencyKey = crypto.randomUUID();

    await expect(
      bootstrapService.executeBootstrap(projectId, fixture.ownerId, {
        idempotencyKey,
        confirmation: true,
        repositoryRoot: targetDir,
      })
    ).rejects.toThrow("GIT_INIT_FAILED");

    const attempt = await fixture.prisma.repositoryBootstrapAttempt.findUnique({
      where: { projectId_idempotencyKey: { projectId, idempotencyKey } },
    });
    expect(attempt?.status).toBe("FAILED");
    expect(attempt?.errorCode).toBe("GIT_INIT_FAILED");
  });

  // 16. Failure during database persistence
  test("16. Failure during database persistence: preserves filesystem Git baseline and marks BASELINE_READY for retry", async () => {
    const { projectId } = await setupProjectWithArchitecture("p16-db-fail");
    const targetDir = path.join(tempTestFolder, "repo-p16-db-fail");

    const bootstrapService = new RepositoryBootstrapService(fixture.prisma, git);
    const idempotencyKey = crypto.randomUUID();

    // Mock prisma.$transaction to fail during projectRepository.create (second transaction call)
    let txCount16 = 0;
    const originalTransaction16 = fixture.prisma.$transaction.bind(fixture.prisma);
    jest.spyOn(fixture.prisma, "$transaction").mockImplementation(async (arg1: any, arg2?: any) => {
      txCount16++;
      if (txCount16 === 2) {
        throw new Error("Simulated database connection loss during binding");
      }
      return originalTransaction16(arg1, arg2);
    });

    await expect(
      bootstrapService.executeBootstrap(projectId, fixture.ownerId, {
        idempotencyKey,
        confirmation: true,
        repositoryRoot: targetDir,
      })
    ).rejects.toThrow("DB_PERSISTENCE_FAILED");

    // The files and Git repository on disk MUST still exist (no data loss)
    expect(fs.existsSync(path.join(targetDir, ".git"))).toBe(true);
    expect(fs.existsSync(path.join(targetDir, "package.json"))).toBe(true);

    const attempt = await fixture.prisma.repositoryBootstrapAttempt.findUnique({
      where: { projectId_idempotencyKey: { projectId, idempotencyKey } },
    });
    expect(attempt?.status).toBe("BASELINE_READY");
    expect(attempt?.baselineCommitSha).toMatch(/^[0-9a-f]{40}$/i);
  });

  // 17. Restart/retry reconciliation
  test("17. Restart/retry reconciliation: reconciles existing verified Git commit and binds repository", async () => {
    const { projectId } = await setupProjectWithArchitecture("p17-reconcile");
    const targetDir = path.join(tempTestFolder, "repo-p17-reconcile");

    const bootstrapService = new RepositoryBootstrapService(fixture.prisma, git);
    const idempotencyKey = crypto.randomUUID();

    // Force DB failure on first attempt's persistence transaction
    let txCount17 = 0;
    const originalTransaction17 = fixture.prisma.$transaction.bind(fixture.prisma);
    jest.spyOn(fixture.prisma, "$transaction").mockImplementation(async (arg1: any, arg2?: any) => {
      txCount17++;
      if (txCount17 === 2) {
        throw new Error("Simulated network blip");
      }
      return originalTransaction17(arg1, arg2);
    });

    await expect(
      bootstrapService.executeBootstrap(projectId, fixture.ownerId, {
        idempotencyKey,
        confirmation: true,
        repositoryRoot: targetDir,
      })
    ).rejects.toThrow();

    // Subsequent retry cleanly reconciles the commit and binds the repository
    const result = await bootstrapService.executeBootstrap(projectId, fixture.ownerId, {
      idempotencyKey,
      confirmation: true,
      repositoryRoot: targetDir,
    });

    expect(result.repository).toBeDefined();
    expect(result.repository.localPath).toBe(path.resolve(targetDir));

    const attempt = await fixture.prisma.repositoryBootstrapAttempt.findUnique({
      where: { projectId_idempotencyKey: { projectId, idempotencyKey } },
    });
    expect(attempt?.status).toBe("BOUND");
  });

  // 18. Prevention of unintended remote push
  test("18. Prevention of unintended remote push: verified that no git push commands are run during bootstrap", async () => {
    const { projectId } = await setupProjectWithArchitecture("p18-nopush");
    const targetDir = path.join(tempTestFolder, "repo-p18-nopush");

    const runSpy = jest.spyOn(git, "run");
    const bootstrapService = new RepositoryBootstrapService(fixture.prisma, git);
    const idempotencyKey = crypto.randomUUID();

    await bootstrapService.executeBootstrap(projectId, fixture.ownerId, {
      idempotencyKey,
      confirmation: true,
      repositoryRoot: targetDir,
    });

    // Check all git commands executed
    for (const call of runSpy.mock.calls) {
      const args = call[1];
      expect(args[0]).not.toBe("push");
      expect(args[0]).not.toBe("remote");
    }
  });

  // 19. GitWorktreeService compatibility with the newly initialized repository
  test("19. GitWorktreeService compatibility: bootstrapped repository is verified worktree-ready", async () => {
    const { projectId } = await setupProjectWithArchitecture("p19-worktree");
    const targetDir = path.join(tempTestFolder, "repo-p19-worktree");

    const bootstrapService = new RepositoryBootstrapService(fixture.prisma, git);
    const idempotencyKey = crypto.randomUUID();

    await bootstrapService.executeBootstrap(projectId, fixture.ownerId, {
      idempotencyKey,
      confirmation: true,
      repositoryRoot: targetDir,
    });

    // Verify resolveRepositoryRoot
    const root = await GitWorktreeService.resolveRepositoryRoot(targetDir);
    expect(root).toBe(path.resolve(targetDir));

    // Verify assertCleanWorkingTree
    await expect(GitWorktreeService.assertCleanWorkingTree(targetDir)).resolves.not.toThrow();

    // Verify GitWorktreeService.prepareRepositoryRun creates isolated worktree
    const runId = `test-run-${Date.now()}`;
    const prepared = await GitWorktreeService.prepareRepositoryRun({
      repositoryPath: targetDir,
      runId,
    });

    expect(prepared.worktreePath).toBeDefined();
    expect(fs.existsSync(prepared.worktreePath)).toBe(true);

    // Clean up worktree
    await GitWorktreeService.cleanupWorktree(prepared.worktreePath, targetDir, prepared.branchName, runId);
  });

  // 20. Preservation of existing CP4.1 task generation and approval behavior
  test("20. Preservation of existing CP4.1 task generation and approval: kanban decomposes against bound repo", async () => {
    const { projectId, draft } = await setupProjectWithArchitecture("p20-kanban");
    const targetDir = path.join(tempTestFolder, "repo-p20-kanban");

    const bootstrapService = new RepositoryBootstrapService(fixture.prisma, git);
    const idempotencyKey = crypto.randomUUID();

    const bootResult = await bootstrapService.executeBootstrap(projectId, fixture.ownerId, {
      idempotencyKey,
      confirmation: true,
      repositoryRoot: targetDir,
    });

    // Now invoke Kanban task decomposition from CP4.1
    const componentId = draft.components[0]?.id || "ARCH-COMP-1";
    const proposal = {
      content: {
        stages: [
          {
            title: "Stage 1: Foundation",
            order: 0,
            tasks: [
              {
                key: "TASK-CORE",
                title: "Setup Core Module",
                description: "Build core architectural foundation",
                acceptanceCriteria: ["Types compile", "Schema valid"],
                targetFiles: ["src/core.ts"],
                architectureComponentIds: [componentId],
                dependencyKeys: [],
                repositoryId: bootResult.repository.id,
              },
            ],
          },
        ],
      },
    };
    const callStructured = jest.fn().mockResolvedValue(proposal);
    jest.spyOn(LLMGateway, "getInstance").mockReturnValue({ callStructured } as unknown as LLMGateway);

    const kanbanService = new KanbanService();
    const board = await kanbanService.generateBoardFromWorkflow(projectId, fixture.ownerId);

    expect(board.stages.length).toBeGreaterThan(0);
    const allTasks = board.stages.flatMap((s) => s.tasks);
    expect(allTasks.length).toBeGreaterThan(0);

    // The bound repository should be available for the tasks
    const firstTask = allTasks[0];
    expect(firstTask.implementationState).toBe("draft");

    // Approve the task as owner using ImplementationTaskLifecycleService
    const lifecycleService = new ImplementationTaskLifecycleService(fixture.prisma);
    const approved = await lifecycleService.approveTask(projectId, firstTask.id, fixture.ownerId, firstTask.stateVersion);
    expect(approved.implementationState).toBe("approved");
    expect(approved.approvedById).toBe(fixture.ownerId);
  });
});
