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
      const response = await this.openai.chat.completions.create({
        model: process.env.OPENAI_AGENT_MODEL || "gpt-4o",
        messages: [
          { role: "system", content: TASK_DECOMPOSITION_PROMPT },
          { role: "user", content: contextText },
        ],
        temperature: 0.2,
        response_format: { type: "json_object" },
      });

      const rawContent = response.choices[0]?.message?.content || "{}";
      const parsed = JSON.parse(rawContent);

      const validRepoIds = availableRepositories?.map((r) => r.repositoryId);
      const graph = this.normalizeAndValidateGraph(parsed, userRequest, validRepoIds);
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

    const cleanNodes: SubTask[] = [];
    const seenIds = new Set<string>();

    for (let i = 0; i < parsed.nodes.length; i++) {
      const raw = parsed.nodes[i];
      const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : `subtask-${i + 1}`;
      if (seenIds.has(id)) continue;
      seenIds.add(id);

      const category: SubTaskCategory = validCategories.has(raw.category)
        ? raw.category
        : "container_components";

      const description = typeof raw.description === "string" ? raw.description : `SubTask ${id}`;
      const targetFiles = Array.isArray(raw.targetFiles)
        ? raw.targetFiles.map((f: any) => String(f).trim()).filter(Boolean)
        : [];
      const dependencies = Array.isArray(raw.dependencies)
        ? raw.dependencies.map((d: any) => String(d).trim()).filter(Boolean)
        : [];

      const rawComplexity = String(raw.estimatedComplexity || "").toUpperCase();
      const estimatedComplexity: "SMALL" | "MEDIUM" = rawComplexity === "SMALL" ? "SMALL" : "MEDIUM";

      let repositoryId: string | undefined;
      if (validRepoIds && validRepoIds.length > 0 && typeof raw.repositoryId === "string") {
        const trimmed = raw.repositoryId.trim();
        if (validRepoIds.includes(trimmed)) {
          repositoryId = trimmed;
        }
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

    const graph: DependencyExecutionGraph = {
      nodes: cleanNodes,
      executionOrder: [],
      graphVersion: "1.0.0",
    };

    if (this.validateDAG(graph)) {
      graph.executionOrder = this.topologicalSort(graph);
    } else {
      console.warn("[TaskDecomposer] Cycle detected in parsed graph! Removing backward dependencies.");
      for (const node of graph.nodes) {
        node.dependencies = [];
      }
      graph.executionOrder = graph.nodes.map((n) => n.id);
    }

    return graph;
  }
}
