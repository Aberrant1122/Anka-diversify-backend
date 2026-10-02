import { ArchitectureAuthoredDraft } from "../../planning/architecture-schema";
import { architectureDraft } from "../../planning/__tests__/architecture-test-fixtures";
import { PlanningArchitectureArtifactService } from "../planning-architecture-artifact.service";
import { PlanningArchitectureGenerationService } from "../planning-architecture-generation.service";
import { DocumentationLifecycleFixture, documentationContent, hashOf } from "./planning-documentation-test-fixtures";

const fixture = new DocumentationLifecycleFixture();
beforeAll(() => fixture.start());
afterAll(() => fixture.stop());

async function setup(label: string, member = false, editDraft?: (draft: ArchitectureAuthoredDraft) => void) {
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
  const draft = architectureDraft(requirements.content.nonFunctionalRequirements[0].id);
  editDraft?.(draft);
  const base = await new PlanningArchitectureArtifactService(fixture.prisma).create({
    projectId, actorId: fixture.ownerId, title: "Architecture", structuredContent: draft,
  });
  return { projectId, requirements, documentation, docs, draft, base };
}
function completion(draft: ArchitectureAuthoredDraft) {
  return { content: draft, model: "gpt-4o", stage: "ARCHITECTURE_PLANNING", finishReason: "stop",
    latencyMs: 1, providerAttempts: [{ attemptNumber: 1, kind: "initial", providerResponseId: "response",
      providerRequestId: "request", model: "gpt-4o", finishReason: "stop", promptTokens: 10,
      completionTokens: 20, totalTokens: 30, usageSource: "provider", latencyMs: 1 }] };
}
function request(data: Awaited<ReturnType<typeof setup>>, key: string) {
  return { projectId: data.projectId, actorId: fixture.ownerId, idempotencyKey: key,
    operation: "DOCUMENT_REVISION" as const, baseArtifactId: data.base.id,
    baseVersion: data.base.version, baseContentHash: hashOf(data.base), instruction: "Improve the design" };
}
type DesignFamily = "dataDesign" | "interfaceDesign";
function designDraft(data: Awaited<ReturnType<typeof setup>>, family: DesignFamily,
  change: "rename" | "edit" | "retire" | "invalidAnchor"): ArchitectureAuthoredDraft {
  const draft = architectureDraft(data.requirements.content.nonFunctionalRequirements[0].id);
  if (change === "retire") {
    draft[family] = { applicable: false, rationale: "Design is intentionally retired", items: [] };
  } else if (family === "dataDesign") {
    if (change === "rename") draft.dataDesign.items[0].id = "ARCH-DATA-NEW";
    if (change === "invalidAnchor") draft.dataDesign.items[0].documentationEntityId = "DOC-ENTITY-UNKNOWN";
    else draft.dataDesign.items[0].persistence = "New storage policy";
  } else {
    if (change === "rename") draft.interfaceDesign.items[0].id = "ARCH-IFACE-NEW";
    if (change === "invalidAnchor") draft.interfaceDesign.items[0].documentationApiId = "DOC-API-UNKNOWN";
    else draft.interfaceDesign.items[0].transport = "gRPC";
  }
  return draft;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("Architecture AI revision on isolated PostgreSQL", () => {
  test("persists immutable whole-document and feedback successors with deterministic diffs", async () => {
    const data = await setup("arch-c-success");
    const revised = architectureDraft(data.requirements.content.nonFunctionalRequirements[0].id);
    revised.components[0].designNotes = "Stronger transactional writes";
    const gateway = { callStructured: jest.fn().mockResolvedValueOnce(completion(revised))
      .mockResolvedValueOnce(completion({ ...revised, overview: { ...revised.overview, approach: "Service modules" } })) };
    const service = new PlanningArchitectureGenerationService(fixture.prisma, { gateway });
    const first = await service.reviseArchitecture(request(data, "revision"));
    expect(first).toMatchObject({ httpStatus: 201, artifact: { version: 2, previousVersionId: data.base.id,
      basedOnArtifactId: data.base.id, lifecycleStatus: "DRAFT", approved: false,
      changeKind: "AI_DOCUMENT_REVISION" }, diff: { changedRootSections: ["components"],
      modifiedIds: ["ARCH-COMP-API"], provenanceChanged: false } });
    expect(first.run.modelUsage).toMatchObject({ promptVersion: "architecture-revision-v1",
      usageSource: "provider", attemptCount: 1 });
    expect(first.run.costUSD).toBeCloseTo(0.000225);
    const feedback = await service.reviseArchitecture({ ...request(data, "feedback"),
      operation: "FEEDBACK_APPLICATION", baseArtifactId: first.artifact!.id, baseVersion: 2,
      baseContentHash: hashOf(first.artifact!), instruction: "Apply review feedback" });
    expect(feedback).toMatchObject({ artifact: { version: 3, previousVersionId: first.artifact!.id,
      changeKind: "FEEDBACK_APPLICATION" }, diff: { changedRootSections: ["overview"] } });
    const state = await fixture.prisma.projectPhaseState.findUniqueOrThrow({ where: {
      projectId_phase: { projectId: data.projectId, phase: "architecture" } } });
    expect(state).toMatchObject({ currentArtifactId: feedback.artifact!.id, currentApprovedArtifactId: null,
      approvalCandidateArtifactId: null, activeRunId: null });
    expect(await fixture.prisma.phaseArtifact.count({ where: { projectId: data.projectId, phase: "architecture" } })).toBe(3);
    expect(gateway.callStructured).toHaveBeenCalledTimes(2);
  });

  test("no-op is terminal, replayable and creates no successor", async () => {
    const data = await setup("arch-c-noop");
    const gateway = { callStructured: jest.fn().mockResolvedValue(completion(data.draft)) };
    const service = new PlanningArchitectureGenerationService(fixture.prisma, { gateway });
    const input = request(data, "no-op");
    await expect(service.reviseArchitecture(input)).rejects.toMatchObject({ code: "PLANNING_REVISION_NO_CHANGES" });
    await expect(service.reviseArchitecture(input)).rejects.toMatchObject({ code: "PLANNING_REVISION_NO_CHANGES" });
    expect(gateway.callStructured).toHaveBeenCalledTimes(1);
    expect(await fixture.prisma.phaseArtifact.count({ where: { projectId: data.projectId, phase: "architecture" } })).toBe(1);
    expect((await fixture.prisma.projectPhaseState.findUniqueOrThrow({ where: {
      projectId_phase: { projectId: data.projectId, phase: "architecture" } } })).activeRunId).toBeNull();
  });

  test("approved baseline revision keeps approved pointer and historical replay survives authority advance", async () => {
    const data = await setup("arch-c-approved");
    await fixture.approvals.requestArchitectureApproval({ projectId: data.projectId,
      artifactId: data.base.id, expectedHash: hashOf(data.base), actorId: fixture.ownerId });
    await fixture.approvals.approveArchitectureArtifact({ projectId: data.projectId,
      artifactId: data.base.id, expectedHash: hashOf(data.base), actorId: fixture.ownerId });
    const revised = architectureDraft(data.requirements.content.nonFunctionalRequirements[0].id);
    revised.overview.approach = "Approved baseline refinement";
    const gateway = { callStructured: jest.fn().mockResolvedValue(completion(revised)) };
    const service = new PlanningArchitectureGenerationService(fixture.prisma, { gateway });
    const input = request(data, "approved-revision");
    const first = await service.reviseArchitecture(input);
    expect(first.artifact).toMatchObject({ lifecycleStatus: "DRAFT", approved: false });
    const state = await fixture.prisma.projectPhaseState.findUniqueOrThrow({ where: {
      projectId_phase: { projectId: data.projectId, phase: "architecture" } } });
    expect(state.currentApprovedArtifactId).toBe(data.base.id);
    expect(await fixture.prisma.phaseApproval.count({ where: { artifactId: data.base.id, decision: "approved" } })).toBe(1);
    const replay = await service.reviseArchitecture(input);
    expect(replay).toMatchObject({ reused: true, httpStatus: 200, artifact: { id: first.artifact!.id } });
    expect(gateway.callStructured).toHaveBeenCalledTimes(1);
  });

  test("explicit provenance-only rebase binds new upstream identities while stale ordinary revision fails", async () => {
    const data = await setup("arch-c-rebase");
    const nextReq = await fixture.approveNextRequirements(data.projectId, data.requirements.artifact, "arch-c-rebase");
    const nextDocsContent = documentationContent(nextReq.artifact, nextReq.content);
    const nextDocs = await fixture.documentationArtifacts.createSuccessorVersion({
      projectId: data.projectId, actorId: fixture.ownerId, baseArtifactId: data.documentation.id,
      baseContentHash: hashOf(data.documentation), title: "Documentation v2", structuredContent: nextDocsContent,
    });
    await fixture.approvals.requestDocumentationApproval({ projectId: data.projectId, artifactId: nextDocs.id,
      expectedHash: hashOf(nextDocs), actorId: fixture.ownerId });
    await fixture.approvals.approveDocumentationArtifact({ projectId: data.projectId, artifactId: nextDocs.id,
      expectedHash: hashOf(nextDocs), actorId: fixture.ownerId });
    await fixture.prisma.project.update({ where: { id: data.projectId }, data: { currentPhase: "architecture" } });
    const gateway = { callStructured: jest.fn().mockResolvedValue(completion(data.draft)) };
    const service = new PlanningArchitectureGenerationService(fixture.prisma, { gateway });
    const input = request(data, "rebase");
    await expect(service.reviseArchitecture(input)).rejects.toMatchObject({ code: "PLANNING_CONTEXT_CHANGED" });
    expect(gateway.callStructured).toHaveBeenCalledTimes(0);
    const result = await service.reviseArchitecture({ ...input, rebaseToCurrentAuthorities: true });
    expect(result).toMatchObject({ artifact: { version: 2 }, diff: { changedRootSections: [], provenanceChanged: true } });
    expect(result.artifact!.structuredContent).toMatchObject({
      sourceRequirements: { artifactId: nextReq.artifact.id, version: 2 },
      sourceDocumentation: { artifactId: nextDocs.id, version: 2 },
    });
    expect(hashOf(nextReq.artifact)).toBe(hashOf(data.requirements.artifact));
    expect(gateway.callStructured).toHaveBeenCalledTimes(1);
    await expect(service.reviseArchitecture({ ...input, rebaseToCurrentAuthorities: false })).rejects.toMatchObject({ code: "PLANNING_IDEMPOTENCY_CONFLICT" });
    expect((await service.reviseArchitecture({ ...input, rebaseToCurrentAuthorities: true })).httpStatus).toBe(200);
    await fixture.approveNextRequirements(data.projectId, nextReq.artifact, "arch-c-rebase");
    const historical = await service.reviseArchitecture({ ...input, rebaseToCurrentAuthorities: true });
    expect(historical).toMatchObject({ httpStatus: 200, reused: true, artifact: { id: result.artifact!.id } });
    expect(gateway.callStructured).toHaveBeenCalledTimes(1);
  });

  test("same key replays running request; competing AI request and cross-operation reuse conflict", async () => {
    const data = await setup("arch-c-lease");
    const entered = deferred<void>(), release = deferred<void>();
    const revised = architectureDraft(data.requirements.content.nonFunctionalRequirements[0].id);
    revised.overview.approach = "New approach";
    const gateway = { callStructured: jest.fn().mockImplementation(async () => {
      entered.resolve(); await release.promise; return completion(revised);
    }) };
    const service = new PlanningArchitectureGenerationService(fixture.prisma, { gateway });
    const input = request(data, "same-key");
    const pending = service.reviseArchitecture(input);
    await entered.promise;
    await expect(service.reviseArchitecture(input)).resolves.toMatchObject({ httpStatus: 202, reused: true });
    await expect(service.reviseArchitecture({ ...input, instruction: "Different request" })).rejects.toMatchObject({ code: "PLANNING_IDEMPOTENCY_CONFLICT" });
    await expect(service.reviseArchitecture({ ...input, includeMemory: true })).rejects.toMatchObject({ code: "PLANNING_IDEMPOTENCY_CONFLICT" });
    await expect(service.reviseArchitecture({ ...input, idempotencyKey: "other-key" })).rejects.toMatchObject({ code: "PLANNING_GENERATION_IN_PROGRESS" });
    await expect(service.reviseArchitecture({ ...input, operation: "FEEDBACK_APPLICATION" })).rejects.toMatchObject({ code: "PLANNING_IDEMPOTENCY_CONFLICT" });
    release.resolve();
    await expect(pending).resolves.toMatchObject({ httpStatus: 201 });
    expect(gateway.callStructured).toHaveBeenCalledTimes(1);
  });

  test("concurrent human successor terminalizes AI run without creating another artifact", async () => {
    const data = await setup("arch-c-human-race");
    const entered = deferred<void>(), release = deferred<void>();
    const revised = architectureDraft(data.requirements.content.nonFunctionalRequirements[0].id);
    revised.overview.approach = "AI change";
    const gateway = { callStructured: jest.fn().mockImplementation(async () => {
      entered.resolve(); await release.promise; return completion(revised);
    }) };
    const service = new PlanningArchitectureGenerationService(fixture.prisma, { gateway });
    const pending = service.reviseArchitecture(request(data, "human-race"));
    await entered.promise;
    const human = await new PlanningArchitectureArtifactService(fixture.prisma).create({
      projectId: data.projectId, actorId: fixture.ownerId, title: "Human successor",
      baseArtifactId: data.base.id, baseContentHash: hashOf(data.base), structuredContent: revised,
    });
    release.resolve();
    await expect(pending).rejects.toMatchObject({ code: "PLANNING_CONTEXT_CHANGED" });
    expect(await fixture.prisma.phaseArtifact.count({ where: { projectId: data.projectId, phase: "architecture" } })).toBe(2);
    expect(await fixture.prisma.projectPhaseState.findUniqueOrThrow({ where: {
      projectId_phase: { projectId: data.projectId, phase: "architecture" } } })).toMatchObject({ currentArtifactId: human.id, activeRunId: null });
    expect(gateway.callStructured).toHaveBeenCalledTimes(1);
  });

  test("revoked editor access cancels finalization and blocks historical replay", async () => {
    const data = await setup("arch-c-revoked", true);
    const entered = deferred<void>(), release = deferred<void>();
    const revised = architectureDraft(data.requirements.content.nonFunctionalRequirements[0].id);
    revised.overview.approach = "Member change";
    const gateway = { callStructured: jest.fn().mockImplementation(async () => {
      entered.resolve(); await release.promise; return completion(revised);
    }) };
    const service = new PlanningArchitectureGenerationService(fixture.prisma, { gateway });
    const input = { ...request(data, "revoked"), actorId: fixture.memberId };
    const pending = service.reviseArchitecture(input);
    await entered.promise;
    await fixture.prisma.projectMember.delete({ where: { projectId_userId: { projectId: data.projectId, userId: fixture.memberId } } });
    release.resolve();
    await expect(pending).rejects.toMatchObject({ code: "PLANNING_PROJECT_NOT_FOUND" });
    await expect(service.reviseArchitecture(input)).rejects.toMatchObject({ code: "PLANNING_PROJECT_NOT_FOUND" });
    expect(await fixture.prisma.phaseArtifact.count({ where: { projectId: data.projectId, phase: "architecture" } })).toBe(1);
    expect(gateway.callStructured).toHaveBeenCalledTimes(1);
  });

  test("a completed historical result is not disclosed after editor access is revoked", async () => {
    const data = await setup("arch-c-replay-access", true);
    const revised = architectureDraft(data.requirements.content.nonFunctionalRequirements[0].id);
    revised.overview.approach = "Member authored revision";
    const gateway = { callStructured: jest.fn().mockResolvedValue(completion(revised)) };
    const service = new PlanningArchitectureGenerationService(fixture.prisma, { gateway });
    const input = { ...request(data, "member-completed"), actorId: fixture.memberId };
    await expect(service.reviseArchitecture(input)).resolves.toMatchObject({ httpStatus: 201 });
    await fixture.prisma.projectMember.delete({ where: { projectId_userId: { projectId: data.projectId, userId: fixture.memberId } } });
    await expect(service.reviseArchitecture(input)).rejects.toMatchObject({ code: "PLANNING_PROJECT_NOT_FOUND" });
    expect(gateway.callStructured).toHaveBeenCalledTimes(1);
  });

  test.each(["candidate", "phase"])("%s mutation during provider execution conflicts atomically", async (mutation) => {
    const data = await setup(`arch-c-${mutation}`);
    const entered = deferred<void>(), release = deferred<void>();
    const revised = architectureDraft(data.requirements.content.nonFunctionalRequirements[0].id);
    revised.overview.approach = "AI proposal";
    const gateway = { callStructured: jest.fn().mockImplementation(async () => {
      entered.resolve(); await release.promise; return completion(revised);
    }) };
    const service = new PlanningArchitectureGenerationService(fixture.prisma, { gateway });
    const pending = service.reviseArchitecture(request(data, mutation));
    await entered.promise;
    if (mutation === "candidate") await fixture.approvals.requestArchitectureApproval({ projectId: data.projectId,
      artifactId: data.base.id, expectedHash: hashOf(data.base), actorId: fixture.ownerId });
    else await fixture.prisma.project.update({ where: { id: data.projectId }, data: { currentPhase: "implementation" } });
    release.resolve();
    await expect(pending).rejects.toMatchObject({ code: "PLANNING_CONTEXT_CHANGED" });
    expect(await fixture.prisma.phaseArtifact.count({ where: { projectId: data.projectId, phase: "architecture" } })).toBe(1);
    expect((await fixture.prisma.projectPhaseState.findUniqueOrThrow({ where: {
      projectId_phase: { projectId: data.projectId, phase: "architecture" } } })).activeRunId).toBeNull();
    expect(gateway.callStructured).toHaveBeenCalledTimes(1);
  });

  test("provider cannot silently churn a retained stable ID", async () => {
    const data = await setup("arch-c-stable-id");
    const churn = architectureDraft(data.requirements.content.nonFunctionalRequirements[0].id);
    churn.components[0].id = "ARCH-COMP-RENAMED";
    churn.dataDesign.items[0].componentId = "ARCH-COMP-RENAMED";
    churn.interfaceDesign.items[0].componentId = "ARCH-COMP-RENAMED";
    churn.implementationSequence = ["ARCH-COMP-RENAMED"];
    const gateway = { callStructured: jest.fn().mockResolvedValue(completion(churn)) };
    const service = new PlanningArchitectureGenerationService(fixture.prisma, { gateway });
    const input = request(data, "churn");
    await expect(service.reviseArchitecture(input)).rejects.toMatchObject({ code: "PLANNING_AI_INVALID_RESPONSE" });
    await expect(service.reviseArchitecture(input)).rejects.toMatchObject({ code: "PLANNING_AI_INVALID_RESPONSE" });
    expect(await fixture.prisma.phaseArtifact.count({ where: { projectId: data.projectId, phase: "architecture" } })).toBe(1);
    expect(gateway.callStructured).toHaveBeenCalledTimes(1);
  });

  test("modified notes and retargeted references cannot remove an undeclared component", async () => {
    const data = await setup("arch-c-undeclared-rename");
    await fixture.approvals.requestArchitectureApproval({ projectId: data.projectId,
      artifactId: data.base.id, expectedHash: hashOf(data.base), actorId: fixture.ownerId });
    await fixture.approvals.approveArchitectureArtifact({ projectId: data.projectId,
      artifactId: data.base.id, expectedHash: hashOf(data.base), actorId: fixture.ownerId });
    const churn = architectureDraft(data.requirements.content.nonFunctionalRequirements[0].id);
    churn.components[0].id = "ARCH-COMP-NEW";
    churn.components[0].designNotes = "Different transaction policy";
    churn.dataDesign.items[0].componentId = "ARCH-COMP-NEW";
    churn.interfaceDesign.items[0].componentId = "ARCH-COMP-NEW";
    churn.implementationSequence = ["ARCH-COMP-NEW"];
    const gateway = { callStructured: jest.fn().mockResolvedValue(completion(churn)) };
    const service = new PlanningArchitectureGenerationService(fixture.prisma, { gateway });
    const input = request(data, "undeclared-rename");
    await expect(service.reviseArchitecture(input)).rejects.toMatchObject({ code: "PLANNING_AI_INVALID_RESPONSE" });
    const run = await fixture.prisma.workflowRun.findFirstOrThrow({ where: { projectId: data.projectId, operation: "DOCUMENT_REVISION" } });
    expect(run).toMatchObject({ status: "failed", baseArtifactId: data.base.id, outputArtifactId: null, errorCode: "PLANNING_AI_INVALID_RESPONSE" });
    expect(await fixture.prisma.phaseArtifact.count({ where: { projectId: data.projectId, phase: "architecture" } })).toBe(1);
    expect(await fixture.prisma.projectPhaseState.findUniqueOrThrow({ where: {
      projectId_phase: { projectId: data.projectId, phase: "architecture" } }, select: {
      currentArtifactId: true, currentApprovedArtifactId: true, activeRunId: true,
    } })).toEqual({ currentArtifactId: data.base.id, currentApprovedArtifactId: data.base.id, activeRunId: null });
    await expect(service.reviseArchitecture(input)).rejects.toMatchObject({ code: "PLANNING_AI_INVALID_RESPONSE" });
    expect(gateway.callStructured).toHaveBeenCalledTimes(1);
  });

  test("editor-authorized replacement persists and replays exact authorization", async () => {
    const data = await setup("arch-c-authorized-replacement", false, (draft) => {
      draft.components.push({ ...draft.components[0], id: "ARCH-COMP-OLD", name: "Legacy", dependencyIds: [], documentationFeatureIds: [], designNotes: "Legacy notes" });
      draft.implementationSequence.push("ARCH-COMP-OLD");
    });
    const replacement = architectureDraft(data.requirements.content.nonFunctionalRequirements[0].id);
    replacement.components[0].id = "ARCH-COMP-NEW";
    replacement.components[0].designNotes = "New implementation";
    replacement.dataDesign.items[0].componentId = "ARCH-COMP-NEW";
    replacement.interfaceDesign.items[0].componentId = "ARCH-COMP-NEW";
    replacement.implementationSequence = ["ARCH-COMP-NEW"];
    const declaration = { retiredComponentId: "ARCH-COMP-API", replacementComponentId: "ARCH-COMP-NEW" };
    const oldRetirement = { retiredComponentId: "ARCH-COMP-OLD", replacementComponentId: null };
    const declarations = [declaration, oldRetirement];
    const gateway = { callStructured: jest.fn().mockResolvedValue(completion(replacement)) };
    const service = new PlanningArchitectureGenerationService(fixture.prisma, { gateway });
    const input = { ...request(data, "authorized-replacement"), componentRetirements: [oldRetirement, declaration] };
    const result = await service.reviseArchitecture(input);
    expect(result).toMatchObject({ httpStatus: 201, artifact: { version: data.base.version + 1,
      previousVersionId: data.base.id, basedOnArtifactId: data.base.id, lifecycleStatus: "DRAFT" } });
    expect(result.run.contextManifest).toMatchObject({ componentRetirements: declarations });
    expect(result.run.modelUsage).toMatchObject({ componentRetirements: declarations });
    expect(await fixture.prisma.phaseArtifact.count({ where: { projectId: data.projectId, phase: "architecture" } })).toBe(2);
    expect(await fixture.prisma.projectPhaseState.findUniqueOrThrow({ where: {
      projectId_phase: { projectId: data.projectId, phase: "architecture" } }, select: {
      currentArtifactId: true, currentApprovedArtifactId: true, activeRunId: true,
    } })).toEqual({ currentArtifactId: result.artifact!.id, currentApprovedArtifactId: null, activeRunId: null });
    const replay = await service.reviseArchitecture({ ...input, componentRetirements: declarations });
    expect(replay).toMatchObject({ reused: true, httpStatus: 200, artifact: { id: result.artifact!.id },
      run: { id: result.run.id, contextManifest: { componentRetirements: declarations } } });
    await expect(service.reviseArchitecture({ ...input, componentRetirements: [] })).rejects.toMatchObject({ code: "PLANNING_IDEMPOTENCY_CONFLICT" });
    expect(gateway.callStructured).toHaveBeenCalledTimes(1);
    expect(await fixture.prisma.phaseArtifact.count({ where: { projectId: data.projectId, phase: "architecture" } })).toBe(2);
  });

  test("editor-authorized retirement without replacement preserves valid remaining component", async () => {
    const data = await setup("arch-c-retirement", false, (draft) => {
      draft.components.push({ ...draft.components[0], id: "ARCH-COMP-OLD", name: "Legacy", dependencyIds: [], documentationFeatureIds: [], designNotes: "Legacy notes" });
      draft.implementationSequence.push("ARCH-COMP-OLD");
    });
    const revised = architectureDraft(data.requirements.content.nonFunctionalRequirements[0].id);
    const gateway = { callStructured: jest.fn().mockResolvedValue(completion(revised)) };
    const service = new PlanningArchitectureGenerationService(fixture.prisma, { gateway });
    const result = await service.reviseArchitecture({ ...request(data, "retirement"), operation: "FEEDBACK_APPLICATION",
      instruction: "Retire legacy component", componentRetirements: [{ retiredComponentId: "ARCH-COMP-OLD", replacementComponentId: null }] });
    expect(result).toMatchObject({ httpStatus: 201, diff: { removedIds: ["ARCH-COMP-OLD"] },
      artifact: { previousVersionId: data.base.id, basedOnArtifactId: data.base.id } });
    expect(await fixture.prisma.phaseArtifact.count({ where: { projectId: data.projectId, phase: "architecture" } })).toBe(2);
    expect(gateway.callStructured).toHaveBeenCalledTimes(1);
  });

  test("invalid base and unused retirement declarations cannot persist a successor", async () => {
    const data = await setup("arch-c-invalid-retirement");
    const gateway = { callStructured: jest.fn().mockResolvedValue(completion(data.draft)) };
    const service = new PlanningArchitectureGenerationService(fixture.prisma, { gateway });
    await expect(service.reviseArchitecture({ ...request(data, "missing-retirement"), componentRetirements: [
      { retiredComponentId: "ARCH-COMP-MISSING", replacementComponentId: null },
    ] })).rejects.toMatchObject({ code: "PLANNING_ARTIFACT_INVALID" });
    await expect(service.reviseArchitecture({ ...request(data, "unused-retirement"), componentRetirements: [
      { retiredComponentId: "ARCH-COMP-API", replacementComponentId: null },
    ] })).rejects.toMatchObject({ code: "PLANNING_AI_INVALID_RESPONSE" });
    expect(await fixture.prisma.phaseArtifact.count({ where: { projectId: data.projectId, phase: "architecture" } })).toBe(1);
    expect(gateway.callStructured).toHaveBeenCalledTimes(1);
  });

  test.each([
    { family: "dataDesign" as const, oldId: "ARCH-DATA-STATE", newId: "ARCH-DATA-NEW", anchor: "DOC-ENTITY" },
    { family: "interfaceDesign" as const, oldId: "ARCH-IFACE-API", newId: "ARCH-IFACE-NEW", anchor: "DOC-API" },
  ])("$family undeclared replacement with changed fields is rejected before persistence", async ({ family }) => {
    const data = await setup(`arch-c-${family}-undeclared`);
    const gateway = { callStructured: jest.fn().mockResolvedValue(completion(designDraft(data, family, "rename"))) };
    const service = new PlanningArchitectureGenerationService(fixture.prisma, { gateway });
    const input = request(data, `${family}-undeclared`);
    await expect(service.reviseArchitecture(input)).rejects.toMatchObject({ code: "PLANNING_AI_INVALID_RESPONSE" });
    const run = await fixture.prisma.workflowRun.findFirstOrThrow({ where: { projectId: data.projectId, operation: "DOCUMENT_REVISION" } });
    expect(run).toMatchObject({ status: "failed", baseArtifactId: data.base.id, outputArtifactId: null, errorCode: "PLANNING_AI_INVALID_RESPONSE" });
    expect(await fixture.prisma.phaseArtifact.count({ where: { projectId: data.projectId, phase: "architecture" } })).toBe(1);
    expect(await fixture.prisma.projectPhaseState.findUniqueOrThrow({ where: {
      projectId_phase: { projectId: data.projectId, phase: "architecture" } }, select: {
      currentArtifactId: true, currentApprovedArtifactId: true, activeRunId: true,
    } })).toEqual({ currentArtifactId: data.base.id, currentApprovedArtifactId: null, activeRunId: null });
    await expect(service.reviseArchitecture(input)).rejects.toMatchObject({ code: "PLANNING_AI_INVALID_RESPONSE" });
    expect(gateway.callStructured).toHaveBeenCalledTimes(1);
  });

  test.each([
    { family: "dataDesign" as const, oldId: "ARCH-DATA-STATE", newId: "ARCH-DATA-NEW", anchor: "DOC-ENTITY" },
    { family: "interfaceDesign" as const, oldId: "ARCH-IFACE-API", newId: "ARCH-IFACE-NEW", anchor: "DOC-API" },
  ])("$family same-ID edit and authorized replacement preserve Documentation anchors", async ({ family, oldId, newId, anchor }) => {
    const same = await setup(`arch-c-${family}-same-id`);
    const sameGateway = { callStructured: jest.fn().mockResolvedValue(completion(designDraft(same, family, "edit"))) };
    const sameService = new PlanningArchitectureGenerationService(fixture.prisma, { gateway: sameGateway });
    const sameResult = await sameService.reviseArchitecture(request(same, `${family}-same-id`));
    expect(sameResult).toMatchObject({ httpStatus: 201, artifact: { previousVersionId: same.base.id,
      basedOnArtifactId: same.base.id, version: same.base.version + 1 }, diff: { modifiedIds: [oldId] } });
    const sameContent = sameResult.artifact!.structuredContent as unknown as ArchitectureAuthoredDraft;
    expect(sameContent[family].items[0].id).toBe(oldId);
    expect(family === "dataDesign" ? sameContent.dataDesign.items[0].documentationEntityId :
      sameContent.interfaceDesign.items[0].documentationApiId).toBe(anchor);
    expect(await fixture.prisma.phaseArtifact.count({ where: { projectId: same.projectId, phase: "architecture" } })).toBe(2);
    expect(sameGateway.callStructured).toHaveBeenCalledTimes(1);

    const data = await setup(`arch-c-${family}-replacement`);
    const declaration = { section: family, retiredId: oldId, replacementId: newId };
    const gateway = { callStructured: jest.fn().mockResolvedValue(completion(designDraft(data, family, "rename"))) };
    const service = new PlanningArchitectureGenerationService(fixture.prisma, { gateway });
    const input = { ...request(data, `${family}-replacement`), identityRetirements: [declaration] };
    const result = await service.reviseArchitecture(input);
    expect(result).toMatchObject({ httpStatus: 201, artifact: { previousVersionId: data.base.id,
      basedOnArtifactId: data.base.id, version: data.base.version + 1 },
      diff: { addedIds: [newId], removedIds: [oldId] },
      run: { status: "completed", contextManifest: { identityRetirements: [declaration] },
        modelUsage: { identityRetirements: [declaration] } } });
    const content = result.artifact!.structuredContent as unknown as ArchitectureAuthoredDraft;
    expect(family === "dataDesign" ? content.dataDesign.items[0].documentationEntityId :
      content.interfaceDesign.items[0].documentationApiId).toBe(anchor);
    expect(await fixture.prisma.projectPhaseState.findUniqueOrThrow({ where: {
      projectId_phase: { projectId: data.projectId, phase: "architecture" } }, select: {
      currentArtifactId: true, currentApprovedArtifactId: true, activeRunId: true,
    } })).toEqual({ currentArtifactId: result.artifact!.id, currentApprovedArtifactId: null, activeRunId: null });
    expect((await service.reviseArchitecture(input))).toMatchObject({ reused: true, httpStatus: 200,
      artifact: { id: result.artifact!.id }, run: { id: result.run.id, contextManifest: { identityRetirements: [declaration] } } });
    await expect(service.reviseArchitecture({ ...input, identityRetirements: [] })).rejects.toMatchObject({ code: "PLANNING_IDEMPOTENCY_CONFLICT" });
    expect(gateway.callStructured).toHaveBeenCalledTimes(1);
    expect(await fixture.prisma.phaseArtifact.count({ where: { projectId: data.projectId, phase: "architecture" } })).toBe(2);
  });

  test.each([
    { family: "dataDesign" as const, oldId: "ARCH-DATA-STATE" },
    { family: "interfaceDesign" as const, oldId: "ARCH-IFACE-API" },
  ])("$family authorized retirement and invalid declarations", async ({ family, oldId }) => {
    const data = await setup(`arch-c-${family}-retirement`);
    const gateway = { callStructured: jest.fn().mockResolvedValueOnce(completion(data.draft))
      .mockResolvedValueOnce(completion(designDraft(data, family, "invalidAnchor")))
      .mockResolvedValueOnce(completion(designDraft(data, family, "retire"))) };
    const service = new PlanningArchitectureGenerationService(fixture.prisma, { gateway });
    await expect(service.reviseArchitecture({ ...request(data, `${family}-unknown`), identityRetirements: [
      { section: family, retiredId: family === "dataDesign" ? "ARCH-DATA-ABSENT" : "ARCH-IFACE-ABSENT", replacementId: null },
    ] })).rejects.toMatchObject({ code: "PLANNING_ARTIFACT_INVALID" });
    await expect(service.reviseArchitecture({ ...request(data, `${family}-unused`), identityRetirements: [
      { section: family, retiredId: oldId, replacementId: null },
    ] })).rejects.toMatchObject({ code: "PLANNING_AI_INVALID_RESPONSE" });
    await expect(service.reviseArchitecture(request(data, `${family}-bad-anchor`))).rejects.toMatchObject({ code: "PLANNING_AI_INVALID_RESPONSE" });
    const result = await service.reviseArchitecture({ ...request(data, `${family}-retire`), identityRetirements: [
      { section: family, retiredId: oldId, replacementId: null },
    ] });
    expect(result).toMatchObject({ httpStatus: 201, diff: { removedIds: [oldId] }, artifact: {
      previousVersionId: data.base.id, basedOnArtifactId: data.base.id, version: data.base.version + 1 } });
    expect(await fixture.prisma.phaseArtifact.count({ where: { projectId: data.projectId, phase: "architecture" } })).toBe(2);
    expect(gateway.callStructured).toHaveBeenCalledTimes(3);
  });

  test("identity declaration order is irrelevant to immutable request identity", async () => {
    const data = await setup("arch-c-multiple-identities");
    const revised = designDraft(data, "dataDesign", "rename");
    revised.interfaceDesign.items[0].id = "ARCH-IFACE-NEW";
    revised.interfaceDesign.items[0].transport = "gRPC";
    const dataDeclaration = { section: "dataDesign" as const, retiredId: "ARCH-DATA-STATE", replacementId: "ARCH-DATA-NEW" };
    const interfaceDeclaration = { section: "interfaceDesign" as const, retiredId: "ARCH-IFACE-API", replacementId: "ARCH-IFACE-NEW" };
    const gateway = { callStructured: jest.fn().mockResolvedValue(completion(revised)) };
    const service = new PlanningArchitectureGenerationService(fixture.prisma, { gateway });
    const input = { ...request(data, "multiple-identities"), identityRetirements: [interfaceDeclaration, dataDeclaration] };
    const result = await service.reviseArchitecture(input);
    expect(result.run.contextManifest).toMatchObject({ identityRetirements: [dataDeclaration, interfaceDeclaration] });
    expect((await service.reviseArchitecture({ ...input, identityRetirements: [dataDeclaration, interfaceDeclaration] })))
      .toMatchObject({ reused: true, artifact: { id: result.artifact!.id } });
    await expect(service.reviseArchitecture({ ...input, identityRetirements: [dataDeclaration] }))
      .rejects.toMatchObject({ code: "PLANNING_IDEMPOTENCY_CONFLICT" });
    expect(gateway.callStructured).toHaveBeenCalledTimes(1);
    expect(await fixture.prisma.phaseArtifact.count({ where: { projectId: data.projectId, phase: "architecture" } })).toBe(2);
  });

  test("question resolution requires an editor retirement declaration", async () => {
    const data = await setup("arch-c-question-resolution", false, (draft) => {
      draft.unresolvedQuestions.push({ id: "ARCH-Q-OWNER", question: "Who owns deploys?", blocksDecision: false });
    });
    const revised = architectureDraft(data.requirements.content.nonFunctionalRequirements[0].id);
    const gateway = { callStructured: jest.fn().mockResolvedValue(completion(revised)) };
    const service = new PlanningArchitectureGenerationService(fixture.prisma, { gateway });
    await expect(service.reviseArchitecture(request(data, "question-undeclared")))
      .rejects.toMatchObject({ code: "PLANNING_AI_INVALID_RESPONSE" });
    const result = await service.reviseArchitecture({ ...request(data, "question-resolved"), identityRetirements: [
      { section: "unresolvedQuestions", retiredId: "ARCH-Q-OWNER", replacementId: null },
    ] });
    expect(result).toMatchObject({ httpStatus: 201, diff: { removedIds: ["ARCH-Q-OWNER"] },
      artifact: { previousVersionId: data.base.id, basedOnArtifactId: data.base.id } });
    expect(await fixture.prisma.phaseArtifact.count({ where: { projectId: data.projectId, phase: "architecture" } })).toBe(2);
    expect(gateway.callStructured).toHaveBeenCalledTimes(2);
  });
});
