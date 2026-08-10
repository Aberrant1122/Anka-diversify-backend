import { Router } from "express";
import { InviteController } from "../controllers/invite-controller";
import { authenticateToken } from "../middleware/auth";
import { requireRole } from "../middleware/rbac";

const router = Router();
const inviteController = new InviteController();
const requireAdmin = requireRole("admin");

// Invite management (admin)
router.post("/", authenticateToken, requireAdmin, inviteController.createInvite.bind(inviteController));
router.get("/", authenticateToken, requireAdmin, inviteController.listInvites.bind(inviteController));
router.delete("/:id", authenticateToken, requireAdmin, inviteController.revokeInvite.bind(inviteController));

// Token validation + acceptance (public — no auth needed, used before the invitee has an account)
router.get("/validate/:token", inviteController.validateToken.bind(inviteController));
router.post("/accept/:token", inviteController.acceptInvite.bind(inviteController));

// User management (admin)
router.get("/users", authenticateToken, requireAdmin, inviteController.listUsers.bind(inviteController));
router.put("/users/:id", authenticateToken, requireAdmin, inviteController.updateUser.bind(inviteController));
router.delete("/users/:id", authenticateToken, requireAdmin, inviteController.removeUser.bind(inviteController));

export default router;
