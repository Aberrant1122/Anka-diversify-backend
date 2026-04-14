import { Router } from "express";
import { InviteController } from "../controllers/invite-controller";

const router = Router();
const inviteController = new InviteController();

// Invite management (admin)
router.post("/", inviteController.createInvite.bind(inviteController));
router.get("/", inviteController.listInvites.bind(inviteController));
router.delete("/:id", inviteController.revokeInvite.bind(inviteController));

// Token validation + acceptance (public — no auth needed)
router.get("/validate/:token", inviteController.validateToken.bind(inviteController));
router.post("/accept/:token", inviteController.acceptInvite.bind(inviteController));

// User management (admin)
router.get("/users", inviteController.listUsers.bind(inviteController));
router.put("/users/:id", inviteController.updateUser.bind(inviteController));
router.delete("/users/:id", inviteController.removeUser.bind(inviteController));

export default router;
