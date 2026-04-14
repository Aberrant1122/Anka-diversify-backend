"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const invite_controller_1 = require("../controllers/invite-controller");
const router = (0, express_1.Router)();
const inviteController = new invite_controller_1.InviteController();
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
exports.default = router;
//# sourceMappingURL=invite-routes.js.map