import OpenAI from "openai";
import { LLMGateway } from "../LLMGateway";
import { ModelRouter } from "../ModelRouter";
import { PipelineStages } from "../PipelineStage";

function clientWithCreate(create: jest.Mock): OpenAI {
  return { chat: { completions: { create } } } as unknown as OpenAI;
}

function success(content: string) {
  return {
    id: "response-1",
    model: "gpt-6.1-sol",
    choices: [{ message: { role: "assistant", content, refusal: null }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  };
}

describe("task-appropriate production model routing", () => {
  const originalArchitectureModel = process.env.OPENAI_ARCHITECTURE_MODEL;

  afterEach(() => {
    if (originalArchitectureModel === undefined) delete process.env.OPENAI_ARCHITECTURE_MODEL;
    else process.env.OPENAI_ARCHITECTURE_MODEL = originalArchitectureModel;
  });

  test("selects the exact model and reasoning effort for every existing target operation", () => {
    delete process.env.OPENAI_ARCHITECTURE_MODEL;
    const router = new ModelRouter();
    const cases = [
      [PipelineStages.REQUIREMENTS_GENERATION, "gpt-6.1-sol", "high"],
      [PipelineStages.REQUIREMENTS_REVISION, "gpt-6.1-sol", "medium"],
      [PipelineStages.DOCUMENTATION_GENERATION, "gpt-6.1-sol", "medium"],
      [PipelineStages.DOCUMENTATION_REVISION, "gpt-6.1-sol", "medium"],
      [PipelineStages.ARCHITECTURE_GENERATION, "gpt-6-astra", "high"],
      [PipelineStages.ARCHITECTURE_REVISION, "gpt-6-astra", "high"],
      [PipelineStages.IMPLEMENTATION_PLANNING, "gpt-6.1-sol", "high"],
      [PipelineStages.CODE_GENERATION, "gpt-6.1-sol", "high"],
    ] as const;

    for (const [stage, model, reasoningEffort] of cases) {
      expect(router.route(stage)).toMatchObject({
        primaryModel: model,
        reasoningEffort,
        fallbackModels: [],
        defaultMaxOutputTokens: 32_000,
        maxOutputTokens: 32_000,
      });
    }
  });

  test("Architecture defaults to Astra and accepts only the server-side Sol comparison switch", () => {
    delete process.env.OPENAI_ARCHITECTURE_MODEL;
    expect(new ModelRouter().route(PipelineStages.ARCHITECTURE_GENERATION).primaryModel).toBe("gpt-6-astra");

    process.env.OPENAI_ARCHITECTURE_MODEL = "gpt-6.1-sol";
    const comparison = new ModelRouter();
    expect(comparison.route(PipelineStages.ARCHITECTURE_GENERATION).primaryModel).toBe("gpt-6.1-sol");
    expect(comparison.route(PipelineStages.ARCHITECTURE_REVISION).primaryModel).toBe("gpt-6.1-sol");

    process.env.OPENAI_ARCHITECTURE_MODEL = "gpt-4o";
    expect(() => new ModelRouter()).toThrow(/Unsupported Architecture model configuration/);
  });

  test("uses reasoning-compatible Chat Completions parameters and records the immutable route", async () => {
    const create = jest.fn().mockResolvedValue(success('{"ok":true}'));
    const gateway = new LLMGateway(undefined, { modelRouter: new ModelRouter() });
    const result = await gateway.callStructured<{ ok: boolean }>({
      stage: PipelineStages.REQUIREMENTS_REVISION,
      messages: [{ role: "user", content: "Return JSON" }],
      schema: {
        name: "routing_test",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
        },
        validate: (value) => value?.ok === true ? { valid: true, data: value } : { valid: false },
      },
      maxTokens: 32_000,
      openaiClient: clientWithCreate(create),
    });

    expect(create.mock.calls[0][0]).toMatchObject({
      model: "gpt-6.1-sol",
      reasoning_effort: "medium",
      max_completion_tokens: 32_000,
    });
    expect(create.mock.calls[0][0]).not.toHaveProperty("temperature");
    expect(create.mock.calls[0][0]).not.toHaveProperty("max_tokens");
    expect(result.routing).toEqual({
      routeId: "REQUIREMENTS_REVISION:REASONING",
      model: "gpt-6.1-sol",
      reasoningEffort: "medium",
      maxOutputTokens: 32_000,
    });
    expect(result.providerAttempts?.[0]).toMatchObject({
      routeId: "REQUIREMENTS_REVISION:REASONING",
      reasoningEffort: "medium",
      maxOutputTokens: 32_000,
    });
  });

  test("provider unavailability retries the selected model and never falls back to GPT-4", async () => {
    const unavailable = Object.assign(new Error("provider unavailable"), { status: 503 });
    const create = jest.fn().mockRejectedValue(unavailable);
    const gateway = new LLMGateway(undefined, { modelRouter: new ModelRouter() });

    await expect(gateway.call({
      stage: PipelineStages.ARCHITECTURE_GENERATION,
      messages: [{ role: "user", content: "Architecture" }],
      maxRetries: 1,
      retryDelayMs: 0,
      openaiClient: clientWithCreate(create),
    })).rejects.toThrow();

    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls.map((call) => call[0].model)).toEqual(["gpt-6-astra", "gpt-6-astra"]);
  });

  test("non-reasoning stages preserve legacy temperature and max_tokens parameters", async () => {
    const create = jest.fn().mockResolvedValue({
      id: "resp-std",
      model: "gpt-4o",
      choices: [{ message: { role: "assistant", content: "standard response" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
    });
    const gateway = new LLMGateway(undefined, { modelRouter: new ModelRouter() });

    await gateway.call({
      stage: PipelineStages.APPLICATION_SUPPORT,
      messages: [{ role: "user", content: "Help" }],
      maxTokens: 1000,
      temperature: 0.3,
      openaiClient: clientWithCreate(create),
    });

    const callPayload = create.mock.calls[0][0];
    expect(callPayload.temperature).toBe(0.3);
    expect(callPayload.max_tokens).toBe(1000);
    expect(callPayload).not.toHaveProperty("reasoning_effort");
    expect(callPayload).not.toHaveProperty("max_completion_tokens");
  });

  test("Code generation routes to GPT-6.1 Sol with high reasoning effort and no fallback", async () => {
    const create = jest.fn().mockResolvedValue(success('{"changes":[]}'));
    const gateway = new LLMGateway(undefined, { modelRouter: new ModelRouter() });
    const result = await gateway.call({
      stage: PipelineStages.CODE_GENERATION,
      messages: [{ role: "user", content: "Generate code" }],
      maxTokens: 32_000,
      openaiClient: clientWithCreate(create),
    });

    expect(create.mock.calls[0][0]).toMatchObject({
      model: "gpt-6.1-sol",
      reasoning_effort: "high",
      max_completion_tokens: 32_000,
    });
    expect(create.mock.calls[0][0]).not.toHaveProperty("temperature");
    expect(result.routing?.model).toBe("gpt-6.1-sol");
    expect(result.routing?.reasoningEffort).toBe("high");
  });
});
