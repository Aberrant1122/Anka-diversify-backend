import { prisma } from "./database";
import type { ProjectHealth } from "../types";

const DAY_MS = 86_400_000;

type HealthTask = {
  status: string;
  dueDate: Date | null;
  updatedAt: Date;
  blockedBy: Array<{ blockingTaskId: string }>;
};

export interface ProjectHealthInput {
  tasks: HealthTask[];
  lastProjectActivityAt: Date | null;
  repository: {
    connected: boolean;
    trackedFiles: number;
    lastSyncedAt: Date | null;
  };
}

function activityValue(days: number): number {
  if (days <= 2) return 100;
  if (days <= 7) return 80;
  if (days <= 14) return 60;
  if (days <= 30) return 30;
  return 0;
}

function repositoryValue(repository: ProjectHealthInput["repository"], daysSinceSync: number | null): number {
  if (!repository.connected) return 0;
  const connected = 30;
  const indexed = repository.trackedFiles > 0 ? 40 : 0;
  const sync = daysSinceSync === null ? 0 : daysSinceSync <= 7 ? 30 : daysSinceSync <= 30 ? 15 : 0;
  return connected + indexed + sync;
}

/**
 * Deterministic v1 health heuristic. Missing dimensions are excluded and the
 * remaining weights are renormalized; missing data is never scored as failure.
 */
export function calculateProjectHealth(
  input: ProjectHealthInput,
  now: Date = new Date(),
): ProjectHealth {
  const totalTasks = input.tasks.length;
  const completedTasks = input.tasks.filter((task) => task.status === "done").length;
  const inProgressTasks = input.tasks.filter((task) => task.status === "in_progress").length;
  const overdueTasks = input.tasks.filter(
    (task) => task.dueDate !== null && task.dueDate < now && task.status !== "done",
  ).length;
  const blockedTasks = input.tasks.filter(
    (task) => task.status !== "done" && task.blockedBy.length > 0,
  ).length;
  const completionPercent = totalTasks > 0
    ? Math.round((completedTasks / totalTasks) * 100)
    : null;

  const activityCandidates = [
    input.lastProjectActivityAt,
    ...input.tasks.map((task) => task.updatedAt),
    input.repository.lastSyncedAt,
  ].filter((date): date is Date => date !== null);
  const lastActivityAt = activityCandidates.length > 0
    ? new Date(Math.max(...activityCandidates.map((date) => date.getTime())))
    : null;
  const daysSinceActivity = lastActivityAt
    ? Math.max(0, Math.floor((now.getTime() - lastActivityAt.getTime()) / DAY_MS))
    : null;
  const daysSinceSync = input.repository.lastSyncedAt
    ? Math.max(0, Math.floor((now.getTime() - input.repository.lastSyncedAt.getTime()) / DAY_MS))
    : null;

  const dimensions: Array<{ weight: number; value: number }> = [];
  if (completionPercent !== null) {
    dimensions.push({ weight: 40, value: completionPercent });
    dimensions.push({ weight: 20, value: Math.max(0, 100 - blockedTasks * 25) });
  }
  if (daysSinceActivity !== null) dimensions.push({ weight: 25, value: activityValue(daysSinceActivity) });
  dimensions.push({ weight: 15, value: repositoryValue(input.repository, daysSinceSync) });

  const totalWeight = dimensions.reduce((sum, dimension) => sum + dimension.weight, 0);
  const score = totalWeight === 0
    ? 0
    : Math.round(dimensions.reduce((sum, dimension) => sum + dimension.weight * dimension.value, 0) / totalWeight);
  const status: ProjectHealth["status"] = score >= 80
    ? "HEALTHY"
    : score >= 60
      ? "FAIR"
      : score >= 40
        ? "WARNING"
        : "AT_RISK";

  const recommendations: ProjectHealth["recommendations"] = [];
  if (totalTasks === 0) {
    recommendations.push({ code: "NO_TASKS", message: "Create tasks to start tracking project progress." });
  }
  if (blockedTasks > 0) {
    recommendations.push({
      code: "BLOCKED_TASKS",
      message: `Review ${blockedTasks} blocked task${blockedTasks === 1 ? "" : "s"}.`,
    });
  }
  if (overdueTasks > 0) {
    recommendations.push({
      code: "OVERDUE_TASKS",
      message: `Review ${overdueTasks} overdue task${overdueTasks === 1 ? "" : "s"}.`,
    });
  }
  if (!input.repository.connected) {
    recommendations.push({ code: "REPOSITORY_MISSING", message: "Connect a repository to enable repository tracking." });
  } else if (input.repository.trackedFiles === 0 || daysSinceSync === null || daysSinceSync > 30) {
    recommendations.push({ code: "REPOSITORY_REFRESH", message: "Refresh repository data." });
  }
  if (daysSinceActivity !== null && daysSinceActivity > 14) {
    recommendations.push({ code: "STALE_ACTIVITY", message: "Review the project plan and record the next active task." });
  }
  if (recommendations.length === 0) {
    recommendations.push({ code: "NO_IMMEDIATE_ISSUES", message: "No immediate issues detected." });
  }

  return {
    score,
    status,
    progress: { totalTasks, completedTasks, percent: completionPercent },
    activity: {
      lastActivityAt: lastActivityAt?.toISOString() ?? null,
      daysSinceActivity,
    },
    repository: {
      connected: input.repository.connected,
      indexed: input.repository.trackedFiles > 0,
      trackedFiles: input.repository.trackedFiles,
      lastSyncedAt: input.repository.lastSyncedAt?.toISOString() ?? null,
    },
    blockers: { count: blockedTasks },
    overdue: { count: overdueTasks },
    inProgress: { count: inProgressTasks },
    recommendations,
    calculatedAt: now.toISOString(),
  };
}

function countTrackedFiles(fileTree: string | null | undefined): number {
  if (!fileTree) return 0;
  try {
    const parsed: unknown = JSON.parse(fileTree);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

export class ProjectSidebarService {
  static async getAccessibleProject(projectId: string, userId: string) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
    return prisma.project.findFirst({
      where: user?.role === "admin"
        ? { id: projectId }
        : { id: projectId, OR: [{ userId }, { members: { some: { userId } } }] },
      select: { id: true, githubUrl: true, githubToken: true },
    });
  }

  static async getProjectHealth(projectId: string): Promise<ProjectHealth> {
    const [project, tasks, activity] = await Promise.all([
      prisma.project.findUnique({
        where: { id: projectId },
        select: {
          githubUrl: true,
          repoSnapshot: { select: { fileTree: true, lastSyncedAt: true } },
        },
      }),
      prisma.projectTask.findMany({
        where: { projectId },
        select: {
          status: true,
          dueDate: true,
          updatedAt: true,
          blockedBy: { select: { blockingTaskId: true } },
        },
      }),
      prisma.projectActivity.findFirst({
        where: { projectId },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      }),
    ]);

    return calculateProjectHealth({
      tasks,
      lastProjectActivityAt: activity?.createdAt ?? null,
      repository: {
        connected: Boolean(project?.githubUrl),
        trackedFiles: countTrackedFiles(project?.repoSnapshot?.fileTree),
        lastSyncedAt: project?.repoSnapshot?.lastSyncedAt ?? null,
      },
    });
  }
}
