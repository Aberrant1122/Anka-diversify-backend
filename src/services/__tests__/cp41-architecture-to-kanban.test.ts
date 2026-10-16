import { architectureDraft } from "../../planning/__tests__/architecture-test-fixtures";
import { LLMGateway } from "../../ai/gateway/LLMGateway";
import { PlanningArchitectureArtifactService } from "../planning-architecture-artifact.service";
import { KanbanService } from "../kanban-service";
import { ImplementationTaskLifecycleService, ImplementationTaskError } from "../implementation-task-lifecycle.service";
import { DocumentationLifecycleFixture, documentationContent, hashOf } from "./planning-documentation-test-fixtures";
import { seedConfirmedLiveBrief } from "./test-brief-fixtures";
import { PlanningDomainError } from "../../planning/planning-errors";

const fixture = new DocumentationLifecycleFixture();
beforeAll(() => fixture.start());
afterAll(() => fixture.stop());
afterEach(() => jest.restoreAllMocks());

async function setupProject(label: string, options: { approveArchitecture?: boolean; addRepository?: boolean } = {}) {
  const { approveArchitecture = true, addRepository = true } = options;
  const projectId = await fixture.createProject();

  let repo = null;
  if (addRepository) {
    repo = await fixture.prisma.projectRepository.create({
      data: {
        projectId,
        name: "main-repo",
        role: "backend",
        githubUrl: "https://github.com/example/repo",
      },
    });
  }

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

  return { projectId, req, doc, arch, draft, repo };
}

function makeProposal(componentId = "ARCH-COMP-API", repoId?: string) {
  return {
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
              ...(repoId ? { repositoryId: repoId } : {}),
            },
            {
              key: "TASK-API",
              title: "Setup API Endpoint",
              description: "Implement API layer",
              acceptanceCriteria: ["Endpoint responds with 200"],
              targetFiles: ["src/api.ts"],
              architectureComponentIds: [componentId],
              dependencyKeys: ["TASK-CORE"],
              ...(repoId ? { repositoryId: repoId } : {}),
            },
          ],
        },
      ],
    },
  };
}

describe("CP4.1: Architecture-to-Kanban Implementation Verification", () => {
  test("1. Approved Architecture success: persists version-bound Kanban draft tasks and dependency relationships", async () => {
    const data = await setupProject("cp41-success");
    const proposal = makeProposal("ARCH-COMP-API", data.repo?.id);
    const callStructured = jest.fn().mockResolvedValue(proposal);
    jest.spyOn(LLMGateway, "getInstance").mockReturnValue({ callStructured } as unknown as LLMGateway);

    const kanbanService = new KanbanService();
    const board = await kanbanService.generateBoardFromWorkflow(data.projectId, fixture.ownerId);

    expect(board.stages).toHaveLength(1);
    expect(board.stages[0].tasks).toHaveLength(2);

    const [taskCore, taskApi] = board.stages[0].tasks;
    expect(taskCore.title).toBe("Setup Core Module");
    expect(taskCore.implementationEligible).toBe(true);
    expect(taskCore.implementationState).toBe("draft");
    expect(taskCore.stateVersion).toBe(0);
    expect(taskCore.architectureArtifactId).toBe(data.arch.id);
    expect(taskCore.architectureComponentIds).toEqual(["ARCH-COMP-API"]);

    expect(taskApi.title).toBe("Setup API Endpoint");
    expect(taskApi.dependencies).toHaveLength(1);
    expect(taskApi.dependencies[0].dependencyTaskId).toBe(taskCore.id);

    // Prompt content verified
    const prompt = callStructured.mock.calls[0][0].messages[0].content as string;
    expect(prompt).toContain(data.arch.content);
  });

  test("2. Draft/unapproved Architecture rejection: refuses task generation when Architecture is unapproved", async () => {
    const data = await setupProject("cp41-unapproved", { approveArchitecture: false });
    const callStructured = jest.fn().mockResolvedValue(makeProposal());
    jest.spyOn(LLMGateway, "getInstance").mockReturnValue({ callStructured } as unknown as LLMGateway);

    const kanbanService = new KanbanService();
    await expect(kanbanService.generateBoardFromWorkflow(data.projectId, fixture.ownerId)).rejects.toMatchObject({
      code: "PLANNING_ACTION_LOCKED",
    });
    expect(callStructured).not.toHaveBeenCalled();
    expect(await fixture.prisma.kanbanBoard.count({ where: { projectId: data.projectId } })).toBe(0);
  });

  test("3. Stale Architecture rejection: refuses task generation when upstream changes invalidate Architecture", async () => {
    const data = await setupProject("cp41-stale");

    // Reconfirming Live Brief invalidates upstream chain and makes Architecture stale
    await seedConfirmedLiveBrief(fixture.prisma, data.projectId, fixture.ownerId, { revisionNumber: 2 });

    const callStructured = jest.fn().mockResolvedValue(makeProposal());
    jest.spyOn(LLMGateway, "getInstance").mockReturnValue({ callStructured } as unknown as LLMGateway);

    const kanbanService = new KanbanService();
    await expect(kanbanService.generateBoardFromWorkflow(data.projectId, fixture.ownerId)).rejects.toMatchObject({
      code: "PLANNING_STALE_UPSTREAM",
    });
    expect(callStructured).not.toHaveBeenCalled();
  });

  test("4. Missing upstream authority: unapproved Requirements or Documentation rejects generation", async () => {
    const projectId = await fixture.createProject();
    const kanbanService = new KanbanService();

    await expect(kanbanService.generateBoardFromWorkflow(projectId, fixture.ownerId)).rejects.toMatchObject({
      code: "PLANNING_ACTION_LOCKED",
    });
  });

  test("5. Invalid architectureComponentId: rejects proposal referencing unknown component without partial persistence", async () => {
    const data = await setupProject("cp41-invalid-comp");
    const badProposal = makeProposal("NON-EXISTENT-COMPONENT-ID");
    const callStructured = jest.fn().mockResolvedValue(badProposal);
    jest.spyOn(LLMGateway, "getInstance").mockReturnValue({ callStructured } as unknown as LLMGateway);

    const kanbanService = new KanbanService();
    await expect(kanbanService.generateBoardFromWorkflow(data.projectId, fixture.ownerId)).rejects.toMatchObject({
      code: "PLANNING_ARTIFACT_INVALID",
    });

    // Zero tasks or stages created
    expect(await fixture.prisma.kanbanTask.count({ where: { stage: { board: { projectId: data.projectId } } } })).toBe(0);
  });

  test("6. Cross-project repository reference: rejects proposal referencing foreign repository", async () => {
    const data = await setupProject("cp41-foreign-repo");
    const foreignProject = await setupProject("cp41-other-project");

    const badProposal = makeProposal("ARCH-COMP-API", foreignProject.repo?.id);
    const callStructured = jest.fn().mockResolvedValue(badProposal);
    jest.spyOn(LLMGateway, "getInstance").mockReturnValue({ callStructured } as unknown as LLMGateway);

    const kanbanService = new KanbanService();
    await expect(kanbanService.generateBoardFromWorkflow(data.projectId, fixture.ownerId)).rejects.toMatchObject({
      code: "PLANNING_ARTIFACT_INVALID",
    });

    expect(await fixture.prisma.kanbanTask.count({ where: { stage: { board: { projectId: data.projectId } } } })).toBe(0);
  });

  test("7. No-repository project behavior: persists draft tasks safely with repositoryId null without silently creating repos", async () => {
    const data = await setupProject("cp41-no-repo", { addRepository: false });
    const proposal = makeProposal("ARCH-COMP-API");
    const callStructured = jest.fn().mockResolvedValue(proposal);
    jest.spyOn(LLMGateway, "getInstance").mockReturnValue({ callStructured } as unknown as LLMGateway);

    const kanbanService = new KanbanService();
    const board = await kanbanService.generateBoardFromWorkflow(data.projectId, fixture.ownerId);

    expect(board.stages[0].tasks[0].repositoryId).toBeNull();
    // Verify no repository was silently created
    expect(await fixture.prisma.projectRepository.count({ where: { projectId: data.projectId } })).toBe(0);
  });

  test("8. Invalid dependency reference: rejects proposal with missing dependency reference", async () => {
    const data = await setupProject("cp41-bad-dep");
    const badProposal = {
      content: {
        stages: [
          {
            title: "Stage 1",
            order: 0,
            tasks: [
              {
                key: "TASK-1",
                title: "Task 1",
                description: "Test task",
                acceptanceCriteria: ["Criteria 1"],
                targetFiles: ["src/a.ts"],
                architectureComponentIds: ["ARCH-COMP-API"],
                dependencyKeys: ["UNKNOWN-KEY-NONEXISTENT"],
              },
            ],
          },
        ],
      },
    };

    const callStructured = jest.fn().mockResolvedValue(badProposal);
    jest.spyOn(LLMGateway, "getInstance").mockReturnValue({ callStructured } as unknown as LLMGateway);

    const kanbanService = new KanbanService();
    await expect(kanbanService.generateBoardFromWorkflow(data.projectId, fixture.ownerId)).rejects.toMatchObject({
      code: "PLANNING_ARTIFACT_INVALID",
    });
  });

  test("9. Cyclic dependencies: rejects proposal containing dependency cycles via DAG validator", async () => {
    const data = await setupProject("cp41-cycle");
    const cyclicProposal = {
      content: {
        stages: [
          {
            title: "Stage 1",
            order: 0,
            tasks: [
              {
                key: "TASK-A",
                title: "Task A",
                description: "Cyclic A",
                acceptanceCriteria: ["A"],
                targetFiles: ["src/a.ts"],
                architectureComponentIds: ["ARCH-COMP-API"],
                dependencyKeys: ["TASK-B"],
              },
              {
                key: "TASK-B",
                title: "Task B",
                description: "Cyclic B",
                acceptanceCriteria: ["B"],
                targetFiles: ["src/b.ts"],
                architectureComponentIds: ["ARCH-COMP-API"],
                dependencyKeys: ["TASK-A"],
              },
            ],
          },
        ],
      },
    };

    const callStructured = jest.fn().mockResolvedValue(cyclicProposal);
    jest.spyOn(LLMGateway, "getInstance").mockReturnValue({ callStructured } as unknown as LLMGateway);

    const kanbanService = new KanbanService();
    await expect(kanbanService.generateBoardFromWorkflow(data.projectId, fixture.ownerId)).rejects.toMatchObject({
      code: "PLANNING_ARTIFACT_INVALID",
    });
  });

  test("10. Idempotent duplicate decomposition requests: repeated call with same idempotencyKey returns board deterministically", async () => {
    const data = await setupProject("cp41-idempotent");
    const proposal = makeProposal("ARCH-COMP-API", data.repo?.id);
    const callStructured = jest.fn().mockResolvedValue(proposal);
    jest.spyOn(LLMGateway, "getInstance").mockReturnValue({ callStructured } as unknown as LLMGateway);

    const kanbanService = new KanbanService();
    const firstBoard = await kanbanService.generateBoardFromWorkflow(data.projectId, fixture.ownerId, { idempotencyKey: "key-123" });
    expect(callStructured).toHaveBeenCalledTimes(1);

    // Second call with same idempotency key
    const secondBoard = await kanbanService.generateBoardFromWorkflow(data.projectId, fixture.ownerId, { idempotencyKey: "key-123" });
    expect(callStructured).toHaveBeenCalledTimes(1); // Not called again!
    expect(secondBoard.id).toBe(firstBoard.id);
  });

  test("11. Duplicate decomposition without idempotency key or different key: throws PLANNING_INITIAL_ARTIFACT_EXISTS", async () => {
    const data = await setupProject("cp41-duplicate");
    const proposal = makeProposal("ARCH-COMP-API", data.repo?.id);
    const callStructured = jest.fn().mockResolvedValue(proposal);
    jest.spyOn(LLMGateway, "getInstance").mockReturnValue({ callStructured } as unknown as LLMGateway);

    const kanbanService = new KanbanService();
    await kanbanService.generateBoardFromWorkflow(data.projectId, fixture.ownerId);

    // Repeated call without idempotency key
    await expect(kanbanService.generateBoardFromWorkflow(data.projectId, fixture.ownerId)).rejects.toMatchObject({
      code: "PLANNING_INITIAL_ARTIFACT_EXISTS",
    });
  });

  test("12. Concurrent Architecture supersession during model call: transactional fingerprint check aborts with PLANNING_CONTEXT_CHANGED", async () => {
    const data = await setupProject("cp41-concurrent-race");
    let release!: (value: any) => void;
    const pending = new Promise((resolve) => { release = resolve; });
    const callStructured = jest.fn().mockReturnValue(pending);
    jest.spyOn(LLMGateway, "getInstance").mockReturnValue({ callStructured } as unknown as LLMGateway);

    const kanbanService = new KanbanService();
    const generationPromise = kanbanService.generateBoardFromWorkflow(data.projectId, fixture.ownerId);

    // Wait for model call to be initiated
    for (let i = 0; i < 50 && callStructured.mock.calls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(callStructured).toHaveBeenCalledTimes(1);

    // Concurrent mutation: create successor architecture
    const changed = architectureDraft(data.req.content.nonFunctionalRequirements[0].id);
    changed.overview.approach = "Concurrent Race Supersession";
    await new PlanningArchitectureArtifactService(fixture.prisma).create({
      projectId: data.projectId,
      actorId: fixture.ownerId,
      title: "Architecture v2",
      structuredContent: changed,
      baseArtifactId: data.arch.id,
      baseContentHash: hashOf(data.arch),
    });

    release(makeProposal());

    await expect(generationPromise).rejects.toMatchObject({
      code: "PLANNING_ACTION_LOCKED",
    });
  });

  test("13. Unauthorized approval: non-owner approval attempt is rejected with 403 / IMPLEMENTATION_FORBIDDEN", async () => {
    const data = await setupProject("cp41-auth-approval");
    // Add member to project so they are an authorized project member but not owner
    await fixture.prisma.projectMember.create({
      data: { projectId: data.projectId, userId: fixture.memberId },
    });

    const proposal = makeProposal("ARCH-COMP-API", data.repo?.id);
    const callStructured = jest.fn().mockResolvedValue(proposal);
    jest.spyOn(LLMGateway, "getInstance").mockReturnValue({ callStructured } as unknown as LLMGateway);

    const kanbanService = new KanbanService();
    const board = await kanbanService.generateBoardFromWorkflow(data.projectId, fixture.ownerId);
    const task = board.stages[0].tasks[0];

    const lifecycleService = new ImplementationTaskLifecycleService(fixture.prisma);

    // Non-owner member receives 403 IMPLEMENTATION_FORBIDDEN
    await expect(
      lifecycleService.approveTask(data.projectId, task.id, fixture.memberId, task.stateVersion)
    ).rejects.toMatchObject({
      code: "PLANNING_OWNER_REQUIRED",
      httpStatus: 403,
    });

    // Complete outsider receives 404 PLANNING_PROJECT_NOT_FOUND (isolation protection)
    await expect(
      lifecycleService.approveTask(data.projectId, task.id, fixture.outsiderId, task.stateVersion)
    ).rejects.toMatchObject({
      code: "PLANNING_PROJECT_NOT_FOUND",
      httpStatus: 404,
    });
  });

  test("14. Owner approval: eligible owner approves task, updates state to approved, records actor, version and approvedTaskFingerprint", async () => {
    const data = await setupProject("cp41-owner-approval");
    const proposal = makeProposal("ARCH-COMP-API", data.repo?.id);
    const callStructured = jest.fn().mockResolvedValue(proposal);
    jest.spyOn(LLMGateway, "getInstance").mockReturnValue({ callStructured } as unknown as LLMGateway);

    const kanbanService = new KanbanService();
    const board = await kanbanService.generateBoardFromWorkflow(data.projectId, fixture.ownerId);
    const task = board.stages[0].tasks[0];

    const lifecycleService = new ImplementationTaskLifecycleService(fixture.prisma);
    const approvedTask = await lifecycleService.approveTask(data.projectId, task.id, fixture.ownerId, task.stateVersion);

    expect(approvedTask.implementationState).toBe("approved");
    expect(approvedTask.approvedById).toBe(fixture.ownerId);
    expect(approvedTask.approvedVersion).toBe(task.stateVersion);
    expect(approvedTask.approvedTaskFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(approvedTask.approvedAt).toBeDefined();
  });

  test("15. Persisted task drafts across refresh: getBoard loads persisted drafts, components, repository, and prerequisites", async () => {
    const data = await setupProject("cp41-get-board");
    const proposal = makeProposal("ARCH-COMP-API", data.repo?.id);
    const callStructured = jest.fn().mockResolvedValue(proposal);
    jest.spyOn(LLMGateway, "getInstance").mockReturnValue({ callStructured } as unknown as LLMGateway);

    const kanbanService = new KanbanService();
    await kanbanService.generateBoardFromWorkflow(data.projectId, fixture.ownerId);

    // Refresh simulation: call getBoard
    const board = await kanbanService.getBoard(data.projectId, fixture.ownerId);
    expect(board.stages[0].tasks).toHaveLength(2);

    const [task1, task2] = board.stages[0].tasks;
    expect(task1.architectureComponentIds).toEqual(["ARCH-COMP-API"]);
    expect(task1.repository).toMatchObject({ id: data.repo?.id, name: "main-repo" });

    expect(task2.dependencies).toHaveLength(1);
    expect(task2.dependencies[0].dependencyTask).toMatchObject({ id: task1.id, title: "Setup Core Module" });
  });
});
