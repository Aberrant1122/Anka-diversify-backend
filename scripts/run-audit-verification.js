const { PrismaClient } = require("@prisma/client");
const { validateSafeTestDatabase, runSuiteWithIsolatedSchema, sanitizeOutput } = require("./run-cp0-acceptance");

async function main() {
  const baseUrl = validateSafeTestDatabase(process.env.CP0_TEST_DATABASE_URL);
  const rootPrisma = new PrismaClient({ datasources: { db: { url: baseUrl.href } } });
  try {
    await runSuiteWithIsolatedSchema(
      rootPrisma,
      baseUrl,
      "planning_checkpoint_audit",
      "src/services/__tests__/audit-independent-verification.test.ts",
    );
  } finally {
    await rootPrisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(`[Independent Audit Verification] ${sanitizeOutput(error.message, { href: "", username: "", password: "" })}`);
  process.exitCode = 1;
});
