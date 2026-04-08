export interface User {
  id: string;
  email: string;
  name: string | undefined;
  role: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Project {
  id: string;
  name: string;
  description?: string;
  phase?: string;
  progress: number;
  teamSize: number;
  priority: string;
  status: string;
  githubUrl?: string;
  // snake_case aliases kept for backward compat
  github_url?: string;
  start_date: string;
  due_date: string;
  created_at: string;
  updated_at: string;
  userId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Task {
  id: string;
  projectId: string;
  title: string;
  description?: string;
  status: "todo" | "in-progress" | "review" | "done";
  priority: "low" | "medium" | "high" | "critical";
  assigneeId?: string;
  dueDate?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface AiChatSession {
  id: string;
  type: "general" | "project";
  userId: string;
  projectId?: string;
  title?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface AiChatMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  metadata?: Record<string, any>;
  createdAt: Date;
}

export interface ProjectMemorySummary {
  id: string;
  projectId: string;
  summary: string;
  lastUpdated: Date;
  version: number;
}

export interface ProjectDecision {
  id: string;
  projectId: string;
  title: string;
  description: string;
  impact?: string;
  madeAt: Date;
  madeBy?: string;
}

export interface ProjectRule {
  id: string;
  projectId: string;
  title: string;
  description: string;
  priority: "low" | "medium" | "high";
  createdAt: Date;
}

export interface ProjectTask {
  id: string;
  projectId: string;
  title: string;
  description?: string;
  status: "todo" | "in_progress" | "done";
  priority: "low" | "medium" | "high";
  dueDate?: Date;
  createdAt: Date;
  updatedAt: Date;
}

// API Request/Response Types
export interface ChatRequest {
  message: string;
  sessionId?: string;
  context?: Record<string, any>;
}

export interface ChatResponse {
  message: string;
  sessionId: string;
  contextMeta?: {
    projectContext?: ProjectContext;
    generalContext?: GeneralContext;
    messageCount: number;
    lastUpdated: Date;
  };
}

export interface RepoKeyFile {
  repoSnapshot: any;
  path: string;
  content: string;
}

export interface RepoSnapshot {
  repoName: string;
  defaultBranch: string;
  description: string;
  languages: Record<string, number>;
  fileTree: string[];
  keyFiles: RepoKeyFile[];
  lastSyncedAt: Date;
}

export interface ProjectContext {
  project: Project;
  summary?: ProjectMemorySummary;
  recentMessages: AiChatMessage[];
  recentDecisions: ProjectDecision[];
  rules: ProjectRule[];
  activeTasks: ProjectTask[];
  repoSnapshot?: RepoSnapshot;
}

export interface GeneralContext {
  recentMessages: AiChatMessage[];
  workspaceInfo?: {
    totalProjects: number;
    activeProjects: number;
    user: {
      id: string;
      name: string | undefined;
      email: string;
      createdAt: Date;
      updatedAt: Date;
    };
  };
}

export interface SessionListResponse {
  sessions: Array<{
    id: string;
    title?: string;
    type: "general" | "project";
    projectId?: string;
    projectName?: string;
    createdAt: Date;
    updatedAt: Date;
    messageCount: number;
    lastMessage?: string;
  }>;
}

export interface MessageListResponse {
  messages: AiChatMessage[];
  session: AiChatSession;
  contextMeta?: {
    projectContext?: ProjectContext;
    generalContext?: GeneralContext;
  };
}

// OpenAI Types
export interface ChatCompletionRequest {
  messages: Array<{
    role: "system" | "user" | "assistant";
    content: string;
  }>;
  model?: string;
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
}

export interface ContextMetadata {
  tokensUsed: number;
  contextBuildTime: number;
  sources: string[];
  lastUpdated: Date;
}

// Error Types
export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, any>;
}

// Database Query Options
export interface QueryOptions {
  limit?: number;
  offset?: number;
  orderBy?: "asc" | "desc";
  include?: {
    messages?: boolean;
    project?: boolean;
    user?: boolean;
  };
}
