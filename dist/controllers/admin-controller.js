"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AdminController = void 0;
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const database_1 = require("../services/database");
class AdminController {
    async inviteUser(req, res) {
        try {
            const { email, name } = req.body;
            if (!email || !name) {
                return res.status(400).json({ message: 'Email and name are required' });
            }
            // Check if user already exists
            const existingUser = await database_1.prisma.user.findUnique({
                where: { email }
            });
            if (existingUser) {
                return res.status(400).json({ message: 'User with this email already exists' });
            }
            // Generate temporary password
            const tempPassword = Math.random().toString(36).slice(-8);
            const saltRounds = 12;
            const hashedPassword = await bcryptjs_1.default.hash(tempPassword, saltRounds);
            // Create user with temporary password
            const user = await database_1.prisma.user.create({
                data: {
                    name,
                    email,
                    password: hashedPassword,
                }
            });
            res.status(201).json({
                message: 'User invited successfully',
                user: {
                    id: user.id,
                    name: user.name,
                    email: user.email,
                    tempPassword, // Only send to admin
                    createdAt: user.createdAt
                }
            });
        }
        catch (error) {
            console.error('Invite user error:', error);
            res.status(500).json({ message: 'Internal server error' });
        }
    }
    async resetPassword(req, res) {
        try {
            const { email, newPassword } = req.body;
            if (!email || !newPassword) {
                return res.status(400).json({ message: 'Email and new password are required' });
            }
            const user = await database_1.prisma.user.findUnique({
                where: { email }
            });
            if (!user) {
                return res.status(404).json({ message: 'User not found' });
            }
            const saltRounds = 12;
            const hashedPassword = await bcryptjs_1.default.hash(newPassword, saltRounds);
            await database_1.prisma.user.update({
                where: { id: user.id },
                data: { password: hashedPassword }
            });
            res.json({ message: 'Password reset successfully' });
        }
        catch (error) {
            console.error('Reset password error:', error);
            res.status(500).json({ message: 'Internal server error' });
        }
    }
}
exports.AdminController = AdminController;
//# sourceMappingURL=admin-controller.js.map