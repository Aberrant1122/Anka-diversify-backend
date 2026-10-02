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

// Controlled Architecture-derived implementation task lifecycle.
router.patch("/tasks/:taskId", kanbanController.editImplementationTask.bind(kanbanController));
router.post("/tasks/:taskId/approve", kanbanController.approveImplementationTask.bind(kanbanController));
router.post("/tasks/:taskId/executions", kanbanController.startImplementationExecution.bind(kanbanController));
router.get("/tasks/:taskId/executions", kanbanController.listImplementationExecutions.bind(kanbanController));
router.get("/tasks/:taskId/executions/:executionId", kanbanController.getImplementationExecution.bind(kanbanController));
router.post("/tasks/:taskId/executions/:executionId/accept", kanbanController.acceptImplementationExecution.bind(kanbanController));
router.post("/tasks/:taskId/executions/:executionId/reject", kanbanController.rejectImplementationExecution.bind(kanbanController));

// POST /api/projects/:projectId/kanban/clarifications — Request clarification (Pause execution)
router.post("/clarifications", kanbanController.requestClarification.bind(kanbanController));

// POST /api/projects/:projectId/kanban/clarifications/:clarificationId/resolve — Resolve clarification decision
router.post("/clarifications/:clarificationId/resolve", kanbanController.resolveClarification.bind(kanbanController));

export default router;
