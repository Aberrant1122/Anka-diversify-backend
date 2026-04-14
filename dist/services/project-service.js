"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProjectService = void 0;
const client_1 = require("@prisma/client");
const prisma = new client_1.PrismaClient();
const DEMO_USER_ID = "demo-user-id";
// Ensure the demo user exists (for unauthenticated/demo usage)
async function ensureUser(userId) {
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
class ProjectService {
    async getAllProjects(userId = DEMO_USER_ID) {
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
    async getProjectById(id, userId = DEMO_USER_ID) {
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
    async createProject(data, userId = DEMO_USER_ID) {
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
    async updateProject(id, data, userId = DEMO_USER_ID) {
        const project = await prisma.project.findFirst({ where: { id, userId } });
        if (!project)
            return null;
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
    async deleteProject(id, userId = DEMO_USER_ID) {
        const project = await prisma.project.findFirst({ where: { id, userId } });
        if (!project)
            return false;
        await prisma.project.delete({ where: { id } });
        return true;
    }
    async getProjectTasks(projectId, userId = DEMO_USER_ID) {
        await ensureUser(userId);
        return prisma.projectTask.findMany({
            where: { projectId },
            orderBy: { createdAt: "desc" },
        });
    }
    async createTask(data, actor) {
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
    async updateTask(taskId, data, actor) {
        const task = await prisma.projectTask.update({
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
        return task;
    }
    async deleteTask(taskId, actor) {
        const task = await prisma.projectTask.findUnique({ where: { id: taskId } });
        if (!task)
            return false;
        await prisma.projectTask.delete({ where: { id: taskId } });
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
    // ── Activities ─────────────────────────────────────────────────────────────
    async logActivity(data) {
        return prisma.projectActivity.create({ data });
    }
    async getActivities(projectId, limit = 50) {
        return prisma.projectActivity.findMany({
            where: { projectId },
            orderBy: { createdAt: "desc" },
            take: limit,
        });
    }
    // ── Comments ────────────────────────────────────────────────────────────────
    async getComments(taskId) {
        return prisma.taskComment.findMany({
            where: { taskId },
            orderBy: { createdAt: "asc" },
        });
    }
    async createComment(data) {
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
    async deleteComment(commentId) {
        const comment = await prisma.taskComment.findUnique({ where: { id: commentId } });
        if (!comment)
            return false;
        await prisma.taskComment.delete({ where: { id: commentId } });
        return true;
    }
    // ── Files ───────────────────────────────────────────────────────────────────
    async getProjectFiles(projectId) {
        return prisma.projectFile.findMany({
            where: { projectId },
            orderBy: { createdAt: "desc" },
        });
    }
    async createFile(data) {
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
    async deleteFile(fileId) {
        const file = await prisma.projectFile.findUnique({ where: { id: fileId } });
        if (!file)
            return null;
        await prisma.projectFile.delete({ where: { id: fileId } });
        return file.s3Key || null; // return key so controller can delete from S3
    }
}
exports.ProjectService = ProjectService;
//# sourceMappingURL=project-service.js.map