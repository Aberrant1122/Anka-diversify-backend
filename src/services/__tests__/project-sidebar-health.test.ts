import { calculateProjectHealth, type ProjectHealthInput } from "../project-sidebar.service";

const NOW = new Date("2026-09-16T12:00:00.000Z");

function task(
  status: string,
  daysAgo: number,
  options: { overdue?: boolean; blocked?: boolean } = {},
): ProjectHealthInput["tasks"][number] {
  return {
    status,
    updatedAt: new Date(NOW.getTime() - daysAgo * 86_400_000),
    dueDate: options.overdue ? new Date(NOW.getTime() - 86_400_000) : null,
    blockedBy: options.blocked ? [{ blockingTaskId: "blocker" }] : [],
  };
}

function input(overrides: Partial<ProjectHealthInput> = {}): ProjectHealthInput {
  return {
    tasks: [],
    lastProjectActivityAt: null,
    repository: { connected: true, trackedFiles: 12, lastSyncedAt: NOW },
    ...overrides,
  };
}

describe("project sidebar health", () => {
  test("calculates task completion from real task state", () => {
    const health = calculateProjectHealth(input({ tasks: [task("done", 1), task("done", 1), task("todo", 1)] }), NOW);
    expect(health.progress).toEqual({ totalTasks: 3, completedTasks: 2, percent: 67 });
  });

  test("uses no-tasks semantics instead of a fake zero percent", () => {
    const health = calculateProjectHealth(input(), NOW);
    expect(health.progress.percent).toBeNull();
    expect(health.recommendations).toContainEqual(expect.objectContaining({ code: "NO_TASKS" }));
  });

  test("derives recent activity from the latest meaningful timestamp", () => {
    const health = calculateProjectHealth(input({
      tasks: [task("todo", 5)],
      lastProjectActivityAt: new Date(NOW.getTime() - 86_400_000),
    }), NOW);
    expect(health.activity.daysSinceActivity).toBe(0);
  });

  test("reports stale activity deterministically", () => {
    const stale = new Date(NOW.getTime() - 45 * 86_400_000);
    const health = calculateProjectHealth(input({
      tasks: [],
      lastProjectActivityAt: stale,
      repository: { connected: true, trackedFiles: 12, lastSyncedAt: stale },
    }), NOW);
    expect(health.activity.daysSinceActivity).toBe(45);
    expect(health.recommendations).toContainEqual(expect.objectContaining({ code: "STALE_ACTIVITY" }));
  });

  test("preserves null when no activity timestamp exists", () => {
    const health = calculateProjectHealth(input({
      repository: { connected: false, trackedFiles: 0, lastSyncedAt: null },
    }), NOW);
    expect(health.activity).toEqual({ lastActivityAt: null, daysSinceActivity: null });
  });

  test("counts blockers and overdue work only for unfinished tasks", () => {
    const health = calculateProjectHealth(input({
      tasks: [task("todo", 1, { overdue: true, blocked: true }), task("done", 1, { overdue: true, blocked: true })],
    }), NOW);
    expect(health.blockers.count).toBe(1);
    expect(health.overdue.count).toBe(1);
    expect(health.recommendations.map((item) => item.code)).toEqual(expect.arrayContaining(["BLOCKED_TASKS", "OVERDUE_TASKS"]));
  });

  test("derives repository readiness from connection, indexing, and sync", () => {
    const connected = calculateProjectHealth(input(), NOW);
    const missing = calculateProjectHealth(input({ repository: { connected: false, trackedFiles: 0, lastSyncedAt: null } }), NOW);
    expect(connected.repository).toMatchObject({ connected: true, indexed: true, trackedFiles: 12 });
    expect(missing.repository).toMatchObject({ connected: false, indexed: false, trackedFiles: 0 });
    expect(missing.recommendations).toContainEqual(expect.objectContaining({ code: "REPOSITORY_MISSING" }));
  });

  test("is deterministic and does not penalize unavailable dimensions", () => {
    const minimal = input({ tasks: [], lastProjectActivityAt: null });
    const first = calculateProjectHealth(minimal, NOW);
    const second = calculateProjectHealth(minimal, NOW);
    expect(first.score).toBe(100);
    expect(second).toEqual(first);
  });
});
