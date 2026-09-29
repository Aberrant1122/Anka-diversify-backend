import fs from "fs";
import path from "path";
import { AgentLoopCoordinator, buildVerifiedTaskResult, projectVerifiedTaskChanges } from "../orchestration/AgentLoopCoordinator";
import { PipelineResultBuilder } from "../orchestration/PipelineResult";
import { AgentWorkspaceState } from "../runtime/AgentWorkspaceState";
import { TaskRuntime } from "../runtime/TaskRuntime";
import { WorkingPlan } from "../runtime/WorkingPlan";
import { VerifiedCheckpointJournal, type ActionGroupJournalEntry } from "../runtime/VerifiedCheckpointJournal";
import { createTaskIntentSpec } from "../shared/TaskIntentSpec";
import type { AgentFileChange, AgentResponse, TaskExecutionPlan } from "../../types";

function change(pathName: string, action: "create" | "modify" | "delete", content: string, description: string): AgentFileChange {
  return { path: pathName, action, content, description, ...(action === "delete" ? { isDeleted: true } : {}) };
}

function checkpoint(
  sequence: number,
  stageId: string,
  changes: readonly AgentFileChange[],
  status: "VERIFIED" | "ROLLED_BACK" = "VERIFIED",
): ActionGroupJournalEntry {
  return {
    journalId: `journal-${sequence}`,
    sequence,
    recordedAt: `2026-01-0${sequence}T00:00:00.000Z`,
    actionGroupId: `group-${sequence}`,
    stageId,
    authorizedScopeReference: `authority-${stageId}`,
    attemptedActions: Object.freeze(changes.map((item, order) => ({
      order,
      action: item.action === "create" ? "FILE_CREATE" as const : item.action === "delete" ? "FILE_DELETE" as const : "FILE_MODIFY" as const,
      path: item.path,
      contentFingerprint: `fingerprint-${sequence}-${order}`,
    }))),
    proposedActions: Object.freeze([]),
    beforeFingerprints: Object.freeze({}),
    attemptedAfterFingerprints: Object.freeze({}),
    finalFingerprints: Object.freeze({}),
    verifiedChanges: Object.freeze([...changes]),
    repositoryRevisionBefore: `revision-${sequence - 1}`,
    repositoryRevisionAfter: `revision-${sequence}`,
    validation: Object.freeze({
      source: status === "VERIFIED" ? "VALIDATION_COORDINATOR" as const : "NOT_COMPLETED" as const,
      passed: status === "VERIFIED",
      reasons: Object.freeze(status === "VERIFIED" ? [] : ["validation failed"]),
    }),
    status,
    ...(status === "ROLLED_BACK" ? { failureCode: "VALIDATION_FAILED" as const } : {}),
  };
}

function plan(first: "PENDING" | "RUNNING" | "VERIFIED" | "FAILED", second: "PENDING" | "RUNNING" | "VERIFIED" | "FAILED"): TaskExecutionPlan {
  const intent = (goal: string) => createTaskIntentSpec(goal, {
    taskType: "NEW_FEATURE",
    intent: "NEW_FEATURE",
    risk: "LOW",
    estimatedComplexity: "SMALL",
    confidence: 1,
    requiresClarification: false,
    reasoning: "test fixture",
  }, []);
  return {
    id: "compound-plan",
    goal: "Replace an existing feature with a new feature",
    currentStageIndex: second === "PENDING" ? 0 : 1,
    status: second === "VERIFIED" ? "COMPLETED" : second === "FAILED" ? "FAILED" : "RUNNING",
    stages: [
      { id: "stage-1", name: "Remove the existing feature", intent: intent("remove existing feature"), dependsOn: [], status: first },
      { id: "stage-2", name: "Create the replacement feature", intent: intent("create replacement feature"), dependsOn: ["stage-1"], status: second },
    ],
  };
}

function response(overrides: Partial<AgentResponse> = {}): AgentResponse {
  return {
    explanation: "Latest stage explanation.\n\nFiles modified: 1",
    changes: [change("src/unverified.ts", "create", "candidate", "unverified candidate")],
    commitMessage: "feat: compound result",
    sessionId: "compound-session",
    taskExecutionPlan: plan("VERIFIED", "VERIFIED"),
    compoundTaskStatus: "VERIFIED",
    pipelineMeasurementText: "Stage 7\nFiles modified: 1",
    ...overrides,
  };
}

describe("verified compound task result aggregation", () => {
  test("two verified stages produce a task-level response rather than first, last, planned, or authorized candidates", () => {
    const first = change("src/legacy.ts", "delete", "", "remove legacy feature");
    const second = change("src/replacement.ts", "create", "export const replacement = true;", "create replacement feature");
    const result = buildVerifiedTaskResult(response(), [checkpoint(1, "stage-1", [first]), checkpoint(2, "stage-2", [second])]);

    expect(result.changes).toEqual([first, second]);
    expect(result.changes).not.toEqual([first]);
    expect(result.changes).not.toEqual([second]);
    expect(result.changes.map((item) => item.path)).not.toContain("src/unverified.ts");
    expect(result.modifiedFilesCount).toBe(result.changes.length);
    expect(result.pipelineMeasurementText).toContain("Files modified: 2");
    expect(result.explanation).toContain("Remove the existing feature");
    expect(result.explanation).toContain("Create the replacement feature");
  });

  test.each([
    [change("src/shared.ts", "modify", "A", "first"), change("src/shared.ts", "modify", "B", "second"), "modify", "B"],
    [change("src/shared.ts", "create", "A", "first"), change("src/shared.ts", "delete", "", "second"), "delete", ""],
    [change("src/shared.ts", "delete", "", "first"), change("src/shared.ts", "create", "B", "second"), "create", "B"],
  ])("same-path composition is last VERIFIED stage wins", (first, second, action, content) => {
    const projected = projectVerifiedTaskChanges([
      checkpoint(1, "stage-1", [first]),
      checkpoint(2, "stage-2", [second]),
    ]);
    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({ path: "src/shared.ts", action, content });
  });

  test("rolled-back and failed candidates are excluded while prior verified progress survives", () => {
    const verified = change("src/stable.ts", "modify", "verified", "verified progress");
    const failed = change("src/failed.ts", "create", "failed", "failed candidate");
    const failedResponse = response({
      changes: [failed],
      compoundTaskStatus: "FAILED",
      failedStage: "stage-2",
      taskExecutionPlan: plan("VERIFIED", "FAILED"),
    });
    const result = buildVerifiedTaskResult(failedResponse, [
      checkpoint(1, "stage-1", [verified]),
      checkpoint(2, "stage-2", [failed], "ROLLED_BACK"),
    ]);

    expect(result.changes).toEqual([verified]);
    expect(result.compoundTaskStatus).toBe("FAILED");
    expect(result.failedStage).toBe("stage-2");
    expect(result.explanation).toContain("Remove the existing feature");
    expect(result.explanation).not.toContain("Create the replacement feature");
  });

  test("recovery checkpoints and repeated successful retries do not duplicate file results", () => {
    const projected = projectVerifiedTaskChanges([
      checkpoint(1, "stage-1", [change("src/retry.ts", "modify", "v1", "attempt one")]),
      checkpoint(2, "stage-1", [change("src/retry.ts", "modify", "v2", "attempt two")]),
      checkpoint(3, "stage-2", [change("src/final.ts", "create", "done", "final")]),
    ]);
    expect(projected.map((item) => item.path)).toEqual(["src/retry.ts", "src/final.ts"]);
    expect(projected[0].content).toBe("v2");
  });

  test("single-stage verified response remains unchanged and an unverified response is fail-closed", () => {
    const verifiedChange = change("src/only.ts", "modify", "verified", "single stage");
    const single = response({ changes: [verifiedChange], taskExecutionPlan: undefined, compoundTaskStatus: "VERIFIED" });
    expect(buildVerifiedTaskResult(single, [checkpoint(1, "stage-1", [verifiedChange])])).toBe(single);
    expect(buildVerifiedTaskResult(response(), []).changes).toEqual([]);
  });

  test("journal projection is stage/order/revision bound and ignores a forged validation boolean on a rolled-back entry", () => {
    const entry = checkpoint(4, "stage-4", [change("src/value.ts", "modify", "verified", "verified")]);
    expect(entry).toMatchObject({
      sequence: 4,
      stageId: "stage-4",
      repositoryRevisionBefore: "revision-3",
      repositoryRevisionAfter: "revision-4",
      status: "VERIFIED",
    });
    const rolledBack = { ...checkpoint(5, "stage-5", [change("src/forged.ts", "create", "bad", "bad")], "ROLLED_BACK"), validation: { source: "NOT_COMPLETED" as const, passed: true, reasons: [] } };
    expect(projectVerifiedTaskChanges([entry, rolledBack])).toEqual(entry.verifiedChanges);
  });

  test("a disconnected verified revision cannot overwrite the contiguous verified lineage", () => {
    const first = checkpoint(1, "stage-1", [change("src/shared.ts", "modify", "trusted", "trusted")]);
    const disconnected = {
      ...checkpoint(2, "stage-2", [change("src/shared.ts", "modify", "stale", "stale")]),
      repositoryRevisionBefore: "unrelated-revision",
    };
    expect(projectVerifiedTaskChanges([first, disconnected])).toEqual(first.verifiedChanges);
  });

  test("the coordinator returns all verified stage results only after the final stage", async () => {
    const runtime = TaskRuntime.create({
      taskId: "compound-runtime",
      originalGoal: "Replace an existing feature",
      workspace: AgentWorkspaceState.create({ projectId: "project", root: process.cwd() }),
    });
    runtime.start();
    const first = change("src/legacy.ts", "delete", "", "remove legacy feature");
    const second = change("src/replacement.ts", "create", "replacement", "create replacement feature");
    let iteration = 0;
    const result = await AgentLoopCoordinator.runPipeline({
      runtime,
      workingPlan: WorkingPlan.create({ id: "compound-working-plan" }),
      maxIterations: 2,
      observe: async () => ({ workspace: runtime.workspaceState(), revision: `revision-${iteration}` }),
      executeIteration: async () => {
        iteration += 1;
        if (iteration === 1) {
          return {
            response: response({ changes: [first], taskExecutionPlan: plan("VERIFIED", "PENDING"), compoundTaskStatus: "RUNNING" }),
            journalEntry: checkpoint(1, "stage-1", [first]),
          };
        }
        return {
          response: response({ changes: [second], taskExecutionPlan: plan("VERIFIED", "VERIFIED"), compoundTaskStatus: "VERIFIED" }),
          journalEntry: checkpoint(2, "stage-2", [second]),
        };
      },
    });

    expect(iteration).toBe(2);
    expect(result.loop.outcome).toBe("AWAITING_COMPLETION_EVALUATION");
    expect(result.response.changes).toEqual([first, second]);
    expect(result.loop.verifiedCheckpointIds).toEqual(["journal-1", "journal-2"]);
  });

  test("a later fallback cannot erase an earlier verified checkpoint or include the failed candidate", async () => {
    const runtime = TaskRuntime.create({
      taskId: "partial-runtime",
      originalGoal: "Replace an existing feature",
      workspace: AgentWorkspaceState.create({ projectId: "project", root: process.cwd() }),
    });
    runtime.start();
    const first = change("src/stable.ts", "modify", "verified", "verified progress");
    let iteration = 0;
    const result = await AgentLoopCoordinator.runPipeline({
      runtime,
      workingPlan: WorkingPlan.create({ id: "partial-working-plan" }),
      maxIterations: 2,
      observe: async () => ({ workspace: runtime.workspaceState(), revision: `revision-${iteration}` }),
      executeIteration: async () => {
        iteration += 1;
        if (iteration === 1) {
          return {
            response: response({ changes: [first], taskExecutionPlan: plan("VERIFIED", "PENDING"), compoundTaskStatus: "RUNNING" }),
            journalEntry: checkpoint(1, "stage-1", [first]),
          };
        }
        return {
          response: response({
            changes: [change("src/failed.ts", "create", "candidate", "failed candidate")],
            errorCode: "PLANNING_IDENTICAL_FAILED_ACTION",
            taskExecutionPlan: plan("VERIFIED", "FAILED"),
            compoundTaskStatus: "FAILED",
          }),
        };
      },
    });

    expect(result.loop.outcome).toBe("VALIDATION_FAILURE");
    expect(result.response.changes).toEqual([first]);
    expect(result.response.changes.map((item) => item.path)).not.toContain("src/failed.ts");
  });

  test("a post-verification exception still projects the checkpoint from the authoritative journal", async () => {
    const runtime = TaskRuntime.create({
      taskId: "journal-fallback-runtime",
      originalGoal: "Apply a verified change",
      workspace: AgentWorkspaceState.create({ projectId: "project", root: process.cwd() }),
    });
    runtime.start();
    const firstChange = change("src/first.ts", "create", "first", "first");
    const secondChange = change("src/second.ts", "create", "second", "second");
    const first = checkpoint(1, "stage-1", [firstChange]);
    const second = checkpoint(2, "stage-2", [secondChange]);
    const entries: ActionGroupJournalEntry[] = [first];
    const journalView = { snapshot: () => [...entries] } as unknown as VerifiedCheckpointJournal;
    let iteration = 0;
    const result = await AgentLoopCoordinator.runPipeline({
      runtime,
      workingPlan: WorkingPlan.create({ id: "journal-fallback-plan" }),
      maxIterations: 2,
      checkpointJournal: journalView,
      observe: async () => ({ workspace: runtime.workspaceState(), revision: "revision-0" }),
      executeIteration: async () => {
        iteration += 1;
        if (iteration === 1) {
          return {
            response: response({ changes: [firstChange], taskExecutionPlan: plan("VERIFIED", "PENDING"), compoundTaskStatus: "RUNNING" }),
            journalEntry: first,
          };
        }
        entries.push(second);
        throw new Error("post-verification formatting failed");
      },
    });

    expect(result.loop.outcome).toBe("TECHNICAL_FAILURE");
    expect(result.response.changes).toEqual([firstChange, secondChange]);
  });

  test("the complete SSE path forwards the backend result and contains no frontend aggregation", () => {
    const controller = fs.readFileSync(path.join(__dirname, "../../controllers/ai-controller.ts"), "utf8");
    expect(controller).toContain('sendEvent("complete", result)');
    expect(controller).not.toMatch(/aggregate.*changes|stitch.*stage/i);
  });

  test("validation reporting does not claim functional interactions from render/static evidence", () => {
    const checklist = PipelineResultBuilder.buildChecklist(
      { pipeline: "REPOSITORY", environment: "REACT_TS" } as Parameters<typeof PipelineResultBuilder.buildChecklist>[0],
      { overallPassed: true, checks: [], failedChecks: [], repairActions: [] },
      1,
      true,
      true,
      true,
    );
    expect(checklist.some((item) => item.label === "Feature functional & working")).toBe(false);
    expect(checklist).toContainEqual({ label: "Deterministic feature validation passed", checked: true, category: "Validation" });
  });
});
