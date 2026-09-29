import { Prisma, PrismaClient } from "@prisma/client";
import { PlanningDomainError } from "../planning/planning-errors";

type PlanningProjectAccess = {
  id: string;
  userId: string;
  isMember: boolean;
  isSystemAdmin: boolean;
};

export class PlanningAuthorizationService {
  constructor(private readonly prisma: PrismaClient) {}

  private async resolve(
    projectId: string,
    userId: string,
    client: Pick<Prisma.TransactionClient, "project" | "user" | "projectMember"> = this.prisma,
  ): Promise<PlanningProjectAccess> {
    const [project, user, membership] = await Promise.all([
      client.project.findUnique({ where: { id: projectId }, select: { id: true, userId: true } }),
      client.user.findUnique({ where: { id: userId }, select: { role: true } }),
      client.projectMember.findUnique({
        where: { projectId_userId: { projectId, userId } },
        select: { id: true },
      }),
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
}
