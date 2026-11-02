import { Router } from "express";
import { ProjectRepositoryController } from "../controllers/project-repository-controller";

import { bindProjectResources } from '../middleware/project-owner';
const router = Router({ mergeParams: true });
bindProjectResources(router, {"repoId":"projectRepository"});
const repoController = new ProjectRepositoryController();

// GET    /api/projects/:projectId/repositories
router.get("/", repoController.list.bind(repoController));

// POST   /api/projects/:projectId/repositories
router.post("/", repoController.create.bind(repoController));

// PUT    /api/projects/:projectId/repositories/:repoId
router.put("/:repoId", repoController.update.bind(repoController));

// POST   /api/projects/:projectId/repositories/:repoId/sync — pull fresh AI context for this repo
router.post("/:repoId/sync", repoController.sync.bind(repoController));

// DELETE /api/projects/:projectId/repositories/:repoId
router.delete("/:repoId", repoController.remove.bind(repoController));

export default router;
