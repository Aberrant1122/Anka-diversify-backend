import { LLMRoutingError } from "./LLMError";
import { PipelineStage, PipelineStages, isValidPipelineStage } from "./PipelineStage";

export type ModelTier = "FAST" | "STANDARD" | "REASONING";
export type ModelReasoningEffort = "low" | "medium" | "high" | "xhigh";

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
  requirementsGenerationModel: string;
  requirementsRevisionModel: string;
  documentationGenerationModel: string;
  documentationRevisionModel: string;
  architectureModel: string;
  implementationPlanningModel: string;
  codeGenerationModel: string;
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
  reasoningEffort: ModelReasoningEffort | null;
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
  [PipelineStages.REQUIREMENTS_GENERATION]: reasoningPolicy(32_000, 32_000),
  [PipelineStages.REQUIREMENTS_REVISION]: reasoningPolicy(32_000, 32_000),
  [PipelineStages.DOCUMENTATION_PLANNING]: standardPolicy(8_000),
  [PipelineStages.DOCUMENTATION_GENERATION]: reasoningPolicy(32_000, 32_000),
  [PipelineStages.DOCUMENTATION_REVISION]: reasoningPolicy(32_000, 32_000),
  [PipelineStages.ARCHITECTURE_PLANNING]: {
    tier: "STANDARD", contextWindowTokens: 64_000 + 12_000 + 512,
    maxInputTokens: 64_000, defaultMaxOutputTokens: 12_000,
    maxOutputTokens: 12_000, defaultTemperature: 0.2,
    maxTemperature: 0.7, maxRetries: 1,
  },
  [PipelineStages.ARCHITECTURE_GENERATION]: reasoningPolicy(32_000, 32_000),
  [PipelineStages.ARCHITECTURE_REVISION]: reasoningPolicy(32_000, 32_000),
  [PipelineStages.IMPLEMENTATION_PLANNING]: reasoningPolicy(32_000, 32_000),
  [PipelineStages.CODE_GENERATION]: reasoningPolicy(32_000, 32_000),
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

function reasoningPolicy(maxOutputTokens: number, defaultMaxOutputTokens = Math.min(8_000, maxOutputTokens)): ModelRoutePolicy {
  return {
    tier: "REASONING",
    contextWindowTokens: 64_000 + maxOutputTokens + 512,
    maxInputTokens: 64_000,
    defaultMaxOutputTokens,
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

function configuredAllowedModel(
  value: string | undefined,
  fallback: string,
  name: string,
  allowed: readonly string[],
): string {
  const model = configuredModel(value, fallback, name);
  if (!allowed.includes(model)) {
    throw new LLMRoutingError(`Unsupported ${name} model configuration`, {
      configuration: name,
      model,
      allowedModels: [...allowed],
    });
  }
  return model;
}

const SOL_MODEL = "gpt-6.1-sol";
const ASTRA_MODEL = "gpt-6-astra";

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
      requirementsGenerationModel: configuredAllowedModel(config.requirementsGenerationModel, SOL_MODEL, "Requirements generation", [SOL_MODEL]),
      requirementsRevisionModel: configuredAllowedModel(config.requirementsRevisionModel, SOL_MODEL, "Requirements revision", [SOL_MODEL]),
      documentationGenerationModel: configuredAllowedModel(config.documentationGenerationModel, SOL_MODEL, "Documentation generation", [SOL_MODEL]),
      documentationRevisionModel: configuredAllowedModel(config.documentationRevisionModel, SOL_MODEL, "Documentation revision", [SOL_MODEL]),
      architectureModel: configuredAllowedModel(
        config.architectureModel ?? process.env.OPENAI_ARCHITECTURE_MODEL,
        ASTRA_MODEL,
        "Architecture",
        [ASTRA_MODEL, SOL_MODEL],
      ),
      implementationPlanningModel: configuredAllowedModel(config.implementationPlanningModel, SOL_MODEL, "Implementation planning", [SOL_MODEL]),
      codeGenerationModel: configuredAllowedModel(
        config.codeGenerationModel ?? config.reasoningModel,
        SOL_MODEL,
        "Code generation",
        config.reasoningModel ? [SOL_MODEL, config.reasoningModel] : [SOL_MODEL],
      ),
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
    const operationRoute = this.operationRoute(stage);
    const primaryModel = operationRoute?.model ?? this.modelForTier(tier);
    const fallbackModels = operationRoute
      ? []
      : [this.config.fallbackModel].filter((model) => model !== primaryModel);

    return {
      ...base,
      tier,
      routeId: `${stage}:${tier}`,
      stage,
      primaryModel,
      fallbackModels,
      reasoningEffort: operationRoute?.reasoningEffort ?? null,
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

  private operationRoute(stage: PipelineStage): { model: string; reasoningEffort: ModelReasoningEffort } | null {
    switch (stage) {
      case PipelineStages.REQUIREMENTS_GENERATION:
        return { model: this.config.requirementsGenerationModel, reasoningEffort: "high" };
      case PipelineStages.REQUIREMENTS_REVISION:
        return { model: this.config.requirementsRevisionModel, reasoningEffort: "medium" };
      case PipelineStages.DOCUMENTATION_GENERATION:
        return { model: this.config.documentationGenerationModel, reasoningEffort: "medium" };
      case PipelineStages.DOCUMENTATION_REVISION:
        return { model: this.config.documentationRevisionModel, reasoningEffort: "medium" };
      case PipelineStages.ARCHITECTURE_GENERATION:
      case PipelineStages.ARCHITECTURE_REVISION:
        return { model: this.config.architectureModel, reasoningEffort: "high" };
      case PipelineStages.IMPLEMENTATION_PLANNING:
        return { model: this.config.implementationPlanningModel, reasoningEffort: "high" };
      case PipelineStages.CODE_GENERATION:
        return { model: this.config.codeGenerationModel, reasoningEffort: "high" };
      default:
        return null;
    }
  }

}
