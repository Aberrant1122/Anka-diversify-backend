import crypto from "crypto";
import { PrismaClient } from "@prisma/client";
import { WorkflowContextService } from "./workflow-context.service";
import { LLMGateway } from "../ai/gateway/LLMGateway";
import { PipelineStages } from "../ai/gateway/PipelineStage";
import { Prisma } from "@prisma/client";
import { currentImplementationAuthority, resolveImplementationAuthority } from "../planning/implementation-authority-preflight";
import { PlanningDomainError } from "../planning/planning-errors";
import { PlanningAuthorizationService } from "./planning-authorization.service";

const prisma = new PrismaClient();
const workflowContextService = new WorkflowContextService();
const authorization = new PlanningAuthorizationService(prisma);

interface KanbanTaskProposal {
  key: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  targetFiles: string[];
  architectureComponentIds: string[];
  dependencyKeys: string[];
}

interface KanbanStageProposal {
  title: string;
  order: number;
  tasks: KanbanTaskProposal[];
}

interface KanbanBoardProposal {
  stages: KanbanStageProposal[];
}

function isSafeRelativePath(value: string): boolean {
  if (!value || value !== value.trim() || value.includes("\0")) return false;
  const normalized = value.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) return false;
  return normalized.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function assertProposalGraph(board: KanbanBoardProposal): void {
  const tasks = board.stages.flatMap((stage) => stage.tasks);
  const keys = new Set<string>();
  for (const task of tasks) {
    if (typeof task.key !== "string" || !Array.isArray(task.dependencyKeys) || !Array.isArray(task.architectureComponentIds))
      throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", "Generated task omitted required implementation references.", 422);
    if (keys.has(task.key)) throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", "Generated tasks contain a duplicate key.", 422);
    keys.add(task.key);
  }
  const graph = new Map(tasks.map((task) => [task.key, task.dependencyKeys]));
  for (const task of tasks) {
    if (task.dependencyKeys.includes(task.key) || task.dependencyKeys.some((key) => !keys.has(key)))
      throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", "Generated task dependency reference is invalid.", 422);
  }
  const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (key: string): boolean => {
    if (visiting.has(key)) return false;
    if (visited.has(key)) return true;
    visiting.add(key);
    for (const dependency of graph.get(key) ?? []) if (!visit(dependency)) return false;
    visiting.delete(key); visited.add(key); return true;
  };
  if ([...keys].some((key) => !visit(key)))
    throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", "Generated task dependencies contain a cycle.", 422);
}

export class KanbanService {
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
                dependencies: true,
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
  async generateBoardFromWorkflow(projectId: string, actorId: string) {
    const accepted = await currentImplementationAuthority(prisma, projectId, actorId);
    const ctx = { projectId, requirements: accepted.requirements.artifact.content,
      documentation: accepted.documentation.artifact.content,
      architecture: accepted.architecture.artifact.content };
    const boundaryPrompt = workflowContextService.buildSystemBoundaryPrompt(ctx);

    const prompt = `
${boundaryPrompt}

Based STRICTLY on the Project Workflow Documents above:
Decompose this project into logical, step-by-step Kanban tasks categorized into stages.
Ensure every task has explicit titles, descriptions, acceptance criteria, and target files.
Each task must have a unique stable key, one or more exact Architecture component IDs,
and dependencyKeys containing only keys of prerequisite tasks. Do not invent component IDs.

Return ONLY a valid JSON object matching this schema:
{
  "stages": [
    {
      "title": "Stage 1: Core Setup & Models",
      "order": 0,
      "tasks": [
        {
          "key": "TASK-USER-SCHEMA",
          "title": "Define User and Project Prisma Schemas",
          "description": "Create data models as specified in Architecture document.",
          "acceptanceCriteria": ["Prisma schema passes validation", "Exported types compile"],
          "targetFiles": ["prisma/schema.prisma"],
          "architectureComponentIds": ["ARCH-COMP-DATA"],
          "dependencyKeys": []
        }
      ]
    }
  ]
}
`;

    const result = await LLMGateway.getInstance().callStructured<KanbanBoardProposal>({
      stage: PipelineStages.TASK_DECOMPOSITION,
      messages: [{ role: "user", content: prompt }],
      schema: {
        name: "KanbanBoardProposalSchema",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["stages"],
          properties: {
            stages: {
              type: "array",
              minItems: 1,
              maxItems: 20,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["title", "order", "tasks"],
                properties: {
                  title: { type: "string", minLength: 1, maxLength: 200 },
                  order: { type: "integer", minimum: 0, maximum: 1000 },
                  tasks: {
                    type: "array",
                    minItems: 1,
                    maxItems: 100,
                    items: {
                      type: "object",
                      additionalProperties: false,
                      required: ["key", "title", "description", "acceptanceCriteria", "targetFiles", "architectureComponentIds", "dependencyKeys"],
                      properties: {
                        key: { type: "string", pattern: "^[A-Z0-9][A-Z0-9_-]{0,79}$" },
                        title: { type: "string", minLength: 1, maxLength: 200 },
                        description: { type: "string", minLength: 1, maxLength: 2000 },
                        acceptanceCriteria: { type: "array", minItems: 1, maxItems: 20, items: { type: "string", minLength: 1, maxLength: 500 } },
                        targetFiles: { type: "array", maxItems: 50, items: { type: "string", minLength: 1 } },
                        architectureComponentIds: { type: "array", minItems: 1, maxItems: 50, items: { type: "string", minLength: 1 } },
                        dependencyKeys: { type: "array", maxItems: 100, items: { type: "string", minLength: 1 } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        validate: (value: unknown) => {
          if (!value || typeof value !== "object" || Array.isArray(value)) return { valid: false, errors: ["Kanban proposal must be an object"] };
          const board = value as Record<string, unknown>;
          if (Object.keys(board).some((key) => key !== "stages") || !Array.isArray(board.stages) || board.stages.length === 0 || board.stages.length > 20) return { valid: false, errors: ["Invalid stages"] };
          const orders = new Set<number>();
          const taskKeys = new Set<string>();
          const taskEntries: Array<Record<string, unknown>> = [];
          for (const stage of board.stages) {
            if (!stage || typeof stage !== "object" || Array.isArray(stage)) return { valid: false, errors: ["Invalid stage"] };
            const item = stage as Record<string, unknown>;
            const order = item.order;
            if (Object.keys(item).some((key) => !["title", "order", "tasks"].includes(key)) || typeof item.title !== "string" || !item.title.trim() || typeof order !== "number" || !Number.isInteger(order) || order < 0 || order > 1000 || orders.has(order) || !Array.isArray(item.tasks) || item.tasks.length === 0 || item.tasks.length > 100) return { valid: false, errors: ["Invalid stage fields"] };
            orders.add(order);
            for (const task of item.tasks) {
              if (!task || typeof task !== "object" || Array.isArray(task)) return { valid: false, errors: ["Invalid task"] };
              const entry = task as Record<string, unknown>;
              if (Object.keys(entry).some((key) => !["key", "title", "description", "acceptanceCriteria", "targetFiles", "architectureComponentIds", "dependencyKeys"].includes(key)) || typeof entry.key !== "string" || !/^[A-Z0-9][A-Z0-9_-]{0,79}$/.test(entry.key) || taskKeys.has(entry.key) || typeof entry.title !== "string" || !entry.title.trim() || typeof entry.description !== "string" || !entry.description.trim() || !Array.isArray(entry.acceptanceCriteria) || entry.acceptanceCriteria.length === 0 || entry.acceptanceCriteria.some((criterion) => typeof criterion !== "string" || !criterion.trim()) || !Array.isArray(entry.targetFiles) || entry.targetFiles.some((file) => typeof file !== "string" || !isSafeRelativePath(file)) || !Array.isArray(entry.architectureComponentIds) || entry.architectureComponentIds.length === 0 || entry.architectureComponentIds.some((id) => typeof id !== "string" || !id.trim()) || new Set(entry.architectureComponentIds).size !== entry.architectureComponentIds.length || !Array.isArray(entry.dependencyKeys) || entry.dependencyKeys.some((key) => typeof key !== "string" || !key.trim()) || new Set(entry.dependencyKeys).size !== entry.dependencyKeys.length) return { valid: false, errors: ["Invalid task fields"] };
              taskKeys.add(entry.key);
              taskEntries.push(entry);
            }
          }
          for (const entry of taskEntries) {
            const key = entry.key as string;
            if ((entry.dependencyKeys as string[]).includes(key) || (entry.dependencyKeys as string[]).some((dependency) => !taskKeys.has(dependency))) return { valid: false, errors: ["Invalid task dependency reference"] };
          }
          const dependencies = new Map(taskEntries.map((entry) => [entry.key as string, entry.dependencyKeys as string[]]));
          const visiting = new Set<string>();
          const visited = new Set<string>();
          const visit = (key: string): boolean => {
            if (visiting.has(key)) return false;
            if (visited.has(key)) return true;
            visiting.add(key);
            for (const dependency of dependencies.get(key) ?? []) if (!visit(dependency)) return false;
            visiting.delete(key);
            visited.add(key);
            return true;
          };
          if ([...taskKeys].some((key) => !visit(key))) return { valid: false, errors: ["Task dependencies contain a cycle"] };
          return { valid: true, data: board as unknown as KanbanBoardProposal };
        },
      },
    });

    assertProposalGraph(result.content);

    return prisma.$transaction(async (tx) => {
      const current = await resolveImplementationAuthority(tx, projectId, actorId);
      if (current.fingerprint !== accepted.fingerprint)
        throw new PlanningDomainError("PLANNING_CONTEXT_CHANGED", "Implementation planning authority changed during task generation.", 409);
      const componentIds = new Set(current.architecture.content.components.map((component) => component.id));
      const proposedTasks = result.content.stages.flatMap((stage) => stage.tasks);
      if (proposedTasks.some((task) => task.architectureComponentIds.some((id) => !componentIds.has(id))))
        throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", "Generated task references an unknown Architecture component.", 422);
      const existing = await tx.kanbanBoard.findUnique({ where: { projectId }, include: { stages: { include: { tasks: true } } } });
      if (existing?.stages.some((stage) => stage.tasks.length > 0))
        throw new PlanningDomainError("PLANNING_INITIAL_ARTIFACT_EXISTS", "Kanban regeneration would overwrite existing tasks.", 409);
      if (existing) await tx.kanbanStage.deleteMany({ where: { boardId: existing.id } });
      const board = existing ?? await tx.kanbanBoard.create({ data: { projectId } });
      const taskIds = new Map(proposedTasks.map((task) => [task.key, crypto.randomUUID()]));
      for (const [sIdx, stage] of result.content.stages.entries()) {
        await tx.kanbanStage.create({ data: {
          boardId: board.id,
          title: stage.title,
          order: stage.order ?? sIdx,
          tasks: { create: stage.tasks.map((task, tIdx) => ({
            id: taskIds.get(task.key)!,
            title: task.title,
            description: task.description,
            acceptanceCriteria: task.acceptanceCriteria || [],
            targetFiles: task.targetFiles || [],
            status: "todo",
            order: tIdx,
            implementationEligible: true,
            implementationState: "draft",
            architectureArtifactId: current.architecture.artifact.id,
            architectureVersion: current.architecture.artifact.version,
            architectureContentHash: current.architecture.contentHash,
            architectureApprovalId: current.architecture.approvalId,
            planningAuthorityFingerprint: current.fingerprint,
            architectureComponentIds: task.architectureComponentIds,
          })) },
        } });
      }
      await tx.implementationTaskDependency.createMany({ data: proposedTasks.flatMap((task) =>
        task.dependencyKeys.map((dependencyKey) => ({ taskId: taskIds.get(task.key)!, dependencyTaskId: taskIds.get(dependencyKey)! }))) });
      return tx.kanbanBoard.findUniqueOrThrow({ where: { id: board.id }, include: { stages: { orderBy: { order: "asc" }, include: { tasks: { orderBy: { order: "asc" }, include: { dependencies: true } } } } } });

    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
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
