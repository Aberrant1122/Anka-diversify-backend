import { Request, Response } from "express";
import { ProjectRepositoryService } from "../services/project-repository-service";
import { RepositoryBootstrapService, RepositoryBootstrapError } from "../services/repository-bootstrap.service";
import { BootstrapTemplateRegistry, UnsupportedBootstrapTemplateError } from "../services/bootstrap-template-registry";
import { WorkspaceBoundaryError } from "../services/workspace-boundary-validator";
import { isPlanningDomainError } from "../planning/planning-errors";
import { prisma } from "../services/database";

const repoService = new ProjectRepositoryService();
const bootstrapService = new RepositoryBootstrapService(prisma);

function param(req: Request, key: string): string {
  const val = req.params[key];
  return Array.isArray(val) ? val[0] : (val as string);
}

function handleControllerError(res: Response, error: any, defaultMessage: string) {
  if (isPlanningDomainError(error)) {
    return res.status(error.httpStatus).json({ error: error.code, message: error.message, details: error.details });
  }
  if (error instanceof RepositoryBootstrapError) {
    return res.status(error.status).json({ error: error.code, message: error.message });
  }
  if (error instanceof UnsupportedBootstrapTemplateError) {
    return res.status(400).json({ error: "UNSUPPORTED_BOOTSTRAP_TEMPLATE", message: error.message });
  }
  if (error instanceof WorkspaceBoundaryError) {
    return res.status(400).json({ error: error.code, message: error.message });
  }

  const message = error?.message || defaultMessage;
  const status = message.includes("not found") ? 404 : 400;
  return res.status(status).json({ error: "BAD_REQUEST", message });
}

export class ProjectRepositoryController {
  async list(req: Request, res: Response) {
    try {
      const repos = await repoService.list(param(req, "projectId"));
      res.json({ success: true, data: repos });
    } catch (error: any) {
      console.error("Error listing project repositories:", error);
      res.status(500).json({ error: "INTERNAL_ERROR", message: error?.message || "Failed to list repositories" });
    }
  }

  async create(req: Request, res: Response) {
    try {
      const repo = await repoService.create(param(req, "projectId"), req.body);
      res.status(201).json({ success: true, data: repo });
    } catch (error: any) {
      console.error("Error creating project repository:", error);
      res.status(400).json({ error: "BAD_REQUEST", message: error?.message || "Failed to create repository" });
    }
  }

  async update(req: Request, res: Response) {
    try {
      const repo = await repoService.update(param(req, "projectId"), param(req, "repoId"), req.body);
      res.json({ success: true, data: repo });
    } catch (error: any) {
      console.error("Error updating project repository:", error);
      const status = error?.message === "Repository not found" ? 404 : 400;
      res.status(status).json({ error: "BAD_REQUEST", message: error?.message || "Failed to update repository" });
    }
  }

  async sync(req: Request, res: Response) {
    try {
      const snapshot = await repoService.sync(param(req, "projectId"), param(req, "repoId"));
      res.json({ success: true, data: snapshot });
    } catch (error: any) {
      console.error("Error syncing project repository:", error);
      const status = error?.message === "Repository not found" ? 404 : 400;
      res.status(status).json({ error: "BAD_REQUEST", message: error?.message || "Failed to sync repository" });
    }
  }

  async remove(req: Request, res: Response) {
    try {
      await repoService.remove(param(req, "projectId"), param(req, "repoId"));
      res.json({ success: true });
    } catch (error: any) {
      console.error("Error deleting project repository:", error);
      const status = error?.message === "Repository not found" ? 404 : 400;
      res.status(status).json({ error: "BAD_REQUEST", message: error?.message || "Failed to delete repository" });
    }
  }

  // ── CP4.2 Repository Bootstrap & Baseline Binding Endpoints ────────────────

  async bindExisting(req: Request, res: Response) {
    try {
      const projectId = param(req, "projectId");
      const actorId = req.user?.userId;
      if (!actorId) return res.status(401).json({ error: "UNAUTHORIZED", message: "Authentication required" });

      const repo = await bootstrapService.bindExistingRepository(projectId, actorId, req.body);
      res.status(200).json({ success: true, data: repo });
    } catch (error: any) {
      console.error("Error binding existing repository:", error);
      handleControllerError(res, error, "Failed to bind existing repository");
    }
  }

  async prepareBootstrapPlan(req: Request, res: Response) {
    try {
      const projectId = param(req, "projectId");
      const actorId = req.user?.userId;
      if (!actorId) return res.status(401).json({ error: "UNAUTHORIZED", message: "Authentication required" });

      const plan = await bootstrapService.prepareBootstrapPlan(projectId, actorId, req.body);
      res.status(200).json({ success: true, data: plan });
    } catch (error: any) {
      console.error("Error preparing bootstrap plan:", error);
      handleControllerError(res, error, "Failed to prepare repository bootstrap plan");
    }
  }

  async executeBootstrap(req: Request, res: Response) {
    try {
      const projectId = param(req, "projectId");
      const actorId = req.user?.userId;
      if (!actorId) return res.status(401).json({ error: "UNAUTHORIZED", message: "Authentication required" });

      const result = await bootstrapService.executeBootstrap(projectId, actorId, req.body);
      res.status(201).json({ success: true, data: result });
    } catch (error: any) {
      console.error("Error executing repository bootstrap:", error);
      handleControllerError(res, error, "Failed to initialize repository");
    }
  }

  async listTemplates(req: Request, res: Response) {
    try {
      const templates = BootstrapTemplateRegistry.listTemplates();
      res.json({ success: true, data: templates });
    } catch (error: any) {
      console.error("Error listing bootstrap templates:", error);
      res.status(500).json({ error: "INTERNAL_ERROR", message: "Failed to list bootstrap templates" });
    }
  }
}
