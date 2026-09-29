import crypto from "crypto";
import OpenAI from "openai";
import {
  ArtifactActorType,
  ArtifactChangeKind,
  PhaseArtifact,
  Prisma,
  PrismaClient,
  WorkflowOperation,
} from "@prisma/client";
import {
  LLMCallResult,
  LLMGateway,
  LLMProviderAttempt,
  LLMStructuredCallOptions,
} from "../../ai/gateway/LLMGateway";
import { LLMTimeoutError } from "../../ai/gateway/LLMError";
import { PipelineStages } from "../../ai/gateway/PipelineStage";
import { REQUIREMENTS_INPUT_LIMITS } from "../../planning/requirements-run-config";
import { RequirementsContent } from "../../planning/requirements-schema";
import {
  CreateRequirementsRevisionInput,
  PlanningArtifactService,
} from "../planning-artifact.service";
import { PlanningAuthorizationService } from "../planning-authorization.service";
import { PlanningGenerationService } from "../planning-generation.service";
import { PlanningApprovalService } from "../planning-approval.service";
import { PlanningReadinessService } from "../planning-readiness.service";
import {
  PlanningRequirementsRunService,
  StartRequirementsRunInput,
  StartRequirementsRunResult,
} from "../planning-requirements-run.service";

const databaseUrl = process.env.DATABASE_URL;
const isolatedSchema = databaseUrl ? new URL(databaseUrl).searchParams.get("schema") : null;
const describeIsolated = isolatedSchema?.startsWith("planning_checkpoint_1c_d_") ? describe : describe.skip;

const prisma = new PrismaClient();
const ownerId = `checkpoint-1c-d-owner-${crypto.randomUUID()}`;
const memberId = `checkpoint-1c-d-member-${crypto.randomUUID()}`;
const outsiderId = `checkpoint-1c-d-outsider-${crypto.randomUUID()}`;
const projectIds: string[] = [];

function baseRequirements(label = "Base System"): RequirementsContent {
  return {
    projectGoal: `Goal for ${label}`,
    problemStatement: `Problem for ${label}`,
    usersAndActors: [
      { id: "ACTOR-001", name: "Admin", description: "Administers the system." },
      { id: "ACTOR-002", name: "User", description: "Uses the system." },
    ],
    userStories: [
      {
        id: "US-001",
        actor: "Admin",
        capability: "manage permissions",
        benefit: "security is maintained",
        acceptanceCriteriaIds: ["AC-001"],
      },
    ],
    functionalRequirements: [
      { id: "FR-001", title: "Role Management", description: "Allow creating and assigning roles." },
      { id: "FR-002", title: "Audit Trail", description: "Record all administrative actions." },
    ],
    nonFunctionalRequirements: [
      { id: "NFR-001", title: "Latency", description: "P95 response time under 200ms." },
    ],
    constraints: [],
    integrations: [],
    assumptions: [],
    acceptanceCriteria: [
      { id: "AC-001", description: "Roles can be assigned.", relatedRequirementIds: ["FR-001", "FR-002"] },
    ],
    outOfScope: [],
    unresolvedQuestions: [],
  };
}

function rawResponse(
  content: RequirementsContent,
  model: string,
  usage?: OpenAI.Completions.CompletionUsage,
): OpenAI.Chat.Completions.ChatCompletion {
  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: 0,
    model,
    choices: [{
      index: 0,
      logprobs: null,
      finish_reason: "stop",
      message: { role: "assistant", content: JSON.stringify(content), refusal: null },
    }],
    ...(usage ? { usage } : {}),
  };
}

function gatewayResponse(input: {
  content: string;
  id: string;
  requestId: string;
  model: string;
  usage?: OpenAI.Completions.CompletionUsage;
}): OpenAI.Chat.Completions.ChatCompletion {
  const response: OpenAI.Chat.Completions.ChatCompletion & { _request_id?: string } = {
    id: input.id,
    object: "chat.completion",
    created: 0,
    model: input.model,
    choices: [{
      index: 0,
      logprobs: null,
      finish_reason: "stop",
      message: { role: "assistant", content: input.content, refusal: null },
    }],
    ...(input.usage ? { usage: input.usage } : {}),
  };
  response._request_id = input.requestId;
  return response;
}

class OpenAIBackedRequirementsGateway extends LLMGateway {
  constructor(private readonly client: OpenAI) {
    super();
  }

  override callStructured<T>(options: LLMStructuredCallOptions<T>): Promise<LLMCallResult<T>> {
    return super.callStructured({ ...options, openaiClient: this.client, retryDelayMs: 0 });
  }
}

function gatewayWithResponses(responses: OpenAI.Chat.Completions.ChatCompletion[]): {
  gateway: OpenAIBackedRequirementsGateway;
  create: jest.Mock;
} {
  const create = jest.fn();
  for (const response of responses) create.mockResolvedValueOnce(response);
  const client = { chat: { completions: { create } } } as unknown as OpenAI;
  return { gateway: new OpenAIBackedRequirementsGateway(client), create };
}

class FakeRequirementsGateway {
  calls = 0;

  constructor(
    private readonly content: RequirementsContent | (() => RequirementsContent),
    private readonly options: {
      model?: string;
      usage?: OpenAI.Completions.CompletionUsage;
      failure?: Error;
      beforeReturn?: () => Promise<void>;
      providerAttempts?: LLMProviderAttempt[];
    } = {},
  ) {}

  async callStructured<T>(options: LLMStructuredCallOptions<T>): Promise<LLMCallResult<T>> {
    this.calls += 1;
    if (this.options.failure) throw this.options.failure;
    await this.options.beforeReturn?.();
    const dataToValidate = typeof this.content === "function" ? this.content() : this.content;
    const validation = options.schema.validate(dataToValidate);
    if (!validation.valid || validation.data === undefined) {
      throw new Error(validation.errors?.join("; ") || "Fake output failed validation");
    }
    const model = this.options.model ?? "gpt-4o";
    const response = rawResponse(validation.data as unknown as RequirementsContent, model, this.options.usage);
    return {
      content: validation.data,
      rawResponse: response,
      finishReason: "stop",
      usage: { promptTokens: 999, completionTokens: 999, totalTokens: 1_998 },
      latencyMs: 12,
      model,
      stage: PipelineStages.ROADMAP_PLANNING,
      attemptCount: 1,
      ...(this.options.providerAttempts ? { providerAttempts: this.options.providerAttempts } : {}),
    };
  }
}

class RollbackRevisionArtifactService extends PlanningArtifactService {
  override async createSuccessorVersionInTransaction(
    tx: Prisma.TransactionClient,
    input: CreateRequirementsRevisionInput,
  ): Promise<{ artifact: PhaseArtifact; base: PhaseArtifact; state: any; latest: any }> {
    await super.createSuccessorVersionInTransaction(tx, input);
    throw new Error("forced failure after successor insertion");
  }
}

async function createProject(member = false): Promise<string> {
  const id = `checkpoint-1c-d-project-${crypto.randomUUID()}`;
  await prisma.project.create({
    data: { id, name: "Checkpoint 1C-D", description: "Whole-Document Requirements Revision", userId: ownerId },
  });
  if (member) await prisma.projectMember.create({ data: { projectId: id, userId: memberId } });
  projectIds.push(id);
  return id;
}

function createServices(
  gateway: Pick<LLMGateway, "callStructured">,
  artifacts?: PlanningArtifactService,
  runService?: PlanningRequirementsRunService,
) {
  const authorization = new PlanningAuthorizationService(prisma);
  const artifactService = artifacts ?? new PlanningArtifactService(prisma, authorization);
  const readiness = new PlanningReadinessService();
  const runs = runService ?? new PlanningRequirementsRunService(prisma, authorization, undefined, artifactService, readiness);
  const lifecycle = new PlanningApprovalService(prisma, authorization, undefined, readiness);
  const generation = new PlanningGenerationService(prisma, {
    authorization,
    artifacts: artifactService,
    readiness,
    runs,
    gateway,
  });
  return { authorization, artifactService, readiness, runs, lifecycle, generation };
}

describeIsolated("Checkpoint 1C-D1 Whole-Document Requirements Revision + Feedback Application", () => {
  beforeAll(async () => {
    await prisma.user.createMany({
      data: [
        { id: ownerId, email: `${ownerId}@anka.test`, password: "unused", role: "user" },
        { id: memberId, email: `${memberId}@anka.test`, password: "unused", role: "user" },
        { id: outsiderId, email: `${outsiderId}@anka.test`, password: "unused", role: "user" },
      ],
    });
  });

  afterAll(async () => {
    for (const id of projectIds.reverse()) {
      await prisma.project.delete({ where: { id } }).catch(() => {});
    }
    await prisma.user.deleteMany({ where: { id: { in: [ownerId, memberId, outsiderId] } } }).catch(() => {});
    await prisma.$disconnect();
  });

  // Helper to initialize project with v1
  async function seedV1(projectId: string, content = baseRequirements()) {
    const { artifactService } = createServices(new FakeRequirementsGateway(content));
    return artifactService.createInitialArtifact({
      projectId,
      actorId: ownerId,
      title: "Requirements v1",
      structuredContent: content,
      createdByType: ArtifactActorType.HUMAN,
      changeKind: ArtifactChangeKind.MANUAL_EDIT,
    });
  }

  // Helper to advance project to v3 and approve it
  async function seedApprovedV3(projectId: string) {
    const { artifactService, lifecycle } = createServices(new FakeRequirementsGateway(baseRequirements()));
    const v1 = await artifactService.createInitialArtifact({
      projectId,
      actorId: ownerId,
      title: "Requirements v1",
      structuredContent: baseRequirements("v1"),
      createdByType: ArtifactActorType.HUMAN,
      changeKind: ArtifactChangeKind.MANUAL_EDIT,
    });
    const v2 = await artifactService.createManualRevision({
      projectId,
      actorId: ownerId,
      baseArtifactId: v1.id,
      baseContentHash: v1.contentHash!,
      title: "Requirements v2",
      structuredContent: baseRequirements("v2"),
    });
    const v3 = await artifactService.createManualRevision({
      projectId,
      actorId: ownerId,
      baseArtifactId: v2.id,
      baseContentHash: v2.contentHash!,
      title: "Requirements v3",
      structuredContent: baseRequirements("v3"),
    });
    await lifecycle.requestApproval({
      projectId,
      phase: "requirements",
      artifactId: v3.id,
      expectedHash: v3.contentHash!,
      actorId: ownerId,
    });
    const approved = await lifecycle.approveArtifact({
      projectId,
      phase: "requirements",
      artifactId: v3.id,
      expectedHash: v3.contentHash!,
      actorId: ownerId,
    });
    return { v1, v2, v3, approved };
  }

  describe("SUCCESS / LINEAGE", () => {
    test("v1 + DOCUMENT_REVISION creates immutable v2 with linear lineage, diff, and readiness", async () => {
      const projectId = await createProject();
      const v1 = await seedV1(projectId);

      const revisedContent: RequirementsContent = {
        ...baseRequirements(),
        functionalRequirements: [
          ...baseRequirements().functionalRequirements,
          { id: "FR-003", title: "Data Retention", description: "Retain data for 90 days." },
        ],
        unresolvedQuestions: [
          { id: "UQ-001", question: "Is cold archival required after 90 days?" },
        ],
      };

      const gateway = new FakeRequirementsGateway(revisedContent);
      const { generation } = createServices(gateway);

      const result = await generation.reviseRequirements({
        projectId,
        actorId: ownerId,
        idempotencyKey: `idemp-${crypto.randomUUID()}`,
        baseArtifactId: v1.id,
        operation: "DOCUMENT_REVISION",
        instruction: "Add data retention requirement and an unresolved question.",
        includeMemory: false,
      });

      expect(result.reused).toBe(false);
      expect(result.artifact).not.toBeNull();
      expect(result.artifact!.version).toBe(2);
      expect(result.artifact!.previousVersionId).toBe(v1.id);
      expect(result.artifact!.basedOnArtifactId).toBe(v1.id);
      expect(result.artifact!.createdByType).toBe(ArtifactActorType.AI);
      expect(result.artifact!.changeKind).toBe(ArtifactChangeKind.AI_DOCUMENT_REVISION);
      expect(result.artifact!.lifecycleStatus).toBe("DRAFT");
      expect(result.artifact!.approved).toBe(false);
      expect(result.artifact!.approvedAt).toBeNull();

      // ProjectPhaseState verified
      const state = await prisma.projectPhaseState.findUniqueOrThrow({
        where: { projectId_phase: { projectId, phase: "requirements" } },
      });
      expect(state.currentArtifactId).toBe(result.artifact!.id);
      expect(state.status).toBe("in_progress");
      expect(state.approvalCandidateArtifactId).toBeNull();

      // Diff verified
      expect(result.diff).not.toBeNull();
      expect(result.diff!.changedRootSections).toEqual(["functionalRequirements", "unresolvedQuestions"]);
      expect(result.diff!.addedIds).toEqual(["FR-003", "UQ-001"]);
      expect(result.diff!.removedIds).toEqual([]);
      expect(result.diff!.retainedIds).toContain("FR-001");
      expect(result.diff!.retainedIds).toContain("FR-002");

      // Readiness verified (blocked because of unresolved questions)
      expect(result.readiness?.ready).toBe(false);
      expect(result.readiness?.blockers).toContainEqual(
        expect.objectContaining({ code: "REQUIREMENTS_UNRESOLVED_QUESTIONS" }),
      );

      // WorkflowRun recorded exact base authority
      const run = await prisma.workflowRun.findUniqueOrThrow({ where: { id: result.run.id } });
      expect(run.operation).toBe(WorkflowOperation.DOCUMENT_REVISION);
      expect(run.baseArtifactId).toBe(v1.id);
      expect(run.outputArtifactId).toBe(result.artifact!.id);
      expect(run.status).toBe("completed");

      const manifest = run.contextManifest as any;
      expect(manifest.baseArtifact.id).toBe(v1.id);
      expect(manifest.baseArtifact.version).toBe(v1.version);
      expect(manifest.baseArtifact.hash).toBe(v1.contentHash);
      expect(manifest.promptVersion).toBe("requirements-revision-v1");
    });
  });

  describe("FEEDBACK APPLICATION", () => {
    test("FEEDBACK_APPLICATION uses same revision engine with FEEDBACK_APPLICATION changeKind", async () => {
      const projectId = await createProject();
      const v1 = await seedV1(projectId);

      const revisedContent: RequirementsContent = {
        ...baseRequirements(),
        functionalRequirements: [
          { id: "FR-001", title: "Role Management", description: "Allow creating and assigning roles with MFA." },
          { id: "FR-002", title: "Audit Trail", description: "Record all administrative actions." },
        ],
      };

      const gateway = new FakeRequirementsGateway(revisedContent);
      const { generation } = createServices(gateway);

      const result = await generation.reviseRequirements({
        projectId,
        actorId: ownerId,
        idempotencyKey: `idemp-${crypto.randomUUID()}`,
        baseArtifactId: v1.id,
        operation: "FEEDBACK_APPLICATION",
        instruction: "Apply reviewer feedback: require MFA for role management.",
        includeMemory: false,
      });

      expect(result.artifact!.version).toBe(2);
      expect(result.artifact!.changeKind).toBe(ArtifactChangeKind.FEEDBACK_APPLICATION);
      expect(result.run.operation).toBe(WorkflowOperation.FEEDBACK_APPLICATION);
      expect(result.diff!.modifiedIds).toContain("FR-001");
    });
  });

  describe("APPROVED BASE SEMANTICS", () => {
    test("revising approved v3 produces draft unapproved v4, preserves v3 approval and currentApprovedArtifactId", async () => {
      const projectId = await createProject();
      const { v3 } = await seedApprovedV3(projectId);

      // State before AI revision
      const stateBefore = await prisma.projectPhaseState.findUniqueOrThrow({
        where: { projectId_phase: { projectId, phase: "requirements" } },
      });
      expect(stateBefore.currentArtifactId).toBe(v3.id);
      expect(stateBefore.currentApprovedArtifactId).toBe(v3.id);
      expect(stateBefore.status).toBe("approved");

      const revisedContent: RequirementsContent = {
        ...baseRequirements("v3"),
        functionalRequirements: [
          ...baseRequirements("v3").functionalRequirements,
          { id: "FR-003", title: "Security Alerts", description: "Send real-time alerts." },
        ],
        acceptanceCriteria: [
          ...baseRequirements("v3").acceptanceCriteria,
          { id: "AC-002", description: "Alerts are sent.", relatedRequirementIds: ["FR-003"] },
        ],
      };

      const gateway = new FakeRequirementsGateway(revisedContent);
      const { generation } = createServices(gateway);

      const result = await generation.reviseRequirements({
        projectId,
        actorId: ownerId,
        idempotencyKey: `idemp-${crypto.randomUUID()}`,
        baseArtifactId: v3.id,
        operation: "DOCUMENT_REVISION",
        instruction: "Add real-time security alerts.",
        includeMemory: false,
      });

      expect(result.artifact!.version).toBe(4);
      expect(result.artifact!.lifecycleStatus).toBe("DRAFT");
      expect(result.artifact!.approved).toBe(false);
      expect(result.artifact!.approvedAt).toBeNull();
      expect(result.artifact!.previousVersionId).toBe(v3.id);

      // v3 must remain approved
      const v3Db = await prisma.phaseArtifact.findUniqueOrThrow({ where: { id: v3.id } });
      expect(v3Db.approved).toBe(true);
      expect(v3Db.lifecycleStatus).toBe("APPROVED");

      // Phase state pointers
      const stateAfter = await prisma.projectPhaseState.findUniqueOrThrow({
        where: { projectId_phase: { projectId, phase: "requirements" } },
      });
      expect(stateAfter.currentArtifactId).toBe(result.artifact!.id);
      expect(stateAfter.currentApprovedArtifactId).toBe(v3.id);
      expect(stateAfter.approvalCandidateArtifactId).toBeNull();
      expect(stateAfter.status).toBe("in_progress");
    });
  });

  describe("STABLE ID POLICY", () => {
    test("rejects moving an existing ID between root collections", async () => {
      const projectId = await createProject();
      const v1 = await seedV1(projectId);

      // FR-001 moved from functionalRequirements to nonFunctionalRequirements
      const invalidContent: RequirementsContent = {
        ...baseRequirements(),
        functionalRequirements: [
          { id: "FR-002", title: "Audit Trail", description: "Record actions." },
        ],
        nonFunctionalRequirements: [
          { id: "FR-001", title: "Role Management", description: "Moved to NFR improperly." },
        ],
      };

      const gateway = new FakeRequirementsGateway(invalidContent);
      const { generation } = createServices(gateway);

      await expect(
        generation.reviseRequirements({
          projectId,
          actorId: ownerId,
          idempotencyKey: `idemp-${crypto.randomUUID()}`,
          baseArtifactId: v1.id,
          operation: "DOCUMENT_REVISION",
          instruction: "Move role management to NFR.",
          includeMemory: false,
        }),
      ).rejects.toMatchObject({
        code: "PLANNING_ARTIFACT_INVALID",
        httpStatus: 422,
      });
    });

    test("rejects churned ID when an identical entity payload is assigned a new ID", async () => {
      const projectId = await createProject();
      const v1 = await seedV1(projectId);

      // Replace FR-002 with FR-999 having identical title and description
      const invalidContent: RequirementsContent = {
        ...baseRequirements(),
        functionalRequirements: [
          { id: "FR-001", title: "Role Management", description: "Allow creating and assigning roles." },
          { id: "FR-999", title: "Audit Trail", description: "Record all administrative actions." }, // identical payload to FR-002
        ],
        acceptanceCriteria: [
          { id: "AC-001", description: "Roles can be assigned.", relatedRequirementIds: ["FR-001", "FR-999"] },
        ],
      };

      const gateway = new FakeRequirementsGateway(invalidContent);
      const { generation } = createServices(gateway);
      const idempotencyKey = `idemp-${crypto.randomUUID()}`;
      const request = {
        projectId,
        actorId: ownerId,
        idempotencyKey,
        baseArtifactId: v1.id,
        operation: "DOCUMENT_REVISION" as const,
        instruction: "Rename FR-002 ID to FR-999.",
        includeMemory: false,
      };

      await expect(
        generation.reviseRequirements(request),
      ).rejects.toMatchObject({
        code: "PLANNING_ARTIFACT_INVALID",
        httpStatus: 422,
      });

      expect(gateway.calls).toBe(1);
      await expect(prisma.workflowRun.findMany({ where: { projectId } })).resolves.toEqual([
        expect.objectContaining({
          status: "failed",
          errorCode: "PLANNING_ARTIFACT_INVALID",
          outputArtifactId: null,
        }),
      ]);
      await expect(prisma.phaseArtifact.count({ where: { projectId } })).resolves.toBe(1);
      await expect(prisma.projectPhaseState.findUniqueOrThrow({
        where: { projectId_phase: { projectId, phase: "requirements" } },
      })).resolves.toMatchObject({ currentArtifactId: v1.id, activeRunId: null });

      await expect(generation.reviseRequirements(request)).rejects.toMatchObject({
        code: "PLANNING_ARTIFACT_INVALID",
        httpStatus: 422,
        details: expect.objectContaining({ reused: true }),
      });

      expect(gateway.calls).toBe(1);
      await expect(prisma.workflowRun.count({ where: { projectId } })).resolves.toBe(1);
      await expect(prisma.phaseArtifact.count({ where: { projectId } })).resolves.toBe(1);
      await expect(prisma.projectPhaseState.findUniqueOrThrow({
        where: { projectId_phase: { projectId, phase: "requirements" } },
      })).resolves.toMatchObject({ currentArtifactId: v1.id, activeRunId: null });
    });

    test("allows modified same-concept entity to retain ID, and genuine new entity to get new ID", async () => {
      const projectId = await createProject();
      const v1 = await seedV1(projectId);

      const validContent: RequirementsContent = {
        ...baseRequirements(),
        functionalRequirements: [
          { id: "FR-001", title: "Role Management", description: "Modified description." },
          { id: "FR-002", title: "Audit Trail", description: "Record all administrative actions." },
          { id: "FR-003", title: "Genuine New Entity", description: "Brand new feature." },
        ],
      };

      const gateway = new FakeRequirementsGateway(validContent);
      const { generation } = createServices(gateway);

      const result = await generation.reviseRequirements({
        projectId,
        actorId: ownerId,
        idempotencyKey: `idemp-${crypto.randomUUID()}`,
        baseArtifactId: v1.id,
        operation: "DOCUMENT_REVISION",
        instruction: "Modify FR-001 and add FR-003.",
        includeMemory: false,
      });

      expect(result.diff!.modifiedIds).toEqual(["FR-001"]);
      expect(result.diff!.addedIds).toEqual(["FR-003"]);
      expect(result.diff!.retainedIds).toContain("FR-002");
    });
  });

  describe("NO-OP REVISION", () => {
    test("returns PLANNING_REVISION_NO_CHANGES (422) when generated content is identical to base, retains audit and releases lease", async () => {
      const projectId = await createProject();
      const v1 = await seedV1(projectId);

      // Return identical base content
      const gateway = new FakeRequirementsGateway(baseRequirements());
      const { generation } = createServices(gateway);

      await expect(
        generation.reviseRequirements({
          projectId,
          actorId: ownerId,
          idempotencyKey: `idemp-${crypto.randomUUID()}`,
          baseArtifactId: v1.id,
          operation: "DOCUMENT_REVISION",
          instruction: "Do nothing.",
          includeMemory: false,
        }),
      ).rejects.toMatchObject({
        code: "PLANNING_REVISION_NO_CHANGES",
        httpStatus: 422,
      });

      // No successor artifact created
      const count = await prisma.phaseArtifact.count({ where: { projectId } });
      expect(count).toBe(1);

      // Provider audit retained in modelUsage and lease released
      const run = await prisma.workflowRun.findFirstOrThrow({ where: { projectId } });
      expect(run.status).toBe("failed");
      const usage = run.modelUsage as Record<string, unknown>;
      expect(usage).toBeDefined();

      const state = await prisma.projectPhaseState.findUniqueOrThrow({
        where: { projectId_phase: { projectId, phase: "requirements" } },
      });
      expect(state.activeRunId).toBeNull();
      expect(state.currentArtifactId).toBe(v1.id);
    });
  });

  describe("CONCURRENCY / CURRENTNESS RACE", () => {
    test("human creates v2 while AI is revising v1 -> AI conflicts with PLANNING_CONTEXT_CHANGED, lease released, v2 remains current", async () => {
      const projectId = await createProject();
      const v1 = await seedV1(projectId);

      const revisedContent: RequirementsContent = {
        ...baseRequirements(),
        functionalRequirements: [
          ...baseRequirements().functionalRequirements,
          { id: "FR-003", title: "AI Feature", description: "Added by AI." },
        ],
      };

      const { artifactService } = createServices(new FakeRequirementsGateway(revisedContent));

      const gateway = new FakeRequirementsGateway(revisedContent, {
        beforeReturn: async () => {
          // Human creates v2 concurrently
          await artifactService.createManualRevision({
            projectId,
            actorId: ownerId,
            baseArtifactId: v1.id,
            baseContentHash: v1.contentHash!,
            title: "Requirements v2 (Human)",
            structuredContent: {
              ...baseRequirements(),
              projectGoal: "Human intervened goal",
            },
          });
        },
      });

      const { generation } = createServices(gateway);

      await expect(
        generation.reviseRequirements({
          projectId,
          actorId: ownerId,
          idempotencyKey: `idemp-${crypto.randomUUID()}`,
          baseArtifactId: v1.id,
          operation: "DOCUMENT_REVISION",
          instruction: "Add AI feature.",
          includeMemory: false,
        }),
      ).rejects.toMatchObject({
        code: "PLANNING_CONTEXT_CHANGED",
        httpStatus: 409,
      });

      // Exactly 2 artifacts: v1 and human v2
      const artifacts = await prisma.phaseArtifact.findMany({ where: { projectId }, orderBy: { version: "asc" } });
      expect(artifacts.length).toBe(2);
      expect(artifacts[1].title).toBe("Requirements v2 (Human)");

      // Phase state points to human v2 and lease is released
      const state = await prisma.projectPhaseState.findUniqueOrThrow({
        where: { projectId_phase: { projectId, phase: "requirements" } },
      });
      expect(state.currentArtifactId).toBe(artifacts[1].id);
      expect(state.activeRunId).toBeNull();

      // Run is conflicted and audit retained
      const run = await prisma.workflowRun.findFirstOrThrow({ where: { projectId } });
      expect(run.status).toBe("conflicted");
      const usage = run.modelUsage as Record<string, unknown>;
      expect(usage).toBeDefined();
    });
  });

  describe("AWAITING APPROVAL", () => {
    test("revision is rejected BEFORE calling provider if phase is awaiting_approval", async () => {
      const projectId = await createProject();
      const v1 = await seedV1(projectId);
      const { lifecycle } = createServices(new FakeRequirementsGateway(baseRequirements()));

      // Submit v1 for approval
      await lifecycle.requestApproval({
        projectId,
        phase: "requirements",
        artifactId: v1.id,
        expectedHash: v1.contentHash!,
        actorId: ownerId,
      });

      const gateway = new FakeRequirementsGateway({
        ...baseRequirements(),
        projectGoal: "New Goal",
      });
      const { generation } = createServices(gateway);

      await expect(
        generation.reviseRequirements({
          projectId,
          actorId: ownerId,
          idempotencyKey: `idemp-${crypto.randomUUID()}`,
          baseArtifactId: v1.id,
          operation: "DOCUMENT_REVISION",
          instruction: "Revise while awaiting approval.",
          includeMemory: false,
        }),
      ).rejects.toMatchObject({
        code: "PLANNING_ACTION_LOCKED",
        httpStatus: 409,
      });

      // Provider was never called
      expect(gateway.calls).toBe(0);
    });

    test("approval race: submitting for approval while AI is running causes Transaction B to conflict safely", async () => {
      const projectId = await createProject();
      const v1 = await seedV1(projectId);
      const { lifecycle } = createServices(new FakeRequirementsGateway(baseRequirements()));

      const revisedContent: RequirementsContent = {
        ...baseRequirements(),
        functionalRequirements: [
          ...baseRequirements().functionalRequirements,
          { id: "FR-003", title: "Security Alert", description: "Alerting." },
        ],
        acceptanceCriteria: [
          ...baseRequirements().acceptanceCriteria,
          { id: "AC-002", description: "Alerts are sent.", relatedRequirementIds: ["FR-003"] },
        ],
      };

      const gateway = new FakeRequirementsGateway(revisedContent, {
        beforeReturn: async () => {
          // Human submits v1 for approval while AI was executing
          await lifecycle.requestApproval({
            projectId,
            phase: "requirements",
            artifactId: v1.id,
            expectedHash: v1.contentHash!,
            actorId: ownerId,
          });
        },
      });

      const { generation } = createServices(gateway);

      await expect(
        generation.reviseRequirements({
          projectId,
          actorId: ownerId,
          idempotencyKey: `idemp-${crypto.randomUUID()}`,
          baseArtifactId: v1.id,
          operation: "DOCUMENT_REVISION",
          instruction: "Add security alert.",
          includeMemory: false,
        }),
      ).rejects.toMatchObject({
        code: "PLANNING_CONTEXT_CHANGED",
        httpStatus: 409,
      });

      // Approval candidate remains untouched
      const state = await prisma.projectPhaseState.findUniqueOrThrow({
        where: { projectId_phase: { projectId, phase: "requirements" } },
      });
      expect(state.status).toBe("awaiting_approval");
      expect(state.approvalCandidateArtifactId).toBe(v1.id);
      expect(state.currentArtifactId).toBe(v1.id);
      expect(state.activeRunId).toBeNull();
    });
  });

  describe("IDEMPOTENCY / REPLAY", () => {
    test("completed replay returns same artifact and diff without calling provider", async () => {
      const projectId = await createProject();
      const v1 = await seedV1(projectId);
      const idempKey = `idemp-${crypto.randomUUID()}`;

      const revisedContent: RequirementsContent = {
        ...baseRequirements(),
        functionalRequirements: [
          ...baseRequirements().functionalRequirements,
          { id: "FR-003", title: "New Feature", description: "Added." },
        ],
      };

      const gateway = new FakeRequirementsGateway(revisedContent);
      const { generation } = createServices(gateway);

      const firstResult = await generation.reviseRequirements({
        projectId,
        actorId: ownerId,
        idempotencyKey: idempKey,
        baseArtifactId: v1.id,
        operation: "DOCUMENT_REVISION",
        instruction: "Add new feature.",
        includeMemory: false,
      });
      expect(firstResult.reused).toBe(false);
      expect(gateway.calls).toBe(1);

      // Replay identical request
      const replayResult = await generation.reviseRequirements({
        projectId,
        actorId: ownerId,
        idempotencyKey: idempKey,
        baseArtifactId: v1.id,
        operation: "DOCUMENT_REVISION",
        instruction: "Add new feature.",
        includeMemory: false,
      });

      expect(replayResult.reused).toBe(true);
      expect(replayResult.artifact!.id).toBe(firstResult.artifact!.id);
      expect(replayResult.diff).toEqual(firstResult.diff);
      expect(gateway.calls).toBe(1); // Provider NOT called again
    });

    test("changed instruction on same idempotency key raises PLANNING_IDEMPOTENCY_CONFLICT", async () => {
      const projectId = await createProject();
      const v1 = await seedV1(projectId);
      const idempKey = `idemp-${crypto.randomUUID()}`;

      const revisedContent: RequirementsContent = {
        ...baseRequirements(),
        functionalRequirements: [
          ...baseRequirements().functionalRequirements,
          { id: "FR-003", title: "Feature", description: "Desc." },
        ],
      };

      const gateway = new FakeRequirementsGateway(revisedContent);
      const { generation } = createServices(gateway);

      await generation.reviseRequirements({
        projectId,
        actorId: ownerId,
        idempotencyKey: idempKey,
        baseArtifactId: v1.id,
        operation: "DOCUMENT_REVISION",
        instruction: "Instruction A",
        includeMemory: false,
      });

      await expect(
        generation.reviseRequirements({
          projectId,
          actorId: ownerId,
          idempotencyKey: idempKey,
          baseArtifactId: v1.id,
          operation: "DOCUMENT_REVISION",
          instruction: "Instruction B (Different)",
          includeMemory: false,
        }),
      ).rejects.toMatchObject({
        code: "PLANNING_IDEMPOTENCY_CONFLICT",
        httpStatus: 409,
      });
    });

    test("changed includeMemory on same idempotency key raises PLANNING_IDEMPOTENCY_CONFLICT", async () => {
      const projectId = await createProject();
      const v1 = await seedV1(projectId);
      const idempKey = `idemp-${crypto.randomUUID()}`;

      const revisedContent: RequirementsContent = {
        ...baseRequirements(),
        functionalRequirements: [
          ...baseRequirements().functionalRequirements,
          { id: "FR-003", title: "Feature", description: "Desc." },
        ],
      };

      const gateway = new FakeRequirementsGateway(revisedContent);
      const { generation } = createServices(gateway);

      await generation.reviseRequirements({
        projectId,
        actorId: ownerId,
        idempotencyKey: idempKey,
        baseArtifactId: v1.id,
        operation: "DOCUMENT_REVISION",
        instruction: "Same instruction",
        includeMemory: false,
      });

      await expect(
        generation.reviseRequirements({
          projectId,
          actorId: ownerId,
          idempotencyKey: idempKey,
          baseArtifactId: v1.id,
          operation: "DOCUMENT_REVISION",
          instruction: "Same instruction",
          includeMemory: true,
        }),
      ).rejects.toMatchObject({
        code: "PLANNING_IDEMPOTENCY_CONFLICT",
        httpStatus: 409,
      });
    });

    test.each([
      ["DOCUMENT_REVISION", "FEEDBACK_APPLICATION"],
      ["FEEDBACK_APPLICATION", "DOCUMENT_REVISION"],
    ] as const)(
      "same idempotency key with %s then %s raises PLANNING_IDEMPOTENCY_CONFLICT without a second run or provider call",
      async (firstOperation, secondOperation) => {
        const projectId = await createProject();
        const v1 = await seedV1(projectId);
        const idempKey = `idemp-${crypto.randomUUID()}`;

        const revisedContent: RequirementsContent = {
          ...baseRequirements(),
          functionalRequirements: [
            ...baseRequirements().functionalRequirements,
            { id: "FR-003", title: "Feature", description: "Desc." },
          ],
        };

        const gateway = new FakeRequirementsGateway(revisedContent);
        const { generation } = createServices(gateway);

        const first = await generation.reviseRequirements({
          projectId,
          actorId: ownerId,
          idempotencyKey: idempKey,
          baseArtifactId: v1.id,
          operation: firstOperation,
          instruction: "Same instruction",
          includeMemory: false,
        });
        expect(first.run.status).toBe("completed");
        expect(gateway.calls).toBe(1);

        const stateBefore = await prisma.projectPhaseState.findUniqueOrThrow({
          where: { projectId_phase: { projectId, phase: "requirements" } },
        });
        const artifactCountBefore = await prisma.phaseArtifact.count({ where: { projectId } });

        await expect(
          generation.reviseRequirements({
            projectId,
            actorId: ownerId,
            idempotencyKey: idempKey,
            baseArtifactId: v1.id,
            operation: secondOperation,
            instruction: "Same instruction",
            includeMemory: false,
          }),
        ).rejects.toMatchObject({
          code: "PLANNING_IDEMPOTENCY_CONFLICT",
          httpStatus: 409,
        });

        expect(gateway.calls).toBe(1);
        const runs = await prisma.workflowRun.findMany({ where: { projectId } });
        expect(runs).toHaveLength(1);
        expect(runs[0].operation).toBe(firstOperation);
        expect(await prisma.phaseArtifact.count({ where: { projectId } })).toBe(artifactCountBefore);
        const stateAfter = await prisma.projectPhaseState.findUniqueOrThrow({
          where: { projectId_phase: { projectId, phase: "requirements" } },
        });
        expect(stateAfter).toEqual(stateBefore);
      },
    );
  });

  describe("PRE-PROVIDER CURRENTNESS FAILURE", () => {
    test("context change after Transaction A conflicts the run, releases the lease, and does not call the provider", async () => {
      const projectId = await createProject();
      const { v3 } = await seedApprovedV3(projectId);
      const stateBefore = await prisma.projectPhaseState.findUniqueOrThrow({
        where: { projectId_phase: { projectId, phase: "requirements" } },
      });
      const artifactCountBefore = await prisma.phaseArtifact.count({ where: { projectId } });

      let renamed = false;
      class RenameAfterTransactionARunService extends PlanningRequirementsRunService {
        override async startRequirementsRun(input: StartRequirementsRunInput): Promise<StartRequirementsRunResult> {
          const started = await super.startRequirementsRun(input);
          if (!renamed) {
            renamed = true;
            // Authoritative project metadata changes after the lease commits but before the provider call.
            await prisma.project.update({ where: { id: input.projectId }, data: { name: "Renamed concurrently" } });
          }
          return started;
        }
      }

      const revisedContent: RequirementsContent = {
        ...baseRequirements("v3"),
        projectGoal: "Revised goal",
      };
      const gateway = new FakeRequirementsGateway(revisedContent);
      const authorization = new PlanningAuthorizationService(prisma);
      const artifactService = new PlanningArtifactService(prisma, authorization);
      const runService = new RenameAfterTransactionARunService(
        prisma,
        authorization,
        undefined,
        artifactService,
        new PlanningReadinessService(),
      );
      const { generation } = createServices(gateway, artifactService, runService);
      const request = {
        projectId,
        actorId: ownerId,
        idempotencyKey: `idemp-${crypto.randomUUID()}`,
        baseArtifactId: v3.id,
        operation: "DOCUMENT_REVISION" as const,
        instruction: "Revise the goal.",
        includeMemory: false,
      };

      await expect(generation.reviseRequirements(request)).rejects.toMatchObject({
        code: "PLANNING_CONTEXT_CHANGED",
        httpStatus: 409,
      });
      expect(gateway.calls).toBe(0);

      const run = await prisma.workflowRun.findFirstOrThrow({ where: { projectId } });
      expect(run.status).toBe("conflicted");
      expect(run.errorCode).toBe("PLANNING_CONTEXT_CHANGED");
      expect(run.outputArtifactId).toBeNull();
      expect(run.completedAt).not.toBeNull();

      const stateAfter = await prisma.projectPhaseState.findUniqueOrThrow({
        where: { projectId_phase: { projectId, phase: "requirements" } },
      });
      expect(stateAfter.activeRunId).toBeNull();
      expect(stateAfter.currentArtifactId).toBe(v3.id);
      expect(stateAfter.currentApprovedArtifactId).toBe(stateBefore.currentApprovedArtifactId);
      expect(stateAfter.currentApprovedArtifactId).toBe(v3.id);
      expect(stateAfter.approvalCandidateArtifactId).toBe(stateBefore.approvalCandidateArtifactId);
      expect(stateAfter.status).toBe(stateBefore.status);
      expect(await prisma.phaseArtifact.count({ where: { projectId } })).toBe(artifactCountBefore);

      // Same-key replay returns the stored terminal conflict, not 202 running.
      await expect(generation.reviseRequirements(request)).rejects.toMatchObject({
        code: "PLANNING_CONTEXT_CHANGED",
        httpStatus: 409,
        details: expect.objectContaining({ reused: true }),
      });
      expect(gateway.calls).toBe(0);

      // A new legitimate request is not blocked by a leaked lease.
      const next = await generation.reviseRequirements({
        ...request,
        idempotencyKey: `idemp-${crypto.randomUUID()}`,
      });
      expect(next.httpStatus).toBe(201);
      expect(gateway.calls).toBe(1);
      expect(next.artifact!.version).toBe(v3.version + 1);
      expect(next.artifact!.previousVersionId).toBe(v3.id);
    });
  });

  describe("FAILURES AND RECOVERY", () => {
    test("gateway timeout raises PLANNING_AI_TIMEOUT (504), retains audit, and releases lease", async () => {
      const projectId = await createProject();
      const v1 = await seedV1(projectId);

      const gateway = new FakeRequirementsGateway(baseRequirements(), {
        failure: new LLMTimeoutError("Request timed out", { timeoutMs: 45000 }),
      });
      const { generation } = createServices(gateway);

      await expect(
        generation.reviseRequirements({
          projectId,
          actorId: ownerId,
          idempotencyKey: `idemp-${crypto.randomUUID()}`,
          baseArtifactId: v1.id,
          operation: "DOCUMENT_REVISION",
          instruction: "Revise requirements.",
          includeMemory: false,
        }),
      ).rejects.toMatchObject({
        code: "PLANNING_AI_TIMEOUT",
        httpStatus: 504,
      });

      const run = await prisma.workflowRun.findFirstOrThrow({ where: { projectId } });
      expect(run.status).toBe("failed");
      const usage = run.modelUsage as Record<string, unknown>;
      expect(usage).toBeDefined();

      const state = await prisma.projectPhaseState.findUniqueOrThrow({
        where: { projectId_phase: { projectId, phase: "requirements" } },
      });
      expect(state.activeRunId).toBeNull();
    });

    test("structured output repair succeeds and records repair in provider audit", async () => {
      const projectId = await createProject();
      const v1 = await seedV1(projectId);

      const validRevision: RequirementsContent = {
        ...baseRequirements(),
        functionalRequirements: [
          ...baseRequirements().functionalRequirements,
          { id: "FR-003", title: "Repaired Feature", description: "Successfully repaired." },
        ],
      };

      const { gateway, create } = gatewayWithResponses([
        gatewayResponse({
          id: "resp-1",
          requestId: "req-1",
          model: "gpt-4o",
          content: "{ broken json",
        }),
        gatewayResponse({
          id: "resp-2",
          requestId: "req-2",
          model: "gpt-4o",
          content: JSON.stringify(validRevision),
        }),
      ]);

      const { generation } = createServices(gateway);

      const result = await generation.reviseRequirements({
        projectId,
        actorId: ownerId,
        idempotencyKey: `idemp-${crypto.randomUUID()}`,
        baseArtifactId: v1.id,
        operation: "DOCUMENT_REVISION",
        instruction: "Add feature with repair.",
        includeMemory: false,
      });

      expect(create).toHaveBeenCalledTimes(2);
      expect(result.artifact!.version).toBe(2);

      const run = await prisma.workflowRun.findUniqueOrThrow({ where: { id: result.run.id } });
      const usage = run.modelUsage as any;
      expect(usage.attempts.length).toBe(2);
      expect(usage.attempts[0].kind).toBe("initial");
      expect(usage.attempts[1].kind).toBe("structured_repair");
    });

    test("failed repair retains provider audit and marks run failed", async () => {
      const projectId = await createProject();
      const v1 = await seedV1(projectId);

      const { gateway, create } = gatewayWithResponses([
        gatewayResponse({
          id: "resp-1",
          requestId: "req-1",
          model: "gpt-4o",
          content: "{ broken json 1",
        }),
        gatewayResponse({
          id: "resp-2",
          requestId: "req-2",
          model: "gpt-4o",
          content: "{ broken json 2",
        }),
      ]);

      const { generation } = createServices(gateway);

      await expect(
        generation.reviseRequirements({
          projectId,
          actorId: ownerId,
          idempotencyKey: `idemp-${crypto.randomUUID()}`,
          baseArtifactId: v1.id,
          operation: "DOCUMENT_REVISION",
          instruction: "Irreparable output.",
          includeMemory: false,
        }),
      ).rejects.toMatchObject({
        code: "PLANNING_AI_INVALID_RESPONSE",
        httpStatus: 502,
      });

      expect(create).toHaveBeenCalledTimes(2);

      const run = await prisma.workflowRun.findFirstOrThrow({ where: { projectId } });
      expect(run.status).toBe("failed");
      const usage = run.modelUsage as any;
      expect(usage.attempts.length).toBe(2);
    });

    test("authorization removed while LLM is running causes run cancellation and lease release", async () => {
      const projectId = await createProject(true);
      const v1 = await seedV1(projectId);

      const revisedContent: RequirementsContent = {
        ...baseRequirements(),
        functionalRequirements: [
          ...baseRequirements().functionalRequirements,
          { id: "FR-003", title: "Auth rev feature", description: "Desc." },
        ],
      };

      const gateway = new FakeRequirementsGateway(revisedContent, {
        beforeReturn: async () => {
          // Remove member access while provider was working
          await prisma.projectMember.deleteMany({
            where: { projectId, userId: memberId },
          });
        },
      });

      const { generation } = createServices(gateway);

      await expect(
        generation.reviseRequirements({
          projectId,
          actorId: memberId,
          idempotencyKey: `idemp-${crypto.randomUUID()}`,
          baseArtifactId: v1.id,
          operation: "DOCUMENT_REVISION",
          instruction: "Revise as member.",
          includeMemory: false,
        }),
      ).rejects.toMatchObject({
        code: "PLANNING_PROJECT_NOT_FOUND",
        httpStatus: 404,
      });

      const run = await prisma.workflowRun.findFirstOrThrow({ where: { projectId } });
      expect(run.status).toBe("cancelled");

      const state = await prisma.projectPhaseState.findUniqueOrThrow({
        where: { projectId_phase: { projectId, phase: "requirements" } },
      });
      expect(state.activeRunId).toBeNull();
    });

    test("Transaction B rollback leaves zero partial artifact or pointer state", async () => {
      const projectId = await createProject();
      const v1 = await seedV1(projectId);

      const revisedContent: RequirementsContent = {
        ...baseRequirements(),
        functionalRequirements: [
          ...baseRequirements().functionalRequirements,
          { id: "FR-003", title: "Rollback feature", description: "Desc." },
        ],
      };

      const gateway = new FakeRequirementsGateway(revisedContent);
      const rollbackArtifacts = new RollbackRevisionArtifactService(prisma);
      const { generation } = createServices(gateway, rollbackArtifacts);

      await expect(
        generation.reviseRequirements({
          projectId,
          actorId: ownerId,
          idempotencyKey: `idemp-${crypto.randomUUID()}`,
          baseArtifactId: v1.id,
          operation: "DOCUMENT_REVISION",
          instruction: "Trigger rollback.",
          includeMemory: false,
        }),
      ).rejects.toMatchObject({
        code: "PLANNING_PERSISTENCE_FAILED",
        httpStatus: 503,
      });

      // Verify no v2 survived
      const artifacts = await prisma.phaseArtifact.findMany({ where: { projectId } });
      expect(artifacts.length).toBe(1);
      expect(artifacts[0].id).toBe(v1.id);

      // Verify phase state was not mutated
      const state = await prisma.projectPhaseState.findUniqueOrThrow({
        where: { projectId_phase: { projectId, phase: "requirements" } },
      });
      expect(state.currentArtifactId).toBe(v1.id);
    });

    test("enforces output byte limit and rejects oversized payload with PLANNING_AI_OUTPUT_TOO_LARGE", async () => {
      const projectId = await createProject();
      const v1 = await seedV1(projectId);

      // Create an oversized content (> 256KB)
      const oversizedRequirements: RequirementsContent = {
        ...baseRequirements(),
        projectGoal: "X".repeat(REQUIREMENTS_INPUT_LIMITS.canonicalArtifactJsonBytes + 1000),
      };

      const gateway = new FakeRequirementsGateway(oversizedRequirements);
      const { generation } = createServices(gateway);

      await expect(
        generation.reviseRequirements({
          projectId,
          actorId: ownerId,
          idempotencyKey: `idemp-${crypto.randomUUID()}`,
          baseArtifactId: v1.id,
          operation: "DOCUMENT_REVISION",
          instruction: "Oversized output.",
          includeMemory: false,
        }),
      ).rejects.toMatchObject({
        code: "PLANNING_AI_OUTPUT_TOO_LARGE",
        httpStatus: 502,
      });
    });
  });
});
