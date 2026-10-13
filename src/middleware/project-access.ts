import { NextFunction, Request, Response } from "express";
import { isPlanningDomainError } from "../planning/planning-errors";
import { PlanningAuthorizationService } from "../services/planning-authorization.service";
import { prisma } from "../services/database";

const authorization = new PlanningAuthorizationService(prisma);

type ProjectPermission = "read" | "edit" | "owner";

function requireProjectPermission(projectParamName: string, permission: ProjectPermission) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.user?.userId;
    if (typeof userId !== "string" || !userId) {
      return res.status(401).json({ message: "Authentication required" });
    }

    const projectId = req.params[projectParamName];
    if (typeof projectId !== "string" || !projectId || projectId.trim() !== projectId ||
        /[\u0000-\u001f\u007f]/.test(projectId)) {
      return res.status(400).json({ message: "Invalid project ID" });
    }

    try {
      if (permission === "owner") {
        await authorization.assertOwner(projectId, userId);
      } else if (permission === "edit") {
        await authorization.assertCanEdit(projectId, userId);
      } else {
        await authorization.assertCanRead(projectId, userId);
      }
      next();
    } catch (error) {
      if (isPlanningDomainError(error)) {
        return res.status(error.httpStatus).json({ error: error.code, message: error.message });
      }
      next(error);
    }
  };
}

export function requireProjectAccess(projectParamName: string) {
  return requireProjectPermission(projectParamName, "read");
}

export function requireProjectEdit(projectParamName: string) {
  return requireProjectPermission(projectParamName, "edit");
}

export function requireProjectOwner(projectParamName: string) {
  return requireProjectPermission(projectParamName, "owner");
}
