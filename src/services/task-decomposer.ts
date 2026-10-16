import OpenAI from "openai";
import {
  DependencyExecutionGraph,
  SubTask,
  SubTaskCategory,
  TaskClassificationResult,
  DependencyGraph,
  RepositoryContextOption,
  CrossRepoEdge,
} from "../types";
import { TASK_DECOMPOSITION_PROMPT } from "../ai/prompts/coding";
import {
  detectRepositoryArchitecture,
  detectPrimaryActiveEntryPoint,
  buildRepositoryUISystemPromptSection,
} from "../ai/planning/RepositoryArchitectureDetector";
import { LLMGateway } from "../ai/gateway/LLMGateway";
import { PipelineStages } from "../ai/gateway/PipelineStage";
import { ImplementationAuthority } from "../planning/implementation-authority-preflight";
import { PlanningDomainError } from "../planning/planning-errors";
import { WorkflowContextService } from "./workflow-context.service";

export interface KanbanTaskProposal {
  key: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  targetFiles: string[];
  architectureComponentIds: string[];
  dependencyKeys: string[];
  repositoryId?: string;
}

export interface KanbanStageProposal {
  title: string;
  order: number;
  tasks: KanbanTaskProposal[];
}

export interface KanbanBoardProposal {
  stages: KanbanStageProposal[];
}

function isSafeRelativePath(value: string): boolean {
  if (!value || value !== value.trim() || value.includes("\0")) return false;
  const normalized = value.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) return false;
  return normalized.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

export class TaskDecomposer {
  private openai: OpenAI;

  constructor(openaiClient?: OpenAI) {
    if (openaiClient) {
      this.openai = openaiClient;
    } else {
      const apiKey = process.env.OPENAI_API_KEY || "";
      this.openai = new OpenAI({ apiKey });
    }
  }

  /**
   * Decomposes a complex request into a Directed Acyclic Graph (DAG) of sub-tasks based on structured intent.
   *
   * Invariants (Phase 1B):
   * 1. Decomposes from structured intent only (taskType, complexity, risk).
   * 2. No prompt wording checks determining architecture or templates.
   * 3. Fails closed on decomposition failure; zero invented paths.
   */
  public async decomposeTask(
    userRequest: string,
    repositoryContext: { existingFiles?: string[]; repoSnapshot?: any },
    intentResult: TaskClassificationResult,
    availableRepositories?: RepositoryContextOption[]
  ): Promise<DependencyExecutionGraph> {
    const existingFiles = repositoryContext.existingFiles || [];
    const isMultiRepo = !!availableRepositories && availableRepositories.length > 1;

    let contextText = `USER REQUEST:\n${userRequest}\n\n`;
    contextText += `INTENT ANALYSIS (STRUCTURED):\n`;
    contextText += `- Task Type: ${intentResult.taskType}\n`;
    contextText += `- Risk: ${intentResult.risk}\n`;
    contextText += `- Estimated Complexity: ${intentResult.estimatedComplexity}\n`;
    contextText += `- Target Path: ${intentResult.targetPath || "project-wide"}\n\n`;

    const arch = detectRepositoryArchitecture(existingFiles);
    const primaryActiveEntry = arch.primaryActiveEntryPoint || detectPrimaryActiveEntryPoint(existingFiles);

    if (primaryActiveEntry && intentResult.targetPath === primaryActiveEntry) {
      contextText += `ACTIVE PRIMARY ENTRY POINT GROUNDING:\n`;
      contextText += `- Verified Primary Active UI File: "${primaryActiveEntry}" (renders root "/")\n\n`;
    }

    if (arch.existingUIComponents.length > 0 || intentResult.taskType === "NEW_FEATURE") {
      const uiSystemSection = buildRepositoryUISystemPromptSection(arch, {
        isComprehensiveUI: intentResult.estimatedComplexity === "LARGE" || intentResult.estimatedComplexity === "COMPLEX",
        isSmallComponent: intentResult.estimatedComplexity === "SMALL",
      });
      if (uiSystemSection) {
        contextText += uiSystemSection;
      }
    }

    if (isMultiRepo) {
      contextText += `MULTIPLE REPOSITORIES AVAILABLE — every sub-task MUST include a "repositoryId" field set to one of these exact IDs:\n`;
      for (const repo of availableRepositories!) {
        contextText += `- repositoryId "${repo.repositoryId}": "${repo.name}" (role: ${repo.role})\n`;
        contextText += `  Sample files: ${repo.existingFiles.slice(0, 15).join(", ") || "(none yet)"}\n`;
      }
      contextText += `A sub-task that changes files in one repo must not list targetFiles from another repo.\n\n`;
    } else {
      contextText += `EXISTING REPOSITORY FILES (SAMPLE):\n`;
      contextText += existingFiles.slice(0, 40).map((f) => `- ${f}`).join("\n");
    }

    try {
      const gateway = LLMGateway.getInstance();
      const response = await gateway.callStructured<{ nodes: any[] }>({
        stage: PipelineStages.TASK_DECOMPOSITION,
        openaiClient: this.openai,
        messages: [
          { role: "system", content: TASK_DECOMPOSITION_PROMPT },
          { role: "user", content: contextText },
        ],
        temperature: 0.2,
        schema: {
          name: "TaskDecompositionSchema",
          strict: false,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              nodes: {
                type: "array",
                minItems: 2,
                maxItems: 8,
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    id: { type: "string" },
                    description: { type: "string" },
                    category: { type: "string", enum: ["types_and_interfaces", "mock_data", "leaf_components", "container_components", "routing_and_navigation", "api_integration", "state_management"] },
                    targetFiles: { type: "array", items: { type: "string" } },
                    dependencies: { type: "array", items: { type: "string" } },
                    estimatedComplexity: { type: "string", enum: ["SMALL", "MEDIUM"] },
                    repositoryId: { type: "string" },
                  },
                  required: ["id", "category", "description", "targetFiles", "dependencies", "estimatedComplexity"],
                },
              },
              graphVersion: { type: "string", enum: ["1.0.0"] },
            },
            required: ["nodes", "graphVersion"],
          },
          validate: (parsed) => {
            try {
              this.normalizeAndValidateGraph(parsed, userRequest, availableRepositories?.map((repo) => repo.repositoryId));
              return { valid: true, data: parsed };
            } catch (error: any) {
              return { valid: false, errors: [error?.message || "Invalid task decomposition"] };
            }
          },
        },
      });

      const validRepoIds = availableRepositories?.map((r) => r.repositoryId);
      const graph = this.normalizeAndValidateGraph(response.content, userRequest, validRepoIds);
      return graph;
    } catch (err: any) {
      console.error("[TaskDecomposer] Error in task decomposition:", err?.message || err);
      // Fail closed per Phase 1B specifications: never invent fallback templates like src/types/feature.ts
      throw new Error(`TASK_DECOMPOSITION_FAILED: ${err?.message || "Failed to decompose task into valid DAG"}`);
    }
  }

  /**
   * Validates if a dependency graph is acyclic (is a valid DAG).
   */
  public validateDAG(graph: DependencyExecutionGraph): boolean {
    if (!graph || !Array.isArray(graph.nodes)) return false;

    const nodeIds = new Set(graph.nodes.map((n) => n.id));
    const adjacency = new Map<string, string[]>();

    for (const node of graph.nodes) {
      adjacency.set(node.id, []);
    }

    for (const node of graph.nodes) {
      for (const depId of node.dependencies || []) {
        if (!nodeIds.has(depId)) continue;
        const list = adjacency.get(depId) || [];
        list.push(node.id);
        adjacency.set(depId, list);
      }
    }

    const state = new Map<string, number>();

    const hasCycle = (u: string): boolean => {
      state.set(u, 1);
      const neighbors = adjacency.get(u) || [];
      for (const v of neighbors) {
        const vState = state.get(v) || 0;
        if (vState === 1) return true;
        if (vState === 0 && hasCycle(v)) return true;
      }
      state.set(u, 2);
      return false;
    };

    for (const nodeId of nodeIds) {
      if ((state.get(nodeId) || 0) === 0) {
        if (hasCycle(nodeId)) return false;
      }
    }

    return true;
  }

  /**
   * Topologically sorts nodes in the DAG so dependencies are executed before dependants.
   */
  public topologicalSort(graph: DependencyExecutionGraph): string[] {
    const inDegree = new Map<string, number>();
    const adjacency = new Map<string, string[]>();

    for (const node of graph.nodes) {
      inDegree.set(node.id, 0);
      adjacency.set(node.id, []);
    }

    for (const node of graph.nodes) {
      for (const depId of node.dependencies || []) {
        if (inDegree.has(node.id) && adjacency.has(depId)) {
          inDegree.set(node.id, (inDegree.get(node.id) || 0) + 1);
          adjacency.get(depId)!.push(node.id);
        }
      }
    }

    const queue: string[] = [];
    for (const [id, deg] of inDegree.entries()) {
      if (deg === 0) queue.push(id);
    }

    const sorted: string[] = [];
    while (queue.length > 0) {
      const u = queue.shift()!;
      sorted.push(u);

      for (const v of adjacency.get(u) || []) {
        const newDeg = (inDegree.get(v) || 1) - 1;
        inDegree.set(v, newDeg);
        if (newDeg === 0) {
          queue.push(v);
        }
      }
    }

    if (sorted.length < graph.nodes.length) {
      for (const node of graph.nodes) {
        if (!sorted.includes(node.id)) sorted.push(node.id);
      }
    }

    return sorted;
  }

  public detectCrossRepoEdges(nodes: SubTask[]): CrossRepoEdge[] {
    const nodeById = new Map<string, SubTask>();
    for (const n of nodes) nodeById.set(n.id, n);

    const edges: CrossRepoEdge[] = [];
    for (const node of nodes) {
      if (!node.repositoryId) continue;
      for (const depId of node.dependencies || []) {
        const dep = nodeById.get(depId);
        if (!dep || !dep.repositoryId) continue;
        if (dep.repositoryId !== node.repositoryId) {
          edges.push({
            fromSubTaskId: dep.id,
            fromRepositoryId: dep.repositoryId,
            toSubTaskId: node.id,
            toRepositoryId: node.repositoryId,
          });
        }
      }
    }
    return edges;
  }

  public toClassicDependencyGraph(execGraph: DependencyExecutionGraph): DependencyGraph {
    const adjacencyList = new Map<string, Set<string>>();
    const inDegree = new Map<string, number>();

    for (const node of execGraph.nodes) {
      if (!adjacencyList.has(node.id)) adjacencyList.set(node.id, new Set<string>());
      if (!inDegree.has(node.id)) inDegree.set(node.id, 0);

      for (const dep of node.dependencies || []) {
        if (!adjacencyList.has(dep)) adjacencyList.set(dep, new Set<string>());
        adjacencyList.get(dep)!.add(node.id);
        inDegree.set(node.id, (inDegree.get(node.id) || 0) + 1);
      }
    }

    return {
      adjacencyList,
      inDegree,
    };
  }

  private normalizeAndValidateGraph(
    parsed: any,
    userRequest: string,
    validRepoIds?: string[]
  ): DependencyExecutionGraph {
    if (!parsed || !Array.isArray(parsed.nodes) || parsed.nodes.length === 0) {
      throw new Error("TASK_DECOMPOSITION_FAILED: Parsed output has no nodes");
    }

    const validCategories: Set<SubTaskCategory> = new Set([
      "types_and_interfaces",
      "mock_data",
      "leaf_components",
      "container_components",
      "routing_and_navigation",
      "api_integration",
      "state_management",
    ]);

    if (Object.keys(parsed).some((key) => !["nodes", "graphVersion"].includes(key)) || parsed.graphVersion !== "1.0.0" || parsed.nodes.length < 2 || parsed.nodes.length > 8) throw new Error("TASK_DECOMPOSITION_FAILED: Invalid graph envelope");

    const cleanNodes: SubTask[] = [];
    const seenIds = new Set<string>();
    const seenTargetFiles = new Set<string>();

    for (let i = 0; i < parsed.nodes.length; i++) {
      const raw = parsed.nodes[i];
      if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some((key) => !["id", "category", "description", "targetFiles", "dependencies", "estimatedComplexity", "repositoryId"].includes(key))) throw new Error("TASK_DECOMPOSITION_FAILED: Invalid node fields");
      const id = typeof raw.id === "string" ? raw.id.trim() : "";
      if (!id || seenIds.has(id)) throw new Error("TASK_DECOMPOSITION_FAILED: Missing or duplicate task ID");
      seenIds.add(id);

      if (!validCategories.has(raw.category)) throw new Error("TASK_DECOMPOSITION_FAILED: Invalid task category");
      const category = raw.category as SubTaskCategory;
      if (typeof raw.description !== "string" || !raw.description.trim()) throw new Error("TASK_DECOMPOSITION_FAILED: Missing task description");
      const description = raw.description;
      if (!Array.isArray(raw.targetFiles) || raw.targetFiles.length === 0) throw new Error("TASK_DECOMPOSITION_FAILED: Missing target files");
      const targetFiles = raw.targetFiles.map((value: unknown) => {
        if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.includes("\0")) throw new Error("TASK_DECOMPOSITION_FAILED: Invalid target file");
        const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
        if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) || normalized.split("/").some((part: string) => !part || part === "." || part === "..") || seenTargetFiles.has(normalized)) throw new Error("TASK_DECOMPOSITION_FAILED: Unsafe or duplicate target file");
        seenTargetFiles.add(normalized); return normalized;
      });
      if (!Array.isArray(raw.dependencies) || new Set(raw.dependencies).size !== raw.dependencies.length || raw.dependencies.some((dep: unknown) => typeof dep !== "string" || !dep.trim() || dep === id)) throw new Error("TASK_DECOMPOSITION_FAILED: Invalid dependency list");
      const dependencies = [...raw.dependencies];
      if (raw.estimatedComplexity !== "SMALL" && raw.estimatedComplexity !== "MEDIUM") throw new Error("TASK_DECOMPOSITION_FAILED: Invalid task complexity");
      const estimatedComplexity = raw.estimatedComplexity;

      let repositoryId: string | undefined;
      if (validRepoIds && validRepoIds.length > 0) {
        if (typeof raw.repositoryId !== "string" || !validRepoIds.includes(raw.repositoryId.trim())) throw new Error("TASK_DECOMPOSITION_FAILED: Invalid or missing repository ID");
        repositoryId = raw.repositoryId.trim();
      } else if (raw.repositoryId !== undefined) {
        throw new Error("TASK_DECOMPOSITION_FAILED: Unexpected repository ID");
      }

      cleanNodes.push({
        id,
        category,
        description,
        targetFiles,
        dependencies,
        estimatedComplexity,
        ...(repositoryId ? { repositoryId } : {}),
      });
    }

    if (cleanNodes.length === 0) {
      throw new Error("TASK_DECOMPOSITION_FAILED: No clean nodes remained after normalization");
    }

    for (const node of cleanNodes) {
      if (node.dependencies.some((dependency) => !seenIds.has(dependency))) throw new Error("TASK_DECOMPOSITION_FAILED: Dependency references unknown task ID");
    }

    const graph: DependencyExecutionGraph = {
      nodes: cleanNodes,
      executionOrder: [],
      graphVersion: "1.0.0",
    };

    if (!this.validateDAG(graph)) throw new Error("TASK_DECOMPOSITION_FAILED: Dependency graph contains a cycle");
    graph.executionOrder = this.topologicalSort(graph);

    return graph;
  }

  /**
   * Decomposes approved Architecture into a structured Kanban board proposal.
   *
   * Invariants (CP4.1):
   * 1. Requires authoritative ImplementationAuthority.
   * 2. Component references must belong to approved Architecture.
   * 3. Repository IDs must belong to the authorized project scope (no fabricated IDs).
   * 4. Enforces strict DAG validation (acyclic) and topological sorting.
   * 5. Fails closed with typed PlanningDomainError on validation errors.
   */
  public async decomposeArchitecture(
    authority: ImplementationAuthority,
    options?: {
      availableRepositories?: Array<{ id: string; name: string; role: string; githubUrl?: string }>;
    }
  ): Promise<KanbanBoardProposal> {
    const workflowContextService = new WorkflowContextService();
    const ctx = {
      projectId: authority.projectId,
      requirements: authority.requirements.artifact.content,
      documentation: authority.documentation.artifact.content,
      architecture: authority.architecture.artifact.content,
    };
    const boundaryPrompt = workflowContextService.buildSystemBoundaryPrompt(ctx);

    const availableRepositories = options?.availableRepositories || [];
    let repoContext = "";
    if (availableRepositories.length > 0) {
      repoContext = `AUTHORIZED PROJECT REPOSITORIES:\n`;
      for (const repo of availableRepositories) {
        repoContext += `- repositoryId "${repo.id}": "${repo.name}" (role: ${repo.role})\n`;
      }
      repoContext += `Tasks may specify a "repositoryId" field set ONLY to one of the exact IDs above. Do not invent repository IDs.\n\n`;
    } else {
      repoContext = `NO REPOSITORIES LINKED: Do NOT include a "repositoryId" field on tasks. Repositories will be bound prior to execution.\n\n`;
    }

    const prompt = `
${boundaryPrompt}

${repoContext}Based STRICTLY on the Project Workflow Documents above:
Decompose this project into logical, step-by-step Kanban tasks categorized into stages.
Ensure every task has explicit titles, descriptions, acceptance criteria, and target files.
Each task must have a unique stable key, one or more exact Architecture component IDs,
and dependencyKeys containing only keys of prerequisite tasks. Do not invent component IDs.

Return ONLY a valid JSON object matching this schema:
{
  "stages": [
    {
      "title": "Stage 1: Core Setup & Models",
      "order": 0,
      "tasks": [
        {
          "key": "TASK-USER-SCHEMA",
          "title": "Define User and Project Prisma Schemas",
          "description": "Create data models as specified in Architecture document.",
          "acceptanceCriteria": ["Prisma schema passes validation", "Exported types compile"],
          "targetFiles": ["prisma/schema.prisma"],
          "architectureComponentIds": ["ARCH-COMP-DATA"],
          "dependencyKeys": []
        }
      ]
    }
  ]
}
`;

    const gateway = LLMGateway.getInstance();
    const result = await gateway.callStructured<KanbanBoardProposal>({
      stage: PipelineStages.IMPLEMENTATION_PLANNING,
      messages: [{ role: "user", content: prompt }],
      schema: {
        name: "KanbanBoardProposalSchema",
        strict: false,
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["stages"],
          properties: {
            stages: {
              type: "array",
              minItems: 1,
              maxItems: 20,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["title", "order", "tasks"],
                properties: {
                  title: { type: "string", minLength: 1, maxLength: 200 },
                  order: { type: "integer", minimum: 0, maximum: 1000 },
                  tasks: {
                    type: "array",
                    minItems: 1,
                    maxItems: 100,
                    items: {
                      type: "object",
                      additionalProperties: false,
                      required: ["key", "title", "description", "acceptanceCriteria", "targetFiles", "architectureComponentIds", "dependencyKeys"],
                      properties: {
                        key: { type: "string", pattern: "^[A-Z0-9][A-Z0-9_-]{0,79}$" },
                        title: { type: "string", minLength: 1, maxLength: 200 },
                        description: { type: "string", minLength: 1, maxLength: 2000 },
                        acceptanceCriteria: { type: "array", minItems: 1, maxItems: 20, items: { type: "string", minLength: 1, maxLength: 500 } },
                        targetFiles: { type: "array", maxItems: 50, items: { type: "string", minLength: 1 } },
                        architectureComponentIds: { type: "array", minItems: 1, maxItems: 50, items: { type: "string", minLength: 1 } },
                        dependencyKeys: { type: "array", maxItems: 100, items: { type: "string", minLength: 1 } },
                        repositoryId: { type: "string" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        validate: (value: unknown) => {
          if (!value || typeof value !== "object" || Array.isArray(value)) {
            return { valid: false, errors: ["Kanban proposal must be an object"] };
          }
          const board = value as Record<string, unknown>;
          if (!Array.isArray(board.stages) || board.stages.length === 0 || board.stages.length > 20) {
            return { valid: false, errors: ["Invalid stages array"] };
          }
          return { valid: true, data: board as unknown as KanbanBoardProposal };
        },
      },
    });

    this.validateArchitectureProposal(result.content, authority, availableRepositories);
    return result.content;
  }

  /**
   * Deterministically validates an architecture decomposition proposal against authority.
   */
  public validateArchitectureProposal(
    board: KanbanBoardProposal,
    authority: ImplementationAuthority,
    availableRepositories?: Array<{ id: string }>
  ): void {
    if (!board || typeof board !== "object" || !Array.isArray(board.stages) || board.stages.length === 0) {
      throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", "Kanban proposal must contain at least one stage.", 422);
    }
    const validComponentIds = new Set(authority.architecture.content.components.map((c) => c.id));
    const validRepoIds = new Set((availableRepositories || []).map((r) => r.id));
    const tasks = board.stages.flatMap((stage) => stage.tasks);
    if (tasks.length === 0) {
      throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", "Kanban proposal must contain at least one task.", 422);
    }
    const keys = new Set<string>();
    for (const task of tasks) {
      if (!task || typeof task !== "object" || typeof task.key !== "string" || !task.key.trim() || !Array.isArray(task.dependencyKeys) || !Array.isArray(task.architectureComponentIds)) {
        throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", "Generated task omitted required implementation references.", 422);
      }
      if (keys.has(task.key)) {
        throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", "Generated tasks contain a duplicate key.", 422);
      }
      keys.add(task.key);

      // Verify architecture component references
      if (task.architectureComponentIds.length === 0 || task.architectureComponentIds.some((id) => !validComponentIds.has(id))) {
        throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", "Generated task references an unknown Architecture component.", 422);
      }

      // Verify target files are safe relative paths
      if (Array.isArray(task.targetFiles)) {
        for (const file of task.targetFiles) {
          if (!isSafeRelativePath(file)) {
            throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", `Unsafe or invalid target file path: ${file}`, 422);
          }
        }
      }

      // Verify repository references
      if (task.repositoryId) {
        if (!validRepoIds.has(task.repositoryId)) {
          throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", "Generated task references an unauthorized or foreign repository.", 422);
        }
      }
    }

    // Verify dependencies exist and are not self-referential
    for (const task of tasks) {
      if (task.dependencyKeys.includes(task.key) || task.dependencyKeys.some((k) => !keys.has(k))) {
        throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", "Generated task dependency reference is invalid.", 422);
      }
    }

    // Verify acyclicity using DAG validation
    const executionGraph: DependencyExecutionGraph = {
      nodes: tasks.map((t) => ({
        id: t.key,
        category: "types_and_interfaces",
        description: t.description,
        targetFiles: t.targetFiles,
        dependencies: t.dependencyKeys,
        estimatedComplexity: "SMALL",
      })),
      executionOrder: [],
      graphVersion: "1.0.0",
    };
    if (!this.validateDAG(executionGraph)) {
      throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", "Generated task dependencies contain a cycle.", 422);
    }
  }
}
