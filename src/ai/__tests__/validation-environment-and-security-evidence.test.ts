import fs from "fs";
import path from "path";
import os from "os";
import { ValidationEnvironmentPolicy } from "../validation/ValidationEnvironmentPolicy";
import { ValidationRunner } from "../validation/ValidationRunner";
import { ErrorClassifier } from "../validation/ErrorClassifier";
import { SecurityPolicy } from "../security/SecurityPolicy";
import { SecurityAuditor } from "../review/SecurityAuditor";
import { SelfHealingEngine } from "../repair/SelfHealingEngine";
import { FileSystemStateManager } from "../validation/FileSystemStateManager";
import { AgentFileChange, ExecutionContract } from "../../types";
import * as sharedUtils from "../shared/utils";

describe("Target Build Environment Isolation + Security Finding Evidence (Section 11 A–Q)", () => {
  let tempDir: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "anka-val-env-test-"));
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  const baseContract: ExecutionContract = {
    goal: "Implement calculator",
    taskType: "NEW_FEATURE",
    risk: "LOW",
    estimatedComplexity: "SMALL",
    pipeline: "REPOSITORY",
    environment: "REACT_TS",
    repositoryRequired: true,
    expectedFiles: ["app/page.tsx"],
    validationType: "TYPESCRIPT_BUILD",
    targetPaths: ["app"],
    allowedActions: ["create", "modify"],
    forbiddenActions: [],
    maxFiles: 5,
    searchScope: ["app"],
    contextScope: ["app/page.tsx"],
    diffCriticEnabled: true,
  };

  // ── TEST A: Target Next build does not inherit custom ANKA NODE_ENV ────────
  test("TEST A: Target Next build does not inherit custom ANKA NODE_ENV", () => {
    process.env.NODE_ENV = "development";
    const env = ValidationEnvironmentPolicy.getSanitizedEnv("npm run build");
    expect(env.NODE_ENV).toBe("production");
    expect(env.NODE_ENV).not.toBe("development");
  });

  // ── TEST B: Next production build receives valid production environment ────
  test("TEST B: Next production build receives valid production environment", () => {
    const env = ValidationEnvironmentPolicy.getSanitizedEnv("next build");
    expect(env.NODE_ENV).toBe("production");
  });

  // ── TEST C: PATH/node/npm remain resolvable after environment sanitization ──
  test("TEST C: PATH/node/npm remain resolvable in sanitized environment", () => {
    const env = ValidationEnvironmentPolicy.getSanitizedEnv("npm run build");
    const pathKey = Object.keys(env).find((k) => k.toLowerCase() === "path");
    expect(pathKey).toBeDefined();
    expect(env[pathKey!]).toBeDefined();
    expect(env[pathKey!]).toBe(process.env[pathKey!]);
  });

  // ── TEST D: ANKA secret env variables are not forwarded to repo scripts ─────
  test("TEST D: ANKA secret env variables are not forwarded to repository scripts", () => {
    process.env.OPENAI_API_KEY = "sk-secret-test-key-12345";
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/db";
    process.env.JWT_SECRET = "super-jwt-secret-xyz";
    process.env.ENCRYPTION_KEY = "32char-encryption-key-secret-123";

    const env = ValidationEnvironmentPolicy.getSanitizedEnv("npm run build");
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.JWT_SECRET).toBeUndefined();
    expect(env.ENCRYPTION_KEY).toBeUndefined();
  });

  // ── TEST E: Stderr warning + exit code 0 remains build success ───────────────
  test("TEST E: Stderr warning with exit code 0 remains build success", async () => {
    const dummyScript = "console.warn('Warning: Each child in a list should have a unique key prop.'); process.exit(0);";
    const scriptPath = path.join(tempDir, "script.js");
    fs.writeFileSync(scriptPath, dummyScript);

    const result = await ValidationRunner.validateWithShell(
      [],
      tempDir,
      [`node "${scriptPath}"`],
    );

    expect(result.success).toBe(true);
    expect(result.errors).toBe("");
    expect(result.warnings).toBeDefined();
    expect(result.warnings?.length).toBeGreaterThan(0);
  });

  // ── TEST F: Actual exit code 1 remains build failure ────────────────────────
  test("TEST F: Actual exit code 1 remains build failure", async () => {
    const dummyScript = "console.error('Fatal compile error: TS2304'); process.exit(1);";
    const scriptPath = path.join(tempDir, "fail.js");
    fs.writeFileSync(scriptPath, dummyScript);

    const result = await ValidationRunner.validateWithShell(
      [],
      tempDir,
      [`node "${scriptPath}"`],
    );

    expect(result.success).toBe(false);
    expect(result.errors).toContain("exit code 1");
  });

  // ── TEST G: ENVIRONMENT/INFRA failure does not enter generic SelfHealing ────
  test("TEST G: ENVIRONMENT/INFRA failure stops immediately without generic SelfHealing", async () => {
    const errorMsg = '⚠ You are using a non-standard "NODE_ENV" value in your environment. Next.js expects "production".';
    const classification = ErrorClassifier.classify(errorMsg);
    expect(classification.type).toBe("ENVIRONMENT");
    expect(classification.isInfrastructure).toBe(true);

    jest.spyOn(ValidationRunner, "validateWithShell").mockResolvedValue({
      success: false,
      errors: errorMsg,
    });

    const result = await SelfHealingEngine.runSelfHealingLoop(
      [{ path: "app/page.tsx", action: "modify", content: "export default function Page() {}", description: "page" }],
      tempDir,
      ["npm run build"],
      "prompt",
      "fix",
      new FileSystemStateManager(),
      "proj-1",
      undefined,
      { files: [{ path: "app/page.tsx", action: "modify", dependencies: [], description: "page" }], totalFiles: 1, manifestVersion: "1.0.0" },
      baseContract,
    );

    expect(result.success).toBe(false);
    expect(result.errorType).toBe("ENVIRONMENT");
    expect(result.infrastructureError).toBe(true);
    expect(result.attempts).toBe(1);
  });

  // ── TEST H: Repeated repair proposal stops immediately ──────────────────────
  test("TEST H: Repeated repair proposal stops immediately with REPEATED_REPAIR_PROPOSAL", async () => {
    let buildCalls = 0;
    jest.spyOn(ValidationRunner, "validateWithShell").mockImplementation(async () => {
      buildCalls++;
      return { success: false, errors: "Build error TS2304: Cannot find name 'x'" };
    });

    const mockOpenAI = {
      chat: {
        completions: {
          create: jest.fn().mockResolvedValue({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    changes: [
                      {
                        path: "app/page.tsx",
                        action: "modify",
                        description: "identical repair",
                        edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }],
                      },
                    ],
                  }),
                },
              },
            ],
          }),
        },
      },
    };
    jest.spyOn(sharedUtils, "getOpenAI").mockReturnValue(mockOpenAI as any);

    const pagePath = path.join(tempDir, "app", "page.tsx");
    fs.mkdirSync(path.join(tempDir, "app"), { recursive: true });
    fs.writeFileSync(pagePath, "const a = 1;\n");

    const result = await SelfHealingEngine.runSelfHealingLoop(
      [{ path: "app/page.tsx", action: "modify", content: "const a = 1;\n", description: "page" }],
      tempDir,
      ["npm run build"],
      "prompt",
      "fix",
      new FileSystemStateManager(),
      "proj-1",
      undefined,
      { files: [{ path: "app/page.tsx", action: "modify", dependencies: [], description: "page" }], totalFiles: 1, manifestVersion: "1.0.0" },
      baseContract,
    );

    // Stops after repeated proposal without running 5 generic attempts
    expect(result.success).toBe(false);
    expect(result.errorType).toBe("REPEATED_REPAIR_PROPOSAL");
    expect(result.attempts).toBeLessThan(5);
  });

  // ── TEST I: buildAttempts counts actual builds only ─────────────────────────
  test("TEST I: buildAttempts telemetry tracks actual shell build attempts accurately", async () => {
    let buildCount = 0;
    jest.spyOn(ValidationRunner, "validateWithShell").mockImplementation(async () => {
      buildCount++;
      if (buildCount === 1) return { success: false, errors: "Initial build fail TS2304" };
      return { success: true, errors: "" };
    });

    const mockOpenAI = {
      chat: {
        completions: {
          create: jest.fn().mockResolvedValue({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    changes: [
                      {
                        path: "app/page.tsx",
                        action: "modify",
                        description: "fix",
                        edits: [{ oldText: "let a;", newText: "let a = 1;" }],
                      },
                    ],
                  }),
                },
              },
            ],
          }),
        },
      },
    };
    jest.spyOn(sharedUtils, "getOpenAI").mockReturnValue(mockOpenAI as any);

    const pagePath = path.join(tempDir, "app", "page.tsx");
    fs.mkdirSync(path.join(tempDir, "app"), { recursive: true });
    fs.writeFileSync(pagePath, "let a;\n");

    const result = await SelfHealingEngine.runSelfHealingLoop(
      [{ path: "app/page.tsx", action: "modify", content: "let a;\n", description: "page" }],
      tempDir,
      ["npm run build"],
      "prompt",
      "fix",
      new FileSystemStateManager(),
      "proj-1",
      undefined,
      { files: [{ path: "app/page.tsx", action: "modify", dependencies: [], description: "page" }], totalFiles: 1, manifestVersion: "1.0.0" },
      baseContract,
    );

    expect(result.buildAttemptsCount).toBe(2);
    expect(result.success).toBe(true);
  });

  // ── TEST J: Explicit eval() remains security failure ─────────────────────────
  test("TEST J: Explicit eval() is flagged as a deterministic security failure", () => {
    const code = "export function run(expr: string) { return eval(expr); }";
    const res = SecurityPolicy.checkCode(code, "lib/calc.ts");
    expect(res.safe).toBe(false);
    expect(res.violations.some((v) => v.reason === "UNSAFE_EVAL")).toBe(true);
  });

  // ── TEST K: new Function() remains security failure ──────────────────────────
  test("TEST K: new Function() is flagged as a deterministic security failure", () => {
    const code = "export function run(expr: string) { return new Function('return ' + expr)(); }";
    const res = SecurityPolicy.checkCode(code, "lib/calc.ts");
    expect(res.safe).toBe(false);
    expect(res.violations.some((v) => v.reason === "UNSAFE_FUNCTION_CONSTRUCTOR")).toBe(true);
  });

  // ── TEST L: mathjs.evaluate remains security failure under current policy ────
  test("TEST L: mathjs.evaluate remains security failure", () => {
    const code = "import { evaluate } from 'mathjs';\nexport function calc(s: string) { return evaluate(s); }";
    const res = SecurityPolicy.checkCode(code, "lib/calc.ts");
    expect(res.safe).toBe(false);
    expect(res.violations.some((v) => v.reason === "UNSAFE_MATHJS_EVALUATE")).toBe(true);
  });

  // ── TEST M: Allowlisted arithmetic switch/parser does NOT trigger security failure ──
  test("TEST M: Allowlisted arithmetic switch/parser does NOT trigger dynamic execution failure", () => {
    const safeCalculator = `'use client';\nexport function calculate(a: number, b: number, op: string) {\n  switch(op) {\n    case '+': return a + b;\n    case '-': return a - b;\n    case '*': return a * b;\n    case '/': return b !== 0 ? a / b : NaN;\n    default: return NaN;\n  }\n}`;
    const res = SecurityPolicy.checkCode(safeCalculator, "components/Calculator.tsx");
    expect(res.safe).toBe(true);
    expect(res.violations).toHaveLength(0);
    expect(SecurityPolicy.hasDangerousPrimitive(safeCalculator)).toBe(false);
  });

  // ── TEST N: LLM security finding without a concrete dangerous sink is marked unsupported ──
  test("TEST N: LLM security finding without a concrete dangerous sink is marked unsupported", async () => {
    const safeCode = `'use client';\nexport function calculateResult(expr: string) {\n  const [a, op, b] = expr.split(' ');\n  if (op === '+') return Number(a) + Number(b);\n  return 0;\n}`;
    const changes: AgentFileChange[] = [
      {
        path: "components/Calculator.tsx",
        content: safeCode,
        action: "create",
        description: "safe calculator",
      },
    ];

    const mockOpenAI = {
      chat: {
        completions: {
          create: jest.fn().mockImplementation(async (opts) => {
            if (opts.messages[0].content.includes("Reflection Agent") || opts.messages[0].content.includes("Critique")) {
              return { choices: [{ message: { content: JSON.stringify({ score: 0.95 }) } }] };
            }
            // LLM Review hallucinates eval-like behavior
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      passed: false,
                      riskLevel: "HIGH",
                      vulnerabilities: [
                        {
                          file: "components/Calculator.tsx",
                          issue: "calculateResult uses eval-like behavior by parsing and executing arithmetic expressions directly from user input",
                          severity: "HIGH",
                        },
                      ],
                    }),
                  },
                },
              ],
            };
          }),
        },
      },
    };
    jest.spyOn(sharedUtils, "getOpenAI").mockReturnValue(mockOpenAI as any);

    const audit = await SecurityAuditor.runReflectionAndSecurityAudit(changes);
    // Unsupported finding is downgraded and does not fail securityPass
    expect(audit.securityPass).toBe(true);
    expect(audit.vulnerabilities?.[0].issue).toContain("[UNSUPPORTED_SECURITY_FINDING]");
    expect(audit.vulnerabilities?.[0].severity).toBe("LOW");
  });

  // ── TEST O: LLM security finding with real source -> sink evidence remains valid ──
  test("TEST O: LLM security finding with real dangerous sink remains valid HIGH/CRITICAL", async () => {
    const dangerousCode = `export function executeUserCode(userStr: string) { eval(userStr); }`;
    const changes: AgentFileChange[] = [
      {
        path: "components/Calculator.tsx",
        content: dangerousCode,
        action: "create",
        description: "unsafe code",
      },
    ];

    const mockOpenAI = {
      chat: {
        completions: {
          create: jest.fn().mockImplementation(async (opts) => {
            if (opts.messages[0].content.includes("Reflection Agent") || opts.messages[0].content.includes("Critique")) {
              return { choices: [{ message: { content: JSON.stringify({ score: 0.90 }) } }] };
            }
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      passed: false,
                      riskLevel: "HIGH",
                      vulnerabilities: [
                        {
                          file: "components/Calculator.tsx",
                          issue: "Use of eval() on user input",
                          severity: "HIGH",
                        },
                      ],
                    }),
                  },
                },
              ],
            };
          }),
        },
      },
    };
    jest.spyOn(sharedUtils, "getOpenAI").mockReturnValue(mockOpenAI as any);

    const audit = await SecurityAuditor.runReflectionAndSecurityAudit(changes);
    expect(audit.securityPass).toBe(false);
    expect(audit.riskLevel).toBe("HIGH");
  });
});
