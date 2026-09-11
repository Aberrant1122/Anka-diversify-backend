import OpenAI from "openai";
import { getOpenAI } from "../shared/utils";
import {
  LLMError,
  LLMTimeoutError,
  LLMRateLimitError,
  LLMNetworkError,
  LLMProviderError,
  LLMRetryExhaustedError,
} from "./LLMError";
import { LLMTelemetry, LLMTelemetryContext } from "./LLMTelemetry";

export function resolveEmbeddingModel(requestedModel?: string): string {
  if (requestedModel && requestedModel.trim()) {
    return requestedModel.trim();
  }
  return process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
}

export interface EmbeddingOptions {
  model?: string;
  timeoutMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  context?: {
    runId?: string;
    projectId?: string;
    repositoryId?: string;
  };
  openaiClient?: OpenAI;
}

export interface EmbeddingResult<T = number[] | number[][]> {
  data: T;
  model: string;
  usage?: {
    promptTokens: number;
    totalTokens: number;
  };
  latencyMs: number;
}

/**
 * Dedicated EmbeddingGateway for vector embeddings.
 *
 * Invariant: Does NOT implement chat finish_reason or truncation semantics.
 * Embeddings are fixed vector representations without generative completion state.
 */
export class EmbeddingGateway {
  private static instance: EmbeddingGateway | null = null;
  private telemetry: LLMTelemetry;

  constructor(telemetry?: LLMTelemetry) {
    this.telemetry = telemetry || LLMTelemetry.getInstance();
  }

  public static getInstance(): EmbeddingGateway {
    if (!EmbeddingGateway.instance) {
      EmbeddingGateway.instance = new EmbeddingGateway();
    }
    return EmbeddingGateway.instance;
  }

  public async embedQuery(text: string, options: EmbeddingOptions = {}): Promise<EmbeddingResult<number[]>> {
    const input = (text || "").slice(0, 8000);
    const res = await this.executeWithRetry<number[]>(input, options);
    return res;
  }

  public async embedBatch(texts: string[], options: EmbeddingOptions = {}): Promise<EmbeddingResult<number[][]>> {
    if (!texts.length) {
      return {
        data: [],
        model: resolveEmbeddingModel(options.model),
        latencyMs: 0,
      };
    }
    const input = texts.map((t) => (t || "").slice(0, 8000));
    const res = await this.executeWithRetry<number[][]>(input, options);
    return res;
  }

  private async executeWithRetry<T extends number[] | number[][]>(
    input: string | string[],
    options: EmbeddingOptions
  ): Promise<EmbeddingResult<T>> {
    const model = resolveEmbeddingModel(options.model);
    const maxRetries = typeof options.maxRetries === "number" ? Math.max(0, options.maxRetries) : 2;
    const timeoutMs = typeof options.timeoutMs === "number" ? options.timeoutMs : 30000;
    const retryDelayMs = typeof options.retryDelayMs === "number" ? options.retryDelayMs : 250;
    const client = options.openaiClient || getOpenAI();

    let lastError: LLMError | undefined;

    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      const telemetryContext: LLMTelemetryContext = {
        ...options.context,
        model,
        attempt,
      };

      this.telemetry.emit("llm.call", telemetryContext);
      const startTime = Date.now();

      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        try {
          const response = await client.embeddings.create(
            {
              model,
              input,
            },
            { signal: controller.signal }
          );

          const latencyMs = Date.now() - startTime;
          this.telemetry.emit("llm.latency", telemetryContext, latencyMs);

          if (response.usage?.prompt_tokens) {
            this.telemetry.emit("llm.tokens_input", telemetryContext, response.usage.prompt_tokens);
          }

          let data: any;
          if (Array.isArray(input)) {
            data = response.data.map((d) => d.embedding);
          } else {
            data = response.data[0]?.embedding || [];
          }

          return {
            data,
            model,
            usage: response.usage
              ? {
                  promptTokens: response.usage.prompt_tokens,
                  totalTokens: response.usage.total_tokens,
                }
              : undefined,
            latencyMs,
          };
        } finally {
          clearTimeout(timer);
        }
      } catch (err: any) {
        lastError = this.normalizeError(err, model, attempt, maxRetries);
        const duration = Date.now() - startTime;
        this.telemetry.emit("llm.latency", telemetryContext, duration);

        this.recordErrorTelemetry(lastError, telemetryContext);

        const isLastAttempt = attempt >= maxRetries + 1;
        if (isLastAttempt || !(lastError as LLMError).isRetryable) {
          if (attempt > 1 && isLastAttempt) {
            throw new LLMRetryExhaustedError(
              `Embedding call failed after ${attempt} attempts: ${lastError.message}`,
              lastError,
              { model, attempt, maxRetries }
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

    throw lastError || new LLMProviderError("Embedding invocation failed unexpectedly", { model });
  }

  private normalizeError(err: any, model: string, attempt: number, maxRetries: number): LLMError {
    if (err instanceof LLMError) {
      return err;
    }

    const details = { model, attempt, maxRetries, originalMessage: err?.message };

    if (err?.name === "AbortError" || err?.message?.toLowerCase().includes("aborted") || err?.message?.toLowerCase().includes("timeout")) {
      return new LLMTimeoutError(`Embedding call timed out: ${err.message}`, details, err);
    }

    if (err?.status === 429 || err?.message?.includes("429") || err?.message?.toLowerCase().includes("rate limit")) {
      return new LLMRateLimitError(`Embedding rate limit exceeded (429): ${err.message}`, details, err);
    }

    const networkCodes = ["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"];
    if (networkCodes.includes(err?.code) || err?.message?.toLowerCase().includes("fetch failed") || err?.message?.toLowerCase().includes("network error")) {
      return new LLMNetworkError(`Embedding network connectivity failure: ${err.message}`, details, err);
    }

    const is5xx = typeof err?.status === "number" && err.status >= 500 && err.status < 600;
    return new LLMProviderError(
      `Embedding provider error: ${err.message || "Unknown error"}`,
      { ...details, status: err?.status },
      is5xx,
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
    }
  }
}
