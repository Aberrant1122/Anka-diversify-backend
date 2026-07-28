import { Request, Response } from "express";
import { PhaseService } from "../services/phase-service";

const phaseService = new PhaseService();

function getUserId(req: Request): string | null {
  const val = req.headers["x-user-id"];
  if (!val) return null;
  return Array.isArray(val) ? val[0] : val;
}

function param(req: Request, key: string): string {
  const val = req.params[key];
  return Array.isArray(val) ? val[0] : (val as string);
}

export class PhaseController {
  async getPhaseStates(req: Request, res: Response) {
    try {
      const states = await phaseService.ensurePhaseStates(param(req, "projectId"));
      res.json({ success: true, data: states });
    } catch (error: any) {
      console.error("Error fetching phase states:", error);
      res.status(500).json({ error: "Internal server error", message: error?.message || "Failed to fetch phase states" });
    }
  }

  async startPhase(req: Request, res: Response) {
    try {
      const state = await phaseService.startPhase(param(req, "projectId"), param(req, "phase"));
      res.json({ success: true, data: state });
    } catch (error: any) {
      console.error("Error starting phase:", error);
      res.status(500).json({ error: "Internal server error", message: error?.message || "Failed to start phase" });
    }
  }

  async requestApproval(req: Request, res: Response) {
    try {
      const state = await phaseService.requestApproval(param(req, "projectId"), param(req, "phase"));
      res.json({ success: true, data: state });
    } catch (error: any) {
      console.error("Error requesting approval:", error);
      res.status(500).json({ error: "Internal server error", message: error?.message || "Failed to request approval" });
    }
  }

  async approvePhase(req: Request, res: Response) {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Unauthorized", message: "X-User-ID header required" });

      const states = await phaseService.approvePhase(
        param(req, "projectId"),
        param(req, "phase"),
        userId,
        req.body?.comments,
      );
      res.json({ success: true, data: states });
    } catch (error: any) {
      console.error("Error approving phase:", error);
      res.status(500).json({ error: "Internal server error", message: error?.message || "Failed to approve phase" });
    }
  }

  async requestChanges(req: Request, res: Response) {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Unauthorized", message: "X-User-ID header required" });

      const state = await phaseService.requestChanges(
        param(req, "projectId"),
        param(req, "phase"),
        userId,
        req.body?.comments,
      );
      res.json({ success: true, data: state });
    } catch (error: any) {
      console.error("Error requesting changes:", error);
      res.status(500).json({ error: "Internal server error", message: error?.message || "Failed to request changes" });
    }
  }

  async getApprovalHistory(req: Request, res: Response) {
    try {
      const history = await phaseService.getApprovalHistory(param(req, "projectId"), req.query.phase as string | undefined);
      res.json({ success: true, data: history });
    } catch (error: any) {
      console.error("Error fetching approval history:", error);
      res.status(500).json({ error: "Internal server error", message: error?.message || "Failed to fetch approval history" });
    }
  }

  async listArtifacts(req: Request, res: Response) {
    try {
      const artifacts = await phaseService.listArtifacts(param(req, "projectId"), req.query.phase as string | undefined);
      res.json({ success: true, data: artifacts });
    } catch (error: any) {
      console.error("Error fetching artifacts:", error);
      res.status(500).json({ error: "Internal server error", message: error?.message || "Failed to fetch artifacts" });
    }
  }

  async runAutomatedPhase(req: Request, res: Response) {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Unauthorized", message: "X-User-ID header required" });

      const result = await phaseService.runAutomatedPhase(param(req, "projectId"), param(req, "phase"), userId, req.body?.brief);
      res.status(201).json({ success: true, data: result });
    } catch (error: any) {
      console.error("Error running automated phase:", error);
      res.status(500).json({ error: "Internal server error", message: error?.message || "Failed to run automated phase" });
    }
  }

  async getWorkflowRuns(req: Request, res: Response) {
    try {
      const runs = await phaseService.getWorkflowRuns(param(req, "projectId"));
      res.json({ success: true, data: runs });
    } catch (error: any) {
      console.error("Error fetching workflow runs:", error);
      res.status(500).json({ error: "Internal server error", message: error?.message || "Failed to fetch workflow runs" });
    }
  }

  async createArtifact(req: Request, res: Response) {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Unauthorized", message: "X-User-ID header required" });

      const { phase, type, title, content } = req.body;
      if (!phase || !type || !title || !content) {
        return res.status(400).json({ error: "Bad request", message: "phase, type, title, and content are required" });
      }

      const artifact = await phaseService.createArtifact(param(req, "projectId"), {
        phase,
        type,
        title,
        content,
        createdBy: userId,
      });
      res.status(201).json({ success: true, data: artifact });
    } catch (error: any) {
      console.error("Error creating artifact:", error);
      res.status(500).json({ error: "Internal server error", message: error?.message || "Failed to create artifact" });
    }
  }
}
