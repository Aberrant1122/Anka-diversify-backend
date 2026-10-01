import crypto from "crypto";
import { PrismaClient } from "@prisma/client";
import { assembleDocumentationContent } from "../../planning/documentation-assembly";
import { DocumentationProviderDraft } from "../../planning/documentation-schema";
import { parseDocumentationContent } from "../../planning/documentation-schema";
import { deriveDocumentationRequirementsTraceability } from "../../planning/documentation-assembly";
import {
  DOCUMENTATION_FEEDBACK_PROMPT_VERSION,
  DOCUMENTATION_REVISION_PROMPT_VERSION,
  DOCUMENTATION_SECTION_REGENERATION_PROMPT_VERSION,
  DOCUMENTATION_SECTION_REVISION_PROMPT_VERSION,
} from "../../planning/documentation-run-config";
import { RequirementsContent } from "../../planning/requirements-schema";
import { PlanningApprovalService } from "../planning-approval.service";
import { PlanningArtifactService } from "../planning-artifact.service";
import { PlanningDocumentationArtifactService } from "../planning-documentation-artifact.service";
import { PlanningDocumentationGenerationService } from "../planning-documentation-generation.service";

const databaseUrl = process.env.DATABASE_URL;
const schema = databaseUrl ? new URL(databaseUrl).searchParams.get("schema") : null;
const describeIsolated = schema?.startsWith("planning_checkpoint_1c_docs_") ? describe : describe.skip;
const prisma = new PrismaClient();
const requirementsArtifacts = new PlanningArtifactService(prisma);
const documentationArtifacts = new PlanningDocumentationArtifactService(prisma);
const approvals = new PlanningApprovalService(prisma);
const ownerId = `docs-rev-owner-${crypto.randomUUID()}`;
const outsiderId = `docs-rev-outsider-${crypto.randomUUID()}`;
const projectIds: string[] = [];

function requirements(label: string): RequirementsContent {
  return {
    projectGoal: `Deliver ${label}`,
    problemStatement: `Need ${label}`,
    usersAndActors: [{ id: "ACT-1", name: "Owner", description: "Owner" }],
    userStories: [
      {
        id: "US-1",
        actor: "Owner",
        capability: label,
        benefit: "value",
        acceptanceCriteriaIds: ["AC-1"],
      },
    ],
    functionalRequirements: [{ id: "FR-1", title: label, description: `Support ${label}` }],
    nonFunctionalRequirements: [{ id: "NFR-1", title: "Audit", description: "Audit" }],
    constraints: [],
    integrations: [],
    assumptions: [],
    acceptanceCriteria: [{ id: "AC-1", description: "Works", relatedRequirementIds: ["FR-1"] }],
    outOfScope: [],
    unresolvedQuestions: [],
  };
}

function draft(modifier?: (d: DocumentationProviderDraft) => void): DocumentationProviderDraft {
  const d: DocumentationProviderDraft = {
    overview: { summary: "Docs", scope: "Scope", goals: [], nonGoals: [] },
    systemActors: [{ id: "DOC-ACTOR", name: "Owner", description: "Uses it", sourceActorIds: ["ACT-1"] }],
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
  if (modifier) modifier(d);
  return d;
}

function completion(content: DocumentationProviderDraft) {
  return {
    content,
    rawResponse: {} as never,
    finishReason: "stop",
    usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    latencyMs: 1,
    model: "gpt-4o",
    stage: "DOCUMENTATION_PLANNING" as const,
    attemptCount: 1,
    providerAttempts: [
      {
        attemptNumber: 1,
        kind: "initial" as const,
        providerResponseId: "response",
        providerRequestId: "request",
        model: "gpt-4o",
        finishReason: "stop",
        promptTokens: 10,
        completionTokens: 20,
        totalTokens: 30,
        usageSource: "provider" as const,
        latencyMs: 1,
      },
    ],
  };
}

async function createProject(): Promise<string> {
  const id = `docs-rev-project-${crypto.randomUUID()}`;
  await prisma.project.create({ data: { id, name: "Documentation revision lifecycle", userId: ownerId } });
  projectIds.push(id);
  return id;
}

async function approveRequirements(projectId: string, label: string) {
  const current = await prisma.projectPhaseState.findUnique({
    where: { projectId_phase: { projectId, phase: "requirements" } },
  });
  const artifact = current?.currentArtifactId
    ? await requirementsArtifacts.createManualRevision({
        projectId,
        actorId: ownerId,
        baseArtifactId: current.currentArtifactId,
        baseContentHash: (
          await prisma.phaseArtifact.findUniqueOrThrow({ where: { id: current.currentArtifactId } })
        ).contentHash!,
        structuredContent: requirements(label),
      })
    : await requirementsArtifacts.createInitialArtifact({
        projectId,
        actorId: ownerId,
        title: "Requirements",
        structuredContent: requirements(label),
      });
  await approvals.requestApproval({
    projectId,
    phase: "requirements",
    artifactId: artifact.id,
    expectedHash: artifact.contentHash!,
    actorId: ownerId,
  });
  await approvals.approveArtifact({
    projectId,
    phase: "requirements",
    artifactId: artifact.id,
    expectedHash: artifact.contentHash!,
    actorId: ownerId,
  });
  return artifact;
}

async function createInitialDoc(projectId: string, d = draft()) {
  const gateway = { callStructured: jest.fn().mockResolvedValue(completion(d)) };
  const service = new PlanningDocumentationGenerationService(prisma, { gateway });
  const result = await service.generateInitial({
    projectId,
    actorId: ownerId,
    idempotencyKey: `init-doc-${crypto.randomUUID()}`,
  });
  return result.artifact!;
}

describeIsolated("Documentation Revision DB Lifecycle & Safety", () => {
  beforeAll(async () => {
    await prisma.user.createMany({
      data: [
        { id: ownerId, email: `${ownerId}@anka.test`, password: "unused" },
        { id: outsiderId, email: `${outsiderId}@anka.test`, password: "unused" },
      ],
    });
  });

  afterAll(async () => {
    for (const id of projectIds.reverse()) {
      await prisma.project.delete({ where: { id } });
    }
    await prisma.user.deleteMany({ where: { id: { in: [ownerId, outsiderId] } } });
    await prisma.$disconnect();
  });

  test("DOCUMENT_REVISION creates immutable successor v2, updates currentArtifactId, preserves DRAFT lifecycle", async () => {
    const projectId = await createProject();
    await approveRequirements(projectId, "v1");
    const v1 = await createInitialDoc(projectId);

    const revisedDraft = draft((d) => {
      d.overview.summary = "Revised overview in v2";
    });
    const gateway = { callStructured: jest.fn().mockResolvedValue(completion(revisedDraft)) };
    const service = new PlanningDocumentationGenerationService(prisma, { gateway });

    const revResult = await service.reviseDocumentation({
      projectId,
      actorId: ownerId,
      baseArtifactId: v1.id,
      operation: "DOCUMENT_REVISION",
      instruction: "Update overview summary",
      idempotencyKey: "doc-rev-key-1",
    });

    expect(revResult.httpStatus).toBe(201);
    expect(revResult.reused).toBe(false);
    expect(revResult.artifact).toMatchObject({
      version: 2,
      basedOnArtifactId: v1.id,
      previousVersionId: v1.id,
      changeKind: "AI_DOCUMENT_REVISION",
      lifecycleStatus: "DRAFT",
      approved: false,
    });
    expect(revResult.diff?.changedRootSections).toContain("overview");

    const state = await prisma.projectPhaseState.findUniqueOrThrow({
      where: { projectId_phase: { projectId, phase: "documentation" } },
    });
    expect(state.currentArtifactId).toBe(revResult.artifact!.id);
    expect(state.currentApprovedArtifactId).toBeNull();
    expect(state.activeRunId).toBeNull();

    // Idempotent replay
    const replay = await service.reviseDocumentation({
      projectId,
      actorId: ownerId,
      baseArtifactId: v1.id,
      operation: "DOCUMENT_REVISION",
      instruction: "Update overview summary",
      idempotencyKey: "doc-rev-key-1",
    });
    expect(replay.httpStatus).toBe(200);
    expect(replay.reused).toBe(true);
    expect(replay.artifact?.id).toBe(revResult.artifact!.id);
    expect(gateway.callStructured).toHaveBeenCalledTimes(1);
  });

  test("FEEDBACK_APPLICATION creates successor with changeKind FEEDBACK_APPLICATION", async () => {
    const projectId = await createProject();
    await approveRequirements(projectId, "v1");
    const v1 = await createInitialDoc(projectId);

    const revisedDraft = draft((d) => {
      d.overview.scope = "Updated scope based on reviewer feedback";
    });
    const gateway = { callStructured: jest.fn().mockResolvedValue(completion(revisedDraft)) };
    const service = new PlanningDocumentationGenerationService(prisma, { gateway });

    const result = await service.reviseDocumentation({
      projectId,
      actorId: ownerId,
      baseArtifactId: v1.id,
      operation: "FEEDBACK_APPLICATION",
      instruction: "Incorporate reviewer feedback regarding scope",
      idempotencyKey: "doc-feedback-key-1",
    });

    expect(result.httpStatus).toBe(201);
    expect(result.artifact).toMatchObject({
      version: 2,
      changeKind: "FEEDBACK_APPLICATION",
      lifecycleStatus: "DRAFT",
    });
    expect(result.run.operation).toBe("FEEDBACK_APPLICATION");
  });

  test("approved base authority preservation: creating revision on approved artifact keeps currentApprovedArtifactId intact", async () => {
    const projectId = await createProject();
    await approveRequirements(projectId, "v1");
    const v1 = await createInitialDoc(projectId);

    // Human approves v1
    await approvals.requestDocumentationApproval({
      projectId,
      artifactId: v1.id,
      expectedHash: v1.contentHash!,
      actorId: ownerId,
    });
    await approvals.approveDocumentationArtifact({
      projectId,
      artifactId: v1.id,
      expectedHash: v1.contentHash!,
      actorId: ownerId,
    });

    const stateApproved = await prisma.projectPhaseState.findUniqueOrThrow({
      where: { projectId_phase: { projectId, phase: "documentation" } },
    });
    expect(stateApproved.currentApprovedArtifactId).toBe(v1.id);
    expect(stateApproved.currentArtifactId).toBe(v1.id);

    // AI revision on approved v1
    const revisedDraft = draft((d) => {
      d.overview.summary = "Post-approval enhancement";
    });
    const gateway = { callStructured: jest.fn().mockResolvedValue(completion(revisedDraft)) };
    const service = new PlanningDocumentationGenerationService(prisma, { gateway });

    const revResult = await service.reviseDocumentation({
      projectId,
      actorId: ownerId,
      baseArtifactId: v1.id,
      operation: "DOCUMENT_REVISION",
      instruction: "Post-approval enhancement",
      idempotencyKey: "approved-base-rev-key",
    });

    expect(revResult.httpStatus).toBe(201);
    expect(revResult.artifact?.version).toBe(2);
    expect(revResult.artifact?.lifecycleStatus).toBe("DRAFT");
    expect(revResult.artifact?.approved).toBe(false);

    const stateAfterRev = await prisma.projectPhaseState.findUniqueOrThrow({
      where: { projectId_phase: { projectId, phase: "documentation" } },
    });
    expect(stateAfterRev.currentArtifactId).toBe(revResult.artifact!.id);
    expect(stateAfterRev.currentApprovedArtifactId).toBe(v1.id); // Base authority preserved!
  });

  test("locks AI revision when base artifact is in AWAITING_APPROVAL state", async () => {
    const projectId = await createProject();
    await approveRequirements(projectId, "v1");
    const v1 = await createInitialDoc(projectId);

    await approvals.requestDocumentationApproval({
      projectId,
      artifactId: v1.id,
      expectedHash: v1.contentHash!,
      actorId: ownerId,
    });

    const service = new PlanningDocumentationGenerationService(prisma, { gateway: {} as never });
    await expect(
      service.reviseDocumentation({
        projectId,
        actorId: ownerId,
        baseArtifactId: v1.id,
        operation: "DOCUMENT_REVISION",
        instruction: "Attempt during approval review",
        idempotencyKey: "locked-approval-key",
      }),
    ).rejects.toMatchObject({
      code: "PLANNING_ACTION_LOCKED",
      httpStatus: 409,
    });
  });

  test("SECTION_REVISION enforces dependency closure", async () => {
    const projectId = await createProject();
    await approveRequirements(projectId, "v1");
    const v1 = await createInitialDoc(projectId);

    // Target 'overview': its allowed closure is only ['overview'].
    // If the provider modifies 'features', it must fail with PLANNING_SECTION_SCOPE_VIOLATION.
    const invalidClosureDraft = draft((d) => {
      d.overview.summary = "New summary";
      d.features[0].title = "Unauthorized feature modification";
    });
    const gateway = { callStructured: jest.fn().mockResolvedValue(completion(invalidClosureDraft)) };
    const service = new PlanningDocumentationGenerationService(prisma, { gateway });

    await expect(
      service.reviseDocumentation({
        projectId,
        actorId: ownerId,
        baseArtifactId: v1.id,
        operation: "SECTION_REVISION",
        targetSectionKey: "overview",
        instruction: "Update overview",
        idempotencyKey: "invalid-closure-key",
      }),
    ).rejects.toMatchObject({
      code: "PLANNING_SECTION_SCOPE_VIOLATION",
      httpStatus: 422,
    });

    // Valid section revision modifying within allowed closure succeeds
    const validClosureDraft = draft((d) => {
      d.overview.summary = "New summary";
    });
    gateway.callStructured.mockResolvedValueOnce(completion(validClosureDraft));
    const validResult = await service.reviseDocumentation({
      projectId,
      actorId: ownerId,
      baseArtifactId: v1.id,
      operation: "SECTION_REVISION",
      targetSectionKey: "overview",
      instruction: "Update overview properly",
      idempotencyKey: "valid-closure-key",
    });
    expect(validResult.httpStatus).toBe(201);
  });

  test("no-op revision fails closed with PLANNING_REVISION_NO_CHANGES and persists nothing", async () => {
    const projectId = await createProject();
    await approveRequirements(projectId, "v1");
    const v1 = await createInitialDoc(projectId);

    // Return the identical draft as v1
    const gateway = { callStructured: jest.fn().mockResolvedValue(completion(draft())) };
    const service = new PlanningDocumentationGenerationService(prisma, { gateway });

    await expect(
      service.reviseDocumentation({
        projectId,
        actorId: ownerId,
        baseArtifactId: v1.id,
        operation: "DOCUMENT_REVISION",
        instruction: "No actual changes",
        idempotencyKey: "noop-key",
      }),
    ).rejects.toMatchObject({
      code: "PLANNING_REVISION_NO_CHANGES",
      httpStatus: 422,
    });

    // Verify no v2 artifact was created
    const count = await prisma.phaseArtifact.count({
      where: { projectId, phase: "documentation" },
    });
    expect(count).toBe(1);
  });

  test("stale upstream Requirements rejects partial revisions but whole-doc DOCUMENT_REVISION with rebase succeeds", async () => {
    const projectId = await createProject();
    const reqV1 = await approveRequirements(projectId, "v1");
    const docV1 = await createInitialDoc(projectId);

    // Requirements advances to v2
    const reqV2 = await approveRequirements(projectId, "v2-updated");

    const gateway = { callStructured: jest.fn().mockResolvedValue(completion(draft((d) => { d.overview.summary = "Rebased summary"; }))) };
    const service = new PlanningDocumentationGenerationService(prisma, { gateway });

    // SECTION_REVISION fails closed
    await expect(
      service.reviseDocumentation({
        projectId,
        actorId: ownerId,
        baseArtifactId: docV1.id,
        operation: "SECTION_REVISION",
        targetSectionKey: "overview",
        instruction: "Stale section revision",
        idempotencyKey: "stale-sec-key",
      }),
    ).rejects.toMatchObject({
      code: "PLANNING_ARTIFACT_INVALID",
      httpStatus: 422,
    });

    // FEEDBACK_APPLICATION fails closed
    await expect(
      service.reviseDocumentation({
        projectId,
        actorId: ownerId,
        baseArtifactId: docV1.id,
        operation: "FEEDBACK_APPLICATION",
        instruction: "Stale feedback application",
        idempotencyKey: "stale-feed-key",
      }),
    ).rejects.toMatchObject({
      code: "PLANNING_ARTIFACT_INVALID",
      httpStatus: 422,
    });

    // DOCUMENT_REVISION without explicit rebase fails closed
    await expect(
      service.reviseDocumentation({
        projectId,
        actorId: ownerId,
        baseArtifactId: docV1.id,
        operation: "DOCUMENT_REVISION",
        instruction: "Stale whole doc revision without rebase",
        idempotencyKey: "stale-doc-key",
        rebaseToCurrentRequirements: false,
      }),
    ).rejects.toMatchObject({
      code: "PLANNING_ARTIFACT_INVALID",
      httpStatus: 422,
    });

    // DOCUMENT_REVISION with explicit rebaseToCurrentRequirements: true succeeds!
    const rebasedResult = await service.reviseDocumentation({
      projectId,
      actorId: ownerId,
      baseArtifactId: docV1.id,
      operation: "DOCUMENT_REVISION",
      instruction: "Rebase to current requirements",
      idempotencyKey: "rebase-doc-key",
      rebaseToCurrentRequirements: true,
    });

    expect(rebasedResult.httpStatus).toBe(201);
    expect(rebasedResult.artifact?.version).toBe(2);
    // Verifies new sourceRequirements stamped!
    const parsedStructured = rebasedResult.artifact?.structuredContent as any;
    expect(parsedStructured.sourceRequirements.artifactId).toBe(reqV2.id);
  });

  test("human race: human creates successor while AI is running -> AI Tx B fails closed with PLANNING_CONTEXT_CHANGED", async () => {
    const projectId = await createProject();
    const reqSource = await approveRequirements(projectId, "v1");
    const v1 = await createInitialDoc(projectId);

    let releaseAi!: () => void;
    const aiBarrier = new Promise<void>((resolve) => { releaseAi = resolve; });

    const gateway = {
      callStructured: jest.fn().mockImplementation(async () => {
        await aiBarrier;
        return completion(draft((d) => { d.overview.summary = "AI update"; }));
      }),
    };
    const service = new PlanningDocumentationGenerationService(prisma, { gateway });

    // Start AI revision
    const aiPromise = service.reviseDocumentation({
      projectId,
      actorId: ownerId,
      baseArtifactId: v1.id,
      operation: "DOCUMENT_REVISION",
      instruction: "AI update during race",
      idempotencyKey: "ai-race-key",
    });

    // Wait until gateway is called
    while (gateway.callStructured.mock.calls.length === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    // While AI is running outside transaction, human creates a manual successor
    const req = requirements("v1");
    const humanContent = assembleDocumentationContent(
      draft((d) => { d.overview.summary = "Human manual edit"; }),
      { artifactId: reqSource.id, version: 1, contentHash: reqSource.contentHash! },
      req,
    );
    const humanSuccessor = await documentationArtifacts.createSuccessorVersion({
      projectId,
      actorId: ownerId,
      baseArtifactId: v1.id,
      baseContentHash: v1.contentHash!,
      structuredContent: humanContent,
    });
    expect(humanSuccessor.version).toBe(2);

    // Now release AI to execute Tx B
    releaseAi();

    // AI Tx B detects base is no longer current artifact -> fails closed
    await expect(aiPromise).rejects.toMatchObject({
      code: "PLANNING_CONTEXT_CHANGED",
      httpStatus: 409,
    });

    // Verify lease was released cleanly
    const state = await prisma.projectPhaseState.findUniqueOrThrow({
      where: { projectId_phase: { projectId, phase: "documentation" } },
    });
    expect(state.activeRunId).toBeNull();
    expect(state.currentArtifactId).toBe(humanSuccessor.id);
  });

  test("rejects stable-ID violation: moving an entity ID across root collections", async () => {
    const projectId = await createProject();
    await approveRequirements(projectId, "v1");
    // v1 has unresolved question DOC-Q1
    const v1 = await createInitialDoc(
      projectId,
      draft((d) => {
        d.unresolvedQuestions = [{ id: "DOC-Q1", question: "Q1?", impact: "Impact" }];
      }),
    );

    // Successor reuses DOC-Q1 in edgeCases root collection
    const crossRootDraft = draft((d) => {
      d.unresolvedQuestions = [];
      d.edgeCases.push({
        id: "DOC-Q1", // Moved from unresolvedQuestions to edgeCases
        scenario: "New edge",
        expectedHandling: "Handling",
        relatedFeatureIds: ["DOC-FEATURE"],
        relatedApiContractIds: ["DOC-API"],
        relatedEntityIds: ["DOC-ENTITY"],
      });
    });
    const gateway = { callStructured: jest.fn().mockResolvedValue(completion(crossRootDraft)) };
    const service = new PlanningDocumentationGenerationService(prisma, { gateway });

    await expect(
      service.reviseDocumentation({
        projectId,
        actorId: ownerId,
        baseArtifactId: v1.id,
        operation: "DOCUMENT_REVISION",
        instruction: "Cross-root ID reclassification",
        idempotencyKey: "cross-root-id-key",
      }),
    ).rejects.toMatchObject({
      code: "PLANNING_ARTIFACT_INVALID",
      httpStatus: 422,
    });
  });

  test("concurrent AI operations: same-key replays 202 running; different-key rejected with 409", async () => {
    const projectId = await createProject();
    await approveRequirements(projectId, "v1");
    const v1 = await createInitialDoc(projectId);

    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => { releaseBarrier = resolve; });

    const gateway = {
      callStructured: jest.fn().mockImplementation(async () => {
        await barrier;
        return completion(draft((d) => { d.overview.summary = "Concurrent done"; }));
      }),
    };
    const service = new PlanningDocumentationGenerationService(prisma, { gateway });

    const initialPromise = service.reviseDocumentation({
      projectId,
      actorId: ownerId,
      baseArtifactId: v1.id,
      operation: "DOCUMENT_REVISION",
      instruction: "First operation",
      idempotencyKey: "lease-key-1",
    });

    while (gateway.callStructured.mock.calls.length === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    // Same key while running returns 202
    const sameKeyReplay = await service.reviseDocumentation({
      projectId,
      actorId: ownerId,
      baseArtifactId: v1.id,
      operation: "DOCUMENT_REVISION",
      instruction: "First operation",
      idempotencyKey: "lease-key-1",
    });
    expect(sameKeyReplay.httpStatus).toBe(202);
    expect(sameKeyReplay.reused).toBe(true);

    // Different key while running is rejected with PLANNING_GENERATION_IN_PROGRESS
    await expect(
      service.reviseDocumentation({
        projectId,
        actorId: ownerId,
        baseArtifactId: v1.id,
        operation: "DOCUMENT_REVISION",
        instruction: "Second operation concurrent",
        idempotencyKey: "lease-key-2",
      }),
    ).rejects.toMatchObject({
      code: "PLANNING_GENERATION_IN_PROGRESS",
      httpStatus: 409,
    });

    releaseBarrier();
    const finalResult = await initialPromise;
    expect(finalResult.httpStatus).toBe(201);
  });

  test("requirements race: requirements advance while AI revision is running -> AI Tx B fails closed", async () => {
    const projectId = await createProject();
    await approveRequirements(projectId, "v1");
    const v1 = await createInitialDoc(projectId);

    let releaseAi!: () => void;
    const aiBarrier = new Promise<void>((resolve) => { releaseAi = resolve; });

    const gateway = {
      callStructured: jest.fn().mockImplementation(async () => {
        await aiBarrier;
        return completion(draft((d) => { d.overview.summary = "AI update"; }));
      }),
    };
    const service = new PlanningDocumentationGenerationService(prisma, { gateway });

    const aiPromise = service.reviseDocumentation({
      projectId,
      actorId: ownerId,
      baseArtifactId: v1.id,
      operation: "DOCUMENT_REVISION",
      instruction: "AI update during req race",
      idempotencyKey: "ai-req-race-key",
      rebaseToCurrentRequirements: false,
    });

    while (gateway.callStructured.mock.calls.length === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    // Requirements authority changes to v2 while AI was running
    await approveRequirements(projectId, "v2-race");

    releaseAi();

    // AI Tx B detects upstream requirements authority changed without rebase flag -> fails closed
    await expect(aiPromise).rejects.toMatchObject({
      code: "PLANNING_CONTEXT_CHANGED",
      httpStatus: 409,
    });
  });

  test("approval race: base enters AWAITING_APPROVAL while AI revision is running -> AI Tx B fails closed", async () => {
    const projectId = await createProject();
    await approveRequirements(projectId, "v1");
    const v1 = await createInitialDoc(projectId);

    let releaseAi!: () => void;
    const aiBarrier = new Promise<void>((resolve) => { releaseAi = resolve; });

    const gateway = {
      callStructured: jest.fn().mockImplementation(async () => {
        await aiBarrier;
        return completion(draft((d) => { d.overview.summary = "AI update"; }));
      }),
    };
    const service = new PlanningDocumentationGenerationService(prisma, { gateway });

    const aiPromise = service.reviseDocumentation({
      projectId,
      actorId: ownerId,
      baseArtifactId: v1.id,
      operation: "DOCUMENT_REVISION",
      instruction: "AI update during approval race",
      idempotencyKey: "ai-approval-race-key",
    });

    while (gateway.callStructured.mock.calls.length === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    // Human submits base artifact for approval review while AI was running
    await approvals.requestDocumentationApproval({
      projectId,
      artifactId: v1.id,
      expectedHash: v1.contentHash!,
      actorId: ownerId,
    });

    releaseAi();

    // AI Tx B detects state is awaiting_approval -> fails closed
    await expect(aiPromise).rejects.toMatchObject({
      code: "PLANNING_CONTEXT_CHANGED",
      httpStatus: 409,
    });
  });

  test("cross-project security: base artifact from another project is rejected", async () => {
    const projectA = await createProject();
    const projectB = await createProject();
    await approveRequirements(projectA, "v1");
    await approveRequirements(projectB, "v1");
    const docA = await createInitialDoc(projectA);

    const service = new PlanningDocumentationGenerationService(prisma, { gateway: {} as never });

    await expect(
      service.reviseDocumentation({
        projectId: projectB,
        actorId: ownerId,
        baseArtifactId: docA.id,
        operation: "DOCUMENT_REVISION",
        instruction: "Attempt revision using artifact from other project",
        idempotencyKey: "cross-project-key",
      }),
    ).rejects.toMatchObject({
      code: "PLANNING_ARTIFACT_NOT_FOUND",
      httpStatus: 404,
    });
  });

  test("provenance-only explicit rebase creates one draft successor and replays it", async () => {
    const projectId = await createProject();
    await approveRequirements(projectId, "v1");
    const v1 = await createInitialDoc(projectId);
    await approvals.requestDocumentationApproval({ projectId, artifactId: v1.id, expectedHash: v1.contentHash!, actorId: ownerId });
    await approvals.approveDocumentationArtifact({ projectId, artifactId: v1.id, expectedHash: v1.contentHash!, actorId: ownerId });
    const reqV2 = await approveRequirements(projectId, "v2");
    const gateway = { callStructured: jest.fn().mockResolvedValue(completion(draft())) };
    const service = new PlanningDocumentationGenerationService(prisma, { gateway });
    const request = {
      projectId, actorId: ownerId, baseArtifactId: v1.id,
      operation: "DOCUMENT_REVISION" as const, instruction: "Rebase authority only",
      idempotencyKey: "provenance-only-rebase", rebaseToCurrentRequirements: true,
    };

    const result = await service.reviseDocumentation(request);
    expect(result.httpStatus).toBe(201);
    expect(result.artifact).toMatchObject({ version: 2, lifecycleStatus: "DRAFT", approved: false });
    expect(result.run.status).toBe("completed");
    const content = parseDocumentationContent(result.artifact!.structuredContent);
    expect(content.sourceRequirements).toEqual({ artifactId: reqV2.id, version: reqV2.version, contentHash: reqV2.contentHash });
    expect(content.requirementsTraceability).toEqual(deriveDocumentationRequirementsTraceability(draft(), requirements("v2")));
    const state = await prisma.projectPhaseState.findUniqueOrThrow({ where: { projectId_phase: { projectId, phase: "documentation" } } });
    expect(state).toMatchObject({ currentArtifactId: result.artifact!.id, currentApprovedArtifactId: v1.id, activeRunId: null });
    expect(await prisma.phaseArtifact.count({ where: { projectId, phase: "documentation" } })).toBe(2);

    const replay = await service.reviseDocumentation(request);
    expect(replay).toMatchObject({ httpStatus: 200, reused: true, artifact: { id: result.artifact!.id }, run: { id: result.run.id } });
    expect(gateway.callStructured).toHaveBeenCalledTimes(1);
    expect(await prisma.phaseArtifact.count({ where: { projectId, phase: "documentation" } })).toBe(2);
  });

  test("completed historical replay survives Requirements advancement; changed key input conflicts and outsider cannot replay", async () => {
    const projectId = await createProject();
    await approveRequirements(projectId, "v1");
    const v1 = await createInitialDoc(projectId);
    const gateway = { callStructured: jest.fn().mockResolvedValue(completion(draft((d) => { d.overview.summary = "Historical revision"; }))) };
    const service = new PlanningDocumentationGenerationService(prisma, { gateway });
    const request = { projectId, actorId: ownerId, baseArtifactId: v1.id, operation: "DOCUMENT_REVISION" as const,
      instruction: "Historical revision", idempotencyKey: "historical-completed" };
    const result = await service.reviseDocumentation(request);
    await approveRequirements(projectId, "v2");
    const runCount = await prisma.workflowRun.count({ where: { projectId, currentPhase: "documentation" } });
    const stateBeforeReplay = await prisma.projectPhaseState.findUniqueOrThrow({ where: { projectId_phase: { projectId, phase: "documentation" } } });

    const replay = await service.reviseDocumentation(request);
    expect(replay).toMatchObject({ httpStatus: 200, reused: true, artifact: { id: result.artifact!.id }, run: { id: result.run.id } });
    await expect(service.reviseDocumentation({ ...request, instruction: "Different instruction" })).rejects.toMatchObject({
      code: "PLANNING_IDEMPOTENCY_CONFLICT", httpStatus: 409,
    });
    await expect(service.reviseDocumentation({ ...request, actorId: outsiderId })).rejects.toMatchObject({
      code: "PLANNING_PROJECT_NOT_FOUND", httpStatus: 404,
    });
    expect(gateway.callStructured).toHaveBeenCalledTimes(1);
    expect(await prisma.workflowRun.count({ where: { projectId, currentPhase: "documentation" } })).toBe(runCount);
    expect(await prisma.phaseArtifact.count({ where: { projectId, phase: "documentation" } })).toBe(2);
    const stateAfterReplay = await prisma.projectPhaseState.findUniqueOrThrow({ where: { projectId_phase: { projectId, phase: "documentation" } } });
    expect(stateAfterReplay.activeRunId).toBeNull();
    expect(stateAfterReplay.stateVersion).toBe(stateBeforeReplay.stateVersion);
  });

  test("terminal no-op failure replays after Requirements advancement without provider or artifact mutation", async () => {
    const projectId = await createProject();
    await approveRequirements(projectId, "v1");
    const v1 = await createInitialDoc(projectId);
    const gateway = { callStructured: jest.fn().mockResolvedValue(completion(draft())) };
    const service = new PlanningDocumentationGenerationService(prisma, { gateway });
    const request = { projectId, actorId: ownerId, baseArtifactId: v1.id, operation: "DOCUMENT_REVISION" as const,
      instruction: "No change", idempotencyKey: "historical-terminal" };
    await expect(service.reviseDocumentation(request)).rejects.toMatchObject({ code: "PLANNING_REVISION_NO_CHANGES", httpStatus: 422 });
    const run = await prisma.workflowRun.findFirstOrThrow({ where: { projectId, operation: "DOCUMENT_REVISION" } });
    await approveRequirements(projectId, "v2");

    await expect(service.reviseDocumentation(request)).rejects.toMatchObject({ code: "PLANNING_REVISION_NO_CHANGES", httpStatus: 422 });
    expect(gateway.callStructured).toHaveBeenCalledTimes(1);
    expect(await prisma.workflowRun.count({ where: { projectId, currentPhase: "documentation" } })).toBe(2);
    expect(await prisma.phaseArtifact.count({ where: { projectId, phase: "documentation" } })).toBe(1);
    expect((await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe("failed");
  });

  test("running historical replay returns 202 after Requirements advancement", async () => {
    const projectId = await createProject();
    await approveRequirements(projectId, "v1");
    const v1 = await createInitialDoc(projectId);
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const gateway = { callStructured: jest.fn().mockImplementation(async () => { await barrier; return completion(draft((d) => { d.overview.summary = "Late"; })); }) };
    const service = new PlanningDocumentationGenerationService(prisma, { gateway });
    const request = { projectId, actorId: ownerId, baseArtifactId: v1.id, operation: "DOCUMENT_REVISION" as const,
      instruction: "Running revision", idempotencyKey: "historical-running" };
    const pending = service.reviseDocumentation(request);
    while (gateway.callStructured.mock.calls.length === 0) await new Promise((resolve) => setImmediate(resolve));
    await approveRequirements(projectId, "v2");
    const stateBeforeReplay = await prisma.projectPhaseState.findUniqueOrThrow({ where: { projectId_phase: { projectId, phase: "documentation" } } });
    const replay = await service.reviseDocumentation(request);
    expect(replay).toMatchObject({ httpStatus: 202, reused: true, artifact: null, run: { status: "running" } });
    expect(gateway.callStructured).toHaveBeenCalledTimes(1);
    const stateAfterReplay = await prisma.projectPhaseState.findUniqueOrThrow({ where: { projectId_phase: { projectId, phase: "documentation" } } });
    expect(stateAfterReplay.stateVersion).toBe(stateBeforeReplay.stateVersion);
    expect(stateAfterReplay.activeRunId).toBe(stateBeforeReplay.activeRunId);
    release();
    await expect(pending).rejects.toMatchObject({ code: "PLANNING_CONTEXT_CHANGED" });
  });

  test("initial generation completed replay also survives Requirements advancement", async () => {
    const projectId = await createProject();
    await approveRequirements(projectId, "v1");
    const gateway = { callStructured: jest.fn().mockResolvedValue(completion(draft())) };
    const service = new PlanningDocumentationGenerationService(prisma, { gateway });
    const request = { projectId, actorId: ownerId, idempotencyKey: "historical-initial" };
    const result = await service.generateInitial(request);
    await approveRequirements(projectId, "v2");
    const replay = await service.generateInitial(request);
    expect(replay).toMatchObject({ httpStatus: 200, reused: true, artifact: { id: result.artifact!.id }, run: { id: result.run.id } });
    expect(gateway.callStructured).toHaveBeenCalledTimes(1);
    expect(await prisma.phaseArtifact.count({ where: { projectId, phase: "documentation" } })).toBe(1);
  });

  test.each([
    ["DOCUMENT_REVISION", undefined, DOCUMENTATION_REVISION_PROMPT_VERSION],
    ["FEEDBACK_APPLICATION", undefined, DOCUMENTATION_FEEDBACK_PROMPT_VERSION],
    ["SECTION_REVISION", "overview", DOCUMENTATION_SECTION_REVISION_PROMPT_VERSION],
    ["SECTION_REGENERATION", "overview", DOCUMENTATION_SECTION_REGENERATION_PROMPT_VERSION],
  ] as const)("%s records its own prompt version in model usage", async (operation, targetSectionKey, promptVersion) => {
    const projectId = await createProject();
    await approveRequirements(projectId, "v1");
    const v1 = await createInitialDoc(projectId);
    const initialRun = await prisma.workflowRun.findFirstOrThrow({ where: { projectId, outputArtifactId: v1.id } });
    expect(initialRun.modelUsage).toMatchObject({ promptVersion: "documentation-initial-generation-v1" });
    const gateway = { callStructured: jest.fn().mockResolvedValue(completion(draft((d) => { d.overview.summary = "Changed"; }))) };
    const result = await new PlanningDocumentationGenerationService(prisma, { gateway }).reviseDocumentation({
      projectId, actorId: ownerId, baseArtifactId: v1.id, operation, targetSectionKey,
      instruction: "Change overview", idempotencyKey: `audit-${operation}`,
    });
    expect(result.run.modelUsage).toMatchObject({ promptVersion });
  });
});
