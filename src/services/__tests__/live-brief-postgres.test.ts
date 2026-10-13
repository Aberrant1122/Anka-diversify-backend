import crypto from "crypto";
import {
  PrismaClient,
  IntakeStateStatus,
  ClaimCategory,
  ClaimProvenance,
  ClaimStatus,
  QuestionStatus,
  ContradictionStatus,
  BriefRevisionActorType,
  BriefConfirmationStatus,
} from "@prisma/client";

const databaseUrl = process.env.DATABASE_URL;
const isolatedSchema = databaseUrl
  ? new URL(databaseUrl).searchParams.get("schema")
  : null;

if (!isolatedSchema?.startsWith("planning_checkpoint_live_brief_")) {
  throw new Error(
    "live-brief-postgres.test.ts requires an isolated planning_checkpoint_live_brief_* PostgreSQL schema",
  );
}

const prisma = new PrismaClient();

describe("CP2.2 Collaborative Live Brief Data Foundation", () => {
  const userAlphaId = `user-alpha-${crypto.randomUUID()}`;
  const userBetaId = `user-beta-${crypto.randomUUID()}`;
  const projectAlphaId = `proj-alpha-${crypto.randomUUID()}`;
  const projectBetaId = `proj-beta-${crypto.randomUUID()}`;

  beforeAll(async () => {
    await prisma.user.createMany({
      data: [
        { id: userAlphaId, email: `${userAlphaId}@test.local`, name: "User Alpha", password: "pwd" },
        { id: userBetaId, email: `${userBetaId}@test.local`, name: "User Beta", password: "pwd" },
      ],
    });

    await prisma.project.createMany({
      data: [
        { id: projectAlphaId, name: "Project Alpha", userId: userAlphaId },
        { id: projectBetaId, name: "Project Beta", userId: userBetaId },
      ],
    });
  });

  afterAll(async () => {
    try {
      await prisma.project.deleteMany({
        where: { id: { in: [projectAlphaId, projectBetaId] } },
      });
      await prisma.user.deleteMany({
        where: { id: { in: [userAlphaId, userBetaId] } },
      });
    } finally {
      await prisma.$disconnect();
    }
  });

  test("1. ProjectIntakeState enforces one state per project with nullable pointers", async () => {
    const intake = await prisma.projectIntakeState.create({
      data: {
        projectId: projectAlphaId,
        status: IntakeStateStatus.EMPTY,
      },
    });

    expect(intake.id).toBeDefined();
    expect(intake.projectId).toBe(projectAlphaId);
    expect(intake.status).toBe(IntakeStateStatus.EMPTY);
    expect(intake.currentBriefRevisionId).toBeNull();
    expect(intake.currentConfirmationId).toBeNull();

    // Enforces unique projectId
    await expect(
      prisma.projectIntakeState.create({
        data: {
          projectId: projectAlphaId,
          status: IntakeStateStatus.EXPLORING,
        },
      }),
    ).rejects.toThrow();
  });

  test("2. ProjectClaim enforces unique [projectId, claimKey, version] and separates provenance/status", async () => {
    // Model-proposed claim v1 (unaccepted)
    const claimV1 = await prisma.projectClaim.create({
      data: {
        projectId: projectAlphaId,
        claimKey: "auth.method",
        version: 1,
        category: ClaimCategory.CONSTRAINT,
        title: "Authentication Method",
        content: "Users authenticate via GitHub OAuth.",
        provenance: ClaimProvenance.MODEL_PROPOSED,
        status: ClaimStatus.PROPOSED,
        confidence: 0.85,
        createdById: userAlphaId,
        createdByType: "AI",
      },
    });

    expect(claimV1.version).toBe(1);
    expect(claimV1.status).toBe(ClaimStatus.PROPOSED);
    expect(claimV1.provenance).toBe(ClaimProvenance.MODEL_PROPOSED);

    // Duplicate [projectId, claimKey, version] must fail
    await expect(
      prisma.projectClaim.create({
        data: {
          projectId: projectAlphaId,
          claimKey: "auth.method",
          version: 1,
          category: ClaimCategory.CONSTRAINT,
          title: "Duplicate",
          content: "Conflict",
          provenance: ClaimProvenance.USER_STATED,
          createdById: userAlphaId,
        },
      }),
    ).rejects.toThrow();

    // Human-accepted successor claim v2
    const claimV2 = await prisma.projectClaim.create({
      data: {
        projectId: projectAlphaId,
        claimKey: "auth.method",
        version: 2,
        category: ClaimCategory.CONSTRAINT,
        title: "Authentication Method",
        content: "Users authenticate via SAML SSO only.",
        provenance: ClaimProvenance.USER_STATED,
        status: ClaimStatus.ACCEPTED,
        createdById: userAlphaId,
        createdByType: "HUMAN",
        supersededById: claimV1.id,
      },
    });

    expect(claimV2.version).toBe(2);
    expect(claimV2.status).toBe(ClaimStatus.ACCEPTED);
    expect(claimV2.provenance).toBe(ClaimProvenance.USER_STATED);
  });

  test("3. ProjectClaim stores sourceSpanIds array bound to CP1 EvidenceSpans", async () => {
    const file = await prisma.projectFile.create({
      data: {
        projectId: projectAlphaId,
        name: "architecture-spec.pdf",
        type: "doc",
        phase: "requirements",
      },
    });

    const source = await prisma.documentSource.create({
      data: {
        projectId: projectAlphaId,
        projectFileId: file.id,
        sourceVersion: 1,
        originalFilename: "architecture-spec.pdf",
        mimeType: "application/pdf",
        s3Key: "projects/alpha/doc-1.pdf",
        byteSize: 1024,
        contentHash: "hash-alpha-1024",
      },
    });

    const run = await prisma.documentExtractionRun.create({
      data: {
        projectId: projectAlphaId,
        sourceId: source.id,
        attempt: 1,
        status: "READY",
        parser: "pdf-parse",
      },
    });

    const span = await prisma.evidenceSpan.create({
      data: {
        projectId: projectAlphaId,
        sourceId: source.id,
        extractionRunId: run.id,
        ordinal: 0,
        locatorType: "PDF_PAGE",
        pageNumber: 3,
        text: "Section 3.1: Retention policy is strictly 90 days.",
        textHash: "span-hash-3-1",
      },
    });

    const evidenceClaim = await prisma.projectClaim.create({
      data: {
        projectId: projectAlphaId,
        claimKey: "retention.period",
        version: 1,
        category: ClaimCategory.CONSTRAINT,
        title: "Data Retention",
        content: "Retention period is strictly 90 days.",
        provenance: ClaimProvenance.DOCUMENT_EVIDENCE,
        status: ClaimStatus.ACCEPTED,
        sourceSpanIds: [span.id],
        createdById: userAlphaId,
      },
    });

    expect(evidenceClaim.sourceSpanIds).toEqual([span.id]);
    expect(evidenceClaim.provenance).toBe(ClaimProvenance.DOCUMENT_EVIDENCE);
  });

  test("4. ProjectClarificationQuestion persists questions, suggested options, and user answers", async () => {
    const question = await prisma.projectClarificationQuestion.create({
      data: {
        projectId: projectAlphaId,
        category: ClaimCategory.USER_PERSONA,
        question: "Should guest users have read-only access?",
        suggestedOptions: ["Yes, public read", "No, auth required", "Configurable per project"],
        status: QuestionStatus.OPEN,
      },
    });

    expect(question.status).toBe(QuestionStatus.OPEN);
    expect(question.suggestedOptions.length).toBe(3);

    // User answers question
    const answered = await prisma.projectClarificationQuestion.update({
      where: { id: question.id },
      data: {
        status: QuestionStatus.ANSWERED,
        answer: "No, auth required.",
        answeredById: userAlphaId,
        answeredAt: new Date(),
      },
    });

    expect(answered.status).toBe(QuestionStatus.ANSWERED);
    expect(answered.answer).toBe("No, auth required.");
    expect(answered.answeredById).toBe(userAlphaId);
  });

  test("5. ProjectContradiction tracks conflicts and explicit resolution decisions", async () => {
    const contradiction = await prisma.projectContradiction.create({
      data: {
        projectId: projectAlphaId,
        claimKeyA: "retention.period",
        claimKeyB: "compliance.gdpr_purge",
        description: "Source doc says 90 days but GDPR policy says 30 days.",
        status: ContradictionStatus.ACTIVE,
      },
    });

    expect(contradiction.status).toBe(ContradictionStatus.ACTIVE);

    // Owner resolves conflict
    const resolved = await prisma.projectContradiction.update({
      where: { id: contradiction.id },
      data: {
        status: ContradictionStatus.RESOLVED,
        resolutionNote: "Owner decided 30 days takes precedence for GDPR compliance.",
        resolvedById: userAlphaId,
        resolvedAt: new Date(),
      },
    });

    expect(resolved.status).toBe(ContradictionStatus.RESOLVED);
    expect(resolved.resolutionNote).toContain("30 days takes precedence");
  });

  test("6. LiveBriefRevision enforces monotonic [projectId, revisionNumber] and immutable snapshots", async () => {
    const claimsSnapshot = [
      { key: "auth.method", value: "SAML SSO" },
      { key: "retention.period", value: "30 days" },
    ];
    const evidenceSnapshot = [
      { sourceId: "src-1", spanId: "span-1", textHash: "hash-1" },
    ];
    const contentHashRev1 = crypto.createHash("sha256").update("brief-rev-1").digest("hex");

    const rev1 = await prisma.liveBriefRevision.create({
      data: {
        projectId: projectAlphaId,
        revisionNumber: 1,
        title: "Live Brief Draft 1",
        markdownContent: "# Project Alpha Live Brief\nInitial draft.",
        structuredClaims: claimsSnapshot,
        evidenceManifest: evidenceSnapshot,
        contentHash: contentHashRev1,
        changeSummary: "Initial AI Turn",
        createdById: userAlphaId,
        createdByType: BriefRevisionActorType.ASSISTANT_CONVERSATION,
      },
    });

    expect(rev1.revisionNumber).toBe(1);
    expect(rev1.contentHash).toBe(contentHashRev1);

    // Monotonic uniqueness: Duplicate revisionNumber 1 must fail
    await expect(
      prisma.liveBriefRevision.create({
        data: {
          projectId: projectAlphaId,
          revisionNumber: 1,
          title: "Duplicate Rev 1",
          markdownContent: "Conflict",
          structuredClaims: [],
          evidenceManifest: [],
          contentHash: "other-hash",
          changeSummary: "Invalid duplicate",
          createdById: userAlphaId,
          createdByType: BriefRevisionActorType.USER,
        },
      }),
    ).rejects.toThrow();

    // Create Revision 2
    const contentHashRev2 = crypto.createHash("sha256").update("brief-rev-2").digest("hex");
    const rev2 = await prisma.liveBriefRevision.create({
      data: {
        projectId: projectAlphaId,
        revisionNumber: 2,
        title: "Live Brief Draft 2",
        markdownContent: "# Project Alpha Live Brief\nUpdated with GDPR decision.",
        structuredClaims: claimsSnapshot,
        evidenceManifest: evidenceSnapshot,
        contentHash: contentHashRev2,
        changeSummary: "Human resolution applied",
        createdById: userAlphaId,
        createdByType: BriefRevisionActorType.USER,
      },
    });

    expect(rev2.revisionNumber).toBe(2);

    // Update ProjectIntakeState pointer to Revision 2
    await prisma.projectIntakeState.update({
      where: { projectId: projectAlphaId },
      data: {
        status: IntakeStateStatus.READY_FOR_CONFIRMATION,
        currentBriefRevisionId: rev2.id,
      },
    });

    const intake = await prisma.projectIntakeState.findUnique({
      where: { projectId: projectAlphaId },
      include: { currentBriefRevision: true },
    });
    expect(intake?.currentBriefRevision?.id).toBe(rev2.id);
    expect(intake?.status).toBe(IntakeStateStatus.READY_FOR_CONFIRMATION);
  });

  test("7. LiveBriefConfirmation binds exact revision and hash; supersession retains history", async () => {
    const rev1 = await prisma.liveBriefRevision.findUniqueOrThrow({
      where: {
        projectId_revisionNumber: { projectId: projectAlphaId, revisionNumber: 1 },
      },
    });

    const rev2 = await prisma.liveBriefRevision.findUniqueOrThrow({
      where: {
        projectId_revisionNumber: { projectId: projectAlphaId, revisionNumber: 2 },
      },
    });

    // Owner confirms Revision 1
    const conf1 = await prisma.liveBriefConfirmation.create({
      data: {
        projectId: projectAlphaId,
        briefRevisionId: rev1.id,
        briefRevisionNumber: 1,
        briefContentHash: rev1.contentHash,
        confirmedById: userAlphaId,
        status: BriefConfirmationStatus.ACTIVE,
      },
    });

    expect(conf1.status).toBe(BriefConfirmationStatus.ACTIVE);
    expect(conf1.briefContentHash).toBe(rev1.contentHash);

    // Revision cannot be confirmed twice (unique briefRevisionId)
    await expect(
      prisma.liveBriefConfirmation.create({
        data: {
          projectId: projectAlphaId,
          briefRevisionId: rev1.id,
          briefRevisionNumber: 1,
          briefContentHash: rev1.contentHash,
          confirmedById: userAlphaId,
          status: BriefConfirmationStatus.ACTIVE,
        },
      }),
    ).rejects.toThrow();

    // Owner subsequently confirms Revision 2:
    // Rev 1 confirmation is marked STALE, Rev 2 is ACTIVE
    await prisma.liveBriefConfirmation.update({
      where: { id: conf1.id },
      data: {
        status: BriefConfirmationStatus.STALE,
        supersededAt: new Date(),
        supersededById: userAlphaId,
      },
    });

    const conf2 = await prisma.liveBriefConfirmation.create({
      data: {
        projectId: projectAlphaId,
        briefRevisionId: rev2.id,
        briefRevisionNumber: 2,
        briefContentHash: rev2.contentHash,
        confirmedById: userAlphaId,
        status: BriefConfirmationStatus.ACTIVE,
      },
    });

    // Both confirmations exist (historical retention)
    const allConfirmations = await prisma.liveBriefConfirmation.findMany({
      where: { projectId: projectAlphaId },
      orderBy: { briefRevisionNumber: "asc" },
    });
    expect(allConfirmations.length).toBe(2);
    expect(allConfirmations[0].status).toBe(BriefConfirmationStatus.STALE);
    expect(allConfirmations[1].status).toBe(BriefConfirmationStatus.ACTIVE);

    // Update ProjectIntakeState currentConfirmationId to conf2
    await prisma.projectIntakeState.update({
      where: { projectId: projectAlphaId },
      data: {
        status: IntakeStateStatus.CONFIRMED,
        currentConfirmationId: conf2.id,
      },
    });

    const activeIntake = await prisma.projectIntakeState.findUnique({
      where: { projectId: projectAlphaId },
      include: { currentConfirmation: true },
    });
    expect(activeIntake?.status).toBe(IntakeStateStatus.CONFIRMED);
    expect(activeIntake?.currentConfirmation?.id).toBe(conf2.id);
  });

  test("8. Deleting a LiveBriefRevision sets intake pointer to null and cascade-deletes confirmation", async () => {
    // Project Beta creates a disposable revision & confirmation
    const betaRev = await prisma.liveBriefRevision.create({
      data: {
        projectId: projectBetaId,
        revisionNumber: 1,
        title: "Beta Rev 1",
        markdownContent: "# Beta",
        structuredClaims: [],
        evidenceManifest: [],
        contentHash: "beta-hash-1",
        changeSummary: "Initial Beta",
        createdById: userBetaId,
        createdByType: BriefRevisionActorType.USER,
      },
    });

    const betaConf = await prisma.liveBriefConfirmation.create({
      data: {
        projectId: projectBetaId,
        briefRevisionId: betaRev.id,
        briefRevisionNumber: 1,
        briefContentHash: "beta-hash-1",
        confirmedById: userBetaId,
      },
    });

    const betaIntake = await prisma.projectIntakeState.create({
      data: {
        projectId: projectBetaId,
        status: IntakeStateStatus.CONFIRMED,
        currentBriefRevisionId: betaRev.id,
        currentConfirmationId: betaConf.id,
      },
    });

    // Delete the revision
    await prisma.liveBriefRevision.delete({ where: { id: betaRev.id } });

    // Confirmation must be cascaded away
    const foundConf = await prisma.liveBriefConfirmation.findUnique({
      where: { id: betaConf.id },
    });
    expect(foundConf).toBeNull();

    // Intake pointers must be set to null via SetNull without deleting the intake state
    const refreshedIntake = await prisma.projectIntakeState.findUnique({
      where: { id: betaIntake.id },
    });
    expect(refreshedIntake).not.toBeNull();
    expect(refreshedIntake?.currentBriefRevisionId).toBeNull();
    expect(refreshedIntake?.currentConfirmationId).toBeNull();
  });

  test("9. Cascade deletion: Deleting a project cleanly removes all Live Brief records", async () => {
    await prisma.project.delete({ where: { id: projectAlphaId } });

    const [intake, claims, questions, contradictions, revs, confs] = await Promise.all([
      prisma.projectIntakeState.findMany({ where: { projectId: projectAlphaId } }),
      prisma.projectClaim.findMany({ where: { projectId: projectAlphaId } }),
      prisma.projectClarificationQuestion.findMany({ where: { projectId: projectAlphaId } }),
      prisma.projectContradiction.findMany({ where: { projectId: projectAlphaId } }),
      prisma.liveBriefRevision.findMany({ where: { projectId: projectAlphaId } }),
      prisma.liveBriefConfirmation.findMany({ where: { projectId: projectAlphaId } }),
    ]);

    expect(intake.length).toBe(0);
    expect(claims.length).toBe(0);
    expect(questions.length).toBe(0);
    expect(contradictions.length).toBe(0);
    expect(revs.length).toBe(0);
    expect(confs.length).toBe(0);
  });
});
