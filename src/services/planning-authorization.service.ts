import { Prisma, PrismaClient } from "@prisma/client";
import { PlanningDomainError, isPlanningDomainError } from "../planning/planning-errors";

type PlanningProjectAccess = {
  id: string;
  userId: string;
  isMember: boolean;
  isSystemAdmin: boolean;
};

export type PlanningProjectCandidate = {
  id: string;
  name: string;
  description?: string | null;
  phase?: string | null;
};

export type PlanningProjectResolution =
  | { status: "RESOLVED"; project: { id: string; name: string } }
  | { status: "NOT_FOUND" }
  | { status: "AMBIGUOUS"; candidates: Array<{ id: string; name: string }> };

export class PlanningAuthorizationService {
  constructor(private readonly prisma: PrismaClient) {}

  private async resolve(
    projectId: string,
    userId: string,
    client: Pick<Prisma.TransactionClient, "project" | "user" | "projectMember"> = this.prisma,
  ): Promise<PlanningProjectAccess> {
    const [project, user, membership] = await Promise.all([
      client.project.findUnique({ where: { id: projectId }, select: { id: true, userId: true } }),
      client.user?.findUnique
        ? client.user.findUnique({ where: { id: userId }, select: { role: true } })
        : Promise.resolve(null),
      client.projectMember?.findUnique
        ? client.projectMember.findUnique({
            where: { projectId_userId: { projectId, userId } },
            select: { id: true },
          })
        : Promise.resolve(null),
    ]);

    if (!project) {
      throw new PlanningDomainError(
        "PLANNING_PROJECT_NOT_FOUND",
        "Project was not found or is not accessible.",
        404,
      );
    }

    return {
      id: project.id,
      userId: project.userId,
      isMember: Boolean(membership),
      isSystemAdmin: user?.role === "admin",
    };
  }

  async assertCanRead(projectId: string, userId: string): Promise<PlanningProjectAccess> {
    const access = await this.resolve(projectId, userId);
    if (access.userId !== userId && !access.isMember && !access.isSystemAdmin) {
      throw new PlanningDomainError(
        "PLANNING_PROJECT_NOT_FOUND",
        "Project was not found or is not accessible.",
        404,
      );
    }
    return access;
  }

  async assertCanEdit(projectId: string, userId: string): Promise<PlanningProjectAccess> {
    const access = await this.resolve(projectId, userId);
    return this.assertEditAccess(access, userId);
  }

  async assertCanEditInTransaction(
    tx: Prisma.TransactionClient,
    projectId: string,
    userId: string,
  ): Promise<PlanningProjectAccess> {
    const access = await this.resolve(projectId, userId, tx);
    return this.assertEditAccess(access, userId);
  }

  private assertEditAccess(access: PlanningProjectAccess, userId: string): PlanningProjectAccess {
    if (access.userId !== userId && !access.isMember) {
      throw new PlanningDomainError(
        "PLANNING_PROJECT_NOT_FOUND",
        "Project was not found or is not accessible.",
        404,
      );
    }
    return access;
  }

  async assertOwner(projectId: string, userId: string): Promise<PlanningProjectAccess> {
    const access = await this.resolve(projectId, userId);
    return this.assertOwnerAccess(access, userId);
  }

  async assertOwnerInTransaction(
    tx: Prisma.TransactionClient,
    projectId: string,
    userId: string,
  ): Promise<PlanningProjectAccess> {
    const access = await this.resolve(projectId, userId, tx);
    return this.assertOwnerAccess(access, userId);
  }

  private assertOwnerAccess(access: PlanningProjectAccess, userId: string): PlanningProjectAccess {
    if (access.userId === userId) return access;

    if (access.isMember || access.isSystemAdmin) {
      throw new PlanningDomainError(
        "PLANNING_OWNER_REQUIRED",
        "Only the project owner may make Requirements approval decisions.",
        403,
      );
    }

    throw new PlanningDomainError(
      "PLANNING_PROJECT_NOT_FOUND",
      "Project was not found or is not accessible.",
      404,
    );
  }

  async listVisibleProjects(
    userId: string,
    options?: { take?: number },
  ): Promise<PlanningProjectCandidate[]> {
    const user = await this.prisma.user?.findUnique?.({
      where: { id: userId },
      select: { role: true },
    });
    const isSystemAdmin = user?.role === "admin";

    return this.prisma.project.findMany({
      where: isSystemAdmin
        ? {}
        : {
            OR: [
              { userId },
              { members: { some: { userId } } },
            ],
          },
      select: { id: true, name: true, description: true, phase: true },
      orderBy: { createdAt: "desc" },
      take: options?.take ?? 20,
    });
  }

  async resolveProjectForActor(
    userId: string,
    target: { projectId?: string; projectName?: string },
  ): Promise<PlanningProjectResolution> {
    const explicitId = typeof target.projectId === "string" ? target.projectId.trim() : "";
    const explicitName = typeof target.projectName === "string" ? target.projectName.trim() : "";

    if (explicitId) {
      if (explicitId !== target.projectId || /[\u0000-\u001f\u007f]/.test(explicitId)) {
        return { status: "NOT_FOUND" };
      }

      try {
        await this.assertCanRead(explicitId, userId);
      } catch (error) {
        if (isPlanningDomainError(error) && error.code === "PLANNING_PROJECT_NOT_FOUND") {
          return { status: "NOT_FOUND" };
        }
        throw error;
      }

      const project = await this.prisma.project.findUnique({
        where: { id: explicitId },
        select: { id: true, name: true },
      });
      if (!project) {
        return { status: "NOT_FOUND" };
      }
      return { status: "RESOLVED", project: { id: project.id, name: project.name } };
    }

    if (explicitName) {
      const user = await this.prisma.user?.findUnique?.({
        where: { id: userId },
        select: { role: true },
      });
      const isSystemAdmin = user?.role === "admin";

      const candidates = await this.prisma.project.findMany({
        where: {
          ...(isSystemAdmin
            ? {}
            : {
                OR: [
                  { userId },
                  { members: { some: { userId } } },
                ],
              }),
          name: { contains: explicitName, mode: "insensitive" },
        },
        select: { id: true, name: true },
      });

      if (!candidates || candidates.length === 0) {
        return { status: "NOT_FOUND" };
      }

      const normalizedSearch = explicitName.toLowerCase();
      const exactMatches = candidates.filter(
        (c) => c.name.trim().toLowerCase() === normalizedSearch,
      );

      if (exactMatches.length === 1) {
        return { status: "RESOLVED", project: { id: exactMatches[0].id, name: exactMatches[0].name } };
      }

      if (exactMatches.length > 1) {
        return {
          status: "AMBIGUOUS",
          candidates: exactMatches.map((c) => ({ id: c.id, name: c.name })),
        };
      }

      if (candidates.length === 1) {
        return { status: "RESOLVED", project: { id: candidates[0].id, name: candidates[0].name } };
      }

      return {
        status: "AMBIGUOUS",
        candidates: candidates.map((c) => ({ id: c.id, name: c.name })),
      };
    }

    return { status: "NOT_FOUND" };
  }
}
