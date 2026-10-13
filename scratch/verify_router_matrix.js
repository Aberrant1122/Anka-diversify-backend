require("dotenv").config();
const { ModelRouter } = require("./src/ai/gateway/ModelRouter");
const { PipelineStages } = require("./src/ai/gateway/PipelineStage");

const router = new ModelRouter();

console.log("=== RUNTIME MODEL ROUTING MATRIX ===");
const stages = Object.values(PipelineStages);

const results = [];
for (const stage of stages) {
  try {
    const decision = router.route(stage);
    results.push({
      stage,
      tier: decision.tier,
      primaryModel: decision.primaryModel,
      fallbackModels: decision.fallbackModels.join(", ") || "none",
      reasoningEffort: decision.reasoningEffort ?? "none",
      maxInputTokens: decision.maxInputTokens,
      maxOutputTokens: decision.maxOutputTokens,
      defaultMaxOutputTokens: decision.defaultMaxOutputTokens,
      contextWindowTokens: decision.contextWindowTokens,
      maxRetries: decision.maxRetries,
    });
  } catch (err) {
    results.push({ stage, error: err.message });
  }
}

console.table(results);
