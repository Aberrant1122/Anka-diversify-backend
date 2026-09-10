import fs from "fs";
import path from "path";
import { PrismaClient } from "@prisma/client";
import { LLMGateway } from "../gateway/LLMGateway";
import { LLMSchemaInvalidError, LLMTimeoutError } from "../gateway/LLMError";
import { PipelineStages } from "../gateway/PipelineStage";
import { ProjectChatService } from "../application/ProjectChatService";
import { IntentClassifier } from "../classification/IntentClassifier";
import { RepositoryInvestigationAgent } from "../repository/RepositoryInvestigationAgent";
import { RepositoryEvidenceStore } from "../repository/RepositoryEvidenceStore";
import { ManifestCorrectionEngine } from "../planning/ManifestCorrectionEngine";
import { TaskExecutionPlanManager } from "../planning/TaskExecutionPlanManager";
import { ManifestGenerator } from "../../services/manifest-generator";
import { TaskDecomposer } from "../../services/task-decomposer";
import { EmbeddingGateway } from "../gateway/EmbeddingGateway";
import { OpenAIEmbeddingProvider } from "../../services/semantic-retrieval.engine";

jest.mock("@prisma/client", () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    project: { create: jest.fn(), findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn() },
    projectTask: { findMany: jest.fn() },
    projectActivity: { findMany: jest.fn().mockResolvedValue([]) },
    sprint: { findUnique: jest.fn() },
  })),
}));

jest.mock("../memory/MemoryPersistence", () => ({
  MemoryPersistence: {
    getOrCreateSession: jest.fn().mockResolvedValue({ id: "session-1", title: "Session" }),
    saveMessage: jest.fn().mockResolvedValue(undefined),
    updateSessionTitle: jest.fn().mockResolvedValue(undefined),
    getMessageCount: jest.fn().mockResolvedValue(2),
  },
}));

jest.mock("../repository/RepositoryContextBuilder", () => ({
  RepositoryContextBuilder: {
    buildGeneralContext: jest.fn().mockResolvedValue({ workspaceInfo: { user: { name: "User" }, totalProjects: 1, activeProjects: 1 } }),
    buildProjectContext: jest.fn().mockResolvedValue({ project: { id: "project-1", name: "Project", description: "Description", phase: "development" }, summary: null }),
  },
}));

const mockPrismaInstance = (PrismaClient as unknown as jest.Mock).mock.results
  .map((entry) => entry.value)
  .find((value) => value?.sprint && value?.projectTask);

function result<T>(content: T, stage: string) {
  return { content, rawResponse: {}, finishReason: "stop", latencyMs: 1, model: "gpt-4o", stage } as any;
}

function prismaMock(): any {
  return mockPrismaInstance;
}

function validatingResult(payload: unknown) {
  return async (options: any) => {
    const validation = options.schema.validate(payload);
    if (!validation.valid) throw new LLMSchemaInvalidError(validation.errors?.join("; ") || "invalid");
    return result(validation.data ?? payload, options.stage);
  };
}

describe("Checkpoint 1 final completion contracts", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  test("ProjectChat general workflow uses typed tool proposals and cannot create a project", async () => {
    const gateway = jest.spyOn(LLMGateway.getInstance(), "callWithTools")
      .mockResolvedValueOnce(result({ type: "tool_calls", text: null, toolCalls: [{ id: "call-1", name: "propose_project", arguments: { name: "New project" } }] }, PipelineStages.APPLICATION_SUPPORT) as any)
      .mockResolvedValueOnce(result({ type: "text", text: "Please confirm the proposal.", toolCalls: [] }, PipelineStages.APPLICATION_SUPPORT) as any);

    const response = await new ProjectChatService().processGeneralChat("user-1", { message: "Create a project" } as any);
    expect(gateway).toHaveBeenCalledTimes(2);
    expect(gateway.mock.calls[0][0].stage).toBe(PipelineStages.APPLICATION_SUPPORT);
    expect(gateway.mock.calls[0][0].validateToolCall("propose_project", { name: "" }).valid).toBe(false);
    expect(prismaMock().project.create).not.toHaveBeenCalled();
    expect(response.actions?.[0]).toEqual(expect.objectContaining({ type: "project_proposed" }));
  });

  test("ProjectChat project workflow validates task proposals through the typed tool path", async () => {
    const gateway = jest.spyOn(LLMGateway.getInstance(), "callWithTools").mockResolvedValue(
      result({ type: "tool_calls", text: null, toolCalls: [{ id: "call-1", name: "propose_tasks", arguments: { tasks: [{ title: "Implement", priority: "high" }] } }] }, PipelineStages.APPLICATION_SUPPORT) as any,
    );
    const response = await new ProjectChatService().processProjectChat("user-1", "project-1", { message: "Plan work" } as any);
    expect(gateway.mock.calls[0][0].stage).toBe(PipelineStages.APPLICATION_SUPPORT);
    expect(gateway.mock.calls[0][0].validateToolCall("propose_tasks", { tasks: [{ title: "x", priority: "urgent" }] }).valid).toBe(false);
    expect(response.proposedTasks).toHaveLength(1);
  });

  test("ProjectChat sprint suggestion and generation validate current task IDs", async () => {
    const tasks = [{ id: "task-1", title: "One", priority: "high", status: "todo", dueDate: null }];
    prismaMock().projectTask.findMany.mockResolvedValue(tasks);
    prismaMock().sprint.findUnique.mockResolvedValue({ id: "sprint-1", startDate: new Date("2026-09-10"), endDate: new Date("2026-09-20"), tasks: [] });
    prismaMock().project.findUnique.mockResolvedValue({ id: "project-1", name: "Project" });
    const structured = jest.spyOn(LLMGateway.getInstance(), "callStructured")
      .mockResolvedValueOnce(result({ tasks: [{ taskId: "task-1", title: "One", reason: "Priority", priority: "high" }] }, PipelineStages.TASK_DECOMPOSITION))
      .mockResolvedValueOnce(result({ name: "Sprint", goal: "Ship", startDate: "2026-09-10", endDate: "2026-09-20", suggestedTasks: [{ taskId: "task-1", title: "One", reason: "Priority", priority: "high" }] }, PipelineStages.TASK_DECOMPOSITION));
    const service = new ProjectChatService();
    await expect(service.suggestSprintTasks("project-1", "sprint-1", 5)).resolves.toHaveLength(1);
    await expect(service.generateSprint("project-1", "Ship it")).resolves.toEqual(expect.objectContaining({ name: "Sprint" }));
    expect(structured.mock.calls.map((call) => call[0].stage)).toEqual([PipelineStages.TASK_DECOMPOSITION, PipelineStages.TASK_DECOMPOSITION]);
    expect(structured.mock.calls[0][0].schema.validate({ tasks: [{ taskId: "invented", title: "X", reason: "X", priority: "high" }] }).valid).toBe(false);
    expect(structured.mock.calls[1][0].schema.validate({ name: "S", goal: "G", startDate: "bad", endDate: "2026-09-20", suggestedTasks: [] }).valid).toBe(false);
  });

  test("ProjectChat ordering requires an exact permutation and technical failure propagates", async () => {
    const spy = jest.spyOn(LLMGateway.getInstance(), "callStructured").mockResolvedValue(result({ order: ["a", "b"] }, PipelineStages.PLAN_REORDER));
    const service = new ProjectChatService();
    await expect(service.suggestTaskOrder([{ id: "a", title: "A" }, { id: "b", title: "B" }])).resolves.toEqual(["a", "b"]);
    expect(spy.mock.calls[0][0].schema.validate({ order: ["a", "a"] }).valid).toBe(false);
    spy.mockRejectedValueOnce(new LLMTimeoutError("timeout"));
    await expect(service.suggestTaskOrder([{ id: "a", title: "A" }, { id: "b", title: "B" }])).rejects.toBeInstanceOf(LLMTimeoutError);
  });

  test("ProjectChat phase proposal uses ROADMAP_PLANNING text completion", async () => {
    const spy = jest.spyOn(LLMGateway.getInstance(), "call").mockResolvedValue(result("# Proposal", PipelineStages.ROADMAP_PLANNING));
    const proposal = await new ProjectChatService().generatePhaseProposal("project-1", "architecture");
    expect(spy.mock.calls[0][0].stage).toBe(PipelineStages.ROADMAP_PLANNING);
    expect(proposal.content).toBe("# Proposal");
  });

  test("repository presence does not suppress genuine user ambiguity and malformed intent fails closed", async () => {
    const spy = jest.spyOn(LLMGateway.getInstance(), "callStructured").mockImplementation(validatingResult({ taskType: "NEW_FEATURE", risk: "LOW", estimatedComplexity: "SMALL", intent: "NEW_FEATURE", confidence: 0.8, requiresClarification: true, question: "Which view?", options: ["A", "B"], reasoning: "Two user choices" }) as any);
    const ambiguous = await IntentClassifier.classifyIntentAndAmbiguity("Change it blue", { project: { name: "P" } }, ["src/App.tsx"]);
    expect(ambiguous.requiresClarification).toBe(true);
    expect(ambiguous.outcome).toBe("CLARIFICATION_NEEDED");
    spy.mockImplementationOnce(validatingResult({ taskType: "MADE_UP", success: true }) as any);
    const malformed = await IntentClassifier.classifyIntentAndAmbiguity("Do work", {}, ["src/App.tsx"]);
    expect(malformed.outcome).toBe("TECHNICAL_FAILURE");
    expect(malformed.requiresClarification).toBe(false);
  });

  test("model readyToPlan cannot terminate repository investigation without materialized evidence", async () => {
    jest.spyOn(LLMGateway.getInstance(), "callStructured").mockResolvedValue(result({ readyToPlan: true, reason: "I think so", toolCalls: [] }, PipelineStages.REPOSITORY_REASONING));
    const agent = new RepositoryInvestigationAgent({
      maxRounds: 1,
      toolEngine: { readFile: jest.fn().mockReturnValue({ found: false }), dispatch: jest.fn() } as any,
      evidenceStore: new RepositoryEvidenceStore("repo-1"),
      intentSpec: { goal: "Change behavior", operations: [{ kind: "MODIFY", subject: "behavior" }], constraints: [], acceptanceCriteria: [], destructive: false, requiresClarification: false, taskType: "NEW_FEATURE", risk: "LOW", estimatedComplexity: "SMALL", explicitUserPaths: [] },
    });
    await expect(agent.investigate()).resolves.toEqual(expect.objectContaining({ readyToPlan: false, evidenceIds: [] }));
  });

  test("plan reorder rejects unknown model IDs and preserves dependency constraints", async () => {
    jest.spyOn(LLMGateway.getInstance(), "callStructured").mockImplementation(validatingResult({ prioritizedStageId: "invented" }) as any);
    const plan: any = { id: "p", goal: "g", currentStageIndex: 0, status: "PENDING", stages: [
      { id: "a", status: "PENDING", dependsOn: [], intent: { taskType: "NEW_FEATURE", goal: "first" } },
      { id: "b", status: "PENDING", dependsOn: ["a"], intent: { taskType: "NEW_FEATURE", goal: "second" } },
    ] };
    const reordered = await TaskExecutionPlanManager.reorderPlanWithClarification(plan, "unknown");
    expect(reordered.stages.map((stage: any) => stage.id)).toEqual(["a", "b"]);
    expect(reordered.stages[1].dependsOn).toEqual(["a"]);
  });

  test("manifest generation rejects unsafe paths, unknown fields, and implicit actions", async () => {
    const spy = jest.spyOn(LLMGateway.getInstance(), "callStructured");
    const generator = new ManifestGenerator({} as any);
    const contract: any = { goal: "g", taskType: "NEW_FEATURE", risk: "LOW", estimatedComplexity: "SMALL", pipeline: "REPOSITORY", environment: "REACT_TS", repositoryRequired: true, expectedFiles: [], validationType: "TYPESCRIPT_BUILD", targetPaths: [], allowedActions: [], forbiddenActions: [], maxFiles: 3, searchScope: [], contextScope: [], diffCriticEnabled: true };
    spy.mockImplementationOnce(validatingResult({ files: [{ path: "../escape.ts", action: "create", dependencies: [], evidenceIds: [] }], totalFiles: 1, manifestVersion: "1.0.0" }) as any);
    await expect(generator.generateManifest("g", { existingFiles: ["src/App.tsx"] }, contract)).rejects.toThrow("MANIFEST_GENERATION_FAILED");
    spy.mockImplementationOnce(validatingResult({ files: [{ path: "src/new.ts", dependencies: [], evidenceIds: [], success: true }], totalFiles: 1, manifestVersion: "1.0.0" }) as any);
    await expect(generator.generateManifest("g", { existingFiles: ["src/App.tsx"] }, contract)).rejects.toThrow("MANIFEST_GENERATION_FAILED");
  });

  test("manifest correction cannot invent paths or default actions", async () => {
    jest.spyOn(LLMGateway.getInstance(), "callStructured").mockImplementation(validatingResult({ files: [{ path: "src/invented.ts", action: "create", dependencies: [], description: "Invent" }], totalFiles: 1, manifestVersion: "1.0.0" }) as any);
    const corrected = await ManifestCorrectionEngine.attemptCorrection({ files: [{ path: "src/a.ts", action: "modify", dependencies: [], description: "A" }], totalFiles: 1, manifestVersion: "1.0.0" }, [], "fix", { existingFiles: ["src/a.ts"] }, { maxFiles: 3, actionObligations: [] } as any, {} as any);
    expect(corrected).toBeNull();
  });

  test("task decomposition rejects invalid repositories, dependencies, self-dependencies, and cycles", async () => {
    const gateway = jest.spyOn(LLMGateway.getInstance(), "callStructured");
    const base = { graphVersion: "1.0.0", nodes: [
      { id: "a", category: "types_and_interfaces", description: "A", targetFiles: ["src/a.ts"], dependencies: [], estimatedComplexity: "SMALL", repositoryId: "repo-1" },
      { id: "b", category: "container_components", description: "B", targetFiles: ["src/b.ts"], dependencies: ["a"], estimatedComplexity: "MEDIUM", repositoryId: "repo-1" },
    ] };
    const decomposer = new TaskDecomposer({} as any);
    const args: any[] = ["build", { existingFiles: ["src/App.tsx"] }, { taskType: "NEW_FEATURE", risk: "LOW", estimatedComplexity: "MEDIUM" }, [{ repositoryId: "repo-1", name: "Repo", role: "primary", existingFiles: [] }]];
    gateway.mockImplementationOnce(validatingResult({ ...base, nodes: [{ ...base.nodes[0], repositoryId: "foreign" }, base.nodes[1]] }) as any);
    await expect(decomposer.decomposeTask(args[0], args[1], args[2], args[3])).rejects.toThrow("TASK_DECOMPOSITION_FAILED");
    gateway.mockImplementationOnce(validatingResult({ ...base, nodes: [{ ...base.nodes[0], dependencies: ["a"] }, base.nodes[1]] }) as any);
    await expect(decomposer.decomposeTask(args[0], args[1], args[2], args[3])).rejects.toThrow("TASK_DECOMPOSITION_FAILED");
    gateway.mockImplementationOnce(validatingResult({ ...base, nodes: [{ ...base.nodes[0], dependencies: ["b"] }, base.nodes[1]] }) as any);
    await expect(decomposer.decomposeTask(args[0], args[1], args[2], args[3])).rejects.toThrow("TASK_DECOMPOSITION_FAILED");
  });

  test("production provider calls are centralized in their gateways", () => {
    const root = path.resolve(__dirname, "../..");
    const files: string[] = [];
    const visit = (dir: string) => fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== "__tests__" && entry.name !== "evals") visit(full); }
      else if (/\.ts$/.test(entry.name)) files.push(full);
    });
    visit(root);
    const generative = files.filter((file) => !file.endsWith(path.join("gateway", "LLMGateway.ts")) && /(?:chat\.completions|completions|responses)\.create\s*\(/.test(fs.readFileSync(file, "utf8")));
    const embeddings = files.filter((file) => !file.endsWith(path.join("gateway", "EmbeddingGateway.ts")) && /embeddings\.create\s*\(/.test(fs.readFileSync(file, "utf8")));
    expect(generative).toEqual([]);
    expect(embeddings).toEqual([]);
  });

  test("the semantic retrieval OpenAI adapter routes embeddings through EmbeddingGateway", async () => {
    const gateway = jest.spyOn(EmbeddingGateway.getInstance(), "embedQuery").mockResolvedValue({
      data: [0.25, 0.75], model: "text-embedding-3-small", latencyMs: 1,
    });
    const provider = new OpenAIEmbeddingProvider("sk-test");
    await expect(provider.embedQuery("repository query")).resolves.toEqual([0.25, 0.75]);
    expect(gateway).toHaveBeenCalledWith("repository query", expect.objectContaining({ model: "text-embedding-3-small" }));
  });
});
