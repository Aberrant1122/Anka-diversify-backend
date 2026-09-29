import crypto from "crypto";
import OpenAI from "openai";
import { PhaseArtifact, Prisma, PrismaClient, ProjectPhaseState } from "@prisma/client";
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
  CreateInitialRequirementsArtifactInput,
  PlanningArtifactService,
} from "../planning-artifact.service";
import { PlanningAuthorizationService } from "../planning-authorization.service";
import { PlanningGenerationService } from "../planning-generation.service";
import { PlanningReadinessService } from "../planning-readiness.service";
import { PlanningRequirementsRunService } from "../planning-requirements-run.service";

const databaseUrl = process.env.DATABASE_URL;
const isolatedSchema = databaseUrl ? new URL(databaseUrl).searchParams.get("schema") : null;
const describeIsolated = isolatedSchema?.startsWith("planning_checkpoint_1c_c_") ? describe : describe.skip;

const prisma = new PrismaClient();
const ownerId = `checkpoint-1c-c-owner-${crypto.randomUUID()}`;
const memberId = `checkpoint-1c-c-member-${crypto.randomUUID()}`;
const projectIds: string[] = [];

function requirements(label: string, unresolved = false): RequirementsContent {
  return {
    projectGoal: `Deliver ${label}`,
    problemStatement: `Need ${label}`,
    usersAndActors: [{ id: "ACTOR-001", name: "Owner", description: "Owns the outcome." }],
    userStories: [{
      id: "US-001",
      actor: "Owner",
      capability: `use ${label}`,
      benefit: "the intended outcome is achieved",
      acceptanceCriteriaIds: ["AC-001"],
    }],
    functionalRequirements: [{ id: "FR-001", title: "Core outcome", description: `Support ${label}.` }],
    nonFunctionalRequirements: [{ id: "NFR-001", title: "Auditability", description: "Retain provenance." }],
    constraints: [],
    integrations: [],
    assumptions: [],
    acceptanceCriteria: [{ id: "AC-001", description: "The outcome works.", relatedRequirementIds: ["FR-001"] }],
    outOfScope: [],
    unresolvedQuestions: unresolved ? [{ id: "UQ-001", question: "Which audience is primary?" }] : [],
  };
}

function rawResponse(
  content: RequirementsContent,
  model: string,
  usage: OpenAI.Completions.CompletionUsage | undefined,
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
    private readonly content: RequirementsContent,
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
    const validation = options.schema.validate(this.content);
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

class TransactionAFailureRunService extends PlanningRequirementsRunService {
  override async startRequirementsRun(
    _input: Parameters<PlanningRequirementsRunService["startRequirementsRun"]>[0],
  ): ReturnType<PlanningRequirementsRunService["startRequirementsRun"]> {
    throw new Error("sensitive database host and query text");
  }
}

class RollbackArtifactService extends PlanningArtifactService {
  override async createInitialArtifactInTransaction(
    tx: Prisma.TransactionClient,
    input: CreateInitialRequirementsArtifactInput,
  ): Promise<{ artifact: PhaseArtifact; state: ProjectPhaseState }> {
    await super.createInitialArtifactInTransaction(tx, input);
    throw new Error("forced failure after artifact insertion");
  }
}

async function createProject(member = false): Promise<string> {
  const id = `checkpoint-1c-c-project-${crypto.randomUUID()}`;
  await prisma.project.create({ data: { id, name: "Checkpoint 1C-C", description: "Initial AI Requirements", userId: ownerId } });
  if (member) await prisma.projectMember.create({ data: { projectId: id, userId: memberId } });
  projectIds.push(id);
  return id;
}

function service(
  gateway: Pick<LLMGateway, "callStructured">,
  artifacts?: PlanningArtifactService,
  runService?: PlanningRequirementsRunService,
): PlanningGenerationService {
  const authorization = new PlanningAuthorizationService(prisma);
  const artifactService = artifacts ?? new PlanningArtifactService(prisma, authorization);
  const readiness = new PlanningReadinessService();
  const runs = runService ?? new PlanningRequirementsRunService(prisma, authorization, undefined, artifactService, readiness);
  return new PlanningGenerationService(prisma, {
    authorization,
    artifacts: artifactService,
    readiness,
    runs,
    gateway,
  });
}

describeIsolated("Checkpoint 1C-C initial Requirements generation", () => {
  beforeAll(async () => {
    await prisma.user.createMany({ data: [
      { id: ownerId, email: `${ownerId}@anka.test`, password: "unused", role: "user" },
      { id: memberId, email: `${memberId}@anka.test`, password: "unused", role: "user" },
    ] });
  });

  afterAll(async () => {
    for (const id of projectIds.reverse()) await prisma.project.delete({ where: { id } });
    await prisma.user.deleteMany({ where: { id: { in: [ownerId, memberId] } } });
    await prisma.$disconnect();
  });

  test("creates and links immutable AI v1, stores provider audit, and preserves blocked draft readiness", async () => {
    const projectId = await createProject();
    const gateway = new FakeRequirementsGateway(requirements("generated draft", true), {
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      beforeReturn: async () => {
        const run = await prisma.workflowRun.findFirstOrThrow({ where: { projectId } });
        const state = await prisma.projectPhaseState.findUniqueOrThrow({
          where: { projectId_phase: { projectId, phase: "requirements" } },
        });
        expect(run.status).toBe("running");
        expect(state.activeRunId).toBe(run.id);
        expect(state.currentArtifactId).toBeNull();
      },
    });

    const result = await service(gateway).generateInitialRequirements({
      projectId,
      actorId: ownerId,
      idempotencyKey: "success",
      brief: "Build the initial product requirements.",
    });

    expect(result).toMatchObject({ reused: false, httpStatus: 201, readiness: { ready: false } });
    expect(result.artifact).toMatchObject({
      title: "Requirements v1",
      version: 1,
      createdByType: "AI",
      changeKind: "INITIAL_GENERATION",
      approved: false,
      lifecycleStatus: "DRAFT",
    });
    expect(result.run).toMatchObject({ status: "completed", outputArtifactId: result.artifact?.id });
    expect(result.readiness?.blockers.map((blocker) => blocker.code)).toContain("REQUIREMENTS_UNRESOLVED_QUESTIONS");
    expect(result.artifact?.structuredContent).toMatchObject({ unresolvedQuestions: [{ id: "UQ-001" }] });
    const usage = result.run.modelUsage as Record<string, unknown>;
    expect(usage).toMatchObject({
      provider: "openai",
      model: "gpt-4o",
      usageSource: "provider",
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      attemptCount: 1,
    });
    expect(usage.providerResponseId).toMatch(/^chatcmpl-/);
    expect(result.run.costUSD).toBeCloseTo(0.00075);
    await expect(prisma.projectPhaseState.findUniqueOrThrow({
      where: { projectId_phase: { projectId, phase: "requirements" } },
    })).resolves.toMatchObject({
      activeRunId: null,
      currentArtifactId: result.artifact?.id,
      approvalCandidateArtifactId: null,
      currentApprovedArtifactId: null,
    });
    expect(await prisma.phaseArtifact.count({ where: { projectId, phase: "documentation" } })).toBe(0);
  });

  test("completed replay returns the stored artifact without another gateway call", async () => {
    const projectId = await createProject();
    const gateway = new FakeRequirementsGateway(requirements("replay"), {
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    });
    const generation = service(gateway);
    const input = { projectId, actorId: ownerId, idempotencyKey: "replay", brief: "Replay exactly." };
    const first = await generation.generateInitialRequirements(input);
    const replay = await generation.generateInitialRequirements(input);
    expect(replay).toMatchObject({ reused: true, httpStatus: 200, artifact: { id: first.artifact?.id } });
    expect(gateway.calls).toBe(1);
  });

  test("missing provider usage stays null and an unknown model is not priced", async () => {
    const projectId = await createProject();
    const gateway = new FakeRequirementsGateway(requirements("no usage"), { model: "future-model" });
    const result = await service(gateway).generateInitialRequirements({
      projectId,
      actorId: ownerId,
      idempotencyKey: "missing-usage",
      brief: "Do not fabricate usage.",
    });
    expect(result.run.costUSD).toBeNull();
    expect(result.run.modelUsage).toMatchObject({
      model: "future-model",
      usageSource: "unavailable",
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
    });
  });

  test("aggregates authoritative usage and cost across both structured-generation attempts", async () => {
    const projectId = await createProject();
    const gateway = new FakeRequirementsGateway(requirements("repaired"), {
      providerAttempts: [
        {
          attemptNumber: 1,
          kind: "initial",
          providerResponseId: "chatcmpl-invalid",
          providerRequestId: "req-invalid",
          model: "gpt-4o",
          finishReason: "stop",
          promptTokens: 1_000,
          completionTokens: 500,
          totalTokens: 1_500,
          usageSource: "provider",
          latencyMs: 10,
        },
        {
          attemptNumber: 2,
          kind: "structured_repair",
          providerResponseId: "chatcmpl-valid",
          providerRequestId: "req-valid",
          model: "gpt-4o",
          finishReason: "stop",
          promptTokens: 1_100,
          completionTokens: 600,
          totalTokens: 1_700,
          usageSource: "provider",
          latencyMs: 12,
        },
      ],
    });
    const result = await service(gateway).generateInitialRequirements({
      projectId,
      actorId: ownerId,
      idempotencyKey: "repair-audit",
      brief: "Repair invalid structured output once.",
    });
    const usage = result.run.modelUsage as Record<string, unknown>;
    expect(usage).toMatchObject({
      attemptCount: 2,
      promptTokens: 2_100,
      completionTokens: 1_100,
      totalTokens: 3_200,
      usageSource: "provider",
      providerResponseId: "chatcmpl-valid",
      providerRequestId: "req-valid",
      aggregate: {
        providerRequestCount: 2,
        providerUsageAttemptCount: 2,
        promptTokens: 2_100,
        completionTokens: 1_100,
        totalTokens: 3_200,
        usageSource: "provider",
      },
    });
    expect(usage.attempts).toEqual([
      expect.objectContaining({ providerResponseId: "chatcmpl-invalid", providerRequestId: "req-invalid" }),
      expect.objectContaining({ providerResponseId: "chatcmpl-valid", providerRequestId: "req-valid" }),
    ]);
    expect(result.run.costUSD).toBeCloseTo(0.01625);
  });

  test("marks aggregate usage partial and leaves cost null when one provider attempt lacks usage", async () => {
    const projectId = await createProject();
    const gateway = new FakeRequirementsGateway(requirements("partial usage"), {
      providerAttempts: [
        {
          attemptNumber: 1,
          kind: "initial",
          providerResponseId: "chatcmpl-no-usage",
          providerRequestId: null,
          model: "gpt-4o",
          finishReason: "stop",
          promptTokens: null,
          completionTokens: null,
          totalTokens: null,
          usageSource: "unavailable",
          latencyMs: 8,
        },
        {
          attemptNumber: 2,
          kind: "structured_repair",
          providerResponseId: "chatcmpl-with-usage",
          providerRequestId: "req-with-usage",
          model: "gpt-4o",
          finishReason: "stop",
          promptTokens: 110,
          completionTokens: 60,
          totalTokens: 170,
          usageSource: "provider",
          latencyMs: 12,
        },
      ],
    });
    const result = await service(gateway).generateInitialRequirements({
      projectId,
      actorId: ownerId,
      idempotencyKey: "partial-audit",
      brief: "Do not fabricate missing usage.",
    });
    expect(result.run.modelUsage).toMatchObject({
      usageSource: "partial_provider",
      promptTokens: 110,
      completionTokens: 60,
      totalTokens: 170,
      providerUsageAttemptCount: 1,
    });
    expect(result.run.costUSD).toBeNull();
  });

  test("does not apply fallback pricing to an unknown model with real provider usage", async () => {
    const projectId = await createProject();
    const result = await service(new FakeRequirementsGateway(requirements("unknown price"), {
      model: "future-model",
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    })).generateInitialRequirements({
      projectId,
      actorId: ownerId,
      idempotencyKey: "unknown-price",
      brief: "Use the configured model.",
    });
    expect(result.run.modelUsage).toMatchObject({ model: "future-model", usageSource: "provider" });
    expect(result.run.costUSD).toBeNull();
  });

  test("normalizes an unexpected Transaction A failure before any gateway call or state mutation", async () => {
    const projectId = await createProject();
    const gateway = new FakeRequirementsGateway(requirements("never called"));
    const runs = new TransactionAFailureRunService(prisma);
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(service(gateway, undefined, runs).generateInitialRequirements({
        projectId,
        actorId: ownerId,
        idempotencyKey: "transaction-a-failure",
        brief: "Valid request whose run start fails.",
      })).rejects.toMatchObject({
        code: "PLANNING_PERSISTENCE_FAILED",
        httpStatus: 503,
        message: "Planning state could not be persisted. Please retry.",
      });
      expect(errorSpy).toHaveBeenCalledWith(
        "Failed to initialize Requirements generation state",
        expect.objectContaining({ projectId }),
      );
    } finally {
      errorSpy.mockRestore();
    }
    expect(gateway.calls).toBe(0);
    expect(await prisma.phaseArtifact.count({ where: { projectId } })).toBe(0);
    expect(await prisma.projectPhaseState.findUnique({
      where: { projectId_phase: { projectId, phase: "requirements" } },
    })).toBeNull();
    expect(await prisma.workflowRun.count({ where: { projectId } })).toBe(0);
  });

  test("persists both real provider attempts when structured repair also fails", async () => {
    const projectId = await createProject();
    const firstRaw = JSON.stringify({ projectGoal: "RAW_INVALID_ATTEMPT_ONE_MUST_NOT_PERSIST" });
    const secondRaw = JSON.stringify({ projectGoal: "RAW_INVALID_ATTEMPT_TWO_MUST_NOT_PERSIST" });
    const { gateway, create } = gatewayWithResponses([
      gatewayResponse({
        content: firstRaw,
        id: "chatcmpl-failed-initial",
        requestId: "req-failed-initial",
        model: "gpt-4o",
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      }),
      gatewayResponse({
        content: secondRaw,
        id: "chatcmpl-failed-repair",
        requestId: "req-failed-repair",
        model: "gpt-4o",
        usage: { prompt_tokens: 110, completion_tokens: 60, total_tokens: 170 },
      }),
    ]);

    await expect(service(gateway).generateInitialRequirements({
      projectId,
      actorId: ownerId,
      idempotencyKey: "failed-structured-repair-audit",
      brief: "Generate Requirements whose provider fixtures remain invalid.",
    })).rejects.toMatchObject({ code: "PLANNING_AI_INVALID_RESPONSE" });

    expect(create).toHaveBeenCalledTimes(2);
    expect(await prisma.phaseArtifact.count({ where: { projectId } })).toBe(0);
    const state = await prisma.projectPhaseState.findUniqueOrThrow({
      where: { projectId_phase: { projectId, phase: "requirements" } },
    });
    expect(state).toMatchObject({
      activeRunId: null,
      currentArtifactId: null,
      approvalCandidateArtifactId: null,
      currentApprovedArtifactId: null,
    });
    const run = await prisma.workflowRun.findFirstOrThrow({ where: { projectId } });
    expect(run).toMatchObject({
      status: "failed",
      errorCode: "PLANNING_AI_INVALID_RESPONSE",
      outputArtifactId: null,
    });
    const usage = run.modelUsage as Record<string, unknown>;
    expect(usage).toMatchObject({
      attemptCount: 2,
      promptTokens: 210,
      completionTokens: 110,
      totalTokens: 320,
      usageSource: "provider",
      providerResponseId: "chatcmpl-failed-repair",
      providerRequestId: "req-failed-repair",
      aggregate: {
        providerRequestCount: 2,
        providerUsageAttemptCount: 2,
        promptTokens: 210,
        completionTokens: 110,
        totalTokens: 320,
        usageSource: "provider",
      },
    });
    expect(usage.attempts).toEqual([
      expect.objectContaining({
        attemptNumber: 1,
        kind: "initial",
        providerResponseId: "chatcmpl-failed-initial",
        providerRequestId: "req-failed-initial",
        model: "gpt-4o",
      }),
      expect.objectContaining({
        attemptNumber: 2,
        kind: "structured_repair",
        providerResponseId: "chatcmpl-failed-repair",
        providerRequestId: "req-failed-repair",
        model: "gpt-4o",
      }),
    ]);
    expect(run.costUSD).toBeCloseTo(0.001625);
    expect(JSON.stringify(run.modelUsage)).not.toContain("RAW_INVALID_ATTEMPT");
    expect(run.errorMessage ?? "").not.toContain("RAW_INVALID_ATTEMPT");
  });

  test("marks failed aggregate usage partial and leaves cost null when a repair has no usage", async () => {
    const projectId = await createProject();
    const { gateway } = gatewayWithResponses([
      gatewayResponse({
        content: JSON.stringify({ projectGoal: "invalid one" }),
        id: "chatcmpl-partial-initial",
        requestId: "req-partial-initial",
        model: "gpt-4o",
        usage: { prompt_tokens: 90, completion_tokens: 40, total_tokens: 130 },
      }),
      gatewayResponse({
        content: JSON.stringify({ projectGoal: "invalid two" }),
        id: "chatcmpl-partial-repair",
        requestId: "req-partial-repair",
        model: "gpt-4o",
      }),
    ]);

    await expect(service(gateway).generateInitialRequirements({
      projectId,
      actorId: ownerId,
      idempotencyKey: "failed-partial-audit",
      brief: "Preserve only authoritative failed-attempt usage.",
    })).rejects.toMatchObject({ code: "PLANNING_AI_INVALID_RESPONSE" });

    const run = await prisma.workflowRun.findFirstOrThrow({ where: { projectId } });
    expect(run.modelUsage).toMatchObject({
      attemptCount: 2,
      promptTokens: 90,
      completionTokens: 40,
      totalTokens: 130,
      usageSource: "partial_provider",
      aggregate: {
        providerRequestCount: 2,
        providerUsageAttemptCount: 1,
        promptTokens: 90,
        completionTokens: 40,
        totalTokens: 130,
        usageSource: "partial_provider",
      },
    });
    expect((run.modelUsage as Record<string, unknown>).attempts).toEqual([
      expect.objectContaining({ usageSource: "provider", promptTokens: 90, totalTokens: 130 }),
      expect.objectContaining({
        usageSource: "unavailable",
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
      }),
    ]);
    expect(run.costUSD).toBeNull();
  });

  test("does not apply fallback pricing to a failed attempt from an unknown model", async () => {
    const projectId = await createProject();
    const { gateway } = gatewayWithResponses([
      gatewayResponse({
        content: JSON.stringify({ projectGoal: "invalid one" }),
        id: "chatcmpl-known-model",
        requestId: "req-known-model",
        model: "gpt-4o",
        usage: { prompt_tokens: 90, completion_tokens: 40, total_tokens: 130 },
      }),
      gatewayResponse({
        content: JSON.stringify({ projectGoal: "invalid two" }),
        id: "chatcmpl-unknown-model",
        requestId: "req-unknown-model",
        model: "future-model",
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      }),
    ]);

    await expect(service(gateway).generateInitialRequirements({
      projectId,
      actorId: ownerId,
      idempotencyKey: "failed-unknown-model",
      brief: "Do not use fallback pricing.",
    })).rejects.toMatchObject({ code: "PLANNING_AI_INVALID_RESPONSE" });

    const run = await prisma.workflowRun.findFirstOrThrow({ where: { projectId } });
    expect(run.modelUsage).toMatchObject({ usageSource: "provider", attemptCount: 2 });
    expect(run.costUSD).toBeNull();
  });

  test("timeout fails the run, releases the lease, and terminal replay does not invoke the gateway", async () => {
    const projectId = await createProject();
    const gateway = new FakeRequirementsGateway(requirements("timeout"), {
      failure: new LLMTimeoutError("timed out"),
    });
    const generation = service(gateway);
    const input = { projectId, actorId: ownerId, idempotencyKey: "timeout", brief: "Provider timeout." };
    await expect(generation.generateInitialRequirements(input)).rejects.toMatchObject({ code: "PLANNING_AI_TIMEOUT" });
    await expect(generation.generateInitialRequirements(input)).rejects.toMatchObject({
      code: "PLANNING_AI_TIMEOUT",
      details: { reused: true },
    });
    expect(gateway.calls).toBe(1);
    await expect(prisma.projectPhaseState.findUniqueOrThrow({
      where: { projectId_phase: { projectId, phase: "requirements" } },
    })).resolves.toMatchObject({ activeRunId: null, currentArtifactId: null });
    await expect(prisma.workflowRun.findFirstOrThrow({ where: { projectId } })).resolves.toMatchObject({
      status: "failed",
      errorCode: "PLANNING_AI_TIMEOUT",
      outputArtifactId: null,
    });
  });

  test("manual v1 created during the call remains current and no AI artifact survives", async () => {
    const projectId = await createProject();
    const artifacts = new PlanningArtifactService(prisma);
    const gateway = new FakeRequirementsGateway(requirements("stale AI"), {
      beforeReturn: async () => {
        await artifacts.createInitialArtifact({
          projectId,
          actorId: ownerId,
          title: "Manual v1",
          structuredContent: requirements("manual"),
        });
      },
    });
    await expect(service(gateway, artifacts).generateInitialRequirements({
      projectId,
      actorId: ownerId,
      idempotencyKey: "manual-race",
      brief: "AI starts first.",
    })).rejects.toMatchObject({ code: "PLANNING_CONTEXT_CHANGED" });
    expect(await prisma.phaseArtifact.count({ where: { projectId } })).toBe(1);
    const manual = await prisma.phaseArtifact.findFirstOrThrow({ where: { projectId } });
    await expect(prisma.projectPhaseState.findUniqueOrThrow({
      where: { projectId_phase: { projectId, phase: "requirements" } },
    })).resolves.toMatchObject({ currentArtifactId: manual.id, activeRunId: null });
    await expect(prisma.workflowRun.findFirstOrThrow({ where: { projectId } })).resolves.toMatchObject({
      status: "conflicted",
      modelUsage: {
        attemptCount: 1,
        aggregate: { providerRequestCount: 1, usageSource: "unavailable" },
      },
    });
  });

  test("authorization removed during the call prevents persistence and releases the lease", async () => {
    const projectId = await createProject(true);
    const gateway = new FakeRequirementsGateway(requirements("permission race"), {
      beforeReturn: async () => {
        await prisma.projectMember.delete({ where: { projectId_userId: { projectId, userId: memberId } } });
      },
    });
    await expect(service(gateway).generateInitialRequirements({
      projectId,
      actorId: memberId,
      idempotencyKey: "permission-race",
      brief: "Member begins generation.",
    })).rejects.toMatchObject({ code: "PLANNING_PROJECT_NOT_FOUND" });
    expect(await prisma.phaseArtifact.count({ where: { projectId } })).toBe(0);
    await expect(prisma.workflowRun.findFirstOrThrow({ where: { projectId } })).resolves.toMatchObject({
      status: "cancelled",
      modelUsage: {
        attemptCount: 1,
        aggregate: { providerRequestCount: 1, usageSource: "unavailable" },
      },
    });
    await expect(prisma.projectPhaseState.findUniqueOrThrow({
      where: { projectId_phase: { projectId, phase: "requirements" } },
    })).resolves.toMatchObject({ activeRunId: null, currentArtifactId: null });
  });

  test("oversized canonical output creates no artifact and releases the lease", async () => {
    const projectId = await createProject();
    const content = requirements("oversized");
    content.projectGoal = "x".repeat(REQUIREMENTS_INPUT_LIMITS.canonicalArtifactJsonBytes + 1);
    await expect(service(new FakeRequirementsGateway(content)).generateInitialRequirements({
      projectId,
      actorId: ownerId,
      idempotencyKey: "oversized-output",
      brief: "Generate bounded output.",
    })).rejects.toMatchObject({ code: "PLANNING_AI_OUTPUT_TOO_LARGE" });
    expect(await prisma.phaseArtifact.count({ where: { projectId } })).toBe(0);
    await expect(prisma.projectPhaseState.findUniqueOrThrow({
      where: { projectId_phase: { projectId, phase: "requirements" } },
    })).resolves.toMatchObject({ activeRunId: null, currentArtifactId: null });
  });

  test("Transaction B rollback removes an inserted artifact and never completes the run", async () => {
    const projectId = await createProject();
    const authorization = new PlanningAuthorizationService(prisma);
    const rollbackArtifacts = new RollbackArtifactService(prisma, authorization);
    await expect(service(new FakeRequirementsGateway(requirements("rollback")), rollbackArtifacts)
      .generateInitialRequirements({
        projectId,
        actorId: ownerId,
        idempotencyKey: "rollback",
        brief: "Force Transaction B rollback.",
      })).rejects.toMatchObject({ code: "PLANNING_PERSISTENCE_FAILED" });
    expect(await prisma.phaseArtifact.count({ where: { projectId } })).toBe(0);
    await expect(prisma.projectPhaseState.findUniqueOrThrow({
      where: { projectId_phase: { projectId, phase: "requirements" } },
    })).resolves.toMatchObject({
      activeRunId: null,
      currentArtifactId: null,
      approvalCandidateArtifactId: null,
      currentApprovedArtifactId: null,
    });
    await expect(prisma.workflowRun.findFirstOrThrow({ where: { projectId } })).resolves.toMatchObject({
      status: "failed",
      outputArtifactId: null,
    });
  });
});
