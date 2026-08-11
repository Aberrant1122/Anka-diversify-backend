import { getOpenAI } from "../shared/utils";
import { RepositoryExecutionMemory, ExecutionContract } from "../shared/types";
import { RepositoryToolEngine } from "../../services/repository-tool.engine";
import { IterativeReasoningEngine } from "../../services/iterative-reasoning.engine";
import { RepositoryScanner } from "./RepositoryScanner";
import { RepositoryKnowledgeGraph } from "./RepositoryKnowledgeGraph";
import { ProjectGitHubService } from "../../services/github.service";

export class RepositorySearch {
  static async planTask(
    message: string,
    snapshot: any,
  ): Promise<{ approach: string; filesToRead: string[]; validationCommands: string[] }> {
    const fileTree = snapshot?.fileTree?.slice(0, 300).join("\n") || "No repo connected";
    const openai = getOpenAI();

    const completion = await openai.chat.completions.create({
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

  static async buildFileContext(
    filesToRead: string[],
    snapshot: any,
    githubUrl: string,
    githubToken?: string,
  ): Promise<Record<string, string>> {
    const context: Record<string, string> = {};

    for (const keyFile of snapshot?.keyFiles || []) {
      if (!filesToRead.length || filesToRead.some((f) => f === keyFile.path || keyFile.path.includes(f))) {
        context[keyFile.path] = keyFile.content;
      }
    }

    for (const filePath of filesToRead.slice(0, 10)) {
      if (!context[filePath] && githubUrl) {
        const file = await ProjectGitHubService.getFileContent(githubUrl, filePath, githubToken).catch(() => null);
        if (file) context[filePath] = file.content;
      }
    }

    if (Object.keys(context).length === 0 && snapshot?.keyFiles?.length) {
      for (const keyFile of snapshot.keyFiles.slice(0, 10)) {
        context[keyFile.path] = keyFile.content;
      }
    }

    return context;
  }

  static async buildOptimizedContext(
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

    for (const [pathKey, content] of Object.entries(rawContext)) {
      const approxTokens = Math.ceil(content.length / 4);
      if (currentTokens + approxTokens <= MAX_TOKEN_BUDGET) {
        fileContext[pathKey] = content;
        currentTokens += approxTokens;
      } else {
        const skeleton = RepositoryKnowledgeGraph.skeletonizeDependencyFile(content);
        const skelTokens = Math.ceil(skeleton.length / 4);
        if (currentTokens + skelTokens <= MAX_TOKEN_BUDGET) {
          skeletonContext[pathKey] = skeleton;
          currentTokens += skelTokens;
        }
      }
    }

    return { fileContext, skeletonContext, tokenEstimate: currentTokens };
  }

  static async runIterativeRepositorySearch(
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
    const effectiveSnap = RepositoryScanner.getEffectiveSnapshot(snapshot, localPath);

    if (contract && contract.repositoryRequired === false) {
      const existingFiles: Record<string, string> = {};
      const snapList = Array.isArray(effectiveSnap) ? effectiveSnap : effectiveSnap?.keyFiles || (effectiveSnap as any)?.repoSnapshot || [];
      for (const f of snapList) {
        if (f && f.path && typeof f.content === "string" && f.content.trim().length > 0) {
          existingFiles[f.path] = f.content;
        }
      }

      const executionMemory: RepositoryExecutionMemory = {
        taskId,
        projectId: projectContext.project.id,
        discoveredSymbols: new Map(),
        discoveredRoutes: [],
        discoveredServices: [],
        discoveredModels: [],
        inspectedFiles: new Set<string>(Object.keys(existingFiles)),
        searchPlanHistory: [],
        currentConfidence: 1.0,
      };
      return {
        optimizedContext: { fileContext: existingFiles, skeletonContext: {}, tokenEstimate: JSON.stringify(existingFiles).length },
        executionMemory,
        finalConfidence: 1.0,
        searchSummary: `Standalone Pipeline active (pipeline: ${contract.pipeline}, environment: ${contract.environment}) — Repository search bypassed. ${Object.keys(existingFiles).length} existing standalone file(s) included in context.`,
      };
    }

    const toolEngine = new RepositoryToolEngine(effectiveSnap, localPath);
    const reasoningEngine = new IterativeReasoningEngine({
      snapshot: effectiveSnap,
      maxRounds: 5,
      confidenceThreshold: 0.80,
      contract,
      projectId: projectContext.project.id,
    });

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

    const collectedFileContext: Record<string, string> = {};
    const collectedSkeletonContext: Record<string, string> = {};
    let tokenBudget = 0;
    const MAX_TOKENS = 15000;

    for (const fp of reasoningTrace.allExploredFiles) {
      if (!fp || collectedFileContext[fp]) continue;
      const fileResult = toolEngine.readFile({ filePath: fp });
      if (!fileResult.found) continue;

      const approxTokens = Math.ceil(fileResult.content.length / 4);
      if (tokenBudget + approxTokens <= MAX_TOKENS) {
        collectedFileContext[fp] = fileResult.content;
        tokenBudget += approxTokens;
      } else {
        const skeleton = RepositoryKnowledgeGraph.skeletonizeDependencyFile(fileResult.content);
        const skelTokens = Math.ceil(skeleton.length / 4);
        if (tokenBudget + skelTokens <= MAX_TOKENS) {
          collectedSkeletonContext[fp] = skeleton;
          tokenBudget += skelTokens;
        }
      }
    }

    const filteredFileContext = reasoningEngine.filterFilesByContractScope(collectedFileContext);

    if (Object.keys(filteredFileContext).length === 0 && snapshot?.keyFiles?.length) {
      for (const kf of (snapshot.keyFiles as Array<{ path: string; content?: string }>).slice(0, 10)) {
        if (kf.content) filteredFileContext[kf.path] = kf.content;
      }
    }

    const toolSummaryLines = executionMemory.searchPlanHistory.map(
      (h) => `  Step ${h.stepId}: ${h.tool} → found ${h.resultCount} result(s)`,
    );
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
}
