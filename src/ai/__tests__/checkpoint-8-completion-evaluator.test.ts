import fs from "fs";
import os from "os";
import path from "path";
import { ValidationCoordinator } from "../orchestration/ValidationCoordinator";
import { AuthorizedCapabilityScope, CapabilityGrant } from "../runtime/CapabilityGuard";
import {
  CompletionEvaluationInput,
  CompletionEvaluator,
  VerifiedCompletionReceipt,
} from "../runtime/CompletionEvaluator";
import { AgentWorkspaceState } from "../runtime/AgentWorkspaceState";
import { BaselineDiagnosticVerifier } from "../runtime/BaselineDiagnosticVerifier";
import { TaskRuntime } from "../runtime/TaskRuntime";
import { VerifiedCheckpointJournal } from "../runtime/VerifiedCheckpointJournal";
import type { AgentFileChange } from "../../types";

describe("Checkpoint 8 deterministic CompletionEvaluator", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cp8-completion-"));
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  function runtime(goal = "Implement the requested deterministic change"): TaskRuntime {
    const value = TaskRuntime.create({
      taskId: "cp8-task",
      originalGoal: goal,
      workspace: AgentWorkspaceState.create({ projectId: "cp8-project", root, revision: "baseline" }),
    });
    value.start();
    return value;
  }

  function authority(stageId: string, grants: readonly CapabilityGrant[]): AuthorizedCapabilityScope {
    const value = AuthorizedCapabilityScope.fromBackendConfiguration({
      workspaceRoot: root,
      authorityId: `cp8:${stageId}`,
      grants,
    });
    if (!value) throw new Error("CP8 test authority must be valid");
    return value;
  }

  async function verifiedJournal(value: TaskRuntime): Promise<VerifiedCheckpointJournal> {
    fs.writeFileSync(path.join(root, "src", "value.ts"), "before", "utf8");
    const journal = new VerifiedCheckpointJournal();
    const changes: AgentFileChange[] = [{
      path: "src/value.ts",
      action: "modify",
      content: "after",
      description: "Apply verified change",
    }];
    const execution = await ValidationCoordinator.applyLocalActionGroup({
      stageId: "stage-1",
      localPath: root,
      authorizedCapabilityScope: authority("stage-1", [{ path: "src/value.ts", action: "FILE_MODIFY" }]),
      changes,
      journal,
    });
    value.updateWorkspace(value.workspaceState().withCheckpointReference({
      id: execution.journalEntry.journalId,
      sequence: execution.journalEntry.sequence,
      actionGroupId: execution.journalEntry.actionGroupId,
      status: execution.journalEntry.status,
      source: "VERIFIED_CHECKPOINT_JOURNAL",
    }));
    return journal;
  }

  function prepare(value: TaskRuntime, revision = "revision-current"): void {
    value.updateWorkspace(value.workspaceState().withEvidence({
      id: `completion:${revision}`,
      kind: "MATERIALIZED_REPOSITORY",
      description: "Fresh disk reality for completion.",
      revision,
    }).withWorkingPlan({ id: "plan-cp8", revision: 2, status: "AWAITING_COMPLETION_EVALUATION" }));
  }

  function input(
    value: TaskRuntime,
    journal: VerifiedCheckpointJournal,
    overrides: Partial<CompletionEvaluationInput> = {},
  ): CompletionEvaluationInput {
    const revision = "revision-current";
    return {
      runtime: value,
      handoff: { outcome: "AWAITING_COMPLETION_EVALUATION", workingPlanId: "plan-cp8", workingPlanRevision: 2 },
      journal,
      repository: {
        root,
        revision,
        changedPaths: journal.verifiedCheckpoints().flatMap((entry) => entry.attemptedActions.map((action) => action.path)),
        source: "MATERIALIZED_REPOSITORY",
        coverage: "FULL_REPOSITORY_DELTA",
      },
      validation: { passed: true, repositoryRevision: revision, source: "VALIDATION_COORDINATOR" },
      requirements: [{
        id: "required-stage",
        description: "The required stage is verified.",
        required: true,
        status: "SATISFIED",
        repositoryRevision: revision,
        checkpointIds: journal.verifiedCheckpoints().map((entry) => entry.journalId),
      }],
      ...overrides,
    };
  }

  function diagnosticComparison(introduced: boolean) {
    const baseline = BaselineDiagnosticVerifier.capture({
      phase: "BASELINE",
      passed: !introduced,
      commands: ["npx tsc --noEmit"],
      diagnostics: introduced ? [{ category: "TYPE", filePath: "src/old.ts", message: "old error" }] : [],
      repositoryRoot: root,
      source: "DETERMINISTIC_TOOL",
    });
    const current = BaselineDiagnosticVerifier.capture({
      phase: "CURRENT",
      passed: false,
      commands: ["npx tsc --noEmit"],
      diagnostics: introduced
        ? [
            { category: "TYPE", filePath: "src/old.ts", message: "old error" },
            { category: "TYPE", filePath: "src/new.ts", message: "introduced error" },
          ]
        : [{ category: "TYPE", filePath: "src/old.ts", message: "old error" }],
      repositoryRoot: root,
      source: "DETERMINISTIC_TOOL",
    });
    return BaselineDiagnosticVerifier.compare(baseline, current);
  }

  test("1, 7, 13. fully verified task is eligible and authentic evaluator success completes TaskRuntime", async () => {
    const value = runtime();
    const journal = await verifiedJournal(value);
    prepare(value);
    const result = CompletionEvaluator.evaluate(input(value, journal));
    expect(result.outcome).toBe("COMPLETE");
    if (result.outcome !== "COMPLETE") throw new Error(result.code);
    const replayTarget = runtime();
    expect(() => replayTarget.complete(result.receipt)).toThrow(/authentic CompletionEvaluator receipt/);
    value.complete(result.receipt);
    expect(value.snapshot()).toMatchObject({
      status: "COMPLETED",
      terminalOutcome: { type: "COMPLETED", validationSource: "COMPLETION_EVALUATOR" },
    });
    expect(CompletionEvaluator.evaluate(input(value, journal))).toMatchObject({
      outcome: "INCOMPLETE", code: "RUNTIME_NOT_RUNNING",
    });
  });

  test("2. model done cannot override failing deterministic validation", () => {
    const value = runtime("model says done");
    prepare(value);
    const result = CompletionEvaluator.evaluate(input(value, new VerifiedCheckpointJournal(), {
      validation: { passed: false, repositoryRevision: "revision-current", source: "VALIDATION_RUNNER" },
    }));
    expect(result).toMatchObject({ outcome: "INCOMPLETE", code: "DETERMINISTIC_VALIDATION_FAILED", category: "VALIDATION_FAILURE" });
    expect(value.snapshot().status).toBe("RUNNING");
  });

  test("3, 10. planner NO_ACTION and partially satisfied requirements remain incomplete", () => {
    const value = runtime();
    prepare(value);
    const result = CompletionEvaluator.evaluate(input(value, new VerifiedCheckpointJournal(), {
      requirements: [
        { id: "one", description: "first", required: true, status: "SATISFIED", repositoryRevision: "revision-current" },
        { id: "two", description: "second", required: true, status: "UNSATISFIED" },
      ],
    }));
    expect(result).toMatchObject({ outcome: "INCOMPLETE", code: "UNRESOLVED_REQUIRED_WORK" });
  });

  test("unverified current changes and absent expected repository changes cannot complete", async () => {
    const unverified = runtime();
    fs.writeFileSync(path.join(root, "src", "unverified.ts"), "unverified", "utf8");
    prepare(unverified);
    expect(CompletionEvaluator.evaluate(input(unverified, new VerifiedCheckpointJournal(), {
      repository: {
        root, revision: "revision-current", changedPaths: ["src/unverified.ts"],
        source: "MATERIALIZED_REPOSITORY", coverage: "FULL_REPOSITORY_DELTA",
      },
    }))).toMatchObject({ outcome: "INCOMPLETE", code: "UNVERIFIED_REPOSITORY_CHANGE" });

    const expected = runtime();
    const journal = await verifiedJournal(expected);
    prepare(expected);
    expect(CompletionEvaluator.evaluate(input(expected, journal, {
      repository: {
        root, revision: "revision-current", changedPaths: [],
        source: "MATERIALIZED_REPOSITORY", coverage: "FULL_REPOSITORY_DELTA",
      },
    }))).toMatchObject({ outcome: "INCOMPLETE", code: "EXPECTED_REPOSITORY_CHANGE_ABSENT" });
  });

  test("4. an introduced diagnostic prevents completion", () => {
    const value = runtime();
    prepare(value);
    const comparison = diagnosticComparison(true);
    const result = CompletionEvaluator.evaluate(input(value, new VerifiedCheckpointJournal(), {
      diagnosticComparison: comparison,
      diagnosticRepositoryRevision: "revision-current",
      diagnosticsRequired: true,
    }));
    expect(result).toMatchObject({ outcome: "INCOMPLETE", code: "TASK_INTRODUCED_DIAGNOSTIC" });
  });

  test("5. only pre-existing diagnostics are not falsely attributed to the task", () => {
    const value = runtime();
    prepare(value);
    const baseline = BaselineDiagnosticVerifier.capture({
      phase: "BASELINE", passed: false, commands: ["tsc"],
      diagnostics: [{ category: "TYPE", filePath: "src/old.ts", message: "old error" }],
      repositoryRoot: root, source: "DETERMINISTIC_TOOL",
    });
    const current = BaselineDiagnosticVerifier.capture({
      phase: "CURRENT", passed: false, commands: ["tsc"],
      diagnostics: [{ category: "TYPE", filePath: "src/old.ts", message: "old error" }],
      repositoryRoot: root, source: "DETERMINISTIC_TOOL",
    });
    const result = CompletionEvaluator.evaluate(input(value, new VerifiedCheckpointJournal(), {
      diagnosticComparison: BaselineDiagnosticVerifier.compare(baseline, current),
      diagnosticRepositoryRevision: "revision-current",
      diagnosticsRequired: true,
    }));
    expect(result.outcome).toBe("COMPLETE");
  });

  test("6. rolled-back latest ActionGroup cannot complete", async () => {
    fs.writeFileSync(path.join(root, "src", "value.ts"), "before", "utf8");
    const value = runtime();
    const journal = new VerifiedCheckpointJournal();
    await expect(ValidationCoordinator.applyLocalActionGroup({
      stageId: "stage-denied",
      localPath: root,
      authorizedCapabilityScope: authority("stage-denied", [{ path: "src/other.ts", action: "FILE_CREATE" }]),
      changes: [{ path: "src/value.ts", action: "modify", content: "denied", description: "denied" }],
      journal,
    })).rejects.toThrow();
    const entry = journal.snapshot()[0];
    value.updateWorkspace(value.workspaceState().withCheckpointReference({
      id: entry.journalId, sequence: entry.sequence, actionGroupId: entry.actionGroupId,
      status: entry.status, source: "VERIFIED_CHECKPOINT_JOURNAL",
    }));
    prepare(value);
    expect(CompletionEvaluator.evaluate(input(value, journal))).toMatchObject({
      outcome: "INCOMPLETE", code: "LATEST_ACTION_GROUP_NOT_VERIFIED",
    });
  });

  test("8. validation for a stale repository revision cannot complete", () => {
    const value = runtime();
    prepare(value);
    expect(CompletionEvaluator.evaluate(input(value, new VerifiedCheckpointJournal(), {
      validation: { passed: true, repositoryRevision: "older-revision", source: "VALIDATION_RUNNER" },
    }))).toMatchObject({ outcome: "INCOMPLETE", code: "STALE_VALIDATION_REVISION" });
  });

  test("9. unresolved authorization denial is BLOCKED", () => {
    const value = runtime();
    value.updateWorkspace(value.workspaceState().withFailureFact({
      id: "denial", code: "CAPABILITY_PATH_DENIED", category: "AUTHORIZATION_DENIAL", source: "DETERMINISTIC_RUNTIME",
    }));
    prepare(value);
    expect(CompletionEvaluator.evaluate(input(value, new VerifiedCheckpointJournal()))).toMatchObject({
      outcome: "BLOCKED", category: "AUTHORIZATION_DENIAL", code: "CAPABILITY_PATH_DENIED",
    });
  });

  test("11. plain or fake completion receipt cannot complete TaskRuntime", () => {
    const value = runtime();
    expect(() => value.complete({ source: "COMPLETION_EVALUATOR", evaluationId: "fake", taskId: "cp8-task" } as VerifiedCompletionReceipt))
      .toThrow(/authentic CompletionEvaluator receipt/);
    expect(value.snapshot().status).toBe("RUNNING");
  });

  test("12. ordinary backend caller has no completion receipt minting API", () => {
    const completionModule = require("../runtime/CompletionEvaluator") as Record<string, unknown>;
    expect(completionModule.AuthenticCompletionReceipt).toBeUndefined();
    expect(completionModule.VerifiedCompletionReceipt).toBeUndefined();
    expect(completionModule.fromDeterministicValidation).toBeUndefined();
  });

  test("14. technical failure remains technical failure, never clarification", () => {
    const value = runtime();
    prepare(value);
    const result = CompletionEvaluator.evaluate(input(value, new VerifiedCheckpointJournal(), {
      validation: {
        passed: false,
        repositoryRevision: "revision-current",
        source: "VALIDATION_RUNNER",
        technicalFailure: { code: "DISK_READ_FAILED", message: "disk unavailable" },
      },
    }));
    expect(result).toMatchObject({ outcome: "TECHNICAL_FAILURE", code: "DISK_READ_FAILED" });
  });

  test("15. genuine missing user information returns CLARIFICATION_REQUIRED", () => {
    const value = runtime();
    prepare(value);
    const result = CompletionEvaluator.evaluate(input(value, new VerifiedCheckpointJournal(), {
      requirements: [{
        id: "target", description: "Choose exact target", required: true, status: "MISSING_INFORMATION",
        clarification: { question: "Which target should be changed?", reason: "Two authorized targets are equally valid." },
      }],
    }));
    expect(result).toMatchObject({
      outcome: "CLARIFICATION_REQUIRED",
      question: "Which target should be changed?",
    });
  });

  test("16. production CP7 handoff invokes CompletionEvaluator in AgentPipeline and Git worktree boundary", () => {
    const pipeline = fs.readFileSync(path.join(__dirname, "../orchestration/AgentPipeline.ts"), "utf8");
    const gitWorktree = fs.readFileSync(path.join(__dirname, "../../services/git-worktree.service.ts"), "utf8");
    expect(pipeline).toContain('result.loop.outcome === "AWAITING_COMPLETION_EVALUATION"');
    expect(pipeline).toContain("CompletionEvaluator.evaluate");
    expect(pipeline).toContain("deferCompletionToGitWorktree");
    expect(gitWorktree).toContain('agentResponse.agentLoop?.outcome === "AWAITING_COMPLETION_EVALUATION"');
    expect(gitWorktree).toContain("CompletionEvaluator.evaluate");
  });

  test("17. no production TaskRuntime completion bypass exists", () => {
    const productionFiles = [
      path.join(__dirname, "../application/CodingAgent.ts"),
      path.join(__dirname, "../orchestration/AgentPipeline.ts"),
      path.join(__dirname, "../../services/git-worktree.service.ts"),
    ];
    const completionCalls = productionFiles.flatMap((file) =>
      fs.readFileSync(file, "utf8").split(/\r?\n/).filter((line) => line.includes(".complete(")),
    );
    expect(completionCalls).toHaveLength(2);
    expect(completionCalls.every((line) => line.includes(".receipt"))).toBe(true);
    expect(productionFiles.map((file) => fs.readFileSync(file, "utf8")).join("\n"))
      .not.toContain("fromDeterministicValidation");
  });
});
