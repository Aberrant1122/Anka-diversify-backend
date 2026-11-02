import { PrismaClient } from "@prisma/client";
export interface ProjectActor {
  projectId: string;
  userId: string;
}
export async function assertOwner(
  database: Pick<PrismaClient, "project">,
  projectId: string,
  actorId: string,
): Promise<void> {
  if (
    !actorId ||
    !projectId ||
    !(await database.project.findFirst({
      where: { id: projectId, userId: actorId, user: { status: "active" } },
      select: { id: true },
    }))
  )
    throw new Error("Project not found or inaccessible");
}
