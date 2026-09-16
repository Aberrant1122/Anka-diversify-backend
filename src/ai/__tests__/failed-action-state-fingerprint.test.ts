import { failedActionStateFingerprint } from "../orchestration/AgentPipeline";

const action = [{
  action: "FILE_MODIFY" as const,
  path: "lib/mock-data.ts",
  contentFingerprint: "candidate-hash",
}];
const plan = { stages: [{ id: "fix", title: "Fix filter", description: "Use project foreign key", status: "PENDING" }] };

describe("failed action state fingerprint", () => {
  test("identical action from identical repository and plan state is rejected as the same attempt", () => {
    const failed = failedActionStateFingerprint("repo-r1", plan, action);
    const regenerated = failedActionStateFingerprint(
      "repo-r1",
      { stages: [{ ...plan.stages[0], status: "FAILED" }] },
      action,
    );
    expect(regenerated).toBe(failed);
  });

  test("changed proposal, evidence state, or substantive plan permits a legitimate retry", () => {
    const failed = failedActionStateFingerprint("repo-r1", plan, action);
    expect(failedActionStateFingerprint("repo-r2", plan, action)).not.toBe(failed);
    expect(failedActionStateFingerprint("repo-r1", plan, [{ ...action[0], contentFingerprint: "revised-candidate" }])).not.toBe(failed);
    expect(failedActionStateFingerprint("repo-r1", { stages: [{ ...plan.stages[0], description: "New evidence changed the fix" }] }, action)).not.toBe(failed);
  });
});
