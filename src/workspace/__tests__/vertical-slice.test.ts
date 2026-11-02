import {
  WorkspaceGenerationService,
  GatewayWorkspaceProvider,
} from "../generation-service";
import { FixtureWorkspaceProvider } from "./fixture-provider";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { execFileSync } from "child_process";
import { WorkspaceService } from "../workspace-service";
import { DocumentExecutor } from "../document-executor";
import {
  hash,
  mainFromBrief,
  ArchitectureDocument,
} from "../document-contract";
import { postgresAdapter } from "./postgres-adapter";
import { PGlite } from "@electric-sql/pglite";

// All persistence and Git state live inside this task's synthetic work area.
const root = path.resolve(
  __dirname,
  "../../../../../work/rehearsal/case-" + randomUUID(),
);
const sqlRoot = path.join(__dirname, "fixtures");
const migration = path.resolve(
  __dirname,
  "../../..",
  "prisma/migrations/20261024170000_workspace_authority/migration.sql",
);
const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Synthetic Test",
      "-c",
      "user.email=fixture@example.test",
      ...args,
    ],
    { cwd, encoding: "utf8" },
  ).trim();

describe("document authority vertical slice and migration rehearsal", () => {
  let db: any, service: WorkspaceService, executor: DocumentExecutor;
  let main: any,
    arch: any,
    approval: any,
    run: any,
    baseline: string,
    repo: string;
  const mainContent = mainFromBrief("Maintain a project note.");
  mainContent.questions = [];
  mainContent.requirements[0].acceptanceCriteria[0].description =
    "README contains the approved note.";
  mainContent.requirements.push({
    id: "REQ-002",
    description: "Independent documentation",
    acceptanceCriteria: [
      { id: "AC-002", description: "Second note remains independent." },
    ],
  });
  beforeAll(async () => {
    fs.mkdirSync(root, { recursive: true });
    db = new PGlite(path.join(root, "db"));
    await db.exec(
      fs.readFileSync(path.join(sqlRoot, "legacy-schema.sql"), "utf8"),
    );
    await db.query(
      `INSERT INTO users (id,email,password,"updatedAt") VALUES ('owner','owner@example.test','synthetic-hash',now()),('other','other@example.test','synthetic-hash',now())`,
    );
    await db.query(
      `INSERT INTO projects (id,name,"userId","updatedAt") VALUES ('p','Legacy project','owner',now())`,
    );
    await db.query(
      `INSERT INTO phase_artifacts (id,"projectId",phase,type,title,content,"createdBy") VALUES ('legacy-1','p','requirements','requirements_doc','Legacy','Preserve this requirement','owner')`,
    );
    await db.exec(fs.readFileSync(migration, "utf8"));
    await db.exec(
      fs.readFileSync(
        path.join(
          path.dirname(path.dirname(migration)),
          "20261024180000_workspace_operations/migration.sql",
        ),
        "utf8",
      ),
    );
    service = new WorkspaceService(postgresAdapter(db));
    const repos = path.join(root, "repositories");
    repo = path.join(repos, "source");
    fs.mkdirSync(repo, { recursive: true });
    git(repo, "init");
    fs.writeFileSync(path.join(repo, "README.md"), "original\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "synthetic baseline");
    baseline = git(repo, "rev-parse", "HEAD");
    await db.query(
      `INSERT INTO project_repositories (id,"projectId",name,role,"githubUrl","localPath","updatedAt") VALUES ('repo','p','Synthetic repo','documentation','https://example.test/repo',$1,now())`,
      [repo],
    );
    executor = new DocumentExecutor(service, {
      repositoryRoot: repos,
      runsRoot: path.join(root, "runs"),
    });
  }, 120000);
  afterAll(async () => {
    if (db) await db.close();
  });
  it("preserves legacy rows and imports uncertain drafts idempotently", async () => {
    const imported = await service.importLegacy("p", "owner", 0);
    expect((imported.content as any).questions[0].blocking).toBe(true);
    expect((await service.importLegacy("p", "owner", 1)).id).toBe(imported.id);
    expect(
      (
        await db.query("SELECT content FROM phase_artifacts WHERE id=$1", [
          "legacy-1",
        ])
      ).rows[0].content,
    ).toBe("Preserve this requirement");
  });
  it("rejects a foreign owner before creating documents", async () => {
    await expect(
      service.save("p", "other", {
        kind: "MAIN",
        content: mainContent,
        expectedVersion: 1,
        reason: "Unauthorized",
      }),
    ).rejects.toMatchObject({ code: "PROJECT_RESOURCE_NOT_FOUND" });
  });
  it("versions Main, links exact Architecture and requires exact approval", async () => {
    main = await service.save("p", "owner", {
      kind: "MAIN",
      content: mainContent,
      expectedVersion: 1,
      reason: "Reconcile legacy requirements",
    });
    const content: ArchitectureDocument = {
      schemaVersion: 1,
      sourceMain: { id: main.id, hash: main.contentHash },
      overview: "Update one project note.",
      components: [{ id: "COMP-NOTE", description: "README" }],
      dataMigrations: [],
      interfaces: [],
      security: ["No shell or provider execution"],
      operations: ["Review local diff before publication"],
      repositories: [{ id: "repo", baseline }],
      units: [
        {
          id: "UNIT-NOTE",
          title: "Update note",
          requirementIds: ["REQ-001"],
          dependsOn: [],
          repositoryId: "repo",
          files: [{ path: "README.md", action: "modify" }],
          checks: [
            {
              id: "CHECK-NOTE",
              criterionId: "AC-001",
              type: "contains",
              path: "README.md",
              expected: "approved note",
            },
          ],
        },
        {
          id: "UNIT-OTHER",
          title: "Independent note",
          requirementIds: ["REQ-002"],
          dependsOn: [],
          repositoryId: "repo",
          files: [{ path: "OTHER.md", action: "create" }],
          checks: [
            {
              id: "CHECK-OTHER",
              criterionId: "AC-002",
              type: "contains",
              path: "OTHER.md",
              expected: "independent",
            },
          ],
        },
      ],
      questions: [],
    };
    arch = await service.save("p", "owner", {
      kind: "ARCHITECTURE",
      content,
      expectedVersion: 2,
      reason: "Bound the note change",
    });
    await expect(
      service.approve("p", "owner", {
        architectureId: arch.id,
        architectureHash: "0".repeat(64),
        mainId: main.id,
        mainHash: main.contentHash,
        expectedVersion: 3,
      }),
    ).rejects.toMatchObject({ code: "DOCUMENT_HASH_MISMATCH" });
    approval = await service.approve("p", "owner", {
      architectureId: arch.id,
      architectureHash: arch.contentHash,
      mainId: main.id,
      mainHash: main.contentHash,
      expectedVersion: 3,
    });
  });
  it("captures immutable authority and deduplicates authorization retries", async () => {
    const input = {
      approvalId: approval.id,
      unitIds: ["UNIT-NOTE"],
      expectedVersion: 4,
      idempotencyKey: "synthetic-run-001",
    };
    run = await service.authorize("p", "owner", input);
    expect((await service.authorize("p", "owner", input)).id).toBe(run.id);
    expect((run.authority as any).mainId).toBe(main.id);
    await expect(
      db.query(`UPDATE "WorkspaceRun" SET authority='{}' WHERE id=$1`, [
        run.id,
      ]),
    ).rejects.toThrow("immutable");
  });
  it("executes only the approved unit in an isolated clone and reviews criterion evidence", async () => {
    const result = await executor.execute(
      "p",
      "owner",
      run.id,
      [
        {
          repositoryId: "repo",
          path: "README.md",
          action: "modify",
          beforeHash: hash("original\n"),
          content: "approved note\n",
        },
      ],
      [{ id: "repo", localPath: repo }],
    );
    expect(result.verification).toBe("CHECKS_PASSED");
    expect(fs.readFileSync(path.join(repo, "README.md"), "utf8")).toBe(
      "original\n",
    );
    expect(result.diffs[0].diff).toContain("+approved note");
    const evidence = await service.review(
      "p",
      "owner",
      run.id,
      result.changeHash,
    );
    expect((evidence.payload as any).checks[0]).toMatchObject({
      criterionId: "AC-001",
      passed: true,
    });
  }, 30000);
  it("rejects scope expansion and leaves source unchanged", async () => {
    const r = await service.authorize("p", "owner", {
      approvalId: approval.id,
      unitIds: ["UNIT-NOTE"],
      expectedVersion: 4,
      idempotencyKey: "synthetic-scope-002",
    });
    await expect(
      executor.execute(
        "p",
        "owner",
        r.id,
        [
          {
            repositoryId: "repo",
            path: "outside.txt",
            action: "create",
            beforeHash: null,
            content: "bad",
          },
        ],
        [{ id: "repo", localPath: repo }],
      ),
    ).rejects.toMatchObject({ code: "SCOPE_CHANGE_REQUIRED" });
    expect(fs.existsSync(path.join(repo, "outside.txt"))).toBe(false);
  });
  it("cannot mark failed checks verified", async () => {
    const r = await service.authorize("p", "owner", {
      approvalId: approval.id,
      unitIds: ["UNIT-NOTE"],
      expectedVersion: 4,
      idempotencyKey: "synthetic-failing-003",
    });
    const result = await executor.execute(
      "p",
      "owner",
      r.id,
      [
        {
          repositoryId: "repo",
          path: "README.md",
          action: "modify",
          beforeHash: hash("original\n"),
          content: "wrong note\n",
        },
      ],
      [{ id: "repo", localPath: repo }],
    );
    await expect(
      service.review("p", "owner", r.id, result.changeHash),
    ).rejects.toMatchObject({ code: "CHECKS_FAILED" });
    const retry = await service.retry("p", "owner", r.id, {
      expectedVersion: 4,
      idempotencyKey: "synthetic-repair-001",
    });
    expect(retry.authority).toMatchObject({
      retryOfRunId: r.id,
      unitIds: ["UNIT-NOTE"],
      retryEvidence: { kind: "IMPLEMENTED" },
    });
    const repaired = await executor.execute(
      "p",
      "owner",
      retry.id,
      [
        {
          repositoryId: "repo",
          path: "README.md",
          action: "modify",
          beforeHash: hash("original\n"),
          content: "approved note\n",
        },
      ],
      [{ id: "repo", localPath: repo }],
    );
    expect(repaired.verification).toBe("CHECKS_PASSED");
    // Leave this separate attempt unreviewed so earlier history assertions stay exact.
    expect(fs.readFileSync(path.join(repo, "README.md"), "utf8")).toBe(
      "original\n",
    );
  }, 30000);
  it("blocks affected execution and preserves independent readiness and historical evidence", async () => {
    const content = JSON.parse(JSON.stringify(mainContent));
    content.requirements[0].description = "Changed note requirement";
    await service.save("p", "owner", {
      kind: "MAIN",
      content,
      expectedVersion: 4,
      reason: "Maintenance requirement change",
    });
    await expect(
      service.authorize("p", "owner", {
        approvalId: approval.id,
        unitIds: ["UNIT-NOTE"],
        expectedVersion: 5,
        idempotencyKey: "synthetic-blocked-004",
      }),
    ).rejects.toMatchObject({ code: "DOCUMENT_RECONCILIATION_REQUIRED" });
    expect(
      (
        await service.authorize("p", "owner", {
          approvalId: approval.id,
          unitIds: ["UNIT-OTHER"],
          expectedVersion: 5,
          idempotencyKey: "synthetic-independent-005",
        })
      ).id,
    ).toBeTruthy();
    expect(
      (await service.view("p", "owner")).events.filter(
        (e) => e.kind === "REVIEW_VERIFIED",
      ),
    ).toHaveLength(1);
  });
  it("detects external Git drift before mutation", async () => {
    const r = await service.authorize("p", "owner", {
      approvalId: approval.id,
      unitIds: ["UNIT-OTHER"],
      expectedVersion: 5,
      idempotencyKey: "synthetic-drift-006",
    });
    fs.writeFileSync(path.join(repo, "README.md"), "external change");
    await expect(
      executor.execute(
        "p",
        "owner",
        r.id,
        [
          {
            repositoryId: "repo",
            path: "OTHER.md",
            action: "create",
            beforeHash: null,
            content: "independent",
          },
        ],
        [{ id: "repo", localPath: repo }],
      ),
    ).rejects.toMatchObject({ code: "EXTERNAL_GIT_DRIFT" });
    fs.writeFileSync(path.join(repo, "README.md"), "original\n");
  });
  it("preserves exact authority and review evidence across a database restart", async () => {
    await db.close();
    db = new PGlite(path.join(root, "db"));
    service = new WorkspaceService(postgresAdapter(db));
    const view = await service.view("p", "owner");
    expect(view.documents).toHaveLength(4);
    expect(view.runs.find((r) => r.id === run.id)?.authority).toMatchObject({
      mainId: main.id,
      architectureId: arch.id,
      approvalId: approval.id,
    });
    expect(
      view.events.filter((e) => e.kind === "REVIEW_VERIFIED"),
    ).toHaveLength(1);
    expect(
      (await db.query("SELECT count(*)::int AS count FROM phase_artifacts"))
        .rows[0].count,
    ).toBe(1);
    fs.writeFileSync(
      path.join(root, "rehearsal-result.json"),
      JSON.stringify(
        {
          legacyPreserved: true,
          documentVersions: view.documents.length,
          runCount: view.runs.length,
          reviewEvidence: view.events.filter(
            (e) => e.kind === "REVIEW_VERIFIED",
          ).length,
        },
        null,
        2,
      ),
    );
  }, 30000);

  it("generates real workflow drafts and architecture-bound code proposals through an injected provider", async () => {
    await db.query(
      `INSERT INTO projects (id,name,"userId","updatedAt") VALUES ('p-ai','Generated workflow','owner',now())`,
    );
    await db.query(
      `INSERT INTO project_repositories (id,"projectId",name,role,"githubUrl","localPath","currentIndexedCommit","updatedAt") VALUES ('repo-ai','p-ai','Generated note repo','documentation','https://example.test/repo',$1,$2,now())`,
      [repo, baseline],
    );
    const provider = new FixtureWorkspaceProvider();
    const scopedExecutor = new DocumentExecutor(service, {
      repositoryRoot: path.join(root, "repositories"),
      runsRoot: path.join(root, "generated-runs"),
    });
    const generation = new WorkspaceGenerationService(
      postgresAdapter(db),
      service,
      scopedExecutor,
      provider,
    );
    const request = {
      kind: "MAIN" as const,
      brief: "Maintain a project note.",
      instruction: "Generate the Main Document",
      expectedVersion: 0,
      idempotencyKey: "generated-main-001",
    };
    const mainOp = await generation.generate("p-ai", "owner", request);
    expect(mainOp.status).toBe("COMPLETED");
    expect((await generation.generate("p-ai", "owner", request)).id).toBe(
      mainOp.id,
    );
    expect(provider.calls).toHaveLength(1);
    await generation.generate("p-ai", "owner", {
      kind: "ARCHITECTURE",
      instruction: "Design bounded implementation units",
      expectedVersion: 1,
      idempotencyKey: "generated-architecture-001",
    });
    let state = await service.view("p-ai", "owner");
    const m = state.documents.find((d) => d.id === state.head.mainId)!,
      a = state.documents.find((d) => d.id === state.head.architectureId)!;
    const approved = await service.approve("p-ai", "owner", {
      mainId: m.id,
      mainHash: m.contentHash,
      architectureId: a.id,
      architectureHash: a.contentHash,
      expectedVersion: 2,
    });
    const authorized = await service.authorize("p-ai", "owner", {
      approvalId: approved.id,
      unitIds: ["UNIT-NOTE"],
      expectedVersion: 3,
      idempotencyKey: "generated-run-001",
    });
    const proposed = await generation.generate("p-ai", "owner", {
      kind: "CODE_PROPOSAL",
      runId: authorized.id,
      instruction: "Implement this approved unit",
      expectedVersion: 3,
      idempotencyKey: "generated-code-001",
    });
    expect((proposed.context as any).authority.approvalId).toBe(approved.id);
    expect(fs.readFileSync(path.join(repo, "README.md"), "utf8")).toBe(
      "original\n",
    );
    const changes = (proposed.result as any).output.changes;
    const implemented = await scopedExecutor.execute(
      "p-ai",
      "owner",
      authorized.id,
      changes,
      [{ id: "repo-ai", localPath: repo }],
    );
    await service.review(
      "p-ai",
      "owner",
      authorized.id,
      implemented.changeHash,
    );
    state = await service.view("p-ai", "owner");
    expect(state.events.some((e) => e.kind === "DOCUMENT_GENERATED")).toBe(
      true,
    );
    expect(state.events.some((e) => e.kind === "CODE_PROPOSED")).toBe(true);
    expect(state.events.some((e) => e.kind === "REVIEW_VERIFIED")).toBe(true);
    expect(provider.calls).toHaveLength(3);
    await expect(
      db.query(`UPDATE "WorkspaceOperation" SET context='{}' WHERE id=$1`, [
        mainOp.id,
      ]),
    ).rejects.toThrow("immutable");
  }, 30000);

  it("rejects provider scope expansion before any file mutation", async () => {
    const state = await service.view("p-ai", "owner");
    const r = await service.authorize("p-ai", "owner", {
      approvalId: state.head.approvalId!,
      unitIds: ["UNIT-NOTE"],
      expectedVersion: state.head.stateVersion,
      idempotencyKey: "generated-scope-run-002",
    });
    const provider = {
      available: () => true,
      generate: jest.fn(async () => ({
        content: {
          scopeChangeRequired: false,
          reason: "Invented file",
          changes: [
            {
              repositoryId: "repo-ai",
              path: "outside.txt",
              action: "create",
              content: "unsafe",
            },
          ],
        },
        audit: { provider: "SYNTHETIC" },
      })),
    };
    const ex = new DocumentExecutor(service, {
      repositoryRoot: path.join(root, "repositories"),
      runsRoot: path.join(root, "rejected-runs"),
    });
    const generation = new WorkspaceGenerationService(
      postgresAdapter(db),
      service,
      ex,
      provider,
    );
    await expect(
      generation.generate("p-ai", "owner", {
        kind: "CODE_PROPOSAL",
        runId: r.id,
        expectedVersion: state.head.stateVersion,
        idempotencyKey: "generated-scope-proposal-002",
        instruction: "Propose the unit",
      }),
    ).rejects.toMatchObject({ code: "SCOPE_CHANGE_REQUIRED" });
    expect(fs.existsSync(path.join(repo, "outside.txt"))).toBe(false);
    const after = await service.view("p-ai", "owner");
    expect(
      after.runs
        .find((run) => run.id === r.id)
        ?.events.some((e) => e.kind === "SCOPE_CHANGE_REQUIRED"),
    ).toBe(true);
    await expect(
      service.retry("p-ai", "owner", r.id, {
        expectedVersion: state.head.stateVersion,
        idempotencyKey: "scope-retry-forbidden",
      }),
    ).rejects.toMatchObject({ code: "RETRY_AUTHORITY_MISMATCH" });
  }, 30000);
  it("deduplicates running generation and conflicts if Main changes during a provider response", async () => {
    const state = await service.view("p-ai", "owner");
    let release!: () => void, started!: () => void;
    const ready = new Promise<void>((r) => (started = r)),
      wait = new Promise<void>((r) => (release = r));
    const fixture = new FixtureWorkspaceProvider();
    const provider = {
      available: () => true,
      generate: async (options: any) => {
        started();
        await wait;
        return fixture.generate(options);
      },
    };
    const ex = new DocumentExecutor(service, {
      repositoryRoot: path.join(root, "repositories"),
      runsRoot: path.join(root, "conflicted-runs"),
    });
    const generation = new WorkspaceGenerationService(
      postgresAdapter(db),
      service,
      ex,
      provider,
    );
    const input = {
      kind: "MAIN" as const,
      expectedVersion: state.head.stateVersion,
      idempotencyKey: "delayed-main-001",
      instruction: "Revise the Main Document",
      brief: "Maintain a project note.",
    };
    const pending = generation.generate("p-ai", "owner", input);
    await ready;
    await expect(
      generation.generate("p-ai", "owner", {
        ...input,
        idempotencyKey: "duplicate-main-002",
      }),
    ).rejects.toMatchObject({ code: "OPERATION_IN_PROGRESS" });
    const m = state.documents.find((d) => d.id === state.head.mainId)!;
    const content = JSON.parse(JSON.stringify(m.content));
    content.requirements[0].description =
      "Maintenance changes the note requirement.";
    await service.save("p-ai", "owner", {
      kind: "MAIN",
      content,
      expectedVersion: state.head.stateVersion,
      reason: "Concurrent maintenance edit",
    });
    release();
    await expect(pending).rejects.toMatchObject({
      code: "GENERATION_CONTEXT_CHANGED",
    });
    expect(fixture.calls).toHaveLength(1);
    const after = await service.view("p-ai", "owner");
    expect(
      after.operations.find((op) => op.idempotencyKey === "delayed-main-001")
        ?.status,
    ).toBe("CONFLICTED");
    expect(after.documents).toHaveLength(3);
  }, 30000);
  it("serializes exact approval, refuses stale runs, and preserves source/evidence after reconciliation", async () => {
    let state = await service.view("p-ai", "owner");
    const m = state.documents.find((d) => d.id === state.head.mainId)!,
      previous = state.documents.find(
        (d) => d.id === state.head.architectureId,
      )!;
    await expect(
      service.authorize("p-ai", "owner", {
        approvalId: state.head.approvalId!,
        unitIds: ["UNIT-NOTE"],
        expectedVersion: state.head.stateVersion,
        idempotencyKey: "maintenance-blocked-001",
      }),
    ).rejects.toMatchObject({ code: "DOCUMENT_RECONCILIATION_REQUIRED" });
    const content = JSON.parse(JSON.stringify(previous.content));
    content.sourceMain = { id: m.id, hash: m.contentHash };
    const a = await service.save("p-ai", "owner", {
      kind: "ARCHITECTURE",
      content,
      expectedVersion: state.head.stateVersion,
      reason: "Reconcile maintenance requirement",
    });
    state = await service.view("p-ai", "owner");
    const input = {
      mainId: m.id,
      mainHash: m.contentHash,
      architectureId: a.id,
      architectureHash: a.contentHash,
      expectedVersion: state.head.stateVersion,
    };
    const results = await Promise.allSettled([
      service.approve("p-ai", "owner", input),
      service.approve("p-ai", "owner", input),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    const final = await service.view("p-ai", "owner");
    expect(final.events.some((e) => e.kind === "REVIEW_VERIFIED")).toBe(true);
    expect(fs.readFileSync(path.join(repo, "README.md"), "utf8")).toBe(
      "original\n",
    );
    expect(
      (
        await service.approve("p-ai", "owner", {
          ...input,
          expectedVersion: final.head.stateVersion,
        })
      ).id,
    ).toBe(final.head.approvalId);
  }, 30000);
  it("verifies an approved deletion using absence evidence without changing the source", async () => {
    await db.query(
      `INSERT INTO projects (id,name,"userId","updatedAt") VALUES ('p-delete','Deletion rehearsal','owner',now())`,
    );
    await db.query(
      `INSERT INTO project_repositories (id,"projectId",name,role,"githubUrl","localPath","updatedAt") VALUES ('repo-delete','p-delete','Deletion source','documentation','https://example.test/repo',$1,now())`,
      [repo],
    );
    const content = mainFromBrief("Remove the obsolete project note.");
    content.questions = [];
    content.requirements[0].acceptanceCriteria[0].description =
      "README is absent.";
    const m = await service.save("p-delete", "owner", {
      kind: "MAIN",
      content,
      expectedVersion: 0,
      reason: "Document deletion",
    });
    const aContent = JSON.parse(JSON.stringify(arch.content));
    aContent.sourceMain = { id: m.id, hash: m.contentHash };
    aContent.repositories = [{ id: "repo-delete", baseline }];
    aContent.units = [aContent.units[0]];
    aContent.units[0].repositoryId = "repo-delete";
    aContent.units[0].files = [{ path: "README.md", action: "delete" }];
    aContent.units[0].checks = [
      {
        id: "CHECK-ABSENT",
        criterionId: "AC-001",
        type: "absent",
        path: "README.md",
        expected: "",
      },
    ];
    const a = await service.save("p-delete", "owner", {
      kind: "ARCHITECTURE",
      content: aContent,
      expectedVersion: 1,
      reason: "Scope deletion",
    });
    const approval = await service.approve("p-delete", "owner", {
      mainId: m.id,
      mainHash: m.contentHash,
      architectureId: a.id,
      architectureHash: a.contentHash,
      expectedVersion: 2,
    });
    const r = await service.authorize("p-delete", "owner", {
      approvalId: approval.id,
      unitIds: ["UNIT-NOTE"],
      expectedVersion: 3,
      idempotencyKey: "delete-note-run-001",
    });
    const deletionExecutor = new DocumentExecutor(service, {
      repositoryRoot: path.join(root, "repositories"),
      runsRoot: path.join(root, "deletion-runs"),
    });
    const result = await deletionExecutor.execute(
      "p-delete",
      "owner",
      r.id,
      [
        {
          repositoryId: "repo-delete",
          path: "README.md",
          action: "delete",
          beforeHash: hash("original\n"),
          content: null,
        },
      ],
      [{ id: "repo-delete", localPath: repo }],
    );
    expect(result.checks[0]).toMatchObject({ type: "absent", passed: true });
    await service.review("p-delete", "owner", r.id, result.changeHash);
    expect(fs.readFileSync(path.join(repo, "README.md"), "utf8")).toBe(
      "original\n",
    );
  }, 30000);
});
