import fs from "fs";
import path from "path";
import os from "os";
import { AgentLoopCoordinator } from "../orchestration/AgentLoopCoordinator";
import { AgentPlanner } from "../orchestration/AgentPlanner";
import { WorkingPlan } from "../runtime/WorkingPlan";
import { TaskRuntime } from "../runtime/TaskRuntime";
import { AgentWorkspaceState } from "../runtime/AgentWorkspaceState";
import { VerifiedCheckpointJournal } from "../runtime/VerifiedCheckpointJournal";
import { RepositoryEvidenceStore } from "../repository/RepositoryEvidenceStore";
import { ManifestGenerator } from "../../services/manifest-generator";
import { ManifestCorrectionEngine } from "../planning/ManifestCorrectionEngine";
import {
  computeManifestAttemptFingerprint,
  extractPlanningFailureFacts,
  MAX_STAGE_PLANNING_ATTEMPTS,
} from "../planning/PlanningFailureFacts";
import {
  TaskExecutionPlan,
  TaskExecutionStage,
  FileManifest,
  AgentResponse,
  ExecutionContract,
} from "../../types";
import { EvidenceBoundWriteSetResolver } from "../contracts/EvidenceBoundWriteSetResolver";
import { PolicyContract } from "../contracts/PolicyContract";
import { createTaskIntentSpec } from "../shared/TaskIntentSpec";
import { TaskClassificationResult } from "../classification/TaskTypes";
import { bindUserRequest } from "../repository/TrustedTaskContext";

const testClassification: TaskClassificationResult = {
  taskType: "NEW_FEATURE",
  intent: "NEW_FEATURE",
  risk: "LOW",
  estimatedComplexity: "SMALL",
  confidence: 1,
  requiresClarification: false,
  reasoning: "Test fixture",
};

describe("Stage-Local Manifest Failure Reinvestigation & Bounded Planning Recovery", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "anka-manifest-recovery-"));
    fs.mkdirSync(path.join(tempDir, "app"), { recursive: true });
    fs.mkdirSync(path.join(tempDir, "app/components"), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, "package.json"),
      JSON.stringify({ name: "recovery-test", dependencies: { react: "^18.0.0" } }, null, 2),
      "utf8"
    );
    fs.writeFileSync(
      path.join(tempDir, "app/page.tsx"),
      `export default function Page() { return <div>Home</div>; }`,
      "utf8"
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  const baseStage1: TaskExecutionStage = {
    id: "stage-1",
    name: "Initialize baseline",
    intent: createTaskIntentSpec("Setup basic infrastructure", testClassification, ["app/page.tsx"]),
    dependsOn: [],
    status: "VERIFIED",
  };

  const baseStage2: TaskExecutionStage = {
    id: "stage-2",
    name: "Add todo feature",
    intent: createTaskIntentSpec("Add todo list with items", testClassification, ["app/components/TodoList.tsx", "app/components/TodoItem.tsx"]),
    dependsOn: ["stage-1"],
    status: "PENDING",
  };

  const basePlan: TaskExecutionPlan = {
    id: "plan-compound",
    goal: "Build todo application",
    stages: [{ ...baseStage1 }, { ...baseStage2 }],
    currentStageIndex: 1,
    status: "RUNNING",
  };

  // ────────────────────────────────────────────────────────────────────────────
  // PART 14: LIVE FAILURE SHAPE TEST
  // ────────────────────────────────────────────────────────────────────────────
  test("PART 14: Live failure shape triggers bounded recovery without stage termination, and recovers with valid Attempt 2", async () => {
    const runtime = TaskRuntime.create({
      taskId: "live-failure-recovery",
      originalGoal: "Add todo feature",
      workspace: AgentWorkspaceState.create({ projectId: "proj-1", root: tempDir }),
    });
    runtime.start();

    // Local correction fails on Attempt 1
    jest.spyOn(ManifestCorrectionEngine, "attemptCorrection").mockResolvedValue(null);

    let planAttempt = 0;
    const fingerprintsSeen: string[] = [];

    const result = await AgentLoopCoordinator.runPipeline({
      runtime,
      workingPlan: WorkingPlan.create({ id: "working-plan-1", advisoryStageIds: ["stage-2"] }),
      maxIterations: 4,
      observe: async (iter) => ({
        workspace: runtime.workspaceState(),
        revision: `rev-1-${iter}`,
      }),
      executeIteration: async (iter) => {
        planAttempt += 1;
        if (planAttempt === 1) {
          // Attempt 1: route rejection + invalid import + orphan children
          const attempt1Manifest: FileManifest = {
            manifestVersion: "1.0.0",
            totalFiles: 3,
            files: [
              {
                path: "app/todo/page.tsx",
                action: "create",
                dependencies: ["../components/TodoList"],
                description: "Todo route",
              },
              {
                path: "app/components/TodoList.tsx",
                action: "create",
                dependencies: ["../src/data"], // unresolvable import
                description: "TodoList component",
              },
              {
                path: "app/components/TodoItem.tsx",
                action: "create",
                dependencies: [],
                description: "TodoItem component",
              },
            ],
          };

          const fp = computeManifestAttemptFingerprint({
            stageId: "stage-2",
            repositoryRevision: "rev-1-1",
            files: attempt1Manifest.files,
          });
          fingerprintsSeen.push(fp);

          const response: AgentResponse = {
            explanation: "[Manifest Validation Failed] Unresolved import and orphan components",
            changes: [],
            commitMessage: "",
            sessionId: "sess-1",
            lifecycleStage: "ManifestValidationFailed",
            errorCode: "PLANNING_REINVESTIGATION_REQUIRED",
            manifestFingerprint: fp,
            planningFailureFacts: [
              { kind: "AUTHORITY_REJECTION", affectedPath: "app/todo/page.tsx", reason: "NO_EVIDENCE_IDS_CITED" },
              { kind: "IMPORT_RESOLUTION", affectedPath: "app/components/TodoList.tsx", dependency: "../src/data", reason: "Unresolved import" },
              { kind: "ORPHAN_CREATE", affectedPath: "app/components/TodoList.tsx", reason: "Orphaned file detected" },
              { kind: "ORPHAN_CREATE", affectedPath: "app/components/TodoItem.tsx", reason: "Orphaned file detected" },
            ],
            authorizedPaths: ["app/components/TodoList.tsx", "app/components/TodoItem.tsx"],
            rejectedPaths: [{ path: "app/todo/page.tsx", action: "create", reason: "NO_EVIDENCE_IDS_CITED" }],
            taskExecutionPlan: { ...basePlan },
            buildVerified: false,
          };
          return { response };
        }

        // Attempt 2: different valid topology connecting to existing app/page.tsx
        const attempt2Manifest: FileManifest = {
          manifestVersion: "1.0.0",
          totalFiles: 3,
          files: [
            {
              path: "app/page.tsx",
              action: "modify",
              dependencies: ["./components/TodoList"],
              description: "Integrate TodoList into home page",
            },
            {
              path: "app/components/TodoList.tsx",
              action: "create",
              dependencies: ["./TodoItem"],
              description: "TodoList component",
            },
            {
              path: "app/components/TodoItem.tsx",
              action: "create",
              dependencies: [],
              description: "TodoItem component",
            },
          ],
        };

        const fp2 = computeManifestAttemptFingerprint({
          stageId: "stage-2",
          repositoryRevision: "rev-1-2",
          files: attempt2Manifest.files,
        });
        fingerprintsSeen.push(fp2);

        const response: AgentResponse = {
          explanation: "Successfully applied and validated todo feature",
          changes: [
            { path: "app/page.tsx", action: "modify", content: "// integrated", description: "integrate" },
            { path: "app/components/TodoList.tsx", action: "create", content: "// list", description: "list" },
            { path: "app/components/TodoItem.tsx", action: "create", content: "// item", description: "item" },
          ],
          commitMessage: "feat: add todo feature",
          sessionId: "sess-1",
          buildVerified: true,
          manifestFingerprint: fp2,
          taskExecutionPlan: {
            ...basePlan,
            stages: [
              { ...baseStage1, status: "VERIFIED" },
              { ...baseStage2, status: "VERIFIED" },
            ],
            status: "COMPLETED",
          },
        };

        const journalEntry = {
          journalId: "journal-stage-2",
          sequence: 2,
          actionGroupId: "ag-stage-2",
          status: "VERIFIED" as const,
          validation: { passed: true, checks: [] },
          attemptedActions: [
            { path: "app/page.tsx", action: "modify" as const },
            { path: "app/components/TodoList.tsx", action: "create" as const },
            { path: "app/components/TodoItem.tsx", action: "create" as const },
          ],
        };

        return { response, journalEntry: journalEntry as any };
      },
    });

    expect(planAttempt).toBe(2);
    expect(fingerprintsSeen[0]).not.toBe(fingerprintsSeen[1]);
    expect(result.response.buildVerified).toBe(true);
    expect(result.loop.outcome).toBe("AWAITING_COMPLETION_EVALUATION");
    expect(result.loop.verifiedCheckpointIds).toContain("journal-stage-2");
  });

  // ────────────────────────────────────────────────────────────────────────────
  // PART 15: AUTHORIZATION RERUN TEST
  // ────────────────────────────────────────────────────────────────────────────
  test("PART 15: Candidate authorization is rerun from scratch; Attempt 1 approval does NOT transfer to new ungrounded path", async () => {
    fs.writeFileSync(path.join(tempDir, "app/components/ComponentA.tsx"), "export const A = 1;", "utf8");
    fs.writeFileSync(path.join(tempDir, "app/components/ComponentB.tsx"), "export const B = 2;", "utf8");

    const store = new RepositoryEvidenceStore("proj-auth-test", tempDir);
    (store as any).isAuthorityEligible = () => true;
    const evA = store.observeRepository({
      kind: "FILE",
      filePath: "app/components/ComponentA.tsx",
      provenance: "REPO_READ",
    });
    const evB = store.observeRepository({
      kind: "FILE",
      filePath: "app/components/ComponentB.tsx",
      provenance: "REPO_READ",
    });

    const policy: PolicyContract = {
      goal: "Update components",
      taskType: "BUG_FIX",
      risk: "LOW",
      estimatedComplexity: "SMALL",
      destructive: false,
      allowedActions: ["modify"],
      forbiddenActions: [],
      maxFiles: 5,
      diffCriticEnabled: false,
      pipeline: "REPOSITORY",
      environment: "REACT_TS",
      repositoryRequired: true,
      expectedFiles: [],
      validationType: "NONE",
      explicitUserPaths: ["app/components/ComponentA.tsx", "app/components/ComponentB.tsx"],
      userConstraints: [],
      requiresClarification: false,
    };
    const userPrompt = "update app/components/ComponentA.tsx and update app/components/ComponentB.tsx";
    const intentSpec = createTaskIntentSpec(
      userPrompt,
      { taskType: "BUG_FIX", intent: "BUG_FIX", risk: "LOW", estimatedComplexity: "SMALL", confidence: 1, requiresClarification: false, reasoning: "fixture" },
      ["app/components/ComponentA.tsx", "app/components/ComponentB.tsx"]
    );
    bindUserRequest(intentSpec, userPrompt);

    // Attempt 1: Path A and Path B both authorized
    const attempt1Result = EvidenceBoundWriteSetResolver.resolve({
      policy,
      intentSpec,
      proposedChanges: [
        { path: "app/components/ComponentA.tsx", action: "modify", reason: "Comp A", evidenceIds: [evA.id], dependencies: [] },
        { path: "app/components/ComponentB.tsx", action: "modify", reason: "Comp B", evidenceIds: [evB.id], dependencies: [] },
      ],
      evidenceStore: store,
      existingFiles: ["app/page.tsx", "app/components/ComponentA.tsx", "app/components/ComponentB.tsx"],
      workspaceRoot: tempDir,
      stageId: "stage-2",
    });
    expect(attempt1Result.approvedPaths).toContain("app/components/ComponentA.tsx");
    expect(attempt1Result.approvedPaths).toContain("app/components/ComponentB.tsx");

    // Attempt 2: Planner proposes Path A (with evidence) and Path C (no evidence, ungrounded)
    const attempt2Result = EvidenceBoundWriteSetResolver.resolve({
      policy,
      intentSpec,
      proposedChanges: [
        { path: "app/components/ComponentA.tsx", action: "modify", reason: "Comp A", evidenceIds: [evA.id], dependencies: [] },
        { path: "app/components/ComponentC.tsx", action: "modify", reason: "Comp C", evidenceIds: [], dependencies: [] },
      ],
      evidenceStore: store,
      existingFiles: ["app/page.tsx", "app/components/ComponentA.tsx", "app/components/ComponentB.tsx"],
      workspaceRoot: tempDir,
      stageId: "stage-2",
    });

    // Path A has evidence -> Approved
    expect(attempt2Result.approvedPaths).toContain("app/components/ComponentA.tsx");
    // Path C has NO evidence -> REJECTED. Approval from Attempt 1 Path B does NOT transfer to Path C.
    expect(attempt2Result.approvedPaths).not.toContain("app/components/ComponentC.tsx");
    expect(attempt2Result.rejectedPaths.some((r: any) => r.path === "app/components/ComponentC.tsx")).toBe(true);
  });

  // ────────────────────────────────────────────────────────────────────────────
  // PART 16: SAME PLAN TEST (DUPLICATE FINGERPRINT REJECTION)
  // ────────────────────────────────────────────────────────────────────────────
  test("PART 16: Identical plan fingerprint on replan triggers DUPLICATE_RECOVERY_PLAN and halts", async () => {
    const runtime = TaskRuntime.create({
      taskId: "duplicate-plan-test",
      originalGoal: "Build feature",
      workspace: AgentWorkspaceState.create({ projectId: "proj-dupe", root: tempDir }),
    });
    runtime.start();

    const staticFingerprint = "stage-2@rev-1:CREATE:app/components/TodoList.tsx;CREATE:app/todo/page.tsx";
    let attempts = 0;

    const result = await AgentLoopCoordinator.runPipeline({
      runtime,
      workingPlan: WorkingPlan.create({ id: "plan-dupe" }),
      maxIterations: 5,
      observe: async () => ({ workspace: runtime.workspaceState(), revision: "rev-1" }),
      executeIteration: async () => {
        attempts += 1;
        return {
          response: {
            explanation: "Topology validation failed",
            changes: [],
            commitMessage: "",
            sessionId: "sess-dupe",
            lifecycleStage: "ManifestValidationFailed",
            errorCode: "PLANNING_REINVESTIGATION_REQUIRED",
            manifestFingerprint: staticFingerprint, // SAME fingerprint on both attempts
            planningFailureFacts: [
              { kind: "ORPHAN_CREATE", affectedPath: "app/components/TodoList.tsx", reason: "Orphaned file" },
            ],
            taskExecutionPlan: { ...basePlan },
            buildVerified: false,
          },
        };
      },
    });

    expect(attempts).toBe(2);
    expect(result.loop.outcome).toBe("VALIDATION_FAILURE");
    expect(result.loop.failureCode).toBe("DUPLICATE_RECOVERY_PLAN");
    expect(result.response.errorCode).toBe("DUPLICATE_RECOVERY_PLAN");
  });

  // ────────────────────────────────────────────────────────────────────────────
  // PART 17: DIFFERENT PLAN SAME ERROR TYPE
  // ────────────────────────────────────────────────────────────────────────────
  test("PART 17: Different plan fingerprint with the same error kind consumes next recovery slot rather than blocking", async () => {
    const runtime = TaskRuntime.create({
      taskId: "diff-plan-same-error",
      originalGoal: "Build feature",
      workspace: AgentWorkspaceState.create({ projectId: "proj-diff", root: tempDir }),
    });
    runtime.start();

    let attempts = 0;
    const result = await AgentLoopCoordinator.runPipeline({
      runtime,
      workingPlan: WorkingPlan.create({ id: "plan-diff" }),
      maxIterations: 5,
      observe: async () => ({ workspace: runtime.workspaceState(), revision: "rev-1" }),
      executeIteration: async () => {
        attempts += 1;
        // Both attempts fail with ORPHAN_CREATE, but have DIFFERENT fingerprints
        const fp = attempts === 1
          ? "stage-2@rev-1:CREATE:app/components/TodoList.tsx"
          : "stage-2@rev-1:CREATE:app/components/AltTodoList.tsx";

        if (attempts === 1) {
          return {
            response: {
              explanation: "TodoList is orphaned",
              changes: [],
              commitMessage: "",
              sessionId: "sess-diff",
              lifecycleStage: "ManifestValidationFailed",
              errorCode: "PLANNING_REINVESTIGATION_REQUIRED",
              manifestFingerprint: fp,
              planningFailureFacts: [
                { kind: "ORPHAN_CREATE", affectedPath: "app/components/TodoList.tsx", reason: "Orphaned" },
              ],
              taskExecutionPlan: { ...basePlan },
              buildVerified: false,
            },
          };
        }

        // Attempt 2 succeeds
        return {
          response: {
            explanation: "AltTodoList wired successfully",
            changes: [{ path: "app/page.tsx", action: "modify", content: "// ok", description: "wire" }],
            commitMessage: "feat: add alt todo",
            sessionId: "sess-diff",
            buildVerified: true,
            manifestFingerprint: fp,
            taskExecutionPlan: { ...basePlan, status: "COMPLETED" },
          },
          journalEntry: {
            journalId: "journal-diff-2",
            sequence: 1,
            actionGroupId: "ag-diff",
            status: "VERIFIED" as const,
            validation: { passed: true, checks: [] },
            attemptedActions: [{ path: "app/page.tsx", action: "modify" as const }],
          } as any,
        };
      },
    });

    expect(attempts).toBe(2);
    expect(result.response.buildVerified).toBe(true);
    expect(result.loop.verifiedCheckpointIds).toContain("journal-diff-2");
  });

  // ────────────────────────────────────────────────────────────────────────────
  // PART 18: BUDGET TEST (EXACTLY 3 ATTEMPTS THEN TERMINAL FAILURE)
  // ────────────────────────────────────────────────────────────────────────────
  test("PART 18: Planning budget is strictly bounded to 3 attempts total (initial + 2 recoveries), then halts terminal with no mutation", async () => {
    const runtime = TaskRuntime.create({
      taskId: "budget-test",
      originalGoal: "Build feature",
      workspace: AgentWorkspaceState.create({ projectId: "proj-budget", root: tempDir }),
    });
    runtime.start();

    let attempts = 0;
    const result = await AgentLoopCoordinator.runPipeline({
      runtime,
      workingPlan: WorkingPlan.create({ id: "plan-budget" }),
      maxIterations: 10,
      observe: async () => ({ workspace: runtime.workspaceState(), revision: "rev-1" }),
      executeIteration: async () => {
        attempts += 1;
        // Each attempt has a unique fingerprint so it's not a duplicate
        const fp = `stage-2@rev-1:CREATE:app/components/Attempt${attempts}.tsx`;
        return {
          response: {
            explanation: `Attempt ${attempts} validation failed`,
            changes: [],
            commitMessage: "",
            sessionId: "sess-budget",
            lifecycleStage: "ManifestValidationFailed",
            errorCode: "PLANNING_REINVESTIGATION_REQUIRED",
            manifestFingerprint: fp,
            planningFailureFacts: [
              { kind: "IMPORT_RESOLUTION", affectedPath: `app/components/Attempt${attempts}.tsx`, reason: "Broken import" },
            ],
            taskExecutionPlan: { ...basePlan },
            buildVerified: false,
          },
        };
      },
    });

    // Exactly 3 planning attempts (Initial + 2 replans)
    expect(attempts).toBe(3);
    expect(result.loop.outcome).toBe("VALIDATION_FAILURE");
    expect(result.loop.failureCode).toBe("PLANNING_RECOVERY_EXHAUSTED");
    expect(result.response.errorCode).toBe("PLANNING_RECOVERY_EXHAUSTED");
    expect(result.response.changes).toHaveLength(0); // Zero mutation
  });

  // ────────────────────────────────────────────────────────────────────────────
  // PART 19: VERIFIED STAGE PRESERVATION
  // ────────────────────────────────────────────────────────────────────────────
  test("PART 19: Compound task preserves verified Stage 1 when Stage 2 planning fails and recovers", async () => {
    const runtime = TaskRuntime.create({
      taskId: "compound-stage-isolation",
      originalGoal: "Build full stack",
      workspace: AgentWorkspaceState.create({ projectId: "proj-iso", root: tempDir }),
    });
    runtime.start();

    let stage1Runs = 0;
    let stage2Attempts = 0;

    const result = await AgentLoopCoordinator.runPipeline({
      runtime,
      workingPlan: WorkingPlan.create({ id: "plan-compound", advisoryStageIds: ["stage-1", "stage-2"] }),
      maxIterations: 5,
      observe: async () => ({ workspace: runtime.workspaceState(), revision: "rev-1" }),
      executeIteration: async () => {
        // Iteration 1: Stage 1 executes and verifies
        if (stage1Runs === 0) {
          stage1Runs += 1;
          return {
            response: {
              explanation: "Stage 1 complete",
              changes: [{ path: "app/page.tsx", action: "modify", content: "// stage 1", description: "init" }],
              commitMessage: "feat: stage 1",
              sessionId: "sess-iso",
              buildVerified: true,
              taskExecutionPlan: {
                ...basePlan,
                stages: [
                  { ...baseStage1, status: "VERIFIED" },
                  { ...baseStage2, status: "PENDING" },
                ],
                currentStageIndex: 1,
                status: "RUNNING",
              },
              compoundTaskStatus: "RUNNING",
            },
            journalEntry: {
              journalId: "journal-stage-1",
              sequence: 1,
              actionGroupId: "ag-1",
              status: "VERIFIED" as const,
              validation: { passed: true, checks: [] },
              attemptedActions: [{ path: "app/page.tsx", action: "modify" as const }],
            } as any,
          };
        }

        // Iteration 2+: Stage 2
        stage2Attempts += 1;
        if (stage2Attempts === 1) {
          return {
            response: {
              explanation: "Stage 2 planning failed initially",
              changes: [],
              commitMessage: "",
              sessionId: "sess-iso",
              lifecycleStage: "ManifestValidationFailed",
              errorCode: "PLANNING_REINVESTIGATION_REQUIRED",
              manifestFingerprint: "stage-2@rev-1:CREATE:app/components/TodoList.tsx",
              planningFailureFacts: [{ kind: "ORPHAN_CREATE", affectedPath: "app/components/TodoList.tsx" }],
              taskExecutionPlan: {
                ...basePlan,
                stages: [
                  { ...baseStage1, status: "VERIFIED" },
                  { ...baseStage2, status: "PENDING" },
                ],
                currentStageIndex: 1,
                status: "RUNNING",
              },
              compoundTaskStatus: "RUNNING",
              buildVerified: false,
            },
          };
        }

        // Stage 2 Attempt 2 succeeds
        return {
          response: {
            explanation: "Stage 2 recovered and verified",
            changes: [{ path: "app/components/TodoList.tsx", action: "create", content: "// ok", description: "ok" }],
            commitMessage: "feat: stage 2",
            sessionId: "sess-iso",
            buildVerified: true,
            manifestFingerprint: "stage-2@rev-1:CREATE:app/components/TodoList.tsx;MODIFY:app/page.tsx",
            taskExecutionPlan: {
              ...basePlan,
              stages: [
                { ...baseStage1, status: "VERIFIED" },
                { ...baseStage2, status: "VERIFIED" },
              ],
              currentStageIndex: 1,
              status: "COMPLETED",
            },
            compoundTaskStatus: "VERIFIED",
          },
          journalEntry: {
            journalId: "journal-stage-2",
            sequence: 2,
            actionGroupId: "ag-2",
            status: "VERIFIED" as const,
            validation: { passed: true, checks: [] },
            attemptedActions: [{ path: "app/components/TodoList.tsx", action: "create" as const }],
          } as any,
        };
      },
    });

    // Stage 1 executed exactly ONCE
    expect(stage1Runs).toBe(1);
    // Stage 2 attempted twice (1 initial failure + 1 recovery)
    expect(stage2Attempts).toBe(2);
    // Both checkpoint IDs are verified in order
    expect(result.loop.verifiedCheckpointIds).toEqual(["journal-stage-1", "journal-stage-2"]);
    // Stage 1 status remained VERIFIED throughout
    expect(result.response.taskExecutionPlan?.stages[0].status).toBe("VERIFIED");
  });

  // ────────────────────────────────────────────────────────────────────────────
  // PART 20: STALE REVISION CHECK
  // ────────────────────────────────────────────────────────────────────────────
  test("PART 20: Stale revision rejects outdated evidence across loop replans", async () => {
    const store = new RepositoryEvidenceStore("proj-stale-test", tempDir);
    const ev = (store as any).insertEvidence(
      {
        kind: "FILE",
        filePath: "app/components/TodoList.tsx",
        provenance: "REPO_READ",
      },
      true,
      "rev-old"
    );

    const policy: PolicyContract = {
      goal: "Test feature",
      taskType: "NEW_FEATURE",
      risk: "LOW",
      estimatedComplexity: "SMALL",
      destructive: false,
      allowedActions: ["create", "modify"],
      forbiddenActions: [],
      maxFiles: 5,
      diffCriticEnabled: false,
      pipeline: "REPOSITORY",
      environment: "REACT_TS",
      repositoryRequired: false,
      expectedFiles: [],
      validationType: "NONE",
      explicitUserPaths: ["app/components/TodoList.tsx"],
      userConstraints: [],
      requiresClarification: false,
    };
    const userPrompt = "create app/components/TodoList.tsx";
    const intentSpec = createTaskIntentSpec(
      userPrompt,
      testClassification,
      ["app/components/TodoList.tsx"]
    );
    bindUserRequest(intentSpec, userPrompt);

    const result = EvidenceBoundWriteSetResolver.resolve({
      policy,
      intentSpec,
      proposedChanges: [
        { path: "app/components/TodoList.tsx", action: "create", reason: "test", evidenceIds: [ev.id], dependencies: [] },
      ],
      evidenceStore: store,
      existingFiles: ["app/page.tsx"],
      workspaceRoot: tempDir,
      baseRevision: "rev-new",
      stageId: "stage-2",
    });

    expect(result.approvedPaths).not.toContain("app/components/TodoList.tsx");
    expect(result.rejectedPaths.some((r: any) => r.path === "app/components/TodoList.tsx")).toBe(true);
  });

  // ────────────────────────────────────────────────────────────────────────────
  // PART 21: PRESERVE EXISTING BUILD REINVESTIGATION
  // ────────────────────────────────────────────────────────────────────────────
  test("PART 21: Existing REINVESTIGATION_REQUIRED outcomes remain fully functional without regression", async () => {
    const runtime = TaskRuntime.create({
      taskId: "existing-reinvestigation-test",
      originalGoal: "Build feature",
      workspace: AgentWorkspaceState.create({ projectId: "proj-existing", root: tempDir }),
    });
    runtime.start();

    let iterations = 0;
    const result = await AgentLoopCoordinator.runPipeline({
      runtime,
      workingPlan: WorkingPlan.create({ id: "plan-existing" }),
      maxIterations: 3,
      observe: async () => ({ workspace: runtime.workspaceState(), revision: "rev-1" }),
      executeIteration: async () => {
        iterations += 1;
        if (iterations === 1) {
          return {
            response: {
              explanation: "Revision diverged during execution",
              changes: [],
              commitMessage: "",
              sessionId: "sess-exist",
              errorCode: "TRANSACTION_REVISION_DIVERGED",
              buildVerified: false,
            },
          };
        }
        return {
          response: {
            explanation: "Recovered successfully from divergence",
            changes: [{ path: "app/page.tsx", action: "modify", content: "// ok", description: "ok" }],
            commitMessage: "fix: recover",
            sessionId: "sess-exist",
            buildVerified: true,
          },
          journalEntry: {
            journalId: "journal-diverge-rec",
            sequence: 1,
            actionGroupId: "ag-rec",
            status: "VERIFIED" as const,
            validation: { passed: true, checks: [] },
            attemptedActions: [{ path: "app/page.tsx", action: "modify" as const }],
          } as any,
        };
      },
    });

    expect(iterations).toBe(2);
    expect(result.loop.verifiedCheckpointIds).toContain("journal-diverge-rec");
    expect(result.response.buildVerified).toBe(true);
  });
});
