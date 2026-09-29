import crypto from "crypto";
import OpenAI from "openai";
import {
  ArtifactActorType,
  ArtifactChangeKind,
  PrismaClient,
  WorkflowOperation,
} from "@prisma/client";
import {
  LLMCallResult,
  LLMGateway,
  LLMStructuredCallOptions,
} from "../../ai/gateway/LLMGateway";
import { PipelineStages } from "../../ai/gateway/PipelineStage";
import { RequirementsContent } from "../../planning/requirements-schema";
import { PlanningApprovalService } from "../planning-approval.service";
import { PlanningArtifactService } from "../planning-artifact.service";
import { PlanningAuthorizationService } from "../planning-authorization.service";
import { PlanningGenerationService } from "../planning-generation.service";
import { PlanningReadinessService } from "../planning-readiness.service";
import { PlanningRequirementsRunService } from "../planning-requirements-run.service";

const databaseUrl = process.env.DATABASE_URL;
const isolatedSchema = databaseUrl ? new URL(databaseUrl).searchParams.get("schema") : null;
const describeIsolated = isolatedSchema?.startsWith("planning_checkpoint_1c_d2_") ? describe : describe.skip;

const prisma = new PrismaClient();
const ownerId = `checkpoint-1c-d2-owner-${crypto.randomUUID()}`;
const projectIds: string[] = [];

function requirements(label = "base"): RequirementsContent {
  return {
    projectGoal: `Goal ${label}`,
    problemStatement: `Problem ${label}`,
    usersAndActors: [{ id: "ACTOR-001", name: "Owner", description: "Owns planning." }],
    userStories: [{
      id: "US-001",
      actor: "Owner",
      capability: "manage requirements",
      benefit: "scope is explicit",
      acceptanceCriteriaIds: ["AC-001"],
    }],
    functionalRequirements: [{ id: "FR-001", title: "Manage", description: "Manage requirements." }],
    nonFunctionalRequirements: [{ id: "NFR-001", title: "Audit", description: "Retain provenance." }],
    constraints: [{ id: "CON-001", description: "No downstream generation." }],
    integrations: [{ id: "INT-001", name: "Provider", description: "Structured output.", required: true }],
    assumptions: [{ id: "ASM-001", description: "One active run." }],
    acceptanceCriteria: [{ id: "AC-001", description: "Requirements are managed.", relatedRequirementIds: ["FR-001"] }],
    outOfScope: [{ id: "OOS-001", description: "Architecture generation." }],
    unresolvedQuestions: [{ id: "UQ-001", question: "Which export format?" }],
  };
}

function completion(content: RequirementsContent): LLMCallResult<RequirementsContent> {
  const rawResponse: OpenAI.Chat.Completions.ChatCompletion = {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: 0,
    model: "gpt-4o",
    choices: [{
      index: 0,
      logprobs: null,
      finish_reason: "stop",
      message: { role: "assistant", content: JSON.stringify(content), refusal: null },
    }],
    usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 },
  };
  return {
    content,
    rawResponse,
    finishReason: "stop",
    usage: { promptTokens: 20, completionTokens: 30, totalTokens: 50 },
    latencyMs: 5,
    model: "gpt-4o",
    stage: PipelineStages.ROADMAP_PLANNING,
    attemptCount: 1,
  };
}

class CapturingGateway {
  calls = 0;
  lastOptions: LLMStructuredCallOptions<RequirementsContent> | null = null;

  constructor(
    private readonly output: RequirementsContent | (() => RequirementsContent),
    private readonly beforeReturn?: () => Promise<void>,
  ) {}

  async callStructured<T>(options: LLMStructuredCallOptions<T>): Promise<LLMCallResult<T>> {
    this.calls += 1;
    this.lastOptions = options as unknown as LLMStructuredCallOptions<RequirementsContent>;
    await this.beforeReturn?.();
    const output = typeof this.output === "function" ? this.output() : this.output;
    const validation = options.schema.validate(output);
    if (!validation.valid || validation.data === undefined) throw new Error(validation.errors?.join("; ") || "invalid output");
    return completion(validation.data as unknown as RequirementsContent) as unknown as LLMCallResult<T>;
  }
}

class OpenAIBackedGateway extends LLMGateway {
  constructor(private readonly client: OpenAI) {
    super();
  }

  override callStructured<T>(options: LLMStructuredCallOptions<T>): Promise<LLMCallResult<T>> {
    return super.callStructured({ ...options, openaiClient: this.client, retryDelayMs: 0 });
  }
}

function queuedGateway(contents: string[]): { gateway: OpenAIBackedGateway; create: jest.Mock } {
  const create = jest.fn();
  contents.forEach((content, index) => create.mockResolvedValueOnce({
    id: `response-${index + 1}`,
    object: "chat.completion",
    created: 0,
    model: "gpt-4o",
    choices: [{
      index: 0,
      logprobs: null,
      finish_reason: "stop",
      message: { role: "assistant", content, refusal: null },
    }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    _request_id: `request-${index + 1}`,
  }));
  const client = { chat: { completions: { create } } } as unknown as OpenAI;
  return { gateway: new OpenAIBackedGateway(client), create };
}

function services(gateway: Pick<LLMGateway, "callStructured">) {
  const authorization = new PlanningAuthorizationService(prisma);
  const artifacts = new PlanningArtifactService(prisma, authorization);
  const readiness = new PlanningReadinessService();
  const runs = new PlanningRequirementsRunService(prisma, authorization, undefined, artifacts, readiness);
  const approvals = new PlanningApprovalService(prisma, authorization, undefined, readiness);
  const generation = new PlanningGenerationService(prisma, { authorization, artifacts, readiness, runs, gateway });
  return { artifacts, runs, approvals, generation };
}

async function createProject(): Promise<string> {
  const id = `checkpoint-1c-d2-project-${crypto.randomUUID()}`;
  await prisma.project.create({ data: { id, name: "Checkpoint 1C-D2", description: "Section revisions", userId: ownerId } });
  projectIds.push(id);
  return id;
}

async function seedV1(projectId: string, content = requirements()) {
  return services(new CapturingGateway(content)).artifacts.createInitialArtifact({
    projectId,
    actorId: ownerId,
    title: "Requirements v1",
    structuredContent: content,
    createdByType: ArtifactActorType.HUMAN,
    changeKind: ArtifactChangeKind.MANUAL_EDIT,
  });
}

describeIsolated("Checkpoint 1C-D2 section Requirements revision and regeneration", () => {
  beforeAll(async () => {
    await prisma.user.create({
      data: { id: ownerId, email: `${ownerId}@anka.test`, password: "unused", role: "user" },
    });
  });

  afterAll(async () => {
    for (const id of projectIds.reverse()) await prisma.project.delete({ where: { id } }).catch(() => undefined);
    await prisma.user.delete({ where: { id: ownerId } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  test("SECTION_REVISION permits target plus deterministic dependencies and binds authority end to end", async () => {
    const projectId = await createProject();
    const base = await seedV1(projectId);
    const output = requirements();
    output.functionalRequirements[0].description = "Manage and export requirements.";
    output.acceptanceCriteria[0].description = "Requirements can be managed and exported.";
    output.userStories[0].benefit = "scope is explicit and exportable";
    const gateway = new CapturingGateway(output);
    const { generation } = services(gateway);

    const result = await generation.reviseRequirements({
      projectId, actorId: ownerId, baseArtifactId: base.id, idempotencyKey: "section-revision-success",
      operation: "SECTION_REVISION", targetSectionKey: "functionalRequirements", instruction: "Add export behavior.",
    });

    expect(result.httpStatus).toBe(201);
    expect(result.artifact).toMatchObject({
      version: 2,
      previousVersionId: base.id,
      basedOnArtifactId: base.id,
      changeKind: ArtifactChangeKind.AI_SECTION_REVISION,
      lifecycleStatus: "DRAFT",
      approved: false,
    });
    expect(result.diff?.changedRootSections).toEqual(["userStories", "functionalRequirements", "acceptanceCriteria"]);
    expect(result.diff?.modifiedIds).toEqual(["AC-001", "FR-001", "US-001"]);
    expect(result.run).toMatchObject({ targetSectionKey: "functionalRequirements", status: "completed" });
    expect(result.run.contextManifest).toMatchObject({
      operation: "SECTION_REVISION",
      targetSectionKey: "functionalRequirements",
      allowedSectionKeys: ["functionalRequirements", "acceptanceCriteria", "userStories"],
      promptVersion: "requirements-section-revision-v2",
    });
    expect(result.run.modelUsage).toMatchObject({ promptVersion: "requirements-section-revision-v2" });
    expect(gateway.lastOptions?.structuredRepair?.instructions).toContain("Target section: functionalRequirements");
    expect(JSON.stringify(gateway.lastOptions?.messages)).toContain("Cross-root reclassification is forbidden");
  });

  test("SECTION_REGENERATION remains distinct and permits genuine additions/removals in the target", async () => {
    const projectId = await createProject();
    const base = await seedV1(projectId);
    const output = requirements();
    output.constraints = [{ id: "CON-002", description: "Exports must be deterministic." }];
    const gateway = new CapturingGateway(output);
    const result = await services(gateway).generation.reviseRequirements({
      projectId, actorId: ownerId, baseArtifactId: base.id, idempotencyKey: "section-regeneration-success",
      operation: "SECTION_REGENERATION", targetSectionKey: "constraints", instruction: "Rebuild constraints.",
    });

    expect(result.artifact?.changeKind).toBe(ArtifactChangeKind.AI_SECTION_REGENERATION);
    expect(result.diff).toMatchObject({ changedRootSections: ["constraints"], addedIds: ["CON-002"], removedIds: ["CON-001"] });
    expect(result.run.modelUsage).toMatchObject({ promptVersion: "requirements-section-regeneration-v2" });
    expect(JSON.stringify(gateway.lastOptions?.messages)).toContain("Rebuild the target section");
  });

  test("a valid section successor persists even when deterministic readiness is false", async () => {
    const projectId = await createProject();
    const base = await seedV1(projectId);
    const output = requirements();
    output.functionalRequirements.push({
      id: "FR-002",
      title: "Export",
      description: "Export the Requirements artifact.",
    });
    const result = await services(new CapturingGateway(output)).generation.reviseRequirements({
      projectId, actorId: ownerId, baseArtifactId: base.id, idempotencyKey: "not-ready-successor",
      operation: "SECTION_REVISION", targetSectionKey: "functionalRequirements", instruction: "Add export.",
    });
    expect(result.httpStatus).toBe(201);
    expect(result.readiness).toMatchObject({
      ready: false,
      blockers: expect.arrayContaining([
        expect.objectContaining({ code: "REQUIREMENTS_FUNCTIONAL_REQUIREMENT_UNCOVERED", itemIds: ["FR-002"] }),
      ]),
    });
    expect(result.artifact).toMatchObject({ lifecycleStatus: "DRAFT", approved: false });
    expect(await prisma.phaseApproval.count({ where: { projectId } })).toBe(0);
  });

  test.each([
    ["projectGoal", (content: RequirementsContent) => { content.projectGoal = "Revised goal"; }],
    ["constraints", (content: RequirementsContent) => { content.constraints[0].description = "Revised constraint"; }],
    ["unresolvedQuestions", (content: RequirementsContent) => { content.unresolvedQuestions[0].question = "Revised question?"; }],
  ] as const)("permits target-only change for %s", async (targetSectionKey, mutate) => {
    const projectId = await createProject();
    const base = await seedV1(projectId);
    const output = requirements();
    mutate(output);
    const result = await services(new CapturingGateway(output)).generation.reviseRequirements({
      projectId, actorId: ownerId, baseArtifactId: base.id, idempotencyKey: `target-${targetSectionKey}`,
      operation: "SECTION_REVISION", targetSectionKey, instruction: "Revise target.",
    });
    expect(result.diff?.changedRootSections).toEqual([targetSectionKey]);
  });

  test.each([
    ["usersAndActors", ["usersAndActors", "userStories"] as const, (content: RequirementsContent) => {
      content.usersAndActors[0].description = "Owns and reviews planning.";
      content.userStories[0].actor = "Product Owner";
    }],
    ["acceptanceCriteria", ["userStories", "acceptanceCriteria"] as const, (content: RequirementsContent) => {
      content.userStories[0].benefit = "acceptance is traceable";
      content.acceptanceCriteria[0].description = "Requirements are traceably managed.";
    }],
  ] as const)("permits asymmetric dependency closure for %s", async (targetSectionKey, changed, mutate) => {
    const projectId = await createProject();
    const base = await seedV1(projectId);
    const output = requirements();
    mutate(output);
    const result = await services(new CapturingGateway(output)).generation.reviseRequirements({
      projectId, actorId: ownerId, baseArtifactId: base.id, idempotencyKey: `closure-${targetSectionKey}`,
      operation: "SECTION_REVISION", targetSectionKey, instruction: "Revise target and dependents.",
    });
    expect(result.diff?.changedRootSections).toEqual(changed);
  });

  test("forbidden unrelated root change fails terminally, retains audit, clears lease, creates no artifact, and replays without provider", async () => {
    const projectId = await createProject();
    const base = await seedV1(projectId);
    const output = requirements();
    output.constraints[0].description = "Allowed constraint change.";
    output.projectGoal = "Forbidden unrelated goal change.";
    const gateway = new CapturingGateway(output);
    const { generation } = services(gateway);
    const input = {
      projectId, actorId: ownerId, baseArtifactId: base.id, idempotencyKey: "scope-failure",
      operation: "SECTION_REVISION" as const, targetSectionKey: "constraints", instruction: "Revise constraints.",
    };

    await expect(generation.reviseRequirements(input)).rejects.toMatchObject({
      code: "PLANNING_SECTION_SCOPE_VIOLATION",
      httpStatus: 422,
      details: {
        targetSectionKey: "constraints",
        allowedSections: ["constraints"],
        changedSections: ["projectGoal", "constraints"],
      },
    });
    const run = await prisma.workflowRun.findFirstOrThrow({ where: { projectId, idempotencyKey: { not: null } } });
    expect(run).toMatchObject({ status: "failed", errorCode: "PLANNING_SECTION_SCOPE_VIOLATION" });
    expect(run.modelUsage).toMatchObject({ promptVersion: "requirements-section-revision-v2" });
    await expect(prisma.projectPhaseState.findUniqueOrThrow({
      where: { projectId_phase: { projectId, phase: "requirements" } },
    })).resolves.toMatchObject({ activeRunId: null, currentArtifactId: base.id });
    expect(await prisma.phaseArtifact.count({ where: { projectId } })).toBe(1);
    await expect(generation.reviseRequirements(input)).rejects.toMatchObject({
      code: "PLANNING_SECTION_SCOPE_VIOLATION", httpStatus: 422, details: { reused: true },
    });
    expect(gateway.calls).toBe(1);
  });

  test("structured repair remains section-bound and cannot escape the dependency closure", async () => {
    const projectId = await createProject();
    const base = await seedV1(projectId);
    const repaired = requirements();
    repaired.constraints[0].description = "Allowed repaired constraint.";
    repaired.projectGoal = "Forbidden repaired goal.";
    const { gateway, create } = queuedGateway(["{ broken json", JSON.stringify(repaired)]);

    await expect(services(gateway).generation.reviseRequirements({
      projectId, actorId: ownerId, baseArtifactId: base.id, idempotencyKey: "repair-scope",
      operation: "SECTION_REVISION", targetSectionKey: "constraints", instruction: "Repair constraints.",
    })).rejects.toMatchObject({ code: "PLANNING_SECTION_SCOPE_VIOLATION", httpStatus: 422 });

    expect(create).toHaveBeenCalledTimes(2);
    const repairRequest = create.mock.calls[1][0] as { messages: Array<{ content?: string }> };
    expect(JSON.stringify(repairRequest.messages)).toContain("Target section: constraints");
    const run = await prisma.workflowRun.findFirstOrThrow({ where: { projectId } });
    const usage = run.modelUsage as Record<string, unknown>;
    expect(run).toMatchObject({ status: "failed", errorCode: "PLANNING_SECTION_SCOPE_VIOLATION" });
    expect(usage).toMatchObject({ attemptCount: 2, promptVersion: "requirements-section-revision-v2" });
    expect(await prisma.phaseArtifact.count({ where: { projectId } })).toBe(1);
  });

  test("cross-root reclassification and moving an existing ID are rejected", async () => {
    const projectId = await createProject();
    const base = await seedV1(projectId);
    const output = requirements();
    output.constraints = [];
    output.assumptions.push({ id: "CON-001", description: "No downstream generation." });

    await expect(services(new CapturingGateway(output)).generation.reviseRequirements({
      projectId, actorId: ownerId, baseArtifactId: base.id, idempotencyKey: "reclassification",
      operation: "SECTION_REGENERATION", targetSectionKey: "constraints", instruction: "Rebuild constraints.",
    })).rejects.toMatchObject({ code: "PLANNING_SECTION_SCOPE_VIOLATION", httpStatus: 422 });
    expect(await prisma.phaseArtifact.count({ where: { projectId } })).toBe(1);
  });

  test("partial section output is rejected after bounded repair and creates no successor", async () => {
    const projectId = await createProject();
    const base = await seedV1(projectId);
    const partial = JSON.stringify({ projectGoal: "Only one field" });
    const { gateway, create } = queuedGateway([partial, partial]);

    await expect(services(gateway).generation.reviseRequirements({
      projectId, actorId: ownerId, baseArtifactId: base.id, idempotencyKey: "partial-output",
      operation: "SECTION_REGENERATION", targetSectionKey: "projectGoal", instruction: "Regenerate the goal.",
    })).rejects.toMatchObject({ code: "PLANNING_AI_INVALID_RESPONSE", httpStatus: 502 });
    expect(create).toHaveBeenCalledTimes(2);
    const run = await prisma.workflowRun.findFirstOrThrow({ where: { projectId } });
    expect(run).toMatchObject({ status: "failed", errorCode: "PLANNING_AI_INVALID_RESPONSE" });
    expect(await prisma.phaseArtifact.count({ where: { projectId } })).toBe(1);
  });

  test.each(["SECTION_REVISION", "SECTION_REGENERATION"] as const)("%s no-op fails, retains audit, and releases lease", async (operation) => {
    const projectId = await createProject();
    const base = await seedV1(projectId);
    const gateway = new CapturingGateway(requirements());
    await expect(services(gateway).generation.reviseRequirements({
      projectId, actorId: ownerId, baseArtifactId: base.id, idempotencyKey: `noop-${operation}`,
      operation, targetSectionKey: "constraints", instruction: "Return no changes.",
    })).rejects.toMatchObject({ code: "PLANNING_REVISION_NO_CHANGES", httpStatus: 422 });
    const run = await prisma.workflowRun.findFirstOrThrow({ where: { projectId } });
    expect(run).toMatchObject({ status: "failed", errorCode: "PLANNING_REVISION_NO_CHANGES" });
    expect(run.modelUsage).not.toBeNull();
    await expect(prisma.projectPhaseState.findUniqueOrThrow({
      where: { projectId_phase: { projectId, phase: "requirements" } },
    })).resolves.toMatchObject({ activeRunId: null, currentArtifactId: base.id });
  });

  test("direct run-service callers cannot bypass target validation and invalid requests create no run", async () => {
    const projectId = await createProject();
    const base = await seedV1(projectId);
    const { runs } = services(new CapturingGateway(requirements()));
    const invalid = [
      { operation: WorkflowOperation.SECTION_REVISION, targetSectionKey: undefined },
      { operation: WorkflowOperation.SECTION_REGENERATION, targetSectionKey: null },
      { operation: WorkflowOperation.SECTION_REVISION, targetSectionKey: "   " },
      { operation: WorkflowOperation.SECTION_REVISION, targetSectionKey: "unknown" },
      { operation: WorkflowOperation.DOCUMENT_REVISION, targetSectionKey: "constraints" },
      { operation: WorkflowOperation.FEEDBACK_APPLICATION, targetSectionKey: "constraints" },
    ];
    for (const [index, item] of invalid.entries()) {
      await expect(runs.startRequirementsRun({
        projectId, actorId: ownerId, baseArtifactId: base.id, idempotencyKey: `invalid-${index}`,
        operation: item.operation, targetSectionKey: item.targetSectionKey, instruction: "Instruction.",
      })).rejects.toMatchObject({ code: "PLANNING_INVALID_SECTION", httpStatus: 422 });
    }
    expect(await prisma.workflowRun.count({ where: { projectId } })).toBe(0);
  });

  test("idempotency binds target and operation while identical replay returns deterministic diff without another provider call", async () => {
    const projectId = await createProject();
    const base = await seedV1(projectId);
    const output = requirements();
    output.constraints[0].description = "Updated once.";
    const gateway = new CapturingGateway(output);
    const { generation } = services(gateway);
    const input = {
      projectId, actorId: ownerId, baseArtifactId: base.id, idempotencyKey: "target-fingerprint",
      operation: "SECTION_REVISION" as const, targetSectionKey: "constraints", instruction: "Update once.",
    };
    const created = await generation.reviseRequirements(input);
    const replay = await generation.reviseRequirements(input);
    expect(replay).toMatchObject({ httpStatus: 200, reused: true, artifact: { id: created.artifact?.id } });
    expect(replay.diff).toEqual(created.diff);
    expect(gateway.calls).toBe(1);

    await expect(generation.reviseRequirements({ ...input, targetSectionKey: "assumptions" })).rejects.toMatchObject({
      code: "PLANNING_IDEMPOTENCY_CONFLICT", httpStatus: 409,
    });
    await expect(generation.reviseRequirements({ ...input, operation: "SECTION_REGENERATION" })).rejects.toMatchObject({
      code: "PLANNING_IDEMPOTENCY_CONFLICT", httpStatus: 409,
    });
    await expect(generation.reviseRequirements({
      ...input, operation: "DOCUMENT_REVISION", targetSectionKey: null,
    })).rejects.toMatchObject({ code: "PLANNING_IDEMPOTENCY_CONFLICT", httpStatus: 409 });
    expect(gateway.calls).toBe(1);
  });

  test("two section starts preserve one lease owner and identical same-key replay", async () => {
    const projectId = await createProject();
    const base = await seedV1(projectId);
    const { runs } = services(new CapturingGateway(requirements()));
    const first = await runs.startRequirementsRun({
      projectId, actorId: ownerId, baseArtifactId: base.id, idempotencyKey: "lease-owner",
      operation: WorkflowOperation.SECTION_REVISION, targetSectionKey: "constraints", instruction: "Revise.",
    });
    const replay = await runs.startRequirementsRun({
      projectId, actorId: ownerId, baseArtifactId: base.id, idempotencyKey: "lease-owner",
      operation: WorkflowOperation.SECTION_REVISION, targetSectionKey: "constraints", instruction: "Revise.",
    });
    expect(replay).toMatchObject({ reused: true, run: { id: first.run.id } });
    await expect(runs.startRequirementsRun({
      projectId, actorId: ownerId, baseArtifactId: base.id, idempotencyKey: "lease-contender",
      operation: WorkflowOperation.SECTION_REGENERATION, targetSectionKey: "constraints", instruction: "Regenerate.",
    })).rejects.toMatchObject({ code: "PLANNING_GENERATION_IN_PROGRESS", httpStatus: 409 });
    await runs.cancelRequirementsRun(projectId, first.run.id, {
      code: "PLANNING_AUTHORIZATION_CHANGED", message: "Test cleanup cancellation.",
    });
  });

  test("human successor race preserves the human artifact and terminalizes the section run with audit", async () => {
    const projectId = await createProject();
    const base = await seedV1(projectId);
    const output = requirements();
    output.constraints[0].description = "AI change.";
    const { artifacts } = services(new CapturingGateway(output));
    let humanId = "";
    const gateway = new CapturingGateway(output, async () => {
      const human = await artifacts.createManualRevision({
        projectId, actorId: ownerId, baseArtifactId: base.id, baseContentHash: base.contentHash!,
        title: "Human v2", structuredContent: requirements("human"),
      });
      humanId = human.id;
    });
    await expect(services(gateway).generation.reviseRequirements({
      projectId, actorId: ownerId, baseArtifactId: base.id, idempotencyKey: "human-race",
      operation: "SECTION_REVISION", targetSectionKey: "constraints", instruction: "AI change.",
    })).rejects.toMatchObject({ code: "PLANNING_CONTEXT_CHANGED", httpStatus: 409 });
    await expect(prisma.projectPhaseState.findUniqueOrThrow({
      where: { projectId_phase: { projectId, phase: "requirements" } },
    })).resolves.toMatchObject({ currentArtifactId: humanId, activeRunId: null });
    const run = await prisma.workflowRun.findFirstOrThrow({ where: { projectId } });
    expect(run).toMatchObject({ status: "conflicted" });
    expect(run.modelUsage).not.toBeNull();
    expect(await prisma.phaseArtifact.count({ where: { projectId } })).toBe(2);
  });

  test("approval race preserves approval candidate and prevents a section successor", async () => {
    const projectId = await createProject();
    const readyBase = requirements();
    readyBase.unresolvedQuestions = [];
    const base = await seedV1(projectId, readyBase);
    const output = structuredClone(readyBase);
    output.constraints[0].description = "AI change.";
    const { approvals } = services(new CapturingGateway(output));
    const gateway = new CapturingGateway(output, async () => {
      await approvals.requestApproval({
        projectId, phase: "requirements", artifactId: base.id, expectedHash: base.contentHash!, actorId: ownerId,
      });
    });
    await expect(services(gateway).generation.reviseRequirements({
      projectId, actorId: ownerId, baseArtifactId: base.id, idempotencyKey: "approval-race",
      operation: "SECTION_REVISION", targetSectionKey: "constraints", instruction: "AI change.",
    })).rejects.toMatchObject({ code: "PLANNING_CONTEXT_CHANGED", httpStatus: 409 });
    await expect(prisma.projectPhaseState.findUniqueOrThrow({
      where: { projectId_phase: { projectId, phase: "requirements" } },
    })).resolves.toMatchObject({
      status: "awaiting_approval", currentArtifactId: base.id, approvalCandidateArtifactId: base.id, activeRunId: null,
    });
    expect(await prisma.phaseArtifact.count({ where: { projectId } })).toBe(1);
  });

  test("approved base produces a draft section successor while preserving currentApprovedArtifactId", async () => {
    const projectId = await createProject();
    const readyBase = requirements();
    readyBase.unresolvedQuestions = [];
    const base = await seedV1(projectId, readyBase);
    const setup = services(new CapturingGateway(requirements()));
    await setup.approvals.requestApproval({
      projectId, phase: "requirements", artifactId: base.id, expectedHash: base.contentHash!, actorId: ownerId,
    });
    await setup.approvals.approveArtifact({
      projectId, phase: "requirements", artifactId: base.id, expectedHash: base.contentHash!, actorId: ownerId,
    });
    const output = structuredClone(readyBase);
    output.constraints[0].description = "Post-approval change.";
    const result = await services(new CapturingGateway(output)).generation.reviseRequirements({
      projectId, actorId: ownerId, baseArtifactId: base.id, idempotencyKey: "approved-base",
      operation: "SECTION_REVISION", targetSectionKey: "constraints", instruction: "Revise approved base.",
    });
    expect(result.artifact).toMatchObject({ lifecycleStatus: "DRAFT", approved: false });
    await expect(prisma.projectPhaseState.findUniqueOrThrow({
      where: { projectId_phase: { projectId, phase: "requirements" } },
    })).resolves.toMatchObject({ currentArtifactId: result.artifact?.id, currentApprovedArtifactId: base.id });
    expect(await prisma.phaseApproval.count({ where: { projectId } })).toBe(1);
  });

  test("clearing the last unresolved question makes the draft ready without approving it", async () => {
    const projectId = await createProject();
    const baseContent = requirements("unresolved-only-blocker");
    const base = await seedV1(projectId, baseContent);
    const output = structuredClone(baseContent);
    output.unresolvedQuestions = [];

    const result = await services(new CapturingGateway(output)).generation.reviseRequirements({
      projectId,
      actorId: ownerId,
      baseArtifactId: base.id,
      idempotencyKey: "ready-without-approval",
      operation: "SECTION_REVISION",
      targetSectionKey: "unresolvedQuestions",
      instruction: "Clear the resolved question.",
    });

    expect(result.readiness).toMatchObject({ ready: true, blockers: [] });
    expect(result.artifact).toMatchObject({ lifecycleStatus: "DRAFT", approved: false });
    await expect(prisma.projectPhaseState.findUniqueOrThrow({
      where: { projectId_phase: { projectId, phase: "requirements" } },
    })).resolves.toMatchObject({
      status: "in_progress",
      currentArtifactId: result.artifact?.id,
      currentApprovedArtifactId: null,
      approvalCandidateArtifactId: null,
    });
    expect(await prisma.phaseApproval.count({ where: { projectId } })).toBe(0);
  });
});
