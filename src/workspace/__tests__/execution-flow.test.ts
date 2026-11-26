import { WorkspaceGenerationService } from "../generation-service";
import { FixtureWorkspaceProvider } from "./fixture-provider";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { execFileSync } from "child_process";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { PrismaClient } from "@prisma/client";
import { WorkspaceService } from "../workspace-service";
import { DocumentExecutor } from "../document-executor";
import { WorkspaceExecutionService } from "../workspace-execution-service";
import { SandboxAdapter, SandboxRequest } from "../sandbox";
import { PublicationAdapter, PublicationTarget } from "../publication";
import {
  hash,
  mainFromBrief,
  ArchitectureDocument,
} from "../document-contract";

const root = path.resolve(
  __dirname,
  "../../../../../work/rehearsal/execution-" + randomUUID(),
);
const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Synthetic",
      "-c",
      "user.email=synthetic@example.test",
      ...args,
    ],
    { cwd, encoding: "utf8" },
  ).trim();
class FakeSandbox implements SandboxAdapter {
  available = true;
  exitCode = 0;
  calls = 0;
  seen: string[][] = [];
  barrier?: () => Promise<void>;
  async ready() {
    return this.available;
  }
  async cleanup() {}
  async run(directory: string, request: SandboxRequest) {
    this.calls++;
    this.seen.push(fs.readdirSync(directory));
    if (this.barrier) await this.barrier();
    return {
      evidenceClass: "CONTRACT_TEST" as const,
      imageId: "synthetic-image",
      runtime: "synthetic",
      inputHash: request.inputHash,
      commandsHash: hash(request.commands),
      results: request.commands.map((c) => ({
        id: c.id,
        unitId: c.unitId,
        criterionId: c.criterionId,
        exitCode: this.exitCode,
        timedOut: false,
        stdout: "synthetic contract result",
        stderr: "",
      })),
      passed: this.exitCode === 0,
    };
  }
}
class FakePublisher implements PublicationAdapter {
  readonly evidenceClass = "CONTRACT_TEST" as const;
  calls: PublicationTarget[] = [];
  observed = new Map<string, string>();
  failAt = 0;
  lookups = 0;
  available() {
    return true;
  }
  async publish(_p: string, _a: string, _w: string, target: PublicationTarget) {
    this.calls.push(target);
    if (this.failAt === this.calls.length)
      throw new Error("synthetic transport interruption");
    this.observed.set(target.repositoryId, target.head);
    return {
      repositoryId: target.repositoryId,
      branch: target.branch,
      head: target.head,
      status: "CREATED" as const,
      url: "https://example.test/synthetic",
    };
  }
  async lookup(_p: string, _a: string, target: PublicationTarget) {
    this.lookups++;
    return this.observed.get(target.repositoryId) || null;
  }
}
describe("exact document execution and separate publication authority through native Prisma", () => {
  let db: PGlite,
    server: PGLiteSocketServer,
    prisma: PrismaClient,
    service: WorkspaceService;
  beforeAll(async () => {
    fs.mkdirSync(root, { recursive: true });
    db = new PGlite();
    const migrations = path.resolve(__dirname, "../../../prisma/migrations");
    for (const name of fs.readdirSync(migrations).sort()) {
      const file = path.join(migrations, name, "migration.sql");
      if (fs.existsSync(file)) await db.exec(fs.readFileSync(file, "utf8"));
    }
    server = new PGLiteSocketServer({
      db,
      host: "127.0.0.1",
      port: 0,
      maxConnections: 1,
    });
    await server.start();
    prisma = new PrismaClient({
      datasources: {
        db: {
          url:
            "postgresql://postgres:postgres@" +
            server.getServerConn() +
            "/postgres?schema=public&connection_limit=1&sslmode=disable",
        },
      },
    });
    await prisma.user.create({
      data: {
        id: "owner",
        email: "execution-owner@example.test",
        password: "synthetic",
      },
    });
    await prisma.user.create({
      data: {
        id: "other",
        email: "execution-other@example.test",
        password: "synthetic",
      },
    });
    service = new WorkspaceService(prisma);
  }, 120000);
  afterAll(async () => {
    await prisma?.$disconnect();
    await server?.stop();
    await db?.close();
  });
  async function setup(count = 1) {
    const projectId = randomUUID(),
      area = path.join(root, projectId),
      policy = {
        repositoryRoot: path.join(area, "repositories"),
        runsRoot: path.join(area, "runs"),
      };
    await prisma.project.create({
      data: { id: projectId, name: "Synthetic execution", userId: "owner" },
    });
    const repositories = [],
      units = [],
      bindings = [];
    for (let i = 0; i < count; i++) {
      const id = randomUUID(),
        repo = path.join(policy.repositoryRoot, String(i));
      fs.mkdirSync(repo, { recursive: true });
      git(repo, "init", "-b", "main");
      fs.writeFileSync(path.join(repo, "README.md"), "original\n");
      fs.writeFileSync(path.join(repo, ".gitignore"), "approved.txt\n");
      fs.writeFileSync(path.join(repo, ".env"), "SYNTHETIC_SECRET=excluded\n");
      git(repo, "add", ".");
      git(repo, "commit", "-m", "Synthetic baseline");
      const baseline = git(repo, "rev-parse", "HEAD");
      await prisma.projectRepository.create({
        data: {
          id,
          projectId,
          name: "Synthetic " + i,
          role: "primary",
          githubUrl: "https://github.com/synthetic/repo-" + i,
          defaultBranch: "main",
          localPath: repo,
        },
      });
      repositories.push({ id, baseline });
      bindings.push({ id, localPath: repo });
      units.push({
        id: "UNIT-NOTE-" + i,
        title: "Approved note",
        requirementIds: ["REQ-001"],
        dependsOn: [],
        repositoryId: id,
        files: [{ path: "approved.txt", action: "create" as const }],
        checks: [
          {
            id: "CHECK-NOTE-" + i,
            criterionId: "AC-001",
            type: "contains" as const,
            path: "approved.txt",
            expected: "approved",
          },
        ],
        commands: [
          {
            id: "CMD-TEST-" + i,
            criterionId: "AC-001",
            argv: ["node", "-e", "process.exit(0)"],
            cwd: ".",
            timeoutMs: 1000,
          },
        ],
      });
    }
    const content = mainFromBrief("Maintain an approved note");
    content.questions = [];
    const main = await service.save(projectId, "owner", {
      kind: "MAIN",
      content,
      expectedVersion: 0,
      reason: "Synthetic resolved Main",
    });
    const architecture: ArchitectureDocument = {
      schemaVersion: 1,
      sourceMain: { id: main.id, hash: main.contentHash },
      overview: "Bounded implementation",
      components: [{ id: "COMP-NOTE", description: "Project notes" }],
      dataMigrations: [],
      interfaces: [],
      security: ["Isolated commands only"],
      operations: ["Separate publication approval"],
      repositories,
      units,
      questions: [],
    };
    const arch = await service.save(projectId, "owner", {
      kind: "ARCHITECTURE",
      content: architecture,
      expectedVersion: 1,
      reason: "Synthetic bounded architecture",
    });
    const approval = await service.approve(projectId, "owner", {
      mainId: main.id,
      mainHash: main.contentHash,
      architectureId: arch.id,
      architectureHash: arch.contentHash,
      expectedVersion: 2,
    });
    const run = await service.authorize(projectId, "owner", {
      approvalId: approval.id,
      unitIds: units.map((u) => u.id),
      expectedVersion: 3,
      idempotencyKey: "synthetic-run-" + randomUUID(),
    });
    const executor = new DocumentExecutor(service, policy);
    const implemented = await executor.execute(
      projectId,
      "owner",
      run.id,
      bindings.map((b) => ({
        repositoryId: b.id,
        path: "approved.txt",
        action: "create" as const,
        beforeHash: null,
        content: "approved\n",
      })),
      bindings,
    );
    const sandbox = new FakeSandbox(),
      publisher = new FakePublisher(),
      execution = new WorkspaceExecutionService(
        prisma,
        service,
        policy,
        sandbox,
        publisher,
      );
    const input = {
      expectedVersion: 3,
      expectedChangeHash: implemented.changeHash,
      idempotencyKey: "operation-" + randomUUID(),
    };
    return {
      projectId,
      run,
      main,
      architecture,
      policy,
      bindings,
      implemented,
      sandbox,
      publisher,
      execution,
      input,
    };
  }
  async function reviewed(c: Awaited<ReturnType<typeof setup>>) {
    await c.execution.validate(c.projectId, "owner", c.run.id, c.input);
    return service.review(
      c.projectId,
      "owner",
      c.run.id,
      c.implemented.changeHash,
    );
  }
  async function prepared(c: Awaited<ReturnType<typeof setup>>) {
    await reviewed(c);
    const op = await c.execution.preparePublication(
      c.projectId,
      "owner",
      c.run.id,
      { ...c.input, idempotencyKey: "prepare-" + randomUUID() },
    );
    return {
      eventId: (op.result as any).eventId,
      bundle: (op.result as any).output,
    };
  }
  test("does not review command-bearing units before validation or claim work without an engine", async () => {
    const c = await setup();
    await expect(
      service.review(c.projectId, "owner", c.run.id, c.implemented.changeHash),
    ).rejects.toMatchObject({ code: "ISOLATED_VALIDATION_REQUIRED" });
    c.sandbox.available = false;
    await expect(
      c.execution.validate(c.projectId, "owner", c.run.id, c.input),
    ).rejects.toMatchObject({ code: "ISOLATED_RUNTIME_UNAVAILABLE" });
    expect(
      await prisma.workspaceOperation.count({ where: { runId: c.run.id } }),
    ).toBe(0);
    expect(c.sandbox.calls).toBe(0);
  }, 30000);
  test("retains ignored approved files in exact diff, excludes secrets and records contract evidence honestly", async () => {
    const c = await setup();
    expect(c.implemented.diffs[0].diff).toContain("+approved");
    const op = await c.execution.validate(
      c.projectId,
      "owner",
      c.run.id,
      c.input,
    );
    expect(op.status).toBe("COMPLETED");
    expect((op.result as any).output).toMatchObject({
      passed: true,
      evidenceClass: "CONTRACT_TEST",
    });
    expect(c.sandbox.seen[0]).toContain("approved.txt");
    expect(c.sandbox.seen[0]).not.toContain(".env");
    expect(c.sandbox.seen[0]).not.toContain(".git");
    expect(
      (await c.execution.validate(c.projectId, "owner", c.run.id, c.input)).id,
    ).toBe(op.id);
    expect(c.sandbox.calls).toBe(1);
    const review = await service.review(
      c.projectId,
      "owner",
      c.run.id,
      c.implemented.changeHash,
    );
    expect((review.payload as any).evidenceClass).toBe("CONTRACT_TEST");
    expect(
      fs.existsSync(path.join(c.bindings[0].localPath, "approved.txt")),
    ).toBe(false);
  }, 30000);
  test("failed commands retain scope and evidence in an explicit repair successor", async () => {
    const c = await setup();
    c.sandbox.exitCode = 1;
    await c.execution.validate(c.projectId, "owner", c.run.id, c.input);
    await expect(
      service.review(c.projectId, "owner", c.run.id, c.implemented.changeHash),
    ).rejects.toMatchObject({ code: "ISOLATED_VALIDATION_REQUIRED" });
    const retry = await service.retry(c.projectId, "owner", c.run.id, {
      expectedVersion: 3,
      idempotencyKey: "repair-" + randomUUID(),
    });
    expect(retry.authority).toMatchObject({
      retryOfRunId: c.run.id,
      unitIds: (c.run.authority as any).unitIds,
      retryEvidence: { kind: "SANDBOX_VALIDATED" },
    });
    const provider = new FixtureWorkspaceProvider(),
      executor = new DocumentExecutor(service, c.policy);
    const generation = new WorkspaceGenerationService(
      prisma,
      service,
      executor,
      provider,
    );
    const proposal = await generation.generate(c.projectId, "owner", {
      kind: "CODE_PROPOSAL",
      runId: retry.id,
      expectedVersion: 3,
      idempotencyKey: "proposal-" + randomUUID(),
      instruction: "Repair only the failed approved command scope",
    });
    expect(
      JSON.parse(String(provider.calls[0].messages[1].content)).authority
        .retryEvidence.kind,
    ).toBe("SANDBOX_VALIDATED");
    const repaired = await executor.execute(
      c.projectId,
      "owner",
      retry.id,
      (proposal.result as any).output.changes,
      c.bindings,
    );
    c.sandbox.exitCode = 0;
    await c.execution.validate(c.projectId, "owner", retry.id, {
      expectedVersion: 3,
      expectedChangeHash: repaired.changeHash,
      idempotencyKey: "validation-" + randomUUID(),
    });
    expect(
      (
        await service.review(
          c.projectId,
          "owner",
          retry.id,
          repaired.changeHash,
        )
      ).kind,
    ).toBe("REVIEW_VERIFIED");
  }, 30000);
  test("requires a separate exact bundle approval and publishes only once through injected transport", async () => {
    const c = await setup();
    const prep = await prepared(c);
    expect(c.publisher.calls).toHaveLength(0);
    expect(prep.bundle.targets[0].head).not.toBe(
      prep.bundle.targets[0].baseline,
    );
    const input = {
      ...c.input,
      idempotencyKey: "publish-" + randomUUID(),
      publicationApprovalId: "not-an-approval",
    };
    await expect(
      c.execution.publish(c.projectId, "owner", c.run.id, input),
    ).rejects.toMatchObject({ code: "PUBLICATION_APPROVAL_REQUIRED" });
    await expect(
      service.approvePublication(c.projectId, "other", c.run.id, {
        preparedEventId: prep.eventId,
        expectedVersion: 3,
        expectedBundleHash: prep.bundle.bundleHash,
      }),
    ).rejects.toMatchObject({ code: "PROJECT_RESOURCE_NOT_FOUND" });
    await expect(
      service.approvePublication(c.projectId, "owner", c.run.id, {
        preparedEventId: prep.eventId,
        expectedVersion: 3,
        expectedBundleHash: "0".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "EXACT_REVIEW_REQUIRED" });
    const permission = await service.approvePublication(
      c.projectId,
      "owner",
      c.run.id,
      {
        preparedEventId: prep.eventId,
        expectedVersion: 3,
        expectedBundleHash: prep.bundle.bundleHash,
      },
    );
    input.publicationApprovalId = permission.id;
    const outcome = await c.execution.publish(
      c.projectId,
      "owner",
      c.run.id,
      input,
    );
    expect(outcome.status).toBe("COMPLETED");
    expect(c.publisher.calls[0]).toEqual(prep.bundle.targets[0]);
    expect(
      (await c.execution.publish(c.projectId, "owner", c.run.id, input)).id,
    ).toBe(outcome.id);
    expect(c.publisher.calls).toHaveLength(1);
    await expect(
      c.execution.publish(c.projectId, "owner", c.run.id, {
        ...input,
        idempotencyKey: "new-" + randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "PUBLICATION_ALREADY_ATTEMPTED" });
    const events = (await service.view(c.projectId, "owner")).runs[0].events;
    expect(events.some((e) => e.kind === "PUBLICATION_CONTRACT_TESTED")).toBe(
      true,
    );
    expect(events.some((e) => e.kind === "PUBLISHED")).toBe(false);
  }, 30000);
  test("detects candidate tampering before any publisher call", async () => {
    const c = await setup(),
      prep = await prepared(c);
    const permission = await service.approvePublication(
      c.projectId,
      "owner",
      c.run.id,
      {
        preparedEventId: prep.eventId,
        expectedVersion: 3,
        expectedBundleHash: prep.bundle.bundleHash,
      },
    );
    const workspace = (c.implemented.bindings[0] as { workspace: string })
      .workspace;
    fs.writeFileSync(path.join(workspace, "approved.txt"), "tampered\n");
    await expect(
      c.execution.publish(c.projectId, "owner", c.run.id, {
        ...c.input,
        idempotencyKey: "publish-" + randomUUID(),
        publicationApprovalId: permission.id,
      }),
    ).rejects.toThrow();
    expect(c.publisher.calls).toHaveLength(0);
  }, 30000);
  test("preserves partial receipts and reconciles read-only without republishing", async () => {
    const c = await setup(2),
      prep = await prepared(c);
    const permission = await service.approvePublication(
      c.projectId,
      "owner",
      c.run.id,
      {
        preparedEventId: prep.eventId,
        expectedVersion: 3,
        expectedBundleHash: prep.bundle.bundleHash,
      },
    );
    c.publisher.failAt = 2;
    const outcome = await c.execution.publish(c.projectId, "owner", c.run.id, {
      ...c.input,
      idempotencyKey: "publish-" + randomUUID(),
      publicationApprovalId: permission.id,
    });
    expect((outcome.result as any).output).toMatchObject({
      complete: false,
      uncertainRepositoryId: c.bindings[1].id,
    });
    expect((outcome.result as any).output.receipts).toHaveLength(1);
    const observed = await c.execution.reconcilePublication(
      c.projectId,
      "owner",
      c.run.id,
      prep.eventId,
    );
    expect((observed.payload as any).complete).toBe(false);
    expect(c.publisher.calls).toHaveLength(2);
    expect(c.publisher.lookups).toBe(2);
    expect(
      (await prisma.workspaceOperation.findUnique({
        where: { id: outcome.id },
      }))!.result,
    ).toEqual(outcome.result);
  }, 30000);
  test("stale validation cannot become current review evidence", async () => {
    const c = await setup();
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((r) => (entered = r)),
      barrier = new Promise<void>((r) => (release = r));
    c.sandbox.barrier = async () => {
      entered();
      await barrier;
    };
    const pending = c.execution.validate(
      c.projectId,
      "owner",
      c.run.id,
      c.input,
    );
    await started;
    const changed = { ...(c.main.content as any), purpose: "Changed purpose" };
    await service.save(c.projectId, "owner", {
      kind: "MAIN",
      content: changed,
      expectedVersion: 3,
      reason: "Edit while validation runs",
    });
    release();
    const outcome = await pending;
    expect(outcome.status).toBe("CONFLICTED");
    const events = (await service.view(c.projectId, "owner")).runs[0].events;
    expect(events.some((e) => e.kind === "SANDBOX_VALIDATED")).toBe(false);
  }, 30000);
  test("inactive owners fail before any work is claimed", async () => {
    const c = await setup();
    await prisma.user.update({
      where: { id: "owner" },
      data: { status: "inactive" },
    });
    try {
      await expect(
        c.execution.validate(c.projectId, "owner", c.run.id, c.input),
      ).rejects.toMatchObject({ code: "PROJECT_RESOURCE_NOT_FOUND" });
      expect(c.sandbox.calls).toBe(0);
    } finally {
      await prisma.user.update({
        where: { id: "owner" },
        data: { status: "active" },
      });
    }
  }, 30000);
  test("expired publication approval cannot start an external attempt", async () => {
    const c = await setup(),
      prep = await prepared(c);
    const permission = await service.approvePublication(
      c.projectId,
      "owner",
      c.run.id,
      {
        preparedEventId: prep.eventId,
        expectedVersion: 3,
        expectedBundleHash: prep.bundle.bundleHash,
      },
    );
    const clock = jest
      .spyOn(Date, "now")
      .mockReturnValue(Date.now() + 16 * 60 * 1000);
    try {
      await expect(
        c.execution.publish(c.projectId, "owner", c.run.id, {
          ...c.input,
          idempotencyKey: "expired-" + randomUUID(),
          publicationApprovalId: permission.id,
        }),
      ).rejects.toMatchObject({ code: "PUBLICATION_APPROVAL_REQUIRED" });
      expect(c.publisher.calls).toHaveLength(0);
    } finally {
      clock.mockRestore();
    }
  }, 30000);
  test("interrupted validation requires exact-job cleanup before recovery", async () => {
    const c = await setup();
    const op = await prisma.workspaceOperation.create({
      data: {
        id: randomUUID(),
        projectId: c.projectId,
        runId: c.run.id,
        kind: "VALIDATION",
        idempotencyKey: "orphan-" + randomUUID(),
        inputHash: "0".repeat(64),
        stateVersion: 3,
        createdBy: "owner",
        context: {},
        createdAt: new Date(Date.now() - 6 * 60 * 1000),
      },
    });
    const cleanup = jest
      .spyOn(c.sandbox, "cleanup")
      .mockRejectedValueOnce(new Error("synthetic cleanup failure"));
    await expect(
      c.execution.recover(c.projectId, "owner", c.run.id, op.id),
    ).rejects.toThrow("synthetic cleanup failure");
    expect(
      (await prisma.workspaceOperation.findUnique({ where: { id: op.id } }))!
        .status,
    ).toBe("RUNNING");
    await c.execution.recover(c.projectId, "owner", c.run.id, op.id);
    expect(cleanup).toHaveBeenLastCalledWith(op.id);
    expect(
      (await prisma.workspaceOperation.findUnique({ where: { id: op.id } }))!
        .status,
    ).toBe("FAILED");
    expect(c.sandbox.calls).toBe(0);
  }, 30000);
});
