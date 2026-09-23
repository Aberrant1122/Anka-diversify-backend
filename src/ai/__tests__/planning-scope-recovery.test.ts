import fs from "fs";
import os from "os";
import path from "path";
import { EvidenceBoundWriteSetResolver } from "../contracts/EvidenceBoundWriteSetResolver";
import { PolicyContract } from "../contracts/PolicyContract";
import { DeterministicRelationEvidenceAcquirer } from "../contracts/DeterministicRelationEvidenceAcquirer";
import { AgentLoopCoordinator } from "../orchestration/AgentLoopCoordinator";
import {
  classifyWriteRejection,
  computeManifestAttemptFingerprint,
  createCanonicalPlanRecoveryEvent,
  formatPlanningFailureContext,
  isTaskLevelActionProhibition,
  PlanningFailureFact,
  StagePlanningRecoveryRecord,
} from "../planning/PlanningFailureFacts";
import { AgentWorkspaceState } from "../runtime/AgentWorkspaceState";
import { TaskRuntime } from "../runtime/TaskRuntime";
import { WorkingPlan } from "../runtime/WorkingPlan";
import { RepositoryEvidenceStore } from "../repository/RepositoryEvidenceStore";
import { bindUserRequest } from "../repository/TrustedTaskContext";
import { createTaskIntentSpec } from "../shared/TaskIntentSpec";
import { AgentResponse, TaskExecutionPlan } from "../../types";

const scopeFact = (
  pathName: string,
  reasonCode: Parameters<typeof classifyWriteRejection>[0],
): PlanningFailureFact => ({
  kind: "AUTHORITY_REJECTION",
  affectedPath: pathName,
  action: "create",
  reasonCode,
  reason: reasonCode,
  classification: classifyWriteRejection(reasonCode),
});

const stagePlan = (firstStatus: "PENDING" | "RUNNING" | "VERIFIED" = "VERIFIED"): TaskExecutionPlan => ({
  id: "scope-plan",
  goal: "Add a generic widget",
  currentStageIndex: 1,
  status: "RUNNING",
  stages: [
    {
      id: "stage-1",
      name: "Preserved prerequisite",
      intent: createTaskIntentSpec("prepare existing application", {
        taskType: "NEW_FEATURE",
        intent: "NEW_FEATURE",
        risk: "LOW",
        estimatedComplexity: "SMALL",
        confidence: 1,
        requiresClarification: false,
        reasoning: "fixture",
      }, []),
      dependsOn: [],
      status: firstStatus,
    },
    {
      id: "stage-2",
      name: "Add widget",
      intent: createTaskIntentSpec("add generic widget", {
        taskType: "NEW_FEATURE",
        intent: "NEW_FEATURE",
        risk: "LOW",
        estimatedComplexity: "SMALL",
        confidence: 1,
        requiresClarification: false,
        reasoning: "fixture",
      }, []),
      dependsOn: ["stage-1"],
      status: "RUNNING",
    },
  ],
});

const scopeFailure = (
  fingerprint: string,
  reasonCode: Parameters<typeof classifyWriteRejection>[0] = "NO_EVIDENCE_IDS_CITED",
): AgentResponse => ({
  explanation: "Internal planning candidate rejection",
  changes: [],
  commitMessage: "",
  sessionId: "scope-session",
  errorCode: "PLANNING_REINVESTIGATION_REQUIRED",
  lifecycleStage: "ManifestValidationFailed",
  manifestFingerprint: fingerprint,
  repositoryRevision: "revision-1",
  planningFailureFacts: [scopeFact("src/components/Widget.tsx", reasonCode)],
  rejectedPaths: [{
    path: "src/components/Widget.tsx",
    action: "create",
    reasonCode,
    reason: reasonCode,
    classification: classifyWriteRejection(reasonCode),
  }],
  taskExecutionPlan: stagePlan(),
  compoundTaskStatus: "RUNNING",
  buildVerified: false,
});

function runtime(root: string): TaskRuntime {
  const value = TaskRuntime.create({
    taskId: `scope-${path.basename(root)}`,
    originalGoal: "Add a generic widget",
    workspace: AgentWorkspaceState.create({ projectId: "scope-project", root }),
  });
  value.start();
  return value;
}

describe("Checkpoint B planning-scope recovery", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "anka-scope-recovery-"));
    fs.mkdirSync(path.join(tempDir, "src", "components"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, "src", "App.tsx"), "export const App = () => null;", "utf8");
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test("typed resolver metadata preserves approved/rejected decisions and partial behavior", () => {
    const request = "create src/components/Widget.tsx";
    const intent = createTaskIntentSpec(request, {
      taskType: "NEW_FEATURE",
      intent: "NEW_FEATURE",
      risk: "LOW",
      estimatedComplexity: "SMALL",
      confidence: 1,
      requiresClarification: false,
      reasoning: "fixture",
    }, ["src/components/Widget.tsx"]);
    bindUserRequest(intent, request);
    const store = new RepositoryEvidenceStore("scope-project", tempDir);
    const acquired = DeterministicRelationEvidenceAcquirer.acquire({
      candidatePaths: ["src/components/Widget.tsx", "src/Unrelated.tsx"],
      intentSpec: intent,
      evidenceStore: store,
      repositoryId: "scope-project",
      workspaceRoot: tempDir,
      existingFiles: ["src/App.tsx"],
    });
    const policy: PolicyContract = {
      goal: request,
      taskType: "NEW_FEATURE",
      risk: "LOW",
      estimatedComplexity: "SMALL",
      destructive: false,
      allowedActions: ["create", "modify"],
      forbiddenActions: [],
      maxFiles: 4,
      diffCriticEnabled: false,
      pipeline: "REPOSITORY",
      environment: "REACT_TS",
      repositoryRequired: true,
      expectedFiles: [],
      validationType: "NONE",
      explicitUserPaths: ["src/components/Widget.tsx"],
      userConstraints: [],
      requiresClarification: false,
    };

    const result = EvidenceBoundWriteSetResolver.resolve({
      policy,
      intentSpec: intent,
      proposedChanges: [
        {
          path: "src/components/Widget.tsx",
          action: "create",
          reason: "requested widget",
          evidenceIds: [...(acquired.get("src/components/Widget.tsx") || [])],
          dependencies: [],
        },
        {
          path: "src/Unrelated.tsx",
          action: "modify",
          reason: "unrelated candidate",
          evidenceIds: [],
          dependencies: [],
        },
      ],
      evidenceStore: store,
      existingFiles: ["src/App.tsx"],
      workspaceRoot: tempDir,
      targetRepositoryId: "scope-project",
      stageId: "stage-2",
    });

    expect(result.approvedPaths).toEqual(["src/components/Widget.tsx"]);
    expect(result.rejectedPaths.map(({ path: rejectedPath }) => rejectedPath)).toEqual(["src/Unrelated.tsx"]);
    expect(result.rejectedPaths[0]).toMatchObject({
      action: "modify",
      reasonCode: "NO_EVIDENCE_IDS_CITED",
      reason: "Proposed change cited no evidence IDs",
    });
  });

  test("deterministic classification separates recoverable, hard, and terminal failures", () => {
    expect(classifyWriteRejection("NO_EVIDENCE_IDS_CITED")).toBe("RECOVERABLE_CANDIDATE");
    expect(classifyWriteRejection("NO_TASK_OR_STRUCTURAL_RELATION")).toBe("HARD_CANDIDATE");
    expect(classifyWriteRejection("MULTI_REPO_ISOLATION_VIOLATION")).toBe("HARD_CANDIDATE");
    expect(classifyWriteRejection("ACTION_NOT_ALLOWED_BY_POLICY")).toBe("HARD_CANDIDATE");
    expect(classifyWriteRejection("POLICY_BLOCKED_UNKNOWN_OR_CLARIFICATION")).toBe("TERMINAL_TASK");
    expect(classifyWriteRejection("AUTHORITY_WORKSPACE_MISMATCH")).toBe("TERMINAL_TASK");
    expect(classifyWriteRejection("UNCLASSIFIED_AUTHORIZATION_FAILURE")).toBe("TERMINAL_TASK");
    expect(isTaskLevelActionProhibition(
      { action: "delete", reasonCode: "ACTION_NOT_ALLOWED_BY_POLICY" },
      ["DELETE"],
    )).toBe(true);
    expect(isTaskLevelActionProhibition(
      { action: "delete", reasonCode: "ACTION_NOT_ALLOWED_BY_POLICY" },
      ["MODIFY"],
    )).toBe(false);
  });

  test("candidate-level scope failure uses the existing coordinator recovery and fresh iterations", async () => {
    const taskRuntime = runtime(tempDir);
    let attempts = 0;
    const freshAuthorizationRuns: object[] = [];
    const result = await AgentLoopCoordinator.runPipeline({
      runtime: taskRuntime,
      workingPlan: WorkingPlan.create({ id: "scope-retry-plan" }),
      maxIterations: 4,
      observe: async () => ({ workspace: taskRuntime.workspaceState(), revision: "revision-1" }),
      executeIteration: async () => {
        attempts += 1;
        freshAuthorizationRuns.push({ attempt: attempts });
        if (attempts === 1) return { response: scopeFailure("stage-2@revision-1:CREATE:src/components/Widget.tsx") };
        return {
          response: {
            explanation: "Recovered using a different topology",
            changes: [{ path: "src/App.tsx", action: "modify", content: "updated", description: "integrate" }],
            commitMessage: "feat: integrate widget",
            sessionId: "scope-session",
            taskExecutionPlan: stagePlan(),
            compoundTaskStatus: "VERIFIED",
            buildVerified: true,
          },
          journalEntry: {
            journalId: "scope-journal",
            sequence: 1,
            actionGroupId: "scope-action",
            status: "VERIFIED" as const,
            validation: { passed: true, checks: [] },
            attemptedActions: [{ path: "src/App.tsx", action: "modify" as const }],
          } as never,
        };
      },
    });

    expect(attempts).toBe(2);
    expect(freshAuthorizationRuns).toHaveLength(2);
    expect(freshAuthorizationRuns[0]).not.toBe(freshAuthorizationRuns[1]);
    expect(result.loop.outcome).toBe("AWAITING_COMPLETION_EVALUATION");
  });

  test("task-terminal scope rejection does not retry", async () => {
    const taskRuntime = runtime(tempDir);
    let attempts = 0;
    const terminal = scopeFailure("terminal-fingerprint", "POLICY_BLOCKED_UNKNOWN_OR_CLARIFICATION");
    terminal.errorCode = "PLANNING_SCOPE_REJECTED";
    const result = await AgentLoopCoordinator.runPipeline({
      runtime: taskRuntime,
      workingPlan: WorkingPlan.create({ id: "scope-terminal-plan" }),
      maxIterations: 4,
      observe: async () => ({ workspace: taskRuntime.workspaceState(), revision: "revision-1" }),
      executeIteration: async () => {
        attempts += 1;
        return { response: terminal };
      },
    });

    expect(attempts).toBe(1);
    expect(result.loop.outcome).toBe("VALIDATION_FAILURE");
    expect(result.loop.failureCode).toBe("PLANNING_SCOPE_REJECTED");
  });

  test("unchanged A and oscillating A-B-A are blocked from full stage history", async () => {
    for (const fingerprints of [["A", "A"], ["A", "B", "A"]]) {
      const taskRuntime = runtime(tempDir);
      let index = 0;
      const result = await AgentLoopCoordinator.runPipeline({
        runtime: taskRuntime,
        workingPlan: WorkingPlan.create({ id: `duplicate-${fingerprints.join("-")}` }),
        maxIterations: 5,
        observe: async () => ({ workspace: taskRuntime.workspaceState(), revision: "revision-1" }),
        executeIteration: async () => ({ response: scopeFailure(fingerprints[index++]) }),
      });
      expect(result.loop.failureCode).toBe("DUPLICATE_RECOVERY_PLAN");
      expect(index).toBe(fingerprints.length);
    }
  });

  test("three distinct scope failures exhaust exactly three outer attempts without mutation", async () => {
    const taskRuntime = runtime(tempDir);
    let attempts = 0;
    const result = await AgentLoopCoordinator.runPipeline({
      runtime: taskRuntime,
      workingPlan: WorkingPlan.create({ id: "scope-budget-plan" }),
      maxIterations: 8,
      observe: async () => ({ workspace: taskRuntime.workspaceState(), revision: "revision-1" }),
      executeIteration: async () => {
        attempts += 1;
        return { response: scopeFailure(`topology-${attempts}`) };
      },
    });

    expect(attempts).toBe(3);
    expect(result.loop.failureCode).toBe("PLANNING_RECOVERY_EXHAUSTED");
    expect(result.response.changes).toEqual([]);
  });

  test("hard candidates from all stage records remain advisory and visible to replanning", () => {
    const records: StagePlanningRecoveryRecord[] = [
      {
        ...createCanonicalPlanRecoveryEvent({
          phase: "AUTHORIZATION",
          stageId: "stage-2",
          workspaceRoot: tempDir,
          repositoryRevision: "revision-1",
          manifestFingerprint: "A",
          failureFacts: [scopeFact("src/Foreign.tsx", "MULTI_REPO_ISOLATION_VIOLATION")],
        }),
        attemptNumber: 1,
        rejectedPaths: [],
        authorizedPaths: [],
      },
      {
        ...createCanonicalPlanRecoveryEvent({
          phase: "AUTHORIZATION",
          stageId: "stage-2",
          workspaceRoot: tempDir,
          repositoryRevision: "revision-1",
          manifestFingerprint: "B",
          failureFacts: [scopeFact("src/Unrelated.tsx", "NO_TASK_OR_STRUCTURAL_RELATION")],
        }),
        attemptNumber: 2,
        rejectedPaths: [],
        authorizedPaths: [],
      },
    ];
    const context = formatPlanningFailureContext(records);
    expect(context).toContain("create src/Foreign.tsx: MULTI_REPO_ISOLATION_VIOLATION");
    expect(context).toContain("create src/Unrelated.tsx: NO_TASK_OR_STRUCTURAL_RELATION");
    expect(context).toContain("grants no mutation authority");
    expect(WorkingPlan.create({ id: "authority-zero" }).snapshot().authority)
      .toBe("ADVISORY_ONLY_NO_FILESYSTEM_AUTHORITY");
  });

  test("same topology is revision-aware and ignores evidence IDs and prose", () => {
    const files = [{ path: "src/components/Widget.tsx", action: "create", dependencies: ["src/App.tsx"] }];
    const first = computeManifestAttemptFingerprint({ stageId: "stage-2", repositoryRevision: "revision-1", files });
    const same = computeManifestAttemptFingerprint({ stageId: "stage-2", repositoryRevision: "revision-1", files });
    const changedRevision = computeManifestAttemptFingerprint({ stageId: "stage-2", repositoryRevision: "revision-2", files });
    expect(first).toBe(same);
    expect(first).not.toBe(changedRevision);
    expect(first).not.toMatch(/evidence|description|random/i);
  });

  test("verified prerequisite stage remains verified during scope recovery", async () => {
    const taskRuntime = runtime(tempDir);
    let attempts = 0;
    const result = await AgentLoopCoordinator.runPipeline({
      runtime: taskRuntime,
      workingPlan: WorkingPlan.create({ id: "verified-stage-plan" }),
      maxIterations: 3,
      observe: async () => ({ workspace: taskRuntime.workspaceState(), revision: "revision-1" }),
      executeIteration: async () => {
        attempts += 1;
        if (attempts === 1) return { response: scopeFailure("stage-2-topology-A") };
        const plan = stagePlan();
        return {
          response: {
            explanation: "Stage 2 recovered",
            changes: [{ path: "src/App.tsx", action: "modify", content: "updated", description: "integrate" }],
            commitMessage: "feat: recover stage",
            sessionId: "scope-session",
            taskExecutionPlan: plan,
            compoundTaskStatus: "VERIFIED",
            buildVerified: true,
          },
          journalEntry: {
            journalId: "stage-2-journal",
            sequence: 2,
            actionGroupId: "stage-2-action",
            status: "VERIFIED" as const,
            validation: { passed: true, checks: [] },
            attemptedActions: [{ path: "src/App.tsx", action: "modify" as const }],
          } as never,
        };
      },
    });
    expect(attempts).toBe(2);
    expect(result.response.taskExecutionPlan?.stages[0].status).toBe("VERIFIED");
  });
});
