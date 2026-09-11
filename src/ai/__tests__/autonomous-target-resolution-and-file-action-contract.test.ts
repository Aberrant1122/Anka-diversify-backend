import fs from "fs";
import path from "path";
import os from "os";
import { DestructiveTargetResolver } from "../contracts/DestructiveTargetResolver";
import {
  EvidenceBoundWriteSetResolver,
  PlannedChange,
} from "../contracts/EvidenceBoundWriteSetResolver";
import { RepositoryEvidenceStore } from "../repository/RepositoryEvidenceStore";
import { PolicyContract } from "../contracts/PolicyContract";
import { TaskIntentSpec } from "../shared/TaskIntentSpec";
import { buildFinalExecutionContract } from "../contracts/ExecutionContractBuilder";
import { TaskExecutionPlanManager } from "../planning/TaskExecutionPlanManager";
import { TaskClassificationResult, FileManifest, ExecutionContract } from "../../types";
import { CodeGenerator } from "../generation/CodeGenerator";

describe("Strict Implementation — Autonomous Target Resolution + File Action Contract", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "autonomous-action-contract-test-"));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  const defaultDeletePolicy: PolicyContract = {
    goal: "remove the calculator",
    taskType: "DELETE_FOLDER",
    risk: "MEDIUM",
    estimatedComplexity: "MEDIUM",
    destructive: true,
    pipeline: "REPOSITORY",
    environment: "REACT_TS",
    allowedActions: [
      "delete_folder",
      "delete_file",
      "remove_imports",
      "update_references",
      "clean_barrel_exports",
      "modify_file",
    ],
    forbiddenActions: ["create_files"],
    maxFiles: 12,
    repositoryRequired: true,
    requiresClarification: false,
    expectedFiles: [],
    validationType: "TYPESCRIPT_BUILD",
    explicitUserPaths: [],
    userConstraints: [],
    diffCriticEnabled: true,
  };

  const defaultDeleteIntent: TaskIntentSpec = {
    goal: "remove the calculator",
    taskType: "DELETE_FOLDER",
    risk: "MEDIUM",
    estimatedComplexity: "MEDIUM",
    destructive: true,
    requiresClarification: false,
    operations: [{ kind: "DELETE", subject: "calculator" }],
    constraints: [],
    acceptanceCriteria: [],
    explicitUserPaths: [],
    reasoning: "Delete calculator feature",
  };

  // Test 1: multiple files -> one logical target -> no clarification
  test("1. multiple files -> one logical target -> no clarification", () => {
    const files = [
      "src/components/calculator/Calculator.tsx",
      "src/components/calculator/index.ts",
      "src/app.ts",
    ];

    const resolution = DestructiveTargetResolver.resolve(
      "remove the calculator",
      files,
      { isDestructive: true, autonomous: true }
    );

    expect(resolution.status).toBe("RESOLVED");
    expect(resolution.requiresClarification).toBe(false);
    expect(resolution.clarificationQuestion).toBeUndefined();
    expect(resolution.clarificationOptions).toBeUndefined();
    expect(resolution.candidatePaths).toEqual([
      "src/components/calculator/Calculator.tsx",
      "src/components/calculator/index.ts",
    ]);
    expect(resolution.resolvedTarget?.actionObligations).toBeDefined();
    const obligations = resolution.resolvedTarget?.actionObligations!;
    expect(obligations).toHaveLength(2);
    expect(obligations.every((o) => o.requiredAction === "delete")).toBe(true);
    expect(obligations.every((o) => o.role === "PRIMARY_TARGET")).toBe(true);
  });

  // Test 2: duplicate logical labels deduplicate -> no clarification
  test("2. duplicate logical labels deduplicate -> no clarification", () => {
    // Two intermediate files in generic directories that normalize to the same logical name "Calculator"
    const files = [
      "src/components/Calculator.tsx",
      "components/Calculator.tsx",
      "src/app.ts",
    ];

    const resolution = DestructiveTargetResolver.resolve(
      "remove the calculator",
      files,
      { isDestructive: true, autonomous: true }
    );

    expect(resolution.status).toBe("RESOLVED");
    expect(resolution.requiresClarification).toBe(false);
    expect(resolution.resolvedTarget?.featureName).toBe("Calculator");
    // Must not return "Multiple matching files ... Calculator"
    expect(resolution.clarificationQuestion).toBeUndefined();
  });

  // Test 3: true unresolved ambiguity -> no picker, controlled failure
  test("3. true unresolved ambiguity -> no picker, controlled failure", () => {
    const files = [
      "components/AdminTaxCalculator.tsx",
      "components/CustomerMortgageCalculator.tsx",
      "src/app.ts",
    ];

    const resolution = DestructiveTargetResolver.resolve(
      "remove the calculator",
      files,
      { isDestructive: true, autonomous: true }
    );

    expect(resolution.status).toBe("AMBIGUOUS");
    // Autonomous mode must not present a UI file picker
    expect(resolution.requiresClarification).toBe(false);
    expect(resolution.clarificationOptions).toBeUndefined();
    expect(resolution.candidatePaths).toEqual([]);
  });

  // Test 4: REMOVE primary target obligation = DELETE
  test("4. REMOVE primary target obligation = DELETE", () => {
    const files = [
      "src/components/calculator/Calculator.tsx",
      "src/components/calculator/index.ts",
    ];
    const evidenceStore = new RepositoryEvidenceStore("test-repo");
    const resolution = DestructiveTargetResolver.resolve(
      "remove the calculator",
      files,
      { isDestructive: true, evidenceStore }
    );

    expect(resolution.status).toBe("RESOLVED");
    const primaryObligations = resolution.resolvedTarget?.actionObligations?.filter(
      (o) => o.role === "PRIMARY_TARGET"
    );
    expect(primaryObligations).toBeDefined();
    expect(primaryObligations!.length).toBeGreaterThan(0);
    for (const obl of primaryObligations!) {
      expect(obl.requiredAction).toBe("delete");
    }
  });

  // Test 5: importer cleanup obligation = MODIFY
  test("5. importer cleanup obligation = MODIFY", () => {
    const files = [
      "src/components/calculator/Calculator.tsx",
      "src/app.ts",
    ];
    const fileContext: Record<string, string> = {
      "src/components/calculator/Calculator.tsx": "export const Calculator = () => null;",
      "src/app.ts": "import { Calculator } from './components/calculator/Calculator';",
    };
    const evidenceStore = new RepositoryEvidenceStore("test-repo");

    const resolution = DestructiveTargetResolver.resolve(
      "remove the calculator",
      files,
      { isDestructive: true, fileContext, evidenceStore }
    );

    expect(resolution.status).toBe("RESOLVED");
    const importerObligations = resolution.resolvedTarget?.actionObligations?.filter(
      (o) => o.role === "DEPENDENCY_CLEANUP"
    );
    expect(importerObligations).toBeDefined();
    expect(importerObligations!).toHaveLength(1);
    expect(importerObligations![0].path).toBe("src/app.ts");
    expect(importerObligations![0].requiredAction).toBe("modify");
  });

  // Test 6: planner MODIFY when DELETE required -> MANIFEST_ACTION_MISMATCH
  test("6. planner MODIFY when DELETE required -> MANIFEST_ACTION_MISMATCH", () => {
    const obligations = [
      {
        path: "src/components/calculator/Calculator.tsx",
        requiredAction: "delete" as const,
        role: "PRIMARY_TARGET" as const,
        evidenceIds: ["evi_1"],
      },
    ];

    // Simulate manifest generator producing "modify" instead of required "delete"
    const proposedManifest: FileManifest = {
      files: [
        {
          path: "src/components/calculator/Calculator.tsx",
          action: "modify",
          description: "Update calculator",
          evidenceIds: ["evi_1"],
          dependencies: [],
        },
      ],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    };

    // Action contract checker logic (reused from AgentPipeline)
    const mismatches: { path: string; expected: string; actual: string }[] = [];
    for (const change of proposedManifest.files) {
      const obl = obligations.find((o) => o.path === change.path);
      if (obl && obl.requiredAction !== change.action) {
        mismatches.push({
          path: change.path,
          expected: obl.requiredAction,
          actual: change.action,
        });
      }
    }

    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toEqual({
      path: "src/components/calculator/Calculator.tsx",
      expected: "delete",
      actual: "modify",
    });
  });

  // Test 7: correct DELETE manifest -> passes write authority
  test("7. correct DELETE manifest -> passes write authority", () => {
    const evidenceStore = new RepositoryEvidenceStore("test-repo");
    const calcEv = evidenceStore.addEvidence({
      kind: "FILE",
      filePath: "src/components/calculator/Calculator.tsx",
      provenance: "REPO_READ",
    });
    const appEv = evidenceStore.addEvidence({
      kind: "IMPORT",
      filePath: "src/app.ts",
      sourceFile: "src/components/calculator/Calculator.tsx",
      provenance: "REPO_READ",
    });

    const obligations = [
      {
        path: "src/components/calculator/Calculator.tsx",
        requiredAction: "delete" as const,
        role: "PRIMARY_TARGET" as const,
        evidenceIds: [calcEv.id],
      },
      {
        path: "src/app.ts",
        requiredAction: "modify" as const,
        role: "DEPENDENCY_CLEANUP" as const,
        evidenceIds: [appEv.id],
      },
    ];

    const proposed: PlannedChange[] = [
      {
        path: "src/components/calculator/Calculator.tsx",
        action: "delete",
        reason: "Delete calculator component",
        evidenceIds: [calcEv.id],
        dependencies: [],
      },
      {
        path: "src/app.ts",
        action: "modify",
        reason: "Remove calculator import",
        evidenceIds: [appEv.id],
        dependencies: [],
      },
    ];

    const intentWithTarget: TaskIntentSpec = {
      ...defaultDeleteIntent,
      resolvedTarget: {
        logicalTargetId: "calc",
        featureName: "Calculator",
        candidatePaths: ["src/components/calculator/Calculator.tsx"],
        evidenceIds: [calcEv.id],
        importerPaths: ["src/app.ts"],
        resolutionSource: "DETERMINISTIC_UNIQUE",
        status: "RESOLVED",
        actionObligations: obligations,
      },
    };

    const authRes = EvidenceBoundWriteSetResolver.resolve({
      policy: defaultDeletePolicy,
      intentSpec: intentWithTarget,
      proposedChanges: proposed,
      evidenceStore,
      existingFiles: ["src/components/calculator/Calculator.tsx", "src/app.ts"],
    });

    expect(authRes.rejectedPaths).toHaveLength(0);
    expect(authRes.approvedPaths).toHaveLength(2);
    expect(authRes.approvedPaths).toContain("src/components/calculator/Calculator.tsx");
    expect(authRes.approvedPaths).toContain("src/app.ts");
  });

  // Test 8: CodeGenerator output is advisory; downstream action authority remains deterministic.
  test("8. CodeGenerator preserves explicit proposal action without treating manifest as authority", async () => {
    const utils = require("../shared/utils");
    utils.getOpenAI = () => ({
      chat: {
        completions: {
          create: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    explanation: "Wrong action modification",
                    commitMessage: "test: propose wrong action",
                    changes: [
                      {
                        path: "src/components/calculator/Calculator.tsx",
                        action: "modify", // Violates approved manifest "delete"
                        description: "Modified calculator instead of deleting",
                        edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }],
                      },
                    ],
                  }),
                },
                finish_reason: "stop",
              },
            ],
          }),
        },
      },
    });

    const contract: ExecutionContract = buildFinalExecutionContract(
      defaultDeletePolicy,
      ["src/components/calculator/Calculator.tsx"],
      ["src/components/calculator/Calculator.tsx"]
    );

    const approvedManifest: FileManifest = {
      files: [
        {
          path: "src/components/calculator/Calculator.tsx",
          action: "delete",
          description: "Delete calculator",
          dependencies: [],
        },
      ],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    };

    const result = await CodeGenerator.generateRoadmapAndDiffs(
      "Delete calculator",
      { intent: "DELETE_FEATURE", taskType: "DELETE_FOLDER" },
      { fileContext: { "src/components/calculator/Calculator.tsx": "const a = 1;" } },
      "system prompt",
      contract,
      approvedManifest,
      {
        "src/components/calculator/Calculator.tsx": {
          path: "src/components/calculator/Calculator.tsx",
          content: "const a = 1;",
          sha256: "sha-1",
        },
      }
    );

    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({
      path: "src/components/calculator/Calculator.tsx",
      action: "modify",
    });
    expect(approvedManifest.files[0].action).toBe("delete");
  });

  // Test 9: action authority is (path, action), not path-only
  test("9. action authority is (path, action), not path-only", () => {
    const evidenceStore = new RepositoryEvidenceStore("test-repo");
    const appEv = evidenceStore.addEvidence({
      kind: "FILE",
      filePath: "src/app.ts",
      provenance: "REPO_READ",
    });

    // src/app.ts is approved ONLY for modify (DEPENDENCY_CLEANUP), NOT for delete
    const obligations = [
      {
        path: "src/app.ts",
        requiredAction: "modify" as const,
        role: "DEPENDENCY_CLEANUP" as const,
        evidenceIds: [appEv.id],
      },
    ];

    const proposedDeleteOfApp: PlannedChange[] = [
      {
        path: "src/app.ts",
        action: "delete",
        reason: "Delete app",
        evidenceIds: [appEv.id],
        dependencies: [],
      },
    ];

    const intentWithTarget: TaskIntentSpec = {
      ...defaultDeleteIntent,
      resolvedTarget: {
        logicalTargetId: "calc",
        featureName: "Calculator",
        candidatePaths: ["src/components/calculator/Calculator.tsx"],
        evidenceIds: [],
        importerPaths: ["src/app.ts"],
        resolutionSource: "DETERMINISTIC_UNIQUE",
        status: "RESOLVED",
        actionObligations: obligations,
      },
    };

    const authRes = EvidenceBoundWriteSetResolver.resolve({
      policy: defaultDeletePolicy,
      intentSpec: intentWithTarget,
      proposedChanges: proposedDeleteOfApp,
      evidenceStore,
      existingFiles: ["src/app.ts"],
    });

    expect(authRes.approvedPaths).toHaveLength(0);
    expect(authRes.rejectedPaths).toHaveLength(1);
    expect(authRes.rejectedPaths[0].path).toBe("src/app.ts");
    expect(authRes.rejectedPaths[0].reason).toContain("NOT_AUTHORIZED_FOR_DELETE");
  });

  // Test 10: DELETE target cannot be changed to MODIFY
  test("10. DELETE target cannot be changed to MODIFY", () => {
    const evidenceStore = new RepositoryEvidenceStore("test-repo");
    const calcEv = evidenceStore.addEvidence({
      kind: "FILE",
      filePath: "src/components/calculator/Calculator.tsx",
      provenance: "REPO_READ",
    });

    const obligations = [
      {
        path: "src/components/calculator/Calculator.tsx",
        requiredAction: "delete" as const,
        role: "PRIMARY_TARGET" as const,
        evidenceIds: [calcEv.id],
      },
    ];

    const proposedModifyOfCalculator: PlannedChange[] = [
      {
        path: "src/components/calculator/Calculator.tsx",
        action: "modify",
        reason: "Modify calculator",
        evidenceIds: [calcEv.id],
        dependencies: [],
      },
    ];

    const intentWithTarget: TaskIntentSpec = {
      ...defaultDeleteIntent,
      resolvedTarget: {
        logicalTargetId: "calc",
        featureName: "Calculator",
        candidatePaths: ["src/components/calculator/Calculator.tsx"],
        evidenceIds: [calcEv.id],
        importerPaths: [],
        resolutionSource: "DETERMINISTIC_UNIQUE",
        status: "RESOLVED",
        actionObligations: obligations,
      },
    };

    const authRes = EvidenceBoundWriteSetResolver.resolve({
      policy: defaultDeletePolicy,
      intentSpec: intentWithTarget,
      proposedChanges: proposedModifyOfCalculator,
      evidenceStore,
      existingFiles: ["src/components/calculator/Calculator.tsx"],
    });

    expect(authRes.approvedPaths).toHaveLength(0);
    expect(authRes.rejectedPaths).toHaveLength(1);
    expect(authRes.rejectedPaths[0].path).toBe("src/components/calculator/Calculator.tsx");
    expect(authRes.rejectedPaths[0].reason).toContain("ACTION_MISMATCH_WITH_INTENT");
  });

  // Test 11: MODIFY importer cannot be changed to DELETE
  test("11. MODIFY importer cannot be changed to DELETE", () => {
    const evidenceStore = new RepositoryEvidenceStore("test-repo");
    const appEv = evidenceStore.addEvidence({
      kind: "FILE",
      filePath: "src/app.ts",
      provenance: "REPO_READ",
    });

    const obligations = [
      {
        path: "src/app.ts",
        requiredAction: "modify" as const,
        role: "DEPENDENCY_CLEANUP" as const,
        evidenceIds: [appEv.id],
      },
    ];

    const proposedDeleteOfApp: PlannedChange[] = [
      {
        path: "src/app.ts",
        action: "delete",
        reason: "Attempting to delete importer instead of cleaning it up",
        evidenceIds: [appEv.id],
        dependencies: [],
      },
    ];

    const intentWithTarget: TaskIntentSpec = {
      ...defaultDeleteIntent,
      resolvedTarget: {
        logicalTargetId: "calc",
        featureName: "Calculator",
        candidatePaths: ["src/components/calculator/Calculator.tsx"],
        evidenceIds: [],
        importerPaths: ["src/app.ts"],
        resolutionSource: "DETERMINISTIC_UNIQUE",
        status: "RESOLVED",
        actionObligations: obligations,
      },
    };

    const authRes = EvidenceBoundWriteSetResolver.resolve({
      policy: defaultDeletePolicy,
      intentSpec: intentWithTarget,
      proposedChanges: proposedDeleteOfApp,
      evidenceStore,
      existingFiles: ["src/app.ts"],
    });

    expect(authRes.approvedPaths).toHaveLength(0);
    expect(authRes.rejectedPaths).toHaveLength(1);
    expect(authRes.rejectedPaths[0].path).toBe("src/app.ts");
    expect(authRes.rejectedPaths[0].reason).toContain("NOT_AUTHORIZED_FOR_DELETE");
  });

  // Test 12: exact compound remove-calculator/add-todo scenario
  test("12. exact compound remove-calculator/add-todo scenario", () => {
    const compoundMessage = "remove the calculator and add a todo list";
    const classification: TaskClassificationResult = {
      taskType: "NEW_FEATURE",
      risk: "MEDIUM",
      estimatedComplexity: "MEDIUM",
      intent: "NEW_FEATURE",
      confidence: 0.95,
      requiresClarification: false,
      reasoning: "Compound task: delete calculator, create todo list",
      stages: [
        {
          id: "stage-1",
          name: "remove the calculator",
          taskType: "DELETE_FOLDER",
          goal: "remove the calculator",
          targetPath: "src/components/calculator/Calculator.tsx",
          dependsOn: [],
        },
        {
          id: "stage-2",
          name: "add a todo list",
          taskType: "NEW_FEATURE",
          goal: "add a todo list",
          targetPath: "src/components/todo/TodoList.tsx",
          dependsOn: ["stage-1"],
        },
      ],
    };

    const plan = TaskExecutionPlanManager.createTaskExecutionPlan(compoundMessage, classification);
    expect(plan.stages).toHaveLength(2);
    expect(plan.stages[0].id).toBe("stage-1");
    expect(plan.stages[0].intent.taskType).toBe("DELETE_FOLDER");
    expect(plan.stages[1].id).toBe("stage-2");
    expect(plan.stages[1].intent.taskType).toBe("NEW_FEATURE");

    // Stage 1 is eligible first
    expect(TaskExecutionPlanManager.isStageEligible(plan, "stage-1")).toBe(true);
    expect(TaskExecutionPlanManager.isStageEligible(plan, "stage-2")).toBe(false);

    // After Stage 1 completes, Stage 2 becomes eligible
    const { plan: advancedPlan, nextStage } = TaskExecutionPlanManager.advancePlanStage(plan);
    expect(advancedPlan.stages[0].status).toBe("VERIFIED");
    expect(nextStage?.id).toBe("stage-2");
    expect(TaskExecutionPlanManager.isStageEligible(advancedPlan, "stage-2")).toBe(true);
  });

  // Test 13: no user clarification in exact live scenario
  test("13. no user clarification in exact live scenario", () => {
    const liveRepoFiles = [
      "src/components/calculator/Calculator.tsx",
      "src/components/calculator/index.ts",
      "src/app.ts",
    ];

    const fileContext: Record<string, string> = {
      "src/components/calculator/Calculator.tsx": "export const Calculator = () => null;",
      "src/components/calculator/index.ts": "export * from './Calculator';",
      "src/app.ts": "import { Calculator } from './components/calculator/Calculator';",
    };

    const resolution = DestructiveTargetResolver.resolve(
      "remove the calculator",
      liveRepoFiles,
      { isDestructive: true, autonomous: true, fileContext }
    );

    expect(resolution.status).toBe("RESOLVED");
    expect(resolution.requiresClarification).toBe(false);
    expect(resolution.clarificationQuestion).toBeUndefined();
    expect(resolution.clarificationOptions).toBeUndefined();
    expect(resolution.resolvedTarget?.candidatePaths).toEqual([
      "src/components/calculator/Calculator.tsx",
      "src/components/calculator/index.ts",
    ]);
  });

  // Test 14: zero mutations on action mismatch
  test("14. zero mutations on action mismatch", () => {
    const targetFile = path.join(tempDir, "Calculator.tsx");
    const originalContent = "export const Calculator = () => 42;";
    fs.writeFileSync(targetFile, originalContent);

    // Attempting an unauthorized action must throw before disk modification
    const obligations = [
      {
        path: "Calculator.tsx",
        requiredAction: "delete" as const,
        role: "PRIMARY_TARGET" as const,
        evidenceIds: ["evi_1"],
      },
    ];

    const proposedChange: PlannedChange = {
      path: "Calculator.tsx",
      action: "modify", // Mismatched action
      reason: "Unauthorized modification of delete target",
      evidenceIds: ["evi_1"],
      dependencies: [],
    };

    const evidenceStore = new RepositoryEvidenceStore("test-repo");
    evidenceStore.addEvidence({
      kind: "FILE",
      filePath: "Calculator.tsx",
      provenance: "REPO_READ",
    });

    const intentWithTarget: TaskIntentSpec = {
      ...defaultDeleteIntent,
      resolvedTarget: {
        logicalTargetId: "calc",
        featureName: "Calculator",
        candidatePaths: ["Calculator.tsx"],
        evidenceIds: ["evi_1"],
        importerPaths: [],
        resolutionSource: "DETERMINISTIC_UNIQUE",
        status: "RESOLVED",
        actionObligations: obligations,
      },
    };

    const authRes = EvidenceBoundWriteSetResolver.resolve({
      policy: defaultDeletePolicy,
      intentSpec: intentWithTarget,
      proposedChanges: [proposedChange],
      evidenceStore,
      existingFiles: ["Calculator.tsx"],
    });

    expect(authRes.approvedPaths).toHaveLength(0);
    expect(authRes.rejectedPaths).toHaveLength(1);

    // Verify 0 disk mutations occurred
    const diskContent = fs.readFileSync(targetFile, "utf-8");
    expect(diskContent).toBe(originalContent);
  });
});
