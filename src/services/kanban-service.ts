import crypto from "crypto";
import { PrismaClient } from "@prisma/client";
import { WorkflowContextService } from "./workflow-context.service";
import { LLMGateway } from "../ai/gateway/LLMGateway";
import { PipelineStages } from "../ai/gateway/PipelineStage";
import { Prisma } from "@prisma/client";
import { currentImplementationAuthority, resolveImplementationAuthority } from "../planning/implementation-authority-preflight";
import { PlanningDomainError } from "../planning/planning-errors";
import { PlanningAuthorizationService } from "./planning-authorization.service";
import {
  TaskDecomposer,
  KanbanBoardProposal,
  KanbanStageProposal,
  KanbanTaskProposal,
} from "./task-decomposer";

const prisma = new PrismaClient();
const authorization = new PlanningAuthorizationService(prisma);

export class KanbanService {
  private readonly taskDecomposer = new TaskDecomposer();
  private static readonly idempotencyCache = new Map<string, { boardId: string; fingerprint: string }>();

  /**
   * Retrieves or initializes the Kanban board for a given project ID.
   */
  async getBoard(projectId: string, actorId?: string) {
    if (actorId) await authorization.assertCanRead(projectId, actorId);
    let board = await prisma.kanbanBoard.findUnique({
      where: { projectId },
      include: {
        stages: {
          orderBy: { order: "asc" },
          include: {
            tasks: {
              orderBy: { order: "asc" },
              include: {
                clarifications: {
                  orderBy: { createdAt: "asc" },
                },
                dependencies: {
                  include: {
                    dependencyTask: {
                      select: { id: true, title: true, implementationState: true },
                    },
                  },
                },
                repository: {
                  select: { id: true, name: true, role: true },
                },
              },
            },
          },
        },
      },
    });

    if (!board) {
      board = await prisma.kanbanBoard.create({
        data: {
          projectId,
          stages: {
            create: [
              { title: "To Do", order: 0 },
              { title: "In Progress", order: 1 },
              { title: "Needs Clarification", order: 2 },
              { title: "Completed", order: 3 },
            ],
          },
        },
        include: {
          stages: {
            orderBy: { order: "asc" },
            include: {
              tasks: {
                include: {
                  clarifications: true,
                  dependencies: true,
                },
              },
            },
          },
        },
      });
    }

    return board;
  }

  /**
   * Generates Kanban stages & tasks based strictly on the project's Workflow Phase Artifacts
   * (Requirements, Documentation, Architecture, Implementation).
   */
  async generateBoardFromWorkflow(
    projectId: string,
    actorId: string,
    options?: { idempotencyKey?: string }
  ) {
    const accepted = await currentImplementationAuthority(prisma, projectId, actorId);

    if (options?.idempotencyKey) {
      const cached = KanbanService.idempotencyCache.get(options.idempotencyKey);
      if (cached) {
        if (cached.fingerprint === accepted.fingerprint) {
          return this.getBoard(projectId, actorId);
        }
        throw new PlanningDomainError(
          "PLANNING_IDEMPOTENCY_CONFLICT",
          "Idempotency key was used with a different authority fingerprint.",
          409
        );
      }
    }

    const repos = await prisma.projectRepository.findMany({
      where: { projectId },
      select: { id: true, name: true, role: true },
    });

    const proposal = await this.taskDecomposer.decomposeArchitecture(accepted, {
      availableRepositories: repos,
    });

    return prisma.$transaction(
      async (tx) => {
        const current = await resolveImplementationAuthority(tx, projectId, actorId);
        if (current.fingerprint !== accepted.fingerprint) {
          throw new PlanningDomainError(
            "PLANNING_CONTEXT_CHANGED",
            "Implementation planning authority changed during task generation.",
            409
          );
        }

        const currentRepos = await tx.projectRepository.findMany({
          where: { projectId },
          select: { id: true, name: true, role: true },
        });

        this.taskDecomposer.validateArchitectureProposal(proposal, current, currentRepos);

        const existing = await tx.kanbanBoard.findUnique({
          where: { projectId },
          include: { stages: { include: { tasks: true } } },
        });

        if (existing?.stages.some((stage) => stage.tasks.length > 0)) {
          throw new PlanningDomainError(
            "PLANNING_INITIAL_ARTIFACT_EXISTS",
            "Kanban regeneration would overwrite existing tasks.",
            409
          );
        }

        if (existing) {
          await tx.kanbanStage.deleteMany({ where: { boardId: existing.id } });
        }

        const board = existing ?? (await tx.kanbanBoard.create({ data: { projectId } }));

        const proposedTasks = proposal.stages.flatMap((stage) => stage.tasks);
        const taskIds = new Map(proposedTasks.map((task) => [task.key, crypto.randomUUID()]));

        for (const [sIdx, stage] of proposal.stages.entries()) {
          await tx.kanbanStage.create({
            data: {
              boardId: board.id,
              title: stage.title,
              order: stage.order ?? sIdx,
              tasks: {
                create: stage.tasks.map((task, tIdx) => ({
                  id: taskIds.get(task.key)!,
                  title: task.title,
                  description: task.description,
                  acceptanceCriteria: task.acceptanceCriteria || [],
                  targetFiles: task.targetFiles || [],
                  status: "todo",
                  order: tIdx,
                  implementationEligible: true,
                  implementationState: "draft",
                  stateVersion: 0,
                  architectureArtifactId: current.architecture.artifact.id,
                  architectureVersion: current.architecture.artifact.version,
                  architectureContentHash: current.architecture.contentHash,
                  architectureApprovalId: current.architecture.approvalId,
                  planningAuthorityFingerprint: current.fingerprint,
                  architectureComponentIds: task.architectureComponentIds,
                  repositoryId: task.repositoryId ?? (currentRepos.length === 1 ? currentRepos[0].id : null),
                })),
              },
            },
          });
        }

        const depData = proposedTasks.flatMap((task) =>
          task.dependencyKeys.map((dependencyKey) => ({
            taskId: taskIds.get(task.key)!,
            dependencyTaskId: taskIds.get(dependencyKey)!,
          }))
        );

        if (depData.length > 0) {
          await tx.implementationTaskDependency.createMany({ data: depData });
        }

        const savedBoard = await tx.kanbanBoard.findUniqueOrThrow({
          where: { id: board.id },
          include: {
            stages: {
              orderBy: { order: "asc" },
              include: {
                tasks: {
                  orderBy: { order: "asc" },
                  include: {
                    dependencies: {
                      include: {
                        dependencyTask: {
                          select: { id: true, title: true, implementationState: true },
                        },
                      },
                    },
                    repository: {
                      select: { id: true, name: true, role: true },
                    },
                  },
                },
              },
            },
          },
        });

        if (options?.idempotencyKey) {
          KanbanService.idempotencyCache.set(options.idempotencyKey, {
            boardId: savedBoard.id,
            fingerprint: current.fingerprint,
          });
        }

        return savedBoard;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
  }

  /**
   * Updates task status and appends optional execution logs.
   */
  async updateTaskStatus(projectId: string, taskId: string, actorId: string, status: string, executionLogs?: string) {
    await authorization.assertCanEdit(projectId, actorId);
    const task = await prisma.kanbanTask.findFirst({ where: { id: taskId, stage: { board: { projectId } } }, select: { id: true, implementationEligible: true } });
    if (!task) throw new PlanningDomainError("PLANNING_PROJECT_NOT_FOUND", "Task was not found in this project.", 404);
    if (task.implementationEligible)
      throw new PlanningDomainError("PLANNING_ACTION_LOCKED", "Controlled implementation tasks must use lifecycle endpoints.", 409);
    if (!["todo", "in_progress", "needs_clarification", "completed", "failed"].includes(status))
      throw new PlanningDomainError("PLANNING_INVALID_TRANSITION", "Unsupported legacy Kanban status.", 400);
    return prisma.kanbanTask.update({
      where: { id: task.id },
      data: {
        status,
        ...(executionLogs ? { executionLogs } : {}),
      },
    });
  }

  /**
   * Resolves an interactive user clarification decision.
   */
  async resolveClarification(projectId: string, clarificationId: string, actorId: string, selectedOption: string, userNotes?: string) {
    return prisma.$transaction(async (tx) => {
    await authorization.assertCanEditInTransaction(tx, projectId, actorId);
    const existing = await tx.clarificationQA.findFirst({ where: { id: clarificationId, task: { stage: { board: { projectId } } } }, include: { task: true } });
    if (!existing) throw new PlanningDomainError("PLANNING_PROJECT_NOT_FOUND", "Clarification was not found in this project.", 404);
    if (existing.task.implementationEligible) throw new PlanningDomainError("PLANNING_ACTION_LOCKED", "Controlled implementation tasks cannot be mutated through legacy clarification routes.", 409);
    const qa = await tx.clarificationQA.update({
      where: { id: clarificationId },
      data: {
        selectedOption,
        userNotes,
        resolved: true,
        resolvedAt: new Date(),
      },
      include: { task: true },
    });

    // Check if task has any remaining unresolved clarifications
    const unresolvedCount = await tx.clarificationQA.count({
      where: { taskId: qa.taskId, resolved: false },
    });

    if (unresolvedCount === 0) {
      await tx.kanbanTask.update({
        where: { id: qa.taskId },
        data: { status: "in_progress" },
      });
    }

    return qa;
    });
  }
}
