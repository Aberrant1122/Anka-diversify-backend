import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { prisma } from '../services/database';


export class AdminController {
  async getDashboardStats(_req: Request, res: Response) {
    try {
      const [totalUsers, projects, recentTasks, completedTaskCount, users] = await Promise.all([
        prisma.user.count(),
        prisma.project.findMany({
          where: { status: { not: 'completed' } },
          include: {
            members: { include: { user: { select: { id: true, name: true, email: true, role: true } } } },
          },
          orderBy: { createdAt: 'desc' },
        }),
        prisma.projectTask.findMany({
          orderBy: { createdAt: 'desc' },
          take: 10,
          include: {
            project: { select: { id: true, name: true } },
          },
        }),
        prisma.projectTask.count({ where: { status: 'done' } }),
        prisma.user.findMany({
          select: { id: true, name: true, email: true, role: true, status: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
        }),
      ]);

      res.json({
        data: {
          totalUsers,
          activeProjects: projects.length,
          completedTasks: completedTaskCount,
          projects: projects.map((p) => ({
            id: p.id,
            name: p.name,
            phase: p.phase,
            status: p.status,
            progress: p.progress,
            githubUrl: p.githubUrl,
            memberCount: p.members.length,
          })),
          recentTasks: recentTasks.map((t) => ({
            id: t.id,
            title: t.title,
            status: t.status,
            priority: t.priority,
            dueDate: t.dueDate,
            projectId: t.projectId,
            projectName: t.project?.name,
          })),
          users,
        },
      });
    } catch (error) {
      console.error('Admin stats error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  async inviteUser(req: Request, res: Response) {
    try {
      const { email, name } = req.body;

      if (!email || !name) {
        return res.status(400).json({ message: 'Email and name are required' });
      }

      // Check if user already exists
      const existingUser = await prisma.user.findUnique({
        where: { email }
      });

      if (existingUser) {
        return res.status(400).json({ message: 'User with this email already exists' });
      }

      // Generate temporary password
      const tempPassword = Math.random().toString(36).slice(-8);
      const saltRounds = 12;
      const hashedPassword = await bcrypt.hash(tempPassword, saltRounds);

      // Create user with temporary password
      const user = await prisma.user.create({
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
    } catch (error) {
      console.error('Invite user error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  async resetPassword(req: Request, res: Response) {
    try {
      const { email, newPassword } = req.body;

      if (!email || !newPassword) {
        return res.status(400).json({ message: 'Email and new password are required' });
      }

      const user = await prisma.user.findUnique({
        where: { email }
      });

      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }

      const saltRounds = 12;
      const hashedPassword = await bcrypt.hash(newPassword, saltRounds);

      await prisma.user.update({
        where: { id: user.id },
        data: { password: hashedPassword }
      });

      res.json({ message: 'Password reset successfully' });
    } catch (error) {
      console.error('Reset password error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  }
}
