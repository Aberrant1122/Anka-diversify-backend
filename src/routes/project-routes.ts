import { Router } from 'express';
import { ProjectController } from '../controllers/project-controller';
import sprintRoutes from './sprint-routes';

const router = Router();
const projectController = new ProjectController();

// Get all documents across all projects
router.get('/documents/all', projectController.getAllDocuments.bind(projectController));

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

// IDE: read/write individual repo files
router.get('/:id/repo/file', projectController.getRepoFile.bind(projectController));
router.put('/:id/repo/file', projectController.saveRepoFile.bind(projectController));

// Apply agent changes to local filesystem
router.post('/:id/apply-local', projectController.applyLocalChanges.bind(projectController));

// Project tasks
router.get('/:id/tasks', projectController.getProjectTasks.bind(projectController));
router.post('/:id/tasks', projectController.createTask.bind(projectController));
router.put('/:id/tasks/:taskId', projectController.updateTask.bind(projectController));
router.delete('/:id/tasks/:taskId', projectController.deleteTask.bind(projectController));

// Project files
router.get('/:id/files', projectController.getProjectFiles.bind(projectController));
router.post('/:id/files', projectController.createFile.bind(projectController));
router.post('/:id/files/presign', projectController.presignUpload.bind(projectController));
router.post('/:id/files/confirm', projectController.confirmUpload.bind(projectController));
router.delete('/:id/files/:fileId', projectController.deleteFile.bind(projectController));
router.get('/:id/files/:fileId/download', projectController.getFileDownloadUrl.bind(projectController));

// Project members
router.get('/:id/members', projectController.getProjectMembers.bind(projectController));
router.post('/:id/members', projectController.addProjectMember.bind(projectController));
router.delete('/:id/members/:userId', projectController.removeProjectMember.bind(projectController));

// Project chat
router.get('/:id/chat', projectController.getChatMessages.bind(projectController));
router.post('/:id/chat', projectController.sendChatMessage.bind(projectController));

// Project activities
router.get('/:id/activities', projectController.getActivities.bind(projectController));

// Project documents (AI-generated)
router.get('/:id/documents', projectController.getProjectDocuments.bind(projectController));
router.post('/:id/documents', projectController.createProjectDocument.bind(projectController));
router.delete('/:id/documents/:docId', projectController.deleteProjectDocument.bind(projectController));

// Task comments
router.get('/:id/tasks/:taskId/comments', projectController.getComments.bind(projectController));
router.post('/:id/tasks/:taskId/comments', projectController.createComment.bind(projectController));
router.delete('/:id/tasks/:taskId/comments/:commentId', projectController.deleteComment.bind(projectController));

// Task dependencies
router.post('/:id/tasks/:taskId/dependencies', projectController.addDependency.bind(projectController));
router.delete('/:id/tasks/:taskId/dependencies/:blockingTaskId', projectController.removeDependency.bind(projectController));

// Task checklist
router.get('/:id/tasks/:taskId/checklist', projectController.getChecklist.bind(projectController));
router.post('/:id/tasks/:taskId/checklist', projectController.addChecklistItem.bind(projectController));
router.patch('/:id/tasks/:taskId/checklist/:itemId', projectController.updateChecklistItem.bind(projectController));
router.delete('/:id/tasks/:taskId/checklist/:itemId', projectController.deleteChecklistItem.bind(projectController));

// S3 Configuration Check
router.get('/config/s3', projectController.checkS3Config.bind(projectController));

// Sprints
router.use('/:projectId/sprints', sprintRoutes);

export default router;
