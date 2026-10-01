import { preflightArchitectureHandoff } from "../../planning/documentation-architecture-preflight";
import { architectureDraft } from "../../planning/__tests__/architecture-test-fixtures";
import { PlanningArchitectureArtifactService } from "../planning-architecture-artifact.service";
import { ARCHITECTURE_CANONICAL_JSON_MAX_BYTES } from "../../planning/architecture-schema";
import { PhaseService } from "../phase-service";
import { DocumentationLifecycleFixture, documentationContent, hashOf } from "./planning-documentation-test-fixtures";

const fixture = new DocumentationLifecycleFixture();
const architectures = new PlanningArchitectureArtifactService(fixture.prisma);
beforeAll(() => fixture.start());
afterAll(() => fixture.stop());

async function setup(label: string, member = false) {
  const projectId = await fixture.createProject(member);
  const requirements = await fixture.approveRequirements(projectId, label);
  const docs = documentationContent(requirements.artifact, requirements.content);
  const documentation = await fixture.documentationArtifacts.createInitialArtifact({ projectId, actorId: fixture.ownerId, title: "Documentation", structuredContent: docs });
  await fixture.approvals.requestDocumentationApproval({ projectId, artifactId: documentation.id, expectedHash: hashOf(documentation), actorId: fixture.ownerId });
  await fixture.approvals.approveDocumentationArtifact({ projectId, artifactId: documentation.id, expectedHash: hashOf(documentation), actorId: fixture.ownerId });
  return { projectId, requirements, documentation, docs };
}

describe("Architecture real PostgreSQL authority and human lifecycle", () => {
  test("real Prisma preflight selects approvedAt and validates approved upstream", async () => {
    const { projectId, requirements, documentation } = await setup("preflight-real");
    const authority = await preflightArchitectureHandoff(fixture.prisma, projectId);
    expect(authority.requirements.artifact.id).toBe(requirements.artifact.id);
    expect(authority.documentation.artifact.id).toBe(documentation.id);
    expect(authority.documentation.approvalId).toBeTruthy();
  });

  test("manual v1, owner approval and transition, successor preserves approved pointer", async () => {
    const { projectId, requirements, documentation } = await setup("arch-lifecycle", true);
    const draft = architectureDraft(requirements.content.nonFunctionalRequirements[0].id);
    const v1 = await architectures.create({ projectId, actorId: fixture.memberId, title: "Architecture", structuredContent: draft });
    expect(v1).toMatchObject({ version: 1, lifecycleStatus: "DRAFT", approved: false, changeKind: "MANUAL_EDIT" });
    expect((v1.structuredContent as any).sourceRequirements.artifactId).toBe(requirements.artifact.id);
    expect((v1.structuredContent as any).sourceDocumentation.artifactId).toBe(documentation.id);
    await expect(architectures.create({ projectId, actorId: fixture.ownerId, title: "Duplicate", structuredContent: draft })).rejects.toMatchObject({ code: "PLANNING_ACTION_LOCKED" });
    const readiness = await architectures.getReadiness(projectId, v1.id, fixture.ownerId);
    expect(readiness).toMatchObject({ ready: true, blockers: [] });
    await fixture.approvals.requestArchitectureApproval({ projectId, artifactId: v1.id, expectedHash: hashOf(v1), actorId: fixture.memberId });
    await expect(fixture.approvals.approveArchitectureArtifact({ projectId, artifactId: v1.id, expectedHash: hashOf(v1), actorId: fixture.memberId })).rejects.toMatchObject({ code: "PLANNING_OWNER_REQUIRED" });
    const approved = await fixture.approvals.approveArchitectureArtifact({ projectId, artifactId: v1.id, expectedHash: hashOf(v1), actorId: fixture.ownerId });
    expect(approved).toMatchObject({ status: "approved", currentApprovedArtifactId: v1.id });
    await expect(fixture.prisma.project.findUniqueOrThrow({ where: { id: projectId } })).resolves.toMatchObject({ currentPhase: "implementation" });
    await expect(fixture.prisma.projectPhaseState.findUniqueOrThrow({ where: { projectId_phase: { projectId, phase: "implementation" } } })).resolves.toMatchObject({ status: "not_started", currentArtifactId: null });
    await expect(fixture.prisma.phaseArtifact.count({ where: { projectId, phase: "implementation" } })).resolves.toBe(0);
    await expect(fixture.prisma.phaseApproval.findFirstOrThrow({ where: { artifactId: v1.id, decision: "approved" } })).resolves.toMatchObject({ artifactVersion: 1, artifactContentHash: hashOf(v1), legacyUnverified: false });
    const v2 = await architectures.create({ projectId, actorId: fixture.ownerId, title: "Architecture v2", structuredContent: draft, baseArtifactId: v1.id, baseContentHash: hashOf(v1) });
    expect(v2).toMatchObject({ version: 2, basedOnArtifactId: v1.id, previousVersionId: v1.id, lifecycleStatus: "DRAFT" });
    await expect(fixture.prisma.projectPhaseState.findUniqueOrThrow({ where: { projectId_phase: { projectId, phase: "architecture" } } })).resolves.toMatchObject({ currentArtifactId: v2.id, currentApprovedArtifactId: v1.id });
    await fixture.approvals.requestArchitectureApproval({ projectId, artifactId: v2.id, expectedHash: hashOf(v2), actorId: fixture.ownerId });
    const changed = await fixture.approvals.requestArchitectureChanges({ projectId, artifactId: v2.id, expectedHash: hashOf(v2), actorId: fixture.ownerId, comments: "Clarify boundary." });
    expect(changed).toMatchObject({ status: "changes_requested", currentApprovedArtifactId: v1.id, approvalCandidateArtifactId: null });
    await expect(fixture.approvals.approveArchitectureArtifact({ projectId, artifactId: v2.id, expectedHash: hashOf(v2), actorId: fixture.ownerId })).rejects.toMatchObject({ code: "PLANNING_ARTIFACT_NOT_CANDIDATE" });
  });

  test("blocking question prevents approval, nonblocking question warns", async () => {
    const { projectId, requirements } = await setup("arch-questions");
    const draft = architectureDraft(requirements.content.nonFunctionalRequirements[0].id);
    draft.unresolvedQuestions = [{ id: "ARCH-Q-ONE", question: "Decision?", blocksDecision: true }];
    const artifact = await architectures.create({ projectId, actorId: fixture.ownerId, title: "Questions", structuredContent: draft });
    await expect(fixture.approvals.requestArchitectureApproval({ projectId, artifactId: artifact.id, expectedHash: hashOf(artifact), actorId: fixture.ownerId })).rejects.toMatchObject({ code: "PLANNING_READINESS_BLOCKED" });
    const warnings = architectureDraft(requirements.content.nonFunctionalRequirements[0].id); warnings.unresolvedQuestions = [{ id: "ARCH-Q-TWO", question: "Follow up?", blocksDecision: false }];
    const successor = await architectures.create({ projectId, actorId: fixture.ownerId, title: "Warnings", structuredContent: warnings, baseArtifactId: artifact.id, baseContentHash: hashOf(artifact) });
    expect((await architectures.getReadiness(projectId, successor.id, fixture.ownerId)).warnings).toHaveLength(1);
    await expect(fixture.approvals.requestArchitectureApproval({ projectId, artifactId: successor.id, expectedHash: hashOf(successor), actorId: fixture.ownerId })).resolves.toMatchObject({ status: "awaiting_approval" });
  });

  test("UTF-8 canonical byte limit and server-owned roots are enforced", async () => {
    const { projectId, requirements } = await setup("arch-size");
    const draft = architectureDraft(requirements.content.nonFunctionalRequirements[0].id);
    (draft as any).sourceDocumentation = { artifactId: "forged", version: 1, contentHash: "0".repeat(64) };
    await expect(architectures.create({ projectId, actorId: fixture.ownerId, title: "Forged", structuredContent: draft })).rejects.toMatchObject({ code: "PLANNING_ARTIFACT_INVALID" });
    delete (draft as any).sourceDocumentation;
    draft.components[0].designNotes = "🚀".repeat(Math.ceil(ARCHITECTURE_CANONICAL_JSON_MAX_BYTES / 4));
    await expect(architectures.create({ projectId, actorId: fixture.ownerId, title: "Too large", structuredContent: draft })).rejects.toMatchObject({ code: "PLANNING_INPUT_TOO_LARGE" });
  });

  test("legacy Architecture run and artifactless start cannot bypass workflow", async () => {
    const { projectId } = await setup("arch-routes");
    const phase = new PhaseService(fixture.prisma);
    await expect(phase.runAutomatedPhase(projectId, "architecture", fixture.ownerId)).rejects.toMatchObject({ code: "PLANNING_ACTION_LOCKED" });
    await expect(phase.startPhase(projectId, "architecture", fixture.ownerId)).rejects.toMatchObject({ code: "PLANNING_ACTION_LOCKED" });
    await expect(fixture.prisma.phaseArtifact.count({ where: { projectId, phase: "architecture" } })).resolves.toBe(0);
    await expect(fixture.prisma.workflowRun.count({ where: { projectId, currentPhase: "architecture" } })).resolves.toBe(0);
  });

  test("cross-project base is hidden and concurrent initial creation has one winner", async () => {
    const first = await setup("arch-concurrent");
    const second = await setup("arch-cross");
    const firstDraft = architectureDraft(first.requirements.content.nonFunctionalRequirements[0].id);
    const results = await Promise.allSettled([1, 2].map(() => architectures.create({ projectId: first.projectId, actorId: fixture.ownerId, title: "Concurrent", structuredContent: firstDraft })));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const winner = results.find((result) => result.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof architectures.create>>>;
    await architectures.create({ projectId: second.projectId, actorId: fixture.ownerId, title: "Second", structuredContent: architectureDraft(second.requirements.content.nonFunctionalRequirements[0].id) });
    await expect(architectures.create({ projectId: second.projectId, actorId: fixture.ownerId, title: "Cross", structuredContent: architectureDraft(second.requirements.content.nonFunctionalRequirements[0].id), baseArtifactId: winner.value.id, baseContentHash: hashOf(winner.value) })).rejects.toMatchObject({ code: "PLANNING_ARTIFACT_PROJECT_MISMATCH" });
  });

  test("stale upstream Requirements or Documentation blocks Architecture approval", async () => {
    const first = await setup("arch-stale-req");
    const firstArtifact = await architectures.create({ projectId: first.projectId, actorId: fixture.ownerId, title: "Architecture", structuredContent: architectureDraft(first.requirements.content.nonFunctionalRequirements[0].id) });
    await fixture.approveNextRequirements(first.projectId, first.requirements.artifact, "arch-stale-req-next");
    await expect(fixture.approvals.requestArchitectureApproval({ projectId: first.projectId, artifactId: firstArtifact.id, expectedHash: hashOf(firstArtifact), actorId: fixture.ownerId })).rejects.toMatchObject({ code: "PLANNING_ACTION_LOCKED" });

    const second = await setup("arch-stale-doc");
    const secondArtifact = await architectures.create({ projectId: second.projectId, actorId: fixture.ownerId, title: "Architecture", structuredContent: architectureDraft(second.requirements.content.nonFunctionalRequirements[0].id) });
    const nextDoc = await fixture.documentationArtifacts.createSuccessorVersion({ projectId: second.projectId, actorId: fixture.ownerId, baseArtifactId: second.documentation.id, baseContentHash: hashOf(second.documentation), title: "Documentation v2", structuredContent: second.docs });
    await fixture.approvals.requestDocumentationApproval({ projectId: second.projectId, artifactId: nextDoc.id, expectedHash: hashOf(nextDoc), actorId: fixture.ownerId });
    await fixture.approvals.approveDocumentationArtifact({ projectId: second.projectId, artifactId: nextDoc.id, expectedHash: hashOf(nextDoc), actorId: fixture.ownerId });
    await expect(fixture.approvals.requestArchitectureApproval({ projectId: second.projectId, artifactId: secondArtifact.id, expectedHash: hashOf(secondArtifact), actorId: fixture.ownerId })).rejects.toMatchObject({ code: "PLANNING_ACTION_LOCKED" });
  });

  test("revoked editor cannot create, and missing feature ownership blocks readiness", async () => {
    const setupResult = await setup("arch-auth", true);
    await fixture.prisma.projectMember.deleteMany({ where: { projectId: setupResult.projectId, userId: fixture.memberId } });
    const draft = architectureDraft(setupResult.requirements.content.nonFunctionalRequirements[0].id);
    await expect(architectures.create({ projectId: setupResult.projectId, actorId: fixture.memberId, title: "Denied", structuredContent: draft })).rejects.toMatchObject({ code: "PLANNING_PROJECT_NOT_FOUND" });
    draft.components[0].documentationFeatureIds = [];
    const artifact = await architectures.create({ projectId: setupResult.projectId, actorId: fixture.ownerId, title: "Unowned", structuredContent: draft });
    await expect(fixture.approvals.requestArchitectureApproval({ projectId: setupResult.projectId, artifactId: artifact.id, expectedHash: hashOf(artifact), actorId: fixture.ownerId })).rejects.toMatchObject({ code: "PLANNING_READINESS_BLOCKED" });
  });

  test("database rejects content mutation and preserves approval pointers", async () => {
    const { projectId, requirements } = await setup("arch-corrupt");
    const artifact = await architectures.create({ projectId, actorId: fixture.ownerId, title: "Architecture", structuredContent: architectureDraft(requirements.content.nonFunctionalRequirements[0].id) });
    await expect(fixture.prisma.phaseArtifact.update({ where: { id: artifact.id }, data: { content: "corrupt" } })).rejects.toThrow(/immutable/);
    await expect(fixture.prisma.projectPhaseState.findUniqueOrThrow({ where: { projectId_phase: { projectId, phase: "architecture" } } })).resolves.toMatchObject({ status: "in_progress", approvalCandidateArtifactId: null, currentApprovedArtifactId: null });
  });

  test("concurrent successors have one winner and preserve approved authority", async () => {
    const { projectId, requirements } = await setup("arch-successor-race");
    const draft = architectureDraft(requirements.content.nonFunctionalRequirements[0].id);
    const v1 = await architectures.create({ projectId, actorId: fixture.ownerId, title: "Architecture", structuredContent: draft });
    await fixture.approvals.requestArchitectureApproval({ projectId, artifactId: v1.id, expectedHash: hashOf(v1), actorId: fixture.ownerId });
    await fixture.approvals.approveArchitectureArtifact({ projectId, artifactId: v1.id, expectedHash: hashOf(v1), actorId: fixture.ownerId });
    const results = await Promise.allSettled([1, 2].map(() => architectures.create({ projectId, actorId: fixture.ownerId, title: "Successor", structuredContent: draft, baseArtifactId: v1.id, baseContentHash: hashOf(v1) })));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    await expect(fixture.prisma.projectPhaseState.findUniqueOrThrow({ where: { projectId_phase: { projectId, phase: "architecture" } } })).resolves.toMatchObject({ currentApprovedArtifactId: v1.id });
    await expect(fixture.prisma.phaseArtifact.count({ where: { projectId, phase: "architecture", version: 2 } })).resolves.toBe(1);
  });
});
