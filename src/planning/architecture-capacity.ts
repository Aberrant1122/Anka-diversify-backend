import OpenAI from "openai";
import { ContextManager } from "../ai/context/ContextManager";
import { ModelRouter } from "../ai/gateway/ModelRouter";
import { PipelineStage, PipelineStages } from "../ai/gateway/PipelineStage";
import { PlanningDomainError } from "./planning-errors";
import { ARCHITECTURE_MAX_INPUT_TOKENS, ARCHITECTURE_MAX_OUTPUT_TOKENS } from "./architecture-run-config";

// Only exact model IDs with verified capability are admitted. Configured aliases
// and unknown models fail closed until their limits are verified here.
const MODEL_CAPABILITIES: Readonly<Record<string, { context: number; output: number }>> = Object.freeze({
  "gpt-4o": { context: 128_000, output: 16_384 },
  "gpt-4o-mini": { context: 128_000, output: 16_384 },
  "gpt-6-astra": { context: 1_050_000, output: 128_000 },
  "gpt-6.1-sol": { context: 1_050_000, output: 128_000 },
});

export function assertArchitectureCapacity(
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  schema: Record<string, unknown>,
  repairInstructions: string,
  router: ModelRouter = new ModelRouter(),
  responseFormat: { name: string; description: string } = { name: "anka_initial_architecture", description: "Initial Anka OS Architecture provider draft" },
  stage: PipelineStage = PipelineStages.ARCHITECTURE_GENERATION,
): void {
  const route = router.route(stage);
  if (route.maxInputTokens !== ARCHITECTURE_MAX_INPUT_TOKENS || route.maxOutputTokens < ARCHITECTURE_MAX_OUTPUT_TOKENS) {
    const details = {
      stage,
      routeMaxInputTokens: route.maxInputTokens,
      expectedMaxInputTokens: ARCHITECTURE_MAX_INPUT_TOKENS,
      routeMaxOutputTokens: route.maxOutputTokens,
      expectedMaxOutputTokens: ARCHITECTURE_MAX_OUTPUT_TOKENS,
    };
    console.error("[ArchitectureCapacity] Architecture model route capacity is invalid:", details);
    throw new PlanningDomainError("PLANNING_AI_CONTEXT_TOO_LARGE", "Architecture model route capacity is invalid.", 413, details);
  }
  for (const model of [route.primaryModel, ...route.fallbackModels]) {
    const capability = MODEL_CAPABILITIES[model];
    if (!capability || capability.context < route.contextWindowTokens || capability.output < ARCHITECTURE_MAX_OUTPUT_TOKENS) {
      const details = {
        model,
        capability: capability ?? null,
        requiredContextWindowTokens: route.contextWindowTokens,
        requiredMaxOutputTokens: ARCHITECTURE_MAX_OUTPUT_TOKENS,
      };
      console.error("[ArchitectureCapacity] Architecture model has unknown or insufficient capacity:", details);
      throw new PlanningDomainError("PLANNING_AI_CONTEXT_TOO_LARGE", "An Architecture model has unknown or insufficient capacity.", 413, details);
    }
  }
  try {
    const result = new ContextManager().build({
      messages, maxTokens: route.contextWindowTokens,
      maxInputTokens: ARCHITECTURE_MAX_INPUT_TOKENS,
      reservedOutputTokens: ARCHITECTURE_MAX_OUTPUT_TOKENS,
      requiredRequestPayloads: [
        { id: "structured-response-format", value: { type: "json_schema", json_schema: {
          name: responseFormat.name, description: responseFormat.description,
          schema, strict: true,
        } } },
        { id: "structured-repair-instructions", value: repairInstructions },
      ],
    });
    if (result.truncated) {
      const details = {
        truncated: true,
        estimatedTokens: result.estimatedTokens,
        inputLimitTokens: result.inputLimitTokens,
        omittedMessageIndexes: result.omittedMessageIndexes,
      };
      console.error("[ArchitectureCapacity] Architecture context was truncated:", details);
      throw new PlanningDomainError("PLANNING_AI_CONTEXT_TOO_LARGE", "Architecture context was truncated.", 413, details);
    }
  } catch (error) {
    if (error instanceof PlanningDomainError) throw error;
    const details = error && typeof error === "object" && "details" in error && typeof (error as Record<string, unknown>).details === "object"
      ? ((error as { details: Record<string, unknown> }).details ?? undefined)
      : (error instanceof Error ? { error: error.message } : undefined);
    console.error("[ArchitectureCapacity] Architecture generation context capacity check failed:", {
      message: error instanceof Error ? error.message : String(error),
      details,
    });
    throw new PlanningDomainError("PLANNING_AI_CONTEXT_TOO_LARGE", "Architecture generation context is too large.", 413, details);
  }
}
