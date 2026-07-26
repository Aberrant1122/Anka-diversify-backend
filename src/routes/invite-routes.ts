import { Router } from "express";
import { InviteController } from "../controllers/invite-controller";
import { authenticateToken } from "../middleware/auth";

const router = Router();
const inviteController = new InviteController();

// Invite management (admin)
router.post("/", authenticateToken, inviteController.createInvite.bind(inviteController));
router.get("/", authenticateToken, inviteController.listInvites.bind(inviteController));
router.delete("/:id", authenticateToken, inviteController.revokeInvite.bind(inviteController));

// Token validation + acceptance (public — no auth needed, used before the invitee has an account)
router.get("/validate/:token", inviteController.validateToken.bind(inviteController));
router.post("/accept/:token", inviteController.acceptInvite.bind(inviteController));

// User management (admin)
router.get("/users", authenticateToken, inviteController.listUsers.bind(inviteController));
router.put("/users/:id", authenticateToken, inviteController.updateUser.bind(inviteController));
router.delete("/users/:id", authenticateToken, inviteController.removeUser.bind(inviteController));

export default router;
