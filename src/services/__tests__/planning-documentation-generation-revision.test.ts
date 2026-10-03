import { PhaseArtifact, WorkflowRun } from "@prisma/client";
import { PipelineStages } from "../../ai/gateway/PipelineStage";
import { LLMTruncationError } from "../../ai/gateway/LLMError";
import { assembleDocumentationContent } from "../../planning/documentation-assembly";
import { DocumentationProviderDraft } from "../../planning/documentation-schema";
import { hashRequirementsContent, RequirementsContent } from "../../planning/requirements-schema";
import { PlanningDocumentationGenerationService } from "../planning-documentation-generation.service";
import {
  DOCUMENTATION_FEEDBACK_PROMPT_VERSION,
  DOCUMENTATION_REVISION_PROMPT_VERSION,
  DOCUMENTATION_SECTION_REGENERATION_PROMPT_VERSION,
  DOCUMENTATION_SECTION_REVISION_PROMPT_VERSION,
} from "../../planning/documentation-run-config";

const requirements: RequirementsContent = {
  projectGoal: "Deliver",
  problemStatement: "Need workflow",
  usersAndActors: [{ id: "ACT-1", name: "Owner", description: "Owner" }],
  userStories: [
    {
      id: "US-1",
      actor: "Owner",
      capability: "run",
      benefit: "value",
      acceptanceCriteriaIds: ["AC-1"],
    },
  ],
  functionalRequirements: [{ id: "FR-1", title: "Run", description: "Run workflow" }],
  nonFunctionalRequirements: [{ id: "NFR-1", title: "Audit", description: "Audit it" }],
  constraints: [],
  integrations: [],
  assumptions: [],
  acceptanceCriteria: [{ id: "AC-1", description: "Works", relatedRequirementIds: ["FR-1"] }],
  outOfScope: [],
  unresolvedQuestions: [],
};

const draft: DocumentationProviderDraft = {
  overview: { summary: "Docs", scope: "Scope", goals: [], nonGoals: [] },
  systemActors: [
    { id: "DOC-ACTOR", name: "Owner", description: "Uses it", sourceActorIds: ["ACT-1"] },
  ],
  features: [
    {
      id: "DOC-FEATURE",
      title: "Run",
      description: "Runs",
      workflowSteps: ["Start"],
      actorIds: ["DOC-ACTOR"],
      access: "controlled",
      sourceRequirementIds: ["FR-1"],
      sourceUserStoryIds: ["US-1"],
    },
  ],
  apiContracts: {
    applicable: true,
    rationale: "Needed",
    items: [
      {
        id: "DOC-API",
        name: "Run",
        description: "Runs",
        interaction: { kind: "http", method: "POST", path: "/run" },
        access: "controlled",
        input: { description: "Input", fields: [] },
        success: { description: "Output", fields: [] },
        relatedFeatureIds: ["DOC-FEATURE"],
        relatedEntityIds: ["DOC-ENTITY"],
        errorBehaviorIds: ["DOC-ERROR"],
        sourceRequirementIds: ["NFR-1"],
        sourceUserStoryIds: ["US-1"],
      },
    ],
  },
  dataEntities: {
    applicable: true,
    rationale: "Needed",
    items: [
      {
        id: "DOC-ENTITY",
        name: "Run",
        description: "State",
        fields: [
          {
            name: "id",
            logicalType: "identifier",
            required: true,
            description: "ID",
            allowedValues: [],
            validationRules: [],
          },
        ],
        relationships: [],
        sourceRequirementIds: ["NFR-1"],
        sourceUserStoryIds: [],
      },
    ],
  },
  businessRules: [
    {
      id: "DOC-RULE",
      title: "Review",
      condition: "Always",
      expectedBehavior: "Review",
      relatedFeatureIds: ["DOC-FEATURE"],
      relatedEntityIds: [],
      sourceRequirementIds: ["FR-1"],
      sourceUserStoryIds: [],
    },
  ],
  permissionRules: {
    applicable: true,
    rationale: "Controlled",
    items: [
      {
        id: "DOC-PERM",
        title: "Owner",
        description: "Allow",
        effect: "allow",
        actorIds: ["DOC-ACTOR"],
        actions: ["run"],
        relatedFeatureIds: ["DOC-FEATURE"],
        relatedApiContractIds: ["DOC-API"],
      },
    ],
  },
  errorBehaviors: [
    {
      id: "DOC-ERROR",
      code: "RUN_FAILED",
      scenario: "Failure",
      expectedSystemBehavior: "Reject",
      recoveryBehavior: "Retry",
      relatedFeatureIds: ["DOC-FEATURE"],
      relatedApiContractIds: ["DOC-API"],
      httpStatus: 409,
    },
  ],
  edgeCases: [
    {
      id: "DOC-EDGE",
      scenario: "Concurrent",
      expectedHandling: "One wins",
      relatedFeatureIds: ["DOC-FEATURE"],
      relatedApiContractIds: ["DOC-API"],
      relatedEntityIds: ["DOC-ENTITY"],
    },
  ],
  unresolvedQuestions: [],
};

describe("PlanningDocumentationGenerationService - Revisions", () => {
  function makeContext(operation: string, targetSectionKey: string | null = null) {
    return {
      payload: {
        target: "documentation",
        operation,
        targetSectionKey,
        project: { id: "project-1", name: "Project", description: null, currentPhase: "documentation" },
        baseArtifact: {
          id: "doc-v1",
          version: 1,
          contentHash: "hash-v1",
          schemaVersion: 1,
          lifecycleStatus: "APPROVED",
        },
        sourceRequirements: {
          artifactId: "req-1",
          version: 1,
          contentHash: hashRequirementsContent(requirements),
          schemaVersion: 1,
          content: requirements,
        },
        input: {
          instruction: "Perform requested update",
          feedback: operation === "FEEDBACK_APPLICATION" ? "Perform requested update" : null,
          targetSectionKey,
          rebaseToCurrentRequirements: false,
        },
        initiator: { id: "actor-1", type: "HUMAN" },
        memory: null,
        versions: {
          builder: "b",
          schema: 1,
          prompt: "p",
          providerSchema: "s",
        },
      },
      manifest: {
        operation,
        baseArtifactId: "doc-v1",
        baseContentHash: "hash-v1",
        targetSectionKey,
      },
      contextHash: "hash",
      requestFingerprint: "fingerprint",
    };
  }

  test.each([
    ["DOCUMENT_REVISION", null, DOCUMENTATION_REVISION_PROMPT_VERSION],
    ["FEEDBACK_APPLICATION", null, DOCUMENTATION_FEEDBACK_PROMPT_VERSION],
    ["SECTION_REVISION", "features", DOCUMENTATION_SECTION_REVISION_PROMPT_VERSION],
    ["SECTION_REGENERATION", "features", DOCUMENTATION_SECTION_REGENERATION_PROMPT_VERSION],
  ] as const)("executes %s using the 32k Documentation revision route and prompt version %s", async (operation, targetSection, expectedPromptVersion) => {
    const run = { id: `run-${operation}`, status: "running" } as WorkflowRun;
    const successorArtifact = { id: "doc-v2", version: 2 } as PhaseArtifact;
    const context = makeContext(operation, targetSection);

    const runs = {
      start: jest.fn().mockResolvedValue({ run, context, reused: false }),
      finalizeRevision: jest.fn().mockImplementation(async (input: { structuredContent: Record<string, unknown>; audit: { modelUsage: Record<string, unknown> } }) => {
        expect(input.audit.modelUsage).toMatchObject({
          model: "gpt-6.1-sol",
          routeId: "DOCUMENTATION_REVISION:REASONING",
          reasoningEffort: "medium",
          configuredMaxOutputTokens: 32_000,
        });
        return {
          run: { ...run, status: "completed", outputArtifactId: successorArtifact.id },
          artifact: successorArtifact,
          readiness: { ready: true },
          diff: { changedRootSections: ["features"] },
        };
      }),
      finish: jest.fn(),
    };

    const gateway = {
      callStructured: jest.fn().mockImplementation(async (options) => {
        expect(options.stage).toBe(PipelineStages.DOCUMENTATION_REVISION);
        expect(options.maxTokens).toBe(32_000);
        return {
          content: draft,
          model: "gpt-6.1-sol",
          stage: options.stage,
          finishReason: "stop",
          latencyMs: 15,
          attemptCount: 1,
          usage: { promptTokens: 100, completionTokens: 200, totalTokens: 300 },
          providerAttempts: [
            {
              attemptNumber: 1,
              kind: "initial",
              providerResponseId: "resp-1",
              providerRequestId: "req-1",
              model: "gpt-6.1-sol",
              finishReason: "stop",
              promptTokens: 100,
              completionTokens: 200,
              totalTokens: 300,
              usageSource: "provider",
              latencyMs: 15,
              routeId: "DOCUMENTATION_REVISION:REASONING",
              reasoningEffort: "medium",
              maxOutputTokens: 32_000,
            },
          ],
        };
      }),
    };

    const service = new PlanningDocumentationGenerationService({} as never, {
      authorization: {} as never,
      artifacts: {} as never,
      readiness: {} as never,
      runs: runs as never,
      gateway,
    });

    const result = await service.reviseDocumentation({
      projectId: "project-1",
      actorId: "actor-1",
      idempotencyKey: "key-1",
      baseArtifactId: "doc-v1",
      operation: operation as any,
      instruction: "Perform requested update",
      targetSectionKey: targetSection as any,
    });

    expect(result.httpStatus).toBe(201);
    expect(result.reused).toBe(false);
    expect(gateway.callStructured).toHaveBeenCalledTimes(1);
    expect(runs.finalizeRevision).toHaveBeenCalledTimes(1);
    expect(runs.finish).not.toHaveBeenCalled();
  });

  test("handles LLM truncation error safely and terminalizes run as PLANNING_AI_TRUNCATED", async () => {
    const run = { id: "run-trunc", status: "running" } as WorkflowRun;
    const context = makeContext("DOCUMENT_REVISION");

    const runs = {
      start: jest.fn().mockResolvedValue({ run, context, reused: false }),
      finalizeRevision: jest.fn(),
      finish: jest.fn().mockResolvedValue({ ...run, status: "failed" }),
    };

    const gateway = {
      callStructured: jest.fn().mockRejectedValue(new LLMTruncationError("Max tokens exceeded", { maxTokens: 32_000, stage: PipelineStages.DOCUMENTATION_REVISION })),
    };

    const service = new PlanningDocumentationGenerationService({} as never, {
      authorization: {} as never,
      artifacts: {} as never,
      readiness: {} as never,
      runs: runs as never,
      gateway,
    });

    await expect(
      service.reviseDocumentation({
        projectId: "project-1",
        actorId: "actor-1",
        idempotencyKey: "key-trunc",
        baseArtifactId: "doc-v1",
        operation: "DOCUMENT_REVISION",
        instruction: "Do something large",
      }),
    ).rejects.toMatchObject({ code: "PLANNING_AI_TRUNCATED" });

    expect(runs.finalizeRevision).not.toHaveBeenCalled();
    expect(runs.finish).toHaveBeenCalledWith(
      "project-1",
      "run-trunc",
      "failed",
      expect.objectContaining({ code: "PLANNING_AI_TRUNCATED" }),
      undefined,
    );
  });

  test("replays completed run without calling provider", async () => {
    const run = { id: "run-completed", status: "completed", outputArtifactId: "doc-v2", baseArtifactId: "doc-v1" } as WorkflowRun;
    const baseArtifact = {
      id: "doc-v1",
      projectId: "project-1",
      version: 1,
      structuredContent: assembleDocumentationContent(draft, { artifactId: "req-1", version: 1, contentHash: hashRequirementsContent(requirements) }, requirements),
    } as unknown as PhaseArtifact;
    const successorDraft = {
      ...draft,
      overview: { ...draft.overview, summary: "Replayed Revision" },
    };
    const successorContent = assembleDocumentationContent(
      successorDraft,
      { artifactId: "req-1", version: 1, contentHash: hashRequirementsContent(requirements) },
      requirements,
    );
    const successorArtifact = {
      id: "doc-v2",
      projectId: "project-1",
      version: 2,
      structuredContent: successorContent,
    } as unknown as PhaseArtifact;
    const context = makeContext("DOCUMENT_REVISION");

    const runs = {
      start: jest.fn().mockResolvedValue({ run, context, reused: true }),
      finalizeRevision: jest.fn(),
      finish: jest.fn(),
    };

    const prismaMock = {
      $transaction: jest.fn().mockImplementation(async (callback) => {
        return callback({
          phaseArtifact: {
            findUnique: jest.fn().mockImplementation(({ where }) => {
              if (where.id === "doc-v2") return Promise.resolve(successorArtifact);
              if (where.id === "doc-v1") return Promise.resolve(baseArtifact);
              return Promise.resolve(null);
            }),
          },
        });
      }),
    };

    const artifacts = {
      validatePersistedArtifactInTransaction: jest.fn().mockResolvedValue({
        historicalRequirements: requirements,
        currentApprovedRequirements: requirements,
      }),
    };

    const readiness = {
      evaluateDocumentation: jest.fn().mockReturnValue({ ready: true, score: 100 }),
    };

    const authorization = {
      assertCanRead: jest.fn().mockResolvedValue(undefined),
    };

    const gateway = {
      callStructured: jest.fn(),
    };

    const service = new PlanningDocumentationGenerationService(prismaMock as never, {
      authorization: authorization as never,
      artifacts: artifacts as never,
      readiness: readiness as never,
      runs: runs as never,
      gateway,
    });

    const result = await service.reviseDocumentation({
      projectId: "project-1",
      actorId: "actor-1",
      idempotencyKey: "key-replay",
      baseArtifactId: "doc-v1",
      operation: "DOCUMENT_REVISION",
      instruction: "Replay instruction",
    });

    expect(result.httpStatus).toBe(200);
    expect(result.reused).toBe(true);
    expect(result.artifact?.id).toBe("doc-v2");
    expect(gateway.callStructured).not.toHaveBeenCalled();
    expect(runs.finalizeRevision).not.toHaveBeenCalled();
  });
});
