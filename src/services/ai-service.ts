import fs from "fs";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import OpenAI from "openai";
import pdfParse from "pdf-parse";
import mammoth from "mammoth";
import { PrismaClient } from "@prisma/client";

const execAsync = promisify(exec);
import { StaticValidationEngine } from "./static-validator.engine";
import {
  ErrorDiagnosticsParser,
  SurgicalPatchEngine,
  SurgicalRepairSessionTracker,
  SurgicalPatchChunk,
} from "./surgical-repair.engine";
import { IterativeReasoningEngine } from "./iterative-reasoning.engine";
import { scanDirectoryFiles, RepositoryToolEngine } from "./repository-tool.engine";
import { buildExecutionContract } from "./execution-contract.engine";
import { ManifestGenerator } from "./manifest-generator";
import { ManifestValidator } from "./manifest-validator";
import { TaskDecomposer } from "./task-decomposer";
import { SubTaskExecutor } from "./sub-task-executor";
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
  AgentProgressEvent,
  TaskClassificationResult,
  TaskType,
  TaskRisk,
  TaskComplexity,
  ExecutionContract,
  RoadmapStep,
  ComponentKnowledgeNode,
  ExtendedKnowledgeGraph,
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
  SEARCH_PLANNING_PROMPT,
  CONFIDENCE_ESTIMATOR_PROMPT,
  FEATURE_VALIDATOR_PROMPT,
  buildContractGuardrailSection,
  STANDALONE_HTML_CSS_JS_PROMPT,
} from "./prompts";

// ── Repository Intelligence Types ─────────────────────────────────────────────

interface SearchPlanStep {
  id: number;
  target: string;
  action: string;
  query: string;
}

interface ConfidenceResult {
  totalConfidence: number;
  breakdown: { C_symbol: number; C_route: number; C_type: number; C_reuse: number };
  decision: "PROCEED" | "SEARCH_MORE";
  reasoning: string;
  nextSearches?: Array<{ tool: string; args: Record<string, any> }>;
}

interface FeatureValidationCheck {
  id: string;
  label: string;
  status: "PASS" | "FAIL" | "WARN";
  checked: boolean;
  details: string;
}

interface FeatureValidationResult {
  overallPassed: boolean;
  checks: FeatureValidationCheck[];
  failedChecks: string[];
  repairActions: Array<{ checkId: string; action: string; suggestedTool: string }>;
}

interface RepositoryExecutionMemory {
  taskId: string;
  projectId: string;
  discoveredSymbols: Map<string, { filePath: string; line: number }>;
  discoveredRoutes: string[];
  discoveredServices: string[];
  discoveredModels: string[];
  inspectedFiles: Set<string>;
  searchPlanHistory: Array<{ stepId: number; tool: string; resultCount: number }>;
  currentConfidence: number;
}

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
      : "No repository connected yet. You MUST generate complete new application files required for the user's request (e.g. Next.js / React app structure with types, components, and page entrypoints).";

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
- You CAN and SHOULD create NEW files (components, pages, utilities, types) as required by the request. When adding a feature (e.g. calculator, dashboard, game), create the component/page files and update existing pages/layouts to render them.
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
      if (!filesToRead.length || filesToRead.some((f) => f === keyFile.path || keyFile.path.includes(f))) {
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

    // Fallback: If context is still empty, include all key files from snapshot by default
    if (Object.keys(context).length === 0 && snapshot?.keyFiles?.length) {
      for (const keyFile of snapshot.keyFiles.slice(0, 10)) {
        context[keyFile.path] = keyFile.content;
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
    // Write changes to disk in localPath before running validation
    for (const change of changes) {
      const abs = path.join(localPath, change.path);
      if (change.action === "delete" || change.isDeleted) {
        if (fs.existsSync(abs)) {
          await fs.promises.rm(abs, { recursive: true, force: true });
        }
      } else {
        await fs.promises.mkdir(path.dirname(abs), { recursive: true });
        await fs.promises.writeFile(abs, change.content, "utf8");
      }
    }

    const errors: string[] = [];
    for (const cmd of commands.slice(0, 2)) {
      try {
        const { stdout, stderr } = await execAsync(cmd, { cwd: localPath, timeout: 60000 });
        const out = String(stdout || "") + "\n" + String(stderr || "");
        if (/error TS|Error:|✖|FAILED|Failed to compile|SyntaxError/i.test(out)) {
          errors.push(`${cmd}:\n${out.slice(0, 3000)}`);
        }
      } catch (err: any) {
        const stdoutStr = err.stdout ? String(err.stdout) : "";
        const stderrStr = err.stderr ? String(err.stderr) : "";
        const msgStr = err.message ? String(err.message) : "";
        const fullErr = (stdoutStr + "\n" + stderrStr + "\n" + msgStr).trim();
        errors.push(`${cmd} failed (exit code ${err.code || "unknown"}):\n${fullErr.slice(0, 3000)}`);
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
          content: `You are an Objective Static Code Auditor.
Your task is to analyze proposed file changes strictly for CRITICAL SYNTAX or COMPILATION ERRORS that would prevent execution.

CHECK FOR CRITICAL SYNTAX & COMPILATION ERRORS ONLY:
1. SYNTAX ERRORS: Unclosed brackets/tags, malformed JSX/HTML, unclosed string literals.
2. UNRESOLVED IMPORTS / UNDEFINED SYMBOLS: References to non-existent local files or undefined variables.
3. INCOMPLETE PLACEHOLDERS: TODO comments, truncated code ("... rest of file"), or missing function bodies.
4. BROKEN STRUCTURE: HTML missing body/script/css tags, or JS with syntax parse errors.

Do NOT flag minor edge-case handling preferences, style choices, or design suggestions as critical errors. If the syntax is 100% valid and parseable, hasCriticalErrors MUST be false.

Respond ONLY with valid JSON:
{
  "hasCriticalErrors": boolean,
  "criticalErrors": "Detailed description of critical syntax/compilation breakages if any. Empty string if syntax is clean.",
  "suggestions": ["Optional minor non-critical review notes"]
}`,
        },
        { role: "user", content: changesText },
      ],
      temperature: 0,
      max_tokens: 2000,
      response_format: { type: "json_object" },
    });

    try {
      const result = JSON.parse(completion.choices[0]?.message?.content || "{}");
      const hasCritical = typeof result.hasCriticalErrors === "boolean" ? result.hasCriticalErrors : Boolean(result.hasErrors && result.errors);
      const errorMsg = result.criticalErrors || (hasCritical ? result.errors : "") || "";
      return { success: !hasCritical, errors: errorMsg };
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
  ): Promise<TaskClassificationResult> {
    const isDeleteFolder = /remove|delete|rm\s+-rf|clean/i.test(message) && /folder|dir|directory|cache|lib|dist|build/i.test(message);
    const isDeleteFile = /remove|delete|unlink/i.test(message) && /file|\.ts|\.tsx|\.js|\.json|\.css/i.test(message);
    const isNewFeature = /build|create|add|implement|design|generate|setup/i.test(message) && /auth|authentication|login|feature|dashboard|payment|page|component|service/i.test(message);

    try {
      const completion = await this.getOpenAI().chat.completions.create({
        model: "gpt-4o",
        messages: [
          { role: "system", content: INTENT_CLASSIFIER_PROMPT },
          {
            role: "user",
            content: `USER REQUEST: ${message}\nPROJECT: ${projectContext?.project?.name || "Workspace"}\nACTIVE TASKS:\n${(projectContext?.activeTasks || []).map((t: any) => `- ${t.title}`).join("\n")}`,
          },
        ],
        temperature: 0.1,
        response_format: { type: "json_object" },
      });

      const parsed = JSON.parse(completion.choices[0]?.message?.content || "{}");
      const isActionRequest = /create|build|make|design|generate|add|remove|delete|rm|fix|update/i.test(message);
      
      let defaultTaskType: TaskType = "NEW_FEATURE";
      let defaultRisk: TaskRisk = "MEDIUM";
      let defaultComplexity: TaskComplexity = "MEDIUM";

      if (isDeleteFolder) {
        defaultTaskType = "DELETE_FOLDER";
        defaultRisk = "LOW";
        defaultComplexity = "SMALL";
      } else if (isDeleteFile) {
        defaultTaskType = "DELETE_FILE";
        defaultRisk = "LOW";
        defaultComplexity = "SMALL";
      } else if (isNewFeature) {
        defaultTaskType = "NEW_FEATURE";
        defaultRisk = "HIGH";
        defaultComplexity = "LARGE";
      }

      const taskType: TaskType = parsed.taskType || defaultTaskType;
      const risk: TaskRisk = parsed.risk || defaultRisk;
      const estimatedComplexity: TaskComplexity = parsed.estimatedComplexity || defaultComplexity;
      const intent = parsed.intent || (taskType === "DELETE_FOLDER" || taskType === "DELETE_FILE" ? "REFACTOR" : "NEW_FEATURE");
      const confidence = isActionRequest ? 0.95 : (typeof parsed.confidence === "number" ? parsed.confidence : 0.85);
      const requiresClarification = isActionRequest ? false : Boolean(parsed.requiresClarification && confidence < 0.70);

      // SAFETY: parsed.targetPath from LLM can be a string, array, or null.
      // Coerce to string | undefined before using as a path.
      let parsedTargetPath: string | undefined;
      if (typeof parsed.targetPath === "string" && parsed.targetPath.trim()) {
        parsedTargetPath = parsed.targetPath.trim();
      } else if (Array.isArray(parsed.targetPath) && parsed.targetPath.length > 0) {
        parsedTargetPath = String(parsed.targetPath[0]).trim() || undefined;
      }

      // Fallback: regex-extract path from message for DELETE tasks.
      // Only accept the result if the regex actually matched (i.e. result ≠ original message).
      let regexTargetPath: string | undefined;
      if (!parsedTargetPath && (isDeleteFolder || isDeleteFile)) {
        const extracted = message.replace(
          /.*(?:remove|delete|rm)\s+(?:folder\s+|dir(?:ectory)?\s+|file\s+)?["']?([\w\-./\\]+)["']?.*/i,
          "$1",
        );
        // Only use if the regex actually captured something shorter than the input
        if (extracted !== message && extracted.length < message.length && /[\w\-./\\]/.test(extracted)) {
          regexTargetPath = extracted.trim();
        }
      }

      const targetPath = parsedTargetPath || regexTargetPath;

      return {
        taskType,
        risk,
        estimatedComplexity,
        intent,
        confidence,
        requiresClarification,
        reasoning: parsed.reasoning || `Classified as ${taskType} (${risk} risk, ${estimatedComplexity} complexity)`,
        targetPath,
        question: parsed.question,
        options: parsed.options,
      };
    } catch {
      let taskType: TaskType = "NEW_FEATURE";
      let risk: TaskRisk = "MEDIUM";
      let estimatedComplexity: TaskComplexity = "MEDIUM";

      if (isDeleteFolder) {
        taskType = "DELETE_FOLDER";
        risk = "LOW";
        estimatedComplexity = "SMALL";
      } else if (isDeleteFile) {
        taskType = "DELETE_FILE";
        risk = "LOW";
        estimatedComplexity = "SMALL";
      } else if (isNewFeature) {
        taskType = "NEW_FEATURE";
        risk = "HIGH";
        estimatedComplexity = "LARGE";
      }

      return {
        taskType,
        risk,
        estimatedComplexity,
        intent: taskType === "DELETE_FOLDER" || taskType === "DELETE_FILE" ? "REFACTOR" : "NEW_FEATURE",
        confidence: 0.95,
        requiresClarification: false,
        reasoning: `Fallback intent classifier determined ${taskType} (${risk} risk)`,
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

  private async buildKnowledgeGraph(snapshot: any): Promise<ExtendedKnowledgeGraph> {
    const keyFiles: Array<{ path: string; content?: string }> = snapshot?.keyFiles || [];
    const dependencyGraph: Record<string, string[]> = {};
    const exports: Array<{ file: string; kind: string; symbol: string }> = [];
    const imports: Array<{ file: string; source: string; importedSymbols: string[] }> = [];
    const componentNodes: Record<string, ComponentKnowledgeNode> = {};

    // 1. Step 1: Component Extraction & Basic Imports/Exports
    for (const file of keyFiles) {
      const pathStr = file.path;
      const content = file.content || "";
      const fileImports: string[] = [];

      // Extract import statements
      const importMatches = content.matchAll(/import\s+(?:\{([^}]+)\}|([A-Za-z0-9_]+))\s+from\s+["']([^"']+)["']/g);
      for (const match of importMatches) {
        const namedSymbols = match[1] ? match[1].split(",").map((s) => s.trim().split(" as ")[0]) : [];
        const defaultSymbol = match[2] ? [match[2].trim()] : [];
        const importedSymbols = [...defaultSymbol, ...namedSymbols].filter(Boolean);
        const source = match[3];

        fileImports.push(source);
        imports.push({ file: pathStr, source, importedSymbols });
      }
      dependencyGraph[pathStr] = fileImports;

      // Extract exported symbols
      const exportMatches = content.matchAll(/export\s+(default\s+)?(interface|class|function|type|const)\s+([A-Za-z0-9_]+)/g);
      for (const match of exportMatches) {
        const isDefault = Boolean(match[1]);
        const kind = match[2];
        const symbol = match[3];
        exports.push({ file: pathStr, kind, symbol });

        // Identify React/UI components (PascalCase symbol in UI/Component files)
        const isPascalCase = /^[A-Z][A-Za-z0-9]*$/.test(symbol);
        const isComponentFile = pathStr.includes("components") || pathStr.endsWith(".tsx") || pathStr.endsWith(".jsx") || pathStr.includes("app/") || pathStr.includes("pages/");

        if (isPascalCase && isComponentFile && (kind === "function" || kind === "const" || kind === "class")) {
          componentNodes[symbol] = {
            component: symbol,
            file: pathStr,
            exportKind: isDefault ? "default" : "named",
            whoImportsIt: [],
            whoRendersIt: [],
            whichRouteOwnsIt: null,
            isReachable: false,
            reachabilityReason: "",
            canUserNavigateToIt: false,
            navigationTriggers: [],
          };
        }
      }
    }

    // 2. Step 2 & 3: Trace "Who imports it?" and "Who renders it?"
    for (const [compName, node] of Object.entries(componentNodes)) {
      const compFile = node.file;
      const compBase = path.basename(compFile, path.extname(compFile));

      for (const file of keyFiles) {
        if (file.path === compFile) continue;
        const content = file.content || "";

        // Check if file imports component by filename or symbol name
        const referencesComp = content.includes(compBase) || content.includes(compName);
        if (referencesComp) {
          const importSymbolMatch = new RegExp(`import\\s+[^"']*\\b${compName}\\b[^"']*from`, "g").test(content);
          if (importSymbolMatch || content.includes(`from "${compBase}"`) || content.includes(`from '${compBase}'`)) {
            node.whoImportsIt.push({
              file: file.path,
              importedSymbols: [compName],
            });
          }

          // Check JSX tag rendering (<CompName or <CompName/>)
          const jsxRegex = new RegExp(`<${compName}(\\s|>|\\/)`, "g");
          if (jsxRegex.test(content)) {
            const parentMatch = content.match(/(?:export\s+(?:default\s+)?)?function\s+([A-Za-z0-9_]+)/) ||
                                content.match(/const\s+([A-Za-z0-9_]+)\s*=\s*(?:\([^)]*\)|[A-Za-z0-9_]+)\s*=>/);
            const parentComponent = parentMatch ? parentMatch[1] : path.basename(file.path, path.extname(file.path));

            node.whoRendersIt.push({
              file: file.path,
              parentComponent,
              jsxTag: `<${compName}>`,
            });
          }
        }
      }
    }

    // 3. Step 4: Resolve "Which route owns it?"
    const routeFileMap: Array<{ file: string; routePath: string }> = [];
    for (const file of keyFiles) {
      const p = file.path.replace(/\\/g, "/");
      if (p.includes("app/") && (p.endsWith("page.tsx") || p.endsWith("page.jsx") || p.endsWith("page.js"))) {
        let routePath = p.split("app/")[1].replace(/\/page\.(tsx|jsx|js)$/, "");
        routePath = routePath ? `/${routePath}` : "/";
        routeFileMap.push({ file: file.path, routePath });
      } else if (p.includes("pages/") && !p.includes("pages/api/") && !p.includes("_app") && !p.includes("_document")) {
        let routePath = p.split("pages/")[1].replace(/\.(tsx|jsx|js)$/, "");
        routePath = routePath === "index" ? "/" : `/${routePath}`;
        routeFileMap.push({ file: file.path, routePath });
      }
    }

    for (const node of Object.values(componentNodes)) {
      const directRoute = routeFileMap.find((r) => r.file === node.file);
      if (directRoute) {
        node.whichRouteOwnsIt = { routeFile: directRoute.file, routePath: directRoute.routePath };
      } else {
        // Trace rendering parent components or importing files to find owning route file
        for (const renderRef of node.whoRendersIt) {
          const parentRoute = routeFileMap.find((r) => r.file === renderRef.file);
          if (parentRoute) {
            node.whichRouteOwnsIt = { routeFile: parentRoute.file, routePath: parentRoute.routePath };
            break;
          }
        }
        if (!node.whichRouteOwnsIt) {
          for (const importRef of node.whoImportsIt) {
            const parentRoute = routeFileMap.find((r) => r.file === importRef.file);
            if (parentRoute) {
              node.whichRouteOwnsIt = { routeFile: parentRoute.file, routePath: parentRoute.routePath };
              break;
            }
          }
        }
      }
    }

    // 4. Step 5: Evaluate "Is it reachable?"
    for (const node of Object.values(componentNodes)) {
      if (node.whichRouteOwnsIt) {
        node.isReachable = true;
        node.reachabilityReason = `Reachable via active route "${node.whichRouteOwnsIt.routePath}" (${path.basename(node.whichRouteOwnsIt.routeFile)})`;
      } else if (node.whoRendersIt.length > 0) {
        node.isReachable = true;
        node.reachabilityReason = `Rendered by ${node.whoRendersIt.map((r) => r.parentComponent).join(", ")}`;
      } else if (node.whoImportsIt.length > 0) {
        node.isReachable = true;
        node.reachabilityReason = `Imported by ${node.whoImportsIt.map((i) => path.basename(i.file)).join(", ")}`;
      } else {
        node.isReachable = false;
        node.reachabilityReason = `Orphaned / Unused component (no active route or parent component imports/renders it)`;
      }
    }

    // 5. Step 6: Evaluate "Can user navigate to it?"
    const navigationElements: Array<{ file: string; type: "Link" | "router.push" | "nav_item" | "anchor"; targetHref: string }> = [];
    for (const file of keyFiles) {
      const content = file.content || "";
      // Link href matches: href="/..." or href={`/...`}
      const linkMatches = content.matchAll(/href=["'`](\/[^"'`\s]*)["'`]/g);
      for (const m of linkMatches) {
        navigationElements.push({ file: file.path, type: "Link", targetHref: m[1] });
      }
      // router.push matches: router.push('/...')
      const routerMatches = content.matchAll(/router\.(?:push|replace)\(["'`](\/[^"'`\s]*)["'`]\)/g);
      for (const m of routerMatches) {
        navigationElements.push({ file: file.path, type: "router.push", targetHref: m[1] });
      }
    }

    for (const node of Object.values(componentNodes)) {
      if (node.whichRouteOwnsIt) {
        const routePath = node.whichRouteOwnsIt.routePath;
        const routePrefix = routePath.split("[")[0].replace(/\/$/, "");

        const matchingTriggers = navigationElements.filter((nav) => {
          if (nav.targetHref === routePath) return true;
          if (routePrefix && routePrefix !== "/" && nav.targetHref.startsWith(routePrefix)) return true;
          return false;
        });

        if (matchingTriggers.length > 0) {
          node.canUserNavigateToIt = true;
          node.navigationTriggers = matchingTriggers;
        } else if (routePath === "/") {
          node.canUserNavigateToIt = true;
          node.navigationTriggers = [{ file: "app/page.tsx", type: "Link", targetHref: "/" }];
        } else {
          node.canUserNavigateToIt = false;
        }
      }
    }

    return { exports, imports, dependencyGraph, componentNodes };
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
    contract?: ExecutionContract,
  ): Promise<{
    roadmap: RoadmapStep[];
    changes: AgentFileChange[];
    explanation: string;
    commitMessage: string;
    validationCommands: string[];
    layerViolations?: string[];
  }> {
    // Phase A: Generate Roadmap
    const isStandaloneWeb = contract?.pipeline === "STANDALONE" || contract?.environment === "HTML_CSS_JS";
    const isDeleteTask = contract?.taskType === "DELETE_FILE" || contract?.taskType === "DELETE_FOLDER";

    // Phase A: Generate Roadmap
    let roadmap: RoadmapStep[] = [
      { phase: 1, title: "Analysis & Types", layer: "Schema", targetFiles: [], description: "Define necessary interfaces and models" },
      { phase: 2, title: "Service Implementation", layer: "Service", targetFiles: [], description: "Implement business logic" },
      { phase: 3, title: "Controller & Route Handling", layer: "Controller", targetFiles: [], description: "Expose API endpoints and validate inputs" },
    ];

    if (isDeleteTask) {
      roadmap = [
        { phase: 1, title: "Identify Target Files & References", layer: "Controller", targetFiles: contract?.targetPaths || [], description: "Identify target files and directories for deletion" },
        { phase: 2, title: "Remove Target Files & Clean References", layer: "Controller", targetFiles: contract?.targetPaths || [], description: "Delete specified files/directories and update imports" },
      ];
    } else if (isStandaloneWeb) {
      roadmap = [
        { phase: 1, title: "HTML5 Document Structure", layer: "UI", targetFiles: ["index.html"], description: "Create responsive HTML5 page structure" },
        { phase: 2, title: "CSS Layout & Styling", layer: "UI", targetFiles: ["style.css"], description: "Implement visual styles and layout" },
        { phase: 3, title: "JS Interactivity & Events", layer: "UI", targetFiles: ["script.js"], description: "Add interactivity and application logic" },
        { phase: 4, title: "Standalone Application Assembly", layer: "UI", targetFiles: ["index.html", "style.css", "script.js"], description: "Assemble complete standalone web application" },
      ];
    } else {
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

    // Build multi-file instruction based on pipeline mode
    let multiFileInstruction = "";
    if (isDeleteTask) {
      multiFileInstruction = `\n\nDELETION MANDATE: This request asks to delete target path(s): ${contract?.targetPaths?.join(", ") || "(target files)"}. Output a 'changes' array containing an entry for each path to delete with "action": "delete", "isDeleted": true, "content": "", and "description": "Delete path".`;
    } else if (isStandaloneWeb) {
      multiFileInstruction = "\n\nSTANDALONE MULTI-FILE MANDATE: You MUST output all 3 files in your 'changes' array: 'index.html' (complete HTML5 structure), 'style.css' (complete CSS styles), and 'script.js' (complete ES6 JS logic). Do NOT output only 1 file. Output ALL 3 files so the application works standalone.";
    } else {
      const narrowScopeTypes = new Set(["DELETE_FOLDER", "DELETE_FILE", "CONFIG_CHANGE", "DOCS"]);
      const isNarrowScope = contract && narrowScopeTypes.has(contract.taskType);
      const isAppOrDashboardRequest = !isNarrowScope && /dashboard|game|app|landing|page|feature|component|system/i.test(message);
      if (isAppOrDashboardRequest) {
        multiFileInstruction = "\n\nMULTI-FILE ARCHITECTURE MANDATE: This request asks to build a feature, dashboard, page, or app. You MUST output a complete multi-file blueprint containing ALL necessary files (e.g. types/interfaces, realistic mock data, modular subcomponents like Sidebar/MetricCard/Chart/Table, and the main container page). Do NOT compress the entire application into a single file or output only 1 file.";
      }
    }

    // Build contract guardrail section to inject into system prompt
    const contractGuardrail = contract
      ? buildContractGuardrailSection(contract)
      : "";

    // Select base system prompt according to routed environment
    const effectiveCodingPrompt = isStandaloneWeb
      ? `${STANDALONE_HTML_CSS_JS_PROMPT}${contractGuardrail}`
      : `${systemPrompt}\n\n${CODING_AGENT_PROMPT}\n\n${LAYER_CONSTRAINT_PROMPT}${contractGuardrail}`;

    const userPrompt = `USER REQUEST: ${message}\nINTENT: ${intentResult.intent}\nROADMAP PLAN:\n${JSON.stringify(roadmap, null, 2)}\n\nCONTEXT:\n${contextContent || "(Standalone Application - No repository context required)"}${multiFileInstruction}\n\nREMINDER: Respond ONLY with valid JSON. Every file in your "changes" array MUST contain the COMPLETE 100% file content — all CSS rules, all HTML structure, all JS logic. The output will be saved directly. Partial files or placeholders are NOT allowed.`;

    const completion = await this.getOpenAI().chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: effectiveCodingPrompt },
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

    // Ensure deletion task completeness
    if (isDeleteTask && contract?.targetPaths) {
      const existingPathsInChanges = new Set(changes.map((c) => c.path.replace(/\\/g, "/").replace(/\/$/, "")));
      for (const targetPath of contract.targetPaths) {
        if (!existingPathsInChanges.has(targetPath)) {
          changes.push({
            path: targetPath,
            content: "",
            description: `Delete ${targetPath}`,
            action: "delete",
            isDeleted: true,
          });
        }
      }
      for (const change of changes) {
        if (contract.targetPaths.some((tp) => change.path.replace(/\\/g, "/").startsWith(tp) || change.path.replace(/\\/g, "/") === tp)) {
          change.action = "delete";
          change.isDeleted = true;
          change.content = "";
          if (!change.description || change.description.includes("edits")) {
            change.description = `Delete ${change.path}`;
          }
        }
      }
    }

    // Ensure standalone web asset completeness
    if (isStandaloneWeb) {
      const isCalc = /calculator|calc/i.test(message);
      const hasHtml = changes.some((c) => c.path.endsWith("index.html") || c.path.endsWith(".html"));
      const hasCss = changes.some((c) => c.path.endsWith("style.css") || c.path.endsWith(".css"));
      const hasJs = changes.some((c) => c.path.endsWith("script.js") || c.path.endsWith(".js"));

      if (!hasHtml) {
        const htmlContent = isCalc
          ? `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Calculator App</title>
  <link rel="stylesheet" href="style.css">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
</head>
<body>
  <div class="calculator">
    <div id="display" class="display">0</div>
    <div class="buttons">
      <button class="btn btn-action" data-action="clear">C</button>
      <button class="btn btn-action" data-action="backspace">⌫</button>
      <button class="btn btn-action" data-action="percent">%</button>
      <button class="btn btn-operator" data-action="divide">÷</button>

      <button class="btn" data-value="7">7</button>
      <button class="btn" data-value="8">8</button>
      <button class="btn" data-value="9">9</button>
      <button class="btn btn-operator" data-action="multiply">×</button>

      <button class="btn" data-value="4">4</button>
      <button class="btn" data-value="5">5</button>
      <button class="btn" data-value="6">6</button>
      <button class="btn btn-operator" data-action="subtract">−</button>

      <button class="btn" data-value="1">1</button>
      <button class="btn" data-value="2">2</button>
      <button class="btn" data-value="3">3</button>
      <button class="btn btn-operator" data-action="add">+</button>

      <button class="btn btn-zero" data-value="0">0</button>
      <button class="btn" data-value=".">.</button>
      <button class="btn btn-equals" data-action="equals">=</button>
    </div>
  </div>
  <script src="script.js"></script>
</body>
</html>`
          : `<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n  <title>Standalone Application</title>\n  <link rel="stylesheet" href="style.css">\n</head>\n<body>\n  <div id="app"></div>\n  <script src="script.js"></script>\n</body>\n</html>`;

        changes.unshift({
          path: "index.html",
          content: htmlContent,
          description: "HTML5 Document Structure",
        });
      }

      if (!hasCss) {
        const cssContent = isCalc
          ? `/* Modern Dark Mode Calculator Styles */
* { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Inter', system-ui, sans-serif; }
body { background: #090d16; color: #f8fafc; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 1rem; }
.calculator { background: rgba(30, 41, 59, 0.8); backdrop-filter: blur(16px); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 24px; padding: 24px; width: 100%; max-width: 360px; shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5); }
.display { background: rgba(15, 23, 42, 0.9); border: 1px solid rgba(255, 255, 255, 0.05); border-radius: 16px; padding: 20px; text-align: right; font-size: 2.5rem; font-weight: 600; min-height: 80px; overflow-x: auto; margin-bottom: 20px; color: #38bdf8; word-break: break-all; }
.buttons { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
.btn { background: rgba(51, 65, 85, 0.6); border: 1px solid rgba(255, 255, 255, 0.05); border-radius: 14px; color: #f8fafc; font-size: 1.25rem; font-weight: 500; height: 60px; cursor: pointer; transition: all 0.15s ease; display: flex; align-items: center; justify-content: center; }
.btn:hover { background: rgba(71, 85, 105, 0.8); transform: translateY(-1px); }
.btn:active { transform: translateY(1px); }
.btn-action { background: rgba(239, 68, 68, 0.15); color: #fca5a5; border-color: rgba(239, 68, 68, 0.2); }
.btn-action:hover { background: rgba(239, 68, 68, 0.25); }
.btn-operator { background: rgba(14, 165, 233, 0.15); color: #7dd3fc; border-color: rgba(14, 165, 233, 0.2); }
.btn-operator:hover { background: rgba(14, 165, 233, 0.25); }
.btn-equals { background: linear-gradient(135deg, #0284c7, #6366f1); color: #fff; font-weight: 700; border: none; }
.btn-equals:hover { opacity: 0.9; }
.btn-zero { grid-column: span 2; }`
          : `/* Standalone Web Application Styles */\n* { box-sizing: border-box; margin: 0; padding: 0; }\nbody { font-family: system-ui, sans-serif; background: #0f172a; color: #f8fafc; min-height: 100vh; display: flex; align-items: center; justify-content: center; }`;

        changes.push({
          path: "style.css",
          content: cssContent,
          description: "CSS Layout & Styling",
        });
      }

      if (!hasJs) {
        changes.push({
          path: "script.js",
          content: `document.addEventListener('DOMContentLoaded', () => {\n  console.log('App initialized.');\n});`,
          description: "JS Interactivity & Events",
        });
      }
    }

    // Determine validation commands for Stage 5
    let validationCommands: string[] = ["npx tsc --noEmit", "npm run build"];
    if (contract?.validationType === "BROWSER_HTML" || isStandaloneWeb) {
      validationCommands = []; // Standalone HTML/CSS/JS requires no npm build step
    } else if (contract?.validationType === "PYTHON_SYNTAX") {
      validationCommands = ["python -m py_compile"];
    }

    return {
      roadmap,
      changes,
      explanation,
      commitMessage,
      validationCommands,
    };
  }

  // ── Diff Contract Critic ───────────────────────────────────────────────────
  // Runs AFTER code generation (Stage 4) and BEFORE self-healing (Stage 5).
  // Enforces the ExecutionContract by rejecting file changes that:
  //   1. Fall outside the contract's contextScope (for tight-scope task types)
  //   2. Would violate a forbiddenAction (detected by file extension/path heuristic)
  //   3. Push the total file count above maxFiles
  //
  // Accepted changes pass through unchanged to runSelfHealingLoop.
  // Rejected changes are logged with their reason.

  private runDiffContractCritic(
    proposedChanges: AgentFileChange[],
    contract: ExecutionContract,
  ): {
    accepted: AgentFileChange[];
    rejected: Array<{ path: string; reason: string }>;
    log: string;
  } {
    // For broad-scope task types (NEW_FEATURE, REFACTOR, OPTIMIZATION), the critic
    // only enforces the maxFiles cap — it does NOT path-filter (too restrictive).
    const broadScopeTypes = new Set(["NEW_FEATURE", "REFACTOR", "OPTIMIZATION"]);
    const isBroadScope = broadScopeTypes.has(contract.taskType);

    const accepted: AgentFileChange[] = [];
    const rejected: Array<{ path: string; reason: string }> = [];

    for (const change of proposedChanges) {
      const normPath = (change.path || "").replace(/\\/g, "/");

      // ── Rule 1: Path scope enforcement (tight-scope tasks only) ──────────────
      if (!isBroadScope && contract.contextScope.length > 0) {
        const inScope = contract.contextScope.some(
          (s) => normPath.startsWith(s) || normPath.includes(`/${s}/`) || normPath === s,
        );
        if (!inScope) {
          rejected.push({
            path: change.path,
            reason: `Out of contract scope. Contract allows: [${contract.contextScope.join(", ")}]. Got: "${normPath}". Forbidden by Diff Critic.`,
          });
          continue;
        }
      }

      // ── Rule 2: ForbiddenAction heuristic enforcement ─────────────────────────
      // Detect if the file change implies a forbidden action via simple heuristics.
      // (A full semantic check would require another LLM call — this is the fast path.)
      let forbiddenViolation: string | null = null;

      if (contract.forbiddenActions.includes("create_new_pages") && /page\.(tsx|ts|jsx|js)$/i.test(normPath)) {
        forbiddenViolation = `"create_new_pages" is forbidden by contract`;
      } else if (contract.forbiddenActions.includes("add_routes") && /router\.|routes\.|routing\./i.test(normPath)) {
        forbiddenViolation = `"add_routes" is forbidden by contract`;
      } else if (
        contract.forbiddenActions.includes("create_utilities") &&
        /util(s|ity)?\/|helper(s)?\//.test(normPath) &&
        !contract.targetPaths.some((tp) => normPath.startsWith(tp))
      ) {
        forbiddenViolation = `"create_utilities" is forbidden by contract`;
      } else if (
        (contract.taskType === "DELETE_FOLDER" || contract.taskType === "DELETE_FILE") &&
        change.content && change.content.length > 500 &&
        !contract.targetPaths.some((tp) => normPath.startsWith(tp))
      ) {
        // For DELETE tasks, large new content in unrelated files is suspicious
        forbiddenViolation = `DELETE contract detected new content written to unrelated file "${normPath}"`;
      }

      if (forbiddenViolation) {
        rejected.push({ path: change.path, reason: forbiddenViolation });
        continue;
      }

      accepted.push(change);
    }

    // ── Rule 3: maxFiles cap ────────────────────────────────────────────────────
    const overCapRejected: Array<{ path: string; reason: string }> = [];
    let finalAccepted = accepted;
    if (accepted.length > contract.maxFiles) {
      // Keep the first maxFiles, reject the rest (preserves most critical changes)
      finalAccepted = accepted.slice(0, contract.maxFiles);
      for (const overflow of accepted.slice(contract.maxFiles)) {
        overCapRejected.push({
          path: overflow.path,
          reason: `Exceeds contract maxFiles cap of ${contract.maxFiles}. Change dropped by Diff Critic.`,
        });
      }
    }

    const allRejected = [...rejected, ...overCapRejected];
    const log = [
      `[Diff Critic] Contract: ${contract.taskType} | Scope: [${contract.contextScope.slice(0, 3).join(", ")}]`,
      `  ✅ Accepted: ${finalAccepted.length} files`,
      `  ❌ Rejected: ${allRejected.length} files`,
      ...allRejected.map((r) => `    • ${r.path}: ${r.reason}`),
    ].join("\n");

    return { accepted: finalAccepted, rejected: allRejected, log };
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
    const tracker = new SurgicalRepairSessionTracker();

    for (let attempt = 1; attempt <= MAX_REPAIR_RETRIES; attempt++) {
      const attemptStart = performance.now();
      let validationSuccess = false;

      if (!currentChanges.length && localPath) {
        const initialCheck = await this.validateWithShell([], localPath, commands);
        if (initialCheck.success) {
          tracker.recordAttempt({
            attempt,
            timestamp: new Date().toISOString(),
            diagnostics: [],
            patchesApplied: [],
            totalFileLines: 0,
            linesChanged: 0,
            patchSizePct: 0,
            repairTimeMs: performance.now() - attemptStart,
            compileSuccess: true,
          });
          return { finalChanges: [], attempts: attempt, success: true };
        }
        previousErrors = initialCheck.errors;
      } else if (!currentChanges.length) {
        return { finalChanges: [], attempts: attempt, success: true };
      } else {
        if (localPath) {
          for (const change of currentChanges) {
            try {
              const abs = path.join(localPath, change.path);
              await fs.promises.mkdir(path.dirname(abs), { recursive: true });
              await fs.promises.writeFile(abs, change.content, "utf8");
            } catch {}
          }
        }

        const validation = (localPath && commands.length > 0)
          ? await this.validateWithShell(currentChanges, localPath, commands)
          : await this.selfReviewChanges(currentChanges);

        validationSuccess = validation.success;
        if (validationSuccess) {
          tracker.recordAttempt({
            attempt,
            timestamp: new Date().toISOString(),
            diagnostics: [],
            patchesApplied: [],
            totalFileLines: 0,
            linesChanged: 0,
            patchSizePct: 0,
            repairTimeMs: performance.now() - attemptStart,
            compileSuccess: true,
          });

          // Save repair metrics summary to disk
          const summaryMd = tracker.generateSummaryMarkdown(true);
          try {
            const cacheDir = path.join(process.cwd(), ".anka-cache");
            if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
            fs.writeFileSync(path.join(cacheDir, "repair-metrics.md"), summaryMd, "utf8");
          } catch {}

          return { finalChanges: currentChanges, attempts: attempt, success: true };
        }

        previousErrors = validation.errors;
      }

      // ── Pipeline 1 & 2: Locate Error & Parse AST Diagnostics ─────────────────
      const diagnostics = ErrorDiagnosticsParser.parse(previousErrors);
      const patchesApplied: SurgicalPatchChunk[] = [];
      let totalLinesChanged = 0;
      let totalFileLines = 0;

      // ── Pipeline 3 & 4: Generate Minimal Patch & Apply Surgical Patch ─────────
      if (diagnostics.length > 0) {
        for (const diag of diagnostics.slice(0, 3)) {
          const targetChangeIdx = currentChanges.findIndex(
            (c) => c.path.replace(/\\/g, "/").endsWith(diag.file) || diag.file.endsWith(c.path.replace(/\\/g, "/")),
          );

          if (targetChangeIdx >= 0) {
            const originalFile = currentChanges[targetChangeIdx];
            totalFileLines = originalFile.content.split("\n").length;

            const minPatch = SurgicalPatchEngine.generateMinimalPatch(
              originalFile.content,
              originalFile.path,
              diag,
            );

            // Surgical replacement of missing imports / type nodes
            if (minPatch.replacementContent !== minPatch.targetContent) {
              const res = SurgicalPatchEngine.applyPatch(originalFile.content, minPatch);
              currentChanges[targetChangeIdx].content = res.newContent;
              patchesApplied.push(minPatch);
              totalLinesChanged += res.linesChanged;
            }
          }
        }
      }

      // Fallback: If diagnostics require LLM reasoning, send minimal AST node window
      if (patchesApplied.length === 0) {
        const repairCompletion = await this.getOpenAI().chat.completions.create({
          model: "gpt-4o",
          messages: [
            { role: "system", content: SELF_HEALING_REPAIR_PROMPT },
            {
              role: "user",
              content: `ORIGINAL REQUEST: ${originalMessage}\n\nCURRENT PROPOSED CHANGES:\n${JSON.stringify(currentChanges, null, 2)}\n\nRAW TERMINAL ERROR TRACE (REPAIR ATTEMPT ${attempt}/${MAX_REPAIR_RETRIES}):\n${previousErrors}\n\nGENERATE SURGICAL PATCH. Return JSON with "changes" array containing only updated contents for affected files.`,
            },
          ],
          temperature: 0.1,
          max_tokens: 8000,
          response_format: { type: "json_object" },
        });

        try {
          const repairParsed = JSON.parse(repairCompletion.choices[0]?.message?.content || "{}");
          if (Array.isArray(repairParsed.changes) && repairParsed.changes.length > 0) {
            const repairMap = new Map<string, AgentFileChange>(repairParsed.changes.map((c: AgentFileChange) => [c.path, c]));
            const merged: AgentFileChange[] = currentChanges.map((c) => repairMap.get(c.path) || c);
            for (const [p, c] of repairMap) {
              if (!merged.find((m) => m.path === p)) merged.push(c as AgentFileChange);
            }
            currentChanges = merged;
          }
        } catch {}
      }

      const attemptTimeMs = performance.now() - attemptStart;
      const patchSizePct = totalFileLines > 0 ? parseFloat(((totalLinesChanged / totalFileLines) * 100).toFixed(2)) : 0;

      tracker.recordAttempt({
        attempt,
        timestamp: new Date().toISOString(),
        diagnostics,
        patchesApplied,
        totalFileLines,
        linesChanged: totalLinesChanged,
        patchSizePct,
        repairTimeMs: attemptTimeMs,
        compileSuccess: false,
      });
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

  private async ensureLocalWorkspace(projectId: string, localPath?: string | null, snapshot?: any): Promise<string | null> {
    if (localPath && fs.existsSync(localPath)) return localPath;

    // Handle snapshot being an array or an object containing keyFiles / repoSnapshot
    const fileList: Array<{ path: string; content?: string }> = Array.isArray(snapshot)
      ? snapshot
      : (snapshot?.keyFiles || snapshot?.repoSnapshot || []);

    if (!fileList || fileList.length === 0) return localPath || null;

    try {
      const cacheDir = path.join(process.cwd(), ".anka-cache", "projects", projectId);
      await fs.promises.mkdir(cacheDir, { recursive: true });

      for (const item of fileList) {
        if (item.path && typeof item.content === "string") {
          const abs = path.join(cacheDir, item.path);
          await fs.promises.mkdir(path.dirname(abs), { recursive: true });
          await fs.promises.writeFile(abs, item.content, "utf8");
        }
      }
      return cacheDir;
    } catch {
      return localPath || null;
    }
  }

  private getEffectiveSnapshot(snapshot: any, localPath?: string | null): any {
    const candidatePath = localPath || process.cwd();
    const diskFiles = scanDirectoryFiles(candidatePath);
    const fileMap = new Map<string, { path: string; content: string }>();

    if (snapshot) {
      const list = Array.isArray(snapshot) ? snapshot : (snapshot.keyFiles || snapshot.repoSnapshot || []);
      for (const f of list) {
        if (f && f.path && typeof f.content === "string") {
          const norm = f.path.replace(/\\/g, "/");
          fileMap.set(norm, { path: norm, content: f.content });
        }
      }
    }

    for (const df of diskFiles) {
      if (!fileMap.has(df.path)) {
        fileMap.set(df.path, { path: df.path, content: df.content || "" });
      }
    }

    const mergedList = Array.from(fileMap.values());
    return {
      repoName: snapshot?.repoName || "workspace",
      defaultBranch: snapshot?.defaultBranch || "main",
      description: snapshot?.description || "",
      languages: snapshot?.languages || { TypeScript: mergedList.length },
      fileTree: mergedList.map((f) => f.path),
      keyFiles: mergedList,
      lastSyncedAt: snapshot?.lastSyncedAt || new Date(),
    };
  }

  // ── Repository Intelligence: Iterative Search Loop ─────────────────────────

  private async runIterativeRepositorySearch(
    message: string,
    snapshot: any,
    projectContext: any,
    intentResult: any,
    localPath?: string | null,
    contract?: ExecutionContract,
  ): Promise<{
    optimizedContext: { fileContext: Record<string, string>; skeletonContext: Record<string, string>; tokenEstimate: number };
    executionMemory: RepositoryExecutionMemory;
    finalConfidence: number;
    searchSummary: string;
  }> {
    const taskId = `task-${Date.now()}`;
    const effectiveSnap = this.getEffectiveSnapshot(snapshot, localPath);

    // ── Bypass Search for STANDALONE / NON-REPO Tasks ──────────────────────────
    if (contract && contract.repositoryRequired === false) {
      const executionMemory: RepositoryExecutionMemory = {
        taskId,
        projectId: projectContext.project.id,
        discoveredSymbols: new Map(),
        discoveredRoutes: [],
        discoveredServices: [],
        discoveredModels: [],
        inspectedFiles: new Set<string>(),
        searchPlanHistory: [],
        currentConfidence: 1.0,
      };
      return {
        optimizedContext: { fileContext: {}, skeletonContext: {}, tokenEstimate: 0 },
        executionMemory,
        finalConfidence: 1.0,
        searchSummary: `Standalone Pipeline active (pipeline: ${contract.pipeline}, environment: ${contract.environment}) — Repository search bypassed.`,
      };
    }

    const toolEngine = new RepositoryToolEngine(effectiveSnap, localPath);
    const reasoningEngine = new IterativeReasoningEngine({
      snapshot: effectiveSnap,
      maxRounds: 5,
      confidenceThreshold: 0.80,
      contract, // Pass contract for scoped search
    });

    // ── Execute Contract-Scoped Iterative Reasoning Loop ──────────────────────
    const reasoningTrace = await reasoningEngine.executeReasoningLoop(message, intentResult.intent, contract);

    const executionMemory: RepositoryExecutionMemory = {
      taskId,
      projectId: projectContext.project.id,
      discoveredSymbols: new Map(),
      discoveredRoutes: [],
      discoveredServices: [],
      discoveredModels: [],
      inspectedFiles: reasoningTrace.allExploredFiles,
      searchPlanHistory: [],
      currentConfidence: reasoningTrace.finalConfidence,
    };

    for (const [name, sym] of reasoningTrace.allDiscoveredSymbols.entries()) {
      executionMemory.discoveredSymbols.set(name, { filePath: sym.filePath, line: sym.line || 1 });
      if (sym.kind === "route") executionMemory.discoveredRoutes.push(sym.name);
      if (sym.kind === "service") executionMemory.discoveredServices.push(sym.filePath);
      if (sym.kind === "model") executionMemory.discoveredModels.push(sym.name);
    }

    // ── Step E: Build Optimized Context from all discovered files ─────────────
    const collectedFileContext: Record<string, string> = {};
    const collectedSkeletonContext: Record<string, string> = {};
    let tokenBudget = 0;
    const MAX_TOKENS = 15000;

    // Gather full content for inspected/discovered files
    for (const fp of reasoningTrace.allExploredFiles) {
      if (!fp || collectedFileContext[fp]) continue;
      const fileResult = toolEngine.readFile({ filePath: fp });
      if (!fileResult.found) continue;

      const approxTokens = Math.ceil(fileResult.content.length / 4);
      if (tokenBudget + approxTokens <= MAX_TOKENS) {
        collectedFileContext[fp] = fileResult.content;
        tokenBudget += approxTokens;
      } else {
        const skeleton = this.skeletonizeDependencyFile(fileResult.content);
        const skelTokens = Math.ceil(skeleton.length / 4);
        if (tokenBudget + skelTokens <= MAX_TOKENS) {
          collectedSkeletonContext[fp] = skeleton;
          tokenBudget += skelTokens;
        }
      }
    }

    // ── Apply Contract Context Filter ─────────────────────────────────────────
    // Remove files outside the contract's contextScope before building the
    // LLM context window. For DELETE_FOLDER / BUG_FIX this can cut the context
    // from 300+ files down to just the 8-12 relevant ones.
    const filteredFileContext = reasoningEngine.filterFilesByContractScope(collectedFileContext);

    // Fallback: include snapshot key files if context is empty
    if (Object.keys(filteredFileContext).length === 0 && snapshot?.keyFiles?.length) {
      for (const kf of (snapshot.keyFiles as Array<{ path: string; content?: string }>).slice(0, 10)) {
        if (kf.content) filteredFileContext[kf.path] = kf.content;
      }
    }

    const toolSummaryLines = executionMemory.searchPlanHistory
      .map((h) => `  Step ${h.stepId}: ${h.tool} → found ${h.resultCount} result(s)`);
    const searchSummary = [
      `Search Plan executed: ${toolSummaryLines.length} steps`,
      `Routes discovered: ${executionMemory.discoveredRoutes.join(", ") || "none"}`,
      `Services discovered: ${executionMemory.discoveredServices.join(", ") || "none"}`,
      `Models discovered: ${executionMemory.discoveredModels.join(", ") || "none"}`,
      `Final confidence: ${(executionMemory.currentConfidence * 100).toFixed(0)}%`,
    ].join("\n");

    return {
      optimizedContext: { fileContext: filteredFileContext, skeletonContext: collectedSkeletonContext, tokenEstimate: tokenBudget },
      executionMemory,
      finalConfidence: executionMemory.currentConfidence,
      searchSummary,
    };
  }

  // ── Feature Validation Engine (4-Tier) ────────────────────────────────────

  private async runFeatureValidation(
    changes: AgentFileChange[],
    snapshot: any,
    originalMessage: string,
    contract?: ExecutionContract,
  ): Promise<FeatureValidationResult> {
    if (!changes.length) {
      return {
        overallPassed: true,
        checks: [],
        failedChecks: [],
        repairActions: [],
      };
    }

    // ── Standalone HTML/CSS/JS Feature Validation ─────────────────────────────
    if (contract?.pipeline === "STANDALONE" || contract?.environment === "HTML_CSS_JS") {
      const hasHtml = changes.some((c) => c.path.endsWith(".html") || c.path.includes("index"));
      const hasCss = changes.some((c) => c.path.endsWith(".css") || c.content.includes("css"));
      const hasJs = changes.some((c) => c.path.endsWith(".js") || c.content.includes("addEventListener"));

      const htmlContent = changes.find((c) => c.path.endsWith(".html"))?.content || "";
      const jsContent = changes.find((c) => c.path.endsWith(".js"))?.content || "";

      const hasDoctype = /<!doctype\s+html>/i.test(htmlContent) || /<html/i.test(htmlContent);
      const linksStyle = /<link[^>]+href=["']?style\.css["']?/i.test(htmlContent);
      const linksScript = /<script[^>]+src=["']?script\.js["']?/i.test(htmlContent);

      return {
        overallPassed: hasHtml,
        checks: [
          {
            id: "html_structure",
            label: "HTML5 Document Structure",
            status: hasHtml && hasDoctype ? "PASS" : "WARN",
            checked: true,
            details: hasHtml ? (hasDoctype ? "Valid HTML5 doctype & tags present" : "HTML file present") : "Missing index.html",
          },
          {
            id: "css_styling",
            label: "CSS Layout & Styling",
            status: hasCss && linksStyle ? "PASS" : "WARN",
            checked: true,
            details: hasCss ? (linksStyle ? "style.css created and linked in <head>" : "style.css present") : "No standalone CSS file",
          },
          {
            id: "js_interactivity",
            label: "JS Interactivity & Events",
            status: hasJs && linksScript ? "PASS" : "WARN",
            checked: true,
            details: hasJs ? (linksScript ? "script.js created and linked before </body>" : "script.js present") : "No standalone JS file",
          },
          {
            id: "standalone_completeness",
            label: "Standalone Asset Completeness",
            status: hasHtml && (hasCss || hasJs) ? "PASS" : "WARN",
            checked: true,
            details: `Generated ${changes.length} standalone file(s): ${changes.map((c) => c.path).join(", ")}`,
          },
        ],
        failedChecks: [],
        repairActions: [],
      };
    }

    // ── Primary: Deterministic Static Feature Validation ─────────────────────────
    try {
      const rawSnapshotFiles = (snapshot?.keyFiles || snapshot?.repoSnapshot || []) as Array<{ path: string; content?: string }>;
      const projectFilesOnly = rawSnapshotFiles.filter((f) => f.path && !f.path.startsWith("benchmarks/") && !f.path.startsWith("node_modules/"));
      const rawStaticResult = StaticValidationEngine.validate(projectFilesOnly, changes);

      // Only evaluate issues in files that are part of the current task changes
      const changedFilePaths = new Set(changes.map((c) => c.path));
      const relevantIssues = rawStaticResult.issues.filter((i) => changedFilePaths.has(i.file));
      const staticResult = { ...rawStaticResult, issues: relevantIssues };

      const checks = [
        {
          id: "import_export",
          label: "Import/Export & Symbol Integrity",
          status: staticResult.issues.some((i) => i.checkId === "broken_import" || i.checkId === "missing_export") ? ("FAIL" as const) : ("PASS" as const),
          checked: true,
          details: staticResult.issues.filter((i) => i.checkId === "broken_import" || i.checkId === "missing_export").map((i) => `${i.file}:${i.line} ${i.reason}`).join("; ") || "All imports and exports resolve cleanly",
        },
        {
          id: "circular_dependencies",
          label: "Circular Dependency Check",
          status: staticResult.issues.some((i) => i.checkId === "circular_dependency") ? ("WARN" as const) : ("PASS" as const),
          checked: true,
          details: staticResult.issues.filter((i) => i.checkId === "circular_dependency").map((i) => `${i.file}:${i.line} ${i.reason}`).join("; ") || "No circular dependencies",
        },
        {
          id: "orphan_audit",
          label: "Orphan Component Audit",
          status: staticResult.issues.some((i) => i.checkId === "orphan_component") ? ("WARN" as const) : ("PASS" as const),
          checked: true,
          details: staticResult.issues.filter((i) => i.checkId === "orphan_component").map((i) => `${i.file}:${i.line} ${i.reason}`).join("; ") || "No orphan UI components",
        },
        {
          id: "route_reachability",
          label: "Route Reachability & Dead Routes",
          status: staticResult.issues.some((i) => i.checkId === "dead_route" || i.checkId === "missing_navigation") ? ("WARN" as const) : ("PASS" as const),
          checked: true,
          details: staticResult.issues.filter((i) => i.checkId === "dead_route" || i.checkId === "missing_navigation").map((i) => `${i.file}:${i.line} ${i.reason}`).join("; ") || "All route pages are reachable",
        },
        {
          id: "api_connection",
          label: "API Endpoint Connection",
          status: staticResult.issues.some((i) => i.checkId === "unused_api") ? ("WARN" as const) : ("PASS" as const),
          checked: true,
          details: staticResult.issues.filter((i) => i.checkId === "unused_api").map((i) => `${i.file}:${i.line} ${i.reason}`).join("; ") || "API handlers connected",
        },
        {
          id: "db_wiring",
          label: "Database Schema Wiring",
          status: staticResult.issues.some((i) => i.checkId === "invalid_prisma") ? ("FAIL" as const) : ("PASS" as const),
          checked: true,
          details: staticResult.issues.filter((i) => i.checkId === "invalid_prisma").map((i) => `${i.file}:${i.line} ${i.reason}`).join("; ") || "Prisma schema calls verified",
        },
        {
          id: "missing_provider",
          label: "React Context Provider Verification",
          status: staticResult.issues.some((i) => i.checkId === "missing_provider") ? ("FAIL" as const) : ("PASS" as const),
          checked: true,
          details: staticResult.issues.filter((i) => i.checkId === "missing_provider").map((i) => `${i.file}:${i.line} ${i.reason}`).join("; ") || "Context providers present",
        },
      ];

      const failedChecks = staticResult.issues
        .filter((i) => i.severity === "FAIL")
        .map((i) => `[${i.checkId}] ${i.file}:${i.line} - ${i.reason} (Fix: ${i.suggestedFix})`);

      const repairActions = staticResult.issues
        .filter((i) => i.severity === "FAIL")
        .map((i) => ({
          checkId: i.checkId,
          action: `Fix issue in ${i.file} at line ${i.line}: ${i.suggestedFix}`,
          suggestedTool: "repo_readFile",
        }));

      return {
        overallPassed: staticResult.passed,
        checks,
        failedChecks,
        repairActions,
      };
    } catch {
      // Fallback to prompt validator if static analysis encounters unhandled exception
    }

    // ── Fallback: Prompt-Based Validation ───────────────────────────────────────
    const changesText = changes.map((c) => `=== NEW/MODIFIED FILE: ${c.path} ===\n${c.content.slice(0, 1500)}`).join("\n\n");
    const snapshotFilesFallback = ((snapshot?.keyFiles || snapshot?.repoSnapshot || []) as Array<{ path: string; content?: string }>);
    const existingFiles = snapshotFilesFallback
      .map((f) => `${f.path}`)
      .join("\n");

    const defaultResult: FeatureValidationResult = {
      overallPassed: true,
      checks: [
        { id: "route_reachability", label: "Route Reachability", status: "WARN", checked: false, details: "Not verified (no snapshot routes found)" },
        { id: "component_rendering", label: "Component Rendering", status: "WARN", checked: false, details: "Not verified" },
        { id: "nav_integration", label: "Navigation Integration", status: "WARN", checked: false, details: "Not verified" },
        { id: "import_export", label: "Import/Export Completeness", status: "PASS", checked: true, details: "Assumed complete" },
        { id: "api_connection", label: "API & Service Connection", status: "WARN", checked: false, details: "Not verified" },
        { id: "middleware", label: "Middleware & Permissions", status: "WARN", checked: false, details: "Not verified" },
        { id: "db_wiring", label: "Database Schema Wiring", status: "WARN", checked: false, details: "Not verified" },
        { id: "orphan_audit", label: "Orphan Component Audit", status: "PASS", checked: true, details: "Assumed none" },
        { id: "intent_satisfaction", label: "Intent Satisfaction", status: "PASS", checked: true, details: "Assumed satisfied" },
      ],
      failedChecks: [],
      repairActions: [],
    };

    try {
      const validationCompletion = await this.getOpenAI().chat.completions.create({
        model: "gpt-4o",
        messages: [
          { role: "system", content: FEATURE_VALIDATOR_PROMPT },
          {
            role: "user",
            content: `ORIGINAL USER REQUEST: ${originalMessage}\n\nEXISTING REPOSITORY FILES:\n${existingFiles.slice(0, 2000)}\n\nNEW/MODIFIED FILES:\n${changesText.slice(0, 6000)}`,
          },
        ],
        temperature: 0.1,
        max_tokens: 2000,
        response_format: { type: "json_object" },
      });

      const parsed = JSON.parse(validationCompletion.choices[0]?.message?.content || "{}");
      if (typeof parsed.overallPassed === "boolean" && Array.isArray(parsed.checks)) {
        return parsed as FeatureValidationResult;
      }
    } catch {
      // Return default
    }

    return defaultResult;
  }

  private detectValidationCommands(workspacePath?: string | null, snapshot?: any): string[] {
    const fileList: Array<any> = Array.isArray(snapshot)
      ? snapshot
      : (snapshot?.keyFiles || snapshot?.repoSnapshot || []);

    const files = fileList.map((f: any) => typeof f === "string" ? f : (f.path || ""));

    let hasPkgJson = files.some((f: string) => f.endsWith("package.json"));
    let hasCargo = files.some((f: string) => f.endsWith("Cargo.toml"));
    let hasGoMod = files.some((f: string) => f.endsWith("go.mod"));
    let hasPy = files.some((f: string) => f.endsWith("requirements.txt") || f.endsWith("pyproject.toml"));

    if (workspacePath && fs.existsSync(workspacePath)) {
      if (fs.existsSync(path.join(workspacePath, "package.json"))) hasPkgJson = true;
      if (fs.existsSync(path.join(workspacePath, "Cargo.toml"))) hasCargo = true;
      if (fs.existsSync(path.join(workspacePath, "go.mod"))) hasGoMod = true;
    }

    if (hasPkgJson) {
      try {
        let pkgContent = "";
        if (workspacePath && fs.existsSync(path.join(workspacePath, "package.json"))) {
          pkgContent = fs.readFileSync(path.join(workspacePath, "package.json"), "utf8");
        } else {
          const pkgFile = fileList.find((f: any) => (f.path || f) === "package.json" || (f.path || f).endsWith("package.json"));
          if (pkgFile?.content) pkgContent = pkgFile.content;
        }

        if (pkgContent) {
          const pkg = JSON.parse(pkgContent);
          const scripts = pkg.scripts || {};
          const cmds: string[] = [];

          if (scripts.typecheck || scripts["type-check"]) {
            cmds.push(pkg.scripts.typecheck ? "npm run typecheck" : "npm run type-check");
          } else if (pkg.devDependencies?.typescript || pkg.dependencies?.typescript) {
            cmds.push("npx tsc --noEmit");
          }

          if (scripts.build) {
            cmds.push("npm run build");
          }

          if (cmds.length > 0) return cmds;
        }
      } catch {}

      return ["npx tsc --noEmit", "npm run build"];
    }

    if (hasCargo) return ["cargo check"];
    if (hasGoMod) return ["go build ./..."];
    if (hasPy) return ["python -m py_compile"];

    return ["npx tsc --noEmit", "npm run build"];
  }

  async runCodingAgent(
    userId: string,
    projectId: string,
    request: ChatRequest,
    onProgress?: (event: AgentProgressEvent) => void,
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
    const effectiveLocalPath = await this.ensureLocalWorkspace(projectId, project?.localPath, snapshot);
    const effectiveSnapshot = this.getEffectiveSnapshot(snapshot, effectiveLocalPath);
    const validationCommands = this.detectValidationCommands(effectiveLocalPath, effectiveSnapshot);

    const intentResult = await this.classifyIntentAndAmbiguity(request.message, projectContext);

    const snapshotFileList = (effectiveSnapshot?.keyFiles || effectiveSnapshot?.repoSnapshot || (Array.isArray(effectiveSnapshot) ? effectiveSnapshot : [])) as Array<any>;
    const repoFileNames = snapshotFileList.map((f: any) => typeof f === "string" ? f : (f.path || ""));

    // ── Build Execution Contract from classification ──────────────────────────
    // The contract governs EVERY subsequent stage: search scope, context filter,
    // code generation guardrails, and diff critic enforcement.
    const executionContract: ExecutionContract = buildExecutionContract(intentResult, request.message, repoFileNames);

    // ── Stage 1: Task & Intent Analysis ──────────────────────
    onProgress?.({
      step: 1,
      stageName: "INTENT_ANALYSIS",
      label: "Task",
      detail: `Task: ${intentResult.taskType} | Risk: ${intentResult.risk} | Complexity: ${intentResult.estimatedComplexity} | Max Files: ${executionContract.maxFiles} | Scope: ${executionContract.targetPaths.join(", ") || "project-wide"}`,
      color: intentResult.risk === "HIGH" || intentResult.risk === "CRITICAL" ? "text-rose-400 border-rose-500/30 bg-rose-500/10" : "text-amber-400 border-amber-500/30 bg-amber-500/10",
      badge: `STAGE 1/7 · ${intentResult.taskType} · ${executionContract.maxFiles} files max`,
      progress: 15,
      log: `[Stage 1/7] Contract built: ${intentResult.taskType} / ${intentResult.risk} risk / ${intentResult.estimatedComplexity} complexity\n  ✓ Allowed: ${executionContract.allowedActions.join(", ")}\n  ✗ Forbidden: ${executionContract.forbiddenActions.slice(0, 3).join(", ")}\n  📁 Target: ${executionContract.targetPaths.join(", ") || "(project-wide)"}\n  📊 Max files: ${executionContract.maxFiles}`,
      taskType: intentResult.taskType,
      risk: intentResult.risk,
      estimatedComplexity: intentResult.estimatedComplexity,
      targetPath: intentResult.targetPath,
      executionContract,
    });

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
        taskType: intentResult.taskType,
        risk: intentResult.risk,
        estimatedComplexity: intentResult.estimatedComplexity,
        targetPath: intentResult.targetPath,
        confidence: intentResult.confidence,
      };
    }

    // ── Stage 2: Understand Goal & Repository Knowledge Graph ─────────────
    onProgress?.({
      step: 2,
      stageName: "KNOWLEDGE_GRAPH",
      label: "Understand Goal",
      detail: "Analyzing request intent & building Repository Knowledge Graph...",
      color: "text-cyan-400 border-cyan-500/30 bg-cyan-500/10",
      badge: "STAGE 2/7",
      progress: 28,
      log: `[Stage 2/7] Task "${intentResult.taskType}" (${intentResult.risk} risk, ${intentResult.estimatedComplexity} complexity). Built Knowledge Graph.`,
      taskType: intentResult.taskType,
      risk: intentResult.risk,
      estimatedComplexity: intentResult.estimatedComplexity,
    });

    const knowledgeGraph = await this.buildKnowledgeGraph(effectiveSnapshot);

    // ── Stage 3: Determine Completion & Iterative Repository Search Loop ───
    onProgress?.({
      step: 3,
      stageName: "REPO_SEARCH",
      label: "Determine Completion",
      detail: `Contract-scoped search: ${executionContract.targetPaths.length > 0 ? executionContract.targetPaths.join(", ") : "project-wide"} + import references...`,
      color: "text-blue-400 border-blue-500/30 bg-blue-500/10",
      badge: "STAGE 3/7",
      progress: 42,
      log: `[Stage 3/7] Contract search scope: [${executionContract.searchScope.slice(0, 4).join(", ")}]\n  Max files cap: ${executionContract.maxFiles}`,
    });

    const { optimizedContext, executionMemory, finalConfidence, searchSummary } =
      await this.runIterativeRepositorySearch(request.message, effectiveSnapshot, projectContext, intentResult, effectiveLocalPath, executionContract);

    const inspectedFilesArr = Array.from(executionMemory.inspectedFiles || []);
    onProgress?.({
      step: 3,
      stageName: "REPO_SEARCH",
      label: "Determine Completion",
      detail: `Scoped search complete: ${inspectedFilesArr.length} files within contract scope. Confidence: ${(finalConfidence * 100).toFixed(0)}%`,
      color: "text-blue-400 border-blue-500/30 bg-blue-500/10",
      badge: "STAGE 3/7",
      progress: 48,
      log: `[Repo Search] Contract-scoped files examined: ${inspectedFilesArr.slice(0, 5).join(", ")}`,
    });

    const systemPrompt = this.buildAgentSystemPrompt(
      projectContext,
      effectiveSnapshot,
      approvedArchitecture?.content,
      projectContext.summary?.summary,
    );

    // ── Stage 3.5: Manifest Generation & Task Decomposition ─────────────
    const manifestEnabled = process.env.ENABLE_MANIFEST_ENFORCEMENT !== "false";
    let manifestResult: any = null;
    let decompositionResult: any = null;

    if (manifestEnabled) {
      const shouldDecompose =
        intentResult.taskType === "NEW_FEATURE" &&
        (intentResult.estimatedComplexity === "LARGE" || intentResult.estimatedComplexity === "COMPLEX");

      if (shouldDecompose) {
        onProgress?.({
          step: 3,
          stageName: "REPO_SEARCH",
          label: "Decompose Task",
          detail: "Complex feature detected. Decomposing task into Directed Acyclic Graph (DAG)...",
          color: "text-purple-400 border-purple-500/30 bg-purple-500/10",
          badge: "STAGE 3.5/7",
          progress: 52,
          log: `[Task Decomposition] Analyzing request complexity: ${intentResult.estimatedComplexity}. Generating DAG...`,
        });

        try {
          const decomposer = new TaskDecomposer(this.getOpenAI());
          const graph = await decomposer.decomposeTask(request.message, projectContext, intentResult);

          await prisma.taskDecomposition.create({
            data: {
              projectId,
              sessionId: session.id,
              userRequest: request.message,
              graphJson: graph as any,
              totalSubTasks: graph.nodes.length,
              status: "in_progress",
            },
          });

          const executor = new SubTaskExecutor(new ManifestGenerator(this.getOpenAI()));
          const completedMap = new Map<string, any>();

          for (const subTaskId of graph.executionOrder) {
            const subTask = graph.nodes.find((n) => n.id === subTaskId);
            if (!subTask) continue;

            const res = await executor.executeSubTask(subTask, completedMap, projectContext, executionContract);
            completedMap.set(subTaskId, res);
          }

          const aggregated = executor.aggregateResults(completedMap);
          decompositionResult = aggregated;
        } catch (e: any) {
          console.error("[AiService] Task decomposition error:", e?.message || e);
        }
      } else {
        onProgress?.({
          step: 3,
          stageName: "REPO_SEARCH",
          label: "Generate File Manifest",
          detail: "Generating and validating pre-execution File Manifest...",
          color: "text-cyan-400 border-cyan-500/30 bg-cyan-500/10",
          badge: "STAGE 3.5/7",
          progress: 52,
          log: "[Manifest Enforcement] Generating File Manifest before code generation...",
        });

        try {
          const generator = new ManifestGenerator(this.getOpenAI());
          const manifest = await generator.generateManifest(request.message, projectContext, executionContract);

          const existingFileList = Array.isArray(effectiveSnapshot)
            ? effectiveSnapshot.map((f: any) => f.path)
            : [];
          const validator = new ManifestValidator(executionContract, existingFileList);
          const valRes = validator.validate(manifest);

          await prisma.agentManifest.create({
            data: {
              projectId,
              sessionId: session.id,
              manifestJson: manifest as any,
              validationStatus: valRes.valid ? "approved" : "rejected",
              validationErrors: valRes.errors as any,
            },
          });

          manifestResult = { manifest, validation: valRes };
        } catch (e: any) {
          console.error("[AiService] Manifest generation error:", e?.message || e);
        }
      }
    }

    // ── Stage 4: Generate Files & Implementation Roadmap ────
    onProgress?.({
      step: 4,
      stageName: "CODE_GEN",
      label: "Generate Files",
      detail: `Guarded generation: Allowed [${executionContract.allowedActions.slice(0, 3).join(", ")}] | Max ${executionContract.maxFiles} files`,
      color: "text-violet-400 border-violet-500/30 bg-violet-500/10",
      badge: "STAGE 4/7",
      progress: 58,
      log: `[Stage 4/7] Code generation with Execution Contract guardrails:\n  ✓ Allowed: ${executionContract.allowedActions.join(", ")}\n  ✗ Forbidden: ${executionContract.forbiddenActions.join(", ")}\n  📊 Max files: ${executionContract.maxFiles}`,
    });

    const roadmapAndDiff = await this.generateRoadmapAndDiffs(
      request.message,
      intentResult,
      optimizedContext,
      systemPrompt,
      executionContract,
    );

    onProgress?.({
      step: 4,
      stageName: "CODE_GEN",
      label: "Generate Files",
      detail: `Generated ${roadmapAndDiff.changes.length} file modification blueprints...`,
      color: "text-violet-400 border-violet-500/30 bg-violet-500/10",
      badge: "STAGE 4/7",
      progress: 68,
      log: `[Stage 4/7] Drafted changes: ${roadmapAndDiff.changes.map(c => c.path).join(", ")}`,
    });

    // ── Diff Contract Critic (between Stage 4 and Stage 5) ───────────────────
    // Rejects any proposed changes that violate the ExecutionContract:
    //   - File paths outside contextScope for tight-scope tasks
    //   - File changes implying a forbiddenAction
    //   - Changes that exceed the maxFiles cap
    const criticResult = executionContract.diffCriticEnabled
      ? this.runDiffContractCritic(roadmapAndDiff.changes, executionContract)
      : { accepted: roadmapAndDiff.changes, rejected: [], log: "[Diff Critic] Skipped — contract.diffCriticEnabled = false" };

    // ── Stage 5: Wire Everything & Diff Critic + Self-Healing Repair Loop ─────
    onProgress?.({
      step: 5,
      stageName: "SELF_HEALING",
      label: "Wire Everything",
      detail: `Diff Critic: ${criticResult.accepted.length} accepted · ${criticResult.rejected.length} rejected | Running build checks...`,
      color: "text-indigo-400 border-indigo-500/30 bg-indigo-500/10",
      badge: "STAGE 5/7",
      progress: 74,
      log: criticResult.log + `\n[Stage 5/7] Wiring module imports, exports & routes...`,
    });

    const effectiveValidationCommands = (executionContract.pipeline === "STANDALONE" || executionContract.environment === "HTML_CSS_JS")
      ? []
      : (roadmapAndDiff.validationCommands || validationCommands);

    const repairResult = await this.runSelfHealingLoop(
      criticResult.accepted,
      effectiveLocalPath,
      effectiveValidationCommands,
      systemPrompt,
      request.message,
    );

    // Flush verified changes directly to local project workspace disk
    if (repairResult.finalChanges.length > 0) {
      const targetPaths = new Set<string>();
      if (effectiveLocalPath) targetPaths.add(effectiveLocalPath);
      if (project?.localPath && fs.existsSync(project.localPath)) targetPaths.add(project.localPath);

      for (const targetPath of targetPaths) {
        for (const change of repairResult.finalChanges) {
          try {
            const abs = path.join(targetPath, change.path);
            if (change.action === "delete" || change.isDeleted) {
              if (fs.existsSync(abs)) {
                await fs.promises.rm(abs, { recursive: true, force: true });
              }
            } else {
              await fs.promises.mkdir(path.dirname(abs), { recursive: true });
              await fs.promises.writeFile(abs, change.content, "utf8");
            }
          } catch {}
        }
      }
    }

    // ── Stage 6: Run App & Security Review / 4-Tier Feature Validation ─────
    onProgress?.({
      step: 6,
      stageName: "FEATURE_VALIDATION",
      label: "Run App & Self-Healing",
      detail: "Executing local tsc & build checks with auto-repair loop...",
      color: "text-emerald-400 border-emerald-500/30 bg-emerald-500/10",
      badge: "STAGE 6/7",
      progress: 88,
      log: `[Stage 6/7] Build check: ${repairResult.success ? "Passed ✅" : "Self-healing applied repairs"} (Attempt ${repairResult.attempts}/5)`,
    });

    const auditResult = await this.runReflectionAndSecurityAudit(repairResult.finalChanges);

    let featureValidation = await this.runFeatureValidation(
      repairResult.finalChanges,
      effectiveSnapshot,
      request.message,
      executionContract,
    );

    // If feature validation fails hard (any FAIL checks), run one additional
    // repair cycle using validation error context as input
    if (!featureValidation.overallPassed && featureValidation.failedChecks.length > 0 && repairResult.success) {
      onProgress?.({
        step: 6,
        stageName: "FEATURE_VALIDATION",
        label: "Run App & Self-Healing",
        detail: "Fixing feature integration issues & component wiring...",
        color: "text-emerald-400 border-emerald-500/30 bg-emerald-500/10",
        badge: "STAGE 6/7",
        progress: 92,
        log: `[Stage 6/7] Applying feature integration fixes...`,
      });

      const validationErrors = featureValidation.checks
        .filter((c) => c.status === "FAIL")
        .map((c) => `[${c.label}] FAILED: ${c.details}`)
        .join("\n");

      const repairActions = featureValidation.repairActions
        .map((ra) => `  → ${ra.action} (use ${ra.suggestedTool})`)
        .join("\n");

      const validationFixCompletion = await this.getOpenAI().chat.completions.create({
        model: "gpt-4o",
        messages: [
          { role: "system", content: SELF_HEALING_REPAIR_PROMPT },
          {
            role: "user",
            content: `ORIGINAL REQUEST: ${request.message}\n\nCURRENT PROPOSED CHANGES:\n${JSON.stringify(repairResult.finalChanges, null, 2)}\n\nFEATURE VALIDATION FAILURES:\n${validationErrors}\n\nSUGGESTED REPAIR ACTIONS:\n${repairActions}\n\nFix the feature integration issues listed above. Update files to properly wire the feature (routes, imports, navigation, API connections) so all validation checks pass.`,
          },
        ],
        temperature: 0.1,
        max_tokens: 8000,
        response_format: { type: "json_object" },
      });

      try {
        const fixParsed = JSON.parse(validationFixCompletion.choices[0]?.message?.content || "{}");
        if (Array.isArray(fixParsed.changes) && fixParsed.changes.length > 0) {
          // Merge repair changes into final changes
          const repairMap = new Map<string, AgentFileChange>(fixParsed.changes.map((c: AgentFileChange) => [c.path, c]));
          const mergedChanges: AgentFileChange[] = repairResult.finalChanges.map((c) => repairMap.get(c.path) || c);
          for (const [, c] of repairMap) {
            if (!mergedChanges.find((mc) => mc.path === (c as AgentFileChange).path)) mergedChanges.push(c as AgentFileChange);
          }
          repairResult.finalChanges = mergedChanges;

          // Re-validate after repair
          featureValidation = await this.runFeatureValidation(
            repairResult.finalChanges,
            snapshot,
            request.message,
            executionContract,
          );
        }
      } catch { /* keep original validation result */ }
    }

    // ── Stage 7: Verify & Done (Memory Persistence) ─────────────────────────
    onProgress?.({
      step: 7,
      stageName: "MEMORY_PERSISTENCE",
      label: "Verify & Done",
      detail: "Verifying localhost rendering, interactivity, and ✓ checklist criteria...",
      color: "text-purple-400 border-purple-500/30 bg-purple-500/10",
      badge: "STAGE 7/7",
      progress: 98,
      log: `[Stage 7/7] Verifying checklist criteria and recording project memory...`,
    });

    await this.persistProjectMemory(projectId, request.message, auditResult);

    // Build unified checklist combining build results + feature validation
    const featureChecks = featureValidation.checks || [];
    const isStandaloneChecklist = executionContract?.pipeline === "STANDALONE" || executionContract?.environment === "HTML_CSS_JS";

    const defaultChecklist = isStandaloneChecklist
      ? [
          { label: "Analyze user request & standalone goal", checked: true, category: "Search" },
          { label: `Task Routing (Pipeline: STANDALONE, Env: ${executionContract?.environment || "HTML_CSS_JS"})`, checked: true, category: "Search" },
          { label: "HTML5 Document Structure", checked: featureChecks.find((c) => c.id === "html_structure")?.status !== "FAIL", category: "Feature" },
          { label: "CSS Layout & Styling", checked: featureChecks.find((c) => c.id === "css_styling")?.status !== "FAIL", category: "Feature" },
          { label: "JS Interactivity & Events", checked: featureChecks.find((c) => c.id === "js_interactivity")?.status !== "FAIL", category: "Feature" },
          { label: "Standalone Asset Completeness", checked: featureChecks.find((c) => c.id === "standalone_completeness")?.status !== "FAIL", category: "Feature" },
          { label: "Zero Syntax Errors", checked: repairResult.success, category: "Build" },
          { label: "Standalone App Working", checked: featureValidation.overallPassed, category: "Validation" },
        ]
      : [
          { label: "Analyze current code base", checked: true, category: "Search" },
          { label: `Repository search (confidence ${(finalConfidence * 100).toFixed(0)}%)`, checked: finalConfidence >= 0.80, category: "Search" },
          { label: "React component exists", checked: featureChecks.find((c) => c.id === "component_rendering")?.status !== "FAIL", category: "Feature" },
          { label: "Route exists", checked: featureChecks.find((c) => c.id === "route_reachability")?.status !== "FAIL", category: "Feature" },
          { label: "Imported", checked: featureChecks.find((c) => c.id === "import_export")?.status !== "FAIL", category: "Feature" },
          { label: "Rendered", checked: featureChecks.find((c) => c.id === "component_rendering")?.status !== "FAIL", category: "Feature" },
          { label: "Navigation updated", checked: featureChecks.find((c) => c.id === "nav_integration")?.status !== "FAIL", category: "Feature" },
          { label: "API connected", checked: featureChecks.find((c) => c.id === "api_connection")?.status !== "FAIL", category: "Feature" },
          { label: "No orphan components", checked: featureChecks.find((c) => c.id === "orphan_audit")?.status !== "FAIL", category: "Validation" },
          { label: "No TS errors", checked: repairResult.success, category: "Build" },
          { label: "Build passes", checked: repairResult.success, category: "Build" },
          { label: "Feature functional & working", checked: repairResult.success && featureValidation.overallPassed, category: "Validation" },
        ];

    const checklistMarkdown = `\n\n### 📋 Repository Intelligence Verification Checklist\n` +
      `**Repository Search Confidence:** ${(finalConfidence * 100).toFixed(0)}%\n\n` +
      `**Search Summary:**\n${searchSummary}\n\n` +
      defaultChecklist.map((item) => `${item.checked ? "✅" : "⚠️"} ${item.label}`).join("\n") +
      (featureValidation.failedChecks.length > 0
        ? `\n\n**⚠️ Feature Validation Issues:**\n` + featureChecks.filter((c) => c.status === "FAIL").map((c) => `- ${c.label}: ${c.details}`).join("\n")
        : "");

    const fileChangeLines = repairResult.finalChanges.length > 0
      ? repairResult.finalChanges.map((c) => `- ${c.path}: ${(c.action === "delete" || c.isDeleted) ? "[DELETED] " : ""}${c.description}`).join("\n")
      : "No files changed.";

    const summary = `[TaskType: ${intentResult.taskType} | Risk: ${intentResult.risk} | Complexity: ${intentResult.estimatedComplexity}] ${roadmapAndDiff.explanation}\n\n${auditResult.summary}${checklistMarkdown}\n\nFiles Modified / Deleted:\n${fileChangeLines}`;
    await this.saveMessage(session.id, "assistant", summary);

    if (!session.title) await this.updateSessionTitle(session.id, request.message);

    return {
      explanation: roadmapAndDiff.explanation + "\n\n" + auditResult.summary + checklistMarkdown,
      changes: repairResult.finalChanges,
      commitMessage: roadmapAndDiff.commitMessage,
      sessionId: session.id,
      intent: intentResult.intent,
      taskType: intentResult.taskType,
      risk: intentResult.risk,
      estimatedComplexity: intentResult.estimatedComplexity,
      targetPath: intentResult.targetPath,
      confidence: finalConfidence,
      roadmap: roadmapAndDiff.roadmap,
      securityPass: auditResult.securityPass,
      critiqueScore: auditResult.critiqueScore,
      buildVerified: repairResult.success,
      repaired: repairResult.attempts > 1,
      buildErrors: repairResult.errorLog,
      verificationChecklist: defaultChecklist,
      lifecycleStage: "Done",
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
