import { PrismaClient } from "@prisma/client";
import { WorkflowContextService } from "./workflow-context.service";
import { LLMGateway } from "../ai/gateway/LLMGateway";
import { PipelineStages } from "../ai/gateway/PipelineStage";

const prisma = new PrismaClient();
const workflowContextService = new WorkflowContextService();

interface KanbanTaskProposal {
  title: string;
  description: string;
  acceptanceCriteria: string[];
  targetFiles: string[];
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

export class KanbanService {
  /**
   * Retrieves or initializes the Kanban board for a given project ID.
   */
  async getBoard(projectId: string) {
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
  async generateBoardFromWorkflow(projectId: string) {
    const ctx = await workflowContextService.getProjectWorkflowContext(projectId);
    const boundaryPrompt = workflowContextService.buildSystemBoundaryPrompt(ctx);

    const prompt = `
${boundaryPrompt}

Based STRICTLY on the Project Workflow Documents above:
Decompose this project into logical, step-by-step Kanban tasks categorized into stages.
Ensure every task has explicit titles, descriptions, acceptance criteria, and target files.

Return ONLY a valid JSON object matching this schema:
{
  "stages": [
    {
      "title": "Stage 1: Core Setup & Models",
      "order": 0,
      "tasks": [
        {
          "title": "Define User and Project Prisma Schemas",
          "description": "Create data models as specified in Architecture document.",
          "acceptanceCriteria": ["Prisma schema passes validation", "Exported types compile"],
          "targetFiles": ["prisma/schema.prisma"]
        }
      ]
    }
  ]
}
`;

    const result = await LLMGateway.getInstance().callStructured<KanbanBoardProposal>({
      stage: PipelineStages.TASK_DECOMPOSITION,
      model: "gpt-4o",
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
                      required: ["title", "description", "acceptanceCriteria", "targetFiles"],
                      properties: {
                        title: { type: "string", minLength: 1, maxLength: 200 },
                        description: { type: "string", minLength: 1, maxLength: 2000 },
                        acceptanceCriteria: { type: "array", minItems: 1, maxItems: 20, items: { type: "string", minLength: 1, maxLength: 500 } },
                        targetFiles: { type: "array", maxItems: 50, items: { type: "string", minLength: 1 } },
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
          for (const stage of board.stages) {
            if (!stage || typeof stage !== "object" || Array.isArray(stage)) return { valid: false, errors: ["Invalid stage"] };
            const item = stage as Record<string, unknown>;
            const order = item.order;
            if (Object.keys(item).some((key) => !["title", "order", "tasks"].includes(key)) || typeof item.title !== "string" || !item.title.trim() || typeof order !== "number" || !Number.isInteger(order) || order < 0 || order > 1000 || orders.has(order) || !Array.isArray(item.tasks) || item.tasks.length === 0 || item.tasks.length > 100) return { valid: false, errors: ["Invalid stage fields"] };
            orders.add(order);
            for (const task of item.tasks) {
              if (!task || typeof task !== "object" || Array.isArray(task)) return { valid: false, errors: ["Invalid task"] };
              const entry = task as Record<string, unknown>;
              if (Object.keys(entry).some((key) => !["title", "description", "acceptanceCriteria", "targetFiles"].includes(key)) || typeof entry.title !== "string" || !entry.title.trim() || typeof entry.description !== "string" || !entry.description.trim() || !Array.isArray(entry.acceptanceCriteria) || entry.acceptanceCriteria.length === 0 || entry.acceptanceCriteria.some((criterion) => typeof criterion !== "string" || !criterion.trim()) || !Array.isArray(entry.targetFiles) || entry.targetFiles.some((file) => typeof file !== "string" || !isSafeRelativePath(file))) return { valid: false, errors: ["Invalid task fields"] };
            }
          }
          return { valid: true, data: board as unknown as KanbanBoardProposal };
        },
      },
    });

    // Ensure board exists
    let board = await prisma.kanbanBoard.findUnique({ where: { projectId } });
    if (board) {
      // Clear old stages & tasks for fresh generation
      await prisma.kanbanBoard.delete({ where: { projectId } });
    }

    board = await prisma.kanbanBoard.create({
      data: {
        projectId,
        stages: {
          create: result.content.stages.map((stage, sIdx) => ({
            title: stage.title,
            order: stage.order ?? sIdx,
            tasks: {
              create: stage.tasks.map((task, tIdx) => ({
                title: task.title,
                description: task.description,
                acceptanceCriteria: task.acceptanceCriteria || [],
                targetFiles: task.targetFiles || [],
                status: "todo",
                order: tIdx,
              })),
            },
          })),
        },
      },
      include: {
        stages: {
          include: {
            tasks: true,
          },
        },
      },
    });

    return board;
  }

  /**
   * Updates task status and appends optional execution logs.
   */
  async updateTaskStatus(taskId: string, status: string, executionLogs?: string) {
    return prisma.kanbanTask.update({
      where: { id: taskId },
      data: {
        status,
        ...(executionLogs ? { executionLogs } : {}),
      },
    });
  }

  /**
   * Resolves an interactive user clarification decision.
   */
  async resolveClarification(clarificationId: string, selectedOption: string, userNotes?: string) {
    const qa = await prisma.clarificationQA.update({
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
    const unresolvedCount = await prisma.clarificationQA.count({
      where: { taskId: qa.taskId, resolved: false },
    });

    if (unresolvedCount === 0) {
      await prisma.kanbanTask.update({
        where: { id: qa.taskId },
        data: { status: "in_progress" },
      });
    }

    return qa;
  }
}
