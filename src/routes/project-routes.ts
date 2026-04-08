import { Router } from 'express';
import { ProjectController } from '../controllers/project-controller';

const router = Router();
const projectController = new ProjectController();

// Get all projects
router.get('/', projectController.getProjects.bind(projectController));

// Get project by ID
router.get('/:id', projectController.getProjectById.bind(projectController));

// Create new project
router.post('/', projectController.createProject.bind(projectController));

// Update project
router.put('/:id', projectController.updateProject.bind(projectController));

// Delete project
router.delete('/:id', projectController.deleteProject.bind(projectController));

// Sync GitHub repo context for a project
router.post('/:id/sync-github', projectController.syncGithub.bind(projectController));

// Get project tasks
router.get('/:id/tasks', projectController.getProjectTasks.bind(projectController));

// Create project task
router.post('/:id/tasks', projectController.createTask.bind(projectController));

export default router;
