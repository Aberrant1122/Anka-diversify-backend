import { Request, Response } from "express";
import { ProjectService } from "../services/project-service";
import { ProjectGitHubService } from "../services/github.service";

const projectService = new ProjectService();
const DEMO_USER_ID = "demo-user-id";

function getUserId(req: Request): string {
  return (req.headers["x-user-id"] as string) || DEMO_USER_ID;
}

function param(req: Request, key: string): string {
  return req.params[key] as string;
}

export class ProjectController {
  async getProjects(req: Request, res: Response) {
    try {
      const projects = await projectService.getAllProjects(getUserId(req));
      res.json({ success: true, data: projects, count: projects.length });
    } catch (error) {
      console.error("Error fetching projects:", error);
      res.status(500).json({ success: false, error: "Failed to fetch projects" });
    }
  }

  async getProjectById(req: Request, res: Response) {
    try {
      const project = await projectService.getProjectById(param(req, "id"), getUserId(req));
      if (!project) {
        return res.status(404).json({ success: false, error: "Project not found" });
      }
      res.json({ success: true, data: project });
    } catch (error) {
      console.error("Error fetching project:", error);
      res.status(500).json({ success: false, error: "Failed to fetch project" });
    }
  }

  async createProject(req: Request, res: Response) {
    try {
      const userId = getUserId(req);
      const { name, description, phase, priority, githubUrl, dueDate } = req.body;

      const project = await projectService.createProject(
        {
          name,
          description,
          phase,
          priority,
          githubUrl,
          dueDate: dueDate || new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
        },
        userId,
      );

      // Kick off GitHub context sync in background (don't block the response)
      if (githubUrl) {
        ProjectGitHubService.buildProjectContext(project.id, githubUrl).catch((err) =>
          console.error("GitHub sync failed for project", project.id, err),
        );
      }

      res.status(201).json({ success: true, data: project, message: "Project created successfully" });
    } catch (error) {
      console.error("Error creating project:", error);
      res.status(500).json({ success: false, error: "Failed to create project" });
    }
  }

  async updateProject(req: Request, res: Response) {
    try {
      const userId = getUserId(req);
      const project = await projectService.updateProject(param(req, "id"), req.body, userId);

      if (!project) {
        return res.status(404).json({ success: false, error: "Project not found" });
      }

      if (req.body.githubUrl) {
        ProjectGitHubService.buildProjectContext(project.id, req.body.githubUrl).catch((err) =>
          console.error("GitHub sync failed for project", project.id, err),
        );
      }

      res.json({ success: true, data: project, message: "Project updated successfully" });
    } catch (error) {
      console.error("Error updating project:", error);
      res.status(500).json({ success: false, error: "Failed to update project" });
    }
  }

  async deleteProject(req: Request, res: Response) {
    try {
      const deleted = await projectService.deleteProject(param(req, "id"), getUserId(req));
      if (!deleted) {
        return res.status(404).json({ success: false, error: "Project not found" });
      }
      res.json({ success: true, message: "Project deleted successfully" });
    } catch (error) {
      console.error("Error deleting project:", error);
      res.status(500).json({ success: false, error: "Failed to delete project" });
    }
  }

  async syncGithub(req: Request, res: Response) {
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

      await ProjectGitHubService.buildProjectContext(project.id, githubUrl);
      res.json({ success: true, message: "GitHub context synced successfully" });
    } catch (error) {
      console.error("Error syncing GitHub context:", error);
      res.status(500).json({ success: false, error: "Failed to sync GitHub context" });
    }
  }

  async getProjectTasks(req: Request, res: Response) {
    try {
      const tasks = await projectService.getProjectTasks(param(req, "id"), getUserId(req));
      res.json({ success: true, data: tasks, count: tasks.length });
    } catch (error) {
      console.error("Error fetching project tasks:", error);
      res.status(500).json({ success: false, error: "Failed to fetch project tasks" });
    }
  }

  async createTask(req: Request, res: Response) {
    try {
      const task = await projectService.createTask({
        project_id: param(req, "id"),
        title: req.body.title,
        description: req.body.description,
        status: req.body.status,
        priority: req.body.priority,
        due_date: req.body.dueDate,
      });
      res.status(201).json({ success: true, data: task, message: "Task created successfully" });
    } catch (error) {
      console.error("Error creating task:", error);
      res.status(500).json({ success: false, error: "Failed to create task" });
    }
  }
}
