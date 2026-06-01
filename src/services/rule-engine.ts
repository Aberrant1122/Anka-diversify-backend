import { prisma } from './database';

export type RuleType = 'sprint_auto_close' | 'overdue_escalation';

// ── Sprint Auto-Close ────────────────────────────────────────────────────────

async function closeCompletedSprints(sprintIds?: string[]): Promise<{ closed: number }> {
  const where = sprintIds
    ? { id: { in: sprintIds }, status: { in: ['active', 'planning'] } }
    : { status: { in: ['active', 'planning'] } };

  const sprints = await prisma.sprint.findMany({
    where,
    include: {
      tasks: { include: { task: { select: { status: true } } } },
    },
  });

  let closed = 0;
  for (const sprint of sprints) {
    if (sprint.tasks.length === 0) continue;
    const allDone = sprint.tasks.every((st) => st.task.status === 'done');
    if (!allDone) continue;

    await prisma.sprint.update({ where: { id: sprint.id }, data: { status: 'completed' } });
    await prisma.projectActivity.create({
      data: {
        projectId: sprint.projectId,
        userId: 'system',
        userName: 'System',
        action: 'updated_sprint',
        entityType: 'sprint',
        entityId: sprint.id,
        entityName: sprint.name,
        meta: { reason: 'All tasks completed — auto-closed by rule engine' },
      },
    });
    closed++;
  }
  return { closed };
}

// Called from project-service after a task is updated to 'done'
export async function checkSprintAutoCloseForTask(taskId: string): Promise<void> {
  const rule = await prisma.orgRule.findFirst({
    where: { ruleType: 'sprint_auto_close', enabled: true },
  });
  if (!rule) return;

  const sprintLinks = await prisma.sprintTask.findMany({
    where: { taskId },
    select: { sprintId: true },
  });
  if (sprintLinks.length === 0) return;

  await closeCompletedSprints(sprintLinks.map((s) => s.sprintId));
}

// ── Overdue Escalation ───────────────────────────────────────────────────────

async function escalateOverdueTasks(): Promise<{ notified: number }> {
  const now = new Date();
  const dedupeWindow = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const overdueTasks = await prisma.projectTask.findMany({
    where: { dueDate: { lt: now }, status: { not: 'done' } },
    include: {
      project: {
        include: { members: { select: { userId: true } } },
      },
    },
  });

  let notified = 0;
  for (const task of overdueTasks) {
    // Skip if we already sent an alert for this task in the last 24h
    const alreadySent = await prisma.notification.findFirst({
      where: {
        entityId: task.id,
        entityType: 'task',
        type: 'alert',
        createdAt: { gte: dedupeWindow },
      },
    });
    if (alreadySent) continue;

    for (const member of task.project.members) {
      await prisma.notification.create({
        data: {
          userId: member.userId,
          type: 'alert',
          title: 'Overdue Task',
          message: `"${task.title}" in ${task.project.name} is past its due date`,
          link: `/development/projects/${task.projectId}`,
          entityId: task.id,
          entityType: 'task',
        },
      });
    }
    notified++;
  }
  return { notified };
}

// ── Public API ────────────────────────────────────────────────────────────────

// Run a rule type on demand / retroactively
export async function runRule(ruleType: RuleType): Promise<Record<string, unknown>> {
  switch (ruleType) {
    case 'sprint_auto_close':
      return closeCompletedSprints();
    case 'overdue_escalation':
      return escalateOverdueTasks();
    default:
      return { error: 'Unknown rule type' };
  }
}
