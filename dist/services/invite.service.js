"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.InviteService = void 0;
const crypto_1 = require("crypto");
const database_1 = require("./database");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const INVITE_EXPIRY_DAYS = 7;
class InviteService {
    async createInvite(data) {
        // Remove existing invite for this email if any
        await database_1.prisma.userInvite.deleteMany({ where: { email: data.email } });
        // Reject if user already exists
        const existing = await database_1.prisma.user.findUnique({ where: { email: data.email } });
        if (existing)
            throw new Error("User with this email already exists");
        const token = (0, crypto_1.randomBytes)(32).toString("hex");
        const expiresAt = new Date(Date.now() + INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
        const invite = await database_1.prisma.userInvite.create({
            data: {
                email: data.email,
                role: data.role,
                department: data.department,
                token,
                invitedById: data.invitedById,
                expiresAt,
            },
            include: { invitedBy: { select: { name: true, email: true } } },
        });
        return invite;
    }
    async getInvite(token) {
        const invite = await database_1.prisma.userInvite.findUnique({
            where: { token },
            include: { invitedBy: { select: { name: true, email: true } } },
        });
        if (!invite)
            throw new Error("Invalid invite link");
        if (invite.acceptedAt)
            throw new Error("Invite already used");
        if (invite.expiresAt < new Date())
            throw new Error("Invite expired");
        return invite;
    }
    async acceptInvite(token, data) {
        const invite = await this.getInvite(token);
        const hashed = await bcryptjs_1.default.hash(data.password, 12);
        const user = await database_1.prisma.user.create({
            data: {
                email: invite.email,
                name: data.name,
                password: hashed,
                role: invite.role,
                department: invite.department || undefined,
                status: "active",
            },
        });
        await database_1.prisma.userInvite.update({
            where: { token },
            data: { acceptedAt: new Date() },
        });
        return user;
    }
    async listInvites(invitedById) {
        return database_1.prisma.userInvite.findMany({
            where: { invitedById },
            include: { invitedBy: { select: { name: true } } },
            orderBy: { createdAt: "desc" },
        });
    }
    async revokeInvite(id) {
        return database_1.prisma.userInvite.delete({ where: { id } });
    }
    async listUsers() {
        return database_1.prisma.user.findMany({
            select: {
                id: true, name: true, email: true, role: true,
                department: true, status: true, createdAt: true,
            },
            orderBy: { createdAt: "desc" },
        });
    }
    async updateUser(id, data) {
        return database_1.prisma.user.update({
            where: { id },
            data,
            select: {
                id: true, name: true, email: true, role: true,
                department: true, status: true, createdAt: true,
            },
        });
    }
    async removeUser(id) {
        return database_1.prisma.user.delete({ where: { id } });
    }
}
exports.InviteService = InviteService;
//# sourceMappingURL=invite.service.js.map