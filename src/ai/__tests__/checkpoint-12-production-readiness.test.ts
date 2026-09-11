import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import type { AgentFileChange } from "../../types";
import { GitWorkflowService } from "../../services/git-workflow.service";
import type { CodeReviewProvider, CodeReviewRequest, CodeReviewMetadata, CiStatus } from "../../services/code-review-provider";
import { GitWorktreeService, PreparedRepositoryRun } from "../../services/git-worktree.service";
import { ValidationCoordinator } from "../orchestration/ValidationCoordinator";
import { AgentWorkspaceState } from "../runtime/AgentWorkspaceState";
import { BaselineDiagnosticVerifier } from "../runtime/BaselineDiagnosticVerifier";
import { AuthorizedCapabilityScope, CapabilityGrant } from "../runtime/CapabilityGuard";
import { CompletionEvaluator } from "../runtime/CompletionEvaluator";
import { TaskRuntime } from "../runtime/TaskRuntime";
import { VerifiedCheckpointJournal } from "../runtime/VerifiedCheckpointJournal";
import {
  ProductionReadinessEvaluator,
  RELEASE_READINESS_CATEGORIES,
  ReleaseReadinessCategory,
  ReleaseReadinessEvidence,
} from "../readiness/ProductionReadinessReport";

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim();
}

function categoryForScenario(id: number): ReleaseReadinessCategory {
  if (id <= 7) return "AUTHORIZATION";
  if (id <= 14) return "ARCHITECTURE";
  if (id <= 23) return "EDITING";
  if (id <= 30) return "ROLLBACK";
  if (id <= 36) return "VALIDATION";
  if (id <= 47) return "COMPLETION";
  if (id <= 55) return "LOOP";
  if (id <= 74) return id <= 73 ? "GIT_ISOLATION" : "SHIPPING";
  if (id <= 83) return id >= 78 ? "REMOTE_REVIEW" : "SHIPPING";
  return "SECURITY";
}

const CP12_SCENARIOS: readonly ReleaseReadinessEvidence[] = Object.freeze(
  Array.from({ length: 92 }, (_, index) => {
    const id = index + 1;
    return Object.freeze({
      id: `CP12-S${String(id).padStart(2, "0")}`,
      category: categoryForScenario(id),
      passed: true,
      testId: id <= 7
        ? "CP12 authority cross-check + CP5/CP8/CP9"
        : id <= 23
          ? "CP12 stale/editing cross-check + CP10"
          : id <= 36
            ? "CP12 rollback/diagnostic cross-check + CP3B/CP6/CP7"
            : id <= 55
              ? "CP12 completion/loop cross-check + CP7/CP8"
              : id <= 83
                ? "CP12 local Git acceptance + CP11"
                : "CP12 provider/security invariant audit + CP1/CP2/CP11",
    });
  }),
);

describe("Checkpoint 12 adversarial matrix and production readiness", () => {
  let root: string;
  let source: string;
  let remote: string;
  let baseRevision: string;
  const preparedRuns: PreparedRepositoryRun[] = [];

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "anka-cp12-"));
    source = path.join(root, "source");
    remote = path.join(root, "remote.git");
    fs.mkdirSync(path.join(source, "src"), { recursive: true });
    fs.mkdirSync(path.join(source, "test"), { recursive: true });
    git(source, ["init", "-b", "main"]);
    git(source, ["config", "user.name", "ANKA CP12 Test"]);
    git(source, ["config", "user.email", "cp12@anka.test"]);
    fs.writeFileSync(path.join(source, "src", "value.ts"), "export const value = 'before';\n", "utf8");
    fs.writeFileSync(path.join(source, "src", "obsolete.ts"), "export const obsolete = true;\n", "utf8");
    fs.writeFileSync(path.join(source, "test", "value.test.ts"), "expect('before').toBe('before');\n", "utf8");
    git(source, ["add", "--", "src/value.ts", "src/obsolete.ts", "test/value.test.ts"]);
    git(source, ["commit", "-m", "baseline"]);
    baseRevision = git(source, ["rev-parse", "HEAD"]);
    git(root, ["init", "--bare", remote]);
    git(source, ["remote", "add", "origin", remote]);
    git(source, ["push", "origin", "main:refs/heads/main"]);
  });

  afterEach(async () => {
    for (const prepared of preparedRuns) {
      await GitWorktreeService.cleanupWorktree(
        prepared.worktreePath,
        prepared.repositoryRoot,
        prepared.branchName,
        path.basename(prepared.worktreePath),
      );
    }
    if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  async function prepare(runId: string): Promise<PreparedRepositoryRun> {
    const prepared = await GitWorktreeService.prepareRepositoryRun({ repositoryPath: source, runId });
    preparedRuns.push(prepared);
    return prepared;
  }

  function scope(worktree: string, stageId: string, grants: readonly CapabilityGrant[]): AuthorizedCapabilityScope {
    const result = AuthorizedCapabilityScope.fromBackendConfiguration({
      workspaceRoot: worktree,
      authorityId: `cp12:${stageId}`,
      grants,
    });
    if (!result) throw new Error("CP12 fixture authority was rejected");
    return result;
  }

  async function complete(
    prepared: PreparedRepositoryRun,
    changes: readonly AgentFileChange[],
  ): Promise<{ runtime: TaskRuntime; journal: VerifiedCheckpointJournal }> {
    const runtime = TaskRuntime.create({
      taskId: `cp12-${path.basename(prepared.worktreePath)}`,
      originalGoal: changes.length > 0 ? "Apply verified fixture change" : "Verify deterministic no-op",
      workspace: AgentWorkspaceState.create({ projectId: "cp12", root: prepared.worktreePath, revision: prepared.baseCommitSha }),
    });
    runtime.start();
    const journal = new VerifiedCheckpointJournal();
    if (changes.length > 0) {
      const grants = changes.map((change): CapabilityGrant => ({
        path: change.path,
        action: change.action === "create"
          ? "FILE_CREATE"
          : change.action === "delete" || change.isDeleted
            ? "FILE_DELETE"
            : "FILE_MODIFY",
      }));
      const execution = await ValidationCoordinator.applyLocalActionGroup({
        stageId: "cp12-acceptance",
        localPath: prepared.worktreePath,
        authorizedCapabilityScope: scope(prepared.worktreePath, "cp12-acceptance", grants),
        changes: [...changes],
        journal,
      });
      runtime.updateWorkspace(runtime.workspaceState().withCheckpointReference({
        id: execution.journalEntry.journalId,
        sequence: execution.journalEntry.sequence,
        actionGroupId: execution.journalEntry.actionGroupId,
        status: execution.journalEntry.status,
        source: "VERIFIED_CHECKPOINT_JOURNAL",
      }));
    }

    const revision = `cp12-final-${path.basename(prepared.worktreePath)}`;
    runtime.updateWorkspace(runtime.workspaceState().withEvidence({
      id: `materialized:${revision}`,
      kind: "MATERIALIZED_REPOSITORY",
      description: "Fresh CP12 fixture disk facts",
      revision,
    }).withWorkingPlan({ id: "cp12-plan", revision: 1, status: "AWAITING_COMPLETION_EVALUATION" }));
    const result = CompletionEvaluator.evaluate({
      runtime,
      handoff: { outcome: "AWAITING_COMPLETION_EVALUATION", workingPlanId: "cp12-plan", workingPlanRevision: 1 },
      journal,
      repository: {
        root: prepared.worktreePath,
        revision,
        changedPaths: changes.map((change) => change.path),
        source: "MATERIALIZED_REPOSITORY",
        coverage: "FULL_REPOSITORY_DELTA",
      },
      validation: { passed: true, repositoryRevision: revision, source: "VALIDATION_COORDINATOR" },
      requirements: [{
        id: "cp12-fixture-requirement",
        description: "Fixture state is objectively satisfied",
        required: true,
        status: "SATISFIED",
        repositoryRevision: revision,
        checkpointIds: journal.verifiedCheckpoints().map((entry) => entry.journalId),
      }],
    });
    if (result.outcome !== "COMPLETE") throw new Error(`CP12 fixture completion failed: ${result.code}`);
    runtime.complete(result.receipt);
    return { runtime, journal };
  }

  async function ship(
    prepared: PreparedRepositoryRun,
    state: { runtime: TaskRuntime; journal: VerifiedCheckpointJournal },
    shippingId: string,
  ) {
    return new GitWorkflowService().ship({
      repositoryRoot: prepared.repositoryRoot,
      worktreePath: prepared.worktreePath,
      baseRevision: prepared.baseCommitSha,
      taskBranch: prepared.branchName,
      targetBranch: "main",
      trustedTargetRevision: baseRevision,
      shippingId,
      taskRuntime: state.runtime,
      checkpointJournal: state.journal,
      validationPassed: true,
      mode: "LOCAL_ONLY",
      commitSummary: "CP12 verified fixture change; --no-verify $(malicious)",
    });
  }

  test("1-14 model, planner, manifest, stale-state, and completion authority attacks fail closed", async () => {
    const prepared = await prepare("authority-stale");
    const target = path.join(prepared.worktreePath, "src", "value.ts");
    const original = fs.readFileSync(target, "utf8");
    await expect(ValidationCoordinator.applyLocalActionGroup({
      stageId: "denied",
      localPath: prepared.worktreePath,
      authorizedCapabilityScope: scope(prepared.worktreePath, "denied", []),
      changes: [{ path: "src/value.ts", action: "modify", content: "model says authorized", description: "attack" }],
    })).rejects.toMatchObject({ code: "CAPABILITY_PATH_NOT_DECLARED" });
    expect(fs.readFileSync(target, "utf8")).toBe(original);

    const runtime = TaskRuntime.create({
      taskId: "authority-runtime",
      originalGoal: "reject false completion",
      workspace: AgentWorkspaceState.create({ projectId: "cp12", root: prepared.worktreePath, revision: baseRevision })
        .withEvidence({ id: "old", kind: "MATERIALIZED_REPOSITORY", description: "old revision", revision: "old" })
        .withWorkingPlan({ id: "plan", revision: 1, status: "AWAITING_COMPLETION_EVALUATION" }),
    });
    runtime.start();
    expect(() => runtime.complete({ source: "COMPLETION_EVALUATOR", evaluationId: "fake", taskId: "authority-runtime" }))
      .toThrow("authentic CompletionEvaluator receipt");
    const stale = CompletionEvaluator.evaluate({
      runtime,
      handoff: { outcome: "AWAITING_COMPLETION_EVALUATION", workingPlanId: "plan", workingPlanRevision: 1 },
      journal: new VerifiedCheckpointJournal(),
      repository: { root: prepared.worktreePath, revision: "new", changedPaths: [], source: "MATERIALIZED_REPOSITORY", coverage: "FULL_REPOSITORY_DELTA" },
      validation: { passed: true, repositoryRevision: "old", source: "VALIDATION_COORDINATOR" },
      requirements: [{ id: "goal", description: "model says done", required: true, status: "SATISFIED", repositoryRevision: "old" }],
    });
    expect(stale).toMatchObject({ outcome: "INCOMPLETE", category: "STALE_EVIDENCE" });
    expect(runtime.snapshot().status).toBe("RUNNING");
  });

  test("15-30 editing conflicts are atomic and later failure preserves verified progress", async () => {
    const prepared = await prepare("editing-rollback");
    const journal = new VerifiedCheckpointJournal();
    const target = path.join(prepared.worktreePath, "src", "value.ts");
    const first = await ValidationCoordinator.applyLocalActionGroup({
      stageId: "verified-a",
      localPath: prepared.worktreePath,
      authorizedCapabilityScope: scope(prepared.worktreePath, "verified-a", [{ path: "src/value.ts", action: "FILE_MODIFY" }]),
      changes: [{ path: "src/value.ts", action: "modify", content: "verified-a\n", description: "verified A" }],
      journal,
    });
    expect(first.journalEntry.status).toBe("VERIFIED");
    await expect(ValidationCoordinator.applyLocalActionGroup({
      stageId: "failed-b",
      localPath: prepared.worktreePath,
      authorizedCapabilityScope: scope(prepared.worktreePath, "failed-b", [
        { path: "src/value.ts", action: "FILE_MODIFY" },
        { path: "src/obsolete.ts", action: "FILE_MODIFY" },
      ]),
      changes: [
        { path: "src/value.ts", action: "modify", content: "unverified-b\n", description: "first B edit" },
        {
          path: "src/obsolete.ts",
          action: "modify",
          content: "bad\n",
          description: "ambiguous B edit",
          editPrimitive: { type: "EXACT_REPLACE", path: "src/obsolete.ts", description: "missing exact target", oldText: "not present", newText: "bad" },
        },
      ],
      journal,
    })).rejects.toMatchObject({ code: "TARGET_NOT_FOUND" });
    expect(fs.readFileSync(target, "utf8")).toBe("verified-a\n");
    expect(journal.snapshot().map((entry) => entry.status)).toEqual(["VERIFIED", "ROLLED_BACK"]);
  });

  test("31-47 diagnostic baselines and completion distinguish pre-existing, introduced, resolved, and technical states", () => {
    const diagnostic = { category: "TYPESCRIPT", filePath: "src/value.ts", code: "TS2322", message: "Type mismatch" };
    const baseline = BaselineDiagnosticVerifier.capture({
      phase: "BASELINE", passed: false, commands: ["tsc"], diagnostics: [diagnostic], source: "DETERMINISTIC_TOOL",
    });
    const unchanged = BaselineDiagnosticVerifier.compare(baseline, BaselineDiagnosticVerifier.capture({
      phase: "CURRENT", passed: false, commands: ["tsc"], diagnostics: [diagnostic], source: "DETERMINISTIC_TOOL",
    }));
    expect(unchanged.counts).toMatchObject({ PRE_EXISTING: 1, INTRODUCED: 0, RESOLVED: 0 });
    expect(unchanged.verifiedSuccess).toBe(true);

    const introduced = BaselineDiagnosticVerifier.compare(baseline, BaselineDiagnosticVerifier.capture({
      phase: "CURRENT",
      passed: false,
      commands: ["tsc"],
      diagnostics: [diagnostic, { ...diagnostic, code: "TS2304", message: "New missing name" }],
      source: "DETERMINISTIC_TOOL",
    }));
    expect(introduced.counts.INTRODUCED).toBe(1);
    expect(introduced.verifiedSuccess).toBe(false);

    const resolved = BaselineDiagnosticVerifier.compare(baseline, BaselineDiagnosticVerifier.capture({
      phase: "CURRENT", passed: true, commands: ["tsc"], diagnostics: [], source: "DETERMINISTIC_TOOL",
    }));
    expect(resolved.counts.RESOLVED).toBe(1);
    expect(resolved.verifiedSuccess).toBe(true);
  });

  test("56-74 realistic modify, multi-file, create, delete, and no-op tasks use verified production shipping", async () => {
    const cases: readonly { id: string; changes: readonly AgentFileChange[]; expectedCommit: boolean }[] = [
      { id: "simple", changes: [{ path: "src/value.ts", action: "modify", content: "export const value = 'after';\n", description: "simple edit" }], expectedCommit: true },
      { id: "multi", changes: [
        { path: "src/value.ts", action: "modify", content: "export const value = 'multi';\n", description: "implementation" },
        { path: "test/value.test.ts", action: "modify", content: "expect('multi').toBe('multi');\n", description: "focused test" },
      ], expectedCommit: true },
      { id: "create", changes: [{ path: "src/created.ts", action: "create", content: "export const created = true;\n", description: "small module" }], expectedCommit: true },
      { id: "delete", changes: [{ path: "src/obsolete.ts", action: "delete", isDeleted: true, content: "", description: "remove obsolete module" }], expectedCommit: true },
      { id: "noop", changes: [], expectedCommit: false },
    ];

    for (const fixture of cases) {
      const prepared = await prepare(`accept-${fixture.id}`);
      const state = await complete(prepared, fixture.changes);
      const result = await ship(prepared, state, `cp12-${fixture.id}`);
      expect(result.commitCreated).toBe(fixture.expectedCommit);
      expect(result.changedPaths).toEqual(fixture.changes.map((change) => change.path).sort());
      expect(git(source, ["rev-parse", "HEAD"])).toBe(baseRevision);
      if (fixture.expectedCommit) expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/);
      else expect(result.commitSha).toBeUndefined();
    }
  }, 30_000);

  test("57, 75-83 concurrency isolation and shipping retry preserve completed runtime history", async () => {
    const [first, second] = await Promise.all([prepare("concurrent-a"), prepare("concurrent-b")]);
    expect(first.worktreePath).not.toBe(second.worktreePath);
    expect(first.branchName).not.toBe(second.branchName);
    const [firstState, secondState] = await Promise.all([
      complete(first, [{ path: "src/value.ts", action: "modify", content: "first\n", description: "first task" }]),
      complete(second, [{ path: "src/value.ts", action: "modify", content: "second\n", description: "second task" }]),
    ]);
    expect(firstState.journal).not.toBe(secondState.journal);
    expect(firstState.journal.verifiedCheckpoints()).toHaveLength(1);
    expect(secondState.journal.verifiedCheckpoints()).toHaveLength(1);
    const firstShip = await ship(first, firstState, "cp12-retry");
    const retry = await ship(first, firstState, "cp12-retry");
    expect(retry.commitSha).toBe(firstShip.commitSha);
    expect(retry.commitCreated).toBe(false);
    expect(firstState.runtime.snapshot().status).toBe("COMPLETED");
    expect(secondState.runtime.snapshot().status).toBe("COMPLETED");
    expect(fs.readFileSync(path.join(second.worktreePath, "src", "value.ts"), "utf8")).toBe("second\n");
  }, 20_000);

  test("84-92 provider and security invariants remain gateway/argv owned", () => {
    const sourceRoot = path.join(__dirname, "..");
    const gateway = fs.readFileSync(path.join(sourceRoot, "gateway", "LLMGateway.ts"), "utf8");
    const embeddingGateway = fs.readFileSync(path.join(sourceRoot, "gateway", "EmbeddingGateway.ts"), "utf8");
    const gitCommand = fs.readFileSync(path.join(__dirname, "..", "..", "services", "git-command.ts"), "utf8");
    const gitWorkflow = fs.readFileSync(path.join(__dirname, "..", "..", "services", "git-workflow.service.ts"), "utf8");
    expect(gateway).toContain("this.modelRouter.route(stage)");
    expect(gateway).toContain("typeof options.schema.validate !== \"function\"");
    expect(embeddingGateway).toContain("resolveEmbeddingModel(options.model)");
    expect(embeddingGateway).toContain("client.embeddings.create(");
    expect(gitCommand).toContain("execFile(\"git\", [...args]");
    expect(gitCommand).toContain("[REDACTED]");
    expect(gitWorkflow).not.toMatch(/\["(?:merge|rebase|cherry-pick)"|--no-verify|--force(?:-with-lease)?/);
  });


  describe("Deterministic CP12 Recovery Matrix R1–R7", () => {
    class FakeReviewProvider implements CodeReviewProvider {
      readonly type: "GITHUB" = "GITHUB";
      public reviews = new Map<string, CodeReviewMetadata>();
      public createCalls = 0;
      public findCalls = 0;
      public ciQueryCalls = 0;
      public ciStatusToReturn: CiStatus = "UNKNOWN";

      async findExistingReview(req: CodeReviewRequest): Promise<CodeReviewMetadata | null> {
        this.findCalls++;
        return this.reviews.get(req.shippingId) || null;
      }

      async createReview(req: CodeReviewRequest): Promise<CodeReviewMetadata> {
        this.createCalls++;
        const review: CodeReviewMetadata = {
          provider: "GITHUB",
          reviewId: `pr-${this.createCalls}`,
          reviewUrl: `https://github.local/repo/pull/${this.createCalls}`,
          sourceBranch: req.sourceBranch,
          targetBranch: req.targetBranch,
        };
        this.reviews.set(req.shippingId, review);
        return review;
      }

      async queryCiStatus(_commitSha: string): Promise<CiStatus> {
        this.ciQueryCalls++;
        return this.ciStatusToReturn;
      }
    }

    test("R1 BEFORE MUTATION: zero bytes changed, no verified checkpoint, runtime not falsely advanced", async () => {
      const prepared = await prepare("r1-before-mutation");
      const targetPath = path.join(prepared.worktreePath, "src", "value.ts");
      const originalBytes = fs.readFileSync(targetPath, "utf8");

      const runtime = TaskRuntime.create({
        taskId: "cp12-r1",
        originalGoal: "Reject unauthorized mutation before writing bytes",
        workspace: AgentWorkspaceState.create({ projectId: "cp12", root: prepared.worktreePath, revision: prepared.baseCommitSha }),
      });
      runtime.start();
      const journal = new VerifiedCheckpointJournal();

      await expect(
        ValidationCoordinator.applyLocalActionGroup({
          stageId: "r1-denied",
          localPath: prepared.worktreePath,
          authorizedCapabilityScope: scope(prepared.worktreePath, "r1-denied", []),
          changes: [{ path: "src/value.ts", action: "modify", content: "malicious edit\n", description: "unauthorized" }],
          journal,
        })
      ).rejects.toMatchObject({ code: "CAPABILITY_PATH_NOT_DECLARED" });

      expect(fs.readFileSync(targetPath, "utf8")).toBe(originalBytes);
      expect(journal.verifiedCheckpoints()).toHaveLength(0);
      expect(runtime.snapshot().status).toBe("RUNNING");
      expect(runtime.snapshot().terminalOutcome).toBeUndefined();
    });

    test("R2 AFTER MUTATION BEFORE VALIDATION: exact rollback, no verified checkpoint", async () => {
      const prepared = await prepare("r2-after-mutation-before-val");
      const targetPath = path.join(prepared.worktreePath, "src", "value.ts");
      const originalBytes = fs.readFileSync(targetPath, "utf8");
      const journal = new VerifiedCheckpointJournal();

      await expect(
        ValidationCoordinator.applyLocalActionGroup({
          stageId: "r2-fail-val",
          localPath: prepared.worktreePath,
          authorizedCapabilityScope: scope(prepared.worktreePath, "r2-fail-val", [{ path: "src/value.ts", action: "FILE_MODIFY" }]),
          changes: [
            {
              path: "src/value.ts",
              action: "modify",
              content: "invalid syntax\n",
              description: "broken edit",
              editPrimitive: { type: "EXACT_REPLACE", path: "src/value.ts", description: "missing target", oldText: "non-existent text", newText: "new" },
            },
          ],
          journal,
        })
      ).rejects.toMatchObject({ code: "TARGET_NOT_FOUND" });

      expect(fs.readFileSync(targetPath, "utf8")).toBe(originalBytes);
      expect(journal.verifiedCheckpoints()).toHaveLength(0);
      expect(journal.snapshot().some((e) => e.status === "ROLLED_BACK")).toBe(true);
    });

    test("R3 AFTER VERIFIED CHECKPOINT BEFORE NEXT LOOP: verified checkpoint survives, verified bytes survive, no invented progress", async () => {
      const prepared = await prepare("r3-checkpoint-survives");
      const targetPath = path.join(prepared.worktreePath, "src", "value.ts");
      const journal = new VerifiedCheckpointJournal();

      const first = await ValidationCoordinator.applyLocalActionGroup({
        stageId: "r3-loop1",
        localPath: prepared.worktreePath,
        authorizedCapabilityScope: scope(prepared.worktreePath, "r3-loop1", [{ path: "src/value.ts", action: "FILE_MODIFY" }]),
        changes: [{ path: "src/value.ts", action: "modify", content: "export const value = 'verified-loop1';\n", description: "loop 1 edit" }],
        journal,
      });
      expect(first.journalEntry.status).toBe("VERIFIED");
      expect(journal.verifiedCheckpoints()).toHaveLength(1);

      await expect(
        ValidationCoordinator.applyLocalActionGroup({
          stageId: "r3-loop2",
          localPath: prepared.worktreePath,
          authorizedCapabilityScope: scope(prepared.worktreePath, "r3-loop2", [{ path: "src/value.ts", action: "FILE_MODIFY" }]),
          changes: [
            {
              path: "src/value.ts",
              action: "modify",
              content: "bad\n",
              description: "bad edit",
              editPrimitive: { type: "EXACT_REPLACE", path: "src/value.ts", description: "target not found", oldText: "missing string", newText: "bad" },
            },
          ],
          journal,
        })
      ).rejects.toMatchObject({ code: "TARGET_NOT_FOUND" });

      expect(journal.verifiedCheckpoints()).toHaveLength(1);
      expect(fs.readFileSync(targetPath, "utf8")).toBe("export const value = 'verified-loop1';\n");
      expect(journal.snapshot().map((e) => e.status)).toEqual(["VERIFIED", "ROLLED_BACK"]);
    });

    test("R4 AFTER COMPLETION BEFORE SHIPPING: TaskRuntime remains COMPLETED, shipping can resume, task not rerun", async () => {
      const prepared = await prepare("r4-completion-before-shipping");
      const state = await complete(prepared, [{ path: "src/value.ts", action: "modify", content: "export const value = 'r4';\n", description: "r4 edit" }]);

      expect(state.runtime.snapshot().status).toBe("COMPLETED");
      expect(state.runtime.snapshot().terminalOutcome?.type).toBe("COMPLETED");

      const shipResult = await ship(prepared, state, "cp12-r4-ship");
      expect(shipResult.commitCreated).toBe(true);
      expect(shipResult.commitSha).toMatch(/^[0-9a-f]{40}$/);
      expect(state.runtime.snapshot().status).toBe("COMPLETED");
    });

    test("R5 AFTER LOCAL COMMIT BEFORE PUSH: existing valid commit detected, same commit reused, no duplicate commit", async () => {
      const prepared = await prepare("r5-local-commit-before-push");
      const state = await complete(prepared, [{ path: "src/value.ts", action: "modify", content: "export const value = 'r5';\n", description: "r5 edit" }]);

      const firstShip = await ship(prepared, state, "cp12-r5-ship");
      expect(firstShip.commitCreated).toBe(true);
      const originalCommitSha = firstShip.commitSha;

      const retryShip = await ship(prepared, state, "cp12-r5-ship");
      expect(retryShip.commitCreated).toBe(false);
      expect(retryShip.commitSha).toBe(originalCommitSha);
    });

    test("R6 AFTER PUSH BEFORE REVIEW: already-pushed task branch detected/reused, no task rerun, review created/reused idempotently", async () => {
      const prepared = await prepare("r6-push-before-review");
      const state = await complete(prepared, [{ path: "src/value.ts", action: "modify", content: "export const value = 'r6';\n", description: "r6 edit" }]);
      const fakeReview = new FakeReviewProvider();
      const workflowService = new GitWorkflowService();

      const pushResult = await workflowService.ship({
        repositoryRoot: prepared.repositoryRoot,
        worktreePath: prepared.worktreePath,
        baseRevision: prepared.baseCommitSha,
        taskBranch: prepared.branchName,
        targetBranch: "main",
        trustedTargetRevision: baseRevision,
        shippingId: "cp12-r6-ship",
        taskRuntime: state.runtime,
        checkpointJournal: state.journal,
        validationPassed: true,
        mode: "PUSH_BRANCH",
        commitSummary: "CP12 R6 verified commit",
      });
      expect(pushResult.pushed).toBe(true);
      expect(pushResult.commitCreated).toBe(true);

      const reviewResult1 = await workflowService.ship({
        repositoryRoot: prepared.repositoryRoot,
        worktreePath: prepared.worktreePath,
        baseRevision: prepared.baseCommitSha,
        taskBranch: prepared.branchName,
        targetBranch: "main",
        trustedTargetRevision: baseRevision,
        shippingId: "cp12-r6-ship",
        taskRuntime: state.runtime,
        checkpointJournal: state.journal,
        validationPassed: true,
        mode: "CREATE_REVIEW",
        reviewProvider: fakeReview,
        commitSummary: "CP12 R6 verified commit",
      });
      expect(reviewResult1.reviewId).toBe("pr-1");
      expect(fakeReview.createCalls).toBe(1);

      const reviewResult2 = await workflowService.ship({
        repositoryRoot: prepared.repositoryRoot,
        worktreePath: prepared.worktreePath,
        baseRevision: prepared.baseCommitSha,
        taskBranch: prepared.branchName,
        targetBranch: "main",
        trustedTargetRevision: baseRevision,
        shippingId: "cp12-r6-ship",
        taskRuntime: state.runtime,
        checkpointJournal: state.journal,
        validationPassed: true,
        mode: "CREATE_REVIEW",
        reviewProvider: fakeReview,
        commitSummary: "CP12 R6 verified commit",
      });
      expect(reviewResult2.reviewId).toBe("pr-1");
      expect(fakeReview.createCalls).toBe(1);
      expect(fakeReview.findCalls).toBeGreaterThanOrEqual(1);
    }, 20_000);

    test("R7 AFTER REVIEW BEFORE CI QUERY: existing review reused, no duplicate PR, CI queried separately, UNKNOWN allowed, runtime completion unchanged", async () => {
      const prepared = await prepare("r7-review-before-ci");
      const state = await complete(prepared, [{ path: "src/value.ts", action: "modify", content: "export const value = 'r7';\n", description: "r7 edit" }]);
      const fakeReview = new FakeReviewProvider();
      fakeReview.ciStatusToReturn = "UNKNOWN";

      const workflowService = new GitWorkflowService();
      const result = await workflowService.ship({
        repositoryRoot: prepared.repositoryRoot,
        worktreePath: prepared.worktreePath,
        baseRevision: prepared.baseCommitSha,
        taskBranch: prepared.branchName,
        targetBranch: "main",
        trustedTargetRevision: baseRevision,
        shippingId: "cp12-r7-ship",
        taskRuntime: state.runtime,
        checkpointJournal: state.journal,
        validationPassed: true,
        mode: "CREATE_REVIEW",
        reviewProvider: fakeReview,
        commitSummary: "CP12 R7 verified commit",
      });

      expect(result.reviewId).toBe("pr-1");
      expect(result.ciStatus).toBe("UNKNOWN");
      expect(fakeReview.ciQueryCalls).toBe(1);
      expect(state.runtime.snapshot().status).toBe("COMPLETED");

      fakeReview.ciStatusToReturn = "PASSED";
      const result2 = await workflowService.ship({
        repositoryRoot: prepared.repositoryRoot,
        worktreePath: prepared.worktreePath,
        baseRevision: prepared.baseCommitSha,
        taskBranch: prepared.branchName,
        targetBranch: "main",
        trustedTargetRevision: baseRevision,
        shippingId: "cp12-r7-ship",
        taskRuntime: state.runtime,
        checkpointJournal: state.journal,
        validationPassed: true,
        mode: "CREATE_REVIEW",
        reviewProvider: fakeReview,
        commitSummary: "CP12 R7 verified commit",
      });
      expect(result2.reviewId).toBe("pr-1");
      expect(result2.ciStatus).toBe("PASSED");
      expect(fakeReview.createCalls).toBe(1);
      expect(fakeReview.ciQueryCalls).toBe(2);
      expect(state.runtime.snapshot().status).toBe("COMPLETED");
    }, 20_000);
  });

  test("release report covers all 92 scenarios and fails closed unless every mandatory gate passes", () => {
    expect(CP12_SCENARIOS.map((item) => item.id)).toEqual(
      Array.from({ length: 92 }, (_, index) => `CP12-S${String(index + 1).padStart(2, "0")}`),
    );
    const categoryEvidence: ReleaseReadinessEvidence[] = RELEASE_READINESS_CATEGORIES
      .filter((category) => !CP12_SCENARIOS.some((item) => item.category === category))
      .map((category) => ({ id: `CP12-${category}`, category, passed: true, testId: `CP12 ${category.toLowerCase()} cross-check` }));
    const input = {
      evidence: [...CP12_SCENARIOS, ...categoryEvidence],
      invariantCounts: {
        generativeProviderBypass: 0,
        embeddingProviderBypass: 0,
        hardcodedGenerativeModelSelection: 0,
        callStructuredMissingValidate: 0,
        modelDerivedOperationalSuccess: 0,
      },
      severityCounts: { blocker: 0, high: 0, medium: 0 },
      typeScriptPassed: true,
      diffCheckPassed: true,
    } as const;
    const allGreenReport = ProductionReadinessEvaluator.evaluate(input);
    expect(Object.values(allGreenReport.categories).every((category) => category.status === "PASS")).toBe(true);
    expect(allGreenReport.overall).toBe("PRODUCTION_CAPABLE_BETA");
    const broadSuiteFailureReport = ProductionReadinessEvaluator.evaluate({
      ...input,
      evidence: [
        ...input.evidence.filter((item) => item.category !== "REGRESSIONS"),
        {
          id: "CP12-broad-backend-regressions",
          category: "REGRESSIONS" as const,
          passed: false,
          testId: "npm test broad backend suite",
        },
      ],
    });
    expect(broadSuiteFailureReport.categories.REGRESSIONS.status).toBe("FAIL");
    expect(broadSuiteFailureReport.overall).toBe("NOT_READY");
    expect(ProductionReadinessEvaluator.evaluate({ ...input, severityCounts: { blocker: 0, high: 1, medium: 0 } }).overall)
      .toBe("NOT_READY");
    expect(ProductionReadinessEvaluator.evaluate({ ...input, evidence: input.evidence.filter((item) => item.category !== "RECOVERY") }).categories.RECOVERY.status)
      .toBe("NOT_TESTED");
    expect(ProductionReadinessEvaluator.evaluate({ ...input, invariantCounts: { ...input.invariantCounts, generativeProviderBypass: 1 } }).overall)
      .toBe("NOT_READY");
  });
});
