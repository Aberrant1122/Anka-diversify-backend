import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export class ProjectMemory {
  static async getSummary(projectId: string) {
    return prisma.projectMemorySummary.findUnique({ where: { projectId } });
  }

  static async getDecisions(projectId: string, take: number = 10) {
    return prisma.projectDecision.findMany({
      where: { projectId },
      orderBy: { madeAt: "desc" },
      take,
    });
  }

  static async getRules(projectId: string) {
    return prisma.projectRule.findMany({
      where: { projectId },
      orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
    });
  }
}
