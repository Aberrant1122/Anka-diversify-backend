import fs from "fs";
import path from "path";
import OpenAI from "openai";
import {
  BudgetAttemptInput,
  BudgetManager,
  ClarificationPolicy,
  ContextManager,
  CONTEXT_SAFETY_RESERVE_TOKENS,
  REQUEST_PROTOCOL_OVERHEAD_TOKENS,
  LLMBudgetConfigurationError,
  LLMBudgetExhaustedError,
  LLMContextOverflowError,
  LLMGateway,
  LLMInvalidJsonError,
  LLMRoutingError,
  LLMTelemetry,
  ModelRouter,
  PipelineStage,
  PipelineStages,
  REPOSITORY_EVIDENCE_NOTICE,
  estimateMessageTokens,
  estimateTextTokens,
} from "../index";

function configuredRouter(): ModelRouter {
  return new ModelRouter({
    fastModel: "fast-model",
    standardModel: "standard-model",
    reasoningModel: "reasoning-model",
    fallbackModel: "fallback-model",
  });
}

function clientWithCreate(create: jest.Mock): OpenAI {
  return { chat: { completions: { create } } } as unknown as OpenAI;
}

function successfulResponse(content = "ok", promptTokens = 4, completionTokens = 2) {
  return {
    choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

describe("Checkpoint 2 runtime managers", () => {
  let telemetry: LLMTelemetry;

  beforeEach(() => {
    telemetry = LLMTelemetry.getInstance();
    telemetry.clear();
  });

  describe("ModelRouter", () => {
    test("routes every PipelineStage through the exact deterministic policy matrix", () => {
      const router = configuredRouter();
      const cases: Array<[PipelineStage, string, string, number]> = [
        [PipelineStages.INTENT_CLASSIFICATION, "FAST", "fast-model", 2_000],
        [PipelineStages.PLAN_REORDER, "FAST", "fast-model", 1_000],
        [PipelineStages.TASK_DECOMPOSITION, "STANDARD", "standard-model", 4_000],
        [PipelineStages.REPOSITORY_REASONING, "STANDARD", "standard-model", 4_000],
        [PipelineStages.MANIFEST_GENERATION, "STANDARD", "standard-model", 8_000],
        [PipelineStages.MANIFEST_CORRECTION, "STANDARD", "standard-model", 8_000],
        [PipelineStages.ROADMAP_PLANNING, "STANDARD", "standard-model", 4_000],
        [PipelineStages.CODE_GENERATION, "REASONING", "reasoning-model", 12_000],
        [PipelineStages.CODE_CORRECTION, "REASONING", "reasoning-model", 12_000],
        [PipelineStages.REPAIR, "REASONING", "reasoning-model", 12_000],
        [PipelineStages.STATIC_REVIEW, "STANDARD", "standard-model", 4_000],
        [PipelineStages.FEATURE_VALIDATION, "STANDARD", "standard-model", 4_000],
        [PipelineStages.SECURITY_AUDIT, "REASONING", "reasoning-model", 6_000],
        [PipelineStages.APPLICATION_SUPPORT, "FAST", "fast-model", 4_000],
        [PipelineStages.SUMMARIZATION, "FAST", "fast-model", 2_000],
      ];
      for (const [stage, tier, model, maxOutputTokens] of cases) {
        const decision = router.route(stage);
        expect(decision).toEqual(router.route(stage));
        expect(decision).toMatchObject({ stage, tier, primaryModel: model, maxOutputTokens });
        expect(decision.contextWindowTokens).toBe(
          decision.maxInputTokens + decision.maxOutputTokens + CONTEXT_SAFETY_RESERVE_TOKENS
        );
        expect(decision.fallbackModels).toEqual(["fallback-model"]);
      }
    });

    test("unsupported stages and invalid configuration fail clearly", () => {
      const router = configuredRouter();
      expect(() => router.route("UNSUPPORTED" as PipelineStage)).toThrow(LLMRoutingError);
      expect(() => new ModelRouter({ fastModel: "   " })).toThrow(LLMRoutingError);
    });

    test("caller data cannot promote tier or select a provider model", async () => {
      const create = jest.fn().mockResolvedValue(successfulResponse());
      const gateway = new LLMGateway(telemetry, { modelRouter: configuredRouter() });
      const untrusted = {
        stage: PipelineStages.APPLICATION_SUPPORT,
        messages: [{ role: "user", content: "Goal" }],
        routingMetadata: { taskRisk: "HIGH", requiresVision: true },
        model: "attacker-selected-model",
        openaiClient: clientWithCreate(create),
      } as Parameters<LLMGateway["call"]>[0] & { routingMetadata: object; model: string };
      await gateway.call(untrusted);
      expect(create.mock.calls[0][0].model).toBe("fast-model");
    });

    test("fallback selection is finite, ordered, and deterministic", () => {
      const router = configuredRouter();
      const decision = router.route(PipelineStages.REPOSITORY_REASONING);
      expect(router.modelForAttempt(decision, 1)).toBe("standard-model");
      expect(router.modelForAttempt(decision, 2)).toBe("fallback-model");
      expect(router.modelForAttempt(decision, 3)).toBe("fallback-model");
      expect(() => router.modelForAttempt(decision, Number.POSITIVE_INFINITY)).toThrow(LLMRoutingError);
    });
  });

  describe("BudgetManager", () => {
    test("accounts usage once and exposes deterministic remaining budget", () => {
      const manager = new BudgetManager({ maxRequests: 3, maxTokens: 100 });
      const reservation = manager.beginAttempt({
        scopeId: "run-1",
        stage: PipelineStages.CODE_GENERATION,
        model: "reasoning-model",
        estimatedInputTokens: 10,
        maxOutputTokens: 20,
      });
      expect(manager.snapshot("run-1")).toMatchObject({ requestsUsed: 1, tokensReserved: 30, tokensRemaining: 70 });
      expect(manager.completeAttempt(reservation, 12).outcome).toBe("ACCOUNTED");
      expect(manager.completeAttempt(reservation, 12).outcome).toBe("ALREADY_ACCOUNTED");
      expect(manager.snapshot("run-1")).toMatchObject({ requestsUsed: 1, tokensUsed: 12, tokensReserved: 0, tokensRemaining: 88 });
    });

    test("fails closed when an operation is unaffordable", () => {
      const manager = new BudgetManager({ maxRequests: 1, maxTokens: 20 });
      expect(() => manager.beginAttempt({
        scopeId: "run-2",
        stage: PipelineStages.REPAIR,
        model: "reasoning-model",
        estimatedInputTokens: 15,
        maxOutputTokens: 10,
      })).toThrow(LLMBudgetExhaustedError);
      expect(manager.snapshot("run-2").requestsUsed).toBe(0);
    });

    test("rejects invalid or unbounded limits", () => {
      expect(() => new BudgetManager({ maxRequests: Number.POSITIVE_INFINITY })).toThrow(LLMBudgetConfigurationError);
      expect(() => new BudgetManager({ maxTokens: Number.NaN })).toThrow(LLMBudgetConfigurationError);
      expect(() => new BudgetManager({ maxTokens: -1 })).toThrow(LLMBudgetConfigurationError);
      expect(() => new BudgetManager({ maxRequests: 0 })).toThrow(LLMBudgetConfigurationError);
    });

    test("enforces the exact affordability boundary and rejects one token over", () => {
      const manager = new BudgetManager({ maxRequests: 2, maxTokens: 20 });
      const exact = manager.beginAttempt({
        scopeId: "exact", stage: PipelineStages.SUMMARIZATION, model: "fast-model",
        estimatedInputTokens: 10, maxOutputTokens: 10,
      });
      expect(manager.completeAttempt(exact, 20)).toMatchObject({ outcome: "ACCOUNTED", overBudget: false });
      const over = new BudgetManager({ maxRequests: 2, maxTokens: 20 });
      expect(() => over.beginAttempt({
        scopeId: "over", stage: PipelineStages.SUMMARIZATION, model: "fast-model",
        estimatedInputTokens: 10, maxOutputTokens: 11,
      })).toThrow(LLMBudgetExhaustedError);
    });

    test("settles actual usage below, equal to, and above the reservation exactly once", () => {
      for (const [scopeId, actual, overBudget] of [["below", 9, false], ["equal", 20, false], ["above", 26, true]] as const) {
        const manager = new BudgetManager({ maxRequests: 1, maxTokens: 25 });
        const reservation = manager.beginAttempt({
          scopeId, stage: PipelineStages.SUMMARIZATION, model: "fast-model",
          estimatedInputTokens: 10, maxOutputTokens: 10,
        });
        const first = manager.completeAttempt(reservation, actual);
        const second = manager.completeAttempt(reservation, actual);
        expect(first).toMatchObject({ outcome: "ACCOUNTED", accountedTokens: actual, overBudget });
        expect(second).toMatchObject({ outcome: "ALREADY_ACCOUNTED", accountedTokens: actual, overBudget });
        expect(manager.snapshot(scopeId).tokensUsed).toBe(actual);
      }
    });

    test("releaseScope removes settled reservation bookkeeping but preserves active attempts", () => {
      const manager = new BudgetManager({ maxRequests: 200, maxTokens: 10_000 });
      const active = manager.beginAttempt({
        scopeId: "active", stage: PipelineStages.SUMMARIZATION, model: "fast-model",
        estimatedInputTokens: 1, maxOutputTokens: 1,
      });
      manager.releaseScope("active");
      expect(manager.completeAttempt(active, 1).outcome).toBe("ACCOUNTED");
      manager.releaseScope("active");
      expect(() => manager.completeAttempt(active, 1)).toThrow(LLMBudgetConfigurationError);
      for (let index = 0; index < 100; index += 1) {
        const scopeId = manager.createOperationScope();
        const reservation = manager.beginAttempt({
          scopeId, stage: PipelineStages.SUMMARIZATION, model: "fast-model",
          estimatedInputTokens: 1, maxOutputTokens: 1,
        });
        manager.completeAttempt(reservation, 1);
        manager.releaseScope(scopeId);
        expect(() => manager.completeAttempt(reservation, 1)).toThrow(LLMBudgetConfigurationError);
      }
    });

    test("untrusted fields cannot expand a configured budget", () => {
      const manager = new BudgetManager({ maxRequests: 2, maxTokens: 25 });
      const input = {
        scopeId: "run-3",
        stage: PipelineStages.SUMMARIZATION,
        model: "fast-model",
        estimatedInputTokens: 5,
        maxOutputTokens: 5,
        maxTokens: 1_000_000,
      } as BudgetAttemptInput & { maxTokens: number };
      const reservation = manager.beginAttempt(input);
      manager.completeAttempt(reservation, 20);
      expect(() => manager.beginAttempt(input)).toThrow(LLMBudgetExhaustedError);
    });

    test("gateway retries consume one request and one token settlement per attempt", async () => {
      const manager = new BudgetManager({ maxRequests: 3, maxTokens: 1_000 });
      const rateLimit = Object.assign(new Error("rate limit"), { status: 429 });
      const create = jest.fn()
        .mockRejectedValueOnce(rateLimit)
        .mockResolvedValueOnce(successfulResponse("done", 5, 3));
      const gateway = new LLMGateway(telemetry, { modelRouter: configuredRouter(), budgetManager: manager });

      await gateway.call({
        stage: PipelineStages.APPLICATION_SUPPORT,
        context: { runId: "retry-run" },
        messages: [{ role: "user", content: "help" }],
        maxTokens: 10,
        maxRetries: 1,
        retryDelayMs: 0,
        openaiClient: clientWithCreate(create),
      });

      const snapshot = manager.snapshot("retry-run");
      const accounted = telemetry.getEvents().filter((event) => event.name === "llm.budget_accounted");
      expect(snapshot.requestsUsed).toBe(2);
      expect(accounted).toHaveLength(2);
      expect(accounted.reduce((sum, event) => sum + (event.value ?? 0), 0)).toBe(snapshot.tokensUsed);
      expect(create.mock.calls.map((call) => call[0].model)).toEqual(["fast-model", "fallback-model"]);
    });

    test("a provider response that later fails validation is not double-counted", async () => {
      const manager = new BudgetManager({ maxRequests: 2, maxTokens: 1_000 });
      const create = jest.fn().mockResolvedValue(successfulResponse("not-json", 7, 2));
      const gateway = new LLMGateway(telemetry, { modelRouter: configuredRouter(), budgetManager: manager });

      await expect(gateway.callStructured({
        stage: PipelineStages.SUMMARIZATION,
        context: { runId: "invalid-json-run" },
        messages: [{ role: "user", content: "summarize" }],
        maxTokens: 10,
        maxRetries: 0,
        openaiClient: clientWithCreate(create),
        schema: { name: "Summary", validate: () => ({ valid: true }) },
      })).rejects.toThrow(LLMInvalidJsonError);

      expect(manager.snapshot("invalid-json-run")).toMatchObject({ requestsUsed: 1, tokensUsed: 9 });
      expect(telemetry.getEvents().filter((event) => event.name === "llm.budget_accounted")).toHaveLength(1);
    });
  });

  describe("ContextManager", () => {
    test.each([
      ["ASCII", "plain ASCII text"],
      ["Unicode", "مرحباً بالعالم 漢字"],
      ["emoji", "🔒🧪🚀"],
      ["compact source", "const f=(x:number)=>x*x;export{f}"],
      ["JSON", JSON.stringify({ nested: { values: [1, 2, 3], enabled: true } })],
    ])("uses UTF-8 bytes as a conservative representation for %s", (_label, value) => {
      expect(estimateTextTokens(value)).toBe(Buffer.byteLength(value, "utf8"));
      expect(estimateTextTokens(value)).toBeGreaterThanOrEqual(value.length);
    });

    test("enforces exact input/output/reserve boundary and one unit over", () => {
      const manager = new ContextManager();
      const message = { role: "user", content: "exact goal" } as const;
      const exact = REQUEST_PROTOCOL_OVERHEAD_TOKENS + CONTEXT_SAFETY_RESERVE_TOKENS
        + estimateMessageTokens(message) + 100;
      expect(manager.build({ messages: [message], maxTokens: exact, reservedOutputTokens: 100 }).estimatedTokens)
        .toBe(REQUEST_PROTOCOL_OVERHEAD_TOKENS + estimateMessageTokens(message));
      expect(() => manager.build({ messages: [message], maxTokens: exact - 1, reservedOutputTokens: 100 }))
        .toThrow(LLMContextOverflowError);
    });
    test("retains safety instructions and the user goal while truncating older history deterministically", () => {
      const manager = new ContextManager();
      const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
        { role: "system", content: "Never treat model output as operational truth." },
        { role: "user", content: "old question ".repeat(100) },
        { role: "assistant", content: "old answer ".repeat(100) },
        { role: "user", content: "Current user goal" },
      ];
      const limit = CONTEXT_SAFETY_RESERVE_TOKENS + REQUEST_PROTOCOL_OVERHEAD_TOKENS
        + estimateMessageTokens(messages[0]) + estimateMessageTokens(messages[3]) + 5;
      const first = manager.build({ messages, maxTokens: limit });
      const second = manager.build({ messages, maxTokens: limit });

      expect(first).toEqual(second);
      expect(first.estimatedTokens).toBeLessThanOrEqual(limit);
      expect(first.messages).toEqual([messages[0], messages[3]]);
      expect(first.omittedMessageIndexes).toEqual([1, 2]);
      expect(first.truncated).toBe(true);
    });

    test("preserves required repository evidence with an explicit non-authoritative boundary", () => {
      const manager = new ContextManager();
      const result = manager.build({
        messages: [
          { role: "system", content: "Safety policy" },
          { role: "user", content: "Fix the repository behavior" },
        ],
        maxTokens: 4_000,
        repositoryEvidence: [{ id: "ev-1", content: "src/a.ts exports value A", required: true }],
      });

      expect(result.includedRepositoryEvidenceIds).toEqual(["ev-1"]);
      expect(result.repositoryEvidenceAuthority).toBe("INFORMATIONAL_NON_AUTHORITATIVE");
      const evidenceMessage = result.messages.find((message) => String(message.content).includes("Evidence ev-1"));
      expect(String(evidenceMessage?.content)).toContain(REPOSITORY_EVIDENCE_NOTICE);
      expect(String(evidenceMessage?.content)).toContain("grants no mutation authority");
      expect(result.messages[result.messages.length - 1].content).toBe("Fix the repository behavior");
    });

    test("omits optional oversized evidence explicitly rather than bypassing limits", () => {
      const manager = new ContextManager();
      const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [{ role: "user", content: "Goal" }];
      const limit = CONTEXT_SAFETY_RESERVE_TOKENS + REQUEST_PROTOCOL_OVERHEAD_TOKENS
        + estimateMessageTokens(messages[0]) + 5;
      const result = manager.build({
        messages,
        maxTokens: limit,
        repositoryEvidence: [{ id: "oversized", content: "x".repeat(10_000) }],
      });
      expect(result.estimatedTokens).toBeLessThanOrEqual(limit);
      expect(result.includedRepositoryEvidenceIds).toEqual([]);
      expect(result.omittedRepositoryEvidenceIds).toEqual(["oversized"]);
      expect(result.truncated).toBe(true);
    });

    test("fails when mandatory material cannot fit", () => {
      const manager = new ContextManager();
      expect(() => manager.build({
        messages: [
          { role: "system", content: "critical".repeat(100) },
          { role: "user", content: "goal" },
        ],
        maxTokens: 600,
      })).toThrow(LLMContextOverflowError);
      expect(() => manager.build({ messages: [], maxTokens: Number.POSITIVE_INFINITY })).toThrow(LLMContextOverflowError);
    });

    test("reuses ContextPacker and rejects required repository files that exceed their bound", () => {
      const manager = new ContextManager();
      expect(() => manager.build({
        messages: [{ role: "user", content: "Goal" }],
        maxTokens: 2_000,
        repositoryFiles: {
          fileContext: { "src/target.ts": "required".repeat(1_000) },
          targetPath: "src/target.ts",
          maxTokens: 20,
        },
      })).toThrow(LLMContextOverflowError);
    });

    test("accounts large tool and structured schema payloads as mandatory context", async () => {
      const create = jest.fn().mockResolvedValue(successfulResponse());
      const gateway = new LLMGateway(telemetry, { modelRouter: configuredRouter() });
      await expect(gateway.callWithTools({
        stage: PipelineStages.APPLICATION_SUPPORT,
        messages: [{ role: "user", content: "Goal" }],
        tools: [{ type: "function", function: { name: "huge", description: "x".repeat(40_000), parameters: { type: "object" } } }],
        validateToolCall: () => ({ valid: true }),
        openaiClient: clientWithCreate(create),
      })).rejects.toThrow(LLMContextOverflowError);
      await expect(gateway.callStructured({
        stage: PipelineStages.APPLICATION_SUPPORT,
        messages: [{ role: "user", content: "Goal" }],
        schema: {
          name: "HugeSchema", schema: { type: "object", description: "x".repeat(40_000) },
          validate: () => ({ valid: true }),
        },
        openaiClient: clientWithCreate(create),
      })).rejects.toThrow(LLMContextOverflowError);
      expect(create).not.toHaveBeenCalled();
    });
  });

  describe("production integration and failure semantics", () => {
    test("LLMGateway invokes all CP2 components before its provider call", async () => {
      const router = configuredRouter();
      const budget = new BudgetManager({ maxRequests: 5, maxTokens: 1_000 });
      const context = new ContextManager();
      const routeSpy = jest.spyOn(router, "route");
      const budgetSpy = jest.spyOn(budget, "beginAttempt");
      const contextSpy = jest.spyOn(context, "build");
      const create = jest.fn().mockResolvedValue(successfulResponse());
      const gateway = new LLMGateway(telemetry, {
        modelRouter: router,
        budgetManager: budget,
        contextManager: context,
      });

      await gateway.call({
        stage: PipelineStages.APPLICATION_SUPPORT,
        context: { runId: "integration-run" },
        messages: [{ role: "system", content: "Safety" }, { role: "user", content: "Goal" }],
        maxTokens: 10,
        openaiClient: clientWithCreate(create),
      });

      expect(routeSpy).toHaveBeenCalledTimes(1);
      expect(contextSpy).toHaveBeenCalledTimes(1);
      expect(budgetSpy).toHaveBeenCalledTimes(1);
      expect(create).toHaveBeenCalledTimes(1);
      expect(telemetry.getEvents().map((event) => event.name)).toEqual(expect.arrayContaining([
        "llm.route", "llm.context", "llm.budget_reserved", "llm.budget_accounted", "llm.call",
      ]));
    });

    test("gateway preserves required repository evidence while truncating optional history", async () => {
      const create = jest.fn().mockResolvedValue(successfulResponse());
      const gateway = new LLMGateway(telemetry, { modelRouter: configuredRouter() });
      await gateway.call({
        stage: PipelineStages.APPLICATION_SUPPORT,
        messages: [
          { role: "system", content: "Safety" },
          { role: "user", content: "old".repeat(20_000) },
          { role: "assistant", content: "old response".repeat(20_000) },
          { role: "user", content: "Current goal" },
        ],
        repositoryEvidence: [{ id: "materialized:src/a.ts", content: "export const a = 1;", required: true }],
        maxTokens: 10,
        openaiClient: clientWithCreate(create),
      });
      const sent = create.mock.calls[0][0].messages as Array<{ content?: string }>;
      expect(sent.some((message) => String(message.content).includes("Evidence materialized:src/a.ts"))).toBe(true);
      expect(sent.some((message) => String(message.content).includes("old response"))).toBe(false);
      expect(sent[sent.length - 1].content).toBe("Current goal");
    });

    test("gateway rejects oversized required repository evidence before provider execution", async () => {
      const create = jest.fn().mockResolvedValue(successfulResponse());
      const gateway = new LLMGateway(telemetry, { modelRouter: configuredRouter() });
      await expect(gateway.call({
        stage: PipelineStages.APPLICATION_SUPPORT,
        messages: [{ role: "user", content: "Current goal" }],
        repositoryEvidence: [{ id: "materialized:huge", content: "x".repeat(40_000), required: true }],
        openaiClient: clientWithCreate(create),
      })).rejects.toThrow(LLMContextOverflowError);
      expect(create).not.toHaveBeenCalled();
    });

    test("provider overage emits usage/accounting/overage once and still fails", async () => {
      const manager = new BudgetManager({ maxRequests: 2, maxTokens: 1_000 });
      const create = jest.fn().mockResolvedValue(successfulResponse("ignored", 900, 200));
      const gateway = new LLMGateway(telemetry, { modelRouter: configuredRouter(), budgetManager: manager });
      await expect(gateway.call({
        stage: PipelineStages.APPLICATION_SUPPORT,
        context: { runId: "overage-run" },
        messages: [{ role: "user", content: "Goal" }],
        maxTokens: 10,
        openaiClient: clientWithCreate(create),
      })).rejects.toThrow(LLMBudgetExhaustedError);
      expect(manager.snapshot("overage-run")).toMatchObject({ requestsUsed: 1, tokensUsed: 1_100 });
      for (const name of ["llm.budget_accounted", "llm.tokens_input", "llm.tokens_output", "llm.budget_overage"]) {
        expect(telemetry.getEvents().filter((event) => event.name === name)).toHaveLength(1);
      }
    });

    test("caller-injected model and context-limit fields cannot bypass backend policy", async () => {
      const create = jest.fn().mockResolvedValue(successfulResponse());
      const gateway = new LLMGateway(telemetry, { modelRouter: configuredRouter() });
      const options = {
        stage: PipelineStages.APPLICATION_SUPPORT,
        messages: [{ role: "user", content: "Goal" }],
        model: "attacker-model",
        contextLimit: Number.POSITIVE_INFINITY,
        openaiClient: clientWithCreate(create),
      } as Parameters<LLMGateway["call"]>[0] & { model: string; contextLimit: number };
      await gateway.call(options);
      expect(create.mock.calls[0][0].model).toBe("fast-model");
    });

    test("an injected unbounded context limit cannot admit oversized mandatory context", async () => {
      const create = jest.fn().mockResolvedValue(successfulResponse());
      const gateway = new LLMGateway(telemetry, { modelRouter: configuredRouter() });
      const options = {
        stage: PipelineStages.APPLICATION_SUPPORT,
        messages: [{ role: "user", content: "mandatory-goal".repeat(20_000) }],
        contextLimit: Number.POSITIVE_INFINITY,
        openaiClient: clientWithCreate(create),
      } as Parameters<LLMGateway["call"]>[0] & { contextLimit: number };
      await expect(gateway.call(options)).rejects.toThrow(LLMContextOverflowError);
      expect(create).not.toHaveBeenCalled();
    });

    test("routing, budget, and context failures remain technical and never clarification", () => {
      const failures = [
        new LLMRoutingError("route failed"),
        new LLMBudgetExhaustedError("budget exhausted"),
        new LLMContextOverflowError("context overflow"),
      ];
      for (const failure of failures) {
        const decision = ClarificationPolicy.evaluate({ category: "TECHNICAL_FAILURE", technicalError: failure });
        expect(decision.outcome).toBe("TECHNICAL_FAILURE");
        expect(decision.requiresClarification).toBe(false);
        expect(decision.clarification).toBeUndefined();
      }
    });

    test("production generative and embedding provider bypass counts remain zero", () => {
      const root = path.resolve(__dirname, "../..");
      const files: string[] = [];
      const visit = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (entry.name !== "__tests__" && entry.name !== "evals") visit(full);
          } else if (entry.name.endsWith(".ts")) files.push(full);
        }
      };
      visit(root);
      const generative = files.filter((file) =>
        !file.endsWith(path.join("gateway", "LLMGateway.ts"))
        && /(?:chat\.completions|completions|responses)\.create\s*\(/.test(fs.readFileSync(file, "utf8"))
      );
      const embeddings = files.filter((file) =>
        !file.endsWith(path.join("gateway", "EmbeddingGateway.ts"))
        && /embeddings\.create\s*\(/.test(fs.readFileSync(file, "utf8"))
      );
      expect(generative).toEqual([]);
      expect(embeddings).toEqual([]);
    });
  });
});
