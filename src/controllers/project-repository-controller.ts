import { Request, Response } from "express";
import { ProjectRepositoryService } from "../services/project-repository-service";

const repoService = new ProjectRepositoryService();

function param(req: Request, key: string): string {
  const val = req.params[key];
  return Array.isArray(val) ? val[0] : (val as string);
}

export class ProjectRepositoryController {
  async list(req: Request, res: Response) {
    try {
      const repos = await repoService.list(param(req, "projectId"));
      res.json({ success: true, data: repos });
    } catch (error: any) {
      console.error("Error listing project repositories:", error);
      res.status(500).json({ error: "Internal server error", message: error?.message || "Failed to list repositories" });
    }
  }

  async create(req: Request, res: Response) {
    try {
      const repo = await repoService.create(param(req, "projectId"), req.body);
      res.status(201).json({ success: true, data: repo });
    } catch (error: any) {
      console.error("Error creating project repository:", error);
      res.status(400).json({ error: "Bad request", message: error?.message || "Failed to create repository" });
    }
  }

  async update(req: Request, res: Response) {
    try {
      const repo = await repoService.update(param(req, "projectId"), param(req, "repoId"), req.body);
      res.json({ success: true, data: repo });
    } catch (error: any) {
      console.error("Error updating project repository:", error);
      const status = error?.message === "Repository not found" ? 404 : 400;
      res.status(status).json({ error: "Bad request", message: error?.message || "Failed to update repository" });
    }
  }

  async sync(req: Request, res: Response) {
    try {
      const snapshot = await repoService.sync(param(req, "projectId"), param(req, "repoId"));
      res.json({ success: true, data: snapshot });
    } catch (error: any) {
      console.error("Error syncing project repository:", error);
      const status = error?.message === "Repository not found" ? 404 : 400;
      res.status(status).json({ error: "Bad request", message: error?.message || "Failed to sync repository" });
    }
  }

  async remove(req: Request, res: Response) {
    try {
      await repoService.remove(param(req, "projectId"), param(req, "repoId"));
      res.json({ success: true });
    } catch (error: any) {
      console.error("Error deleting project repository:", error);
      const status = error?.message === "Repository not found" ? 404 : 400;
      res.status(status).json({ error: "Bad request", message: error?.message || "Failed to delete repository" });
    }
  }
}
