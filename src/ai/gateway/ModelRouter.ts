import { LLMRoutingError } from "./LLMError";
import { PipelineStage, PipelineStages, isValidPipelineStage } from "./PipelineStage";

export type ModelTier = "FAST" | "STANDARD" | "REASONING";

export interface ModelRoutingMetadata {
  taskComplexity?: "SMALL" | "MEDIUM" | "COMPLEX";
  taskRisk?: "LOW" | "MEDIUM" | "HIGH";
  requiresVision?: boolean;
}

export interface ModelRouterConfig {
  fastModel: string;
  standardModel: string;
  reasoningModel: string;
  fallbackModel: string;
}

export interface ModelRoutePolicy {
  tier: ModelTier;
  contextWindowTokens: number;
  maxInputTokens: number;
  defaultMaxOutputTokens: number;
  maxOutputTokens: number;
  defaultTemperature: number;
  maxTemperature: number;
  maxRetries: number;
}

export interface ModelRoutingDecision extends ModelRoutePolicy {
  routeId: string;
  stage: PipelineStage;
  primaryModel: string;
  fallbackModels: string[];
  consideredMetadata: ModelRoutingMetadata;
}

const STAGE_POLICIES: Record<PipelineStage, ModelRoutePolicy> = {
  [PipelineStages.INTENT_CLASSIFICATION]: fastPolicy(2_000),
  [PipelineStages.PLAN_REORDER]: fastPolicy(1_000),
  [PipelineStages.TASK_DECOMPOSITION]: standardPolicy(4_000),
  [PipelineStages.REPOSITORY_REASONING]: standardPolicy(4_000),
  [PipelineStages.MANIFEST_GENERATION]: standardPolicy(8_000),
  [PipelineStages.MANIFEST_CORRECTION]: standardPolicy(8_000),
  [PipelineStages.ROADMAP_PLANNING]: standardPolicy(4_000),
  [PipelineStages.CODE_GENERATION]: reasoningPolicy(12_000),
  [PipelineStages.CODE_CORRECTION]: reasoningPolicy(12_000),
  [PipelineStages.REPAIR]: reasoningPolicy(12_000),
  [PipelineStages.STATIC_REVIEW]: standardPolicy(4_000),
  [PipelineStages.FEATURE_VALIDATION]: standardPolicy(4_000),
  [PipelineStages.SECURITY_AUDIT]: reasoningPolicy(6_000),
  [PipelineStages.APPLICATION_SUPPORT]: fastPolicy(4_000),
  [PipelineStages.SUMMARIZATION]: fastPolicy(2_000),
};

function fastPolicy(maxOutputTokens: number): ModelRoutePolicy {
  return {
    tier: "FAST",
    contextWindowTokens: 32_000 + maxOutputTokens + 512,
    maxInputTokens: 32_000,
    defaultMaxOutputTokens: Math.min(2_000, maxOutputTokens),
    maxOutputTokens,
    defaultTemperature: 0.2,
    maxTemperature: 0.8,
    maxRetries: 5,
  };
}

function standardPolicy(maxOutputTokens: number): ModelRoutePolicy {
  return {
    tier: "STANDARD",
    contextWindowTokens: 64_000 + maxOutputTokens + 512,
    maxInputTokens: 64_000,
    defaultMaxOutputTokens: Math.min(4_000, maxOutputTokens),
    maxOutputTokens,
    defaultTemperature: 0.2,
    maxTemperature: 0.7,
    maxRetries: 5,
  };
}

function reasoningPolicy(maxOutputTokens: number): ModelRoutePolicy {
  return {
    tier: "REASONING",
    contextWindowTokens: 64_000 + maxOutputTokens + 512,
    maxInputTokens: 64_000,
    defaultMaxOutputTokens: Math.min(8_000, maxOutputTokens),
    maxOutputTokens,
    defaultTemperature: 0.1,
    maxTemperature: 0.4,
    maxRetries: 5,
  };
}

function configuredModel(value: string | undefined, fallback: string, name: string): string {
  const model = value === undefined ? fallback : value.trim();
  if (!model || model.length > 128 || /[\r\n]/.test(model)) {
    throw new LLMRoutingError(`Invalid ${name} model configuration`, { configuration: name });
  }
  return model;
}

/**
 * Deterministic backend model policy. It selects configuration only and never
 * invokes a provider. Model output and call-site options are not routing inputs.
 */
export class ModelRouter {
  private readonly config: ModelRouterConfig;

  constructor(config: Partial<ModelRouterConfig> = {}) {
    const standardModel = configuredModel(
      config.standardModel ?? process.env.OPENAI_AGENT_MODEL,
      "gpt-4o",
      "standard"
    );
    this.config = {
      fastModel: configuredModel(config.fastModel ?? process.env.OPENAI_FAST_MODEL, "gpt-4o-mini", "fast"),
      standardModel,
      reasoningModel: configuredModel(config.reasoningModel ?? process.env.OPENAI_REASONING_MODEL, standardModel, "reasoning"),
      fallbackModel: configuredModel(config.fallbackModel ?? process.env.OPENAI_FALLBACK_MODEL, "gpt-4o-mini", "fallback"),
    };
  }

  public route(stage: PipelineStage): ModelRoutingDecision {
    if (!isValidPipelineStage(stage)) {
      throw new LLMRoutingError(`Unsupported PipelineStage for model routing: ${String(stage)}`, {
        receivedStage: String(stage),
      });
    }

    const base = STAGE_POLICIES[stage];
    if (!base) {
      throw new LLMRoutingError(`No model route is configured for PipelineStage ${stage}`, { stage });
    }

    const tier = base.tier;
    const primaryModel = this.modelForTier(tier);
    const fallbackModels = [this.config.fallbackModel].filter((model) => model !== primaryModel);

    return {
      ...base,
      tier,
      routeId: `${stage}:${tier}`,
      stage,
      primaryModel,
      fallbackModels,
      consideredMetadata: {},
    };
  }

  public modelForAttempt(decision: ModelRoutingDecision, attempt: number): string {
    if (!Number.isFinite(attempt) || attempt < 1 || !Number.isInteger(attempt)) {
      throw new LLMRoutingError(`Routing attempt must be a positive finite integer`, {
        stage: decision.stage,
        attempt,
      });
    }
    const orderedModels = [decision.primaryModel, ...decision.fallbackModels];
    return orderedModels[Math.min(attempt - 1, orderedModels.length - 1)];
  }

  private modelForTier(tier: ModelTier): string {
    if (tier === "FAST") return this.config.fastModel;
    if (tier === "STANDARD") return this.config.standardModel;
    return this.config.reasoningModel;
  }

}
