import { Request, Response } from "express";
import { KanbanService } from "../services/kanban-service";
import { ClarificationHandlerService } from "../services/clarification-handler.service";
import { isPlanningDomainError } from "../planning/planning-errors";
import { currentImplementationAuthority } from "../planning/implementation-authority-preflight";
import { prisma } from "../services/database";
import { ImplementationTaskLifecycleService, isImplementationTaskError } from "../services/implementation-task-lifecycle.service";

const kanbanService = new KanbanService();
const clarificationHandlerService = new ClarificationHandlerService();
const implementationTasks = new ImplementationTaskLifecycleService(prisma);

function projectId(req: Request): string { return Array.isArray(req.params.projectId) ? req.params.projectId[0] : req.params.projectId; }
function actorId(req: Request): string | undefined { return req.user?.userId as string | undefined; }
function respondError(res: Response, error: unknown) {
  if (isImplementationTaskError(error)) return res.status(error.httpStatus).json({ success: false, error: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) });
  if (isPlanningDomainError(error)) return res.status(error.httpStatus).json({ success: false, error: error.code, message: error.message });
  return res.status(500).json({ success: false, error: "IMPLEMENTATION_INTERNAL_ERROR", message: error instanceof Error ? error.message : "Unknown error" });
}

export class KanbanController {
  async getBoard(req: Request, res: Response) {
    try {
      const projectId = Array.isArray(req.params.projectId) ? req.params.projectId[0] : req.params.projectId;
      const actor = actorId(req);
      if (!actor) return res.status(401).json({ success: false, error: "Authentication required" });
      const board = await kanbanService.getBoard(projectId, actor);
      return res.json({ success: true, data: board });
    } catch (err: unknown) {
      return respondError(res, err);
    }
  }

  async generateBoardFromWorkflow(req: Request, res: Response) {
    try {
      const projectId = Array.isArray(req.params.projectId) ? req.params.projectId[0] : req.params.projectId;
      const actorId = req.user?.userId as string | undefined;
      if (!actorId) return res.status(401).json({ success: false, error: "Authentication required" });
      await currentImplementationAuthority(prisma, projectId, actorId);
      const board = await kanbanService.generateBoardFromWorkflow(projectId, actorId);
      return res.json({ success: true, data: board });
    } catch (err: any) {
      if (isPlanningDomainError(err)) return res.status(err.httpStatus).json({ success: false, error: err.code, message: err.message });
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  async updateTaskStatus(req: Request, res: Response) {
    try {
      const taskId = Array.isArray(req.params.taskId) ? req.params.taskId[0] : req.params.taskId;
      const { status, executionLogs } = req.body;
      const actor = actorId(req);
      if (!actor) return res.status(401).json({ success: false, error: "Authentication required" });
      const updated = await kanbanService.updateTaskStatus(projectId(req), taskId, actor, status, executionLogs);
      return res.json({ success: true, data: updated });
    } catch (err: unknown) {
      return respondError(res, err);
    }
  }

  async editImplementationTask(req: Request, res: Response) {
    try {
      const actor = actorId(req); if (!actor) return res.status(401).json({ success: false, error: "Authentication required" });
      const taskId = Array.isArray(req.params.taskId) ? req.params.taskId[0] : req.params.taskId;
      return res.json({ success: true, data: await implementationTasks.editTask(projectId(req), taskId, actor, req.body ?? {}) });
    } catch (error) { return respondError(res, error); }
  }

  async approveImplementationTask(req: Request, res: Response) {
    try {
      const actor = actorId(req); if (!actor) return res.status(401).json({ success: false, error: "Authentication required" });
      const taskId = Array.isArray(req.params.taskId) ? req.params.taskId[0] : req.params.taskId;
      return res.json({ success: true, data: await implementationTasks.approveTask(projectId(req), taskId, actor, req.body?.expectedStateVersion) });
    } catch (error) { return respondError(res, error); }
  }

  async startImplementationExecution(req: Request, res: Response) {
    try {
      const actor = actorId(req); if (!actor) return res.status(401).json({ success: false, error: "Authentication required" });
      const taskId = Array.isArray(req.params.taskId) ? req.params.taskId[0] : req.params.taskId;
      const key = typeof req.body?.idempotencyKey === "string" ? req.body.idempotencyKey.trim() : "";
      return res.status(202).json({ success: true, data: await implementationTasks.startExecution(projectId(req), taskId, actor, key) });
    } catch (error) { return respondError(res, error); }
  }

  async listImplementationExecutions(req: Request, res: Response) {
    try {
      const actor = actorId(req); if (!actor) return res.status(401).json({ success: false, error: "Authentication required" });
      const taskId = Array.isArray(req.params.taskId) ? req.params.taskId[0] : req.params.taskId;
      return res.json({ success: true, data: await implementationTasks.listExecutions(projectId(req), taskId, actor) });
    } catch (error) { return respondError(res, error); }
  }

  async getImplementationExecution(req: Request, res: Response) {
    try {
      const actor = actorId(req); if (!actor) return res.status(401).json({ success: false, error: "Authentication required" });
      const taskId = Array.isArray(req.params.taskId) ? req.params.taskId[0] : req.params.taskId;
      const executionId = Array.isArray(req.params.executionId) ? req.params.executionId[0] : req.params.executionId;
      return res.json({ success: true, data: await implementationTasks.getExecution(projectId(req), taskId, executionId, actor) });
    } catch (error) { return respondError(res, error); }
  }

  async acceptImplementationExecution(req: Request, res: Response) {
    try {
      const actor = actorId(req); if (!actor) return res.status(401).json({ success: false, error: "Authentication required" });
      const taskId = Array.isArray(req.params.taskId) ? req.params.taskId[0] : req.params.taskId;
      const executionId = Array.isArray(req.params.executionId) ? req.params.executionId[0] : req.params.executionId;
      return res.json({ success: true, data: await implementationTasks.acceptExecution(projectId(req), taskId, executionId, actor, req.body ?? {}) });
    } catch (error) { return respondError(res, error); }
  }

  async rejectImplementationExecution(req: Request, res: Response) {
    try {
      const actor = actorId(req); if (!actor) return res.status(401).json({ success: false, error: "Authentication required" });
      const taskId = Array.isArray(req.params.taskId) ? req.params.taskId[0] : req.params.taskId;
      const executionId = Array.isArray(req.params.executionId) ? req.params.executionId[0] : req.params.executionId;
      return res.json({ success: true, data: await implementationTasks.rejectExecution(projectId(req), taskId, executionId, actor, typeof req.body?.comments === "string" ? req.body.comments : "") });
    } catch (error) { return respondError(res, error); }
  }

  async requestClarification(req: Request, res: Response) {
    try {
      const actor = actorId(req);
      if (!actor) return res.status(401).json({ success: false, error: "Authentication required" });
      const { taskId, question, options } = req.body;
      const qa = await clarificationHandlerService.requestClarification({
        projectId: projectId(req),
        actorId: actor,
        taskId,
        question,
        options,
      });
      return res.json({ success: true, data: qa });
    } catch (err: unknown) {
      return respondError(res, err);
    }
  }

  async resolveClarification(req: Request, res: Response) {
    try {
      const actor = actorId(req);
      if (!actor) return res.status(401).json({ success: false, error: "Authentication required" });
      const clarificationId = Array.isArray(req.params.clarificationId) ? req.params.clarificationId[0] : req.params.clarificationId;
      const { selectedOption, userNotes } = req.body;
      const resolved = await kanbanService.resolveClarification(projectId(req), clarificationId, actor, selectedOption, userNotes);
      return res.json({ success: true, data: resolved });
    } catch (err: unknown) {
      return respondError(res, err);
    }
  }
}
