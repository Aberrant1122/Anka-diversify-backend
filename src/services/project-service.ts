import { assertOwner } from "../security/project-access";
import { PrismaClient } from "@prisma/client";
import { checkSprintAutoCloseForTask } from "./rule-engine";
import { ProjectRepositoryService } from "./project-repository-service";

const prisma = new PrismaClient();
const repoService = new ProjectRepositoryService();

async function ensureUser(userId: string): Promise<void> {
  if (!userId) throw new Error("Authenticated active user required");
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, status: true },
  });
  if (!user || user.status !== "active")
    throw new Error("Authenticated active user required");
}

async function assertProjectOwner(projectId: string, actorId: string) {
  return assertOwner(prisma, projectId, actorId);
}
export type ProjectActor = { projectId: string; userId: string };
export class ProjectService {
  async getAllProjects(userId: string) {
    if (!userId) throw new Error("Authenticated active user required");
    return prisma.project.findMany({
      where: {
        userId,
        user: { status: "active" },
        NOT: { id: { startsWith: "eval-project-" } },
      },
      include: {
        tasks: true,
        memorySummary: { select: { summary: true, lastUpdated: true } },
        repoSnapshot: {
          select: { githubUrl: true, repoName: true, lastSyncedAt: true },
        },
        members: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                role: true,
                department: true,
                status: true,
              },
            },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });
  }

  async getProjectById(id: string, userId: string) {
    if (!userId) throw new Error("Authenticated active user required");
    return prisma.project.findFirst({
      where: { id, userId, user: { status: "active" } },
      include: {
        tasks: true,
        memorySummary: true,
        repoSnapshot: true,
        decisions: { orderBy: { madeAt: "desc" }, take: 10 },
        rules: { orderBy: { createdAt: "desc" } },
        members: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                role: true,
                department: true,
                status: true,
              },
            },
          },
        },
      },
    });
  }

  async createProject(
    data: {
      name: string;
      description?: string;
      phase?: string;
      priority?: string;
      githubUrl?: string;
      githubToken?: string;
      localPath?: string;
      startDate?: string;
      dueDate?: string;
      status?: string;
    },
    userId: string,
  ) {
    await ensureUser(userId);
    const project = await prisma.project.create({
      data: {
        name: data.name,
        description: data.description,
        phase: data.phase || "development",
        priority: data.priority || "medium",
        status: data.status || "active",
        githubUrl: data.githubUrl,
        githubToken: data.githubToken, // Already encrypted by controller
        localPath: data.localPath,
        startDate: data.startDate ? new Date(data.startDate) : new Date(),
        dueDate: data.dueDate ? new Date(data.dueDate) : undefined,
        userId,
      },
    });

    if (project.githubUrl) {
      await repoService
        .ensurePrimaryRepository(project.id, userId)
        .catch((err) => {
          console.warn(
            `[ProjectService] Failed to ensure primary repository for ${project.id}:`,
            err?.message || err,
          );
        });
    }

    return project;
  }

  async updateProjectGitHubToken(
    projectId: string,
    githubToken: string,
    userId: string,
  ) {
    await assertProjectOwner(projectId, userId);

    return prisma.project.update({
      where: { id: projectId, userId },
      data: { githubToken }, // Already encrypted by controller
    });
  }

  async updateProject(
    id: string,
    data: {
      name?: string;
      description?: string;
      phase?: string;
      priority?: string;
      githubUrl?: string;
      localPath?: string;
      status?: string;
      progress?: number;
      dueDate?: string;
    },
    userId: string,
  ) {
    await assertProjectOwner(id, userId);
    const project = await prisma.project.findFirst({ where: { id, userId } });
    if (!project) return null;

    return prisma.project.update({
      where: { id },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.description !== undefined && {
          description: data.description,
        }),
        ...(data.phase !== undefined && { phase: data.phase }),
        ...(data.priority !== undefined && { priority: data.priority }),
        ...(data.githubUrl !== undefined && { githubUrl: data.githubUrl }),
        ...(data.localPath !== undefined && {
          localPath: data.localPath || null,
        }),
        ...(data.status !== undefined && { status: data.status }),
        ...(data.progress !== undefined && { progress: data.progress }),
        ...(data.dueDate !== undefined && { dueDate: new Date(data.dueDate) }),
      },
    });
  }

  async deleteProject(id: string, userId: string) {
    // Owner-only: find the project only if the requesting user is its owner
    const project = await prisma.project.findFirst({ where: { id, userId } });
    if (!project) return false;

    await prisma.project.delete({ where: { id } });
    return true;
  }

  async getProjectTasks(projectId: string, userId: string) {
    await assertProjectOwner(projectId, userId);
    const tasks = await prisma.projectTask.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" },
      include: {
        blocking: { select: { blockedTaskId: true } },
        blockedBy: { select: { blockingTaskId: true } },
        _count: { select: { comments: true } },
      },
    });
    return tasks.map((t) => ({
      ...t,
      blockingIds: t.blocking.map((d) => d.blockedTaskId),
      blockedByIds: t.blockedBy.map((d) => d.blockingTaskId),
      commentCount: t._count.comments,
      blocking: undefined,
      blockedBy: undefined,
      _count: undefined,
    }));
  }

  async createTask(
    data: {
      project_id: string;
      title: string;
      description?: string;
      status?: string;
      priority?: string;
      phase?: string;
      due_date?: string;
    },
    actor: { userId: string; userName: string },
  ) {
    await assertProjectOwner(data.project_id, actor.userId);
    const task = await prisma.projectTask.create({
      data: {
        projectId: data.project_id,
        title: data.title,
        description: data.description,
        status: data.status || "todo",
        priority: data.priority || "medium",
        phase: data.phase || "development",
        dueDate: data.due_date ? new Date(data.due_date) : undefined,
      },
    });
    if (actor) {
      await this.logActivity({
        projectId: data.project_id,
        userId: actor.userId,
        userName: actor.userName,
        action: "created_task",
        entityType: "task",
        entityId: task.id,
        entityName: task.title,
      });
    }
    return task;
  }

  async updateTask(
    taskId: string,
    data: {
      title?: string;
      description?: string;
      status?: string;
      priority?: string;
      phase?: string;
      dueDate?: string;
    },
    actor: { userId: string; userName: string; projectId: string },
  ) {
    await assertProjectOwner(actor.projectId, actor.userId);
    const task = await prisma.projectTask.update({
      where: { id: taskId, projectId: actor.projectId },
      data: {
        ...(data.title !== undefined && { title: data.title }),
        ...(data.description !== undefined && {
          description: data.description,
        }),
        ...(data.status !== undefined && { status: data.status }),
        ...(data.priority !== undefined && { priority: data.priority }),
        ...(data.phase !== undefined && { phase: data.phase }),
        ...(data.dueDate !== undefined && { dueDate: new Date(data.dueDate) }),
      },
    });
    if (actor) {
      const action = data.status ? "moved_task" : "updated_task";
      await this.logActivity({
        projectId: actor.projectId,
        userId: actor.userId,
        userName: actor.userName,
        action,
        entityType: "task",
        entityId: task.id,
        entityName: task.title,
        meta: data.status ? { to: data.status } : undefined,
      });
    }
    // Fire rule engine check when a task is marked done
    if (data.status === "done") {
      checkSprintAutoCloseForTask(task.id).catch(console.error);
    }
    return task;
  }

  async deleteTask(
    taskId: string,
    actor: { userId: string; userName: string; projectId: string },
  ) {
    await assertProjectOwner(actor.projectId, actor.userId);
    const task = await prisma.projectTask.findFirst({
      where: { id: taskId, projectId: actor.projectId },
    });
    if (!task) return false;
    await prisma.projectTask.delete({
      where: { id: taskId, projectId: actor.projectId },
    });
    if (actor) {
      await this.logActivity({
        projectId: actor.projectId,
        userId: actor.userId,
        userName: actor.userName,
        action: "deleted_task",
        entityType: "task",
        entityId: taskId,
        entityName: task.title,
      });
    }
    return true;
  }

  // ── Members ─────────────────────────────────────────────────────────────────

  async getProjectMembers(projectId: string, actorId: string) {
    await assertProjectOwner(projectId, actorId);
    const members = await prisma.projectMember.findMany({
      where: { projectId },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
            department: true,
            status: true,
          },
        },
      },
      orderBy: { joinedAt: "asc" },
    });
    return members.map((m) => ({ ...m.user, joinedAt: m.joinedAt }));
  }

  async addProjectMember(projectId: string, userId: string, actorId: string) {
    await assertProjectOwner(projectId, actorId);
    await ensureUser(userId);
    return prisma.projectMember.create({
      data: { projectId, userId },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
            department: true,
            status: true,
          },
        },
      },
    });
  }

  async removeProjectMember(
    projectId: string,
    userId: string,
    actorId: string,
  ) {
    await assertProjectOwner(projectId, actorId);
    const member = await prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId } },
    });
    if (!member) return false;
    await prisma.projectMember.delete({
      where: { projectId_userId: { projectId, userId } },
    });
    return true;
  }

  // ── Chat ────────────────────────────────────────────────────────────────────

  async getChatMessages(projectId: string, actorId: string, limit = 100) {
    await assertProjectOwner(projectId, actorId);
    return prisma.projectChatMessage.findMany({
      where: { projectId },
      orderBy: { createdAt: "asc" },
      take: limit,
    });
  }

  async sendChatMessage(data: {
    projectId: string;
    userId: string;
    userName: string;
    content: string;
  }) {
    await assertProjectOwner(data.projectId, data.userId);
    return prisma.projectChatMessage.create({ data });
  }

  // ── Activities ─────────────────────────────────────────────────────────────

  async logActivity(data: {
    projectId: string;
    userId: string;
    userName: string;
    action: string;
    entityType: string;
    entityId?: string;
    entityName?: string;
    meta?: Record<string, any>;
  }) {
    await assertProjectOwner(data.projectId, data.userId);
    return prisma.projectActivity.create({ data });
  }

  async getActivities(projectId: string, actorId: string, limit = 50) {
    await assertProjectOwner(projectId, actorId);
    return prisma.projectActivity.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
  }

  // ── Comments ────────────────────────────────────────────────────────────────

  async getComments(taskId: string, actor: ProjectActor) {
    await assertProjectOwner(actor.projectId, actor.userId);
    return prisma.taskComment.findMany({
      where: { taskId, projectId: actor.projectId },
      orderBy: { createdAt: "asc" },
    });
  }

  async createComment(data: {
    taskId: string;
    projectId: string;
    userId: string;
    userName: string;
    content: string;
  }) {
    await assertProjectOwner(data.projectId, data.userId);
    if (
      !(await prisma.projectTask.findFirst({
        where: { id: data.taskId, projectId: data.projectId },
        select: { id: true },
      }))
    )
      throw new Error("Task not found or inaccessible");
    const comment = await prisma.taskComment.create({ data });
    await this.logActivity({
      projectId: data.projectId,
      userId: data.userId,
      userName: data.userName,
      action: "added_comment",
      entityType: "comment",
      entityId: comment.id,
    });
    return comment;
  }

  async deleteComment(
    commentId: string,
    actor: ProjectActor & { taskId: string },
  ) {
    await assertProjectOwner(actor.projectId, actor.userId);
    const comment = await prisma.taskComment.findFirst({
      where: {
        id: commentId,
        projectId: actor.projectId,
        taskId: actor.taskId,
      },
    });
    if (!comment) return false;
    await prisma.taskComment.delete({
      where: {
        id: commentId,
        projectId: actor.projectId,
        taskId: actor.taskId,
      },
    });
    return true;
  }

  // ── Files ───────────────────────────────────────────────────────────────────

  async getProjectFiles(projectId: string, actorId: string) {
    await assertProjectOwner(projectId, actorId);
    return prisma.projectFile.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" },
    });
  }

  async createFile(
    data: {
      projectId: string;
      name: string;
      type?: string;
      phase?: string;
      url?: string;
      s3Key?: string;
      size?: string;
      uploadedBy?: string;
    },
    actorId: string,
  ) {
    await assertProjectOwner(data.projectId, actorId);
    if (
      data.s3Key &&
      (!data.s3Key.startsWith(`projects/${data.projectId}/`) ||
        data.s3Key.includes(".."))
    )
      throw new Error("File key outside project");
    return prisma.projectFile.create({
      data: {
        projectId: data.projectId,
        name: data.name,
        type: data.type || "doc",
        phase: data.phase || "development",
        url: data.url,
        s3Key: data.s3Key,
        size: data.size,
        uploadedBy: actorId,
      },
    });
  }

  async deleteFile(fileId: string, actor: ProjectActor) {
    await assertProjectOwner(actor.projectId, actor.userId);
    const file = await prisma.projectFile.findFirst({
      where: { id: fileId, projectId: actor.projectId },
    });
    if (!file) return undefined;
    await prisma.projectFile.delete({
      where: { id: fileId, projectId: actor.projectId },
    });
    return file.s3Key || null; // return key so controller can delete from S3
  }

  // ── Project Rules ──────────────────────────────────────────────────────────

  async createProjectRule(
    data: {
      projectId: string;
      title: string;
      description: string;
      priority?: string;
    },
    actorId: string,
  ) {
    await assertProjectOwner(data.projectId, actorId);
    return prisma.projectRule.create({ data });
  }

  async updateProjectRule(
    ruleId: string,
    data: {
      title?: string;
      description?: string;
      priority?: string;
    },
    actor: ProjectActor,
  ) {
    await assertProjectOwner(actor.projectId, actor.userId);
    const rule = await prisma.projectRule.findFirst({
      where: { id: ruleId, projectId: actor.projectId },
    });
    if (!rule) return null;
    return prisma.projectRule.update({
      where: { id: ruleId, projectId: actor.projectId },
      data: {
        ...(data.title !== undefined && { title: data.title }),
        ...(data.description !== undefined && {
          description: data.description,
        }),
        ...(data.priority !== undefined && { priority: data.priority }),
      },
    });
  }

  async deleteProjectRule(ruleId: string, actor: ProjectActor) {
    await assertProjectOwner(actor.projectId, actor.userId);
    const rule = await prisma.projectRule.findFirst({
      where: { id: ruleId, projectId: actor.projectId },
    });
    if (!rule) return false;
    await prisma.projectRule.delete({
      where: { id: ruleId, projectId: actor.projectId },
    });
    return true;
  }

  // ── Project Decisions ──────────────────────────────────────────────────────

  async createProjectDecision(
    data: {
      projectId: string;
      title: string;
      description: string;
      impact?: string;
      madeBy?: string;
      artifactId?: string;
    },
    actorId: string,
  ) {
    await assertProjectOwner(data.projectId, actorId);
    if (
      data.artifactId &&
      !(await prisma.phaseArtifact.findFirst({
        where: { id: data.artifactId, projectId: data.projectId },
        select: { id: true },
      }))
    )
      throw new Error("Artifact outside project");
    return prisma.projectDecision.create({
      data: { ...data, madeBy: actorId },
    });
  }

  async updateProjectDecision(
    decisionId: string,
    data: {
      title?: string;
      description?: string;
      impact?: string;
    },
    actor: ProjectActor,
  ) {
    await assertProjectOwner(actor.projectId, actor.userId);
    const decision = await prisma.projectDecision.findFirst({
      where: { id: decisionId, projectId: actor.projectId },
    });
    if (!decision) return null;
    return prisma.projectDecision.update({
      where: { id: decisionId, projectId: actor.projectId },
      data: {
        ...(data.title !== undefined && { title: data.title }),
        ...(data.description !== undefined && {
          description: data.description,
        }),
        ...(data.impact !== undefined && { impact: data.impact }),
      },
    });
  }

  async deleteProjectDecision(decisionId: string, actor: ProjectActor) {
    await assertProjectOwner(actor.projectId, actor.userId);
    const decision = await prisma.projectDecision.findFirst({
      where: { id: decisionId, projectId: actor.projectId },
    });
    if (!decision) return false;
    await prisma.projectDecision.delete({
      where: { id: decisionId, projectId: actor.projectId },
    });
    return true;
  }

  // ── Memory Summary ─────────────────────────────────────────────────────────

  async saveMemorySummary(projectId: string, summary: string, actorId: string) {
    await assertProjectOwner(projectId, actorId);
    const existing = await prisma.projectMemorySummary.findUnique({
      where: { projectId },
    });
    if (existing) {
      return prisma.projectMemorySummary.update({
        where: { projectId },
        data: {
          summary,
          version: existing.version + 1,
          lastUpdated: new Date(),
        },
      });
    }
    return prisma.projectMemorySummary.create({
      data: { projectId, summary, version: 1 },
    });
  }

  // ── Task Stats ─────────────────────────────────────────────────────────────

  async getTaskStats(projectId: string, actorId: string) {
    await assertProjectOwner(projectId, actorId);
    const tasks = await prisma.projectTask.findMany({
      where: { projectId },
      select: { status: true, priority: true, dueDate: true },
    });

    const now = new Date();
    const totalTasks = tasks.length;
    let completedTasks = 0;
    let inProgressTasks = 0;
    let todoTasks = 0;
    let reviewTasks = 0;
    let overdueTasks = 0;
    const priorityCounts: Record<string, number> = {};
    const statusCounts: Record<string, number> = {};

    for (const t of tasks) {
      statusCounts[t.status] = (statusCounts[t.status] || 0) + 1;
      priorityCounts[t.priority] = (priorityCounts[t.priority] || 0) + 1;

      if (t.status === "done") completedTasks++;
      else if (t.status === "in_progress" || t.status === "in-progress")
        inProgressTasks++;
      else if (t.status === "todo") todoTasks++;
      else if (t.status === "review") reviewTasks++;

      if (t.dueDate && t.status !== "done" && new Date(t.dueDate) < now) {
        overdueTasks++;
      }
    }

    return {
      totalTasks,
      completedTasks,
      inProgressTasks,
      todoTasks,
      reviewTasks,
      overdueTasks,
      completionRate:
        totalTasks > 0
          ? parseFloat(((completedTasks / totalTasks) * 100).toFixed(1))
          : 0,
      priorityCounts,
      statusCounts,
    };
  }
}
