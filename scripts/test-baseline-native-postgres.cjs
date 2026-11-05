// Opt-in, fresh-schema rehearsal only. Never reads the application's DATABASE_URL.
const { PrismaClient } = require("@prisma/client");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs"),
  path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");
(async () => {
  if (process.env.ANKA_LOCAL_REHEARSAL !== "1")
    throw new Error("Explicit local rehearsal flag required");
  const url = new URL(process.env.ANKA_REHEARSAL_DATABASE_URL || "");
  if (
    url.protocol !== "postgresql:" ||
    url.hostname !== "127.0.0.1" ||
    url.username !== "anka_rehearsal" ||
    url.password !== "synthetic" ||
    url.pathname !== "/anka_rehearsal" ||
    url.search
  )
    throw new Error("Only synthetic loopback rehearsal database is allowed");
  const variant = process.env.ANKA_BASELINE_RACE_VARIANT || "same-key";
  if (!["same-key", "different-key"].includes(variant))
    throw new Error("Unknown synthetic race variant");
  const schema = "anka_rehearsal_" + randomUUID().replaceAll("-", "");
  const db = new PrismaClient({
    datasources: {
      db: { url: url.href + "?schema=public&connection_limit=1" },
    },
  });
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    PGPASSWORD: "synthetic",
    PGOPTIONS: "-c search_path=" + schema,
  };
  let created = false;
  try {
    const [{ version }] = await db.$queryRawUnsafe("SELECT version()");
    if (!version.includes("PostgreSQL") || /pglite/i.test(version))
      throw new Error("Independent native PostgreSQL required");
    await db.$executeRawUnsafe('CREATE SCHEMA "' + schema + '"');
    created = true;
    for (const name of fs.readdirSync("prisma/migrations").sort()) {
      const file = path.resolve("prisma/migrations", name, "migration.sql");
      if (!fs.existsSync(file)) continue;
      execFileSync(
        process.env.ANKA_REHEARSAL_PSQL || "psql",
        [
          "-X",
          "-v",
          "ON_ERROR_STOP=1",
          "-h",
          "127.0.0.1",
          "-p",
          url.port || "5432",
          "-U",
          "anka_rehearsal",
          "-d",
          "anka_rehearsal",
          "-f",
          file,
        ],
        { env, stdio: ["ignore", "ignore", "pipe"], timeout: 30000 },
      );
    }
    const childEnv = {
      ...env,
      ANKA_REHEARSAL_DATABASE_URL:
        url.href + "?schema=" + schema + "&connection_limit=1",
      JWT_SECRET: "synthetic-native-rehearsal-key",
      ENCRYPTION_KEY: "00000000000000000000000000000000",
    };
    const scoped = new PrismaClient({
      datasources: { db: { url: childEnv.ANKA_REHEARSAL_DATABASE_URL } },
    });
    try {
      await scoped.user.create({
        data: {
          id: "owner",
          email: "owner@example.test",
          password: "synthetic",
        },
      });
      await scoped.project.create({
        data: {
          id: "project",
          name: "Native concurrency rehearsal",
          userId: "owner",
        },
      });
    } finally {
      await scoped.$disconnect();
    }
    childEnv.ANKA_LOCAL_REHEARSAL = "1";
    childEnv.ANKA_BASELINE_RACE_VARIANT = variant;
    childEnv.ANKA_BASELINE_CLAIM = execFileSync(
      process.execPath,
      [
        "node_modules/ts-node/dist/bin.js",
        "--project",
        "tsconfig.rehearsal.json",
        "scripts/baseline-native-worker.ts",
        "setup",
      ],
      { env: childEnv, encoding: "utf8", timeout: 60000 },
    ).trim();
    function worker(index) {
      const child = spawn(
        process.execPath,
        [
          "node_modules/ts-node/dist/bin.js",
          "--project",
          "tsconfig.rehearsal.json",
          "scripts/baseline-native-worker.ts",
        ],
        {
          env: { ...childEnv, ANKA_BASELINE_WORKER_INDEX: String(index) },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let out = "",
        stderr = "";
      const ready = new Promise((resolve, reject) => {
        child.stdout.on("data", (b) => {
          out += b.toString();
          const line = out.split("\n").find((l) => l.startsWith('{"ready"'));
          if (line) resolve(JSON.parse(line));
        });
        child.on("error", reject);
        child.on("exit", () => {
          if (!out.includes('{"ready"'))
            reject(new Error("Native child did not become ready"));
        });
      });
      const done = new Promise((resolve, reject) => {
        child.stderr.on("data", (b) => (stderr += b.toString()));
        child.on("exit", (code) => {
          if (code)
            reject(new Error("Native child failed: " + stderr.slice(0, 200)));
          else {
            const line = out
              .split("\n")
              .find((l) => l.startsWith('{"outcome"'));
            line
              ? resolve(JSON.parse(line))
              : reject(new Error("Missing native outcome"));
          }
        });
      });
      done.catch(() => {});
      return { child, ready, done };
    }
    const workers = [worker(0), worker(1)];
    const timer = setTimeout(() => {
      for (const w of workers) w.child.kill();
    }, 45000);
    try {
      const ready = await Promise.all(workers.map((w) => w.ready));
      if (ready[0].pid === ready[1].pid)
        throw new Error("Distinct PostgreSQL backends required");
      for (const w of workers) w.child.stdin.end("go\n");
      const outcomes = await Promise.all(workers.map((w) => w.done));
      if (
        outcomes.filter((o) => o.outcome === "CLAIMED").length !== 1 ||
        outcomes.filter((o) =>
          [
            "REUSED",
            "STATE_CONFLICT",
            "BASELINE_OPERATION_ALREADY_CLAIMED",
          ].includes(o.outcome),
        ).length !== 1
      )
        throw new Error("Native CAS race invariant failed");
      const verify = new PrismaClient({
        datasources: { db: { url: childEnv.ANKA_REHEARSAL_DATABASE_URL } },
      });
      try {
        if (
          (await verify.baselineValidationOperation.count({
            where: { projectId: "project" },
          })) !== 1 ||
          (await verify.workspaceEvent.count({
            where: {
              projectId: "project",
              kind: "BASELINE_VALIDATION_PREPARING",
            },
          })) !== 1
        )
          throw new Error("Duplicate baseline claim/job");
      } finally {
        await verify.$disconnect();
      }
      const projectWideCleanupGuards=JSON.parse(execFileSync(process.execPath,[
        'node_modules/ts-node/dist/bin.js','--project','tsconfig.rehearsal.json',
        'scripts/baseline-native-worker.ts','guards',
      ],{env:childEnv,encoding:'utf8',timeout:60000}).trim());
      if(!projectWideCleanupGuards.passed||projectWideCleanupGuards.outcomes.length!==4)
        throw Error('Native project-wide cleanup guards not verified');
      console.log(
        JSON.stringify({
          engine: "independent-native-postgresql",
          schema,
          variant,
          durableOperations: 1,
          preparingEvents: 1,
          actualRuntimeDispatched: false,
          distinctBackendPids: true,
          outcomes,
          projectWideCleanupGuards,
          passed: true,
        }),
      );
    } finally {
      clearTimeout(timer);
      for (const w of workers) w.child.kill();
    }
  } finally {
    if (created)
      await db.$executeRawUnsafe('DROP SCHEMA "' + schema + '" CASCADE');
    await db.$disconnect();
  }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
