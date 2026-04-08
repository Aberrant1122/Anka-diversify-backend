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

// Project tasks
router.get('/:id/tasks', projectController.getProjectTasks.bind(projectController));
router.post('/:id/tasks', projectController.createTask.bind(projectController));
router.put('/:id/tasks/:taskId', projectController.updateTask.bind(projectController));
router.delete('/:id/tasks/:taskId', projectController.deleteTask.bind(projectController));

export default router;
