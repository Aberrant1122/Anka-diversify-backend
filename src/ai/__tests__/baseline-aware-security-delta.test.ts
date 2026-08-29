import { SecurityPolicy } from "../security/SecurityPolicy";
import { SecurityAuditor } from "../review/SecurityAuditor";
import { FileSystemStateManager } from "../validation/FileSystemStateManager";
import { getOpenAI } from "../shared/utils";
import { AgentFileChange } from "../shared/types";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

jest.mock("../shared/utils", () => ({
  getOpenAI: jest.fn(),
  formatMs: (ms: number) => `${Math.round(ms)}ms`,
}));

describe("Baseline-Aware Security Delta & Provenance Gating", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  // =========================================================================
  // Section 1: SecurityPolicy.checkChanges Provenance Tests
  // =========================================================================

  describe("Section 1: SecurityPolicy.checkChanges Provenance Tests", () => {
    const baselineCalcContent = `'use client';\nimport * as math from 'mathjs';\nexport function Calculator() {\n  const res = math.evaluate('2 + 2');\n  return <div>{res}</div>;\n}\n`;

    test("1. Unchanged baseline math.evaluate -> safe: true, provenance: PRE_EXISTING_BASELINE", () => {
      const repairedCalcContent = `'use client';\nimport React from 'react';\nimport * as math from 'mathjs';\nexport function Calculator() {\n  const res = math.evaluate('2 + 2');\n  return React.createElement('div', null, res);\n}\n`;

      const changes: AgentFileChange[] = [
        {
          path: "components/Calculator.tsx",
          content: repairedCalcContent,
          action: "modify",
          description: "Fixed React.createElement",
        },
      ];

      const result = SecurityPolicy.checkChanges(changes, {
        "components/Calculator.tsx": baselineCalcContent,
      });

      expect(result.safe).toBe(true);
      expect(result.violations.length).toBe(1);
      expect(result.violations[0].reason).toBe("UNSAFE_MATHJS_EVALUATE");
      expect(result.violations[0].provenance).toBe("PRE_EXISTING_BASELINE");
    });

    test("2. Newly introduced math.evaluate -> safe: false, provenance: INTRODUCED_BY_AGENT", () => {
      const cleanBaseline = `export function compute(a: number, b: number) { return a + b; }`;
      const evilContent = `import * as math from 'mathjs';\nexport function compute(expr: string) { return math.evaluate(expr); }`;

      const changes: AgentFileChange[] = [
        {
          path: "src/utils.ts",
          content: evilContent,
          action: "modify",
          description: "Added dynamic evaluator",
        },
      ];

      const result = SecurityPolicy.checkChanges(changes, {
        "src/utils.ts": cleanBaseline,
      });

      expect(result.safe).toBe(false);
      expect(result.violations.length).toBe(1);
      expect(result.violations[0].reason).toBe("UNSAFE_MATHJS_EVALUATE");
      expect(result.violations[0].provenance).toBe("INTRODUCED_BY_AGENT");
    });

    test("3. Newly introduced eval() -> safe: false, provenance: INTRODUCED_BY_AGENT", () => {
      const cleanBaseline = `export function run() {}`;
      const evalContent = `export function run(code: string) { return eval(code); }`;

      const changes: AgentFileChange[] = [
        {
          path: "src/runner.ts",
          content: evalContent,
          action: "modify",
          description: "Added eval runner",
        },
      ];

      const result = SecurityPolicy.checkChanges(changes, {
        "src/runner.ts": cleanBaseline,
      });

      expect(result.safe).toBe(false);
      expect(result.violations.length).toBe(1);
      expect(result.violations[0].reason).toBe("UNSAFE_EVAL");
      expect(result.violations[0].provenance).toBe("INTRODUCED_BY_AGENT");
    });

    test("4. Worsened math.evaluate (occurrences increased 1 -> 2) -> safe: false, provenance: WORSENED_BY_AGENT", () => {
      const worsenedContent = `'use client';\nimport * as math from 'mathjs';\nexport function Calculator() {\n  const a = math.evaluate('1+1');\n  const b = math.evaluate('2+2');\n  return <div>{a + b}</div>;\n}\n`;

      const changes: AgentFileChange[] = [
        {
          path: "components/Calculator.tsx",
          content: worsenedContent,
          action: "modify",
          description: "Added second evaluate call",
        },
      ];

      const result = SecurityPolicy.checkChanges(changes, {
        "components/Calculator.tsx": baselineCalcContent,
      });

      expect(result.safe).toBe(false);
      expect(result.violations.length).toBe(1);
      expect(result.violations[0].reason).toBe("UNSAFE_MATHJS_EVALUATE");
      expect(result.violations[0].provenance).toBe("WORSENED_BY_AGENT");
    });

    test("5. Multiple findings: 1 pre-existing + 1 new -> safe: false", () => {
      const repairedCalcContent = `'use client';\nimport * as math from 'mathjs';\nexport function Calculator() {\n  const res = math.evaluate('2 + 2');\n  return <div>{res}</div>;\n}\n`;
      const evalContent = `export function run(code: string) { return eval(code); }`;

      const changes: AgentFileChange[] = [
        {
          path: "components/Calculator.tsx",
          content: repairedCalcContent,
          action: "modify",
          description: "Unchanged evaluate",
        },
        {
          path: "src/runner.ts",
          content: evalContent,
          action: "modify",
          description: "Introduced eval",
        },
      ];

      const result = SecurityPolicy.checkChanges(changes, {
        "components/Calculator.tsx": baselineCalcContent,
        "src/runner.ts": `export function run() {}`,
      });

      expect(result.safe).toBe(false);
      expect(result.violations.length).toBe(2);
      expect(result.violations.find((v) => v.path === "components/Calculator.tsx")?.provenance).toBe("PRE_EXISTING_BASELINE");
      expect(result.violations.find((v) => v.path === "src/runner.ts")?.provenance).toBe("INTRODUCED_BY_AGENT");
    });
  });

  // =========================================================================
  // Section 2: SecurityAuditor.runReflectionAndSecurityAudit Reconciliation Tests
  // =========================================================================

  describe("Section 2: SecurityAuditor.runReflectionAndSecurityAudit Reconciliation Tests", () => {
    const baselineCalcContent = `'use client';\nimport * as math from 'mathjs';\nexport function Calculator() {\n  const res = math.evaluate('2 + 2');\n  return <div>{res}</div>;\n}\n`;

    test("Part R (Regression Test A): Baseline math.evaluate + LLM natural language finding -> reconciled as PRE_EXISTING_BASELINE -> llmReviewPass: true, securityPass: true", async () => {
      (getOpenAI as unknown as jest.Mock).mockReturnValue({
        chat: {
          completions: {
            create: jest.fn().mockResolvedValue({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      score: 8.5,
                      passed: false,
                      riskLevel: "HIGH",
                      vulnerabilities: [
                        {
                          file: "components/Calculator.tsx",
                          issue: "The use of 'math.evaluate' with user input can lead to code injection vulnerabilities if the input is not properly sanitized.",
                          severity: "HIGH",
                        },
                      ],
                    }),
                  },
                },
              ],
            }),
          },
        },
      });

      const repairedCalcContent = `'use client';\nimport React from 'react';\nimport * as math from 'mathjs';\nexport function Calculator() {\n  const res = math.evaluate('2 + 2');\n  return React.createElement('div', null, res);\n}\n`;

      const changes: AgentFileChange[] = [
        {
          path: "components/Calculator.tsx",
          content: repairedCalcContent,
          action: "modify",
          description: "Fixed syntax",
        },
      ];

      const audit = await SecurityAuditor.runReflectionAndSecurityAudit(changes, (p) =>
        p.includes("Calculator.tsx") ? baselineCalcContent : null,
      );

      expect(audit.securityPass).toBe(true);
      expect(audit.passed).toBe(true);
      expect(audit.riskLevel).toBe("HIGH");
      expect(audit.vulnerabilities?.length).toBe(1);
      expect(audit.vulnerabilities?.[0].provenance).toBe("PRE_EXISTING_BASELINE");
      expect(audit.summary).toContain("Deterministic Policy: PASS");
      expect(audit.summary).toContain("LLM Review: PASS");
      expect(audit.summary).toContain("[PRE_EXISTING_BASELINE]");
    });

    test("Part S (Regression Test B): Baseline does not contain math.evaluate, agent adds it -> LLM HIGH remains blocking -> securityPass: false", async () => {
      (getOpenAI as unknown as jest.Mock).mockReturnValue({
        chat: {
          completions: {
            create: jest.fn().mockResolvedValue({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      score: 8.5,
                      passed: false,
                      riskLevel: "HIGH",
                      vulnerabilities: [
                        {
                          file: "src/utils.ts",
                          issue: "math.evaluate with dynamic string execution.",
                          severity: "HIGH",
                        },
                      ],
                    }),
                  },
                },
              ],
            }),
          },
        },
      });

      const changes: AgentFileChange[] = [
        {
          path: "src/utils.ts",
          content: `import * as math from 'mathjs';\nexport const run = (x: string) => math.evaluate(x);`,
          action: "modify",
          description: "added math evaluate",
        },
      ];

      const audit = await SecurityAuditor.runReflectionAndSecurityAudit(changes, () => `export const run = () => 0;`);

      expect(audit.securityPass).toBe(false);
      expect(audit.passed).toBe(false);
      expect(audit.summary).toContain("Deterministic Policy: FAIL");
      expect(audit.summary).toContain("LLM Review: FLAGGED");
      expect(audit.vulnerabilities?.[0].provenance).toBe("INTRODUCED_BY_AGENT");
    });

    test("Part T (Regression Test C): Baseline contains issue A in File 1, agent introduces issue B in File 2 -> B does not inherit baseline provenance -> securityPass: false", async () => {
      (getOpenAI as unknown as jest.Mock).mockReturnValue({
        chat: {
          completions: {
            create: jest.fn().mockResolvedValue({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      score: 8.5,
                      passed: false,
                      riskLevel: "HIGH",
                      vulnerabilities: [
                        {
                          file: "components/Calculator.tsx",
                          issue: "math.evaluate dynamic evaluation.",
                          severity: "HIGH",
                        },
                        {
                          file: "src/runner.ts",
                          issue: "eval allows arbitrary code execution.",
                          severity: "HIGH",
                        },
                      ],
                    }),
                  },
                },
              ],
            }),
          },
        },
      });

      const changes: AgentFileChange[] = [
        {
          path: "components/Calculator.tsx",
          content: baselineCalcContent,
          action: "modify",
          description: "untouched calc",
        },
        {
          path: "src/runner.ts",
          content: `export const run = (code: string) => eval(code);`,
          action: "modify",
          description: "added eval",
        },
      ];

      const audit = await SecurityAuditor.runReflectionAndSecurityAudit(changes, (p) =>
        p.includes("Calculator.tsx") ? baselineCalcContent : `export const run = () => 0;`,
      );

      expect(audit.securityPass).toBe(false);
      expect(audit.vulnerabilities?.find((v) => v.file === "components/Calculator.tsx")?.provenance).toBe("PRE_EXISTING_BASELINE");
      expect(audit.vulnerabilities?.find((v) => v.file === "src/runner.ts")?.provenance).toBe("INTRODUCED_BY_AGENT");
    });

    test("Part U (Regression Test D): Novel LLM-Only HIGH finding in agent-modified code -> remains blocking -> securityPass: false", async () => {
      (getOpenAI as unknown as jest.Mock).mockReturnValue({
        chat: {
          completions: {
            create: jest.fn().mockResolvedValue({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      score: 8.5,
                      passed: false,
                      riskLevel: "HIGH",
                      vulnerabilities: [
                        {
                          file: "src/auth.ts",
                          issue: "Hardcoded master API key bypasses JWT validation.",
                          severity: "HIGH",
                        },
                      ],
                    }),
                  },
                },
              ],
            }),
          },
        },
      });

      const changes: AgentFileChange[] = [
        {
          path: "src/auth.ts",
          content: `export const checkAuth = (token: string) => token === 'secret-backdoor-123' || verify(token);`,
          action: "modify",
          description: "auth bypass",
        },
      ];

      const audit = await SecurityAuditor.runReflectionAndSecurityAudit(changes, () => `export const checkAuth = (token: string) => verify(token);`);

      expect(audit.securityPass).toBe(false);
      expect(audit.vulnerabilities?.[0].provenance).toBe("INTRODUCED_BY_AGENT");
      expect(audit.summary).toContain("LLM Review: FLAGGED");
    });
  });

  // =========================================================================
  // Section 3: AgentPipeline Transaction Boundary Regression
  // =========================================================================

  describe("Section 3: AgentPipeline Transaction Boundary Regression", () => {
    test("Live Case: Pre-existing math.evaluate in Calculator.tsx allows clean build changes to be returned", async () => {
      (getOpenAI as unknown as jest.Mock).mockReturnValue({
        chat: {
          completions: {
            create: jest.fn().mockResolvedValue({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      score: 9.0,
                      passed: false,
                      riskLevel: "HIGH",
                      vulnerabilities: [
                        {
                          file: "components/Calculator.tsx",
                          issue: "The use of 'math.evaluate' with user input can lead to code injection vulnerabilities if the input is not properly sanitized.",
                          severity: "HIGH",
                        },
                      ],
                    }),
                  },
                },
              ],
            }),
          },
        },
      });

      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "anka-test-sec-pipeline-"));
      const compDir = path.join(tempDir, "components");
      fs.mkdirSync(compDir, { recursive: true });

      const baselineCalculator = `'use client';\nimport * as math from 'mathjs';\nexport function CalculatorButton() { return null; }\nexport function CalculatorButton() { return null; }\nexport function Calculator() { return math.evaluate('1+1'); }\n`;
      fs.writeFileSync(path.join(compDir, "Calculator.tsx"), baselineCalculator, "utf8");

      const fsManager = new FileSystemStateManager();
      await fsManager.snapshot(
        [{ path: "components/Calculator.tsx", content: baselineCalculator, action: "modify", description: "Calc" }],
        tempDir,
      );

      const repairedCalculator = `'use client';\nimport * as math from 'mathjs';\nexport function CalculatorButton() { return null; }\nexport function Calculator() { return math.evaluate('1+1'); }\n`;

      const baselineSourceGetter = (p: string) => (p.includes("Calculator.tsx") ? baselineCalculator : null);
      const auditResult = await SecurityAuditor.runReflectionAndSecurityAudit(
        [{ path: "components/Calculator.tsx", content: repairedCalculator, action: "modify", description: "Repaired duplicate export" }],
        baselineSourceGetter,
      );

      expect(auditResult.securityPass).toBe(true);
      expect(auditResult.riskLevel).toBe("HIGH");
      expect(auditResult.vulnerabilities?.[0].provenance).toBe("PRE_EXISTING_BASELINE");

      fs.rmSync(tempDir, { recursive: true, force: true });
    });
  });
});
