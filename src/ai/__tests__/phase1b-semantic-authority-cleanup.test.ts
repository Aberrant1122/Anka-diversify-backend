import { IntentClassifier } from "../classification/IntentClassifier";
import { ManifestGenerator } from "../../services/manifest-generator";
import { routeTask } from "../../services/task-router.engine";
import { buildExecutionContract } from "../contracts/ExecutionContractBuilder";
import { ValidationDetector } from "../validation/ValidationDetector";
import { TaskClassificationResult, ExecutionContract, AgentFileChange } from "../../types";

describe("Phase 1B — Authoritative Semantic Keyword Control Removal Verification", () => {
  describe("Requirement 17: Unknown-Semantics Unseen Prompts (A-E)", () => {
    const unseenPrompts = [
      "Add a zen workspace switch.",
      "Introduce a compactness controller.",
      "Add a distraction shield.",
      "Make the existing launch action say Continue.",
      "Introduce temporal grouping for the activity stream.",
    ];

    it("evaluates unseen prompts purely via structured LLM classification without keyword overrides", async () => {
      for (const prompt of unseenPrompts) {
        // When LLM returns a structured classification for an unseen prompt
        const mockLlmResponse = {
          taskType: "NEW_FEATURE",
          risk: "LOW",
          estimatedComplexity: "MEDIUM",
          reasoning: `Structured LLM assessment for "${prompt}"`,
          confidence: 0.88,
          requiresClarification: false,
        };

        const mockClient = {
          chat: {
            completions: {
              create: jest.fn().mockResolvedValue({
                choices: [{ message: { content: JSON.stringify(mockLlmResponse) } }],
              }),
            },
          },
        } as any;

        const result = await IntentClassifier.classifyIntentAndAmbiguity(
          prompt,
          {},
          ["src/app.tsx", "package.json"],
          mockClient
        );

        expect(result.taskType).toBe("NEW_FEATURE");
        expect(result.confidence).toBe(0.88);
        expect(result.requiresClarification).toBe(false);
      }
    });

    it("ensures equivalent structured intents behave identically regardless of arbitrary wording", async () => {
      const prompt1 = "Introduce a compactness controller.";
      const prompt2 = "Add a zen workspace switch.";

      const structuredIntent: TaskClassificationResult = {
        intent: "NEW_FEATURE",
        taskType: "NEW_FEATURE",
        risk: "LOW",
        estimatedComplexity: "SMALL",
        confidence: 0.9,
        requiresClarification: false,
        reasoning: "Feature addition",
      };

      const repoFiles = ["src/index.ts", "package.json"];
      const contract1 = buildExecutionContract(structuredIntent, prompt1, repoFiles);
      const contract2 = buildExecutionContract(structuredIntent, prompt2, repoFiles);

      expect(contract1.taskType).toBe(contract2.taskType);
      expect(contract1.environment).toBe(contract2.environment);
      expect(contract1.pipeline).toBe(contract2.pipeline);
      expect(contract1.allowedActions).toEqual(contract2.allowedActions);
      expect(contract1.forbiddenActions).toEqual(contract2.forbiddenActions);
      expect(contract1.targetPaths).toEqual(contract2.targetPaths);
    });
  });

  describe("Requirement 18: Classifier Failure Returns UNKNOWN / CLASSIFICATION_FAILED", () => {
    it("fails closed to UNKNOWN / CLASSIFICATION_FAILED on LLM failure, without guessing from prompt keywords", async () => {
      const mockFailingClient = {
        chat: {
          completions: {
            create: jest.fn().mockRejectedValue(new Error("LLM provider unavailable")),
          },
        },
      } as any;

      const result = await IntentClassifier.classifyIntentAndAmbiguity(
        "delete the legacy auth folder and all files immediately",
        {},
        ["src/auth/login.ts"],
        mockFailingClient
      );

      // MUST NOT guess DELETE_FOLDER or NEW_FEATURE from prompt words
      expect(result.taskType).toBe("UNKNOWN");
      expect(result.intent).toBe("CLASSIFICATION_FAILED");
      expect(result.requiresClarification).toBe(true);
      expect(result.confidence).toBe(0);
    });

    it("fails closed on malformed non-JSON LLM response", async () => {
      const mockMalformedClient = {
        chat: {
          completions: {
            create: jest.fn().mockResolvedValue({
              choices: [{ message: { content: "I cannot classify this in JSON format." } }],
            }),
          },
        },
      } as any;

      const result = await IntentClassifier.classifyIntentAndAmbiguity(
        "Create a new feature module",
        {},
        ["src/index.ts"],
        mockMalformedClient
      );

      expect(result.taskType).toBe("UNKNOWN");
      expect(result.intent).toBe("CLASSIFICATION_FAILED");
      expect(result.requiresClarification).toBe(true);
    });
  });

  describe("Requirement 19: Manifest Failure Semantics & Zero Invented Paths", () => {
    const validContract: ExecutionContract = {
      goal: "Add an activity filter",
      taskType: "NEW_FEATURE",
      risk: "LOW",
      estimatedComplexity: "SMALL",
      pipeline: "REPOSITORY",
      environment: "REACT_TS",
      repositoryRequired: true,
      expectedFiles: [],
      validationType: "TYPESCRIPT_BUILD",
      targetPaths: ["src/components/ActivityFilter.tsx"],
      allowedActions: ["create_files", "modify_file"],
      forbiddenActions: ["delete_file"],
      maxFiles: 5,
      searchScope: ["src/components"],
      contextScope: ["src/components"],
      diffCriticEnabled: true,
    };

    it("fails closed when OpenAI throws MANIFEST_GENERATION_FAILED with zero invented files", async () => {
      const mockClient = {
        chat: {
          completions: {
            create: jest.fn().mockRejectedValue(new Error("API rate limit exceeded")),
          },
        },
      } as any;

      const generator = new ManifestGenerator(mockClient);
      await expect(
        generator.generateManifest("Add filter", { existingFiles: ["src/App.tsx"] }, validContract)
      ).rejects.toThrow(/MANIFEST_GENERATION_FAILED/);
    });

    it("fails closed on malformed JSON response from OpenAI", async () => {
      const mockClient = {
        chat: {
          completions: {
            create: jest.fn().mockResolvedValue({
              choices: [{ message: { content: "Not valid JSON output" } }],
            }),
          },
        },
      } as any;

      const generator = new ManifestGenerator(mockClient);
      await expect(
        generator.generateManifest("Add filter", { existingFiles: ["src/App.tsx"] }, validContract)
      ).rejects.toThrow(/MANIFEST_GENERATION_FAILED/);
    });

    it("fails closed when manifest item is missing path", async () => {
      const mockClient = {
        chat: {
          completions: {
            create: jest.fn().mockResolvedValue({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      files: [{ action: "create", description: "Missing path field" }],
                    }),
                  },
                },
              ],
            }),
          },
        },
      } as any;

      const generator = new ManifestGenerator(mockClient);
      await expect(
        generator.generateManifest("Add filter", { existingFiles: ["src/App.tsx"] }, validContract)
      ).rejects.toThrow(/MANIFEST_GENERATION_FAILED/);
    });

    it("fails closed when empty files array returned", async () => {
      const mockClient = {
        chat: {
          completions: {
            create: jest.fn().mockResolvedValue({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      files: [],
                    }),
                  },
                },
              ],
            }),
          },
        },
      } as any;

      const generator = new ManifestGenerator(mockClient);
      await expect(
        generator.generateManifest("Add filter", { existingFiles: ["src/App.tsx"] }, validContract)
      ).rejects.toThrow(/MANIFEST_GENERATION_FAILED/);
    });
  });

  describe("Requirement 20: Target Authority Test ('Update the dashboard')", () => {
    it("does not give prompt nouns automatic write authority without repository evidence", () => {
      const message = "Update the dashboard.";
      const repoFiles = [
        "DashboardPage.tsx",
        "dashboard.ts",
        "DashboardHeader.tsx",
        "dashboard.css",
      ];

      const classification: TaskClassificationResult = {
        intent: "NEW_FEATURE",
        taskType: "NEW_FEATURE",
        risk: "LOW",
        estimatedComplexity: "SMALL",
        confidence: 0.9,
        requiresClarification: false,
        reasoning: "Dashboard update requested",
      };

      const contract = buildExecutionContract(classification, message, repoFiles);

      // NONE of the files matching prompt noun 'dashboard' should enter targetPaths
      expect(contract.targetPaths).not.toContain("DashboardPage.tsx");
      expect(contract.targetPaths).not.toContain("dashboard.ts");
      expect(contract.targetPaths).not.toContain("DashboardHeader.tsx");
      expect(contract.targetPaths).not.toContain("dashboard.css");
      expect(contract.targetPaths).toEqual([]);
    });
  });

  describe("Requirement 21: Repository-Stack Routing Test ('Add a processing endpoint')", () => {
    const message = "Add a processing endpoint.";
    const classification: TaskClassificationResult = {
      intent: "NEW_FEATURE",
      taskType: "NEW_FEATURE",
      risk: "LOW",
      estimatedComplexity: "SMALL",
      confidence: 0.9,
      requiresClarification: false,
      reasoning: "Endpoint addition",
    };

    it("routes to Python backend when repository is a Python/FastAPI project", () => {
      const pythonRepoFiles = [
        "main.py",
        "requirements.txt",
        "api/endpoints.py",
      ];

      const route = routeTask(message, classification, pythonRepoFiles);
      expect(route.environment).toBe("PYTHON");
      expect(route.pipeline).toBe("REPOSITORY");
      expect(route.validationType).toBe("PYTHON_SYNTAX");
    });

    it("routes to Node backend when repository is an Express/Node project", () => {
      const nodeRepoFiles = [
        "src/index.ts",
        "src/routes/api.ts",
        "package.json",
      ];

      const route = routeTask(message, classification, nodeRepoFiles);
      expect(route.environment).toBe("NODE_JS");
      expect(route.pipeline).toBe("REPOSITORY");
      expect(route.validationType).toBe("TYPESCRIPT_BUILD");
    });
  });

  describe("Requirement 22: Validation Wording Invariance", () => {
    it("returns identical validation results for identical changes regardless of prompt wording", async () => {
      const changes: AgentFileChange[] = [
        {
          path: "src/components/View.tsx",
          action: "modify",
          description: "Update View component",
          content: "export function View() { return <div>Updated View</div>; }",
        },
      ];

      const snapshot = {
        keyFiles: [
          { path: "package.json", content: JSON.stringify({ dependencies: { react: "^18.0.0" } }) },
          { path: "src/App.tsx", content: 'import { View } from "./components/View"; export function App() { return <View />; }' },
          { path: "src/components/View.tsx", content: "export function View() { return <div>Old View</div>; }" },
        ],
      };

      const contract: ExecutionContract = {
        goal: "Update view",
        taskType: "NEW_FEATURE",
        risk: "LOW",
        estimatedComplexity: "SMALL",
        pipeline: "REPOSITORY",
        environment: "REACT_TS",
        repositoryRequired: true,
        expectedFiles: ["src/components/View.tsx"],
        validationType: "TYPESCRIPT_BUILD",
        targetPaths: ["src/components/View.tsx"],
        allowedActions: ["modify_file"],
        forbiddenActions: ["delete_file"],
        maxFiles: 5,
        searchScope: ["src/components"],
        contextScope: ["src/components"],
        diffCriticEnabled: true,
      };

      const wordingA = "Update the page";
      const wordingB = "Adjust the interface";
      const wordingC = "Change the screen";

      const resA = await ValidationDetector.runFeatureValidation(changes, snapshot, wordingA, contract);
      const resB = await ValidationDetector.runFeatureValidation(changes, snapshot, wordingB, contract);
      const resC = await ValidationDetector.runFeatureValidation(changes, snapshot, wordingC, contract);

      expect(resA.overallPassed).toBe(resB.overallPassed);
      expect(resB.overallPassed).toBe(resC.overallPassed);
      expect(resA.checks.length).toBe(resB.checks.length);
      expect(resB.checks.length).toBe(resC.checks.length);
      expect(resA.failedChecks).toEqual(resB.failedChecks);
      expect(resB.failedChecks).toEqual(resC.failedChecks);
    });
  });
});
