import fs from "fs";
import os from "os";
import path from "path";
import { FileManifest } from "../../types";
import { createTaskIntentSpec } from "../shared/TaskIntentSpec";
import { RepositoryEvidenceStore } from "../repository/RepositoryEvidenceStore";
import { PreExecutionAuthorityClosure } from "../contracts/PreExecutionAuthorityClosure";
import { PolicyContract } from "../contracts/PolicyContract";
import { AuthorizedCapabilityScope, CapabilityGuard } from "../runtime/CapabilityGuard";
import { MutationTransaction, ExecutionWorkspaceBinding } from "../runtime/MutationTransaction";
import { MutationCompiler, MutationOperation } from "../runtime/MutationCompiler";
import { captureAuthoritySnapshot } from "../repository/AuthorityWorktree";
import { fingerprintBytes } from "../editing/EditingPrimitives";
import { LLMGateway } from "../gateway/LLMGateway";
import { LLMSchemaInvalidError } from "../gateway/LLMError";
import { SelfHealingEngine } from "../repair/SelfHealingEngine";
import { FileSystemStateManager } from "../validation/FileSystemStateManager";
import { reconcileExecutionManifest } from "../runtime/ExecutionManifest";
import { ValidationCoordinator } from "../orchestration/ValidationCoordinator";
import { ValidationPlanner } from "../validation/ValidationPlanner";
import { ValidationDetector } from "../validation/ValidationDetector";
import { SecurityAuditor } from "../review/SecurityAuditor";
import { MonorepoDetector } from "../workspace/MonorepoDetector";
import { StageExecutionTransaction } from "../orchestration/StageExecutionTransaction";
import { DiagnosticNormalizer } from "../validation/DiagnosticNormalizer";
import { ValidationRunner } from "../validation/ValidationRunner";

const policy: PolicyContract = { goal: "Repair target.ts", taskType: "BUG_FIX", risk: "MEDIUM", estimatedComplexity: "MEDIUM", destructive: false,
  allowedActions: ["modify_file"], forbiddenActions: [], maxFiles: 10, diffCriticEnabled: true, pipeline: "REPOSITORY", environment: "GENERIC",
  repositoryRequired: true, expectedFiles: [], validationType: "TYPESCRIPT_BUILD", explicitUserPaths: [], userConstraints: [], requiresClarification: false };

describe("Trusted mutation transaction production security", () => {
  let root: string;
  let active: MutationTransaction[];
  const manifest = (): FileManifest => ({ manifestVersion: "1", totalFiles: 1, files: [{ path: "target.ts", action: "modify", dependencies: [], description: "authorized target" }] });
  const read = () => fs.readFileSync(path.join(root, "target.ts"), "utf8");
  const write = (text: string) => fs.writeFileSync(path.join(root, "target.ts"), text);
  function scope() {
    const intentSpec = createTaskIntentSpec("Repair target.ts", { taskType: "BUG_FIX", intent: "BUG_FIX", risk: "MEDIUM", estimatedComplexity: "MEDIUM", confidence: 1, requiresClarification: false, reasoning: "fixture" });
    const closure = PreExecutionAuthorityClosure.close({ changes: [{ path: "target.ts", action: "modify", content: "candidate", description: "proposal" }],
      policy, intentSpec, evidenceStore: new RepositoryEvidenceStore("project-A", root), existingFiles: [...captureAuthoritySnapshot(root).files.keys()],
      repositoryId: "project-A", workspaceRoot: root, stageId: "stage", runId: "run" });
    expect(closure.valid).toBe(true);
    const base = AuthorizedCapabilityScope.fromIsolatedWorktree({ workspaceRoot: root, authorityId: "base", repositoryId: "project-A", runId: "run", grants: [] })!;
    return base.deriveExecutionScope(closure.result.evidenceAuthorization, { stageId: "stage" })!;
  }
  function transaction(inputManifest = manifest()) {
    const value = MutationTransaction.create(scope(), inputManifest);
    active.push(value);
    return value;
  }
  const replace = (oldText = "R0", newText = "R1", file = "target.ts", source = oldText): MutationOperation => ({ op: "replace_exact", path: file, oldText, newText, expectedFileHash: fingerprintBytes(source) });
  const fake = (content: unknown) => ({ content } as Awaited<ReturnType<LLMGateway["callStructured"]>>);
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "anka-tx-security-"));
    active = [];
    write("R0");
    fs.writeFileSync(path.join(root, "other.ts"), "other");
  });
  afterEach(() => {
    jest.restoreAllMocks();
    active.forEach(tx => tx.abort());
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("R0 authority advances to actual R1 through one trusted receipt without scope expansion", () => {
    const tx = transaction(); const grants = tx.capabilities;
    tx.apply([replace()]);
    expect(read()).toBe("R1");
    expect(tx.currentRevision).toBe(captureAuthoritySnapshot(root).revision);
    expect(tx.transitions).toHaveLength(1);
    expect(tx.transitions[0]).toMatchObject({ parentRevision: tx.baseRevision, childRevision: tx.currentRevision, repositoryIdentity: "project-A" });
    expect(tx.capabilities).toBe(grants);
    expect(grants).toEqual([{ path: "target.ts", action: "FILE_MODIFY" }]);
  });
  test("external RX invalidates even after a trusted initial mutation", () => {
    const tx = transaction(); tx.apply([replace()]); const r1 = tx.currentRevision;
    fs.writeFileSync(path.join(root, "other.ts"), "external");
    expect(() => tx.apply([replace("R1", "R2")])).toThrow(expect.objectContaining({ code: "TRANSACTION_REVISION_DIVERGED" }));
    expect(tx.status).toBe("INVALIDATED"); expect(tx.currentRevision).toBe(r1); expect(read()).toBe("R1");
  });
  test("backend repair workspace verifies actual R1 bytes in a different canonical root", () => {
    const tx = transaction(); tx.apply([replace()]); const binding = tx.createRepairWorkspace();
    expect(binding.workspaceRoot).not.toBe(root);
    expect(tx.verify(binding).revision).toBe(tx.currentRevision);
    expect(CapabilityGuard.forTransaction(tx, binding).authorize({ path: "target.ts", action: "FILE_MODIFY", scopeId: tx.id }).allowed).toBe(true);
  });
  test("R0 workspace cannot be used after transaction advances to R1", () => {
    const tx = transaction(); const binding = tx.createRepairWorkspace(); tx.apply([replace()]);
    expect(() => tx.verify(binding)).toThrow(expect.objectContaining({ code: "TRANSACTION_CONFLICT" }));
  });
  test("matching workspace metadata cannot bless different bytes", () => {
    const tx = transaction(); const binding = tx.createRepairWorkspace();
    fs.writeFileSync(path.join(binding.workspaceRoot, "target.ts"), "RX");
    expect(() => tx.verify(binding)).toThrow(expect.objectContaining({ code: "TRANSACTION_REVISION_DIVERGED" }));
  });
  test("forged workspace binding and unrelated physical root are rejected", () => {
    const tx = transaction(); const binding = tx.createRepairWorkspace();
    expect(() => CapabilityGuard.forTransaction(tx, { ...binding })).toThrow(expect.objectContaining({ code: "WORKSPACE_BINDING_INVALID" }));
  });
  test("fabricated transaction and receipt metadata are not credentials", () => {
    const tx = transaction();
    const forged = { ...tx, currentRevision: "R9", transitions: [{ parentRevision: tx.baseRevision, childRevision: "R9" }] };
    expect(() => CapabilityGuard.forTransaction(forged as unknown as MutationTransaction, tx.primary)).toThrow();
    expect(tx.transitions).toHaveLength(0);
    expect(() => Object.assign(tx, { currentRevision: "R9" })).toThrow();
  });
  test("receipt history cannot be modified to break parent-child continuity", () => {
    const tx = transaction(); tx.apply([replace()]);
    expect(() => Object.assign(tx.transitions[0], { parentRevision: "R9", repositoryIdentity: "project-B" })).toThrow();
    expect(() => (tx.transitions as unknown[]).push({ childRevision: "R9" })).toThrow();
    expect(tx.verify().revision).toBe(tx.currentRevision);
  });
  test("repository A transaction cannot consume repository B binding", () => {
    const tx = transaction();
    expect(() => tx.verify({ ...tx.primary, repositoryIdentity: "project-B" })).toThrow(expect.objectContaining({ code: "WORKSPACE_BINDING_INVALID" }));
  });
  test("capability without manifest permission is rejected at creation", () => {
    expect(() => transaction({ manifestVersion: "1", files: [], totalFiles: 0 })).toThrow(expect.objectContaining({ code: "CAPABILITY_MANIFEST_MISMATCH" }));
  });
  test("manifest permission cannot authorize an additional file", () => {
    const m = manifest(); m.files.push({ path: "other.ts", action: "modify", dependencies: [], description: "model request" });
    const tx = transaction(m);
    expect(() => tx.apply([replace("other", "stolen", "other.ts")])).toThrow(expect.objectContaining({ code: "REPAIR_SCOPE_EXPANSION_REQUIRED" }));
    expect(tx.status).toBe("INVALIDATED");
    expect(fs.readFileSync(path.join(root, "other.ts"), "utf8")).toBe("other");
  });
  test.each(["create_file", "delete_file"] as const)("repair cannot invent %s action", op => {
    const tx = transaction();
    const operation = op === "create_file" ? { op, path: "new.ts", expectedFileHash: null, content: "invented" }
      : { op, path: "target.ts", expectedFileHash: fingerprintBytes("R0") };
    expect(() => tx.apply([operation])).toThrow(expect.objectContaining({ code: "REPAIR_SCOPE_EXPANSION_REQUIRED" }));
  });
  test("manifest and proof references are immutable value snapshots", () => {
    const m = manifest(); const tx = transaction(m); m.files[0].path = "other.ts";
    expect(tx.manifest.files[0].path).toBe("target.ts");
    expect(() => tx.manifest.files.push(m.files[0])).toThrow();
    expect(() => (tx.authorityProofIds as string[]).push("forged")).toThrow();
  });
  test("failed repair never changes primary bytes or transaction revision", async () => {
    const tx = transaction(); tx.apply([replace()]); const r1 = tx.currentRevision;
    const binding = tx.createRepairWorkspace(); tx.apply([replace("R1", "BAD")], binding);
    expect(await tx.validateAndPromote(binding, async () => false)).toBe(false);
    expect(read()).toBe("R1"); expect(tx.currentRevision).toBe(r1); expect(tx.transitions).toHaveLength(1);
  });
  test("partial primary I/O failure restores parent and publishes no receipt", () => {
    const tx = transaction();
    const originalWrite = fs.writeFileSync;
    let writes = 0;
    jest.spyOn(fs, "writeFileSync").mockImplementation((...args: Parameters<typeof fs.writeFileSync>) => {
      writes++;
      if (writes === 2) throw new Error("injected primary write failure");
      return originalWrite(...args);
    });
    expect(() => tx.apply([replace("R0", "half"), replace("half", "R1")])).toThrow("injected primary write failure");
    expect(read()).toBe("R0"); expect(tx.currentRevision).toBe(tx.baseRevision);
    expect(tx.transitions).toHaveLength(0); expect(tx.status).toBe("INVALIDATED");
  });
  test("scope invalidation can roll back known primary descendants without blessing new authority", async () => {
    const tx = transaction();
    const stage = await StageExecutionTransaction.startTransaction("stage", root, CapabilityGuard.forTransaction(tx, tx.primary), tx);
    await stage.apply([{ path: "target.ts", action: "modify", content: "R1", description: "initial" }]);
    expect(() => tx.apply([replace("other", "invented", "other.ts")])).toThrow(expect.objectContaining({ code: "REPAIR_SCOPE_EXPANSION_REQUIRED" }));
    await stage.rollback();
    expect(read()).toBe("R0"); expect(tx.status).toBe("ABORTED");
    expect(stage.isRolledBack()).toBe(true);
  });
  test("external divergence cannot be overwritten or reported as a successful stage rollback", async () => {
    const tx = transaction();
    const stage = await StageExecutionTransaction.startTransaction("stage", root, CapabilityGuard.forTransaction(tx, tx.primary), tx);
    await stage.apply([{ path: "target.ts", action: "modify", content: "R1", description: "initial" }]);
    write("external");
    await expect(stage.rollback()).rejects.toMatchObject({ code: "TRANSACTION_REVISION_DIVERGED" });
    expect(read()).toBe("external"); expect(stage.isRolledBack()).toBe(false);
  });
  test("initial proposal cannot reinterpret a DELETE primitive as MODIFY", () => {
    const tx = transaction();
    expect(() => tx.applyChanges([{ path: "target.ts", action: "modify", content: "", description: "inconsistent",
      editPrimitive: { type: "DELETE_FILE", path: "target.ts", description: "delete" } }])).toThrow(expect.objectContaining({ code: "MUTATION_IR_INVALID" }));
    expect(read()).toBe("R0"); expect(tx.transitions).toHaveLength(0);
  });
  test("successful repair promotes exactly one R1 to R2 transition", async () => {
    const tx = transaction(); tx.apply([replace()]); const binding = tx.createRepairWorkspace();
    tx.apply([replace("R1", "R2")], binding);
    expect(read()).toBe("R1"); expect(tx.transitions).toHaveLength(1);
    expect(await tx.validateAndPromote(binding, async () => true)).toBe(true);
    expect(read()).toBe("R2"); expect(tx.transitions).toHaveLength(2);
    expect(tx.currentRevision).toBe(captureAuthoritySnapshot(root).revision);
    await expect(tx.validateAndPromote(binding, async () => true)).rejects.toMatchObject({ code: "WORKSPACE_BINDING_INVALID" });
  });
  test("promotion I/O failure preserves R1 and does not publish a receipt", async () => {
    const tx = transaction(); tx.apply([replace()]); const r1 = tx.currentRevision;
    const binding = tx.createRepairWorkspace(); tx.apply([replace("R1", "half"), replace("half", "R2")], binding);
    const original = fs.writeFileSync;
    let writes = 0;
    jest.spyOn(fs, "writeFileSync").mockImplementation((file, data, options) => {
      if (file === path.join(root, "target.ts") && ++writes === 2) throw new Error("fixture disk failure");
      original(file, data, options);
    });
    await expect(tx.validateAndPromote(binding, async () => true)).rejects.toThrow("fixture disk failure");
    expect(writes).toBe(3);
    expect(read()).toBe("R1"); expect(tx.currentRevision).toBe(r1); expect(tx.transitions).toHaveLength(1);
  });
  test("concurrent conflicting repairs cannot both become current", async () => {
    const tx = transaction(); const a = tx.createRepairWorkspace(); const b = tx.createRepairWorkspace();
    tx.apply([replace("R0", "R2A")], a); tx.apply([replace("R0", "R2B")], b);
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const first = tx.validateAndPromote(a, async () => { await gate; return true; });
    const second = tx.validateAndPromote(b, async () => { await gate; return true; });
    release();
    const outcomes = await Promise.allSettled([first, second]);
    expect(outcomes.filter(o => o.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(o => o.status === "rejected")).toHaveLength(1);
    expect(tx.transitions).toHaveLength(1); expect(read()).toBe("R2A");
  });
  test("aborted transaction cannot silently reactivate", () => {
    const tx = transaction(); tx.abort();
    expect(() => tx.apply([replace()])).toThrow(expect.objectContaining({ code: "TRANSACTION_INVALIDATED" }));
  });
  test("late manifest reconciliation requires fresh scope and records its authorization", () => {
    const authorized = scope();
    const updated = reconcileExecutionManifest(authorized, { manifestVersion: "old", files: [], totalFiles: 0 });
    const tx = MutationTransaction.create(authorized, updated); active.push(tx);
    expect(updated.files.map(f => f.path)).toEqual(["target.ts"]);
    expect(tx.manifestUpdates).toHaveLength(1);
    expect(tx.manifestUpdates[0]).toMatchObject({ previousVersion: "old", currentVersion: updated.manifestVersion });
    expect(tx.manifestVersion).toBe(tx.manifestUpdates[0].currentVersion);
    write("RX");
    expect(() => reconcileExecutionManifest(authorized, updated)).toThrow(expect.objectContaining({ code: "TRANSACTION_INVALIDATED" }));
  });
  test("stale initial proof cannot create a fresh transaction on RX", () => {
    const authorized = scope(); write("RX");
    expect(() => MutationTransaction.create(authorized, manifest())).toThrow(expect.objectContaining({ code: "TRANSACTION_INVALIDATED" }));
  });
  test("initial generated primitive cannot bypass its expected hash", () => {
    const tx = transaction();
    expect(() => tx.applyChanges([{ path: "target.ts", action: "modify", content: "R1", description: "stale primitive",
      editPrimitive: { type: "EXACT_REPLACE", path: "target.ts", oldText: "R0", newText: "R1", description: "stale", expectedSourceFingerprint: fingerprintBytes("RX") } }]))
      .toThrow(expect.objectContaining({ code: "FILE_HASH_MISMATCH" }));
    expect(read()).toBe("R0"); expect(tx.transitions).toHaveLength(0);
  });
  test("validation side effects do not become trusted candidate bytes", async () => {
    const tx = transaction(); const binding = tx.createRepairWorkspace(); tx.apply([replace()], binding);
    await expect(tx.validateAndPromote(binding, async candidate => {
      fs.writeFileSync(path.join(candidate, "other.ts"), "external validation side effect"); return true;
    })).rejects.toMatchObject({ code: "TRANSACTION_REVISION_DIVERGED" });
    expect(read()).toBe("R0"); expect(tx.transitions).toHaveLength(0);
  });
  test("a fresh guard accepts a trusted descendant but still enforces fixed scope", () => {
    const tx = transaction(); tx.apply([replace()]);
    const fresh = CapabilityGuard.forTransaction(tx, tx.primary);
    expect(fresh.authorize({ path: "target.ts", action: "FILE_MODIFY", scopeId: tx.id }).allowed).toBe(true);
    expect(fresh.authorize({ path: "other.ts", action: "FILE_MODIFY", scopeId: tx.id })).toMatchObject({ allowed: false, code: "REPAIR_SCOPE_EXPANSION_REQUIRED" });
  });
  test("dependencies in repair workspace cannot mutate primary dependencies", () => {
    fs.mkdirSync(path.join(root, "node_modules")); fs.writeFileSync(path.join(root, "node_modules", "fixture.js"), "original");
    const tx = transaction(); const binding = tx.createRepairWorkspace();
    fs.writeFileSync(path.join(binding.workspaceRoot, "node_modules", "fixture.js"), "candidate-only");
    expect(fs.readFileSync(path.join(root, "node_modules", "fixture.js"), "utf8")).toBe("original");
  });
  test("filesystem adapter cannot use an authentic transaction to write another root", async () => {
    const tx = transaction();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "anka-tx-other-root-"));
    try {
      fs.writeFileSync(path.join(outside, "target.ts"), "R0");
      const manager = new FileSystemStateManager(CapabilityGuard.forTransaction(tx, tx.primary), tx.id, tx);
      await expect(manager.applyPrimitives([{ type: "EXACT_REPLACE", path: "target.ts", oldText: "R0", newText: "stolen", description: "wrong root" }], outside))
        .rejects.toMatchObject({ code: "WORKSPACE_BINDING_INVALID" });
      expect(fs.readFileSync(path.join(outside, "target.ts"), "utf8")).toBe("R0");
      expect(read()).toBe("R0");
    } finally { fs.rmSync(outside, { recursive: true, force: true }); }
  });
  test("filesystem primitive adapter cannot bypass revision receipts", async () => {
    const tx = transaction();
    const manager = new FileSystemStateManager(CapabilityGuard.forTransaction(tx, tx.primary), tx.id, tx);
    await manager.applyPrimitives([{ type: "INSERT_AFTER", path: "target.ts", anchor: "R0", content: "X", description: "explicit insertion" }], root);
    expect(read()).toBe("R0X"); expect(tx.transitions).toHaveLength(1);
    expect(tx.currentRevision).toBe(captureAuthoritySnapshot(root).revision);
  });
  test("a manifest update from another authority cannot be rebound by matching path strings", () => {
    const first = scope(); const second = scope();
    const updated = reconcileExecutionManifest(first, manifest());
    expect(() => MutationTransaction.create(second, updated)).toThrow(expect.objectContaining({ code: "CAPABILITY_MANIFEST_MISMATCH" }));
  });
  test("reused legacy guard rejects external mutation after first authorization", () => {
    const guard = CapabilityGuard.create({ workspaceRoot: root, scopeId: "stage", authorizedScope: scope() });
    expect(guard.authorize({ path: "target.ts", action: "FILE_MODIFY", scopeId: "stage" }).allowed).toBe(true);
    write("RX");
    expect(guard.authorize({ path: "target.ts", action: "FILE_MODIFY", scopeId: "stage" }).allowed).toBe(false);
    expect(guard.beginMutation()).toBe(false);
  });
  test("junction escape invalidates binding without touching external bytes", () => {
    const tx = transaction(); const outside = fs.mkdtempSync(path.join(os.tmpdir(), "anka-tx-outside-"));
    try {
      fs.writeFileSync(path.join(outside, "secret.ts"), "secret");
      fs.symlinkSync(outside, path.join(root, "escape"), "junction");
      expect(() => tx.verify()).toThrow(expect.objectContaining({ code: "WORKSPACE_BINDING_INVALID" }));
      expect(fs.readFileSync(path.join(outside, "secret.ts"), "utf8")).toBe("secret");
    } finally { fs.rmSync(path.join(root, "escape"), { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); }
  });
  test.each([
    [{ op: "replace_exact", path: "target.ts", expectedFileHash: fingerprintBytes("R0"), oldText: "", newText: "invented" }, "MUTATION_IR_INVALID"],
    [replace("missing", "new", "target.ts", "R0"), "EDIT_ANCHOR_NOT_FOUND"],
    [replace("R", "new", "target.ts", "R0 R0"), "EDIT_ANCHOR_AMBIGUOUS"],
    [replace("R0", "R1", "target.ts", "stale"), "FILE_HASH_MISMATCH"],
  ])("compiler returns recoverable code for %j", (operation, code) => {
    const source = code === "EDIT_ANCHOR_AMBIGUOUS" ? "R0 R0" : "R0";
    expect(() => MutationCompiler.compile([operation], new Map([["target.ts", Buffer.from(source).toString("base64")]]))).toThrow(expect.objectContaining({ code }));
  });
  test.each(["insert_before", "insert_after"] as const)("%s is explicit, deterministic and replayable", op => {
    const files = new Map([["target.ts", Buffer.from("R0").toString("base64")]]);
    const operations = [{ op, path: "target.ts", expectedFileHash: fingerprintBytes("R0"), anchor: "R0", content: "X" }];
    expect(MutationCompiler.compile(operations, files)).toEqual(MutationCompiler.compile(operations, files));
    expect(Buffer.from(MutationCompiler.compile(operations, files)[0].after!, "base64").toString()).toBe(op === "insert_before" ? "XR0" : "R0X");
  });
  test("a cancelling mutation batch is rejected before filesystem writes", () => {
    const tx = transaction(); const writes = jest.spyOn(fs, "writeFileSync");
    expect(() => tx.apply([replace("R0", "R1"), replace("R1", "R0")])).toThrow(expect.objectContaining({ code: "MUTATION_IR_INVALID" }));
    expect(writes).not.toHaveBeenCalled(); expect(tx.transitions).toHaveLength(0);
  });

  function shellFixture() {
    fs.writeFileSync(path.join(root, "validate.cjs"), "const fs=require('fs');const s=fs.readFileSync('target.ts','utf8');if(s.includes('BAD')){console.error(\"target.ts(1,1): error TS2304: Cannot find name 'BAD'.\");process.exitCode=1;}if(s.includes('WORSE')){console.error(\"target.ts(1,1): error TS2322: Worse diagnostic.\");process.exitCode=1;}");
  }
  async function repair(tx: MutationTransaction, content = "BAD", commands = ["node validate.cjs"]) {
    const manager = new FileSystemStateManager(CapabilityGuard.forTransaction(tx, tx.primary), tx.id, tx);
    const changes = [{ path: "target.ts", action: "modify" as const, content, description: "initial candidate" }];
    await manager.snapshot(changes, root);
    return SelfHealingEngine.runSelfHealingLoop(changes, root, commands, "system", "Repair target.ts", manager, "project-A", undefined, manifest());
  }
  test("production authorization → initial mutation → malformed repair → correction → isolated validation → promotion", async () => {
    shellFixture(); const tx = transaction();
    const model = jest.spyOn(LLMGateway.getInstance(), "callStructured")
      .mockResolvedValueOnce(fake({ changes: [{ action: "modify", path: "target.ts", edits: [{ oldText: "", newText: "invented" }] }] }))
      .mockResolvedValueOnce(fake({ operations: [replace("BAD", "FIXED")] }));
    const outcome = await repair(tx);
    expect(outcome).toMatchObject({ success: true, attempts: 2, repairApplied: true });
    expect(read()).toBe("FIXED"); expect(tx.transitions).toHaveLength(2);
    expect(tx.currentRevision).toBe(captureAuthoritySnapshot(root).revision);
    expect(model.mock.calls[1][0].messages[1].content).toContain("Structured correction required");
    expect(model.mock.calls[1][0].messages[1].content).toContain("introducedFailures");
  });
  test("package-manager command banners do not masquerade as unscoped repair failures", async () => {
    const tx = transaction();
    let validationCall = 0;
    jest.spyOn(ValidationRunner, "validateWithShell").mockImplementation(async () => {
      validationCall++;
      if (validationCall === 1) return { success: true, errors: "" };
      if (validationCall === 2) {
        return {
          success: false,
          errors: [
            "npm run build failed (exit code 2):",
            "> fixture@1.0.0 build\n> tsc && vite build",
            "target.ts(1,1): error TS2304: Cannot find name 'BAD'.\nCommand failed: npm run build",
          ].join("\n\n"),
        };
      }
      return { success: true, errors: "" };
    });
    const model = jest.spyOn(LLMGateway.getInstance(), "callStructured")
      .mockResolvedValue(fake({ operations: [replace("BAD", "FIXED")] }));

    const outcome = await repair(tx, "BAD", ["npm run build"]);

    expect(outcome).toMatchObject({ success: true, attempts: 1, repairApplied: true });
    expect(model).toHaveBeenCalledTimes(1);
    expect(read()).toBe("FIXED");
  });
  test("schema error once then valid response recovers without throwing", async () => {
    shellFixture(); const tx = transaction();
    jest.spyOn(LLMGateway.getInstance(), "callStructured").mockRejectedValueOnce(new LLMSchemaInvalidError("empty oldText"))
      .mockResolvedValueOnce(fake({ operations: [replace("BAD", "FIXED")] }));
    await expect(repair(tx)).resolves.toMatchObject({ success: true, attempts: 2 });
  });
  test("reducing introduced diagnostics permits promotion and continued bounded repair", async () => {
    shellFixture(); const tx = transaction();
    jest.spyOn(LLMGateway.getInstance(), "callStructured")
      .mockResolvedValueOnce(fake({ operations: [replace("BAD", "FIXED", "target.ts", "BAD WORSE")] }))
      .mockResolvedValueOnce(fake({ operations: [replace("WORSE", "FIXED", "target.ts", "FIXED WORSE")] }));
    await expect(repair(tx, "BAD WORSE")).resolves.toMatchObject({ success: true, attempts: 2 });
    expect(read()).toBe("FIXED FIXED"); expect(tx.transitions).toHaveLength(3);
  });
  test("model task/proof/manifest overrides never change runtime authority", async () => {
    shellFixture(); const tx = transaction(); const originalProofs = [...tx.authorityProofIds];
    jest.spyOn(LLMGateway.getInstance(), "callStructured").mockResolvedValue(fake({ operations: [replace("BAD", "FIXED")],
      originalTask: "new task", authorityProofIds: ["fake"], manifest: { files: [{ path: "other.ts", action: "delete" }] } }));
    await expect(repair(tx)).resolves.toMatchObject({ success: false, errorType: "REPAIR_UNRESOLVED" });
    expect(tx.authorityProofIds).toEqual(originalProofs); expect(tx.manifest.files[0].path).toBe("target.ts");
    expect(read()).toBe("BAD"); expect(tx.transitions).toHaveLength(1);
  });
  test("repeated malformed repair returns REPAIR_UNRESOLVED within three calls, never rejects as HTTP 500", async () => {
    shellFixture(); const tx = transaction();
    const model = jest.spyOn(LLMGateway.getInstance(), "callStructured").mockRejectedValue(new LLMSchemaInvalidError("empty oldText"));
    await expect(repair(tx)).resolves.toMatchObject({ success: false, errorType: "REPAIR_UNRESOLVED", attempts: 3 });
    expect(model).toHaveBeenCalledTimes(3); expect(read()).toBe("BAD"); expect(tx.transitions).toHaveLength(1);
  });
  test("worse diagnostic repair is discarded and primary remains last-known-good R1", async () => {
    shellFixture(); const tx = transaction();
    jest.spyOn(LLMGateway.getInstance(), "callStructured").mockResolvedValue(fake({ operations: [replace("BAD", "WORSE")] }));
    const outcome = await repair(tx);
    expect(outcome).toMatchObject({ success: false, errorType: "REPAIR_UNRESOLVED" });
    expect(read()).toBe("BAD"); expect(tx.transitions).toHaveLength(1);
  });
  test("baseline-only failure is excluded from repair", async () => {
    shellFixture(); write("BAD"); const tx = transaction();
    const model = jest.spyOn(LLMGateway.getInstance(), "callStructured");
    const manager = new FileSystemStateManager(CapabilityGuard.forTransaction(tx, tx.primary), tx.id, tx);
    const outcome = await SelfHealingEngine.runSelfHealingLoop([], root, ["node validate.cjs"], "system", "Repair target.ts", manager);
    expect(outcome).toMatchObject({ success: true, repositoryClean: false }); expect(model).not.toHaveBeenCalled();
  });
  test("failed validation with no parseable diagnostics cannot become success or promotion", async () => {
    shellFixture(); const tx = transaction();
    const normalize = DiagnosticNormalizer.normalize.bind(DiagnosticNormalizer);
    jest.spyOn(DiagnosticNormalizer, "normalize").mockImplementationOnce(normalize).mockReturnValue([]);
    jest.spyOn(LLMGateway.getInstance(), "callStructured").mockResolvedValue(fake({ operations: [replace("BAD", "WORSE")] }));
    await expect(repair(tx)).resolves.toMatchObject({ success: false, errorType: "REPAIR_UNRESOLVED" });
    expect(read()).toBe("BAD"); expect(tx.transitions).toHaveLength(1);
  });
  test("model-requested additional file returns typed scope expansion and leaves primary unchanged", async () => {
    shellFixture(); const tx = transaction();
    jest.spyOn(LLMGateway.getInstance(), "callStructured").mockResolvedValue(fake({ operations: [replace("other", "invented", "other.ts")] }));
    await expect(repair(tx)).resolves.toMatchObject({ success: false, errorType: "REPAIR_SCOPE_EXPANSION_REQUIRED" });
    expect(read()).toBe("BAD"); expect(fs.readFileSync(path.join(root, "other.ts"), "utf8")).toBe("other");
  });
  test("remaining targeted baseline diagnostic requires reinvestigation instead of a false task success", async () => {
    shellFixture(); write("BAD"); const tx = transaction();
    const model = jest.spyOn(LLMGateway.getInstance(), "callStructured");
    const manager = new FileSystemStateManager(CapabilityGuard.forTransaction(tx, tx.primary), tx.id, tx);
    const outcome = await SelfHealingEngine.runSelfHealingLoop([], root, ["node validate.cjs"], "system", "Repair target.ts", manager,
      "project-A", undefined, manifest(), undefined, undefined,
      [{ filePath: "target.ts", errorType: "TYPESCRIPT", errorCode: "TS2304", message: "original failure", fingerprint: "advisory", origin: "BASELINE" }]);
    expect(outcome).toMatchObject({ success: false, taskVerified: false, errorType: "REINVESTIGATION_REQUIRED" });
    expect(model).not.toHaveBeenCalled(); expect(tx.transitions).toHaveLength(0);
  });
  test("coordinator action group commits the real corrected repair through its transaction", async () => {
    shellFixture();
    const authorized = scope();
    jest.spyOn(ValidationPlanner, "detectValidationCommands").mockReturnValue(["node validate.cjs"]);
    jest.spyOn(SecurityAuditor, "runReflectionAndSecurityAudit").mockResolvedValue({ securityPass: true } as Awaited<ReturnType<typeof SecurityAuditor.runReflectionAndSecurityAudit>>);
    jest.spyOn(ValidationDetector, "runFeatureValidation").mockResolvedValue({ overallPassed: true } as Awaited<ReturnType<typeof ValidationDetector.runFeatureValidation>>);
    jest.spyOn(LLMGateway.getInstance(), "callStructured").mockResolvedValueOnce(fake({ action: "modify", edits: [{ oldText: "", newText: "invented" }] }))
      .mockResolvedValueOnce(fake({ operations: [replace("BAD", "FIXED")] }));
    const intent = createTaskIntentSpec("Repair target.ts", { taskType: "BUG_FIX", intent: "BUG_FIX", risk: "MEDIUM", estimatedComplexity: "MEDIUM", confidence: 1, requiresClarification: false, reasoning: "fixture" });
    const outcome = await ValidationCoordinator.validate({ acceptedChanges: [{ path: "target.ts", action: "modify", content: "BAD", description: "initial candidate" }],
      effectiveLocalPath: root, effectiveSnapshot: { repoName: "fixture", defaultBranch: "main", languages: {}, fileTree: ["target.ts"], keyFiles: [], lastSyncedAt: new Date() },
      executionContract: { ...policy, targetPaths: ["target.ts"], searchScope: ["target.ts"], contextScope: ["target.ts"] },
      monorepo: MonorepoDetector.detectMonorepo(root), activeStageId: "stage", taskExecutionPlan: { id: "plan", goal: intent.goal, currentStageIndex: 0, status: "RUNNING",
        stages: [{ id: "stage", name: "repair", intent, dependsOn: [], status: "RUNNING" }] }, systemPrompt: "system", requestMessage: intent.goal, projectId: "project-A",
      approvedManifest: manifest(), authorizedCapabilityScope: authorized });
    expect(outcome.gateSuccess).toBe(true); expect(read()).toBe("FIXED");
    expect(outcome.stageTransaction.isCommitted()).toBe(true);
    expect(outcome.stageTransaction.fsManager.mutationTransaction?.status).toBe("COMPLETED");
    expect(outcome.stageTransaction.fsManager.mutationTransaction?.transitions).toHaveLength(2);
  });
});
