import { Router } from "express";
import { SprintController } from "../controllers/sprint-controller";

const router = Router({ mergeParams: true });
const sprintController = new SprintController();

// GET    /api/projects/:projectId/sprints
router.get("/", sprintController.getSprints.bind(sprintController));

// POST   /api/projects/:projectId/sprints
router.post("/", sprintController.createSprint.bind(sprintController));

// PUT    /api/projects/:projectId/sprints/:sprintId
router.put("/:sprintId", sprintController.updateSprint.bind(sprintController));

// DELETE /api/projects/:projectId/sprints/:sprintId
router.delete("/:sprintId", sprintController.deleteSprint.bind(sprintController));

// POST   /api/projects/:projectId/sprints/:sprintId/tasks
router.post("/:sprintId/tasks", sprintController.addTaskToSprint.bind(sprintController));

// DELETE /api/projects/:projectId/sprints/:sprintId/tasks/:taskId
router.delete("/:sprintId/tasks/:taskId", sprintController.removeTaskFromSprint.bind(sprintController));

export default router;
