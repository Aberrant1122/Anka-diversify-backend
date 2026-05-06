import { Router } from "express";
import { NotificationController } from "../controllers/notification-controller";

const router = Router();
const ctrl = new NotificationController();

router.get("/", ctrl.getNotifications.bind(ctrl));
router.get("/unread-count", ctrl.getUnreadCount.bind(ctrl));
router.put("/read-all", ctrl.markAllAsRead.bind(ctrl));
router.put("/:id/read", ctrl.markAsRead.bind(ctrl));
router.delete("/:id", ctrl.deleteNotification.bind(ctrl));

export default router;
