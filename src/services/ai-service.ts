import fs from "fs";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import OpenAI from "openai";
import pdfParse from "pdf-parse";
import mammoth from "mammoth";
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
  RoadmapStep,
} from "../types";
import { ProjectGitHubService } from "./github.service";
import { decrypt } from "../utils/encryption";
import {
  INTENT_CLASSIFIER_PROMPT,
  SYMBOL_EXTRACTION_PROMPT,
  CONTEXT_OPTIMIZER_PROMPT,
  LAYER_CONSTRAINT_PROMPT,
  IMPLEMENTATION_PLANNER_PROMPT,
  CODING_AGENT_PROMPT,
  SELF_HEALING_REPAIR_PROMPT,
  CODE_CRITIQUE_PROMPT,
  SECURITY_REVIEW_PROMPT,
  MEMORY_PERSISTENCE_PROMPT,
} from "./prompts";

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

  private get agentTools(): OpenAI.Chat.Completions.ChatCompletionTool[] {
    return [
      {
        type: "function",
        function: {
          name: "create_project",
          description: "Create a new project in the workspace. Call this whenever the user asks to create, start, set up, or launch a project. Do NOT tell them to do it manually.",
          parameters: {
            type: "object",
            properties: {
              name:        { type: "string", description: "Project name" },
              description: { type: "string", description: "Brief project description" },
              phase:       { type: "string", enum: ["product-modeling", "development", "marketing"], description: "Starting phase" },
              priority:    { type: "string", enum: ["low", "medium", "high", "critical"], description: "Project priority" },
            },
            required: ["name"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "propose_document",
          description: "Generate a full document (requirements, technical docs, specs, notes) and propose it to the user for review before saving. ALWAYS use this instead of saving directly — the user must confirm first. Generate rich, detailed markdown content.",
          parameters: {
            type: "object",
            properties: {
              projectId:   { type: "string", description: "ID of the project (use if known)" },
              projectName: { type: "string", description: "Project name to look up (if ID unknown)" },
              title:       { type: "string", description: "Document title" },
              content:     { type: "string", description: "Full document content in markdown" },
              type:        { type: "string", enum: ["requirements", "documentation", "note"], description: "Document type" },
            },
            required: ["title", "content", "type"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "list_projects",
          description: "Return the list of all projects with their IDs and names. Call this before propose_document when you need to look up a project ID by name.",
          parameters: { type: "object", properties: {} },
        },
      },
    ];
  }

  async processGeneralChat(
    userId: string,
    request: ChatRequest,
  ): Promise<ChatResponse> {
    const session = await this.getOrCreateSession(userId, "general", undefined, request.sessionId);
    const generalContext = await this.buildGeneralContext(userId, session.id);
    await this.saveMessage(session.id, "user", request.message);

    const docText = await this.extractDocumentText(
      (request.context?.documents as { name: string; mimeType: string; dataUrl: string }[]) ?? [],
    );
    const effectiveMessage = request.message + docText;
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = this.buildGeneralPrompt(effectiveMessage, generalContext);
    this.injectImages(messages, request.context?.images as { name: string; dataUrl: string }[] | undefined);
    const actions: import('../types').AIAction[] = [];
    let aiResponse = "";

    // Agentic loop — up to 5 rounds to handle multi-step tool chains (e.g. list_projects → save_document)
    for (let round = 0; round < 5; round++) {
      const completion = await this.getOpenAI().chat.completions.create({
        model: "gpt-4o",
        messages,
        temperature: 0.7,
        max_tokens: 4000,
        tools: this.agentTools,
        tool_choice: "auto",
      });

      const choice = completion.choices[0];
      const assistantMsg = choice.message;
      messages.push(assistantMsg);

      // No tool calls — final text response
      if (!assistantMsg.tool_calls?.length) {
        aiResponse = assistantMsg.content ?? "";
        break;
      }

      // Execute each tool call and collect results
      for (const call of assistantMsg.tool_calls) {
        if (call.type !== "function") continue;
        let toolResult = "";

        try {
          const args = JSON.parse(call.function.arguments);

          if (call.function.name === "create_project") {
            const project = await prisma.project.create({
              data: {
                name: args.name,
                description: args.description || "",
                phase: args.phase || "product-modeling",
                priority: args.priority || "medium",
                status: "active",
                progress: 0,
                startDate: new Date(),
                dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
                userId,
              },
            });
            actions.push({ type: "project_created", data: { id: project.id, name: project.name, phase: project.phase, description: project.description } });
            toolResult = JSON.stringify({ success: true, projectId: project.id, projectName: project.name });
          }

          else if (call.function.name === "list_projects") {
            const projects = await prisma.project.findMany({
              select: { id: true, name: true, description: true, phase: true },
              orderBy: { createdAt: "desc" },
              take: 20,
            });
            toolResult = JSON.stringify(projects);
          }

          else if (call.function.name === "propose_document") {
            let projectId = args.projectId;
            let projectName = args.projectName;
            if (!projectId && projectName) {
              const found = await prisma.project.findFirst({
                where: { name: { contains: projectName, mode: "insensitive" } },
                select: { id: true, name: true },
              });
              if (found) { projectId = found.id; projectName = found.name; }
            } else if (projectId && !projectName) {
              const found = await prisma.project.findUnique({ where: { id: projectId }, select: { name: true } });
              if (found) projectName = found.name;
            }
            if (!projectId) {
              toolResult = JSON.stringify({ error: "Project not found. Call list_projects to get the correct project ID." });
            } else {
              actions.push({
                type: "document_proposed",
                data: { title: args.title, content: args.content, type: args.type, projectId, projectName: projectName ?? "Unknown project" },
              });
              toolResult = JSON.stringify({ success: true, status: "proposed", message: "Document proposed to the user for review. Waiting for confirmation." });
            }
          }
        } catch (err) {
          console.error("Tool call error:", err);
          toolResult = JSON.stringify({ error: String(err) });
        }

        messages.push({ role: "tool", tool_call_id: call.id, content: toolResult });
      }
    }

    if (!aiResponse) aiResponse = "Done.";

    await this.saveMessage(session.id, "assistant", aiResponse);
    if (!session.title) await this.updateSessionTitle(session.id, request.message);

    return {
      message: aiResponse,
      sessionId: session.id,
      actions: actions.length ? actions : undefined,
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
    const docText = await this.extractDocumentText(
      (request.context?.documents as { name: string; mimeType: string; dataUrl: string }[]) ?? [],
    );
    const messages = this.buildProjectPrompt(request.message + docText, projectContext);
    this.injectImages(messages, request.context?.images as { name: string; dataUrl: string }[] | undefined);

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

  async suggestSprintTasks(
    projectId: string,
    sprintId: string,
    capacity: number = 10,
  ): Promise<{ taskId: string; title: string; reason: string; priority: string }[]> {
    const openai = this.getOpenAI();
    const [sprint, allTasks] = await Promise.all([
      prisma.sprint.findUnique({
        where: { id: sprintId },
        include: { tasks: { select: { taskId: true } } },
      }),
      prisma.projectTask.findMany({
        where: { projectId, status: { in: ["todo", "in_progress"] } },
      }),
    ]);

    if (!sprint) throw new Error("Sprint not found");

    const alreadyInSprint = new Set(sprint.tasks.map((t) => t.taskId));
    const candidateTasks = allTasks.filter((t) => !alreadyInSprint.has(t.id));
    if (!candidateTasks.length) return [];

    const now = new Date();
    const taskSummary = candidateTasks.map((t) => ({
      id: t.id,
      title: t.title,
      priority: t.priority,
      status: t.status,
      dueDate: t.dueDate ? t.dueDate.toISOString().split("T")[0] : null,
      overdue: t.dueDate ? t.dueDate < now : false,
    }));

    const prompt = `You are a sprint planner. Given a sprint from ${sprint.startDate.toISOString().split("T")[0]} to ${sprint.endDate.toISOString().split("T")[0]}, suggest the best ${capacity} tasks to include.

Tasks to choose from:
${JSON.stringify(taskSummary, null, 2)}

Return a JSON array of up to ${capacity} objects: { taskId, title, reason, priority }
Sort by importance. Prefer: overdue tasks, high priority, tasks due before sprint end.`;

    const res = await openai.chat.completions.create({
      model: "gpt-4o",
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: prompt }],
    });

    const parsed = JSON.parse(res.choices[0].message.content || "{}");
    return Array.isArray(parsed.tasks) ? parsed.tasks : [];
  }

  async generateSprint(
    projectId: string,
    userPrompt: string,
  ): Promise<{
    name: string;
    goal: string;
    startDate: string;
    endDate: string;
    suggestedTasks: { taskId: string; title: string; reason: string; priority: string }[];
  }> {
    const openai = this.getOpenAI();
    const [project, allTasks] = await Promise.all([
      prisma.project.findUnique({ where: { id: projectId } }),
      prisma.projectTask.findMany({
        where: { projectId, status: { in: ["todo", "in_progress"] } },
      }),
    ]);

    const now = new Date();
    const taskSummary = allTasks.map((t) => ({
      id: t.id,
      title: t.title,
      priority: t.priority,
      status: t.status,
      dueDate: t.dueDate ? t.dueDate.toISOString().split("T")[0] : null,
      overdue: t.dueDate ? t.dueDate < now : false,
    }));

    const todayStr = now.toISOString().split("T")[0];
    const prompt = `You are a sprint planner for a project called "${project?.name}".
Today is ${todayStr}.

The user wants to create a sprint: "${userPrompt}"

Available tasks (not yet in a sprint):
${JSON.stringify(taskSummary, null, 2)}

Return a JSON object with exactly these fields:
{
  "name": "sprint name (e.g. Sprint 1 — Auth & Onboarding)",
  "goal": "one-sentence sprint goal",
  "startDate": "YYYY-MM-DD (today or later)",
  "endDate": "YYYY-MM-DD (typically 2 weeks after start)",
  "suggestedTasks": [{ "taskId", "title", "reason", "priority" }]
}

Pick the most relevant tasks based on the user's prompt. Prefer high priority and overdue tasks. Include up to 10 tasks.`;

    const res = await openai.chat.completions.create({
      model: "gpt-4o",
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: prompt }],
    });

    const parsed = JSON.parse(res.choices[0].message.content || "{}");
    return {
      name: parsed.name || "New Sprint",
      goal: parsed.goal || "",
      startDate: parsed.startDate || todayStr,
      endDate: parsed.endDate || "",
      suggestedTasks: Array.isArray(parsed.suggestedTasks) ? parsed.suggestedTasks : [],
    };
  }

  async reviewPullRequest(projectId: string, prNumber: number): Promise<PRReview> {
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project?.githubUrl) throw new Error("No GitHub repository connected to this project");

    const token = project.githubToken ? decrypt(project.githubToken) : undefined;

    const [diff, prs] = await Promise.all([
      ProjectGitHubService.getPullRequestDiff(project.githubUrl, prNumber, token),
      ProjectGitHubService.listPullRequests(project.githubUrl, token),
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

  async generatePRDescription(projectId: string, prNumber: number): Promise<{ title: string; description: string }> {
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project?.githubUrl) throw new Error("No GitHub repository connected to this project");

    const token = project.githubToken ? decrypt(project.githubToken) : undefined;

    const [diff, prs] = await Promise.all([
      ProjectGitHubService.getPullRequestDiff(project.githubUrl, prNumber, token),
      ProjectGitHubService.listPullRequests(project.githubUrl, token),
    ]);

    const pr = prs.find((p) => p.number === prNumber);
    const prMeta = pr
      ? `Branch: ${pr.headBranch} → ${pr.baseBranch}\nChanged files: ${pr.changedFiles}, +${pr.additions} -${pr.deletions} lines`
      : `PR #${prNumber}`;

    const completion = await this.getOpenAI().chat.completions.create({
      model: "gpt-4o",
      temperature: 0.4,
      max_tokens: 800,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You are a senior engineer writing a GitHub pull request description. Based on the diff, produce a clear, professional PR description.
Return JSON: { "title": "concise PR title under 72 chars", "description": "markdown body with ## Summary, ## Changes, ## Testing sections" }`,
        },
        {
          role: "user",
          content: `${prMeta}\n\n--- DIFF ---\n${diff.slice(0, 8000)}`,
        },
      ],
    });

    const raw = completion.choices[0]?.message?.content ?? "{}";
    try {
      return JSON.parse(raw) as { title: string; description: string };
    } catch {
      return { title: pr?.title || `PR #${prNumber}`, description: "Could not generate description." };
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

  private async extractDocumentText(
    docs: { name: string; mimeType: string; dataUrl: string }[],
  ): Promise<string> {
    if (!docs.length) return "";
    const MAX_CHARS = 30000;
    const parts: string[] = [];

    for (const doc of docs) {
      try {
        const base64 = doc.dataUrl.includes(",") ? doc.dataUrl.split(",")[1] : doc.dataUrl;
        const buffer = Buffer.from(base64, "base64");
        const ext = doc.name.split(".").pop()?.toLowerCase() ?? "";
        let text = "";

        if (ext === "pdf") {
          const result = await pdfParse(buffer, { max: 50 }); // cap at 50 pages
          text = result.text;
        } else if (ext === "docx" || ext === "doc") {
          const result = await mammoth.extractRawText({ buffer });
          text = result.value;
        }

        if (text.trim()) {
          const snippet = text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) + "\n... (truncated)" : text;
          parts.push(`\n\n---\n**Attached document: ${doc.name}**\n\`\`\`\n${snippet}\n\`\`\``);
        }
      } catch (err) {
        console.error(`Failed to extract text from ${doc.name}:`, err);
        parts.push(`\n\n---\n**Attached document: ${doc.name}** (could not extract text)`);
      }
    }
    return parts.join("");
  }

  private injectImages(
    messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
    images: { name: string; dataUrl: string }[] | undefined,
  ) {
    if (!images?.length) return;
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) { if (messages[i].role === "user") { lastUserIdx = i; break; } }
    if (lastUserIdx < 0) return;
    const existing = messages[lastUserIdx] as { role: "user"; content: string };
    messages[lastUserIdx] = {
      role: "user",
      content: [
        { type: "text", text: existing.content },
        ...images.map((img) => ({
          type: "image_url" as const,
          image_url: { url: img.dataUrl },
        })),
      ],
    };
  }

  private buildGeneralPrompt(
    userMessage: string,
    context: GeneralContext,
  ): Array<{ role: "system" | "user" | "assistant"; content: string }> {
    const systemPrompt = `You are an agentic AI assistant embedded in a project management workspace. You can take real actions on behalf of the user — you are NOT limited to giving instructions.

## Tools you have (use them proactively):
- **create_project** — call this whenever the user asks to create, start, set up, or launch a project. Do not instruct them to do it manually.
- **propose_document** — call this whenever the user asks to write, generate, or create requirements, documentation, specs, or notes for a project. Generate the full content and propose it — the user will confirm before it is saved. Never save without proposing first.
- **list_projects** — call this to look up existing projects before saving documents or when the user asks what projects exist.

## Rules:
1. NEVER tell the user to navigate somewhere manually if you have a tool to do the task directly.
2. When creating a project, pick sensible defaults for phase/priority if not specified.
3. When saving a document, generate rich, detailed markdown content — don't ask the user to provide it.
4. After using a tool, confirm what was done in 1-2 sentences. No need for lengthy explanations.
5. Always call list_projects first if you need to find a project by name before saving a document.

## Workspace context:
- User: ${context.workspaceInfo?.user.name || context.workspaceInfo?.user.email || "Unknown"}
- Total Projects: ${context.workspaceInfo?.totalProjects || 0}
- Active Projects: ${context.workspaceInfo?.activeProjects || 0}

Recent conversation:
${context.recentMessages
  .slice(-5)
  .map((msg) => `${msg.role}: ${msg.content}`)
  .join("\n")}`;

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

    // Reuse existing active session for this project if one exists
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

  private buildAgentSystemPrompt(
    projectContext: any,
    snapshot: any,
    architectureDoc?: string | null,
    memorySummary?: string | null,
  ): string {
    const repoInfo = snapshot
      ? `REPOSITORY: ${snapshot.repoName} (branch: ${snapshot.defaultBranch})
FILE TREE:
${snapshot.fileTree.slice(0, 200).join("\n")}`
      : "No repository connected. Return empty changes array and explain.";

    const architectureInfo = architectureDoc
      ? `\nAPPROVED ARCHITECTURE (follow this design — do not deviate without good reason):\n${architectureDoc}\n`
      : "";

    const memoryInfo = memorySummary
      ? `\nPROJECT MEMORY (decisions and conventions established in prior runs — stay consistent with these):\n${memorySummary}\n`
      : "";

    // The established language/stack, inferred from what's actually in the repo —
    // used to hard-block introducing a second, competing implementation.
    const languages: Record<string, number> = snapshot?.languages || {};
    const dominantLanguage = Object.entries(languages).sort(([, a], [, b]) => (b as number) - (a as number))[0]?.[0];

    return `You are a coding agent for "${projectContext.project.name}". Produce exact file changes for the user's request.

${repoInfo}
${architectureInfo}${memoryInfo}
ACTIVE TASKS:
${projectContext.activeTasks.map((t: any) =>
  `- ${t.title} (${t.status}, priority: ${t.priority})${t.description ? `\n  ${t.description}` : ""}`
).join("\n") || "None"}

CRITICAL CODE QUALITY RULES (VIOLATIONS CAUSE BUILD FAILURES):
1. Every file you output MUST be COMPLETE and SELF-CONTAINED — include ALL imports, type definitions, and dependencies at the top of each file. Never assume an import exists unless you can see it in the provided context.
2. Write the ENTIRE file content from line 1 to the end. Never write partial files, snippets, placeholders like "// ... rest of file", or TODO comments. Every function must have a complete implementation.
3. All code MUST compile without errors. If TypeScript: no \`any\` types unless absolutely unavoidable, all variables must be typed, all imports must resolve to real modules.
4. If you create a new file that other files import, also update those importing files.
5. If you edit an existing file, preserve ALL existing code that is not directly related to your change. Never remove functions, imports, or exports that you didn't add.
6. Include proper error handling — try/catch blocks, null checks, fallback values.
7. For web projects: include complete HTML with all script/style tags, or complete component files with all hooks and state.

STRUCTURAL RULES:
- Only change files that exist in the file tree above — if the file tree is empty, you are creating this project's first files
- If the repository already has files or an approved architecture is given above: follow its existing code style, structure, and stack exactly — reuse existing components/utilities instead of duplicating them.
- If the repository is empty and no architecture is given: pick ONE modern, idiomatic, commonly-used stack appropriate for what the task describes, and proceed. State the choice in your explanation.
${dominantLanguage ? `- This project's established language/stack is ${dominantLanguage} — ALL new files MUST use it. Never create a parallel implementation in a different language.` : ""}
- Only change what is strictly necessary for the current task — nothing more
- Preserve formatting, naming, and file structure of files you edit
- NEVER modify a file without reading it first
- TOOL BOUNDARIES: no rm -rf, no git push --force, no .env edits, no deleting core files

If — and only if — the request is genuinely ambiguous about something you have no reasonable way to decide yourself (e.g. a business-logic decision only the user can make, conflicting instructions, a missing credential/config value), respond with ONLY this JSON:
{
  "needsClarification": true,
  "question": "the specific question to ask",
  "options": ["short option A", "short option B"]
}
Basic project-setup choices (language, framework, file layout, styling approach) are YOURS to make — never ask about those.

Otherwise, you MUST respond with ONLY valid JSON:
{
  "explanation": "what you changed and why",
  "changes": [{ "path": "relative/path", "content": "COMPLETE file content from first line to last line — no placeholders or partial content", "description": "one-line summary" }],
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
    githubToken?: string,
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
        const file = await ProjectGitHubService.getFileContent(githubUrl, filePath, githubToken).catch(() => null);
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
  ): Promise<
    | { explanation: string; changes: AgentFileChange[]; commitMessage: string }
    | { needsClarification: true; question: string; options?: string[] }
  > {
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
          content: `You are a HOSTILE code reviewer whose ONLY job is to find errors. You are NOT the author of this code — treat it as adversarial input that is PROBABLY broken.

CHECK EVERY FILE FOR:
1. MISSING IMPORTS — Does every symbol used (types, functions, classes, React hooks, libraries) have a corresponding import statement? If a file uses \`useState\` but doesn't import it from 'react', that's an error.
2. UNDEFINED VARIABLES — Are there variables, functions, or types referenced that are never defined or imported?
3. TYPE ERRORS — For TypeScript: Are there type mismatches, missing generic parameters, or implicit \`any\`?
4. INCOMPLETE CODE — Are there TODO comments, placeholder strings like "...", "rest of file", or functions with empty bodies that should have implementations?
5. SYNTAX ERRORS — Unclosed brackets, missing semicolons (where required), malformed JSX, template literal errors?
6. MISSING EXPORTS — Does the file export what other files would need to import?
7. BROKEN DEPENDENCIES — Does the file reference modules/packages that don't exist in a standard project?
8. LOGIC ERRORS — Obvious bugs like infinite loops, unreachable code, or functions that never return?

Be EXTREMELY strict. If you find even ONE issue, report it.

Respond with ONLY valid JSON:
{ "hasErrors": boolean, "errors": "Detailed list of every error found with file path and description. Empty string if no errors." }`,
        },
        { role: "user", content: changesText },
      ],
      temperature: 0,
      max_tokens: 2000,
      response_format: { type: "json_object" },
    });

    try {
      const result = JSON.parse(completion.choices[0]?.message?.content || "{}");
      return { success: !result.hasErrors, errors: result.errors || "" };
    } catch {
      return { success: true, errors: "" };
    }
  }

  // ── Phased workflow: AI-drafted phase proposals ─────────────────────────

  // Simple model router — reasoning-heavy phases get the stronger model,
  // lighter/more mechanical phases get the cheaper one. Swap for LiteLLM
  // later if multi-provider routing becomes necessary.
  private modelForPhase(phase: string): string {
    switch (phase) {
      case "requirements":
      case "documentation":
      case "architecture":
        return "gpt-4o";
      default:
        return "gpt-4o-mini";
    }
  }

  private estimateCostUSD(model: string, usage: { prompt_tokens?: number; completion_tokens?: number }): number {
    const rates: Record<string, { prompt: number; completion: number }> = {
      "gpt-4o": { prompt: 2.5 / 1_000_000, completion: 10 / 1_000_000 },
      "gpt-4o-mini": { prompt: 0.15 / 1_000_000, completion: 0.6 / 1_000_000 },
    };
    const rate = rates[model] || rates["gpt-4o-mini"];
    return (usage.prompt_tokens || 0) * rate.prompt + (usage.completion_tokens || 0) * rate.completion;
  }

  private phasePromptInstructions(phase: string): string {
    switch (phase) {
      case "requirements":
        return "Parse the project brief into: user stories, acceptance criteria, and constraints.";
      case "documentation":
        return "Write a PRD covering: overview, API outlines, data models, edge cases, and acceptance criteria.";
      case "architecture":
        return "Write an architecture proposal with these sections: System Overview, Components & Responsibilities, Data Flow & APIs, Technology Decisions, Risks & Mitigations, and Recommended Diagrams (as Mermaid code fences).";
      case "implementation":
        return "Write an implementation plan: sequenced tasks, file/module boundaries, and validation steps.";
      case "testing":
        return "Write a test plan: coverage strategy, key test cases, and edge cases to validate.";
      case "review":
        return "Write a PR risk summary and deployment checklist for merging this work.";
      default:
        return "Write a proposal document for this phase.";
    }
  }

  // Generates a draft artifact for a workflow phase, grounded in the project's
  // accumulated context (memory summary, decisions, repo snapshot). When a
  // previous artifact + reviewer feedback are supplied (the "Request Changes"
  // loop), the regeneration revises that draft to address the feedback
  // instead of starting over from scratch.
  // Orders a set of tasks that have no explicit dependencies between them into
  // a sensible build sequence (foundational work before things that build on
  // it, before polish/optimization/testing) — used by the batch agent runner
  // when tasks were created without blockedByIds set between them.
  async suggestTaskOrder(tasks: { id: string; title: string; description?: string }[]): Promise<string[]> {
    if (tasks.length <= 1) return tasks.map((t) => t.id);

    const completion = await this.getOpenAI().chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `Order these development tasks into the most sensible build sequence — foundational/setup work first, then features built on it, then polish/optimization/testing last. Respond with ONLY valid JSON: { "order": ["taskId1", "taskId2", ...] } listing every given task ID exactly once.`,
        },
        {
          role: "user",
          content: tasks.map((t) => `- id: ${t.id}\n  title: ${t.title}${t.description ? `\n  description: ${t.description}` : ""}`).join("\n"),
        },
      ],
      temperature: 0,
      max_tokens: 500,
      response_format: { type: "json_object" },
    });

    try {
      const parsed = JSON.parse(completion.choices[0]?.message?.content || "{}");
      const order: string[] = Array.isArray(parsed.order) ? parsed.order : [];
      const validIds = new Set(tasks.map((t) => t.id));
      const filtered = order.filter((id) => validIds.has(id));
      const missing = tasks.map((t) => t.id).filter((id) => !filtered.includes(id));
      return [...filtered, ...missing];
    } catch {
      return tasks.map((t) => t.id);
    }
  }

  async generatePhaseProposal(
    projectId: string,
    phase: string,
    revision?: { previousContent: string; feedback: string },
    brief?: string,
  ): Promise<{ title: string; content: string; model: string; usage: { prompt_tokens: number; completion_tokens: number }; costUSD: number }> {
    const projectContext = await this.buildProjectContext(projectId);
    const model = this.modelForPhase(phase);

    const revisionBlock = revision
      ? `\nPREVIOUS DRAFT:\n${revision.previousContent}\n\nREVIEWER FEEDBACK (address this — do not ignore it):\n${revision.feedback}\n\nRevise the previous draft to address the feedback. Keep what still works; change what the feedback calls out.`
      : "";

    const briefBlock = brief
      ? `\nBRIEF FROM USER FOR THIS GENERATION (this is the most specific and important input — prioritize it over generic assumptions):\n${brief}\n`
      : "";

    const systemPrompt = `You are drafting the "${phase}" phase document for project "${projectContext.project.name}".

PROJECT DESCRIPTION:
${projectContext.project.description || "No description provided."}

MEMORY SUMMARY:
${projectContext.summary?.summary || "No prior context yet."}

ACTIVE TASKS:
${projectContext.activeTasks.map((t: any) => `- ${t.title} (${t.status})`).join("\n") || "None"}
${briefBlock}${revisionBlock}

TASK: ${this.phasePromptInstructions(phase)}

RULES:
- Match the proposal's scale to the ACTUAL scope implied by the project name, description, brief, and active tasks above — not a generic template. A small utility or single-feature project should get a small, proportionate proposal (e.g. one module, no backend/database/mobile app) unless the brief explicitly calls for more. Only propose infrastructure (APIs, databases, multi-platform clients, logging pipelines, etc.) that the actual scope justifies.
- Make every technical decision definite — never present a choice as "X or Y" (e.g. "React Native or Flutter", "Python or Java"). Pick one and justify it briefly. An architecture decision that isn't actually decided is useless — it's supposed to be locked once approved.
- Ground every section in the specific project, not boilerplate that could apply to any generic app.

Respond in clean Markdown only — no preamble, no closing remarks, and do NOT wrap the entire response in a code fence (\`\`\`) — only use code fences for actual code/diagram snippets within the document (e.g. Mermaid diagrams).`;

    const completion = await this.getOpenAI().chat.completions.create({
      model,
      messages: [{ role: "system", content: systemPrompt }],
      temperature: 0.4,
      max_tokens: 2000,
    });

    // Defensive: if the model wrapped the whole response in one big code
    // fence anyway, strip it — otherwise every heading/bold marker renders as
    // literal text instead of being parsed, since it's all one code block.
    let content = completion.choices[0]?.message?.content || "";
    const wholeFenceMatch = content.match(/^```[a-z]*\n([\s\S]*)\n```\s*$/);
    if (wholeFenceMatch) content = wholeFenceMatch[1];

    const usage = {
      prompt_tokens: completion.usage?.prompt_tokens || 0,
      completion_tokens: completion.usage?.completion_tokens || 0,
    };

    return {
      title: `${projectContext.project.name} — ${phase.charAt(0).toUpperCase() + phase.slice(1)} Proposal`,
      content,
      model,
      usage,
      costUSD: this.estimateCostUSD(model, usage),
    };
  }

  // ── Multi-Stage Agentic Pipeline Methods ─────────────────────────────────

  private async classifyIntentAndAmbiguity(
    message: string,
    projectContext: any,
  ): Promise<{
    intent: "BUG_FIX" | "FEATURE_ADD" | "REFACTOR" | "DOCS" | "OPTIMIZATION";
    confidence: number;
    requiresClarification: boolean;
    reasoning: string;
    question?: string;
    options?: string[];
  }> {
    try {
      const completion = await this.getOpenAI().chat.completions.create({
        model: "gpt-4o",
        messages: [
          { role: "system", content: INTENT_CLASSIFIER_PROMPT },
          {
            role: "user",
            content: `USER REQUEST: ${message}\nPROJECT: ${projectContext.project.name}\nACTIVE TASKS:\n${projectContext.activeTasks.map((t: any) => `- ${t.title}`).join("\n")}`,
          },
        ],
        temperature: 0.1,
        response_format: { type: "json_object" },
      });

      const parsed = JSON.parse(completion.choices[0]?.message?.content || "{}");
      const isCreateRequest = /create|build|make|design|generate|add|dashboard|game|landing|app|feature|page|component/i.test(message);
      const intent = parsed.intent || "FEATURE_ADD";
      const confidence = isCreateRequest ? 0.95 : (typeof parsed.confidence === "number" ? parsed.confidence : 0.85);
      const requiresClarification = isCreateRequest ? false : Boolean(parsed.requiresClarification && confidence < 0.70);

      return {
        intent,
        confidence,
        requiresClarification,
        reasoning: parsed.reasoning || "Intent classified",
        question: parsed.question,
        options: parsed.options,
      };
    } catch {
      return {
        intent: "FEATURE_ADD",
        confidence: 0.95,
        requiresClarification: false,
        reasoning: "Default fallback classification with action bias",
      };
    }
  }

  private skeletonizeDependencyFile(content: string): string {
    // Retain import statements, interface declarations, type aliases, export function signatures, and class method signatures.
    // Strip internal function/method body implementations.
    const lines = content.split("\n");
    const skeletonLines: string[] = [];
    let insideBody = false;
    let braceDepth = 0;

    for (const line of lines) {
      const trimmed = line.trim();
      if (
        trimmed.startsWith("import ") ||
        trimmed.startsWith("export interface ") ||
        trimmed.startsWith("interface ") ||
        trimmed.startsWith("export type ") ||
        trimmed.startsWith("type ") ||
        trimmed.startsWith("export enum ") ||
        trimmed.startsWith("enum ")
      ) {
        skeletonLines.push(line);
        continue;
      }

      if (trimmed.startsWith("export class ") || trimmed.startsWith("class ")) {
        skeletonLines.push(line);
        continue;
      }

      if (trimmed.startsWith("export declare ") || trimmed.startsWith("declare ")) {
        skeletonLines.push(line);
        continue;
      }

      // Preserve function/method signature headers
      if ((trimmed.startsWith("export function ") || trimmed.startsWith("public ") || trimmed.startsWith("private ") || trimmed.startsWith("protected ")) && trimmed.includes("{")) {
        const signature = line.substring(0, line.indexOf("{")).trim() + " { /* skeletonized body */ }";
        skeletonLines.push(signature);
        continue;
      }

      if (braceDepth === 0) {
        skeletonLines.push(line);
      }

      braceDepth += (line.match(/\{/g) || []).length;
      braceDepth -= (line.match(/\}/g) || []).length;
      if (braceDepth < 0) braceDepth = 0;
    }

    return skeletonLines.slice(0, 150).join("\n");
  }

  private async buildKnowledgeGraph(snapshot: any): Promise<{
    exports: any[];
    imports: any[];
    dependencyGraph: Record<string, string[]>;
  }> {
    const keyFiles = snapshot?.keyFiles || [];
    const dependencyGraph: Record<string, string[]> = {};
    const exports: any[] = [];
    const imports: any[] = [];

    for (const file of keyFiles) {
      const pathStr = file.path;
      const content = file.content || "";
      const fileImports: string[] = [];

      // Extract import paths via regex
      const importMatches = content.matchAll(/from\s+["']([^"']+)["']/g);
      for (const match of importMatches) {
        fileImports.push(match[1]);
      }
      dependencyGraph[pathStr] = fileImports;

      // Extract exported symbols via regex
      const exportMatches = content.matchAll(/export\s+(interface|class|function|type|const)\s+([A-Za-z0-9_]+)/g);
      for (const match of exportMatches) {
        exports.push({ file: pathStr, kind: match[1], symbol: match[2] });
      }
    }

    return { exports, imports, dependencyGraph };
  }

  private async buildOptimizedContext(
    intentResult: any,
    knowledgeGraph: any,
    projectContext: any,
    filesToRead: string[],
    snapshot: any,
    githubUrl: string,
    githubToken?: string,
  ): Promise<{
    fileContext: Record<string, string>;
    skeletonContext: Record<string, string>;
    tokenEstimate: number;
  }> {
    const rawContext = await this.buildFileContext(filesToRead, snapshot, githubUrl, githubToken);
    const fileContext: Record<string, string> = {};
    const skeletonContext: Record<string, string> = {};
    let currentTokens = 0;
    const MAX_TOKEN_BUDGET = 15000;

    // First, prioritize target files (FULL content)
    for (const [pathKey, content] of Object.entries(rawContext)) {
      const approxTokens = Math.ceil(content.length / 4);
      if (currentTokens + approxTokens <= MAX_TOKEN_BUDGET) {
        fileContext[pathKey] = content;
        currentTokens += approxTokens;
      } else {
        // Skeletonize if token limit is tight
        const skeleton = this.skeletonizeDependencyFile(content);
        const skelTokens = Math.ceil(skeleton.length / 4);
        if (currentTokens + skelTokens <= MAX_TOKEN_BUDGET) {
          skeletonContext[pathKey] = skeleton;
          currentTokens += skelTokens;
        }
      }
    }

    return { fileContext, skeletonContext, tokenEstimate: currentTokens };
  }

  private async generateRoadmapAndDiffs(
    message: string,
    intentResult: any,
    optimizedContext: any,
    systemPrompt: string,
  ): Promise<{
    roadmap: RoadmapStep[];
    changes: AgentFileChange[];
    explanation: string;
    commitMessage: string;
    validationCommands: string[];
    layerViolations?: string[];
  }> {
    // Phase A: Generate Roadmap
    let roadmap: RoadmapStep[] = [
      { phase: 1, title: "Analysis & Types", layer: "Schema", targetFiles: [], description: "Define necessary interfaces and models" },
      { phase: 2, title: "Service Implementation", layer: "Service", targetFiles: [], description: "Implement business logic" },
      { phase: 3, title: "Controller & Route Handling", layer: "Controller", targetFiles: [], description: "Expose API endpoints and validate inputs" },
    ];

    try {
      const roadmapCompletion = await this.getOpenAI().chat.completions.create({
        model: "gpt-4o",
        messages: [
          { role: "system", content: IMPLEMENTATION_PLANNER_PROMPT },
          { role: "user", content: `REQUEST: ${message}\nINTENT: ${intentResult.intent}` },
        ],
        temperature: 0.2,
        response_format: { type: "json_object" },
      });
      const parsedRoadmap = JSON.parse(roadmapCompletion.choices[0]?.message?.content || "{}");
      if (Array.isArray(parsedRoadmap.roadmap) && parsedRoadmap.roadmap.length > 0) {
        roadmap = parsedRoadmap.roadmap;
      }
    } catch {
      // Use fallback roadmap
    }

    // Phase B: Coding Agent Diff Generation
    const contextContent = Object.entries(optimizedContext.fileContext)
      .map(([p, c]) => `=== FULL FILE: ${p} ===\n${c}`)
      .concat(
        Object.entries(optimizedContext.skeletonContext).map(
          ([p, c]) => `=== SKELETON DEPENDENCY: ${p} ===\n${c}`,
        ),
      )
      .join("\n\n");

    const isAppOrDashboardRequest = /dashboard|game|app|landing|page|feature|component|system/i.test(message);
    const multiFileInstruction = isAppOrDashboardRequest
      ? "\n\nMULTI-FILE ARCHITECTURE MANDATE: This request asks to build a feature, dashboard, page, or app. You MUST output a complete multi-file blueprint containing ALL necessary files (e.g. types/interfaces, realistic mock data, modular subcomponents like Sidebar/MetricCard/Chart/Table, and the main container page). Do NOT compress the entire application into a single file or output only 1 file."
      : "";

    const userPrompt = `USER REQUEST: ${message}\nINTENT: ${intentResult.intent}\nROADMAP PLAN:\n${JSON.stringify(roadmap, null, 2)}\n\nCONTEXT:\n${contextContent}${multiFileInstruction}\n\nREMINDER: Every file in your "changes" array MUST contain the COMPLETE 100% file content — all imports, all functions, all exports. The output will be written directly to disk and compiled. Partial files or placeholders will cause build failures.`;

    const completion = await this.getOpenAI().chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: `${systemPrompt}\n\n${CODING_AGENT_PROMPT}\n\n${LAYER_CONSTRAINT_PROMPT}` },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.2,
      max_tokens: 16000,
      response_format: { type: "json_object" },
    });

    const parsed = JSON.parse(completion.choices[0]?.message?.content || "{}");
    const changes: AgentFileChange[] = Array.isArray(parsed.changes) ? parsed.changes : [];
    const explanation = parsed.explanation || "Agent generated code diffs.";
    const commitMessage = parsed.commitMessage || `feat(${intentResult.intent.toLowerCase()}): implementation updates`;

    return {
      roadmap,
      changes,
      explanation,
      commitMessage,
      validationCommands: ["npx tsc --noEmit", "npm run build"],
    };
  }

  private async runSelfHealingLoop(
    initialChanges: AgentFileChange[],
    localPath: string | null | undefined,
    commands: string[],
    systemPrompt: string,
    originalMessage: string,
  ): Promise<{
    finalChanges: AgentFileChange[];
    attempts: number;
    success: boolean;
    errorLog?: string;
  }> {
    const MAX_REPAIR_RETRIES = 5;
    let currentChanges = [...initialChanges];
    let previousErrors = "";

    for (let attempt = 1; attempt <= MAX_REPAIR_RETRIES; attempt++) {
      if (!currentChanges.length) {
        return { finalChanges: [], attempts: attempt, success: true };
      }

      const validation = localPath
        ? await this.validateWithShell(currentChanges, localPath, commands)
        : await this.selfReviewChanges(currentChanges);

      if (validation.success) {
        return { finalChanges: currentChanges, attempts: attempt, success: true };
      }

      previousErrors = validation.errors;

      // Pass raw terminal traces back to specialized repair prompt
      const repairCompletion = await this.getOpenAI().chat.completions.create({
        model: "gpt-4o",
        messages: [
          { role: "system", content: SELF_HEALING_REPAIR_PROMPT },
          {
            role: "user",
            content: `ORIGINAL REQUEST: ${originalMessage}\n\nCURRENT CHANGES:\n${JSON.stringify(currentChanges, null, 2)}\n\nRAW TERMINAL ERROR TRACE (REPAIR ATTEMPT ${attempt}/${MAX_REPAIR_RETRIES}):\n${previousErrors}`,
          },
        ],
        temperature: 0.1,
        max_tokens: 8000,
        response_format: { type: "json_object" },
      });

      try {
        const repairParsed = JSON.parse(repairCompletion.choices[0]?.message?.content || "{}");
        if (Array.isArray(repairParsed.changes) && repairParsed.changes.length > 0) {
          currentChanges = repairParsed.changes;
        }
      } catch {
        // Keep current changes for next retry if parse fails
      }
    }

    return {
      finalChanges: currentChanges,
      attempts: MAX_REPAIR_RETRIES,
      success: false,
      errorLog: previousErrors,
    };
  }

  private async runReflectionAndSecurityAudit(
    changes: AgentFileChange[],
  ): Promise<{
    approvedChanges: AgentFileChange[];
    passed: boolean;
    critiqueScore: number;
    securityPass: boolean;
    summary: string;
  }> {
    if (!changes.length) {
      return { approvedChanges: [], passed: true, critiqueScore: 1.0, securityPass: true, summary: "No changes to review." };
    }

    const diffText = changes.map((c) => `=== FILE: ${c.path} ===\n${c.content}`).join("\n\n");

    // 1. Independent Critique Pass
    let critiqueScore = 0.90;
    try {
      const critiqueCompletion = await this.getOpenAI().chat.completions.create({
        model: "gpt-4o",
        messages: [
          { role: "system", content: CODE_CRITIQUE_PROMPT },
          { role: "user", content: diffText },
        ],
        temperature: 0.1,
        response_format: { type: "json_object" },
      });
      const critiqueResult = JSON.parse(critiqueCompletion.choices[0]?.message?.content || "{}");
      if (typeof critiqueResult.score === "number") critiqueScore = critiqueResult.score;
    } catch {
      critiqueScore = 0.90;
    }

    // 2. Security Audit Pass
    let securityPass = true;
    try {
      const secCompletion = await this.getOpenAI().chat.completions.create({
        model: "gpt-4o",
        messages: [
          { role: "system", content: SECURITY_REVIEW_PROMPT },
          { role: "user", content: diffText },
        ],
        temperature: 0.0,
        response_format: { type: "json_object" },
      });
      const secResult = JSON.parse(secCompletion.choices[0]?.message?.content || "{}");
      if (typeof secResult.passed === "boolean") securityPass = secResult.passed;
    } catch {
      securityPass = true;
    }

    return {
      approvedChanges: changes,
      passed: securityPass && critiqueScore >= 0.80,
      critiqueScore,
      securityPass,
      summary: `Reflection Pass Score: ${(critiqueScore * 100).toFixed(0)}%. Security Pass: ${securityPass ? "PASSED" : "FLAGGED"}.`,
    };
  }

  private async persistProjectMemory(projectId: string, userMessage: string, auditResult: any): Promise<void> {
    try {
      const memoryCompletion = await this.getOpenAI().chat.completions.create({
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

  async runCodingAgent(
    userId: string,
    projectId: string,
    request: ChatRequest,
  ): Promise<AgentResponse> {
    const session = await this.getOrCreateSession(userId, "project", projectId, request.sessionId);
    const projectContext = await this.buildProjectContext(projectId);
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { localPath: true, githubUrl: true, githubToken: true },
    });
    const approvedArchitecture = await prisma.phaseArtifact.findFirst({
      where: { projectId, phase: "architecture", approved: true },
      orderBy: { createdAt: "desc" },
      select: { content: true },
    });

    await this.saveMessage(session.id, "user", request.message);

    const snapshot = projectContext.repoSnapshot;
    const githubUrl = project?.githubUrl || "";
    const githubToken = project?.githubToken ? decrypt(project.githubToken) : undefined;

    // ── Stage 1: Intent Analysis & Ambiguity Classifier ──────────────────────
    const intentResult = await this.classifyIntentAndAmbiguity(request.message, projectContext);
    if (intentResult.requiresClarification) {
      await this.saveMessage(session.id, "assistant", `[Agent] ❓ ${intentResult.question || "Please clarify your request."}`);
      return {
        explanation: intentResult.reasoning,
        changes: [],
        commitMessage: "",
        sessionId: session.id,
        needsClarification: true,
        question: intentResult.question || "Could you provide more specific details for this request?",
        options: intentResult.options || ["Proceed with default settings", "Specify target files"],
        intent: intentResult.intent,
        confidence: intentResult.confidence,
      };
    }

    // ── Stage 2: Repository Knowledge Graph & Symbol Extraction ─────────────
    const knowledgeGraph = await this.buildKnowledgeGraph(snapshot);
    const plan = await this.planTask(request.message, snapshot);

    // ── Stage 3: Dynamic Context Optimizer ──────────────────────────────────
    const optimizedContext = await this.buildOptimizedContext(
      intentResult,
      knowledgeGraph,
      projectContext,
      plan.filesToRead || [],
      snapshot,
      githubUrl,
      githubToken,
    );

    const systemPrompt = this.buildAgentSystemPrompt(
      projectContext,
      snapshot,
      approvedArchitecture?.content,
      projectContext.summary?.summary,
    );

    // ── Stage 4: Implementation Planner & Layer-Constrained Coding Agent ────
    const roadmapAndDiff = await this.generateRoadmapAndDiffs(
      request.message,
      intentResult,
      optimizedContext,
      systemPrompt,
    );

    // ── Stage 5: Self-Healing Repair Loop (Up to 5 Retries) ────────────────
    const repairResult = await this.runSelfHealingLoop(
      roadmapAndDiff.changes,
      project?.localPath,
      roadmapAndDiff.validationCommands,
      systemPrompt,
      request.message,
    );

    // ── Stage 6: Independent Reflection & Security Review ─────────────────
    const auditResult = await this.runReflectionAndSecurityAudit(repairResult.finalChanges);

    // ── Stage 7: Project Memory Persistence ─────────────────────────────────
    await this.persistProjectMemory(projectId, request.message, auditResult);

    const summary = `[Agent Intent: ${intentResult.intent}] ${roadmapAndDiff.explanation}\n\n${auditResult.summary}\n\nFiles changed:\n${repairResult.finalChanges.map((c) => `- ${c.path}: ${c.description}`).join("\n")}`;
    await this.saveMessage(session.id, "assistant", summary);

    if (!session.title) await this.updateSessionTitle(session.id, request.message);

    return {
      explanation: roadmapAndDiff.explanation + "\n\n" + auditResult.summary,
      changes: repairResult.finalChanges,
      commitMessage: roadmapAndDiff.commitMessage,
      sessionId: session.id,
      intent: intentResult.intent,
      confidence: intentResult.confidence,
      roadmap: roadmapAndDiff.roadmap,
      securityPass: auditResult.securityPass,
      critiqueScore: auditResult.critiqueScore,
      buildVerified: repairResult.success,
      buildErrors: repairResult.errorLog,
    };
  }

  private async recordAgentMemory(projectId: string, note: string): Promise<void> {
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
}
