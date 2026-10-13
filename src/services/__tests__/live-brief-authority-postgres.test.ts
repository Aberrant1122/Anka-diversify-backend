import crypto from "crypto";
import { ClaimCategory, ClaimStatus, PrismaClient } from "@prisma/client";
import { LLMGateway } from "../../ai/gateway/LLMGateway";
import { PlanningRequirementsContextBuilder } from "../../planning/requirements-context";
import { LiveBriefService, IntakeAiResponse } from "../live-brief.service";

const databaseUrl = process.env.DATABASE_URL;
const isolatedSchema = databaseUrl ? new URL(databaseUrl).searchParams.get("schema") : null;
if (!isolatedSchema?.startsWith("planning_checkpoint_live_brief_authority_")) {
  throw new Error("live-brief-authority-postgres.test.ts requires an isolated planning_checkpoint_live_brief_authority_* schema");
}

const prisma = new PrismaClient();
const ownerId = `owner-${crypto.randomUUID()}`;
const memberId = `member-${crypto.randomUUID()}`;
const otherId = `other-${crypto.randomUUID()}`;
const projectId = `project-${crypto.randomUUID()}`;
const otherProjectId = `other-project-${crypto.randomUUID()}`;

let response: IntakeAiResponse;
const gateway = {
  callStructured: jest.fn(async () => ({ content: response })),
} as unknown as Pick<LLMGateway, "callStructured">;
const service = new LiveBriefService(prisma, undefined, gateway);

describe("CP2.3-CP2.5 Live Brief authority", () => {
  let spanId = "";
  let sourceId = "";
  let otherSourceId = "";

  beforeAll(async () => {
    await prisma.user.createMany({ data: [
      { id: ownerId, email: `${ownerId}@test.local`, name: "Owner", password: "pwd" },
      { id: memberId, email: `${memberId}@test.local`, name: "Member", password: "pwd" },
      { id: otherId, email: `${otherId}@test.local`, name: "Other", password: "pwd" },
    ] });
    await prisma.project.createMany({ data: [
      { id: projectId, name: "Authority Project", description: "Idea only", userId: ownerId },
      { id: otherProjectId, name: "Foreign Project", userId: otherId },
    ] });
    await prisma.projectMember.create({ data: { projectId, userId: memberId } });
    const file = await prisma.projectFile.create({ data: { projectId, name: "ready.pdf", type: "doc", phase: "requirements" } });
    const source = await prisma.documentSource.create({ data: {
      projectId, projectFileId: file.id, originalFilename: file.name, mimeType: "application/pdf",
      s3Key: `tests/${file.id}`, byteSize: 100, contentHash: "a".repeat(64),
    } });
    sourceId = source.id;
    const run = await prisma.documentExtractionRun.create({ data: { projectId, sourceId, attempt: 1, status: "READY", parser: "fixture" } });
    const span = await prisma.evidenceSpan.create({ data: {
      projectId, sourceId, extractionRunId: run.id, ordinal: 0, locatorType: "PDF_PAGE", pageNumber: 1,
      text: "The product helps operators manage releases.", textHash: "b".repeat(64),
    } });
    spanId = span.id;
    const foreignFile = await prisma.projectFile.create({ data: { projectId: otherProjectId, name: "foreign.pdf", type: "doc", phase: "requirements" } });
    const foreignSource = await prisma.documentSource.create({ data: {
      projectId: otherProjectId, projectFileId: foreignFile.id, originalFilename: foreignFile.name, mimeType: "application/pdf",
      s3Key: `tests/${foreignFile.id}`, byteSize: 100, contentHash: "c".repeat(64),
    } });
    otherSourceId = foreignSource.id;
  });

  afterAll(async () => {
    await prisma.project.deleteMany({ where: { id: { in: [projectId, otherProjectId] } } });
    await prisma.user.deleteMany({ where: { id: { in: [ownerId, memberId, otherId] } } });
    await prisma.$disconnect();
  });

  test("1. initializes an immutable deterministic revision for an idea-only project", async () => {
    await service.initialize(projectId, ownerId);
    const workspace = await service.getWorkspace(projectId, ownerId);
    expect(workspace.state?.currentBriefRevision?.revisionNumber).toBe(1);
    expect(workspace.state?.currentBriefRevision?.markdownContent).toContain("Idea only");
    expect(workspace.readiness.ready).toBe(false);
  });

  test("2. rejects cross-project source selection with zero intake side effects", async () => {
    const before = await prisma.projectIntakeRequest.count({ where: { projectId } });
    await expect(service.converse({ projectId, actorId: ownerId, requestKey: "foreign-source-request", message: "Read it", sourceIds: [otherSourceId] }))
      .rejects.toMatchObject({ httpStatus: 422 });
    expect(await prisma.projectIntakeRequest.count({ where: { projectId } })).toBe(before);
  });

  test("3. persists validated AI proposals without accepting them and replays duplicates", async () => {
    response = {
      message: "I found four essentials for review.",
      proposedClaims: [
        { claimKey: "goal", category: ClaimCategory.GOAL, title: "Goal", content: "Manage releases", sourceSpanIds: [spanId] },
        { claimKey: "users", category: ClaimCategory.USER_PERSONA, title: "Users", content: "Release operators", sourceSpanIds: [] },
        { claimKey: "workflow", category: ClaimCategory.WORKFLOW, title: "Workflow", content: "Plan and release", sourceSpanIds: [] },
        { claimKey: "acceptance", category: ClaimCategory.ACCEPTANCE_CRITERION, title: "Acceptance", content: "A release can be tracked", sourceSpanIds: [] },
      ],
      questions: [], contradictions: [],
    };
    const first = await service.converse({ projectId, actorId: memberId, requestKey: "valid-intake-request", message: "Define the essentials", sourceIds: [sourceId] });
    const replay = await service.converse({ projectId, actorId: memberId, requestKey: "valid-intake-request", message: "ignored", sourceIds: [sourceId] });
    expect(replay).toEqual(first);
    expect(gateway.callStructured).toHaveBeenCalledTimes(1);
    const claims = await prisma.projectClaim.findMany({ where: { projectId } });
    expect(claims).toHaveLength(4);
    expect(claims.every((claim) => claim.status === ClaimStatus.PROPOSED)).toBe(true);
  });

  test("4. human acceptance creates one revision per decision and stale CAS loses", async () => {
    const claims = await prisma.projectClaim.findMany({ where: { projectId }, orderBy: { claimKey: "asc" } });
    let revisionNumber = 1;
    for (const claim of claims) {
      const result = await service.decideClaim({ projectId, actorId: memberId, claimId: claim.id, action: "ACCEPT", expectedRevisionNumber: revisionNumber });
      revisionNumber = result.revision.revisionNumber;
    }
    expect(revisionNumber).toBe(5);
    await expect(service.updateBrief({ projectId, actorId: ownerId, expectedRevisionNumber: 4, title: "Stale", markdownContent: "Stale" }))
      .rejects.toMatchObject({ httpStatus: 409 });
    expect((await service.getWorkspace(projectId, ownerId)).readiness.ready).toBe(true);
  });

  test("5. only the owner confirms the exact current hash", async () => {
    const workspace = await service.getWorkspace(projectId, ownerId);
    const revision = workspace.state!.currentBriefRevision!;
    await expect(service.confirm({ projectId, actorId: memberId, revisionId: revision.id, expectedContentHash: revision.contentHash }))
      .rejects.toMatchObject({ httpStatus: 403 });
    await expect(service.confirm({ projectId, actorId: ownerId, revisionId: revision.id, expectedContentHash: "0".repeat(64) }))
      .rejects.toMatchObject({ httpStatus: 409 });
    const confirmation = await service.confirm({ projectId, actorId: ownerId, revisionId: revision.id, expectedContentHash: revision.contentHash });
    expect(confirmation.status).toBe("ACTIVE");
  });

  test("6. Requirements context carries exact confirmation, revision, hash, and evidence lineage", async () => {
    const workspace = await service.getWorkspace(projectId, ownerId);
    const confirmation = workspace.state!.currentConfirmation!;
    const context = await new PlanningRequirementsContextBuilder(prisma).buildInitial({
      projectId, actorId: ownerId, briefConfirmationId: confirmation.id,
    });
    expect(context.manifest.briefAuthority).toMatchObject({
      confirmationId: confirmation.id,
      revisionId: workspace.state!.currentBriefRevision!.id,
      contentHash: workspace.state!.currentBriefRevision!.contentHash,
    });
    expect(context.manifest.briefAuthority!.evidenceManifest).toEqual(expect.arrayContaining([expect.objectContaining({ spanId })]));
  });
});
