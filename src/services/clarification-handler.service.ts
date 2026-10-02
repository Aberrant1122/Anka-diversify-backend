import { PrismaClient } from "@prisma/client";
import { PlanningAuthorizationService } from "./planning-authorization.service";
import { PlanningDomainError } from "../planning/planning-errors";

const prisma = new PrismaClient();
const authorization = new PlanningAuthorizationService(prisma);

export interface ClarificationOption {
  id: string;
  label: string;
  description: string;
  isRecommended?: boolean;
}

export interface CreateClarificationRequest {
  projectId: string;
  actorId: string;
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
    return prisma.$transaction(async (tx) => {
      await authorization.assertCanEditInTransaction(tx, req.projectId, req.actorId);
      const task = await tx.kanbanTask.findFirst({ where: { id: req.taskId, stage: { board: { projectId: req.projectId } } }, select: { id: true, implementationEligible: true } });
      if (!task) throw new PlanningDomainError("PLANNING_PROJECT_NOT_FOUND", "Task was not found in this project.", 404);
      if (task.implementationEligible) throw new PlanningDomainError("PLANNING_ACTION_LOCKED", "Controlled implementation tasks cannot be mutated through legacy clarification routes.", 409);
      const qa = await tx.clarificationQA.create({ data: { taskId: task.id, question: req.question, options: req.options as unknown as object[], resolved: false } });
      await tx.kanbanTask.update({ where: { id: task.id }, data: { status: "needs_clarification" } });
      return qa;
    });
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
