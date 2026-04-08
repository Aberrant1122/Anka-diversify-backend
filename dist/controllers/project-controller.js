"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProjectController = void 0;
const project_service_1 = require("../services/project-service");
const github_service_1 = require("../services/github.service");
const projectService = new project_service_1.ProjectService();
const DEMO_USER_ID = "demo-user-id";
function getUserId(req) {
    return req.headers["x-user-id"] || DEMO_USER_ID;
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
            const task = await projectService.createTask({
                project_id: param(req, "id"),
                title: req.body.title,
                description: req.body.description,
                status: req.body.status,
                priority: req.body.priority,
                phase: req.body.phase,
                due_date: req.body.dueDate,
            });
            res.status(201).json({ success: true, data: task, message: "Task created successfully" });
        }
        catch (error) {
            console.error("Error creating task:", error);
            res.status(500).json({ success: false, error: "Failed to create task" });
        }
    }
    async updateTask(req, res) {
        try {
            const task = await projectService.updateTask(param(req, "taskId"), req.body);
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
            const deleted = await projectService.deleteTask(param(req, "taskId"));
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
}
exports.ProjectController = ProjectController;
//# sourceMappingURL=project-controller.js.map