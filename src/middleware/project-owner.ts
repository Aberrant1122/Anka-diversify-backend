import { Request, Response, NextFunction, Router } from "express";
import { prisma } from "../services/database";

const denied = (res: Response) =>
  res.status(404).json({ error: "PROJECT_RESOURCE_NOT_FOUND" });
function value(req: Request, key: string): string | undefined {
  const raw = req.params[key];
  return typeof raw === "string" ? raw : undefined;
}

export async function requireProjectOwner(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (!req.user?.userId)
    return res.status(401).json({ error: "AUTHENTICATION_REQUIRED" });
  const id = value(req, "projectId") || value(req, "id");
  if (!id) return denied(res);
  try {
    const project = await prisma.project.findFirst({
      where: { id, userId: req.user.userId },
      select: { id: true },
    });
    if (!project) return denied(res);
    res.locals.projectId = project.id;
    next();
  } catch {
    res.status(503).json({ error: "AUTHORIZATION_UNAVAILABLE" });
  }
}

type Resource =
  | "projectTask"
  | "projectFile"
  | "projectDocument"
  | "projectRule"
  | "projectDecision"
  | "sprint"
  | "projectRepository"
  | "phaseArtifact"
  | "workflowRun"
  | "architectureDriftRecord";

// Parent routing checks project ownership. Child routing independently binds
// every URL/body resource to it, including nested task comments and checklists.
export function bindProjectResources(
  router: Router,
  resources: Record<string, Resource>,
) {
  for (const [param, model] of Object.entries(resources)) {
    router.param(param, async (req, res, next, id: string) => {
      const projectId =
        res.locals.projectId || value(req, "projectId") || value(req, "id");
      try {
        const record = await (prisma[model] as any).findFirst({
          where: { id, projectId },
          select: { id: true },
        });
        if (!record) return denied(res);
        next();
      } catch {
        res.status(503).json({ error: "AUTHORIZATION_UNAVAILABLE" });
      }
    });
  }
}

export async function bindTaskChildren(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const projectId = res.locals.projectId;
    const taskId = value(req, "taskId");
    const checks: Promise<unknown>[] = [];
    if (value(req, "commentId"))
      checks.push(
        prisma.taskComment.findFirst({
          where: { id: value(req, "commentId"), projectId, taskId },
          select: { id: true },
        }),
      );
    if (value(req, "itemId"))
      checks.push(
        prisma.taskChecklistItem.findFirst({
          where: { id: value(req, "itemId"), projectId, taskId },
          select: { id: true },
        }),
      );
    const blockingId = value(req, "blockingTaskId") || req.body?.blockingTaskId;
    if (blockingId)
      checks.push(
        prisma.projectTask.findFirst({
          where: { id: blockingId, projectId },
          select: { id: true },
        }),
      );
    if ((await Promise.all(checks)).some((record) => !record))
      return denied(res);
    const key = req.body?.s3Key;
    if (
      key !== undefined &&
      (typeof key !== "string" ||
        !key.startsWith(`projects/${projectId}/`) ||
        key.includes(".."))
    )
      return denied(res);
    next();
  } catch {
    res.status(503).json({ error: "AUTHORIZATION_UNAVAILABLE" });
  }
}

export async function requireProjectTaskBody(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    if (typeof req.body?.taskId !== "string")
      return res.status(400).json({ error: "TASK_REQUIRED" });
    const task = await prisma.projectTask.findFirst({
      where: { id: req.body.taskId, projectId: res.locals.projectId },
      select: { id: true },
    });
    if (!task) return denied(res);
    next();
  } catch {
    res.status(503).json({ error: "AUTHORIZATION_UNAVAILABLE" });
  }
}

export async function bindKanbanResource(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const projectId = res.locals.projectId;
    const clarificationId = value(req, "clarificationId");
    const taskId = value(req, "taskId") || req.body?.taskId;
    const task = clarificationId
      ? await prisma.clarificationQA.findFirst({
          where: {
            id: clarificationId,
            task: { stage: { board: { projectId } } },
          },
          select: { id: true },
        })
      : typeof taskId === "string" &&
        (await prisma.kanbanTask.findFirst({
          where: { id: taskId, stage: { board: { projectId } } },
          select: { id: true },
        }));
    if (!task) return denied(res);
    next();
  } catch {
    res.status(503).json({ error: "AUTHORIZATION_UNAVAILABLE" });
  }
}
