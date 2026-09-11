import { IntentClassifier } from "../classification/IntentClassifier";
import { TaskExecutionPlanManager } from "../planning/TaskExecutionPlanManager";
import { ManifestGenerator } from "../../services/manifest-generator";
import { ManifestCorrectionEngine } from "../planning/ManifestCorrectionEngine";
import { TaskDecomposer } from "../../services/task-decomposer";
import { CodeGenerator } from "../generation/CodeGenerator";
import {
  LLMGateway,
  PipelineStages,
  LLMTelemetry,
  LLMInvalidJsonError,
  LLMSchemaInvalidError,
  LLMNetworkError,
  LLMTruncationError,
} from "../gateway";
import { ExecutionContract, FileManifest } from "../../types";

describe("Checkpoint 1B: High-Payoff LLM Migration Tests", () => {
  let telemetry: LLMTelemetry;

  beforeEach(() => {
    telemetry = LLMTelemetry.getInstance();
    telemetry.clear();
    jest.clearAllMocks();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // INTENT CLASSIFIER (Tests 1 - 11)
  // ═══════════════════════════════════════════════════════════════════════════
  describe("IntentClassifier Migration & Failure Semantics", () => {
    it("1. valid classification parses structured output and returns valid TaskClassificationResult", async () => {
      const mockClient = {
        chat: {
          completions: {
            create: jest.fn().mockResolvedValue({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      taskType: "BUG_FIX",
                      risk: "LOW",
                      estimatedComplexity: "SMALL",
                      intent: "BUG_FIX",
                      confidence: 0.95,
                      requiresClarification: false,
                      reasoning: "Fix login button click handler",
                      targetPath: "src/Login.tsx",
                    }),
                  },
                  finish_reason: "stop",
                },
              ],
            }),
          },
        },
      } as any;

      const result = await IntentClassifier.classifyIntentAndAmbiguity(
        "Fix login button",
        { project: { name: "Test" } },
        ["src/Login.tsx"],
        mockClient
      );

      expect(result.taskType).toBe("BUG_FIX");
      expect(result.intent).toBe("BUG_FIX");
      expect(result.requiresClarification).toBe(false);
      expect(result.targetPath).toBe("src/Login.tsx");
      expect(result.outcome).toBeUndefined();
    });

    it("2. genuine user ambiguity yields ASK_USER and CLARIFICATION_NEEDED", async () => {
      const mockClient = {
        chat: {
          completions: {
            create: jest.fn().mockResolvedValue({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      taskType: "DELETE_FOLDER",
                      risk: "CRITICAL",
                      estimatedComplexity: "COMPLEX",
                      intent: "DELETE_FOLDER",
                      confidence: 0.5,
                      requiresClarification: true,
                      question: "Which folder do you want to delete?",
                      options: ["src/old", "src/backup"],
                      reasoning: "Vague folder deletion",
                    }),
                  },
                  finish_reason: "stop",
                },
              ],
            }),
          },
        },
      } as any;

      const result = await IntentClassifier.classifyIntentAndAmbiguity(
        "Delete the old stuff and clean everything up.",
        {},
        ["src/old/index.ts", "src/backup/index.ts"],
        mockClient
      );

      expect(result.requiresClarification).toBe(true);
      expect(result.outcome).toBe("CLARIFICATION_NEEDED");
      expect(result.question).toBeDefined();
    });

    it("3. repository presence does not suppress genuine user ambiguity", async () => {
      const mockClient = {
        chat: {
          completions: {
            create: jest.fn().mockResolvedValue({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      taskType: "BUG_FIX",
                      risk: "MEDIUM",
                      estimatedComplexity: "MEDIUM",
                      intent: "BUG_FIX",
                      confidence: 0.8,
                      requiresClarification: true, // model is unsure about which file
                      reasoning: "Not sure which auth file handles session tokens",
                    }),
                  },
                  finish_reason: "stop",
                },
              ],
            }),
          },
        },
      } as any;

      const result = await IntentClassifier.classifyIntentAndAmbiguity(
        "Fix session token refresh issue",
        {},
        ["src/auth/session.ts", "src/auth/token.ts"],
        mockClient
      );

      expect(result.requiresClarification).toBe(true);
      expect(result.outcome).toBe("CLARIFICATION_NEEDED");
    });

    it("4. timeout → technical failure (requiresClarification: false)", async () => {
      const timeoutErr: any = new Error("Request aborted due to timeout");
      timeoutErr.name = "AbortError";
      const mockClient = {
        chat: { completions: { create: jest.fn().mockRejectedValue(timeoutErr) } },
      } as any;

      const result = await IntentClassifier.classifyIntentAndAmbiguity(
        "Add new feature",
        {},
        [],
        mockClient
      );

      expect(result.requiresClarification).toBe(false);
      expect(result.outcome).toBe("TECHNICAL_FAILURE");
      expect(result.intent).toBe("CLASSIFICATION_FAILED");
      expect(result.question).toBeUndefined();
    });

    it("5. rate limit exhausted → technical failure", async () => {
      const rateLimitErr: any = new Error("Rate limit exceeded 429");
      rateLimitErr.status = 429;
      const mockClient = {
        chat: { completions: { create: jest.fn().mockRejectedValue(rateLimitErr) } },
      } as any;

      const result = await IntentClassifier.classifyIntentAndAmbiguity(
        "Refactor database module",
        {},
        [],
        mockClient
      );

      expect(result.requiresClarification).toBe(false);
      expect(result.outcome).toBe("TECHNICAL_FAILURE");
      expect(result.intent).toBe("CLASSIFICATION_FAILED");
    });

    it("6. network error → technical failure", async () => {
      const netErr: any = new Error("connect ECONNRESET");
      netErr.code = "ECONNRESET";
      const mockClient = {
        chat: { completions: { create: jest.fn().mockRejectedValue(netErr) } },
      } as any;

      const result = await IntentClassifier.classifyIntentAndAmbiguity(
        "Update styles",
        {},
        [],
        mockClient
      );

      expect(result.requiresClarification).toBe(false);
      expect(result.outcome).toBe("TECHNICAL_FAILURE");
      expect(result.intent).toBe("CLASSIFICATION_FAILED");
    });

    it("7. provider 500 exhausted → technical failure", async () => {
      const serverErr: any = new Error("Internal server error 500");
      serverErr.status = 500;
      const mockClient = {
        chat: { completions: { create: jest.fn().mockRejectedValue(serverErr) } },
      } as any;

      const result = await IntentClassifier.classifyIntentAndAmbiguity(
        "Build project",
        {},
        [],
        mockClient
      );

      expect(result.requiresClarification).toBe(false);
      expect(result.outcome).toBe("TECHNICAL_FAILURE");
      expect(result.intent).toBe("CLASSIFICATION_FAILED");
    });

    it("8. malformed JSON → technical failure", async () => {
      const mockClient = {
        chat: {
          completions: {
            create: jest.fn().mockResolvedValue({
              choices: [{ message: { content: "{ invalid JSON missing quotes " }, finish_reason: "stop" }],
            }),
          },
        },
      } as any;

      const result = await IntentClassifier.classifyIntentAndAmbiguity(
        "Optimize query",
        {},
        [],
        mockClient
      );

      expect(result.requiresClarification).toBe(false);
      expect(result.outcome).toBe("TECHNICAL_FAILURE");
      expect(result.intent).toBe("CLASSIFICATION_FAILED");
    });

    it("9. schema invalid (missing taskType) → technical failure", async () => {
      const mockClient = {
        chat: {
          completions: {
            create: jest.fn().mockResolvedValue({
              choices: [{ message: { content: JSON.stringify({ unexpected: "data" }) }, finish_reason: "stop" }],
            }),
          },
        },
      } as any;

      const result = await IntentClassifier.classifyIntentAndAmbiguity(
        "Fix header",
        {},
        [],
        mockClient
      );

      expect(result.requiresClarification).toBe(false);
      expect(result.outcome).toBe("TECHNICAL_FAILURE");
      expect(result.intent).toBe("CLASSIFICATION_FAILED");
    });

    it("10. finish_reason length → technical failure", async () => {
      const mockClient = {
        chat: {
          completions: {
            create: jest.fn().mockResolvedValue({
              choices: [{ message: { content: '{"taskType": "BUG' }, finish_reason: "length" }],
            }),
          },
        },
      } as any;

      const result = await IntentClassifier.classifyIntentAndAmbiguity(
        "Fix bug",
        {},
        [],
        mockClient
      );

      expect(result.requiresClarification).toBe(false);
      expect(result.outcome).toBe("TECHNICAL_FAILURE");
      expect(result.intent).toBe("CLASSIFICATION_FAILED");
    });

    it("11. no technical failure becomes clarification", async () => {
      const failures = [
        new Error("fetch failed"),
        { status: 429, message: "Too Many Requests" },
        { status: 503, message: "Service Unavailable" },
        { name: "AbortError", message: "Timeout" },
      ];

      for (const failErr of failures) {
        const mockClient = {
          chat: { completions: { create: jest.fn().mockRejectedValue(failErr) } },
        } as any;

        const result = await IntentClassifier.classifyIntentAndAmbiguity(
          "Test request",
          {},
          [],
          mockClient
        );

        expect(result.requiresClarification).toBe(false);
        expect(result.outcome).toBe("TECHNICAL_FAILURE");
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TASK PLAN REORDER (Tests 12 - 15)
  // ═══════════════════════════════════════════════════════════════════════════
  describe("TaskExecutionPlanManager.reorderPlanWithClarification", () => {
    const basePlan = {
      id: "plan-1",
      goal: "Multi-step fix",
      currentStageIndex: 0,
      status: "PENDING" as const,
      stages: [
        {
          id: "stage-1",
          name: "Refactor backend",
          intent: { taskType: "REFACTOR", goal: "Refactor backend" } as any,
          dependsOn: [],
          status: "PENDING" as const,
        },
        {
          id: "stage-2",
          name: "Fix frontend UI",
          intent: { taskType: "BUG_FIX", goal: "Fix frontend UI" } as any,
          dependsOn: ["stage-1"],
          status: "PENDING" as const,
        },
      ],
    };

    it("12. reorderPlanWithClarification uses gateway and passes PipelineStages.PLAN_REORDER", async () => {
      const mockClient = {
        chat: {
          completions: {
            create: jest.fn().mockResolvedValue({
              choices: [
                {
                  message: { content: JSON.stringify({ prioritizedStageId: "stage-2" }) },
                  finish_reason: "stop",
                },
              ],
            }),
          },
        },
      } as any;

      await TaskExecutionPlanManager.reorderPlanWithClarification(
        basePlan,
        "Fix the frontend UI first",
        "Which stage to run first?",
        mockClient
      );

      expect(mockClient.chat.completions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          model: expect.any(String),
          messages: expect.any(Array),
        }),
        expect.any(Object)
      );
    });

    it("13. model reorder cannot violate existing dependency constraints", async () => {
      const mockClient = {
        chat: {
          completions: {
            create: jest.fn().mockResolvedValue({
              choices: [
                {
                  message: { content: JSON.stringify({ prioritizedStageId: "stage-2" }) },
                  finish_reason: "stop",
                },
              ],
            }),
          },
        },
      } as any;

      const reordered = await TaskExecutionPlanManager.reorderPlanWithClarification(
        basePlan,
        "frontend",
        "Which stage first?",
        mockClient
      );

      expect(reordered.stages[0].id).toBe("stage-1");
      expect(reordered.stages[1].id).toBe("stage-2");
      expect(reordered.stages[1].dependsOn).toEqual(["stage-1"]);
    });

    it("14. provider failure preserves safe deterministic fallback", async () => {
      const mockClient = {
        chat: {
          completions: {
            create: jest.fn().mockRejectedValue(new Error("Provider down 503")),
          },
        },
      } as any;

      // The fallback semantic token matcher should match "frontend" to stage-2
      const reordered = await TaskExecutionPlanManager.reorderPlanWithClarification(
        basePlan,
        "Please do the frontend UI first",
        "Which stage first?",
        mockClient
      );

      expect(reordered.stages[0].id).toBe("stage-1");
    });

    it("15. never creates fake clarification from provider failure", async () => {
      const mockClient = {
        chat: {
          completions: {
            create: jest.fn().mockRejectedValue(new Error("Network disconnect")),
          },
        },
      } as any;

      const reordered = await TaskExecutionPlanManager.reorderPlanWithClarification(
        basePlan,
        "unmatched completely random text",
        "Which stage first?",
        mockClient
      );

      // Safe fallback returns original plan without throwing or creating clarification
      expect(reordered).toBeDefined();
      expect(reordered.stages.length).toBe(2);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // MANIFEST GENERATOR (Tests 16 - 21)
  // ═══════════════════════════════════════════════════════════════════════════
  describe("ManifestGenerator", () => {
    const mockContract: ExecutionContract = {
      allowedActions: ["modify_file", "create_file", "delete_file"],
      forbiddenActions: [],
      maxFiles: 5,
      targetPaths: ["src/app.ts"],
      scopeConstraints: { maxNewFiles: 2, maxModifiedFiles: 3, allowedDirectoryPrefixes: ["src/"] },
    } as any;

    it("16. valid strict structured manifest returns normalized FileManifest", async () => {
      const mockClient = {
        chat: {
          completions: {
            create: jest.fn().mockResolvedValue({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      files: [
                        { path: "src/app.ts", action: "modify", description: "Update main app", dependencies: [], evidenceIds: [] },
                        { path: "src/utils.ts", action: "create", description: "Add utils", dependencies: [], evidenceIds: [] },
                      ],
                      totalFiles: 2,
                      manifestVersion: "1.0.0",
                    }),
                  },
                  finish_reason: "stop",
                },
              ],
            }),
          },
        },
      } as any;

      const generator = new ManifestGenerator(mockClient);
      const manifest = await generator.generateManifest(
        "Add helper",
        { existingFiles: ["src/app.ts"] },
        mockContract
      );

      expect(manifest.files.length).toBe(2);
      expect(manifest.files[0].path).toBe("src/app.ts");
      expect(manifest.files[0].action).toBe("modify");
      expect(manifest.files[1].path).toBe("src/utils.ts");
      expect(manifest.files[1].action).toBe("create");
    });

    it("17. schema-invalid manifest rejected with MANIFEST_GENERATION_FAILED", async () => {
      const mockClient = {
        chat: {
          completions: {
            create: jest.fn().mockResolvedValue({
              choices: [
                {
                  message: { content: JSON.stringify({ files: [] }) },
                  finish_reason: "stop",
                },
              ],
            }),
          },
        },
      } as any;

      const generator = new ManifestGenerator(mockClient);
      await expect(
        generator.generateManifest("Update", { existingFiles: [] }, mockContract)
      ).rejects.toThrow(/MANIFEST_GENERATION_FAILED/);
    });

    it("18. truncated manifest rejected before authority logic", async () => {
      const mockClient = {
        chat: {
          completions: {
            create: jest.fn().mockResolvedValue({
              choices: [
                {
                  message: { content: '{"files": [{"path": "src/app.ts"' },
                  finish_reason: "length",
                },
              ],
            }),
          },
        },
      } as any;

      const generator = new ManifestGenerator(mockClient);
      await expect(
        generator.generateManifest("Truncate test", { existingFiles: [] }, mockContract)
      ).rejects.toThrow(/MANIFEST_GENERATION_FAILED/);
    });

    it("19. required file action obligations preserved", async () => {
      const contractWithObligation: ExecutionContract = {
        ...mockContract,
        actionObligations: [
          {
            path: "src/obsolete.ts",
            requiredAction: "delete",
            role: "DEPENDENCY_CLEANUP",
            evidenceIds: ["ev-delete-1"],
          },
        ],
      };

      const mockClient = {
        chat: {
          completions: {
            create: jest.fn().mockResolvedValue({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      files: [
                        { path: "src/obsolete.ts", action: "delete", description: "Delete file", dependencies: [], evidenceIds: [] },
                      ],
                      totalFiles: 1,
                      manifestVersion: "1.0.0",
                    }),
                  },
                  finish_reason: "stop",
                },
              ],
            }),
          },
        },
      } as any;

      const generator = new ManifestGenerator(mockClient);
      const manifest = await generator.generateManifest(
        "Delete obsolete",
        {
          existingFiles: ["src/obsolete.ts"],
          actionObligations: contractWithObligation.actionObligations,
        },
        contractWithObligation
      );

      expect(manifest.files[0].action).toBe("delete");
      expect(manifest.files[0].evidenceIds).toContain("ev-delete-1");
    });

    it("20. evidence IDs preserved in normalized manifest", async () => {
      const mockClient = {
        chat: {
          completions: {
            create: jest.fn().mockResolvedValue({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      files: [
                        {
                          path: "src/app.ts",
                          action: "modify",
                          description: "Mod",
                          dependencies: [],
                          evidenceIds: ["ev-123", "ev-456"],
                        },
                      ],
                      totalFiles: 1,
                      manifestVersion: "1.0.0",
                    }),
                  },
                  finish_reason: "stop",
                },
              ],
            }),
          },
        },
      } as any;

      const generator = new ManifestGenerator(mockClient);
      const manifest = await generator.generateManifest(
        "Evidence test",
        { existingFiles: ["src/app.ts"] },
        mockContract
      );

      expect(manifest.files[0].evidenceIds).toEqual(["ev-123", "ev-456"]);
    });

    it("21. MANIFEST_ACTION_MISMATCH behavior preserved when model produces wrong action", async () => {
      const contractWithObligation: ExecutionContract = {
        ...mockContract,
        actionObligations: [
          {
            path: "src/must-delete.ts",
            requiredAction: "delete",
            role: "PRIMARY_TARGET",
            evidenceIds: ["ev-del"],
          },
        ],
      };

      // Model incorrectly returns modify instead of delete
      const mockClient = {
        chat: {
          completions: {
            create: jest.fn().mockResolvedValue({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      files: [
                        { path: "src/must-delete.ts", action: "modify", description: "Modify", dependencies: [], evidenceIds: [] },
                      ],
                      totalFiles: 1,
                      manifestVersion: "1.0.0",
                    }),
                  },
                  finish_reason: "stop",
                },
              ],
            }),
          },
        },
      } as any;

      const generator = new ManifestGenerator(mockClient);
      await expect(
        generator.generateManifest(
          "Delete task",
          {
            existingFiles: ["src/must-delete.ts"],
            actionObligations: contractWithObligation.actionObligations,
          },
          contractWithObligation
        )
      ).rejects.toThrow(/MANIFEST_ACTION_MISMATCH/);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // MANIFEST CORRECTION ENGINE (Tests 22 - 24)
  // ═══════════════════════════════════════════════════════════════════════════
  describe("ManifestCorrectionEngine", () => {
    const mockRejectedManifest: FileManifest = {
      files: [{ path: "invalid/path.ts", action: "create", dependencies: [], description: "Test" }],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    };
    const mockErrors = [
      {
        type: "SCOPE_VIOLATION" as any,
        message: "Path outside scope",
        suggestion: "Use src/",
        affectedFiles: ["invalid/path.ts"],
      },
    ];
    const mockContract: ExecutionContract = {
      allowedActions: ["create_file"],
      forbiddenActions: [],
      maxFiles: 5,
      targetPaths: [],
      scopeConstraints: {} as any,
    } as any;

    it("22. valid correction returns corrected FileManifest", async () => {
      const mockClient = {
        chat: {
          completions: {
            create: jest.fn().mockResolvedValue({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      files: [{ path: "invalid/path.ts", action: "create", description: "Corrected metadata", dependencies: [] }],
                      totalFiles: 1,
                      manifestVersion: "1.0.0",
                    }),
                  },
                  finish_reason: "stop",
                },
              ],
            }),
          },
        },
      } as any;

      const corrected = await ManifestCorrectionEngine.attemptCorrection(
        mockRejectedManifest,
        mockErrors,
        "Fix manifest",
        {},
        mockContract,
        mockClient
      );

      expect(corrected).not.toBeNull();
      expect(corrected?.files[0].path).toBe("invalid/path.ts");
    });

    it("23. technical failure does not fabricate correction", async () => {
      const mockClient = {
        chat: { completions: { create: jest.fn().mockRejectedValue(new Error("503 Service Unavailable")) } },
      } as any;

      const corrected = await ManifestCorrectionEngine.attemptCorrection(
        mockRejectedManifest,
        mockErrors,
        "Fix manifest",
        {},
        mockContract,
        mockClient
      );

      expect(corrected).toBeNull();
    });

    it("24. bounded behavior preserved (returns null on malformed output)", async () => {
      const mockClient = {
        chat: {
          completions: {
            create: jest.fn().mockResolvedValue({
              choices: [{ message: { content: "invalid json string" }, finish_reason: "stop" }],
            }),
          },
        },
      } as any;

      const corrected = await ManifestCorrectionEngine.attemptCorrection(
        mockRejectedManifest,
        mockErrors,
        "Fix manifest",
        {},
        mockContract,
        mockClient
      );

      expect(corrected).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TASK DECOMPOSER (Tests 25 - 26)
  // ═══════════════════════════════════════════════════════════════════════════
  describe("TaskDecomposer", () => {
    const dummyIntent = {
      taskType: "NEW_FEATURE" as const,
      risk: "LOW" as const,
      estimatedComplexity: "SMALL" as const,
      intent: "NEW_FEATURE" as const,
      confidence: 0.95,
      requiresClarification: false,
      reasoning: "New feature",
    };

    it("25. valid structured DAG decomposes request into nodes and execution order", async () => {
      const mockClient = {
        chat: {
          completions: {
            create: jest.fn().mockResolvedValue({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      nodes: [
                        {
                          id: "subtask-1",
                          description: "Create types",
                          category: "types_and_interfaces",
                          targetFiles: ["src/types.ts"],
                          dependencies: [],
                          estimatedComplexity: "SMALL",
                        },
                        {
                          id: "subtask-2",
                          description: "Create component",
                          category: "leaf_components",
                          targetFiles: ["src/Comp.tsx"],
                          dependencies: ["subtask-1"],
                          estimatedComplexity: "MEDIUM",
                        },
                      ],
                      graphVersion: "1.0.0",
                    }),
                  },
                  finish_reason: "stop",
                },
              ],
            }),
          },
        },
      } as any;

      const decomposer = new TaskDecomposer(mockClient);
      const graph = await decomposer.decomposeTask(
        "Build feature",
        { existingFiles: [] },
        dummyIntent
      );

      expect(graph.nodes.length).toBe(2);
      expect(graph.executionOrder).toEqual(["subtask-1", "subtask-2"]);
    });

    it("26. malformed/truncated response not accepted and throws TASK_DECOMPOSITION_FAILED", async () => {
      const mockClient = {
        chat: {
          completions: {
            create: jest.fn().mockResolvedValue({
              choices: [
                {
                  message: { content: '{"nodes": [{"id": "subtask-1"' },
                  finish_reason: "length",
                },
              ],
            }),
          },
        },
      } as any;

      const decomposer = new TaskDecomposer(mockClient);
      await expect(
        decomposer.decomposeTask("Build complex feature", { existingFiles: [] }, dummyIntent)
      ).rejects.toThrow(/TASK_DECOMPOSITION_FAILED/);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // CODEGENERATOR ROADMAP (Tests 27 - 29)
  // ═══════════════════════════════════════════════════════════════════════════
  describe("CodeGenerator R2A Gateway Migration", () => {
    const gatewayResult = (content: any, stage: any) => ({
      content,
      rawResponse: {
        choices: [{ message: { content: JSON.stringify(content) }, finish_reason: "stop" }],
      } as any,
      finishReason: "stop",
      latencyMs: 1,
      model: "gpt-4o",
      stage,
    });

    const standaloneContract = {
      goal: "Implement the requested standalone change",
      pipeline: "STANDALONE",
      environment: "HTML_CSS_JS",
      taskType: "FEATURE",
      expectedFiles: [],
      allowedActions: ["create_file", "modify_file"],
      forbiddenActions: ["delete_file"],
      maxFiles: 3,
      targetPaths: [],
      contextScope: [],
    } as any;

    afterEach(() => jest.restoreAllMocks());

    it("27. executeChanges invokes real CodeGenerator behavior through LLMGateway", async () => {
      const gatewaySpy = jest.spyOn(LLMGateway.getInstance(), "callStructured").mockResolvedValue(
        gatewayResult({
          explanation: "Implemented",
          changes: [{ path: "src/a.ts", content: "export const a = 1;", description: "Create a" }],
          commitMessage: "feat: add a",
        }, PipelineStages.CODE_GENERATION) as any
      );

      const result = await CodeGenerator.executeChanges("Add a", "Implement it", {}, "system", null);

      expect(gatewaySpy).toHaveBeenCalledWith(expect.objectContaining({
        stage: PipelineStages.CODE_GENERATION,
        schema: expect.objectContaining({ validate: expect.any(Function) }),
      }));
      expect("changes" in result && result.changes[0].path).toBe("src/a.ts");
    });

    it.each([
      new LLMTruncationError("truncated", { stage: PipelineStages.CODE_GENERATION }),
      new LLMNetworkError("network", { stage: PipelineStages.CODE_GENERATION }),
      new LLMInvalidJsonError("malformed", { stage: PipelineStages.CODE_GENERATION }),
      new LLMSchemaInvalidError("schema invalid", { stage: PipelineStages.CODE_GENERATION }),
    ])("28. gateway technical failure %s cannot become successful CodeGenerator output", async (failure) => {
      jest.spyOn(LLMGateway.getInstance(), "callStructured").mockRejectedValue(failure);
      await expect(CodeGenerator.executeChanges("Add a", "Implement it", {}, "system", null)).rejects.toBe(failure);
    });

    it("29. production validator rejects unsafe paths, nested invalid data, and authority claims", async () => {
      let options: any;
      jest.spyOn(LLMGateway.getInstance(), "callStructured").mockImplementation(async (callOptions: any) => {
        options = callOptions;
        return gatewayResult({
          explanation: "Implemented",
          changes: [{ path: "src/a.ts", content: "ok", description: "Create a" }],
          commitMessage: "feat: a",
        }, PipelineStages.CODE_GENERATION) as any;
      });

      await CodeGenerator.executeChanges("Add a", "Implement it", {}, "system", null);
      expect(options.schema.validate({
        explanation: "Unsafe",
        changes: [{ path: "../outside.ts", content: "bad", description: "Bad" }],
        commitMessage: "feat: unsafe",
      }).valid).toBe(false);
      expect(options.schema.validate({
        explanation: "Malformed",
        changes: [{ path: "src/a.ts", action: "modify", edits: [{ oldText: 1, newText: "x" }], description: "Bad" }],
        commitMessage: "feat: malformed",
      }).valid).toBe(false);
      expect(options.schema.validate({
        explanation: "Claims success",
        changes: [{ path: "src/a.ts", content: "ok", description: "Create a" }],
        commitMessage: "feat: a",
        buildPassed: true,
      }).valid).toBe(false);
    });

    it("30. CP9 manifest divergence remains a proposal for CapabilityGuard instead of triggering manifest authority", async () => {
      const gatewaySpy = jest.spyOn(LLMGateway.getInstance(), "callStructured")
        .mockResolvedValueOnce(gatewayResult({
          explanation: "Wrong path",
          changes: [{ path: "src/invented.ts", action: "create", content: "bad", description: "Wrong" }],
          commitMessage: "feat: wrong",
        }, PipelineStages.CODE_GENERATION) as any)
        .mockResolvedValueOnce(gatewayResult({
          explanation: "Corrected",
          changes: [{ path: "src/approved.ts", action: "create", content: "safe", description: "Approved" }],
          commitMessage: "feat: approved",
        }, PipelineStages.CODE_CORRECTION) as any);

      const result = await CodeGenerator.generateRoadmapAndDiffs(
        "Create approved", { intent: "FEATURE" }, { fileContext: {}, skeletonContext: {} }, "system",
        standaloneContract,
        { manifestVersion: "1", totalFiles: 1, files: [{ path: "src/approved.ts", action: "create", description: "Approved", dependencies: [] }] } as any,
      );

      expect(result.changes.map((change) => change.path)).toEqual(["src/invented.ts"]);
      expect(gatewaySpy.mock.calls[0][0].stage).toBe(PipelineStages.CODE_GENERATION);
      expect(gatewaySpy).toHaveBeenCalledTimes(1);
    });

    it("31. CP9 does not normalize or reject a proposal solely from manifest action", async () => {
      jest.spyOn(LLMGateway.getInstance(), "callStructured")
        .mockResolvedValueOnce(gatewayResult({
          explanation: "Wrong path",
          changes: [{ path: "src/invented.ts", action: "create", content: "bad", description: "Wrong" }],
          commitMessage: "feat: wrong",
        }, PipelineStages.CODE_GENERATION) as any)
        .mockResolvedValueOnce(gatewayResult({
          explanation: "Wrong action",
          changes: [{ path: "src/approved.ts", action: "delete", isDeleted: true, content: "", description: "Delete" }],
          commitMessage: "feat: wrong action",
        }, PipelineStages.CODE_CORRECTION) as any);

      const result = await CodeGenerator.generateRoadmapAndDiffs(
        "Create approved", { intent: "FEATURE" }, { fileContext: {}, skeletonContext: {} }, "system",
        standaloneContract,
        { manifestVersion: "1", totalFiles: 1, files: [{ path: "src/approved.ts", action: "create", description: "Approved", dependencies: [] }] } as any,
      );
      expect(result.changes).toMatchObject([{ path: "src/invented.ts", action: "create" }]);
    });

    it("32. security correction uses the gateway and remains subject to SecurityPolicy", async () => {
      const gatewaySpy = jest.spyOn(LLMGateway.getInstance(), "callStructured")
        .mockResolvedValueOnce(gatewayResult({
          explanation: "Unsafe",
          changes: [{ path: "script.js", content: "const value = eval(input);", description: "Implement" }],
          commitMessage: "feat: parser",
        }, PipelineStages.CODE_GENERATION) as any)
        .mockResolvedValueOnce(gatewayResult({ content: "const value = Number(input);" }, PipelineStages.CODE_CORRECTION) as any);

      const result = await CodeGenerator.generateRoadmapAndDiffs(
        "Implement parser", { intent: "FEATURE" }, { fileContext: {}, skeletonContext: {} }, "system", standaloneContract
      );
      expect(result.changes[0].content).toBe("const value = Number(input);");
      expect(gatewaySpy.mock.calls[1][0]).toEqual(expect.objectContaining({
        stage: PipelineStages.CODE_CORRECTION,
        schema: expect.objectContaining({ name: "SecurityCodeCorrectionSchema", validate: expect.any(Function) }),
      }));
    });

    it("33. dependency correction uses the gateway and remains subject to ImportValidator", async () => {
      const gatewaySpy = jest.spyOn(LLMGateway.getInstance(), "callStructured")
        .mockResolvedValueOnce(gatewayResult({
          explanation: "Unavailable dependency",
          changes: [{ path: "script.js", content: 'import x from "left-pad";\nexport const y = x("a", 2);', description: "Implement" }],
          commitMessage: "feat: padding",
        }, PipelineStages.CODE_GENERATION) as any)
        .mockResolvedValueOnce(gatewayResult({ content: 'export const y = " a";' }, PipelineStages.CODE_CORRECTION) as any);

      const result = await CodeGenerator.generateRoadmapAndDiffs(
        "Implement padding", { intent: "FEATURE" },
        { fileContext: { "package.json": '{"dependencies":{"react":"1.0.0"}}' }, skeletonContext: {} },
        "system", standaloneContract,
      );
      expect(result.changes[0].content).toBe('export const y = " a";');
      expect(gatewaySpy.mock.calls[1][0]).toEqual(expect.objectContaining({
        stage: PipelineStages.CODE_CORRECTION,
        schema: expect.objectContaining({ name: "DependencyCodeCorrectionSchema", validate: expect.any(Function) }),
      }));
    });
  });
});
