import { Router } from "express";
import { KanbanController } from "../controllers/kanban-controller";

const router = Router({ mergeParams: true });
const kanbanController = new KanbanController();

// GET  /api/projects/:projectId/kanban — Get Kanban Board & Tasks
router.get("/", kanbanController.getBoard.bind(kanbanController));

// POST /api/projects/:projectId/kanban/generate — Generate Kanban Board from Project Workflow subtabs
router.post("/generate", kanbanController.generateBoardFromWorkflow.bind(kanbanController));

// PATCH /api/projects/:projectId/kanban/tasks/:taskId/status — Update task status
router.patch("/tasks/:taskId/status", kanbanController.updateTaskStatus.bind(kanbanController));

// POST /api/projects/:projectId/kanban/clarifications — Request clarification (Pause execution)
router.post("/clarifications", kanbanController.requestClarification.bind(kanbanController));

// POST /api/projects/:projectId/kanban/clarifications/:clarificationId/resolve — Resolve clarification decision
router.post("/clarifications/:clarificationId/resolve", kanbanController.resolveClarification.bind(kanbanController));

export default router;
