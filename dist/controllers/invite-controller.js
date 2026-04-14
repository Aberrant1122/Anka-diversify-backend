"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.InviteController = void 0;
const invite_service_1 = require("../services/invite.service");
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const inviteService = new invite_service_1.InviteService();
const JWT_SECRET = process.env.JWT_SECRET || "fallback-secret";
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";
class InviteController {
    // POST /api/invites — admin creates invite
    async createInvite(req, res) {
        try {
            const { email, role, department } = req.body;
            const invitedById = req.headers["x-user-id"];
            if (!email || !role) {
                return res.status(400).json({ success: false, error: "email and role are required" });
            }
            const invite = await inviteService.createInvite({ email, role, department, invitedById });
            const inviteLink = `${FRONTEND_URL}/invite/${invite.token}`;
            res.status(201).json({
                success: true,
                data: { ...invite, inviteLink },
                message: "Invite created. Share this link with the user.",
            });
        }
        catch (error) {
            res.status(400).json({ success: false, error: error.message || "Failed to create invite" });
        }
    }
    // GET /api/invites — list all invites (admin)
    async listInvites(req, res) {
        try {
            const invitedById = req.headers["x-user-id"];
            const invites = await inviteService.listInvites(invitedById);
            res.json({ success: true, data: invites });
        }
        catch (error) {
            res.status(500).json({ success: false, error: "Failed to fetch invites" });
        }
    }
    // DELETE /api/invites/:id — revoke invite
    async revokeInvite(req, res) {
        try {
            await inviteService.revokeInvite(req.params.id);
            res.json({ success: true, message: "Invite revoked" });
        }
        catch (error) {
            res.status(500).json({ success: false, error: "Failed to revoke invite" });
        }
    }
    // GET /api/invites/validate/:token — frontend checks token before showing form
    async validateToken(req, res) {
        try {
            const invite = await inviteService.getInvite(req.params.token);
            res.json({
                success: true,
                data: {
                    email: invite.email,
                    role: invite.role,
                    department: invite.department,
                    invitedBy: invite.invitedBy.name,
                    expiresAt: invite.expiresAt,
                },
            });
        }
        catch (error) {
            res.status(400).json({ success: false, error: error.message });
        }
    }
    // POST /api/invites/accept/:token — user sets name + password
    async acceptInvite(req, res) {
        try {
            const { name, password } = req.body;
            if (!name || !password) {
                return res.status(400).json({ success: false, error: "name and password are required" });
            }
            const user = await inviteService.acceptInvite(req.params.token, { name, password });
            const token = jsonwebtoken_1.default.sign({ userId: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: "7d" });
            res.json({
                success: true,
                message: "Account created successfully",
                data: { token, user: { id: user.id, name: user.name, email: user.email, role: user.role } },
            });
        }
        catch (error) {
            res.status(400).json({ success: false, error: error.message });
        }
    }
    // GET /api/invites/users — list all users (admin)
    async listUsers(req, res) {
        try {
            const users = await inviteService.listUsers();
            res.json({ success: true, data: users });
        }
        catch (error) {
            res.status(500).json({ success: false, error: "Failed to fetch users" });
        }
    }
    // PUT /api/invites/users/:id — update user role/dept/status
    async updateUser(req, res) {
        try {
            const user = await inviteService.updateUser(req.params.id, req.body);
            res.json({ success: true, data: user });
        }
        catch (error) {
            res.status(500).json({ success: false, error: "Failed to update user" });
        }
    }
    // DELETE /api/invites/users/:id — remove user
    async removeUser(req, res) {
        try {
            await inviteService.removeUser(req.params.id);
            res.json({ success: true, message: "User removed" });
        }
        catch (error) {
            res.status(500).json({ success: false, error: "Failed to remove user" });
        }
    }
}
exports.InviteController = InviteController;
//# sourceMappingURL=invite-controller.js.map