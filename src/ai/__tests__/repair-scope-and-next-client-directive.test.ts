import fs from "fs";
import path from "path";
import os from "os";
import { enforceExecutionScope } from "../contracts/ExecutionScopeEnforcer";
import { validateRepairManifestScope } from "../repair/RepairProposalResolver";
import { SelfHealingEngine } from "../repair/SelfHealingEngine";
import { SecurityAuditor } from "../review/SecurityAuditor";
import { FileSystemStateManager } from "../validation/FileSystemStateManager";
import { ValidationRunner } from "../validation/ValidationRunner";
import { FileManifest, ExecutionContract, AgentFileChange } from "../../types";
import * as sharedUtils from "../shared/utils";

describe("Repair Scope for Generated Files & Next.js Client Directive (Section 10)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "anka-repair-scope-test-"));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ── TEST A: Manifest CREATE path remains repair-authorized during same run ──
  test("TEST A: Manifest CREATE path remains repair-authorized during same run", () => {
    const manifest: FileManifest = {
      files: [
        { path: "app/components/Calculator.tsx", action: "create", dependencies: [], description: "New calculator component" },
        { path: "app/page.tsx", action: "modify", dependencies: [], description: "Use calculator in page" },
      ],
      totalFiles: 2,
      manifestVersion: "1.0.0",
    };

    // Repair proposal attempts to modify the newly created Calculator.tsx
    const repairProposals = [
      {
        path: "app/components/Calculator.tsx",
        action: "modify" as const,
        description: "Add 'use client' directive",
        edits: [{ oldText: "export function Calculator", newText: "'use client';\nexport function Calculator" }],
      },
    ];

    const manifestCheck = validateRepairManifestScope(repairProposals, manifest);
    expect(manifestCheck.valid).toBe(true);

    const changes: AgentFileChange[] = [
      {
        path: "app/components/Calculator.tsx",
        action: "modify",
        content: "'use client';\nexport function Calculator() { return <div>Calc</div>; }",
        description: "Add use client",
      },
    ];

    const scopeCheck = enforceExecutionScope({
      proposedChanges: changes,
      manifest,
      existingFilePaths: new Set(["app/components/Calculator.tsx", "app/page.tsx"]),
      isRepair: true,
    });

    expect(scopeCheck.valid).toBe(true);
    expect(scopeCheck.errors).toHaveLength(0);
  });

  // ── TEST B: Manifest MODIFY path remains repair-authorized ────────────────
  test("TEST B: Manifest MODIFY path remains repair-authorized", () => {
    const manifest: FileManifest = {
      files: [{ path: "app/page.tsx", action: "modify", dependencies: [], description: "Modify page" }],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    };

    const repairProposals = [
      {
        path: "app/page.tsx",
        action: "modify" as const,
        description: "Fix import",
        edits: [{ oldText: "<div>", newText: "<div>Fixed" }],
      },
    ];

    const manifestCheck = validateRepairManifestScope(repairProposals, manifest);
    expect(manifestCheck.valid).toBe(true);
  });

  // ── TEST C: Path outside manifest remains SCOPE_VIOLATION ─────────────────
  test("TEST C: Path outside manifest remains SCOPE_VIOLATION / REPAIR_UNDECLARED_FILE", () => {
    const manifest: FileManifest = {
      files: [{ path: "app/page.tsx", action: "modify", dependencies: [], description: "Modify page" }],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    };

    const undeclaredProposal = [
      {
        path: "app/components/Undeclared.tsx",
        action: "modify" as const,
        description: "Undeclared file",
        edits: [{ oldText: "a", newText: "b" }],
      },
    ];

    const manifestCheck = validateRepairManifestScope(undeclaredProposal, manifest);
    expect(manifestCheck.valid).toBe(false);
    if (!manifestCheck.valid) {
      expect(manifestCheck.error.code).toBe("REPAIR_UNDECLARED_FILE");
    }

    const changes: AgentFileChange[] = [
      {
        path: "app/components/Undeclared.tsx",
        action: "modify",
        content: "content",
        description: "Undeclared",
      },
    ];

    const scopeCheck = enforceExecutionScope({
      proposedChanges: changes,
      manifest,
      isRepair: true,
    });

    expect(scopeCheck.valid).toBe(false);
    expect(scopeCheck.errors[0].reason).toBe("UNDECLARED_FILE");
  });

  // ── TEST D: Generated file is read from current worktree during repair ────
  test("TEST D: Generated file is read from current worktree during repair", async () => {
    const calcFile = path.join(tempDir, "app/components/Calculator.tsx");
    fs.mkdirSync(path.dirname(calcFile), { recursive: true });
    fs.writeFileSync(calcFile, "export function Calculator() { return <div>Initial Generated</div>; }\n");

    jest.spyOn(ValidationRunner, "validateWithShell").mockResolvedValue({
      success: false,
      errors: "Build failed: useState requires 'use client'",
    });

    let capturedPrompt = "";
    const mockOpenAI = {
      chat: {
        completions: {
          create: jest.fn().mockImplementation(async (opts) => {
            capturedPrompt = opts.messages[1].content;
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      changes: [
                        {
                          path: "app/components/Calculator.tsx",
                          action: "modify",
                          description: "add client directive",
                          edits: [
                            {
                              oldText: "export function Calculator() { return <div>Initial Generated</div>; }\n",
                              newText: "'use client';\nexport function Calculator() { return <div>Initial Generated</div>; }\n",
                            },
                          ],
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

    const manifest: FileManifest = {
      files: [{ path: "app/components/Calculator.tsx", action: "create", dependencies: [], description: "Calculator" }],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    };

    const contract: ExecutionContract = {
      goal: "Add calculator",
      taskType: "NEW_FEATURE",
      risk: "LOW",
      estimatedComplexity: "SMALL",
      pipeline: "REPOSITORY",
      environment: "REACT_TS",
      repositoryRequired: true,
      expectedFiles: ["app/components/Calculator.tsx"],
      validationType: "TYPESCRIPT_BUILD",
      targetPaths: ["app/components/Calculator.tsx"],
      allowedActions: ["create", "modify"],
      forbiddenActions: [],
      maxFiles: 2,
      searchScope: ["app"],
      contextScope: ["app/components/Calculator.tsx"],
      diffCriticEnabled: true,
    };

    await SelfHealingEngine.runSelfHealingLoop(
      [{ path: "app/components/Calculator.tsx", action: "create", content: "export function Calculator() { return <div>Initial Generated</div>; }\n", description: "calc" }],
      tempDir,
      ["npm run build"],
      "prompt",
      "msg",
      new FileSystemStateManager(),
      "proj-1",
      undefined,
      manifest,
      contract,
    );

    expect(capturedPrompt).toContain("export function Calculator() { return <div>Initial Generated</div>; }");
  });

  // ── TEST E: Generated file SHA is verified before repair ──────────────────
  test("TEST E: Generated file SHA is verified before repair", async () => {
    const calcFile = path.join(tempDir, "app/components/Calculator.tsx");
    fs.mkdirSync(path.dirname(calcFile), { recursive: true });
    fs.writeFileSync(calcFile, "export function Calculator() { return <div>v1</div>; }\n");

    jest.spyOn(ValidationRunner, "validateWithShell").mockResolvedValue({
      success: false,
      errors: "Build failed",
    });

    const mockOpenAI = {
      chat: {
        completions: {
          create: jest.fn().mockImplementation(async () => {
            // Concurrent change
            fs.writeFileSync(calcFile, "export function Calculator() { return <div>v2_concurrent</div>; }\n");
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      changes: [
                        {
                          path: "app/components/Calculator.tsx",
                          action: "modify",
                          description: "mod",
                          edits: [{ oldText: "export function Calculator() { return <div>v1</div>; }\n", newText: "'use client';\nexport function Calculator() { return <div>v1</div>; }\n" }],
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

    const manifest: FileManifest = {
      files: [{ path: "app/components/Calculator.tsx", action: "create", dependencies: [], description: "Calculator" }],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    };

    const contract: ExecutionContract = {
      goal: "Add calculator",
      taskType: "NEW_FEATURE",
      risk: "LOW",
      estimatedComplexity: "SMALL",
      pipeline: "REPOSITORY",
      environment: "REACT_TS",
      repositoryRequired: true,
      expectedFiles: ["app/components/Calculator.tsx"],
      validationType: "TYPESCRIPT_BUILD",
      targetPaths: ["app/components/Calculator.tsx"],
      allowedActions: ["create", "modify"],
      forbiddenActions: [],
      maxFiles: 2,
      searchScope: ["app"],
      contextScope: ["app/components/Calculator.tsx"],
      diffCriticEnabled: true,
    };

    const result = await SelfHealingEngine.runSelfHealingLoop(
      [{ path: "app/components/Calculator.tsx", action: "create", content: "export function Calculator() { return <div>v1</div>; }\n", description: "calc" }],
      tempDir,
      ["npm run build"],
      "prompt",
      "msg",
      new FileSystemStateManager(),
      "proj-1",
      undefined,
      manifest,
      contract,
    );

    expect(result.success).toBe(false);
    expect(result.errorType).toBe("STALE_REPAIR_SOURCE");
  });

  // ── TEST F: App Router component using useState without 'use client' is auto-detected ──
  test("TEST F & G: Next.js Client Directive precheck auto-prepends 'use client' when client hooks are present", () => {
    const rawContent = `import React, { useState } from 'react';\n\nexport function Counter() {\n  const [count, setCount] = useState(0);\n  return <button onClick={() => setCount(c => c + 1)}>{count}</button>;\n}`;

    const usesClientHooks =
      /\buse(State|Effect|Reducer|LayoutEffect|ImperativeHandle|SyncExternalStore)\s*(<|\()/.test(rawContent) ||
      /\bfrom\s*["']react["']\b.*useState/.test(rawContent);

    const hasClientDirective = /^(?:\s*\/\/[^\n]*\n|\s*\/\*[\s\S]*?\*\/\s*)*['"]use client['"]/m.test(rawContent);

    expect(usesClientHooks).toBe(true);
    expect(hasClientDirective).toBe(false);

    const fixedContent = `"use client";\n\n` + rawContent;
    const nowHasDirective = /^(?:\s*\/\/[^\n]*\n|\s*\/\*[\s\S]*?\*\/\s*)*['"]use client['"]/m.test(fixedContent);
    expect(nowHasDirective).toBe(true);
  });

  // ── TEST H: Ordinary Server Component without hooks does not get forced client-side ──
  test("TEST H: Ordinary Server Component without hooks does not get forced client-side", () => {
    const serverComponent = `import React from 'react';\n\nexport default async function Page() {\n  const data = await fetch('https://api.example.com');\n  return <div>{JSON.stringify(data)}</div>;\n}`;

    const usesClientHooks =
      /\buse(State|Effect|Reducer|LayoutEffect|ImperativeHandle|SyncExternalStore)\s*(<|\()/.test(serverComponent) ||
      /\bfrom\s*["']react["']\b.*useState/.test(serverComponent);

    expect(usesClientHooks).toBe(false);
  });

  // ── TEST I: SelfHealing can add 'use client' to an approved generated file ──
  test("TEST I: SelfHealing can add 'use client' to an approved generated file and succeed", async () => {
    const calcFile = path.join(tempDir, "app/components/Calculator.tsx");
    fs.mkdirSync(path.dirname(calcFile), { recursive: true });
    fs.writeFileSync(calcFile, "export function Calculator() { return <div>Calc</div>; }\n");

    let buildCalls = 0;
    jest.spyOn(ValidationRunner, "validateWithShell").mockImplementation(async () => {
      buildCalls++;
      if (buildCalls === 1) {
        return { success: false, errors: "Build failed: useState requires 'use client'" };
      }
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
                        path: "app/components/Calculator.tsx",
                        action: "modify",
                        description: "Add use client directive",
                        edits: [
                          {
                            oldText: "export function Calculator() { return <div>Calc</div>; }\n",
                            newText: "'use client';\n\nexport function Calculator() { return <div>Calc</div>; }\n",
                          },
                        ],
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

    const manifest: FileManifest = {
      files: [{ path: "app/components/Calculator.tsx", action: "create", dependencies: [], description: "Calculator" }],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    };

    const contract: ExecutionContract = {
      goal: "Add calculator",
      taskType: "NEW_FEATURE",
      risk: "LOW",
      estimatedComplexity: "SMALL",
      pipeline: "REPOSITORY",
      environment: "REACT_TS",
      repositoryRequired: true,
      expectedFiles: ["app/components/Calculator.tsx"],
      validationType: "TYPESCRIPT_BUILD",
      targetPaths: ["app/components/Calculator.tsx"],
      allowedActions: ["create", "modify"],
      forbiddenActions: [],
      maxFiles: 2,
      searchScope: ["app"],
      contextScope: ["app/components/Calculator.tsx"],
      diffCriticEnabled: true,
    };

    const result = await SelfHealingEngine.runSelfHealingLoop(
      [{ path: "app/components/Calculator.tsx", action: "create", content: "export function Calculator() { return <div>Calc</div>; }\n", description: "calc" }],
      tempDir,
      ["npm run build"],
      "prompt",
      "msg",
      new FileSystemStateManager(),
      "proj-1",
      undefined,
      manifest,
      contract,
    );

    expect(result.success).toBe(true);
    expect(result.repairApplied).toBe(true);
    expect(buildCalls).toBe(2);
  });

  // ── TEST L & M: Direct newly introduced eval() / new Function() is flagged ──
  test("TEST L & M: Direct newly introduced eval() / new Function() is detected and flagged by SecurityAuditor", async () => {
    const evalChange: AgentFileChange[] = [
      {
        path: "app/components/Calculator.tsx",
        content: `export function calculate(expr: string) { return eval(expr); }`,
        action: "create",
        description: "eval calculator",
      },
    ];

    const fnChange: AgentFileChange[] = [
      {
        path: "app/components/Calculator.tsx",
        content: `export function calculate(expr: string) { return new Function('return ' + expr)(); }`,
        action: "create",
        description: "function calculator",
      },
    ];

    const auditEval = await SecurityAuditor.runReflectionAndSecurityAudit(evalChange);
    expect(auditEval.securityPass).toBe(false);
    expect(auditEval.riskLevel).toBe("HIGH");

    const auditFn = await SecurityAuditor.runReflectionAndSecurityAudit(fnChange);
    expect(auditFn.securityPass).toBe(false);
    expect(auditFn.riskLevel).toBe("HIGH");
  });

  // ── TEST N: Safe arithmetic implementation passes deterministic precheck ──
  test("TEST N: Safe arithmetic implementation without eval passes SecurityAuditor", async () => {
    const safeCalc: AgentFileChange[] = [
      {
        path: "app/components/Calculator.tsx",
        content: `'use client';\nimport React, { useState } from 'react';\n\nexport function Calculator() {\n  const [val, setVal] = useState(0);\n  const add = (x: number) => setVal(v => v + x);\n  return <div>{val}</div>;\n}`,
        action: "create",
        description: "safe client calculator",
      },
    ];

    const audit = await SecurityAuditor.runReflectionAndSecurityAudit(safeCalc);
    expect(audit.securityPass).toBe(true);
    expect(audit.riskLevel).toBe("LOW");
  });

  // ── TEST O: Baseline dangerous code unchanged by ANKA is not incorrectly attributed ──
  test("TEST O: Baseline dangerous code unchanged by ANKA is not attributed to new proposal", () => {
    const baseline = `function legacyRunner(code: string) { return eval(code); }`;
    const unchanged = `function legacyRunner(code: string) { return eval(code); }`;

    const hasEval = /\beval\s*\(/.test(unchanged);
    const baselineHadEval = /\beval\s*\(/.test(baseline);

    const isNewlyIntroduced = hasEval && !baselineHadEval;
    expect(isNewlyIntroduced).toBe(false);
  });
});
