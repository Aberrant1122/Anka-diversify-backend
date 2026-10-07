import { Router } from "express";
import { SprintController } from "../controllers/sprint-controller";
import { bodyResource, requireProjectResources, routeResource } from "../middleware/project-resource-binding";

const router = Router({ mergeParams: true });
const sprintController = new SprintController();
const bind = (...resources: Parameters<typeof requireProjectResources>[1][]) =>
  requireProjectResources("projectId", ...resources);

// GET    /api/projects/:projectId/sprints
router.get("/", sprintController.getSprints.bind(sprintController));

// POST   /api/projects/:projectId/sprints
router.post("/", sprintController.createSprint.bind(sprintController));

// PUT    /api/projects/:projectId/sprints/:sprintId
router.put("/:sprintId", bind(routeResource("sprintId", "sprint")), sprintController.updateSprint.bind(sprintController));

// DELETE /api/projects/:projectId/sprints/:sprintId
router.delete("/:sprintId", bind(routeResource("sprintId", "sprint")), sprintController.deleteSprint.bind(sprintController));

// POST   /api/projects/:projectId/sprints/:sprintId/tasks
router.post("/:sprintId/tasks", bind(routeResource("sprintId", "sprint"), bodyResource("taskId", "task")), sprintController.addTaskToSprint.bind(sprintController));

// DELETE /api/projects/:projectId/sprints/:sprintId/tasks/:taskId
router.delete("/:sprintId/tasks/:taskId", bind(routeResource("sprintId", "sprint"), routeResource("taskId", "task")), sprintController.removeTaskFromSprint.bind(sprintController));

export default router;
