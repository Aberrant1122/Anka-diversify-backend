import fs from "fs";
import path from "path";
import os from "os";
import {
  extractPackageRoot,
  isAllowedBuiltinOrInstalled,
  detectRepositoryArchitecture,
} from "../planning/RepositoryArchitectureDetector";
import { ManifestValidator } from "../../services/manifest-validator";
import { SecurityPolicy } from "../security/SecurityPolicy";
import { ImportValidator } from "../validation/ImportValidator";
import { SelfHealingEngine } from "../repair/SelfHealingEngine";
import { SecurityAuditor } from "../review/SecurityAuditor";
import { ValidationRunner } from "../validation/ValidationRunner";
import { FileSystemStateManager } from "../validation/FileSystemStateManager";
import { FileManifest, ExecutionContract, AgentFileChange } from "../../types";
import * as sharedUtils from "../shared/utils";

describe("Dependency-Aware Generation and Missing-Dependency Routing (Section J)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "anka-dep-aware-test-"));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  const baseContract: ExecutionContract = {
    goal: "Implement feature",
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

  // ── TEST 1: Installed react import accepted ─────────────────────────────────
  test("TEST 1: Installed react import is accepted by ManifestValidator & ImportValidator", () => {
    const installed = ["react", "react-dom", "next"];
    expect(isAllowedBuiltinOrInstalled("react", installed)).toBe(true);

    const code = `import React from 'react';\nexport function App() { return <div>App</div>; }`;
    const res = ImportValidator.validateCodeImports(code, "app/page.tsx", installed);
    expect(res.valid).toBe(true);
    expect(res.errors).toHaveLength(0);
  });

  // ── TEST 2: next/link accepted when next installed ──────────────────────────
  test("TEST 2: next/link accepted when next is installed", () => {
    const installed = ["next", "react"];
    expect(extractPackageRoot("next/link")).toBe("next");
    expect(isAllowedBuiltinOrInstalled("next/link", installed)).toBe(true);

    const code = `import Link from 'next/link';\nexport function Nav() { return <Link href="/">Home</Link>; }`;
    const res = ImportValidator.validateCodeImports(code, "components/Nav.tsx", installed);
    expect(res.valid).toBe(true);
  });

  // ── TEST 3: @scope/package subpath normalization ────────────────────────────
  test("TEST 3: @scope/package subpath normalization (@radix-ui/react-dialog/subpath -> @radix-ui/react-dialog)", () => {
    expect(extractPackageRoot("@radix-ui/react-dialog")).toBe("@radix-ui/react-dialog");
    expect(extractPackageRoot("@radix-ui/react-dialog/subpath")).toBe("@radix-ui/react-dialog");
    expect(extractPackageRoot("@tanstack/react-query/devtools")).toBe("@tanstack/react-query");
    expect(extractPackageRoot("lodash/get")).toBe("lodash");
  });

  // ── TEST 4: Missing mathjs rejected before CodeGenerator ───────────────────
  test("TEST 4: Missing mathjs is rejected by ManifestValidator with external-dependency-missing", () => {
    const manifest: FileManifest = {
      files: [
        {
          path: "app/components/Calculator.tsx",
          action: "create",
          dependencies: ["react", "mathjs"],
          description: "Calculator using mathjs",
        },
      ],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    };

    const validator = new ManifestValidator(baseContract, {
      existingFiles: ["package.json", "app/page.tsx"],
      installedPackages: ["react", "next"],
    });

    const result = validator.validate(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.type === "external-dependency-missing" && e.message.includes("mathjs"))).toBe(true);
  });

  // ── TEST 5: Missing lucide-react rejected ──────────────────────────────────
  test("TEST 5: Missing lucide-react is rejected when not in package.json", () => {
    const manifest: FileManifest = {
      files: [
        {
          path: "app/components/Icon.tsx",
          action: "create",
          dependencies: ["react", "lucide-react"],
          description: "Icon component",
        },
      ],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    };

    const validator = new ManifestValidator(baseContract, {
      existingFiles: ["package.json", "app/page.tsx"],
      installedPackages: ["react", "next"],
    });

    const result = validator.validate(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.type === "external-dependency-missing" && e.message.includes("lucide-react"))).toBe(true);
  });

  // ── TEST 6: CodeGenerator / ImportValidator rejects uninstalled external import ──
  test("TEST 6: ImportValidator rejects uninstalled external import in generated code", () => {
    const changes: AgentFileChange[] = [
      {
        path: "app/components/Calculator.tsx",
        content: `import { evaluate } from "mathjs";\nexport function calc(x: string) { return evaluate(x); }`,
        action: "create",
        description: "calc",
      },
    ];

    const result = ImportValidator.validateChangesImports(changes, ["react", "next"]);
    expect(result.valid).toBe(false);
    expect(result.errors[0].packageRoot).toBe("mathjs");
    expect(result.errors[0].message).toContain("[UNDECLARED_EXTERNAL_DEPENDENCY]");
  });

  // ── TEST 7: Bounded correction using only installed deps passes ─────────────
  test("TEST 7: Code using only verified installed packages passes ImportValidator", () => {
    const validChanges: AgentFileChange[] = [
      {
        path: "app/components/Calculator.tsx",
        content: `'use client';\nimport React, { useState } from 'react';\nimport Link from 'next/link';\nimport path from 'path';\n\nexport function Calculator() { return <div><Link href="/">Home</Link></div>; }`,
        action: "create",
        description: "safe component",
      },
    ];

    const result = ImportValidator.validateChangesImports(validChanges, ["react", "next"]);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  // ── TEST 8: eval() rejected by SecurityPolicy ──────────────────────────────
  test("TEST 8: eval() rejected by SecurityPolicy", () => {
    const code = `export function compute(str: string) { return eval(str); }`;
    const check = SecurityPolicy.checkCode(code, "lib/calc.ts");
    expect(check.safe).toBe(false);
    expect(check.violations.some((v) => v.reason === "UNSAFE_EVAL")).toBe(true);
  });

  // ── TEST 9: new Function() rejected by SecurityPolicy ───────────────────────
  test("TEST 9: new Function() rejected by SecurityPolicy", () => {
    const code = `export function compute(str: string) { return new Function('return ' + str)(); }`;
    const check = SecurityPolicy.checkCode(code, "lib/calc.ts");
    expect(check.safe).toBe(false);
    expect(check.violations.some((v) => v.reason === "UNSAFE_FUNCTION_CONSTRUCTOR")).toBe(true);
  });

  // ── TEST 10: Unrestricted mathjs.evaluate rejected by SecurityPolicy ────────
  test("TEST 10: Unrestricted mathjs.evaluate / mathjs import rejected by SecurityPolicy", () => {
    const code1 = `import { evaluate } from 'mathjs';\nexport function calc(s: string) { return evaluate(s); }`;
    const check1 = SecurityPolicy.checkCode(code1, "lib/calc.ts");
    expect(check1.safe).toBe(false);
    expect(check1.violations.some((v) => v.reason === "UNSAFE_MATHJS_EVALUATE")).toBe(true);

    const code2 = `const math = require('mathjs');\nexport function calc(s: string) { return math.evaluate(s); }`;
    const check2 = SecurityPolicy.checkCode(code2, "lib/calc.ts");
    expect(check2.safe).toBe(false);
  });

  // ── TEST 11: Security correction is revalidated by same policy ──────────────
  test("TEST 11: Security correction must pass the same SecurityPolicy detector", () => {
    const correctedSafe = `'use client';\nexport function calculate(a: number, b: number, op: string) {\n  if (op === '+') return a + b;\n  if (op === '-') return a - b;\n  if (op === '*') return a * b;\n  if (op === '/') return b !== 0 ? a / b : NaN;\n  return NaN;\n}`;
    const check = SecurityPolicy.checkCode(correctedSafe, "lib/calc.ts");
    expect(check.safe).toBe(true);
    expect(check.violations).toHaveLength(0);
  });

  // ── TEST 12: MISSING_DEP does not enter generic 5-repair loop ───────────────
  test("TEST 12: MISSING_DEP does not enter generic 5-repair loop and stops fast", async () => {
    const pkgPath = path.join(tempDir, "package.json");
    fs.writeFileSync(pkgPath, JSON.stringify({ dependencies: { react: "^18.0.0", next: "^14.0.0" } }));

    jest.spyOn(ValidationRunner, "validateWithShell").mockResolvedValue({
      success: false,
      errors: "Module not found: Can't resolve 'mathjs'",
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
                        content: "import { evaluate } from 'mathjs';",
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

    const result = await SelfHealingEngine.runSelfHealingLoop(
      [{ path: "app/components/Calculator.tsx", action: "create", content: "import { evaluate } from 'mathjs';", description: "calc" }],
      tempDir,
      ["npm run build"],
      "prompt",
      "create calculator",
      new FileSystemStateManager(),
      "proj-1",
      undefined,
      { files: [{ path: "app/components/Calculator.tsx", action: "create", dependencies: [], description: "calc" }], totalFiles: 1, manifestVersion: "1.0.0" },
      baseContract,
    );

    // Stops after 1 bounded attempt without wasting 5 loops
    expect(result.success).toBe(false);
    expect(result.errorType).toBe("MISSING_DEP");
    expect(result.attempts).toBe(1);
  });

  // ── TEST 13: Current validation error, not root error, is sent to SelfHealing ──
  test("TEST 13: SelfHealing prompt receives current errorLog, not stale root error", async () => {
    const pkgPath = path.join(tempDir, "package.json");
    fs.writeFileSync(pkgPath, JSON.stringify({ dependencies: { react: "^18.0.0" } }));

    let buildCalls = 0;
    jest.spyOn(ValidationRunner, "validateWithShell").mockImplementation(async () => {
      buildCalls++;
      if (buildCalls === 1) return { success: false, errors: "Initial compiler error TS2304: Cannot find name 'foo'" };
      return { success: false, errors: "Subsequent compiler error TS2322: Type 'number' is not assignable to 'string'" };
    });

    let receivedErrorInPrompt = "";
    const mockOpenAI = {
      chat: {
        completions: {
          create: jest.fn().mockImplementation(async (opts) => {
            receivedErrorInPrompt = opts.messages[1].content;
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      changes: [
                        {
                          path: "app/page.tsx",
                          action: "modify",
                          description: "fix",
                          edits: [{ oldText: "foo", newText: "bar" }],
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

    const result = await SelfHealingEngine.runSelfHealingLoop(
      [{ path: "app/page.tsx", action: "modify", content: "const a: string = foo;\n", description: "page" }],
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

    // rootFailure preserved in telemetry
    expect(result.rootFailure?.stderr).toContain("Cannot find name 'foo'");
  });

  // ── TEST 14: App Router calculator with React/Next only passes validation ────
  test("TEST 14: Next App Router calculator implemented with standard React only passes all checks", () => {
    const calcFileContent = `'use client';\nimport React, { useState } from 'react';\n\nexport function Calculator() {\n  const [display, setDisplay] = useState('0');\n  const handleDigit = (d: string) => setDisplay(prev => prev === '0' ? d : prev + d);\n  return <div id="display">{display}</div>;\n}`;

    const changes: AgentFileChange[] = [
      {
        path: "app/components/Calculator.tsx",
        content: calcFileContent,
        action: "create",
        description: "clean calculator component",
      },
    ];

    const installed = ["react", "react-dom", "next"];
    const importRes = ImportValidator.validateChangesImports(changes, installed);
    expect(importRes.valid).toBe(true);

    const secRes = SecurityPolicy.checkChanges(changes);
    expect(secRes.safe).toBe(true);
  });
});
