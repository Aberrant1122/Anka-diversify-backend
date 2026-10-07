import { NextFunction, Request, Response } from "express";
import { prisma } from "../services/database";

type Resource = "file" | "session" | "sprint" | "task" | "comment" |
  "checklist" | "document" | "rule" | "decision" | "repository" | "artifact";
type Identifier = { source: "params" | "body"; key: string; resource: Resource; optional?: boolean };

async function belongsToProject(resource: Resource, id: string, projectId: string, userId: string): Promise<boolean> {
  switch (resource) {
    case "file": return Boolean(await prisma.projectFile.findFirst({ where: { id, projectId }, select: { id: true } }));
    case "session": return Boolean(await prisma.aiChatSession.findFirst({ where: { id, projectId, userId, type: "project" }, select: { id: true } }));
    case "sprint": return Boolean(await prisma.sprint.findFirst({ where: { id, projectId }, select: { id: true } }));
    case "task": return Boolean(await prisma.projectTask.findFirst({ where: { id, projectId }, select: { id: true } }));
    case "comment": return Boolean(await prisma.taskComment.findFirst({ where: { id, projectId, task: { projectId } }, select: { id: true } }));
    case "checklist": return Boolean(await prisma.taskChecklistItem.findFirst({ where: { id, projectId, task: { projectId } }, select: { id: true } }));
    case "document": return Boolean(await prisma.projectDocument.findFirst({ where: { id, projectId }, select: { id: true } }));
    case "rule": return Boolean(await prisma.projectRule.findFirst({ where: { id, projectId }, select: { id: true } }));
    case "decision": return Boolean(await prisma.projectDecision.findFirst({ where: { id, projectId }, select: { id: true } }));
    case "repository": return Boolean(await prisma.projectRepository.findFirst({ where: { id, projectId }, select: { id: true } }));
    case "artifact": return Boolean(await prisma.phaseArtifact.findFirst({ where: { id, projectId }, select: { id: true } }));
  }
}

// Run after requireProjectAccess. A missing resource and one from another project
// have the same response, before the controller can perform an external effect.
export function requireProjectResources(projectParam: string, ...identifiers: Identifier[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const projectId = req.params[projectParam];
    const userId = req.user?.userId;
    if (typeof projectId !== "string" || typeof userId !== "string") {
      return res.status(404).json({ error: "Resource not found" });
    }
    try {
      for (const identifier of identifiers) {
        const value = identifier.source === "params" ? req.params[identifier.key] : req.body?.[identifier.key];
        if (identifier.optional && value === undefined) continue;
        if (typeof value !== "string" || !value ||
            !await belongsToProject(identifier.resource, value, projectId, userId)) {
          return res.status(404).json({ error: "Resource not found" });
        }
      }
      next();
    } catch (error) { next(error); }
  };
}

export function routeResource(key: string, resource: Resource): Identifier {
  return { source: "params", key, resource };
}

export function bodyResource(key: string, resource: Resource, optional = false): Identifier {
  return { source: "body", key, resource, optional };
}
