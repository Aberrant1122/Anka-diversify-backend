import { PipelineStage } from "./PipelineStage";

export type LLMErrorCode =
  | "LLM_TIMEOUT"
  | "LLM_RATE_LIMIT"
  | "LLM_NETWORK_ERROR"
  | "LLM_PROVIDER_ERROR"
  | "LLM_TRUNCATED"
  | "LLM_INVALID_JSON"
  | "LLM_SCHEMA_INVALID"
  | "LLM_RETRY_EXHAUSTED"
  | "LLM_ROUTING_ERROR"
  | "LLM_BUDGET_INVALID"
  | "LLM_BUDGET_EXHAUSTED"
  | "LLM_CONTEXT_OVERFLOW";

export interface LLMErrorDetails {
  stage?: PipelineStage;
  model?: string;
  attempt?: number;
  maxRetries?: number;
  status?: number;
  finishReason?: string;
  rawPayloadSnippet?: string;
  validationErrors?: string[];
  [key: string]: any;
}

/**
 * Base typed LLM Error.
 * Technical failures are NOT user ambiguity.
 */
export class LLMError extends Error {
  public readonly code: LLMErrorCode;
  public readonly stage?: PipelineStage;
  public readonly model?: string;
  public readonly details: LLMErrorDetails;
  public readonly isRetryable: boolean;

  constructor(message: string, code: LLMErrorCode, details: LLMErrorDetails = {}, isRetryable: boolean = false, cause?: unknown) {
    super(message);
    this.name = `LLMError[${code}]`;
    this.code = code;
    this.stage = details.stage;
    this.model = details.model;
    this.details = details;
    this.isRetryable = isRetryable;
    if (cause) {
      (this as any).cause = cause;
    }
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class LLMTimeoutError extends LLMError {
  constructor(message: string, details: LLMErrorDetails = {}, cause?: unknown) {
    super(message, "LLM_TIMEOUT", details, true, cause);
    this.name = "LLMTimeoutError";
  }
}

export class LLMRateLimitError extends LLMError {
  constructor(message: string, details: LLMErrorDetails = {}, cause?: unknown) {
    super(message, "LLM_RATE_LIMIT", details, true, cause);
    this.name = "LLMRateLimitError";
  }
}

export class LLMNetworkError extends LLMError {
  constructor(message: string, details: LLMErrorDetails = {}, cause?: unknown) {
    super(message, "LLM_NETWORK_ERROR", details, true, cause);
    this.name = "LLMNetworkError";
  }
}

export class LLMProviderError extends LLMError {
  constructor(message: string, details: LLMErrorDetails = {}, isRetryable: boolean = false, cause?: unknown) {
    super(message, "LLM_PROVIDER_ERROR", details, isRetryable, cause);
    this.name = "LLMProviderError";
  }
}

export class LLMTruncationError extends LLMError {
  constructor(message: string, details: LLMErrorDetails = {}, cause?: unknown) {
    // Truncation is retryable if the gateway can adjust tokens or retry
    super(message, "LLM_TRUNCATED", details, true, cause);
    this.name = "LLMTruncationError";
  }
}

export class LLMInvalidJsonError extends LLMError {
  constructor(message: string, details: LLMErrorDetails = {}, cause?: unknown) {
    super(message, "LLM_INVALID_JSON", details, false, cause);
    this.name = "LLMInvalidJsonError";
  }
}

export class LLMSchemaInvalidError extends LLMError {
  constructor(message: string, details: LLMErrorDetails = {}, cause?: unknown, isRetryable: boolean = false) {
    super(message, "LLM_SCHEMA_INVALID", details, isRetryable, cause);
    this.name = "LLMSchemaInvalidError";
  }
}

export class LLMRetryExhaustedError extends LLMError {
  public readonly lastError?: LLMError | Error;

  constructor(message: string, lastError?: LLMError | Error, details: LLMErrorDetails = {}) {
    super(message, "LLM_RETRY_EXHAUSTED", details, false, lastError);
    this.name = "LLMRetryExhaustedError";
    this.lastError = lastError;
  }
}

export class LLMRoutingError extends LLMError {
  constructor(message: string, details: LLMErrorDetails = {}, cause?: unknown) {
    super(message, "LLM_ROUTING_ERROR", details, false, cause);
    this.name = "LLMRoutingError";
  }
}

export class LLMBudgetConfigurationError extends LLMError {
  constructor(message: string, details: LLMErrorDetails = {}, cause?: unknown) {
    super(message, "LLM_BUDGET_INVALID", details, false, cause);
    this.name = "LLMBudgetConfigurationError";
  }
}

export class LLMBudgetExhaustedError extends LLMError {
  constructor(message: string, details: LLMErrorDetails = {}, cause?: unknown) {
    super(message, "LLM_BUDGET_EXHAUSTED", details, false, cause);
    this.name = "LLMBudgetExhaustedError";
  }
}

export class LLMContextOverflowError extends LLMError {
  constructor(message: string, details: LLMErrorDetails = {}, cause?: unknown) {
    super(message, "LLM_CONTEXT_OVERFLOW", details, false, cause);
    this.name = "LLMContextOverflowError";
  }
}

export function isLLMError(err: unknown): err is LLMError {
  return err instanceof LLMError;
}
