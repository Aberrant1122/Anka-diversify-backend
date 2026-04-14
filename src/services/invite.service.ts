import { randomBytes } from "crypto";
import { prisma } from "./database";
import bcrypt from "bcryptjs";

const INVITE_EXPIRY_DAYS = 7;

export class InviteService {
  async createInvite(data: {
    email: string;
    role: string;
    department?: string;
    invitedById: string;
  }) {
    // Remove existing invite for this email if any
    await prisma.userInvite.deleteMany({ where: { email: data.email } });

    // Reject if user already exists
    const existing = await prisma.user.findUnique({ where: { email: data.email } });
    if (existing) throw new Error("User with this email already exists");

    const token = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

    const invite = await prisma.userInvite.create({
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

  async getInvite(token: string) {
    const invite = await prisma.userInvite.findUnique({
      where: { token },
      include: { invitedBy: { select: { name: true, email: true } } },
    });
    if (!invite) throw new Error("Invalid invite link");
    if (invite.acceptedAt) throw new Error("Invite already used");
    if (invite.expiresAt < new Date()) throw new Error("Invite expired");
    return invite;
  }

  async acceptInvite(token: string, data: { name: string; password: string }) {
    const invite = await this.getInvite(token);

    const hashed = await bcrypt.hash(data.password, 12);
    const user = await prisma.user.create({
      data: {
        email: invite.email,
        name: data.name,
        password: hashed,
        role: invite.role,
        department: invite.department || undefined,
        status: "active",
      },
    });

    await prisma.userInvite.update({
      where: { token },
      data: { acceptedAt: new Date() },
    });

    return user;
  }

  async listInvites(invitedById: string) {
    return prisma.userInvite.findMany({
      where: { invitedById },
      include: { invitedBy: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
    });
  }

  async revokeInvite(id: string) {
    return prisma.userInvite.delete({ where: { id } });
  }

  async listUsers() {
    return prisma.user.findMany({
      select: {
        id: true, name: true, email: true, role: true,
        department: true, status: true, createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    });
  }

  async updateUser(id: string, data: { role?: string; department?: string; status?: string }) {
    return prisma.user.update({
      where: { id },
      data,
      select: {
        id: true, name: true, email: true, role: true,
        department: true, status: true, createdAt: true,
      },
    });
  }

  async removeUser(id: string) {
    return prisma.user.delete({ where: { id } });
  }
}
