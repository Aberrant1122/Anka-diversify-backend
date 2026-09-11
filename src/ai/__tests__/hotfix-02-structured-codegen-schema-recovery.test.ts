import fs from "fs";
import os from "os";
import path from "path";
import { LLMGateway } from "../gateway/LLMGateway";
import { LLMTelemetry } from "../gateway/LLMTelemetry";
import { LLMSchemaInvalidError } from "../gateway/LLMError";
import { PipelineStages } from "../gateway/PipelineStage";
import { CodeGenerator } from "../generation/CodeGenerator";
import { ExecutionContract, FileManifest } from "../../types";
import { AuthorizedCapabilityScope, CapabilityGuard } from "../runtime/CapabilityGuard";
import { TaskRuntime } from "../runtime/TaskRuntime";
import { AgentWorkspaceState } from "../runtime/AgentWorkspaceState";
import { VerifiedCheckpointJournal } from "../runtime/VerifiedCheckpointJournal";
import { CompletionEvaluator } from "../runtime/CompletionEvaluator";
import { IMPLEMENTATION_PLANNER_PROMPT } from "../prompts/coding";
import * as utils from "../shared/utils";

describe("Production Acceptance Hotfix 02: Structured Code-Generation Schema Recovery", () => {
  let workspace: string;
  let telemetry: LLMTelemetry;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "hotfix-02-codegen-"));
    fs.mkdirSync(path.join(workspace, "lib"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "lib", "mock-data.ts"), "export function getTasksByProject(projectId: string) { return tasks.filter((t) => t.projectId === projectId); }\n", "utf8");
    fs.writeFileSync(path.join(workspace, "src", "a.ts"), "export const a = 1;\n", "utf8");
    fs.writeFileSync(path.join(workspace, "src", "protected.ts"), "export const secret = 42;\n", "utf8");

    telemetry = new LLMTelemetry();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (fs.existsSync(workspace)) {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  function createCodeGenMockClient(responses: Array<{ choices: any[] }>) {
    let callIdx = 0;
    const client = {
      chat: {
        completions: {
          create: jest.fn().mockImplementation(async (params: any) => {
            const isRoadmap = params.messages?.some(
              (m: any) => m.content === IMPLEMENTATION_PLANNER_PROMPT
            );
            if (isRoadmap) {
              const target = params.messages?.some(
                (m: any) => typeof m.content === "string" && m.content.includes("mock-data.ts")
              )
                ? "lib/mock-data.ts"
                : "src/a.ts";
              return {
                choices: [
                  {
                    message: {
                      content: JSON.stringify({
                        roadmap: [
                          {
                            phase: 1,
                            title: "Apply changes",
                            targetFiles: [target],
                            description: "Apply changes",
                          },
                        ],
                      }),
                    },
                    finish_reason: "stop",
                  },
                ],
              };
            }
            const res = responses[callIdx++];
            return res;
          }),
        },
      },
    } as any;
    return client;
  }

  // ── TEST A: Valid first response → no repair retry ──
  test("TEST A: Valid first response succeeds immediately without repair retry", async () => {
    const mockClient = {
      chat: {
        completions: {
          create: jest.fn().mockResolvedValue({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    explanation: "Valid modify proposal on first attempt",
                    commitMessage: "feat: valid modify",
                    changes: [
                      {
                        path: "src/a.ts",
                        action: "modify",
                        description: "update a",
                        edits: [{ oldText: "export const a = 1;", newText: "export const a = 2;" }],
                      },
                    ],
                  }),
                },
                finish_reason: "stop",
              },
            ],
          }),
        },
      },
    } as any;

    const gateway = new LLMGateway(telemetry);
    const result = await gateway.callStructured({
      stage: PipelineStages.CODE_GENERATION,
      messages: [{ role: "user", content: "Implement change in src/a.ts" }],
      openaiClient: mockClient,
      schema: {
        name: "TestCodeGenSchema",
        validate: (parsed: any) => {
          if (!parsed?.changes?.[0]?.edits) return { valid: false, errors: ["Missing edits"] };
          return { valid: true, data: parsed };
        },
      },
    });

    expect(mockClient.chat.completions.create).toHaveBeenCalledTimes(1);
    expect(result.content.changes[0].action).toBe("modify");
    expect(result.content.changes[0].edits[0].newText).toBe("export const a = 2;");
    const retryEvents = telemetry.getEvents().filter((e) => e.name === "llm.retry");
    expect(retryEvents).toHaveLength(0);
  });

  // ── TEST B & D: Exact production regression: legacy MODIFY using content → repair requested → accepted ──
  test("TEST B & D (Production Regression): Malformed response with content/isDeleted triggers bounded repair retry and accepts canonical edits[]", async () => {
    const originalFileContent = fs.readFileSync(path.join(workspace, "lib", "mock-data.ts"), "utf8");

    const mockClient = createCodeGenMockClient([
      // Attempt 1: Malformed production payload (content on modify, missing edits)
      {
        choices: [
          {
            message: {
              content: JSON.stringify({
                explanation: "Found getTasksByProject bug in mock-data.ts",
                commitMessage: "fix: filter tasks by project id correctly",
                changes: [
                  {
                    path: "lib/mock-data.ts",
                    action: "modify",
                    content: "export function getTasksByProject(projectId: string) { return tasks.filter((t) => String(t.projectId) === String(projectId)); }\n",
                    isDeleted: false,
                    description: "Fix getTasksByProject filter logic",
                  },
                ],
              }),
            },
            finish_reason: "stop",
          },
        ],
      },
      // Attempt 2: Repaired canonical schema with edits[]
      {
        choices: [
          {
            message: {
              content: JSON.stringify({
                explanation: "Found getTasksByProject bug in mock-data.ts (repaired schema)",
                commitMessage: "fix: filter tasks by project id correctly",
                changes: [
                  {
                    path: "lib/mock-data.ts",
                    action: "modify",
                    description: "Fix getTasksByProject filter logic",
                    edits: [
                      {
                        oldText: "tasks.filter((t) => t.projectId === projectId)",
                        newText: "tasks.filter((t) => String(t.projectId) === String(projectId))",
                      },
                    ],
                  },
                ],
              }),
            },
            finish_reason: "stop",
          },
        ],
      },
    ]);

    jest.spyOn(utils, "getOpenAI").mockReturnValue(mockClient);

    const manifest: FileManifest = {
      manifestVersion: "1.0.0",
      totalFiles: 1,
      files: [{ path: "lib/mock-data.ts", action: "modify", dependencies: [], description: "Fix mock data" }],
    };

    const contract: ExecutionContract = {
      goal: "Fix mock data",
      taskType: "BUG_FIX",
      pipeline: "REPOSITORY",
      environment: "REACT_TS",
      targetPaths: ["lib/mock-data.ts"],
      expectedFiles: ["lib/mock-data.ts"],
      estimatedComplexity: "SMALL",
      risk: "LOW",
      repositoryRequired: true,
      validationType: "TYPESCRIPT_BUILD",
      allowedActions: ["modify"],
      forbiddenActions: [],
      maxFiles: 5,
      searchScope: ["lib"],
      contextScope: ["lib"],
      diffCriticEnabled: true,
    };

    const authorSources = {
      "lib/mock-data.ts": {
        path: "lib/mock-data.ts",
        content: originalFileContent,
        sha256: "dummy-sha",
      },
    };

    const result = await CodeGenerator.generateRoadmapAndDiffs(
      "Fix getTasksByProject in mock-data.ts",
      { intent: "BUG_FIX", targetPath: "lib/mock-data.ts" },
      { fileContext: { "lib/mock-data.ts": originalFileContent } },
      "system prompt",
      contract,
      manifest,
      authorSources,
    );

    const codeGenCalls = mockClient.chat.completions.create.mock.calls.filter(
      (c: any) => !c[0].messages?.some((m: any) => m.content === IMPLEMENTATION_PLANNER_PROMPT)
    );

    // Initial response was rejected, repair was invoked once
    expect(codeGenCalls).toHaveLength(2);

    // Second call contained repair instructions with validator error context
    const secondCallPayload = codeGenCalls[1][0];
    const userRepairMessage = secondCallPayload.messages.find(
      (m: any) => m.role === "user" && m.content.includes("VALIDATION ERRORS:")
    );
    expect(userRepairMessage).toBeDefined();
    expect(userRepairMessage.content).toContain("modify requires a non-empty edits array");
    expect(userRepairMessage.content).toContain("modify cannot contain content or isDeleted");
    expect(userRepairMessage.content).toContain("REPAIR INSTRUCTIONS:");

    // Repaired model output uses canonical edits[] format and was resolved into safe primitive
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].path).toBe("lib/mock-data.ts");
    expect(result.changes[0].action).toBe("modify");
    expect(result.changes[0].editPrimitive?.type).toBe("PATCH_HUNK");

    // Zero filesystem mutation occurred before execution boundary
    expect(fs.readFileSync(path.join(workspace, "lib", "mock-data.ts"), "utf8")).toBe(originalFileContent);
  });

  // ── TEST C: MODIFY missing edits[] → repair requested ──
  test("TEST C: MODIFY missing edits[] triggers repair retry and accepts valid proposal", async () => {
    const mockClient = createCodeGenMockClient([
      {
        choices: [
          {
            message: {
              content: JSON.stringify({
                explanation: "Missing edits array entirely",
                commitMessage: "feat: broken modify",
                changes: [
                  {
                    path: "src/a.ts",
                    action: "modify",
                    description: "update a without edits array",
                  },
                ],
              }),
            },
            finish_reason: "stop",
          },
        ],
      },
      {
        choices: [
          {
            message: {
              content: JSON.stringify({
                explanation: "Fixed missing edits array",
                commitMessage: "feat: valid modify",
                changes: [
                  {
                    path: "src/a.ts",
                    action: "modify",
                    description: "update a with edits",
                    edits: [{ oldText: "export const a = 1;", newText: "export const a = 100;" }],
                  },
                ],
              }),
            },
            finish_reason: "stop",
          },
        ],
      },
    ]);

    jest.spyOn(utils, "getOpenAI").mockReturnValue(mockClient);

    const manifest: FileManifest = {
      manifestVersion: "1.0.0",
      totalFiles: 1,
      files: [{ path: "src/a.ts", action: "modify", dependencies: [], description: "Update a" }],
    };

    const authorSources = {
      "src/a.ts": { path: "src/a.ts", content: "export const a = 1;\n", sha256: "sha-a" },
    };

    const result = await CodeGenerator.generateRoadmapAndDiffs(
      "Update a",
      { intent: "FEATURE", targetPath: "src/a.ts" },
      { fileContext: { "src/a.ts": "export const a = 1;\n" } },
      "system prompt",
      undefined,
      manifest,
      authorSources,
    );

    const codeGenCalls = mockClient.chat.completions.create.mock.calls.filter(
      (c: any) => !c[0].messages?.some((m: any) => m.content === IMPLEMENTATION_PLANNER_PROMPT)
    );

    expect(codeGenCalls).toHaveLength(2);
    expect(result.changes[0].action).toBe("modify");
    expect(result.changes[0].editPrimitive?.type).toBe("PATCH_HUNK");
  });

  // ── TEST E: Repair remains invalid → technical failure, zero mutation ──
  test("TEST E: If repair attempt remains invalid, fails closed with LLMSchemaInvalidError and zero mutation", async () => {
    const originalA = fs.readFileSync(path.join(workspace, "src", "a.ts"), "utf8");

    const mockClient = createCodeGenMockClient([
      {
        choices: [
          {
            message: {
              content: JSON.stringify({
                explanation: "Attempt 1 invalid",
                commitMessage: "bad 1",
                changes: [{ path: "src/a.ts", action: "modify", content: "full replacement", description: "d" }],
              }),
            },
            finish_reason: "stop",
          },
        ],
      },
      {
        choices: [
          {
            message: {
              content: JSON.stringify({
                explanation: "Attempt 2 still invalid",
                commitMessage: "bad 2",
                changes: [{ path: "src/a.ts", action: "modify", content: "still full replacement", description: "d" }],
              }),
            },
            finish_reason: "stop",
          },
        ],
      },
    ]);

    jest.spyOn(utils, "getOpenAI").mockReturnValue(mockClient);

    const manifest: FileManifest = {
      manifestVersion: "1.0.0",
      totalFiles: 1,
      files: [{ path: "src/a.ts", action: "modify", dependencies: [], description: "Update a" }],
    };

    await expect(
      CodeGenerator.generateRoadmapAndDiffs(
        "Update a",
        { intent: "FEATURE" },
        { fileContext: { "src/a.ts": originalA } },
        "system prompt",
        undefined,
        manifest,
        { "src/a.ts": { path: "src/a.ts", content: originalA, sha256: "sha-a" } },
      )
    ).rejects.toThrow(LLMSchemaInvalidError);

    const codeGenCalls = mockClient.chat.completions.create.mock.calls.filter(
      (c: any) => !c[0].messages?.some((m: any) => m.content === IMPLEMENTATION_PLANNER_PROMPT)
    );

    // Exactly 2 calls: 1 initial + 1 repair attempt. Bounded!
    expect(codeGenCalls).toHaveLength(2);

    // ZERO filesystem mutation
    expect(fs.readFileSync(path.join(workspace, "src", "a.ts"), "utf8")).toBe(originalA);
  });

  // ── TEST F: Repair expands scope → CapabilityGuard still rejects unauthorized target ──
  test("TEST F: If repair response expands scope to unauthorized file, CapabilityGuard rejects it", async () => {
    const mockClient = createCodeGenMockClient([
      {
        choices: [
          {
            message: {
              content: JSON.stringify({
                explanation: "Initial malformed proposal",
                commitMessage: "fix",
                changes: [{ path: "src/a.ts", action: "modify", content: "replacement", description: "bad" }],
              }),
            },
            finish_reason: "stop",
          },
        ],
      },
      {
        choices: [
          {
            message: {
              content: JSON.stringify({
                explanation: "Repaired schema, but sneaks in protected file",
                commitMessage: "fix and breach",
                changes: [
                  {
                    path: "src/a.ts",
                    action: "modify",
                    description: "update a",
                    edits: [{ oldText: "export const a = 1;", newText: "export const a = 2;" }],
                  },
                  {
                    path: "src/protected.ts",
                    action: "modify",
                    description: "tamper with protected file",
                    edits: [{ oldText: "export const secret = 42;", newText: "export const secret = 0;" }],
                  },
                ],
              }),
            },
            finish_reason: "stop",
          },
        ],
      },
    ]);

    jest.spyOn(utils, "getOpenAI").mockReturnValue(mockClient);

    const manifest: FileManifest = {
      manifestVersion: "1.0.0",
      totalFiles: 1,
      files: [{ path: "src/a.ts", action: "modify", dependencies: [], description: "Update a" }],
    };

    const genResult = await CodeGenerator.generateRoadmapAndDiffs(
      "Update a",
      { intent: "FEATURE" },
      {
        fileContext: {
          "src/a.ts": "export const a = 1;\n",
          "src/protected.ts": "export const secret = 42;\n",
        },
      },
      "system prompt",
      undefined,
      manifest,
      {
        "src/a.ts": { path: "src/a.ts", content: "export const a = 1;\n", sha256: "sha-a" },
        "src/protected.ts": { path: "src/protected.ts", content: "export const secret = 42;\n", sha256: "sha-p" },
      },
    );

    // Repair passed schema validation, but returned 2 changes
    expect(genResult.changes).toHaveLength(2);

    // CapabilityGuard authorizes only src/a.ts
    const authorizedScope = AuthorizedCapabilityScope.fromBackendConfiguration({
      workspaceRoot: workspace,
      authorityId: "test-auth-scope",
      grants: [{ path: "src/a.ts", action: "FILE_MODIFY" }],
    })!;

    const guard = CapabilityGuard.create({
      workspaceRoot: workspace,
      scopeId: "stage-exec",
      authorizedScope,
    });

    const decisionA = guard.authorize({ action: "FILE_MODIFY", path: "src/a.ts", scopeId: "stage-exec" });
    expect(decisionA.allowed).toBe(true);

    const decisionProtected = guard.authorize({ action: "FILE_MODIFY", path: "src/protected.ts", scopeId: "stage-exec" });
    expect(decisionProtected.allowed).toBe(false);
    expect(decisionProtected.code).toBe("CAPABILITY_PATH_NOT_DECLARED");
  });

  // ── TEST G: Repair changes semantic operation → normal downstream validation required ──
  test("TEST G: Schema-valid repaired output still requires downstream verification", async () => {
    // A proposal that is schema-valid does not equal task completion or build pass
    const mockClient = createCodeGenMockClient([
      {
        choices: [
          {
            message: {
              content: JSON.stringify({
                explanation: "Malformed",
                commitMessage: "bad",
                changes: [{ path: "src/a.ts", action: "modify", content: "syntax error", description: "bad" }],
              }),
            },
            finish_reason: "stop",
          },
        ],
      },
      {
        choices: [
          {
            message: {
              content: JSON.stringify({
                explanation: "Schema repaired but introduces TypeScript error",
                commitMessage: "fix syntax error",
                changes: [
                  {
                    path: "src/a.ts",
                    action: "modify",
                    description: "syntax error edit",
                    edits: [{ oldText: "export const a = 1;", newText: "export const a: number = 'string_type_error';" }],
                  },
                ],
              }),
            },
            finish_reason: "stop",
          },
        ],
      },
    ]);

    jest.spyOn(utils, "getOpenAI").mockReturnValue(mockClient);

    const manifest: FileManifest = {
      manifestVersion: "1.0.0",
      totalFiles: 1,
      files: [{ path: "src/a.ts", action: "modify", dependencies: [], description: "Update a" }],
    };

    const genResult = await CodeGenerator.generateRoadmapAndDiffs(
      "Update a",
      { intent: "FEATURE" },
      { fileContext: { "src/a.ts": "export const a = 1;\n" } },
      "system prompt",
      undefined,
      manifest,
      { "src/a.ts": { path: "src/a.ts", content: "export const a = 1;\n", sha256: "sha-a" } },
    );

    // Schema succeeded
    expect(genResult.changes[0].content).toContain("export const a: number = 'string_type_error';");
    // But generation output does NOT claim verification or bypass downstream compiler
    expect((genResult as any).buildPassed).toBeUndefined();
    expect((genResult as any).verified).toBeUndefined();
  });

  // ── TEST H & I: Malformed response cannot create VERIFIED checkpoint or completion success ──
  test("TEST H & I: Malformed generation failure cannot produce VERIFIED checkpoint or completion success", async () => {
    const runtime = TaskRuntime.create({
      taskId: "task-fail-schema",
      originalGoal: "Fix mock data",
      workspace: AgentWorkspaceState.create({ projectId: "proj", root: workspace, revision: "rev-0" }),
    });
    runtime.start();

    const journal = new VerifiedCheckpointJournal();
    // No checkpoints verified
    expect(journal.verifiedCheckpoints()).toHaveLength(0);

    // CompletionEvaluator refuses to declare completion without verified validation
    const completionResult = CompletionEvaluator.evaluate({
      runtime,
      handoff: { outcome: "AWAITING_COMPLETION_EVALUATION", workingPlanId: "plan-1", workingPlanRevision: 1 },
      journal,
      repository: {
        root: workspace,
        revision: "rev-1",
        changedPaths: [],
        source: "MATERIALIZED_REPOSITORY",
        coverage: "FULL_REPOSITORY_DELTA",
      },
      validation: { passed: false, repositoryRevision: "rev-1", source: "VALIDATION_COORDINATOR" },
      requirements: [{
        id: "req-1",
        description: "Must verify change",
        required: true,
        status: "UNSATISFIED",
        repositoryRevision: "rev-1",
        checkpointIds: [],
      }],
    });

    expect(completionResult.outcome).toBe("INCOMPLETE");
    expect(journal.verifiedCheckpoints()).toHaveLength(0);
  });

  // ── TEST J: Bounded retry count cannot loop indefinitely ──
  test("TEST J: Bounded retry count terminates after at most 1 repair retry even if maxRetries is high", async () => {
    const gateway = new LLMGateway(telemetry);
    const mockClient = {
      chat: {
        completions: {
          create: jest.fn().mockResolvedValue({
            choices: [
              {
                message: {
                  content: JSON.stringify({ invalidKey: true }),
                },
                finish_reason: "stop",
              },
            ],
          }),
        },
      },
    } as any;

    await expect(
      gateway.callStructured({
        stage: PipelineStages.CODE_GENERATION,
        messages: [{ role: "user", content: "code" }],
        maxRetries: 5, // High maxRetries configured!
        openaiClient: mockClient,
        schema: {
          name: "TestSchema",
          schema: { type: "object", required: ["validKey"] },
          validate: (parsed: any) => ({
            valid: Boolean(parsed?.validKey),
            errors: ["Missing required validKey"],
          }),
        },
      })
    ).rejects.toThrow(LLMSchemaInvalidError);

    // Must be called at most 2 times: Attempt 1 + Attempt 2 (the 1 bounded repair retry)
    expect(mockClient.chat.completions.create).toHaveBeenCalledTimes(2);

    const retryEvents = telemetry.getEvents().filter((e) => e.name === "llm.retry");
    expect(retryEvents).toHaveLength(1);
  });
});
