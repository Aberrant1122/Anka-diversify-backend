import { architectureDraft } from "../../planning/__tests__/architecture-test-fixtures";
import { LLMGateway } from "../../ai/gateway/LLMGateway";
import { CodingAgent } from "../../ai/application/CodingAgent";
import { MultiRepoAuthorityConflictError, MultiRepoCoordinator, RepositoryCandidate } from "../../ai/coordination/MultiRepoCoordinator";
import { GitWorktreeService, RepositoryRunSummary } from "../git-worktree.service";
import { PlanningArchitectureArtifactService } from "../planning-architecture-artifact.service";
import { KanbanService } from "../kanban-service";
import { PhaseService } from "../phase-service";
import { DocumentationLifecycleFixture, documentationContent, hashOf } from "./planning-documentation-test-fixtures";
import * as implementationAuthority from "../../planning/implementation-authority-preflight";

const fixture = new DocumentationLifecycleFixture();
beforeAll(() => fixture.start());
afterAll(() => fixture.stop());
afterEach(() => jest.restoreAllMocks());

async function setup(label: string, approved: boolean) {
  const projectId = await fixture.createProject();
  const req = await fixture.approveRequirements(projectId, label);
  const doc = await fixture.documentationArtifacts.createInitialArtifact({ projectId, actorId: fixture.ownerId,
    title: "Documentation", structuredContent: documentationContent(req.artifact, req.content) });
  await fixture.approvals.requestDocumentationApproval({ projectId, artifactId: doc.id, expectedHash: hashOf(doc), actorId: fixture.ownerId });
  await fixture.approvals.approveDocumentationArtifact({ projectId, artifactId: doc.id, expectedHash: hashOf(doc), actorId: fixture.ownerId });
  const draft = architectureDraft(req.content.nonFunctionalRequirements[0].id);
  const arch = await new PlanningArchitectureArtifactService(fixture.prisma).create({ projectId, actorId: fixture.ownerId,
    title: "Architecture", structuredContent: draft });
  if (approved) {
    await fixture.approvals.requestArchitectureApproval({ projectId, artifactId: arch.id, expectedHash: hashOf(arch), actorId: fixture.ownerId });
    await fixture.approvals.approveArchitectureArtifact({ projectId, artifactId: arch.id, expectedHash: hashOf(arch), actorId: fixture.ownerId });
  }
  return { projectId, req, doc, arch, draft };
}

const proposal = { content: { stages: [{ title: "Build", order: 0, tasks: [{ title: "Implement", description: "Implement design",
  acceptanceCriteria: ["Verified"], targetFiles: ["src/index.ts"] }] }] } };
const noOpSummary: RepositoryRunSummary = { runId: "mock", branchName: "mock", baseCommitSha: "a".repeat(40),
  worktreePath: "unused", changedFiles: [], diffSummary: "", validationPassed: true, validationCommands: [],
  agentResponse: { explanation: "Verified", changes: [], commitMessage: "", sessionId: "mock", buildVerified: true, successfulNoOp: true } };

async function supersedeArchitecture(data: Awaited<ReturnType<typeof setup>>, label: string) {
  const changed = architectureDraft(data.req.content.nonFunctionalRequirements[0].id);
  changed.overview.approach = label;
  await new PlanningArchitectureArtifactService(fixture.prisma).create({ projectId: data.projectId,
    actorId: fixture.ownerId, title: label, structuredContent: changed,
    baseArtifactId: data.arch.id, baseContentHash: hashOf(data.arch) });
}

function observedSummary(runId: string, path: string): RepositoryRunSummary {
  return { ...noOpSummary, runId, branchName: `branch-${runId}`, changedFiles: [path],
    agentResponse: { ...noOpSummary.agentResponse, changes: [{ path, action: "modify", content: "generated", description: "Observed work" }] } };
}

async function conflictOf(run: Promise<unknown>): Promise<MultiRepoAuthorityConflictError> {
  try {
    await run;
  } catch (error) {
    expect(error).toBeInstanceOf(MultiRepoAuthorityConflictError);
    return error as MultiRepoAuthorityConflictError;
  }
  throw new Error("Expected an authority conflict");
}

async function mockCodingRepository(projectId: string) {
  await fixture.prisma.project.update({ where: { id: projectId }, data: { localPath: process.cwd() } });
  jest.spyOn(GitWorktreeService, "resolveRepositoryRoot").mockResolvedValue(process.cwd());
  jest.spyOn(GitWorktreeService, "getHeadCommitSha").mockResolvedValue("a".repeat(40));
}

describe("Implementation consumers on disposable PostgreSQL", () => {
  test("authorized Kanban generation persists tasks from the exact approved chain", async () => {
    const data = await setup("impl-kanban-success", true);
    const callStructured = jest.fn().mockResolvedValue(proposal);
    jest.spyOn(LLMGateway, "getInstance").mockReturnValue({ callStructured } as unknown as LLMGateway);
    const board = await new KanbanService().generateBoardFromWorkflow(data.projectId, fixture.ownerId);
    expect(board.stages).toHaveLength(1);
    expect(board.stages[0].tasks).toHaveLength(1);
    const prompt = callStructured.mock.calls[0][0].messages[0].content as string;
    expect(prompt).toContain(data.req.artifact.content);
    expect(prompt).toContain(data.doc.content);
    expect(prompt).toContain(data.arch.content);
    expect(await fixture.prisma.kanbanTask.count({ where: { stage: { board: { projectId: data.projectId } } } })).toBe(1);
  });

  test("initial missing authority invokes no Kanban provider, coding Git or multi-repo runner", async () => {
    const data = await setup("impl-reject", false);
    const callStructured = jest.fn().mockResolvedValue(proposal);
    jest.spyOn(LLMGateway, "getInstance").mockReturnValue({ callStructured } as unknown as LLMGateway);
    await expect(new KanbanService().generateBoardFromWorkflow(data.projectId, fixture.ownerId)).rejects.toMatchObject({ code: "PLANNING_ACTION_LOCKED" });
    expect(callStructured).not.toHaveBeenCalled();
    await expect(CodingAgent.runCodingAgent(fixture.ownerId, data.projectId, { message: "Implement" })).rejects.toMatchObject({ code: "PLANNING_ACTION_LOCKED" });
    const runner = jest.fn();
    const repositories: RepositoryCandidate[] = [{ id: "repo", name: "Repo", role: "backend", localPath: "unused" }];
    await expect(new MultiRepoCoordinator().coordinateTask({ userId: fixture.ownerId, projectId: data.projectId,
      userPrompt: "Implement", customRepositories: repositories, agentRunner: runner })).rejects.toMatchObject({ code: "PLANNING_ACTION_LOCKED" });
    expect(runner).not.toHaveBeenCalled();
    expect(await fixture.prisma.kanbanBoard.count({ where: { projectId: data.projectId } })).toBe(0);
  });

  test("single-repository coding passes verified authority to its isolated runner", async () => {
    const data = await setup("impl-coding-positive", true);
    await mockCodingRepository(data.projectId);
    const isolated = jest.spyOn(GitWorktreeService, "runIsolatedAgent").mockResolvedValue(noOpSummary);
    const result = await CodingAgent.runCodingAgent(fixture.ownerId, data.projectId, { message: "Implement" });
    expect(result.successfulNoOp).toBe(true);
    expect(isolated).toHaveBeenCalledTimes(1);
    const accepted = isolated.mock.calls[0][0].implementationAuthority;
    expect(accepted?.architecture.artifact.id).toBe(data.arch.id);
    expect(accepted?.documentation.artifact.id).toBe(data.doc.id);
    expect(accepted?.requirements.artifact.id).toBe(data.req.artifact.id);
    expect(accepted?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    await expect(isolated.mock.calls[0][0].revalidateAuthority?.()).resolves.toBeUndefined();
  });

  test("single-repository coding rejects a generated result after authority changes", async () => {
    const data = await setup("impl-coding-stale", true);
    await mockCodingRepository(data.projectId);
    const isolated = jest.spyOn(GitWorktreeService, "runIsolatedAgent").mockImplementation(async () => {
      const changed = architectureDraft(data.req.content.nonFunctionalRequirements[0].id);
      changed.overview.approach = "Superseding coding authority";
      await new PlanningArchitectureArtifactService(fixture.prisma).create({ projectId: data.projectId,
        actorId: fixture.ownerId, title: "Architecture successor", structuredContent: changed,
        baseArtifactId: data.arch.id, baseContentHash: hashOf(data.arch) });
      return noOpSummary;
    });
    await expect(CodingAgent.runCodingAgent(fixture.ownerId, data.projectId, { message: "Implement" }))
      .rejects.toMatchObject({ code: "PLANNING_ACTION_LOCKED" });
    expect(isolated).toHaveBeenCalledTimes(1);
  });

  test("Kanban uses exact approved artifacts and refuses stale persistence", async () => {
    const data = await setup("impl-kanban", true);
    let release!: (value: typeof proposal) => void;
    const pending = new Promise<typeof proposal>((resolve) => { release = resolve; });
    const callStructured = jest.fn().mockReturnValue(pending);
    jest.spyOn(LLMGateway, "getInstance").mockReturnValue({ callStructured } as unknown as LLMGateway);
    const generation = new KanbanService().generateBoardFromWorkflow(data.projectId, fixture.ownerId);
    for (let attempt = 0; attempt < 100 && callStructured.mock.calls.length === 0; attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(callStructured).toHaveBeenCalledTimes(1);
    const prompt = callStructured.mock.calls[0][0].messages[0].content as string;
    expect(prompt).toContain(data.arch.content);
    const changed = architectureDraft(data.req.content.nonFunctionalRequirements[0].id);
    changed.overview.approach = "Updated Architecture";
    await new PlanningArchitectureArtifactService(fixture.prisma).create({ projectId: data.projectId,
      actorId: fixture.ownerId, title: "Successor", structuredContent: changed,
      baseArtifactId: data.arch.id, baseContentHash: hashOf(data.arch) });
    release(proposal);
    await expect(generation).rejects.toMatchObject({ code: "PLANNING_ACTION_LOCKED" });
    expect(await fixture.prisma.kanbanBoard.count({ where: { projectId: data.projectId } })).toBe(0);
  });

  test("generic phase routes cannot create downstream artifacts or start phases early", async () => {
    const data = await setup("impl-generic", false);
    const phases = new PhaseService(fixture.prisma);
    for (const phase of ["documentation", "implementation", "testing", "review"])
      await expect(phases.startPhase(data.projectId, phase, fixture.ownerId)).rejects.toMatchObject({ code: "PLANNING_ACTION_LOCKED" });
    for (const phase of ["implementation", "testing", "review"])
      await expect(phases.runAutomatedPhase(data.projectId, phase, fixture.ownerId)).rejects.toMatchObject({ code: "PLANNING_ACTION_LOCKED" });
    expect(await fixture.prisma.phaseArtifact.count({ where: { projectId: data.projectId, phase: "implementation" } })).toBe(0);
  });

  test("multi-repo conflict before the first step reports no executed work", async () => {
    const data = await setup("impl-multi-before-first", true);
    const repositories: RepositoryCandidate[] = [
      { id: "repo-api", name: "API", role: "backend", localPath: "unused" },
      { id: "repo-web", name: "Web", role: "frontend", localPath: "unused" },
    ];
    const runner = jest.fn();
    const original = implementationAuthority.assertImplementationAuthorityCurrent;
    jest.spyOn(implementationAuthority, "assertImplementationAuthorityCurrent").mockImplementation(async (client, accepted) => {
      await supersedeArchitecture(data, "Changed before first step");
      return original(client, accepted);
    });
    const error = await conflictOf(new MultiRepoCoordinator().coordinateTask({ userId: fixture.ownerId,
      projectId: data.projectId, userPrompt: "Implement", customRepositories: repositories, agentRunner: runner,
    }));
    expect(runner).not.toHaveBeenCalled();
    expect(error.partialResult).toMatchObject({ overallStatus: "AUTHORITY_CONFLICT", authorityCurrent: false,
      changes: [], results: [{ status: "REJECTED", sideEffects: { status: "NOT_EXECUTED" } },
        { status: "SKIPPED", sideEffects: { status: "NOT_EXECUTED" } }] });
  });

  test("multi-repo conflict reports completed, rejected, and unexecuted steps", async () => {
    const data = await setup("impl-multi-stale", true);
    const repositories: RepositoryCandidate[] = [
      { id: "repo-api", name: "API", role: "backend", localPath: "unused" },
      { id: "repo-web", name: "Web", role: "frontend", localPath: "unused" },
      { id: "repo-doc", name: "Docs", role: "documentation", localPath: "unused" },
    ];
    const calls: string[] = [];
    const runner = jest.fn(async (options: { request: { repositoryId?: string } }): Promise<RepositoryRunSummary> => {
      calls.push(options.request.repositoryId!);
      if (calls.length === 2) await supersedeArchitecture(data, "Changed during second step");
      return observedSummary(`run-${calls.length}`, `src/${calls.length}.ts`);
    });
    const error = await conflictOf(new MultiRepoCoordinator().coordinateTask({ userId: fixture.ownerId,
      projectId: data.projectId, userPrompt: "Implement", customRepositories: repositories, agentRunner: runner }));
    expect(error.code).toBe("PLANNING_ACTION_LOCKED");
    expect(calls).toEqual(["repo-api", "repo-web"]);
    expect(error.partialResult.changes).toEqual([]);
    expect(error.partialResult.results).toMatchObject([
      { repositoryId: "repo-api", status: "SUCCESS", runId: "run-1", branchName: "branch-run-1",
        observedChangedFiles: ["src/1.ts"], changes: [], sideEffects: { status: "UNKNOWN" } },
      { repositoryId: "repo-web", status: "REJECTED", runId: "run-2",
        observedChangedFiles: ["src/2.ts"], changes: [], sideEffects: { status: "UNKNOWN" } },
      { repositoryId: "repo-doc", status: "SKIPPED", changes: [], sideEffects: { status: "NOT_EXECUTED" } },
    ]);
  });

  test("final revalidation retains completed steps and reported Git evidence", async () => {
    const data = await setup("impl-multi-final", true);
    const repositories: RepositoryCandidate[] = [{ id: "repo-api", name: "API", role: "backend", localPath: "unused" }];
    const runner = jest.fn(async (): Promise<RepositoryRunSummary> => ({ ...observedSummary("run-final", "src/final.ts"),
      shipping: { baseRevision: "a".repeat(40), taskHeadRevision: "a".repeat(40), finalVerifiedRevision: "b".repeat(40),
        taskBranch: "task", commitCreated: true, commitSha: "b".repeat(40), changedPaths: ["src/final.ts"],
        pushed: false, ciStatus: "NOT_REQUESTED" } }));
    const original = implementationAuthority.assertImplementationAuthorityCurrent;
    let checks = 0;
    jest.spyOn(implementationAuthority, "assertImplementationAuthorityCurrent").mockImplementation(async (client, accepted) => {
      checks += 1;
      if (checks === 3) await supersedeArchitecture(data, "Changed before final revalidation");
      return original(client, accepted);
    });
    const error = await conflictOf(new MultiRepoCoordinator().coordinateTask({ userId: fixture.ownerId,
      projectId: data.projectId, userPrompt: "Implement", customRepositories: repositories, agentRunner: runner,
    }));
    expect(checks).toBe(3);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(error.partialResult.results).toMatchObject([{ status: "SUCCESS", runId: "run-final",
      observedChangedFiles: ["src/final.ts"], sideEffects: { status: "REPORTED",
        git: { commitCreated: true, commitSha: "b".repeat(40), pushed: false } } }]);
    expect(error.partialResult.authorityCurrent).toBe(false);
    expect(error.partialResult.changes).toEqual([]);
  });

  test("unauthorized project actor receives no partial execution information", async () => {
    const data = await setup("impl-multi-unauthorized", true);
    const runner = jest.fn();
    try {
      await new MultiRepoCoordinator().coordinateTask({ userId: fixture.outsiderId, projectId: data.projectId,
        userPrompt: "Implement", customRepositories: [{ id: "repo-api", name: "API", role: "backend", localPath: "unused" }],
        agentRunner: runner });
      throw new Error("Expected authorization rejection");
    } catch (error) {
      expect(error).toMatchObject({ code: "PLANNING_PROJECT_NOT_FOUND" });
      expect(error).not.toHaveProperty("partialResult");
    }
    expect(runner).not.toHaveBeenCalled();
  });
});
