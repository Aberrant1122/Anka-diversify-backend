// Explicit local-only UI harness. It never uses DATABASE_URL or provider keys.
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { execFileSync } from "child_process";
import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import { PGlite } from "@electric-sql/pglite";
import { createWorkspaceRouter } from "../src/routes/workspace-routes";
import { createAuthenticateToken } from "../src/middleware/auth";
import { sessionVersion } from "../src/security/session-version";
import { JWT_SECRET } from "../src/config/env";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { PrismaClient } from "@prisma/client";
import { FixtureWorkspaceProvider } from "../src/workspace/__tests__/fixture-provider";

async function start() {
  if (process.env.ANKA_LOCAL_REHEARSAL !== "1")
    throw new Error("ANKA_LOCAL_REHEARSAL=1 is required");
  const root = path.resolve(
    process.env.ANKA_REHEARSAL_DIR ||
      path.join("work", "ui-rehearsal-" + randomUUID()),
  );
  fs.mkdirSync(root, { recursive: true });
  const db = new PGlite(path.join(root, "db"));
  if (
    !(
      await db.query<{ name: string | null }>(
        "SELECT to_regclass('public.users') AS name",
      )
    ).rows[0].name
  )
    await db.exec(
      fs.readFileSync(
        path.join(
          __dirname,
          "../src/workspace/__tests__/fixtures/legacy-schema.sql",
        ),
        "utf8",
      ),
    );
  if (
    !(
      await db.query<{ name: string | null }>(
        "SELECT to_regclass($1) AS name",
        ['public."WorkspaceDocument"'],
      )
    ).rows[0].name
  )
    await db.exec(
      fs.readFileSync(
        path.join(
          __dirname,
          "../prisma/migrations/20261024170000_workspace_authority/migration.sql",
        ),
        "utf8",
      ),
    );
  if (
    !(
      await db.query<{ name: string | null }>(
        "SELECT to_regclass($1) AS name",
        ['public."WorkspaceOperation"'],
      )
    ).rows[0].name
  )
    await db.exec(
      fs.readFileSync(
        path.join(
          __dirname,
          "../prisma/migrations/20261024180000_workspace_operations/migration.sql",
        ),
        "utf8",
      ),
    );
  const user = {
    id: "owner",
    name: "Synthetic Owner",
    email: "owner@example.test",
    password: "fixture-hash",
    status: "active",
    role: "developer",
  };
  await db.query(
    `INSERT INTO users (id,email,password,"updatedAt",role) VALUES ($1,$2,$3,now(),$4) ON CONFLICT (id) DO NOTHING`,
    [user.id, user.email, user.password, user.role],
  );
  await db.query(
    `INSERT INTO projects (id,name,description,"userId","updatedAt") VALUES ('p','Synthetic document authority rehearsal','Maintain one project note.','owner',now()) ON CONFLICT (id) DO NOTHING`,
  );
  const repositoryRoot = path.join(root, "repositories"),
    repo = path.join(repositoryRoot, "source");
  fs.mkdirSync(repo, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Synthetic Fixture",
        "-c",
        "user.email=fixture@example.test",
        ...args,
      ],
      { cwd: repo, encoding: "utf8" },
    ).trim();
  if (!fs.existsSync(path.join(repo, ".git"))) {
    git("init");
    fs.writeFileSync(path.join(repo, "README.md"), "original\n");
    git("add", ".");
    git("commit", "-m", "synthetic baseline");
  }
  const baseline = git("rev-parse", "HEAD");
  await db.query(
    `INSERT INTO project_repositories (id,"projectId",name,role,"githubUrl","localPath","currentIndexedCommit","updatedAt") VALUES ('repo','p','Synthetic note repository','documentation','https://github.com/synthetic/anka-document-rehearsal',$1,$2,now()) ON CONFLICT (id) DO UPDATE SET "githubUrl"=EXCLUDED."githubUrl" WHERE project_repositories."projectId"='p' AND project_repositories."githubUrl"='https://example.test/repo'`,
    [repo, baseline],
  );
  const sqlServer = new PGLiteSocketServer({
    db,
    port: 0,
    host: "127.0.0.1",
    maxConnections: 1,
  });
  await sqlServer.start();
  const adapter = new PrismaClient({
    datasources: {
      db: {
        url:
          "postgresql://postgres:postgres@" +
          sqlServer.getServerConn() +
          "/postgres?schema=public&connection_limit=1&sslmode=disable",
      },
    },
  });
  const app = express();
  app.use(
    cors({
      origin: ["http://localhost:4100", "http://127.0.0.1:4100"],
      credentials: true,
    }),
  );
  app.use(express.json({ limit: "2mb" }));
  app.post("/api/auth/login", (req, res) => {
    if (
      req.body.email !== user.email ||
      req.body.password !== "synthetic-local-only"
    )
      return res.status(401).json({ message: "Invalid synthetic login" });
    res.json({
      token: jwt.sign(
        { userId: user.id, sessionVersion: sessionVersion(user) },
        JWT_SECRET,
      ),
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        createdAt: new Date().toISOString(),
      },
    });
  });
  app.use("/api", createAuthenticateToken(adapter));
  app.use(
    "/api/projects/:projectId/workspace",
    createWorkspaceRouter(
      adapter,
      { repositoryRoot, runsRoot: path.join(root, "runs") },
      new FixtureWorkspaceProvider(),
    ),
  );
  const project = {
    id: "p",
    name: "Synthetic document authority rehearsal",
    description: "Maintain one project note.",
    phase: "development",
    userId: "owner",
    tasks: [],
    members: [],
    rules: [],
    decisions: [],
    phaseStates: [],
    repoSnapshot: {
      repoName: "Synthetic note repository",
      fileTree: ["README.md"],
      lastSyncedAt: new Date().toISOString(),
    },
  };
  app.get("/api/projects", (_req, res) =>
    res.json({ success: true, data: [project] }),
  );
  app.get("/api/projects/p", (_req, res) =>
    res.json({ success: true, data: project }),
  );
  app.get("/api/projects/p/repositories", async (_req, res) =>
    res.json({
      success: true,
      data: await adapter.projectRepository.findMany({
        where: { projectId: "p" },
      }),
    }),
  );
  app.get("/api/projects/p/repo/file", (req, res) => {
    if (req.query.path !== "README.md")
      return res.status(404).json({ error: "Synthetic file not found" });
    res.json({
      success: true,
      data: {
        path: "README.md",
        content: fs.readFileSync(path.join(repo, "README.md"), "utf8"),
        sha: git("rev-parse", "HEAD:README.md"),
      },
    });
  });
  app.get("/api/notifications/unread-count", (_req, res) =>
    res.json({ success: true, data: { count: 0 } }),
  );
  app.get("/api/auth/profile", (_req, res) =>
    res.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
    }),
  );
  app.use("/api", (_req, res) => res.json({ success: true, data: [] }));
  const server = app.listen(4101, "127.0.0.1", () =>
    console.log(
      JSON.stringify({
        fixture: "LOCAL SYNTHETIC ONLY",
        api: "http://127.0.0.1:4101/api",
        email: user.email,
        password: "synthetic-local-only",
        baseline,
        root,
      }),
    ),
  );
  const stop = () =>
    server.close(async () => {
      await adapter.$disconnect();
      await sqlServer.stop();
      await db.close();
      process.exit(0);
    });
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
start().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
