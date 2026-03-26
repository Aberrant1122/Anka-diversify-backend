"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const admin_controller_1 = require("../controllers/admin-controller");
const router = (0, express_1.Router)();
const adminController = new admin_controller_1.AdminController();
// Invite user route
router.post('/invite-user', adminController.inviteUser.bind(adminController));
// Reset password route
router.post('/reset-password', adminController.resetPassword.bind(adminController));
exports.default = router;
//# sourceMappingURL=admin-routes.js.map