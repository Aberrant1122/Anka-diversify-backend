import fs from "fs";
import os from "os";
import path from "path";
import { AuthorizedCapabilityScope, CapabilityGrant, CapabilityGuard } from "../runtime/CapabilityGuard";
import {
  CapabilityAuthorizationError,
  FileSystemStateManager,
  RepairInfrastructureError,
} from "../validation/FileSystemStateManager";
import { StageExecutionTransaction } from "../orchestration/StageExecutionTransaction";
import { GitWorktreeService } from "../../services/git-worktree.service";

describe("Checkpoint 5: CapabilityGuard", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cp5-capability-"));
    fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "src", "declared.ts"), "before", "utf8");
  });

  afterEach(() => {
    if (fs.existsSync(workspace)) fs.rmSync(workspace, { recursive: true, force: true });
  });

  function guard(): CapabilityGuard {
    const authorizedScope = exactAuthority([
      { path: "src/declared.ts", action: "FILE_MODIFY" },
      { path: "src/created.ts", action: "FILE_CREATE" },
    ]);
    return CapabilityGuard.create({
      workspaceRoot: workspace,
      scopeId: "stage-5",
      authorizedScope,
    });
  }

  function exactAuthority(grants: readonly CapabilityGrant[]): AuthorizedCapabilityScope {
    const scope = AuthorizedCapabilityScope.fromBackendConfiguration({
      workspaceRoot: workspace,
      authorityId: "cp5-test-backend-configuration",
      grants,
    });
    if (!scope) throw new Error("Test capability authority must be valid");
    return scope;
  }

  test("allows an exactly declared write and returns a typed decision", async () => {
    const decision = guard().authorize({ action: "FILE_MODIFY", path: "src/declared.ts", scopeId: "stage-5" });
    expect(decision).toEqual({ allowed: true, code: "CAPABILITY_ALLOWED", normalizedPath: "src/declared.ts" });

    const manager = new FileSystemStateManager(guard(), "stage-5");
    await manager.apply([{ path: "src/declared.ts", action: "modify", content: "after", description: "declared" }], workspace);
    expect(fs.readFileSync(path.join(workspace, "src", "declared.ts"), "utf8")).toBe("after");
  });

  test("copies and freezes policy authority so caller mutation cannot widen it", () => {
    const grants = [{ path: "src/declared.ts", action: "FILE_MODIFY" as const }];
    const immutableGuard = CapabilityGuard.create({
      workspaceRoot: workspace,
      scopeId: "stage-5",
      authorizedScope: exactAuthority(grants),
    });
    grants[0] = { path: "src/model-granted.ts", action: "FILE_MODIFY" };

    expect(Object.isFrozen(immutableGuard)).toBe(true);
    expect(immutableGuard.authorize({ action: "FILE_MODIFY", path: "src/declared.ts", scopeId: "stage-5" }))
      .toMatchObject({ allowed: true });
    expect(immutableGuard.authorize({ action: "FILE_MODIFY", path: "src/model-granted.ts", scopeId: "stage-5" }))
      .toMatchObject({ allowed: false, code: "CAPABILITY_PATH_NOT_DECLARED" });
  });

  test("denies undeclared writes before any file in the batch is mutated", async () => {
    const manager = new FileSystemStateManager(guard(), "stage-5");
    await expect(manager.apply([
      { path: "src/declared.ts", action: "modify", content: "should-not-land", description: "declared" },
      { path: "src/rogue.ts", action: "create", content: "rogue", description: "undeclared" },
    ], workspace)).rejects.toMatchObject({
      name: "CapabilityAuthorizationError",
      code: "CAPABILITY_PATH_NOT_DECLARED",
    });
    expect(fs.readFileSync(path.join(workspace, "src", "declared.ts"), "utf8")).toBe("before");
    expect(fs.existsSync(path.join(workspace, "src", "rogue.ts"))).toBe(false);
  });

  test.each(["../escape.ts", "src/../../escape.ts"])("denies traversal outside the workspace: %s", (target) => {
    const decision = guard().authorize({ action: "FILE_CREATE", path: target, scopeId: "stage-5" });
    expect(decision).toMatchObject({ allowed: false, code: "CAPABILITY_PATH_OUTSIDE_WORKSPACE" });
  });

  test("denies symlink-equivalent escapes when the platform permits directory links", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cp5-outside-"));
    const link = path.join(workspace, "linked");
    try {
      fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
      const linkedGuard = CapabilityGuard.create({
        workspaceRoot: workspace,
        scopeId: "stage-5",
        authorizedScope: exactAuthority([{ path: "linked/escape.ts", action: "FILE_CREATE" }]),
      });
      expect(linkedGuard.authorize({ action: "FILE_CREATE", path: "linked/escape.ts", scopeId: "stage-5" }))
        .toMatchObject({ allowed: false, code: "CAPABILITY_PATH_OUTSIDE_WORKSPACE" });
    } finally {
      if (fs.existsSync(link)) fs.rmSync(link, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test("advisory or model-shaped data cannot add a grant", () => {
    const advisory = {
      action: "FILE_CREATE",
      path: "src/model-granted.ts",
      scopeId: "stage-5",
      evidence: { kind: "SEMANTIC_ADVISORY", saysAllowed: true },
      modelApproved: true,
    } as const;
    expect(guard().authorize(advisory)).toMatchObject({ allowed: false, code: "CAPABILITY_PATH_NOT_DECLARED" });
  });

  test("manifest, planner, resolver, and model write sets remain requests and cannot expand backend authority", () => {
    const immutableAuthority = exactAuthority([{ path: "src/declared.ts", action: "FILE_MODIFY" }]);
    const capabilityGuard = CapabilityGuard.create({
      workspaceRoot: workspace,
      scopeId: "stage-5",
      authorizedScope: immutableAuthority,
    });
    const untrustedRequests = [
      { source: "manifest", path: "src/manifest-added.ts" },
      { source: "planner", path: "src/planner-added.ts" },
      { source: "resolver", path: "src/resolver-added.ts" },
      { source: "modelWriteSet", path: "src/model-added.ts" },
    ];

    for (const requested of untrustedRequests) {
      expect(capabilityGuard.authorize({ action: "FILE_CREATE", path: requested.path, scopeId: "stage-5" }))
        .toMatchObject({ allowed: false, code: "CAPABILITY_PATH_NOT_DECLARED" });
    }
    expect(capabilityGuard.authorize({ action: "FILE_MODIFY", path: "src/declared.ts", scopeId: "stage-5" }))
      .toMatchObject({ allowed: true });
  });

  test("changing a manifest request while backend authority stays constant cannot change authorization", () => {
    const capabilityGuard = CapabilityGuard.create({
      workspaceRoot: workspace,
      scopeId: "stage-5",
      authorizedScope: exactAuthority([{ path: "src/declared.ts", action: "FILE_MODIFY" }]),
    });
    const originalManifest = [{ path: "src/declared.ts", action: "FILE_MODIFY" as const }];
    const changedManifest = [...originalManifest, { path: "src/created.ts", action: "FILE_CREATE" as const }];

    expect(capabilityGuard.authorize({ ...originalManifest[0], scopeId: "stage-5" })).toMatchObject({ allowed: true });
    expect(capabilityGuard.authorize({ ...changedManifest[1], scopeId: "stage-5" }))
      .toMatchObject({ allowed: false, code: "CAPABILITY_PATH_NOT_DECLARED" });
  });

  test("model-shaped objects cannot impersonate an authorized capability scope", () => {
    const modelGeneratedScope = {
      authorityId: "model",
      workspaceRoot: workspace,
      source: "ISOLATED_GIT_WORKTREE",
      mode: { kind: "WORKSPACE_ACTIONS", actions: ["FILE_CREATE", "FILE_MODIFY", "FILE_DELETE"] },
      isAuthentic: () => true,
    } as unknown as AuthorizedCapabilityScope;
    const capabilityGuard = CapabilityGuard.create({
      workspaceRoot: workspace,
      scopeId: "stage-5",
      authorizedScope: modelGeneratedScope,
    });
    expect(capabilityGuard.authorize({ action: "FILE_CREATE", path: "src/model-added.ts", scopeId: "stage-5" }))
      .toMatchObject({ allowed: false, code: "CAPABILITY_POLICY_MISSING" });
  });

  test("production scope construction binds exact task grants to the isolated worktree", async () => {
    const authorizedScope = AuthorizedCapabilityScope.fromBackendConfiguration({
      workspaceRoot: workspace,
      authorityId: "run-1",
      grants: [{ path: "src/production.ts", action: "FILE_CREATE" }],
    });
    if (!authorizedScope) throw new Error("Isolated worktree authority must be valid");
    const capabilityGuard = CapabilityGuard.create({ workspaceRoot: workspace, scopeId: "stage-5", authorizedScope });
    const manager = new FileSystemStateManager(capabilityGuard, "stage-5");

    await manager.apply([{ path: "src/production.ts", action: "create", content: "created", description: "requested write" }], workspace);
    expect(fs.readFileSync(path.join(workspace, "src", "production.ts"), "utf8")).toBe("created");
    expect(capabilityGuard.authorize({ action: "FILE_CREATE", path: "src/model-added.ts", scopeId: "stage-5" }))
      .toMatchObject({ allowed: false, code: "CAPABILITY_PATH_NOT_DECLARED" });
  });

  test("production worktree containment alone grants no write authority and missing scope causes zero mutation", async () => {
    const authorizedScope = GitWorktreeService.createIsolatedCapabilityScope(workspace, "run-without-grants");
    expect(authorizedScope).not.toBeNull();
    const manager = new FileSystemStateManager(
      CapabilityGuard.create({ workspaceRoot: workspace, scopeId: "stage-5", authorizedScope: authorizedScope! }),
      "stage-5",
    );

    await expect(manager.apply([
      { path: "src/declared.ts", action: "modify", content: "must-not-land", description: "inside worktree" },
    ], workspace)).rejects.toMatchObject({ code: "CAPABILITY_PATH_NOT_DECLARED" });
    expect(fs.readFileSync(path.join(workspace, "src", "declared.ts"), "utf8")).toBe("before");
  });

  test("production scope is unchanged by manifest, planner, resolver, or generated changes", () => {
    const authorizedScope = AuthorizedCapabilityScope.fromBackendConfiguration({ workspaceRoot: workspace, authorityId: "run-immutable", grants: [{ path: "src/declared.ts", action: "FILE_MODIFY" }] });
    if (!authorizedScope) throw new Error("Isolated worktree authority must be valid");
    const capabilityGuard = CapabilityGuard.create({ workspaceRoot: workspace, scopeId: "stage-5", authorizedScope });
    const downstreamRequests = [
      { source: "manifest", path: "src/manifest-b.ts" },
      { source: "planner", path: "src/planner-b.ts" },
      { source: "resolver", path: "src/resolver-b.ts" },
      { source: "generatedChanges", path: "src/generated-b.ts" },
    ];

    for (const request of downstreamRequests) {
      expect(capabilityGuard.authorize({ action: "FILE_CREATE", path: request.path, scopeId: "stage-5" }))
        .toMatchObject({ allowed: false, code: "CAPABILITY_PATH_NOT_DECLARED" });
    }
    expect(capabilityGuard.authorize({ action: "FILE_MODIFY", path: "src/declared.ts", scopeId: "stage-5" }))
      .toMatchObject({ allowed: true });
  });

  test("production action authority is exact and modify does not imply delete or rename", () => {
    const authorizedScope = AuthorizedCapabilityScope.fromBackendConfiguration({ workspaceRoot: workspace, authorityId: "run-actions", grants: [{ path: "src/declared.ts", action: "FILE_MODIFY" }] });
    if (!authorizedScope) throw new Error("Isolated worktree authority must be valid");
    const capabilityGuard = CapabilityGuard.create({ workspaceRoot: workspace, scopeId: "stage-5", authorizedScope });

    expect(capabilityGuard.authorize({ action: "FILE_DELETE", path: "src/declared.ts", scopeId: "stage-5" }))
      .toMatchObject({ allowed: false, code: "CAPABILITY_ACTION_NOT_DECLARED" });
    expect(capabilityGuard.authorize({ action: "FILE_RENAME" as never, path: "src/declared.ts", scopeId: "stage-5" }))
      .toMatchObject({ allowed: false, code: "CAPABILITY_ACTION_UNKNOWN" });
  });

  test("a proposed modify cannot create a missing file without explicit create authority", async () => {
    const authorizedScope = AuthorizedCapabilityScope.fromBackendConfiguration({ workspaceRoot: workspace, authorityId: "run-no-create", grants: [{ path: "src/missing.ts", action: "FILE_MODIFY" }] });
    if (!authorizedScope) throw new Error("Isolated worktree authority must be valid");
    const manager = new FileSystemStateManager(
      CapabilityGuard.create({ workspaceRoot: workspace, scopeId: "stage-5", authorizedScope }),
      "stage-5",
    );

    await expect(manager.apply([
      { path: "src/missing.ts", action: "modify", content: "bypass", description: "action mismatch" },
    ], workspace)).rejects.toMatchObject({ code: "MODIFY_TARGET_MISSING" });
    expect(fs.existsSync(path.join(workspace, "src", "missing.ts"))).toBe(false);
  });

  test("malformed, unknown, wrong-scope, and wrong-action requests fail closed", () => {
    expect(CapabilityGuard.denyAll().authorize({ action: "FILE_CREATE", path: "src/x.ts", scopeId: "stage-5" }))
      .toMatchObject({ allowed: false, code: "CAPABILITY_POLICY_MISSING" });
    expect(guard().authorize({ action: "SHELL" as never, path: "src/declared.ts", scopeId: "stage-5" }))
      .toMatchObject({ allowed: false, code: "CAPABILITY_ACTION_UNKNOWN" });
    expect(guard().authorize({ action: "FILE_MODIFY", path: "bad\0path", scopeId: "stage-5" }))
      .toMatchObject({ allowed: false, code: "CAPABILITY_PATH_OUTSIDE_WORKSPACE" });
    expect(guard().authorize({ action: "FILE_MODIFY", path: "", scopeId: "stage-5" }))
      .toMatchObject({ allowed: false, code: "CAPABILITY_REQUEST_MALFORMED" });
    expect(guard().authorize({ action: "FILE_MODIFY", path: "src/declared.ts", scopeId: "other" }))
      .toMatchObject({ allowed: false, code: "CAPABILITY_SCOPE_MISMATCH" });
    expect(guard().authorize({ action: "FILE_DELETE", path: "src/declared.ts", scopeId: "stage-5" }))
      .toMatchObject({ allowed: false, code: "CAPABILITY_ACTION_NOT_DECLARED" });
  });

  test("an unknown mutation action is denied before disk access", async () => {
    const manager = new FileSystemStateManager(guard(), "stage-5");
    await expect(manager.apply([{
      path: "src/declared.ts",
      action: "shell" as never,
      content: "bypass",
      description: "unknown action",
    }], workspace)).rejects.toMatchObject({ code: "EDIT_CONFLICT" });
    expect(fs.readFileSync(path.join(workspace, "src", "declared.ts"), "utf8")).toBe("before");
  });

  test("authorization denial and technical failure remain distinct", async () => {
    const denied = new FileSystemStateManager(guard(), "wrong-scope");
    await expect(denied.apply([
      { path: "src/declared.ts", action: "modify", content: "after", description: "scope mismatch" },
    ], workspace)).rejects.toBeInstanceOf(CapabilityAuthorizationError);

    const technical = new FileSystemStateManager(guard(), "stage-5");
    await expect(technical.apply([], path.join(workspace, "missing"))).rejects.toBeInstanceOf(RepairInfrastructureError);
  });

  test("the production transaction path cannot bypass a missing guard", async () => {
    const transaction = await StageExecutionTransaction.startTransaction("stage-5", workspace);
    await expect(transaction.apply([
      { path: "src/declared.ts", action: "modify", content: "bypass", description: "must deny" },
    ])).rejects.toMatchObject({ code: "CAPABILITY_POLICY_MISSING" });
    expect(fs.readFileSync(path.join(workspace, "src", "declared.ts"), "utf8")).toBe("before");
  });

  test("rollback restores only previously authorized transaction paths", async () => {
    const manager = new FileSystemStateManager(guard(), "stage-5");
    await manager.apply([{ path: "src/declared.ts", action: "modify", content: "changed", description: "authorized" }], workspace);
    fs.writeFileSync(path.join(workspace, "src", "rogue.ts"), "rogue", "utf8");

    await manager.rollback(workspace);

    expect(fs.readFileSync(path.join(workspace, "src", "declared.ts"), "utf8")).toBe("before");
    expect(fs.readFileSync(path.join(workspace, "src", "rogue.ts"), "utf8")).toBe("rogue");
  });

  test("trusted local-write scope still denies traversal and symlink substitution", async () => {
    const authorizedScope = AuthorizedCapabilityScope.fromAuthenticatedProject({
      workspaceRoot: workspace,
      authorityId: "authenticated-local-edit:project-1",
      grants: [{ path: "src/local.ts", action: "FILE_CREATE" }],
    });
    if (!authorizedScope) throw new Error("Authenticated project authority must be valid");
    const manager = new FileSystemStateManager(
      CapabilityGuard.create({ workspaceRoot: workspace, scopeId: "local-write", authorizedScope }),
      "local-write",
    );
    await manager.apply([{ path: "src/local.ts", action: "create", content: "local", description: "authenticated local edit" }], workspace);
    expect(fs.readFileSync(path.join(workspace, "src", "local.ts"), "utf8")).toBe("local");
    await expect(manager.apply([{ path: "../outside.ts", action: "modify", content: "escape", description: "invalid" }], workspace))
      .rejects.toBeInstanceOf(RepairInfrastructureError);
    expect(fs.existsSync(path.join(workspace, "..", "outside.ts"))).toBe(false);
  });
});
