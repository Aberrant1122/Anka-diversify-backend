import { PrismaClient } from "@prisma/client";

export interface ProvisionedEvalContext {
  userId: string;
  projectId: string;
  localPath: string;
  cleanup: () => Promise<void>;
}

export class EvalDatabaseFixture {
  private static prismaInstance: PrismaClient | null = null;

  public static getPrisma(): PrismaClient {
    if (!this.prismaInstance) {
      const url = process.env.EVAL_DATABASE_URL || process.env.DATABASE_URL;
      this.prismaInstance = new PrismaClient({
        datasources: url ? { db: { url } } : undefined,
      });
    }
    return this.prismaInstance;
  }

  /**
   * Verifies that the database connection is safe for eval execution (local, dev, test, or eval).
   * Fails closed if the database URL points to an unverified or production host.
   */
  public static verifySafeDatabase(customUrl?: string): void {
    const url = customUrl || process.env.EVAL_DATABASE_URL || process.env.DATABASE_URL || "";
    if (!url) {
      if (process.env.JEST_WORKER_ID !== undefined || typeof (global as any).it === "function") {
        return; // Allow mocked Prisma in Jest tests
      }
      throw new Error("[EVAL_DB_SAFETY] No DATABASE_URL or EVAL_DATABASE_URL configured.");
    }

    if (url.startsWith("file:") || url.startsWith("sqlite:")) {
      return;
    }

    try {
      const normalizedUrl = url.startsWith("postgresql://") || url.startsWith("postgres://")
        ? url
        : `postgresql://${url}`;
      const parsed = new URL(normalizedUrl);
      const host = (parsed.hostname || "").toLowerCase();
      const isLocalHost = host === "localhost" || host === "127.0.0.1" || host === "::1";

      const dbName = (parsed.pathname || "").replace(/^\//, "").toLowerCase();
      const isTestOrEvalDb = /(test|eval|dev)/i.test(dbName);

      if (process.env.NODE_ENV === "production" || (!isLocalHost && !isTestOrEvalDb)) {
        throw new Error(
          `[EVAL_DB_SAFETY] Unsafe evaluation database target host '${host}' and database '${dbName}'. Refusing to run evals against unapproved database.`,
        );
      }
    } catch (err: any) {
      if (err.message.startsWith("[EVAL_DB_SAFETY]")) throw err;
      throw new Error(`[EVAL_DB_SAFETY] Invalid database URL: ${err.message}`);
    }
  }

  /**
   * Provisions legitimate minimal User, Project, and ProjectMember records
   * required for AgentPipeline execution.
   */
  public static async provision(
    caseId: string,
    tempWorkspace: string,
    runId: string = Date.now().toString(36),
  ): Promise<ProvisionedEvalContext> {
    this.verifySafeDatabase();

    const prisma = this.getPrisma();
    const uniqueSuffix = `${runId}-${Math.random().toString(36).slice(2, 7)}`;
    const userId = `eval-user-${uniqueSuffix}`;
    const projectId = `eval-project-${caseId}-${uniqueSuffix}`;
    const email = `eval-${uniqueSuffix}@anka-eval.local`;

    let userCreated = false;
    let projectCreated = false;
    let memberCreated = false;

    try {
      // 1. Create legitimate Eval User
      await prisma.user.create({
        data: {
          id: userId,
          email,
          name: `Eval User (${caseId})`,
          password: "eval-password-hash-placeholder",
          role: "developer",
          status: "active",
        },
      });
      userCreated = true;

      // 2. Create legitimate Eval Project with localPath set to isolated tempWorkspace
      await prisma.project.create({
        data: {
          id: projectId,
          name: `Eval Project (${caseId})`,
          userId,
          localPath: tempWorkspace,
          status: "active",
          priority: "medium",
          teamSize: 1,
          progress: 0,
        },
      });
      projectCreated = true;

      // 3. Create ProjectMember relation
      await prisma.projectMember.create({
        data: {
          projectId,
          userId,
        },
      });
      memberCreated = true;

      const cleanup = async () => {
        await this.cleanupRecords(prisma, userId, projectId);
      };

      return {
        userId,
        projectId,
        localPath: tempWorkspace,
        cleanup,
      };
    } catch (err) {
      // Partial creation rollback
      await this.cleanupRecords(prisma, userCreated ? userId : undefined, projectCreated ? projectId : undefined);
      throw err;
    }
  }

  /**
   * Cleans up ephemeral eval records in strict reverse foreign-key dependency order.
   */
  public static async cleanupRecords(
    prisma: PrismaClient,
    userId?: string,
    projectId?: string,
  ): Promise<void> {
    try {
      if (projectId) {
        // 1. Delete dependent messages
        const sessions = await prisma.aiChatSession.findMany({
          where: { projectId },
          select: { id: true },
        });
        const sessionIds = sessions.map((s) => s.id);
        if (sessionIds.length > 0) {
          await prisma.aiChatMessage.deleteMany({
            where: { sessionId: { in: sessionIds } },
          });
        }

        // 2. Delete chat sessions
        await prisma.aiChatSession.deleteMany({
          where: { projectId },
        });

        // 3. Delete memory summaries, manifests, decompositions, snapshots, reservations, and artifacts
        await prisma.projectMemorySummary.deleteMany({
          where: { projectId },
        });

        await prisma.agentManifest.deleteMany({
          where: { projectId },
        });

        // Delete child subtask executions before decompositions (if any)
        if ((prisma as any).taskDecomposition && typeof (prisma as any).taskDecomposition.findMany === "function") {
          const decompositions = await (prisma as any).taskDecomposition.findMany({
            where: { projectId },
            select: { id: true },
          });
          const decompIds = decompositions.map((d: any) => d.id);
          if (decompIds.length > 0 && (prisma as any).subTaskExecution) {
            await (prisma as any).subTaskExecution.deleteMany({
              where: { decompositionId: { in: decompIds } },
            });
          }
        }

        await prisma.taskDecomposition.deleteMany({
          where: { projectId },
        });

        if ((prisma as any).contextSnapshot) {
          await (prisma as any).contextSnapshot.deleteMany({
            where: { projectId },
          });
        }

        if ((prisma as any).fileReservation) {
          await (prisma as any).fileReservation.deleteMany({
            where: { projectId },
          });
        }

        if ((prisma as any).architectureDriftRecord) {
          await (prisma as any).architectureDriftRecord.deleteMany({
            where: { projectId },
          });
        }

        await prisma.phaseArtifact.deleteMany({
          where: { projectId },
        });

        await prisma.projectMember.deleteMany({
          where: { projectId },
        });

        // 4. Delete Project
        await prisma.project.deleteMany({
          where: { id: projectId },
        });
      }

      if (userId) {
        // Delete any remaining user-level chat sessions
        const userSessions = await prisma.aiChatSession.findMany({
          where: { userId },
          select: { id: true },
        });
        const userSessionIds = userSessions.map((s) => s.id);
        if (userSessionIds.length > 0) {
          await prisma.aiChatMessage.deleteMany({
            where: { sessionId: { in: userSessionIds } },
          });
        }

        await prisma.aiChatSession.deleteMany({
          where: { userId },
        });

        await prisma.projectMember.deleteMany({
          where: { userId },
        });

        // Delete User
        await prisma.user.deleteMany({
          where: { id: userId },
        });
      }
    } catch {
      // Best-effort cleanup — do not throw so eval failure reports are preserved
    }
  }

  public static async disconnect(): Promise<void> {
    if (this.prismaInstance) {
      await this.prismaInstance.$disconnect();
      this.prismaInstance = null;
    }
  }
}
