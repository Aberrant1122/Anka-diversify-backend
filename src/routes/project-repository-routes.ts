import { Router } from "express";
import { ProjectRepositoryController } from "../controllers/project-repository-controller";
import { requireProjectOwner } from "../middleware/project-access";

const router = Router({ mergeParams: true });
const repoController = new ProjectRepositoryController();

// GET    /api/projects/:projectId/repositories
router.get("/", repoController.list.bind(repoController));

// GET    /api/projects/:projectId/repositories/bootstrap-templates
router.get("/bootstrap-templates", repoController.listTemplates.bind(repoController));

// POST   /api/projects/:projectId/repositories/bind-existing (Owner only)
router.post("/bind-existing", requireProjectOwner("projectId"), repoController.bindExisting.bind(repoController));

// POST   /api/projects/:projectId/repositories/bootstrap-plan (Owner only)
router.post("/bootstrap-plan", requireProjectOwner("projectId"), repoController.prepareBootstrapPlan.bind(repoController));

// POST   /api/projects/:projectId/repositories/bootstrap-init (Owner only)
router.post("/bootstrap-init", requireProjectOwner("projectId"), repoController.executeBootstrap.bind(repoController));

// POST   /api/projects/:projectId/repositories (Owner only)
router.post("/", requireProjectOwner("projectId"), repoController.create.bind(repoController));

// PUT    /api/projects/:projectId/repositories/:repoId (Owner only)
router.put("/:repoId", requireProjectOwner("projectId"), repoController.update.bind(repoController));

// POST   /api/projects/:projectId/repositories/:repoId/sync — pull fresh AI context for this repo
router.post("/:repoId/sync", repoController.sync.bind(repoController));

// DELETE /api/projects/:projectId/repositories/:repoId (Owner only)
router.delete("/:repoId", requireProjectOwner("projectId"), repoController.remove.bind(repoController));

export default router;
