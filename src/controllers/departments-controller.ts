import { Request, Response } from 'express';
import { prisma } from '../services/database';

function param(req: Request, key: string): string {
  return req.params[key] as string;
}

export class DepartmentsController {
  // GET /api/admin/departments
  async list(_req: Request, res: Response) {
    try {
      const departments = await prisma.department.findMany({
        include: { head: { select: { id: true, name: true, email: true, role: true } } },
        orderBy: { createdAt: 'asc' },
      });

      // For each dept, fetch members (users whose .department matches dept name)
      // and projects (via ProjectMember on those users)
      const result = await Promise.all(
        departments.map(async (dept) => {
          const members = await prisma.user.findMany({
            where: { department: { equals: dept.name, mode: 'insensitive' } },
            select: { id: true, name: true, email: true, role: true, status: true },
          });

          const memberIds = members.map((m) => m.id);
          const projectLinks = memberIds.length
            ? await prisma.projectMember.findMany({
                where: { userId: { in: memberIds } },
                select: { projectId: true },
                distinct: ['projectId'],
              })
            : [];

          const projectIds = projectLinks.map((p) => p.projectId);
          const projects = projectIds.length
            ? await prisma.project.findMany({
                where: { id: { in: projectIds }, status: { not: 'completed' } },
                select: { id: true, name: true, phase: true, progress: true, status: true },
              })
            : [];

          return { ...dept, members, projects };
        })
      );

      res.json({ data: result });
    } catch (error) {
      console.error('List departments error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  // POST /api/admin/departments
  async create(req: Request, res: Response) {
    try {
      const { name, description, headUserId } = req.body;
      if (!name) return res.status(400).json({ message: 'name is required' });

      const dept = await prisma.department.create({
        data: {
          name: String(name),
          description: String(description || ''),
          headUserId: headUserId || null,
        },
        include: { head: { select: { id: true, name: true, email: true, role: true } } },
      });

      res.status(201).json({ data: { ...dept, members: [], projects: [] } });
    } catch (error: any) {
      if (error.code === 'P2002') {
        return res.status(400).json({ message: 'A department with this name already exists' });
      }
      console.error('Create department error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  // PATCH /api/admin/departments/:id
  async update(req: Request, res: Response) {
    try {
      const id = param(req, 'id');
      const body = req.body as Record<string, unknown>;
      const dept = await prisma.department.update({
        where: { id },
        data: {
          ...(body.name !== undefined && { name: String(body.name) }),
          ...(body.description !== undefined && { description: String(body.description) }),
          ...(body.headUserId !== undefined && { headUserId: body.headUserId ? String(body.headUserId) : null }),
        },
        include: { head: { select: { id: true, name: true, email: true, role: true } } },
      });
      res.json({ data: dept });
    } catch (error) {
      console.error('Update department error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  // DELETE /api/admin/departments/:id
  async remove(req: Request, res: Response) {
    try {
      const id = param(req, 'id');
      // Unassign all users from this department before deleting
      const dept = await prisma.department.findUnique({ where: { id } });
      if (dept) {
        await prisma.user.updateMany({
          where: { department: { equals: dept.name, mode: 'insensitive' } },
          data: { department: null },
        });
      }
      await prisma.department.delete({ where: { id } });
      res.json({ message: 'Department deleted' });
    } catch (error) {
      console.error('Delete department error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  // POST /api/admin/departments/:id/members  — assign a user to this dept
  async addMember(req: Request, res: Response) {
    try {
      const id = param(req, 'id');
      const { userId } = req.body;
      if (!userId) return res.status(400).json({ message: 'userId is required' });

      const dept = await prisma.department.findUniqueOrThrow({ where: { id } });
      await prisma.user.update({
        where: { id: String(userId) },
        data: { department: dept.name },
      });
      res.json({ message: 'Member added' });
    } catch (error) {
      console.error('Add member error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  // DELETE /api/admin/departments/:id/members/:userId — remove user from dept
  async removeMember(req: Request, res: Response) {
    try {
      const userId = param(req, 'userId');
      await prisma.user.update({
        where: { id: userId },
        data: { department: null },
      });
      res.json({ message: 'Member removed' });
    } catch (error) {
      console.error('Remove member error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  }
}
