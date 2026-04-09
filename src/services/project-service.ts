import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const DEMO_USER_ID = "demo-user-id";

// Ensure the demo user exists (for unauthenticated/demo usage)
async function ensureUser(userId: string): Promise<void> {
  const exists = await prisma.user.findUnique({ where: { id: userId } });
  if (!exists) {
    await prisma.user.create({
      data: {
        id: userId,
        email: `${userId}@demo.anka.io`,
        name: "Demo User",
        password: "demo",
        role: "admin",
      },
    });
  }
}

export class ProjectService {
  async getAllProjects(userId: string = DEMO_USER_ID) {
    await ensureUser(userId);
    return prisma.project.findMany({
      where: { userId },
      include: {
        tasks: true,
        memorySummary: { select: { summary: true, lastUpdated: true } },
        repoSnapshot: { select: { githubUrl: true, repoName: true, lastSyncedAt: true } },
      },
      orderBy: { createdAt: "desc" },
    });
  }

  async getProjectById(id: string, userId: string = DEMO_USER_ID) {
    await ensureUser(userId);
    return prisma.project.findFirst({
      where: { id, userId },
      include: {
        tasks: true,
        memorySummary: true,
        repoSnapshot: true,
        decisions: { orderBy: { madeAt: "desc" }, take: 10 },
        rules: { orderBy: { createdAt: "desc" } },
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
      startDate?: string;
      dueDate?: string;
      status?: string;
    },
    userId: string = DEMO_USER_ID,
  ) {
    await ensureUser(userId);
    return prisma.project.create({
      data: {
        name: data.name,
        description: data.description,
        phase: data.phase || "product-modeling",
        priority: data.priority || "medium",
        status: data.status || "active",
        githubUrl: data.githubUrl,
        startDate: data.startDate ? new Date(data.startDate) : new Date(),
        dueDate: data.dueDate ? new Date(data.dueDate) : undefined,
        userId,
      },
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
      status?: string;
      progress?: number;
      dueDate?: string;
    },
    userId: string = DEMO_USER_ID,
  ) {
    const project = await prisma.project.findFirst({ where: { id, userId } });
    if (!project) return null;

    return prisma.project.update({
      where: { id },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.description !== undefined && { description: data.description }),
        ...(data.phase !== undefined && { phase: data.phase }),
        ...(data.priority !== undefined && { priority: data.priority }),
        ...(data.githubUrl !== undefined && { githubUrl: data.githubUrl }),
        ...(data.status !== undefined && { status: data.status }),
        ...(data.progress !== undefined && { progress: data.progress }),
        ...(data.dueDate !== undefined && { dueDate: new Date(data.dueDate) }),
      },
    });
  }

  async deleteProject(id: string, userId: string = DEMO_USER_ID) {
    const project = await prisma.project.findFirst({ where: { id, userId } });
    if (!project) return false;

    await prisma.project.delete({ where: { id } });
    return true;
  }

  async getProjectTasks(projectId: string, userId: string = DEMO_USER_ID) {
    await ensureUser(userId);
    return prisma.projectTask.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" },
    });
  }

  async createTask(data: {
    project_id: string;
    title: string;
    description?: string;
    status?: string;
    priority?: string;
    phase?: string;
    due_date?: string;
  }) {
    return prisma.projectTask.create({
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
  }

  async updateTask(taskId: string, data: {
    title?: string;
    description?: string;
    status?: string;
    priority?: string;
    phase?: string;
    dueDate?: string;
  }) {
    return prisma.projectTask.update({
      where: { id: taskId },
      data: {
        ...(data.title !== undefined && { title: data.title }),
        ...(data.description !== undefined && { description: data.description }),
        ...(data.status !== undefined && { status: data.status }),
        ...(data.priority !== undefined && { priority: data.priority }),
        ...(data.phase !== undefined && { phase: data.phase }),
        ...(data.dueDate !== undefined && { dueDate: new Date(data.dueDate) }),
      },
    });
  }

  async deleteTask(taskId: string) {
    const task = await prisma.projectTask.findUnique({ where: { id: taskId } });
    if (!task) return false;
    await prisma.projectTask.delete({ where: { id: taskId } });
    return true;
  }

  async getProjectFiles(projectId: string) {
    return prisma.projectFile.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" },
    });
  }

  async createFile(data: {
    projectId: string;
    name: string;
    type?: string;
    phase?: string;
    url?: string;
    s3Key?: string;
    size?: string;
    uploadedBy?: string;
  }) {
    return prisma.projectFile.create({
      data: {
        projectId: data.projectId,
        name: data.name,
        type: data.type || "doc",
        phase: data.phase || "development",
        url: data.url,
        s3Key: data.s3Key,
        size: data.size,
        uploadedBy: data.uploadedBy,
      },
    });
  }

  async deleteFile(fileId: string) {
    const file = await prisma.projectFile.findUnique({ where: { id: fileId } });
    if (!file) return null;
    await prisma.projectFile.delete({ where: { id: fileId } });
    return file.s3Key || null; // return key so controller can delete from S3
  }
}
