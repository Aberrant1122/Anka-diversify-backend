"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProjectController = void 0;
const project_service_1 = require("../services/project-service");
const github_service_1 = require("../services/github.service");
const upload_service_1 = require("../services/upload.service");
const projectService = new project_service_1.ProjectService();
const DEMO_USER_ID = "demo-user-id";
function getUserId(req) {
    return req.headers["x-user-id"] || DEMO_USER_ID;
}
function getUserName(req) {
    return req.headers["x-user-name"] || "Unknown";
}
function param(req, key) {
    return req.params[key];
}
class ProjectController {
    async getProjects(req, res) {
        try {
            const projects = await projectService.getAllProjects(getUserId(req));
            res.json({ success: true, data: projects, count: projects.length });
        }
        catch (error) {
            console.error("Error fetching projects:", error);
            res.status(500).json({ success: false, error: "Failed to fetch projects" });
        }
    }
    async getProjectById(req, res) {
        try {
            const project = await projectService.getProjectById(param(req, "id"), getUserId(req));
            if (!project) {
                return res.status(404).json({ success: false, error: "Project not found" });
            }
            res.json({ success: true, data: project });
        }
        catch (error) {
            console.error("Error fetching project:", error);
            res.status(500).json({ success: false, error: "Failed to fetch project" });
        }
    }
    async createProject(req, res) {
        try {
            const userId = getUserId(req);
            const { name, description, phase, priority, githubUrl, dueDate } = req.body;
            const project = await projectService.createProject({
                name,
                description,
                phase,
                priority,
                githubUrl,
                dueDate: dueDate || new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
            }, userId);
            // Kick off GitHub context sync in background (don't block the response)
            if (githubUrl) {
                github_service_1.ProjectGitHubService.buildProjectContext(project.id, githubUrl).catch((err) => console.error("GitHub sync failed for project", project.id, err));
            }
            res.status(201).json({ success: true, data: project, message: "Project created successfully" });
        }
        catch (error) {
            console.error("Error creating project:", error);
            res.status(500).json({ success: false, error: "Failed to create project" });
        }
    }
    async updateProject(req, res) {
        try {
            const userId = getUserId(req);
            const project = await projectService.updateProject(param(req, "id"), req.body, userId);
            if (!project) {
                return res.status(404).json({ success: false, error: "Project not found" });
            }
            if (req.body.githubUrl) {
                github_service_1.ProjectGitHubService.buildProjectContext(project.id, req.body.githubUrl).catch((err) => console.error("GitHub sync failed for project", project.id, err));
            }
            res.json({ success: true, data: project, message: "Project updated successfully" });
        }
        catch (error) {
            console.error("Error updating project:", error);
            res.status(500).json({ success: false, error: "Failed to update project" });
        }
    }
    async deleteProject(req, res) {
        try {
            const deleted = await projectService.deleteProject(param(req, "id"), getUserId(req));
            if (!deleted) {
                return res.status(404).json({ success: false, error: "Project not found" });
            }
            res.json({ success: true, message: "Project deleted successfully" });
        }
        catch (error) {
            console.error("Error deleting project:", error);
            res.status(500).json({ success: false, error: "Failed to delete project" });
        }
    }
    async syncGithub(req, res) {
        try {
            const userId = getUserId(req);
            const project = await projectService.getProjectById(param(req, "id"), userId);
            if (!project) {
                return res.status(404).json({ success: false, error: "Project not found" });
            }
            const githubUrl = req.body.githubUrl || project.githubUrl;
            if (!githubUrl) {
                return res.status(400).json({ success: false, error: "No GitHub URL provided" });
            }
            await github_service_1.ProjectGitHubService.buildProjectContext(project.id, githubUrl);
            res.json({ success: true, message: "GitHub context synced successfully" });
        }
        catch (error) {
            console.error("Error syncing GitHub context:", error);
            res.status(500).json({ success: false, error: "Failed to sync GitHub context" });
        }
    }
    async getProjectTasks(req, res) {
        try {
            const tasks = await projectService.getProjectTasks(param(req, "id"), getUserId(req));
            res.json({ success: true, data: tasks, count: tasks.length });
        }
        catch (error) {
            console.error("Error fetching project tasks:", error);
            res.status(500).json({ success: false, error: "Failed to fetch project tasks" });
        }
    }
    async createTask(req, res) {
        try {
            const actor = { userId: getUserId(req), userName: getUserName(req) };
            const task = await projectService.createTask({
                project_id: param(req, "id"),
                title: req.body.title,
                description: req.body.description,
                status: req.body.status,
                priority: req.body.priority,
                phase: req.body.phase,
                due_date: req.body.dueDate,
            }, actor);
            res.status(201).json({ success: true, data: task, message: "Task created successfully" });
        }
        catch (error) {
            console.error("Error creating task:", error);
            res.status(500).json({ success: false, error: "Failed to create task" });
        }
    }
    async updateTask(req, res) {
        try {
            const actor = { userId: getUserId(req), userName: getUserName(req), projectId: param(req, "id") };
            const task = await projectService.updateTask(param(req, "taskId"), req.body, actor);
            if (!task) {
                return res.status(404).json({ success: false, error: "Task not found" });
            }
            res.json({ success: true, data: task });
        }
        catch (error) {
            console.error("Error updating task:", error);
            res.status(500).json({ success: false, error: "Failed to update task" });
        }
    }
    async deleteTask(req, res) {
        try {
            const actor = { userId: getUserId(req), userName: getUserName(req), projectId: param(req, "id") };
            const deleted = await projectService.deleteTask(param(req, "taskId"), actor);
            if (!deleted) {
                return res.status(404).json({ success: false, error: "Task not found" });
            }
            res.json({ success: true, message: "Task deleted successfully" });
        }
        catch (error) {
            console.error("Error deleting task:", error);
            res.status(500).json({ success: false, error: "Failed to delete task" });
        }
    }
    async getActivities(req, res) {
        try {
            const activities = await projectService.getActivities(param(req, "id"));
            res.json({ success: true, data: activities, count: activities.length });
        }
        catch (error) {
            console.error("Error fetching activities:", error);
            res.status(500).json({ success: false, error: "Failed to fetch activities" });
        }
    }
    async getComments(req, res) {
        try {
            const comments = await projectService.getComments(param(req, "taskId"));
            res.json({ success: true, data: comments, count: comments.length });
        }
        catch (error) {
            console.error("Error fetching comments:", error);
            res.status(500).json({ success: false, error: "Failed to fetch comments" });
        }
    }
    async createComment(req, res) {
        try {
            const { content } = req.body;
            if (!content?.trim()) {
                return res.status(400).json({ success: false, error: "content is required" });
            }
            const comment = await projectService.createComment({
                taskId: param(req, "taskId"),
                projectId: param(req, "id"),
                userId: getUserId(req),
                userName: getUserName(req),
                content: content.trim(),
            });
            res.status(201).json({ success: true, data: comment });
        }
        catch (error) {
            console.error("Error creating comment:", error);
            res.status(500).json({ success: false, error: "Failed to create comment" });
        }
    }
    async deleteComment(req, res) {
        try {
            const deleted = await projectService.deleteComment(param(req, "commentId"));
            if (!deleted) {
                return res.status(404).json({ success: false, error: "Comment not found" });
            }
            res.json({ success: true, message: "Comment deleted" });
        }
        catch (error) {
            console.error("Error deleting comment:", error);
            res.status(500).json({ success: false, error: "Failed to delete comment" });
        }
    }
    async getProjectFiles(req, res) {
        try {
            const files = await projectService.getProjectFiles(param(req, "id"));
            res.json({ success: true, data: files, count: files.length });
        }
        catch (error) {
            console.error("Error fetching project files:", error);
            res.status(500).json({ success: false, error: "Failed to fetch files" });
        }
    }
    async createFile(req, res) {
        try {
            const file = await projectService.createFile({
                projectId: param(req, "id"),
                name: req.body.name,
                type: req.body.type,
                phase: req.body.phase,
                url: req.body.url,
                size: req.body.size,
                uploadedBy: req.body.uploadedBy,
            });
            res.status(201).json({ success: true, data: file });
        }
        catch (error) {
            console.error("Error creating file:", error);
            res.status(500).json({ success: false, error: "Failed to create file" });
        }
    }
    // Step 1: get presigned URL to upload directly to S3 from browser
    async presignUpload(req, res) {
        try {
            const { filename, mimetype, phase, size } = req.body;
            if (!filename || !mimetype) {
                return res.status(400).json({ success: false, error: "filename and mimetype required" });
            }
            const projectId = param(req, "id");
            const { uploadUrl, fileUrl, key } = await (0, upload_service_1.generatePresignedUrl)(projectId, filename, mimetype);
            res.json({ success: true, data: { uploadUrl, fileUrl, key, type: (0, upload_service_1.detectType)(mimetype) } });
        }
        catch (error) {
            console.error("Error generating presigned URL:", error);
            res.status(500).json({ success: false, error: "Failed to generate upload URL" });
        }
    }
    // Step 2: after browser uploads to S3, save file record in DB
    async confirmUpload(req, res) {
        try {
            const { name, type, phase, url, s3Key, size } = req.body;
            if (!name || !url) {
                return res.status(400).json({ success: false, error: "name and url required" });
            }
            const file = await projectService.createFile({
                projectId: param(req, "id"),
                name,
                type,
                phase,
                url,
                s3Key,
                size,
                uploadedBy: getUserId(req),
            });
            res.status(201).json({ success: true, data: file });
        }
        catch (error) {
            console.error("Error confirming upload:", error);
            res.status(500).json({ success: false, error: "Failed to save file" });
        }
    }
    async deleteFile(req, res) {
        try {
            const s3Key = await projectService.deleteFile(param(req, "fileId"));
            if (s3Key === undefined) {
                return res.status(404).json({ success: false, error: "File not found" });
            }
            if (s3Key) {
                (0, upload_service_1.deleteFromS3)(s3Key).catch((err) => console.error("S3 delete failed:", err));
            }
            res.json({ success: true, message: "File deleted successfully" });
        }
        catch (error) {
            console.error("Error deleting file:", error);
            res.status(500).json({ success: false, error: "Failed to delete file" });
        }
    }
}
exports.ProjectController = ProjectController;
//# sourceMappingURL=project-controller.js.map