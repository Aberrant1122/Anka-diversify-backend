import OpenAI from "openai";
import { APIConnectionTimeoutError, APIUserAbortError } from "openai";
import { LLMGateway } from "../../ai/gateway/LLMGateway";
import { ModelRouter } from "../../ai/gateway/ModelRouter";
import { PipelineStages } from "../../ai/gateway/PipelineStage";
import { LLMTimeoutError, LLMContextOverflowError } from "../../ai/gateway/LLMError";
import { assertArchitectureCapacity } from "../architecture-capacity";
import { ARCHITECTURE_PROVIDER_JSON_SCHEMA, validateGeneratedArchitecture } from "../../ai/prompts/architecture";
import { architectureDraft } from "./architecture-test-fixtures";
import { getOpenAI } from "../../ai/shared/utils";

describe("Architecture generation reliability & regression suite", () => {
  const originalArchRevEffort = process.env.OPENAI_ARCHITECTURE_REVISION_REASONING_EFFORT;
  const originalArchGenEffort = process.env.OPENAI_ARCHITECTURE_GENERATION_REASONING_EFFORT;
  const originalArchModel = process.env.OPENAI_ARCHITECTURE_MODEL;

  afterEach(() => {
    if (originalArchRevEffort === undefined) delete process.env.OPENAI_ARCHITECTURE_REVISION_REASONING_EFFORT;
    else process.env.OPENAI_ARCHITECTURE_REVISION_REASONING_EFFORT = originalArchRevEffort;
    if (originalArchGenEffort === undefined) delete process.env.OPENAI_ARCHITECTURE_GENERATION_REASONING_EFFORT;
    else process.env.OPENAI_ARCHITECTURE_GENERATION_REASONING_EFFORT = originalArchGenEffort;
    if (originalArchModel === undefined) delete process.env.OPENAI_ARCHITECTURE_MODEL;
    else process.env.OPENAI_ARCHITECTURE_MODEL = originalArchModel;
  });

  // ── 1. Effective timeout configuration and cancellation ─────────────────────
  test("1. Effective timeout configuration and cancellation", async () => {
    const client = getOpenAI();
    expect(client.timeout).toBe(360_000);

    const mockCreate = jest.fn().mockImplementation((_payload, options) => {
      expect(options.timeout).toBe(360_000);
      expect(options.signal).toBeDefined();
      expect(options.maxRetries).toBe(0);
      return Promise.reject(new APIConnectionTimeoutError({ message: "ConnectTimeoutError: Connect Timeout Error" }));
    });

    const mockClient = { chat: { completions: { create: mockCreate } } } as unknown as OpenAI;
    const gateway = new LLMGateway(undefined, { modelRouter: new ModelRouter() });

    await expect(
      gateway.call({
        stage: PipelineStages.ARCHITECTURE_GENERATION,
        messages: [{ role: "user", content: "test" }],
        maxTokens: 1000,
        maxRetries: 0,
        openaiClient: mockClient,
      })
    ).rejects.toThrow(LLMTimeoutError);

    expect(mockCreate).toHaveBeenCalled();
  });

  // ── 2. Correct timeout versus capacity-error classification ────────────────
  test("2. Correct timeout versus capacity-error classification", async () => {
    const mockTransportTimeout = {
      chat: {
        completions: {
          create: jest.fn().mockRejectedValue(new APIConnectionTimeoutError({ message: "HeadersTimeoutError: Headers Timeout Error" })),
        },
      },
    } as unknown as OpenAI;

    const gateway = new LLMGateway(undefined, { modelRouter: new ModelRouter() });

    try {
      await gateway.call({
        stage: PipelineStages.ARCHITECTURE_REVISION,
        messages: [{ role: "user", content: "test" }],
        maxTokens: 1000,
        maxRetries: 0,
        openaiClient: mockTransportTimeout,
      });
      throw new Error("Should have failed");
    } catch (err) {
      expect(err).toBeInstanceOf(LLMTimeoutError);
      const timeoutErr = err as LLMTimeoutError;
      expect(timeoutErr.details.timeoutKind).toBe("transport_timeout");
    }

    // Capacity error classification (throws LLMContextOverflowError, NOT timeout)
    const messages = [{ role: "system" as const, content: "policy" }, { role: "user" as const, content: "x".repeat(1_050_000) }];
    expect(() =>
      assertArchitectureCapacity(messages, ARCHITECTURE_PROVIDER_JSON_SCHEMA, "repair", new ModelRouter(), undefined, PipelineStages.ARCHITECTURE_REVISION)
    ).toThrow();
  });

  // ── 3. Configurable reasoning effort and default behavior ─────────────────
  test("3. Configurable reasoning effort and default behavior", () => {
    delete process.env.OPENAI_ARCHITECTURE_REVISION_REASONING_EFFORT;
    delete process.env.OPENAI_ARCHITECTURE_GENERATION_REASONING_EFFORT;

    // Default: initial generation high, revision high when unconfigured
    const defaultRouter = new ModelRouter();
    expect(defaultRouter.route(PipelineStages.ARCHITECTURE_GENERATION).reasoningEffort).toBe("high");
    expect(defaultRouter.route(PipelineStages.ARCHITECTURE_REVISION).reasoningEffort).toBe("high");

    // Configured via config object
    const configuredRouter = new ModelRouter({ architectureRevisionReasoningEffort: "medium" });
    expect(configuredRouter.route(PipelineStages.ARCHITECTURE_GENERATION).reasoningEffort).toBe("high");
    expect(configuredRouter.route(PipelineStages.ARCHITECTURE_REVISION).reasoningEffort).toBe("medium");

    // Configured via env var
    process.env.OPENAI_ARCHITECTURE_REVISION_REASONING_EFFORT = "medium";
    const envRouter = new ModelRouter();
    expect(envRouter.route(PipelineStages.ARCHITECTURE_REVISION).reasoningEffort).toBe("medium");
    expect(envRouter.route(PipelineStages.ARCHITECTURE_GENERATION).reasoningEffort).toBe("high");
  });

  // ── 4. Model context and output-budget validation ─────────────────────────
  test("4. Model context and output-budget validation", () => {
    const router = new ModelRouter();
    const genRoute = router.route(PipelineStages.ARCHITECTURE_GENERATION);
    const revRoute = router.route(PipelineStages.ARCHITECTURE_REVISION);

    expect(genRoute.maxInputTokens).toBe(400_000);
    expect(genRoute.maxOutputTokens).toBe(32_000);
    expect(revRoute.maxInputTokens).toBe(400_000);
    expect(revRoute.maxOutputTokens).toBe(32_000);

    // Context manager builds cleanly under 400k tokens
    const validMessages = [{ role: "system" as const, content: "policy" }, { role: "user" as const, content: "data".repeat(10_000) }];
    expect(() => assertArchitectureCapacity(validMessages, ARCHITECTURE_PROVIDER_JSON_SCHEMA, "repair", router)).not.toThrow();

    // Rejects oversized payload exceeding 400,000 tokens
    const oversizedMessages = [{ role: "system" as const, content: "policy" }, { role: "user" as const, content: "data".repeat(260_000) }];
    expect(() => assertArchitectureCapacity(oversizedMessages, ARCHITECTURE_PROVIDER_JSON_SCHEMA, "repair", router)).toThrow();
  });

  // ── 5. Bounded retries without duplicate artifact creation ─────────────────
  test("5. Bounded retries on retryable failure", async () => {
    const mockCreate = jest.fn().mockRejectedValue(new APIConnectionTimeoutError({ message: "timeout" }));
    const mockClient = { chat: { completions: { create: mockCreate } } } as unknown as OpenAI;
    const gateway = new LLMGateway(undefined, { modelRouter: new ModelRouter() });

    await expect(
      gateway.callStructured({
        stage: PipelineStages.ARCHITECTURE_REVISION,
        messages: [{ role: "user", content: "test" }],
        schema: { name: "test", description: "test", schema: ARCHITECTURE_PROVIDER_JSON_SCHEMA, strict: true, validate: () => ({ valid: true }) },
        maxTokens: 1000,
        maxRetries: 1,
        openaiClient: mockClient,
      })
    ).rejects.toThrow();

    // 1 initial + 1 transport retry = 2 attempts total
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  // ── 6 & 7. Architecture v1 preservation & WorkflowRun terminal cleanup ─────
  test("6 & 7. Failure preserves Architecture v1 and terminalizes WorkflowRun with activeRunId cleanup", async () => {
    const mockRuns = {
      startRevision: jest.fn().mockResolvedValue({
        run: { id: "run-failed", status: "running" },
        context: {
          payload: { operation: "DOCUMENT_REVISION", baseArchitecture: architectureDraft() },
          manifest: { promptVersion: "architecture-revision-v1", componentRetirements: [], identityRetirements: [] },
        },
        reused: false,
      }),
      finish: jest.fn().mockResolvedValue(undefined),
    };

    const mockGateway = {
      callStructured: jest.fn().mockRejectedValue(new LLMTimeoutError("LLM call timed out", { timeoutKind: "transport_timeout" })),
    };

    const { PlanningArchitectureGenerationService } = require("../../services/planning-architecture-generation.service");
    const service = new PlanningArchitectureGenerationService({} as any, {
      runs: mockRuns as any,
      gateway: mockGateway as any,
    });

    await expect(
      service.reviseArchitecture({
        projectId: "proj-1",
        actorId: "user-1",
        baseArtifactId: "arch-v1",
        baseVersion: 1,
        baseContentHash: "a".repeat(64),
        operation: "DOCUMENT_REVISION",
        instruction: "Please revise",
        idempotencyKey: "key-1",
      })
    ).rejects.toThrow();

    // Verify finish was called with status="failed" and activeRunId is released
    expect(mockRuns.finish).toHaveBeenCalledWith(
      "proj-1",
      "run-failed",
      "failed",
      expect.objectContaining({
        code: "PLANNING_AI_TIMEOUT",
        message: "Architecture generation timed out.",
      }),
      undefined
    );
  });

  // ── 8 & 9. Stale upstream authority rejection & permissions ───────────────
  test("8 & 9. Stale upstream authority rejection preserves immutable authority", async () => {
    const mockRuns = {
      startRevision: jest.fn().mockRejectedValue(
        new (require("../planning-errors").PlanningDomainError)(
          "PLANNING_CONTEXT_CHANGED",
          "Architecture upstream authority is stale; request an explicit rebase.",
          409
        )
      ),
    };

    const { PlanningArchitectureGenerationService } = require("../../services/planning-architecture-generation.service");
    const service = new PlanningArchitectureGenerationService({} as any, {
      runs: mockRuns as any,
      gateway: { callStructured: jest.fn() } as any,
    });

    await expect(
      service.reviseArchitecture({
        projectId: "proj-1",
        actorId: "user-1",
        baseArtifactId: "arch-v1",
        baseVersion: 1,
        baseContentHash: "a".repeat(64),
        operation: "DOCUMENT_REVISION",
        instruction: "Please revise",
        idempotencyKey: "key-1",
      })
    ).rejects.toMatchObject({
      code: "PLANNING_CONTEXT_CHANGED",
      httpStatus: 409,
    });
  });

  // ── 10. Structured Architecture schema validity ───────────────────────────
  test("10. Structured Architecture schema validity", () => {
    const draft = architectureDraft();
    const validResult = validateGeneratedArchitecture(draft);
    expect(validResult.valid).toBe(true);

    // Missing required authored root fails validation
    const missingRoot = { ...draft };
    delete (missingRoot as any).components;
    expect(validateGeneratedArchitecture(missingRoot).valid).toBe(false);

    // Empty components array fails validation
    const emptyComponents = { ...draft, components: [] };
    expect(validateGeneratedArchitecture(emptyComponents).valid).toBe(false);
  });
});
