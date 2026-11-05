import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { PrismaClient } from "@prisma/client";
import {
  BaselineValidationService,
  baselinePlan,
  BaselineEvidenceStore,
} from "../baseline-validation-service";
import { hash, mainFromBrief } from "../document-contract";
import { baselineFixture, contractStore } from "./baseline-fixture";

describe("baseline authority lifecycle through real Prisma and isolated embedded Postgres", () => {
  let engine: PGlite,
    server: PGLiteSocketServer,
    db: PrismaClient,
    root: string;
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "anka-baseline-v2-"));
    engine = new PGlite(path.join(root, "db"));
    const migrations = path.resolve(__dirname, "../../../prisma/migrations"),
      v2 = "20261102200000_baseline_validation_lifecycle";
    for (const name of fs.readdirSync(migrations).sort()) {
      const f = path.join(migrations, name, "migration.sql");
      if (name < v2 && fs.existsSync(f))
        await engine.exec(fs.readFileSync(f, "utf8"));
    }
    await engine.exec(`INSERT INTO users(id,email,password,"updatedAt") VALUES ('v2-legacy-owner','v2-legacy@example.test','synthetic',now());
      INSERT INTO projects(id,name,"userId","updatedAt") VALUES ('v2-legacy-project','Preserve legacy authority','v2-legacy-owner',now());
      INSERT INTO "WorkspaceDocument"(id,"projectId",kind,version,"contentHash",content,"createdBy") VALUES ('v2-old-main','v2-legacy-project','MAIN',1,'preserve-main','{"old":"main"}','v2-legacy-owner'),('v2-old-arch','v2-legacy-project','ARCHITECTURE',1,'preserve-arch','{"old":"arch"}','v2-legacy-owner');
      INSERT INTO "WorkspaceApproval"(id,"projectId","mainId","architectureId",snapshot,"createdBy") VALUES ('v2-old-approval','v2-legacy-project','v2-old-main','v2-old-arch','{"old":"snapshot"}','v2-legacy-owner');
      INSERT INTO "WorkspaceRun"(id,"projectId","approvalId","idempotencyKey",authority,"createdBy") VALUES ('v2-old-run','v2-legacy-project','v2-old-approval','preserve-old-run','{"old":"authority"}','v2-legacy-owner');
      INSERT INTO "WorkspaceHead"("projectId","mainId","architectureId","approvalId","stateVersion") VALUES ('v2-legacy-project','v2-old-main','v2-old-arch','v2-old-approval',9);
      INSERT INTO "WorkspaceEvent"(id,"projectId","runId",kind,payload,"createdBy") VALUES ('v2-old-event','v2-legacy-project','v2-old-run','RUN_AUTHORIZED','{"old":"event"}','v2-legacy-owner');
      INSERT INTO "WorkspaceOperation"(id,"projectId","runId",kind,"idempotencyKey","stateVersion","inputHash",context,"createdBy",status,result) VALUES ('v2-old-op','v2-legacy-project','v2-old-run','VALIDATION','preserve-old-op',9,'old-input','{"old":"context"}','v2-legacy-owner','COMPLETED','{"old":"result"}');`);
    await engine.exec(
      fs.readFileSync(path.join(migrations, v2, "migration.sql"), "utf8"),
    );
    server = new PGLiteSocketServer({
      db: engine,
      port: 0,
      host: "127.0.0.1",
      maxConnections: 1,
    });
    await server.start();
    db = new PrismaClient({
      datasources: {
        db: {
          url:
            "postgresql://postgres:postgres@" +
            server.getServerConn() +
            "/postgres?schema=public&connection_limit=1&sslmode=disable",
        },
      },
    });
  }, 120000);
  afterAll(async () => {
    await db?.$disconnect();
    await server?.stop();
    await engine?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });
  const claim = async () => {
    const f = await baselineFixture(db),
      c = await f.baseline.claim(f.project, f.actor, f.claimInput);
    return { ...f, op: c.operation };
  };
  it("keeps an exact separate baseline approval pointer, bindings and no execution authority", async () => {
    const f = await baselineFixture(db),
      head = await db.workspaceHead.findUniqueOrThrow({
        where: { projectId: f.project },
      });
    expect(head.approvalId).toBeNull();
    expect(head.baselineApprovalId).toBe(f.approval.id);
    expect(f.approval.purpose).toBe("BASELINE_VALIDATION");
    expect(f.run.purpose).toBe("BASELINE_VALIDATION");
    expect((f.run.authority as any).bindingHash).toBe(f.preview.bindingHash);
    expect((f.run.authority as any).planHash).toBe(f.preview.planHash);
    expect(f.preview.dispatchAvailable).toBe(false);
  });
  it("enforces current active owner and project binding on every public baseline action", async () => {
    const f = await claim();
    const calls = [
      () => f.baseline.preview(f.project, "other", f.selection),
      () => f.baseline.approve(f.project, "other", f.approvalInput),
      () => f.baseline.authorize(f.project, "other", f.runInput),
      () => f.baseline.claim(f.project, "other", f.claimInput),
      () => f.baseline.view(f.project, "other"),
      () => f.baseline.dispatch(f.project, "other", f.op.id),
      () => f.baseline.requestCleanup(f.project, "other", f.op.id),
    ];
    for (const call of calls)
      await expect(call()).rejects.toThrow("PROJECT_RESOURCE_NOT_FOUND");
    await expect(
      f.baseline.dispatch("other-project", f.actor, f.op.id),
    ).rejects.toThrow("PROJECT_RESOURCE_NOT_FOUND");
    await db.user.update({
      where: { id: f.actor },
      data: { status: "disabled" },
    });
    await expect(f.baseline.view(f.project, f.actor)).rejects.toThrow(
      "PROJECT_RESOURCE_NOT_FOUND",
    );
  });
  it("reuses exact approval/authorization/claim requests but not a changed idempotent input", async () => {
    const f = await claim();
    expect(
      (await f.baseline.approve(f.project, f.actor, f.approvalInput)).id,
    ).toBe(f.approval.id);
    expect(
      (await f.baseline.authorize(f.project, f.actor, f.runInput)).id,
    ).toBe(f.run.id);
    const reused = await f.baseline.claim(f.project, f.actor, f.claimInput);
    expect(reused.reused).toBe(true);
    expect(reused.operation.id).toBe(f.op.id);
    await expect(
      f.baseline.approve(f.project, f.actor, {
        ...f.approvalInput,
        expectedVersion: 5,
      }),
    ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
    await expect(
      f.baseline.authorize(f.project, f.actor, {
        ...f.runInput,
        expectedVersion: 5,
      }),
    ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
    await expect(
      f.baseline.claim(f.project, f.actor, {
        ...f.claimInput,
        expectedVersion: 5,
      }),
    ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
    expect(
      await db.baselineValidationOperation.count({
        where: { projectId: f.project },
      }),
    ).toBe(1);
    expect(
      await db.workspaceEvent.count({
        where: { projectId: f.project, kind: "BASELINE_VALIDATION_PREPARING" },
      }),
    ).toBe(1);
  });
  it("rejects stale CAS and a second key claiming the same run without an additional operation", async () => {
    const f = await baselineFixture(db);
    await expect(
      f.baseline.claim(f.project, f.actor, {
        ...f.claimInput,
        expectedVersion: 3,
      }),
    ).rejects.toThrow("STATE_CONFLICT");
    expect(
      await db.baselineValidationOperation.count({
        where: { projectId: f.project },
      }),
    ).toBe(0);
    await f.baseline.claim(f.project, f.actor, f.claimInput);
    await expect(
      f.baseline.claim(f.project, f.actor, {
        ...f.claimInput,
        idempotencyKey: "another-claim-001",
      }),
    ).rejects.toThrow("BASELINE_OPERATION_ALREADY_CLAIMED");
  });
  it.each(["expectedBindingHash", "expectedPlanHash"] as const)(
    "rejects tampered %s",
    async (key) => {
      const f = await baselineFixture(db);
      await expect(
        f.baseline.claim(f.project, f.actor, {
          ...f.claimInput,
          [key]: "f".repeat(64),
        }),
      ).rejects.toThrow("BASELINE_BINDING_MISMATCH");
    },
  );
  it("rejects caller-supplied result/runtime/measurement fields even with matching digests", async () => {
    const f = await baselineFixture(db);
    await expect(
      f.baseline.claim(f.project, f.actor, {
        ...f.claimInput,
        result: { passed: true },
      } as any),
    ).rejects.toThrow("BASELINE_INPUT_INVALID");
    await expect(
      f.baseline.approve(f.project, f.actor, {
        ...f.approvalInput,
        runtimeAcceptanceVerified: true,
      } as any),
    ).rejects.toThrow("BASELINE_INPUT_INVALID");
  });
  it("does not treat a matching digest as trusted runtime evidence or dispatch permission", async () => {
    const f = await claim();
    await expect(
      f.baseline.dispatch(f.project, f.actor, f.op.id),
    ).rejects.toThrow("BASELINE_RUNTIME_UNAVAILABLE");
    await expect(
      f.baseline.recordStarted(f.project, f.op.id, f.preview.bindingHash),
    ).rejects.toThrow("TRUSTED_BASELINE_EVIDENCE_REQUIRED");
    expect(
      (
        await db.baselineValidationOperation.findUniqueOrThrow({
          where: { id: f.op.id },
        })
      ).status,
    ).toBe("PREPARING");
  });
  it("requires actual runtime/measurement acceptance in trusted dynamic evidence, not merely matching strings", async () => {
    const f = await claim(),
      fixture = contractStore();
    const service = new BaselineValidationService(db, {
      ...fixture,
      admission: async (op) => ({
        ...(await fixture.admission(op, "contract-start")!),
        evidenceClass: "DYNAMIC_ISOLATED_COMMAND_CHECKS",
      }),
    } as BaselineEvidenceStore);
    await expect(
      service.recordStarted(f.project, f.op.id, "anything"),
    ).rejects.toThrow("TRUSTED_BASELINE_EVIDENCE_REQUIRED");
  });
  it("retains contract evidence honestly and requires durable exact-job cleanup before terminal status", async () => {
    const f = await claim(),
      worker = new BaselineValidationService(db, contractStore());
    await worker.recordStarted(f.project, f.op.id, "contract-start");
    await worker.recordResult(f.project, f.op.id, "contract-result");
    expect(
      (
        await db.baselineValidationOperation.findUniqueOrThrow({
          where: { id: f.op.id },
        })
      ).status,
    ).toBe("CLEANUP_REQUIRED");
    await expect(
      worker.confirmCleanup(f.project, f.op.id, "wrong"),
    ).rejects.toThrow("BASELINE_CLEANUP_UNCONFIRMED");
    await worker.confirmCleanup(f.project, f.op.id, "contract-cleanup");
    const op = await db.baselineValidationOperation.findUniqueOrThrow({
      where: { id: f.op.id },
    });
    expect(op.status).toBe("COMPLETED");
    expect((op.result as any).outcome).toBe("CONTRACT_TEST_PASSED");
    expect((op.result as any).acceptedForCurrentAuthority).toBe(false);
    expect(
      await db.workspaceEvent.count({
        where: {
          runId: f.run.id,
          kind: {
            in: [
              "IMPLEMENTED",
              "SANDBOX_VALIDATED",
              "REVIEW_VERIFIED",
              "PUBLICATION_PREPARED",
              "PUBLICATION_APPROVED",
              "PUBLISHED",
            ],
          },
        },
      }),
    ).toBe(0);
  });
  it("requires ordered qualified command identity and rejects missing/duplicate/foreign result entries", async () => {
    const f = await claim(),
      fixture = contractStore();
    for (const variant of ["missing", "duplicate", "profile", "criterion"]) {
      const service = new BaselineValidationService(db, {
        ...fixture,
        execution: async (op) => {
          const r = await fixture.execution(op, "contract-result");
          if (!r) throw Error("fixture");
          if (variant === "missing") r.results = [];
          if (variant === "duplicate") r.results.push(r.results[0]);
          if (variant === "profile") r.results[0].profileId = "VAL-OTHER";
          if (variant === "criterion") r.results[0].criterionId = "AC-OTHER";
          return r;
        },
      });
      if (variant === "missing")
        await service.recordStarted(f.project, f.op.id, "contract-start");
      await expect(
        service.recordResult(f.project, f.op.id, "x"),
      ).rejects.toThrow("BASELINE_RESULT_INVALID");
    }
  });
  it("latches a revoked result as stale even if the owner becomes active again before cleanup", async () => {
    const f = await claim(),
      worker = new BaselineValidationService(db, contractStore());
    await worker.recordStarted(f.project, f.op.id, "contract-start");
    await db.user.update({
      where: { id: f.actor },
      data: { status: "disabled" },
    });
    await worker.recordResult(f.project, f.op.id, "contract-result");
    await db.user.update({
      where: { id: f.actor },
      data: { status: "active" },
    });
    await worker.confirmCleanup(f.project, f.op.id, "contract-cleanup");
    const op = await db.baselineValidationOperation.findUniqueOrThrow({
      where: { id: f.op.id },
    });
    expect(op.status).toBe("CONFLICTED");
    expect((op.result as any).acceptedForCurrentAuthority).toBe(false);
  });
  it.each(["document", "repository", "pointer"] as const)(
    "retains late results as conflicted after %s drift",
    async (kind) => {
      const f = await claim(),
        worker = new BaselineValidationService(db, contractStore());
      await worker.recordStarted(f.project, f.op.id, "contract-start");
      if (kind === "document") {
        const m = mainFromBrief("Changed scope");
        m.questions = [];
        await f.workspace.save(f.project, f.actor, {
          kind: "MAIN",
          content: m,
          expectedVersion: 5,
          reason: "Invalidates pending baseline",
        });
      }
      if (kind === "repository")
        await db.projectRepository.update({
          where: { id: f.repo.id },
          data: { currentIndexedCommit: "e".repeat(40) },
        });
      if (kind === "pointer")
        await db.workspaceHead.update({
          where: { projectId: f.project },
          data: { baselineApprovalId: null, stateVersion: { increment: 1 } },
        });
      await worker.recordResult(f.project, f.op.id, "contract-result");
      await worker.confirmCleanup(f.project, f.op.id, "contract-cleanup");
      expect(
        (
          await db.baselineValidationOperation.findUniqueOrThrow({
            where: { id: f.op.id },
          })
        ).status,
      ).toBe("CONFLICTED");
    },
  );
  it("requires exact job cleanup and fresh successor authority after interruption, preserving the parent", async () => {
    const f = await claim();
    await f.baseline.requestCleanup(f.project, f.actor, f.op.id);
    await expect(
      f.baseline.authorize(f.project, f.actor, {
        ...f.runInput,
        expectedVersion: 5,
        idempotencyKey: "retry-before-cleanup",
        retryOfOperationId: f.op.id,
      }),
    ).rejects.toThrow("BASELINE_CLEANUP_REQUIRED");
    const worker = new BaselineValidationService(db, contractStore());
    await worker.confirmCleanup(f.project, f.op.id, "contract-cleanup");
    const run = await f.baseline.authorize(f.project, f.actor, {
      ...f.runInput,
      expectedVersion: 5,
      idempotencyKey: "retry-after-cleanup",
      retryOfOperationId: f.op.id,
    });
    expect((run.authority as any).retryOfOperationId).toBe(f.op.id);
    expect(
      (
        await db.baselineValidationOperation.findUniqueOrThrow({
          where: { id: f.op.id },
        })
      ).status,
    ).toBe("FAILED");
  });
  it('blocks new run keys that omit a cleanup-required predecessor', async () => {
    const f = await claim();
    for (const retryOfOperationId of [null, f.op.id]) {
      await expect(f.baseline.authorize(f.project, f.actor, {...f.runInput, expectedVersion:5, idempotencyKey:'fresh-key-'+String(retryOfOperationId), retryOfOperationId})).rejects.toThrow('BASELINE_CLEANUP_REQUIRED');
    }
    await f.baseline.requestCleanup(f.project,f.actor,f.op.id);
    await expect(f.baseline.authorize(f.project,f.actor,{...f.runInput,expectedVersion:5,idempotencyKey:'omit-parent-cleanup',retryOfOperationId:null})).rejects.toThrow('BASELINE_CLEANUP_REQUIRED');
    await new BaselineValidationService(db,contractStore()).confirmCleanup(f.project,f.op.id,'contract-cleanup');
    await expect(f.baseline.authorize(f.project,f.actor,{...f.runInput,expectedVersion:5,idempotencyKey:'omit-terminal-parent',retryOfOperationId:null})).rejects.toThrow('BASELINE_RETRY_LINK_REQUIRED');
  });
  it('blocks claiming an earlier authorized second run while any project job is outstanding', async () => {
    const f=await baselineFixture(db);
    const second=await f.baseline.authorize(f.project,f.actor,{...f.runInput,expectedVersion:4,idempotencyKey:'preauthorized-second'});
    await f.baseline.claim(f.project,f.actor,{...f.claimInput,expectedVersion:5});
    await expect(f.baseline.claim(f.project,f.actor,{...f.claimInput,runId:second.id,expectedVersion:6,idempotencyKey:'claim-second-run'})).rejects.toThrow('BASELINE_CLEANUP_REQUIRED');
  });
  it('does not admit a typed dynamic receipt with asserted acceptance booleans', async () => {
    const f=await claim(),store=contractStore();
    const worker=new BaselineValidationService(db,{...store,admission:async(op,id)=>{const r=await store.admission(op,id);return r?{...r,evidenceClass:'DYNAMIC_ISOLATED_COMMAND_CHECKS',profiles:r.profiles.map(p=>({...p,runtimeAcceptanceVerified:true,measurementAcceptanceVerified:true}))}:null;}});
    await expect(worker.recordStarted(f.project,f.op.id,'contract-start')).rejects.toThrow('BASELINE_RUNTIME_UNAVAILABLE');
    expect((await db.baselineValidationOperation.findUniqueOrThrow({where:{id:f.op.id}})).status).toBe('PREPARING');
  });
  it("enforces baseline pointer scope/purpose and immutable operation transition rules in SQL", async () => {
    const f = await claim(),
      other = await baselineFixture(db);
    await expect(
      db.workspaceHead.update({
        where: { projectId: other.project },
        data: { baselineApprovalId: f.approval.id },
      }),
    ).rejects.toThrow();
    await expect(
      db.baselineValidationOperation.update({
        where: { id: f.op.id },
        data: { authority: { forged: true } },
      }),
    ).rejects.toThrow("immutable");
    await expect(
      db.baselineValidationOperation.update({
        where: { id: f.op.id },
        data: { status: "COMPLETED" },
      }),
    ).rejects.toThrow("transition denied");
    await expect(
      db.baselineValidationOperation.delete({ where: { id: f.op.id } }),
    ).rejects.toThrow("immutable");
  });
  it("keeps aggregate reservations bounded and repeated command IDs unambiguous across selected profiles", async () => {
    const f = await baselineFixture(db),
      binding = JSON.parse(JSON.stringify(f.preview.binding));
    binding.profiles.push({ ...binding.profiles[0], id: "VAL-TWO" });
    const plan = baselinePlan(binding);
    expect(plan.commands.map((c) => [c.profileId, c.id])).toEqual([
      ["VAL-ONE", "CMD-ONE"],
      ["VAL-TWO", "CMD-ONE"],
    ]);
    expect(plan.limits.totalTimeoutMs).toBe(60000);
    binding.profiles[1].budgetProfile.limits.totalTimeoutMs = 120000;
    expect(() => baselinePlan(binding)).toThrow("COMMAND_BUDGET_EXCEEDED");
    binding.profiles[1].budgetProfile.limits.totalTimeoutMs = 30000;
    binding.profiles[1].runtimeProfileHash = "e".repeat(64);
    expect(() => baselinePlan(binding)).toThrow(
      "BASELINE_RUNTIME_PROFILE_CONFLICT",
    );
  });
  it("keeps all implementation/publication alternate entries closed to a V2 baseline run", async () => {
    const f = await claim(),
      calls = [
        () => f.workspace.assertRunnable(f.project, f.actor, f.run.id),
        () =>
          f.workspace.record(f.project, f.actor, f.run.id, "IMPLEMENTED", {}),
        () =>
          f.workspace.executeWithAuthority(
            f.project,
            f.actor,
            f.run.id,
            async () => ({}),
          ),
        () => f.workspace.review(f.project, f.actor, f.run.id, "a".repeat(64)),
        () =>
          f.workspace.startOperation(f.project, f.actor, {
            kind: "CODE_PROPOSAL",
            runId: f.run.id,
            expectedVersion: 5,
            idempotencyKey: "illegal-code-001",
            instruction: "Forbidden",
          }),
        () =>
          f.workspace.approvePublication(f.project, f.actor, f.run.id, {
            expectedVersion: 5,
            preparedEventId: "bad",
            expectedBundleHash: "a".repeat(64),
          }),
      ];
    for (const call of calls)
      await expect(call()).rejects.toThrow("VALIDATION_LIFECYCLE_UNAVAILABLE");
  });
  it("preserves the old implementation pointer, purpose and immutable evidence through the additive V2 migration", async () => {
    const head = await db.workspaceHead.findUniqueOrThrow({
      where: { projectId: "v2-legacy-project" },
    });
    expect(head.approvalId).toBe("v2-old-approval");
    expect(head.stateVersion).toBe(9);
    expect(head.baselineApprovalId).toBeNull();
    const approval = await db.workspaceApproval.findUniqueOrThrow({
        where: { id: "v2-old-approval" },
      }),
      run = await db.workspaceRun.findUniqueOrThrow({
        where: { id: "v2-old-run" },
      });
    expect(approval.purpose).toBe("IMPLEMENTATION");
    expect(approval.snapshot).toEqual({ old: "snapshot" });
    expect(approval.baselineRequestKey).toBeNull();
    expect(run.authority).toEqual({ old: "authority" });
    expect(
      (
        await db.workspaceEvent.findUniqueOrThrow({
          where: { id: "v2-old-event" },
        })
      ).payload,
    ).toEqual({ old: "event" });
    expect(
      (
        await db.workspaceOperation.findUniqueOrThrow({
          where: { id: "v2-old-op" },
        })
      ).context,
    ).toEqual({ old: "context" });
    await expect(
      db.workspaceHead.update({
        where: { projectId: "v2-legacy-project" },
        data: { baselineApprovalId: "v2-old-approval" },
      }),
    ).rejects.toThrow();
  });
  it("keeps completed evidence historical and projects current freshness after a later revision", async () => {
    const f = await claim(),
      worker = new BaselineValidationService(db, contractStore());
    await worker.recordStarted(f.project, f.op.id, "contract-start");
    await worker.recordResult(f.project, f.op.id, "contract-result");
    await worker.confirmCleanup(f.project, f.op.id, "contract-cleanup");
    const m = mainFromBrief("Later revision");
    m.questions = [];
    await f.workspace.save(f.project, f.actor, {
      kind: "MAIN",
      content: m,
      expectedVersion: 5,
      reason: "Invalidate current projection",
    });
    const view = await f.baseline.view(f.project, f.actor);
    expect(view.operations[0].authorityCurrent).toBe(false);
    expect(view.operations[0].result?.acceptedForCurrentAuthority).toBe(false);
    expect(
      (
        await db.baselineValidationOperation.findUniqueOrThrow({
          where: { id: f.op.id },
        })
      ).status,
    ).toBe("COMPLETED");
  });
  it("persists cleanup-required operation identity, authority and history across engine restart", async () => {
    const f = await claim();
    await f.baseline.requestCleanup(f.project, f.actor, f.op.id);
    const old = await db.baselineValidationOperation.findUniqueOrThrow({
      where: { id: f.op.id },
    });
    await db.$disconnect();
    await server.stop();
    await engine.close();
    engine = new PGlite(path.join(root, "db"));
    await engine.waitReady;
    server = new PGLiteSocketServer({
      db: engine,
      port: 0,
      host: "127.0.0.1",
      maxConnections: 1,
    });
    await server.start();
    db = new PrismaClient({
      datasources: {
        db: {
          url:
            "postgresql://postgres:postgres@" +
            server.getServerConn() +
            "/postgres?schema=public&connection_limit=1&sslmode=disable",
        },
      },
    });
    expect(
      await db.baselineValidationOperation.findUniqueOrThrow({
        where: { id: f.op.id },
      }),
    ).toEqual(old);
    await new BaselineValidationService(db, contractStore()).confirmCleanup(
      f.project,
      f.op.id,
      "contract-cleanup",
    );
    expect(
      (
        await db.baselineValidationOperation.findUniqueOrThrow({
          where: { id: f.op.id },
        })
      ).status,
    ).toBe("FAILED");
    expect(
      (
        await db.workspaceApproval.findUniqueOrThrow({
          where: { id: "v2-old-approval" },
        })
      ).snapshot,
    ).toEqual({ old: "snapshot" });
  });
  it("native race harness refuses missing opt-in and non-synthetic destinations before any application datasource use", () => {
    const script = path.resolve(
        __dirname,
        "../../../scripts/test-baseline-native-postgres.cjs",
      ),
      base = {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        DATABASE_URL: "postgresql://do-not-use.invalid/production",
      };
    for (const extra of [
      {},
      {
        ANKA_LOCAL_REHEARSAL: "1",
        ANKA_REHEARSAL_DATABASE_URL:
          "postgresql://anka_rehearsal:synthetic@not-loopback/anka_rehearsal",
      },
    ]) {
      try {
        execFileSync(process.execPath, [script], {
          env: { ...base, ...extra },
          stdio: "pipe",
          timeout: 10000,
        });
        throw Error("Harness should refuse");
      } catch (e: any) {
        expect(e.status).toBe(1);
        expect(String(e.stderr)).toMatch(
          /Explicit local rehearsal|Only synthetic loopback/,
        );
      }
    }
  });
  it("allows the new current owner to request cleanup without attributing the request to the former owner", async () => {
    const f = await claim(),
      next = f.actor + "-next";
    await db.user.create({
      data: { id: next, email: next + "@example.test", password: "synthetic" },
    });
    await db.project.update({
      where: { id: f.project },
      data: { userId: next },
    });
    await f.baseline.requestCleanup(f.project, next, f.op.id);
    const event = await db.workspaceEvent.findFirstOrThrow({
      where: { runId: f.run.id, kind: "BASELINE_VALIDATION_CLEANUP_REQUIRED" },
    });
    expect(event.createdBy).toBe(next);
    expect((event.payload as any).origin).toBe("OWNER_REQUEST");
    await new BaselineValidationService(db, contractStore()).confirmCleanup(
      f.project,
      f.op.id,
      "contract-cleanup",
    );
    expect(
      (
        await db.baselineValidationOperation.findUniqueOrThrow({
          where: { id: f.op.id },
        })
      ).status,
    ).toBe("CONFLICTED");
  });
});
