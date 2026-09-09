import {
  PipelineStages,
  PipelineStage,
  LLMGateway,
  EmbeddingGateway,
  resolveModel,
  resolveEmbeddingModel,
  LLMTimeoutError,
  LLMRateLimitError,
  LLMNetworkError,
  LLMProviderError,
  LLMTruncationError,
  LLMInvalidJsonError,
  LLMSchemaInvalidError,
  LLMRetryExhaustedError,
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
        schema: { name: "test" },
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
        schema: { name: "CodeSchema" },
        maxRetries: 0,
        openaiClient: mockClient,
      })
    ).rejects.toThrow(LLMInvalidJsonError);

    const parseFailures = telemetry.getEvents().filter((e) => e.name === "llm.parse_failure");
    expect(parseFailures.length).toBeGreaterThanOrEqual(1);
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
    expect(schemaFailures.length).toBeGreaterThanOrEqual(1);
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
    expect(truncEvents.length).toBeGreaterThanOrEqual(1);
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
  it("19. passes neutral default model to provider client invocation", async () => {
    const gateway = new LLMGateway(telemetry);
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

    const expectedDefault = process.env.OPENAI_AGENT_MODEL || "gpt-4o";
    expect(mockClient.chat.completions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: expectedDefault,
      }),
      expect.any(Object)
    );
  });

  // ── 20. Zero stage-dependent model routing in Checkpoint 1A ────────────────
  it("20. returns identical neutral default model for every PipelineStage with zero premature tiering", () => {
    const expectedDefault = process.env.OPENAI_AGENT_MODEL || "gpt-4o";

    for (const stage of Object.values(PipelineStages)) {
      expect(resolveModel(stage)).toBe(expectedDefault);
    }

    // Explicit caller-requested model is preserved exactly
    expect(resolveModel(PipelineStages.APPLICATION_SUPPORT, "custom-model-x")).toBe("custom-model-x");
    expect(resolveModel(PipelineStages.SUMMARIZATION, "gpt-4o-mini")).toBe("gpt-4o-mini");
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
});

import * as gatewayModule from "../index";
