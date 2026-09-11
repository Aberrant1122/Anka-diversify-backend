import { TaskExecutionPlanManager } from "../planning/TaskExecutionPlanManager";
import { IntentClassifier } from "../classification/IntentClassifier";
import { AgentPipeline } from "../orchestration/AgentPipeline";
import { ManifestGenerator } from "../../services/manifest-generator";
import { TaskClassificationResult } from "../../types";

describe("Compound Task Execution Plan & Clarification Sequencing (Pass 1)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // Test A: Initial request produces 2 structured stages
  test("Test A: Initial compound request ('fix errors and create calculator') produces 2 stages", () => {
    const initialMessage = "this repo contain errors i need you to solve them and create a calculator for me";
    const classification: TaskClassificationResult = {
      taskType: "BUG_FIX",
      risk: "MEDIUM",
      estimatedComplexity: "LARGE",
      intent: "BUG_FIX",
      confidence: 0.9,
      requiresClarification: true,
      reasoning: "Compound request with repair and new feature creation",
      question: "Would you like to prioritize fixing the existing errors or creating the new calculator feature first?",
      options: ["Fix existing errors first", "Create calculator first"],
      stages: [
        {
          id: "stage-1",
          taskType: "BUG_FIX",
          goal: "solve existing repository errors",
          dependsOn: [],
        },
        {
          id: "stage-2",
          taskType: "NEW_FEATURE",
          goal: "create a calculator",
          dependsOn: ["stage-1"],
        },
      ],
    };

    const plan = TaskExecutionPlanManager.createTaskExecutionPlan(initialMessage, classification);

    expect(plan.stages.length).toBe(2);
    expect(plan.stages[0].intent.taskType).toBe("BUG_FIX");
    expect(plan.stages[0].intent.operations[0].kind).toBe("REPAIR");
    expect(plan.stages[0].intent.goal).toBe("solve existing repository errors");

    expect(plan.stages[1].intent.taskType).toBe("NEW_FEATURE");
    expect(plan.stages[1].intent.operations[0].kind).toBe("MODIFY");
    expect(plan.stages[1].intent.goal).toBe("create a calculator");
    expect(plan.stages[1].dependsOn).toEqual(["stage-1"]);
    expect(plan.status).toBe("PENDING");
  });

  // Test B: Clarification reorders priorities, preserves both stages (does NOT delete calculator)
  test("Test B: Clarification ('Fix existing errors') preserves 2 stages and sets REPAIR first, CREATE pending", async () => {
    const initialMessage = "this repo contain errors i need you to solve them and create a calculator for me";
    const classification: TaskClassificationResult = {
      taskType: "BUG_FIX",
      risk: "MEDIUM",
      estimatedComplexity: "LARGE",
      intent: "BUG_FIX",
      confidence: 0.9,
      requiresClarification: true,
      reasoning: "Compound request",
      stages: [
        {
          id: "stage-feat",
          taskType: "NEW_FEATURE",
          goal: "create a calculator",
          dependsOn: [],
        },
        {
          id: "stage-fix",
          taskType: "BUG_FIX",
          goal: "solve existing repository errors",
          dependsOn: [],
        },
      ],
    };

    const plan = TaskExecutionPlanManager.createTaskExecutionPlan(initialMessage, classification);
    expect(plan.stages.length).toBe(2);

    // Clarification arrives
    const clarificationAnswer = "Fix existing errors";
    const clarificationQuestion = "Would you like to prioritize fixing the existing errors or creating the new calculator feature first?";

    const reorderedPlan = await TaskExecutionPlanManager.reorderPlanWithClarification(
      plan,
      clarificationAnswer,
      clarificationQuestion
    );

    expect(reorderedPlan.stages.length).toBe(2);
    // Stage 1 must be REPAIR / BUG_FIX
    expect(reorderedPlan.stages[0].id).toBe("stage-fix");
    expect(reorderedPlan.stages[0].intent.taskType).toBe("BUG_FIX");
    expect(reorderedPlan.stages[0].dependsOn).toEqual([]);

    // Stage 2 must remain CREATE / NEW_FEATURE without inventing a new dependency edge.
    expect(reorderedPlan.stages[1].id).toBe("stage-feat");
    expect(reorderedPlan.stages[1].intent.taskType).toBe("NEW_FEATURE");
    expect(reorderedPlan.stages[1].dependsOn).toEqual([]);
    expect(reorderedPlan.stages[1].status).toBe("PENDING");
  });

  // Test C: Stage 1 execution input contains repair intent only. Calculator creation must NOT reach ManifestGenerator
  test("Test C: Stage 1 execution isolates repair intent; calculator creation does not reach ManifestGenerator", async () => {
    const rawClientMessage = `this repo contain errors i need you to solve them and create a calculator for me

CLARIFICATION SO FAR:
Q: Would you like to prioritize fixing the existing errors or creating the new calculator feature first?
A: Fix existing errors`;

    const parsed = TaskExecutionPlanManager.parseClarificationInput(rawClientMessage);
    expect(parsed).not.toBeNull();
    expect(parsed!.initialRequest).toBe("this repo contain errors i need you to solve them and create a calculator for me");
    expect(parsed!.clarificationQas[0].answer).toBe("Fix existing errors");

    const classification: TaskClassificationResult = {
      taskType: "BUG_FIX",
      risk: "MEDIUM",
      estimatedComplexity: "LARGE",
      intent: "BUG_FIX",
      confidence: 0.95,
      requiresClarification: false,
      reasoning: "Fix existing errors prioritized",
      stages: [
        {
          id: "stage-1",
          taskType: "BUG_FIX",
          goal: "solve existing repository errors",
          dependsOn: [],
        },
        {
          id: "stage-2",
          taskType: "NEW_FEATURE",
          goal: "create a calculator",
          dependsOn: ["stage-1"],
        },
      ],
    };

    let plan = TaskExecutionPlanManager.createTaskExecutionPlan(parsed!.initialRequest, classification);
    plan = await TaskExecutionPlanManager.reorderPlanWithClarification(
      plan,
      parsed!.clarificationQas[0].answer,
      parsed!.clarificationQas[0].question
    );

    // Active stage for Stage 1 execution
    const activeStage = plan.stages[plan.currentStageIndex];
    expect(activeStage.intent.taskType).toBe("BUG_FIX");
    expect(activeStage.intent.goal).toBe("solve existing repository errors");

    // The effective goal passed to ManifestGenerator must be activeStage.intent.goal
    expect(activeStage.intent.goal).not.toContain("calculator");
    expect(activeStage.intent.goal).not.toContain("CLARIFICATION SO FAR");
  });

  // Test D: After Stage 1 is marked VERIFIED, Stage 2 becomes the next eligible stage
  test("Test D: After Stage 1 is marked VERIFIED, Stage 2 becomes next eligible stage", () => {
    const classification: TaskClassificationResult = {
      taskType: "BUG_FIX",
      risk: "MEDIUM",
      estimatedComplexity: "LARGE",
      intent: "BUG_FIX",
      confidence: 0.95,
      requiresClarification: false,
      reasoning: "Sequential execution",
      stages: [
        {
          id: "stage-1",
          taskType: "BUG_FIX",
          goal: "solve existing repository errors",
          dependsOn: [],
        },
        {
          id: "stage-2",
          taskType: "NEW_FEATURE",
          goal: "create a calculator",
          dependsOn: ["stage-1"],
        },
      ],
    };

    const plan = TaskExecutionPlanManager.createTaskExecutionPlan("test", classification);
    expect(plan.currentStageIndex).toBe(0);
    expect(plan.stages[0].status).toBe("PENDING");

    // Complete and advance Stage 1
    const { plan: advancedPlan, nextStage } = TaskExecutionPlanManager.advancePlanStage(plan);

    expect(advancedPlan.stages[0].status).toBe("VERIFIED");
    expect(advancedPlan.currentStageIndex).toBe(1);
    expect(nextStage).not.toBeNull();
    expect(nextStage!.id).toBe("stage-2");
    expect(nextStage!.intent.taskType).toBe("NEW_FEATURE");
    expect(nextStage!.intent.goal).toBe("create a calculator");
    expect(nextStage!.dependsOn).toEqual(["stage-1"]);
  });

  // Test E: Unseen compound task produces 2 structured stages without keyword hardcoding
  test("Test E: Unseen compound task ('repair the broken authentication flow and then add export support') produces 2 structured stages", () => {
    const unseenMessage = "repair the broken authentication flow and then add export support";

    const classification: TaskClassificationResult = {
      taskType: "BUG_FIX",
      risk: "HIGH",
      estimatedComplexity: "COMPLEX",
      intent: "BUG_FIX",
      confidence: 0.95,
      requiresClarification: false,
      reasoning: "Compound repair and feature",
      stages: [
        {
          id: "stage-1",
          taskType: "BUG_FIX",
          goal: "repair the broken authentication flow",
          dependsOn: [],
        },
        {
          id: "stage-2",
          taskType: "NEW_FEATURE",
          goal: "add export support",
          dependsOn: ["stage-1"],
        },
      ],
    };

    const plan = TaskExecutionPlanManager.createTaskExecutionPlan(unseenMessage, classification);

    expect(plan.stages.length).toBe(2);
    expect(plan.stages[0].intent.taskType).toBe("BUG_FIX");
    expect(plan.stages[0].intent.goal).toBe("repair the broken authentication flow");

    expect(plan.stages[1].intent.taskType).toBe("NEW_FEATURE");
    expect(plan.stages[1].intent.goal).toBe("add export support");
    expect(plan.stages[1].dependsOn).toEqual(["stage-1"]);
  });
});
