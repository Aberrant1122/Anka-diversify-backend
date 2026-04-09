"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const multer_1 = __importDefault(require("multer"));
const project_controller_1 = require("../controllers/project-controller");
const upload = (0, multer_1.default)({ storage: multer_1.default.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } }); // 20MB
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
router.post('/:id/files/upload', upload.single('file'), projectController.uploadFile.bind(projectController));
router.delete('/:id/files/:fileId', projectController.deleteFile.bind(projectController));
exports.default = router;
//# sourceMappingURL=project-routes.js.map