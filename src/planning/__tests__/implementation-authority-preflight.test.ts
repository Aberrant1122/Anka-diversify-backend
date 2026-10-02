import { architectureDraft } from "./architecture-test-fixtures";
import { PlanningArchitectureArtifactService } from "../../services/planning-architecture-artifact.service";
import { DocumentationLifecycleFixture, documentationContent, hashOf } from "../../services/__tests__/planning-documentation-test-fixtures";
import { currentImplementationAuthority } from "../implementation-authority-preflight";

const fixture = new DocumentationLifecycleFixture();
beforeAll(() => fixture.start());
afterAll(() => fixture.stop());

async function chain(label: string, member = false) {
  const projectId = await fixture.createProject(member);
  const requirements = await fixture.approveRequirements(projectId, label);
  const docs = documentationContent(requirements.artifact, requirements.content);
  const documentation = await fixture.documentationArtifacts.createInitialArtifact({ projectId, actorId: fixture.ownerId,
    title: "Documentation", structuredContent: docs });
  await fixture.approvals.requestDocumentationApproval({ projectId, artifactId: documentation.id,
    expectedHash: hashOf(documentation), actorId: fixture.ownerId });
  await fixture.approvals.approveDocumentationArtifact({ projectId, artifactId: documentation.id,
    expectedHash: hashOf(documentation), actorId: fixture.ownerId });
  const architecture = await new PlanningArchitectureArtifactService(fixture.prisma).create({ projectId, actorId: fixture.ownerId,
    title: "Architecture", structuredContent: architectureDraft(requirements.content.nonFunctionalRequirements[0].id) });
  return { projectId, architecture, requirements, documentation };
}

describe("Implementation authority preflight on disposable PostgreSQL", () => {
  test("active project member may execute; inactive member may not", async () => {
    const data = await chain("impl-member", true);
    await fixture.approvals.requestArchitectureApproval({ projectId: data.projectId, artifactId: data.architecture.id,
      expectedHash: hashOf(data.architecture), actorId: fixture.ownerId });
    await fixture.approvals.approveArchitectureArtifact({ projectId: data.projectId, artifactId: data.architecture.id,
      expectedHash: hashOf(data.architecture), actorId: fixture.ownerId });
    expect((await currentImplementationAuthority(fixture.prisma, data.projectId, fixture.memberId)).actorId).toBe(fixture.memberId);
    await fixture.prisma.user.update({ where: { id: fixture.memberId }, data: { status: "inactive" } });
    await expect(currentImplementationAuthority(fixture.prisma, data.projectId, fixture.memberId))
      .rejects.toMatchObject({ code: "PLANNING_FORBIDDEN" });
  });

  test.each(["requirements", "documentation"])("rejects a missing %s approval decision", async (phase) => {
    const data = await chain(`impl-missing-${phase}`);
    await fixture.approvals.requestArchitectureApproval({ projectId: data.projectId, artifactId: data.architecture.id,
      expectedHash: hashOf(data.architecture), actorId: fixture.ownerId });
    await fixture.approvals.approveArchitectureArtifact({ projectId: data.projectId, artifactId: data.architecture.id,
      expectedHash: hashOf(data.architecture), actorId: fixture.ownerId });
    await fixture.prisma.phaseApproval.deleteMany({ where: { projectId: data.projectId, phase, decision: "approved" } });
    await expect(currentImplementationAuthority(fixture.prisma, data.projectId, fixture.ownerId))
      .rejects.toMatchObject({ code: "PLANNING_ARTIFACT_INVALID" });
  });

  test("rejects a cross-project approved pointer", async () => {
    const first = await chain("impl-pointer-one");
    const second = await chain("impl-pointer-two");
    await fixture.approvals.requestArchitectureApproval({ projectId: first.projectId, artifactId: first.architecture.id,
      expectedHash: hashOf(first.architecture), actorId: fixture.ownerId });
    await fixture.approvals.approveArchitectureArtifact({ projectId: first.projectId, artifactId: first.architecture.id,
      expectedHash: hashOf(first.architecture), actorId: fixture.ownerId });
    await fixture.prisma.projectPhaseState.update({ where: { projectId_phase: { projectId: first.projectId, phase: "documentation" } },
      data: { currentApprovedArtifactId: second.documentation.id } });
    await expect(currentImplementationAuthority(fixture.prisma, first.projectId, fixture.ownerId))
      .rejects.toMatchObject({ code: "PLANNING_ARTIFACT_INVALID" });
  });

  test("valid exact approved chain and rejection of missing Architecture approval", async () => {
    const data = await chain("impl-valid");
    await expect(currentImplementationAuthority(fixture.prisma, data.projectId, fixture.ownerId)).rejects.toMatchObject({ code: "PLANNING_ACTION_LOCKED" });
    await fixture.approvals.requestArchitectureApproval({ projectId: data.projectId, artifactId: data.architecture.id,
      expectedHash: hashOf(data.architecture), actorId: fixture.ownerId });
    await fixture.approvals.approveArchitectureArtifact({ projectId: data.projectId, artifactId: data.architecture.id,
      expectedHash: hashOf(data.architecture), actorId: fixture.ownerId });
    const authority = await currentImplementationAuthority(fixture.prisma, data.projectId, fixture.ownerId);
    expect(authority).toMatchObject({ architecture: { artifact: { id: data.architecture.id } },
      requirements: { artifact: { id: data.requirements.artifact.id } },
      documentation: { artifact: { id: data.documentation.id } } });
    expect(authority.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    await expect(currentImplementationAuthority(fixture.prisma, data.projectId, fixture.outsiderId)).rejects.toMatchObject({ code: "PLANNING_PROJECT_NOT_FOUND" });
    await fixture.prisma.phaseApproval.deleteMany({ where: { projectId: data.projectId, phase: "architecture", artifactId: data.architecture.id } });
    await expect(currentImplementationAuthority(fixture.prisma, data.projectId, fixture.ownerId)).rejects.toMatchObject({ code: "PLANNING_ARTIFACT_INVALID" });
  });

  test("Architecture successor makes the older approved pointer ineligible", async () => {
    const data = await chain("impl-successor");
    await fixture.approvals.requestArchitectureApproval({ projectId: data.projectId, artifactId: data.architecture.id,
      expectedHash: hashOf(data.architecture), actorId: fixture.ownerId });
    await fixture.approvals.approveArchitectureArtifact({ projectId: data.projectId, artifactId: data.architecture.id,
      expectedHash: hashOf(data.architecture), actorId: fixture.ownerId });
    const draft = architectureDraft(data.requirements.content.nonFunctionalRequirements[0].id);
    draft.overview.approach = "Revised approach";
    await new PlanningArchitectureArtifactService(fixture.prisma).create({ projectId: data.projectId, actorId: fixture.ownerId,
      title: "Architecture successor", structuredContent: draft, baseArtifactId: data.architecture.id,
      baseContentHash: hashOf(data.architecture) });
    await expect(currentImplementationAuthority(fixture.prisma, data.projectId, fixture.ownerId)).rejects.toMatchObject({ code: "PLANNING_ACTION_LOCKED" });
  });
});
