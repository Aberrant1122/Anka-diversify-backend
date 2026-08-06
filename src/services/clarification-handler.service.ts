import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export interface ClarificationOption {
  id: string;
  label: string;
  description: string;
  isRecommended?: boolean;
}

export interface CreateClarificationRequest {
  taskId: string;
  question: string;
  options: ClarificationOption[];
}

export class ClarificationHandlerService {
  /**
   * Called by the AI Agent when missing info or out-of-scope ambiguity is encountered.
   * Pauses the task by setting status to 'needs_clarification' and creates a ClarificationQA record.
   */
  async requestClarification(req: CreateClarificationRequest) {
    const qa = await prisma.clarificationQA.create({
      data: {
        taskId: req.taskId,
        question: req.question,
        options: req.options as unknown as object[],
        resolved: false,
      },
    });

    await prisma.kanbanTask.update({
      where: { id: req.taskId },
      data: { status: "needs_clarification" },
    });

    return qa;
  }

  /**
   * Called when the user resolves a clarification modal choice in the UI.
   */
  async resolveClarification(
    clarificationId: string,
    selectedOption: string,
    userNotes?: string
  ) {
    const updatedQa = await prisma.clarificationQA.update({
      where: { id: clarificationId },
      data: {
        selectedOption,
        userNotes,
        resolved: true,
        resolvedAt: new Date(),
      },
      include: { task: true },
    });

    // Check if there are any remaining unresolved clarifications for this task
    const unresolvedCount = await prisma.clarificationQA.count({
      where: {
        taskId: updatedQa.taskId,
        resolved: false,
      },
    });

    if (unresolvedCount === 0) {
      // Resume task execution status
      await prisma.kanbanTask.update({
        where: { id: updatedQa.taskId },
        data: { status: "in_progress" },
      });
    }

    return updatedQa;
  }

  /**
   * Retrieves all resolved clarification decisions for a task to inject into the agent prompt context.
   */
  async getResolvedClarificationContext(taskId: string): Promise<string> {
    const resolvedQAs = await prisma.clarificationQA.findMany({
      where: { taskId, resolved: true },
      orderBy: { resolvedAt: "asc" },
    });

    if (resolvedQAs.length === 0) return "";

    let context = "\n=== USER CLARIFICATIONS & SCOPE DECISIONS ===\n";
    for (const qa of resolvedQAs) {
      context += `Question: ${qa.question}\n`;
      context += `User Selected Choice: ${qa.selectedOption}\n`;
      if (qa.userNotes) {
        context += `User Notes: ${qa.userNotes}\n`;
      }
      context += "----------------------------------------\n";
    }
    return context;
  }
}
