import { Router } from 'express';
import { ProjectController } from '../controllers/project-controller';
import { AiController } from '../controllers/ai-controller';
import sprintRoutes from './sprint-routes';
import phaseRoutes from './phase-routes';
import kanbanRoutes from './kanban-routes';
import projectRepositoryRoutes from './project-repository-routes';
import terminalRoutes from './terminal-routes';
import { requireRole } from '../middleware/rbac';
import { requireProjectAccess } from '../middleware/project-access';
import { bodyResource, requireProjectResources, routeResource } from '../middleware/project-resource-binding';

const router = Router();
const projectController = new ProjectController();
const aiController = new AiController();
const bind = (...resources: Parameters<typeof requireProjectResources>[1][]) =>
  requireProjectResources('id', ...resources);

// Get all documents across all projects
router.get('/documents/all', projectController.getAllDocuments.bind(projectController));

// Get all projects
router.get('/', projectController.getProjects.bind(projectController));

// Get project by ID
router.get('/:id', requireProjectAccess('id'), projectController.getProjectById.bind(projectController));

// Create new project
router.post('/', projectController.createProject.bind(projectController));

// Update project
router.put('/:id', requireProjectAccess('id'), projectController.updateProject.bind(projectController));

// Delete project
router.delete('/:id', requireProjectAccess('id'), projectController.deleteProject.bind(projectController));

// Sync GitHub repo context for a project
router.post('/:id/sync-github', requireProjectAccess('id'), projectController.syncGithub.bind(projectController));

// Update GitHub token for a project
router.put('/:id/github-token', requireProjectAccess('id'), projectController.updateProjectGitHubToken.bind(projectController));

// Validate a GitHub token
router.post('/validate-github-token', projectController.validateGitHubToken.bind(projectController));

// IDE: read/write individual repo files
router.get('/:id/repo/file', requireProjectAccess('id'), projectController.getRepoFile.bind(projectController));
router.put('/:id/repo/file', requireProjectAccess('id'), projectController.saveRepoFile.bind(projectController));

// Apply agent changes to local filesystem
router.post('/:id/apply-local', requireProjectAccess('id'), projectController.applyLocalChanges.bind(projectController));

// Project tasks
router.get('/:id/tasks', requireProjectAccess('id'), projectController.getProjectTasks.bind(projectController));
router.get('/:id/tasks/stats', requireProjectAccess('id'), projectController.getTaskStats.bind(projectController));
router.post('/:id/tasks', requireProjectAccess('id'), projectController.createTask.bind(projectController));
router.put('/:id/tasks/:taskId', requireProjectAccess('id'), bind(routeResource('taskId', 'task')), projectController.updateTask.bind(projectController));
router.delete('/:id/tasks/:taskId', requireProjectAccess('id'), bind(routeResource('taskId', 'task')), projectController.deleteTask.bind(projectController));

// Project files
router.get('/:id/files', requireProjectAccess('id'), projectController.getProjectFiles.bind(projectController));
router.post('/:id/files', requireProjectAccess('id'), projectController.createFile.bind(projectController));
router.post('/:id/files/presign', requireProjectAccess('id'), projectController.presignUpload.bind(projectController));
router.post('/:id/files/confirm', requireProjectAccess('id'), projectController.confirmUpload.bind(projectController));
router.delete('/:id/files/:fileId', requireProjectAccess('id'), bind(routeResource('fileId', 'file')), projectController.deleteFile.bind(projectController));
router.get('/:id/files/:fileId/download', requireProjectAccess('id'), bind(routeResource('fileId', 'file')), projectController.getFileDownloadUrl.bind(projectController));

// Project members
router.get('/:id/members', requireProjectAccess('id'), projectController.getProjectMembers.bind(projectController));
router.post('/:id/members', requireProjectAccess('id'), projectController.addProjectMember.bind(projectController));
router.delete('/:id/members/:userId', requireProjectAccess('id'), projectController.removeProjectMember.bind(projectController));

// Project chat
router.get('/:id/chat', requireProjectAccess('id'), projectController.getChatMessages.bind(projectController));
router.post('/:id/chat', requireProjectAccess('id'), projectController.sendChatMessage.bind(projectController));

// Project activities
router.get('/:id/activities', requireProjectAccess('id'), projectController.getActivities.bind(projectController));

// Project documents (AI-generated)
router.get('/:id/documents', requireProjectAccess('id'), projectController.getProjectDocuments.bind(projectController));
router.post('/:id/documents', requireProjectAccess('id'), projectController.createProjectDocument.bind(projectController));
router.delete('/:id/documents/:docId', requireProjectAccess('id'), bind(routeResource('docId', 'document')), projectController.deleteProjectDocument.bind(projectController));

// Task comments
router.get('/:id/tasks/:taskId/comments', requireProjectAccess('id'), bind(routeResource('taskId', 'task')), projectController.getComments.bind(projectController));
router.post('/:id/tasks/:taskId/comments', requireProjectAccess('id'), bind(routeResource('taskId', 'task')), projectController.createComment.bind(projectController));
router.delete('/:id/tasks/:taskId/comments/:commentId', requireProjectAccess('id'), bind(routeResource('taskId', 'task'), routeResource('commentId', 'comment')), projectController.deleteComment.bind(projectController));

// Task dependencies
router.post('/:id/tasks/:taskId/dependencies', requireProjectAccess('id'), bind(routeResource('taskId', 'task'), bodyResource('blockingTaskId', 'task')), projectController.addDependency.bind(projectController));
router.delete('/:id/tasks/:taskId/dependencies/:blockingTaskId', requireProjectAccess('id'), bind(routeResource('taskId', 'task'), routeResource('blockingTaskId', 'task')), projectController.removeDependency.bind(projectController));

// Task checklist
router.get('/:id/tasks/:taskId/checklist', requireProjectAccess('id'), bind(routeResource('taskId', 'task')), projectController.getChecklist.bind(projectController));
router.post('/:id/tasks/:taskId/checklist', requireProjectAccess('id'), bind(routeResource('taskId', 'task')), projectController.addChecklistItem.bind(projectController));
router.patch('/:id/tasks/:taskId/checklist/:itemId', requireProjectAccess('id'), bind(routeResource('taskId', 'task'), routeResource('itemId', 'checklist')), projectController.updateChecklistItem.bind(projectController));
router.delete('/:id/tasks/:taskId/checklist/:itemId', requireProjectAccess('id'), bind(routeResource('taskId', 'task'), routeResource('itemId', 'checklist')), projectController.deleteChecklistItem.bind(projectController));

// Git data (live from GitHub API)
router.get('/:id/git/commits', requireProjectAccess('id'), projectController.getGitCommits.bind(projectController));
router.get('/:id/git/branches', requireProjectAccess('id'), projectController.getGitBranches.bind(projectController));
router.get('/:id/git/pulls', requireProjectAccess('id'), projectController.getGitPulls.bind(projectController));

// S3 Configuration Check
router.get('/config/s3', requireRole('admin'), projectController.checkS3Config.bind(projectController));

// Project rules
router.post('/:id/rules', requireProjectAccess('id'), projectController.createProjectRule.bind(projectController));
router.put('/:id/rules/:ruleId', requireProjectAccess('id'), bind(routeResource('ruleId', 'rule')), projectController.updateProjectRule.bind(projectController));
router.delete('/:id/rules/:ruleId', requireProjectAccess('id'), bind(routeResource('ruleId', 'rule')), projectController.deleteProjectRule.bind(projectController));

// Project decisions
router.post('/:id/decisions', requireProjectAccess('id'), bind(bodyResource('artifactId', 'artifact', true)), projectController.createProjectDecision.bind(projectController));
router.put('/:id/decisions/:decisionId', requireProjectAccess('id'), bind(routeResource('decisionId', 'decision'), bodyResource('artifactId', 'artifact', true)), projectController.updateProjectDecision.bind(projectController));
router.delete('/:id/decisions/:decisionId', requireProjectAccess('id'), bind(routeResource('decisionId', 'decision')), projectController.deleteProjectDecision.bind(projectController));

// Memory summary
router.put('/:id/memory-summary', requireProjectAccess('id'), projectController.saveMemorySummary.bind(projectController));

// Sprints
router.use('/:projectId/sprints', requireProjectAccess('projectId'), sprintRoutes);

// Phased workflow (requirements → documentation → architecture → implementation → testing → review)
router.use('/:projectId/phases', requireProjectAccess('projectId'), phaseRoutes);

// Kanban & Clarifications (Workflow-driven decomposition & interactive option loop)
router.use('/:projectId/kanban', requireProjectAccess('projectId'), kanbanRoutes);

// Multi-repository support (Anka OS v2.0 spec §11)
router.use('/:projectId/repositories', requireProjectAccess('projectId'), projectRepositoryRoutes);
router.post('/:projectId/agent/multi-repo/run', requireProjectAccess('projectId'), aiController.runMultiRepoAgent.bind(aiController));

// Bounded developer terminal session support
router.use('/:projectId/terminal', requireProjectAccess('projectId'), terminalRoutes);

export default router;
