import fs from "fs";
import os from "os";
import path from "path";
import { PGlite } from "@electric-sql/pglite";
import { mainFromBrief, hash } from "../document-contract";
import { WorkspaceService } from "../workspace-service";
import { postgresAdapter } from "./postgres-adapter";
const migrationName = "20261102190000_workspace_validation_purpose";
describe("V1 additive purpose migration and unsupported-purpose service boundaries", () => {
  let db: PGlite, service: WorkspaceService, root: string, before: any;
  const rows = async () => ({
    documents: (
      await db.query(
        'SELECT id,content,"contentHash" FROM "WorkspaceDocument" ORDER BY id',
      )
    ).rows,
    approvals: (
      await db.query('SELECT id,snapshot FROM "WorkspaceApproval" ORDER BY id')
    ).rows,
    runs: (
      await db.query('SELECT id,authority FROM "WorkspaceRun" ORDER BY id')
    ).rows,
    events: (await db.query('SELECT * FROM "WorkspaceEvent" ORDER BY id')).rows,
    operations: (
      await db.query('SELECT * FROM "WorkspaceOperation" ORDER BY id')
    ).rows,
  });
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "anka-validation-v1-"));
    db = new PGlite(path.join(root, "db"));
    const dir = path.resolve(__dirname, "../../../prisma/migrations");
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name, "migration.sql");
      if (name !== migrationName && fs.existsSync(file))
        await db.exec(fs.readFileSync(file, "utf8"));
    }
    await db.exec(`INSERT INTO users(id,email,password,"updatedAt") VALUES ('v1-owner','v1-owner@example.test','synthetic',now());
      INSERT INTO projects(id,name,"userId","updatedAt") VALUES ('v1-project','Purpose migration fixture','v1-owner',now());
      INSERT INTO "WorkspaceDocument"(id,"projectId",kind,version,"contentHash",content,"createdBy") VALUES ('v1-main','v1-project','MAIN',1,'unchanged-main','{"legacy":"main"}','v1-owner'),('v1-arch','v1-project','ARCHITECTURE',1,'unchanged-arch','{"legacy":"architecture"}','v1-owner');
      INSERT INTO "WorkspaceApproval"(id,"projectId","mainId","architectureId",snapshot,"createdBy") VALUES ('v1-approval','v1-project','v1-main','v1-arch','{"legacy":"snapshot"}','v1-owner');
      INSERT INTO "WorkspaceRun"(id,"projectId","approvalId","idempotencyKey",authority,"createdBy") VALUES ('v1-run','v1-project','v1-approval','legacy-run-001','{"legacy":"authority"}','v1-owner');
      INSERT INTO "WorkspaceHead"("projectId","mainId","architectureId","approvalId") VALUES ('v1-project','v1-main','v1-arch','v1-approval');
      INSERT INTO "WorkspaceEvent"(id,"projectId","runId",kind,payload,"createdBy") VALUES ('v1-event','v1-project','v1-run','RUN_AUTHORIZED','{"legacy":"event"}','v1-owner');
      INSERT INTO "WorkspaceOperation"(id,"projectId","runId",kind,"idempotencyKey","stateVersion","inputHash",context,"createdBy",status,result) VALUES ('v1-op','v1-project','v1-run','VALIDATION','legacy-op-001',0,'legacy-input','{"legacy":"context"}','v1-owner','COMPLETED','{"legacy":"result"}');`);
    before = await rows();
    await db.exec(
      fs.readFileSync(path.join(dir, migrationName, "migration.sql"), "utf8"),
    );
    service = new WorkspaceService(postgresAdapter(db));
  }, 120000);
  afterAll(async () => {
    await db?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });
  it("preserves all historical snapshots/documents/events/operations and defaults legacy purposes", async () => {
    expect(await rows()).toEqual(before);
    expect(
      (await db.query('SELECT purpose FROM "WorkspaceApproval"')).rows,
    ).toEqual([{ purpose: "IMPLEMENTATION" }]);
    expect((await db.query('SELECT purpose FROM "WorkspaceRun"')).rows).toEqual(
      [{ purpose: "IMPLEMENTATION" }],
    );
  });
  it("defaults new legacy-style inserts and rejects null/unknown purpose and approval/run purpose mismatch", async () => {
    await db.exec(
      `INSERT INTO "WorkspaceRun"(id,"projectId","approvalId","idempotencyKey",authority,"createdBy") VALUES ('v1-default','v1-project','v1-approval','default-run-001','{}','v1-owner');`,
    );
    expect(
      (
        await db.query('SELECT purpose FROM "WorkspaceRun" WHERE id=$1', [
          "v1-default",
        ])
      ).rows,
    ).toEqual([{ purpose: "IMPLEMENTATION" }]);
    for (const purpose of [null, "UNKNOWN", "BASELINE_VALIDATION"])
      await expect(
        db.query(
          `INSERT INTO "WorkspaceRun"(id,"projectId","approvalId","idempotencyKey",authority,"createdBy",purpose) VALUES ('invalid','v1-project','v1-approval','invalid-run-001','{}','v1-owner',$1)`,
          [purpose],
        ),
      ).rejects.toThrow();
    await expect(
      db.exec(
        `INSERT INTO "WorkspaceApproval"(id,"projectId","mainId","architectureId",snapshot,"createdBy",purpose) VALUES ('invalid','v1-project','v1-main','v1-arch','{}','v1-owner','UNKNOWN')`,
      ),
    ).rejects.toThrow();
  });
  it("keeps purpose and snapshot immutable, including against a direct purpose rewrite", async () => {
    await expect(
      db.exec(
        `UPDATE "WorkspaceApproval" SET purpose='BASELINE_VALIDATION' WHERE id='v1-approval'`,
      ),
    ).rejects.toThrow("immutable");
    await expect(
      db.exec(
        `UPDATE "WorkspaceRun" SET purpose='BASELINE_VALIDATION' WHERE id='v1-run'`,
      ),
    ).rejects.toThrow("immutable");
    await expect(
      db.exec(`UPDATE "WorkspaceDocument" SET content='{}' WHERE id='v1-main'`),
    ).rejects.toThrow("immutable");
    await expect(
      db.exec(
        `UPDATE "WorkspaceOperation" SET "inputHash"='changed' WHERE id='v1-op'`,
      ),
    ).rejects.toThrow("immutable");
  });
  it("persists new columns/constraints and historical evidence across a real embedded-engine restart", async () => {
    await db.close();
    db = new PGlite(path.join(root, "db"));
    await db.waitReady;
    service = new WorkspaceService(postgresAdapter(db));
    expect(
      (
        await db.query('SELECT purpose FROM "WorkspaceRun" WHERE id=$1', [
          "v1-run",
        ])
      ).rows,
    ).toEqual([{ purpose: "IMPLEMENTATION" }]);
    expect((await rows()).documents).toEqual(before.documents);
    expect((await rows()).events).toEqual(before.events);
    expect((await rows()).operations).toEqual(before.operations);
    await expect(
      db.exec(`UPDATE "WorkspaceRun" SET purpose='UNKNOWN' WHERE id='v1-run'`),
    ).rejects.toThrow();
  });
  it("does not approve/authorize a requested baseline purpose or unknown purpose via existing services", async () => {
    for (const purpose of ["BASELINE_VALIDATION", "UNKNOWN"]) {
      await expect(
        service.approve("v1-project", "v1-owner", {
          purpose,
          architectureId: "v1-arch",
          architectureHash: "a".repeat(64),
          mainId: "v1-main",
          mainHash: "b".repeat(64),
          expectedVersion: 0,
        }),
      ).rejects.toThrow(
        purpose === "UNKNOWN"
          ? "WORKSPACE_PURPOSE_INVALID"
          : "VALIDATION_LIFECYCLE_UNAVAILABLE",
      );
      await expect(
        service.authorize("v1-project", "v1-owner", {
          purpose,
          approvalId: "v1-approval",
          unitIds: [],
          expectedVersion: 0,
          idempotencyKey: "new-baseline-run",
        }),
      ).rejects.toThrow();
    }
  });
  it("denies every existing implementation/publication evidence path for a persisted baseline run", async () => {
    await db.exec(`INSERT INTO "WorkspaceApproval"(id,"projectId","mainId","architectureId",snapshot,"createdBy",purpose) VALUES ('baseline-approval','v1-project','v1-main','v1-arch','{}','v1-owner','BASELINE_VALIDATION');
      INSERT INTO "WorkspaceRun"(id,"projectId","approvalId","idempotencyKey",authority,"createdBy",purpose) VALUES ('baseline-run','v1-project','baseline-approval','baseline-run-001','{}','v1-owner','BASELINE_VALIDATION');
      INSERT INTO "WorkspaceOperation"(id,"projectId","runId",kind,"idempotencyKey","stateVersion","inputHash",context,"createdBy") VALUES ('baseline-op','v1-project','baseline-run','VALIDATION','baseline-op-001',0,'input','{}','v1-owner'),('baseline-code','v1-project','baseline-run','CODE_PROPOSAL','baseline-code-001',0,'input','{}','v1-owner');`);
    const work = jest.fn();
    const calls = [
      () => service.assertRunnable("v1-project", "v1-owner", "baseline-run"),
      () =>
        service.executeWithAuthority(
          "v1-project",
          "v1-owner",
          "baseline-run",
          work,
        ),
      () =>
        service.record(
          "v1-project",
          "v1-owner",
          "baseline-run",
          "IMPLEMENTED",
          {},
        ),
      () =>
        service.review(
          "v1-project",
          "v1-owner",
          "baseline-run",
          "a".repeat(64),
        ),
      () =>
        service.retry("v1-project", "v1-owner", "baseline-run", {
          expectedVersion: 0,
          idempotencyKey: "retry-baseline-001",
        }),
      () =>
        service.beginRunOperation("v1-project", "v1-owner", "baseline-run", {
          kind: "VALIDATION",
          expectedVersion: 0,
          expectedChangeHash: "a".repeat(64),
          idempotencyKey: "dispatch-baseline-001",
        }),
      () =>
        service.finishRunOperation("v1-project", "v1-owner", "baseline-op", {}),
      () =>
        service.failRunOperation(
          "v1-project",
          "v1-owner",
          "baseline-op",
          "TEST_FAILED",
        ),
      () =>
        service.approvePublication("v1-project", "v1-owner", "baseline-run", {
          expectedVersion: 0,
          preparedEventId: "x",
          expectedBundleHash: "a".repeat(64),
        }),
      () =>
        service.completeOperation(
          "v1-project",
          "v1-owner",
          "baseline-code",
          {},
          {},
        ),
    ];
    calls.push(() =>
      service.startOperation("v1-project", "v1-owner", {
        kind: "CODE_PROPOSAL",
        runId: "baseline-run",
        expectedVersion: 0,
        instruction: "Denied",
        idempotencyKey: "denied-code-proposal",
      }),
    );
    for (const call of calls)
      await expect(call()).rejects.toThrow("VALIDATION_LIFECYCLE_UNAVAILABLE");
    expect(work).not.toHaveBeenCalled();
    expect(
      (
        await db.query('SELECT * FROM "WorkspaceEvent" WHERE "runId"=$1', [
          "baseline-run",
        ])
      ).rows,
    ).toEqual([]);
    expect(
      (
        await db.query('SELECT status FROM "WorkspaceOperation" WHERE id=$1', [
          "baseline-op",
        ])
      ).rows,
    ).toEqual([{ status: "RUNNING" }]);
  });
  it("stores schema2 as an exact linked draft but cannot approve it through implementation approval", async () => {
    await db.exec(`INSERT INTO projects(id,name,"userId","updatedAt") VALUES ('draft-project','Draft profile fixture','v1-owner',now());
      INSERT INTO project_repositories(id,"projectId",name,role,"githubUrl","updatedAt") VALUES ('draft-repo','draft-project','Reference','backend','https://github.com/example/reference',now());`);
    const mainContent = mainFromBrief("Read-only fixture");
    mainContent.questions = [];
    const main = await service.save("draft-project", "v1-owner", {
      kind: "MAIN",
      content: mainContent,
      expectedVersion: 0,
      reason: "Synthetic exact draft",
    });
    const limits = {
      totalTimeoutMs: 30000,
      memoryMiB: 512,
      workMiB: 256,
      tmpMiB: 64,
      stdoutBytes: 65536,
      stderrBytes: 65536,
    };
    const budget = { measurementHash: "b".repeat(64), limits };
    const content = {
      schemaVersion: 2,
      sourceMain: { id: main.id, hash: main.contentHash },
      overview: "Draft baseline profile",
      components: [{ id: "COMP-ONE", description: "Read only" }],
      dataMigrations: [],
      interfaces: [],
      security: ["No publication"],
      operations: ["Lifecycle unavailable"],
      repositories: [{ id: "draft-repo", baseline: "a".repeat(40) }],
      units: [],
      questions: [],
      validationProfiles: [
        {
          id: "VAL-ONE",
          title: "Read only",
          requirementIds: ["REQ-001"],
          criterionIds: ["AC-001"],
          repositoryId: "draft-repo",
          baseline: "a".repeat(40),
          runtimeProfileHash: "c".repeat(64),
          budgetProfile: { ...budget, hash: hash(budget) },
          commands: [
            {
              id: "CMD-ONE",
              criterionId: "AC-001",
              argv: ["node", "--test", "fixture.js"],
              cwd: ".",
              timeoutMs: 30000,
            },
          ],
        },
      ],
    };
    const arch = await service.save("draft-project", "v1-owner", {
      kind: "ARCHITECTURE",
      content,
      expectedVersion: 1,
      reason: "Store only",
    });
    expect(arch.contentHash).toBe(hash(content));
    expect(arch.sourceMainId).toBe(main.id);
    for (const purpose of [undefined, "IMPLEMENTATION", "BASELINE_VALIDATION"])
      await expect(
        service.approve("draft-project", "v1-owner", {
          purpose,
          architectureId: arch.id,
          architectureHash: arch.contentHash,
          mainId: main.id,
          mainHash: main.contentHash,
          expectedVersion: 2,
        }),
      ).rejects.toThrow("VALIDATION_LIFECYCLE_UNAVAILABLE");
    expect(
      (
        await db.query(
          'SELECT * FROM "WorkspaceApproval" WHERE "projectId"=$1',
          ["draft-project"],
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await db.query('SELECT * FROM "WorkspaceRun" WHERE "projectId"=$1', [
          "draft-project",
        ])
      ).rows,
    ).toEqual([]);
  });
});
