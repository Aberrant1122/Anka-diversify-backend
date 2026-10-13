const { PrismaClient } = require("@prisma/client");
const { validateSafeTestDatabase, runSuiteWithIsolatedSchema, sanitizeOutput } = require("./run-cp0-acceptance");

async function main() {
  const baseUrl = validateSafeTestDatabase(process.env.CP0_TEST_DATABASE_URL);
  const rootPrisma = new PrismaClient({ datasources: { db: { url: baseUrl.href } } });
  try {
    await runSuiteWithIsolatedSchema(
      rootPrisma,
      baseUrl,
      "planning_checkpoint_live_brief_authority",
      "src/services/__tests__/live-brief-authority-postgres.test.ts",
    );
    await runSuiteWithIsolatedSchema(
      rootPrisma,
      baseUrl,
      "planning_checkpoint_1c_c",
      "src/services/__tests__/planning-initial-requirements-generation.test.ts",
    );
  } finally {
    await rootPrisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(`[Live Brief Authority Integration] ${sanitizeOutput(error.message, { href: "", username: "", password: "" })}`);
  process.exitCode = 1;
});
