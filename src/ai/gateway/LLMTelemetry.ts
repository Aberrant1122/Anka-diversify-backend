import { PipelineStage } from "./PipelineStage";

export type LLMTelemetryEventName =
  | "llm.route"
  | "llm.call"
  | "llm.retry"
  | "llm.truncated"
  | "llm.timeout"
  | "llm.rate_limit"
  | "llm.network_error"
  | "llm.provider_error"
  | "llm.parse_failure"
  | "llm.schema_failure"
  | "llm.tokens_input"
  | "llm.tokens_output"
  | "llm.latency"
  | "llm.context"
  | "llm.budget_reserved"
  | "llm.budget_accounted"
  | "llm.budget_overage"
  | "llm.budget_exhausted"
  | "clarification.user_ambiguity"
  | "clarification.repo_resolvable"
  | "clarification.technical_failure";

export interface LLMTelemetryContext {
  runId?: string;
  projectId?: string;
  repositoryId?: string;
  stage?: PipelineStage;
  model?: string;
  attempt?: number;
  [key: string]: any;
}

export interface LLMTelemetryEvent {
  name: LLMTelemetryEventName;
  timestamp: string;
  value?: number;
  context: LLMTelemetryContext;
  metadata?: Record<string, any>;
}

export type LLMTelemetryListener = (event: LLMTelemetryEvent) => void;

/**
 * Production Telemetry service for LLM runtime events.
 * Provides structured observation without throwing into business logic.
 */
export class LLMTelemetry {
  public static readonly MAX_RECORDED_EVENTS = 1000;
  private static instance: LLMTelemetry | null = null;
  private listeners: Set<LLMTelemetryListener> = new Set();
  private recordedEvents: LLMTelemetryEvent[] = [];

  public static getInstance(): LLMTelemetry {
    if (!LLMTelemetry.instance) {
      LLMTelemetry.instance = new LLMTelemetry();
    }
    return LLMTelemetry.instance;
  }

  public subscribe(listener: LLMTelemetryListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public emit(name: LLMTelemetryEventName, context: LLMTelemetryContext = {}, value?: number, metadata?: Record<string, any>): void {
    const event: LLMTelemetryEvent = {
      name,
      timestamp: new Date().toISOString(),
      value,
      context,
      metadata,
    };

    this.recordedEvents.push(event);
    if (this.recordedEvents.length > LLMTelemetry.MAX_RECORDED_EVENTS) {
      this.recordedEvents.splice(
        0,
        this.recordedEvents.length - LLMTelemetry.MAX_RECORDED_EVENTS
      );
    }

    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (listenerErr) {
        // Do not let telemetry observer error crash business logic, but log to stderr
        console.error(`[LLMTelemetry] Error in telemetry listener for "${name}":`, listenerErr);
      }
    }
  }

  public getEvents(): LLMTelemetryEvent[] {
    return [...this.recordedEvents];
  }

  public clear(): void {
    this.recordedEvents = [];
  }
}
