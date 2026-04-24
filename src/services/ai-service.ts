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
    const startTime = Date.now();

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

  async runCodingAgent(
    userId: string,
    projectId: string,
    request: ChatRequest,
  ): Promise<AgentResponse> {
    const session = await this.getOrCreateSession(userId, "project", projectId, request.sessionId);
    const projectContext = await this.buildProjectContext(projectId);

    await this.saveMessage(session.id, "user", request.message);

    const snapshot = projectContext.repoSnapshot;
    const repoInfo = snapshot
      ? `
REPOSITORY: ${snapshot.repoName} (branch: ${snapshot.defaultBranch})
LANGUAGES: ${Object.keys(snapshot.languages).slice(0, 6).join(", ")}

FILE TREE (${snapshot.fileTree.length} files):
${snapshot.fileTree.slice(0, 200).join("\n")}

KEY FILE CONTENTS:
${snapshot.keyFiles.map((f: any) => `=== ${f.path} ===\n${f.content}`).join("\n\n")}`
      : "No repository connected. Inform the user to connect a GitHub repo first.";

    const systemPrompt = `You are a coding agent for the project "${projectContext.project.name}". You can read and edit files in the connected GitHub repository.

Your job is to fulfill the user's coding request by producing exact file changes.

${repoInfo}

ACTIVE TASKS:
${projectContext.activeTasks.map((t: any) => `- ${t.title} (${t.status})`).join("\n") || "None"}

WORKFLOW — follow these steps in order for every task:
1. UNDERSTAND — read the request carefully, clarify the goal and scope
2. INSPECT — examine relevant existing files in the repo before writing anything
3. PLAN — decide the minimal set of files to change and what each change achieves
4. APPLY — make minimal, focused changes; do not refactor unrelated code
5. VALIDATE — ensure the changes are consistent with the existing code style, types, and patterns
6. FIX — if there are type errors, import issues, or broken logic, fix them before returning

RULES:
- Only change files that exist in the file tree above
- Write complete file contents (not diffs or partials)
- Follow the existing code style and patterns you see in the key files
- If the repo is not connected, explain and return empty changes array
- Never add unrelated changes, comments, or refactors beyond what was asked
- If a task is ambiguous, make the safest minimal change and explain assumptions in the explanation field
- NEVER create or modify a file without first reading the relevant existing files in the repo
- ALWAYS search the codebase for existing patterns, utilities, and conventions before generating new code — do not duplicate what already exists
- Only change what is strictly necessary to fulfil the request — nothing more
- Preserve existing formatting, naming conventions, and file structure exactly as found
- Prefer targeted edits over full file rewrites; rewrite the full file only when the change touches more than half of it
- VALIDATION — after every set of changes:
  - Always run a build or typecheck (e.g. tsc --noEmit, npm run build) to verify the changes compile
  - Run tests if a test suite exists (e.g. npm test, jest, vitest) — never skip this step
  - If build or test errors occur: read the full error log, identify the root cause, and fix it automatically before returning the result
  - Never return changes that are known to be broken — all changes must pass validation before being proposed
- UI CONSISTENCY (apply to every frontend change):
  A. DESIGN SYSTEM — use only the established design system, never invent new patterns:
    - Font: Geist (sans) / Geist Mono (mono) — set via --font-sans / --font-mono CSS vars
    - Border radius: use rounded-md (default --radius: 0.5rem) or rounded-lg — never arbitrary values
    - Spacing: Tailwind default scale only — no arbitrary values like p-[13px]
    - All colors via semantic Tailwind tokens — NEVER hardcode hex/rgb values:
      · bg-background / text-foreground (page surfaces)
      · bg-card / text-card-foreground (cards)
      · bg-primary / text-primary-foreground (actions)
      · bg-secondary / text-secondary-foreground (subtle areas)
      · bg-muted / text-muted-foreground (disabled, hints)
      · bg-accent / text-accent-foreground (highlights)
      · bg-destructive / text-destructive-foreground (errors/delete)
      · text-success, text-warning (status indicators)
      · bg-sidebar / bg-sidebar-accent (sidebar surfaces)
  B. COMPONENT REUSE — before creating any UI element:
    - Check /components/ui/ first — it has: Button, Card, Badge, Avatar, Dialog, Input, Textarea, Select, Tabs, Table, Tooltip, Popover, DropdownMenu, Sheet, Separator, Progress, Skeleton, Spinner, ScrollArea, Switch, Checkbox, Label, Form, Accordion, Alert, Command, and more
    - NEVER create a new component if one already exists in /components/ui/
    - NEVER duplicate layout or pattern already used in an existing page — extend it instead
    - NEVER introduce new UI libraries (no Chakra, MUI, Radix direct imports, Ant Design, etc.) — shadcn/ui components are already wired
  C. STYLE CONSTRAINTS:
    - No inline styles (style prop) — use Tailwind classes only
    - No hardcoded colors — always use semantic tokens above
    - No new CSS files or custom class definitions unless absolutely unavoidable
    - Maintain responsiveness: use sm/md/lg/xl breakpoints consistent with existing pages
    - Keep accessibility: always include aria-label on icon-only buttons, htmlFor on labels, role where needed
  D. CONTEXT TO REFERENCE for UI work — always read these before writing frontend code:
    - The file being changed + its direct imports
    - /components/ui/button.tsx and /components/ui/card.tsx (baseline patterns)
    - The nearest existing page that has similar layout to what's being built
    - app/globals.css (for CSS variables and tokens)
  E. ANTI-PATTERNS — never do these:
    - No inline style prop with color values
    - No arbitrary color values in className (e.g. text-[#abc])
    - No new icon libraries — use lucide-react (already installed)
    - No div used as a button — use the Button component
    - No layout built from scratch if an existing page already has the same structure
- CONTEXT SELECTION (critical — do not ignore):
  - Never load the entire codebase into context — it exceeds limits and degrades quality
  - Select only the files directly relevant to the task:
    1. The file being changed (highest priority — always include)
    2. Files it directly imports or that import it
    3. Related components or modules that share the same feature area
    4. Type definition files if types are involved
  - Exclude: test fixtures, lock files, generated files, unrelated pages, config files not touched by the task
  - If uncertain which files are relevant, start with the current file and its imports only — expand only if needed
  - Keep total context under 20 files; if more are needed, summarize rather than include in full
- TOOL BOUNDARIES:
  - ALLOWED: read any file, write or create source files, run safe commands (npm install, npm run build, npm run lint, tsc --noEmit, git status, git diff)
  - RESTRICTED — never do any of the following:
    - Delete, move, or rename core files (package.json, tsconfig, schema.prisma, config files, CI files)
    - Run destructive shell commands (rm -rf, git reset --hard, git push --force, DROP TABLE, truncate, kill)
    - Modify environment files (.env, .env.local) or secrets
    - Install packages without listing them in the explanation first

You MUST respond with ONLY valid JSON in this exact shape:
{
  "explanation": "Clear explanation of what you're changing and why",
  "changes": [
    {
      "path": "relative/path/to/file.ts",
      "content": "complete new file content here",
      "description": "one-line summary of what changed in this file"
    }
  ],
  "commitMessage": "conventional commit message e.g. feat: add X to Y"
}`;

    const completion = await this.getOpenAI().chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: request.message },
      ],
      temperature: 0.2,
      max_tokens: 4000,
      response_format: { type: "json_object" },
    });

    const raw = completion.choices[0]?.message?.content || "{}";

    let parsed: { explanation: string; changes: AgentFileChange[]; commitMessage: string };
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = { explanation: raw, changes: [], commitMessage: "chore: AI agent changes" };
    }

    const summary = `[Agent] ${parsed.explanation}\n\nFiles to change:\n${parsed.changes.map((c: AgentFileChange) => `- ${c.path}: ${c.description}`).join("\n")}`;
    await this.saveMessage(session.id, "assistant", summary);

    if (!session.title) {
      await this.updateSessionTitle(session.id, request.message);
    }

    return {
      explanation: parsed.explanation || "",
      changes: parsed.changes || [],
      commitMessage: parsed.commitMessage || "chore: AI agent changes",
      sessionId: session.id,
    };
  }
}
