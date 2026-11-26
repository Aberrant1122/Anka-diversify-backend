// Native Prisma regression checks against a fresh, loopback-only Postgres engine.
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
(async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { PGLiteSocketServer } = await import("@electric-sql/pglite-socket");
  const db = new PGlite();
  const server = new PGLiteSocketServer({
    db,
    host: "127.0.0.1",
    port: 0,
    maxConnections: 4,
  });
  const groups = [
    ["planning_checkpoint_1b_local", "planning-requirements-lifecycle"],
    [
      "planning_checkpoint_1c_a_local",
      "planning-requirements-readiness-lifecycle",
    ],
    ["planning_checkpoint_1c_b_local", "planning-requirements-run-lifecycle"],
    [
      "planning_checkpoint_1c_docs_local",
      "planning-documentation-(revision|run)-lifecycle",
    ],
    [
      "planning_checkpoint_1b_extended_local",
      "planning-(architecture-(revision-)?lifecycle|documentation-(approval|artifact)-lifecycle)|planning-initial-architecture-generation",
    ],
  ];
  groups.push([
    "planning_checkpoint_1b_repositories_local",
    "primary-repository-registration",
  ]);
  groups.push(
    ["planning_checkpoint_1a_local", "planning-data-foundation"],
    [
      "planning_checkpoint_1c_c_local",
      "planning-initial-requirements-generation",
    ],
    ["planning_checkpoint_1c_d_local", "planning-requirements-revision.test"],
    [
      "planning_checkpoint_1c_d2_local",
      "planning-requirements-section-revision",
    ],
  );
  const selected = process.argv.slice(2);
  try {
    await server.start();
    for (const [schema, pattern] of groups.filter(
      ([schema]) => !selected.length || selected.includes(schema),
    )) {
      await db.exec("DEALLOCATE ALL");
      await db.exec(
        "CREATE SCHEMA " + schema + "; SET search_path TO " + schema + ";",
      );
      for (const name of fs.readdirSync("prisma/migrations").sort()) {
        const file = path.join("prisma/migrations", name, "migration.sql");
        if (fs.existsSync(file)) await db.exec(fs.readFileSync(file, "utf8"));
      }
      const env = {
        ...process.env,
        NODE_ENV: "test",
        JWT_SECRET: "synthetic-regression-key",
        ENCRYPTION_KEY: "00000000000000000000000000000000",
        DATABASE_URL:
          "postgresql://postgres:postgres@" +
          server.getServerConn() +
          "/postgres?schema=" +
          schema +
          "&connection_limit=1&sslmode=disable&pgbouncer=true&statement_cache_size=0",
        ANKA_WORKSPACE_AI_ENABLED: "false",
      };
      for (const name of Object.keys(env))
        if (
          /(?:OPENAI|ANTHROPIC|GEMINI|GOOGLE|DEEPSEEK|OPENROUTER|MISTRAL|GROQ).*API_KEY/i.test(
            name,
          )
        )
          env[name] = "";
      const code = await new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            "--experimental-vm-modules",
            "node_modules/jest/bin/jest.js",
            "--config",
            "jest.config.json",
            "--runInBand",
            "--testTimeout=30000",
            "--testPathPatterns=" + pattern,
            "--json",
            "--outputFile=../../outputs/" + schema + "-results.json",
          ],
          { env, stdio: "inherit" },
        );
        child.on("error", reject);
        child.on("exit", resolve);
      });
      if (code) process.exitCode = 1;
    }
  } finally {
    await server.stop();
    await db.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
