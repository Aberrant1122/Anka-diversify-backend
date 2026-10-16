const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { PrismaClient } = require("@prisma/client");
const { validateSafeTestDatabase, assertSafeSchema } = require("../scripts/run-cp0-acceptance");

async function testSetup() {
  const baseUrl = validateSafeTestDatabase(process.env.CP0_TEST_DATABASE_URL);
  const schemaName = `planning_checkpoint_1b_cp41_test_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
  assertSafeSchema(schemaName);

  const isolatedUrl = new URL(baseUrl.href);
  isolatedUrl.searchParams.set("schema", schemaName);

  console.log(`[TEST SETUP] Running migration on isolated schema: ${schemaName}`);
  const migration = spawnSync("npx prisma migrate deploy", {
    shell: true,
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: isolatedUrl.href },
  });
  if (migration.status !== 0) {
    throw new Error(migration.stderr || migration.stdout || "Migration failed");
  }

  process.env.DATABASE_URL = isolatedUrl.href;
  const rootPrisma = new PrismaClient({ datasources: { db: { url: baseUrl.href } } });
  const prisma = new PrismaClient({ datasources: { db: { url: isolatedUrl.href } } });

  try {
    const user = await prisma.user.create({
      data: {
        id: "test-owner-id",
        email: "owner@anka.test",
        name: "Test Owner",
        password: "unused",
      },
    });
    console.log(`[TEST SETUP] User created: ${user.id}`);
  } finally {
    await prisma.$disconnect();
    await rootPrisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE;`);
    await rootPrisma.$disconnect();
    console.log(`[TEST SETUP] Dropped schema: ${schemaName}`);
  }
}

testSetup().catch((err) => {
  console.error(err);
  process.exit(1);
});
