import crypto from "crypto";
import { ArtifactLifecycleStatus, PrismaClient, ClaimProvenance, ClaimStatus, ClaimCategory } from "@prisma/client";
import { LLMGateway } from "../../ai/gateway/LLMGateway";
import { PlanningDomainError } from "../../planning/planning-errors";
import { LiveBriefService, hashBriefPayload, CanonicalBriefClaim } from "../live-brief.service";
import { PlanningRequirementsRunService } from "../planning-requirements-run.service";
import { PlanningGenerationService } from "../planning-generation.service";
import { PlanningApprovalService } from "../planning-approval.service";
import { PlanningArtifactService } from "../planning-artifact.service";
import { AuthorityCurrentnessService } from "../authority-currentness.service";
import { PlanningDocumentationRunService } from "../planning-documentation-run.service";
import { PlanningDocumentationArtifactService } from "../planning-documentation-artifact.service";
import { PhaseService } from "../phase-service";
import { preflightArchitectureHandoff } from "../../planning/documentation-architecture-preflight";
import { resolveImplementationAuthority } from "../../planning/implementation-authority-preflight";
import { assembleDocumentationContent } from "../../planning/documentation-assembly";
import {
  RequirementsContent,
  hashRequirementsContent,
  renderRequirementsMarkdown,
  REQUIREMENTS_ARTIFACT_TYPE,
  REQUIREMENTS_PHASE,
  REQUIREMENTS_SCHEMA_VERSION,
} from "../../planning/requirements-schema";
import {
  DocumentationContent,
  DocumentationProviderDraft,
  hashDocumentationContent,
  renderDocumentationMarkdown,
  DOCUMENTATION_ARTIFACT_TYPE,
  DOCUMENTATION_SCHEMA_VERSION,
} from "../../planning/documentation-schema";
import { DOCUMENTATION_PHASE } from "../planning-documentation-artifact.service";
import { hashCanonical } from "../../planning/requirements-context";

const databaseUrl = process.env.DATABASE_URL;
const isolatedSchema = databaseUrl ? new URL(databaseUrl).searchParams.get("schema") : null;
const describeIsolated = isolatedSchema?.startsWith("planning_checkpoint_audit_") ? describe : describe.skip;

const prisma = new PrismaClient();

function mockRequirementsContent(label: string): RequirementsContent {
  return {
    projectGoal: `Goal for ${label}`,
    problemStatement: `Problem statement for ${label}`,
    usersAndActors: [{ id: "ACTOR-001", name: "Owner", description: "Standard user." }],
    userStories: [{
      id: "US-001",
      actor: "Owner",
      capability: `use ${label}`,
      benefit: "solve problem",
      acceptanceCriteriaIds: ["AC-001"],
    }],
    functionalRequirements: [{ id: "FR-001", title: "Core requirement", description: `Deliver ${label}.` }],
    nonFunctionalRequirements: [{ id: "NFR-001", title: "Security", description: "Audit trail." }],
    constraints: [],
    integrations: [],
    assumptions: [],
    acceptanceCriteria: [{ id: "AC-001", description: "Outcome verified when action taken.", relatedRequirementIds: ["FR-001"] }],
    outOfScope: [],
    unresolvedQuestions: [],
  };
}

function documentationDraft(req: RequirementsContent): DocumentationProviderDraft {
  const actor = req.usersAndActors[0].id;
  const story = req.userStories[0].id;
  const functional = req.functionalRequirements[0].id;
  const nonFunctional = req.nonFunctionalRequirements[0].id;
  return {
    overview: { summary: "Canonical Documentation", scope: "The approved scope", goals: [], nonGoals: [] },
    systemActors: [{ id: "DOC-ACTOR", name: "Owner", description: "Uses the workflow.", sourceActorIds: [actor] }],
    features: [{ id: "DOC-FEATURE", title: "Workflow", description: "Runs the workflow.", workflowSteps: ["Start", "Finish"], actorIds: ["DOC-ACTOR"], access: "controlled", sourceRequirementIds: [functional], sourceUserStoryIds: [story] }],
    apiContracts: { applicable: true, rationale: "A service contract is required.", items: [{ id: "DOC-API", name: "Run workflow", description: "Runs it.", interaction: { kind: "http", method: "POST", path: "/workflow" }, access: "controlled", input: { description: "Input", fields: [] }, success: { description: "Success", fields: [] }, relatedFeatureIds: ["DOC-FEATURE"], relatedEntityIds: ["DOC-ENTITY"], errorBehaviorIds: ["DOC-ERROR"], sourceRequirementIds: [nonFunctional], sourceUserStoryIds: [story] }] },
    dataEntities: { applicable: true, rationale: "State is persisted.", items: [{ id: "DOC-ENTITY", name: "Workflow", description: "Workflow state.", fields: [{ name: "id", logicalType: "identifier", required: true, description: "Identifier", allowedValues: [], validationRules: [] }], relationships: [], sourceRequirementIds: [nonFunctional], sourceUserStoryIds: [] }] },
    businessRules: [{ id: "DOC-RULE", title: "Owner review", condition: "Before approval", expectedBehavior: "Require the owner.", relatedFeatureIds: ["DOC-FEATURE"], relatedEntityIds: [], sourceRequirementIds: [functional], sourceUserStoryIds: [] }],
    permissionRules: { applicable: true, rationale: "The workflow is controlled.", items: [{ id: "DOC-PERMISSION", title: "Owner access", description: "Allow the owner.", effect: "allow", actorIds: ["DOC-ACTOR"], actions: ["approve"], relatedFeatureIds: ["DOC-FEATURE"], relatedApiContractIds: ["DOC-API"] }] },
    errorBehaviors: [{ id: "DOC-ERROR", code: "WORKFLOW_FAILED", scenario: "The workflow fails.", expectedSystemBehavior: "Reject safely.", recoveryBehavior: "Retry.", relatedFeatureIds: ["DOC-FEATURE"], relatedApiContractIds: ["DOC-API"], httpStatus: 409 }],
    edgeCases: [{ id: "DOC-EDGE", scenario: "Concurrent approval", expectedHandling: "Only one succeeds.", relatedFeatureIds: ["DOC-FEATURE"], relatedApiContractIds: ["DOC-API"], relatedEntityIds: ["DOC-ENTITY"] }],
    unresolvedQuestions: [],
  };
}

function mockLlmResult(content: RequirementsContent) {
  return {
    content,
    model: "gpt-4o",
    durationMs: 100,
    latencyMs: 100,
    providerAttempts: [{
      attemptNumber: 1,
      kind: "initial" as const,
      providerResponseId: "resp-1",
      providerRequestId: "req-1",
      model: "gpt-4o",
      finishReason: "stop",
      promptTokens: 100,
      completionTokens: 200,
      totalTokens: 300,
      usageSource: "provider" as const,
      latencyMs: 100,
    }],
    rawResponse: {
      id: "resp-1",
      model: "gpt-4o",
      usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
    },
  };
}

describeIsolated("Independent Verification: Legacy Authorization Remediation Audit", () => {
  let briefService: LiveBriefService;
  let currentnessService: AuthorityCurrentnessService;
  let reqRunService: PlanningRequirementsRunService;
  let reqGenService: PlanningGenerationService;
  let approvalService: PlanningApprovalService;
  let artifactService: PlanningArtifactService;
  let docRunService: PlanningDocumentationRunService;
  let docArtifactService: PlanningDocumentationArtifactService;
  let phaseService: PhaseService;

  const ownerA = `owner-a-${crypto.randomUUID()}`;
  const ownerB = `owner-b-${crypto.randomUUID()}`;

  beforeAll(async () => {
    await prisma.user.createMany({
      data: [
        { id: ownerA, email: `${ownerA}@test.local`, name: "Owner A", password: "pwd" },
        { id: ownerB, email: `${ownerB}@test.local`, name: "Owner B", password: "pwd" },
      ],
    });

    currentnessService = new AuthorityCurrentnessService(prisma);
    artifactService = new PlanningArtifactService(prisma);
    approvalService = new PlanningApprovalService(prisma);
    reqRunService = new PlanningRequirementsRunService(prisma, undefined, undefined, artifactService);
    docArtifactService = new PlanningDocumentationArtifactService(prisma);
    docRunService = new PlanningDocumentationRunService(prisma, { artifacts: docArtifactService });
    phaseService = new PhaseService(prisma);
    briefService = new LiveBriefService(prisma);

    const mockGenGateway = {
      callStructured: jest.fn(async () => mockLlmResult(mockRequirementsContent("Audited Brief"))),
    } as unknown as Pick<LLMGateway, "callStructured">;
    reqGenService = new PlanningGenerationService(prisma, {
      gateway: mockGenGateway,
      artifacts: artifactService,
      runs: reqRunService,
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // CASE A: New project without intake
  test("CASE A: New project without intake denies all authority-consuming actions", async () => {
    const projId = `case-a-${crypto.randomUUID()}`;
    await prisma.project.create({ data: { id: projId, name: "Case A Project", userId: ownerA } });
    await phaseService.ensurePhaseStates(projId, ownerA);

    // 1. Requirements creation attempt fails
    await expect(
      artifactService.createInitialArtifact({
        projectId: projId,
        actorId: ownerA,
        title: "Case A Requirements",
        structuredContent: mockRequirementsContent("Case A"),
      }),
    ).rejects.toMatchObject({
      code: "PLANNING_BRIEF_REQUIRED",
      httpStatus: 422,
    });

    // 2. Requirements approval attempt fails (no artifact exists)
    await expect(
      approvalService.approveArtifact({
        projectId: projId,
        phase: "requirements",
        artifactId: "non-existent-artifact",
        expectedHash: "hash",
        actorId: ownerA,
      }),
    ).rejects.toMatchObject({
      httpStatus: 404,
    });

    // 3. Documentation generation attempt fails
    await expect(
      docRunService.start({
        projectId: projId,
        actorId: ownerA,
        operation: "INITIAL_GENERATION",
        idempotencyKey: `doc-gen-${crypto.randomUUID()}`,
      }),
    ).rejects.toMatchObject({
      code: "PLANNING_ACTION_LOCKED",
      httpStatus: 409,
    });

    // 4. Architecture generation preflight fails
    await expect(
      preflightArchitectureHandoff(prisma, projId),
    ).rejects.toMatchObject({
      code: "PLANNING_ACTION_LOCKED",
      httpStatus: 409,
    });

    // 5. Implementation authority preflight fails
    await expect(
      resolveImplementationAuthority(prisma, projId, ownerA),
    ).rejects.toMatchObject({
      code: "PLANNING_ACTION_LOCKED",
      httpStatus: 409,
    });

    // Verify zero artifacts created
    const artifactCount = await prisma.phaseArtifact.count({ where: { projectId: projId } });
    expect(artifactCount).toBe(0);
  });

  // CASE B: Initialized but unconfirmed brief
  test("CASE B: Initialized but unconfirmed Live Brief denies all authority-consuming actions", async () => {
    const projId = `case-b-${crypto.randomUUID()}`;
    await prisma.project.create({ data: { id: projId, name: "Case B Project", userId: ownerA } });
    await phaseService.ensurePhaseStates(projId, ownerA);

    // Initialize brief but do NOT confirm
    await briefService.initialize(projId, ownerA);
    const intakeState = await prisma.projectIntakeState.findUnique({ where: { projectId: projId } });
    expect(intakeState?.status).toBe("EMPTY");
    expect(intakeState?.currentConfirmationId).toBeNull();

    // 1. Requirements creation attempt fails
    await expect(
      artifactService.createInitialArtifact({
        projectId: projId,
        actorId: ownerA,
        title: "Case B Requirements",
        structuredContent: mockRequirementsContent("Case B"),
      }),
    ).rejects.toMatchObject({
      code: "PLANNING_BRIEF_REQUIRED",
      httpStatus: 422,
    });

    // 2. Documentation generation attempt fails
    await expect(
      docRunService.start({
        projectId: projId,
        actorId: ownerA,
        operation: "INITIAL_GENERATION",
        idempotencyKey: `doc-gen-${crypto.randomUUID()}`,
      }),
    ).rejects.toMatchObject({
      code: "PLANNING_ACTION_LOCKED",
      httpStatus: 409,
    });

    // 3. Architecture handoff preflight fails
    await expect(
      preflightArchitectureHandoff(prisma, projId),
    ).rejects.toMatchObject({
      code: "PLANNING_ACTION_LOCKED",
      httpStatus: 409,
    });

    // 4. Implementation authority preflight fails
    await expect(
      resolveImplementationAuthority(prisma, projId, ownerA),
    ).rejects.toMatchObject({
      code: "PLANNING_ACTION_LOCKED",
      httpStatus: 409,
    });
  });

  // CASE C: Valid confirmed brief
  test("CASE C: Valid confirmed Live Brief grants authority, allows Requirements generation & downstream handoff", async () => {
    const projId = `case-c-${crypto.randomUUID()}`;
    await prisma.project.create({ data: { id: projId, name: "Case C Project", userId: ownerA } });
    await phaseService.ensurePhaseStates(projId, ownerA);

    await briefService.initialize(projId, ownerA);
    // Add all 4 required claim categories to satisfy readiness
    await prisma.projectClaim.createMany({
      data: [
        { projectId: projId, claimKey: "GOAL-001", category: ClaimCategory.GOAL, title: "Goal", content: "Build ANKA OS", provenance: ClaimProvenance.USER_STATED, status: ClaimStatus.ACCEPTED, createdById: ownerA, createdByType: "HUMAN" },
        { projectId: projId, claimKey: "USER-001", category: ClaimCategory.USER_PERSONA, title: "User Persona", content: "Platform Engineers", provenance: ClaimProvenance.USER_STATED, status: ClaimStatus.ACCEPTED, createdById: ownerA, createdByType: "HUMAN" },
        { projectId: projId, claimKey: "WF-001", category: ClaimCategory.WORKFLOW, title: "Workflow", content: "Spec to tasks", provenance: ClaimProvenance.USER_STATED, status: ClaimStatus.ACCEPTED, createdById: ownerA, createdByType: "HUMAN" },
        { projectId: projId, claimKey: "AC-001", category: ClaimCategory.ACCEPTANCE_CRITERION, title: "Acceptance Criteria", content: "Deterministic verification", provenance: ClaimProvenance.USER_STATED, status: ClaimStatus.ACCEPTED, createdById: ownerA, createdByType: "HUMAN" },
      ],
    });

    // Refresh revision to include accepted claims matching CanonicalBriefClaim schema
    const intake = await prisma.projectIntakeState.findUniqueOrThrow({ where: { projectId: projId }, include: { currentBriefRevision: true } });
    const rev = intake.currentBriefRevision!;
    const claims: CanonicalBriefClaim[] = [
      { category: ClaimCategory.GOAL, key: "GOAL-001", title: "Goal", content: "Build ANKA OS", provenance: "USER_STATED", sourceSpanIds: [] },
      { category: ClaimCategory.USER_PERSONA, key: "USER-001", title: "User Persona", content: "Platform Engineers", provenance: "USER_STATED", sourceSpanIds: [] },
      { category: ClaimCategory.WORKFLOW, key: "WF-001", title: "Workflow", content: "Spec to tasks", provenance: "USER_STATED", sourceSpanIds: [] },
      { category: ClaimCategory.ACCEPTANCE_CRITERION, key: "AC-001", title: "Acceptance Criteria", content: "Deterministic verification", provenance: "USER_STATED", sourceSpanIds: [] },
    ];
    const payload = {
      projectId: projId,
      title: rev.title,
      markdownContent: rev.markdownContent,
      claims,
      evidenceManifest: [],
    };
    const contentHash = hashBriefPayload(payload);
    const updatedRev = await prisma.liveBriefRevision.update({
      where: { id: rev.id },
      data: {
        structuredClaims: claims as any,
        contentHash,
      },
    });

    const confirmation = await briefService.confirm({
      projectId: projId,
      actorId: ownerA,
      revisionId: updatedRev.id,
      expectedContentHash: contentHash,
      notes: "Confirmed for Case C",
    });
    expect(confirmation.status).toBe("ACTIVE");

    // Generate Requirements
    const genResult = await reqGenService.generateInitialRequirements({
      projectId: projId,
      actorId: ownerA,
      idempotencyKey: `gen-req-c-${crypto.randomUUID()}`,
      briefConfirmationId: confirmation.id,
    });
    expect(genResult.run.status).toBe("completed");
    expect(genResult.artifact).not.toBeNull();
    const reqArtifact = genResult.artifact!;

    // Verify artifact is current
    const currentness = await currentnessService.getRequirementsArtifactCurrentness(prisma, projId, reqArtifact);
    expect(currentness.isCurrent).toBe(true);
    expect(currentness.isStale).toBe(false);
    expect(currentness.status).toBe("CURRENT");

    // Request and approve Requirements
    await approvalService.requestApproval({
      projectId: projId,
      phase: "requirements",
      artifactId: reqArtifact.id,
      expectedHash: reqArtifact.contentHash!,
      actorId: ownerA,
    });
    const approvedState = await approvalService.approveArtifact({
      projectId: projId,
      phase: "requirements",
      artifactId: reqArtifact.id,
      expectedHash: reqArtifact.contentHash!,
      actorId: ownerA,
    });
    expect(approvedState.status).toBe("approved");

    // Verify Documentation generation run starts successfully
    const docStart = await docRunService.start({
      projectId: projId,
      actorId: ownerA,
      operation: "INITIAL_GENERATION",
      idempotencyKey: `doc-gen-c-${crypto.randomUUID()}`,
    });
    expect(docStart.run.status).toBe("running");
  });

  // CASE D: Superseded confirmation
  test("CASE D: Superseded confirmation invalidates Requirements currentness, fails downstream handoff, preserves historical records", async () => {
    const projId = `case-d-${crypto.randomUUID()}`;
    await prisma.project.create({ data: { id: projId, name: "Case D Project", userId: ownerA } });
    await phaseService.ensurePhaseStates(projId, ownerA);

    // 1. Create and confirm Brief A
    const confAHash = hashCanonical({ projectId: projId, title: "Brief A", markdownContent: "# Brief A", claims: [], evidenceManifest: [] });
    const revA = await prisma.liveBriefRevision.create({
      data: { projectId: projId, revisionNumber: 1, title: "Brief A", markdownContent: "# Brief A", structuredClaims: [], evidenceManifest: [], contentHash: confAHash, changeSummary: "Rev 1", createdById: ownerA, createdByType: "USER" },
    });
    const confA = await prisma.liveBriefConfirmation.create({
      data: { projectId: projId, briefRevisionId: revA.id, briefRevisionNumber: 1, briefContentHash: confAHash, confirmedById: ownerA, status: "ACTIVE" },
    });
    await prisma.projectIntakeState.create({
      data: { projectId: projId, status: "CONFIRMED", currentBriefRevisionId: revA.id, currentConfirmationId: confA.id },
    });

    // 2. Generate and approve Requirements A
    const genResult = await reqGenService.generateInitialRequirements({
      projectId: projId,
      actorId: ownerA,
      idempotencyKey: `gen-req-d-${crypto.randomUUID()}`,
      briefConfirmationId: confA.id,
    });
    const reqA = genResult.artifact!;
    await approvalService.requestApproval({
      projectId: projId, phase: "requirements", artifactId: reqA.id, expectedHash: reqA.contentHash!, actorId: ownerA,
    });
    await approvalService.approveArtifact({
      projectId: projId, phase: "requirements", artifactId: reqA.id, expectedHash: reqA.contentHash!, actorId: ownerA,
    });

    // 3. Confirm Brief B (superseding Brief A)
    const now = new Date();
    await prisma.liveBriefConfirmation.updateMany({ where: { projectId: projId, status: "ACTIVE" }, data: { status: "STALE", supersededAt: now } });
    const confBHash = hashCanonical({ projectId: projId, title: "Brief B", markdownContent: "# Brief B", claims: [], evidenceManifest: [] });
    const revB = await prisma.liveBriefRevision.create({
      data: { projectId: projId, revisionNumber: 2, title: "Brief B", markdownContent: "# Brief B", structuredClaims: [], evidenceManifest: [], contentHash: confBHash, changeSummary: "Rev 2", createdById: ownerA, createdByType: "USER" },
    });
    const confB = await prisma.liveBriefConfirmation.create({
      data: { projectId: projId, briefRevisionId: revB.id, briefRevisionNumber: 2, briefContentHash: confBHash, confirmedById: ownerA, status: "ACTIVE" },
    });
    await prisma.liveBriefConfirmation.updateMany({ where: { projectId: projId, status: "STALE", supersededAt: now, supersededById: null }, data: { supersededById: confB.id } });
    await prisma.projectIntakeState.update({
      where: { projectId: projId }, data: { currentBriefRevisionId: revB.id, currentConfirmationId: confB.id },
    });

    // 4. Verify Confirmation A is STALE
    const staleConfA = await prisma.liveBriefConfirmation.findUnique({ where: { id: confA.id } });
    expect(staleConfA?.status).toBe("STALE");

    // 5. Verify Requirements A loses usable currentness
    const currentnessReqA = await currentnessService.getRequirementsArtifactCurrentness(prisma, projId, reqA);
    expect(currentnessReqA.isCurrent).toBe(false);
    expect(currentnessReqA.isStale).toBe(true);
    expect(currentnessReqA.status).toBe("STALE");
    expect(currentnessReqA.staleReason).toContain("superseded");

    // 6. Verify stale downstream handoff attempts fail with 409 PLANNING_STALE_UPSTREAM
    await expect(
      docRunService.start({
        projectId: projId, actorId: ownerA, operation: "INITIAL_GENERATION", idempotencyKey: `doc-gen-fail-${crypto.randomUUID()}`,
      }),
    ).rejects.toMatchObject({
      code: "PLANNING_STALE_UPSTREAM",
      httpStatus: 409,
    });

    await expect(
      currentnessService.assertRequirementsCurrentForHandoff(prisma, projId, reqA),
    ).rejects.toMatchObject({
      code: "PLANNING_STALE_UPSTREAM",
      httpStatus: 409,
    });

    // 7. Verify historical records remain untouched
    const historicalReq = await prisma.phaseArtifact.findUniqueOrThrow({ where: { id: reqA.id } });
    expect(historicalReq.version).toBe(1);
    expect(historicalReq.lifecycleStatus).toBe(ArtifactLifecycleStatus.APPROVED);

    const historicalApproval = await prisma.phaseApproval.findFirst({ where: { projectId: projId, artifactId: reqA.id } });
    expect(historicalApproval?.decision).toBe("approved");
  });

  // CASE E: Historical records
  test("CASE E: Historical artifacts with legacyUnverified approval metadata grant NO usable authority", async () => {
    const projId = `case-e-${crypto.randomUUID()}`;
    await prisma.project.create({
      data: { id: projId, name: "Case E Historical Project", userId: ownerA, createdAt: new Date("2026-08-01T00:00:00.000Z") },
    });
    await phaseService.ensurePhaseStates(projId, ownerA);

    const histContent = mockRequirementsContent("Historical E");
    const histArtifact = await prisma.phaseArtifact.create({
      data: {
        projectId: projId,
        phase: REQUIREMENTS_PHASE,
        type: REQUIREMENTS_ARTIFACT_TYPE,
        version: 1,
        schemaVersion: REQUIREMENTS_SCHEMA_VERSION,
        title: "Historical Requirements E",
        content: renderRequirementsMarkdown(histContent),
        contentHash: hashRequirementsContent(histContent),
        structuredContent: histContent as any,
        lifecycleStatus: ArtifactLifecycleStatus.APPROVED,
        createdBy: ownerA,
        createdByType: "HUMAN",
        changeKind: "INITIAL_GENERATION",
        createdAt: new Date("2026-08-01T00:00:00.000Z"),
      },
    });

    const histApproval = await prisma.phaseApproval.create({
      data: {
        projectId: projId,
        phase: REQUIREMENTS_PHASE,
        artifactId: histArtifact.id,
        artifactVersion: 1,
        artifactContentHash: histArtifact.contentHash,
        legacyUnverified: true,
        approvedById: ownerA,
        approvedAt: new Date("2026-08-01T00:00:00.000Z"),
        decision: "approved",
      },
    });

    // 1. Verify currentness is NO_ACTIVE_BRIEF and NOT current
    const currentness = await currentnessService.getRequirementsArtifactCurrentness(prisma, projId, histArtifact);
    expect(currentness.isCurrent).toBe(false);
    expect(currentness.isStale).toBe(true);
    expect(currentness.status).toBe("NO_ACTIVE_BRIEF");

    // 2. Downstream handoff preflight rejects with 409
    await expect(
      currentnessService.assertRequirementsCurrentForHandoff(prisma, projId, histArtifact),
    ).rejects.toMatchObject({
      code: "PLANNING_STALE_UPSTREAM",
      httpStatus: 409,
    });

    // 3. Historical records are preserved and readable
    const fetchedArt = await prisma.phaseArtifact.findUnique({ where: { id: histArtifact.id } });
    expect(fetchedArt).not.toBeNull();
    const fetchedAppr = await prisma.phaseApproval.findUnique({ where: { id: histApproval.id } });
    expect(fetchedAppr?.legacyUnverified).toBe(true);
  });

  // CASE F: Cross-project substitution
  test("CASE F: Cross-project authority substitution attempts are deterministically rejected", async () => {
    const projA = `case-f-a-${crypto.randomUUID()}`;
    const projB = `case-f-b-${crypto.randomUUID()}`;
    await prisma.project.createMany({
      data: [
        { id: projA, name: "Project F-A", userId: ownerA },
        { id: projB, name: "Project F-B", userId: ownerB },
      ],
    });
    await phaseService.ensurePhaseStates(projA, ownerA);
    await phaseService.ensurePhaseStates(projB, ownerB);

    // Create confirmed brief for Project B
    const confBHash = hashCanonical({ projectId: projB, title: "Brief B", markdownContent: "# Brief B", claims: [], evidenceManifest: [] });
    const revB = await prisma.liveBriefRevision.create({
      data: { projectId: projB, revisionNumber: 1, title: "Brief B", markdownContent: "# Brief B", structuredClaims: [], evidenceManifest: [], contentHash: confBHash, changeSummary: "Rev 1", createdById: ownerB, createdByType: "USER" },
    });
    const confB = await prisma.liveBriefConfirmation.create({
      data: { projectId: projB, briefRevisionId: revB.id, briefRevisionNumber: 1, briefContentHash: confBHash, confirmedById: ownerB, status: "ACTIVE" },
    });
    await prisma.projectIntakeState.create({
      data: { projectId: projB, status: "CONFIRMED", currentBriefRevisionId: revB.id, currentConfirmationId: confB.id },
    });

    // 1. Attempting to use Project B's confirmationId when generating Requirements for Project A fails
    await expect(
      reqGenService.generateInitialRequirements({
        projectId: projA,
        actorId: ownerA,
        idempotencyKey: `gen-req-f-${crypto.randomUUID()}`,
        briefConfirmationId: confB.id,
      }),
    ).rejects.toThrow();

    // 2. Attempting to get artifact currentness for Project B's artifact within Project A fails with 404
    await expect(
      phaseService.getArtifactCurrentness(projA, revB.id, ownerA),
    ).rejects.toMatchObject({
      code: "PLANNING_ARTIFACT_NOT_FOUND",
      httpStatus: 404,
    });
  });

  // SECTION 4: Audit manually created Requirements artifacts
  test("SECTION 4: Manual Requirements creation on active Live Brief produces artifact with NO_AUTHORITY that cannot be approved or consumed downstream", async () => {
    const projId = `sec-4-${crypto.randomUUID()}`;
    await prisma.project.create({ data: { id: projId, name: "Section 4 Project", userId: ownerA } });
    await phaseService.ensurePhaseStates(projId, ownerA);

    // Create active confirmed Live Brief
    const confHash = hashCanonical({ projectId: projId, title: "Brief S4", markdownContent: "# Brief S4", claims: [], evidenceManifest: [] });
    const rev = await prisma.liveBriefRevision.create({
      data: { projectId: projId, revisionNumber: 1, title: "Brief S4", markdownContent: "# Brief S4", structuredClaims: [], evidenceManifest: [], contentHash: confHash, changeSummary: "Rev 1", createdById: ownerA, createdByType: "USER" },
    });
    const conf = await prisma.liveBriefConfirmation.create({
      data: { projectId: projId, briefRevisionId: rev.id, briefRevisionNumber: 1, briefContentHash: confHash, confirmedById: ownerA, status: "ACTIVE" },
    });
    await prisma.projectIntakeState.create({
      data: { projectId: projId, status: "CONFIRMED", currentBriefRevisionId: rev.id, currentConfirmationId: conf.id },
    });

    // 1. Call manual Requirements creation endpoint
    const manualArtifact = await artifactService.createInitialArtifact({
      projectId: projId,
      actorId: ownerA,
      title: "Manual Requirements S4",
      structuredContent: mockRequirementsContent("Section 4 Manual"),
    });
    expect(manualArtifact).toBeDefined();
    expect(manualArtifact.createdByType).toBe("HUMAN");

    // 2. Inspect upstream authority lineage
    const currentness = await currentnessService.getRequirementsArtifactCurrentness(prisma, projId, manualArtifact);
    expect(currentness.isCurrent).toBe(false);
    expect(currentness.isStale).toBe(true);
    expect(currentness.status).toBe("NO_AUTHORITY");
    expect(currentness.staleReason).toContain("no originating WorkflowRun recording Live Brief authority");

    // 3. Attempt approval -> Fails with 409 PLANNING_STALE_UPSTREAM
    await expect(
      approvalService.approveArtifact({
        projectId: projId,
        phase: "requirements",
        artifactId: manualArtifact.id,
        expectedHash: manualArtifact.contentHash!,
        actorId: ownerA,
      }),
    ).rejects.toMatchObject({
      code: "PLANNING_STALE_UPSTREAM",
      httpStatus: 409,
    });

    // 4. Attempt Documentation generation -> Fails with 409 PLANNING_ACTION_LOCKED
    await expect(
      docRunService.start({
        projectId: projId,
        actorId: ownerA,
        operation: "INITIAL_GENERATION",
        idempotencyKey: `doc-gen-s4-${crypto.randomUUID()}`,
      }),
    ).rejects.toMatchObject({
      code: "PLANNING_ACTION_LOCKED",
      httpStatus: 409,
    });

    // 5. Attempt Architecture handoff -> Fails with 409 PLANNING_ACTION_LOCKED
    await expect(
      preflightArchitectureHandoff(prisma, projId),
    ).rejects.toMatchObject({
      code: "PLANNING_ACTION_LOCKED",
      httpStatus: 409,
    });
  });

  // SECTION 7: Concurrency & Transaction Correctness
  test("SECTION 7: Concurrency & Transaction correctness in Live Brief confirmations and in-flight operations", async () => {
    const projId = `sec-7-${crypto.randomUUID()}`;
    await prisma.project.create({ data: { id: projId, name: "Section 7 Project", userId: ownerA } });
    await phaseService.ensurePhaseStates(projId, ownerA);

    await briefService.initialize(projId, ownerA);
    await prisma.projectClaim.createMany({
      data: [
        { projectId: projId, claimKey: "GOAL-001", category: ClaimCategory.GOAL, title: "Goal", content: "Build ANKA OS", provenance: ClaimProvenance.USER_STATED, status: ClaimStatus.ACCEPTED, createdById: ownerA, createdByType: "HUMAN" },
        { projectId: projId, claimKey: "USER-001", category: ClaimCategory.USER_PERSONA, title: "User Persona", content: "Platform Engineers", provenance: ClaimProvenance.USER_STATED, status: ClaimStatus.ACCEPTED, createdById: ownerA, createdByType: "HUMAN" },
        { projectId: projId, claimKey: "WF-001", category: ClaimCategory.WORKFLOW, title: "Workflow", content: "Spec to tasks", provenance: ClaimProvenance.USER_STATED, status: ClaimStatus.ACCEPTED, createdById: ownerA, createdByType: "HUMAN" },
        { projectId: projId, claimKey: "AC-001", category: ClaimCategory.ACCEPTANCE_CRITERION, title: "Acceptance Criteria", content: "Deterministic verification", provenance: ClaimProvenance.USER_STATED, status: ClaimStatus.ACCEPTED, createdById: ownerA, createdByType: "HUMAN" },
      ],
    });

    const intake = await prisma.projectIntakeState.findUniqueOrThrow({ where: { projectId: projId }, include: { currentBriefRevision: true } });
    const rev = intake.currentBriefRevision!;
    const claims: CanonicalBriefClaim[] = [
      { category: ClaimCategory.GOAL, key: "GOAL-001", title: "Goal", content: "Build ANKA OS", provenance: "USER_STATED", sourceSpanIds: [] },
      { category: ClaimCategory.USER_PERSONA, key: "USER-001", title: "User Persona", content: "Platform Engineers", provenance: "USER_STATED", sourceSpanIds: [] },
      { category: ClaimCategory.WORKFLOW, key: "WF-001", title: "Workflow", content: "Spec to tasks", provenance: "USER_STATED", sourceSpanIds: [] },
      { category: ClaimCategory.ACCEPTANCE_CRITERION, key: "AC-001", title: "Acceptance Criteria", content: "Deterministic verification", provenance: "USER_STATED", sourceSpanIds: [] },
    ];
    const payload = {
      projectId: projId,
      title: rev.title,
      markdownContent: rev.markdownContent,
      claims,
      evidenceManifest: [],
    };
    const contentHash = hashBriefPayload(payload);
    const updatedRev = await prisma.liveBriefRevision.update({
      where: { id: rev.id },
      data: {
        structuredClaims: claims as any,
        contentHash,
      },
    });

    // 7a. Two simultaneous brief confirmations on the same revision
    const [res1, res2] = await Promise.allSettled([
      briefService.confirm({ projectId: projId, actorId: ownerA, revisionId: updatedRev.id, expectedContentHash: contentHash }),
      briefService.confirm({ projectId: projId, actorId: ownerA, revisionId: updatedRev.id, expectedContentHash: contentHash }),
    ]);

    expect(res1.status === "fulfilled" || res2.status === "fulfilled").toBe(true);
    if (res1.status === "fulfilled" && res2.status === "fulfilled") {
      expect(res1.value.id).toBe(res2.value.id);
    }

    const activeConfCount = await prisma.liveBriefConfirmation.count({
      where: { projectId: projId, status: "ACTIVE" },
    });
    expect(activeConfCount).toBe(1);

    // 7b. Requirements revision finalization race: reconfirmation while revision in-flight
    const conf = await prisma.liveBriefConfirmation.findFirstOrThrow({ where: { projectId: projId, status: "ACTIVE" } });
    const genResult = await reqGenService.generateInitialRequirements({
      projectId: projId,
      actorId: ownerA,
      idempotencyKey: `gen-req-7-${crypto.randomUUID()}`,
      briefConfirmationId: conf.id,
    });
    const reqArt = genResult.artifact!;
    await approvalService.requestApproval({ projectId: projId, phase: "requirements", artifactId: reqArt.id, expectedHash: reqArt.contentHash!, actorId: ownerA });
    await approvalService.approveArtifact({ projectId: projId, phase: "requirements", artifactId: reqArt.id, expectedHash: reqArt.contentHash!, actorId: ownerA });

    const revStart = await reqRunService.startRequirementsRun({
      projectId: projId,
      actorId: ownerA,
      operation: "DOCUMENT_REVISION",
      baseArtifactId: reqArt.id,
      instruction: "Apply critical changes",
      idempotencyKey: `race-req-rev-${crypto.randomUUID()}`,
    });

    // Reconfirm Live Brief concurrently!
    const newConfHash = hashCanonical({ projectId: projId, title: "Brief S7 New", markdownContent: "# Brief S7 New", claims: [], evidenceManifest: [] });
    const rev2 = await prisma.liveBriefRevision.create({
      data: { projectId: projId, revisionNumber: 2, title: "Brief S7 New", markdownContent: "# Brief S7 New", structuredClaims: [], evidenceManifest: [], contentHash: newConfHash, changeSummary: "Rev 2", createdById: ownerA, createdByType: "USER" },
    });
    await prisma.liveBriefConfirmation.updateMany({ where: { projectId: projId, status: "ACTIVE" }, data: { status: "STALE", supersededAt: new Date() } });
    const conf2 = await prisma.liveBriefConfirmation.create({
      data: { projectId: projId, briefRevisionId: rev2.id, briefRevisionNumber: 2, briefContentHash: newConfHash, confirmedById: ownerA, status: "ACTIVE" },
    });
    await prisma.projectIntakeState.update({ where: { projectId: projId }, data: { currentBriefRevisionId: rev2.id, currentConfirmationId: conf2.id } });

    // Finalizing the in-flight Requirements revision MUST fail with 409 PLANNING_STALE_UPSTREAM
    await expect(
      reqRunService.finalizeRequirementsRevision({
        projectId: projId,
        runId: revStart.run.id,
        actorId: ownerA,
        structuredContent: mockRequirementsContent("Revised Race"),
        audit: { modelUsage: {}, costUSD: 0.01 },
      }),
    ).rejects.toMatchObject({
      code: "PLANNING_STALE_UPSTREAM",
      httpStatus: 409,
    });
  });
});
