import fs from "fs";
import os from "os";
import path from "path";
import { FileManifest, TaskExecutionPlan } from "../../types";
import { AgentLoopCoordinator } from "../orchestration/AgentLoopCoordinator";
import { evaluateProspectiveTopologyApplicability } from "../orchestration/AgentPlanner";
import {
  createCanonicalPlanRecoveryEvent,
  createPreCanonicalRecoveryEvent,
  PlanningFailureFact,
} from "../planning/PlanningFailureFacts";
import { RepositoryInvestigationAgent } from "../repository/RepositoryInvestigationAgent";
import { RepositorySearch } from "../repository/RepositorySearch";
import { AgentWorkspaceState } from "../runtime/AgentWorkspaceState";
import { TaskRuntime } from "../runtime/TaskRuntime";
import { WorkingPlan } from "../runtime/WorkingPlan";
import { createTaskIntentSpec } from "../shared/TaskIntentSpec";

const topology = {
  nodes: [{ temporaryId: "candidate", path: "src/Candidate.ts", kind: "PROSPECTIVE" as const, role: "MODULE" as const }],
  edges: [],
  featureRoots: ["candidate"],
};

function manifest(action: "create" | "modify" | "delete"): FileManifest {
  return {
    files: [{ path: "src/Candidate.ts", action, dependencies: [], description: "generic fixture" }],
    totalFiles: 1,
    manifestVersion: "1.0.0",
    prospectiveTopology: topology,
  };
}

const investigationFact: PlanningFailureFact = {
  kind: "INVESTIGATION_READINESS",
  affectedPath: "src/Candidate.ts",
  reason: "MISSING_EXPLICIT_TARGET_EVIDENCE",
};

function plan(stageId = "stage-1"): TaskExecutionPlan {
  return {
    id: "corrective-plan",
    goal: "Apply a generic staged change",
    currentStageIndex: 0,
    status: "RUNNING",
    stages: [{
      id: stageId,
      name: "Generic stage",
      intent: createTaskIntentSpec("Apply a generic staged change", {
        taskType: "NEW_FEATURE",
        intent: "NEW_FEATURE",
        risk: "LOW",
        estimatedComplexity: "SMALL",
        confidence: 1,
        requiresClarification: false,
        reasoning: "fixture",
      }, []),
      dependsOn: [],
      status: "RUNNING",
    }],
  };
}

function runtime(root: string): TaskRuntime {
  const value = TaskRuntime.create({
    taskId: `corrective-${path.basename(root)}`,
    originalGoal: "Apply a generic staged change",
    workspace: AgentWorkspaceState.create({ projectId: "corrective-project", root }),
  });
  value.start();
  return value;
}

describe("Checkpoint D corrective recovery identity and topology applicability", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "anka-corrective-"));
    fs.mkdirSync(path.join(tempDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, "src", "Candidate.ts"), "export const candidate = true;", "utf8");
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test("DELETE and MODIFY stages ignore irrelevant proposed topology while CREATE remains fail-closed", () => {
    expect(evaluateProspectiveTopologyApplicability(manifest("delete"), false)).toBe("INAPPLICABLE_NON_CREATE");
    expect(evaluateProspectiveTopologyApplicability(manifest("modify"), false)).toBe("INAPPLICABLE_NON_CREATE");
    expect(evaluateProspectiveTopologyApplicability(manifest("create"), false)).toBe("FAIL_MISSING_CREATE_ENVELOPE");
    expect(evaluateProspectiveTopologyApplicability(manifest("create"), true)).toBe("CANONICALIZE");
  });

  test("compound destructive then constructive stages evaluate topology independently", () => {
    const destructive = evaluateProspectiveTopologyApplicability(manifest("delete"), false);
    const constructive = evaluateProspectiveTopologyApplicability(manifest("create"), true);
    expect(destructive).toBe("INAPPLICABLE_NON_CREATE");
    expect(constructive).toBe("CANONICALIZE");
  });

  test("recovery constructors reject empty facts and empty canonical fingerprints", () => {
    expect(() => createPreCanonicalRecoveryEvent({
      phase: "INVESTIGATION",
      stageId: "stage-1",
      workspaceRoot: tempDir,
      repositoryRevision: "revision-1",
      failureFacts: [],
    })).toThrow("INTERNAL_RECOVERY_CONTRACT_ERROR");
    expect(() => createCanonicalPlanRecoveryEvent({
      phase: "MANIFEST_VALIDATION",
      stageId: "stage-1",
      workspaceRoot: tempDir,
      repositoryRevision: "revision-1",
      manifestFingerprint: " ",
      failureFacts: [investigationFact],
    })).toThrow("INTERNAL_RECOVERY_CONTRACT_ERROR");
  });

  test("same pre-canonical identity and progress stalls with a non-duplicate-plan code", async () => {
    const taskRuntime = runtime(tempDir);
    const event = createPreCanonicalRecoveryEvent({
      phase: "INVESTIGATION",
      stageId: "stage-1",
      workspaceRoot: tempDir,
      repositoryRevision: "revision-1",
      failureFacts: [investigationFact],
      operationKinds: ["MODIFY"],
      missingTargets: ["src/Candidate.ts"],
      inspectedPaths: ["src/Entry.ts"],
    });
    let attempts = 0;
    const result = await AgentLoopCoordinator.runPipeline({
      runtime: taskRuntime,
      workingPlan: WorkingPlan.create({ id: "pre-canonical-stall" }),
      maxIterations: 4,
      observe: async () => ({ workspace: taskRuntime.workspaceState(), revision: "revision-1" }),
      executeIteration: async () => {
        attempts += 1;
        return { response: {
          explanation: "Investigation remains incomplete",
          changes: [],
          commitMessage: "",
          sessionId: "corrective-session",
          errorCode: "PLANNING_REINVESTIGATION_REQUIRED",
          planningRecoveryEvent: event,
          planningFailureFacts: [...event.failureFacts],
          repositoryRevision: event.repositoryRevision,
          taskExecutionPlan: plan(),
        } };
      },
    });
    expect(attempts).toBe(2);
    expect(result.loop.failureCode).toBe("INVESTIGATION_STALLED");
    expect(result.loop.failureCode).not.toBe("DUPLICATE_RECOVERY_PLAN");
  });

  test("changed deterministic progress continues within the outer bound", async () => {
    const taskRuntime = runtime(tempDir);
    const events = [
      createPreCanonicalRecoveryEvent({
        phase: "INVESTIGATION", stageId: "stage-1", workspaceRoot: tempDir, repositoryRevision: "revision-1",
        failureFacts: [investigationFact], operationKinds: ["MODIFY"], missingTargets: ["src/Candidate.ts", "src/Entry.ts"], inspectedPaths: [],
      }),
      createPreCanonicalRecoveryEvent({
        phase: "INVESTIGATION", stageId: "stage-1", workspaceRoot: tempDir, repositoryRevision: "revision-1",
        failureFacts: [investigationFact], operationKinds: ["MODIFY"], missingTargets: ["src/Candidate.ts"], inspectedPaths: ["src/Entry.ts"],
      }),
    ];
    let attempts = 0;
    const result = await AgentLoopCoordinator.runPipeline({
      runtime: taskRuntime,
      workingPlan: WorkingPlan.create({ id: "pre-canonical-progress" }),
      maxIterations: 2,
      observe: async () => ({ workspace: taskRuntime.workspaceState(), revision: "revision-1" }),
      executeIteration: async () => {
        const event = events[attempts++];
        return { response: {
          explanation: "Bounded investigation progress",
          changes: [], commitMessage: "", sessionId: "corrective-session",
          errorCode: "PLANNING_REINVESTIGATION_REQUIRED",
          planningRecoveryEvent: event,
          planningFailureFacts: [...event.failureFacts],
          repositoryRevision: event.repositoryRevision,
          taskExecutionPlan: plan(),
        } };
      },
    });
    expect(attempts).toBe(2);
    expect(result.loop.failureCode).not.toBe("INVESTIGATION_STALLED");
    expect(result.loop.outcome).toBe("MAX_ITERATIONS_REACHED");
  });

  test("canonical A-B-A remains blocked and never compares against pre-canonical identity", async () => {
    const taskRuntime = runtime(tempDir);
    const pre = createPreCanonicalRecoveryEvent({
      phase: "INVESTIGATION", stageId: "stage-1", workspaceRoot: tempDir, repositoryRevision: "revision-1",
      failureFacts: [investigationFact], operationKinds: ["CREATE"], inspectedPaths: ["src/Candidate.ts"],
    });
    const canonical = [pre.recoveryIdentity, "B", pre.recoveryIdentity].map((fingerprint) => createCanonicalPlanRecoveryEvent({
      phase: "MANIFEST_VALIDATION", stageId: "stage-1", workspaceRoot: tempDir, repositoryRevision: "revision-1",
      manifestFingerprint: fingerprint, failureFacts: [{ kind: "INVALID_MANIFEST_STRUCTURE", reason: "schema" }],
    }));
    const sequence = [pre, ...canonical];
    let attempts = 0;
    const result = await AgentLoopCoordinator.runPipeline({
      runtime: taskRuntime,
      workingPlan: WorkingPlan.create({ id: "canonical-oscillation" }),
      maxIterations: 6,
      observe: async () => ({ workspace: taskRuntime.workspaceState(), revision: "revision-1" }),
      executeIteration: async () => {
        const event = sequence[attempts++];
        return { response: {
          explanation: "Recovery fixture", changes: [], commitMessage: "", sessionId: "corrective-session",
          errorCode: "PLANNING_REINVESTIGATION_REQUIRED", planningRecoveryEvent: event,
          planningFailureFacts: [...event.failureFacts], repositoryRevision: event.repositoryRevision,
          taskExecutionPlan: plan(),
        } };
      },
    });
    expect(attempts).toBe(4);
    expect(result.loop.failureCode).toBe("DUPLICATE_RECOVERY_PLAN");
  });

  test("revision and workspace are bound into pre-canonical identity", () => {
    const otherWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "anka-corrective-other-"));
    try {
      const base = { phase: "INVESTIGATION" as const, stageId: "stage-1", failureFacts: [investigationFact], inspectedPaths: ["src/Candidate.ts"] };
      const first = createPreCanonicalRecoveryEvent({ ...base, workspaceRoot: tempDir, repositoryRevision: "revision-1" });
      const changedRevision = createPreCanonicalRecoveryEvent({ ...base, workspaceRoot: tempDir, repositoryRevision: "revision-2" });
      const changedWorkspace = createPreCanonicalRecoveryEvent({ ...base, workspaceRoot: otherWorkspace, repositoryRevision: "revision-1" });
      expect(first.recoveryIdentity).not.toBe(changedRevision.recoveryIdentity);
      expect(first.recoveryIdentity).not.toBe(changedWorkspace.recoveryIdentity);
    } finally {
      fs.rmSync(otherWorkspace, { recursive: true, force: true });
    }
  });

  test("RepositorySearch preserves deterministic readyToPlan=false instead of only lowering confidence", async () => {
    jest.spyOn(RepositoryInvestigationAgent.prototype, "investigate").mockResolvedValue({
      readyToPlan: false,
      evidenceIds: [],
      missingEvidence: ["fixture diagnostic"],
      missingEvidenceKinds: ["MISSING_EXPLICIT_TARGET_EVIDENCE"],
      missingTargets: ["src/Candidate.ts"],
      roundsExecuted: 1,
      allExploredFiles: ["src/Candidate.ts"],
      summary: "bounded fixture investigation",
      investigationHistory: [],
    });
    const intent = createTaskIntentSpec("modify src/Candidate.ts", {
      taskType: "REFACTOR",
      intent: "REFACTOR",
      risk: "LOW",
      estimatedComplexity: "SMALL",
      confidence: 1,
      requiresClarification: false,
      reasoning: "fixture",
    }, ["src/Candidate.ts"]);
    const result = await RepositorySearch.runIterativeRepositorySearch(
      "modify src/Candidate.ts",
      [{ path: "src/Candidate.ts", content: "export const candidate = true;" }],
      { project: { id: "corrective-project" } },
      { taskType: "REFACTOR", intent: "REFACTOR" },
      tempDir,
      undefined,
      intent,
    );
    expect(result.finalConfidence).toBe(0.60);
    expect(result.investigationReadiness).toEqual(expect.objectContaining({
      readyToPlan: false,
      missingEvidenceKinds: ["MISSING_EXPLICIT_TARGET_EVIDENCE"],
      missingTargets: ["src/Candidate.ts"],
    }));
  });
});
