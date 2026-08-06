import { Request, Response } from "express";
import { KanbanService } from "../services/kanban-service";
import { ClarificationHandlerService } from "../services/clarification-handler.service";

const kanbanService = new KanbanService();
const clarificationHandlerService = new ClarificationHandlerService();

export class KanbanController {
  async getBoard(req: Request, res: Response) {
    try {
      const projectId = Array.isArray(req.params.projectId) ? req.params.projectId[0] : req.params.projectId;
      const board = await kanbanService.getBoard(projectId);
      return res.json({ success: true, data: board });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  async generateBoardFromWorkflow(req: Request, res: Response) {
    try {
      const projectId = Array.isArray(req.params.projectId) ? req.params.projectId[0] : req.params.projectId;
      const board = await kanbanService.generateBoardFromWorkflow(projectId);
      return res.json({ success: true, data: board });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  async updateTaskStatus(req: Request, res: Response) {
    try {
      const taskId = Array.isArray(req.params.taskId) ? req.params.taskId[0] : req.params.taskId;
      const { status, executionLogs } = req.body;
      const updated = await kanbanService.updateTaskStatus(taskId, status, executionLogs);
      return res.json({ success: true, data: updated });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  async requestClarification(req: Request, res: Response) {
    try {
      const { taskId, question, options } = req.body;
      const qa = await clarificationHandlerService.requestClarification({
        taskId,
        question,
        options,
      });
      return res.json({ success: true, data: qa });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  async resolveClarification(req: Request, res: Response) {
    try {
      const clarificationId = Array.isArray(req.params.clarificationId) ? req.params.clarificationId[0] : req.params.clarificationId;
      const { selectedOption, userNotes } = req.body;
      const resolved = await kanbanService.resolveClarification(clarificationId, selectedOption, userNotes);
      return res.json({ success: true, data: resolved });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }
}
