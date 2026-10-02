import { ArtifactActorType, ArtifactChangeKind, PhaseArtifact, Prisma } from "@prisma/client";
import { canonicalJson } from "../../planning/requirements-context";
import {
  DOCUMENTATION_CANONICAL_JSON_MAX_BYTES,
  DOCUMENTATION_SCHEMA_VERSION,
  DocumentationContent,
  hashDocumentationContent,
  renderDocumentationMarkdown,
} from "../../planning/documentation-schema";
import {
  hashRequirementsContent,
  renderRequirementsMarkdown,
} from "../../planning/requirements-schema";
import {
  clone,
  documentationContent,
  DocumentationLifecycleFixture,
  hashOf,
  requirements,
} from "./planning-documentation-test-fixtures";
import { PlanningAuthorizationService } from "../planning-authorization.service";
import { PlanningDocumentationArtifactService } from "../planning-documentation-artifact.service";

const fixture = new DocumentationLifecycleFixture();
beforeAll(() => fixture.start());
afterAll(() => fixture.stop());

function withCanonicalBytes(
  input: DocumentationContent,
  targetBytes: number,
  multibyte = false,
): DocumentationContent {
  const content = clone(input);
  content.overview.summary = "";
  const fixedBytes = Buffer.byteLength(canonicalJson(content), "utf8");
  const remaining = targetBytes - fixedBytes;
  if (remaining < 1) throw new Error("Documentation size target is too small.");
  content.overview.summary = multibyte
    ? `${"é".repeat(Math.floor(remaining / 2))}${"a".repeat(remaining % 2)}`
    : "a".repeat(remaining);
  if (Buffer.byteLength(canonicalJson(content), "utf8") !== targetBytes) {
    throw new Error("Documentation byte fixture did not reach its exact target.");
  }
  return content;
}

async function createInitial(
  projectId: string,
  requirementsArtifact: PhaseArtifact,
  requirementsContent: Parameters<typeof documentationContent>[1],
  actorId = fixture.ownerId,
) {
  return fixture.documentationArtifacts.createInitialArtifact({
    projectId,
    actorId,
    title: "Documentation",
    structuredContent: documentationContent(requirementsArtifact, requirementsContent),
  });
}

describe("Checkpoint 1B Documentation artifact persistence", () => {
  test("authorizes initial creation inside the mutation transaction after membership revocation", async () => {
    const projectId = await fixture.createProject(true);
    const source = await fixture.approveRequirements(projectId, "revoked-editor");
    const input = { projectId, actorId: fixture.memberId, title: "Documentation", structuredContent: documentationContent(source.artifact, source.content) };
    const authorization = new PlanningAuthorizationService(fixture.prisma);
    const staleAccess = await authorization.assertCanEdit(projectId, fixture.memberId);
    const earlierCheck = jest.spyOn(authorization, "assertCanEdit").mockResolvedValue(staleAccess);
    const transactionalCheck = jest.spyOn(authorization, "assertCanEditInTransaction");
    const service = new PlanningDocumentationArtifactService(fixture.prisma, authorization);
    const stateBefore = await fixture.prisma.projectPhaseState.findUniqueOrThrow({ where: { projectId_phase: { projectId, phase: "documentation" } } });
    await fixture.prisma.projectMember.delete({ where: { projectId_userId: { projectId, userId: fixture.memberId } } });

    await expect(service.createInitialArtifact(input)).rejects.toMatchObject({ code: "PLANNING_PROJECT_NOT_FOUND", httpStatus: 404 });
    expect(transactionalCheck).toHaveBeenCalledTimes(1);
    expect(earlierCheck).not.toHaveBeenCalled();
    await expect(service.createInitialArtifact({ ...input, actorId: fixture.outsiderId })).rejects.toMatchObject({ code: "PLANNING_PROJECT_NOT_FOUND", httpStatus: 404 });
    expect(await fixture.prisma.phaseArtifact.count({ where: { projectId, phase: "documentation" } })).toBe(0);
    await expect(fixture.prisma.projectPhaseState.findUniqueOrThrow({ where: { projectId_phase: { projectId, phase: "documentation" } } })).resolves.toMatchObject({
      currentArtifactId: stateBefore.currentArtifactId,
      currentApprovedArtifactId: stateBefore.currentApprovedArtifactId,
      approvalCandidateArtifactId: stateBefore.approvalCandidateArtifactId,
      stateVersion: stateBefore.stateVersion,
    });
  });

  test("creates canonical immutable v1 and advances only the current pointer", async () => {
    const projectId = await fixture.createProject();
    const source = await fixture.approveRequirements(projectId, "initial");
    const input = documentationContent(source.artifact, source.content);
    const artifact = await fixture.documentationArtifacts.createInitialArtifact({
      projectId,
      actorId: fixture.ownerId,
      title: "Documentation v1",
      structuredContent: input,
    });
    expect(artifact).toMatchObject({
      projectId,
      phase: "documentation",
      type: "documentation_doc",
      schemaVersion: DOCUMENTATION_SCHEMA_VERSION,
      version: 1,
      previousVersionId: null,
      basedOnArtifactId: null,
      lifecycleStatus: "DRAFT",
      approved: false,
      content: renderDocumentationMarkdown(input),
      contentHash: hashDocumentationContent(input),
    });
    await expect(fixture.prisma.projectPhaseState.findUniqueOrThrow({
      where: { projectId_phase: { projectId, phase: "documentation" } },
    })).resolves.toMatchObject({
      status: "in_progress",
      currentArtifactId: artifact.id,
      currentApprovedArtifactId: null,
      approvalCandidateArtifactId: null,
    });
    await expect(fixture.prisma.phaseApproval.count({ where: { projectId, phase: "documentation" } })).resolves.toBe(0);
  });

  test("rejects an unapproved Requirements source without partial Documentation state", async () => {
    const projectId = await fixture.createProject();
    const reqContent = requirements("draft-source");
    const req = (await fixture.requirementsArtifacts.createInitialArtifact({
      projectId,
      actorId: fixture.ownerId,
      title: "Draft Requirements",
      structuredContent: reqContent,
    }));
    const input = documentationContent(req, reqContent);
    await expect(fixture.documentationArtifacts.createInitialArtifact({
      projectId,
      actorId: fixture.ownerId,
      title: "Documentation",
      structuredContent: input,
    })).rejects.toMatchObject({ code: "PLANNING_ARTIFACT_INVALID" });
    await expect(fixture.prisma.phaseArtifact.count({ where: { projectId, phase: "documentation" } })).resolves.toBe(0);
  });

  test("rejects stale, cross-project, version-mismatched, and hash-mismatched source authority", async () => {
    const projectA = await fixture.createProject();
    const sourceA = await fixture.approveRequirements(projectA, "source-a");
    const currentA = await fixture.approveNextRequirements(projectA, sourceA.artifact, "source-a-v2");
    const projectB = await fixture.createProject();
    const sourceB = await fixture.approveRequirements(projectB, "source-b");

    const stale = documentationContent(sourceA.artifact, sourceA.content);
    const crossProject = documentationContent(sourceB.artifact, sourceB.content);
    const badVersion = clone(documentationContent(currentA.artifact, currentA.content));
    badVersion.sourceRequirements.version += 1;
    const badHash = clone(documentationContent(currentA.artifact, currentA.content));
    badHash.sourceRequirements.contentHash = "0".repeat(64);

    for (const input of [stale, crossProject, badVersion, badHash]) {
      await expect(fixture.documentationArtifacts.createInitialArtifact({
        projectId: projectA,
        actorId: fixture.ownerId,
        title: "Invalid Documentation",
        structuredContent: input,
      })).rejects.toMatchObject({ code: "PLANNING_ARTIFACT_INVALID" });
    }
    await expect(fixture.prisma.phaseArtifact.count({ where: { projectId: projectA, phase: "documentation" } })).resolves.toBe(0);
  });

  test.each([
    ["wrong phase", { phase: "documentation", type: "requirements_doc", schemaVersion: 1, corrupt: false }],
    ["wrong type", { phase: "requirements", type: "legacy_doc", schemaVersion: 1, corrupt: false }],
    ["wrong schema", { phase: "requirements", type: "requirements_doc", schemaVersion: 99, corrupt: false }],
    ["corrupt canonical content", { phase: "requirements", type: "requirements_doc", schemaVersion: 1, corrupt: true }],
  ])("rejects Requirements authority with %s", async (_label, mutation) => {
    const projectId = await fixture.createProject();
    const source = await fixture.approveRequirements(projectId, `corrupt-${_label}`);
    const contentHash = hashRequirementsContent(source.content);
    const fake = await fixture.prisma.phaseArtifact.create({
      data: {
        projectId,
        phase: mutation.phase,
        type: mutation.type,
        title: "Corrupt authority",
        content: renderRequirementsMarkdown(source.content),
        structuredContent: (mutation.corrupt ? { broken: true } : source.content) as Prisma.InputJsonValue,
        schemaVersion: mutation.schemaVersion,
        contentHash,
        version: 2,
        createdBy: fixture.ownerId,
        lifecycleStatus: "APPROVED",
        approved: true,
        approvedAt: new Date(),
      },
    });
    await fixture.prisma.phaseApproval.create({ data: { projectId, phase: "requirements", artifactId: fake.id, artifactVersion: fake.version, artifactContentHash: contentHash, approvedById: fixture.ownerId, decision: "approved" } });
    await fixture.prisma.projectPhaseState.update({ where: { projectId_phase: { projectId, phase: "requirements" } }, data: { currentApprovedArtifactId: fake.id } });
    const input = clone(documentationContent(source.artifact, source.content));
    input.sourceRequirements = { artifactId: fake.id, version: fake.version, contentHash };
    await expect(fixture.documentationArtifacts.createInitialArtifact({
      projectId,
      actorId: fixture.ownerId,
      title: "Documentation",
      structuredContent: input,
    })).rejects.toMatchObject({ code: "PLANNING_ARTIFACT_INVALID" });
    await expect(fixture.prisma.phaseArtifact.count({ where: { projectId, phase: "documentation", type: "documentation_doc" } })).resolves.toBe(0);
  });

  test("creates an exact linear successor and preserves prior approved authority", async () => {
    const projectId = await fixture.createProject();
    const source = await fixture.approveRequirements(projectId, "lineage");
    const v1 = await createInitial(projectId, source.artifact, source.content);
    await fixture.approvals.requestDocumentationApproval({ projectId, artifactId: v1.id, expectedHash: hashOf(v1), actorId: fixture.ownerId });
    await fixture.approvals.approveDocumentationArtifact({ projectId, artifactId: v1.id, expectedHash: hashOf(v1), actorId: fixture.ownerId });
    const v2 = await fixture.documentationArtifacts.createSuccessorVersion({
      projectId,
      actorId: fixture.ownerId,
      baseArtifactId: v1.id,
      baseContentHash: hashOf(v1),
      structuredContent: documentationContent(source.artifact, source.content),
      createdByType: ArtifactActorType.AI,
      changeKind: ArtifactChangeKind.AI_DOCUMENT_REVISION,
    });
    expect(v2).toMatchObject({ version: 2, previousVersionId: v1.id, basedOnArtifactId: v1.id, lifecycleStatus: "DRAFT", approved: false, createdByType: "AI" });
    await expect(fixture.prisma.projectPhaseState.findUniqueOrThrow({
      where: { projectId_phase: { projectId, phase: "documentation" } },
    })).resolves.toMatchObject({ currentArtifactId: v2.id, currentApprovedArtifactId: v1.id, approvalCandidateArtifactId: null });
    await expect(fixture.prisma.phaseArtifact.findUniqueOrThrow({ where: { id: v1.id } })).resolves.toMatchObject({ lifecycleStatus: "APPROVED", approved: true });
  });

  test("rejects stale base ID and wrong base hash without creating a successor", async () => {
    const projectId = await fixture.createProject();
    const source = await fixture.approveRequirements(projectId, "stale-base");
    const v1 = await createInitial(projectId, source.artifact, source.content);
    const v2 = await fixture.documentationArtifacts.createSuccessorVersion({ projectId, actorId: fixture.ownerId, baseArtifactId: v1.id, baseContentHash: hashOf(v1), structuredContent: documentationContent(source.artifact, source.content) });
    await expect(fixture.documentationArtifacts.createSuccessorVersion({ projectId, actorId: fixture.ownerId, baseArtifactId: v1.id, baseContentHash: hashOf(v1), structuredContent: documentationContent(source.artifact, source.content) })).rejects.toMatchObject({ code: "PLANNING_ARTIFACT_BASE_CHANGED" });
    await expect(fixture.documentationArtifacts.createSuccessorVersion({ projectId, actorId: fixture.ownerId, baseArtifactId: v2.id, baseContentHash: "0".repeat(64), structuredContent: documentationContent(source.artifact, source.content) })).rejects.toMatchObject({ code: "PLANNING_ARTIFACT_BASE_CHANGED" });
    await expect(fixture.prisma.phaseArtifact.count({ where: { projectId, phase: "documentation" } })).resolves.toBe(2);
  });

  test("serializes simultaneous initial creation attempts", async () => {
    const projectId = await fixture.createProject();
    const source = await fixture.approveRequirements(projectId, "concurrent-initial");
    const operation = () => createInitial(projectId, source.artifact, source.content);
    const results = await Promise.allSettled([operation(), operation()]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    await expect(fixture.prisma.phaseArtifact.count({ where: { projectId, phase: "documentation" } })).resolves.toBe(1);
  });

  test("serializes simultaneous successors from one base", async () => {
    const projectId = await fixture.createProject();
    const source = await fixture.approveRequirements(projectId, "concurrent-successor");
    const v1 = await createInitial(projectId, source.artifact, source.content);
    const operation = () => fixture.documentationArtifacts.createSuccessorVersion({ projectId, actorId: fixture.ownerId, baseArtifactId: v1.id, baseContentHash: hashOf(v1), structuredContent: documentationContent(source.artifact, source.content) });
    const results = await Promise.allSettled([operation(), operation()]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    const versions = await fixture.prisma.phaseArtifact.findMany({ where: { projectId, phase: "documentation" }, orderBy: { version: "asc" }, select: { version: true } });
    expect(versions.map(({ version }) => version)).toEqual([1, 2]);
  });

  test("enforces exact, one-byte overflow, and multibyte overflow at the service boundary", async () => {
    const exactProject = await fixture.createProject();
    const exactSource = await fixture.approveRequirements(exactProject, "size-exact");
    const exact = withCanonicalBytes(documentationContent(exactSource.artifact, exactSource.content), DOCUMENTATION_CANONICAL_JSON_MAX_BYTES);
    const artifact = await fixture.documentationArtifacts.createInitialArtifact({ projectId: exactProject, actorId: fixture.ownerId, title: "Exact", structuredContent: exact });
    expect(Buffer.byteLength(canonicalJson(artifact.structuredContent), "utf8")).toBe(DOCUMENTATION_CANONICAL_JSON_MAX_BYTES);

    for (const multibyte of [false, true]) {
      const projectId = await fixture.createProject();
      const source = await fixture.approveRequirements(projectId, multibyte ? "size-multibyte" : "size-overflow");
      const oversized = withCanonicalBytes(documentationContent(source.artifact, source.content), DOCUMENTATION_CANONICAL_JSON_MAX_BYTES + 1, multibyte);
      await expect(fixture.documentationArtifacts.createInitialArtifact({ projectId, actorId: fixture.ownerId, title: "Too large", structuredContent: oversized })).rejects.toMatchObject({ code: "PLANNING_INPUT_TOO_LARGE", httpStatus: 413 });
      await expect(fixture.prisma.phaseArtifact.count({ where: { projectId, phase: "documentation" } })).resolves.toBe(0);
    }
  });

  test("retry exhaustion returns a sanitized concurrency error", async () => {
    const projectId = await fixture.createProject();
    const source = await fixture.approveRequirements(projectId, "retry");
    const v1 = await createInitial(projectId, source.artifact, source.content);
    const marker = "RAW_DOCUMENTATION_PRISMA_SECRET";
    const retryable = new Prisma.PrismaClientKnownRequestError(marker, { code: "P2034", clientVersion: "5.22.0" });
    const transactionSpy = jest.spyOn(fixture.prisma, "$transaction").mockRejectedValue(retryable);
    let caught: unknown;
    let transactionCalls = 0;
    try {
      await fixture.documentationArtifacts.createSuccessorVersion({
        projectId,
        actorId: fixture.ownerId,
        baseArtifactId: v1.id,
        baseContentHash: hashOf(v1),
        structuredContent: documentationContent(source.artifact, source.content),
      });
    } catch (error) {
      caught = error;
    } finally {
      transactionCalls = transactionSpy.mock.calls.length;
      transactionSpy.mockRestore();
    }
    expect(caught).toMatchObject({
      code: "PLANNING_CONCURRENT_UPDATE",
      httpStatus: 409,
      message: "Documentation changed concurrently; reload the current version and retry.",
    });
    expect((caught as Error).message).not.toContain(marker);
    expect(transactionCalls).toBe(3);
    await expect(fixture.prisma.phaseArtifact.count({ where: { projectId, phase: "documentation" } })).resolves.toBe(1);
  });
});
