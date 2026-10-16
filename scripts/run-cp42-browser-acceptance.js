const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { PrismaClient } = require("@prisma/client");
const { validateSafeTestDatabase, assertSafeSchema, sanitizeOutput } = require("./run-cp0-acceptance");

async function main() {
  const baseUrl = validateSafeTestDatabase(process.env.CP0_TEST_DATABASE_URL);
  const schemaName = `planning_checkpoint_1b_cp42_browser_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
  assertSafeSchema(schemaName);

  const isolatedUrl = new URL(baseUrl.href);
  isolatedUrl.searchParams.set("schema", schemaName);

  console.log(`[CP4.2 Browser Acceptance] Deploying migrations to isolated schema: ${schemaName}...`);
  const migration = spawnSync("npx prisma migrate deploy", {
    shell: true,
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: isolatedUrl.href },
  });
  if (migration.status !== 0) {
    throw new Error(migration.stderr || migration.stdout || "Migration failed");
  }

  const rootPrisma = new PrismaClient({ datasources: { db: { url: baseUrl.href } } });
  try {
    console.log(`[CP4.2 Browser Acceptance] Spawning Playwright worker against isolated test database...`);
    const workerScript = path.resolve(__dirname, "cp42-browser-acceptance-worker.ts");
    const run = spawnSync(
      `npx ts-node --transpile-only "${workerScript}"`,
      {
        shell: true,
        encoding: "utf8",
        env: {
          ...process.env,
          DATABASE_URL: isolatedUrl.href,
          TEST_SCHEMA_NAME: schemaName,
        },
        maxBuffer: 20 * 1024 * 1024,
      }
    );

    if (run.stdout) process.stdout.write(sanitizeOutput(run.stdout, baseUrl));
    if (run.stderr) process.stderr.write(sanitizeOutput(run.stderr, baseUrl));

    if (run.status !== 0) {
      throw new Error(`Browser acceptance worker exited with code ${run.status}`);
    }

    console.log(`[CP4.2 Browser Acceptance] Acceptance journey completed successfully!`);
  } finally {
    const quoted = assertSafeSchema(schemaName);
    await rootPrisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${quoted} CASCADE;`);
    await rootPrisma.$disconnect();
    console.log(`[CP4.2 Browser Acceptance] Cleaned up isolated schema: ${schemaName}`);
  }
}

main().catch((err) => {
  console.error(`[CP4.2 Browser Acceptance Failure]`, err.message);
  process.exit(1);
});
