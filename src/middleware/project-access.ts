import { NextFunction, Request, Response } from "express";
import { isPlanningDomainError } from "../planning/planning-errors";
import { PlanningAuthorizationService } from "../services/planning-authorization.service";
import { prisma } from "../services/database";

const authorization = new PlanningAuthorizationService(prisma);

export function requireProjectAccess(projectParamName: string) {
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
      await authorization.assertCanRead(projectId, userId);
      next();
    } catch (error) {
      if (isPlanningDomainError(error)) {
        return res.status(error.httpStatus).json({ error: error.code, message: error.message });
      }
      next(error);
    }
  };
}
