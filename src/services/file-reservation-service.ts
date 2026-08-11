import { prisma } from "./database";

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes — comfortably longer than one sub-task, short enough that a crashed run doesn't block a project for long

export interface ReservationConflict {
  filePath: string;
  heldBySessionId: string;
  holderType: string;
  reason: string | null;
}

export interface AcquireResult {
  granted: string[];
  conflicts: ReservationConflict[];
}

// Best-effort, advisory locking (spec §14.3) — not OS-level. A conflict blocks the
// calling code from proceeding on that file rather than silently overwriting; nothing
// stops a human editing the file directly outside this system.
export async function acquireReservations(
  projectId: string,
  repositoryId: string | null,
  filePaths: string[],
  sessionId: string,
  holderType: "agent_run" | "human",
  reason?: string,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<AcquireResult> {
  if (filePaths.length === 0) return { granted: [], conflicts: [] };

  const now = new Date();
  const existing = await prisma.fileReservation.findMany({
    where: {
      projectId,
      repositoryId,
      filePath: { in: filePaths },
      expiresAt: { gt: now },
    },
  });

  const conflicts: ReservationConflict[] = [];
  const heldBySelf = new Set<string>();
  for (const res of existing) {
    if (res.sessionId === sessionId) {
      heldBySelf.add(res.filePath);
    } else {
      conflicts.push({
        filePath: res.filePath,
        heldBySessionId: res.sessionId,
        holderType: res.holderType,
        reason: res.reason,
      });
    }
  }

  const conflictedPaths = new Set(conflicts.map((c) => c.filePath));
  const toGrant = filePaths.filter((p) => !conflictedPaths.has(p) && !heldBySelf.has(p));

  if (toGrant.length > 0) {
    const expiresAt = new Date(now.getTime() + ttlMs);
    await prisma.fileReservation.createMany({
      data: toGrant.map((filePath) => ({
        projectId,
        repositoryId,
        filePath,
        holderType,
        sessionId,
        reason,
        expiresAt,
      })),
    });
  }

  return {
    granted: [...toGrant, ...Array.from(heldBySelf)],
    conflicts,
  };
}

export async function releaseReservations(sessionId: string): Promise<void> {
  await prisma.fileReservation.deleteMany({ where: { sessionId } });
}

export async function listActiveReservations(projectId: string) {
  return prisma.fileReservation.findMany({
    where: { projectId, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });
}
