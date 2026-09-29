import OpenAI from "openai";
import { LLMGateway } from "../LLMGateway";
import { LLMContentFilterError, LLMError, LLMRefusalError } from "../LLMError";
import { PipelineStages } from "../PipelineStage";

function clientWithResponses(
  responses: OpenAI.Chat.Completions.ChatCompletion[],
): { client: OpenAI; create: jest.Mock } {
  const create = jest.fn();
  for (const response of responses) create.mockResolvedValueOnce(response);
  return {
    client: { chat: { completions: { create } } } as unknown as OpenAI,
    create,
  };
}

function response(input: {
  content?: string | null;
  refusal?: string | null;
  finishReason?: OpenAI.Chat.Completions.ChatCompletion.Choice["finish_reason"];
  id?: string;
  requestId?: string;
  model?: string;
  usage?: OpenAI.Completions.CompletionUsage | null;
}): OpenAI.Chat.Completions.ChatCompletion {
  const result: OpenAI.Chat.Completions.ChatCompletion & { _request_id?: string } = {
    id: input.id ?? "chatcmpl-requirements",
    object: "chat.completion",
    created: 0,
    model: input.model ?? "gpt-4o",
    choices: [{
      index: 0,
      logprobs: null,
      finish_reason: input.finishReason ?? "stop",
      message: {
        role: "assistant",
        content: input.content ?? null,
        refusal: input.refusal ?? null,
      },
    }],
    ...(input.usage === null ? {} : {
      usage: input.usage ?? { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
  };
  if (input.requestId) result._request_id = input.requestId;
  return result;
}

describe("Requirements gateway metadata and correction", () => {
  test("exposes successful provider attempt count", async () => {
    const { client } = clientWithResponses([response({ content: '{"ok":true}' })]);
    const result = await new LLMGateway().callStructured({
      stage: PipelineStages.ROADMAP_PLANNING,
      messages: [{ role: "user", content: "requirements" }],
      schema: { name: "requirements", validate: (parsed) => ({ valid: true, data: parsed }) },
      openaiClient: client,
    });
    expect(result.attemptCount).toBe(1);
    expect(result.providerAttempts).toEqual([expect.objectContaining({
      attemptNumber: 1,
      kind: "initial",
      providerResponseId: "chatcmpl-requirements",
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      usageSource: "provider",
    })]);
  });

  test("normalizes refusal and content filtering distinctly", async () => {
    const refused = clientWithResponses([response({ refusal: "Cannot comply." })]);
    await expect(new LLMGateway().callStructured({
      stage: PipelineStages.ROADMAP_PLANNING,
      messages: [{ role: "user", content: "requirements" }],
      schema: { name: "requirements", validate: (parsed) => ({ valid: true, data: parsed }) },
      maxRetries: 0,
      openaiClient: refused.client,
    })).rejects.toBeInstanceOf(LLMRefusalError);

    const filtered = clientWithResponses([response({ content: "", finishReason: "content_filter" })]);
    await expect(new LLMGateway().callStructured({
      stage: PipelineStages.ROADMAP_PLANNING,
      messages: [{ role: "user", content: "requirements" }],
      schema: { name: "requirements", validate: (parsed) => ({ valid: true, data: parsed }) },
      maxRetries: 0,
      openaiClient: filtered.client,
    })).rejects.toBeInstanceOf(LLMContentFilterError);
  });

  test("performs at most one caller-specific structured repair", async () => {
    const { client, create } = clientWithResponses([
      response({
        content: '{"ok":false}',
        id: "chatcmpl-first",
        requestId: "req-first",
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      }),
      response({
        content: '{"ok":true}',
        id: "chatcmpl-repair",
        requestId: "req-repair",
        usage: { prompt_tokens: 110, completion_tokens: 60, total_tokens: 170 },
      }),
    ]);
    const result = await new LLMGateway().callStructured<{ ok: boolean }>({
      stage: PipelineStages.ROADMAP_PLANNING,
      messages: [{ role: "user", content: "requirements" }],
      schema: {
        name: "requirements",
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
        },
        validate: (parsed) => parsed?.ok === true
          ? { valid: true, data: { ok: true } }
          : { valid: false, errors: ["ok must be true"] },
      },
      structuredRepair: { instructions: "Return the complete corrected Requirements JSON." },
      maxRetries: 1,
      retryDelayMs: 0,
      openaiClient: client,
    });
    expect(result.content).toEqual({ ok: true });
    expect(result.attemptCount).toBe(2);
    expect(result.providerAttempts).toEqual([
      expect.objectContaining({
        attemptNumber: 1,
        kind: "initial",
        providerResponseId: "chatcmpl-first",
        providerRequestId: "req-first",
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
      }),
      expect.objectContaining({
        attemptNumber: 2,
        kind: "structured_repair",
        providerResponseId: "chatcmpl-repair",
        providerRequestId: "req-repair",
        promptTokens: 110,
        completionTokens: 60,
        totalTokens: 170,
      }),
    ]);
    expect(create).toHaveBeenCalledTimes(2);
    const secondRequest = create.mock.calls[1][0] as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
    expect(JSON.stringify(secondRequest.messages)).toContain("complete corrected Requirements JSON");
    expect(JSON.stringify(secondRequest.messages)).not.toContain("semantic code changes");
  });

  test("records ordered transport retry metadata from the actual gateway sequence", async () => {
    const networkError = Object.assign(new Error("network error"), { code: "ECONNRESET" });
    const create = jest.fn()
      .mockRejectedValueOnce(networkError)
      .mockResolvedValueOnce(response({
        content: '{"ok":true}',
        id: "chatcmpl-after-transport-retry",
        requestId: "req-after-transport-retry",
        finishReason: "stop",
        usage: { prompt_tokens: 21, completion_tokens: 8, total_tokens: 29 },
      }));
    const client = { chat: { completions: { create } } } as unknown as OpenAI;

    const result = await new LLMGateway().callStructured<{ ok: boolean }>({
      stage: PipelineStages.ROADMAP_PLANNING,
      messages: [{ role: "user", content: "requirements" }],
      schema: { name: "requirements", validate: (parsed) => ({ valid: true, data: parsed as { ok: boolean } }) },
      maxRetries: 1,
      retryDelayMs: 0,
      openaiClient: client,
    });

    expect(result.providerAttempts).toEqual([
      expect.objectContaining({
        attemptNumber: 1,
        kind: "initial",
        providerRequestId: null,
        providerResponseId: null,
        finishReason: null,
        usageSource: "unavailable",
        latencyMs: expect.any(Number),
      }),
      expect.objectContaining({
        attemptNumber: 2,
        kind: "transport_retry",
        providerRequestId: "req-after-transport-retry",
        providerResponseId: "chatcmpl-after-transport-retry",
        finishReason: "stop",
        promptTokens: 21,
        completionTokens: 8,
        totalTokens: 29,
        usageSource: "provider",
        latencyMs: expect.any(Number),
      }),
    ]);
    expect(create).toHaveBeenCalledTimes(2);
  });

  test("preserves sanitized provider attempts when structured repair also fails", async () => {
    const { client, create } = clientWithResponses([
      response({
        content: '{"ok":false,"raw":"FIRST_RAW_OUTPUT"}',
        id: "chatcmpl-failed-first",
        requestId: "req-failed-first",
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      }),
      response({
        content: '{"ok":false,"raw":"SECOND_RAW_OUTPUT"}',
        id: "chatcmpl-failed-repair",
        requestId: "req-failed-repair",
        usage: { prompt_tokens: 110, completion_tokens: 60, total_tokens: 170 },
      }),
    ]);

    const thrown = await new LLMGateway().callStructured<{ ok: boolean }>({
      stage: PipelineStages.ROADMAP_PLANNING,
      messages: [{ role: "user", content: "requirements" }],
      schema: {
        name: "requirements",
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
        },
        validate: (parsed) => parsed?.ok === true
          ? { valid: true, data: { ok: true } }
          : { valid: false, errors: ["ok must be true"] },
      },
      structuredRepair: { instructions: "Return the corrected object." },
      maxRetries: 1,
      retryDelayMs: 0,
      openaiClient: client,
    }).then(() => null, (error: unknown) => error);

    expect(thrown).toBeInstanceOf(LLMError);
    const llmError = thrown as LLMError;
    expect(llmError.providerAttempts).toEqual([
      expect.objectContaining({
        attemptNumber: 1,
        kind: "initial",
        providerResponseId: "chatcmpl-failed-first",
        providerRequestId: "req-failed-first",
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
      }),
      expect.objectContaining({
        attemptNumber: 2,
        kind: "structured_repair",
        providerResponseId: "chatcmpl-failed-repair",
        providerRequestId: "req-failed-repair",
        promptTokens: 110,
        completionTokens: 60,
        totalTokens: 170,
      }),
    ]);
    expect(JSON.stringify(llmError.providerAttempts)).not.toContain("RAW_OUTPUT");
    expect(create).toHaveBeenCalledTimes(2);
  });
});
