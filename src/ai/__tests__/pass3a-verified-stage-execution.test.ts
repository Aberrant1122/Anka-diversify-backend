import fs from "fs";
import path from "path";
import os from "os";
import { StageExecutionTransaction, StageVerificationGate } from "../orchestration/StageExecutionTransaction";
import { TaskExecutionPlanManager } from "../planning/TaskExecutionPlanManager";
import { TaskClassificationResult, AgentFileChange } from "../../types";
import { AuthorizedCapabilityScope, CapabilityAction, CapabilityGuard } from "../runtime/CapabilityGuard";

describe("Strict Implementation Pass 3A — Verified Stage Execution + Checkpoint Rollback", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pass3a-test-"));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function authorizedTransaction(stageId: string, root: string, changes: AgentFileChange[]) {
    const grants = changes.map((change) => ({
      path: change.path,
      action: (change.action === "delete" || change.isDeleted
        ? "FILE_DELETE"
        : change.action === "create"
          ? "FILE_CREATE"
          : "FILE_MODIFY") as CapabilityAction,
    }));
    const scope = AuthorizedCapabilityScope.fromBackendConfiguration({ workspaceRoot: root, authorityId: `pass3a:${stageId}`, grants });
    if (!scope) throw new Error("test capability scope must be valid");
    return StageExecutionTransaction.startTransaction(
      stageId,
      root,
      CapabilityGuard.create({ workspaceRoot: root, scopeId: stageId, authorizedScope: scope }),
    );
  }

  // Test 1: Only active stage executes
  test("1. Only active stage executes with its own intent", () => {
    const classification: TaskClassificationResult = {
      taskType: "BUG_FIX",
      risk: "MEDIUM",
      estimatedComplexity: "LARGE",
      intent: "BUG_FIX",
      confidence: 0.9,
      requiresClarification: false,
      reasoning: "Compound repair and feature creation",
      stages: [
        {
          id: "stage-1-repair",
          taskType: "BUG_FIX",
          goal: "repair existing repository errors",
          dependsOn: [],
        },
        {
          id: "stage-2-create",
          taskType: "NEW_FEATURE",
          goal: "create a calculator",
          dependsOn: ["stage-1-repair"],
        },
      ],
    };

    const plan = TaskExecutionPlanManager.createTaskExecutionPlan("test", classification);
    const activeStage = plan.stages[plan.currentStageIndex];

    expect(activeStage.id).toBe("stage-1-repair");
    expect(activeStage.intent.goal).toBe("repair existing repository errors");
    expect(activeStage.intent.taskType).toBe("BUG_FIX");
    // Stage 2 remains unexecuted and pending
    expect(plan.stages[1].status).toBe("PENDING");
  });

  // Test 2: Dependencies block later stage
  test("2. Later stage is blocked until dependencies are VERIFIED", () => {
    const classification: TaskClassificationResult = {
      taskType: "BUG_FIX",
      risk: "MEDIUM",
      estimatedComplexity: "LARGE",
      intent: "BUG_FIX",
      confidence: 0.9,
      requiresClarification: false,
      reasoning: "Compound task",
      stages: [
        {
          id: "stage-1",
          taskType: "BUG_FIX",
          goal: "repair errors",
          dependsOn: [],
        },
        {
          id: "stage-2",
          taskType: "NEW_FEATURE",
          goal: "create feature",
          dependsOn: ["stage-1"],
        },
      ],
    };

    const plan = TaskExecutionPlanManager.createTaskExecutionPlan("test", classification);

    // While stage-1 is PENDING, stage-2 must NOT be eligible
    expect(TaskExecutionPlanManager.isStageEligible(plan, "stage-1")).toBe(true);
    expect(TaskExecutionPlanManager.isStageEligible(plan, "stage-2")).toBe(false);

    // While stage-1 is RUNNING, stage-2 must still NOT be eligible
    const runningPlan = TaskExecutionPlanManager.markStageStatus(plan, "stage-1", "RUNNING");
    expect(TaskExecutionPlanManager.isStageEligible(runningPlan, "stage-2")).toBe(false);

    // While stage-1 is FAILED, stage-2 must NOT be eligible
    const failedPlan = TaskExecutionPlanManager.markStageStatus(plan, "stage-1", "FAILED");
    expect(TaskExecutionPlanManager.isStageEligible(failedPlan, "stage-2")).toBe(false);
  });

  // Test 3: Verified stage advances plan
  test("3. Verified stage advances plan and makes dependent stage eligible", () => {
    const classification: TaskClassificationResult = {
      taskType: "BUG_FIX",
      risk: "MEDIUM",
      estimatedComplexity: "LARGE",
      intent: "BUG_FIX",
      confidence: 0.9,
      requiresClarification: false,
      reasoning: "Compound task",
      stages: [
        {
          id: "stage-1",
          taskType: "BUG_FIX",
          goal: "repair errors",
          dependsOn: [],
        },
        {
          id: "stage-2",
          taskType: "NEW_FEATURE",
          goal: "create calculator",
          dependsOn: ["stage-1"],
        },
      ],
    };

    const plan = TaskExecutionPlanManager.createTaskExecutionPlan("test", classification);
    const { plan: advancedPlan, nextStage } = TaskExecutionPlanManager.advancePlanStage(plan);

    expect(advancedPlan.stages[0].status).toBe("VERIFIED");
    expect(advancedPlan.currentStageIndex).toBe(1);
    expect(nextStage).not.toBeNull();
    expect(nextStage!.id).toBe("stage-2");

    // Now stage-2 IS eligible because stage-1 is VERIFIED
    expect(TaskExecutionPlanManager.isStageEligible(advancedPlan, "stage-2")).toBe(true);
  });

  // Test 4: Failed stage blocks dependent stage
  test("4. Failed stage blocks dependent stages from executing", () => {
    const classification: TaskClassificationResult = {
      taskType: "BUG_FIX",
      risk: "MEDIUM",
      estimatedComplexity: "LARGE",
      intent: "BUG_FIX",
      confidence: 0.9,
      requiresClarification: false,
      reasoning: "Compound task",
      stages: [
        {
          id: "stage-1",
          taskType: "BUG_FIX",
          goal: "repair errors",
          dependsOn: [],
        },
        {
          id: "stage-2",
          taskType: "NEW_FEATURE",
          goal: "create calculator",
          dependsOn: ["stage-1"],
        },
        {
          id: "stage-3",
          taskType: "REFACTOR",
          goal: "refactor calculator styles",
          dependsOn: ["stage-2"],
        },
      ],
    };

    const plan = TaskExecutionPlanManager.createTaskExecutionPlan("test", classification);
    const failedPlan = TaskExecutionPlanManager.failStage(plan, "stage-1");

    expect(failedPlan.status).toBe("FAILED");
    expect(failedPlan.stages[0].status).toBe("FAILED");
    expect(TaskExecutionPlanManager.isStageEligible(failedPlan, "stage-2")).toBe(false);
    expect(TaskExecutionPlanManager.isStageEligible(failedPlan, "stage-3")).toBe(false);

    const dependents = TaskExecutionPlanManager.getDependentStages(failedPlan, "stage-1");
    expect(dependents).toContain("stage-2");
    expect(dependents).toContain("stage-3");
  });

  // Test 5: Exact rollback restores modified file
  test("5. Exact rollback restores modified file to pre-stage content", async () => {
    const filePath = path.join(tempDir, "app/page.tsx");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "const Page = () => 'original';", "utf8");

    // Apply modification
    const change: AgentFileChange = {
      path: "app/page.tsx",
      content: "const Page = () => 'broken modification';",
      action: "modify",
      description: "modify page",
    };
    const transaction = await authorizedTransaction("stage-1", tempDir, [change]);
    await transaction.apply([change]);

    expect(fs.readFileSync(filePath, "utf8")).toBe("const Page = () => 'broken modification';");

    // Rollback
    await transaction.rollback();

    expect(fs.readFileSync(filePath, "utf8")).toBe("const Page = () => 'original';");
    expect(transaction.isRolledBack()).toBe(true);
  });

  // Test 6: Exact rollback removes created file
  test("6. Exact rollback removes newly created file", async () => {
    const createdPath = path.join(tempDir, "components/Calculator.tsx");
    const change: AgentFileChange = {
      path: "components/Calculator.tsx",
      content: "export const Calculator = () => null;",
      action: "create",
      description: "create calculator",
    };
    const transaction = await authorizedTransaction("stage-1", tempDir, [change]);
    await transaction.apply([change]);

    expect(fs.existsSync(createdPath)).toBe(true);

    // Rollback
    await transaction.rollback();

    expect(fs.existsSync(createdPath)).toBe(false);
  });

  // Test 7: Stage 2 rollback preserves Stage 1 verified state
  test("7. Stage 2 rollback preserves Stage 1 verified state", async () => {
    const pageFile = path.join(tempDir, "app/page.tsx");
    fs.mkdirSync(path.dirname(pageFile), { recursive: true });
    fs.writeFileSync(pageFile, "const Page = () => 'v0-initial';", "utf8");

    // Stage 1 executes and modifies app/page.tsx
    const stage1Changes: AgentFileChange[] = [
      {
        path: "app/page.tsx",
        content: "const Page = () => 'v1-stage1-verified';",
        action: "modify",
        description: "stage 1 repair",
      },
    ];
    const tx1 = await authorizedTransaction("stage-1", tempDir, stage1Changes);
    await tx1.apply(stage1Changes);

    // Stage 1 passes verification
    const gate1 = StageVerificationGate.evaluate({
      repairSuccess: true,
      securityPass: true,
      featureValidationPassed: true,
    });
    expect(gate1.passed).toBe(true);
    await tx1.commit();

    expect(fs.readFileSync(pageFile, "utf8")).toBe("const Page = () => 'v1-stage1-verified';");

    // Stage 2 executes: creates Calculator.tsx and attempts another edit
    const calcFile = path.join(tempDir, "components/Calculator.tsx");
    const stage2Changes: AgentFileChange[] = [
      {
        path: "components/Calculator.tsx",
        content: "export const Calculator = () => <div>calc</div>;",
        action: "create",
        description: "stage 2 create calculator",
      },
    ];
    const tx2 = await authorizedTransaction("stage-2", tempDir, stage2Changes);
    await tx2.apply(stage2Changes);

    expect(fs.existsSync(calcFile)).toBe(true);

    // Stage 2 fails verification
    const gate2 = StageVerificationGate.evaluate({
      repairSuccess: false,
      securityPass: true,
      featureValidationPassed: false,
      hasBuildErrors: true,
    });
    expect(gate2.passed).toBe(false);

    // Rollback Stage 2
    await tx2.rollback();

    // Critical assertion: Calculator.tsx is removed, but app/page.tsx preserves Stage 1 verified content
    expect(fs.existsSync(calcFile)).toBe(false);
    expect(fs.readFileSync(pageFile, "utf8")).toBe("const Page = () => 'v1-stage1-verified';");
  });

  // Test 8: Unexpected exception rolls back
  test("8. Unexpected exception triggers stage rollback", async () => {
    const file = path.join(tempDir, "src/temp.ts");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "export const a = 1;", "utf8");

    const crashChanges: AgentFileChange[] = [
      {
        path: "src/temp.ts",
        content: "export const a = 999;",
        action: "modify",
        description: "crash attempt",
      },
    ];
    const tx = await authorizedTransaction("stage-crash", tempDir, crashChanges);

    try {
      await tx.apply(crashChanges);
      throw new Error("UNEXPECTED_PIPELINE_CRASH");
    } catch {
      await tx.rollback();
    }

    expect(fs.readFileSync(file, "utf8")).toBe("export const a = 1;");
    expect(tx.isRolledBack()).toBe(true);
  });

  // Test 9: Retry starts clean
  test("9. Retry after rollback starts from clean initial state without artifacts", async () => {
    const existingFile = path.join(tempDir, "src/index.ts");
    fs.mkdirSync(path.dirname(existingFile), { recursive: true });
    fs.writeFileSync(existingFile, "console.log('init');", "utf8");

    // Attempt 1: fails
    const attempt1Changes: AgentFileChange[] = [
      { path: "src/index.ts", content: "console.log('bad');", action: "modify", description: "bad mod" },
      { path: "src/orphan.ts", content: "export const orphan = true;", action: "create", description: "bad orphan" },
    ];
    const txAttempt1 = await authorizedTransaction("stage-1", tempDir, attempt1Changes);
    await txAttempt1.apply(attempt1Changes);
    await txAttempt1.rollback();

    expect(fs.readFileSync(existingFile, "utf8")).toBe("console.log('init');");
    expect(fs.existsSync(path.join(tempDir, "src/orphan.ts"))).toBe(false);

    // Attempt 2 (retry): succeeds cleanly
    const attempt2Changes: AgentFileChange[] = [
      { path: "src/index.ts", content: "console.log('good');", action: "modify", description: "good mod" },
    ];
    const txAttempt2 = await authorizedTransaction("stage-1", tempDir, attempt2Changes);
    await txAttempt2.apply(attempt2Changes);
    await txAttempt2.commit();

    expect(fs.readFileSync(existingFile, "utf8")).toBe("console.log('good');");
    expect(fs.existsSync(path.join(tempDir, "src/orphan.ts"))).toBe(false);
  });

  // Test 10: Single-stage task still works
  test("10. Single-stage non-compound task works directly", () => {
    const classification: TaskClassificationResult = {
      taskType: "BUG_FIX",
      risk: "LOW",
      estimatedComplexity: "SMALL",
      intent: "BUG_FIX",
      confidence: 0.95,
      requiresClarification: false,
      reasoning: "Single typo fix",
      stages: [
        {
          id: "stage-single",
          taskType: "BUG_FIX",
          goal: "fix single typo",
          dependsOn: [],
        },
      ],
    };

    const plan = TaskExecutionPlanManager.createTaskExecutionPlan("fix typo", classification);
    expect(plan.stages.length).toBe(1);
    expect(TaskExecutionPlanManager.isStageEligible(plan, "stage-single")).toBe(true);

    const { plan: advancedPlan, nextStage } = TaskExecutionPlanManager.advancePlanStage(plan);
    expect(advancedPlan.stages[0].status).toBe("VERIFIED");
    expect(nextStage).toBeNull();
    expect(advancedPlan.status).toBe("COMPLETED");
  });

  // Test 11: Multi-repo checkpoint isolation
  test("11. Multi-repo checkpoint isolation: rollback in Repo A does not touch Repo B", async () => {
    const repoA = path.join(tempDir, "repo-a");
    const repoB = path.join(tempDir, "repo-b");
    fs.mkdirSync(repoA, { recursive: true });
    fs.mkdirSync(repoB, { recursive: true });

    const fileA = path.join(repoA, "serviceA.ts");
    const fileB = path.join(repoB, "serviceB.ts");
    fs.writeFileSync(fileA, "content A original", "utf8");
    fs.writeFileSync(fileB, "content B original", "utf8");

    const changesA: AgentFileChange[] = [{ path: "serviceA.ts", content: "content A modified", action: "modify", description: "repo A mod" }];
    const changesB: AgentFileChange[] = [{ path: "serviceB.ts", content: "content B modified", action: "modify", description: "repo B mod" }];
    const txA = await authorizedTransaction("stage-a", repoA, changesA);
    const txB = await authorizedTransaction("stage-b", repoB, changesB);

    await txA.apply(changesA);
    await txB.apply(changesB);

    // Rollback Repo A only
    await txA.rollback();

    // Repo A restored, Repo B remains modified
    expect(fs.readFileSync(fileA, "utf8")).toBe("content A original");
    expect(fs.readFileSync(fileB, "utf8")).toBe("content B modified");

    // Commit Repo B
    await txB.commit();
    expect(fs.readFileSync(fileB, "utf8")).toBe("content B modified");
  });

  // Test 12: Calculator planning does not start before repair verified
  test("12. Calculator planning does not start before repair stage is verified", () => {
    const classification: TaskClassificationResult = {
      taskType: "BUG_FIX",
      risk: "MEDIUM",
      estimatedComplexity: "LARGE",
      intent: "BUG_FIX",
      confidence: 0.9,
      requiresClarification: false,
      reasoning: "Compound request with repair and calculator creation",
      stages: [
        {
          id: "stage-repair",
          taskType: "BUG_FIX",
          goal: "solve existing repository errors",
          dependsOn: [],
        },
        {
          id: "stage-calculator",
          taskType: "NEW_FEATURE",
          goal: "create a calculator",
          dependsOn: ["stage-repair"],
        },
      ],
    };

    const plan = TaskExecutionPlanManager.createTaskExecutionPlan("fix errors and create calculator", classification);

    // Initial check: only stage-repair is eligible
    expect(TaskExecutionPlanManager.isStageEligible(plan, "stage-repair")).toBe(true);
    expect(TaskExecutionPlanManager.isStageEligible(plan, "stage-calculator")).toBe(false);

    // Active stage intent is strictly repair
    const activeStage = plan.stages[plan.currentStageIndex];
    expect(activeStage.id).toBe("stage-repair");
    expect(activeStage.intent.goal).toBe("solve existing repository errors");

    // If repair fails: calculator NEVER becomes eligible
    const failedPlan = TaskExecutionPlanManager.failStage(plan, "stage-repair");
    expect(TaskExecutionPlanManager.isStageEligible(failedPlan, "stage-calculator")).toBe(false);
  });
});
