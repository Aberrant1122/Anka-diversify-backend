"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const project_controller_1 = require("../controllers/project-controller");
const router = (0, express_1.Router)();
const projectController = new project_controller_1.ProjectController();
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
// Project files
router.get('/:id/files', projectController.getProjectFiles.bind(projectController));
router.post('/:id/files', projectController.createFile.bind(projectController));
router.post('/:id/files/presign', projectController.presignUpload.bind(projectController));
router.post('/:id/files/confirm', projectController.confirmUpload.bind(projectController));
router.delete('/:id/files/:fileId', projectController.deleteFile.bind(projectController));
// Project chat
router.get('/:id/chat', projectController.getChatMessages.bind(projectController));
router.post('/:id/chat', projectController.sendChatMessage.bind(projectController));
// Project activities
router.get('/:id/activities', projectController.getActivities.bind(projectController));
// Task comments
router.get('/:id/tasks/:taskId/comments', projectController.getComments.bind(projectController));
router.post('/:id/tasks/:taskId/comments', projectController.createComment.bind(projectController));
router.delete('/:id/tasks/:taskId/comments/:commentId', projectController.deleteComment.bind(projectController));
exports.default = router;
//# sourceMappingURL=project-routes.js.map