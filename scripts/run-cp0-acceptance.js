const { spawnSync } = require("child_process");
const crypto = require("crypto");
const { PrismaClient } = require("@prisma/client");

const SCHEMA_PATTERN = /^planning_checkpoint_[a-z0-9_]+$/;
const SUITES = [
  ["planning_checkpoint_cp0", "src/routes/__tests__/cp0-isolated-acceptance.test.ts"],
  ["planning_checkpoint_1b", "src/services/__tests__/planning-requirements-lifecycle.test.ts"],
  ["planning_checkpoint_1a", "src/services/__tests__/planning-data-foundation.test.ts"],
];

function validateSafeTestDatabase(value) {
  if (!value) throw new Error("CP0_TEST_DATABASE_URL is required for CP0 acceptance.");
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("CP0_TEST_DATABASE_URL is not a valid URL.");
  }
  if (!["postgresql:", "postgres:"].includes(parsed.protocol)) {
    throw new Error("CP0 acceptance requires a PostgreSQL URL.");
  }
  if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname.toLowerCase())) {
    throw new Error("CP0 acceptance requires local PostgreSQL.");
  }
  let database;
  let username;
  try {
    database = decodeURIComponent(parsed.pathname.slice(1));
    username = decodeURIComponent(parsed.username);
  } catch {
    throw new Error("CP0_TEST_DATABASE_URL has invalid encoding.");
  }
  if (!database || /prod|railway|supabase/i.test(`${database} ${username}`)) {
    throw new Error("CP0 acceptance rejects production-like database identifiers.");
  }
  if (parsed.searchParams.has("schema") && parsed.searchParams.get("schema") !== "public") {
    throw new Error("CP0 acceptance requires the base database URL to use the public schema.");
  }
  parsed.searchParams.delete("schema");
  return parsed;
}

function assertSafeSchema(schemaName) {
  if (!SCHEMA_PATTERN.test(schemaName)) {
    throw new Error("CP0 acceptance rejects an unsafe checkpoint schema name.");
  }
  return `"${schemaName}"`;
}

function sanitizeOutput(value, databaseUrl) {
  let output = String(value || "");
  const decoded = (value) => { try { return decodeURIComponent(value); } catch { return value; } };
  const secrets = [databaseUrl.href, databaseUrl.username, databaseUrl.password,
    decoded(databaseUrl.username), decoded(databaseUrl.password)]
    .filter(Boolean);
  for (const secret of secrets) output = output.split(secret).join("<redacted>");
  return output.replace(/postgres(?:ql)?:\/\/[^\s'"`]+/gi, "<redacted PostgreSQL URL>");
}

function runCommand(command, isolatedUrl, baseUrl) {
  const result = spawnSync(command, {
    shell: true,
    env: { ...process.env, DATABASE_URL: isolatedUrl },
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  process.stdout.write(sanitizeOutput(result.stdout, baseUrl));
  process.stderr.write(sanitizeOutput(result.stderr, baseUrl));
  if (result.error || result.status !== 0) {
    throw new Error(`Command failed: ${command}`);
  }
}

async function dropSchemaSafely(rootPrisma, schemaName) {
  const quotedSchema = assertSafeSchema(schemaName);
  await rootPrisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
  console.log(`[CP0 Acceptance] Dropped isolated schema: ${schemaName}`);
}

async function runSuiteWithIsolatedSchema(rootPrisma, baseUrl, schemaPrefix, suitePattern, execute = runCommand) {
  assertSafeSchema(schemaPrefix);
  const schemaName = `${schemaPrefix}_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
  assertSafeSchema(schemaName);
  const isolatedUrl = new URL(baseUrl.href);
  isolatedUrl.searchParams.set("schema", schemaName);
  console.log(`[CP0 Acceptance] Isolated schema: ${schemaName}; suite: ${suitePattern}`);

  let primaryFailure;
  try {
    execute("npx prisma migrate deploy", isolatedUrl.href, baseUrl);
    execute(`npx jest ${suitePattern} --runInBand`, isolatedUrl.href, baseUrl);
  } catch (error) {
    primaryFailure = error;
  } finally {
    try {
      await dropSchemaSafely(rootPrisma, schemaName);
    } catch (cleanupFailure) {
      const safeCleanupFailure = new Error(`Cleanup failed for ${schemaName}`, { cause: cleanupFailure });
      if (primaryFailure) {
        throw new AggregateError([primaryFailure, safeCleanupFailure], `Suite failed and cleanup failed for ${schemaName}`);
      }
      throw safeCleanupFailure;
    }
  }
  if (primaryFailure) throw primaryFailure;
  console.log(`[CP0 Acceptance] Passed: ${suitePattern}; cleanup succeeded`);
  return { schemaName, suitePattern };
}

async function main() {
  const baseUrl = validateSafeTestDatabase(process.env.CP0_TEST_DATABASE_URL);
  const rootPrisma = new PrismaClient({ datasources: { db: { url: baseUrl.href } } });
  const results = [];
  try {
    for (const [schemaPrefix, suitePattern] of SUITES) {
      results.push(await runSuiteWithIsolatedSchema(rootPrisma, baseUrl, schemaPrefix, suitePattern));
    }
  } finally {
    await rootPrisma.$disconnect();
  }
  console.log(`CP0 ACCEPTANCE PASSED: ${results.length} suites migrated, tested, and cleaned up.`);
  return results;
}

if (require.main === module) {
  main().catch((error) => {
    const failures = error instanceof AggregateError ? error.errors : [error];
    for (const failure of failures) {
      // A driver exception can contain connection credentials.
      console.error(`[CP0 Acceptance] ${sanitizeOutput(failure.message, { href: "", username: "", password: "" })}`);
    }
    process.exitCode = 1;
  });
}

module.exports = { validateSafeTestDatabase, assertSafeSchema, sanitizeOutput, runSuiteWithIsolatedSchema, main };
