import { Request, Response } from "express";
import { ProjectService } from "../services/project-service";
import { ProjectGitHubService } from "../services/github.service";

export class ProjectController {
  private projectService: ProjectService;

  constructor() {
    this.projectService = new ProjectService();
  }

  // Get all projects
  async getProjects(req: Request, res: Response) {
    try {
      const projects = await this.projectService.getAllProjects();
      res.json({
        success: true,
        data: projects,
        count: projects.length,
      });
    } catch (error) {
      console.error("Error fetching projects:", error);
      res.status(500).json({
        success: false,
        error: "Failed to fetch projects",
      });
    }
  }

  // Get project by ID
  async getProjectById(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const project = await this.projectService.getProjectById(id);

      if (!project) {
        return res.status(404).json({
          success: false,
          error: "Project not found",
        });
      }

      res.json({
        success: true,
        data: project,
      });
    } catch (error) {
      console.error("Error fetching project:", error);
      res.status(500).json({
        success: false,
        error: "Failed to fetch project",
      });
    }
  }

  // Create new project
  async createProject(req: Request, res: Response) {
    try {
      const projectData = req.body;

      // Create project in database
      const project = await this.projectService.createProject({
        name: projectData.name,
        description: projectData.description,
        phase: projectData.phase || "product-modeling",
        priority: projectData.priority || "medium",
        github_url: projectData.githubUrl,
        start_date: new Date().toISOString(),
        due_date: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
        status: "active",
      });

      // Build GitHub context if GitHub URL is provided
      if (projectData.githubUrl) {
        try {
          await ProjectGitHubService.buildProjectContext(
            project.id,
            projectData.githubUrl,
          );
          console.log("GitHub context built for project:", project.name);
        } catch (error) {
          console.error("Failed to build GitHub context:", error);
          // Don't fail project creation, just log the error
        }
      }

      res.status(201).json({
        success: true,
        data: project,
        message: "Project created successfully",
      });
    } catch (error) {
      console.error("Error creating project:", error);
      res.status(500).json({
        success: false,
        error: "Failed to create project",
      });
    }
  }

  // Update project
  async updateProject(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const updateData = req.body;

      const project = await this.projectService.updateProject(id, updateData);

      if (!project) {
        return res.status(404).json({
          success: false,
          error: "Project not found",
        });
      }

      // Update GitHub context if GitHub URL changed
      if (updateData.githubUrl && updateData.githubUrl !== project.github_url) {
        try {
          await ProjectGitHubService.buildProjectContext(
            id,
            updateData.githubUrl,
          );
          console.log("GitHub context updated for project:", project.name);
        } catch (error) {
          console.error("Failed to update GitHub context:", error);
        }
      }

      res.json({
        success: true,
        data: project,
        message: "Project updated successfully",
      });
    } catch (error) {
      console.error("Error updating project:", error);
      res.status(500).json({
        success: false,
        error: "Failed to update project",
      });
    }
  }

  // Delete project
  async deleteProject(req: Request, res: Response) {
    try {
      const { id } = req.params;

      const deleted = await this.projectService.deleteProject(id);

      if (!deleted) {
        return res.status(404).json({
          success: false,
          error: "Project not found",
        });
      }

      res.json({
        success: true,
        message: "Project deleted successfully",
      });
    } catch (error) {
      console.error("Error deleting project:", error);
      res.status(500).json({
        success: false,
        error: "Failed to delete project",
      });
    }
  }

  // Get project tasks
  async getProjectTasks(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const tasks = await this.projectService.getProjectTasks(id);

      res.json({
        success: true,
        data: tasks,
        count: tasks.length,
      });
    } catch (error) {
      console.error("Error fetching project tasks:", error);
      res.status(500).json({
        success: false,
        error: "Failed to fetch project tasks",
      });
    }
  }

  // Sync GitHub repo context
  async syncGithub(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const project = await this.projectService.getProjectById(id);

      if (!project) {
        return res.status(404).json({ success: false, error: "Project not found" });
      }

      const githubUrl = req.body.githubUrl || project.github_url;
      if (!githubUrl) {
        return res.status(400).json({ success: false, error: "No GitHub URL provided" });
      }

      await ProjectGitHubService.buildProjectContext(id, githubUrl);

      res.json({ success: true, message: "GitHub context synced successfully" });
    } catch (error) {
      console.error("Error syncing GitHub context:", error);
      res.status(500).json({ success: false, error: "Failed to sync GitHub context" });
    }
  }

  // Create project task
  async createTask(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const taskData = req.body;

      const task = await this.projectService.createTask({
        project_id: id,
        title: taskData.title,
        description: taskData.description,
        status: taskData.status || "todo",
        priority: taskData.priority || "medium",
        assignee_id: taskData.assigneeId,
        due_date: taskData.dueDate,
      });

      res.status(201).json({
        success: true,
        data: task,
        message: "Task created successfully",
      });
    } catch (error) {
      console.error("Error creating task:", error);
      res.status(500).json({
        success: false,
        error: "Failed to create task",
      });
    }
  }
}
