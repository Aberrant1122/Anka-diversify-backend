import crypto from "crypto";
import { AgentResponse } from "../../types";
import { CodingAgent } from "../../ai/application/CodingAgent";
import { architectureDraft } from "../../planning/__tests__/architecture-test-fixtures";
import { currentImplementationAuthority } from "../../planning/implementation-authority-preflight";
import { PlanningArchitectureArtifactService } from "../planning-architecture-artifact.service";
import { DocumentationLifecycleFixture, documentationContent, hashOf } from "./planning-documentation-test-fixtures";
import { ImplementationTaskLifecycleService } from "../implementation-task-lifecycle.service";
import { GitWorktreeService } from "../git-worktree.service";
import { GitWorkflowError } from "../git-workflow.service";
import { KanbanService } from "../kanban-service";
import { LLMGateway } from "../../ai/gateway/LLMGateway";
import { PipelineStages } from "../../ai/gateway/PipelineStage";
import { ClarificationHandlerService } from "../clarification-handler.service";

const fixture = new DocumentationLifecycleFixture();
const service = new ImplementationTaskLifecycleService(fixture.prisma);

beforeAll(() => fixture.start());
afterAll(() => fixture.stop());
afterEach(() => jest.restoreAllMocks());

async function approvedArchitecture(label: string, member = false) {
  const projectId = await fixture.createProject(member);
  const requirements = await fixture.approveRequirements(projectId, label);
  const documentation = await fixture.documentationArtifacts.createInitialArtifact({
    projectId, actorId: fixture.ownerId, title: "Documentation",
    structuredContent: documentationContent(requirements.artifact, requirements.content),
  });
  await fixture.approvals.requestDocumentationApproval({ projectId, artifactId: documentation.id, expectedHash: hashOf(documentation), actorId: fixture.ownerId });
  await fixture.approvals.approveDocumentationArtifact({ projectId, artifactId: documentation.id, expectedHash: hashOf(documentation), actorId: fixture.ownerId });
  const architecture = await new PlanningArchitectureArtifactService(fixture.prisma).create({
    projectId, actorId: fixture.ownerId, title: "Architecture",
    structuredContent: architectureDraft(requirements.content.nonFunctionalRequirements[0].id),
  });
  await fixture.approvals.requestArchitectureApproval({ projectId, artifactId: architecture.id, expectedHash: hashOf(architecture), actorId: fixture.ownerId });
  await fixture.approvals.approveArchitectureArtifact({ projectId, artifactId: architecture.id, expectedHash: hashOf(architecture), actorId: fixture.ownerId });
  return { projectId, architecture };
}

async function controlledTask(label: string, member = false) {
  const { projectId } = await approvedArchitecture(label, member);
  const authority = await currentImplementationAuthority(fixture.prisma, projectId, fixture.ownerId);
  const repository = await fixture.prisma.projectRepository.create({ data: {
    projectId, name: "backend", role: "backend", githubUrl: "https://github.com/anka/test-repository.git", defaultBranch: "main",
  } });
  const board = await fixture.prisma.kanbanBoard.create({ data: { projectId } });
  const stage = await fixture.prisma.kanbanStage.create({ data: { boardId: board.id, title: "Implementation", order: 0 } });
  const task = await fixture.prisma.kanbanTask.create({ data: {
    stageId: stage.id, title: "Implement lifecycle", description: "Implement the approved lifecycle.",
    acceptanceCriteria: ["Deterministic validation passes"], targetFiles: ["src/lifecycle.ts"],
    implementationEligible: true, implementationState: "draft", architectureArtifactId: authority.architecture.artifact.id,
    architectureVersion: authority.architecture.artifact.version, architectureContentHash: authority.architecture.contentHash,
    architectureApprovalId: authority.architecture.approvalId, planningAuthorityFingerprint: authority.fingerprint,
    architectureComponentIds: ["ARCH-COMP-API"], repositoryId: repository.id,
  } });
  return { projectId, repository, task };
}

function successfulResponse(): AgentResponse {
  return {
    explanation: "Verified change", changes: [{ path: "src/lifecycle.ts", content: "export const lifecycle = true;", description: "Implement lifecycle" }],
    commitMessage: "implement lifecycle", sessionId: "session-1", buildVerified: true,
    changedFiles: ["src/lifecycle.ts"], diffSummary: "src/lifecycle.ts changed", worktreePath: "C:/tmp/anka/run",
    branchName: "anka/run-test", baseCommitSha: "a".repeat(40), validationCommands: ["npm test"],
    taskRuntime: { taskId: "run-test", status: "COMPLETED", terminalOutcome: { type: "COMPLETED", validationSource: "COMPLETION_EVALUATOR" } },
    gitApproval: { approvalId: `ship-${crypto.randomUUID()}`, changedPaths: ["src/lifecycle.ts"], expiresAt: new Date(Date.now() + 60_000).toISOString() },
  } as unknown as AgentResponse;
}

async function approvedTask(label: string, member = false) {
  const data = await controlledTask(label, member);
  await service.approveTask(data.projectId, data.task.id, fixture.ownerId, data.task.stateVersion);
  return data;
}

describe("controlled implementation task lifecycle on disposable PostgreSQL", () => {
  test("generation persists exact provenance and validated dependency identities", async () => {
    const { projectId, architecture } = await approvedArchitecture("task-generation-valid");
    const proposal = { stages: [{ title: "Implementation", order: 0, tasks: [
      { key: "TASK-A", title: "Foundation", description: "Create foundation", acceptanceCriteria: ["Foundation passes"], targetFiles: ["src/a.ts"], architectureComponentIds: ["ARCH-COMP-API"], dependencyKeys: [] },
      { key: "TASK-B", title: "Consumer", description: "Use foundation", acceptanceCriteria: ["Consumer passes"], targetFiles: ["src/b.ts"], architectureComponentIds: ["ARCH-COMP-API"], dependencyKeys: ["TASK-A"] },
    ] }] };
    jest.spyOn(LLMGateway.getInstance(), "callStructured").mockResolvedValue({ content: proposal, rawResponse: {}, finishReason: "stop", latencyMs: 1, model: "mock", stage: PipelineStages.TASK_DECOMPOSITION } as never);
    const board = await new KanbanService().generateBoardFromWorkflow(projectId, fixture.ownerId);
    const tasks = board.stages.flatMap((stage) => stage.tasks);
    expect(tasks).toHaveLength(2);
    expect(tasks.every((task) => task.implementationState === "draft" && task.architectureArtifactId === architecture.id && task.planningAuthorityFingerprint?.length === 64)).toBe(true);
    const consumer = tasks.find((task) => task.title === "Consumer");
    const foundation = tasks.find((task) => task.title === "Foundation");
    expect(consumer?.dependencies).toEqual([expect.objectContaining({ dependencyTaskId: foundation?.id })]);
  });

  test("invalid generated references and dependency cycles cannot persist", async () => {
    const invalid = await approvedArchitecture("task-generation-invalid");
    jest.spyOn(LLMGateway.getInstance(), "callStructured").mockResolvedValue({ content: { stages: [{ title: "Implementation", order: 0, tasks: [
      { key: "TASK-A", title: "Invalid", description: "Invalid ref", acceptanceCriteria: ["No persistence"], targetFiles: [], architectureComponentIds: ["ARCH-COMP-MISSING"], dependencyKeys: [] },
    ] }] }, rawResponse: {}, finishReason: "stop", latencyMs: 1, model: "mock", stage: PipelineStages.TASK_DECOMPOSITION } as never);
    await expect(new KanbanService().generateBoardFromWorkflow(invalid.projectId, fixture.ownerId)).rejects.toMatchObject({ code: "PLANNING_ARTIFACT_INVALID" });
    expect(await fixture.prisma.kanbanBoard.findUnique({ where: { projectId: invalid.projectId } })).toBeNull();

    jest.restoreAllMocks();
    const cyclic = await approvedArchitecture("task-generation-cycle");
    jest.spyOn(LLMGateway.getInstance(), "callStructured").mockResolvedValue({ content: { stages: [{ title: "Implementation", order: 0, tasks: [
      { key: "TASK-A", title: "A", description: "A", acceptanceCriteria: ["A"], targetFiles: [], architectureComponentIds: ["ARCH-COMP-API"], dependencyKeys: ["TASK-B"] },
      { key: "TASK-B", title: "B", description: "B", acceptanceCriteria: ["B"], targetFiles: [], architectureComponentIds: ["ARCH-COMP-API"], dependencyKeys: ["TASK-A"] },
    ] }] }, rawResponse: {}, finishReason: "stop", latencyMs: 1, model: "mock", stage: PipelineStages.TASK_DECOMPOSITION } as never);
    await expect(new KanbanService().generateBoardFromWorkflow(cyclic.projectId, fixture.ownerId)).rejects.toMatchObject({ code: "PLANNING_ARTIFACT_INVALID" });
    expect(await fixture.prisma.kanbanBoard.findUnique({ where: { projectId: cyclic.projectId } })).toBeNull();
  });

  test("regeneration conflicts preserve the complete existing board", async () => {
    const { projectId } = await approvedArchitecture("task-generation-conflict");
    const proposal = { stages: [{ title: "Implementation", order: 0, tasks: [
      { key: "TASK-A", title: "Existing", description: "Preserve me", acceptanceCriteria: ["Still exists"], targetFiles: [], architectureComponentIds: ["ARCH-COMP-API"], dependencyKeys: [] },
    ] }] };
    jest.spyOn(LLMGateway.getInstance(), "callStructured").mockResolvedValue({ content: proposal, rawResponse: {}, finishReason: "stop", latencyMs: 1, model: "mock", stage: PipelineStages.TASK_DECOMPOSITION } as never);
    const generated = await new KanbanService().generateBoardFromWorkflow(projectId, fixture.ownerId);
    const taskId = generated.stages[0].tasks[0].id;
    await expect(new KanbanService().generateBoardFromWorkflow(projectId, fixture.ownerId)).rejects.toMatchObject({ code: "PLANNING_INITIAL_ARTIFACT_EXISTS" });
    expect(await fixture.prisma.kanbanTask.findUnique({ where: { id: taskId } })).toMatchObject({ title: "Existing", description: "Preserve me" });
  });

  test("material edits invalidate approval and only the owner can approve", async () => {
    const data = await controlledTask("task-edit", true);
    await expect(service.approveTask(data.projectId, data.task.id, fixture.memberId, 0)).rejects.toMatchObject({ code: "PLANNING_OWNER_REQUIRED" });
    await service.approveTask(data.projectId, data.task.id, fixture.ownerId, 0);
    await fixture.prisma.kanbanTask.update({ where: { id: data.task.id }, data: { implementationState: "failed" } });
    const edited = await service.editTask(data.projectId, data.task.id, fixture.memberId, { expectedStateVersion: 0, description: "A revised approved task." });
    expect(edited).toMatchObject({ implementationState: "draft", stateVersion: 1, approvedVersion: null, approvedById: null, approvedTaskFingerprint: null });
  });

  test("unapproved and dependency-blocked tasks cannot execute", async () => {
    const data = await controlledTask("task-dependency");
    const run = jest.spyOn(CodingAgent, "runCodingAgent");
    await expect(service.startExecution(data.projectId, data.task.id, fixture.ownerId, "unapproved-1")).rejects.toMatchObject({ code: "IMPLEMENTATION_TASK_NOT_APPROVED" });
    const dependency = await fixture.prisma.kanbanTask.create({ data: {
      stageId: data.task.stageId, title: "Prerequisite", description: "Must finish first", acceptanceCriteria: ["Accepted"], targetFiles: [],
      implementationEligible: true, implementationState: "draft", architectureArtifactId: data.task.architectureArtifactId,
      architectureVersion: data.task.architectureVersion, architectureContentHash: data.task.architectureContentHash,
      architectureApprovalId: data.task.architectureApprovalId, planningAuthorityFingerprint: data.task.planningAuthorityFingerprint,
      architectureComponentIds: ["ARCH-COMP-API"], repositoryId: data.repository.id,
    } });
    await fixture.prisma.implementationTaskDependency.create({ data: { taskId: data.task.id, dependencyTaskId: dependency.id } });
    await service.approveTask(data.projectId, data.task.id, fixture.ownerId, 0);
    await expect(service.startExecution(data.projectId, data.task.id, fixture.ownerId, "blocked-1")).rejects.toMatchObject({ code: "IMPLEMENTATION_DEPENDENCY_BLOCKED" });
    expect(run).not.toHaveBeenCalled();
  });

  test("legacy status mutation cannot bypass a controlled task lifecycle", async () => {
    const data = await controlledTask("task-status-guard");
    await expect(new KanbanService().updateTaskStatus(data.projectId, data.task.id, fixture.ownerId, "completed"))
      .rejects.toMatchObject({ code: "PLANNING_ACTION_LOCKED" });
    await expect(new ClarificationHandlerService().requestClarification({ projectId: data.projectId, actorId: fixture.ownerId, taskId: data.task.id, question: "Bypass?", options: [] }))
      .rejects.toMatchObject({ code: "PLANNING_ACTION_LOCKED" });
    expect((await fixture.prisma.kanbanTask.findUniqueOrThrow({ where: { id: data.task.id } })).implementationState).toBe("draft");
  });

  test("idempotent concurrent starts invoke the coding agent once and a different key cannot bypass the claim", async () => {
    const data = await approvedTask("task-idempotency");
    let release: ((value: AgentResponse) => void) | undefined;
    const pending = new Promise<AgentResponse>((resolve) => { release = resolve; });
    const run = jest.spyOn(CodingAgent, "runCodingAgent").mockReturnValue(pending);
    const first = service.startExecution(data.projectId, data.task.id, fixture.ownerId, "same-key");
    while (run.mock.calls.length === 0) await new Promise((resolve) => setImmediate(resolve));
    const retry = await service.startExecution(data.projectId, data.task.id, fixture.ownerId, "same-key");
    expect(retry.state).toBe("running");
    await expect(service.startExecution(data.projectId, data.task.id, fixture.ownerId, "different-key")).rejects.toMatchObject({ code: "IMPLEMENTATION_TASK_NOT_APPROVED" });
    release?.(successfulResponse());
    const completed = await first;
    expect(completed.state).toBe("awaiting_review");
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][2]).toMatchObject({ repositoryId: data.repository.id });
    expect(run.mock.calls[0][2].message).toContain("Implement lifecycle");
    expect(await fixture.prisma.implementationTaskExecution.count({ where: { taskId: data.task.id } })).toBe(1);
  });

  test("validation failure persists distinct evidence and never becomes reviewable", async () => {
    const data = await approvedTask("task-validation-failure");
    const failed = successfulResponse();
    failed.buildVerified = false;
    failed.buildErrors = "TypeScript compilation failed";
    delete failed.gitApproval;
    jest.spyOn(CodingAgent, "runCodingAgent").mockResolvedValue(failed);
    const execution = await service.startExecution(data.projectId, data.task.id, fixture.ownerId, "validation-failed-1");
    expect(execution).toMatchObject({ state: "failed", failureCategory: "VALIDATION_FAILURE" });
    expect(execution.validationEvidence).toMatchObject({ buildVerified: false, validationError: "TypeScript compilation failed" });
    expect((await fixture.prisma.kanbanTask.findUniqueOrThrow({ where: { id: data.task.id } })).implementationState).toBe("failed");
  });

  test("authority changes prevent successful promotion and preserve a stale attempt", async () => {
    const data = await approvedTask("task-stale");
    jest.spyOn(CodingAgent, "runCodingAgent").mockImplementation(async () => {
      await fixture.prisma.project.update({ where: { id: data.projectId }, data: { currentPhase: "testing" } });
      return successfulResponse();
    });
    const execution = await service.startExecution(data.projectId, data.task.id, fixture.ownerId, "stale-1");
    expect(execution.state).toBe("authority_stale");
    expect((await fixture.prisma.kanbanTask.findUniqueOrThrow({ where: { id: data.task.id } })).implementationState).toBe("stale");
  });

  test("rejection is owner-only, exact, comment-bound, and preserves execution evidence", async () => {
    const data = await approvedTask("task-reject", true);
    const run = jest.spyOn(CodingAgent, "runCodingAgent").mockResolvedValue(successfulResponse());
    const execution = await service.startExecution(data.projectId, data.task.id, fixture.memberId, "reject-1");
    expect(run.mock.calls[0][0]).toBe(fixture.memberId);
    expect(run.mock.calls[0][4]).toMatchObject({ shippingApprovalUserId: fixture.ownerId });
    await expect(service.rejectExecution(data.projectId, data.task.id, execution.id, fixture.memberId, "No")).rejects.toMatchObject({ code: "PLANNING_OWNER_REQUIRED" });
    await expect(service.rejectExecution(data.projectId, data.task.id, execution.id, fixture.ownerId, "")).rejects.toMatchObject({ code: "IMPLEMENTATION_REVIEW_COMMENTS_REQUIRED" });
    const rejected = await service.rejectExecution(data.projectId, data.task.id, execution.id, fixture.ownerId, "Please cover the rollback case.");
    expect(rejected).toMatchObject({ state: "rejected", reviewComments: "Please cover the rollback case." });
    expect(rejected.validationEvidence).not.toBeNull();
    expect((await fixture.prisma.kanbanTask.findUniqueOrThrow({ where: { id: data.task.id } })).implementationState).toBe("changes_requested");
  });

  test("missing authentic Git approval expires review instead of reconstructing authority", async () => {
    const data = await approvedTask("task-expired");
    jest.spyOn(CodingAgent, "runCodingAgent").mockResolvedValue(successfulResponse());
    const execution = await service.startExecution(data.projectId, data.task.id, fixture.ownerId, "expired-1");
    await expect(service.acceptExecution(data.projectId, data.task.id, execution.id, fixture.ownerId, { commitSummary: "ship", changes: [{ path: "src/lifecycle.ts", content: "export const lifecycle = true;" }] })).rejects.toMatchObject({ code: "IMPLEMENTATION_REVIEW_EXPIRED" });
    expect((await fixture.prisma.implementationTaskExecution.findUniqueOrThrow({ where: { id: execution.id } })).state).toBe("review_expired");
  });

  test("confirmed push accepts exact execution; uncertain push remains unresolved", async () => {
    const first = await approvedTask("task-ship-success");
    jest.spyOn(CodingAgent, "runCodingAgent").mockResolvedValue(successfulResponse());
    const acceptedAttempt = await service.startExecution(first.projectId, first.task.id, fixture.ownerId, "ship-1");
    jest.spyOn(GitWorktreeService, "inspectShippingApproval").mockReturnValue({ expiresAt: new Date(Date.now() + 60_000), repositoryId: first.repository.id, state: "AVAILABLE" });
    jest.spyOn(GitWorktreeService, "shipApprovedRun").mockResolvedValue({ baseRevision: "a".repeat(40), taskHeadRevision: "a".repeat(40), finalVerifiedRevision: "f", taskBranch: "anka/run-test", commitCreated: true, commitSha: "b".repeat(40), changedPaths: ["src/lifecycle.ts"], remote: "origin", pushed: true, ciStatus: "NOT_REQUESTED" });
    const accepted = await service.acceptExecution(first.projectId, first.task.id, acceptedAttempt.id, fixture.ownerId, { commitSummary: "ship", changes: [{ path: "src/lifecycle.ts", content: "export const lifecycle = true;" }] });
    expect(accepted).toMatchObject({ state: "accepted", commitSha: "b".repeat(40), pushed: true });

    jest.restoreAllMocks();
    const second = await approvedTask("task-ship-unknown");
    jest.spyOn(CodingAgent, "runCodingAgent").mockResolvedValue(successfulResponse());
    const unknownAttempt = await service.startExecution(second.projectId, second.task.id, fixture.ownerId, "ship-2");
    jest.spyOn(GitWorktreeService, "inspectShippingApproval").mockReturnValue({ expiresAt: new Date(Date.now() + 60_000), repositoryId: second.repository.id, state: "AVAILABLE" });
    jest.spyOn(GitWorktreeService, "shipApprovedRun").mockRejectedValue(new GitWorkflowError("GIT_PUSH_FAILED", "Remote result is not safely known"));
    await expect(service.acceptExecution(second.projectId, second.task.id, unknownAttempt.id, fixture.ownerId, { commitSummary: "ship", changes: [{ path: "src/lifecycle.ts", content: "export const lifecycle = true;" }] })).rejects.toMatchObject({ code: "GIT_PUSH_FAILED" });
    expect((await fixture.prisma.implementationTaskExecution.findUniqueOrThrow({ where: { id: unknownAttempt.id } })).state).toBe("shipping_unknown");
  });

  test("recovery interrupts only expired running leases", async () => {
    const expired = await approvedTask("task-recovery-expired");
    await fixture.prisma.kanbanTask.update({ where: { id: expired.task.id }, data: { implementationState: "running" } });
    const old = await fixture.prisma.implementationTaskExecution.create({ data: {
      projectId: expired.projectId, taskId: expired.task.id, repositoryId: expired.repository.id, initiatedById: fixture.ownerId,
      idempotencyKey: "recover-old", requestIdentity: "old", approvedTaskVersion: 0, taskSnapshot: {}, planningAuthority: {}, authorityFingerprint: "old", state: "running",
      heartbeatAt: new Date(Date.now() - 300_000), leaseExpiresAt: new Date(Date.now() - 120_000),
    } });
    const active = await approvedTask("task-recovery-active");
    await fixture.prisma.kanbanTask.update({ where: { id: active.task.id }, data: { implementationState: "running" } });
    const live = await fixture.prisma.implementationTaskExecution.create({ data: {
      projectId: active.projectId, taskId: active.task.id, repositoryId: active.repository.id, initiatedById: fixture.ownerId,
      idempotencyKey: "recover-live", requestIdentity: "live", approvedTaskVersion: 0, taskSnapshot: {}, planningAuthority: {}, authorityFingerprint: "live", state: "running",
      heartbeatAt: new Date(), leaseExpiresAt: new Date(Date.now() + 120_000),
    } });
    expect(await service.recoverAbandonedExecutions(expired.projectId)).toBe(1);
    expect((await fixture.prisma.implementationTaskExecution.findUniqueOrThrow({ where: { id: old.id } })).state).toBe("interrupted");
    expect((await fixture.prisma.implementationTaskExecution.findUniqueOrThrow({ where: { id: live.id } })).state).toBe("running");
  });
});
