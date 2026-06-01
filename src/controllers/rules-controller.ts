import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../services/database';

function param(req: Request, key: string): string {
  return req.params[key] as string;
}

function headerStr(req: Request, fallback: string): string {
  const val = req.headers['x-user-name'];
  return (Array.isArray(val) ? val[0] : val) || fallback;
}

export class RulesController {
  async list(_req: Request, res: Response) {
    try {
      const rules = await prisma.orgRule.findMany({ orderBy: { createdAt: 'desc' } });
      res.json({ data: rules });
    } catch (error) {
      console.error('List rules error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  async create(req: Request, res: Response) {
    try {
      const { name, description, category, conditions, actions } = req.body;
      if (!name || !category) {
        return res.status(400).json({ message: 'name and category are required' });
      }
      const rule = await prisma.orgRule.create({
        data: {
          name: String(name),
          description: String(description || ''),
          category: String(category),
          conditions: (conditions ?? []) as Prisma.InputJsonValue,
          actions: (actions ?? []) as Prisma.InputJsonValue,
          createdBy: headerStr(req, 'Admin'),
        },
      });
      res.status(201).json({ data: rule });
    } catch (error) {
      console.error('Create rule error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  async update(req: Request, res: Response) {
    try {
      const id = param(req, 'id');
      const body = req.body as Record<string, unknown>;
      const data: Prisma.OrgRuleUpdateInput = {};
      if (body.name !== undefined) data.name = String(body.name);
      if (body.description !== undefined) data.description = String(body.description);
      if (body.category !== undefined) data.category = String(body.category);
      if (body.enabled !== undefined) data.enabled = Boolean(body.enabled);
      if (body.conditions !== undefined) data.conditions = body.conditions as Prisma.InputJsonValue;
      if (body.actions !== undefined) data.actions = body.actions as Prisma.InputJsonValue;
      const rule = await prisma.orgRule.update({ where: { id }, data });
      res.json({ data: rule });
    } catch (error) {
      console.error('Update rule error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  async remove(req: Request, res: Response) {
    try {
      const id = param(req, 'id');
      await prisma.orgRule.delete({ where: { id } });
      res.json({ message: 'Rule deleted' });
    } catch (error) {
      console.error('Delete rule error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  async duplicate(req: Request, res: Response) {
    try {
      const id = param(req, 'id');
      const source = await prisma.orgRule.findUniqueOrThrow({ where: { id } });
      const copy = await prisma.orgRule.create({
        data: {
          name: `${source.name} (copy)`,
          description: source.description,
          category: source.category,
          enabled: false,
          conditions: (source.conditions ?? []) as Prisma.InputJsonValue,
          actions: (source.actions ?? []) as Prisma.InputJsonValue,
          createdBy: headerStr(req, source.createdBy),
        },
      });
      res.status(201).json({ data: copy });
    } catch (error) {
      console.error('Duplicate rule error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  }
}
