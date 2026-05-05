import fs from "fs";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import OpenAI from "openai";
import { PrismaClient } from "@prisma/client";

const execAsync = promisify(exec);
import {
  ChatRequest,
  ChatResponse,
  ProposedTask,
  EpicProposal,
  ProjectHealth,
  PRReview,
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
  AgentResponse,
  AgentFileChange,
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
    const session = await this.getOrCreateSession(
      userId,
      "project",
      projectId,
      request.sessionId,
    );

    const projectContext = await this.buildProjectContext(projectId);
    await this.saveMessage(session.id, "user", request.message);
    const messages = this.buildProjectPrompt(request.message, projectContext);

    const completion = await this.getOpenAI().chat.completions.create({
      model: "gpt-4o",
      messages,
      temperature: 0.7,
      max_tokens: 2000,
      tools: [
        {
          type: "function",
          function: {
            name: "propose_tasks",
            description:
              "When the user discusses small requirements, bugs, or asks to create a few tasks, call this to propose actionable Kanban tasks. Use generate_epic instead when the user describes a full feature or large piece of work.",
            parameters: {
              type: "object",
              properties: {
                tasks: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      title:       { type: "string", description: "Short, action-oriented task title" },
                      description: { type: "string", description: "Details and acceptance criteria" },
                      priority:    { type: "string", enum: ["low", "medium", "high"] },
                      phase:       { type: "string", description: "Project phase this belongs to" },
                      userStory:   { type: "string", description: "Optional: As a [user], I want [goal] so that [benefit]" },
                    },
                    required: ["title", "priority"],
                  },
                },
              },
              required: ["tasks"],
            },
          },
        },
        {
          type: "function",
          function: {
            name: "generate_epic",
            description:
              "When the user describes a full feature, module, or large piece of work, break it into a named epic with multiple tasks covering the full scope. Include user stories and acceptance criteria.",
            parameters: {
              type: "object",
              properties: {
                title:       { type: "string", description: "Epic name (short, feature-level)" },
                description: { type: "string", description: "What this epic delivers and why" },
                tasks: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      title:               { type: "string" },
                      description:         { type: "string", description: "Acceptance criteria and technical notes" },
                      priority:            { type: "string", enum: ["low", "medium", "high"] },
                      phase:               { type: "string" },
                      userStory:           { type: "string", description: "As a [user], I want [goal] so that [benefit]" },
                    },
                    required: ["title", "priority"],
                  },
                },
              },
              required: ["title", "description", "tasks"],
            },
          },
        },
      ],
      tool_choice: "auto",
    });

    let aiResponse = completion.choices[0]?.message?.content ?? "";
    let proposedTasks: ProposedTask[] | undefined;
    let proposedEpic: EpicProposal | undefined;

    const toolCalls = completion.choices[0]?.message?.tool_calls;
    if (toolCalls?.length) {
      for (const call of toolCalls) {
        if (call.type !== "function") continue;
        try {
          const args = JSON.parse(call.function.arguments);
          if (call.function.name === "propose_tasks") {
            proposedTasks = args.tasks as ProposedTask[];
            if (!aiResponse) {
              aiResponse = `I've identified **${proposedTasks.length} task${proposedTasks.length !== 1 ? "s" : ""}** from our discussion. Review and confirm which ones to add to the Kanban board.`;
            }
          } else if (call.function.name === "generate_epic") {
            proposedEpic = args as EpicProposal;
            if (!aiResponse) {
              aiResponse = `I've broken down **${proposedEpic.title}** into ${proposedEpic.tasks.length} tasks. Review the epic and add it to the Kanban board.`;
            }
          }
        } catch {}
      }
    }

    if (!aiResponse) aiResponse = "I apologize, but I could not generate a response.";

    await this.saveMessage(session.id, "assistant", aiResponse);

    if (!session.title) {
      await this.updateSessionTitle(session.id, request.message);
    }

    return {
      message: aiResponse,
      sessionId: session.id,
      proposedTasks,
      proposedEpic,
      contextMeta: {
        projectContext,
        messageCount: await this.getMessageCount(session.id),
        lastUpdated: new Date(),
      },
    };
  }

  async getProjectHealth(projectId: string): Promise<ProjectHealth> {
    const now = new Date();

    const [tasks, recentActivity] = await Promise.all([
      prisma.projectTask.findMany({ where: { projectId } }),
      prisma.projectActivity.findMany({
        where: { projectId },
        orderBy: { createdAt: "desc" },
        take: 1,
      }),
    ]);

    const totalTasks = tasks.length;
    const completedTasks = tasks.filter((t: any) => t.status === "done").length;
    const inProgressTasks = tasks.filter((t: any) => t.status === "in_progress").length;
    const overdueTasks = tasks.filter(
      (t: any) => t.dueDate && new Date(t.dueDate) < now && t.status !== "done"
    ).length;
    const completionRate = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

    const daysSinceActivity = recentActivity[0]
      ? Math.floor((now.getTime() - new Date(recentActivity[0].createdAt).getTime()) / 86400000)
      : 999;

    const flags: string[] = [];
    const recommendations: string[] = [];
    let score = 100;

    if (overdueTasks > 0) {
      score -= Math.min(overdueTasks * 8, 30);
      flags.push(`${overdueTasks} overdue task${overdueTasks > 1 ? "s" : ""}`);
      recommendations.push("Review and reschedule overdue tasks or mark them as blocked.");
    }
    if (completionRate < 20 && totalTasks > 5) {
      score -= 15;
      flags.push("Low completion rate");
      recommendations.push("Break large tasks into smaller ones to improve velocity.");
    }
    if (inProgressTasks > 5) {
      score -= 10;
      flags.push(`${inProgressTasks} tasks in progress simultaneously`);
      recommendations.push("Limit work-in-progress to 2-3 tasks per person to reduce context switching.");
    }
    if (daysSinceActivity > 7) {
      score -= 15;
      flags.push(`No activity in ${daysSinceActivity} days`);
      recommendations.push("Schedule a team sync to unblock progress.");
    }
    if (totalTasks === 0) {
      score = 50;
      flags.push("No tasks created yet");
      recommendations.push("Use the AI assistant to break down your project into actionable tasks.");
    }

    score = Math.max(0, Math.min(100, score));
    const status: ProjectHealth["status"] = score >= 70 ? "healthy" : score >= 40 ? "warning" : "critical";

    return {
      score,
      status,
      flags,
      recommendations,
      stats: { totalTasks, completedTasks, overdueTasks, inProgressTasks, completionRate },
    };
  }

  async reviewPullRequest(projectId: string, prNumber: number): Promise<PRReview> {
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project?.githubUrl) throw new Error("No GitHub repository connected to this project");

    const [diff, prs] = await Promise.all([
      ProjectGitHubService.getPullRequestDiff(project.githubUrl, prNumber),
      ProjectGitHubService.listPullRequests(project.githubUrl),
    ]);

    const pr = prs.find((p) => p.number === prNumber);
    const prMeta = pr
      ? `PR #${pr.number}: ${pr.title}\nAuthor: ${pr.author}\nBranch: ${pr.headBranch} → ${pr.baseBranch}\n${pr.body ? `\nDescription:\n${pr.body}` : ""}`
      : `PR #${prNumber}`;

    const completion = await this.getOpenAI().chat.completions.create({
      model: "gpt-4o",
      temperature: 0.3,
      max_tokens: 1500,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You are a senior code reviewer. Analyze the pull request diff and return a JSON object with:
{
  "summary": "2-3 sentence overview of what this PR does",
  "risks": ["list of specific risks, bugs, or security concerns found in the diff"],
  "suggestions": ["list of concrete improvement suggestions"],
  "verdict": "approve" | "request_changes" | "needs_discussion",
  "qualityScore": 0-100
}
Be specific and reference actual code from the diff. Keep each risk/suggestion under 120 characters.`,
        },
        {
          role: "user",
          content: `${prMeta}\n\n--- DIFF ---\n${diff}`,
        },
      ],
    });

    const raw = completion.choices[0]?.message?.content ?? "{}";
    try {
      return JSON.parse(raw) as PRReview;
    } catch {
      return {
        summary: "Could not parse AI review response.",
        risks: [],
        suggestions: [],
        verdict: "needs_discussion",
        qualityScore: 50,
      };
    }
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
        orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
      }),
      prisma.projectTask.findMany({
        where: {
          projectId,
          status: { in: ["todo", "in_progress"] },
        },
        orderBy: [{ priority: "desc" }, { dueDate: "asc" }],
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

WORKFLOW — follow these steps in order when helping with any coding or technical task:
1. UNDERSTAND — read the request carefully, clarify the goal and scope before acting
2. INSPECT — reference the existing codebase context below before suggesting changes
3. PLAN — outline the minimal set of changes needed and explain the approach
4. APPLY — recommend minimal, focused changes; do not suggest unrelated refactors
5. VALIDATE — ensure suggestions are consistent with the existing code style and patterns
6. FIX — if you spot type errors, broken imports, or logic issues, flag and fix them

HARD RULES:
- NEVER suggest creating or modifying a file without first referencing the relevant existing code in the context below
- ALWAYS search the codebase context for existing patterns and utilities before generating new code — do not duplicate what already exists

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
    return this.buildProjectContext(projectId);
  }

  // ── Agent Pipeline ────────────────────────────────────────────────────────

  private buildAgentSystemPrompt(projectContext: any, snapshot: any): string {
    const repoInfo = snapshot
      ? `REPOSITORY: ${snapshot.repoName} (branch: ${snapshot.defaultBranch})
FILE TREE:
${snapshot.fileTree.slice(0, 200).join("\n")}`
      : "No repository connected. Return empty changes array and explain.";

    return `You are a coding agent for "${projectContext.project.name}". Produce exact file changes for the user's request.

${repoInfo}

ACTIVE TASKS:
${projectContext.activeTasks.map((t: any) => `- ${t.title} (${t.status})`).join("\n") || "None"}

RULES:
- Only change files that exist in the file tree above
- Write complete file contents (not diffs or partials)
- Follow existing code style and patterns exactly
- Only change what is strictly necessary — nothing more
- Preserve formatting, naming, and file structure
- NEVER create or modify a file without reading it first
- ALWAYS reuse existing components from /components/ui/
- No inline styles, no hardcoded colors, no new UI libraries
- Use semantic Tailwind tokens: bg-background, bg-card, bg-primary, bg-muted, text-foreground, etc.
- TOOL BOUNDARIES: no rm -rf, no git push --force, no .env edits, no deleting core files

You MUST respond with ONLY valid JSON:
{
  "explanation": "what you changed and why",
  "changes": [{ "path": "relative/path", "content": "complete file content", "description": "one-line summary" }],
  "commitMessage": "feat: description"
}`;
  }

  private async planTask(
    message: string,
    snapshot: any,
  ): Promise<{ approach: string; filesToRead: string[]; validationCommands: string[] }> {
    const fileTree = snapshot?.fileTree?.slice(0, 300).join("\n") || "No repo connected";

    const completion = await this.getOpenAI().chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: `You are a coding task planner. Given a user request and file tree, identify:
1. The minimal approach to fulfil the request
2. Only the specific files that need to be read (max 10): the file to change, its imports, related types
3. Validation commands to run after changes

FILE TREE:
${fileTree}

Respond with ONLY valid JSON: { "approach": "string", "filesToRead": ["path1", "path2"], "validationCommands": ["tsc --noEmit"] }`,
        },
        { role: "user", content: message },
      ],
      temperature: 0.1,
      max_tokens: 600,
      response_format: { type: "json_object" },
    });

    try {
      return JSON.parse(completion.choices[0]?.message?.content || "{}");
    } catch {
      return { approach: "", filesToRead: [], validationCommands: ["tsc --noEmit"] };
    }
  }

  private async buildFileContext(
    filesToRead: string[],
    snapshot: any,
    githubUrl: string,
  ): Promise<Record<string, string>> {
    const context: Record<string, string> = {};

    // Pull from already-fetched key files first
    for (const keyFile of snapshot?.keyFiles || []) {
      if (filesToRead.some((f) => f === keyFile.path)) {
        context[keyFile.path] = keyFile.content;
      }
    }

    // Fetch remaining files directly from GitHub
    for (const filePath of filesToRead.slice(0, 10)) {
      if (!context[filePath] && githubUrl) {
        const file = await ProjectGitHubService.getFileContent(githubUrl, filePath).catch(() => null);
        if (file) context[filePath] = file.content;
      }
    }

    return context;
  }

  private async executeChanges(
    message: string,
    approach: string,
    fileContext: Record<string, string>,
    systemPrompt: string,
    previousErrors: string | null,
  ): Promise<{ explanation: string; changes: AgentFileChange[]; commitMessage: string }> {
    const fileContents = Object.entries(fileContext)
      .map(([p, c]) => `=== ${p} ===\n${c}`)
      .join("\n\n");

    const userMessage = previousErrors
      ? `${message}\n\nAPPROACH: ${approach}\n\nRELEVANT FILES:\n${fileContents}\n\nPREVIOUS ATTEMPT ERRORS — fix these:\n${previousErrors}`
      : `${message}\n\nAPPROACH: ${approach}\n\nRELEVANT FILES:\n${fileContents}`;

    const completion = await this.getOpenAI().chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      temperature: 0.2,
      max_tokens: 8000,
      response_format: { type: "json_object" },
    });

    try {
      return JSON.parse(completion.choices[0]?.message?.content || "{}");
    } catch {
      return { explanation: "Failed to parse response", changes: [], commitMessage: "chore: agent changes" };
    }
  }

  private async validateWithShell(
    changes: AgentFileChange[],
    localPath: string,
    commands: string[],
  ): Promise<{ success: boolean; errors: string }> {
    // Write changes to disk
    for (const change of changes) {
      const abs = path.join(localPath, change.path);
      await fs.promises.mkdir(path.dirname(abs), { recursive: true });
      await fs.promises.writeFile(abs, change.content, "utf8");
    }

    const errors: string[] = [];
    for (const cmd of commands.slice(0, 2)) {
      try {
        const { stdout, stderr } = await execAsync(cmd, { cwd: localPath, timeout: 30000 });
        const out = stdout + stderr;
        if (/error TS|Error:|✖|FAILED/i.test(out)) errors.push(`${cmd}:\n${out.slice(0, 2000)}`);
      } catch (err: any) {
        errors.push(`${cmd}:\n${(err.stdout || "") + (err.stderr || "") || err.message}`.slice(0, 2000));
      }
    }

    return errors.length === 0 ? { success: true, errors: "" } : { success: false, errors: errors.join("\n\n") };
  }

  private async selfReviewChanges(changes: AgentFileChange[]): Promise<{ success: boolean; errors: string }> {
    if (!changes.length) return { success: true, errors: "" };

    const changesText = changes.map((c) => `=== ${c.path} ===\n${c.content}`).join("\n\n");

    const completion = await this.getOpenAI().chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: `Review these code changes for TypeScript errors, missing imports, undefined variables, and broken logic. Be strict.
Respond with ONLY valid JSON: { "hasErrors": boolean, "errors": "description or empty string" }`,
        },
        { role: "user", content: changesText },
      ],
      temperature: 0,
      max_tokens: 800,
      response_format: { type: "json_object" },
    });

    try {
      const result = JSON.parse(completion.choices[0]?.message?.content || "{}");
      return { success: !result.hasErrors, errors: result.errors || "" };
    } catch {
      return { success: true, errors: "" };
    }
  }

  async runCodingAgent(
    userId: string,
    projectId: string,
    request: ChatRequest,
  ): Promise<AgentResponse> {
    const MAX_ITERATIONS = 3;

    const session = await this.getOrCreateSession(userId, "project", projectId, request.sessionId);
    const projectContext = await this.buildProjectContext(projectId);
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { localPath: true, githubUrl: true },
    });

    await this.saveMessage(session.id, "user", request.message);

    const snapshot = projectContext.repoSnapshot;
    const githubUrl = project?.githubUrl || "";

    // ── Stage 1: Planner ──────────────────────────────────────────────────
    const plan = await this.planTask(request.message, snapshot);

    // ── Stage 2: Context Builder ──────────────────────────────────────────
    const fileContext = await this.buildFileContext(plan.filesToRead || [], snapshot, githubUrl);
    const systemPrompt = this.buildAgentSystemPrompt(projectContext, snapshot);

    // ── Stages 3–5: Executor → Validator loop ─────────────────────────────
    let changes: AgentFileChange[] = [];
    let explanation = "";
    let commitMessage = "chore: agent changes";
    let previousErrors: string | null = null;

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const result = await this.executeChanges(
        request.message,
        plan.approach || "",
        fileContext,
        systemPrompt,
        previousErrors,
      );

      changes = result.changes || [];
      explanation = result.explanation || "";
      commitMessage = result.commitMessage || "chore: agent changes";

      if (!changes.length) break;

      const validation = project?.localPath
        ? await this.validateWithShell(changes, project.localPath, plan.validationCommands || ["tsc --noEmit"])
        : await this.selfReviewChanges(changes);

      if (validation.success) break;

      previousErrors = validation.errors;
      explanation += `\n\n[Auto-fix attempt ${i + 1}] Errors found — retrying...`;
    }

    const summary = `[Agent] ${explanation}\n\nFiles changed:\n${changes.map((c) => `- ${c.path}: ${c.description}`).join("\n")}`;
    await this.saveMessage(session.id, "assistant", summary);

    if (!session.title) await this.updateSessionTitle(session.id, request.message);

    return { explanation, changes, commitMessage, sessionId: session.id };
  }
}
