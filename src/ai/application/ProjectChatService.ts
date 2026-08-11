import OpenAI from "openai";
import { PrismaClient } from "@prisma/client";
import { getOpenAI, extractDocumentText, injectImages, modelForPhase, estimateCostUSD } from "../shared/utils";
import { ChatRequest, ChatResponse, ProposedTask, EpicProposal, ProjectHealth, GeneralContext, ProjectContext, AIAction } from "../shared/types";
import { RepositoryContextBuilder } from "../repository/RepositoryContextBuilder";
import { MemoryPersistence } from "../memory/MemoryPersistence";

const prisma = new PrismaClient();

export class ProjectChatService {
  private get agentTools(): OpenAI.Chat.Completions.ChatCompletionTool[] {
    return [
      {
        type: "function",
        function: {
          name: "create_project",
          description: "Create a new project in the workspace. Call this whenever the user asks to create, start, set up, or launch a project.",
          parameters: {
            type: "object",
            properties: {
              name: { type: "string", description: "Project name" },
              description: { type: "string", description: "Brief project description" },
              phase: { type: "string", enum: ["product-modeling", "development", "marketing"], description: "Starting phase" },
              priority: { type: "string", enum: ["low", "medium", "high", "critical"], description: "Project priority" },
            },
            required: ["name"],
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
          },
        },
      },
      {
        type: "function",
        function: {
          name: "list_projects",
          description: "Return the list of all projects with their IDs and names.",
          parameters: { type: "object", properties: {} },
        },
      },
    ];
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

    const openai = getOpenAI();

    for (let round = 0; round < 5; round++) {
      const completion = await openai.chat.completions.create({
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

      if (!assistantMsg.tool_calls?.length) {
        aiResponse = assistantMsg.content ?? "";
        break;
      }

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
          } else if (call.function.name === "list_projects") {
            const projects = await prisma.project.findMany({
              select: { id: true, name: true, description: true, phase: true },
              orderBy: { createdAt: "desc" },
              take: 20,
            });
            toolResult = JSON.stringify(projects);
          } else if (call.function.name === "propose_document") {
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
              toolResult = JSON.stringify({ success: true, status: "proposed", message: "Document proposed to the user for review." });
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

    const openai = getOpenAI();
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages,
      temperature: 0.7,
      max_tokens: 2000,
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
              aiResponse = `I've identified **${proposedTasks.length} task${proposedTasks.length !== 1 ? "s" : ""}** from our discussion.`;
            }
          } else if (call.function.name === "generate_epic") {
            proposedEpic = args as EpicProposal;
            if (!aiResponse) {
              aiResponse = `I've broken down **${proposedEpic.title}** into ${proposedEpic.tasks.length} tasks.`;
            }
          }
        } catch {}
      }
    }

    if (!aiResponse) aiResponse = "I apologize, but I could not generate a response.";

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
    const openai = getOpenAI();
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

    const prompt = `You are a sprint planner. Given a sprint from ${sprint.startDate.toISOString().split("T")[0]} to ${sprint.endDate.toISOString().split("T")[0]}, suggest the best ${capacity} tasks to include.\n\nTasks to choose from:\n${JSON.stringify(taskSummary, null, 2)}\n\nReturn a JSON array of up to ${capacity} objects: { taskId, title, reason, priority }`;

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
    const openai = getOpenAI();
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

  async suggestTaskOrder(tasks: { id: string; title: string; description?: string }[]): Promise<string[]> {
    if (tasks.length <= 1) return tasks.map((t) => t.id);

    const openai = getOpenAI();
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
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
    const projectContext = await RepositoryContextBuilder.buildProjectContext(projectId);
    const model = modelForPhase(phase);

    const revisionBlock = revision
      ? `\nPREVIOUS DRAFT:\n${revision.previousContent}\n\nREVIEWER FEEDBACK:\n${revision.feedback}\n`
      : "";

    const briefBlock = brief ? `\nBRIEF FROM USER:\n${brief}\n` : "";

    const systemPrompt = `You are drafting the "${phase}" phase document for project "${projectContext.project.name}".\n\nPROJECT DESCRIPTION:\n${projectContext.project.description || "No description provided."}\n\nMEMORY SUMMARY:\n${projectContext.summary?.summary || "No prior context."}\n${briefBlock}${revisionBlock}\n\nTASK: ${this.phasePromptInstructions(phase)}\n\nRespond in clean Markdown only.`;

    const openai = getOpenAI();
    const completion = await openai.chat.completions.create({
      model,
      messages: [{ role: "system", content: systemPrompt }],
      temperature: 0.4,
      max_tokens: 2000,
    });

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
      costUSD: estimateCostUSD(model, usage),
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
