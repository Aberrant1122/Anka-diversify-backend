import OpenAI from "openai";
import { PrismaClient } from "@prisma/client";
import {
  ChatRequest,
  ChatResponse,
  ProjectContext,
  GeneralContext,
  ChatCompletionRequest,
  AiChatSession,
  AiChatMessage,
  Project,
  ProjectMemorySummary,
  ProjectDecision,
  ProjectRule,
  ProjectTask,
  User,
} from "../types";
import { ProjectGitHubService } from "./github.service";

const prisma = new PrismaClient();

export class AiService {
  private static instance: AiService;
  private openai: OpenAI | null = null;

  private constructor() {
    // Don't initialize OpenAI here - do it lazily
  }

  private getOpenAI(): OpenAI {
    if (!this.openai) {
      this.openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
      });
    }
    return this.openai;
  }

  static getInstance(): AiService {
    if (!AiService.instance) {
      AiService.instance = new AiService();
    }
    return AiService.instance;
  }

  async processGeneralChat(
    userId: string,
    request: ChatRequest,
  ): Promise<ChatResponse> {
    const startTime = Date.now();

    // Get or create session
    const session = await this.getOrCreateSession(
      userId,
      "general",
      undefined,
      request.sessionId,
    );

    // Build general context
    const generalContext = await this.buildGeneralContext(userId, session.id);

    // Save user message
    await this.saveMessage(session.id, "user", request.message);

    // Build prompt
    const messages = this.buildGeneralPrompt(request.message, generalContext);

    // Get AI response
    const completion = await this.getOpenAI().chat.completions.create({
      model: "gpt-4",
      messages,
      temperature: 0.7,
      max_tokens: 2000,
    });

    const aiResponse =
      completion.choices[0]?.message?.content ||
      "I apologize, but I could not generate a response.";

    // Save AI response
    await this.saveMessage(session.id, "assistant", aiResponse);

    // Update session title if first message
    if (!session.title) {
      await this.updateSessionTitle(session.id, request.message);
    }

    return {
      message: aiResponse,
      sessionId: session.id,
      contextMeta: {
        generalContext,
        messageCount: await this.getMessageCount(session.id),
        lastUpdated: new Date(),
      },
    };
  }

  async processProjectChat(
    userId: string,
    projectId: string,
    request: ChatRequest,
  ): Promise<ChatResponse> {
    const startTime = Date.now();

    // Verify user has access to project
    const project = await prisma.project.findFirst({
      where: { id: projectId, userId },
    });

    if (!project) {
      throw new Error("Project not found or access denied");
    }

    // Get or create session
    const session = await this.getOrCreateSession(
      userId,
      "project",
      projectId,
      request.sessionId,
    );

    // Build project context
    const projectContext = await this.buildProjectContext(projectId);

    // Save user message
    await this.saveMessage(session.id, "user", request.message);

    // Build prompt
    const messages = this.buildProjectPrompt(request.message, projectContext);

    // Get AI response
    const completion = await this.getOpenAI().chat.completions.create({
      model: "gpt-4",
      messages,
      temperature: 0.7,
      max_tokens: 2000,
    });

    const aiResponse =
      completion.choices[0]?.message?.content ||
      "I apologize, but I could not generate a response.";

    // Save AI response
    await this.saveMessage(session.id, "assistant", aiResponse);

    // Update session title if first message
    if (!session.title) {
      await this.updateSessionTitle(session.id, request.message);
    }

    return {
      message: aiResponse,
      sessionId: session.id,
      contextMeta: {
        projectContext,
        messageCount: await this.getMessageCount(session.id),
        lastUpdated: new Date(),
      },
    };
  }

  private async buildGeneralContext(
    userId: string,
    sessionId: string,
  ): Promise<GeneralContext> {
    const recentMessages = await prisma.aiChatMessage.findMany({
      where: {
        session: {
          userId,
          type: "general",
        },
      },
      orderBy: { createdAt: "desc" },
      take: 20,
      include: { session: true },
    });

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    const totalProjects = await prisma.project.count({
      where: { userId },
    });

    const activeProjects = await prisma.project.count({
      where: {
        userId,
        progress: { lt: 100 },
      },
    });

    return {
      recentMessages: recentMessages.reverse().map((msg: any) => ({
        id: msg.id,
        sessionId: msg.sessionId,
        role: msg.role as "user" | "assistant",
        content: msg.content,
        metadata: msg.metadata as Record<string, any> | undefined,
        createdAt: msg.createdAt,
      })),
      workspaceInfo: user
        ? {
            totalProjects,
            activeProjects,
            user: {
              id: user.id,
              name: user.name || undefined,
              email: user.email,
              createdAt: user.createdAt,
              updatedAt: user.updatedAt,
            },
          }
        : undefined,
    };
  }

  private async buildProjectContext(
    projectId: string,
  ): Promise<ProjectContext> {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
    });

    if (!project) {
      throw new Error("Project not found");
    }

    const [
      summary,
      recentMessages,
      recentDecisions,
      rules,
      activeTasks,
      repoSnapshot,
    ] = await Promise.all([
      prisma.projectMemorySummary.findUnique({
        where: { projectId },
      }),
      prisma.aiChatMessage.findMany({
        where: {
          session: {
            projectId,
            type: "project",
          },
        },
        orderBy: { createdAt: "desc" },
        take: 15,
        include: { session: true },
      }),
      prisma.projectDecision.findMany({
        where: { projectId },
        orderBy: { madeAt: "desc" },
        take: 10,
      }),
      prisma.projectRule.findMany({
        where: { projectId },
        orderBy: { priority: "desc", createdAt: "desc" },
      }),
      prisma.projectTask.findMany({
        where: {
          projectId,
          status: { in: ["todo", "in_progress"] },
        },
        orderBy: { priority: "desc", dueDate: "asc" },
        take: 20,
      }),
      ProjectGitHubService.getSnapshot(projectId),
    ]);

    return {
      project: {
        id: project.id,
        name: project.name,
        description: project.description || undefined,
        phase: project.phase || undefined,
        progress: project.progress,
        teamSize: project.teamSize,
        priority: project.priority,
        status: project.status,
        githubUrl: project.githubUrl || undefined,
        userId: project.userId,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        start_date: project.startDate?.toISOString() || "",
        due_date: project.dueDate?.toISOString() || "",
        created_at: project.createdAt.toISOString(),
        updated_at: project.updatedAt.toISOString(),
      },
      summary: summary || undefined,
      recentMessages: recentMessages.reverse().map((msg: any) => ({
        id: msg.id,
        sessionId: msg.sessionId,
        role: msg.role as "user" | "assistant",
        content: msg.content,
        metadata: msg.metadata as Record<string, any> | undefined,
        createdAt: msg.createdAt,
      })),
      recentDecisions: recentDecisions.map((decision: any) => ({
        id: decision.id,
        projectId: decision.projectId,
        title: decision.title,
        description: decision.description,
        impact: decision.impact || undefined,
        madeAt: decision.madeAt,
        madeBy: decision.madeBy || undefined,
        options: decision.options || undefined,
        createdAt: decision.createdAt,
      })),
      rules: rules.map((rule: any) => ({
        id: rule.id,
        projectId: rule.projectId,
        title: rule.title,
        description: rule.description,
        priority: rule.priority as "low" | "medium" | "high",
        createdAt: rule.createdAt,
      })),
      activeTasks: activeTasks.map((task: any) => ({
        id: task.id,
        projectId: task.projectId,
        title: task.title,
        description: task.description || undefined,
        status: task.status as "todo" | "in_progress" | "done",
        priority: task.priority as "low" | "medium" | "high",
        dueDate: task.dueDate || undefined,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      })),
      repoSnapshot: repoSnapshot
        ? {
            ...repoSnapshot,
            keyFiles: repoSnapshot.keyFiles.map((file: any) => ({
              ...file,
              repoSnapshot: repoSnapshot,
            })),
          }
        : undefined,
    };
  }

  private buildGeneralPrompt(
    userMessage: string,
    context: GeneralContext,
  ): Array<{ role: "system" | "user" | "assistant"; content: string }> {
    const systemPrompt = `You are a helpful AI assistant for a project management workspace. You help users with general questions, workspace overview, and cross-project insights.

Current Context:
- User: ${context.workspaceInfo?.user.name || context.workspaceInfo?.user.email || "Unknown"}
- Total Projects: ${context.workspaceInfo?.totalProjects || 0}
- Active Projects: ${context.workspaceInfo?.activeProjects || 0}

Recent conversation history:
${context.recentMessages
  .slice(-5)
  .map((msg) => `${msg.role}: ${msg.content}`)
  .join("\n")}

Guidelines:
- Be helpful and conversational
- Provide workspace-level insights when relevant
- Help users navigate between projects
- Suggest project management best practices
- Keep responses focused and actionable`;

    return [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ];
  }

  private buildProjectPrompt(
    userMessage: string,
    context: ProjectContext,
  ): Array<{ role: "system" | "user" | "assistant"; content: string }> {
    const systemPrompt = `You are a specialized AI assistant for the project "${context.project.name}". You have deep knowledge of this specific project and should provide contextualized assistance.

PROJECT DETAILS:
- Name: ${context.project.name}
- Description: ${context.project.description || "No description"}
- Phase: ${context.project.phase || "Not specified"}
- Progress: ${context.project.progress}%
- Team Size: ${context.project.teamSize} people

PROJECT SUMMARY:
${context.summary?.summary || "No project summary available"}

PROJECT RULES:
${context.rules.length > 0 ? context.rules.map((rule) => `- ${rule.title}: ${rule.description} (Priority: ${rule.priority})`).join("\n") : "No specific rules defined"}

RECENT DECISIONS:
${context.recentDecisions.length > 0 ? context.recentDecisions.map((decision) => `- ${decision.title}: ${decision.description} (Impact: ${decision.impact || "Not specified"})`).join("\n") : "No recent decisions"}

ACTIVE TASKS:
${context.activeTasks.length > 0 ? context.activeTasks.map((task) => `- ${task.title} (${task.status}, Priority: ${task.priority})${task.dueDate ? ` Due: ${task.dueDate.toLocaleDateString()}` : ""}`).join("\n") : "No active tasks"}

RECENT CONVERSATION:
${context.recentMessages
  .slice(-5)
  .map((msg) => `${msg.role}: ${msg.content}`)
  .join("\n")}
${
  context.repoSnapshot
    ? `
CODEBASE (GitHub: ${context.repoSnapshot.repoName}):
- Branch: ${context.repoSnapshot.defaultBranch}
- Description: ${context.repoSnapshot.description || "N/A"}
- Languages: ${Object.entries(context.repoSnapshot.languages)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 6)
        .map(([lang]) => lang)
        .join(", ")}
- Last synced: ${context.repoSnapshot.lastSyncedAt.toLocaleDateString()}

FILE STRUCTURE (${context.repoSnapshot.fileTree.length} files):
${context.repoSnapshot.fileTree.slice(0, 80).join("\n")}

KEY FILES:
${context.repoSnapshot.keyFiles
  .map((f) => `--- ${f.path} ---\n${f.content}`)
  .join("\n\n")}`
    : ""
}

GUIDELINES:
- Always consider project context in your responses
- Reference project rules, decisions, and tasks when relevant
- When answering code questions, reference actual files and patterns from the codebase above
- Help with project-specific questions and planning
- Suggest next steps based on current progress
- Keep responses actionable and project-focused`;

    return [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ];
  }

  private async getOrCreateSession(
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

  private async saveMessage(
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

  private async updateSessionTitle(
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

  private async getMessageCount(sessionId: string): Promise<number> {
    return prisma.aiChatMessage.count({
      where: { sessionId },
    });
  }

  async getSessions(
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

  async getSessionMessages(sessionId: string, userId: string) {
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

  async getProjectContext(projectId: string, userId: string) {
    const project = await prisma.project.findFirst({
      where: { id: projectId, userId },
    });

    if (!project) {
      throw new Error("Project not found or access denied");
    }

    return this.buildProjectContext(projectId);
  }
}
