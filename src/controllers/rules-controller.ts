import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../services/database';
import { runRule, RuleType } from '../services/rule-engine';

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
      const { name, description, category, conditions, actions, ruleType } = req.body;
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
          ruleType: ruleType || null,
        },
      });
      // Retroactive: if created enabled with a known type, run it immediately
      if (rule.enabled && rule.ruleType) {
        runRule(rule.ruleType as RuleType).catch(console.error);
      }
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

      // Fetch current state to detect enabled toggle
      const before = await prisma.orgRule.findUnique({ where: { id } });

      const data: Prisma.OrgRuleUpdateInput = {};
      if (body.name !== undefined) data.name = String(body.name);
      if (body.description !== undefined) data.description = String(body.description);
      if (body.category !== undefined) data.category = String(body.category);
      if (body.enabled !== undefined) data.enabled = Boolean(body.enabled);
      if (body.conditions !== undefined) data.conditions = body.conditions as Prisma.InputJsonValue;
      if (body.actions !== undefined) data.actions = body.actions as Prisma.InputJsonValue;
      if (body.ruleType !== undefined) data.ruleType = body.ruleType ? String(body.ruleType) : null;

      const rule = await prisma.orgRule.update({ where: { id }, data });

      // Retroactive: rule was just switched on — run it against existing data immediately
      const wasOff = before && !before.enabled;
      const isNowOn = rule.enabled;
      if (wasOff && isNowOn && rule.ruleType) {
        runRule(rule.ruleType as RuleType).catch(console.error);
      }

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
          ruleType: source.ruleType,
        },
      });
      res.status(201).json({ data: copy });
    } catch (error) {
      console.error('Duplicate rule error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  // Manual / on-demand run
  async run(req: Request, res: Response) {
    try {
      const id = param(req, 'id');
      const rule = await prisma.orgRule.findUniqueOrThrow({ where: { id } });
      if (!rule.ruleType) {
        return res.status(400).json({ message: 'This rule has no enforcement type — it is policy-only' });
      }
      const result = await runRule(rule.ruleType as RuleType);
      res.json({ data: result });
    } catch (error) {
      console.error('Run rule error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  }
}
