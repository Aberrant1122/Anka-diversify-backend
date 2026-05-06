import { Request, Response } from "express";
import { SprintService } from "../services/sprint-service";

const sprintService = new SprintService();

function getUserId(req: Request): string | null {
  const val = req.headers["x-user-id"];
  if (!val) return null;
  return Array.isArray(val) ? val[0] : val;
}

function param(req: Request, key: string): string {
  const val = req.params[key];
  return Array.isArray(val) ? val[0] : (val as string);
}

export class SprintController {
  async getSprints(req: Request, res: Response) {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Unauthorized", message: "X-User-ID header required" });

      const sprints = await sprintService.getSprints(param(req, "projectId"));
      res.json({ success: true, data: sprints, count: sprints.length });
    } catch (error: any) {
      console.error("Error fetching sprints:", error);
      res.status(500).json({ error: "Internal server error", message: error?.message || "Failed to fetch sprints" });
    }
  }

  async createSprint(req: Request, res: Response) {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Unauthorized", message: "X-User-ID header required" });

      const { name, goal, startDate, endDate, velocity } = req.body;
      if (!name || !startDate || !endDate) {
        return res.status(400).json({ error: "Bad request", message: "name, startDate, and endDate are required" });
      }

      const sprint = await sprintService.createSprint(param(req, "projectId"), {
        name,
        goal,
        startDate,
        endDate,
        velocity,
      });
      res.status(201).json({ success: true, data: sprint });
    } catch (error: any) {
      console.error("Error creating sprint:", error);
      res.status(500).json({ error: "Internal server error", message: error?.message || "Failed to create sprint" });
    }
  }

  async updateSprint(req: Request, res: Response) {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Unauthorized", message: "X-User-ID header required" });

      const sprint = await sprintService.updateSprint(param(req, "sprintId"), req.body);
      res.json({ success: true, data: sprint });
    } catch (error: any) {
      console.error("Error updating sprint:", error);
      res.status(500).json({ error: "Internal server error", message: error?.message || "Failed to update sprint" });
    }
  }

  async deleteSprint(req: Request, res: Response) {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Unauthorized", message: "X-User-ID header required" });

      await sprintService.deleteSprint(param(req, "sprintId"));
      res.json({ success: true, message: "Sprint deleted" });
    } catch (error: any) {
      console.error("Error deleting sprint:", error);
      res.status(500).json({ error: "Internal server error", message: error?.message || "Failed to delete sprint" });
    }
  }

  async addTaskToSprint(req: Request, res: Response) {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Unauthorized", message: "X-User-ID header required" });

      const { taskId } = req.body;
      if (!taskId) return res.status(400).json({ error: "Bad request", message: "taskId is required" });

      await sprintService.addTaskToSprint(param(req, "sprintId"), taskId);
      res.json({ success: true, message: "Task added to sprint" });
    } catch (error: any) {
      console.error("Error adding task to sprint:", error);
      res.status(500).json({ error: "Internal server error", message: error?.message || "Failed to add task to sprint" });
    }
  }

  async removeTaskFromSprint(req: Request, res: Response) {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Unauthorized", message: "X-User-ID header required" });

      await sprintService.removeTaskFromSprint(param(req, "sprintId"), param(req, "taskId"));
      res.json({ success: true, message: "Task removed from sprint" });
    } catch (error: any) {
      console.error("Error removing task from sprint:", error);
      res.status(500).json({ error: "Internal server error", message: error?.message || "Failed to remove task from sprint" });
    }
  }
}
