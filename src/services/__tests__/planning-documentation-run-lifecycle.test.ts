import crypto from "crypto";
import { PrismaClient } from "@prisma/client";
import { DocumentationProviderDraft } from "../../planning/documentation-schema";
import { LLMTruncationError } from "../../ai/gateway/LLMError";
import { RequirementsContent } from "../../planning/requirements-schema";
import { PlanningApprovalService } from "../planning-approval.service";
import { PlanningArtifactService } from "../planning-artifact.service";
import { PlanningDocumentationArtifactService } from "../planning-documentation-artifact.service";
import { PlanningDocumentationGenerationService } from "../planning-documentation-generation.service";
import { PhaseService } from "../phase-service";

const databaseUrl = process.env.DATABASE_URL;
const schema = databaseUrl ? new URL(databaseUrl).searchParams.get("schema") : null;
const describeIsolated = schema?.startsWith("planning_checkpoint_1c_docs_") ? describe : describe.skip;
const prisma = new PrismaClient();
const requirementsArtifacts = new PlanningArtifactService(prisma);
const documentationArtifacts = new PlanningDocumentationArtifactService(prisma);
const approvals = new PlanningApprovalService(prisma);
const ownerId = `docs-run-owner-${crypto.randomUUID()}`;
const outsiderId = `docs-run-outsider-${crypto.randomUUID()}`;
const projectIds: string[] = [];

function requirements(label: string): RequirementsContent {
  return {
    projectGoal: `Deliver ${label}`, problemStatement: `Need ${label}`,
    usersAndActors: [{ id: "ACT-1", name: "Owner", description: "Owner" }],
    userStories: [{ id: "US-1", actor: "Owner", capability: label, benefit: "value", acceptanceCriteriaIds: ["AC-1"] }],
    functionalRequirements: [{ id: "FR-1", title: label, description: `Support ${label}` }],
    nonFunctionalRequirements: [{ id: "NFR-1", title: "Audit", description: "Audit" }],
    constraints: [], integrations: [], assumptions: [],
    acceptanceCriteria: [{ id: "AC-1", description: "Works", relatedRequirementIds: ["FR-1"] }],
    outOfScope: [], unresolvedQuestions: [],
  };
}

function draft(): DocumentationProviderDraft {
  return {
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
}

function completion(content: DocumentationProviderDraft) {
  return { content, rawResponse: {} as never, finishReason: "stop", usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 }, latencyMs: 1, model: "gpt-4o", stage: "DOCUMENTATION_PLANNING" as const, attemptCount: 1,
    providerAttempts: [{ attemptNumber: 1, kind: "initial" as const, providerResponseId: "response", providerRequestId: "request", model: "gpt-4o", finishReason: "stop", promptTokens: 10, completionTokens: 20, totalTokens: 30, usageSource: "provider" as const, latencyMs: 1 }] };
}

async function project(): Promise<string> {
  const id = `docs-run-project-${crypto.randomUUID()}`;
  await prisma.project.create({ data: { id, name: "Documentation run", userId: ownerId } });
  projectIds.push(id);
  return id;
}

async function approveRequirements(projectId: string, label: string) {
  const current = await prisma.projectPhaseState.findUnique({ where: { projectId_phase: { projectId, phase: "requirements" } } });
  const artifact = current?.currentArtifactId
    ? await requirementsArtifacts.createManualRevision({ projectId, actorId: ownerId, baseArtifactId: current.currentArtifactId, baseContentHash: (await prisma.phaseArtifact.findUniqueOrThrow({ where: { id: current.currentArtifactId } })).contentHash!, structuredContent: requirements(label) })
    : await requirementsArtifacts.createInitialArtifact({ projectId, actorId: ownerId, title: "Requirements", structuredContent: requirements(label) });
  await approvals.requestApproval({ projectId, phase: "requirements", artifactId: artifact.id, expectedHash: artifact.contentHash!, actorId: ownerId });
  await approvals.approveArtifact({ projectId, phase: "requirements", artifactId: artifact.id, expectedHash: artifact.contentHash!, actorId: ownerId });
  return artifact;
}

describeIsolated("Documentation WorkflowRun lifecycle", () => {
  beforeAll(async () => { await prisma.user.createMany({ data: [
    { id: ownerId, email: `${ownerId}@anka.test`, password: "unused" },
    { id: outsiderId, email: `${outsiderId}@anka.test`, password: "unused" },
  ] }); });
  afterAll(async () => {
    for (const id of projectIds.reverse()) await prisma.project.delete({ where: { id } });
    await prisma.user.deleteMany({ where: { id: { in: [ownerId, outsiderId] } } });
    await prisma.$disconnect();
  });

  test("persists v1 atomically and replays without another provider call", async () => {
    const projectId = await project();
    const source = await approveRequirements(projectId, "v1");
    const gateway = { callStructured: jest.fn().mockResolvedValue(completion(draft())) };
    const service = new PlanningDocumentationGenerationService(prisma, { gateway });
    const first = await service.generateInitial({ projectId, actorId: ownerId, idempotencyKey: "raw-secret-key" });
    expect(first).toMatchObject({ httpStatus: 201, reused: false, artifact: { version: 1, createdByType: "AI", changeKind: "INITIAL_GENERATION", lifecycleStatus: "DRAFT", approved: false } });
    expect(first.run).toMatchObject({ status: "completed", operation: "INITIAL_GENERATION", inputArtifactId: source.id, baseArtifactId: null, outputArtifactId: first.artifact!.id, targetSectionKey: null });
    expect(first.run.idempotencyKey).toMatch(/^documentation:[a-f0-9]{64}$/);
    expect(first.run.idempotencyKey).not.toContain("raw-secret-key");
    await expect(prisma.projectPhaseState.findUniqueOrThrow({ where: { projectId_phase: { projectId, phase: "documentation" } } })).resolves.toMatchObject({ activeRunId: null, currentArtifactId: first.artifact!.id });
    const replay = await service.generateInitial({ projectId, actorId: ownerId, idempotencyKey: "raw-secret-key" });
    expect(replay).toMatchObject({ httpStatus: 200, reused: true, artifact: { id: first.artifact!.id } });
    expect(gateway.callStructured).toHaveBeenCalledTimes(1);
  });

  test("same key with changed memory option conflicts without a provider call", async () => {
    const projectId = await project();
    await approveRequirements(projectId, "v1");
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const gateway = { callStructured: jest.fn().mockImplementation(async () => { await barrier; return completion(draft()); }) };
    const service = new PlanningDocumentationGenerationService(prisma, { gateway });
    const pending = service.generateInitial({ projectId, actorId: ownerId, idempotencyKey: "same-key", includeMemory: false });
    while (gateway.callStructured.mock.calls.length === 0) await new Promise((resolve) => setImmediate(resolve));
    await expect(service.generateInitial({ projectId, actorId: ownerId, idempotencyKey: "same-key", includeMemory: false })).resolves.toMatchObject({ httpStatus: 202, reused: true, artifact: null });
    const stateBeforeConflict = await prisma.projectPhaseState.findUniqueOrThrow({ where: { projectId_phase: { projectId, phase: "documentation" } } });
    await expect(service.generateInitial({ projectId, actorId: ownerId, idempotencyKey: "same-key", includeMemory: true })).rejects.toMatchObject({ code: "PLANNING_IDEMPOTENCY_CONFLICT", httpStatus: 409 });
    expect(await prisma.workflowRun.count({ where: { projectId, currentPhase: "documentation" } })).toBe(1);
    expect(await prisma.phaseArtifact.count({ where: { projectId, phase: "documentation" } })).toBe(0);
    await expect(prisma.projectPhaseState.findUniqueOrThrow({ where: { projectId_phase: { projectId, phase: "documentation" } } })).resolves.toMatchObject({
      activeRunId: stateBeforeConflict.activeRunId,
      currentArtifactId: stateBeforeConflict.currentArtifactId,
      currentApprovedArtifactId: stateBeforeConflict.currentApprovedArtifactId,
      approvalCandidateArtifactId: stateBeforeConflict.approvalCandidateArtifactId,
      stateVersion: stateBeforeConflict.stateVersion,
    });
    expect(gateway.callStructured).toHaveBeenCalledTimes(1);
    release();
    await expect(pending).resolves.toMatchObject({ httpStatus: 201 });
    expect(gateway.callStructured).toHaveBeenCalledTimes(1);
  });

  test("a different key cannot acquire an active Documentation lease", async () => {
    const projectId = await project();
    await approveRequirements(projectId, "v1");
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const gateway = { callStructured: jest.fn().mockImplementation(async () => { await barrier; return completion(draft()); }) };
    const service = new PlanningDocumentationGenerationService(prisma, { gateway });
    const pending = service.generateInitial({ projectId, actorId: ownerId, idempotencyKey: "owner-one" });
    while (gateway.callStructured.mock.calls.length === 0) await new Promise((resolve) => setImmediate(resolve));
    await expect(service.generateInitial({ projectId, actorId: ownerId, idempotencyKey: "owner-two" })).rejects.toMatchObject({ code: "PLANNING_GENERATION_IN_PROGRESS", httpStatus: 409 });
    release();
    await expect(pending).resolves.toMatchObject({ httpStatus: 201 });
    expect(await prisma.workflowRun.count({ where: { projectId } })).toBe(1);
    expect(gateway.callStructured).toHaveBeenCalledTimes(1);
  });

  test("outsiders cannot create a run or invoke the provider", async () => {
    const projectId = await project();
    await approveRequirements(projectId, "v1");
    const gateway = { callStructured: jest.fn() };
    const service = new PlanningDocumentationGenerationService(prisma, { gateway });
    await expect(service.generateInitial({ projectId, actorId: outsiderId, idempotencyKey: "outsider" })).rejects.toMatchObject({ code: "PLANNING_PROJECT_NOT_FOUND", httpStatus: 404 });
    expect(await prisma.workflowRun.count({ where: { projectId } })).toBe(0);
    expect(gateway.callStructured).not.toHaveBeenCalled();
  });

  test("a human Documentation v1 created during provider execution wins", async () => {
    const projectId = await project();
    const source = await approveRequirements(projectId, "v1");
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const gateway = { callStructured: jest.fn().mockImplementation(async () => { await barrier; return completion(draft()); }) };
    const service = new PlanningDocumentationGenerationService(prisma, { gateway });
    const pending = service.generateInitial({ projectId, actorId: ownerId, idempotencyKey: "human-race" });
    while (gateway.callStructured.mock.calls.length === 0) await new Promise((resolve) => setImmediate(resolve));
    const { assembleDocumentationContent } = await import("../../planning/documentation-assembly");
    const human = await documentationArtifacts.createInitialArtifact({ projectId, actorId: ownerId, title: "Human", structuredContent: assembleDocumentationContent(draft(), { artifactId: source.id, version: source.version, contentHash: source.contentHash! }, requirements("v1")) });
    release();
    await expect(pending).rejects.toMatchObject({ code: "PLANNING_CONTEXT_CHANGED", httpStatus: 409 });
    await expect(prisma.projectPhaseState.findUniqueOrThrow({ where: { projectId_phase: { projectId, phase: "documentation" } } })).resolves.toMatchObject({ currentArtifactId: human.id, activeRunId: null });
    expect(await prisma.phaseArtifact.count({ where: { projectId, phase: "documentation" } })).toBe(1);
  });

  test("a newly approved Requirements version invalidates provider output", async () => {
    const projectId = await project();
    await approveRequirements(projectId, "v1");
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const gateway = { callStructured: jest.fn().mockImplementation(async () => { await barrier; return completion(draft()); }) };
    const service = new PlanningDocumentationGenerationService(prisma, { gateway });
    const pending = service.generateInitial({ projectId, actorId: ownerId, idempotencyKey: "requirements-race" });
    while (gateway.callStructured.mock.calls.length === 0) await new Promise((resolve) => setImmediate(resolve));
    const v2 = await approveRequirements(projectId, "v2");
    release();
    await expect(pending).rejects.toMatchObject({ code: "PLANNING_CONTEXT_CHANGED", httpStatus: 409 });
    await expect(prisma.projectPhaseState.findUniqueOrThrow({ where: { projectId_phase: { projectId, phase: "requirements" } } })).resolves.toMatchObject({ currentApprovedArtifactId: v2.id });
    expect(await prisma.phaseArtifact.count({ where: { projectId, phase: "documentation" } })).toBe(0);
  });

  test("truncation terminalizes, releases the lease, and replays without another provider call", async () => {
    const projectId = await project();
    await approveRequirements(projectId, "v1");
    const truncation = new LLMTruncationError("truncated", { stage: "DOCUMENTATION_PLANNING", model: "gpt-4o" });
    truncation.attachProviderAttempts([{ attemptNumber: 1, kind: "initial", providerResponseId: "response", providerRequestId: "request", model: "gpt-4o", finishReason: "length", promptTokens: 10, completionTokens: 8_000, totalTokens: 8_010, usageSource: "provider", latencyMs: 1 }]);
    const gateway = { callStructured: jest.fn().mockRejectedValue(truncation) };
    const service = new PlanningDocumentationGenerationService(prisma, { gateway });
    await expect(service.generateInitial({ projectId, actorId: ownerId, idempotencyKey: "truncated" })).rejects.toMatchObject({ code: "PLANNING_AI_TRUNCATED" });
    const run = await prisma.workflowRun.findFirstOrThrow({ where: { projectId } });
    expect(run).toMatchObject({ status: "failed", errorCode: "PLANNING_AI_TRUNCATED", outputArtifactId: null });
    expect(run.modelUsage).toMatchObject({ usageSource: "provider", finishReason: "length" });
    await expect(prisma.projectPhaseState.findUniqueOrThrow({ where: { projectId_phase: { projectId, phase: "documentation" } } })).resolves.toMatchObject({ activeRunId: null });
    await expect(service.generateInitial({ projectId, actorId: ownerId, idempotencyKey: "truncated" })).rejects.toMatchObject({ code: "PLANNING_AI_TRUNCATED", details: { reused: true } });
    expect(gateway.callStructured).toHaveBeenCalledTimes(1);
  });

  test("invalid provider roots create no artifact and replay the terminal failure", async () => {
    const projectId = await project();
    await approveRequirements(projectId, "v1");
    const gateway = { callStructured: jest.fn().mockResolvedValue(completion({ ...draft(), sourceRequirements: { artifactId: "forged" } } as unknown as DocumentationProviderDraft)) };
    const service = new PlanningDocumentationGenerationService(prisma, { gateway });
    await expect(service.generateInitial({ projectId, actorId: ownerId, idempotencyKey: "invalid" })).rejects.toMatchObject({ code: "PLANNING_AI_INVALID_RESPONSE" });
    expect(await prisma.phaseArtifact.count({ where: { projectId, phase: "documentation" } })).toBe(0);
    await expect(service.generateInitial({ projectId, actorId: ownerId, idempotencyKey: "invalid" })).rejects.toMatchObject({ code: "PLANNING_AI_INVALID_RESPONSE", details: { reused: true } });
    expect(gateway.callStructured).toHaveBeenCalledTimes(1);
  });

  test("persists a structurally valid unresolved draft with readiness blockers", async () => {
    const projectId = await project();
    await approveRequirements(projectId, "v1");
    const unresolved = draft();
    unresolved.unresolvedQuestions = [{ id: "DOC-UQ", question: "Who reviews?", impact: "Approval is blocked." }];
    const gateway = { callStructured: jest.fn().mockResolvedValue(completion(unresolved)) };
    const service = new PlanningDocumentationGenerationService(prisma, { gateway });
    const result = await service.generateInitial({ projectId, actorId: ownerId, idempotencyKey: "unresolved" });
    expect(result).toMatchObject({ httpStatus: 201, artifact: { lifecycleStatus: "DRAFT", approved: false }, readiness: { ready: false } });
    expect(result.readiness?.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code: "DOCS_UNRESOLVED_QUESTIONS" })]));
  });

  test("recovers an expired lease before establishing one new owner", async () => {
    const projectId = await project();
    const source = await approveRequirements(projectId, "v1");
    const old = await prisma.workflowRun.create({ data: {
      projectId, triggerType: "manual", currentPhase: "documentation", status: "running",
      operation: "INITIAL_GENERATION", inputArtifactId: source.id, initiatedById: ownerId,
      initiatedByType: "HUMAN", idempotencyKey: `documentation:${"a".repeat(64)}`,
      startedAt: new Date(Date.now() - 16 * 60 * 1000),
    } });
    await prisma.projectPhaseState.upsert({
      where: { projectId_phase: { projectId, phase: "documentation" } },
      update: { activeRunId: old.id }, create: { projectId, phase: "documentation", activeRunId: old.id },
    });
    const gateway = { callStructured: jest.fn().mockResolvedValue(completion(draft())) };
    const service = new PlanningDocumentationGenerationService(prisma, { gateway });
    await expect(service.generateInitial({ projectId, actorId: ownerId, idempotencyKey: "new-owner" })).resolves.toMatchObject({ httpStatus: 201 });
    await expect(prisma.workflowRun.findUniqueOrThrow({ where: { id: old.id } })).resolves.toMatchObject({ status: "failed", errorCode: "PLANNING_STALE_RUN_RECOVERED" });
    expect(gateway.callStructured).toHaveBeenCalledTimes(1);
  });

  test.each(["requirements", "documentation"])("locks the legacy %s runner", async (phase) => {
    const projectId = await project();
    const phases = new PhaseService(prisma);
    await expect(phases.runAutomatedPhase(projectId, phase, ownerId)).rejects.toMatchObject({
      code: "PLANNING_ACTION_LOCKED", httpStatus: 409,
    });
    expect(await prisma.workflowRun.count({ where: { projectId } })).toBe(0);
  });
});
