import fs from "fs";
import os from "os";
import path from "path";
import { AgentLoopCoordinator } from "../orchestration/AgentLoopCoordinator";
import { ValidationCoordinator } from "../orchestration/ValidationCoordinator";
import { AgentWorkspaceState } from "../runtime/AgentWorkspaceState";
import { AuthorizedCapabilityScope, CapabilityGrant } from "../runtime/CapabilityGuard";
import { TaskRuntime } from "../runtime/TaskRuntime";
import { VerifiedCheckpointJournal } from "../runtime/VerifiedCheckpointJournal";
import { WorkingPlan } from "../runtime/WorkingPlan";
import { LLMBudgetExhaustedError } from "../gateway/LLMError";
import { AgentFileChange } from "../../types";
import { StageExecutionTransaction } from "../orchestration/StageExecutionTransaction";

describe("Checkpoint 7 bounded agent loop", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cp7-agent-loop-"));
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src/state.txt"), "v0");
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
  });

  function runtime(): TaskRuntime {
    const value = TaskRuntime.create({
      taskId: "cp7",
      originalGoal: "iterate",
      workspace: AgentWorkspaceState.create({ projectId: "project", root }),
    });
    value.start();
    return value;
  }

  function scope(grants: CapabilityGrant[]): AuthorizedCapabilityScope {
    const value = AuthorizedCapabilityScope.fromBackendConfiguration({
      workspaceRoot: root,
      authorityId: "cp7-authority",
      grants,
    });
    if (!value) throw new Error("fixture authority must be valid");
    return value;
  }

  function observation(value: TaskRuntime, iteration: number) {
    const bytes = fs.readFileSync(path.join(root, "src/state.txt"), "utf8");
    return {
      revision: bytes,
      workspace: value.workspaceState().withEvidence({
        id: `observation:${iteration}:${bytes}`,
        kind: "MATERIALIZED_REPOSITORY" as const,
        description: `disk bytes ${bytes}`,
        path: "src/state.txt",
        revision: bytes,
      }),
    };
  }

  test("1-2. observe-plan-action-validate-state-update repeats from first VERIFIED bytes", async () => {
    const task = runtime();
    const journal = new VerifiedCheckpointJournal();
    const observed: string[] = [];
    const result = await AgentLoopCoordinator.run<AgentFileChange[]>({
      runtime: task,
      workingPlan: WorkingPlan.create({ id: "plan", advisoryStageIds: ["one", "two"] }),
      maxIterations: 2,
      observe: async (iteration) => {
        const current = observation(task, iteration);
        observed.push(current.revision);
        return current;
      },
      plan: async ({ iteration, workingPlan }) => ({
        kind: "ACTION_GROUP",
        workingPlan: iteration === 1 ? workingPlan : workingPlan.revise({ reason: "new verified bytes" }),
        actionGroup: [{
          path: "src/state.txt", action: "modify", content: `v${iteration}`, description: `iteration ${iteration}`,
        }],
      }),
      execute: async (changes, iteration) => {
        const executed = await ValidationCoordinator.applyLocalActionGroup({
          stageId: `stage-${iteration}`,
          localPath: root,
          authorizedCapabilityScope: scope([{ path: "src/state.txt", action: "FILE_MODIFY" }]),
          changes,
          journal,
        });
        return { journalEntry: executed.journalEntry };
      },
    });
    expect(observed).toEqual(["v0", "v1"]);
    expect(fs.readFileSync(path.join(root, "src/state.txt"), "utf8")).toBe("v2");
    expect(result.outcome).toBe("MAX_ITERATIONS_REACHED");
    expect(result.verifiedCheckpointIds).toHaveLength(2);
    expect(task.snapshot().workspace.checkpointReferences).toHaveLength(2);
  });

  test("3-6. a failed group rolls back, is observed as rollback reality, and a revised plan preserves Group A", async () => {
    const task = runtime();
    const journal = new VerifiedCheckpointJournal();
    const observations: string[] = [];
    let failedOnce = false;
    const commit = jest.spyOn(StageExecutionTransaction.prototype, "commit");
    const originalRead = fs.readFileSync;
    const result = await AgentLoopCoordinator.run<AgentFileChange[]>({
      runtime: task,
      workingPlan: WorkingPlan.create({ id: "revisable" }),
      maxIterations: 3,
      observe: async (iteration) => {
        const current = observation(task, iteration);
        observations.push(current.revision);
        return current;
      },
      plan: async ({ iteration, workingPlan, lastFailure }) => ({
        kind: "ACTION_GROUP",
        workingPlan: lastFailure
          ? workingPlan.revise({ reason: "validation fact changed the hypothesis" })
          : workingPlan,
        actionGroup: [{
          path: "src/state.txt", action: "modify", content: iteration === 1 ? "verified-a" : iteration === 2 ? "bad-b" : "verified-c",
          description: "bounded change",
        }],
      }),
      execute: async (changes, iteration) => {
        if (iteration === 2) {
          failedOnce = true;
          const readMock = jest.spyOn(fs, "readFileSync").mockImplementation(((filePath: fs.PathOrFileDescriptor, options?: BufferEncoding | null) => {
            const value = originalRead.call(fs, filePath, options as BufferEncoding);
            return typeof value === "string" && value === "bad-b" ? "mismatched" : value;
          }) as typeof fs.readFileSync);
          const executed = await ValidationCoordinator.applyLocalActionGroup({
            stageId: `revision-${iteration}`,
            localPath: root,
            authorizedCapabilityScope: scope([{ path: "src/state.txt", action: "FILE_MODIFY" }]),
            changes,
            journal,
          });
          readMock.mockRestore();
          return { journalEntry: executed.journalEntry };
        }
        const executed = await ValidationCoordinator.applyLocalActionGroup({
          stageId: `revision-${iteration}`,
          localPath: root,
          authorizedCapabilityScope: scope([{ path: "src/state.txt", action: "FILE_MODIFY" }]),
          changes,
          journal,
        });
        return { journalEntry: executed.journalEntry };
      },
    });
    expect(failedOnce).toBe(true);
    expect(observations).toEqual(["v0", "verified-a", "verified-a"]);
    expect(fs.readFileSync(path.join(root, "src/state.txt"), "utf8")).toBe("verified-c");
    expect(journal.snapshot().map((entry) => entry.status)).toEqual(["VERIFIED", "ROLLED_BACK", "VERIFIED"]);
    expect(commit).toHaveBeenCalledTimes(2);
    expect(result.verifiedCheckpointIds).toHaveLength(2);
    expect(result.workingPlan.snapshot().revision).toBe(2);
  });

  test("verified deletion stays absent in the next authoritative observation", async () => {
    const task = runtime();
    const journal = new VerifiedCheckpointJournal();
    const present: boolean[] = [];
    const result = await AgentLoopCoordinator.run<AgentFileChange[]>({
      runtime: task,
      workingPlan: WorkingPlan.create({ id: "delete" }),
      maxIterations: 2,
      observe: async (iteration) => {
        const exists = fs.existsSync(path.join(root, "src/state.txt"));
        present.push(exists);
        return {
          revision: exists ? "present" : "absent",
          workspace: task.workspaceState().withEvidence({
            id: `delete-observation:${iteration}:${exists}`,
            kind: "MATERIALIZED_REPOSITORY",
            description: exists ? "file exists on disk" : "file is absent on disk",
            revision: exists ? "present" : "absent",
          }),
        };
      },
      plan: async ({ iteration, workingPlan }) => iteration === 1
        ? {
            kind: "ACTION_GROUP",
            workingPlan,
            actionGroup: [{ path: "src/state.txt", action: "delete", isDeleted: true, content: "", description: "delete" }],
          }
        : { kind: "NO_ACTION", workingPlan },
      execute: async (changes) => {
        const executed = await ValidationCoordinator.applyLocalActionGroup({
          stageId: "delete-stage",
          localPath: root,
          authorizedCapabilityScope: scope([{ path: "src/state.txt", action: "FILE_DELETE" }]),
          changes,
          journal,
        });
        return { journalEntry: executed.journalEntry };
      },
    });
    expect(present).toEqual([true, false]);
    expect(result.outcome).toBe("AWAITING_COMPLETION_EVALUATION");
    expect(fs.existsSync(path.join(root, "src/state.txt"))).toBe(false);
  });

  test("7. authorization denial mutates nothing and terminates without looping", async () => {
    const task = runtime();
    let observations = 0;
    const result = await AgentLoopCoordinator.run<AgentFileChange[]>({
      runtime: task,
      workingPlan: WorkingPlan.create({ id: "denied" }),
      maxIterations: 10,
      observe: async (iteration) => { observations += 1; return observation(task, iteration); },
      plan: async ({ workingPlan }) => ({
        kind: "ACTION_GROUP",
        workingPlan,
        actionGroup: [{ path: "src/state.txt", action: "modify", content: "denied", description: "denied" }],
      }),
      execute: async (changes) => {
        const executed = await ValidationCoordinator.applyLocalActionGroup({
          stageId: "denied",
          localPath: root,
          authorizedCapabilityScope: scope([]),
          changes,
        });
        return { journalEntry: executed.journalEntry };
      },
    });
    expect(result.outcome).toBe("AUTHORIZATION_DENIED");
    expect(observations).toBe(1);
    expect(fs.readFileSync(path.join(root, "src/state.txt"), "utf8")).toBe("v0");
  });

  test("8. budget exhaustion preserves earlier VERIFIED progress", async () => {
    const task = runtime();
    const journal = new VerifiedCheckpointJournal();
    const result = await AgentLoopCoordinator.run<AgentFileChange[]>({
      runtime: task,
      workingPlan: WorkingPlan.create({ id: "budget" }),
      maxIterations: 4,
      observe: async (iteration) => observation(task, iteration),
      plan: async ({ iteration, workingPlan }) => {
        if (iteration === 2) throw new LLMBudgetExhaustedError("budget exhausted");
        return {
          kind: "ACTION_GROUP",
          workingPlan,
          actionGroup: [{ path: "src/state.txt", action: "modify", content: "kept", description: "verified" }],
        };
      },
      execute: async (changes) => {
        const executed = await ValidationCoordinator.applyLocalActionGroup({
          stageId: "budget-1",
          localPath: root,
          authorizedCapabilityScope: scope([{ path: "src/state.txt", action: "FILE_MODIFY" }]),
          changes,
          journal,
        });
        return { journalEntry: executed.journalEntry };
      },
    });
    expect(result.outcome).toBe("BUDGET_EXHAUSTED");
    expect(result.verifiedCheckpointIds).toHaveLength(1);
    expect(fs.readFileSync(path.join(root, "src/state.txt"), "utf8")).toBe("kept");
    expect(task.snapshot().terminalOutcome).toMatchObject({ failureType: "BUDGET_EXHAUSTED" });
  });

  test("9-12. bounds and advisory/model assertions cannot create completion or verified facts", async () => {
    const task = runtime();
    const plan = WorkingPlan.create({ id: "advisory", advisoryHypothesis: "model says done" });
    const result = await AgentLoopCoordinator.run<never>({
      runtime: task,
      workingPlan: plan,
      maxIterations: 1,
      observe: async (iteration) => observation(task, iteration),
      plan: async ({ workingPlan }) => ({ kind: "NO_ACTION", workingPlan }),
      execute: async () => { throw new Error("unreachable"); },
    });
    expect(result.outcome).toBe("AWAITING_COMPLETION_EVALUATION");
    expect(task.snapshot().status).toBe("RUNNING");
    expect(task.snapshot().workspace.validationFacts).toEqual([]);
    expect(plan.snapshot().authority).toBe("ADVISORY_ONLY_NO_FILESYSTEM_AUTHORITY");

    const technical = runtime();
    const technicalResult = await AgentLoopCoordinator.run<never>({
      runtime: technical,
      workingPlan: WorkingPlan.create({ id: "technical" }),
      maxIterations: 3,
      observe: async () => { throw new Error("disk failed"); },
      plan: async () => { throw new Error("unreachable"); },
      execute: async () => { throw new Error("unreachable"); },
    });
    expect(technicalResult.outcome).toBe("TECHNICAL_FAILURE");
    expect(technical.snapshot().status).toBe("FAILED");
    expect(technical.snapshot().clarification).toBeUndefined();
  });

  test("13-14. production CodingAgent routes AgentPipeline through the bounded loop without a legacy completion bypass", () => {
    const pipeline = fs.readFileSync(path.join(__dirname, "../orchestration/AgentPipeline.ts"), "utf8");
    const codingAgent = fs.readFileSync(path.join(__dirname, "../application/CodingAgent.ts"), "utf8");
    expect(pipeline).toContain("AgentLoopCoordinator.runPipeline");
    expect(pipeline).toContain("this.runSingleIteration");
    expect(pipeline).toContain("checkpointJournal: journal");
    expect(codingAgent).toContain("taskRuntime: runtime");
    expect(codingAgent).not.toContain("runtime.complete(");
    expect(codingAgent).not.toContain("VerifiedCompletionReceipt.fromDeterministicValidation");
  });
});
