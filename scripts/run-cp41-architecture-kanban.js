const { PrismaClient } = require("@prisma/client");
const { validateSafeTestDatabase, runSuiteWithIsolatedSchema, sanitizeOutput } = require("./run-cp0-acceptance");

async function main() {
  const baseUrl = validateSafeTestDatabase(process.env.CP0_TEST_DATABASE_URL);
  const rootPrisma = new PrismaClient({ datasources: { db: { url: baseUrl.href } } });
  try {
    await runSuiteWithIsolatedSchema(
      rootPrisma,
      baseUrl,
      "planning_checkpoint_1b_cp41",
      "src/services/__tests__/cp41-architecture-to-kanban.test.ts",
    );
  } finally {
    await rootPrisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(`[CP4.1 Architecture-to-Kanban Integration] ${sanitizeOutput(error.message, { href: "", username: "", password: "" })}`);
  process.exitCode = 1;
});
