import fs from "fs";
import os from "os";
import path from "path";
import {
  ActionGroup,
  ActionGroupExecutor,
} from "../orchestration/ActionGroup";
import { ValidationCoordinator } from "../orchestration/ValidationCoordinator";
import { StageExecutionTransaction } from "../orchestration/StageExecutionTransaction";
import { AuthorizedCapabilityScope, CapabilityGrant, CapabilityGuard } from "../runtime/CapabilityGuard";
import { VerifiedCheckpointJournal } from "../runtime/VerifiedCheckpointJournal";
import { AgentFileChange } from "../../types";

describe("Checkpoint 6 ActionGroups and verified checkpoint journal", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cp6-action-group-"));
    fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(workspace)) fs.rmSync(workspace, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  function transaction(stageId: string, grants: CapabilityGrant[]): Promise<StageExecutionTransaction> {
    const scope = AuthorizedCapabilityScope.fromBackendConfiguration({
      workspaceRoot: workspace,
      authorityId: `cp6:${stageId}`,
      grants,
    });
    if (!scope) throw new Error("fixture capability scope must be valid");
    return StageExecutionTransaction.startTransaction(
      stageId,
      workspace,
      CapabilityGuard.create({ workspaceRoot: workspace, scopeId: stageId, authorizedScope: scope }),
    );
  }

  function group(stageId: string, changes: AgentFileChange[]): ActionGroup {
    return ActionGroup.create({ stageId, authorizedScopeReference: `cp6:${stageId}`, actions: changes });
  }

  async function applyThroughCoordinator(
    stageId: string,
    changes: AgentFileChange[],
    grants: CapabilityGrant[],
    journal = new VerifiedCheckpointJournal(),
  ) {
    const scope = AuthorizedCapabilityScope.fromBackendConfiguration({
      workspaceRoot: workspace,
      authorityId: `cp6:${stageId}`,
      grants,
    });
    if (!scope) throw new Error("fixture capability scope must be valid");
    return ValidationCoordinator.applyLocalActionGroup({
      stageId,
      localPath: workspace,
      authorizedCapabilityScope: scope,
      changes,
      journal,
    });
  }

  test("1. a multi-action valid group succeeds atomically and creates a VERIFIED checkpoint", async () => {
    fs.writeFileSync(path.join(workspace, "src/a.ts"), "a0");
    const changes: AgentFileChange[] = [
      { path: "src/a.ts", action: "modify", content: "a1", description: "modify a" },
      { path: "src/b.ts", action: "create", content: "b1", description: "create b" },
    ];
    const journal = new VerifiedCheckpointJournal(() => new Date("2026-01-01T00:00:00.000Z"));
    const result = await applyThroughCoordinator("stage-1", changes, [
      { path: "src/a.ts", action: "FILE_MODIFY" }, { path: "src/b.ts", action: "FILE_CREATE" },
    ], journal);

    expect(fs.readFileSync(path.join(workspace, "src/a.ts"), "utf8")).toBe("a1");
    expect(fs.readFileSync(path.join(workspace, "src/b.ts"), "utf8")).toBe("b1");
    expect(result.group.lifecycle).toBe("VERIFIED");
    expect(result.journalEntry).toMatchObject({ status: "VERIFIED", sequence: 1, validation: { passed: true } });
  });

  test("2. a second action failure rolls back the first action", async () => {
    fs.writeFileSync(path.join(workspace, "src/a.ts"), "a0");
    const changes: AgentFileChange[] = [
      { path: "src/a.ts", action: "modify", content: "a1", description: "first" },
      { path: "src/b.ts", action: "create", content: "b1", description: "second" },
    ];
    const tx = await transaction("stage-2", [
      { path: "src/a.ts", action: "FILE_MODIFY" }, { path: "src/b.ts", action: "FILE_CREATE" },
    ]);
    const journal = new VerifiedCheckpointJournal();

    await expect(ActionGroupExecutor.execute({
      group: group("stage-2", changes), transaction: tx, journal,
      executeActions: async () => {
        await tx.apply([changes[0]]);
        throw new Error("SECOND_ACTION_FAILED");
      },
      validate: async () => ({ passed: true, source: "VALIDATION_COORDINATOR", reasons: [] }),
    })).rejects.toThrow("SECOND_ACTION_FAILED");
    expect(fs.readFileSync(path.join(workspace, "src/a.ts"), "utf8")).toBe("a0");
    expect(fs.existsSync(path.join(workspace, "src/b.ts"))).toBe(false);
    expect(journal.snapshot()[0]).toMatchObject({ status: "ROLLED_BACK", failureCode: "ACTION_EXECUTION_FAILED" });
  });

  test("3. validation failure rolls back every group change and is never VERIFIED", async () => {
    fs.writeFileSync(path.join(workspace, "src/a.ts"), "a0");
    const changes: AgentFileChange[] = [
      { path: "src/a.ts", action: "modify", content: "a1", description: "modify" },
      { path: "src/b.ts", action: "create", content: "b1", description: "create" },
    ];
    const journal = new VerifiedCheckpointJournal();
    const originalReadFile = fs.readFileSync;
    const readFile = jest.spyOn(fs, "readFileSync").mockImplementation(((filePath: fs.PathOrFileDescriptor, options?: any) => {
      const value = originalReadFile.call(fs, filePath, options);
      return typeof value === "string" && value === "a1" ? "unexpected bytes" : value;
    }) as typeof fs.readFileSync);
    const result = await applyThroughCoordinator("stage-3", changes, [
      { path: "src/a.ts", action: "FILE_MODIFY" }, { path: "src/b.ts", action: "FILE_CREATE" },
    ], journal);
    readFile.mockRestore();
    expect(fs.readFileSync(path.join(workspace, "src/a.ts"), "utf8")).toBe("a0");
    expect(fs.existsSync(path.join(workspace, "src/b.ts"))).toBe(false);
    expect(result.journalEntry).toMatchObject({ status: "ROLLED_BACK", failureCode: "VALIDATION_FAILED" });
    expect(journal.verifiedCheckpoints()).toHaveLength(0);
  });

  test("4. an unauthorized action prevents all mutation", async () => {
    fs.writeFileSync(path.join(workspace, "src/a.ts"), "a0");
    const changes: AgentFileChange[] = [
      { path: "src/a.ts", action: "modify", content: "a1", description: "allowed" },
      { path: "src/unauthorized.ts", action: "create", content: "bad", description: "denied" },
    ];
    const tx = await transaction("stage-4", [{ path: "src/a.ts", action: "FILE_MODIFY" }]);
    const journal = new VerifiedCheckpointJournal();
    await expect(ActionGroupExecutor.execute({
      group: group("stage-4", changes), transaction: tx, journal,
      executeActions: async () => tx.apply(changes), validate: async () => ({ passed: true, source: "VALIDATION_COORDINATOR", reasons: [] }),
    })).rejects.toMatchObject({ code: "CAPABILITY_PATH_NOT_DECLARED" });
    expect(fs.readFileSync(path.join(workspace, "src/a.ts"), "utf8")).toBe("a0");
    expect(fs.existsSync(path.join(workspace, "src/unauthorized.ts"))).toBe(false);
  });

  test("5. rollback restores exact prior bytes", async () => {
    const original = Buffer.from([0, 255, 1, 254, 2, 253]);
    fs.writeFileSync(path.join(workspace, "src/binary.dat"), original);
    const changes: AgentFileChange[] = [{ path: "src/binary.dat", action: "modify", content: "text", description: "attempt" }];
    const tx = await transaction("stage-5", [{ path: "src/binary.dat", action: "FILE_MODIFY" }]);
    await ActionGroupExecutor.execute({
      group: group("stage-5", changes), transaction: tx, journal: new VerifiedCheckpointJournal(),
      executeActions: async () => tx.apply(changes), validate: async () => ({ passed: false, source: "VALIDATION_COORDINATOR", reasons: ["failed"] }),
    }).catch(() => undefined);
    expect(fs.readFileSync(path.join(workspace, "src/binary.dat"))).toEqual(original);
  });

  test("6. model-shaped claims cannot mark a group verified or rewrite entries", async () => {
    fs.writeFileSync(path.join(workspace, "src/a.ts"), "a0");
    const changes: AgentFileChange[] = [{ path: "src/a.ts", action: "modify", content: "a1", description: "attempt" }];
    const tx = await transaction("stage-6", [{ path: "src/a.ts", action: "FILE_MODIFY" }]);
    const journal = new VerifiedCheckpointJournal();
    const proposedGroup = group("stage-6", changes);
    await expect(ActionGroupExecutor.execute({
      group: proposedGroup, transaction: tx, journal,
      executeActions: async () => tx.apply(changes),
      validate: async () => ({ passed: true, source: "VALIDATION_COORDINATOR", reasons: [] }),
    })).rejects.toThrow(/authentic deterministic validation receipt/);
    expect(journal.snapshot()[0].status).toBe("ROLLED_BACK");
    expect(() => { (journal.snapshot()[0] as { status: string }).status = "VERIFIED"; }).toThrow();
  });

  test("7-10. earlier verified progress survives a later failed group while later mutations do not", async () => {
    fs.writeFileSync(path.join(workspace, "src/a.ts"), "v0");
    const journal = new VerifiedCheckpointJournal(() => new Date("2026-01-01T00:00:00.000Z"));
    const first = [{ path: "src/a.ts", action: "modify" as const, content: "v1", description: "verified" }];
    await applyThroughCoordinator("stage-7a", first, [{ path: "src/a.ts", action: "FILE_MODIFY" }], journal);

    const later = [{ path: "src/later.ts", action: "create" as const, content: "unverified", description: "later" }];
    const originalReadFile = fs.readFileSync;
    const readFile = jest.spyOn(fs, "readFileSync").mockImplementation(((filePath: fs.PathOrFileDescriptor, options?: any) => {
      const value = originalReadFile.call(fs, filePath, options);
      return typeof value === "string" && value === "unverified" ? "unexpected bytes" : value;
    }) as typeof fs.readFileSync);
    await applyThroughCoordinator("stage-7b", later, [{ path: "src/later.ts", action: "FILE_CREATE" }], journal);
    readFile.mockRestore();

    expect(fs.readFileSync(path.join(workspace, "src/a.ts"), "utf8")).toBe("v1");
    expect(fs.existsSync(path.join(workspace, "src/later.ts"))).toBe(false);
    expect(journal.verifiedCheckpoints()).toHaveLength(1);
    expect(journal.snapshot().map((entry) => entry.status)).toEqual(["VERIFIED", "ROLLED_BACK"]);
  });

  test("11. group IDs and journal ordering are deterministic enough for runtime audit", async () => {
    const changes = [{ path: "src/a.ts", action: "create" as const, content: "a", description: "create" }];
    expect(group("stable", changes).snapshot().id).toBe(group("stable", changes).snapshot().id);
    const journal = new VerifiedCheckpointJournal(() => new Date("2026-01-01T00:00:00.000Z"));
    await applyThroughCoordinator("stable", changes, [{ path: "src/a.ts", action: "FILE_CREATE" }], journal);
    const second = [{ path: "src/b.ts", action: "create" as const, content: "b", description: "create" }];
    await applyThroughCoordinator("stable-2", second, [{ path: "src/b.ts", action: "FILE_CREATE" }], journal);
    expect(journal.snapshot().map((entry) => [entry.sequence, entry.journalId])).toEqual([
      [1, `journal_000001_${journal.snapshot()[0].actionGroupId}`],
      [2, `journal_000002_${journal.snapshot()[1].actionGroupId}`],
    ]);
  });

  test("11b. journal records repair mutations in addition to the immutable proposal", async () => {
    const proposed = [{ path: "src/a.ts", action: "create" as const, content: "a", description: "proposed" }];
    const repair = { path: "src/repair.ts", action: "create" as const, content: "repair", description: "repair" };
    const originalApply = StageExecutionTransaction.prototype.apply;
    jest.spyOn(StageExecutionTransaction.prototype, "apply").mockImplementation(async function(this: StageExecutionTransaction, changes) {
      await originalApply.call(this, changes);
      await originalApply.call(this, [repair]);
    });
    const result = await applyThroughCoordinator("repair-accounting", proposed, [
      { path: "src/a.ts", action: "FILE_CREATE" },
      { path: "src/repair.ts", action: "FILE_CREATE" },
    ]);
    expect(result.journalEntry.proposedActions.map((action) => action.path)).toEqual(["src/a.ts"]);
    expect(result.journalEntry.attemptedActions.map((action) => action.path)).toEqual(["src/a.ts", "src/repair.ts"]);
  });

  test("12. ValidationCoordinator production source executes through ActionGroupExecutor", () => {
    const source = fs.readFileSync(path.join(__dirname, "../orchestration/ValidationCoordinator.ts"), "utf8");
    expect(source).toContain("ActionGroup.create");
    expect(source).toContain("ActionGroupExecutor.execute");
    expect(source).toContain("StageExecutionTransaction.startTransaction");
    expect(source).toContain("DeterministicValidationReceipt.issue");
  });

  test("13. source strings and plain objects cannot mint an authentic receipt", async () => {
    const coordinatorModule = await import("../orchestration/ValidationCoordinator");
    const actionGroupModule = await import("../orchestration/ActionGroup");
    const forged = { passed: true, source: "VALIDATION_COORDINATOR", reasons: [] };
    expect(coordinatorModule.isAuthenticActionGroupValidationReceipt(forged)).toBe(false);
    expect((actionGroupModule as Record<string, unknown>).ActionGroupValidationReceipt).toBeUndefined();
    expect((actionGroupModule as Record<string, unknown>).fromDeterministicValidation).toBeUndefined();
  });

  test("14. apply-local controller delegates its mutation to the coordinator action-group entry point", () => {
    const controller = fs.readFileSync(path.join(__dirname, "../../controllers/project-controller.ts"), "utf8");
    const coordinator = fs.readFileSync(path.join(__dirname, "../orchestration/ValidationCoordinator.ts"), "utf8");
    expect(controller).toContain("ValidationCoordinator.applyLocalActionGroup");
    expect(controller).not.toContain("FileSystemStateManager.apply");
    expect(coordinator).toContain("StageExecutionTransaction.startTransaction");
    expect(coordinator).toContain("ActionGroupExecutor.execute");
    expect(coordinator).toContain("DeterministicValidationReceipt.issue");
  });
});
