import { composeLifecycleExplanation } from "../orchestration/PipelineResult";

describe("deterministic pipeline completion reporting", () => {
  const successClaim = "The issue has been corrected and the task is completed. Everything is working.";

  test("verified lifecycle permits the generated success explanation", () => {
    expect(composeLifecycleExplanation(true, successClaim)).toBe(successClaim);
  });

  test("failed lifecycle replaces contradictory generated success language", () => {
    const explanation = composeLifecycleExplanation(false, successClaim);
    expect(explanation).toBe("ANKA identified a candidate change, but deterministic validation failed. The candidate was rolled back and the task was not verified.");
    expect(explanation).not.toMatch(/corrected|completed|working/i);
  });

  test("failed lifecycle exposes deterministic gate reasons", () => {
    const explanation = composeLifecycleExplanation(false, successClaim, ["Feature/static validation failed"]);
    expect(explanation).toContain("Validation reasons: Feature/static validation failed.");
    expect(explanation).not.toMatch(/corrected|completed|working/i);
  });
});
