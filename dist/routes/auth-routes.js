"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_controller_1 = require("../controllers/auth-controller");
const router = (0, express_1.Router)();
const authController = new auth_controller_1.AuthController();
// Signup route
router.post('/signup', authController.signup.bind(authController));
// Login route
router.post('/login', authController.login.bind(authController));
// Get profile route
router.get('/profile', authController.getProfile.bind(authController));
exports.default = router;
//# sourceMappingURL=auth-routes.js.map