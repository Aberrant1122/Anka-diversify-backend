import { PhaseArtifact, WorkflowRun } from "@prisma/client";
import { PipelineStages } from "../../ai/gateway/PipelineStage";
import { DocumentationProviderDraft } from "../../planning/documentation-schema";
import { hashRequirementsContent, RequirementsContent } from "../../planning/requirements-schema";
import { PlanningDocumentationGenerationService } from "../planning-documentation-generation.service";

const requirements: RequirementsContent = {
  projectGoal: "Deliver", problemStatement: "Need workflow",
  usersAndActors: [{ id: "ACT-1", name: "Owner", description: "Owner" }],
  userStories: [{ id: "US-1", actor: "Owner", capability: "run", benefit: "value", acceptanceCriteriaIds: ["AC-1"] }],
  functionalRequirements: [{ id: "FR-1", title: "Run", description: "Run workflow" }],
  nonFunctionalRequirements: [{ id: "NFR-1", title: "Audit", description: "Audit it" }],
  constraints: [], integrations: [], assumptions: [],
  acceptanceCriteria: [{ id: "AC-1", description: "Works", relatedRequirementIds: ["FR-1"] }],
  outOfScope: [], unresolvedQuestions: [],
};

const draft: DocumentationProviderDraft = {
  overview: { summary: "Docs", scope: "Scope", goals: [], nonGoals: [] },
  systemActors: [{ id: "DOC-ACTOR", name: "Owner", description: "Uses it", sourceActorIds: ["ACT-1"] }],
  features: [{ id: "DOC-FEATURE", title: "Run", description: "Runs", workflowSteps: ["Start"], actorIds: ["DOC-ACTOR"], access: "controlled", sourceRequirementIds: ["FR-1"], sourceUserStoryIds: ["US-1"] }],
  apiContracts: { applicable: true, rationale: "Needed", items: [{ id: "DOC-API", name: "Run", description: "Runs", interaction: { kind: "http", method: "POST", path: "/run" }, access: "controlled", input: { description: "Input", fields: [] }, success: { description: "Output", fields: [] }, relatedFeatureIds: ["DOC-FEATURE"], relatedEntityIds: ["DOC-ENTITY"], errorBehaviorIds: ["DOC-ERROR"], sourceRequirementIds: ["NFR-1"], sourceUserStoryIds: ["US-1"] }] },
  dataEntities: { applicable: true, rationale: "Needed", items: [{ id: "DOC-ENTITY", name: "Run", description: "State", fields: [{ name: "id", logicalType: "identifier", required: true, description: "ID", allowedValues: [], validationRules: [] }], relationships: [], sourceRequirementIds: ["NFR-1"], sourceUserStoryIds: [] }] },
  businessRules: [{ id: "DOC-RULE", title: "Review", condition: "Always", expectedBehavior: "Review", relatedFeatureIds: ["DOC-FEATURE"], relatedEntityIds: [], sourceRequirementIds: ["FR-1"], sourceUserStoryIds: [] }],
  permissionRules: { applicable: true, rationale: "Controlled", items: [{ id: "DOC-PERM", title: "Owner", description: "Allow", effect: "allow", actorIds: ["DOC-ACTOR"], actions: ["run"], relatedFeatureIds: ["DOC-FEATURE"], relatedApiContractIds: ["DOC-API"] }] },
  errorBehaviors: [{ id: "DOC-ERROR", code: "RUN_FAILED", scenario: "Failure", expectedSystemBehavior: "Reject", recoveryBehavior: "Retry", relatedFeatureIds: ["DOC-FEATURE"], relatedApiContractIds: ["DOC-API"], httpStatus: 409 }],
  edgeCases: [{ id: "DOC-EDGE", scenario: "Concurrent", expectedHandling: "One wins", relatedFeatureIds: ["DOC-FEATURE"], relatedApiContractIds: ["DOC-API"], relatedEntityIds: ["DOC-ENTITY"] }],
  unresolvedQuestions: [],
};

describe("PlanningDocumentationGenerationService", () => {
  test("uses the dedicated 32k Documentation generation route and server-owned provenance", async () => {
    const run = { id: "run-1", status: "running" } as WorkflowRun;
    const artifact = { id: "doc-1" } as PhaseArtifact;
    const context = {
      payload: {
        target: "documentation", operation: "INITIAL_GENERATION",
        project: { id: "project-1", name: "Project", description: null, currentPhase: "requirements" },
        sourceRequirements: { artifactId: "req-1", version: 1, contentHash: hashRequirementsContent(requirements), schemaVersion: 1, content: requirements },
        initiator: { id: "actor-1", type: "HUMAN" }, memory: null,
        versions: { builder: "b", schema: 1, prompt: "p", providerSchema: "s" },
      },
      manifest: {}, contextHash: "hash", requestFingerprint: "fingerprint",
    };
    const runs = {
      start: jest.fn().mockResolvedValue({ run, context, reused: false }),
      finalize: jest.fn().mockImplementation(async (input: { structuredContent: Record<string, unknown>; audit: { modelUsage: Record<string, unknown> } }) => {
        expect(input.structuredContent.sourceRequirements).toEqual({ artifactId: "req-1", version: 1, contentHash: hashRequirementsContent(requirements) });
        expect(input.structuredContent.requirementsTraceability).toBeDefined();
        expect(input.audit.modelUsage).toMatchObject({
          model: "gpt-6.1-sol",
          routeId: "DOCUMENTATION_GENERATION:REASONING",
          reasoningEffort: "medium",
          configuredMaxOutputTokens: 32_000,
        });
        return { run: { ...run, status: "completed", outputArtifactId: artifact.id }, artifact, readiness: { ready: true } };
      }),
      finish: jest.fn(),
    };
    const gateway = { callStructured: jest.fn().mockImplementation(async (options) => {
      expect(options.stage).toBe(PipelineStages.DOCUMENTATION_GENERATION);
      expect(options.maxTokens).toBe(32_000);
      expect(options.schema.schema.properties.sourceRequirements).toBeUndefined();
      return { content: draft, model: "gpt-6.1-sol", stage: options.stage, finishReason: "stop", latencyMs: 1, attemptCount: 1,
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 }, providerAttempts: [{ attemptNumber: 1, kind: "initial", providerResponseId: "response", providerRequestId: "request", model: "gpt-6.1-sol", finishReason: "stop", promptTokens: 10, completionTokens: 20, totalTokens: 30, usageSource: "provider", latencyMs: 1, routeId: "DOCUMENTATION_GENERATION:REASONING", reasoningEffort: "medium", maxOutputTokens: 32_000 }] };
    }) };
    const service = new PlanningDocumentationGenerationService({} as never, {
      authorization: {} as never, artifacts: {} as never, readiness: {} as never,
      runs: runs as never, gateway,
    });
    const result = await service.generateInitial({ projectId: "project-1", actorId: "actor-1", idempotencyKey: "key" });
    expect(result.httpStatus).toBe(201);
    expect(result.reused).toBe(false);
    expect(gateway.callStructured).toHaveBeenCalledTimes(1);
    expect(runs.finalize).toHaveBeenCalledTimes(1);
  });

  test("rejects provider-forged server roots and terminalizes without persistence", async () => {
    const run = { id: "run-invalid", status: "running" } as WorkflowRun;
    const context = {
      payload: {
        target: "documentation", operation: "INITIAL_GENERATION",
        project: { id: "project-1", name: "Project", description: null, currentPhase: "requirements" },
        sourceRequirements: { artifactId: "req-1", version: 1, contentHash: hashRequirementsContent(requirements), schemaVersion: 1, content: requirements },
        initiator: { id: "actor-1", type: "HUMAN" }, memory: null,
        versions: { builder: "b", schema: 1, prompt: "p", providerSchema: "s" },
      }, manifest: {}, contextHash: "hash", requestFingerprint: "fingerprint",
    };
    const runs = {
      start: jest.fn().mockResolvedValue({ run, context, reused: false }),
      finalize: jest.fn(), finish: jest.fn().mockResolvedValue({ ...run, status: "failed" }),
    };
    const gateway = { callStructured: jest.fn().mockResolvedValue({
      content: { ...draft, sourceRequirements: { artifactId: "forged", version: 99, contentHash: "f".repeat(64) } },
      model: "gpt-6.1-sol", stage: PipelineStages.DOCUMENTATION_GENERATION, finishReason: "stop", latencyMs: 1,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, attemptCount: 1,
    }) };
    const service = new PlanningDocumentationGenerationService({} as never, {
      authorization: {} as never, artifacts: {} as never, readiness: {} as never,
      runs: runs as never, gateway,
    });
    await expect(service.generateInitial({ projectId: "project-1", actorId: "actor-1", idempotencyKey: "key" })).rejects.toMatchObject({ code: "PLANNING_AI_INVALID_RESPONSE" });
    expect(runs.finalize).not.toHaveBeenCalled();
    expect(runs.finish).toHaveBeenCalledWith("project-1", "run-invalid", "failed", expect.objectContaining({ code: "PLANNING_AI_INVALID_RESPONSE" }), expect.any(Object));
  });
});
