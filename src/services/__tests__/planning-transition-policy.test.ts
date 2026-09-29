import { PlanningTransitionPolicy } from "../planning-transition-policy";

describe("PlanningTransitionPolicy Requirements transitions", () => {
  const policy = new PlanningTransitionPolicy();

  test.each([
    ["not_started", "in_progress"],
    ["in_progress", "awaiting_approval"],
    ["awaiting_approval", "approved"],
    ["awaiting_approval", "changes_requested"],
    ["changes_requested", "in_progress"],
    ["approved", "in_progress"],
  ] as const)("allows %s -> %s", (from, to) => {
    expect(() => policy.assertTransition(from, to)).not.toThrow();
  });

  test("returns allowed actions and structured lock reasons", () => {
    expect(policy.describe("awaiting_approval")).toEqual(expect.objectContaining({
      allowedActions: ["read", "approve", "request_changes"],
      locks: expect.objectContaining({
        create_revision: expect.objectContaining({ code: "PLANNING_ACTION_LOCKED" }),
      }),
    }));
  });

  test("rejects invalid transitions with a domain error", () => {
    expect(() => policy.assertTransition("not_started", "approved")).toThrow(expect.objectContaining({
      code: "PLANNING_INVALID_TRANSITION",
      httpStatus: 409,
    }));
  });
});
