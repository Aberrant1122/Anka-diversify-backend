import OpenAI from "openai";
import { getOpenAI } from "../shared/utils";
import { PipelineStage, PipelineStages, isValidPipelineStage } from "./PipelineStage";
import {
  LLMError,
  LLMTimeoutError,
  LLMRateLimitError,
  LLMNetworkError,
  LLMProviderError,
  LLMTruncationError,
  LLMInvalidJsonError,
  LLMSchemaInvalidError,
  LLMRetryExhaustedError,
} from "./LLMError";
import { LLMTelemetry, LLMTelemetryContext } from "./LLMTelemetry";

/**
 * Centralized Model Resolution Hook.
 * Checkpoint 1A invariant: Production model behavior remains unchanged.
 */
export function resolveModel(_stage: PipelineStage, requestedModel?: string): string {
  if (requestedModel && requestedModel.trim()) {
    return requestedModel.trim();
  }

  return process.env.OPENAI_AGENT_MODEL || "gpt-4o";
}

export interface LLMCallContext {
  runId?: string;
  projectId?: string;
  repositoryId?: string;
}

export interface LLMBaseCallOptions {
  stage: PipelineStage;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  context?: LLMCallContext;
  openaiClient?: OpenAI;
}

export interface LLMTextCallOptions extends LLMBaseCallOptions {
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  tools?: OpenAI.Chat.Completions.ChatCompletionTool[];
  toolChoice?: OpenAI.Chat.Completions.ChatCompletionToolChoiceOption;
}

export interface LLMStructuredSchema<T = any> {
  name: string;
  description?: string;
  schema?: Record<string, any>;
  strict?: boolean;
  validate?: (parsed: any) => { valid: boolean; errors?: string[]; data?: T };
}

export interface LLMStructuredCallOptions<T = any> extends LLMBaseCallOptions {
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  schema: LLMStructuredSchema<T>;
}

export interface LLMCallResult<T = string> {
  content: T;
  rawResponse: OpenAI.Chat.Completions.ChatCompletion;
  finishReason: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  latencyMs: number;
  model: string;
  stage: PipelineStage;
}

export class LLMGateway {
  private static instance: LLMGateway | null = null;
  private telemetry: LLMTelemetry;

  constructor(telemetry?: LLMTelemetry) {
    this.telemetry = telemetry || LLMTelemetry.getInstance();
  }

  public static getInstance(): LLMGateway {
    if (!LLMGateway.instance) {
      LLMGateway.instance = new LLMGateway();
    }
    return LLMGateway.instance;
  }

  /**
   * Primary entry point for text/chat generative calls.
   */
  public async call(options: LLMTextCallOptions): Promise<LLMCallResult<string>> {
    this.assertValidStage(options.stage);
    return this.executeWithRetry<string>(options, false);
  }

  /**
   * Primary entry point for schema-constrained structured output generation.
   */
  public async callStructured<T = any>(options: LLMStructuredCallOptions<T>): Promise<LLMCallResult<T>> {
    this.assertValidStage(options.stage);
    if (!options.schema || typeof options.schema !== "object") {
      throw new LLMSchemaInvalidError("Schema configuration is required for callStructured", {
        stage: options.stage,
      });
    }
    return this.executeWithRetry<T>(options, true);
  }

  private assertValidStage(stage: PipelineStage): void {
    if (!stage || !isValidPipelineStage(stage)) {
      throw new Error(
        `[LLMGateway] Invariant Violation: A valid PipelineStage is strictly required for every gateway call. Received: "${stage}"`
      );
    }
  }

  private async executeWithRetry<T>(
    options: LLMTextCallOptions | LLMStructuredCallOptions<any>,
    isStructured: boolean
  ): Promise<LLMCallResult<T>> {
    const stage = options.stage;
    const model = resolveModel(stage, options.model);
    const maxRetries = typeof options.maxRetries === "number" ? Math.max(0, options.maxRetries) : 2;
    const timeoutMs = typeof options.timeoutMs === "number" ? options.timeoutMs : 60000;
    const retryDelayMs = typeof options.retryDelayMs === "number" ? options.retryDelayMs : 250;
    const client = options.openaiClient || getOpenAI();

    let lastError: LLMError | undefined;

    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      const telemetryContext: LLMTelemetryContext = {
        ...options.context,
        stage,
        model,
        attempt,
      };

      this.telemetry.emit("llm.call", telemetryContext);
      const startTime = Date.now();

      try {
        const result = await this.executeSingleAttempt<T>(
          client,
          options,
          model,
          stage,
          timeoutMs,
          isStructured,
          startTime,
          telemetryContext
        );
        return result;
      } catch (err: any) {
        lastError = this.normalizeError(err, stage, model, attempt, maxRetries);
        const duration = Date.now() - startTime;
        this.telemetry.emit("llm.latency", telemetryContext, duration);

        this.recordErrorTelemetry(lastError, telemetryContext);

        const isLastAttempt = attempt >= maxRetries + 1;
        if (isLastAttempt || !(lastError as LLMError).isRetryable) {
          if (attempt > 1 && isLastAttempt) {
            throw new LLMRetryExhaustedError(
              `LLM call failed after ${attempt} attempts: ${lastError.message}`,
              lastError,
              { stage, model, attempt, maxRetries }
            );
          }
          throw lastError;
        }

        this.telemetry.emit("llm.retry", telemetryContext, attempt);
        if (retryDelayMs > 0) {
          const delay = retryDelayMs * Math.pow(1.5, attempt - 1);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError || new LLMProviderError("LLM invocation failed unexpectedly", { stage, model });
  }

  private async executeSingleAttempt<T>(
    client: OpenAI,
    options: LLMTextCallOptions | LLMStructuredCallOptions<any>,
    model: string,
    stage: PipelineStage,
    timeoutMs: number,
    isStructured: boolean,
    startTime: number,
    telemetryContext: LLMTelemetryContext
  ): Promise<LLMCallResult<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const requestPayload: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
        model,
        messages: options.messages,
        temperature: typeof options.temperature === "number" ? options.temperature : 0.2,
      };

      if (typeof options.maxTokens === "number") {
        requestPayload.max_tokens = options.maxTokens;
      }

      const textOptions = options as LLMTextCallOptions;
      if (textOptions.tools) {
        requestPayload.tools = textOptions.tools;
      }
      if (textOptions.toolChoice) {
        requestPayload.tool_choice = textOptions.toolChoice;
      }

      if (isStructured) {
        const structuredOpts = options as LLMStructuredCallOptions;
        if (structuredOpts.schema.schema) {
          requestPayload.response_format = {
            type: "json_schema",
            json_schema: {
              name: structuredOpts.schema.name,
              description: structuredOpts.schema.description,
              schema: structuredOpts.schema.schema,
              strict: structuredOpts.schema.strict ?? true,
            },
          };
        } else {
          requestPayload.response_format = { type: "json_object" };
        }
      }

      const response = await client.chat.completions.create(requestPayload, {
        signal: controller.signal,
      });

      const latencyMs = Date.now() - startTime;
      this.telemetry.emit("llm.latency", telemetryContext, latencyMs);

      // Usage accounting
      const usage = response.usage;
      if (usage) {
        if (usage.prompt_tokens) {
          this.telemetry.emit("llm.tokens_input", telemetryContext, usage.prompt_tokens);
        }
        if (usage.completion_tokens) {
          this.telemetry.emit("llm.tokens_output", telemetryContext, usage.completion_tokens);
        }
      }

      const choice = response.choices?.[0];
      if (!choice) {
        throw new LLMProviderError("Provider returned empty choices array", {
          stage,
          model,
        });
      }

      // ── COMPLETION / TRUNCATION CONTRACT ──
      // Critical: Inspect finish_reason.
      const finishReason = choice.finish_reason || "stop";
      if (finishReason === "length") {
        this.telemetry.emit("llm.truncated", telemetryContext);
        throw new LLMTruncationError(
          `LLM response was truncated due to output token exhaustion (finish_reason: length). Business result discarded.`,
          {
            stage,
            model,
            finishReason,
            rawPayloadSnippet: (choice.message?.content || "").slice(0, 200),
          }
        );
      }

      if (finishReason === "content_filter") {
        throw new LLMProviderError("LLM response was blocked by content filter", {
          stage,
          model,
          finishReason,
        });
      }

      const rawContent = choice.message?.content ?? "";

      let finalContent: T;
      if (isStructured) {
        finalContent = this.parseAndValidateStructured<T>(
          rawContent,
          (options as LLMStructuredCallOptions).schema,
          stage,
          model,
          telemetryContext
        );
      } else {
        finalContent = rawContent as unknown as T;
      }

      return {
        content: finalContent,
        rawResponse: response,
        finishReason,
        usage: usage
          ? {
              promptTokens: usage.prompt_tokens,
              completionTokens: usage.completion_tokens,
              totalTokens: usage.total_tokens,
            }
          : undefined,
        latencyMs,
        model,
        stage,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private parseAndValidateStructured<T>(
    rawContent: string,
    schema: LLMStructuredSchema<T>,
    stage: PipelineStage,
    model: string,
    telemetryContext: LLMTelemetryContext
  ): T {
    // ── SAFE PARSING ──
    let parsed: any;
    try {
      parsed = JSON.parse(rawContent);
    } catch (parseErr: any) {
      this.telemetry.emit("llm.parse_failure", telemetryContext);
      throw new LLMInvalidJsonError(
        `Failed to parse structured model response as valid JSON: ${parseErr.message}`,
        {
          stage,
          model,
          rawPayloadSnippet: rawContent.slice(0, 300),
        },
        parseErr
      );
    }

    // ── DEFENSE IN DEPTH: DETERMINISTIC SCHEMA VALIDATION ──
    if (schema.validate) {
      const validationResult = schema.validate(parsed);
      if (!validationResult.valid) {
        this.telemetry.emit("llm.schema_failure", telemetryContext);
        throw new LLMSchemaInvalidError(
          `Structured model response failed schema validation: ${(validationResult.errors || []).join("; ")}`,
          {
            stage,
            model,
            validationErrors: validationResult.errors,
            rawPayloadSnippet: rawContent.slice(0, 300),
          }
        );
      }
      return (validationResult.data !== undefined ? validationResult.data : parsed) as T;
    }

    return parsed as T;
  }

  private normalizeError(
    err: any,
    stage: PipelineStage,
    model: string,
    attempt: number,
    maxRetries: number
  ): LLMError {
    if (err instanceof LLMError) {
      return err;
    }

    const details = { stage, model, attempt, maxRetries, originalMessage: err?.message };

    // Timeout detection
    if (err?.name === "AbortError" || err?.message?.toLowerCase().includes("aborted") || err?.message?.toLowerCase().includes("timeout")) {
      return new LLMTimeoutError(`LLM call timed out: ${err.message}`, details, err);
    }

    // Rate limit detection
    if (err?.status === 429 || err?.message?.includes("429") || err?.message?.toLowerCase().includes("rate limit")) {
      return new LLMRateLimitError(`LLM rate limit exceeded (429): ${err.message}`, details, err);
    }

    // Network error detection
    const networkCodes = ["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"];
    if (networkCodes.includes(err?.code) || err?.message?.toLowerCase().includes("fetch failed") || err?.message?.toLowerCase().includes("network error")) {
      return new LLMNetworkError(`LLM network connectivity failure: ${err.message}`, details, err);
    }

    // 5xx or provider error
    const is5xx = typeof err?.status === "number" && err.status >= 500 && err.status < 600;
    return new LLMProviderError(
      `LLM provider error: ${err.message || "Unknown error"}`,
      { ...details, status: err?.status },
      is5xx, // retryable if 5xx
      err
    );
  }

  private recordErrorTelemetry(error: LLMError, context: LLMTelemetryContext): void {
    switch (error.code) {
      case "LLM_TIMEOUT":
        this.telemetry.emit("llm.timeout", context);
        break;
      case "LLM_RATE_LIMIT":
        this.telemetry.emit("llm.rate_limit", context);
        break;
      case "LLM_NETWORK_ERROR":
        this.telemetry.emit("llm.network_error", context);
        break;
      case "LLM_PROVIDER_ERROR":
        this.telemetry.emit("llm.provider_error", context);
        break;
      case "LLM_TRUNCATED":
        this.telemetry.emit("llm.truncated", context);
        break;
      case "LLM_INVALID_JSON":
        this.telemetry.emit("llm.parse_failure", context);
        break;
      case "LLM_SCHEMA_INVALID":
        this.telemetry.emit("llm.schema_failure", context);
        break;
    }
  }
}
