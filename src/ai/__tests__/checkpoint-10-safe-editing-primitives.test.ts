import fs from "fs";
import os from "os";
import path from "path";
import { materializeEditingPrimitive, EditingConflictError, fingerprintBytes } from "../editing/EditingPrimitives";
import { FileEditingPrimitive, AgentFileChange } from "../../types";
import { AuthorizedCapabilityScope, CapabilityGrant, CapabilityGuard } from "../runtime/CapabilityGuard";
import { FileSystemStateManager } from "../validation/FileSystemStateManager";
import { ValidationCoordinator } from "../orchestration/ValidationCoordinator";
import { VerifiedCheckpointJournal } from "../runtime/VerifiedCheckpointJournal";
import { resolveRepairProposals } from "../repair/RepairProposalResolver";

describe("Checkpoint 10 safe editing primitives", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cp10-editing-"));
    fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(workspace)) fs.rmSync(workspace, { recursive: true, force: true });
  });

  function scope(stageId: string, grants: readonly CapabilityGrant[]): AuthorizedCapabilityScope {
    const result = AuthorizedCapabilityScope.fromBackendConfiguration({
      workspaceRoot: workspace,
      authorityId: `cp10:${stageId}`,
      grants,
    });
    if (!result) throw new Error("Expected authentic CP10 capability scope");
    return result;
  }

  function manager(stageId: string, grants: readonly CapabilityGrant[]): FileSystemStateManager {
    const authorizedScope = scope(stageId, grants);
    return new FileSystemStateManager(
      CapabilityGuard.create({ workspaceRoot: workspace, scopeId: stageId, authorizedScope }),
      stageId,
    );
  }

  function primitive<T extends FileEditingPrimitive>(value: T): T {
    return value;
  }

  test("1 exact replace with one match succeeds", () => {
    const result = materializeEditingPrimitive(primitive({
      type: "EXACT_REPLACE", path: "src/a.ts", description: "exact", oldText: "one", newText: "two",
    }), Buffer.from("const value = 'one';"));
    expect(result.after?.toString()).toBe("const value = 'two';");
  });

  test("2 exact replace with zero matches fails without mutation", () => {
    const source = Buffer.from("const value = 'one';");
    expect(() => materializeEditingPrimitive(primitive({
      type: "EXACT_REPLACE", path: "src/a.ts", description: "missing", oldText: "absent", newText: "two",
    }), source)).toThrow(expect.objectContaining({ code: "TARGET_NOT_FOUND" }));
    expect(source.toString()).toBe("const value = 'one';");
  });

  test("3 duplicate exact target fails AMBIGUOUS_TARGET", () => {
    expect(() => materializeEditingPrimitive(primitive({
      type: "EXACT_REPLACE", path: "src/a.ts", description: "ambiguous", oldText: "same", newText: "new",
    }), Buffer.from("same and same"))).toThrow(expect.objectContaining({ code: "AMBIGUOUS_TARGET" }));
  });

  test("4 stale source fingerprint rejects edit", () => {
    expect(() => materializeEditingPrimitive(primitive({
      type: "REPLACE_FILE", path: "src/a.ts", description: "stale", content: "after", expectedSourceFingerprint: fingerprintBytes("before"),
    }), Buffer.from("changed"))).toThrow(expect.objectContaining({ code: "STALE_SOURCE" }));
  });

  test("5 create existing file fails without overwriting", async () => {
    fs.writeFileSync(path.join(workspace, "src/a.ts"), "existing");
    const editor = manager("create", [{ path: "src/a.ts", action: "FILE_CREATE" }]);
    await expect(editor.applyPrimitives([primitive({ type: "CREATE_FILE", path: "src/a.ts", content: "new", description: "create" })], workspace))
      .rejects.toMatchObject({ code: "CREATE_TARGET_EXISTS" });
    expect(fs.readFileSync(path.join(workspace, "src/a.ts"), "utf8")).toBe("existing");
  });

  test("6 modify missing file fails", async () => {
    const editor = manager("modify", [{ path: "src/missing.ts", action: "FILE_MODIFY" }]);
    await expect(editor.applyPrimitives([primitive({ type: "REPLACE_FILE", path: "src/missing.ts", content: "new", description: "modify" })], workspace))
      .rejects.toMatchObject({ code: "MODIFY_TARGET_MISSING" });
  });

  test("7 delete missing file deterministically fails", async () => {
    const editor = manager("delete", [{ path: "src/missing.ts", action: "FILE_DELETE" }]);
    await expect(editor.applyPrimitives([primitive({ type: "DELETE_FILE", path: "src/missing.ts", description: "delete" })], workspace))
      .rejects.toMatchObject({ code: "DELETE_TARGET_MISSING" });
  });

  test("8 insert-before exact unique anchor succeeds", () => {
    const result = materializeEditingPrimitive(primitive({
      type: "INSERT_BEFORE", path: "src/a.ts", description: "insert", anchor: "export const a", content: "// safe\n",
    }), Buffer.from("export const a = 1;"));
    expect(result.after?.toString()).toBe("// safe\nexport const a = 1;");
  });

  test("9 insert-before ambiguous anchor fails without mutation", () => {
    const source = Buffer.from("anchor\nanchor");
    expect(() => materializeEditingPrimitive(primitive({
      type: "INSERT_BEFORE", path: "src/a.ts", description: "insert", anchor: "anchor", content: "x",
    }), source)).toThrow(expect.objectContaining({ code: "AMBIGUOUS_TARGET" }));
    expect(source.toString()).toBe("anchor\nanchor");
  });

  test("10 insert-after missing anchor fails without mutation", () => {
    const source = Buffer.from("current");
    expect(() => materializeEditingPrimitive(primitive({
      type: "INSERT_AFTER", path: "src/a.ts", description: "insert", anchor: "missing", content: "x",
    }), source)).toThrow(expect.objectContaining({ code: "TARGET_NOT_FOUND" }));
    expect(source.toString()).toBe("current");
  });

  test("11 patch with stale context is rejected", () => {
    expect(() => materializeEditingPrimitive(primitive({
      type: "PATCH_HUNK", path: "src/a.ts", description: "patch", edits: [{ oldText: "old context", newText: "new" }],
    }), Buffer.from("current context"))).toThrow(expect.objectContaining({ code: "PATCH_CONTEXT_MISMATCH" }));
  });

  test("12 patch never uses a fuzzy nearest match to mutate", () => {
    expect(() => materializeEditingPrimitive(primitive({
      type: "PATCH_HUNK", path: "src/a.ts", description: "patch", edits: [{ oldText: "const value=1", newText: "const value=2" }],
    }), Buffer.from("const value = 1"))).toThrow(expect.objectContaining({ code: "PATCH_CONTEXT_MISMATCH" }));
  });

  test("13 semantic or cached source cannot override different disk bytes", async () => {
    fs.writeFileSync(path.join(workspace, "src/a.ts"), "disk");
    const editor = manager("cache", [{ path: "src/a.ts", action: "FILE_MODIFY" }]);
    await expect(editor.applyPrimitives([primitive({
      type: "REPLACE_FILE", path: "src/a.ts", description: "cached", content: "new", expectedSourceFingerprint: fingerprintBytes("semantic-cache"),
    })], workspace)).rejects.toMatchObject({ code: "STALE_SOURCE" });
    expect(fs.readFileSync(path.join(workspace, "src/a.ts"), "utf8")).toBe("disk");
  });

  test("14 second edit failure leaves the first edit unchanged in one ActionGroup", async () => {
    fs.writeFileSync(path.join(workspace, "src/a.ts"), "a0");
    fs.writeFileSync(path.join(workspace, "src/b.ts"), "b0");
    const changes: AgentFileChange[] = [
      { path: "src/a.ts", action: "modify", content: "a1", description: "first", editPrimitive: primitive({ type: "EXACT_REPLACE", path: "src/a.ts", description: "first", oldText: "a0", newText: "a1" }) },
      { path: "src/b.ts", action: "modify", content: "b1", description: "second", editPrimitive: primitive({ type: "EXACT_REPLACE", path: "src/b.ts", description: "second", oldText: "missing", newText: "b1" }) },
    ];
    await expect(ValidationCoordinator.applyLocalActionGroup({
      stageId: "group-fail", localPath: workspace, authorizedCapabilityScope: scope("group-fail", [
        { path: "src/a.ts", action: "FILE_MODIFY" }, { path: "src/b.ts", action: "FILE_MODIFY" },
      ]), changes,
    })).rejects.toMatchObject({ code: "TARGET_NOT_FOUND" });
    expect(fs.readFileSync(path.join(workspace, "src/a.ts"), "utf8")).toBe("a0");
  });

  test("15 earlier VERIFIED ActionGroup survives a later failed edit group", async () => {
    fs.writeFileSync(path.join(workspace, "src/a.ts"), "a0");
    const journal = new VerifiedCheckpointJournal();
    await ValidationCoordinator.applyLocalActionGroup({
      stageId: "verified", localPath: workspace, authorizedCapabilityScope: scope("verified", [{ path: "src/a.ts", action: "FILE_MODIFY" }]), journal,
      changes: [{ path: "src/a.ts", action: "modify", content: "a1", description: "verified" }],
    });
    await expect(ValidationCoordinator.applyLocalActionGroup({
      stageId: "failed", localPath: workspace, authorizedCapabilityScope: scope("failed", [{ path: "src/a.ts", action: "FILE_MODIFY" }]), journal,
      changes: [{ path: "src/a.ts", action: "modify", content: "a2", description: "stale", editPrimitive: primitive({ type: "REPLACE_FILE", path: "src/a.ts", content: "a2", description: "stale", expectedSourceFingerprint: fingerprintBytes("a0") }) }],
    })).rejects.toMatchObject({ code: "STALE_SOURCE" });
    expect(fs.readFileSync(path.join(workspace, "src/a.ts"), "utf8")).toBe("a1");
    expect(journal.verifiedCheckpoints()).toHaveLength(1);
  });

  test("16 unauthorized path cannot be edited regardless of primitive", async () => {
    fs.writeFileSync(path.join(workspace, "src/a.ts"), "a0");
    const editor = manager("unauthorized", [{ path: "src/allowed.ts", action: "FILE_MODIFY" }]);
    await expect(editor.applyPrimitives([primitive({ type: "REPLACE_FILE", path: "src/a.ts", content: "bad", description: "bad" })], workspace))
      .rejects.toMatchObject({ code: "CAPABILITY_PATH_NOT_DECLARED" });
  });

  test("17 action type cannot be transformed through a conflicting primitive", async () => {
    fs.writeFileSync(path.join(workspace, "src/a.ts"), "a0");
    const editor = manager("type", [{ path: "src/a.ts", action: "FILE_CREATE" }]);
    await expect(editor.apply([{ path: "src/a.ts", action: "create", content: "bad", description: "bad", editPrimitive: primitive({ type: "REPLACE_FILE", path: "src/a.ts", content: "bad", description: "bad" }) }], workspace))
      .rejects.toMatchObject({ code: "EDIT_CONFLICT" });
  });

  test("18 repair path emits the same guarded PATCH_HUNK primitive", () => {
    const result = resolveRepairProposals([{ path: "src/a.ts", action: "modify", edits: [{ oldText: "a0", newText: "a1" }], description: "repair" }], { "src/a.ts": "a0" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.changes[0].editPrimitive).toMatchObject({ type: "PATCH_HUNK", expectedSourceFingerprint: fingerprintBytes("a0") });
  });

  test("19 generated whole-file modify checks current source freshness", () => {
    const wholeFile = primitive({
      type: "REPLACE_FILE",
      path: "src/a.ts",
      content: "a1",
      description: "generated whole-file replacement",
      expectedSourceFingerprint: fingerprintBytes("a0"),
    });
    expect(materializeEditingPrimitive(wholeFile, Buffer.from("a0")).after?.toString()).toBe("a1");
    expect(() => materializeEditingPrimitive(wholeFile, Buffer.from("changed")))
      .toThrow(expect.objectContaining({ code: "STALE_SOURCE" }));
  });

  test("20 exact replacement preserves CRLF, trailing newline, and unrelated bytes", () => {
    const source = "first\r\ntarget\r\nlast\r\n";
    const result = materializeEditingPrimitive(primitive({ type: "EXACT_REPLACE", path: "src/a.ts", description: "exact", oldText: "target", newText: "changed" }), Buffer.from(source));
    expect(result.after?.toString()).toBe("first\r\nchanged\r\nlast\r\n");
  });

  test("21 current deleted state is respected after re-observation", async () => {
    fs.writeFileSync(path.join(workspace, "src/a.ts"), "a0");
    await manager("delete-now", [{ path: "src/a.ts", action: "FILE_DELETE" }]).applyPrimitives([
      primitive({ type: "DELETE_FILE", path: "src/a.ts", description: "delete", expectedSourceFingerprint: fingerprintBytes("a0") }),
    ], workspace);
    await manager("create-now", [{ path: "src/a.ts", action: "FILE_CREATE" }]).applyPrimitives([
      primitive({ type: "CREATE_FILE", path: "src/a.ts", content: "new", description: "re-observed create" }),
    ], workspace);
    expect(fs.readFileSync(path.join(workspace, "src/a.ts"), "utf8")).toBe("new");
  });

  test("22 edit conflict is a technical rolled-back failure, not fabricated success", async () => {
    fs.writeFileSync(path.join(workspace, "src/a.ts"), "current");
    const journal = new VerifiedCheckpointJournal();
    await expect(ValidationCoordinator.applyLocalActionGroup({
      stageId: "revision", localPath: workspace, authorizedCapabilityScope: scope("revision", [{ path: "src/a.ts", action: "FILE_MODIFY" }]), journal,
      changes: [{ path: "src/a.ts", action: "modify", content: "next", description: "stale", editPrimitive: primitive({ type: "REPLACE_FILE", path: "src/a.ts", content: "next", description: "stale", expectedSourceFingerprint: fingerprintBytes("old") }) }],
    })).rejects.toBeInstanceOf(EditingConflictError);
    expect(journal.snapshot()[0]).toMatchObject({ status: "ROLLED_BACK" });
    expect(journal.verifiedCheckpoints()).toHaveLength(0);
  });

  test("23 editing primitives cannot mint ActionGroup VERIFIED status", async () => {
    const editingModule = await import("../editing/EditingPrimitives");
    expect((editingModule as Record<string, unknown>).ActionGroup).toBeUndefined();
    expect((editingModule as Record<string, unknown>).DeterministicValidationReceipt).toBeUndefined();
  });

  test("24 editing primitives cannot complete TaskRuntime", async () => {
    const editingModule = await import("../editing/EditingPrimitives");
    expect((editingModule as Record<string, unknown>).CompletionEvaluator).toBeUndefined();
    expect((editingModule as Record<string, unknown>).TaskRuntime).toBeUndefined();
  });
});
