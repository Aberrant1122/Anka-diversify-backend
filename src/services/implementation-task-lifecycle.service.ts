import crypto from "crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { CodingAgent } from "../ai/application/CodingAgent";
import { AgentResponse } from "../types";
import { assertImplementationAuthorityCurrent, ImplementationAuthority, resolveImplementationAuthority } from "../planning/implementation-authority-preflight";
import { hashCanonical } from "../planning/requirements-context";
import { isPlanningDomainError } from "../planning/planning-errors";
import { PlanningAuthorizationService } from "./planning-authorization.service";
import { GitWorktreeService } from "./git-worktree.service";
import { GitWorkflowError } from "./git-workflow.service";
import { decrypt } from "../utils/encryption";
import { prisma } from "./database";

export type ImplementationTaskState = "draft" | "approved" | "running" | "awaiting_review" | "changes_requested" | "failed" | "stale" | "accepted";
export type ImplementationExecutionState = "running" | "awaiting_review" | "failed" | "authority_stale" | "rejected" | "accepted" | "interrupted" | "review_expired" | "shipping_unknown";

export class ImplementationTaskError extends Error {
  constructor(readonly code: string, message: string, readonly httpStatus: number, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "ImplementationTaskError";
  }
}

export function isImplementationTaskError(error: unknown): error is ImplementationTaskError {
  return error instanceof ImplementationTaskError;
}

type EditableTaskInput = {
  expectedStateVersion: number;
  title?: string;
  description?: string;
  acceptanceCriteria?: string[];
  targetFiles?: string[];
  repositoryId?: string;
};

type ApprovedSnapshot = {
  taskId: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  targetFiles: string[];
  architectureComponentIds: string[];
  dependencyTaskIds: string[];
  repositoryId: string;
  stateVersion: number;
  architecture: { artifactId: string; version: number; contentHash: string; approvalId: string };
  authorityFingerprint: string;
};

const LEASE_MS = 2 * 60 * 1000;
const HEARTBEAT_MS = 30 * 1000;
const MAX_LIST = 100;

function bounded(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.replace(/\0/g, "").slice(0, max);
}

function strings(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}

function safePath(value: string): boolean {
  if (!value || value !== value.trim() || value.includes("\0")) return false;
  const normalized = value.replace(/\\/g, "/");
  return !normalized.startsWith("/") && !/^[A-Za-z]:\//.test(normalized)
    && normalized.split("/").every((part) => part && part !== "." && part !== "..");
}

function taskFingerprint(snapshot: ApprovedSnapshot): string {
  return hashCanonical(snapshot);
}

function requestIdentity(projectId: string, task: { id: string; stateVersion: number; repositoryId: string | null; planningAuthorityFingerprint: string | null }, actorId: string): string {
  return hashCanonical({ projectId, taskId: task.id, stateVersion: task.stateVersion, repositoryId: task.repositoryId, authorityFingerprint: task.planningAuthorityFingerprint, actorId });
}

function authorityIdentity(authority: ImplementationAuthority): Prisma.InputJsonObject {
  return {
    fingerprint: authority.fingerprint,
    architecture: {
      artifactId: authority.architecture.artifact.id,
      version: authority.architecture.artifact.version,
      contentHash: authority.architecture.contentHash,
      approvalId: authority.architecture.approvalId,
      approvedById: authority.architecture.approvedById,
      approvedAt: authority.architecture.approvedAt.toISOString(),
    },
  };
}

function instruction(snapshot: ApprovedSnapshot, authority: ImplementationAuthority): string {
  const componentSet = new Set(snapshot.architectureComponentIds);
  const components = authority.architecture.content.components.filter((component) => componentSet.has(component.id));
  return [
    "Implement exactly the approved persisted Kanban task below. Treat it as the complete task authority; do not broaden scope.",
    `Task: ${snapshot.title}`,
    `Description: ${snapshot.description}`,
    `Acceptance criteria:\n${snapshot.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}`,
    `Target-file hints (hints only; repository evidence remains authoritative):\n${snapshot.targetFiles.map((item) => `- ${item}`).join("\n") || "- none"}`,
    `Approved Architecture components:\n${JSON.stringify(components)}`,
    `Architecture authority: ${snapshot.architecture.artifactId} v${snapshot.architecture.version} ${snapshot.architecture.contentHash}`,
  ].join("\n\n");
}

function validationEvidence(response: AgentResponse): Prisma.InputJsonObject {
  return {
    runtimeStatus: response.taskRuntime?.status ?? "UNKNOWN",
    terminalOutcome: response.taskRuntime?.terminalOutcome?.type ?? "UNKNOWN",
    buildVerified: response.buildVerified === true,
    validationCommands: (response.validationCommands ?? []).slice(0, 30).map((item) => item.slice(0, 500)),
    validationError: bounded(response.buildErrors ?? response.reason, 4000) ?? null,
    successfulNoOp: response.successfulNoOp === true,
  };
}

export class ImplementationTaskLifecycleService {
  private static readonly activeExecutionIds = new Set<string>();
  private readonly authorization: PlanningAuthorizationService;

  constructor(private readonly client: PrismaClient = prisma) {
    this.authorization = new PlanningAuthorizationService(client);
  }

  async editTask(projectId: string, taskId: string, actorId: string, input: EditableTaskInput) {
    await this.authorization.assertCanEdit(projectId, actorId);
    if (!Number.isSafeInteger(input.expectedStateVersion) || input.expectedStateVersion < 0)
      throw new ImplementationTaskError("IMPLEMENTATION_VERSION_REQUIRED", "A valid expectedStateVersion is required.", 400);
    if (![input.title, input.description, input.acceptanceCriteria, input.targetFiles, input.repositoryId].some((value) => value !== undefined))
      throw new ImplementationTaskError("IMPLEMENTATION_INVALID_INPUT", "At least one supported material task field is required.", 400);
    const data: Prisma.KanbanTaskUncheckedUpdateManyInput = {
      stateVersion: { increment: 1 }, implementationState: "draft", status: "todo",
      approvedVersion: null, approvedById: null, approvedAt: null, approvedTaskFingerprint: null,
    };
    if (input.title !== undefined) {
      const title = input.title.trim();
      if (!title || title.length > 200) throw new ImplementationTaskError("IMPLEMENTATION_INVALID_INPUT", "Task title is invalid.", 400);
      data.title = title;
    }
    if (input.description !== undefined) {
      const description = input.description.trim();
      if (!description || description.length > 10_000) throw new ImplementationTaskError("IMPLEMENTATION_INVALID_INPUT", "Task description is invalid.", 400);
      data.description = description;
    }
    if (input.acceptanceCriteria !== undefined) {
      if (!Array.isArray(input.acceptanceCriteria) || input.acceptanceCriteria.length === 0 || input.acceptanceCriteria.length > 50 || input.acceptanceCriteria.some((item) => typeof item !== "string" || !item.trim() || item.length > 1000))
        throw new ImplementationTaskError("IMPLEMENTATION_INVALID_INPUT", "Acceptance criteria are invalid.", 400);
      data.acceptanceCriteria = input.acceptanceCriteria.map((item) => item.trim());
    }
    if (input.targetFiles !== undefined) {
      if (!Array.isArray(input.targetFiles) || input.targetFiles.length > 100 || input.targetFiles.some((item) => typeof item !== "string" || !safePath(item)))
        throw new ImplementationTaskError("IMPLEMENTATION_INVALID_INPUT", "Target-file hints are invalid.", 400);
      data.targetFiles = input.targetFiles;
    }
    if (input.repositoryId !== undefined) {
      const repository = await this.client.projectRepository.findFirst({ where: { id: input.repositoryId, projectId }, select: { id: true } });
      if (!repository) throw new ImplementationTaskError("IMPLEMENTATION_REPOSITORY_NOT_FOUND", "Repository does not belong to this project.", 422);
      data.repositoryId = repository.id;
    }
    const changed = await this.client.kanbanTask.updateMany({ where: {
      id: taskId, stage: { board: { projectId } }, implementationEligible: true,
      implementationState: { in: ["draft", "changes_requested", "failed"] }, stateVersion: input.expectedStateVersion,
    }, data });
    if (changed.count !== 1) throw new ImplementationTaskError("IMPLEMENTATION_CONCURRENT_UPDATE", "Task changed or is not editable in its current state.", 409);
    return this.task(projectId, taskId);
  }

  async approveTask(projectId: string, taskId: string, actorId: string, expectedStateVersion: number) {
    if (!Number.isSafeInteger(expectedStateVersion) || expectedStateVersion < 0)
      throw new ImplementationTaskError("IMPLEMENTATION_VERSION_REQUIRED", "A valid expectedStateVersion is required.", 400);
    return this.client.$transaction(async (tx) => {
      await this.authorization.assertOwnerInTransaction(tx, projectId, actorId);
      const authority = await resolveImplementationAuthority(tx, projectId, actorId);
      const task = await tx.kanbanTask.findFirst({ where: { id: taskId, stage: { board: { projectId } }, implementationEligible: true }, include: { dependencies: true } });
      if (!task) throw new ImplementationTaskError("IMPLEMENTATION_TASK_NOT_FOUND", "Implementation task was not found.", 404);
      if (task.implementationState !== "draft" || task.stateVersion !== expectedStateVersion)
        throw new ImplementationTaskError("IMPLEMENTATION_CONCURRENT_UPDATE", "Only the exact current draft version can be approved.", 409);
      if (task.planningAuthorityFingerprint !== authority.fingerprint || task.architectureArtifactId !== authority.architecture.artifact.id || task.architectureVersion !== authority.architecture.artifact.version || task.architectureContentHash !== authority.architecture.contentHash || task.architectureApprovalId !== authority.architecture.approvalId)
        throw new ImplementationTaskError("IMPLEMENTATION_AUTHORITY_STALE", "Task planning authority is no longer current.", 409);
      const componentIds = strings(task.architectureComponentIds);
      const validComponents = new Set(authority.architecture.content.components.map((component) => component.id));
      if (!componentIds.length || componentIds.some((id) => !validComponents.has(id)))
        throw new ImplementationTaskError("IMPLEMENTATION_COMPONENT_INVALID", "Task contains an invalid Architecture component reference.", 422);
      if (!task.repositoryId || !await tx.projectRepository.findFirst({ where: { id: task.repositoryId, projectId }, select: { id: true } }))
        throw new ImplementationTaskError("IMPLEMENTATION_REPOSITORY_REQUIRED", "Select a repository belonging to this project before approval.", 422);
      await this.assertDependencyGraph(tx, projectId, task.id);
      const snapshot = this.snapshot(task, task.dependencies.map((item) => item.dependencyTaskId));
      const fingerprint = taskFingerprint(snapshot);
      const updated = await tx.kanbanTask.updateMany({ where: { id: task.id, implementationState: "draft", stateVersion: expectedStateVersion }, data: {
        implementationState: "approved", approvedVersion: expectedStateVersion, approvedById: actorId, approvedAt: new Date(), approvedTaskFingerprint: fingerprint,
      } });
      if (updated.count !== 1) throw new ImplementationTaskError("IMPLEMENTATION_CONCURRENT_UPDATE", "Task changed during approval.", 409);
      return tx.kanbanTask.findUniqueOrThrow({ where: { id: task.id }, include: { dependencies: true } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async startExecution(projectId: string, taskId: string, actorId: string, idempotencyKey: string) {
    await this.authorization.assertCanEdit(projectId, actorId);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(idempotencyKey))
      throw new ImplementationTaskError("IMPLEMENTATION_IDEMPOTENCY_REQUIRED", "A bounded idempotency key is required.", 400);
    await this.recoverAbandonedExecutions(projectId);

    let claimed: { executionId: string; snapshot: ApprovedSnapshot; authority: ImplementationAuthority; executionActorId: string; existing: boolean };
    try {
      claimed = await this.client.$transaction(async (tx) => {
        const authority = await resolveImplementationAuthority(tx, projectId, actorId);
        const task = await tx.kanbanTask.findFirst({ where: { id: taskId, stage: { board: { projectId } }, implementationEligible: true }, include: { dependencies: { include: { dependencyTask: { select: { implementationState: true } } } } } });
        if (!task) throw new ImplementationTaskError("IMPLEMENTATION_TASK_NOT_FOUND", "Implementation task was not found.", 404);
        const identity = requestIdentity(projectId, task, actorId);
        const prior = await tx.implementationTaskExecution.findUnique({ where: { taskId_idempotencyKey: { taskId, idempotencyKey } } });
        if (prior) {
          if (prior.requestIdentity !== identity) throw new ImplementationTaskError("IMPLEMENTATION_IDEMPOTENCY_CONFLICT", "Idempotency key was used for a different effective request.", 409);
          const owner = await tx.project.findUniqueOrThrow({ where: { id: projectId }, select: { userId: true } });
          return { executionId: prior.id, snapshot: prior.taskSnapshot as unknown as ApprovedSnapshot, authority, executionActorId: owner.userId, existing: true };
        }
        if (task.implementationState !== "approved" || task.approvedVersion !== task.stateVersion || !task.approvedTaskFingerprint)
          throw new ImplementationTaskError("IMPLEMENTATION_TASK_NOT_APPROVED", "The exact current task version is not approved.", 409);
        if (task.planningAuthorityFingerprint !== authority.fingerprint)
          throw new ImplementationTaskError("IMPLEMENTATION_AUTHORITY_STALE", "Task planning authority is stale.", 409);
        if (task.dependencies.some((item) => item.dependencyTask.implementationState !== "accepted"))
          throw new ImplementationTaskError("IMPLEMENTATION_DEPENDENCY_BLOCKED", "Every prerequisite task must be accepted before execution.", 409);
        const snapshot = this.snapshot(task, task.dependencies.map((item) => item.dependencyTaskId));
        if (taskFingerprint(snapshot) !== task.approvedTaskFingerprint)
          throw new ImplementationTaskError("IMPLEMENTATION_APPROVAL_MISMATCH", "Approved task content no longer matches its fingerprint.", 409);
        const now = new Date();
        const execution = await tx.implementationTaskExecution.create({ data: {
          projectId, taskId, repositoryId: snapshot.repositoryId, initiatedById: actorId, idempotencyKey,
          requestIdentity: identity, approvedTaskVersion: snapshot.stateVersion, taskSnapshot: snapshot as unknown as Prisma.InputJsonObject,
          planningAuthority: authorityIdentity(authority), authorityFingerprint: authority.fingerprint, state: "running",
          heartbeatAt: now, leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
        } });
        const taskClaim = await tx.kanbanTask.updateMany({ where: { id: taskId, implementationState: "approved", stateVersion: snapshot.stateVersion, approvedVersion: snapshot.stateVersion }, data: { implementationState: "running", status: "in_progress" } });
        if (taskClaim.count !== 1) throw new ImplementationTaskError("IMPLEMENTATION_CONCURRENT_UPDATE", "Task could not be claimed for execution.", 409);
        const owner = await tx.project.findUniqueOrThrow({ where: { id: projectId }, select: { userId: true } });
        return { executionId: execution.id, snapshot, authority, executionActorId: owner.userId, existing: false };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const existing = await this.client.implementationTaskExecution.findUnique({ where: { taskId_idempotencyKey: { taskId, idempotencyKey } } });
        if (existing) return existing;
        throw new ImplementationTaskError("IMPLEMENTATION_EXECUTION_ACTIVE", "Another execution already owns this task.", 409);
      }
      throw error;
    }
    if (claimed.existing) return this.client.implementationTaskExecution.findUniqueOrThrow({ where: { id: claimed.executionId } });

    ImplementationTaskLifecycleService.activeExecutionIds.add(claimed.executionId);
    const heartbeat = setInterval(() => {
      const now = new Date();
      void this.client.implementationTaskExecution.updateMany({ where: { id: claimed.executionId, state: "running" }, data: { heartbeatAt: now, leaseExpiresAt: new Date(now.getTime() + LEASE_MS) } });
    }, HEARTBEAT_MS);
    heartbeat.unref();
    try {
      const response = await CodingAgent.runCodingAgent(actorId, projectId, {
        message: instruction(claimed.snapshot, claimed.authority), repositoryId: claimed.snapshot.repositoryId,
      }, undefined, {
        // Execution remains attributed to its initiating editor; only the
        // later retained Git approval is bound to the owner reviewer.
        shippingApprovalUserId: claimed.executionActorId,
      });
      await assertImplementationAuthorityCurrent(this.client, claimed.authority);
      const verified = response.taskRuntime?.status === "COMPLETED" && response.taskRuntime.terminalOutcome?.type === "COMPLETED"
        && response.buildVerified === true && Boolean(response.gitApproval) && (response.changes?.length ?? 0) > 0;
      if (!verified) {
        return await this.finishFailure(claimed.executionId, taskId, "VALIDATION_FAILURE", response.buildErrors ?? response.reason ?? "Execution did not produce verified reviewable changes.", validationEvidence(response));
      }
      const changedFiles = [...new Set((response.changedFiles ?? response.changes.map((change) => change.path)).map((file) => file.replace(/\\/g, "/")))].slice(0, MAX_LIST);
      await this.client.$transaction(async (tx) => {
        const attempt = await tx.implementationTaskExecution.updateMany({ where: { id: claimed.executionId, state: "running" }, data: {
          state: "awaiting_review", completedAt: new Date(), leaseExpiresAt: new Date(), sessionId: bounded(response.sessionId, 200),
          runId: bounded(response.taskRuntime?.taskId, 200), worktreePath: bounded(response.worktreePath, 1000), branchName: bounded(response.branchName, 300),
          baseCommitSha: bounded(response.baseCommitSha, 80), changedFiles, diffSummary: bounded(response.diffSummary, 8000),
          validationEvidence: validationEvidence(response), gitApprovalId: response.gitApproval!.approvalId,
          gitApprovalExpiresAt: new Date(response.gitApproval!.expiresAt),
        } });
        if (attempt.count !== 1) throw new ImplementationTaskError("IMPLEMENTATION_CONCURRENT_UPDATE", "Execution result could not be persisted.", 409);
        await tx.kanbanTask.updateMany({ where: { id: taskId, implementationState: "running" }, data: { implementationState: "awaiting_review", status: "in_progress" } });
      });
      return this.client.implementationTaskExecution.findUniqueOrThrow({ where: { id: claimed.executionId } });
    } catch (error) {
      const stale = isPlanningDomainError(error) || (error instanceof Error && (error.message.includes("PLANNING_CONTEXT_CHANGED") || error.message.includes("planning authority")));
      return this.finishFailure(claimed.executionId, taskId, stale ? "AUTHORITY_STALE" : "TECHNICAL_FAILURE", error instanceof Error ? error.message : "Unknown execution failure", undefined, stale);
    } finally {
      clearInterval(heartbeat);
      ImplementationTaskLifecycleService.activeExecutionIds.delete(claimed.executionId);
    }
  }

  async listExecutions(projectId: string, taskId: string, actorId: string) {
    await this.authorization.assertCanRead(projectId, actorId);
    await this.assertTaskScope(projectId, taskId);
    await this.recoverAbandonedExecutions(projectId);
    return this.client.implementationTaskExecution.findMany({ where: { projectId, taskId }, orderBy: { createdAt: "desc" }, take: MAX_LIST });
  }

  async getExecution(projectId: string, taskId: string, executionId: string, actorId: string) {
    await this.authorization.assertCanRead(projectId, actorId);
    await this.assertTaskScope(projectId, taskId);
    const execution = await this.client.implementationTaskExecution.findFirst({ where: { id: executionId, projectId, taskId } });
    if (!execution) throw new ImplementationTaskError("IMPLEMENTATION_EXECUTION_NOT_FOUND", "Execution was not found.", 404);
    return execution;
  }

  async rejectExecution(projectId: string, taskId: string, executionId: string, actorId: string, comments: string) {
    const clean = comments.trim();
    if (!clean || clean.length > 10_000) throw new ImplementationTaskError("IMPLEMENTATION_REVIEW_COMMENTS_REQUIRED", "Bounded review comments are required.", 400);
    return this.client.$transaction(async (tx) => {
      await this.authorization.assertOwnerInTransaction(tx, projectId, actorId);
      const execution = await tx.implementationTaskExecution.findFirst({ where: { id: executionId, projectId, taskId, state: "awaiting_review" } });
      if (!execution) throw new ImplementationTaskError("IMPLEMENTATION_REVIEW_CONFLICT", "The exact execution is not awaiting review.", 409);
      const task = await tx.kanbanTask.updateMany({ where: { id: taskId, implementationState: "awaiting_review", stateVersion: execution.approvedTaskVersion }, data: { implementationState: "changes_requested", status: "todo", approvedVersion: null, approvedById: null, approvedAt: null, approvedTaskFingerprint: null } });
      if (task.count !== 1) throw new ImplementationTaskError("IMPLEMENTATION_REVIEW_CONFLICT", "Task no longer matches this execution.", 409);
      return tx.implementationTaskExecution.update({ where: { id: execution.id }, data: { state: "rejected", reviewedAt: new Date(), reviewedById: actorId, reviewComments: clean } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async acceptExecution(projectId: string, taskId: string, executionId: string, actorId: string, input: { changes: readonly { path: string; content: string }[]; commitSummary: string }) {
    await this.authorization.assertOwner(projectId, actorId);
    const execution = await this.client.implementationTaskExecution.findFirst({ where: { id: executionId, projectId, taskId }, include: { task: true, repository: true } });
    const persistedSnapshot = execution?.taskSnapshot as unknown as ApprovedSnapshot | undefined;
    if (!execution || !persistedSnapshot || execution.state !== "awaiting_review" || execution.task.implementationState !== "awaiting_review"
      || execution.task.stateVersion !== execution.approvedTaskVersion || execution.task.approvedVersion !== execution.approvedTaskVersion
      || execution.task.approvedTaskFingerprint !== taskFingerprint(persistedSnapshot))
      throw new ImplementationTaskError("IMPLEMENTATION_REVIEW_CONFLICT", "The exact task execution is not awaiting review.", 409);
    if (!execution.gitApprovalId || !execution.gitApprovalExpiresAt || execution.gitApprovalExpiresAt.getTime() <= Date.now())
      return this.expireReview(execution.id, taskId, "Verified Git approval expired or is unavailable.");
    const approval = GitWorktreeService.inspectShippingApproval(execution.gitApprovalId, actorId, projectId);
    if (!approval || approval.state !== "AVAILABLE" || approval.expiresAt.getTime() <= Date.now())
      return this.expireReview(execution.id, taskId, "Verified Git approval was lost or expired.");
    const authority = await this.client.$transaction((tx) => resolveImplementationAuthority(tx, projectId, actorId), { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    if (authority.fingerprint !== execution.authorityFingerprint)
      throw new ImplementationTaskError("IMPLEMENTATION_AUTHORITY_STALE", "Planning authority changed before acceptance.", 409);
    const evidence = execution.validationEvidence as Record<string, unknown> | null;
    if (!evidence || evidence.runtimeStatus !== "COMPLETED" || evidence.buildVerified !== true || strings(execution.changedFiles).length === 0)
      throw new ImplementationTaskError("IMPLEMENTATION_VALIDATION_REQUIRED", "Verified validation and change evidence are required.", 409);
    const summary = input.commitSummary?.trim();
    if (!summary || summary.length > 500 || !Array.isArray(input.changes) || input.changes.length === 0)
      throw new ImplementationTaskError("IMPLEMENTATION_GIT_INPUT_INVALID", "Commit summary and exact approved changes are required.", 400);
    if (input.changes.length > MAX_LIST) throw new ImplementationTaskError("IMPLEMENTATION_GIT_INPUT_INVALID", "Too many approved changes were supplied.", 400);
    const suppliedPaths = new Set<string>(); let suppliedBytes = 0;
    for (const change of input.changes) {
      if (!change || typeof change.path !== "string" || typeof change.content !== "string" || !safePath(change.path) || suppliedPaths.has(change.path))
        throw new ImplementationTaskError("IMPLEMENTATION_GIT_INPUT_INVALID", "Approved changes contain an invalid or duplicate path.", 400);
      suppliedPaths.add(change.path); suppliedBytes += Buffer.byteLength(change.content, "utf8");
      if (Buffer.byteLength(change.content, "utf8") > 2 * 1024 * 1024 || suppliedBytes > 8 * 1024 * 1024)
        throw new ImplementationTaskError("IMPLEMENTATION_GIT_INPUT_INVALID", "Approved change content exceeds the bounded request limit.", 413);
    }
    const claimed = await this.client.implementationTaskExecution.updateMany({ where: { id: execution.id, state: "awaiting_review" }, data: { state: "shipping_unknown", reviewedById: actorId, reviewedAt: new Date() } });
    if (claimed.count !== 1) throw new ImplementationTaskError("IMPLEMENTATION_REVIEW_CONFLICT", "Execution is already being reviewed.", 409);
    try {
      const encryptedToken = execution.repository.githubToken;
      const gitEnvironment = encryptedToken ? this.gitEnvironment(decrypt(encryptedToken)) : undefined;
      const shipped = await GitWorktreeService.shipApprovedRun({
        approvalId: execution.gitApprovalId, userId: actorId, projectId, changes: input.changes,
        commitSummary: summary, expectedRepositoryIdentity: execution.repository.githubUrl, gitEnvironment,
      });
      if (!shipped.commitSha || shipped.pushed !== true)
        throw new ImplementationTaskError("IMPLEMENTATION_SHIPPING_UNCONFIRMED", "Git shipping did not confirm a pushed commit.", 502);
      await this.client.$transaction(async (tx) => {
        const result = await tx.implementationTaskExecution.updateMany({ where: { id: execution.id, state: "shipping_unknown" }, data: {
          state: "accepted", completedAt: new Date(), commitSha: shipped.commitSha, pushed: shipped.pushed,
          remote: shipped.remote, reviewId: shipped.reviewId, reviewUrl: shipped.reviewUrl,
        } });
        if (result.count !== 1) throw new ImplementationTaskError("IMPLEMENTATION_SHIPPING_PERSISTENCE_UNKNOWN", "Shipped result could not be finalized.", 500);
        const task = await tx.kanbanTask.updateMany({ where: { id: taskId, implementationState: "awaiting_review", stateVersion: execution.approvedTaskVersion }, data: { implementationState: "accepted", status: "completed" } });
        if (task.count !== 1) throw new ImplementationTaskError("IMPLEMENTATION_SHIPPING_PERSISTENCE_UNKNOWN", "Shipped task could not be finalized.", 500);
      });
      return this.client.implementationTaskExecution.findUniqueOrThrow({ where: { id: execution.id } });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown Git shipping failure";
      if (message.includes("GIT_APPROVAL_EXPIRED") || message.includes("GIT_APPROVAL_NOT_FOUND")) return this.expireReview(execution.id, taskId, message);
      if (message.includes("GIT_APPROVAL_MISMATCH") || message.includes("PLANNING_CONTEXT_CHANGED")) {
        await this.client.implementationTaskExecution.updateMany({ where: { id: execution.id, state: "shipping_unknown" }, data: { state: "awaiting_review", failureCategory: "SHIPPING_PRECONDITION", failureDiagnostic: bounded(message, 4000) } });
      } else if (error instanceof GitWorkflowError || error instanceof ImplementationTaskError) {
        await this.client.implementationTaskExecution.updateMany({ where: { id: execution.id, state: "shipping_unknown" }, data: { failureCategory: "SHIPPING_UNKNOWN", failureDiagnostic: bounded(message, 4000) } });
      }
      throw error;
    }
  }

  async recoverAbandonedExecutions(projectId: string): Promise<number> {
    const now = new Date();
    return this.client.$transaction(async (tx) => {
      const expired = await tx.implementationTaskExecution.findMany({ where: { projectId, state: "running", leaseExpiresAt: { lt: now } }, select: { id: true, taskId: true } });
      let recovered = 0;
      for (const item of expired) {
        if (ImplementationTaskLifecycleService.activeExecutionIds.has(item.id)) continue;
        const changed = await tx.implementationTaskExecution.updateMany({ where: { id: item.id, state: "running", leaseExpiresAt: { lt: now } }, data: { state: "interrupted", completedAt: now, failureCategory: "PROCESS_INTERRUPTED", failureDiagnostic: "Execution lease expired without a live heartbeat." } });
        if (changed.count === 1) {
          recovered += 1;
          await tx.kanbanTask.updateMany({ where: { id: item.taskId, implementationState: "running" }, data: { implementationState: "failed", status: "failed" } });
        }
      }
      return recovered;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  private async task(projectId: string, taskId: string) {
    const task = await this.client.kanbanTask.findFirst({ where: { id: taskId, stage: { board: { projectId } } }, include: { dependencies: true } });
    if (!task) throw new ImplementationTaskError("IMPLEMENTATION_TASK_NOT_FOUND", "Task was not found.", 404);
    return task;
  }

  private async assertTaskScope(projectId: string, taskId: string): Promise<void> { await this.task(projectId, taskId); }

  private snapshot(task: { id: string; title: string; description: string; acceptanceCriteria: Prisma.JsonValue; targetFiles: Prisma.JsonValue; architectureComponentIds: Prisma.JsonValue; repositoryId: string | null; stateVersion: number; architectureArtifactId: string | null; architectureVersion: number | null; architectureContentHash: string | null; architectureApprovalId: string | null; planningAuthorityFingerprint: string | null }, dependencyTaskIds: string[]): ApprovedSnapshot {
    if (!task.repositoryId || !task.architectureArtifactId || !task.architectureVersion || !task.architectureContentHash || !task.architectureApprovalId || !task.planningAuthorityFingerprint)
      throw new ImplementationTaskError("IMPLEMENTATION_TASK_INCOMPLETE", "Task lacks required implementation provenance.", 422);
    return {
      taskId: task.id, title: task.title, description: task.description, acceptanceCriteria: strings(task.acceptanceCriteria), targetFiles: strings(task.targetFiles),
      architectureComponentIds: strings(task.architectureComponentIds), dependencyTaskIds: [...dependencyTaskIds].sort(), repositoryId: task.repositoryId,
      stateVersion: task.stateVersion, architecture: { artifactId: task.architectureArtifactId, version: task.architectureVersion, contentHash: task.architectureContentHash, approvalId: task.architectureApprovalId },
      authorityFingerprint: task.planningAuthorityFingerprint,
    };
  }

  private async assertDependencyGraph(tx: Prisma.TransactionClient, projectId: string, rootTaskId: string): Promise<void> {
    const tasks = await tx.kanbanTask.findMany({ where: { stage: { board: { projectId } }, implementationEligible: true }, select: { id: true, dependencies: { select: { dependencyTaskId: true } } } });
    const graph = new Map(tasks.map((task) => [task.id, task.dependencies.map((item) => item.dependencyTaskId)]));
    if (!graph.has(rootTaskId)) throw new ImplementationTaskError("IMPLEMENTATION_TASK_NOT_FOUND", "Task was not found.", 404);
    for (const [id, dependencies] of graph) if (dependencies.includes(id) || dependencies.some((dependency) => !graph.has(dependency)))
      throw new ImplementationTaskError("IMPLEMENTATION_DEPENDENCY_INVALID", "Task dependency is invalid.", 422);
    const visiting = new Set<string>(); const visited = new Set<string>();
    const visit = (id: string): boolean => { if (visiting.has(id)) return false; if (visited.has(id)) return true; visiting.add(id); for (const dependency of graph.get(id) ?? []) if (!visit(dependency)) return false; visiting.delete(id); visited.add(id); return true; };
    if ([...graph.keys()].some((id) => !visit(id))) throw new ImplementationTaskError("IMPLEMENTATION_DEPENDENCY_CYCLE", "Task dependencies contain a cycle.", 422);
  }

  private async finishFailure(executionId: string, taskId: string, category: string, diagnostic: string, evidence?: Prisma.InputJsonObject, stale = false) {
    await this.client.$transaction(async (tx) => {
      await tx.implementationTaskExecution.updateMany({ where: { id: executionId, state: "running" }, data: {
        state: stale ? "authority_stale" : "failed", completedAt: new Date(), leaseExpiresAt: new Date(), failureCategory: category,
        failureDiagnostic: bounded(diagnostic, 4000), ...(evidence ? { validationEvidence: evidence } : {}),
      } });
      await tx.kanbanTask.updateMany({ where: { id: taskId, implementationState: "running" }, data: { implementationState: stale ? "stale" : "failed", status: "failed" } });
    });
    return this.client.implementationTaskExecution.findUniqueOrThrow({ where: { id: executionId } });
  }

  private async expireReview(executionId: string, taskId: string, message: string) {
    await this.client.$transaction(async (tx) => {
      await tx.implementationTaskExecution.updateMany({ where: { id: executionId, state: { in: ["awaiting_review", "shipping_unknown"] } }, data: { state: "review_expired", completedAt: new Date(), failureCategory: "GIT_APPROVAL_EXPIRED", failureDiagnostic: bounded(message, 4000) } });
      await tx.kanbanTask.updateMany({ where: { id: taskId, implementationState: "awaiting_review" }, data: { implementationState: "failed", status: "failed" } });
    });
    throw new ImplementationTaskError("IMPLEMENTATION_REVIEW_EXPIRED", message, 409);
  }

  private gitEnvironment(token: string): Readonly<Record<string, string>> {
    return Object.freeze({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`, "utf8").toString("base64")}` });
  }
}
