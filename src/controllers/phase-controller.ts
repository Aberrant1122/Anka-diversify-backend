import { Request, Response } from "express";
import { isPlanningDomainError, PlanningDomainError } from "../planning/planning-errors";
import { validateRequirementsRevisionTarget } from "../planning/requirements-schema";
import {
  RequirementsRevisionOperation,
  validateRevisionOperation,
} from "../planning/requirements-revision-policy";
import { PhaseService } from "../services/phase-service";

const phaseService = new PhaseService();

function getUserId(req: Request): string | null {
  return (req.user?.userId as string | undefined) || null;
}

function param(req: Request, key: string): string {
  const value = req.params[key];
  return Array.isArray(value) ? value[0] : (value as string);
}

function requiredBodyString(req: Request, key: string): string {
  const value = req.body?.[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PlanningDomainError(
      "PLANNING_ARTIFACT_INVALID",
      `${key} is required.`,
      422,
      { field: key },
    );
  }
  return value;
}

function optionalQueryString(req: Request, key: string): string | undefined {
  const value = req.query[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PlanningDomainError(
      "PLANNING_ARTIFACT_INVALID",
      `${key} must be a non-empty string when provided.`,
      422,
      { field: key },
    );
  }
  return value;
}

function initialGenerationBody(req: Request): { brief: string; includeMemory: boolean } {
  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new PlanningDomainError(
      "PLANNING_ARTIFACT_INVALID",
      "Request body must be an object.",
      422,
    );
  }
  const allowed = new Set(["brief", "includeMemory"]);
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new PlanningDomainError(
      "PLANNING_ARTIFACT_INVALID",
      `Unknown initial Requirements generation fields: ${unknown.join(", ")}.`,
      422,
      { fields: unknown },
    );
  }
  if (body.includeMemory !== undefined && typeof body.includeMemory !== "boolean") {
    throw new PlanningDomainError(
      "PLANNING_ARTIFACT_INVALID",
      "includeMemory must be a boolean when provided.",
      422,
      { field: "includeMemory" },
    );
  }
  return { brief: requiredBodyString(req, "brief"), includeMemory: body.includeMemory === true };
}

function idempotencyKey(req: Request): string {
  const value = req.get("Idempotency-Key");
  if (!value?.trim()) {
    throw new PlanningDomainError(
      "PLANNING_ARTIFACT_INVALID",
      "Idempotency-Key is required for Requirements AI operations.",
      422,
      { field: "Idempotency-Key" },
    );
  }
  return value;
}

function revisionBody(req: Request): {
  operation: RequirementsRevisionOperation;
  instruction: string;
  targetSectionKey: string | null;
  includeMemory: boolean;
} {
  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new PlanningDomainError(
      "PLANNING_ARTIFACT_INVALID",
      "Request body must be a JSON object.",
      422,
    );
  }
  const allowed = new Set(["operation", "instruction", "includeMemory", "targetSectionKey"]);
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new PlanningDomainError(
      "PLANNING_ARTIFACT_INVALID",
      `Unknown Requirements revision fields: ${unknown.join(", ")}.`,
      422,
      { fields: unknown },
    );
  }
  const operation = body.operation;
  if (typeof operation !== "string") {
    throw new PlanningDomainError(
      "PLANNING_ARTIFACT_INVALID",
      "A supported Requirements revision operation is required.",
      422,
      { operation },
    );
  }
  validateRevisionOperation(operation);
  const target = validateRequirementsRevisionTarget(operation, body.targetSectionKey);
  const instruction = body.instruction;
  if (typeof instruction !== "string" || !instruction.trim()) {
    throw new PlanningDomainError(
      "PLANNING_ARTIFACT_INVALID",
      "Explicit revision instruction is required.",
      422,
      { field: "instruction" },
    );
  }
  if (body.includeMemory !== undefined && typeof body.includeMemory !== "boolean") {
    throw new PlanningDomainError(
      "PLANNING_ARTIFACT_INVALID",
      "includeMemory must be a boolean when provided.",
      422,
      { field: "includeMemory" },
    );
  }
  return {
    operation,
    instruction: instruction.trim(),
    targetSectionKey: target.targetSectionKey,
    includeMemory: body.includeMemory === true,
  };
}

function requireUser(req: Request, res: Response): string | null {
  const userId = getUserId(req);
  if (!userId) res.status(401).json({ error: "Unauthorized", message: "Authentication required" });
  return userId;
}

function respondError(res: Response, error: unknown, fallback: string): void {
  if (isPlanningDomainError(error)) {
    res.status(error.httpStatus).json({
      error: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    });
    return;
  }
  console.error(fallback, error);
  res.status(500).json({
    error: "Internal server error",
    message: "The planning request could not be completed.",
  });
}

export class PhaseController {
  async getPhaseStates(req: Request, res: Response) {
    try {
      const userId = requireUser(req, res);
      if (!userId) return;
      const states = await phaseService.ensurePhaseStates(param(req, "projectId"), userId);
      res.json({ success: true, data: states });
    } catch (error) {
      respondError(res, error, "Failed to fetch phase states");
    }
  }

  async getRequirementsPolicy(req: Request, res: Response) {
    try {
      const userId = requireUser(req, res);
      if (!userId) return;
      const policy = await phaseService.getRequirementsPolicy(param(req, "projectId"), userId);
      res.json({ success: true, data: policy });
    } catch (error) {
      respondError(res, error, "Failed to fetch Requirements policy");
    }
  }

  async startPhase(req: Request, res: Response) {
    try {
      const userId = requireUser(req, res);
      if (!userId) return;
      const state = await phaseService.startPhase(param(req, "projectId"), param(req, "phase"), userId);
      res.json({ success: true, data: state });
    } catch (error) {
      respondError(res, error, "Failed to start phase");
    }
  }

  async requestApproval(req: Request, res: Response) {
    try {
      const userId = requireUser(req, res);
      if (!userId) return;
      const state = await phaseService.requestApproval(
        param(req, "projectId"),
        param(req, "phase"),
        requiredBodyString(req, "artifactId"),
        requiredBodyString(req, "expectedHash"),
        userId,
      );
      res.json({ success: true, data: state });
    } catch (error) {
      respondError(res, error, "Failed to request approval");
    }
  }

  async approvePhase(req: Request, res: Response) {
    try {
      const userId = requireUser(req, res);
      if (!userId) return;
      const state = await phaseService.approvePhase(
        param(req, "projectId"),
        param(req, "phase"),
        requiredBodyString(req, "artifactId"),
        requiredBodyString(req, "expectedHash"),
        userId,
        req.body?.comments,
      );
      res.json({ success: true, data: state });
    } catch (error) {
      respondError(res, error, "Failed to approve phase");
    }
  }

  async rejectPhase(req: Request, res: Response) {
    try {
      const userId = requireUser(req, res);
      if (!userId) return;
      const state = await phaseService.rejectPhase(
        param(req, "projectId"),
        param(req, "phase"),
        requiredBodyString(req, "artifactId"),
        requiredBodyString(req, "expectedHash"),
        userId,
        requiredBodyString(req, "comments"),
      );
      res.json({ success: true, data: state });
    } catch (error) {
      respondError(res, error, "Failed to reject phase");
    }
  }

  async requestChanges(req: Request, res: Response) {
    try {
      const userId = requireUser(req, res);
      if (!userId) return;
      const state = await phaseService.requestChanges(
        param(req, "projectId"),
        param(req, "phase"),
        requiredBodyString(req, "artifactId"),
        requiredBodyString(req, "expectedHash"),
        userId,
        requiredBodyString(req, "comments"),
      );
      res.json({ success: true, data: state });
    } catch (error) {
      respondError(res, error, "Failed to request changes");
    }
  }

  async getApprovalHistory(req: Request, res: Response) {
    try {
      const userId = requireUser(req, res);
      if (!userId) return;
      const history = await phaseService.getApprovalHistory(
        param(req, "projectId"),
        userId,
        req.query.phase as string | undefined,
      );
      res.json({ success: true, data: history });
    } catch (error) {
      respondError(res, error, "Failed to fetch approval history");
    }
  }

  async listArtifacts(req: Request, res: Response) {
    try {
      const userId = requireUser(req, res);
      if (!userId) return;
      const artifacts = await phaseService.listArtifacts(
        param(req, "projectId"),
        userId,
        req.query.phase as string | undefined,
      );
      res.json({ success: true, data: artifacts });
    } catch (error) {
      respondError(res, error, "Failed to fetch artifacts");
    }
  }

  async getArtifact(req: Request, res: Response) {
    try {
      const userId = requireUser(req, res);
      if (!userId) return;
      const artifact = await phaseService.getArtifact(
        param(req, "projectId"),
        param(req, "artifactId"),
        userId,
      );
      res.json({ success: true, data: artifact });
    } catch (error) {
      respondError(res, error, "Failed to fetch artifact");
    }
  }

  async getRequirementsReadiness(req: Request, res: Response) {
    try {
      const userId = requireUser(req, res);
      if (!userId) return;
      const readiness = await phaseService.getRequirementsReadiness(
        param(req, "projectId"),
        param(req, "artifactId"),
        userId,
        optionalQueryString(req, "expectedHash"),
      );
      res.json({ success: true, data: readiness });
    } catch (error) {
      respondError(res, error, "Failed to evaluate Requirements readiness");
    }
  }

  async runAutomatedPhase(req: Request, res: Response) {
    try {
      const userId = requireUser(req, res);
      if (!userId) return;
      const result = await phaseService.runAutomatedPhase(
        param(req, "projectId"),
        param(req, "phase"),
        userId,
        req.body?.brief,
      );
      res.status(201).json({ success: true, data: result });
    } catch (error) {
      respondError(res, error, "Failed to run automated phase");
    }
  }

  async generateInitialRequirements(req: Request, res: Response) {
    try {
      const userId = requireUser(req, res);
      if (!userId) return;
      const body = initialGenerationBody(req);
      const result = await phaseService.generateInitialRequirements({
        projectId: param(req, "projectId"),
        actorId: userId,
        idempotencyKey: idempotencyKey(req),
        brief: body.brief,
        includeMemory: body.includeMemory,
      });
      const { httpStatus, ...data } = result;
      res.status(httpStatus).json({ success: true, data });
    } catch (error) {
      respondError(res, error, "Failed to generate initial Requirements");
    }
  }

  async reviseRequirements(req: Request, res: Response) {
    try {
      const userId = requireUser(req, res);
      if (!userId) return;
      const body = revisionBody(req);
      const result = await phaseService.reviseRequirements({
        projectId: param(req, "projectId"),
        baseArtifactId: param(req, "artifactId"),
        actorId: userId,
        idempotencyKey: idempotencyKey(req),
        operation: body.operation,
        instruction: body.instruction,
        targetSectionKey: body.targetSectionKey,
        includeMemory: body.includeMemory,
      });
      const { httpStatus, ...data } = result;
      res.status(httpStatus).json({ success: true, data });
    } catch (error) {
      respondError(res, error, "Failed to revise Requirements");
    }
  }

  async getWorkflowRuns(req: Request, res: Response) {
    try {
      const userId = requireUser(req, res);
      if (!userId) return;
      const runs = await phaseService.getWorkflowRuns(param(req, "projectId"), userId);
      res.json({ success: true, data: runs });
    } catch (error) {
      respondError(res, error, "Failed to fetch workflow runs");
    }
  }

  async getRequirementsRun(req: Request, res: Response) {
    try {
      const userId = requireUser(req, res);
      if (!userId) return;
      const run = await phaseService.getRequirementsRun(
        param(req, "projectId"),
        param(req, "runId"),
        userId,
      );
      res.json({ success: true, data: run });
    } catch (error) {
      respondError(res, error, "Failed to fetch Requirements run");
    }
  }

  async createArtifact(req: Request, res: Response) {
    try {
      const userId = requireUser(req, res);
      if (!userId) return;
      if (req.body?.structuredContent === undefined) {
        throw new PlanningDomainError(
          "PLANNING_ARTIFACT_INVALID",
          "structuredContent is required and is the canonical Requirements representation.",
          422,
          { field: "structuredContent" },
        );
      }
      const artifact = await phaseService.createArtifact(param(req, "projectId"), {
        phase: requiredBodyString(req, "phase"),
        title: requiredBodyString(req, "title"),
        structuredContent: req.body.structuredContent,
        createdBy: userId,
        baseArtifactId: req.body?.baseArtifactId,
        baseContentHash: req.body?.baseContentHash,
      });
      res.status(201).json({ success: true, data: artifact });
    } catch (error) {
      respondError(res, error, "Failed to create artifact");
    }
  }
}
