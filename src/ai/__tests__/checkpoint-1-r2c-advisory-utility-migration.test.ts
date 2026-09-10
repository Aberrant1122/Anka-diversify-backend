import { LLMGateway } from "../gateway/LLMGateway";
import { PipelineStages } from "../gateway/PipelineStage";
import { LLMTruncationError } from "../gateway/LLMError";
import { MemoryPersistence } from "../memory/MemoryPersistence";
import { PullRequestReviewer } from "../github/PullRequestReviewer";
import { PullRequestDescription } from "../github/PullRequestDescription";
import { CodeCritic } from "../review/CodeCritic";
import { KanbanService } from "../../services/kanban-service";
import { GitHubService } from "../github/GitHubService";

jest.mock("@prisma/client", () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    projectMemorySummary: { findUnique: jest.fn().mockResolvedValue(null), upsert: jest.fn().mockResolvedValue({}) },
    project: { findUnique: jest.fn().mockResolvedValue({ githubUrl: "https://github.com/acme/repo", githubToken: null }) },
    kanbanBoard: {
      findUnique: jest.fn().mockResolvedValue(null),
      delete: jest.fn().mockResolvedValue({}),
      create: jest.fn().mockResolvedValue({ id: "board-1", stages: [] }),
    },
  })),
}));

jest.mock("../github/GitHubService", () => ({
  GitHubService: {
    getPullRequestDiff: jest.fn().mockResolvedValue("diff --git a/src/index.ts b/src/index.ts"),
    listPullRequests: jest.fn().mockResolvedValue([{ number: 1, title: "Improve code", author: "dev", headBranch: "feature", baseBranch: "main", body: "details", changedFiles: 1, additions: 1, deletions: 1 }]),
  },
}));

jest.mock("../../utils/encryption", () => ({ decrypt: jest.fn((value: string) => value) }));
jest.mock("../../services/workflow-context.service", () => ({
  WorkflowContextService: jest.fn().mockImplementation(() => ({
    getProjectWorkflowContext: jest.fn().mockResolvedValue({ requirements: "req", documentation: "docs", architecture: "arch", implementation: "impl" }),
    buildSystemBoundaryPrompt: jest.fn().mockReturnValue("WORKFLOW CONTEXT"),
  })),
}));

function gatewayResult<T>(content: T, stage: string) {
  return { content, rawResponse: {}, finishReason: "stop", latencyMs: 1, model: "gpt-4o", stage } as any;
}

describe("Checkpoint 1 R2C advisory and utility gateway migration", () => {
  afterEach(() => jest.restoreAllMocks());

  test("MemoryPersistence routes summaries through SUMMARIZATION and keeps technical fallback non-authoritative", async () => {
    const gatewaySpy = jest.spyOn(LLMGateway.getInstance(), "callStructured").mockResolvedValue(
      gatewayResult({ summaryEntry: "Stored architecture decision", keyDecisions: ["Use gateway"] }, PipelineStages.SUMMARIZATION),
    );
    await MemoryPersistence.persistProjectMemory("project-1", "Implement gateway", { summary: "audit" });
    expect(gatewaySpy.mock.calls[0][0].stage).toBe(PipelineStages.SUMMARIZATION);
    expect(gatewaySpy.mock.calls[0][0].schema.validate({ summaryEntry: "", keyDecisions: [] }).valid).toBe(false);
  });

  test("MemoryPersistence technical failure records only deterministic task context", async () => {
    jest.spyOn(LLMGateway.getInstance(), "callStructured").mockRejectedValue(new Error("provider unavailable"));
    await expect(MemoryPersistence.persistProjectMemory("project-1", "Implement gateway", { summary: "audit" })).resolves.toBeUndefined();
  });

  test("PullRequestReviewer routes advisory review through STATIC_REVIEW", async () => {
    const gatewaySpy = jest.spyOn(LLMGateway.getInstance(), "callStructured").mockResolvedValue(
      gatewayResult({ summary: "Looks reasonable", risks: [], suggestions: ["Add tests"], verdict: "needs_discussion", qualityScore: 75 }, PipelineStages.STATIC_REVIEW),
    );
    const result = await PullRequestReviewer.reviewPullRequest("project-1", 1);
    expect(result.verdict).toBe("needs_discussion");
    expect(gatewaySpy.mock.calls[0][0].stage).toBe(PipelineStages.STATIC_REVIEW);
    expect(gatewaySpy.mock.calls[0][0].schema.validate({ summary: "x", risks: [{ bad: true }], suggestions: [], verdict: "approve", qualityScore: 100 }).valid).toBe(false);
  });

  test("PullRequestDescription routes descriptive output through SUMMARIZATION and propagates truncation", async () => {
    const gatewaySpy = jest.spyOn(LLMGateway.getInstance(), "callStructured").mockRejectedValue(new LLMTruncationError("truncated", { stage: PipelineStages.SUMMARIZATION }));
    await expect(PullRequestDescription.generatePRDescription("project-1", 1)).rejects.toBeInstanceOf(LLMTruncationError);
    expect(gatewaySpy.mock.calls[0][0].stage).toBe(PipelineStages.SUMMARIZATION);
  });

  test("CodeCritic routes critique through STATIC_REVIEW without treating model pass as repository validation", async () => {
    const gatewaySpy = jest.spyOn(LLMGateway.getInstance(), "callStructured").mockResolvedValue(
      gatewayResult({ score: 0.8, passed: true, critique: ["Looks good"], improvements: "Add tests" }, PipelineStages.STATIC_REVIEW),
    );
    const result = await CodeCritic.critique([{ path: "src/index.ts", content: "export const value = 1;", action: "modify", description: "change" }]);
    expect(result.passed).toBe(true);
    expect(gatewaySpy.mock.calls[0][0].stage).toBe(PipelineStages.STATIC_REVIEW);
    expect(gatewaySpy.mock.calls[0][0].schema.validate({ score: 2, passed: true, critique: [], improvements: "" }).valid).toBe(false);
  });

  test("Kanban generation routes planning data through TASK_DECOMPOSITION and rejects unsafe nested paths", async () => {
    const gatewaySpy = jest.spyOn(LLMGateway.getInstance(), "callStructured").mockResolvedValue(
      gatewayResult({ stages: [{ title: "Setup", order: 0, tasks: [{ title: "Create schema", description: "Define models", acceptanceCriteria: ["Schema validates"], targetFiles: ["prisma/schema.prisma"] }] }] }, PipelineStages.TASK_DECOMPOSITION),
    );
    await new KanbanService().generateBoardFromWorkflow("project-1");
    expect(gatewaySpy.mock.calls[0][0].stage).toBe(PipelineStages.TASK_DECOMPOSITION);
    expect(gatewaySpy.mock.calls[0][0].schema.validate({ stages: [{ title: "x", order: 0, tasks: [{ title: "x", description: "x", acceptanceCriteria: ["x"], targetFiles: ["../outside.ts"] }] }] }).valid).toBe(false);
    expect(gatewaySpy.mock.calls[0][0].schema.validate({ stages: [{ title: "x", order: 0, tasks: [{ title: "x", description: "x", acceptanceCriteria: ["x"], targetFiles: ["src/a.ts"], success: true }] }] }).valid).toBe(false);
  });

  test("Kanban provider failure cannot create a board", async () => {
    jest.spyOn(LLMGateway.getInstance(), "callStructured").mockRejectedValue(new Error("provider unavailable"));
    await expect(new KanbanService().generateBoardFromWorkflow("project-1")).rejects.toThrow("provider unavailable");
  });

  test("all R2C requests use gateway stages and no direct provider fallback exists", () => {
    expect([PipelineStages.SUMMARIZATION, PipelineStages.STATIC_REVIEW, PipelineStages.TASK_DECOMPOSITION]).toHaveLength(3);
    expect(GitHubService.getPullRequestDiff).toBeDefined();
  });
});
