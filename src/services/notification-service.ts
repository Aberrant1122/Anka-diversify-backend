import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export interface CreateNotificationInput {
  userId: string;
  type: "mention" | "comment" | "assignment" | "alert" | "system";
  title: string;
  message: string;
  link?: string;
  entityId?: string;
  entityType?: string;
}

export class NotificationService {
  async getNotifications(userId: string, limit = 50) {
    return prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
  }

  async getUnreadCount(userId: string) {
    return prisma.notification.count({ where: { userId, read: false } });
  }

  async markAsRead(userId: string, notificationId: string) {
    return prisma.notification.updateMany({
      where: { id: notificationId, userId },
      data: { read: true },
    });
  }

  async markAllAsRead(userId: string) {
    return prisma.notification.updateMany({
      where: { userId, read: false },
      data: { read: true },
    });
  }

  async deleteNotification(userId: string, notificationId: string) {
    return prisma.notification.deleteMany({
      where: { id: notificationId, userId },
    });
  }

  async create(input: CreateNotificationInput) {
    return prisma.notification.create({ data: input });
  }

  // Parse @username mentions from comment content and create notifications.
  // Returns userIds that were notified.
  async handleMentions(
    content: string,
    authorId: string,
    authorName: string,
    context: { projectName: string; taskTitle: string; taskId: string; projectId: string },
  ): Promise<void> {
    const mentions = [...content.matchAll(/@(\w[\w\s]*?)(?=\s|$|[^a-zA-Z0-9\s])/g)].map(
      (m) => m[1].trim(),
    );
    if (!mentions.length) return;

    const users = await prisma.user.findMany({
      where: {
        name: { in: mentions, mode: "insensitive" },
        NOT: { id: authorId },
      },
      select: { id: true, name: true },
    });

    await Promise.all(
      users.map((user) =>
        this.create({
          userId: user.id,
          type: "mention",
          title: `${authorName} mentioned you`,
          message: `In "${context.taskTitle}" (${context.projectName}): ${content.slice(0, 100)}`,
          link: `/development/projects/${context.projectId}?task=${context.taskId}`,
          entityId: context.taskId,
          entityType: "task",
        }),
      ),
    );
  }
}

export const notificationService = new NotificationService();
