import fs from "fs";
import path from "path";
import { AgentWorkspaceState } from "../runtime/AgentWorkspaceState";
import { TaskRuntime, VerifiedCompletionReceipt } from "../runtime/TaskRuntime";
import { CompletionEvaluator } from "../runtime/CompletionEvaluator";
import { VerifiedCheckpointJournal } from "../runtime/VerifiedCheckpointJournal";
import { CodingAgent } from "../application/CodingAgent";
import { GitWorktreeService } from "../../services/git-worktree.service";
import { prisma } from "../../services/database";
import { BudgetManager } from "../gateway/BudgetManager";
import { ContextManager } from "../context/ContextManager";
import { LLMGateway } from "../gateway/LLMGateway";
import { ModelRouter } from "../gateway/ModelRouter";
import { PipelineStages } from "../gateway/PipelineStage";
import { runWithTaskRuntimeScope } from "../runtime/TaskRuntimeScope";

jest.mock("../../services/database", () => ({
  prisma: {
    project: { findUnique: jest.fn() },
    projectRepository: { findFirst: jest.fn() },
  },
}));

function workspace(): AgentWorkspaceState {
  return AgentWorkspaceState.create({
    projectId: "project-1",
    repositoryId: "repository-1",
    root: path.resolve("fixture-repository"),
    revision: "abc123",
    constraints: [{ id: "bounded", description: "Stay within the task boundary." }],
  });
}

function evaluatorReceipt(runtime: TaskRuntime): VerifiedCompletionReceipt {
  const revision = "completion-revision";
  runtime.updateWorkspace(runtime.workspaceState().withEvidence({
    id: `completion:${runtime.snapshot().taskId}`,
    kind: "MATERIALIZED_REPOSITORY",
    description: "Fresh deterministic test repository observation.",
    revision,
  }).withWorkingPlan({ id: "cp8-plan", revision: 1, status: "AWAITING_COMPLETION_EVALUATION" }));
  const result = CompletionEvaluator.evaluate({
    runtime,
    handoff: { outcome: "AWAITING_COMPLETION_EVALUATION", workingPlanId: "cp8-plan", workingPlanRevision: 1 },
    journal: new VerifiedCheckpointJournal(),
    repository: { root: runtime.snapshot().workspace.repository.root, revision, changedPaths: [], source: "MATERIALIZED_REPOSITORY", coverage: "FULL_REPOSITORY_DELTA" },
    validation: { passed: true, repositoryRevision: revision, source: "VALIDATION_RUNNER" },
    requirements: [{ id: "runtime-test", description: "Lifecycle test criterion", required: true, status: "SATISFIED", repositoryRevision: revision }],
  });
  if (result.outcome !== "COMPLETE") throw new Error(`Fixture completion failed: ${result.code}`);
  return result.receipt;
}

describe("Checkpoint 3 deterministic runtime and workspace state", () => {
  afterEach(() => jest.restoreAllMocks());

  test("creates stable runtime identity, scope, timestamps, and immutable initial state", () => {
    const timestamps = [new Date("2026-01-01T00:00:00.000Z"), new Date("2026-01-01T00:00:01.000Z")];
    const runtime = TaskRuntime.create({
      taskId: "task-stable-1",
      originalGoal: "Fix the requested behavior",
      workspace: workspace(),
      runtimeScopeId: "scope-stable-1",
      now: () => timestamps.shift()!,
    });

    expect(runtime.snapshot()).toMatchObject({
      taskId: "task-stable-1",
      originalGoal: "Fix the requested behavior",
      status: "CREATED",
      createdAt: "2026-01-01T00:00:00.000Z",
      runtimeScope: { budgetScopeId: "scope-stable-1", contextScopeId: "scope-stable-1" },
    });
    runtime.start();
    expect(runtime.snapshot()).toMatchObject({ status: "RUNNING", startedAt: "2026-01-01T00:00:01.000Z" });
    expect(Object.isFrozen(runtime.snapshot())).toBe(true);
  });

  test("allows only explicit lifecycle transitions and protects terminal states", () => {
    const runtime = TaskRuntime.create({ taskId: "task-2", originalGoal: "Goal", workspace: workspace() });
    expect(() => runtime.complete({ type: "COMPLETED" } as unknown as VerifiedCompletionReceipt)).toThrow(/from CREATED/);
    runtime.start();
    runtime.requestClarification({ question: "Which target?", reason: "Two targets are equally plausible." });
    expect(runtime.snapshot()).toMatchObject({ status: "AWAITING_CLARIFICATION" });
    expect(() => runtime.start()).toThrow(/AWAITING_CLARIFICATION/);
    runtime.resumeAfterClarification();
    runtime.complete(evaluatorReceipt(runtime));
    expect(runtime.snapshot()).toMatchObject({
      status: "COMPLETED",
      terminalOutcome: { type: "COMPLETED", validationSource: "COMPLETION_EVALUATOR" },
    });
    expect(() => runtime.start()).toThrow(/COMPLETED/);
    expect(() => runtime.fail({ failureType: "TECHNICAL_FAILURE", code: "LATE", message: "late" })).toThrow(/terminal/);
    expect(() => runtime.updateWorkspace(workspace())).toThrow(/COMPLETED/);
  });

  test("keeps technical failure distinct from clarification and rejects model-shaped completion data", () => {
    const clarification = TaskRuntime.create({ taskId: "clarify", originalGoal: "Goal", workspace: workspace() });
    clarification.start();
    clarification.requestClarification({ question: "Choose A or B?", reason: "User intent is ambiguous." });
    expect(clarification.snapshot().terminalOutcome).toBeUndefined();
    expect(clarification.snapshot().clarification).toBeDefined();

    const failed = TaskRuntime.create({ taskId: "failed", originalGoal: "Goal", workspace: workspace() });
    failed.start();
    expect(() => failed.complete({
      source: "model",
      isAuthentic: () => true,
    } as unknown as VerifiedCompletionReceipt)).toThrow(/authentic CompletionEvaluator receipt/);
    failed.fail({ failureType: "TECHNICAL_FAILURE", code: "PROVIDER_DOWN", message: "Provider unavailable" });
    expect(failed.snapshot()).toMatchObject({
      status: "FAILED",
      terminalOutcome: { type: "FAILED", failureType: "TECHNICAL_FAILURE", code: "PROVIDER_DOWN" },
    });
  });

  test("workspace updates are controlled, immutable, bounded, and preserve evidence provenance", () => {
    const initial = workspace();
    const materialized = initial.withEvidence({
      id: "disk:src/a.ts",
      kind: "MATERIALIZED_REPOSITORY",
      description: "Read from disk",
      path: "src/a.ts",
      revision: "abc123",
    });
    const advisory = materialized.withEvidence({
      id: "semantic:src/b.ts",
      kind: "SEMANTIC_ADVISORY",
      description: "Embedding search candidate",
      path: "src/b.ts",
    });
    const updated = advisory
      .withRelevantPaths(["src/b.ts", "src/a.ts", "src/a.ts"])
      .withValidationFact({ id: "tsc", command: "npx tsc --noEmit", passed: true, source: "DETERMINISTIC_TOOL" })
      .withWorkingPlan({ id: "future-plan", status: "NOT_STARTED" });

    expect(initial.snapshot().evidence).toEqual([]);
    expect(updated.snapshot().evidence.map((item) => item.kind)).toEqual([
      "MATERIALIZED_REPOSITORY",
      "SEMANTIC_ADVISORY",
    ]);
    expect(updated.snapshot().relevantPaths).toEqual(["src/a.ts", "src/b.ts"]);
    expect(updated.snapshot().validationFacts[0].source).toBe("DETERMINISTIC_TOOL");
    expect(updated.snapshot().authority).toBe("KNOWLEDGE_ONLY_NO_MUTATION_AUTHORITY");
    expect(Object.isFrozen(updated.snapshot().evidence)).toBe(true);
    expect("writeFile" in updated).toBe(false);
    expect(() => updated.withRelevantPaths(["../outside.ts"])).toThrow(/repository-relative/);
    expect(() => updated.withRelevantPaths([path.resolve("absolute.ts")])).toThrow(/repository-relative/);
    expect(() => updated.withValidationFact({
      id: "model",
      command: "model says pass",
      passed: true,
      source: "MODEL" as unknown as "DETERMINISTIC_TOOL",
    })).toThrow(/deterministic tool provenance/);
    expect(() => updated.withValidationFact({
      id: "invalid-boolean",
      command: "npx tsc --noEmit",
      passed: "yes" as unknown as boolean,
      source: "DETERMINISTIC_TOOL",
    })).toThrow(/must be boolean/);
  });

  test("the user-facing production flow preserves deterministic state for CP8 completion evaluation", async () => {
    (prisma.project.findUnique as jest.Mock).mockResolvedValue({
      id: "project-1",
      localPath: path.resolve("production-repository"),
      githubUrl: null,
    });
    jest.spyOn(fs, "existsSync").mockReturnValue(true);
    jest.spyOn(GitWorktreeService, "resolveRepositoryRoot").mockResolvedValue(path.resolve("production-repository"));
    jest.spyOn(GitWorktreeService, "getHeadCommitSha").mockResolvedValue("deterministic-head");
    const isolated = jest.spyOn(GitWorktreeService, "runIsolatedAgent").mockResolvedValue({
      runId: "worktree-run",
      branchName: "anka/run-test",
      baseCommitSha: "deterministic-head",
      worktreePath: path.resolve("isolated-worktree"),
      changedFiles: ["src/feature.ts"],
      diffSummary: "changed",
      validationPassed: true,
      validationCommands: ["npm test"],
      agentResponse: { explanation: "done", changes: [], commitMessage: "change", sessionId: "session-1" },
    });

    const response = await CodingAgent.runCodingAgent("user-1", "project-1", { message: "Implement feature" });

    expect(isolated).toHaveBeenCalledTimes(1);
    expect(response.taskRuntime).toMatchObject({
      originalGoal: "Implement feature",
      status: "RUNNING",
      runtimeScope: { budgetScopeId: response.taskRuntime?.taskId, contextScopeId: response.taskRuntime?.taskId },
      workspace: {
        repository: { projectId: "project-1", revision: "deterministic-head" },
        relevantPaths: ["src/feature.ts"],
        authority: "KNOWLEDGE_ONLY_NO_MUTATION_AUTHORITY",
      },
    });
  });

  test("CP2 router, context, and budget authorities still gate the provider path", async () => {
    const router = new ModelRouter({
      fastModel: "backend-selected-model",
      fallbackModel: "fallback-model",
    });
    const budget = new BudgetManager({ maxRequests: 2, maxTokens: 4_000 });
    const context = new ContextManager();
    const routeSpy = jest.spyOn(router, "route");
    const budgetSpy = jest.spyOn(budget, "beginAttempt");
    const contextSpy = jest.spyOn(context, "build");
    const create = jest.fn().mockResolvedValue({
      id: "response-1",
      object: "chat.completion",
      created: 0,
      model: "backend-selected-model",
      choices: [{ index: 0, message: { role: "assistant", content: "proposal", refusal: null }, finish_reason: "stop", logprobs: null }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    });
    const gateway = new LLMGateway(undefined, { modelRouter: router, budgetManager: budget, contextManager: context });

    await runWithTaskRuntimeScope(
      { budgetScopeId: "task-runtime-scope", contextScopeId: "task-runtime-scope" },
      () => gateway.call({
        stage: PipelineStages.APPLICATION_SUPPORT,
        messages: [{ role: "user", content: "Goal" }],
        openaiClient: { chat: { completions: { create } } } as unknown as Parameters<typeof gateway.call>[0]["openaiClient"],
      })
    );

    expect(routeSpy).toHaveBeenCalledTimes(1);
    expect(contextSpy).toHaveBeenCalledTimes(1);
    expect(budgetSpy).toHaveBeenCalledWith(expect.objectContaining({ scopeId: "task-runtime-scope", model: "backend-selected-model" }));
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: "backend-selected-model" }), expect.anything());
  });
});
