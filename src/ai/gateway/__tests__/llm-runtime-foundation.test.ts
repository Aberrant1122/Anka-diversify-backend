import { APIConnectionError, APIConnectionTimeoutError, APIUserAbortError } from "openai";
import {
  PipelineStages,
  PipelineStage,
  LLMGateway,
  EmbeddingGateway,
  ModelRouter,
  resolveEmbeddingModel,
  LLMTimeoutError,
  LLMError,
  LLMRateLimitError,
  LLMNetworkError,
  LLMProviderError,
  LLMTruncationError,
  LLMInvalidJsonError,
  LLMSchemaInvalidError,
  LLMRetryExhaustedError,
  MAX_GATEWAY_RETRIES,
  ClarificationPolicy,
  ClarificationDecisionType,
  AgentOutcomeType,
  VERIFICATION_INVARIANT,
  LLMTelemetry,
} from "../index";

describe("Checkpoint 1A: LLM Runtime Foundation", () => {
  let telemetry: LLMTelemetry;

  beforeEach(() => {
    telemetry = LLMTelemetry.getInstance();
    telemetry.clear();
  });

  // ── 1. PipelineStage required ───────────────────────────────────────────────
  it("1. requires a valid PipelineStage for every generative gateway call", async () => {
    const gateway = new LLMGateway(telemetry);
    const mockClient = {
      chat: { completions: { create: jest.fn() } },
    } as any;

    await expect(
      gateway.call({
        stage: undefined as any,
        messages: [{ role: "user", content: "hello" }],
        openaiClient: mockClient,
      })
    ).rejects.toThrow(/PipelineStage is strictly required/);

    await expect(
      gateway.callStructured({
        stage: "INVALID_STAGE" as any,
        messages: [{ role: "user", content: "hello" }],
        // Deliberately bypasses the static contract to exercise the earlier stage guard.
        schema: { name: "test" } as any,
        openaiClient: mockClient,
      })
    ).rejects.toThrow(/PipelineStage is strictly required/);
  });

  // ── 2. Text call successful ────────────────────────────────────────────────
  it("2. executes successful text call with latency and token usage tracking", async () => {
    const gateway = new LLMGateway(telemetry);
    const mockClient = {
      chat: {
        completions: {
          create: jest.fn().mockResolvedValue({
            id: "chatcmpl-1",
            choices: [{ message: { content: "Generated text response" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 15, completion_tokens: 25, total_tokens: 40 },
          }),
        },
      },
    } as any;

    const result = await gateway.call({
      stage: PipelineStages.APPLICATION_SUPPORT,
      messages: [{ role: "user", content: "test" }],
      openaiClient: mockClient,
    });

    expect(result.content).toBe("Generated text response");
    expect(result.finishReason).toBe("stop");
    expect(result.usage?.promptTokens).toBe(15);
    expect(result.usage?.completionTokens).toBe(25);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  // ── 3. Structured call successful ──────────────────────────────────────────
  it("3. executes successful schema-constrained structured call with deterministic validation", async () => {
    const gateway = new LLMGateway(telemetry);
    const validPayload = { taskType: "BUG_FIX", files: ["src/index.ts"] };
    const mockClient = {
      chat: {
        completions: {
          create: jest.fn().mockResolvedValue({
            choices: [{ message: { content: JSON.stringify(validPayload) }, finish_reason: "stop" }],
            usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 },
          }),
        },
      },
    } as any;

    const result = await gateway.callStructured({
      stage: PipelineStages.INTENT_CLASSIFICATION,
      messages: [{ role: "user", content: "fix bug" }],
      schema: {
        name: "IntentSchema",
        schema: { type: "object" },
        validate: (parsed) => ({
          valid: parsed.taskType === "BUG_FIX",
          data: parsed,
        }),
      },
      openaiClient: mockClient,
    });

    expect(result.content).toEqual(validPayload);
    expect(mockClient.chat.completions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        response_format: {
          type: "json_schema",
          json_schema: expect.objectContaining({ name: "IntentSchema", strict: true }),
        },
      }),
      expect.any(Object)
    );
  });

  // ── 4. Malformed JSON → LLM_INVALID_JSON ───────────────────────────────────
  it("4. throws LLMInvalidJsonError (LLM_INVALID_JSON) on malformed JSON payload without escaping", async () => {
    const gateway = new LLMGateway(telemetry);
    const mockClient = {
      chat: {
        completions: {
          create: jest.fn().mockResolvedValue({
            choices: [{ message: { content: "{ invalid json, missing quotes " }, finish_reason: "stop" }],
          }),
        },
      },
    } as any;

    await expect(
      gateway.callStructured({
        stage: PipelineStages.CODE_GENERATION,
        messages: [{ role: "user", content: "code" }],
        schema: { name: "CodeSchema", validate: (parsed) => ({ valid: true, data: parsed }) },
        maxRetries: 0,
        openaiClient: mockClient,
      })
    ).rejects.toThrow(LLMInvalidJsonError);

    const parseFailures = telemetry.getEvents().filter((e) => e.name === "llm.parse_failure");
    expect(parseFailures.length).toBe(1);
    expect(telemetry.getEvents().filter((e) => e.name === "llm.latency")).toHaveLength(1);
  });

  // ── 5. Schema mismatch → LLM_SCHEMA_INVALID ────────────────────────────────
  it("5. throws LLMSchemaInvalidError (LLM_SCHEMA_INVALID) when payload fails post-generation validation", async () => {
    const gateway = new LLMGateway(telemetry);
    const mockClient = {
      chat: {
        completions: {
          create: jest.fn().mockResolvedValue({
            choices: [{ message: { content: JSON.stringify({ unexpectedKey: "value" }) }, finish_reason: "stop" }],
          }),
        },
      },
    } as any;

    await expect(
      gateway.callStructured({
        stage: PipelineStages.MANIFEST_GENERATION,
        messages: [{ role: "user", content: "manifest" }],
        schema: {
          name: "ManifestSchema",
          validate: (parsed) => ({
            valid: Array.isArray(parsed.files),
            errors: ["Missing required 'files' array in manifest"],
          }),
        },
        maxRetries: 0,
        openaiClient: mockClient,
      })
    ).rejects.toThrow(LLMSchemaInvalidError);

    const schemaFailures = telemetry.getEvents().filter((e) => e.name === "llm.schema_failure");
    expect(schemaFailures.length).toBe(1);
    expect(telemetry.getEvents().filter((e) => e.name === "llm.latency")).toHaveLength(1);
  });

  // ── 6. finish_reason=length → LLM_TRUNCATED ────────────────────────────────
  it("6. throws LLMTruncationError (LLM_TRUNCATED) when finish_reason is length", async () => {
    const gateway = new LLMGateway(telemetry);
    const mockClient = {
      chat: {
        completions: {
          create: jest.fn().mockResolvedValue({
            choices: [{ message: { content: '{"files": [{"path": "src/app.ts", "content": "function start() {' }, finish_reason: "length" }],
          }),
        },
      },
    } as any;

    await expect(
      gateway.call({
        stage: PipelineStages.CODE_GENERATION,
        messages: [{ role: "user", content: "code" }],
        maxRetries: 0,
        openaiClient: mockClient,
      })
    ).rejects.toThrow(LLMTruncationError);

    const truncEvents = telemetry.getEvents().filter((e) => e.name === "llm.truncated");
    expect(truncEvents.length).toBe(1);
    expect(telemetry.getEvents().filter((e) => e.name === "llm.latency")).toHaveLength(1);
  });

  // ── 7. Truncated response never reaches business caller ────────────────────
  it("7. ensures truncated partial response is discarded and never parsed or returned", async () => {
    const gateway = new LLMGateway(telemetry);
    let parseAttempted = false;
    const mockClient = {
      chat: {
        completions: {
          create: jest.fn().mockResolvedValue({
            choices: [{ message: { content: '{"halfway": 123' }, finish_reason: "length" }],
          }),
        },
      },
    } as any;

    try {
      await gateway.callStructured({
        stage: PipelineStages.MANIFEST_GENERATION,
        messages: [{ role: "user", content: "gen" }],
        schema: {
          name: "Test",
          validate: (p) => {
            parseAttempted = true;
            return { valid: true, data: p };
          },
        },
        maxRetries: 0,
        openaiClient: mockClient,
      });
      fail("Should have thrown LLMTruncationError");
    } catch (err: any) {
      expect(err).toBeInstanceOf(LLMTruncationError);
      expect(parseAttempted).toBe(false); // Validated that parsing was NEVER attempted on truncated output
    }
  });

  // ── 8. Timeout → LLM_TIMEOUT ───────────────────────────────────────────────
  it("8. normalizes timeout / AbortError to LLMTimeoutError (LLM_TIMEOUT)", async () => {
    const gateway = new LLMGateway(telemetry);
    const abortErr = new Error("The operation was aborted due to timeout");
    abortErr.name = "AbortError";

    const mockClient = {
      chat: {
        completions: {
          create: jest.fn().mockRejectedValue(abortErr),
        },
      },
    } as any;

    await expect(
      gateway.call({
        stage: PipelineStages.REPOSITORY_REASONING,
        messages: [{ role: "user", content: "reason" }],
        maxRetries: 0,
        openaiClient: mockClient,
      })
    ).rejects.toThrow(LLMTimeoutError);

    const timeoutEvents = telemetry.getEvents().filter((e) => e.name === "llm.timeout");
    expect(timeoutEvents.length).toBe(1);
  });

  // ── 9. Rate limit → LLM_RATE_LIMIT ─────────────────────────────────────────
  it("9. normalizes 429 to LLMRateLimitError (LLM_RATE_LIMIT)", async () => {
    const gateway = new LLMGateway(telemetry);
    const rateLimitErr: any = new Error("Rate limit reached for requests");
    rateLimitErr.status = 429;

    const mockClient = {
      chat: {
        completions: {
          create: jest.fn().mockRejectedValue(rateLimitErr),
        },
      },
    } as any;

    await expect(
      gateway.call({
        stage: PipelineStages.INTENT_CLASSIFICATION,
        messages: [{ role: "user", content: "classify" }],
        maxRetries: 0,
        openaiClient: mockClient,
      })
    ).rejects.toThrow(LLMRateLimitError);

    const rlEvents = telemetry.getEvents().filter((e) => e.name === "llm.rate_limit");
    expect(rlEvents.length).toBe(1);
  });

  // ── 10. Network error → LLM_NETWORK_ERROR ──────────────────────────────────
  it("10. normalizes connection / socket errors to LLMNetworkError (LLM_NETWORK_ERROR)", async () => {
    const gateway = new LLMGateway(telemetry);
    const netErr: any = new Error("fetch failed: connect ECONNRESET");
    netErr.code = "ECONNRESET";

    const mockClient = {
      chat: {
        completions: {
          create: jest.fn().mockRejectedValue(netErr),
        },
      },
    } as any;

    await expect(
      gateway.call({
        stage: PipelineStages.SECURITY_AUDIT,
        messages: [{ role: "user", content: "audit" }],
        maxRetries: 0,
        openaiClient: mockClient,
      })
    ).rejects.toThrow(LLMNetworkError);

    const netEvents = telemetry.getEvents().filter((e) => e.name === "llm.network_error");
    expect(netEvents.length).toBe(1);
  });

  // ── 11. Provider failure → LLM_PROVIDER_ERROR ──────────────────────────────
  it("11. normalizes 500 / 503 provider errors to LLMProviderError (LLM_PROVIDER_ERROR)", async () => {
    const gateway = new LLMGateway(telemetry);
    const serverErr: any = new Error("Internal server error from provider");
    serverErr.status = 500;

    const mockClient = {
      chat: {
        completions: {
          create: jest.fn().mockRejectedValue(serverErr),
        },
      },
    } as any;

    await expect(
      gateway.call({
        stage: PipelineStages.REPAIR,
        messages: [{ role: "user", content: "repair" }],
        maxRetries: 0,
        openaiClient: mockClient,
      })
    ).rejects.toThrow(LLMProviderError);

    const provEvents = telemetry.getEvents().filter((e) => e.name === "llm.provider_error");
    expect(provEvents.length).toBe(1);
  });

  // ── 12. Retry bounded ──────────────────────────────────────────────────────
  it("12. executes bounded retries on retryable failures and respects maxRetries limit", async () => {
    const gateway = new LLMGateway(telemetry);
    const transientErr: any = new Error("Rate limit");
    transientErr.status = 429;

    const mockClient = {
      chat: {
        completions: {
          create: jest.fn().mockRejectedValue(transientErr),
        },
      },
    } as any;

    await expect(
      gateway.call({
        stage: PipelineStages.ROADMAP_PLANNING,
        messages: [{ role: "user", content: "roadmap" }],
        maxRetries: 2,
        retryDelayMs: 1, // fast unit test
        openaiClient: mockClient,
      })
    ).rejects.toThrow(LLMRetryExhaustedError);

    // Initial call + 2 retries = 3 calls total
    expect(mockClient.chat.completions.create).toHaveBeenCalledTimes(3);
    const retryEvents = telemetry.getEvents().filter((e) => e.name === "llm.retry");
    expect(retryEvents.length).toBe(2);
  });

  // ── 13. Retry exhaustion typed ─────────────────────────────────────────────
  it("13. throws LLMRetryExhaustedError wrapping last technical error upon exhaustion", async () => {
    const gateway = new LLMGateway(telemetry);
    const netErr: any = new Error("Connection reset");
    netErr.code = "ECONNRESET";

    const mockClient = {
      chat: {
        completions: {
          create: jest.fn().mockRejectedValue(netErr),
        },
      },
    } as any;

    try {
      await gateway.call({
        stage: PipelineStages.STATIC_REVIEW,
        messages: [{ role: "user", content: "review" }],
        maxRetries: 1,
        retryDelayMs: 1,
        openaiClient: mockClient,
      });
      fail("Should have thrown LLMRetryExhaustedError");
    } catch (err: any) {
      expect(err).toBeInstanceOf(LLMRetryExhaustedError);
      expect(err.code).toBe("LLM_RETRY_EXHAUSTED");
      expect(err.lastError).toBeInstanceOf(LLMNetworkError);
    }
  });

  // ── 14. REPOSITORY_RESOLVABLE → CONTINUE_INVESTIGATION (NOT terminal SUCCESS) ─
  it("14. ClarificationPolicy: REPOSITORY_RESOLVABLE yields CONTINUE_INVESTIGATION and NEVER terminal SUCCESS", () => {
    const decision = ClarificationPolicy.evaluate({
      category: "REPOSITORY_RESOLVABLE",
      reason: "Found matching source in src/auth/login.ts",
    });

    expect(decision.decision).toBe("CONTINUE_INVESTIGATION");
    expect(decision.requiresClarification).toBe(false);
    expect(decision.canClarify).toBe(false);
    expect(decision.clarification).toBeUndefined();
    // Critical: outcome must NOT be SUCCESS
    expect(decision.outcome).toBeUndefined();
    expect(decision.outcome).not.toBe("SUCCESS");

    const repoEvents = telemetry.getEvents().filter((e) => e.name === "clarification.repo_resolvable");
    expect(repoEvents.length).toBe(1);
  });

  // ── 15. USER_AMBIGUITY → ASK_USER (CLARIFICATION_NEEDED) ───────────────────
  it("15. ClarificationPolicy: USER_AMBIGUITY yields ASK_USER and CLARIFICATION_NEEDED", () => {
    const decision = ClarificationPolicy.evaluate({
      category: "USER_AMBIGUITY",
      question: "Which component should be deleted?",
      options: ["src/Button.tsx", "src/Modal.tsx"],
      reason: "Multiple ambiguous destructive targets exist",
    });

    expect(decision.decision).toBe("ASK_USER");
    expect(decision.outcome).toBe("CLARIFICATION_NEEDED");
    expect(decision.requiresClarification).toBe(true);
    expect(decision.canClarify).toBe(true);
    expect(decision.clarification?.question).toBe("Which component should be deleted?");
    expect(decision.clarification?.options).toEqual(["src/Button.tsx", "src/Modal.tsx"]);

    const ambiguityEvents = telemetry.getEvents().filter((e) => e.name === "clarification.user_ambiguity");
    expect(ambiguityEvents.length).toBe(1);
  });

  // ── 16. TECHNICAL_FAILURE → TECHNICAL_FAILURE (NEVER Clarification) ────────
  it("16. ClarificationPolicy: TECHNICAL_FAILURE NEVER yields clarification", () => {
    const technicalErr = new LLMTimeoutError("LLM call timed out after 60000ms");
    const decision = ClarificationPolicy.evaluate({
      category: "TECHNICAL_FAILURE",
      technicalError: technicalErr,
    });

    expect(decision.decision).toBe("TECHNICAL_FAILURE");
    expect(decision.outcome).toBe("TECHNICAL_FAILURE");
    expect(decision.requiresClarification).toBe(false);
    expect(decision.canClarify).toBe(false);
    expect(decision.clarification).toBeUndefined();
    expect(decision.technicalError).toBe(technicalErr);

    const techEvents = telemetry.getEvents().filter((e) => e.name === "clarification.technical_failure");
    expect(techEvents.length).toBe(1);
  });

  // ── 17. Telemetry emitted on success ───────────────────────────────────────
  it("17. emits structured telemetry events on successful LLM call", async () => {
    const gateway = new LLMGateway(telemetry);
    const mockClient = {
      chat: {
        completions: {
          create: jest.fn().mockResolvedValue({
            choices: [{ message: { content: "OK" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
        },
      },
    } as any;

    await gateway.call({
      stage: PipelineStages.CODE_CORRECTION,
      messages: [{ role: "user", content: "test" }],
      context: { runId: "run-101", projectId: "proj-1" },
      openaiClient: mockClient,
    });

    const callEvents = telemetry.getEvents().filter((e) => e.name === "llm.call");
    const latencyEvents = telemetry.getEvents().filter((e) => e.name === "llm.latency");
    const tokenInEvents = telemetry.getEvents().filter((e) => e.name === "llm.tokens_input");
    const tokenOutEvents = telemetry.getEvents().filter((e) => e.name === "llm.tokens_output");

    expect(callEvents.length).toBe(1);
    expect(callEvents[0].context.runId).toBe("run-101");
    expect(latencyEvents.length).toBe(1);
    expect(tokenInEvents[0].value).toBe(10);
    expect(tokenOutEvents[0].value).toBe(5);
  });

  // ── 18. Telemetry emitted on failure ───────────────────────────────────────
  it("18. emits structured telemetry events on LLM failures", async () => {
    const gateway = new LLMGateway(telemetry);
    const err: any = new Error("Provider service unavailable (503)");
    err.status = 503;

    const mockClient = {
      chat: {
        completions: {
          create: jest.fn().mockRejectedValue(err),
        },
      },
    } as any;

    await expect(
      gateway.call({
        stage: PipelineStages.FEATURE_VALIDATION,
        messages: [{ role: "user", content: "validate" }],
        maxRetries: 0,
        openaiClient: mockClient,
      })
    ).rejects.toThrow(LLMProviderError);

    const provErrors = telemetry.getEvents().filter((e) => e.name === "llm.provider_error");
    expect(provErrors.length).toBe(1);
  });

  // ── 19. Model resolution hook passes neutral default model without stage tiering ─
  it("19. passes the centralized route model to provider client invocation", async () => {
    const modelRouter = new ModelRouter({
      fastModel: "fast-test-model",
      standardModel: "standard-test-model",
      reasoningModel: "reasoning-test-model",
      fallbackModel: "fallback-test-model",
    });
    const gateway = new LLMGateway(telemetry, { modelRouter });
    const mockClient = {
      chat: {
        completions: {
          create: jest.fn().mockResolvedValue({
            choices: [{ message: { content: "text" }, finish_reason: "stop" }],
          }),
        },
      },
    } as any;

    await gateway.call({
      stage: PipelineStages.APPLICATION_SUPPORT,
      messages: [{ role: "user", content: "hi" }],
      openaiClient: mockClient,
    });

    expect(mockClient.chat.completions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "fast-test-model",
      }),
      expect.any(Object)
    );
  });

  // ── 20. Zero stage-dependent model routing in Checkpoint 1A ────────────────
  it("20. routes deterministically by PipelineStage without accepting a requested model", () => {
    const router = new ModelRouter({
      fastModel: "fast-test-model",
      standardModel: "standard-test-model",
      reasoningModel: "reasoning-test-model",
      fallbackModel: "fallback-test-model",
    });

    expect(router.route(PipelineStages.APPLICATION_SUPPORT).primaryModel).toBe("fast-test-model");
    expect(router.route(PipelineStages.REPOSITORY_REASONING).primaryModel).toBe("standard-test-model");
    expect(router.route(PipelineStages.CODE_GENERATION).primaryModel).toBe("reasoning-test-model");
  });

  // ── 21. Model self-report cannot establish deterministic completion ────────
  it("21. Invariant: MODEL PROPOSES. BACKEND VERIFIES. Preserves 5-state contract without fake authority helpers", () => {
    // 1. Verify locked five-state contract
    const validOutcomes: AgentOutcomeType[] = [
      "SUCCESS",
      "CLARIFICATION_NEEDED",
      "TECHNICAL_FAILURE",
      "POLICY_BLOCKED",
      "BUDGET_EXHAUSTED",
    ];
    expect(validOutcomes).toHaveLength(5);

    // 2. Invariant documentation string is intact
    expect(VERIFICATION_INVARIANT).toBe("MODEL PROPOSES. BACKEND VERIFIES.");

    // 3. Verify no assertBackendVerified helper exists to manufacture verification claims
    expect((gatewayModule as any).assertBackendVerified).toBeUndefined();
    expect((gatewayModule as any).BackendVerificationProvenance).toBeUndefined();
  });

  // ── 22. Embedding timeout/retry/error behavior ──────────────────────────────
  it("22. EmbeddingGateway handles timeouts, retries, and errors properly", async () => {
    const embedGateway = new EmbeddingGateway(telemetry);
    const netErr: any = new Error("Embedding connection dropped");
    netErr.code = "ECONNRESET";

    const mockClient = {
      embeddings: {
        create: jest.fn().mockRejectedValue(netErr),
      },
    } as any;

    await expect(
      embedGateway.embedQuery("search query", {
        maxRetries: 1,
        retryDelayMs: 1,
        openaiClient: mockClient,
      })
    ).rejects.toThrow(LLMRetryExhaustedError);

    expect(mockClient.embeddings.create).toHaveBeenCalledTimes(2);
    const retryEvents = telemetry.getEvents().filter((e) => e.name === "llm.retry");
    expect(retryEvents.length).toBe(1);
  });

  // ── 23. Embedding does NOT require finish_reason handling ──────────────────
  it("23. EmbeddingGateway returns vectors without requiring finish_reason or truncation checks", async () => {
    const embedGateway = new EmbeddingGateway(telemetry);
    const mockVector = [0.1, 0.2, 0.3, 0.4];
    const mockClient = {
      embeddings: {
        create: jest.fn().mockResolvedValue({
          data: [{ embedding: mockVector }],
          usage: { prompt_tokens: 8, total_tokens: 8 },
        }),
      },
    } as any;

    const result = await embedGateway.embedQuery("test embedding", {
      openaiClient: mockClient,
    });

    expect(result.data).toEqual(mockVector);
    expect(result.model).toBe("text-embedding-3-small");
    expect((result as any).finishReason).toBeUndefined(); // Finish reason is intentionally not part of embedding contract
  });

  it("24. callStructured fails before provider invocation without a deterministic validator", async () => {
    const gateway = new LLMGateway(telemetry);
    const create = jest.fn();

    await expect(
      gateway.callStructured({
        stage: PipelineStages.MANIFEST_GENERATION,
        messages: [{ role: "user", content: "manifest" }],
        // Deliberately bypasses the static contract to exercise runtime defense in depth.
        schema: { name: "ProviderSchemaOnly", schema: { type: "object" } } as any,
        openaiClient: { chat: { completions: { create } } } as any,
      })
    ).rejects.toThrow(LLMSchemaInvalidError);

    expect(create).not.toHaveBeenCalled();
  });

  it("25. structured business data is returned only after deterministic validation succeeds", async () => {
    const gateway = new LLMGateway(telemetry);
    const validator = jest.fn().mockReturnValue({ valid: true, data: { accepted: true } });
    const mockClient = {
      chat: {
        completions: {
          create: jest.fn().mockResolvedValue({
            choices: [{ message: { content: JSON.stringify({ accepted: true }) }, finish_reason: "stop" }],
          }),
        },
      },
    } as any;

    const result = await gateway.callStructured<{ accepted: boolean }>({
      stage: PipelineStages.MANIFEST_GENERATION,
      messages: [{ role: "user", content: "manifest" }],
      schema: { name: "Validated", validate: validator },
      openaiClient: mockClient,
    });

    expect(validator).toHaveBeenCalledWith({ accepted: true });
    expect(result.content).toEqual({ accepted: true });
  });

  it("26. retry configuration is finite, integral, non-negative, and hard bounded", async () => {
    const gateway = new LLMGateway(telemetry);
    const retryable: any = new Error("rate limit");
    retryable.status = 429;

    const run = async (maxRetries: number) => {
      telemetry.clear();
      const create = jest.fn().mockRejectedValue(retryable);
      await expect(
        gateway.call({
          stage: PipelineStages.REPAIR,
          messages: [{ role: "user", content: "repair" }],
          maxRetries,
          retryDelayMs: 0,
          openaiClient: { chat: { completions: { create } } } as any,
        })
      ).rejects.toBeInstanceOf(LLMError);
      return create.mock.calls.length;
    };

    expect(await run(Infinity)).toBe(3); // invalid input normalizes to the finite default of 2 retries
    expect(await run(-10)).toBe(1);
    expect(await run(2.9)).toBe(3);
    expect(await run(999)).toBe(MAX_GATEWAY_RETRIES + 1);
  });

  it("27. timeout and retry-delay configuration cannot create non-finite timers", async () => {
    const gateway = new LLMGateway(telemetry);
    const create = jest.fn().mockResolvedValue({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
    });

    await gateway.call({
      stage: PipelineStages.APPLICATION_SUPPORT,
      messages: [{ role: "user", content: "hello" }],
      timeoutMs: Infinity,
      retryDelayMs: Number.NaN,
      openaiClient: { chat: { completions: { create } } } as any,
    });

    expect(create).toHaveBeenCalledTimes(1);
  });

  it("28. disables SDK retries on every provider request", async () => {
    const gateway = new LLMGateway(telemetry);
    const create = jest.fn().mockResolvedValue({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
    });

    await gateway.call({
      stage: PipelineStages.APPLICATION_SUPPORT,
      messages: [{ role: "user", content: "hello" }],
      openaiClient: { chat: { completions: { create } } } as any,
    });

    expect(create).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ maxRetries: 0 }));
  });

  it("29. normalizes OpenAI SDK connection and timeout errors", async () => {
    const gateway = new LLMGateway(telemetry);

    const connectionClient = {
      chat: { completions: { create: jest.fn().mockRejectedValue(new APIConnectionError({ message: "Connection error." })) } },
    } as any;
    await expect(
      gateway.call({
        stage: PipelineStages.REPOSITORY_REASONING,
        messages: [{ role: "user", content: "inspect" }],
        maxRetries: 0,
        openaiClient: connectionClient,
      })
    ).rejects.toThrow(LLMNetworkError);

    const timeoutClient = {
      chat: { completions: { create: jest.fn().mockRejectedValue(new APIConnectionTimeoutError({ message: "Request timed out." })) } },
    } as any;
    await expect(
      gateway.call({
        stage: PipelineStages.REPOSITORY_REASONING,
        messages: [{ role: "user", content: "inspect" }],
        maxRetries: 0,
        openaiClient: timeoutClient,
      })
    ).rejects.toThrow(LLMTimeoutError);
  });

  it("30. gateway timer aborts normalize to LLMTimeoutError", async () => {
    const gateway = new LLMGateway(telemetry);
    const create = jest.fn((_body: any, requestOptions: any) =>
      new Promise((_resolve, reject) => {
        requestOptions.signal.addEventListener("abort", () => reject(new APIUserAbortError()));
      })
    );

    await expect(
      gateway.call({
        stage: PipelineStages.REPOSITORY_REASONING,
        messages: [{ role: "user", content: "inspect" }],
        timeoutMs: 1,
        maxRetries: 0,
        openaiClient: { chat: { completions: { create } } } as any,
      })
    ).rejects.toThrow(LLMTimeoutError);
  });

  it("31. provider 5xx retries remain bounded with accurate retry telemetry", async () => {
    const gateway = new LLMGateway(telemetry);
    const providerError: any = new Error("service unavailable");
    providerError.status = 503;
    const create = jest.fn().mockRejectedValue(providerError);

    await expect(
      gateway.call({
        stage: PipelineStages.REPAIR,
        messages: [{ role: "user", content: "repair" }],
        maxRetries: 2,
        retryDelayMs: 0,
        openaiClient: { chat: { completions: { create } } } as any,
      })
    ).rejects.toThrow(LLMRetryExhaustedError);

    expect(create).toHaveBeenCalledTimes(3);
    expect(telemetry.getEvents().filter((event) => event.name === "llm.retry")).toHaveLength(2);
    expect(telemetry.getEvents().filter((event) => event.name === "llm.latency")).toHaveLength(3);
  });

  it.each([undefined, "mystery_reason"])(
    "32. missing or unknown finish_reason %p fails closed",
    async (finishReason) => {
      const gateway = new LLMGateway(telemetry);
      const mockClient = {
        chat: {
          completions: {
            create: jest.fn().mockResolvedValue({
              choices: [{ message: { content: "business data" }, finish_reason: finishReason }],
            }),
          },
        },
      } as any;

      await expect(
        gateway.call({
          stage: PipelineStages.CODE_GENERATION,
          messages: [{ role: "user", content: "generate" }],
          maxRetries: 0,
          openaiClient: mockClient,
        })
      ).rejects.toThrow(LLMProviderError);
    }
  );

  it("33. token telemetry remains accurate when the provider returns usage", async () => {
    const gateway = new LLMGateway(telemetry);
    await gateway.call({
      stage: PipelineStages.CODE_GENERATION,
      messages: [{ role: "user", content: "generate" }],
      openaiClient: {
        chat: {
          completions: {
            create: jest.fn().mockResolvedValue({
              choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
              usage: { prompt_tokens: 7, completion_tokens: 11, total_tokens: 18 },
            }),
          },
        },
      } as any,
    });

    expect(telemetry.getEvents().filter((event) => event.name === "llm.tokens_input").map((event) => event.value)).toEqual([7]);
    expect(telemetry.getEvents().filter((event) => event.name === "llm.tokens_output").map((event) => event.value)).toEqual([11]);
  });

  it("34. telemetry retention evicts oldest records while listeners receive every event", () => {
    const listener = jest.fn();
    const unsubscribe = telemetry.subscribe(listener);
    const emitted = LLMTelemetry.MAX_RECORDED_EVENTS + 5;

    for (let index = 0; index < emitted; index++) {
      telemetry.emit("llm.call", { attempt: index + 1 });
    }

    unsubscribe();
    expect(listener).toHaveBeenCalledTimes(emitted);
    expect(telemetry.getEvents()).toHaveLength(LLMTelemetry.MAX_RECORDED_EVENTS);
    expect(telemetry.getEvents()[0].context.attempt).toBe(6);
  });

  it.each(["tool_calls", "function_call"])(
    "35. generic calls fail closed for finish_reason=%s",
    async (finishReason) => {
      const gateway = new LLMGateway(telemetry);
      const create = jest.fn().mockResolvedValue({
        choices: [{ message: { content: "ordinary-looking content" }, finish_reason: finishReason }],
      });

      await expect(
        gateway.call({
          stage: PipelineStages.CODE_GENERATION,
          messages: [{ role: "user", content: "generate" }],
          maxRetries: 0,
          openaiClient: { chat: { completions: { create } } } as any,
        })
      ).rejects.toThrow(LLMProviderError);
    }
  );

  it.each(["tool_calls", "function_call"])(
    "36. empty generic content cannot succeed for finish_reason=%s",
    async (finishReason) => {
      const gateway = new LLMGateway(telemetry);
      await expect(
        gateway.call({
          stage: PipelineStages.CODE_GENERATION,
          messages: [{ role: "user", content: "generate" }],
          maxRetries: 0,
          openaiClient: {
            chat: {
              completions: {
                create: jest.fn().mockResolvedValue({
                  choices: [{ message: { content: "" }, finish_reason: finishReason }],
                }),
              },
            },
          } as any,
        })
      ).rejects.toThrow(LLMProviderError);
    }
  );

  it("37. finish_reason=stop remains a successful generic completion", async () => {
    const gateway = new LLMGateway(telemetry);
    const result = await gateway.call({
      stage: PipelineStages.CODE_GENERATION,
      messages: [{ role: "user", content: "generate" }],
      openaiClient: {
        chat: {
          completions: {
            create: jest.fn().mockResolvedValue({
              choices: [{ message: { content: "completed text" }, finish_reason: "stop" }],
            }),
          },
        },
      } as any,
    });

    expect(result.content).toBe("completed text");
    expect(result.finishReason).toBe("stop");
  });

  it("38. validator exceptions fail closed with one schema-failure event", async () => {
    const gateway = new LLMGateway(telemetry);
    await expect(
      gateway.callStructured({
        stage: PipelineStages.MANIFEST_GENERATION,
        messages: [{ role: "user", content: "manifest" }],
        schema: {
          name: "ThrowingValidator",
          validate: () => {
            throw new Error("validator failure");
          },
        },
        maxRetries: 0,
        openaiClient: {
          chat: {
            completions: {
              create: jest.fn().mockResolvedValue({
                choices: [{ message: { content: "{}" }, finish_reason: "stop" }],
              }),
            },
          },
        } as any,
      })
    ).rejects.toThrow(LLMSchemaInvalidError);

    expect(telemetry.getEvents().filter((event) => event.name === "llm.schema_failure")).toHaveLength(1);
  });

  it("39. zero input and output token usage are retained in telemetry", async () => {
    const gateway = new LLMGateway(telemetry);
    await gateway.call({
      stage: PipelineStages.CODE_GENERATION,
      messages: [{ role: "user", content: "generate" }],
      openaiClient: {
        chat: {
          completions: {
            create: jest.fn().mockResolvedValue({
              choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
              usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            }),
          },
        },
      } as any,
    });

    expect(telemetry.getEvents().filter((event) => event.name === "llm.tokens_input").map((event) => event.value)).toEqual([0]);
    expect(telemetry.getEvents().filter((event) => event.name === "llm.tokens_output").map((event) => event.value)).toEqual([0]);
  });

  it("40. typed tool path exposes only declared, deterministically validated proposals", async () => {
    const gateway = new LLMGateway(telemetry);
    const validator = jest.fn((name: string, args: unknown) => ({
      valid: name === "lookup" && Boolean(args && typeof args === "object" && (args as any).query === "term"),
      data: args,
    }));
    const result = await gateway.callWithTools({
      stage: PipelineStages.APPLICATION_SUPPORT,
      messages: [{ role: "user", content: "lookup" }],
      tools: [{ type: "function", function: { name: "lookup", description: "Lookup", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } } }],
      validateToolCall: validator,
      maxRetries: 0,
      openaiClient: { chat: { completions: { create: jest.fn().mockResolvedValue({ choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "lookup", arguments: '{"query":"term"}' } }] } }] }) } } } as any,
    });

    expect(result.content).toEqual({ type: "tool_calls", text: null, toolCalls: [{ id: "call-1", name: "lookup", arguments: { query: "term" } }] });
    expect(validator).toHaveBeenCalledWith("lookup", { query: "term" });
  });

  it("41. typed tool path rejects malformed arguments", async () => {
    const gateway = new LLMGateway(telemetry);
    await expect(gateway.callWithTools({
      stage: PipelineStages.APPLICATION_SUPPORT,
      messages: [{ role: "user", content: "lookup" }],
      tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
      validateToolCall: () => ({ valid: true }),
      maxRetries: 0,
      openaiClient: { chat: { completions: { create: jest.fn().mockResolvedValue({ choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "lookup", arguments: "{" } }] } }] }) } } } as any,
    })).rejects.toThrow(LLMInvalidJsonError);
  });

  it("42. typed tool path rejects undeclared tool names before caller execution", async () => {
    const gateway = new LLMGateway(telemetry);
    await expect(gateway.callWithTools({
      stage: PipelineStages.APPLICATION_SUPPORT,
      messages: [{ role: "user", content: "lookup" }],
      tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
      validateToolCall: () => ({ valid: true }),
      maxRetries: 0,
      openaiClient: { chat: { completions: { create: jest.fn().mockResolvedValue({ choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "delete_everything", arguments: "{}" } }] } }] }) } } } as any,
    })).rejects.toThrow(LLMSchemaInvalidError);
  });

  it("43. typed tool path rejects tool payloads mislabeled as a text completion", async () => {
    const gateway = new LLMGateway(telemetry);
    await expect(gateway.callWithTools({
      stage: PipelineStages.APPLICATION_SUPPORT,
      messages: [{ role: "user", content: "lookup" }],
      tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
      validateToolCall: () => ({ valid: true }),
      maxRetries: 0,
      openaiClient: { chat: { completions: { create: jest.fn().mockResolvedValue({ choices: [{ finish_reason: "stop", message: { content: "", tool_calls: [{ id: "call-1", type: "function", function: { name: "lookup", arguments: "{}" } }] } }] }) } } } as any,
    })).rejects.toThrow(LLMSchemaInvalidError);
  });
});

import * as gatewayModule from "../index";
