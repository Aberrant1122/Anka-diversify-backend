import { Request, Response } from "express";
import { notificationService } from "../services/notification-service";

function uid(req: Request): string | null {
  const v = req.headers["x-user-id"];
  return v ? (Array.isArray(v) ? v[0] : v) : null;
}

export class NotificationController {
  async getNotifications(req: Request, res: Response) {
    const userId = uid(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const notifications = await notificationService.getNotifications(userId);
    res.json({ success: true, data: notifications });
  }

  async getUnreadCount(req: Request, res: Response) {
    const userId = uid(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const count = await notificationService.getUnreadCount(userId);
    res.json({ count });
  }

  async markAsRead(req: Request, res: Response) {
    const userId = uid(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    await notificationService.markAsRead(userId, id);
    res.json({ success: true });
  }

  async markAllAsRead(req: Request, res: Response) {
    const userId = uid(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    await notificationService.markAllAsRead(userId);
    res.json({ success: true });
  }

  async deleteNotification(req: Request, res: Response) {
    const userId = uid(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    await notificationService.deleteNotification(userId, id);
    res.json({ success: true });
  }
}
