import { PrismaClient } from "@prisma/client";
import { getOpenAI } from "../shared/utils";
import { AiChatSession } from "../shared/types";
import { MEMORY_PERSISTENCE_PROMPT } from "../prompts/coding";

const prisma = new PrismaClient();

export class MemoryPersistence {
  static async recordAgentMemory(projectId: string, note: string): Promise<void> {
    const existing = await prisma.projectMemorySummary.findUnique({ where: { projectId } });
    const priorLines = existing?.summary ? existing.summary.split("\n").filter(Boolean) : [];
    const entry = `- ${new Date().toISOString().slice(0, 10)}: ${note}`;
    const summary = [...priorLines, entry].slice(-20).join("\n");

    await prisma.projectMemorySummary.upsert({
      where: { projectId },
      update: { summary, lastUpdated: new Date(), version: { increment: 1 } },
      create: { projectId, summary, version: 1 },
    });
  }

  static async persistProjectMemory(projectId: string, userMessage: string, auditResult: any): Promise<void> {
    try {
      const openai = getOpenAI();
      const memoryCompletion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: MEMORY_PERSISTENCE_PROMPT },
          { role: "user", content: `USER TASK: ${userMessage}\nAUDIT SUMMARY: ${auditResult.summary}` },
        ],
        temperature: 0.2,
        response_format: { type: "json_object" },
      });

      const parsed = JSON.parse(memoryCompletion.choices[0]?.message?.content || "{}");
      const note = parsed.summaryEntry || `Updated code and structure for: ${userMessage.slice(0, 100)}`;
      await this.recordAgentMemory(projectId, note);
    } catch {
      await this.recordAgentMemory(projectId, `Executed task: ${userMessage.slice(0, 100)}`);
    }
  }

  static async getOrCreateSession(
    userId: string,
    type: "general" | "project",
    projectId?: string,
    sessionId?: string,
  ): Promise<AiChatSession> {
    if (sessionId) {
      const existingSession = await prisma.aiChatSession.findFirst({
        where: {
          id: sessionId,
          userId,
          type,
          ...(projectId && { projectId }),
        },
      });

      if (existingSession) {
        return {
          id: existingSession.id,
          type: existingSession.type as "general" | "project",
          userId: existingSession.userId,
          projectId: existingSession.projectId || undefined,
          title: existingSession.title || undefined,
          createdAt: existingSession.createdAt,
          updatedAt: existingSession.updatedAt,
        };
      }
    }

    if (projectId) {
      const existingProjectSession = await prisma.aiChatSession.findFirst({
        where: {
          userId,
          type,
          projectId,
        },
        orderBy: { updatedAt: "desc" },
      });

      if (existingProjectSession) {
        return {
          id: existingProjectSession.id,
          type: existingProjectSession.type as "general" | "project",
          userId: existingProjectSession.userId,
          projectId: existingProjectSession.projectId || undefined,
          title: existingProjectSession.title || undefined,
          createdAt: existingProjectSession.createdAt,
          updatedAt: existingProjectSession.updatedAt,
        };
      }
    }

    const newSession = await prisma.aiChatSession.create({
      data: {
        type,
        userId,
        projectId,
      },
    });

    return {
      id: newSession.id,
      type: newSession.type as "general" | "project",
      userId: newSession.userId,
      projectId: newSession.projectId || undefined,
      title: newSession.title || undefined,
      createdAt: newSession.createdAt,
      updatedAt: newSession.updatedAt,
    };
  }

  static async saveMessage(
    sessionId: string,
    role: "user" | "assistant",
    content: string,
  ): Promise<void> {
    await prisma.aiChatMessage.create({
      data: {
        sessionId,
        role,
        content,
      },
    });
  }

  static async updateSessionTitle(
    sessionId: string,
    firstMessage: string,
  ): Promise<void> {
    const title =
      firstMessage.length > 50
        ? firstMessage.substring(0, 47) + "..."
        : firstMessage;
    await prisma.aiChatSession.update({
      where: { id: sessionId },
      data: { title },
    });
  }

  static async getMessageCount(sessionId: string): Promise<number> {
    return prisma.aiChatMessage.count({
      where: { sessionId },
    });
  }

  static async getSessions(
    userId: string,
    type: "general" | "project",
    projectId?: string,
  ) {
    return prisma.aiChatSession.findMany({
      where: {
        userId,
        type,
        ...(projectId && { projectId }),
      },
      include: {
        messages: {
          orderBy: { createdAt: "desc" },
          take: 1,
        },
        project: projectId
          ? false
          : {
              select: { id: true, name: true },
            },
      },
      orderBy: { updatedAt: "desc" },
    });
  }

  static async getSessionMessages(sessionId: string, userId: string) {
    const session = await prisma.aiChatSession.findFirst({
      where: {
        id: sessionId,
        userId,
      },
      include: {
        messages: {
          orderBy: { createdAt: "asc" },
        },
      },
    });

    if (!session) {
      throw new Error("Session not found");
    }

    return session;
  }
}
