import { Prisma } from "@prisma/client";
import {
  DOCUMENTATION_CANONICAL_JSON_MAX_BYTES,
  DocumentationContent,
} from "../../planning/documentation-schema";
import { canonicalJson } from "../../planning/requirements-context";
import {
  clone,
  documentationContent,
  documentationDraft,
  DocumentationLifecycleFixture,
  hashOf,
} from "./planning-documentation-test-fixtures";
import { PhaseService } from "../phase-service";

const fixture = new DocumentationLifecycleFixture();
beforeAll(() => fixture.start());
afterAll(() => fixture.stop());

async function setupDocumentation(label: string, member = false) {
  const projectId = await fixture.createProject(member);
  const source = await fixture.approveRequirements(projectId, label);
  const content = documentationContent(source.artifact, source.content);
  const artifact = await fixture.documentationArtifacts.createInitialArtifact({
    projectId,
    actorId: fixture.ownerId,
    title: "Documentation",
    structuredContent: content,
  });
  return { projectId, source, content, artifact };
}

function oversized(input: DocumentationContent): DocumentationContent {
  const content = clone(input);
  content.overview.summary = "";
  const fixed = Buffer.byteLength(canonicalJson(content), "utf8");
  content.overview.summary = "x".repeat(DOCUMENTATION_CANONICAL_JSON_MAX_BYTES + 1 - fixed);
  return content;
}

describe("Checkpoint 1B Documentation approval lifecycle", () => {
  test("member requests approval; owner approves exact authority and seeds Architecture", async () => {
    const setup = await setupDocumentation("approve", true);
    const phases = new PhaseService(fixture.prisma);
    const requested = await phases.requestApproval(
      setup.projectId, "documentation", setup.artifact.id, hashOf(setup.artifact), fixture.memberId,
    );
    expect(requested).toMatchObject({
      status: "awaiting_approval",
      currentArtifactId: setup.artifact.id,
      currentApprovedArtifactId: null,
      approvalCandidateArtifactId: setup.artifact.id,
    });
    await expect(fixture.prisma.phaseApproval.count({ where: { projectId: setup.projectId, phase: "documentation" } })).resolves.toBe(0);

    const approved = await phases.approvePhase(
      setup.projectId, "documentation", setup.artifact.id, hashOf(setup.artifact), fixture.ownerId, "Approved.",
    );
    expect(approved).toMatchObject({ status: "approved", currentApprovedArtifactId: setup.artifact.id, approvalCandidateArtifactId: null });
    await expect(fixture.prisma.phaseArtifact.findUniqueOrThrow({ where: { id: setup.artifact.id } })).resolves.toMatchObject({ lifecycleStatus: "APPROVED", approved: true, supersededAt: null });
    await expect(fixture.prisma.phaseApproval.findFirstOrThrow({ where: { artifactId: setup.artifact.id, decision: "approved" } })).resolves.toMatchObject({
      projectId: setup.projectId,
      phase: "documentation",
      artifactVersion: 1,
      artifactContentHash: hashOf(setup.artifact),
      approvedById: fixture.ownerId,
      legacyUnverified: false,
      comments: "Approved.",
    });
    await expect(fixture.prisma.projectPhaseState.findUniqueOrThrow({ where: { projectId_phase: { projectId: setup.projectId, phase: "architecture" } } })).resolves.toMatchObject({ status: "not_started", currentArtifactId: null });
    await expect(fixture.prisma.project.findUniqueOrThrow({ where: { id: setup.projectId } })).resolves.toMatchObject({ currentPhase: "architecture" });
    await expect(fixture.prisma.phaseArtifact.count({ where: { projectId: setup.projectId, phase: "architecture" } })).resolves.toBe(0);
  });

  test("owner may request approval and warning-only readiness remains non-blocking", async () => {
    const projectId = await fixture.createProject();
    const source = await fixture.approveRequirements(projectId, "warnings");
    const draft = documentationDraft(source.content);
    draft.features[0].access = "public";
    draft.apiContracts = { applicable: false, rationale: "No interface", items: [] };
    draft.dataEntities = { applicable: false, rationale: "No data", items: [] };
    draft.permissionRules = { applicable: false, rationale: "Public", items: [] };
    draft.businessRules = [];
    draft.errorBehaviors[0].relatedApiContractIds = [];
    delete draft.errorBehaviors[0].httpStatus;
    draft.edgeCases[0].relatedApiContractIds = [];
    draft.edgeCases[0].relatedEntityIds = [];
    const content = documentationContent(source.artifact, source.content, draft);
    const artifact = await fixture.documentationArtifacts.createInitialArtifact({ projectId, actorId: fixture.ownerId, title: "Warnings", structuredContent: content });
    await expect(fixture.approvals.requestDocumentationApproval({ projectId, artifactId: artifact.id, expectedHash: hashOf(artifact), actorId: fixture.ownerId })).resolves.toMatchObject({ status: "awaiting_approval" });
  });

  test("readiness blockers reject request approval without partial mutation", async () => {
    const projectId = await fixture.createProject();
    const source = await fixture.approveRequirements(projectId, "blocker");
    const draft = documentationDraft(source.content);
    draft.unresolvedQuestions = [{ id: "DOC-QUESTION", question: "Which option?", impact: "Approval" }];
    const content = documentationContent(source.artifact, source.content, draft);
    const artifact = await fixture.documentationArtifacts.createInitialArtifact({ projectId, actorId: fixture.ownerId, title: "Blocked", structuredContent: content });
    await expect(fixture.approvals.requestDocumentationApproval({ projectId, artifactId: artifact.id, expectedHash: hashOf(artifact), actorId: fixture.ownerId })).rejects.toMatchObject({ code: "PLANNING_READINESS_BLOCKED" });
    await expect(fixture.prisma.phaseArtifact.findUniqueOrThrow({ where: { id: artifact.id } })).resolves.toMatchObject({ lifecycleStatus: "DRAFT", approved: false });
    await expect(fixture.prisma.projectPhaseState.findUniqueOrThrow({ where: { projectId_phase: { projectId, phase: "documentation" } } })).resolves.toMatchObject({ status: "in_progress", approvalCandidateArtifactId: null, currentApprovedArtifactId: null });
  });

  test("final approval and request changes are owner-only; outsiders remain non-disclosed", async () => {
    const setup = await setupDocumentation("authorization", true);
    await fixture.approvals.requestDocumentationApproval({ projectId: setup.projectId, artifactId: setup.artifact.id, expectedHash: hashOf(setup.artifact), actorId: fixture.memberId });
    await expect(fixture.approvals.approveDocumentationArtifact({ projectId: setup.projectId, artifactId: setup.artifact.id, expectedHash: hashOf(setup.artifact), actorId: fixture.memberId })).rejects.toMatchObject({ code: "PLANNING_OWNER_REQUIRED", httpStatus: 403 });
    await expect(fixture.approvals.requestDocumentationChanges({ projectId: setup.projectId, artifactId: setup.artifact.id, expectedHash: hashOf(setup.artifact), actorId: fixture.memberId, comments: "Change it." })).rejects.toMatchObject({ code: "PLANNING_OWNER_REQUIRED", httpStatus: 403 });
    await expect(fixture.approvals.approveDocumentationArtifact({ projectId: setup.projectId, artifactId: setup.artifact.id, expectedHash: hashOf(setup.artifact), actorId: fixture.outsiderId })).rejects.toMatchObject({ code: "PLANNING_PROJECT_NOT_FOUND", httpStatus: 404 });
    await expect(fixture.prisma.phaseApproval.count({ where: { projectId: setup.projectId, phase: "documentation" } })).resolves.toBe(0);
  });

  test("upstream Requirements approval after submission makes final approval fail closed", async () => {
    const setup = await setupDocumentation("upstream-v1");
    await fixture.approvals.requestDocumentationApproval({ projectId: setup.projectId, artifactId: setup.artifact.id, expectedHash: hashOf(setup.artifact), actorId: fixture.ownerId });
    await fixture.approveNextRequirements(setup.projectId, setup.source.artifact, "upstream-v2");
    await expect(fixture.approvals.approveDocumentationArtifact({ projectId: setup.projectId, artifactId: setup.artifact.id, expectedHash: hashOf(setup.artifact), actorId: fixture.ownerId })).rejects.toMatchObject({ code: "PLANNING_ARTIFACT_INVALID" });
    await expect(fixture.prisma.phaseArtifact.findUniqueOrThrow({ where: { id: setup.artifact.id } })).resolves.toMatchObject({ lifecycleStatus: "AWAITING_APPROVAL", approved: false });
    await expect(fixture.prisma.phaseApproval.count({ where: { projectId: setup.projectId, phase: "documentation" } })).resolves.toBe(0);
    await expect(fixture.prisma.projectPhaseState.findUnique({ where: { projectId_phase: { projectId: setup.projectId, phase: "architecture" } } })).resolves.toBeNull();
  });

  test("request changes appends an exact decision and preserves the prior approved authority", async () => {
    const setup = await setupDocumentation("changes");
    await fixture.approvals.requestDocumentationApproval({ projectId: setup.projectId, artifactId: setup.artifact.id, expectedHash: hashOf(setup.artifact), actorId: fixture.ownerId });
    await fixture.approvals.approveDocumentationArtifact({ projectId: setup.projectId, artifactId: setup.artifact.id, expectedHash: hashOf(setup.artifact), actorId: fixture.ownerId });
    const v2 = await fixture.documentationArtifacts.createSuccessorVersion({ projectId: setup.projectId, actorId: fixture.ownerId, baseArtifactId: setup.artifact.id, baseContentHash: hashOf(setup.artifact), structuredContent: setup.content });
    await fixture.approvals.requestDocumentationApproval({ projectId: setup.projectId, artifactId: v2.id, expectedHash: hashOf(v2), actorId: fixture.ownerId });
    const state = await fixture.approvals.requestDocumentationChanges({ projectId: setup.projectId, artifactId: v2.id, expectedHash: hashOf(v2), actorId: fixture.ownerId, comments: "Clarify recovery." });
    expect(state).toMatchObject({ status: "changes_requested", currentArtifactId: v2.id, currentApprovedArtifactId: setup.artifact.id, approvalCandidateArtifactId: null });
    await expect(fixture.prisma.phaseArtifact.findUniqueOrThrow({ where: { id: v2.id } })).resolves.toMatchObject({ lifecycleStatus: "DRAFT", approved: false });
    await expect(fixture.prisma.phaseArtifact.findUniqueOrThrow({ where: { id: setup.artifact.id } })).resolves.toMatchObject({ lifecycleStatus: "APPROVED", approved: true });
    await expect(fixture.prisma.phaseApproval.findFirstOrThrow({ where: { artifactId: v2.id, decision: "changes_requested" } })).resolves.toMatchObject({ artifactVersion: 2, artifactContentHash: hashOf(v2), approvedById: fixture.ownerId, comments: "Clarify recovery." });
  });

  test("legacy unstructured Documentation can never request approval", async () => {
    const projectId = await fixture.createProject();
    await fixture.approveRequirements(projectId, "legacy");
    const artifact = await fixture.prisma.phaseArtifact.create({ data: { projectId, phase: "documentation", type: "documentation_doc", title: "Legacy", content: "legacy", structuredContent: Prisma.DbNull, contentHash: null, version: 1, createdBy: fixture.ownerId } });
    await fixture.prisma.projectPhaseState.update({ where: { projectId_phase: { projectId, phase: "documentation" } }, data: { status: "in_progress", currentArtifactId: artifact.id, stateVersion: { increment: 1 } } });
    await expect(fixture.approvals.requestDocumentationApproval({ projectId, artifactId: artifact.id, expectedHash: "", actorId: fixture.ownerId })).rejects.toMatchObject({ code: "PLANNING_ARTIFACT_INVALID" });
    await expect(fixture.prisma.phaseApproval.count({ where: { projectId, phase: "documentation" } })).resolves.toBe(0);
    await expect(fixture.prisma.projectPhaseState.findUnique({ where: { projectId_phase: { projectId, phase: "architecture" } } })).resolves.toBeNull();
  });

  test.each(["hash", "Markdown", "structured content", "oversized canonical content"])(
    "rejects persisted %s corruption",
    async (kind) => {
      const projectId = await fixture.createProject();
      const source = await fixture.approveRequirements(projectId, `corruption-${kind}`);
      const valid = documentationContent(source.artifact, source.content);
      const storedContent = kind === "structured content"
        ? { broken: true }
        : kind === "oversized canonical content" ? oversized(valid) : valid;
      const artifact = await fixture.prisma.phaseArtifact.create({
        data: {
          projectId,
          phase: "documentation",
          type: "documentation_doc",
          title: "Corrupt Documentation",
          content: kind === "Markdown" ? "corrupt" : (await import("../../planning/documentation-schema")).renderDocumentationMarkdown(valid),
          structuredContent: storedContent as Prisma.InputJsonValue,
          schemaVersion: 1,
          contentHash: kind === "hash" ? "0".repeat(64) : (await import("../../planning/documentation-schema")).hashDocumentationContent(valid),
          version: 1,
          createdBy: fixture.ownerId,
        },
      });
      await fixture.prisma.projectPhaseState.update({
        where: { projectId_phase: { projectId, phase: "documentation" } },
        data: { status: "in_progress", currentArtifactId: artifact.id, stateVersion: { increment: 1 } },
      });
      await expect(fixture.approvals.requestDocumentationApproval({
        projectId,
        artifactId: artifact.id,
        expectedHash: artifact.contentHash ?? "",
        actorId: fixture.ownerId,
      })).rejects.toMatchObject({ code: expect.stringMatching(/^PLANNING_(ARTIFACT_INVALID|INPUT_TOO_LARGE)$/) });
      await expect(fixture.prisma.projectPhaseState.findUniqueOrThrow({
        where: { projectId_phase: { projectId, phase: "documentation" } },
      })).resolves.toMatchObject({ status: "in_progress", approvalCandidateArtifactId: null, currentApprovedArtifactId: null });
    },
  );

  test("stale and cross-project artifact IDs and expected hashes are rejected without mutation", async () => {
    const first = await setupDocumentation("exact-a");
    const v2 = await fixture.documentationArtifacts.createSuccessorVersion({ projectId: first.projectId, actorId: fixture.ownerId, baseArtifactId: first.artifact.id, baseContentHash: hashOf(first.artifact), structuredContent: first.content });
    const second = await setupDocumentation("exact-b");
    await expect(fixture.approvals.requestDocumentationApproval({ projectId: first.projectId, artifactId: first.artifact.id, expectedHash: hashOf(first.artifact), actorId: fixture.ownerId })).rejects.toMatchObject({ code: "PLANNING_ARTIFACT_NOT_CURRENT" });
    await expect(fixture.approvals.requestDocumentationApproval({ projectId: first.projectId, artifactId: second.artifact.id, expectedHash: hashOf(second.artifact), actorId: fixture.ownerId })).rejects.toMatchObject({ code: "PLANNING_ARTIFACT_PROJECT_MISMATCH" });
    await expect(fixture.approvals.requestDocumentationApproval({ projectId: first.projectId, artifactId: v2.id, expectedHash: "0".repeat(64), actorId: fixture.ownerId })).rejects.toMatchObject({ code: "PLANNING_ARTIFACT_HASH_MISMATCH" });
    await expect(fixture.prisma.phaseApproval.count({ where: { projectId: first.projectId, phase: "documentation" } })).resolves.toBe(0);
  });

  test("non-empty comments and exact candidate/lifecycle are required for request changes", async () => {
    const setup = await setupDocumentation("candidate");
    await expect(fixture.approvals.requestDocumentationChanges({ projectId: setup.projectId, artifactId: setup.artifact.id, expectedHash: hashOf(setup.artifact), actorId: fixture.ownerId, comments: "  " })).rejects.toMatchObject({ code: "PLANNING_COMMENTS_REQUIRED" });
    await expect(fixture.approvals.approveDocumentationArtifact({ projectId: setup.projectId, artifactId: setup.artifact.id, expectedHash: hashOf(setup.artifact), actorId: fixture.ownerId })).rejects.toMatchObject({ code: "PLANNING_ARTIFACT_NOT_CANDIDATE" });
    await expect(fixture.prisma.phaseApproval.count({ where: { projectId: setup.projectId, phase: "documentation" } })).resolves.toBe(0);
  });
});
