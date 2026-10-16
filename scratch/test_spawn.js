const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { PrismaClient } = require("@prisma/client");
const { validateSafeTestDatabase, assertSafeSchema } = require("../scripts/run-cp0-acceptance");

async function main() {
  const baseUrl = validateSafeTestDatabase(process.env.CP0_TEST_DATABASE_URL);
  const schemaName = `planning_checkpoint_1b_cp41_spawn_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
  assertSafeSchema(schemaName);

  const isolatedUrl = new URL(baseUrl.href);
  isolatedUrl.searchParams.set("schema", schemaName);

  console.log(`[SPAWN] Deploying migrations to ${schemaName}...`);
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
    console.log(`[SPAWN] Spawning ts-node with DATABASE_URL in env...`);
    const run = spawnSync(
      `npx ts-node --transpile-only scratch/test_ts_seed.ts`,
      {
        shell: true,
        encoding: "utf8",
        env: { ...process.env, DATABASE_URL: isolatedUrl.href, TEST_SCHEMA_NAME: schemaName },
      }
    );
    console.log(run.stdout);
    if (run.stderr) console.error(run.stderr);
    if (run.status !== 0) throw new Error("Child process failed with status " + run.status);
  } finally {
    await rootPrisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE;`);
    await rootPrisma.$disconnect();
    console.log(`[SPAWN] Dropped schema: ${schemaName}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
