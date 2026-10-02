import { ModelRouter } from "../ModelRouter";
import { PipelineStages } from "../PipelineStage";
import { DOCUMENTATION_PROVIDER_JSON_SCHEMA } from "../../prompts/documentation";

describe("Documentation model routing", () => {
  test("adds an 8k Documentation stage without changing Requirements capacity", () => {
    const router = new ModelRouter({ standardModel: "standard", fallbackModel: "fallback" });
    expect(router.route(PipelineStages.ROADMAP_PLANNING).maxOutputTokens).toBe(4_000);
    const documentation = router.route(PipelineStages.DOCUMENTATION_PLANNING);
    expect(documentation.maxOutputTokens).toBe(8_000);
    expect(documentation.tier).toBe("STANDARD");
  });

  test("exposes exactly the ten provider-owned roots", () => {
    const properties = DOCUMENTATION_PROVIDER_JSON_SCHEMA.properties as Record<string, unknown>;
    expect(Object.keys(properties).sort()).toEqual([
      "apiContracts", "businessRules", "dataEntities", "edgeCases", "errorBehaviors",
      "features", "overview", "permissionRules", "systemActors", "unresolvedQuestions",
    ]);
    expect(properties).not.toHaveProperty("sourceRequirements");
    expect(properties).not.toHaveProperty("requirementsTraceability");
  });
});
