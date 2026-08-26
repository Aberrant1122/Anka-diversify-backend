import fs from "fs";
import path from "path";
import os from "os";
import { WorktreeDependencyService } from "../../services/worktree-dependency.service";
import { SecurityAuditor } from "../review/SecurityAuditor";
import { SelfHealingEngine } from "../repair/SelfHealingEngine";
import { ValidationRunner } from "../validation/ValidationRunner";

describe("AI Step 15 & 16 — Real-Repo Worktree Dependency & Build Hardening", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "anka-test-worktree-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  test("A, B, C. npm project with package-lock.json detects npm ci and runs in worktreePath", async () => {
    const pkgJson = {
      name: "test-app",
      dependencies: {
        express: "^4.18.0",
      },
    };
    fs.writeFileSync(path.join(tempDir, "package.json"), JSON.stringify(pkgJson, null, 2));
    fs.writeFileSync(path.join(tempDir, "package-lock.json"), "{}");

    const plan = WorktreeDependencyService.resolveDependencyInstallPlan(tempDir);
    expect(plan.needed).toBe(true);
    expect(plan.packageManager).toBe("npm");
    expect(plan.installCommand).toBe("npm ci --no-audit --no-fund");

    const executedCommands: string[] = [];
    const mockExecutor = async (cmd: string, cwd: string) => {
      executedCommands.push(`${cmd} in ${cwd}`);
      // Simulate node_modules created
      fs.mkdirSync(path.join(cwd, "node_modules"), { recursive: true });
      return { stdout: "installed", stderr: "" };
    };

    const prep = await WorktreeDependencyService.prepareDependencies(tempDir, mockExecutor);
    expect(prep.attempted).toBe(true);
    expect(prep.success).toBe(true);
    expect(prep.packageManager).toBe("npm");
    expect(executedCommands).toEqual([`npm ci --no-audit --no-fund in ${tempDir}`]);
  });

  test("D. Missing lockfile fails safely with MISSING_LOCKFILE error without running arbitrary mutations", async () => {
    const pkgJson = {
      name: "test-app",
      dependencies: {
        express: "^4.18.0",
      },
    };
    fs.writeFileSync(path.join(tempDir, "package.json"), JSON.stringify(pkgJson, null, 2));
    // No lockfile created

    const prep = await WorktreeDependencyService.prepareDependencies(tempDir);
    expect(prep.attempted).toBe(true);
    expect(prep.success).toBe(false);
    expect(prep.errorType).toBe("MISSING_LOCKFILE");
  });

  test("E. 'next' build script + missing local Next executable fails dependency preparation before generation", async () => {
    const pkgJson = {
      name: "next-app",
      scripts: {
        build: "next build",
      },
      dependencies: {
        next: "^14.0.0",
      },
    };
    fs.writeFileSync(path.join(tempDir, "package.json"), JSON.stringify(pkgJson, null, 2));
    fs.writeFileSync(path.join(tempDir, "package-lock.json"), "{}");

    const mockExecutor = async (cmd: string, cwd: string) => {
      // Simulate empty node_modules without next binary
      fs.mkdirSync(path.join(cwd, "node_modules"), { recursive: true });
      return { stdout: "installed", stderr: "" };
    };

    const prep = await WorktreeDependencyService.prepareDependencies(tempDir, mockExecutor);
    expect(prep.attempted).toBe(true);
    expect(prep.success).toBe(false);
    expect(prep.errorType).toBe("DEPENDENCY_TOOL_MISSING");
    expect(prep.error).toContain("next");
  });

  test("F. Successful dependency preparation with local Next executable succeeds", async () => {
    const pkgJson = {
      name: "next-app",
      scripts: {
        build: "next build",
      },
      dependencies: {
        next: "^14.0.0",
      },
    };
    fs.writeFileSync(path.join(tempDir, "package.json"), JSON.stringify(pkgJson, null, 2));
    fs.writeFileSync(path.join(tempDir, "package-lock.json"), "{}");

    const mockExecutor = async (cmd: string, cwd: string) => {
      const binDir = path.join(cwd, "node_modules", ".bin");
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(path.join(binDir, "next"), "#!/usr/bin/env node");
      return { stdout: "installed", stderr: "" };
    };

    const prep = await WorktreeDependencyService.prepareDependencies(tempDir, mockExecutor);
    expect(prep.attempted).toBe(true);
    expect(prep.success).toBe(true);
    expect(prep.errorType).toBeNull();
  });

  test("G. Infrastructure error (e.g. 'next is not recognized') halts SelfHealingEngine immediately without 5 repair attempts", async () => {
    jest.spyOn(ValidationRunner, "validateWithShell").mockResolvedValue({
      success: false,
      errors: "'next' is not recognized as an internal or external command, operable program or batch file.",
    });

    const result = await SelfHealingEngine.runSelfHealingLoop(
      [{ path: "src/app.tsx", content: "export default function App() {}", action: "create", description: "app" }],
      tempDir,
      ["npm run build"],
      "system prompt",
      "user request",
      undefined,
      undefined,
      undefined,
      { files: [{ path: "src/app.tsx", action: "create", description: "app", dependencies: [] }], totalFiles: 1, manifestVersion: "1.0.0" },
      { pipeline: "REPOSITORY", taskType: "NEW_FEATURE", goal: "goal", risk: "LOW", estimatedComplexity: "SMALL", environment: "NODE_JS", repositoryRequired: true, expectedFiles: [], validationType: "TYPESCRIPT_BUILD", targetPaths: [], allowedActions: [], forbiddenActions: [], maxFiles: 5, searchScope: [], contextScope: [], diffCriticEnabled: false }
    );

    expect(result.success).toBe(false);
    expect(result.infrastructureError).toBe(true);
    expect(result.errorType).toBe("INFRA");
    expect(result.attempts).toBe(1);
  });

  test("H. Raw user input to mathjs.evaluate remains security-invalid", async () => {
    const mockOpenAI: any = {
      chat: {
        completions: {
          create: jest.fn().mockImplementation((args: any) => {
            if (args.messages[0].content.includes("Application Security Auditor")) {
              return Promise.resolve({
                choices: [
                  {
                    message: {
                      content: JSON.stringify({
                        passed: false,
                        riskLevel: "HIGH",
                        vulnerabilities: [
                          {
                            file: "src/calculator.ts",
                            issue: "Unrestricted mathjs.evaluate(rawInput) allows arbitrary code execution",
                            severity: "HIGH",
                          },
                        ],
                        recommendations: ["Use safe allowlisted parser or mathjs.compile with scope isolation"],
                      }),
                    },
                  },
                ],
              });
            }
            return Promise.resolve({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      score: 0.85,
                      passed: true,
                      critique: [],
                      improvements: "",
                    }),
                  },
                },
              ],
            });
          }),
        },
      },
    };

    const changes = [
      {
        path: "src/calculator.ts",
        content: "import { evaluate } from 'mathjs'; export function calc(expr: string) { return evaluate(expr); }",
        action: "create" as const,
        description: "Calculator",
      },
    ];

    jest.spyOn(require("../shared/utils"), "getOpenAI").mockReturnValue(mockOpenAI);

    const audit = await SecurityAuditor.runReflectionAndSecurityAudit(changes);
    expect(audit.securityPass).toBe(false);
    expect(audit.passed).toBe(false);
    expect(audit.riskLevel).toBe("HIGH");
    expect(audit.vulnerabilities).toBeDefined();
    expect(audit.vulnerabilities?.[0].issue).toContain("mathjs.evaluate");
    expect(audit.summary).toContain("FLAGGED (HIGH risk)");
  });

  test("I. Critique score is defensively clamped and normalized so percentage is always 0% – 100%", async () => {
    const mockOpenAI: any = {
      chat: {
        completions: {
          create: jest.fn().mockImplementation((args: any) => {
            if (args.messages[0].content.includes("Application Security Auditor")) {
              return Promise.resolve({
                choices: [{ message: { content: JSON.stringify({ passed: true, riskLevel: "LOW" }) } }],
              });
            }
            return Promise.resolve({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      score: 7,
                      passed: true,
                      critique: [],
                    }),
                  },
                },
              ],
            });
          }),
        },
      },
    };

    jest.spyOn(require("../shared/utils"), "getOpenAI").mockReturnValue(mockOpenAI);

    const changes = [
      {
        path: "src/index.ts",
        content: "export const x = 1;",
        action: "create" as const,
        description: "Index",
      },
    ];

    const audit = await SecurityAuditor.runReflectionAndSecurityAudit(changes);
    expect(audit.critiqueScore).toBe(0.7);
    expect(audit.summary).toContain("Reflection Pass Score: 70%");
    expect(audit.summary).not.toContain("700%");
  });

  test("J. EXACT REAL-WORLD ETARGET: 'No matching version found for lucide-react@^0.2.0' classified as INVALID_PACKAGE_DEPENDENCY", async () => {
    const pkgJson = {
      name: "anka-test-project",
      dependencies: {
        "lucide-react": "^0.2.0",
      },
    };
    fs.writeFileSync(path.join(tempDir, "package.json"), JSON.stringify(pkgJson, null, 2));
    fs.writeFileSync(path.join(tempDir, "package-lock.json"), "{}");

    const rawNpmError = `npm ERR! code ETARGET
npm ERR! notarget No matching version found for lucide-react@^0.2.0.
npm ERR! notarget In most cases you or one of your dependencies are requesting
npm ERR! notarget a package version that doesn't exist.`;

    const mockExecutor = async () => {
      const err: any = new Error("Command failed");
      err.stderr = rawNpmError;
      throw err;
    };

    const prep = await WorktreeDependencyService.prepareDependencies(tempDir, mockExecutor);
    expect(prep.attempted).toBe(true);
    expect(prep.success).toBe(false);
    expect(prep.errorType).toBe("INVALID_PACKAGE_DEPENDENCY");
    expect(prep.packageName).toBe("lucide-react");
    expect(prep.requestedVersion).toBe("^0.2.0");
    expect(prep.error).toContain("ETARGET");
    expect(prep.errorType).not.toBe("INFRASTRUCTURE");
  });

  test("K. Peer dependency conflict (ERESOLVE) classified as PEER_DEPENDENCY_CONFLICT", async () => {
    const pkgJson = {
      name: "anka-test-project",
      dependencies: { "some-pkg": "^1.0.0" },
    };
    fs.writeFileSync(path.join(tempDir, "package.json"), JSON.stringify(pkgJson, null, 2));
    fs.writeFileSync(path.join(tempDir, "package-lock.json"), "{}");

    const rawNpmError = `npm ERR! code ERESOLVE
npm ERR! ERESOLVE unable to resolve dependency tree
npm ERR! While resolving: anka-test-project@0.1.0
npm ERR! Found: react@19.0.0
npm ERR! Could not resolve dependency: peer react@"^18.0.0" from some-lib@1.0.0`;

    const mockExecutor = async () => {
      const err: any = new Error("Command failed");
      err.stderr = rawNpmError;
      throw err;
    };

    const prep = await WorktreeDependencyService.prepareDependencies(tempDir, mockExecutor);
    expect(prep.attempted).toBe(true);
    expect(prep.success).toBe(false);
    expect(prep.errorType).toBe("PEER_DEPENDENCY_CONFLICT");
    expect(prep.error).toContain("Peer dependency conflict");
  });

  test("L. Out-of-sync lockfile error classified as LOCKFILE_OUT_OF_SYNC", async () => {
    const pkgJson = {
      name: "anka-test-project",
      dependencies: { "some-pkg": "^1.0.0" },
    };
    fs.writeFileSync(path.join(tempDir, "package.json"), JSON.stringify(pkgJson, null, 2));
    fs.writeFileSync(path.join(tempDir, "package-lock.json"), "{}");

    const rawNpmError = `npm ERR! code EUSAGE
npm ERR! \`npm ci\` can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync. Please update your lock file with \`npm install\` before running \`npm ci\`.`;

    const mockExecutor = async () => {
      const err: any = new Error("Command failed");
      err.stderr = rawNpmError;
      throw err;
    };

    const prep = await WorktreeDependencyService.prepareDependencies(tempDir, mockExecutor);
    expect(prep.attempted).toBe(true);
    expect(prep.success).toBe(false);
    expect(prep.errorType).toBe("LOCKFILE_OUT_OF_SYNC");
    expect(prep.error).toContain("Lockfile is out of sync");
  });

  test("M. GitWorktreeService reports BASELINE_REPOSITORY_UNHEALTHY for ETARGET and NOT INFRASTRUCTURE_ERROR", async () => {
    const { GitWorktreeService } = require("../../services/git-worktree.service");

    // Mock prepareRepositoryRun & rollbackWorktree
    jest.spyOn(GitWorktreeService, "prepareRepositoryRun").mockResolvedValue({
      originalRepositoryPath: tempDir,
      repositoryRoot: tempDir,
      worktreePath: tempDir,
      branchName: "anka/run-etarget",
      baseCommitSha: "abc12345",
    });
    jest.spyOn(GitWorktreeService, "rollbackWorktree").mockResolvedValue(undefined as any);

    // Mock prepareDependencies returning ETARGET failure
    jest.spyOn(WorktreeDependencyService, "prepareDependencies").mockResolvedValue({
      attempted: true,
      success: false,
      packageManager: "npm",
      installCommand: "npm ci --no-audit --no-fund",
      durationMs: 4200,
      errorType: "INVALID_PACKAGE_DEPENDENCY",
      packageName: "lucide-react",
      requestedVersion: "^0.2.0",
      error: "Invalid package dependency 'lucide-react'@'^0.2.0': version does not exist in registry. (ETARGET)",
    });

    const summary = await GitWorktreeService.runIsolatedAgent({
      userId: "user-1",
      projectId: "proj-1",
      repositoryPath: tempDir,
      runId: "etarget-run",
      request: { message: "update the UI" },
    });

    expect(summary.validationPassed).toBe(false);
    expect(summary.validationErrors).toContain("[BASELINE_REPOSITORY_UNHEALTHY]");
    expect(summary.validationErrors).toContain("[INVALID_PACKAGE_DEPENDENCY]");
    expect(summary.validationErrors).toContain("lucide-react");
    expect(summary.validationErrors).toContain("^0.2.0");
    expect(summary.validationErrors).not.toContain("INFRASTRUCTURE_ERROR");

    expect(summary.agentResponse.errorType).toBe("INVALID_PACKAGE_DEPENDENCY");
    expect(summary.agentResponse.packageName).toBe("lucide-react");
    expect(summary.agentResponse.requestedVersion).toBe("^0.2.0");
    expect(summary.agentResponse.baselineFailure).toBe(true);
    expect(summary.agentResponse.buildVerificationBlocked).toBe(true);
    expect(summary.agentResponse.healthStatus).toBe("BASELINE_REPOSITORY_UNHEALTHY");
    expect(summary.agentResponse.explanation).not.toContain("INFRASTRUCTURE_ERROR");
  });
});
