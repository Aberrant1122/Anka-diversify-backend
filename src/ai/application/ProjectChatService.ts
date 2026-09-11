import OpenAI from "openai";
import { PrismaClient } from "@prisma/client";
import { extractDocumentText, injectImages, estimateCostUSD } from "../shared/utils";
import { ChatRequest, ChatResponse, ProposedTask, EpicProposal, ProjectHealth, GeneralContext, ProjectContext, AIAction } from "../shared/types";
import { RepositoryContextBuilder } from "../repository/RepositoryContextBuilder";
import { MemoryPersistence } from "../memory/MemoryPersistence";
import { LLMGateway, LLMToolValidationResult } from "../gateway/LLMGateway";
import { LLMProviderError } from "../gateway/LLMError";
import { PipelineStages } from "../gateway/PipelineStage";

const prisma = new PrismaClient();

const TASK_PRIORITIES = new Set(["low", "medium", "high"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isProposedTask(value: unknown, allowedTaskIds?: Set<string>): value is ProposedTask & { taskId?: string; reason?: string } {
  if (!isRecord(value) || !hasOnlyKeys(value, ["taskId", "title", "description", "priority", "phase", "userStory", "reason"])) return false;
  if (!isNonEmptyString(value.title) || !TASK_PRIORITIES.has(value.priority as string)) return false;
  if (value.taskId !== undefined && (!isNonEmptyString(value.taskId) || (allowedTaskIds && !allowedTaskIds.has(value.taskId)))) return false;
  return ["description", "phase", "userStory", "reason"].every((key) => value[key] === undefined || isNonEmptyString(value[key]));
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

export class ProjectChatService {
  private get agentTools(): OpenAI.Chat.Completions.ChatCompletionTool[] {
    return [
      {
        type: "function",
        function: {
          name: "propose_project",
          description: "Propose a new project for explicit user confirmation. This tool never creates the project.",
          parameters: {
            type: "object",
            properties: {
              name: { type: "string", description: "Project name" },
              description: { type: "string", description: "Brief project description" },
              phase: { type: "string", enum: ["product-modeling", "development", "marketing"], description: "Starting phase" },
              priority: { type: "string", enum: ["low", "medium", "high", "critical"], description: "Project priority" },
            },
            required: ["name"],
            additionalProperties: false,
          },
        },
      },
      {
        type: "function",
        function: {
          name: "propose_document",
          description: "Generate a full document and propose it to the user for review before saving.",
          parameters: {
            type: "object",
            properties: {
              projectId: { type: "string", description: "ID of the project" },
              projectName: { type: "string", description: "Project name" },
              title: { type: "string", description: "Document title" },
              content: { type: "string", description: "Full document content in markdown" },
              type: { type: "string", enum: ["requirements", "documentation", "note"], description: "Document type" },
            },
            required: ["title", "content", "type"],
            additionalProperties: false,
          },
        },
      },
      {
        type: "function",
        function: {
          name: "list_projects",
          description: "Return the list of all projects with their IDs and names.",
          parameters: { type: "object", properties: {}, additionalProperties: false },
        },
      },
    ];
  }

  private validateGeneralToolCall(name: string, value: unknown): LLMToolValidationResult {
    if (!isRecord(value)) return { valid: false, errors: ["Tool arguments must be an object"] };
    if (name === "list_projects") {
      return { valid: Object.keys(value).length === 0, errors: ["list_projects accepts no arguments"], data: value };
    }
    if (name === "propose_project") {
      const valid = hasOnlyKeys(value, ["name", "description", "phase", "priority"])
        && isNonEmptyString(value.name)
        && (value.description === undefined || typeof value.description === "string")
        && (value.phase === undefined || ["product-modeling", "development", "marketing"].includes(String(value.phase)))
        && (value.priority === undefined || ["low", "medium", "high", "critical"].includes(String(value.priority)));
      return { valid, errors: valid ? undefined : ["Invalid project proposal arguments"], data: value };
    }
    if (name === "propose_document") {
      const valid = hasOnlyKeys(value, ["projectId", "projectName", "title", "content", "type"])
        && isNonEmptyString(value.title)
        && isNonEmptyString(value.content)
        && ["requirements", "documentation", "note"].includes(String(value.type))
        && (value.projectId === undefined || isNonEmptyString(value.projectId))
        && (value.projectName === undefined || isNonEmptyString(value.projectName))
        && (isNonEmptyString(value.projectId) || isNonEmptyString(value.projectName));
      return { valid, errors: valid ? undefined : ["Invalid document proposal arguments"], data: value };
    }
    return { valid: false, errors: [`Unknown tool: ${name}`] };
  }

  private validateProjectToolCall(name: string, value: unknown): LLMToolValidationResult {
    if (!isRecord(value)) return { valid: false, errors: ["Tool arguments must be an object"] };
    if (name === "propose_tasks") {
      const valid = hasOnlyKeys(value, ["tasks"])
        && Array.isArray(value.tasks)
        && value.tasks.length > 0
        && value.tasks.length <= 50
        && value.tasks.every((task) => isProposedTask(task));
      return { valid, errors: valid ? undefined : ["Invalid proposed task list"], data: value };
    }
    if (name === "generate_epic") {
      const valid = hasOnlyKeys(value, ["title", "description", "tasks"])
        && isNonEmptyString(value.title)
        && isNonEmptyString(value.description)
        && Array.isArray(value.tasks)
        && value.tasks.length > 0
        && value.tasks.length <= 50
        && value.tasks.every((task) => isProposedTask(task));
      return { valid, errors: valid ? undefined : ["Invalid epic proposal"], data: value };
    }
    return { valid: false, errors: [`Unknown tool: ${name}`] };
  }

  async processGeneralChat(userId: string, request: ChatRequest): Promise<ChatResponse> {
    const session = await MemoryPersistence.getOrCreateSession(userId, "general", undefined, request.sessionId);
    const generalContext = await RepositoryContextBuilder.buildGeneralContext(userId, session.id);
    await MemoryPersistence.saveMessage(session.id, "user", request.message);

    const docText = await extractDocumentText((request.context?.documents as { name: string; mimeType: string; dataUrl: string }[]) ?? []);
    const effectiveMessage = request.message + docText;
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = this.buildGeneralPrompt(effectiveMessage, generalContext);
    injectImages(messages, request.context?.images as { name: string; dataUrl: string }[] | undefined);
    const actions: AIAction[] = [];
    let aiResponse = "";

    const gateway = LLMGateway.getInstance();

    for (let round = 0; round < 5; round++) {
      const completion = await gateway.callWithTools({
        stage: PipelineStages.APPLICATION_SUPPORT,
        context: { runId: session.id },
        messages,
        temperature: 0.7,
        maxTokens: 4000,
        tools: this.agentTools,
        toolChoice: "auto",
        validateToolCall: (name, args) => this.validateGeneralToolCall(name, args),
      });

      if (completion.content.type === "text") {
        aiResponse = completion.content.text;
        break;
      }

      messages.push({
        role: "assistant",
        content: completion.content.text,
        tool_calls: completion.content.toolCalls.map((call) => ({
          id: call.id,
          type: "function" as const,
          function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        })),
      });

      for (const call of completion.content.toolCalls) {
        let toolResult = "";

        try {
          const args = call.arguments as Record<string, any>;

          if (call.name === "propose_project") {
            actions.push({ type: "project_proposed", data: { ...args } });
            toolResult = JSON.stringify({ status: "proposed", message: "Project proposal requires user confirmation before creation." });
          } else if (call.name === "list_projects") {
            const projects = await prisma.project.findMany({
              where: { userId },
              select: { id: true, name: true, description: true, phase: true },
              orderBy: { createdAt: "desc" },
              take: 20,
            });
            toolResult = JSON.stringify(projects);
          } else if (call.name === "propose_document") {
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
              toolResult = JSON.stringify({ status: "proposed", message: "Document proposed to the user for review." });
            }
          }
        } catch (err) {
          console.error("Tool call error:", err);
          toolResult = JSON.stringify({ error: String(err) });
        }

        messages.push({ role: "tool", tool_call_id: call.id, content: toolResult });
      }
    }

    if (!aiResponse) throw new LLMProviderError("Tool workflow ended without a completed assistant response", { stage: PipelineStages.APPLICATION_SUPPORT });

    await MemoryPersistence.saveMessage(session.id, "assistant", aiResponse);
    if (!session.title) await MemoryPersistence.updateSessionTitle(session.id, request.message);

    return {
      message: aiResponse,
      sessionId: session.id,
      actions: actions.length ? actions : undefined,
      contextMeta: {
        generalContext,
        messageCount: await MemoryPersistence.getMessageCount(session.id),
        lastUpdated: new Date(),
      },
    };
  }

  async processProjectChat(userId: string, projectId: string, request: ChatRequest): Promise<ChatResponse> {
    const session = await MemoryPersistence.getOrCreateSession(userId, "project", projectId, request.sessionId);
    const projectContext = await RepositoryContextBuilder.buildProjectContext(projectId);
    await MemoryPersistence.saveMessage(session.id, "user", request.message);

    const docText = await extractDocumentText((request.context?.documents as { name: string; mimeType: string; dataUrl: string }[]) ?? []);
    const messages = this.buildProjectPrompt(request.message + docText, projectContext);
    injectImages(messages, request.context?.images as { name: string; dataUrl: string }[] | undefined);

    const completion = await LLMGateway.getInstance().callWithTools({
      stage: PipelineStages.APPLICATION_SUPPORT,
      context: { runId: session.id, projectId },
      messages,
      temperature: 0.7,
      maxTokens: 2000,
      tools: [
        {
          type: "function",
          function: {
            name: "propose_tasks",
            description: "Propose actionable Kanban tasks.",
            parameters: {
              type: "object",
              properties: {
                tasks: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      title: { type: "string" },
                      description: { type: "string" },
                      priority: { type: "string", enum: ["low", "medium", "high"] },
                      phase: { type: "string" },
                      userStory: { type: "string" },
                    },
                  required: ["title", "priority"],
                  additionalProperties: false,
                  },
                },
              },
              required: ["tasks"],
              additionalProperties: false,
            },
          },
        },
        {
          type: "function",
          function: {
            name: "generate_epic",
            description: "Break work into a named epic with multiple tasks.",
            parameters: {
              type: "object",
              properties: {
                title: { type: "string" },
                description: { type: "string" },
                tasks: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      title: { type: "string" },
                      description: { type: "string" },
                      priority: { type: "string", enum: ["low", "medium", "high"] },
                      phase: { type: "string" },
                      userStory: { type: "string" },
                    },
                    required: ["title", "priority"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["title", "description", "tasks"],
              additionalProperties: false,
            },
          },
        },
      ],
      toolChoice: "auto",
      validateToolCall: (name, args) => this.validateProjectToolCall(name, args),
    });

    let aiResponse = completion.content.text ?? "";
    let proposedTasks: ProposedTask[] | undefined;
    let proposedEpic: EpicProposal | undefined;

    if (completion.content.type === "tool_calls") {
      for (const call of completion.content.toolCalls) {
        const args = call.arguments as Record<string, any>;
        if (call.name === "propose_tasks") {
          proposedTasks = args.tasks as ProposedTask[];
          if (!aiResponse) aiResponse = `I've identified **${proposedTasks.length} task${proposedTasks.length !== 1 ? "s" : ""}** from our discussion.`;
        } else if (call.name === "generate_epic") {
          proposedEpic = args as unknown as EpicProposal;
          if (!aiResponse) aiResponse = `I've broken down **${proposedEpic.title}** into ${proposedEpic.tasks.length} tasks.`;
        }
      }
    }

    if (!aiResponse) throw new LLMProviderError("Project chat returned neither text nor a valid proposal", { stage: PipelineStages.APPLICATION_SUPPORT });

    await MemoryPersistence.saveMessage(session.id, "assistant", aiResponse);
    if (!session.title) await MemoryPersistence.updateSessionTitle(session.id, request.message);

    return {
      message: aiResponse,
      sessionId: session.id,
      proposedTasks,
      proposedEpic,
      contextMeta: {
        projectContext,
        messageCount: await MemoryPersistence.getMessageCount(session.id),
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
      (t: any) => t.dueDate && new Date(t.dueDate) < now && t.status !== "done",
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
      recommendations.push("Limit work-in-progress to 2-3 tasks per person.");
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
    const suggestionLimit = Number.isInteger(capacity) ? Math.min(50, Math.max(1, capacity)) : 10;
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

    const prompt = `You are a sprint planner. Given a sprint from ${sprint.startDate.toISOString().split("T")[0]} to ${sprint.endDate.toISOString().split("T")[0]}, suggest the best ${suggestionLimit} tasks to include.\n\nTasks to choose from:\n${JSON.stringify(taskSummary, null, 2)}\n\nReturn a JSON array of up to ${suggestionLimit} objects: { taskId, title, reason, priority }`;

    const allowedTaskIds = new Set(candidateTasks.map((task) => task.id));
    const res = await LLMGateway.getInstance().callStructured<{ tasks: { taskId: string; title: string; reason: string; priority: string }[] }>({
      stage: PipelineStages.TASK_DECOMPOSITION,
      messages: [{ role: "user", content: prompt }],
      schema: {
        name: "SprintTaskSuggestionsSchema",
        strict: true,
        schema: {
          type: "object", additionalProperties: false, required: ["tasks"],
          properties: { tasks: { type: "array", maxItems: suggestionLimit, items: {
            type: "object", additionalProperties: false,
            required: ["taskId", "title", "reason", "priority"],
            properties: { taskId: { type: "string" }, title: { type: "string" }, reason: { type: "string" }, priority: { type: "string", enum: ["low", "medium", "high"] } },
          } } },
        },
        validate: (value) => {
          if (!isRecord(value) || !hasOnlyKeys(value, ["tasks"]) || !Array.isArray(value.tasks) || value.tasks.length > suggestionLimit) return { valid: false, errors: ["Invalid sprint task proposal"] };
          const ids = new Set<string>();
          const valid = value.tasks.every((item) => {
            if (!isRecord(item) || !isProposedTask(item, allowedTaskIds) || !isNonEmptyString(item.taskId) || !isNonEmptyString(item.reason) || ids.has(item.taskId)) return false;
            ids.add(item.taskId); return true;
          });
          return { valid, errors: valid ? undefined : ["Sprint tasks must be unique current candidates"], data: value as any };
        },
      },
    });
    return res.content.tasks;
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
    const prompt = `You are a sprint planner for a project called "${project?.name}". Today is ${todayStr}.\n\nThe user wants to create a sprint: "${userPrompt}"\n\nAvailable tasks:\n${JSON.stringify(taskSummary, null, 2)}\n\nReturn a JSON object: { "name", "goal", "startDate", "endDate", "suggestedTasks" }`;

    const allowedTaskIds = new Set(allTasks.map((task) => task.id));
    const res = await LLMGateway.getInstance().callStructured<{
      name: string; goal: string; startDate: string; endDate: string;
      suggestedTasks: { taskId: string; title: string; reason: string; priority: string }[];
    }>({
      stage: PipelineStages.TASK_DECOMPOSITION,
      messages: [{ role: "user", content: prompt }],
      schema: {
        name: "SprintGenerationSchema", strict: true,
        schema: {
          type: "object", additionalProperties: false,
          required: ["name", "goal", "startDate", "endDate", "suggestedTasks"],
          properties: {
            name: { type: "string" }, goal: { type: "string" }, startDate: { type: "string" }, endDate: { type: "string" },
            suggestedTasks: { type: "array", items: { type: "object", additionalProperties: false,
              required: ["taskId", "title", "reason", "priority"],
              properties: { taskId: { type: "string" }, title: { type: "string" }, reason: { type: "string" }, priority: { type: "string", enum: ["low", "medium", "high"] } },
            } },
          },
        },
        validate: (value) => {
          if (!isRecord(value) || !hasOnlyKeys(value, ["name", "goal", "startDate", "endDate", "suggestedTasks"]) || !isNonEmptyString(value.name) || !isNonEmptyString(value.goal) || !isIsoDate(value.startDate) || !isIsoDate(value.endDate) || value.endDate < value.startDate || !Array.isArray(value.suggestedTasks)) return { valid: false, errors: ["Invalid sprint proposal"] };
          const ids = new Set<string>();
          const valid = value.suggestedTasks.every((item) => {
            if (!isRecord(item) || !isProposedTask(item, allowedTaskIds) || !isNonEmptyString(item.taskId) || !isNonEmptyString(item.reason) || ids.has(item.taskId)) return false;
            ids.add(item.taskId); return true;
          });
          return { valid, errors: valid ? undefined : ["Invalid suggested sprint task"], data: value as any };
        },
      },
    });
    return res.content;
  }

  async suggestTaskOrder(tasks: { id: string; title: string; description?: string }[]): Promise<string[]> {
    if (tasks.length <= 1) return tasks.map((t) => t.id);

    const validIds = new Set(tasks.map((task) => task.id));
    const completion = await LLMGateway.getInstance().callStructured<{ order: string[] }>({
      stage: PipelineStages.PLAN_REORDER,
      messages: [
        {
          role: "system",
          content: `Order these development tasks into the most sensible build sequence. Respond with ONLY valid JSON: { "order": ["taskId1", "taskId2", ...] }`,
        },
        {
          role: "user",
          content: tasks.map((t) => `- id: ${t.id}\n  title: ${t.title}${t.description ? `\n  description: ${t.description}` : ""}`).join("\n"),
        },
      ],
      temperature: 0,
      maxTokens: 500,
      schema: {
        name: "TaskOrderSchema", strict: true,
        schema: { type: "object", additionalProperties: false, required: ["order"], properties: { order: { type: "array", items: { type: "string" } } } },
        validate: (value) => {
          if (!isRecord(value) || !hasOnlyKeys(value, ["order"]) || !Array.isArray(value.order) || value.order.length !== tasks.length) return { valid: false, errors: ["Task order must include every task exactly once"] };
          const unique = new Set(value.order);
          const valid = unique.size === tasks.length && value.order.every((id) => typeof id === "string" && validIds.has(id));
          return { valid, errors: valid ? undefined : ["Task order contains missing, duplicate, or unknown IDs"], data: value as { order: string[] } };
        },
      },
    });
    return completion.content.order;
  }

  async generatePhaseProposal(
    projectId: string,
    phase: string,
    revision?: { previousContent: string; feedback: string },
    brief?: string,
  ): Promise<{ title: string; content: string; model: string; usage: { prompt_tokens: number; completion_tokens: number }; costUSD: number }> {
    const projectContext = await RepositoryContextBuilder.buildProjectContext(projectId);
    const revisionBlock = revision
      ? `\nPREVIOUS DRAFT:\n${revision.previousContent}\n\nREVIEWER FEEDBACK:\n${revision.feedback}\n`
      : "";

    const briefBlock = brief ? `\nBRIEF FROM USER:\n${brief}\n` : "";

    const systemPrompt = `You are drafting the "${phase}" phase document for project "${projectContext.project.name}".\n\nPROJECT DESCRIPTION:\n${projectContext.project.description || "No description provided."}\n\nMEMORY SUMMARY:\n${projectContext.summary?.summary || "No prior context."}\n${briefBlock}${revisionBlock}\n\nTASK: ${this.phasePromptInstructions(phase)}\n\nRespond in clean Markdown only.`;

    const completion = await LLMGateway.getInstance().call({
      stage: PipelineStages.ROADMAP_PLANNING,
      messages: [{ role: "system", content: systemPrompt }],
      temperature: 0.4,
      maxTokens: 2000,
    });

    let content = completion.content;
    const wholeFenceMatch = content.match(/^```[a-z]*\n([\s\S]*)\n```\s*$/);
    if (wholeFenceMatch) content = wholeFenceMatch[1];

    const usage = {
      prompt_tokens: completion.usage?.promptTokens || 0,
      completion_tokens: completion.usage?.completionTokens || 0,
    };

    return {
      title: `${projectContext.project.name} — ${phase.charAt(0).toUpperCase() + phase.slice(1)} Proposal`,
      content,
      model: completion.model,
      usage,
      costUSD: estimateCostUSD(completion.model, usage),
    };
  }

  private phasePromptInstructions(phase: string): string {
    switch (phase) {
      case "requirements":
        return "Parse the project brief into: user stories, acceptance criteria, and constraints.";
      case "documentation":
        return "Write a PRD covering: overview, API outlines, data models, edge cases, and acceptance criteria.";
      case "architecture":
        return "Write an architecture proposal with these sections: System Overview, Components & Responsibilities, Data Flow & APIs, Technology Decisions, Risks & Mitigations, and Recommended Diagrams (Mermaid).";
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

  private buildGeneralPrompt(userMessage: string, context: GeneralContext): Array<{ role: "system" | "user" | "assistant"; content: string }> {
    const systemPrompt = `You are an agentic AI assistant embedded in a project management workspace.
Workspace context:
- User: ${context.workspaceInfo?.user.name || context.workspaceInfo?.user.email || "Unknown"}
- Total Projects: ${context.workspaceInfo?.totalProjects || 0}
- Active Projects: ${context.workspaceInfo?.activeProjects || 0}`;

    return [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ];
  }

  private buildProjectPrompt(userMessage: string, context: ProjectContext): Array<{ role: "system" | "user" | "assistant"; content: string }> {
    const systemPrompt = `You are a specialized AI assistant for the project "${context.project.name}".
PROJECT DETAILS:
- Name: ${context.project.name}
- Description: ${context.project.description || "No description"}
- Phase: ${context.project.phase || "Not specified"}`;

    return [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ];
  }
}
