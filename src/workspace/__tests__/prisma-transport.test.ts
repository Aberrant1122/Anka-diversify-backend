import fs from "fs";
import path from "path";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { PrismaClient } from "@prisma/client";
import { WorkspaceService } from "../workspace-service";
import { WorkspaceGenerationService } from "../generation-service";
import { DocumentExecutor } from "../document-executor";
import { FixtureWorkspaceProvider } from "./fixture-provider";

describe("native Prisma transport against isolated Postgres over loopback TCP", () => {
  let db: PGlite,
    server: PGLiteSocketServer,
    prisma: PrismaClient,
    service: WorkspaceService;
  beforeAll(async () => {
    db = new PGlite();
    const migrations = path.resolve(__dirname, "../../..", "prisma/migrations");
    // This test uses actual migration history, not the Prisma-shaped test adapter.
    for (const name of fs.readdirSync(migrations).sort()) {
      const file = path.join(migrations, name, "migration.sql");
      if (fs.existsSync(file)) await db.exec(fs.readFileSync(file, "utf8"));
    }
    server = new PGLiteSocketServer({
      db,
      port: 0,
      host: "127.0.0.1",
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
        id: "tcp-owner",
        email: "tcp-owner@example.test",
        password: "synthetic-hash",
      },
    });
    await prisma.project.create({
      data: {
        id: "tcp-project",
        name: "Native Prisma rehearsal",
        userId: "tcp-owner",
      },
    });
    service = new WorkspaceService(prisma);
  }, 120000);
  afterAll(async () => {
    await prisma?.$disconnect();
    await server?.stop();
    await db?.close();
  });
  it("persists generated versions through real Prisma transactions and preserves immutable records", async () => {
    const generation = new WorkspaceGenerationService(
      prisma,
      service,
      new DocumentExecutor(service),
      new FixtureWorkspaceProvider(),
    );
    const operation = await generation.generate("tcp-project", "tcp-owner", {
      kind: "MAIN",
      brief: "Maintain the native Prisma project note.",
      instruction: "Generate the Main Document",
      expectedVersion: 0,
      idempotencyKey: "native-prisma-main-001",
    });
    expect(operation.status).toBe("COMPLETED");
    const state = await service.view("tcp-project", "tcp-owner");
    expect(state.documents).toHaveLength(1);
    expect(state.head.stateVersion).toBe(1);
    await expect(
      prisma.workspaceDocument.update({
        where: { id: state.head.mainId! },
        data: { contentHash: "forged" },
      }),
    ).rejects.toThrow("immutable");
    expect(
      (await service.view("tcp-project", "tcp-owner")).documents[0].contentHash,
    ).toBe(state.documents[0].contentHash);
  }, 30000);
  it("rejects a stale compare-and-swap without modifying the new version", async () => {
    const state = await service.view("tcp-project", "tcp-owner");
    const content = state.documents[0].content;
    await expect(
      service.save("tcp-project", "tcp-owner", {
        kind: "MAIN",
        content,
        expectedVersion: 0,
        reason: "Stale edit",
      }),
    ).rejects.toMatchObject({ code: "STATE_CONFLICT" });
    expect(
      (await service.view("tcp-project", "tcp-owner")).documents,
    ).toHaveLength(1);
  }, 30000);
});
