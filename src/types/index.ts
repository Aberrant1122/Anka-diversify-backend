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

export interface ProposedTask {
  title: string;
  description?: string;
  priority: "low" | "medium" | "high";
  phase?: string;
  userStory?: string;
}

export interface EpicProposal {
  title: string;
  description: string;
  tasks: ProposedTask[];
}

export interface ProjectHealth {
  score: number;
  status: "healthy" | "warning" | "critical";
  flags: string[];
  recommendations: string[];
  stats: {
    totalTasks: number;
    completedTasks: number;
    overdueTasks: number;
    inProgressTasks: number;
    completionRate: number;
  };
}

export interface PullRequest {
  number: number;
  title: string;
  author: string;
  state: "open" | "closed" | "merged";
  createdAt: string;
  updatedAt: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  url: string;
  draft: boolean;
  body?: string;
  labels: string[];
  baseBranch: string;
  headBranch: string;
}

export interface PRReview {
  summary: string;
  risks: string[];
  suggestions: string[];
  verdict: "approve" | "request_changes" | "needs_discussion";
  qualityScore: number;
}

export interface AIAction {
  type: 'project_created' | 'document_proposed' | 'document_saved';
  data: Record<string, unknown>;
}

export interface ChatResponse {
  message: string;
  sessionId: string;
  proposedTasks?: ProposedTask[];
  proposedEpic?: EpicProposal;
  actions?: AIAction[];
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

// Knowledge Graph Component Hierarchy Types (Component -> Who imports it -> Who renders it -> Which route owns it -> Is it reachable -> Can user navigate to it)
export interface ComponentImportRef {
  file: string;
  importedSymbols: string[];
}

export interface ComponentRenderRef {
  file: string;
  parentComponent: string;
  jsxTag: string;
}

export interface RouteOwnershipRef {
  routeFile: string;
  routePath: string;
}

export interface NavigationTriggerRef {
  file: string;
  type: "Link" | "router.push" | "nav_item" | "anchor";
  targetHref: string;
}

export interface ComponentKnowledgeNode {
  /** 1. Component symbol name */
  component: string;
  /** Source file path */
  file: string;
  /** Export kind */
  exportKind: string;

  /** 2. Who imports it? */
  whoImportsIt: ComponentImportRef[];

  /** 3. Who renders it? */
  whoRendersIt: ComponentRenderRef[];

  /** 4. Which route owns it? */
  whichRouteOwnsIt: RouteOwnershipRef | null;

  /** 5. Is it reachable? */
  isReachable: boolean;
  reachabilityReason: string;

  /** 6. Can user navigate to it? */
  canUserNavigateToIt: boolean;
  navigationTriggers: NavigationTriggerRef[];
}

export interface ExtendedKnowledgeGraph {
  exports: Array<{ file: string; kind: string; symbol: string }>;
  imports: Array<{ file: string; source: string; importedSymbols: string[] }>;
  dependencyGraph: Record<string, string[]>;
  componentNodes: Record<string, ComponentKnowledgeNode>;
}

// Coding Agent Types
export interface AgentFileChange {
  path: string;
  content: string;
  description: string;
  layer?: "Controller" | "Service" | "Repository" | "Schema" | "UI";
  action?: "create" | "modify" | "delete";
  isDeleted?: boolean;
}

export interface RoadmapStep {
  phase: number;
  title: string;
  layer?: "Controller" | "Service" | "Repository" | "Schema" | "UI";
  targetFiles: string[];
  description: string;
}

export interface ChecklistItem {
  label: string;
  checked: boolean;
  category?: string;
}

export type TaskType =
  | "DELETE_FOLDER"
  | "DELETE_FILE"
  | "NEW_FEATURE"
  | "BUG_FIX"
  | "REFACTOR"
  | "FILE_CREATION"
  | "CONFIG_CHANGE"
  | "DOCS"
  | "OPTIMIZATION";

export type TaskRisk = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type TaskComplexity = "SMALL" | "MEDIUM" | "LARGE" | "COMPLEX";

export interface TaskClassificationResult {
  taskType: TaskType;
  risk: TaskRisk;
  estimatedComplexity: TaskComplexity;
  intent: "BUG_FIX" | "FEATURE_ADD" | "REFACTOR" | "DOCS" | "OPTIMIZATION" | "DELETE_FOLDER" | "DELETE_FILE" | "NEW_FEATURE";
  confidence: number;
  requiresClarification: boolean;
  reasoning: string;
  targetPath?: string;
  question?: string;
  options?: string[];
}

export type PipelineMode =
  | "REPOSITORY"
  | "STANDALONE"
  | "DOCUMENTATION"
  | "DIRECT_ANSWER";

export type TargetEnvironment =
  | "HTML_CSS_JS"
  | "REACT_TS"
  | "NODE_JS"
  | "PYTHON"
  | "MARKDOWN"
  | "GENERIC";

export type ValidationType =
  | "TYPESCRIPT_BUILD"
  | "BROWSER_HTML"
  | "PYTHON_SYNTAX"
  | "NONE";

/**
 * Execution Contract — generated from TaskClassificationResult & TaskRouter.
 * This contract actively governs every downstream pipeline stage:
 *  - Pipeline routing (REPOSITORY vs STANDALONE vs DOCS vs DIRECT_ANSWER)
 *  - Target environment (HTML_CSS_JS vs REACT_TS vs PYTHON, etc.)
 *  - Repo search scope (bypassed if repositoryRequired = false)
 *  - Context retrieval filter (only contextScope paths)
 *  - Code generation guardrails (LLM system prompt injection)
 *  - Diff critic enforcement (reject files outside scope)
 *  - Validation engine (BROWSER_HTML vs TYPESCRIPT_BUILD)
 */
export interface ExecutionContract {
  /** Human-readable one-line goal */
  goal: string;
  taskType: TaskType;
  risk: TaskRisk;
  estimatedComplexity: TaskComplexity;
  /** Routed execution pipeline mode */
  pipeline: PipelineMode;
  /** Primary target technical environment */
  environment: TargetEnvironment;
  /** Whether repository searching & graph exploration are required */
  repositoryRequired: boolean;
  /** Target expected file layout (e.g. ["index.html", "style.css", "script.js"]) */
  expectedFiles: string[];
  /** Primary validation strategy for Stage 5 & 6 */
  validationType: ValidationType;
  /** Canonical target paths the task operates on (e.g. ["src/lib"]) */
  targetPaths: string[];
  /** Actions the LLM and agent are permitted to perform */
  allowedActions: string[];
  /** Actions that are strictly forbidden */
  forbiddenActions: string[];
  /** Hard cap: max number of files the agent may touch for this task */
  maxFiles: number;
  /** Paths the repository search loop is authorised to search within */
  searchScope: string[];
  /** Paths the context retrieval step is allowed to load into the LLM window */
  contextScope: string[];
  /** Whether the Diff Critic stage should run */
  diffCriticEnabled: boolean;
}


export interface AgentResponse {
  explanation: string;
  changes: AgentFileChange[];
  commitMessage: string;
  sessionId: string;
  needsClarification?: boolean;
  question?: string;
  options?: string[];
  intent?: "BUG_FIX" | "FEATURE_ADD" | "REFACTOR" | "DOCS" | "OPTIMIZATION" | "DELETE_FOLDER" | "DELETE_FILE" | "NEW_FEATURE";
  taskType?: TaskType;
  risk?: TaskRisk;
  estimatedComplexity?: TaskComplexity;
  targetPath?: string;
  confidence?: number;
  roadmap?: RoadmapStep[];
  securityPass?: boolean;
  critiqueScore?: number;
  layerViolations?: string[];
  buildVerified?: boolean;
  repaired?: boolean;
  buildErrors?: string;
  verificationChecklist?: ChecklistItem[];
  lifecycleStage?: "Done" | "Verify" | "Run App" | "Wire Everything" | "Generate Files" | "Determine Completion" | "Understand Goal" | "Task";
}

export interface AgentProgressEvent {
  step: number;
  stageName: string;
  label: string;
  detail: string;
  color: string;
  badge: string;
  progress: number;
  log?: string;
  taskType?: TaskType;
  risk?: TaskRisk;
  estimatedComplexity?: TaskComplexity;
  targetPath?: string;
  /** Full Execution Contract emitted in Stage 1 for frontend display */
  executionContract?: ExecutionContract;
}

// ────────────────────────────────────────────────────────────────────────────
// File Manifest Types (Requirements 1.2, 2.1)
// ────────────────────────────────────────────────────────────────────────────

export interface FileDeclaration {
  /** Relative path from project root (e.g., "src/components/Button.tsx") */
  path: string;
  /** Action to perform on this file */
  action: "create" | "modify" | "delete";
  /** Array of import paths this file depends on */
  dependencies: string[];
  /** Human-readable description of file purpose */
  description: string;
  /** Optional size estimate */
  estimatedLines?: number;
}

export interface FileManifest {
  /** Array of file declarations */
  files: FileDeclaration[];
  /** Total number of files in manifest */
  totalFiles: number;
  /** Manifest schema version (e.g., "1.0.0") */
  manifestVersion: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Manifest Validation Types (Requirements 7.3, 8.1, 8.2)
// ────────────────────────────────────────────────────────────────────────────

export type ValidationErrorType =
  | "schema"
  | "import_resolution"
  | "file_limit"
  | "orphan"
  | "path_constraint";

export interface ValidationError {
  /** Type of validation error */
  type: ValidationErrorType;
  /** Files affected by this error */
  affectedFiles: string[];
  /** Human-readable error message */
  message: string;
  /** Actionable suggestion for fixing the error */
  suggestion: string;
}

export interface ValidationResult {
  /** Whether the validation passed */
  valid: boolean;
  /** Array of validation errors (empty if valid) */
  errors: ValidationError[];
}

// ────────────────────────────────────────────────────────────────────────────
// Task Decomposition Types (Requirements 7.3, 8.1, 8.2)
// ────────────────────────────────────────────────────────────────────────────

export type SubTaskCategory =
  | "types_and_interfaces"
  | "mock_data"
  | "leaf_components"
  | "container_components"
  | "routing_and_navigation"
  | "api_integration"
  | "state_management";

export interface SubTask {
  /** Unique identifier (e.g., "subtask-1") */
  id: string;
  /** Category of the sub-task */
  category: SubTaskCategory;
  /** Human-readable description */
  description: string;
  /** Expected output files for this sub-task */
  targetFiles: string[];
  /** Array of sub-task IDs this task depends on */
  dependencies: string[];
  /** Estimated complexity */
  estimatedComplexity: "SMALL" | "MEDIUM";
}

export interface DependencyExecutionGraph {
  /** Array of sub-tasks */
  nodes: SubTask[];
  /** Topologically sorted sub-task IDs (execution order) */
  executionOrder: string[];
  /** Graph schema version (e.g., "1.0.0") */
  graphVersion: string;
}

// ────────────────────────────────────────────────────────────────────────────
// In-Memory Data Structures for Graph Processing
// ────────────────────────────────────────────────────────────────────────────

export interface DependencyGraph {
  /** Map of subTaskId to Set of dependent subTaskIds */
  adjacencyList: Map<string, Set<string>>;
  /** Map of subTaskId to count of dependencies */
  inDegree: Map<string, number>;
}

export interface SubTaskExecutionResult {
  /** ID of the executed sub-task */
  subTaskId: string;
  /** Whether the execution was successful */
  success: boolean;
  /** Generated manifest for this sub-task */
  manifest: FileManifest;
  /** Code changes produced */
  changes: AgentFileChange[];
  /** Error messages if failed */
  errors?: string[];
}

export interface DecompositionExecutionState {
  /** The dependency execution graph */
  graph: DependencyExecutionGraph;
  /** Map of completed sub-task results */
  completed: Map<string, SubTaskExecutionResult>;
  /** Set of failed sub-task IDs */
  failed: Set<string>;
  /** Set of currently executing sub-task IDs */
  inProgress: Set<string>;
  /** Set of pending sub-task IDs */
  pending: Set<string>;
}

export interface ImportGraph {
  /** Map of filePath to Set of files that import it */
  dependencies: Map<string, Set<string>>;
  /** Function to check if a file is an entry point */
  isEntryPoint: (filePath: string) => boolean;
  /** Function to check if a file is a config file */
  isConfigFile: (filePath: string) => boolean;
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
