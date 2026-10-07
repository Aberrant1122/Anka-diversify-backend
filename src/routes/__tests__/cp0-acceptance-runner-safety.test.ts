import path from "path";
import { spawnSync } from "child_process";

type TestPrisma = { $executeRawUnsafe: (sql: string) => Promise<unknown> };
type Runner = {
  validateSafeTestDatabase: (value?: string) => URL;
  assertSafeSchema: (value: string) => string;
  sanitizeOutput: (value: string, url: URL) => string;
  runSuiteWithIsolatedSchema: (
    prisma: TestPrisma, url: URL, prefix: string, suite: string,
    execute: (command: string, isolatedUrl: string, baseUrl: URL) => void,
  ) => Promise<{ schemaName: string; suitePattern: string }>;
};

const runner: Runner = require(path.resolve(__dirname, "../../../scripts/run-cp0-acceptance.js"));
const safeUrl = () => runner.validateSafeTestDatabase("postgresql://test-user:test-password@localhost:5432/cp0_test");

describe("CP0 acceptance runner safety", () => {
  test("CLI fails closed without the explicit URL even when DATABASE_URL exists", () => {
    const script = path.resolve(__dirname, "../../../scripts/run-cp0-acceptance.js");
    const result = spawnSync(process.execPath, [script], {
      env: { ...process.env, CP0_TEST_DATABASE_URL: "", DATABASE_URL: "postgresql://dummy:sentinel-password@localhost:5432/dev_db" },
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("CP0_TEST_DATABASE_URL is required");
    expect(result.stderr).not.toContain("sentinel-password");
  });

  test("CLI rejects a remote URL before migration and does not emit credentials", () => {
    const script = path.resolve(__dirname, "../../../scripts/run-cp0-acceptance.js");
    const result = spawnSync(process.execPath, [script], {
      env: { ...process.env, CP0_TEST_DATABASE_URL: "postgresql://dummy:sentinel-password@remote.example:5432/cp0_test" },
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("requires local PostgreSQL");
    expect(result.stderr).not.toContain("sentinel-password");
    expect(result.stdout).not.toContain("Applying migrations");
  });

  test("requires an explicit test URL and rejects remote, production-like, and malformed URLs", () => {
    expect(() => runner.validateSafeTestDatabase(undefined)).toThrow("CP0_TEST_DATABASE_URL is required");
    expect(() => runner.validateSafeTestDatabase("postgresql://user:secret@remote.example/cp0_test")).toThrow("local PostgreSQL");
    expect(() => runner.validateSafeTestDatabase("postgresql://user:secret@localhost/prod_database")).toThrow("production-like");
    expect(() => runner.validateSafeTestDatabase("not a URL secret"))
      .toThrow("not a valid URL");
    expect(() => runner.validateSafeTestDatabase("postgresql://user:secret@localhost/cp0_test?schema=other"))
      .toThrow("public schema");
  });

  test("accepts a local test URL, validates schema identifiers, and redacts credentials", () => {
    const url = safeUrl();
    expect(url.hostname).toBe("localhost");
    expect(runner.assertSafeSchema("planning_checkpoint_cp0_123_abcdef"))
      .toBe('"planning_checkpoint_cp0_123_abcdef"');
    expect(() => runner.assertSafeSchema("public")).toThrow("unsafe");
    expect(() => runner.assertSafeSchema('planning_checkpoint_x";DROP SCHEMA public;--'))
      .toThrow("unsafe");
    const output = runner.sanitizeOutput(`Failure ${url.href} test-password`, url);
    expect(output).not.toContain("test-password");
    expect(output).not.toContain(url.href);
  });

  test.each([
    [false, false, true, false],
    [true, false, false, true],
    [false, true, false, true],
    [true, true, false, true],
  ])("test failure=%s cleanup failure=%s gives success=%s failure=%s", async (
    testFails, cleanupFails, succeeds, fails,
  ) => {
    const executed: string[] = [];
    const prisma: TestPrisma = {
      $executeRawUnsafe: async (sql) => {
        expect(sql).toMatch(/^DROP SCHEMA IF EXISTS "planning_checkpoint_cp0_[a-z0-9_]+" CASCADE$/);
        if (cleanupFails) throw new Error("simulated cleanup failure");
      },
    };
    const execute = (command: string) => {
      executed.push(command);
      if (testFails && command.startsWith("npx jest")) throw new Error("simulated test failure");
    };
    const operation = runner.runSuiteWithIsolatedSchema(
      prisma, safeUrl(), "planning_checkpoint_cp0", "sample.test.ts", execute,
    );
    if (fails) {
      await expect(operation).rejects.toThrow();
    } else if (succeeds) {
      await expect(operation).resolves.toMatchObject({ suitePattern: "sample.test.ts" });
    }
    expect(executed).toHaveLength(2);
  });

  test("reports both test and cleanup failure without hiding the first", async () => {
    const prisma: TestPrisma = { $executeRawUnsafe: async () => { throw new Error("cleanup"); } };
    const execute = (command: string) => {
      if (command.startsWith("npx jest")) throw new Error("test failed");
    };
    await expect(runner.runSuiteWithIsolatedSchema(prisma, safeUrl(), "planning_checkpoint_cp0", "sample.test.ts", execute))
      .rejects.toMatchObject({ errors: [{ message: "test failed" }, { message: expect.stringContaining("Cleanup failed") }] });
  });
});
