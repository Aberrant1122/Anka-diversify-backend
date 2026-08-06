import { PrismaClient } from "@prisma/client";
import { WorkflowContextService } from "./workflow-context.service";
import { AiService } from "./ai-service";

const prisma = new PrismaClient();
const workflowContextService = new WorkflowContextService();
const aiService = AiService.getInstance();

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

    const completion = await (aiService as any).getOpenAI().chat.completions.create({
      model: "gpt-4o",
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: prompt }],
    });

    const response = completion.choices[0]?.message?.content || "{}";

    let parsed: { stages: Array<{ title: string; order: number; tasks: Array<{ title: string; description: string; acceptanceCriteria: string[]; targetFiles: string[] }> }> };

    try {
      parsed = typeof response === "string" ? JSON.parse(response) : response;
    } catch (err) {
      throw new Error(`Failed to parse AI-generated Kanban board JSON: ${err}`);
    }

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
          create: (parsed.stages || []).map((stage, sIdx) => ({
            title: stage.title,
            order: stage.order ?? sIdx,
            tasks: {
              create: (stage.tasks || []).map((task, tIdx) => ({
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
