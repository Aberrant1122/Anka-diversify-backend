import { Request, Response } from "express";
import { isPlanningDomainError, PlanningDomainError } from "../planning/planning-errors";
import { validateRequirementsRevisionTarget } from "../planning/requirements-schema";
import {
  RequirementsRevisionOperation,
  validateRevisionOperation,
} from "../planning/requirements-revision-policy";
import {
  DocumentationRevisionOperation,
  validateDocumentationRevisionOperation,
  validateDocumentationRevisionTarget,
  ValidatedDocumentationRevisionTarget,
} from "../planning/documentation-revision-policy";
import { DocumentationProviderRoot, DocumentationValidationError } from "../planning/documentation-schema";
import { ArchitectureRevisionOperation, ARCHITECTURE_REVISION_OPERATIONS, ComponentRetirement, IdentityRetirement, normalizeComponentRetirements, normalizeIdentityRetirements } from "../planning/architecture-revision-policy";
import { ArchitectureValidationError } from "../planning/architecture-schema";
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

function architectureArtifactBody(req: Request, successor: boolean): { title: string; structuredContent: unknown; baseContentHash?: string } {
  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", "Request body must be an object.", 422);
  const allowed = successor ? ["title", "structuredContent", "baseContentHash"] : ["title", "structuredContent"];
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", `Unknown Architecture fields: ${unknown.join(", ")}.`, 422, { fields: unknown });
  if (!body.structuredContent || typeof body.structuredContent !== "object" || Array.isArray(body.structuredContent)) throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", "structuredContent must be an object.", 422);
  return { title: requiredBodyString(req, "title"), structuredContent: body.structuredContent, ...(successor ? { baseContentHash: requiredBodyString(req, "baseContentHash") } : {}) };
}

function architectureRevisionBody(req: Request): { operation: ArchitectureRevisionOperation; baseVersion: number;
  baseContentHash: string; instruction: string; includeMemory: boolean; rebaseToCurrentAuthorities: boolean; componentRetirements: ComponentRetirement[]; identityRetirements: IdentityRetirement[] } {
  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", "Request body must be a JSON object.", 422);
  if (!ARCHITECTURE_REVISION_OPERATIONS.includes(body.operation))
    throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", "A supported Architecture revision operation is required.", 422);
  const operation = body.operation as ArchitectureRevisionOperation;
  const contentField = operation === "DOCUMENT_REVISION" ? "instruction" : "feedback";
  const allowed = new Set(["operation", "baseVersion", "baseContentHash", contentField, "includeMemory", "rebaseToCurrentAuthorities", "componentRetirements", "identityRetirements"]);
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length) throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", `Unknown Architecture revision fields: ${unknown.join(", ")}.`, 422, { fields: unknown });
  const instruction = body[contentField];
  if (typeof instruction !== "string" || !instruction.trim() || Buffer.byteLength(instruction, "utf8") > 8192)
    throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", `${contentField} must be non-empty and at most 8192 UTF-8 bytes.`, 422);
  if (!Number.isSafeInteger(body.baseVersion) || body.baseVersion < 1 ||
      typeof body.baseContentHash !== "string" || !/^[a-f0-9]{64}$/.test(body.baseContentHash))
    throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", "Exact baseVersion and baseContentHash are required.", 422);
  if (body.includeMemory !== undefined && typeof body.includeMemory !== "boolean")
    throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", "includeMemory must be a boolean.", 422);
  if (body.rebaseToCurrentAuthorities !== undefined && typeof body.rebaseToCurrentAuthorities !== "boolean")
    throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", "rebaseToCurrentAuthorities must be a boolean.", 422);
  if (body.rebaseToCurrentAuthorities && operation !== "DOCUMENT_REVISION")
    throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", "Explicit rebase requires DOCUMENT_REVISION.", 422);
  let componentRetirements: ComponentRetirement[];
  let identityRetirements: IdentityRetirement[];
  try {
    componentRetirements = normalizeComponentRetirements(body.componentRetirements);
    identityRetirements = normalizeIdentityRetirements(body.identityRetirements);
  }
  catch (error) {
    if (error instanceof ArchitectureValidationError) throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", error.message, 422, { path: error.path });
    throw error;
  }
  return { operation, baseVersion: body.baseVersion, baseContentHash: body.baseContentHash,
    instruction: instruction.trim().replace(/\r\n?/g, "\n"), includeMemory: body.includeMemory === true,
    rebaseToCurrentAuthorities: body.rebaseToCurrentAuthorities === true, componentRetirements, identityRetirements };
}

function validateArchitectureDecisionBody(req: Request, action: "request" | "approve" | "changes"): void {
  if (param(req, "phase") !== "architecture") return;
  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", "Request body must be an object.", 422);
  const allowed = action === "request" ? ["artifactId", "expectedHash"] : ["artifactId", "expectedHash", "comments"];
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", `Unknown Architecture decision fields: ${unknown.join(", ")}.`, 422, { fields: unknown });
  if (body.comments !== undefined && (typeof body.comments !== "string" || !body.comments.trim())) throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", "comments must be a non-empty string when provided.", 422);
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
      "Idempotency-Key is required for structured planning AI operations.",
      422,
      { field: "Idempotency-Key" },
    );
  }
  return value;
}

function documentationGenerationBody(req: Request, phase: "Documentation" | "Architecture" = "Documentation"): { includeMemory: boolean } {
  const body = req.body === undefined ? {} : req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", "Request body must be an object.", 422);
  }
  const unknown = Object.keys(body).filter((key) => key !== "includeMemory");
  if (unknown.length > 0) {
    throw new PlanningDomainError(
      "PLANNING_ARTIFACT_INVALID",
      `Unknown initial ${phase} generation fields: ${unknown.join(", ")}.`,
      422,
      { fields: unknown },
    );
  }
  if (body.includeMemory !== undefined && typeof body.includeMemory !== "boolean") {
    throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", "includeMemory must be a boolean when provided.", 422, { field: "includeMemory" });
  }
  return { includeMemory: body.includeMemory === true };
}

function documentationRevisionBody(req: Request): {
  operation: DocumentationRevisionOperation;
  instruction: string;
  targetSectionKey: DocumentationProviderRoot | null;
  includeMemory: boolean;
  rebaseToCurrentRequirements?: boolean;
} {
  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new PlanningDomainError(
      "PLANNING_ARTIFACT_INVALID",
      "Request body must be a JSON object.",
      422,
    );
  }
  const allowed = new Set(["operation", "instruction", "includeMemory", "targetSectionKey", "rebaseToCurrentRequirements"]);
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new PlanningDomainError(
      "PLANNING_ARTIFACT_INVALID",
      `Unknown Documentation revision fields: ${unknown.join(", ")}.`,
      422,
      { fields: unknown },
    );
  }
  const operation = body.operation;
  if (typeof operation !== "string") {
    throw new PlanningDomainError(
      "PLANNING_ARTIFACT_INVALID",
      "A supported Documentation revision operation is required.",
      422,
      { operation },
    );
  }
  try {
    validateDocumentationRevisionOperation(operation);
  } catch (error) {
    if (error instanceof DocumentationValidationError) {
      throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", error.message, 422, error.details);
    }
    throw error;
  }

  let target: ValidatedDocumentationRevisionTarget;
  try {
    target = validateDocumentationRevisionTarget(operation, body.targetSectionKey);
  } catch (error) {
    if (error instanceof DocumentationValidationError) {
      throw new PlanningDomainError("PLANNING_INVALID_SECTION", error.message, 422, error.details);
    }
    throw error;
  }

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
  if (body.rebaseToCurrentRequirements !== undefined) {
    if (typeof body.rebaseToCurrentRequirements !== "boolean") {
      throw new PlanningDomainError(
        "PLANNING_ARTIFACT_INVALID",
        "rebaseToCurrentRequirements must be a boolean when provided.",
        422,
        { field: "rebaseToCurrentRequirements" },
      );
    }
    if (body.rebaseToCurrentRequirements && operation !== "DOCUMENT_REVISION") {
      throw new PlanningDomainError(
        "PLANNING_ARTIFACT_INVALID",
        "rebaseToCurrentRequirements is only supported for DOCUMENT_REVISION operations.",
        422,
        { operation },
      );
    }
  }

  return {
    operation,
    instruction: instruction.trim(),
    targetSectionKey: target.targetSectionKey,
    includeMemory: body.includeMemory === true,
    rebaseToCurrentRequirements: body.rebaseToCurrentRequirements === true,
  };
}

function documentRevisionOnlyBody(req: Request): {
  instruction: string;
  includeMemory: boolean;
  rebaseToCurrentRequirements?: boolean;
} {
  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", "Request body must be a JSON object.", 422);
  }
  const allowed = new Set(["instruction", "includeMemory", "rebaseToCurrentRequirements"]);
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", `Unknown revision fields: ${unknown.join(", ")}.`, 422, { fields: unknown });
  }
  const instruction = body.instruction;
  if (typeof instruction !== "string" || !instruction.trim()) {
    throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", "Explicit revision instruction is required.", 422, { field: "instruction" });
  }
  if (body.includeMemory !== undefined && typeof body.includeMemory !== "boolean") {
    throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", "includeMemory must be a boolean when provided.", 422, { field: "includeMemory" });
  }
  if (body.rebaseToCurrentRequirements !== undefined && typeof body.rebaseToCurrentRequirements !== "boolean") {
    throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", "rebaseToCurrentRequirements must be a boolean when provided.", 422, { field: "rebaseToCurrentRequirements" });
  }
  return {
    instruction: instruction.trim(),
    includeMemory: body.includeMemory === true,
    rebaseToCurrentRequirements: body.rebaseToCurrentRequirements === true,
  };
}

function feedbackBody(req: Request): {
  instruction: string;
  includeMemory: boolean;
} {
  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", "Request body must be a JSON object.", 422);
  }
  const allowed = new Set(["feedback", "instruction", "includeMemory"]);
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", `Unknown feedback fields: ${unknown.join(", ")}.`, 422, { fields: unknown });
  }
  const rawText = body.feedback ?? body.instruction;
  if (typeof rawText !== "string" || !rawText.trim()) {
    throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", "Feedback instruction is required.", 422, { field: "feedback" });
  }
  if (body.includeMemory !== undefined && typeof body.includeMemory !== "boolean") {
    throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", "includeMemory must be a boolean when provided.", 422, { field: "includeMemory" });
  }
  return {
    instruction: rawText.trim(),
    includeMemory: body.includeMemory === true,
  };
}

function sectionRevisionBody(req: Request): {
  instruction: string;
  includeMemory: boolean;
} {
  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", "Request body must be a JSON object.", 422);
  }
  const allowed = new Set(["instruction", "includeMemory"]);
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", `Unknown section revision fields: ${unknown.join(", ")}.`, 422, { fields: unknown });
  }
  const instruction = body.instruction;
  if (typeof instruction !== "string" || !instruction.trim()) {
    throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", "Explicit section revision instruction is required.", 422, { field: "instruction" });
  }
  if (body.includeMemory !== undefined && typeof body.includeMemory !== "boolean") {
    throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", "includeMemory must be a boolean when provided.", 422, { field: "includeMemory" });
  }
  return {
    instruction: instruction.trim(),
    includeMemory: body.includeMemory === true,
  };
}

function sectionRegenerationBody(req: Request): {
  instruction?: string;
  includeMemory: boolean;
} {
  const body = req.body === undefined ? {} : req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", "Request body must be a JSON object.", 422);
  }
  const allowed = new Set(["instruction", "includeMemory"]);
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", `Unknown section regeneration fields: ${unknown.join(", ")}.`, 422, { fields: unknown });
  }
  if (body.instruction !== undefined && (typeof body.instruction !== "string" || !body.instruction.trim())) {
    throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", "instruction must be a non-empty string when provided.", 422, { field: "instruction" });
  }
  if (body.includeMemory !== undefined && typeof body.includeMemory !== "boolean") {
    throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", "includeMemory must be a boolean when provided.", 422, { field: "includeMemory" });
  }
  return {
    instruction: body.instruction?.trim(),
    includeMemory: body.includeMemory === true,
  };
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
  async createArchitectureArtifact(req: Request, res: Response) {
    try {
      const actorId = requireUser(req, res);
      if (!actorId) return;
      const body = architectureArtifactBody(req, false);
      const artifact = await phaseService.createArchitectureArtifact({ projectId: param(req, "projectId"), actorId, ...body });
      res.status(201).json({ success: true, data: artifact });
    } catch (error) { respondError(res, error, "Failed to create Architecture artifact"); }
  }

  async generateInitialArchitecture(req: Request, res: Response) {
    try {
      const actorId = requireUser(req, res);
      if (!actorId) return;
      const body = documentationGenerationBody(req, "Architecture");
      const result = await phaseService.generateInitialArchitecture({
        projectId: param(req, "projectId"), actorId,
        idempotencyKey: idempotencyKey(req), includeMemory: body.includeMemory,
      });
      const { httpStatus, ...data } = result;
      res.status(httpStatus).json({ success: true, data });
    } catch (error) { respondError(res, error, "Failed to generate initial Architecture"); }
  }

  async getArchitectureRun(req: Request, res: Response) {
    try {
      const actorId = requireUser(req, res);
      if (!actorId) return;
      const run = await phaseService.getArchitectureRun(param(req, "projectId"), param(req, "runId"), actorId);
      res.json({ success: true, data: run });
    } catch (error) { respondError(res, error, "Failed to fetch Architecture run"); }
  }

  async createArchitectureSuccessor(req: Request, res: Response) {
    try {
      const actorId = requireUser(req, res);
      if (!actorId) return;
      const body = architectureArtifactBody(req, true);
      const artifact = await phaseService.createArchitectureArtifact({ projectId: param(req, "projectId"), actorId, title: body.title, structuredContent: body.structuredContent, baseArtifactId: param(req, "artifactId"), baseContentHash: body.baseContentHash });
      res.status(201).json({ success: true, data: artifact });
    } catch (error) { respondError(res, error, "Failed to create Architecture successor"); }
  }

  async reviseArchitectureAI(req: Request, res: Response) {
    try {
      const actorId = requireUser(req, res);
      if (!actorId) return;
      const body = architectureRevisionBody(req);
      const result = await phaseService.reviseArchitecture({ projectId: param(req, "projectId"), actorId,
        idempotencyKey: idempotencyKey(req), baseArtifactId: param(req, "artifactId"), ...body });
      const { httpStatus, ...data } = result;
      res.status(httpStatus).json({ success: true, data });
    } catch (error) { respondError(res, error, "Failed to revise Architecture with AI"); }
  }

  async getArchitectureReadiness(req: Request, res: Response) {
    try {
      const actorId = requireUser(req, res);
      if (!actorId) return;
      const readiness = await phaseService.getArchitectureReadiness(param(req, "projectId"), param(req, "artifactId"), actorId, optionalQueryString(req, "expectedHash"));
      res.json({ success: true, data: readiness });
    } catch (error) { respondError(res, error, "Failed to fetch Architecture readiness"); }
  }

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
      validateArchitectureDecisionBody(req, "request");
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
      validateArchitectureDecisionBody(req, "approve");
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
      validateArchitectureDecisionBody(req, "changes");
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

  async generateInitialDocumentation(req: Request, res: Response) {
    try {
      const userId = requireUser(req, res);
      if (!userId) return;
      const body = documentationGenerationBody(req);
      const result = await phaseService.generateInitialDocumentation({
        projectId: param(req, "projectId"), actorId: userId,
        idempotencyKey: idempotencyKey(req), includeMemory: body.includeMemory,
      });
      const { httpStatus, ...data } = result;
      res.status(httpStatus).json({ success: true, data });
    } catch (error) {
      respondError(res, error, "Failed to generate initial Documentation");
    }
  }

  async reviseDocumentation(req: Request, res: Response) {
    try {
      const userId = requireUser(req, res);
      if (!userId) return;
      const body = documentationRevisionBody(req);
      const result = await phaseService.reviseDocumentation({
        projectId: param(req, "projectId"),
        baseArtifactId: param(req, "artifactId"),
        actorId: userId,
        idempotencyKey: idempotencyKey(req),
        operation: body.operation,
        instruction: body.instruction,
        targetSectionKey: body.targetSectionKey,
        includeMemory: body.includeMemory,
        rebaseToCurrentRequirements: body.rebaseToCurrentRequirements,
      });
      const { httpStatus, ...data } = result;
      res.status(httpStatus).json({ success: true, data });
    } catch (error) {
      respondError(res, error, "Failed to revise Documentation");
    }
  }

  async reviseDocumentationDocument(req: Request, res: Response) {
    try {
      const userId = requireUser(req, res);
      if (!userId) return;
      const body = documentRevisionOnlyBody(req);
      const result = await phaseService.reviseDocumentation({
        projectId: param(req, "projectId"),
        baseArtifactId: param(req, "artifactId"),
        actorId: userId,
        idempotencyKey: idempotencyKey(req),
        operation: "DOCUMENT_REVISION",
        instruction: body.instruction,
        targetSectionKey: null,
        includeMemory: body.includeMemory,
        rebaseToCurrentRequirements: body.rebaseToCurrentRequirements,
      });
      const { httpStatus, ...data } = result;
      res.status(httpStatus).json({ success: true, data });
    } catch (error) {
      respondError(res, error, "Failed to revise Documentation document");
    }
  }

  async applyDocumentationFeedback(req: Request, res: Response) {
    try {
      const userId = requireUser(req, res);
      if (!userId) return;
      const body = feedbackBody(req);
      const result = await phaseService.reviseDocumentation({
        projectId: param(req, "projectId"),
        baseArtifactId: param(req, "artifactId"),
        actorId: userId,
        idempotencyKey: idempotencyKey(req),
        operation: "FEEDBACK_APPLICATION",
        instruction: body.instruction,
        targetSectionKey: null,
        includeMemory: body.includeMemory,
      });
      const { httpStatus, ...data } = result;
      res.status(httpStatus).json({ success: true, data });
    } catch (error) {
      respondError(res, error, "Failed to apply Documentation feedback");
    }
  }

  async reviseDocumentationSection(req: Request, res: Response) {
    try {
      const userId = requireUser(req, res);
      if (!userId) return;
      const sectionKey = param(req, "sectionKey");
      let target: ValidatedDocumentationRevisionTarget;
      try {
        target = validateDocumentationRevisionTarget("SECTION_REVISION", sectionKey);
      } catch (error) {
        if (error instanceof DocumentationValidationError) {
          throw new PlanningDomainError("PLANNING_INVALID_SECTION", error.message, 422, error.details);
        }
        throw error;
      }
      const body = sectionRevisionBody(req);
      const result = await phaseService.reviseDocumentation({
        projectId: param(req, "projectId"),
        baseArtifactId: param(req, "artifactId"),
        actorId: userId,
        idempotencyKey: idempotencyKey(req),
        operation: "SECTION_REVISION",
        instruction: body.instruction,
        targetSectionKey: target.targetSectionKey,
        includeMemory: body.includeMemory,
      });
      const { httpStatus, ...data } = result;
      res.status(httpStatus).json({ success: true, data });
    } catch (error) {
      respondError(res, error, "Failed to revise Documentation section");
    }
  }

  async regenerateDocumentationSection(req: Request, res: Response) {
    try {
      const userId = requireUser(req, res);
      if (!userId) return;
      const sectionKey = param(req, "sectionKey");
      let target: ValidatedDocumentationRevisionTarget;
      try {
        target = validateDocumentationRevisionTarget("SECTION_REGENERATION", sectionKey);
      } catch (error) {
        if (error instanceof DocumentationValidationError) {
          throw new PlanningDomainError("PLANNING_INVALID_SECTION", error.message, 422, error.details);
        }
        throw error;
      }
      const body = sectionRegenerationBody(req);
      const result = await phaseService.reviseDocumentation({
        projectId: param(req, "projectId"),
        baseArtifactId: param(req, "artifactId"),
        actorId: userId,
        idempotencyKey: idempotencyKey(req),
        operation: "SECTION_REGENERATION",
        instruction: body.instruction ?? `Regenerate section ${sectionKey} from authoritative context`,
        targetSectionKey: target.targetSectionKey,
        includeMemory: body.includeMemory,
      });
      const { httpStatus, ...data } = result;
      res.status(httpStatus).json({ success: true, data });
    } catch (error) {
      respondError(res, error, "Failed to regenerate Documentation section");
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
