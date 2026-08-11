import { PrismaClient } from "@prisma/client";
import { GeneralContext, ProjectContext } from "../shared/types";
import { ProjectGitHubService } from "../../services/github.service";

const prisma = new PrismaClient();

export class RepositoryContextBuilder {
  static async buildGeneralContext(
    userId: string,
    sessionId: string,
  ): Promise<GeneralContext> {
    const recentMessages = await prisma.aiChatMessage.findMany({
      where: {
        session: {
          userId,
          type: "general",
        },
      },
      orderBy: { createdAt: "desc" },
      take: 20,
      include: { session: true },
    });

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    const totalProjects = await prisma.project.count({
      where: { userId },
    });

    const activeProjects = await prisma.project.count({
      where: {
        userId,
        progress: { lt: 100 },
      },
    });

    return {
      recentMessages: recentMessages.reverse().map((msg: any) => ({
        id: msg.id,
        sessionId: msg.sessionId,
        role: msg.role as "user" | "assistant",
        content: msg.content,
        metadata: msg.metadata as Record<string, any> | undefined,
        createdAt: msg.createdAt,
      })),
      workspaceInfo: user
        ? {
            totalProjects,
            activeProjects,
            user: {
              id: user.id,
              name: user.name || undefined,
              email: user.email,
              createdAt: user.createdAt,
              updatedAt: user.updatedAt,
            },
          }
        : undefined,
    };
  }

  static async buildProjectContext(
    projectId: string,
  ): Promise<ProjectContext> {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
    });

    if (!project) {
      throw new Error("Project not found");
    }

    const [
      summary,
      recentMessages,
      recentDecisions,
      rules,
      activeTasks,
      repoSnapshot,
    ] = await Promise.all([
      prisma.projectMemorySummary.findUnique({
        where: { projectId },
      }),
      prisma.aiChatMessage.findMany({
        where: {
          session: {
            projectId,
            type: "project",
          },
        },
        orderBy: { createdAt: "desc" },
        take: 15,
        include: { session: true },
      }),
      prisma.projectDecision.findMany({
        where: { projectId },
        orderBy: { madeAt: "desc" },
        take: 10,
      }),
      prisma.projectRule.findMany({
        where: { projectId },
        orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
      }),
      prisma.projectTask.findMany({
        where: {
          projectId,
          status: { in: ["todo", "in_progress"] },
        },
        orderBy: [{ priority: "desc" }, { dueDate: "asc" }],
        take: 20,
      }),
      ProjectGitHubService.getSnapshot(projectId),
    ]);

    return {
      project: {
        id: project.id,
        name: project.name,
        description: project.description || undefined,
        phase: project.phase || undefined,
        progress: project.progress,
        teamSize: project.teamSize,
        priority: project.priority,
        status: project.status,
        githubUrl: project.githubUrl || undefined,
        userId: project.userId,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        start_date: project.startDate?.toISOString() || "",
        due_date: project.dueDate?.toISOString() || "",
        created_at: project.createdAt.toISOString(),
        updated_at: project.updatedAt.toISOString(),
      },
      summary: summary || undefined,
      recentMessages: recentMessages.reverse().map((msg: any) => ({
        id: msg.id,
        sessionId: msg.sessionId,
        role: msg.role as "user" | "assistant",
        content: msg.content,
        metadata: msg.metadata as Record<string, any> | undefined,
        createdAt: msg.createdAt,
      })),
      recentDecisions: recentDecisions.map((decision: any) => ({
        id: decision.id,
        projectId: decision.projectId,
        title: decision.title,
        description: decision.description,
        impact: decision.impact || undefined,
        madeAt: decision.madeAt,
        madeBy: decision.madeBy || undefined,
        options: decision.options || undefined,
        createdAt: decision.createdAt,
      })),
      rules: rules.map((rule: any) => ({
        id: rule.id,
        projectId: rule.projectId,
        title: rule.title,
        description: rule.description,
        priority: rule.priority as "low" | "medium" | "high",
        createdAt: rule.createdAt,
      })),
      activeTasks: activeTasks.map((task: any) => ({
        id: task.id,
        projectId: task.projectId,
        title: task.title,
        description: task.description || undefined,
        status: task.status as "todo" | "in_progress" | "done",
        priority: task.priority as "low" | "medium" | "high",
        dueDate: task.dueDate || undefined,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      })),
      repoSnapshot: repoSnapshot
        ? {
            ...repoSnapshot,
            keyFiles: repoSnapshot.keyFiles.map((file: any) => ({
              ...file,
              repoSnapshot: repoSnapshot,
            })),
          }
        : undefined,
    };
  }
}
