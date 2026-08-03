import OpenAI from "openai";
import {
  DependencyExecutionGraph,
  SubTask,
  SubTaskCategory,
  TaskClassificationResult,
  DependencyGraph,
} from "../types";
import { TASK_DECOMPOSITION_PROMPT } from "./prompts";

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
   * Decomposes a complex request into a Directed Acyclic Graph (DAG) of sub-tasks.
   */
  public async decomposeTask(
    userRequest: string,
    repositoryContext: { existingFiles?: string[]; repoSnapshot?: any },
    intentResult: TaskClassificationResult
  ): Promise<DependencyExecutionGraph> {
    const existingFiles = repositoryContext.existingFiles || [];

    let contextText = `USER REQUEST:\n${userRequest}\n\n`;
    contextText += `INTENT ANALYSIS:\n`;
    contextText += `- Task Type: ${intentResult.taskType}\n`;
    contextText += `- Risk: ${intentResult.risk}\n`;
    contextText += `- Estimated Complexity: ${intentResult.estimatedComplexity}\n`;
    contextText += `- Target Path: ${intentResult.targetPath || "project-wide"}\n\n`;

    contextText += `EXISTING REPOSITORY FILES (SAMPLE):\n`;
    contextText += existingFiles.slice(0, 40).map((f) => `- ${f}`).join("\n");

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

      const graph = this.normalizeAndValidateGraph(parsed, userRequest);
      return graph;
    } catch (err: any) {
      console.error("[TaskDecomposer] Error in task decomposition:", err?.message || err);
      return this.buildFallbackGraph(userRequest, intentResult);
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
        if (!nodeIds.has(depId)) continue; // ignore unknown dependency IDs
        const list = adjacency.get(depId) || [];
        list.push(node.id);
        adjacency.set(depId, list);
      }
    }

    // Cycle detection using DFS (visited states: 0=unvisited, 1=visiting, 2=visited)
    const state = new Map<string, number>();

    const hasCycle = (u: string): boolean => {
      state.set(u, 1);
      const neighbors = adjacency.get(u) || [];
      for (const v of neighbors) {
        const vState = state.get(v) || 0;
        if (vState === 1) return true; // cycle detected!
        if (vState === 0 && hasCycle(v)) return true;
      }
      state.set(u, 2);
      return false;
    };

    for (const nodeId of nodeIds) {
      if ((state.get(nodeId) || 0) === 0) {
        if (hasCycle(nodeId)) return false; // Not a DAG
      }
    }

    return true;
  }

  /**
   * Performs Kahn's algorithm for topological sorting of sub-tasks.
   */
  public topologicalSort(graph: DependencyExecutionGraph): string[] {
    if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length === 0) {
      return [];
    }

    const nodeIds = new Set(graph.nodes.map((n) => n.id));
    const inDegree = new Map<string, number>();
    const graphMap = new Map<string, string[]>(); // depId -> dependentNodeIds

    for (const node of graph.nodes) {
      inDegree.set(node.id, 0);
      graphMap.set(node.id, []);
    }

    for (const node of graph.nodes) {
      const validDeps = (node.dependencies || []).filter((d) => nodeIds.has(d));
      inDegree.set(node.id, validDeps.length);

      for (const depId of validDeps) {
        const list = graphMap.get(depId) || [];
        list.push(node.id);
        graphMap.set(depId, list);
      }
    }

    const queue: string[] = [];
    for (const [id, deg] of inDegree.entries()) {
      if (deg === 0) queue.push(id);
    }

    const order: string[] = [];
    while (queue.length > 0) {
      const u = queue.shift()!;
      order.push(u);

      const neighbors = graphMap.get(u) || [];
      for (const v of neighbors) {
        const deg = (inDegree.get(v) || 1) - 1;
        inDegree.set(v, deg);
        if (deg === 0) {
          queue.push(v);
        }
      }
    }

    // If order length != total nodes, there's a cycle; append remaining nodes as fallback
    if (order.length !== graph.nodes.length) {
      for (const node of graph.nodes) {
        if (!order.includes(node.id)) {
          order.push(node.id);
        }
      }
    }

    return order;
  }

  /**
   * Normalizes raw LLM output graph, ensures DAG acyclicity, and sets topological execution order.
   */
  private normalizeAndValidateGraph(parsed: any, userRequest: string): DependencyExecutionGraph {
    const rawNodes = Array.isArray(parsed.nodes) ? parsed.nodes : [];

    const nodes: SubTask[] = rawNodes.map((n: any, idx: number) => ({
      id: typeof n.id === "string" ? n.id : `subtask-${idx + 1}`,
      category: this.normalizeCategory(n.category),
      description: typeof n.description === "string" ? n.description : `Sub-task ${idx + 1}`,
      targetFiles: Array.isArray(n.targetFiles) ? n.targetFiles : [],
      dependencies: Array.isArray(n.dependencies) ? n.dependencies : [],
      estimatedComplexity: n.estimatedComplexity === "MEDIUM" ? "MEDIUM" : "SMALL",
    }));

    // Enforce bounds: 2 to 8 sub-tasks
    let boundedNodes = nodes;
    if (boundedNodes.length < 2) {
      boundedNodes = this.buildFallbackNodes(userRequest);
    } else if (boundedNodes.length > 8) {
      boundedNodes = boundedNodes.slice(0, 8);
    }

    let candidateGraph: DependencyExecutionGraph = {
      nodes: boundedNodes,
      executionOrder: [],
      graphVersion: parsed.graphVersion || "1.0.0",
    };

    // Verify DAG
    if (!this.validateDAG(candidateGraph)) {
      // Break cycles by stripping backward dependencies
      candidateGraph.nodes = candidateGraph.nodes.map((node, i) => ({
        ...node,
        dependencies: node.dependencies.filter((depId) => {
          const depIdx = candidateGraph.nodes.findIndex((n) => n.id === depId);
          return depIdx >= 0 && depIdx < i; // only allow dependencies on earlier indexed nodes
        }),
      }));
    }

    candidateGraph.executionOrder = this.topologicalSort(candidateGraph);
    return candidateGraph;
  }

  private normalizeCategory(cat: string): SubTaskCategory {
    const validCategories: SubTaskCategory[] = [
      "types_and_interfaces",
      "mock_data",
      "leaf_components",
      "container_components",
      "routing_and_navigation",
      "api_integration",
      "state_management",
    ];
    if (validCategories.includes(cat as any)) return cat as SubTaskCategory;
    return "container_components";
  }

  private buildFallbackGraph(userRequest: string, intentResult: TaskClassificationResult): DependencyExecutionGraph {
    const nodes = this.buildFallbackNodes(userRequest);
    const graph: DependencyExecutionGraph = {
      nodes,
      executionOrder: [],
      graphVersion: "1.0.0",
    };
    graph.executionOrder = this.topologicalSort(graph);
    return graph;
  }

  private buildFallbackNodes(userRequest: string): SubTask[] {
    return [
      {
        id: "subtask-1",
        category: "types_and_interfaces",
        description: "Define types and data models for requested feature",
        targetFiles: ["src/types/feature.ts"],
        dependencies: [],
        estimatedComplexity: "SMALL",
      },
      {
        id: "subtask-2",
        category: "container_components",
        description: "Implement UI view and components",
        targetFiles: ["src/components/FeatureView.tsx"],
        dependencies: ["subtask-1"],
        estimatedComplexity: "MEDIUM",
      },
    ];
  }
}
