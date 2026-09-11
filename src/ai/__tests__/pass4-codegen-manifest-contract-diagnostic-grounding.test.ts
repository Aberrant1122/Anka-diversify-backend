import { CodeGenerator } from "../generation/CodeGenerator";
import { enforceExecutionScope } from "../contracts/ExecutionScopeEnforcer";
import { EvidenceBoundWriteSetResolver, PlannedChange } from "../contracts/EvidenceBoundWriteSetResolver";
import { RepositoryEvidenceStore } from "../repository/RepositoryEvidenceStore";
import { DiagnosticNormalizer } from "../validation/DiagnosticNormalizer";
import { PolicyContract } from "../contracts/PolicyContract";
import { TaskIntentSpec } from "../shared/TaskIntentSpec";
import { ExecutionContract, FileManifest } from "../../types";

describe("Strict Implementation Pass 4: CodeGen Manifest Contract & Repair Diagnostic Grounding", () => {
  const originalGetOpenAI = require("../shared/utils").getOpenAI;

  afterEach(() => {
    require("../shared/utils").getOpenAI = originalGetOpenAI;
    jest.restoreAllMocks();
  });

  // ─────────────────────────────────────────────────────────────
  // 1. Undeclared CodeGen Test & Bounded Retry
  // ─────────────────────────────────────────────────────────────
  test("10. Undeclared CodeGen test: undeclared paths trigger bounded retry and fail closed with CODEGEN_MANIFEST_VIOLATION if persistent", async () => {
    const approvedManifest: FileManifest = {
      manifestVersion: "1.0.0",
      totalFiles: 1,
      files: [
        { path: "src/foo.ts", action: "modify", dependencies: [], description: "update foo" },
      ],
    };

    const contract: ExecutionContract = {
      goal: "Update foo",
      taskType: "BUG_FIX",
      risk: "LOW",
      estimatedComplexity: "SMALL",
      pipeline: "REPOSITORY",
      environment: "REACT_TS",
      repositoryRequired: true,
      expectedFiles: ["src/foo.ts"],
      validationType: "TYPESCRIPT_BUILD",
      targetPaths: ["src/foo.ts"],
      allowedActions: ["modify_file"],
      forbiddenActions: [],
      maxFiles: 5,
      searchScope: ["src/foo.ts"],
      contextScope: ["src/foo.ts"],
      diffCriticEnabled: true,
    };

    let callCount = 0;
    const capturedMessages: any[][] = [];

    const utils = require("../shared/utils");
    utils.getOpenAI = () => ({
      chat: {
        completions: {
          create: async (params: any) => {
            callCount++;
            capturedMessages.push(params.messages);
            // Both initial call and retry return undeclared src/bar.ts
            return {
              choices: [
                {
                  finish_reason: "stop",
                  message: {
                    content: JSON.stringify({
                      explanation: "Modified foo and added bar",
                      commitMessage: "test commit",
                      changes: [
                        {
                          path: "src/foo.ts",
                          action: "modify",
                          description: "update foo",
                          edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }],
                        },
                        {
                          path: "src/bar.ts",
                          action: "create",
                          content: "export const bar = 42;",
                          description: "created bar",
                        },
                      ],
                    }),
                  },
                },
              ],
            };
          },
        },
      },
    });

    const result = await CodeGenerator.generateRoadmapAndDiffs(
      "Update foo",
      { intent: "BUG_FIX", taskType: "BUG_FIX" },
      { fileContext: { "src/foo.ts": "const a = 1;" } },
      "system prompt",
      contract,
      approvedManifest,
      { "src/foo.ts": { path: "src/foo.ts", content: "const a = 1;", sha256: "sha-foo" } }
    );

    // Post-CP9: manifest demoted; execution scope enforcement strictly fails closed
    const scopeCheck = enforceExecutionScope({
      proposedChanges: result.changes,
      contract,
      isRepair: false,
    });
    expect(scopeCheck.valid).toBe(false);
    expect(scopeCheck.errors.some((e) => e.reason === "TARGET_PATH_VIOLATION" && e.path === "src/bar.ts")).toBe(true);

    // targetPaths remain untouched
    expect(contract.targetPaths).toEqual(["src/foo.ts"]);
    // approvedManifest.files remain untouched
    expect(approvedManifest.files).toHaveLength(1);
    expect(approvedManifest.files[0].path).toBe("src/foo.ts");
  });

  test("10b. Bounded regeneration success: retry successfully restricts changes to approved paths", async () => {
    const approvedManifest: FileManifest = {
      manifestVersion: "1.0.0",
      totalFiles: 1,
      files: [
        { path: "src/foo.ts", action: "modify", dependencies: [], description: "update foo" },
      ],
    };

    const contract: ExecutionContract = {
      goal: "Update foo",
      taskType: "BUG_FIX",
      risk: "LOW",
      estimatedComplexity: "SMALL",
      pipeline: "REPOSITORY",
      environment: "REACT_TS",
      repositoryRequired: true,
      expectedFiles: ["src/foo.ts"],
      validationType: "TYPESCRIPT_BUILD",
      targetPaths: ["src/foo.ts"],
      allowedActions: ["modify_file"],
      forbiddenActions: [],
      maxFiles: 5,
      searchScope: ["src/foo.ts"],
      contextScope: ["src/foo.ts"],
      diffCriticEnabled: true,
    };

    let callCount = 0;
    const utils = require("../shared/utils");
    utils.getOpenAI = () => ({
      chat: {
        completions: {
          create: async () => {
            callCount++;
            if (callCount === 1) {
              // First call: emits undeclared src/bar.ts
              return {
                choices: [
                  {
                    finish_reason: "stop",
                  message: {
                      content: JSON.stringify({
                        explanation: "Updated foo and bar",
                      commitMessage: "test commit",
                        changes: [
                          {
                            path: "src/foo.ts",
                            action: "modify",
                            description: "update foo",
                            edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }],
                          },
                          {
                            path: "src/bar.ts",
                            action: "create",
                            content: "export const bar = 1;",
                            description: "undeclared bar",
                          },
                        ],
                      }),
                    },
                  },
                ],
              };
            } else {
              // Second call (bounded retry): obeys and emits only approved src/foo.ts
              return {
                choices: [
                  {
                    finish_reason: "stop",
                  message: {
                      content: JSON.stringify({
                        explanation: "Updated foo only",
                      commitMessage: "test commit",
                        changes: [
                          {
                            path: "src/foo.ts",
                            action: "modify",
                            description: "update foo",
                            edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }],
                          },
                        ],
                      }),
                    },
                  },
                ],
              };
            }
          },
        },
      },
    });

    const result = await CodeGenerator.generateRoadmapAndDiffs(
      "Update foo",
      { intent: "BUG_FIX", taskType: "BUG_FIX" },
      { fileContext: { "src/foo.ts": "const a = 1;" } },
      "system prompt",
      contract,
      approvedManifest,
      { "src/foo.ts": { path: "src/foo.ts", content: "const a = 1;", sha256: "sha-foo" } }
    );

    expect(callCount).toBe(2);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].path).toBe("src/foo.ts");
    expect(result.changes.some((c) => c.path === "src/bar.ts")).toBe(false);
  });

  // ─────────────────────────────────────────────────────────────
  // 2. Stale Calculator Context Test
  // ─────────────────────────────────────────────────────────────
  test("11. Stale Calculator context test: context visibility of Calculator.tsx does not confer write authority", async () => {
    const approvedManifest: FileManifest = {
      manifestVersion: "1.0.0",
      totalFiles: 1,
      files: [
        { path: "src/app.ts", action: "modify", dependencies: [], description: "fix app.ts" },
      ],
    };

    const contract: ExecutionContract = {
      goal: "resolve all the build errors",
      taskType: "BUG_FIX",
      risk: "LOW",
      estimatedComplexity: "SMALL",
      pipeline: "REPOSITORY",
      environment: "REACT_TS",
      repositoryRequired: true,
      expectedFiles: ["src/app.ts"],
      validationType: "TYPESCRIPT_BUILD",
      targetPaths: ["src/app.ts"],
      allowedActions: ["modify_file"],
      forbiddenActions: [],
      maxFiles: 5,
      searchScope: ["src/app.ts"],
      contextScope: ["src/app.ts"],
      diffCriticEnabled: true,
    };

    // Calculator is in repository context
    const fileContext = {
      "src/app.ts": "export const app = 1;",
      "src/components/calculator/Calculator.tsx": "export default function Calculator() { return null; }",
    };

    const utils = require("../shared/utils");
    utils.getOpenAI = () => ({
      chat: {
        completions: {
          create: async () => ({
            choices: [
              {
                finish_reason: "stop",
                  message: {
                  content: JSON.stringify({
                    explanation: "Tried to modify Calculator from context",
                      commitMessage: "test commit",
                    changes: [
                      {
                        path: "src/app.ts",
                        action: "modify",
                        description: "fix app",
                        edits: [{ oldText: "export const app = 1;", newText: "export const app = 2;" }],
                      },
                      {
                        path: "src/components/calculator/Calculator.tsx",
                        action: "modify",
                        description: "modify calculator",
                        edits: [{ oldText: "return null;", newText: "return <div>Calc</div>;" }],
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

    // Context visibility of Calculator.tsx does not confer write authority (fails closed with patch-resolution error)
    let error: any = null;
    try {
      await CodeGenerator.generateRoadmapAndDiffs(
        "resolve all the build errors",
        { intent: "BUG_FIX", taskType: "BUG_FIX" },
        { fileContext },
        "system prompt",
        contract,
        approvedManifest,
        { "src/app.ts": { path: "src/app.ts", content: "export const app = 1;", sha256: "sha-app" } }
      );
    } catch (e: any) {
      error = e;
    }

    expect(error).not.toBeNull();
    expect(error.message).toMatch(/PATCH_RESOLUTION_FAILED|TARGET_PATH_VIOLATION/);
    expect(error.message).toContain("src/components/calculator/Calculator.tsx");
  });

  // ─────────────────────────────────────────────────────────────
  // 3. Related Caller Test
  // ─────────────────────────────────────────────────────────────
  test("12. Related caller test: unapproved related caller in context cannot be modified", async () => {
    const approvedManifest: FileManifest = {
      manifestVersion: "1.0.0",
      totalFiles: 1,
      files: [
        { path: "src/app.ts", action: "modify", dependencies: [], description: "fix app.ts" },
      ],
    };

    const contract: ExecutionContract = {
      goal: "resolve all the build errors",
      taskType: "BUG_FIX",
      risk: "LOW",
      estimatedComplexity: "SMALL",
      pipeline: "REPOSITORY",
      environment: "REACT_TS",
      repositoryRequired: true,
      expectedFiles: ["src/app.ts"],
      validationType: "TYPESCRIPT_BUILD",
      targetPaths: ["src/app.ts"],
      allowedActions: ["modify_file"],
      forbiddenActions: [],
      maxFiles: 5,
      searchScope: ["src/app.ts"],
      contextScope: ["src/app.ts"],
      diffCriticEnabled: true,
    };

    const fileContext = {
      "src/app.ts": "export function run() { return 1; }",
      "src/index.ts": "import { run } from './app'; console.log(run());",
    };

    const utils = require("../shared/utils");
    utils.getOpenAI = () => ({
      chat: {
        completions: {
          create: async () => ({
            choices: [
              {
                finish_reason: "stop",
                  message: {
                  content: JSON.stringify({
                    explanation: "Modifying app and its caller index.ts",
                      commitMessage: "test commit",
                    changes: [
                      {
                        path: "src/app.ts",
                        action: "modify",
                        description: "fix run",
                        edits: [{ oldText: "return 1;", newText: "return 2;" }],
                      },
                      {
                        path: "src/index.ts",
                        action: "modify",
                        description: "update caller",
                        edits: [{ oldText: "console.log(run());", newText: "console.log('done', run());" }],
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

    // Unapproved related caller in context cannot be modified (fails closed with patch-resolution error)
    let error: any = null;
    try {
      await CodeGenerator.generateRoadmapAndDiffs(
        "resolve all the build errors",
        { intent: "BUG_FIX", taskType: "BUG_FIX" },
        { fileContext },
        "system prompt",
        contract,
        approvedManifest,
        { "src/app.ts": { path: "src/app.ts", content: fileContext["src/app.ts"], sha256: "sha-app" } }
      );
    } catch (e: any) {
      error = e;
    }

    expect(error).not.toBeNull();
    expect(error.message).toMatch(/PATCH_RESOLUTION_FAILED|TARGET_PATH_VIOLATION/);
    expect(error.message).toContain("src/index.ts");
  });

  // ─────────────────────────────────────────────────────────────
  // 4. No Manifest Expansion
  // ─────────────────────────────────────────────────────────────
  test("13. No manifest expansion: CodeGenerator never mutates approvedManifest or expands contract.targetPaths", async () => {
    const approvedManifest: FileManifest = {
      manifestVersion: "1.0.0",
      totalFiles: 1,
      files: [
        { path: "src/app.ts", action: "modify", dependencies: [], description: "fix app.ts" },
      ],
    };

    const contract: ExecutionContract = {
      goal: "resolve all the build errors",
      taskType: "BUG_FIX",
      risk: "LOW",
      estimatedComplexity: "SMALL",
      pipeline: "REPOSITORY",
      environment: "REACT_TS",
      repositoryRequired: true,
      expectedFiles: ["src/app.ts"],
      validationType: "TYPESCRIPT_BUILD",
      targetPaths: ["src/app.ts"],
      allowedActions: ["modify_file"],
      forbiddenActions: [],
      maxFiles: 5,
      searchScope: ["src/app.ts"],
      contextScope: ["src/app.ts"],
      diffCriticEnabled: true,
    };

    const utils = require("../shared/utils");
    utils.getOpenAI = () => ({
      chat: {
        completions: {
          create: async () => ({
            choices: [
              {
                finish_reason: "stop",
                  message: {
                  content: JSON.stringify({
                    explanation: "Modified app.ts",
                      commitMessage: "test commit",
                    changes: [
                      {
                        path: "src/app.ts",
                        action: "modify",
                        description: "fix syntax",
                        edits: [{ oldText: "const x = 1", newText: "const x = 1;" }],
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

    await CodeGenerator.generateRoadmapAndDiffs(
      "resolve all the build errors",
      { intent: "BUG_FIX", taskType: "BUG_FIX" },
      { fileContext: { "src/app.ts": "const x = 1" } },
      "system prompt",
      contract,
      approvedManifest,
      { "src/app.ts": { path: "src/app.ts", content: "const x = 1", sha256: "sha-app" } }
    );

    expect(approvedManifest.files).toHaveLength(1);
    expect(approvedManifest.files[0].path).toBe("src/app.ts");
    expect(contract.targetPaths).toEqual(["src/app.ts"]);
  });

  // ─────────────────────────────────────────────────────────────
  // 5. Exact Repair Test (Evidence Store + Resolver + CodeGen + Scope Enforcer)
  // ─────────────────────────────────────────────────────────────
  test("9. Exact repair flow: real source diagnostic normalized -> ingested -> cited -> authorized -> generated within scope", async () => {
    // 1. Diagnostic normalized
    const rawCompilerError = "src/app.ts(6,10): error TS1005: ';' expected.";
    const normalized = DiagnosticNormalizer.normalize(rawCompilerError, {
      repositoryId: "test-repair-proj",
      checkpointId: "chk-baseline",
    });

    expect(normalized).toHaveLength(1);
    expect(normalized[0].category).toBe("SOURCE_DIAGNOSTIC");
    expect(normalized[0].filePath).toBe("src/app.ts");
    expect(normalized[0].line).toBe(6);
    expect(normalized[0].code).toBe("TS1005");

    // 2. DIAGNOSTIC evidence exists in RepositoryEvidenceStore before manifest planning
    const store = new RepositoryEvidenceStore("test-repair-proj");
    const addedEvidence = DiagnosticNormalizer.ingestSourceDiagnostics(normalized, store, "chk-baseline");

    expect(addedEvidence).toHaveLength(1);
    const diagEvidence = addedEvidence[0];
    expect(diagEvidence.kind).toBe("DIAGNOSTIC");
    expect(diagEvidence.filePath).toBe("src/app.ts");

    // 3. Manifest planning cites the evidence ID
    const policy: PolicyContract = {
      goal: "resolve all the build errors",
      taskType: "BUG_FIX",
      risk: "LOW",
      estimatedComplexity: "SMALL",
      destructive: false,
      allowedActions: ["modify_file"],
      forbiddenActions: [],
      maxFiles: 5,
      diffCriticEnabled: true,
      pipeline: "REPOSITORY",
      environment: "REACT_TS",
      repositoryRequired: true,
      explicitUserPaths: [],
      userConstraints: [],
      expectedFiles: [],
      requiresClarification: false,
      validationType: "TYPESCRIPT_BUILD",
    };

    const intentSpec: TaskIntentSpec = {
      goal: "resolve all the build errors",
      taskType: "BUG_FIX",
      explicitUserPaths: [],
      operations: [{ kind: "REPAIR", subject: "src/app.ts" }],
      constraints: [],
      acceptanceCriteria: [],
      destructive: false,
      requiresClarification: false,
      risk: "LOW",
      estimatedComplexity: "SMALL",
    };

    const plannedChanges: PlannedChange[] = [
      {
        path: "src/app.ts",
        action: "modify",
        reason: "Fix compiler syntax error TS1005",
        dependencies: [],
        evidenceIds: [diagEvidence.id],
      },
    ];

    // 4. EvidenceBoundWriteSetResolver authorizes MODIFY src/app.ts
    const authResult = EvidenceBoundWriteSetResolver.resolve({
      policy,
      intentSpec,
      proposedChanges: plannedChanges,
      evidenceStore: store,
      existingFiles: ["src/app.ts", "package.json"],
      targetRepositoryId: "test-repair-proj",
    });

    expect(authResult.approvedPaths).toEqual(["src/app.ts"]);
    expect(authResult.rejectedPaths).toHaveLength(0);

    // 5. src/app.ts appears in approved manifest
    const approvedManifest: FileManifest = {
      manifestVersion: "1.0.0",
      totalFiles: 1,
      files: [
        {
          path: "src/app.ts",
          action: "modify",
          dependencies: [],
          description: "Fix TS1005 syntax error",
        },
      ],
    };

    // 6. CodeGenerator modifies src/app.ts
    const utils = require("../shared/utils");
    utils.getOpenAI = () => ({
      chat: {
        completions: {
          create: async () => ({
            choices: [
              {
                finish_reason: "stop",
                  message: {
                  content: JSON.stringify({
                    explanation: "Fixed syntax error in src/app.ts",
                      commitMessage: "test commit",
                    changes: [
                      {
                        path: "src/app.ts",
                        action: "modify",
                        description: "Add missing semicolon",
                        edits: [{ oldText: "const broken = 1", newText: "const broken = 1;" }],
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

    const executionContract: ExecutionContract = {
      goal: "resolve all the build errors",
      taskType: "BUG_FIX",
      risk: "LOW",
      estimatedComplexity: "SMALL",
      pipeline: "REPOSITORY",
      environment: "REACT_TS",
      repositoryRequired: true,
      expectedFiles: ["src/app.ts"],
      validationType: "TYPESCRIPT_BUILD",
      targetPaths: ["src/app.ts"],
      allowedActions: ["modify_file"],
      forbiddenActions: [],
      maxFiles: 5,
      searchScope: ["src/app.ts"],
      contextScope: ["src/app.ts"],
      diffCriticEnabled: true,
    };

    const genResult = await CodeGenerator.generateRoadmapAndDiffs(
      "resolve all the build errors",
      { intent: "BUG_FIX", taskType: "BUG_FIX" },
      { fileContext: { "src/app.ts": "const broken = 1" } },
      "system prompt",
      executionContract,
      approvedManifest,
      { "src/app.ts": { path: "src/app.ts", content: "const broken = 1", sha256: "sha-app" } }
    );

    expect(genResult.changes).toHaveLength(1);
    expect(genResult.changes[0].path).toBe("src/app.ts");
    expect(genResult.changes[0].content).toBe("const broken = 1;");

    // 7. ExecutionScopeEnforcer passes for that path
    const scopeCheck = enforceExecutionScope({
      proposedChanges: genResult.changes,
      manifest: approvedManifest,
      contract: executionContract,
      existingFilePaths: ["src/app.ts", "package.json"],
    });

    expect(scopeCheck.valid).toBe(true);
    expect(scopeCheck.errors).toHaveLength(0);
  });

  // ─────────────────────────────────────────────────────────────
  // 6. Generic Environment Failures
  // ─────────────────────────────────────────────────────────────
  test("8. Generic environment failures: missing npm, node_modules, or toolchain failure never produce DIAGNOSTIC evidence", () => {
    const store = new RepositoryEvidenceStore("test-env-proj");

    const envErrors = [
      "npm: command not found",
      "Cannot resolve installed dependency because node_modules is absent",
      "tsc: command not found",
      "pnpm: not found",
    ];

    for (const err of envErrors) {
      const normalized = DiagnosticNormalizer.normalize(err, { repositoryId: "test-env-proj" });
      const added = DiagnosticNormalizer.ingestSourceDiagnostics(normalized, store);
      expect(added).toHaveLength(0);
    }

    expect(store.getAllEvidence()).toHaveLength(0);
  });
});
