import { PrismaClient } from "@prisma/client";
import { Request, Response } from "express";
import { isPlanningDomainError, PlanningDomainError } from "../planning/planning-errors";
import { LiveBriefService } from "../services/live-brief.service";

const service = new LiveBriefService(new PrismaClient());

function actor(req: Request): string {
  const userId = req.user?.userId;
  if (typeof userId !== "string" || !userId) throw new PlanningDomainError("PLANNING_FORBIDDEN", "Authentication required.", 401);
  return userId;
}

function projectId(req: Request): string {
  const value = req.params.projectId;
  if (typeof value !== "string" || !value) throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", "Invalid project ID.", 422);
  return value;
}

function stringField(body: unknown, key: string): string {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", "Request body must be an object.", 422);
  const value = (body as Record<string, unknown>)[key];
  if (typeof value !== "string" || !value.trim()) throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", `${key} is required.`, 422);
  return value;
}

function integerField(body: unknown, key: string): number {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", "Request body must be an object.", 422);
  const value = (body as Record<string, unknown>)[key];
  if (!Number.isSafeInteger(value)) throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", `${key} is required.`, 422);
  return value as number;
}

function fail(res: Response, error: unknown): void {
  if (isPlanningDomainError(error)) {
    res.status(error.httpStatus).json({ error: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) });
    return;
  }
  console.error("Live Brief request failed", error);
  res.status(500).json({ error: "PLANNING_PERSISTENCE_FAILED", message: "The Live Brief request could not be completed." });
}

export class LiveBriefController {
  async get(req: Request, res: Response) {
    try { res.json({ success: true, data: await service.getWorkspace(projectId(req), actor(req)) }); }
    catch (error) { fail(res, error); }
  }

  async initialize(req: Request, res: Response) {
    try {
      await service.initialize(projectId(req), actor(req));
      res.status(201).json({ success: true, data: await service.getWorkspace(projectId(req), actor(req)) });
    } catch (error) { fail(res, error); }
  }

  async chat(req: Request, res: Response) {
    try {
      const requestKey = req.get("Idempotency-Key") || "";
      const sourceIds = req.body?.sourceIds;
      if (sourceIds !== undefined && (!Array.isArray(sourceIds) || sourceIds.some((item: unknown) => typeof item !== "string"))) {
        throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", "sourceIds must be a string array.", 422);
      }
      const data = await service.converse({
        projectId: projectId(req), actorId: actor(req), requestKey,
        message: stringField(req.body, "message"), sourceIds,
      });
      res.json({ success: true, data });
    } catch (error) { fail(res, error); }
  }

  async update(req: Request, res: Response) {
    try {
      const data = await service.updateBrief({
        projectId: projectId(req), actorId: actor(req),
        expectedRevisionNumber: integerField(req.body, "expectedRevisionNumber"),
        title: stringField(req.body, "title"), markdownContent: stringField(req.body, "markdownContent"),
        changeSummary: typeof req.body?.changeSummary === "string" ? req.body.changeSummary : undefined,
      });
      res.json({ success: true, data });
    } catch (error) { fail(res, error); }
  }

  async decideClaim(req: Request, res: Response) {
    try {
      const action = stringField(req.body, "action");
      if (!["ACCEPT", "REJECT", "CORRECT", "SUPERSEDE"].includes(action)) throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", "Unsupported claim action.", 422);
      const data = await service.decideClaim({
        projectId: projectId(req), actorId: actor(req), claimId: stringField(req.params, "claimId"),
        action: action as "ACCEPT" | "REJECT" | "CORRECT" | "SUPERSEDE",
        expectedRevisionNumber: integerField(req.body, "expectedRevisionNumber"),
        content: typeof req.body?.content === "string" ? req.body.content : undefined,
        title: typeof req.body?.title === "string" ? req.body.title : undefined,
      });
      res.json({ success: true, data });
    } catch (error) { fail(res, error); }
  }

  async answerQuestion(req: Request, res: Response) {
    try {
      const data = await service.answerQuestion({
        projectId: projectId(req), actorId: actor(req), questionId: stringField(req.params, "questionId"),
        answer: stringField(req.body, "answer"), expectedRevisionNumber: integerField(req.body, "expectedRevisionNumber"),
      });
      res.json({ success: true, data });
    } catch (error) { fail(res, error); }
  }

  async resolveContradiction(req: Request, res: Response) {
    try {
      const data = await service.resolveContradiction({
        projectId: projectId(req), actorId: actor(req), contradictionId: stringField(req.params, "contradictionId"),
        resolutionNote: stringField(req.body, "resolutionNote"), expectedRevisionNumber: integerField(req.body, "expectedRevisionNumber"),
        dismiss: req.body?.dismiss === true,
      });
      res.json({ success: true, data });
    } catch (error) { fail(res, error); }
  }

  async confirm(req: Request, res: Response) {
    try {
      const data = await service.confirm({
        projectId: projectId(req), actorId: actor(req), revisionId: stringField(req.body, "revisionId"),
        expectedContentHash: stringField(req.body, "expectedContentHash"),
        notes: typeof req.body?.notes === "string" ? req.body.notes : undefined,
      });
      res.status(201).json({ success: true, data });
    } catch (error) { fail(res, error); }
  }
}
