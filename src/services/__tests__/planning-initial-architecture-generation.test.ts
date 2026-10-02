import { ArchitectureAuthoredDraft } from "../../planning/architecture-schema";
import { PlanningArchitectureContextBuilder } from "../../planning/architecture-context";
import { preflightArchitectureHandoff } from "../../planning/documentation-architecture-preflight";
import { architectureDraft } from "../../planning/__tests__/architecture-test-fixtures";
import { PlanningArchitectureGenerationService } from "../planning-architecture-generation.service";
import { PlanningArchitectureRunService } from "../planning-architecture-run.service";
import { PlanningArchitectureArtifactService } from "../planning-architecture-artifact.service";
import { DocumentationLifecycleFixture, documentationContent, hashOf } from "./planning-documentation-test-fixtures";

const fixture = new DocumentationLifecycleFixture();
beforeAll(() => fixture.start());
afterAll(() => fixture.stop());

async function setup(label: string, member = false) {
  const projectId = await fixture.createProject(member);
  const requirements = await fixture.approveRequirements(projectId, label);
  const docs = documentationContent(requirements.artifact, requirements.content);
  const documentation = await fixture.documentationArtifacts.createInitialArtifact({
    projectId, actorId: fixture.ownerId, title: "Documentation", structuredContent: docs,
  });
  await fixture.approvals.requestDocumentationApproval({ projectId, artifactId: documentation.id,
    expectedHash: hashOf(documentation), actorId: fixture.ownerId });
  await fixture.approvals.approveDocumentationArtifact({ projectId, artifactId: documentation.id,
    expectedHash: hashOf(documentation), actorId: fixture.ownerId });
  return { projectId, requirements, documentation, docs,
    draft: architectureDraft(requirements.content.nonFunctionalRequirements[0].id) };
}
function completion(draft: ArchitectureAuthoredDraft) {
  return { content: draft, model: "gpt-4o", stage: "ARCHITECTURE_PLANNING", finishReason: "stop",
    latencyMs: 1, providerAttempts: [{ attemptNumber: 1, kind: "initial", providerResponseId: "response",
      providerRequestId: "request", model: "gpt-4o", finishReason: "stop", promptTokens: 10,
      completionTokens: 20, totalTokens: 30, usageSource: "provider", latencyMs: 1 }] };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function assertNoAIArtifact(projectId: string) {
  expect(await fixture.prisma.phaseArtifact.count({ where: { projectId, phase: "architecture", createdByType: "AI" } })).toBe(0);
  expect((await fixture.prisma.projectPhaseState.findUniqueOrThrow({
    where: { projectId_phase: { projectId, phase: "architecture" } },
  })).activeRunId).toBeNull();
}

describe("Architecture initial AI generation on isolated PostgreSQL", () => {
  test("creates one immutable unapproved v1 and replays the historical result", async () => {
    const data = await setup("arch-ai-success");
    const gateway = { callStructured: jest.fn().mockResolvedValue(completion(data.draft)) };
    const service = new PlanningArchitectureGenerationService(fixture.prisma, { gateway });
    const input = { projectId: data.projectId, actorId: fixture.ownerId, idempotencyKey: "success" };
    const first = await service.generateInitial(input);
    expect(first).toMatchObject({ httpStatus: 201, reused: false, artifact: {
      version: 1, lifecycleStatus: "DRAFT", approved: false, createdByType: "AI",
      changeKind: "INITIAL_GENERATION",
    }, readiness: { ready: true } });
    expect(first.artifact?.structuredContent).toMatchObject({
      sourceRequirements: { artifactId: data.requirements.artifact.id },
      sourceDocumentation: { artifactId: data.documentation.id },
      traceability: { features: [{ documentationId: "DOC-FEATURE" }] },
    });
    expect(first.run.modelUsage).toMatchObject({ promptVersion: "architecture-initial-generation-v1",
      usageSource: "provider", attemptCount: 1 });
    expect(first.run.costUSD).toBeCloseTo(0.000225);
    const replay = await service.generateInitial(input);
    expect(replay).toMatchObject({ httpStatus: 200, reused: true, artifact: { id: first.artifact?.id } });
    expect(gateway.callStructured).toHaveBeenCalledTimes(1);
    expect(await fixture.prisma.workflowRun.count({ where: { projectId: data.projectId, currentPhase: "architecture" } })).toBe(1);
    expect(await fixture.prisma.phaseArtifact.count({ where: { projectId: data.projectId, phase: "architecture" } })).toBe(1);
    expect(await fixture.prisma.projectPhaseState.findUniqueOrThrow({ where: {
      projectId_phase: { projectId: data.projectId, phase: "architecture" },
    } })).toMatchObject({ currentArtifactId: first.artifact?.id, currentApprovedArtifactId: null,
      approvalCandidateArtifactId: null, activeRunId: null });
  });

  test("structurally valid blocked draft persists without approval readiness", async () => {
    const data = await setup("arch-ai-blocked");
    data.draft.unresolvedQuestions = [{ id: "ARCH-Q-OPEN", question: "Who operates it?", blocksDecision: true }];
    const service = new PlanningArchitectureGenerationService(fixture.prisma, {
      gateway: { callStructured: jest.fn().mockResolvedValue(completion(data.draft)) },
    });
    const result = await service.generateInitial({ projectId: data.projectId, actorId: fixture.ownerId, idempotencyKey: "blocked" });
    expect(result.readiness).toMatchObject({ ready: false, blockers: [{ code: "ARCH_BLOCKING_QUESTIONS" }] });
    expect(result.artifact?.lifecycleStatus).toBe("DRAFT");
  });

  test.each(["sourceRequirements", "traceability"])("rejects provider-owned %s", async (root) => {
    const data = await setup(`arch-ai-forged-${root}`);
    const gateway = { callStructured: jest.fn().mockResolvedValue(completion({
      ...data.draft, [root]: { artifactId: "forged" },
    } as ArchitectureAuthoredDraft)) };
    const service = new PlanningArchitectureGenerationService(fixture.prisma, { gateway });
    const input = { projectId: data.projectId, actorId: fixture.ownerId, idempotencyKey: "forged" };
    await expect(service.generateInitial(input)).rejects.toMatchObject({ code: "PLANNING_AI_INVALID_RESPONSE" });
    await assertNoAIArtifact(data.projectId);
    await expect(service.generateInitial(input)).rejects.toMatchObject({ code: "PLANNING_AI_INVALID_RESPONSE" });
    expect(gateway.callStructured).toHaveBeenCalledTimes(1);
  });

  test("truncation records terminal failure with no artifact", async () => {
    const data = await setup("arch-ai-truncated");
    const gateway = { callStructured: jest.fn().mockResolvedValue({ ...completion(data.draft), finishReason: "length" }) };
    const service = new PlanningArchitectureGenerationService(fixture.prisma, { gateway });
    await expect(service.generateInitial({ projectId: data.projectId, actorId: fixture.ownerId, idempotencyKey: "trunc" }))
      .rejects.toMatchObject({ code: "PLANNING_AI_TRUNCATED" });
    await assertNoAIArtifact(data.projectId);
  });

  test.each(["requirements", "documentation"])("%s approval advance during provider execution rejects stale output", async (phase) => {
    const data = await setup(`arch-ai-race-${phase}`);
    const entered = deferred<void>(); const release = deferred<void>();
    const gateway = { callStructured: jest.fn().mockImplementation(async () => {
      entered.resolve(); await release.promise; return completion(data.draft);
    }) };
    const service = new PlanningArchitectureGenerationService(fixture.prisma, { gateway });
    const pending = service.generateInitial({ projectId: data.projectId, actorId: fixture.ownerId, idempotencyKey: phase });
    await entered.promise;
    if (phase === "requirements") {
      await fixture.approveNextRequirements(data.projectId, data.requirements.artifact, "arch-ai-race-next");
    } else {
      const next = await fixture.documentationArtifacts.createSuccessorVersion({
        projectId: data.projectId, actorId: fixture.ownerId, baseArtifactId: data.documentation.id,
        baseContentHash: hashOf(data.documentation), title: "Documentation v2", structuredContent: data.docs,
      });
      await fixture.approvals.requestDocumentationApproval({ projectId: data.projectId,
        artifactId: next.id, expectedHash: hashOf(next), actorId: fixture.ownerId });
      await fixture.approvals.approveDocumentationArtifact({ projectId: data.projectId,
        artifactId: next.id, expectedHash: hashOf(next), actorId: fixture.ownerId });
    }
    release.resolve();
    await expect(pending).rejects.toMatchObject({ code: "PLANNING_CONTEXT_CHANGED" });
    await assertNoAIArtifact(data.projectId);
    expect(gateway.callStructured).toHaveBeenCalledTimes(1);
  });

  test("new unapproved upstream draft does not replace approved authority", async () => {
    const data = await setup("arch-ai-unapproved");
    const entered = deferred<void>(); const release = deferred<void>();
    const service = new PlanningArchitectureGenerationService(fixture.prisma, { gateway: {
      callStructured: jest.fn().mockImplementation(async () => { entered.resolve(); await release.promise; return completion(data.draft); }),
    } });
    const pending = service.generateInitial({ projectId: data.projectId, actorId: fixture.ownerId, idempotencyKey: "unapproved" });
    await entered.promise;
    await fixture.requirementsArtifacts.createManualRevision({ projectId: data.projectId,
      actorId: fixture.ownerId, baseArtifactId: data.requirements.artifact.id,
      baseContentHash: hashOf(data.requirements.artifact), structuredContent: data.requirements.content });
    // Keep the project in Architecture to isolate authority selection from a phase transition.
    await fixture.prisma.project.update({ where: { id: data.projectId }, data: { currentPhase: "architecture" } });
    release.resolve();
    await expect(pending).resolves.toMatchObject({ httpStatus: 201, artifact: { version: 1 } });
  });

  test("human v1 race wins and AI run becomes terminal without moving pointers", async () => {
    const data = await setup("arch-ai-human-race");
    const entered = deferred<void>(); const release = deferred<void>();
    const service = new PlanningArchitectureGenerationService(fixture.prisma, { gateway: {
      callStructured: jest.fn().mockImplementation(async () => { entered.resolve(); await release.promise; return completion(data.draft); }),
    } });
    const pending = service.generateInitial({ projectId: data.projectId, actorId: fixture.ownerId, idempotencyKey: "human-race" });
    await entered.promise;
    const human = await new PlanningArchitectureArtifactService(fixture.prisma).create({
      projectId: data.projectId, actorId: fixture.ownerId, title: "Human Architecture", structuredContent: data.draft,
    });
    await fixture.approvals.requestArchitectureApproval({ projectId: data.projectId,
      artifactId: human.id, expectedHash: hashOf(human), actorId: fixture.ownerId });
    release.resolve();
    await expect(pending).rejects.toMatchObject({ code: "PLANNING_CONTEXT_CHANGED" });
    expect(await fixture.prisma.phaseArtifact.count({ where: { projectId: data.projectId, phase: "architecture" } })).toBe(1);
    expect(await fixture.prisma.projectPhaseState.findUniqueOrThrow({ where: {
      projectId_phase: { projectId: data.projectId, phase: "architecture" },
    } })).toMatchObject({ currentArtifactId: human.id, approvalCandidateArtifactId: human.id, activeRunId: null });
  });

  test("opted-in memory is hashed and a change prevents finalization", async () => {
    const data = await setup("arch-ai-memory");
    const memory = await fixture.prisma.projectMemorySummary.create({ data: {
      projectId: data.projectId, summary: "Only a supplemental note.",
    } });
    const context = await fixture.prisma.$transaction(async (tx) => {
      const authority = await preflightArchitectureHandoff(tx, data.projectId);
      const builder = new PlanningArchitectureContextBuilder();
      const without = await builder.buildInTransaction(tx, { projectId: data.projectId,
        actorId: fixture.ownerId, includeMemory: false, authority });
      const withMemory = await builder.buildInTransaction(tx, { projectId: data.projectId,
        actorId: fixture.ownerId, includeMemory: true, authority });
      return { without, withMemory };
    });
    expect(context.without.payload.memory).toBeNull();
    expect(context.withMemory.manifest.memory).toMatchObject({ id: memory.id, summary: "Only a supplemental note." });
    expect(context.withMemory.manifest.requestFingerprint).not.toBe(context.without.manifest.requestFingerprint);
    expect(context.withMemory.manifest.contextHash).not.toBe(context.without.manifest.contextHash);
    const runs = new PlanningArchitectureRunService(fixture.prisma);
    const started = await runs.start({ projectId: data.projectId, actorId: fixture.ownerId,
      idempotencyKey: "memory", includeMemory: true });
    await fixture.prisma.projectMemorySummary.update({ where: { projectId: data.projectId },
      data: { summary: "The note changed.", version: { increment: 1 } } });
    await expect(runs.finalize({ projectId: data.projectId, runId: started.run.id,
      actorId: fixture.ownerId, structuredContent: data.draft,
      audit: { modelUsage: {}, costUSD: null } })).rejects.toMatchObject({ code: "PLANNING_CONTEXT_CHANGED" });
    await runs.finish(data.projectId, started.run.id, "conflicted", { code: "PLANNING_CONTEXT_CHANGED", message: "Context changed." });
    await assertNoAIArtifact(data.projectId);
  });

  test("mixed provider usage remains partial and cost stays null", async () => {
    const data = await setup("arch-ai-partial-usage");
    const first = completion(data.draft);
    const gateway = { callStructured: jest.fn().mockResolvedValue({ ...first, providerAttempts: [
      first.providerAttempts[0],
      { ...first.providerAttempts[0], attemptNumber: 2, usageSource: "unavailable",
        promptTokens: null, completionTokens: null, totalTokens: null },
    ] }) };
    const result = await new PlanningArchitectureGenerationService(fixture.prisma, { gateway }).generateInitial({
      projectId: data.projectId, actorId: fixture.ownerId, idempotencyKey: "partial",
    });
    expect(result.run.modelUsage).toMatchObject({ usageSource: "partial_provider", providerUsageAttemptCount: 1 });
    expect(result.run.costUSD).toBeNull();
  });

  test("distinct keys compete while same key replays a running lease", async () => {
    const data = await setup("arch-ai-keys");
    const entered = deferred<void>(); const release = deferred<void>();
    const gateway = { callStructured: jest.fn().mockImplementation(async () => {
      entered.resolve(); await release.promise; return completion(data.draft);
    }) };
    const service = new PlanningArchitectureGenerationService(fixture.prisma, { gateway });
    const firstInput = { projectId: data.projectId, actorId: fixture.ownerId, idempotencyKey: "same" };
    const pending = service.generateInitial(firstInput);
    await entered.promise;
    await expect(service.generateInitial(firstInput)).resolves.toMatchObject({ httpStatus: 202, reused: true });
    await expect(service.generateInitial({ ...firstInput, idempotencyKey: "different" })).rejects.toMatchObject({ code: "PLANNING_GENERATION_IN_PROGRESS" });
    release.resolve();
    await expect(pending).resolves.toMatchObject({ httpStatus: 201 });
    expect(gateway.callStructured).toHaveBeenCalledTimes(1);
    expect(await fixture.prisma.workflowRun.count({ where: { projectId: data.projectId, currentPhase: "architecture" } })).toBe(1);
  });

  test("simultaneous same-key starts converge on one run and lease", async () => {
    const data = await setup("arch-ai-same-key-race");
    const runs = new PlanningArchitectureRunService(fixture.prisma);
    const input = { projectId: data.projectId, actorId: fixture.ownerId,
      idempotencyKey: "simultaneous", includeMemory: false };
    const results = await Promise.all([runs.start(input), runs.start(input)]);
    expect(results.map((result) => result.run.id)).toEqual([results[0].run.id, results[0].run.id]);
    expect(results.filter((result) => result.reused)).toHaveLength(1);
    expect(await fixture.prisma.workflowRun.count({ where: { projectId: data.projectId,
      currentPhase: "architecture" } })).toBe(1);
    expect((await fixture.prisma.projectPhaseState.findUniqueOrThrow({ where: {
      projectId_phase: { projectId: data.projectId, phase: "architecture" },
    } })).activeRunId).toBe(results[0].run.id);
    await runs.finish(data.projectId, results[0].run.id, "failed", {
      code: "PLANNING_AI_PROVIDER_ERROR", message: "Provider failed.",
    });
  });

  test("phase change and revoked editor prevent finalization", async () => {
    const data = await setup("arch-ai-revoked", true);
    const entered = deferred<void>(); const release = deferred<void>();
    const service = new PlanningArchitectureGenerationService(fixture.prisma, { gateway: {
      callStructured: jest.fn().mockImplementation(async () => { entered.resolve(); await release.promise; return completion(data.draft); }),
    } });
    const pending = service.generateInitial({ projectId: data.projectId, actorId: fixture.memberId, idempotencyKey: "revoked" });
    await entered.promise;
    await fixture.prisma.projectMember.deleteMany({ where: { projectId: data.projectId, userId: fixture.memberId } });
    release.resolve();
    await expect(pending).rejects.toMatchObject({ code: "PLANNING_PROJECT_NOT_FOUND" });
    await assertNoAIArtifact(data.projectId);
    const second = await setup("arch-ai-phase-change");
    const runs = new PlanningArchitectureRunService(fixture.prisma);
    const started = await runs.start({ projectId: second.projectId, actorId: fixture.ownerId,
      idempotencyKey: "phase-change", includeMemory: false });
    await fixture.prisma.project.update({ where: { id: second.projectId }, data: { currentPhase: "implementation" } });
    await expect(runs.finalize({ projectId: second.projectId, runId: started.run.id, actorId: fixture.ownerId,
      structuredContent: second.draft, audit: { modelUsage: {}, costUSD: null } })).rejects.toMatchObject({ code: "PLANNING_CONTEXT_CHANGED" });
    await runs.finish(second.projectId, started.run.id, "conflicted", { code: "PLANNING_CONTEXT_CHANGED", message: "Context changed." });
    await assertNoAIArtifact(second.projectId);
  });

  test("cross-project editor cannot generate or replay", async () => {
    const first = await setup("arch-ai-cross-first");
    const second = await setup("arch-ai-cross-second");
    const gateway = { callStructured: jest.fn().mockResolvedValue(completion(first.draft)) };
    const service = new PlanningArchitectureGenerationService(fixture.prisma, { gateway });
    const result = await service.generateInitial({ projectId: first.projectId, actorId: fixture.ownerId, idempotencyKey: "cross" });
    await expect(service.generateInitial({ projectId: first.projectId, actorId: fixture.outsiderId, idempotencyKey: "cross" }))
      .rejects.toMatchObject({ code: "PLANNING_PROJECT_NOT_FOUND" });
    await expect(new PlanningArchitectureRunService(fixture.prisma).getRun(second.projectId, result.run.id, fixture.ownerId))
      .rejects.toMatchObject({ code: "PLANNING_PROJECT_NOT_FOUND" });
  });

  test("stale lease is terminalized before a new key acquires it", async () => {
    const data = await setup("arch-ai-stale");
    const runs = new PlanningArchitectureRunService(fixture.prisma);
    const first = await runs.start({ projectId: data.projectId, actorId: fixture.ownerId,
      idempotencyKey: "stale-first", includeMemory: false });
    await fixture.prisma.workflowRun.update({ where: { id: first.run.id }, data: {
      startedAt: new Date(Date.now() - 16 * 60 * 1000),
    } });
    const second = await runs.start({ projectId: data.projectId, actorId: fixture.ownerId,
      idempotencyKey: "stale-second", includeMemory: false });
    expect((await fixture.prisma.workflowRun.findUniqueOrThrow({ where: { id: first.run.id } })).errorCode).toBe("PLANNING_STALE_RUN_RECOVERED");
    expect((await fixture.prisma.projectPhaseState.findUniqueOrThrow({ where: {
      projectId_phase: { projectId: data.projectId, phase: "architecture" },
    } })).activeRunId).toBe(second.run.id);
    await runs.finish(data.projectId, second.run.id, "failed", { code: "PLANNING_AI_PROVIDER_ERROR", message: "Provider failed." });
  });

  test("completed and terminal replay survive an upstream approval advance", async () => {
    const completed = await setup("arch-ai-history-complete");
    const successGateway = { callStructured: jest.fn().mockResolvedValue(completion(completed.draft)) };
    const success = new PlanningArchitectureGenerationService(fixture.prisma, { gateway: successGateway });
    const successInput = { projectId: completed.projectId, actorId: fixture.ownerId, idempotencyKey: "historical" };
    const original = await success.generateInitial(successInput);
    await fixture.approveNextRequirements(completed.projectId, completed.requirements.artifact, "arch-ai-history-next");
    await expect(success.generateInitial(successInput)).resolves.toMatchObject({ httpStatus: 200, artifact: { id: original.artifact?.id } });
    expect(successGateway.callStructured).toHaveBeenCalledTimes(1);

    const terminal = await setup("arch-ai-history-terminal");
    const badGateway = { callStructured: jest.fn().mockResolvedValue({ ...completion(terminal.draft), finishReason: "length" }) };
    const failed = new PlanningArchitectureGenerationService(fixture.prisma, { gateway: badGateway });
    const failedInput = { projectId: terminal.projectId, actorId: fixture.ownerId, idempotencyKey: "terminal-history" };
    await expect(failed.generateInitial(failedInput)).rejects.toMatchObject({ code: "PLANNING_AI_TRUNCATED" });
    await fixture.approveNextRequirements(terminal.projectId, terminal.requirements.artifact, "arch-ai-history-terminal-next");
    await expect(failed.generateInitial(failedInput)).rejects.toMatchObject({ code: "PLANNING_AI_TRUNCATED", details: { reused: true } });
    expect(badGateway.callStructured).toHaveBeenCalledTimes(1);
    await assertNoAIArtifact(terminal.projectId);
  });
});
