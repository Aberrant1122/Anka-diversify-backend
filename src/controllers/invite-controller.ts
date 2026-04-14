import { Request, Response } from "express";
import { InviteService } from "../services/invite.service";
import jwt from "jsonwebtoken";

const inviteService = new InviteService();
const JWT_SECRET = process.env.JWT_SECRET || "fallback-secret";
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";

export class InviteController {
  // POST /api/invites — admin creates invite
  async createInvite(req: Request, res: Response) {
    try {
      const { email, role, department } = req.body;
      const invitedById = req.headers["x-user-id"] as string;

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
    } catch (error: any) {
      res.status(400).json({ success: false, error: error.message || "Failed to create invite" });
    }
  }

  // GET /api/invites — list all invites (admin)
  async listInvites(req: Request, res: Response) {
    try {
      const invitedById = req.headers["x-user-id"] as string;
      const invites = await inviteService.listInvites(invitedById);
      res.json({ success: true, data: invites });
    } catch (error) {
      res.status(500).json({ success: false, error: "Failed to fetch invites" });
    }
  }

  // DELETE /api/invites/:id — revoke invite
  async revokeInvite(req: Request, res: Response) {
    try {
      await inviteService.revokeInvite(req.params.id as string);
      res.json({ success: true, message: "Invite revoked" });
    } catch (error) {
      res.status(500).json({ success: false, error: "Failed to revoke invite" });
    }
  }

  // GET /api/invites/validate/:token — frontend checks token before showing form
  async validateToken(req: Request, res: Response) {
    try {
      const invite = await inviteService.getInvite(req.params.token as string);
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
    } catch (error: any) {
      res.status(400).json({ success: false, error: error.message });
    }
  }

  // POST /api/invites/accept/:token — user sets name + password
  async acceptInvite(req: Request, res: Response) {
    try {
      const { name, password } = req.body;
      if (!name || !password) {
        return res.status(400).json({ success: false, error: "name and password are required" });
      }

      const user = await inviteService.acceptInvite(req.params.token as string, { name, password });

      const token = jwt.sign(
        { userId: user.id, email: user.email, role: user.role },
        JWT_SECRET,
        { expiresIn: "7d" } as any,
      );

      res.json({
        success: true,
        message: "Account created successfully",
        data: { token, user: { id: user.id, name: user.name, email: user.email, role: user.role } },
      });
    } catch (error: any) {
      res.status(400).json({ success: false, error: error.message });
    }
  }

  // GET /api/invites/users — list all users (admin)
  async listUsers(req: Request, res: Response) {
    try {
      const users = await inviteService.listUsers();
      res.json({ success: true, data: users });
    } catch (error) {
      res.status(500).json({ success: false, error: "Failed to fetch users" });
    }
  }

  // PUT /api/invites/users/:id — update user role/dept/status
  async updateUser(req: Request, res: Response) {
    try {
      const user = await inviteService.updateUser(req.params.id as string, req.body);
      res.json({ success: true, data: user });
    } catch (error) {
      res.status(500).json({ success: false, error: "Failed to update user" });
    }
  }

  // DELETE /api/invites/users/:id — remove user
  async removeUser(req: Request, res: Response) {
    try {
      await inviteService.removeUser(req.params.id as string);
      res.json({ success: true, message: "User removed" });
    } catch (error) {
      res.status(500).json({ success: false, error: "Failed to remove user" });
    }
  }
}
