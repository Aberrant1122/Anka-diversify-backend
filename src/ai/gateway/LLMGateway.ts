import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIUserAbortError,
} from "openai";
import { getOpenAI } from "../shared/utils";
import {
  ContextManager,
  RepositoryEvidenceInput,
  estimateMessageTokens,
} from "../context/ContextManager";
import { ContextPackerParams } from "../context/ContextPacker";
import { PipelineStage, isValidPipelineStage } from "./PipelineStage";
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
  LLMBudgetExhaustedError,
} from "./LLMError";
import { LLMTelemetry, LLMTelemetryContext } from "./LLMTelemetry";
import { BudgetManager, BudgetReservation } from "./BudgetManager";
import { ModelRouter } from "./ModelRouter";
import { getActiveTaskRuntimeScope } from "../runtime/TaskRuntimeScope";

export const MAX_GATEWAY_RETRIES = 5;
export const DEFAULT_GATEWAY_RETRIES = 2;
export const DEFAULT_GATEWAY_TIMEOUT_MS = 60000;
export const MAX_GATEWAY_TIMEOUT_MS = 120000;
export const DEFAULT_GATEWAY_RETRY_DELAY_MS = 250;
export const MAX_GATEWAY_RETRY_DELAY_MS = 10000;

function normalizeBoundedInteger(
  value: number | undefined,
  defaultValue: number,
  minimum: number,
  maximum: number
): number {
  if (value === undefined) return defaultValue;
  if (!Number.isFinite(value)) return defaultValue;
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

export interface LLMCallContext {
  runId?: string;
  projectId?: string;
  repositoryId?: string;
}

export interface LLMBaseCallOptions {
  stage: PipelineStage;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  context?: LLMCallContext;
  repositoryEvidence?: RepositoryEvidenceInput[];
  repositoryFiles?: ContextPackerParams;
  openaiClient?: OpenAI;
}

export interface LLMTextCallOptions extends LLMBaseCallOptions {
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
}

export interface LLMToolValidationResult<T = unknown> {
  valid: boolean;
  errors?: string[];
  data?: T;
}

export interface LLMToolCallOptions extends LLMBaseCallOptions {
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  tools: OpenAI.Chat.Completions.ChatCompletionTool[];
  toolChoice?: OpenAI.Chat.Completions.ChatCompletionToolChoiceOption;
  validateToolCall: (name: string, args: unknown) => LLMToolValidationResult;
}

export interface LLMValidatedToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export type LLMToolCompletion =
  | { type: "text"; text: string; toolCalls: [] }
  | { type: "tool_calls"; text: string | null; toolCalls: LLMValidatedToolCall[] };

export interface LLMStructuredSchema<T = any> {
  name: string;
  description?: string;
  schema?: Record<string, any>;
  strict?: boolean;
  validate: (parsed: any) => { valid: boolean; errors?: string[]; data?: T };
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

export interface LLMGatewayComponents {
  modelRouter?: ModelRouter;
  budgetManager?: BudgetManager;
  contextManager?: ContextManager;
}

type LLMInvocationOptions = LLMTextCallOptions | LLMStructuredCallOptions<unknown> | LLMToolCallOptions;

export class LLMGateway {
  private static instance: LLMGateway | null = null;
  private telemetry: LLMTelemetry;
  private readonly modelRouter: ModelRouter;
  private readonly budgetManager: BudgetManager;
  private readonly contextManager: ContextManager;

  constructor(telemetry?: LLMTelemetry, components: LLMGatewayComponents = {}) {
    this.telemetry = telemetry || LLMTelemetry.getInstance();
    this.modelRouter = components.modelRouter ?? new ModelRouter();
    this.budgetManager = components.budgetManager ?? new BudgetManager();
    this.contextManager = components.contextManager ?? new ContextManager();
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
    return this.executeWithRetry<string>(options, "text");
  }

  /**
   * Primary entry point for schema-constrained structured output generation.
   */
  public async callStructured<T = any>(options: LLMStructuredCallOptions<T>): Promise<LLMCallResult<T>> {
    this.assertValidStage(options.stage);
    if (!options.schema || typeof options.schema !== "object" || typeof options.schema.validate !== "function") {
      throw new LLMSchemaInvalidError("A deterministic schema validator is required for callStructured", {
        stage: options.stage,
      });
    }
    return this.executeWithRetry<T>(options, "structured");
  }

  /**
   * Explicit typed tool-proposal path. It validates tool names and parsed
   * arguments but never executes a tool or grants operational authority.
   */
  public async callWithTools(options: LLMToolCallOptions): Promise<LLMCallResult<LLMToolCompletion>> {
    this.assertValidStage(options.stage);
    if (!Array.isArray(options.tools) || options.tools.length === 0 || typeof options.validateToolCall !== "function") {
      throw new LLMSchemaInvalidError("Tool calls require declared tools and deterministic argument validation", {
        stage: options.stage,
      });
    }
    return this.executeWithRetry<LLMToolCompletion>(options, "tools");
  }

  private assertValidStage(stage: PipelineStage): void {
    if (!stage || !isValidPipelineStage(stage)) {
      throw new Error(
        `[LLMGateway] Invariant Violation: A valid PipelineStage is strictly required for every gateway call. Received: "${stage}"`
      );
    }
  }

  private async executeWithRetry<T>(
    options: LLMInvocationOptions,
    mode: "text" | "structured" | "tools"
  ): Promise<LLMCallResult<T>> {
    const stage = options.stage;
    const route = this.modelRouter.route(stage);
    const maxTokens = normalizeBoundedInteger(
      options.maxTokens,
      route.defaultMaxOutputTokens,
      1,
      route.maxOutputTokens
    );
    const maxRetries = normalizeBoundedInteger(
      options.maxRetries,
      Math.min(DEFAULT_GATEWAY_RETRIES, route.maxRetries),
      0,
      Math.min(MAX_GATEWAY_RETRIES, route.maxRetries)
    );
    const timeoutMs = normalizeBoundedInteger(
      options.timeoutMs,
      DEFAULT_GATEWAY_TIMEOUT_MS,
      1,
      MAX_GATEWAY_TIMEOUT_MS
    );
    const retryDelayMs = normalizeBoundedInteger(
      options.retryDelayMs,
      DEFAULT_GATEWAY_RETRY_DELAY_MS,
      0,
      MAX_GATEWAY_RETRY_DELAY_MS
    );
    const temperature = this.normalizeTemperature(options.temperature, route.defaultTemperature, route.maxTemperature);
    const requiredRequestPayloads = this.requiredRequestPayloads(options, mode);
    const managedContext = this.contextManager.build({
      messages: options.messages,
      maxTokens: route.contextWindowTokens,
      maxInputTokens: route.maxInputTokens,
      reservedOutputTokens: maxTokens,
      requiredRequestPayloads,
      repositoryEvidence: options.repositoryEvidence,
      repositoryFiles: options.repositoryFiles,
    });
    const preparedOptions: LLMInvocationOptions = {
      ...options,
      messages: managedContext.messages,
      maxTokens,
      temperature,
    };
    const client = options.openaiClient || getOpenAI();
    const activeTaskScope = getActiveTaskRuntimeScope();
    const inheritedRunId = activeTaskScope?.budgetScopeId;
    const effectiveContext: LLMCallContext = {
      ...options.context,
      ...(options.context?.runId || !inheritedRunId ? {} : { runId: inheritedRunId }),
    };
    const operationScoped = !effectiveContext.runId;
    const budgetScopeId = effectiveContext.runId ?? this.budgetManager.createOperationScope();

    this.telemetry.emit("llm.route", {
      ...effectiveContext,
      stage,
      model: route.primaryModel,
    }, undefined, {
      routeId: route.routeId,
      tier: route.tier,
      fallbackModels: route.fallbackModels,
      maxInputTokens: route.maxInputTokens,
      contextWindowTokens: route.contextWindowTokens,
      maxOutputTokens: maxTokens,
      maxRetries,
    });
    this.telemetry.emit("llm.context", {
      ...effectiveContext,
      stage,
      model: route.primaryModel,
    }, managedContext.estimatedTokens, {
      limitTokens: managedContext.limitTokens,
      inputLimitTokens: managedContext.inputLimitTokens,
      reservedOutputTokens: managedContext.reservedOutputTokens,
      safetyReserveTokens: managedContext.safetyReserveTokens,
      requiredRequestOverheadTokens: managedContext.requiredRequestOverheadTokens,
      truncated: managedContext.truncated,
      omittedMessageIndexes: managedContext.omittedMessageIndexes,
      repositoryEvidenceAuthority: managedContext.repositoryEvidenceAuthority,
    });

    let lastError: LLMError | undefined;
    try {
      for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
        const model = this.modelRouter.modelForAttempt(route, attempt);
        const telemetryContext: LLMTelemetryContext = {
          ...effectiveContext,
          stage,
          model,
          attempt,
          routeId: route.routeId,
          budgetScopeId,
        };
        let reservation: BudgetReservation;
        try {
          reservation = this.budgetManager.beginAttempt({
            scopeId: budgetScopeId,
            stage,
            model,
            estimatedInputTokens: managedContext.estimatedTokens,
            maxOutputTokens: maxTokens,
          });
        } catch (budgetError) {
          this.telemetry.emit("llm.budget_exhausted", telemetryContext);
          throw budgetError;
        }
        this.telemetry.emit("llm.budget_reserved", telemetryContext, reservation.reservedTokens);
        this.telemetry.emit("llm.call", telemetryContext);
        const startTime = Date.now();

        try {
          const result = await this.executeSingleAttempt<T>(
            client,
            preparedOptions,
            model,
            stage,
            timeoutMs,
            mode,
            startTime,
            telemetryContext,
            reservation,
            managedContext.estimatedTokens
          );
          this.telemetry.emit("llm.latency", telemetryContext, Date.now() - startTime);
          return result;
        } catch (err: unknown) {
          const failedSettlement = this.budgetManager.failAttempt(reservation);
          if (failedSettlement.outcome === "ACCOUNTED") {
            this.telemetry.emit("llm.budget_accounted", telemetryContext, failedSettlement.accountedTokens, {
              source: "failed-attempt-reservation",
              ...failedSettlement.snapshot,
            });
          }
          lastError = this.normalizeError(err, stage, model, attempt, maxRetries);
          this.telemetry.emit("llm.latency", telemetryContext, Date.now() - startTime);
          this.recordErrorTelemetry(lastError, telemetryContext);

          const isLastAttempt = attempt >= maxRetries + 1;
          if (!lastError.isRetryable) throw lastError;
          if (isLastAttempt) {
            if (attempt === 1) throw lastError;
            throw new LLMRetryExhaustedError(
              `LLM call failed after ${attempt} attempts: ${lastError.message}`,
              lastError,
              { stage, model, attempt, maxRetries }
            );
          }

          this.telemetry.emit("llm.retry", telemetryContext, attempt);
          if (retryDelayMs > 0) {
            const delay = retryDelayMs * Math.pow(1.5, attempt - 1);
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
        }
      }

      throw lastError || new LLMProviderError("LLM invocation failed unexpectedly", {
        stage,
        model: route.primaryModel,
      });
    } finally {
      if (operationScoped) this.budgetManager.releaseScope(budgetScopeId);
    }
  }

  private async executeSingleAttempt<T>(
    client: OpenAI,
    options: LLMInvocationOptions,
    model: string,
    stage: PipelineStage,
    timeoutMs: number,
    mode: "text" | "structured" | "tools",
    startTime: number,
    telemetryContext: LLMTelemetryContext,
    reservation: BudgetReservation,
    estimatedInputTokens: number
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

      if (mode === "tools") {
        const toolOptions = options as LLMToolCallOptions;
        requestPayload.tools = toolOptions.tools;
        if (toolOptions.toolChoice) requestPayload.tool_choice = toolOptions.toolChoice;
      }

      if (mode === "structured") {
        const structuredOpts = options as LLMStructuredCallOptions;
        requestPayload.response_format = this.structuredResponseFormat(structuredOpts);
      }

      const response = await client.chat.completions.create(requestPayload, {
        signal: controller.signal,
        // The gateway owns retry accounting. Disable hidden SDK retries so one
        // gateway attempt always corresponds to one provider request attempt.
        maxRetries: 0,
      });

      const latencyMs = Date.now() - startTime;

      const choice = response.choices?.[0];
      if (!choice) {
        throw new LLMProviderError("Provider returned empty choices array", {
          stage,
          model,
        });
      }

      const providerUsage = response.usage;
      const promptTokens = this.validUsageValue(providerUsage?.prompt_tokens, estimatedInputTokens);
      const completionTokens = this.validUsageValue(
        providerUsage?.completion_tokens,
        estimateMessageTokens(choice.message)
      );
      const totalTokens = Math.max(
        promptTokens + completionTokens,
        this.validUsageValue(providerUsage?.total_tokens, promptTokens + completionTokens)
      );
      const settlement = this.budgetManager.completeAttempt(reservation, totalTokens);
      this.telemetry.emit("llm.budget_accounted", telemetryContext, settlement.accountedTokens, {
        source: providerUsage ? "provider" : "deterministic-estimate",
        ...settlement.snapshot,
      });
      this.telemetry.emit("llm.tokens_input", telemetryContext, promptTokens, {
        source: providerUsage ? "provider" : "deterministic-estimate",
      });
      this.telemetry.emit("llm.tokens_output", telemetryContext, completionTokens, {
        source: providerUsage ? "provider" : "deterministic-estimate",
      });
      if (settlement.overBudget) {
        this.telemetry.emit("llm.budget_overage", telemetryContext, settlement.accountedTokens, {
          source: providerUsage ? "provider" : "deterministic-estimate",
          ...settlement.snapshot,
        });
        throw new LLMBudgetExhaustedError("Provider usage exceeded the enforced runtime token budget", {
          stage,
          model,
          accountedTokens: settlement.accountedTokens,
          ...settlement.snapshot,
        });
      }

      // ── COMPLETION / TRUNCATION CONTRACT ──
      // Critical: Inspect finish_reason.
      const finishReason = choice.finish_reason;
      if (finishReason === "length") {
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

      if (finishReason === "function_call") {
        throw new LLMProviderError(
          `Provider returned ${finishReason}, which is unsupported by the generic gateway result contract`,
          { stage, model, finishReason }
        );
      }

      if (finishReason === "tool_calls" && mode !== "tools") {
        throw new LLMProviderError(
          "Provider returned tool_calls, which is unsupported by the generic gateway result contract",
          { stage, model, finishReason }
        );
      }

      if (finishReason !== "stop" && finishReason !== "tool_calls") {
        throw new LLMProviderError(
          `Provider returned an unsupported or missing finish_reason: ${String(finishReason)}`,
          { stage, model, finishReason }
        );
      }

      const rawContent = choice.message?.content ?? "";

      let finalContent: T;
      if (mode === "structured") {
        finalContent = this.parseAndValidateStructured<T>(
          rawContent,
          (options as LLMStructuredCallOptions).schema,
          stage,
          model,
          telemetryContext
        );
      } else if (mode === "tools") {
        finalContent = this.parseAndValidateToolCompletion(
          choice.message,
          finishReason,
          options as LLMToolCallOptions,
          stage,
          model
        ) as unknown as T;
      } else {
        finalContent = rawContent as unknown as T;
      }

      return {
        content: finalContent,
        rawResponse: response,
        finishReason,
        usage: {
          promptTokens,
          completionTokens,
          totalTokens,
        },
        latencyMs,
        model,
        stage,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private parseAndValidateToolCompletion(
    message: OpenAI.Chat.Completions.ChatCompletionMessage,
    finishReason: string,
    options: LLMToolCallOptions,
    stage: PipelineStage,
    model: string
  ): LLMToolCompletion {
    if (finishReason === "stop") {
      if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
        throw new LLMSchemaInvalidError("Provider returned tool payloads with a text completion finish reason", { stage, model });
      }
      return { type: "text", text: message.content ?? "", toolCalls: [] };
    }

    const calls = message.tool_calls;
    if (!Array.isArray(calls) || calls.length === 0) {
      throw new LLMSchemaInvalidError("Provider reported tool_calls without tool payloads", { stage, model });
    }

    const declaredNames = new Set(
      options.tools
        .filter((tool) => tool.type === "function")
        .map((tool) => tool.function.name)
    );
    const validated: LLMValidatedToolCall[] = [];

    for (const call of calls) {
      if (call.type !== "function" || !call.id || !declaredNames.has(call.function.name)) {
        throw new LLMSchemaInvalidError("Provider returned an undeclared or malformed tool call", { stage, model });
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(call.function.arguments);
      } catch (err: any) {
        throw new LLMInvalidJsonError(`Tool arguments are not valid JSON: ${err.message}`, { stage, model }, err);
      }
      let validation: LLMToolValidationResult;
      try {
        validation = options.validateToolCall(call.function.name, parsed);
      } catch (err: any) {
        throw new LLMSchemaInvalidError(`Tool argument validator threw: ${err?.message || String(err)}`, { stage, model }, err);
      }
      if (!validation || validation.valid !== true) {
        throw new LLMSchemaInvalidError(
          `Tool arguments failed validation: ${(validation?.errors || []).join("; ")}`,
          { stage, model, validationErrors: validation?.errors }
        );
      }
      validated.push({ id: call.id, name: call.function.name, arguments: validation.data ?? parsed });
    }

    return { type: "tool_calls", text: message.content, toolCalls: validated };
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
    if (typeof schema.validate !== "function") {
      throw new LLMSchemaInvalidError("A deterministic schema validator is required for structured output", {
        stage,
        model,
      });
    }

    let validationResult: ReturnType<LLMStructuredSchema<T>["validate"]>;
    try {
      validationResult = schema.validate(parsed);
    } catch (validationErr: any) {
      throw new LLMSchemaInvalidError(
        `Structured model response validator threw: ${validationErr?.message || String(validationErr)}`,
        {
          stage,
          model,
          validationErrors: [validationErr?.message || String(validationErr)],
          rawPayloadSnippet: rawContent.slice(0, 300),
        },
        validationErr
      );
    }

    if (!validationResult || validationResult.valid !== true) {
      throw new LLMSchemaInvalidError(
        `Structured model response failed schema validation: ${(validationResult?.errors || []).join("; ")}`,
        {
          stage,
          model,
          validationErrors: validationResult?.errors,
          rawPayloadSnippet: rawContent.slice(0, 300),
        }
      );
    }
    return (validationResult.data !== undefined ? validationResult.data : parsed) as T;
  }

  private normalizeTemperature(value: number | undefined, defaultValue: number, maximum: number): number {
    if (value === undefined || !Number.isFinite(value)) return defaultValue;
    return Math.min(maximum, Math.max(0, value));
  }

  private validUsageValue(value: number | undefined, fallback: number): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return fallback;
    return Math.floor(value);
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

    const errorName = typeof err?.name === "string" ? err.name : "";
    const errorCode = typeof err?.code === "string" ? err.code : "";
    const errorMessage = typeof err?.message === "string" ? err.message : "";
    const lowerMessage = errorMessage.toLowerCase();

    // SDK connection timeouts and gateway-triggered aborts are timeouts.
    if (
      err instanceof APIConnectionTimeoutError ||
      err instanceof APIUserAbortError ||
      errorName === "APIConnectionTimeoutError" ||
      errorName === "APIUserAbortError" ||
      errorName === "AbortError" ||
      lowerMessage.includes("aborted") ||
      lowerMessage.includes("timed out") ||
      lowerMessage.includes("timeout")
    ) {
      return new LLMTimeoutError(`LLM call timed out: ${err.message}`, details, err);
    }

    // Rate limit detection
    if (err?.status === 429 || errorName === "RateLimitError" || errorMessage.includes("429") || lowerMessage.includes("rate limit")) {
      return new LLMRateLimitError(`LLM rate limit exceeded (429): ${err.message}`, details, err);
    }

    // Network error detection
    const networkCodes = ["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"];
    if (
      err instanceof APIConnectionError ||
      errorName === "APIConnectionError" ||
      networkCodes.includes(errorCode) ||
      lowerMessage.includes("fetch failed") ||
      lowerMessage.includes("network error") ||
      lowerMessage === "connection error."
    ) {
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
      case "LLM_BUDGET_EXHAUSTED":
        this.telemetry.emit("llm.budget_exhausted", context);
        break;
    }
  }

  private requiredRequestPayloads(
    options: LLMInvocationOptions,
    mode: "text" | "structured" | "tools"
  ): Array<{ id: string; value: unknown }> {
    if (mode === "tools") {
      const toolOptions = options as LLMToolCallOptions;
      return [{
        id: "tool-definitions",
        value: { tools: toolOptions.tools, tool_choice: toolOptions.toolChoice },
      }];
    }
    if (mode === "structured") {
      return [{
        id: "structured-response-format",
        value: this.structuredResponseFormat(options as LLMStructuredCallOptions),
      }];
    }
    return [];
  }

  private structuredResponseFormat(
    options: LLMStructuredCallOptions
  ): OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming["response_format"] {
    if (!options.schema.schema) return { type: "json_object" };
    return {
      type: "json_schema",
      json_schema: {
        name: options.schema.name,
        description: options.schema.description,
        schema: options.schema.schema,
        strict: options.schema.strict ?? true,
      },
    };
  }
}
