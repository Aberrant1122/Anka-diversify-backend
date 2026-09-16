import { TaskExecutionPlanManager } from "../planning/TaskExecutionPlanManager";
import { TaskClassificationResult } from "../../types";

describe("single-focus execution-plan normalization", () => {
  test("collapses procedural phases of one bug fix into one atomic stage", () => {
    const message = "Investigate why project tasks do not render, fix the issue, and validate the result.";
    const classification: TaskClassificationResult = {
      taskType: "BUG_FIX",
      risk: "MEDIUM",
      estimatedComplexity: "MEDIUM",
      intent: "BUG_FIX",
      confidence: 0.95,
      requiresClarification: false,
      reasoning: "Single behavioral bug fix",
      successCondition: "BEHAVIORAL_VALIDATION",
      stages: [
        {
          id: "stage-1",
          taskType: "BUG_FIX",
          goal: "Investigate the project detail loading flow",
          dependsOn: [],
        },
        {
          id: "stage-2",
          taskType: "BUG_FIX",
          goal: "Implement and validate the project task fix",
          dependsOn: ["stage-1"],
        },
      ],
    };

    const plan = TaskExecutionPlanManager.createTaskExecutionPlan(message, classification);

    expect(plan.stages).toHaveLength(1);
    expect(plan.stages[0]).toMatchObject({
      id: "stage-1",
      name: message,
      dependsOn: [],
      status: "PENDING",
      intent: expect.objectContaining({ goal: message, taskType: "BUG_FIX" }),
    });
  });

  test("preserves stages for distinct requested task types", () => {
    const classification: TaskClassificationResult = {
      taskType: "BUG_FIX",
      risk: "HIGH",
      estimatedComplexity: "LARGE",
      intent: "BUG_FIX",
      confidence: 0.95,
      requiresClarification: false,
      reasoning: "Compound repair and feature request",
      stages: [
        { id: "stage-1", taskType: "BUG_FIX", goal: "Repair authentication", dependsOn: [] },
        { id: "stage-2", taskType: "NEW_FEATURE", goal: "Add data export", dependsOn: ["stage-1"] },
      ],
    };

    const plan = TaskExecutionPlanManager.createTaskExecutionPlan(
      "Repair authentication and add data export",
      classification,
    );

    expect(plan.stages).toHaveLength(2);
    expect(plan.stages.map((stage) => stage.intent.taskType)).toEqual(["BUG_FIX", "NEW_FEATURE"]);
  });

  test("preserves same-type stages grounded to distinct explicit user paths", () => {
    const classification: TaskClassificationResult = {
      taskType: "BUG_FIX",
      risk: "MEDIUM",
      estimatedComplexity: "MEDIUM",
      intent: "BUG_FIX",
      confidence: 0.95,
      requiresClarification: false,
      reasoning: "Two explicitly targeted fixes",
      stages: [
        { id: "stage-1", taskType: "BUG_FIX", goal: "Repair a.ts", targetPath: "a.ts", dependsOn: [] },
        { id: "stage-2", taskType: "BUG_FIX", goal: "Repair b.ts", targetPath: "b.ts", dependsOn: ["stage-1"] },
      ],
    };

    const plan = TaskExecutionPlanManager.createTaskExecutionPlan(
      "Repair a.ts and b.ts",
      classification,
      ["a.ts", "b.ts"],
    );

    expect(plan.stages).toHaveLength(2);
    expect(plan.stages.map((stage) => stage.intent.explicitUserPaths)).toEqual([["a.ts"], ["b.ts"]]);
  });
});
