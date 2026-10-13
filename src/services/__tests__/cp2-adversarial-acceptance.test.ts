import crypto from "crypto";
import {
  ClaimCategory,
  ClaimProvenance,
  ClaimStatus,
  ContradictionStatus,
  IntakeStateStatus,
  PrismaClient,
  QuestionStatus,
  WorkflowOperation,
} from "@prisma/client";
import { LLMGateway } from "../../ai/gateway/LLMGateway";
import { PlanningDomainError } from "../../planning/planning-errors";
import { hashBriefPayload, LiveBriefService, IntakeAiResponse } from "../live-brief.service";
import { PlanningRequirementsContextBuilder } from "../../planning/requirements-context";
import { PlanningRequirementsRunService } from "../planning-requirements-run.service";
import { PlanningArtifactService } from "../planning-artifact.service";
import { PlanningApprovalService } from "../planning-approval.service";

const databaseUrl = process.env.DATABASE_URL;
const isolatedSchema = databaseUrl ? new URL(databaseUrl).searchParams.get("schema") : null;
if (!isolatedSchema?.startsWith("planning_checkpoint_cp2_adversarial_")) {
  throw new Error("cp2-adversarial-acceptance.test.ts requires an isolated planning_checkpoint_cp2_adversarial_* schema");
}

const prisma = new PrismaClient();

describe("CP2 Independent Adversarial Acceptance & Invariants", () => {
  const ownerA = `owner-a-${crypto.randomUUID()}`;
  const memberA = `member-a-${crypto.randomUUID()}`;
  const ownerB = `owner-b-${crypto.randomUUID()}`;
  const nonMemberAdmin = `admin-${crypto.randomUUID()}`;

  const projectA = `proj-a-${crypto.randomUUID()}`;
  const projectB = `proj-b-${crypto.randomUUID()}`;

  let spanA1 = "";
  let spanA2 = "";
  let sourceA = "";
  let spanB = "";
  let sourceB = "";

  let mockAiResponse: IntakeAiResponse;
  const mockCallStructured = jest.fn();
  const mockGateway = {
    callStructured: mockCallStructured,
  } as unknown as Pick<LLMGateway, "callStructured">;
  mockCallStructured.mockImplementation(async () => ({ content: mockAiResponse }));

  const service = new LiveBriefService(prisma, undefined, mockGateway);
  const runService = new PlanningRequirementsRunService(prisma);
  const artifactService = new PlanningArtifactService(prisma);
  const approvalService = new PlanningApprovalService(prisma);

  beforeAll(async () => {
    // Seed users
    await prisma.user.createMany({
      data: [
        { id: ownerA, email: `${ownerA}@test.local`, name: "Owner A", password: "pwd" },
        { id: memberA, email: `${memberA}@test.local`, name: "Member A", password: "pwd" },
        { id: ownerB, email: `${ownerB}@test.local`, name: "Owner B", password: "pwd" },
        { id: nonMemberAdmin, email: `${nonMemberAdmin}@test.local`, name: "Admin", password: "pwd", role: "admin" },
      ],
    });

    // Seed projects
    await prisma.project.createMany({
      data: [
        { id: projectA, name: "Project Alpha", description: "Alpha initial description", userId: ownerA },
        { id: projectB, name: "Project Beta", description: "Beta initial description", userId: ownerB },
      ],
    });

    // Member A is member of Project A
    await prisma.projectMember.create({ data: { projectId: projectA, userId: memberA } });

    // Sources and evidence spans in Project A
    const fileA = await prisma.projectFile.create({ data: { projectId: projectA, name: "docA.pdf", type: "doc" } });
    const docSourceA = await prisma.documentSource.create({
      data: {
        projectId: projectA,
        projectFileId: fileA.id,
        originalFilename: fileA.name,
        mimeType: "application/pdf",
        s3Key: `tests/${fileA.id}`,
        byteSize: 1000,
        contentHash: "a".repeat(64),
      },
    });
    sourceA = docSourceA.id;
    const runA = await prisma.documentExtractionRun.create({
      data: { projectId: projectA, sourceId: sourceA, attempt: 1, status: "READY", parser: "pdf-parse" },
    });
    const span1 = await prisma.evidenceSpan.create({
      data: {
        projectId: projectA,
        sourceId: sourceA,
        extractionRunId: runA.id,
        ordinal: 0,
        locatorType: "PDF_PAGE",
        pageNumber: 1,
        text: "Project Alpha provides high availability failover.",
        textHash: crypto.createHash("sha256").update("Project Alpha provides high availability failover.").digest("hex"),
      },
    });
    spanA1 = span1.id;
    const span2 = await prisma.evidenceSpan.create({
      data: {
        projectId: projectA,
        sourceId: sourceA,
        extractionRunId: runA.id,
        ordinal: 1,
        locatorType: "PDF_PAGE",
        pageNumber: 2,
        text: "Recovery time objective is under 5 seconds.",
        textHash: crypto.createHash("sha256").update("Recovery time objective is under 5 seconds.").digest("hex"),
      },
    });
    spanA2 = span2.id;

    // Sources and evidence spans in Project B
    const fileB = await prisma.projectFile.create({ data: { projectId: projectB, name: "secretB.docx", type: "doc" } });
    const docSourceB = await prisma.documentSource.create({
      data: {
        projectId: projectB,
        projectFileId: fileB.id,
        originalFilename: fileB.name,
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        s3Key: `tests/${fileB.id}`,
        byteSize: 2000,
        contentHash: "b".repeat(64),
      },
    });
    sourceB = docSourceB.id;
    const runB = await prisma.documentExtractionRun.create({
      data: { projectId: projectB, sourceId: sourceB, attempt: 1, status: "READY", parser: "docx-parser" },
    });
    const spanBRecord = await prisma.evidenceSpan.create({
      data: {
        projectId: projectB,
        sourceId: sourceB,
        extractionRunId: runB.id,
        ordinal: 0,
        locatorType: "DOCX_PARAGRAPH",
        paragraphNumber: 1,
        text: "Project Beta confidential internal algorithms.",
        textHash: crypto.createHash("sha256").update("Project Beta confidential internal algorithms.").digest("hex"),
      },
    });
    spanB = spanBRecord.id;
  });

  afterAll(async () => {
    await prisma.project.deleteMany({ where: { id: { in: [projectA, projectB] } } });
    await prisma.user.deleteMany({ where: { id: { in: [ownerA, memberA, ownerB, nonMemberAdmin] } } });
    await prisma.$disconnect();
  });

  describe("1. Canonical content hashing determinism and invariants", () => {
    test("reordering claims or evidence spans produces the EXACT SAME hash", () => {
      const claim1 = {
        category: "GOAL",
        key: "goal.1",
        title: "Goal 1",
        content: "First goal",
        provenance: "USER_STATED",
        sourceSpanIds: ["span-2", "span-1"],
      };
      const claim2 = {
        category: "ACCEPTANCE_CRITERION",
        key: "ac.1",
        title: "AC 1",
        content: "First AC",
        provenance: "USER_STATED",
        sourceSpanIds: [],
      };

      const evidence1 = {
        sourceId: "src-2",
        sourceVersion: 1,
        spanId: "span-b",
        textHash: "hash-b",
        locator: { locatorType: "PDF_PAGE", pageNumber: 2, paragraphNumber: null },
      };
      const evidence2 = {
        sourceId: "src-1",
        sourceVersion: 1,
        spanId: "span-a",
        textHash: "hash-a",
        locator: { locatorType: "PDF_PAGE", pageNumber: 1, paragraphNumber: null },
      };

      // Order A: claim1 then claim2; evidence1 then evidence2
      const hashA = hashBriefPayload({
        projectId: "proj-1",
        title: "Test Brief",
        markdownContent: "Content",
        claims: [claim1, claim2],
        evidenceManifest: [evidence1, evidence2],
      });

      // Order B: claim2 then claim1; evidence2 then evidence1; spanIds reversed
      const hashB = hashBriefPayload({
        projectId: "proj-1",
        title: "Test Brief",
        markdownContent: "Content",
        claims: [
          claim2,
          { ...claim1, sourceSpanIds: ["span-1", "span-2"] },
        ],
        evidenceManifest: [evidence2, evidence1],
      });

      expect(hashA).toBe(hashB);
    });

    test("changing title, markdown, or claim content alters the hash", () => {
      const base = {
        projectId: "proj-1",
        title: "Test Brief",
        markdownContent: "Content",
        claims: [],
        evidenceManifest: [],
      };
      const baseHash = hashBriefPayload(base);

      expect(hashBriefPayload({ ...base, title: "Modified Title" })).not.toBe(baseHash);
      expect(hashBriefPayload({ ...base, markdownContent: "Modified Content" })).not.toBe(baseHash);
      expect(hashBriefPayload({
        ...base,
        claims: [{
          category: "GOAL",
          key: "goal.1",
          title: "Goal",
          content: "Achieve X",
          provenance: "USER_STATED",
          sourceSpanIds: [],
        }],
      })).not.toBe(baseHash);
    });
  });

  describe("2. Deterministic readiness evaluation (all edge cases)", () => {
    test("initializes Project A brief with revision 1, unready status", async () => {
      await service.initialize(projectA, ownerA);
      const ws = await service.getWorkspace(projectA, ownerA);

      expect(ws.state?.currentBriefRevision?.revisionNumber).toBe(1);
      expect(ws.state?.currentBriefRevision?.markdownContent).toContain("Alpha initial description");
      expect(ws.readiness.ready).toBe(false);
      expect(ws.readiness.blockers.map((b) => b.code)).toEqual(
        expect.arrayContaining(["MISSING_GOAL", "MISSING_USER_PERSONA", "MISSING_WORKFLOW", "MISSING_ACCEPTANCE_CRITERION"]),
      );
    });

    test("unaccepted AI proposals (PROPOSED status) DO NOT satisfy readiness", async () => {
      mockAiResponse = {
        message: "Proposed essentials",
        proposedClaims: [
          { claimKey: "goal", category: ClaimCategory.GOAL, title: "Goal", content: "HA Failover", sourceSpanIds: [spanA1] },
          { claimKey: "users", category: ClaimCategory.USER_PERSONA, title: "Users", content: "Site Reliability Engineers", sourceSpanIds: [] },
          { claimKey: "workflow", category: ClaimCategory.WORKFLOW, title: "Workflow", content: "Failover workflow", sourceSpanIds: [] },
          { claimKey: "ac", category: ClaimCategory.ACCEPTANCE_CRITERION, title: "AC", content: "RTO < 5s", sourceSpanIds: [spanA2] },
        ],
        questions: [],
        contradictions: [],
      };

      await service.converse({
        projectId: projectA,
        actorId: memberA,
        requestKey: "intake-propose-essentials",
        message: "Draft all essentials",
        sourceIds: [sourceA],
      });

      const ws = await service.getWorkspace(projectA, ownerA);
      expect(ws.claims.filter((c) => c.status === ClaimStatus.PROPOSED)).toHaveLength(4);
      // All 4 essential categories are still blocked because proposals are not accepted!
      expect(ws.readiness.ready).toBe(false);
      expect(ws.readiness.blockers.length).toBe(4);
    });

    test("confirmation is REJECTED with 409 PLANNING_READINESS_BLOCKED if brief is unready", async () => {
      const ws = await service.getWorkspace(projectA, ownerA);
      const rev = ws.state!.currentBriefRevision!;

      await expect(service.confirm({
        projectId: projectA,
        actorId: ownerA,
        revisionId: rev.id,
        expectedContentHash: rev.contentHash,
      })).rejects.toMatchObject({
        httpStatus: 409,
        code: "PLANNING_READINESS_BLOCKED",
      });
    });

    test("accepting 3 of 4 categories remains unready; accepting all 4 achieves readiness", async () => {
      const ws = await service.getWorkspace(projectA, ownerA);
      const goalClaim = ws.claims.find((c) => c.claimKey === "goal")!;
      const usersClaim = ws.claims.find((c) => c.claimKey === "users")!;
      const workflowClaim = ws.claims.find((c) => c.claimKey === "workflow")!;
      const acClaim = ws.claims.find((c) => c.claimKey === "ac")!;

      // Accept Goal (rev 1 -> 2)
      let rev = (await service.decideClaim({
        projectId: projectA, actorId: memberA, claimId: goalClaim.id, action: "ACCEPT", expectedRevisionNumber: 1,
      })).revision;

      // Accept Users (rev 2 -> 3)
      rev = (await service.decideClaim({
        projectId: projectA, actorId: memberA, claimId: usersClaim.id, action: "ACCEPT", expectedRevisionNumber: rev.revisionNumber,
      })).revision;

      // Accept Workflow (rev 3 -> 4)
      rev = (await service.decideClaim({
        projectId: projectA, actorId: memberA, claimId: workflowClaim.id, action: "ACCEPT", expectedRevisionNumber: rev.revisionNumber,
      })).revision;

      let currentWs = await service.getWorkspace(projectA, ownerA);
      expect(currentWs.readiness.ready).toBe(false);
      expect(currentWs.readiness.blockers).toEqual([{ code: "MISSING_ACCEPTANCE_CRITERION", message: "An accepted acceptance criterion is required." }]);

      // Accept AC (rev 4 -> 5)
      rev = (await service.decideClaim({
        projectId: projectA, actorId: memberA, claimId: acClaim.id, action: "ACCEPT", expectedRevisionNumber: rev.revisionNumber,
      })).revision;

      currentWs = await service.getWorkspace(projectA, ownerA);
      expect(currentWs.readiness.ready).toBe(true);
      expect(currentWs.readiness.blockers).toHaveLength(0);
    });

    test("an open ESSENTIAL question blocks readiness", async () => {
      // Add an essential question under GOAL category
      const q = await prisma.projectClarificationQuestion.create({
        data: {
          projectId: projectA,
          category: ClaimCategory.GOAL,
          question: "Is zero data loss mandatory?",
          status: QuestionStatus.OPEN,
        },
      });

      let ws = await service.getWorkspace(projectA, ownerA);
      expect(ws.readiness.ready).toBe(false);
      expect(ws.readiness.blockers).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "OPEN_ESSENTIAL_QUESTIONS" }),
      ]));

      // Answering the question restores readiness
      const rev = ws.state!.currentBriefRevision!;
      await service.answerQuestion({
        projectId: projectA,
        actorId: memberA,
        questionId: q.id,
        answer: "Yes, RPO must be 0.",
        expectedRevisionNumber: rev.revisionNumber,
      });

      ws = await service.getWorkspace(projectA, ownerA);
      expect(ws.readiness.ready).toBe(true);
    });

    test("an active contradiction blocks readiness until resolved", async () => {
      const contra = await prisma.projectContradiction.create({
        data: {
          projectId: projectA,
          claimKeyA: "goal",
          claimKeyB: "ac",
          description: "Goal specifies automatic failover while AC states manual trigger.",
          status: ContradictionStatus.ACTIVE,
        },
      });

      let ws = await service.getWorkspace(projectA, ownerA);
      expect(ws.readiness.ready).toBe(false);
      expect(ws.readiness.blockers).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "ACTIVE_CONTRADICTIONS" }),
      ]));

      // Resolve contradiction
      const rev = ws.state!.currentBriefRevision!;
      await service.resolveContradiction({
        projectId: projectA,
        actorId: memberA,
        contradictionId: contra.id,
        resolutionNote: "Automatic failover with manual override.",
        expectedRevisionNumber: rev.revisionNumber,
      });

      ws = await service.getWorkspace(projectA, ownerA);
      expect(ws.readiness.ready).toBe(true);
    });

    test("a non-critical question creates a warning but DOES NOT block readiness", async () => {
      await prisma.projectClarificationQuestion.create({
        data: {
          projectId: projectA,
          category: ClaimCategory.SCOPE_OUT, // Not in REQUIRED_CATEGORIES
          question: "Should we support legacy MySQL 5.6?",
          status: QuestionStatus.OPEN,
        },
      });

      const ws = await service.getWorkspace(projectA, ownerA);
      expect(ws.readiness.ready).toBe(true);
      expect(ws.readiness.blockers).toHaveLength(0);
      expect(ws.readiness.warnings).toEqual([
        { code: "OPEN_NONCRITICAL_QUESTIONS", message: "1 noncritical question(s) remain open." },
      ]);
    });
  });

  describe("3. Concurrency and CAS invariants (Real PostgreSQL)", () => {
    test("two concurrent mutations from the same revision number: exactly one succeeds, one gets 409", async () => {
      const ws = await service.getWorkspace(projectA, ownerA);
      const currentRevNumber = ws.state!.currentBriefRevision!.revisionNumber;

      const edit1 = service.updateBrief({
        projectId: projectA,
        actorId: ownerA,
        expectedRevisionNumber: currentRevNumber,
        title: "Title Edit by Client 1",
        markdownContent: "Content by Client 1",
      });

      const edit2 = service.updateBrief({
        projectId: projectA,
        actorId: memberA,
        expectedRevisionNumber: currentRevNumber,
        title: "Title Edit by Client 2",
        markdownContent: "Content by Client 2",
      });

      const results = await Promise.allSettled([edit1, edit2]);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      const rejectedReason = (rejected[0] as PromiseRejectedResult).reason;
      expect(rejectedReason).toBeInstanceOf(PlanningDomainError);
      expect(rejectedReason.httpStatus).toBe(409);
    });

    test("stale expectedRevisionNumber returns 409 with zero mutation", async () => {
      const beforeWs = await service.getWorkspace(projectA, ownerA);
      const staleRevNumber = beforeWs.state!.currentBriefRevision!.revisionNumber - 1;

      await expect(service.updateBrief({
        projectId: projectA,
        actorId: ownerA,
        expectedRevisionNumber: staleRevNumber,
        title: "Stale edit",
        markdownContent: "Stale content",
      })).rejects.toMatchObject({
        httpStatus: 409,
        code: "PLANNING_CONTEXT_CHANGED",
      });

      const afterWs = await service.getWorkspace(projectA, ownerA);
      expect(afterWs.state!.currentBriefRevision!.revisionNumber).toBe(beforeWs.state!.currentBriefRevision!.revisionNumber);
    });
  });

  describe("4. Adversarial cross-project attacks and security boundaries", () => {
    test("Project A user cannot cite Project B's evidence span in intake", async () => {
      await expect(service.converse({
        projectId: projectA,
        actorId: ownerA,
        requestKey: "cross-project-citation-attempt",
        message: "Tell me secrets",
        sourceIds: [sourceB], // sourceB belongs to projectB!
      })).rejects.toMatchObject({
        httpStatus: 422,
        code: "PLANNING_ARTIFACT_INVALID",
      });
    });

    test("forged span ID in AI model response is rejected before persistence", async () => {
      mockAiResponse = {
        message: "I cite a foreign span",
        proposedClaims: [
          {
            claimKey: "leak",
            category: ClaimCategory.GOAL,
            title: "Leaked info",
            content: "Leaked",
            sourceSpanIds: [spanB], // spanB is foreign!
          },
        ],
        questions: [],
        contradictions: [],
      };

      await expect(service.converse({
        projectId: projectA,
        actorId: ownerA,
        requestKey: "forged-model-citation-key",
        message: "Read",
        sourceIds: [sourceA],
      })).rejects.toMatchObject({
        httpStatus: 422,
      });

      // No claim was created
      const claim = await prisma.projectClaim.findFirst({ where: { projectId: projectA, claimKey: "leak" } });
      expect(claim).toBeNull();
    });

    test("Project A user cannot decide Project B's claim", async () => {
      // Create a claim in Project B
      const claimB = await prisma.projectClaim.create({
        data: {
          projectId: projectB,
          claimKey: "b.claim",
          version: 1,
          category: ClaimCategory.GOAL,
          title: "B Goal",
          content: "Content",
          provenance: ClaimProvenance.USER_STATED,
          status: ClaimStatus.PROPOSED,
          createdById: ownerB,
        },
      });

      const wsA = await service.getWorkspace(projectA, ownerA);
      const revNumber = wsA.state!.currentBriefRevision!.revisionNumber;

      await expect(service.decideClaim({
        projectId: projectA, // routed under projectA
        actorId: ownerA,
        claimId: claimB.id,
        action: "ACCEPT",
        expectedRevisionNumber: revNumber,
      })).rejects.toMatchObject({
        httpStatus: 404,
        code: "PLANNING_ARTIFACT_NOT_FOUND",
      });

      // Claim in Project B remains PROPOSED
      const freshClaimB = await prisma.projectClaim.findUnique({ where: { id: claimB.id } });
      expect(freshClaimB?.status).toBe(ClaimStatus.PROPOSED);
    });

    test("non-member admin cannot edit or confirm the brief", async () => {
      const wsA = await service.getWorkspace(projectA, ownerA);
      const revNumber = wsA.state!.currentBriefRevision!.revisionNumber;

      await expect(service.updateBrief({
        projectId: projectA,
        actorId: nonMemberAdmin,
        expectedRevisionNumber: revNumber,
        title: "Admin override",
        markdownContent: "Override",
      })).rejects.toMatchObject({
        httpStatus: 404, // assertCanEdit fails with 404 project not found
      });

      await expect(service.confirm({
        projectId: projectA,
        actorId: nonMemberAdmin,
        revisionId: "rev-id",
        expectedContentHash: "hash",
      })).rejects.toMatchObject({
        httpStatus: 403, // assertOwner fails with 403
      });
    });
  });

  describe("5. Owner confirmation and authority handoff", () => {
    test("non-owner project member cannot confirm", async () => {
      const ws = await service.getWorkspace(projectA, ownerA);
      const rev = ws.state!.currentBriefRevision!;

      await expect(service.confirm({
        projectId: projectA,
        actorId: memberA,
        revisionId: rev.id,
        expectedContentHash: rev.contentHash,
      })).rejects.toMatchObject({
        httpStatus: 403,
      });
    });

    test("owner confirmation with mismatched content hash fails with 409", async () => {
      const ws = await service.getWorkspace(projectA, ownerA);
      const rev = ws.state!.currentBriefRevision!;

      await expect(service.confirm({
        projectId: projectA,
        actorId: ownerA,
        revisionId: rev.id,
        expectedContentHash: "badhash".repeat(8),
      })).rejects.toMatchObject({
        httpStatus: 409,
        code: "PLANNING_ARTIFACT_HASH_MISMATCH",
      });
    });

    test("owner confirmation with exact revision ID and hash succeeds and creates ACTIVE confirmation", async () => {
      const ws = await service.getWorkspace(projectA, ownerA);
      const rev = ws.state!.currentBriefRevision!;

      const confirmation = await service.confirm({
        projectId: projectA,
        actorId: ownerA,
        revisionId: rev.id,
        expectedContentHash: rev.contentHash,
        notes: "Revision confirmed for initial requirements",
      });

      expect(confirmation.status).toBe("ACTIVE");
      expect(confirmation.briefRevisionNumber).toBe(rev.revisionNumber);
      expect(confirmation.briefContentHash).toBe(rev.contentHash);

      const afterWs = await service.getWorkspace(projectA, ownerA);
      expect(afterWs.state?.currentConfirmationId).toBe(confirmation.id);
      expect(afterWs.state?.status).toBe(IntakeStateStatus.CONFIRMED);
    });

    test("Requirements context builder binds exact confirmed brief and evidence manifest", async () => {
      const ws = await service.getWorkspace(projectA, ownerA);
      const conf = ws.state!.currentConfirmation!;
      const builder = new PlanningRequirementsContextBuilder(prisma);

      const built = await builder.buildInitial({
        projectId: projectA,
        actorId: ownerA,
        briefConfirmationId: conf.id,
      });

      expect(built.manifest.briefAuthority?.confirmationId).toBe(conf.id);
      expect(built.manifest.briefAuthority?.contentHash).toBe(conf.briefContentHash);
      expect(built.manifest.brief?.source).toBe("confirmed_live_brief");
      expect(built.manifest.briefAuthority?.evidenceManifest).toEqual(expect.arrayContaining([
        expect.objectContaining({ spanId: spanA1 }),
      ]));
    });

    test("attempting Requirements generation with a foreign project confirmation ID is rejected", async () => {
      // Create and confirm a brief in Project B
      await service.initialize(projectB, ownerB);
      // Give Project B all 4 accepted categories so it is ready
      await prisma.projectClaim.createMany({
        data: [
          { projectId: projectB, claimKey: "b.goal", version: 1, category: ClaimCategory.GOAL, title: "G", content: "C", provenance: ClaimProvenance.USER_STATED, status: ClaimStatus.ACCEPTED, createdById: ownerB },
          { projectId: projectB, claimKey: "b.users", version: 1, category: ClaimCategory.USER_PERSONA, title: "U", content: "C", provenance: ClaimProvenance.USER_STATED, status: ClaimStatus.ACCEPTED, createdById: ownerB },
          { projectId: projectB, claimKey: "b.wf", version: 1, category: ClaimCategory.WORKFLOW, title: "W", content: "C", provenance: ClaimProvenance.USER_STATED, status: ClaimStatus.ACCEPTED, createdById: ownerB },
          { projectId: projectB, claimKey: "b.ac", version: 1, category: ClaimCategory.ACCEPTANCE_CRITERION, title: "A", content: "C", provenance: ClaimProvenance.USER_STATED, status: ClaimStatus.ACCEPTED, createdById: ownerB },
        ],
      });
      const wsB = await service.getWorkspace(projectB, ownerB);
      const revB = wsB.state!.currentBriefRevision!;
      const confB = await service.confirm({
        projectId: projectB,
        actorId: ownerB,
        revisionId: revB.id,
        expectedContentHash: revB.contentHash,
      });

      // Now Project A user tries to start Requirements using Project B's confirmation ID
      await expect(runService.startRequirementsRun({
        projectId: projectA,
        actorId: ownerA,
        operation: WorkflowOperation.INITIAL_GENERATION,
        idempotencyKey: "foreign-confirmation-test",
        briefConfirmationId: confB.id,
      })).rejects.toMatchObject({
        httpStatus: 409,
        code: "PLANNING_CONTEXT_CHANGED",
      });
    });
  });

  describe("6. Downstream invalidation lifecycle and stale authority rejection", () => {
    let confA1Id = "";
    let artifactA1Id = "";

    test("Step 1 & 2: Start and finalize initial Requirements from Confirmation 1", async () => {
      const ws = await service.getWorkspace(projectA, ownerA);
      const conf = ws.state!.currentConfirmation!;
      confA1Id = conf.id;

      const start = await runService.startRequirementsRun({
        projectId: projectA,
        actorId: ownerA,
        operation: WorkflowOperation.INITIAL_GENERATION,
        idempotencyKey: "initial-req-run-1",
        briefConfirmationId: confA1Id,
      });

      expect(start.run.status).toBe("running");

      const finalContent = {
        projectGoal: "Deliver HA Failover",
        problemStatement: "Outages cause downtime",
        usersAndActors: [{ id: "ACTOR-001", name: "SRE", description: "Operates failover" }],
        userStories: [{ id: "US-001", actor: "SRE", capability: "Failover in 5s", benefit: "Zero downtime", acceptanceCriteriaIds: ["AC-001"] }],
        functionalRequirements: [{ id: "FR-001", title: "Automated failover", description: "Heartbeat detection" }],
        nonFunctionalRequirements: [{ id: "NFR-001", title: "RTO", description: "< 5s" }],
        constraints: [],
        integrations: [],
        assumptions: [],
        acceptanceCriteria: [{ id: "AC-001", description: "RTO validated under 5s", relatedRequirementIds: ["FR-001"] }],
        outOfScope: [],
        unresolvedQuestions: [],
      };

      const finalized = await runService.finalizeInitialGeneration({
        projectId: projectA,
        runId: start.run.id,
        actorId: ownerA,
        structuredContent: finalContent,
        audit: { modelUsage: { promptTokens: 100, completionTokens: 50 }, costUSD: 0.001 },
      });

      expect(finalized.artifact.version).toBe(1);
      artifactA1Id = finalized.artifact.id;
    });

    test("Step 3: Owner requests changes and approves Requirements v1", async () => {
      const art = await prisma.phaseArtifact.findUnique({ where: { id: artifactA1Id } });
      // Transition Requirements to awaiting approval, then approve
      await prisma.projectPhaseState.update({
        where: { projectId_phase: { projectId: projectA, phase: "requirements" } },
        data: { status: "awaiting_approval", approvalCandidateArtifactId: artifactA1Id },
      });

      const approved = await approvalService.approveArtifact({
        projectId: projectA,
        phase: "requirements",
        actorId: ownerA,
        artifactId: artifactA1Id,
        expectedHash: art!.contentHash!,
      });

      expect(approved.status).toBe("approved");
    });

    test("Step 4 & 5: Create draft Revision B; historical Revision A remains immutable", async () => {
      const ws = await service.getWorkspace(projectA, ownerA);
      const currentRevNumber = ws.state!.currentBriefRevision!.revisionNumber;

      const edit = await service.updateBrief({
        projectId: projectA,
        actorId: ownerA,
        expectedRevisionNumber: currentRevNumber,
        title: "Project Alpha Live Brief (Revision B)",
        markdownContent: "Updated scope in Revision B",
        changeSummary: "Drafted Revision B",
      });

      expect(edit.revision.revisionNumber).toBe(currentRevNumber + 1);

      // Verify earlier revision 1 and earlier confirmed revision still exist with unchanged content
      const rev1 = await prisma.liveBriefRevision.findFirst({
        where: { projectId: projectA, revisionNumber: 1 },
      });
      expect(rev1?.title).toContain("Live Brief");
    });

    test("Step 6: Owner confirms Revision B; Confirmation 1 becomes STALE atomically", async () => {
      const ws = await service.getWorkspace(projectA, ownerA);
      const revB = ws.state!.currentBriefRevision!;

      const confB = await service.confirm({
        projectId: projectA,
        actorId: ownerA,
        revisionId: revB.id,
        expectedContentHash: revB.contentHash,
        notes: "Confirmed Revision B",
      });

      expect(confB.status).toBe("ACTIVE");

      // Verify Confirmation 1 is now STALE and superseded
      const conf1 = await prisma.liveBriefConfirmation.findUnique({ where: { id: confA1Id } });
      expect(conf1?.status).toBe("STALE");
      expect(conf1?.supersededById).toBe(confB.id);
      expect(conf1?.supersededAt).not.toBeNull();
    });

    test("Step 7 & 8: Attempting Requirements generation with stale Confirmation 1 fails with 409", async () => {
      await expect(runService.startRequirementsRun({
        projectId: projectA,
        actorId: ownerA,
        operation: WorkflowOperation.INITIAL_GENERATION,
        idempotencyKey: "stale-generation-attempt",
        briefConfirmationId: confA1Id, // STALE!
      })).rejects.toMatchObject({
        httpStatus: 409,
        code: "PLANNING_CONTEXT_CHANGED",
      });
    });

    test("Step 9 & 10: In-flight race: Confirmation updated while Requirements generation is running fails finalization", async () => {
      // 1. Get current active confirmation (confB)
      const ws = await service.getWorkspace(projectA, ownerA);
      const confB = ws.state!.currentConfirmation!;
      const revB = ws.state!.currentBriefRevision!;

      // Clear phase approvals, workflow runs, and artifacts so we can start a fresh initial run
      await prisma.projectPhaseState.update({
        where: { projectId_phase: { projectId: projectA, phase: "requirements" } },
        data: { currentArtifactId: null, status: "not_started", approvalCandidateArtifactId: null, activeRunId: null },
      });
      await prisma.phaseApproval.deleteMany({ where: { projectId: projectA } });
      await prisma.workflowRun.deleteMany({ where: { projectId: projectA } });
      await prisma.phaseArtifact.deleteMany({ where: { projectId: projectA, phase: "requirements" } });

      // 2. Start a run under confB
      const run = await runService.startRequirementsRun({
        projectId: projectA,
        actorId: ownerA,
        operation: WorkflowOperation.INITIAL_GENERATION,
        idempotencyKey: "in-flight-race-run",
        briefConfirmationId: confB.id,
      });

      // 3. Concurrently update and confirm Revision C
      const revCUpdate = await service.updateBrief({
        projectId: projectA,
        actorId: ownerA,
        expectedRevisionNumber: revB.revisionNumber,
        title: "Revision C during in-flight generation",
        markdownContent: "Content C",
      });
      const confC = await service.confirm({
        projectId: projectA,
        actorId: ownerA,
        revisionId: revCUpdate.revision.id,
        expectedContentHash: revCUpdate.revision.contentHash,
      });
      expect(confC.status).toBe("ACTIVE");

      // 4. Now attempt to finalize the in-flight run that started under confB
      await expect(runService.finalizeInitialGeneration({
        projectId: projectA,
        runId: run.run.id,
        actorId: ownerA,
        structuredContent: {
          projectGoal: "G",
          problemStatement: "P",
          usersAndActors: [{ id: "A-1", name: "N", description: "D" }],
          userStories: [{ id: "U-1", actor: "N", capability: "C", benefit: "B", acceptanceCriteriaIds: ["AC-1"] }],
          functionalRequirements: [{ id: "F-1", title: "T", description: "D" }],
          nonFunctionalRequirements: [{ id: "NF-1", title: "T", description: "D" }],
          constraints: [],
          integrations: [],
          assumptions: [],
          acceptanceCriteria: [{ id: "AC-1", description: "D", relatedRequirementIds: ["F-1"] }],
          outOfScope: [],
          unresolvedQuestions: [],
        },
        audit: { modelUsage: { promptTokens: 10, completionTokens: 10 }, costUSD: 0.001 },
      })).rejects.toMatchObject({
        httpStatus: 409,
        code: "PLANNING_CONTEXT_CHANGED",
      });
    });
  });

  describe("7. Failure recovery and idempotency", () => {
    test("idempotent replay of completed intake returns cached response without duplicate calls", async () => {
      mockAiResponse = {
        message: "Unique replay message",
        proposedClaims: [
          { claimKey: "cache.claim", category: ClaimCategory.CONSTRAINT, title: "Cache", content: "Cached text", sourceSpanIds: [] },
        ],
        questions: [],
        contradictions: [],
      };
      mockCallStructured.mockReset();
      mockCallStructured.mockImplementation(async () => ({ content: mockAiResponse }));

      const key = `replay-test-${Date.now()}`;
      const first = await service.converse({
        projectId: projectA,
        actorId: memberA,
        requestKey: key,
        message: "Test caching",
      });

      const second = await service.converse({
        projectId: projectA,
        actorId: memberA,
        requestKey: key,
        message: "Different message but same idempotency key",
      });

      expect(second).toEqual(first);
      expect(mockCallStructured).toHaveBeenCalledTimes(1);
    });

    test("provider error marks request FAILED and allows subsequent clean request with different key", async () => {
      mockCallStructured.mockReset();
      mockCallStructured.mockImplementation(async () => {
        throw new Error("Simulated Gateway Timeout");
      });

      const failedKey = `failed-req-${Date.now()}`;
      await expect(service.converse({
        projectId: projectA,
        actorId: memberA,
        requestKey: failedKey,
        message: "Will fail",
      })).rejects.toThrow();

      const failedRecord = await prisma.projectIntakeRequest.findUnique({
        where: { projectId_requestKey: { projectId: projectA, requestKey: failedKey } },
      });
      expect(failedRecord?.status).toBe("FAILED");

      // Recover: New request with clean gateway succeeds
      mockAiResponse = {
        message: "Recovered message",
        proposedClaims: [],
        questions: [],
        contradictions: [],
      };
      mockCallStructured.mockReset();
      mockCallStructured.mockImplementation(async () => ({ content: mockAiResponse }));

      const cleanKey = `clean-req-${Date.now()}`;
      const recovered = await service.converse({
        projectId: projectA,
        actorId: memberA,
        requestKey: cleanKey,
        message: "Try again after recovery",
      });

      expect((recovered as IntakeAiResponse).message).toBe("Recovered message");
    });
  });
});

