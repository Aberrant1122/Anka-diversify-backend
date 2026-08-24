import OpenAI from "openai";
import { ModelCallEvent, ModelProfile, ActualTokenUsage } from "./types";
import { getOpenAI } from "../shared/utils";

export class ModelObserver {
  private static activeObserver: ModelObserver | null = null;
  private events: ModelCallEvent[] = [];
  private originalChatCreate?: typeof OpenAI.prototype.chat.completions.create;
  private originalEmbeddingsCreate?: typeof OpenAI.prototype.embeddings.create;
  private attachedClient?: OpenAI;

  public static start(): ModelObserver {
    if (this.activeObserver) {
      this.activeObserver.stop();
    }
    const observer = new ModelObserver();
    observer.attach();
    this.activeObserver = observer;
    return observer;
  }

  public static getActive(): ModelObserver | null {
    return this.activeObserver;
  }

  public recordEvent(event: ModelCallEvent): void {
    this.events.push(event);
  }

  public getEvents(): ModelCallEvent[] {
    return [...this.events];
  }

  public clear(): void {
    this.events = [];
  }

  public attach(client?: OpenAI): void {
    try {
      this.attachedClient = client || getOpenAI();
      if (!this.attachedClient) return;

      const chat = this.attachedClient.chat.completions;
      if (chat && !this.originalChatCreate) {
        this.originalChatCreate = chat.create.bind(chat);

        chat.create = (async (body: any, options: any) => {
          const start = performance.now();
          const modelName = body.model || "unknown";

          const response = await this.originalChatCreate!(body, options);
          const durationMs = parseFloat((performance.now() - start).toFixed(1));

          const usage = (response as any)?.usage;
          const promptTokens = usage?.prompt_tokens;
          const completionTokens = usage?.completion_tokens;
          const totalTokens = usage?.total_tokens ?? (promptTokens && completionTokens ? promptTokens + completionTokens : undefined);

          this.recordEvent({
            provider: "openai",
            model: modelName,
            promptTokens,
            completionTokens,
            totalTokens,
            durationMs,
            timestamp: new Date().toISOString(),
          });

          return response;
        }) as any;
      }

      const embeddings = this.attachedClient.embeddings;
      if (embeddings && !this.originalEmbeddingsCreate) {
        this.originalEmbeddingsCreate = embeddings.create.bind(embeddings);

        embeddings.create = (async (body: any, options: any) => {
          const start = performance.now();
          const modelName = body.model || "unknown";

          const response = await this.originalEmbeddingsCreate!(body, options);
          const durationMs = parseFloat((performance.now() - start).toFixed(1));

          const usage = (response as any)?.usage;
          const promptTokens = usage?.prompt_tokens;
          const totalTokens = usage?.total_tokens ?? promptTokens;

          this.recordEvent({
            provider: "openai",
            model: modelName,
            promptTokens,
            totalTokens,
            durationMs,
            timestamp: new Date().toISOString(),
          });

          return response;
        }) as any;
      }
    } catch {
      // In environment without API key or mock, graceful fallback
    }
  }

  public stop(): ModelCallEvent[] {
    if (this.attachedClient) {
      if (this.originalChatCreate) {
        this.attachedClient.chat.completions.create = this.originalChatCreate;
        this.originalChatCreate = undefined;
      }
      if (this.originalEmbeddingsCreate) {
        this.attachedClient.embeddings.create = this.originalEmbeddingsCreate;
        this.originalEmbeddingsCreate = undefined;
      }
    }
    if (ModelObserver.activeObserver === this) {
      ModelObserver.activeObserver = null;
    }
    return this.getEvents();
  }

  public buildModelProfile(embeddingProvider: string = "local-feature-hashing-128"): ModelProfile {
    const modelsSeen = new Set<string>();
    const providersSeen = new Set<string>();
    const callsByModel: Record<string, number> = {};

    for (const ev of this.events) {
      providersSeen.add(ev.provider);
      modelsSeen.add(ev.model);
      callsByModel[ev.model] = (callsByModel[ev.model] || 0) + 1;
    }

    return {
      providers: Array.from(providersSeen).length > 0 ? Array.from(providersSeen) : ["openai"],
      modelsObserved: Array.from(modelsSeen),
      embeddingProvider,
      callCount: this.events.length,
      callsByModel,
    };
  }

  public aggregateActualTokenUsage(): ActualTokenUsage | undefined {
    let hasUsage = false;
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;

    for (const ev of this.events) {
      if (typeof ev.promptTokens === "number" || typeof ev.completionTokens === "number") {
        hasUsage = true;
        promptTokens += ev.promptTokens || 0;
        completionTokens += ev.completionTokens || 0;
        totalTokens += ev.totalTokens || (ev.promptTokens || 0) + (ev.completionTokens || 0);
      }
    }

    if (!hasUsage) return undefined;

    return {
      promptTokens,
      completionTokens,
      totalTokens,
    };
  }
}
