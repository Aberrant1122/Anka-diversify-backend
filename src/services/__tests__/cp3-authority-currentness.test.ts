import crypto from "crypto";
import { ArtifactLifecycleStatus, PrismaClient, WorkflowOperation } from "@prisma/client";
import { LLMGateway } from "../../ai/gateway/LLMGateway";
import { PlanningDomainError } from "../../planning/planning-errors";
import { LiveBriefService } from "../live-brief.service";
import { PlanningRequirementsRunService } from "../planning-requirements-run.service";
import { PlanningGenerationService } from "../planning-generation.service";
import { PlanningApprovalService } from "../planning-approval.service";
import { PlanningArtifactService } from "../planning-artifact.service";
import { AuthorityCurrentnessService } from "../authority-currentness.service";
import { PlanningDocumentationRunService } from "../planning-documentation-run.service";
import { PlanningDocumentationArtifactService } from "../planning-documentation-artifact.service";
import { PhaseService } from "../phase-service";
import { preflightArchitectureHandoff } from "../../planning/documentation-architecture-preflight";
import { assembleDocumentationContent } from "../../planning/documentation-assembly";
import {
  RequirementsContent,
  hashRequirementsContent,
  renderRequirementsMarkdown,
  REQUIREMENTS_ARTIFACT_TYPE,
  REQUIREMENTS_PHASE,
  REQUIREMENTS_SCHEMA_VERSION,
  REQUIREMENTS_RENDERER_VERSION,
} from "../../planning/requirements-schema";
import {
  DocumentationContent,
  DocumentationProviderDraft,
  hashDocumentationContent,
  renderDocumentationMarkdown,
  DOCUMENTATION_ARTIFACT_TYPE,
  DOCUMENTATION_SCHEMA_VERSION,
  DOCUMENTATION_RENDERER_VERSION,
} from "../../planning/documentation-schema";
import { DOCUMENTATION_PHASE } from "../planning-documentation-artifact.service";
import { hashCanonical } from "../../planning/requirements-context";

const databaseUrl = process.env.DATABASE_URL;
const isolatedSchema = databaseUrl ? new URL(databaseUrl).searchParams.get("schema") : null;
const describeIsolated = isolatedSchema?.startsWith("planning_checkpoint_cp3_currentness_") ? describe : describe.skip;

const prisma = new PrismaClient();
const ownerId = `owner-${crypto.randomUUID()}`;
const memberId = `member-${crypto.randomUUID()}`;
const foreignOwnerId = `foreign-${crypto.randomUUID()}`;
const projectId = `project-${crypto.randomUUID()}`;
const foreignProjectId = `foreign-project-${crypto.randomUUID()}`;

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

function mockDocumentationContent(
  reqArtifactId: string,
  reqVersion: number,
  reqHash: string,
  reqContent: RequirementsContent = mockRequirementsContent("Brief A"),
): DocumentationContent {
  return assembleDocumentationContent(
    documentationDraft(reqContent),
    {
      artifactId: reqArtifactId,
      version: reqVersion,
      contentHash: reqHash,
    },
    reqContent,
  );
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

async function createConfirmedBrief(
  projId: string,
  revNumber = 1,
  title = "Confirmed Live Brief",
  markdown = "# Live Brief\n\nProject scope."
): Promise<{ confirmationId: string; revisionId: string; contentHash: string }> {
  const contentHash = hashCanonical({
    projectId: projId,
    title,
    markdownContent: markdown,
    claims: [],
    evidenceManifest: [],
  });
  const revision = await prisma.liveBriefRevision.create({
    data: {
      projectId: projId,
      revisionNumber: revNumber,
      title,
      markdownContent: markdown,
      structuredClaims: [],
      evidenceManifest: [],
      contentHash,
      changeSummary: `Revision ${revNumber}`,
      createdById: ownerId,
      createdByType: "USER",
    },
  });
  const confirmation = await prisma.liveBriefConfirmation.create({
    data: {
      projectId: projId,
      briefRevisionId: revision.id,
      briefRevisionNumber: revNumber,
      briefContentHash: contentHash,
      confirmedById: ownerId,
      status: "ACTIVE",
    },
  });
  await prisma.projectIntakeState.upsert({
    where: { projectId: projId },
    update: {
      status: "CONFIRMED",
      currentBriefRevisionId: revision.id,
      currentConfirmationId: confirmation.id,
    },
    create: {
      projectId: projId,
      status: "CONFIRMED",
      currentBriefRevisionId: revision.id,
      currentConfirmationId: confirmation.id,
    },
  });
  return { confirmationId: confirmation.id, revisionId: revision.id, contentHash };
}

async function reconfirmBrief(
  projId: string,
  revNumber = 2,
  title = "Updated Live Brief B",
  markdown = "# Updated Live Brief B\n\nScope changed."
): Promise<{ confirmationId: string; revisionId: string; contentHash: string }> {
  const now = new Date();
  await prisma.liveBriefConfirmation.updateMany({
    where: { projectId: projId, status: "ACTIVE" },
    data: { status: "STALE", supersededAt: now },
  });
  const contentHash = hashCanonical({
    projectId: projId,
    title,
    markdownContent: markdown,
    claims: [],
    evidenceManifest: [],
  });
  const revision = await prisma.liveBriefRevision.create({
    data: {
      projectId: projId,
      revisionNumber: revNumber,
      title,
      markdownContent: markdown,
      structuredClaims: [],
      evidenceManifest: [],
      contentHash,
      changeSummary: `Revision ${revNumber}`,
      createdById: ownerId,
      createdByType: "USER",
    },
  });
  const confirmation = await prisma.liveBriefConfirmation.create({
    data: {
      projectId: projId,
      briefRevisionId: revision.id,
      briefRevisionNumber: revNumber,
      briefContentHash: contentHash,
      confirmedById: ownerId,
      status: "ACTIVE",
    },
  });
  await prisma.liveBriefConfirmation.updateMany({
    where: { projectId: projId, status: "STALE", supersededAt: now, supersededById: null },
    data: { supersededById: confirmation.id },
  });
  await prisma.projectIntakeState.update({
    where: { projectId: projId },
    data: {
      status: "CONFIRMED",
      currentBriefRevisionId: revision.id,
      currentConfirmationId: confirmation.id,
    },
  });
  return { confirmationId: confirmation.id, revisionId: revision.id, contentHash };
}

describeIsolated("CP3: Cross-Phase Authority Currentness and Stale Recovery Foundation", () => {
  let briefService: LiveBriefService;
  let currentnessService: AuthorityCurrentnessService;
  let reqRunService: PlanningRequirementsRunService;
  let reqGenService: PlanningGenerationService;
  let approvalService: PlanningApprovalService;
  let artifactService: PlanningArtifactService;
  let docRunService: PlanningDocumentationRunService;
  let docArtifactService: PlanningDocumentationArtifactService;
  let phaseService: PhaseService;

  let confirmationAId: string;
  let confirmationBId: string;
  let reqAArtifactId: string;
  let reqAHash: string;
  let reqBArtifactId: string;

  beforeAll(async () => {
    // 1. Create test users
    await prisma.user.createMany({
      data: [
        { id: ownerId, email: `${ownerId}@test.local`, name: "Owner 1", password: "pwd" },
        { id: memberId, email: `${memberId}@test.local`, name: "Member 1", password: "pwd" },
        { id: foreignOwnerId, email: `${foreignOwnerId}@test.local`, name: "Owner 2", password: "pwd" },
      ],
    });

    // 2. Create projects
    await prisma.project.createMany({
      data: [
        { id: projectId, name: "CP3 Authority Project", description: "Testing stale authority", userId: ownerId },
        { id: foreignProjectId, name: "CP3 Foreign Project", description: "Isolation project", userId: foreignOwnerId },
      ],
    });
    await prisma.projectMember.create({ data: { projectId, userId: memberId } });

    // 3. Initialize phase services & states
    currentnessService = new AuthorityCurrentnessService(prisma);
    artifactService = new PlanningArtifactService(prisma);
    approvalService = new PlanningApprovalService(prisma);
    reqRunService = new PlanningRequirementsRunService(prisma, undefined, undefined, artifactService);
    docArtifactService = new PlanningDocumentationArtifactService(prisma);
    docRunService = new PlanningDocumentationRunService(prisma, { artifacts: docArtifactService });
    phaseService = new PhaseService(prisma);

    await phaseService.ensurePhaseStates(projectId, ownerId);
    await phaseService.ensurePhaseStates(foreignProjectId, foreignOwnerId);

    const mockGenGateway = {
      callStructured: jest.fn(async () => mockLlmResult(mockRequirementsContent("Brief A"))),
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

  test("1. Confirm Brief A, generate and approve Requirements A", async () => {
    const confA = await createConfirmedBrief(projectId, 1, "Brief A", "# Brief A");
    confirmationAId = confA.confirmationId;

    // Generate Requirements A
    const genResult = await reqGenService.generateInitialRequirements({
      projectId,
      actorId: ownerId,
      idempotencyKey: `gen-req-a-${crypto.randomUUID()}`,
      briefConfirmationId: confirmationAId,
    });
    expect(genResult.run.status).toBe("completed");
    expect(genResult.artifact).not.toBeNull();
    const genArtifact = genResult.artifact!;
    reqAArtifactId = genArtifact.id;
    reqAHash = genArtifact.contentHash!;
    expect(genArtifact.version).toBe(1);

    // Verify Requirements A is current right now
    const currentnessBefore = await currentnessService.getRequirementsArtifactCurrentness(
      prisma,
      projectId,
      genArtifact,
    );
    expect(currentnessBefore.isCurrent).toBe(true);
    expect(currentnessBefore.isStale).toBe(false);

    // Request approval on Requirements A
    await approvalService.requestApproval({
      projectId,
      phase: "requirements",
      artifactId: reqAArtifactId,
      expectedHash: reqAHash,
      actorId: ownerId,
    });

    // Approve Requirements A
    const approvedState = await approvalService.approveArtifact({
      projectId,
      phase: "requirements",
      artifactId: reqAArtifactId,
      expectedHash: reqAHash,
      actorId: ownerId,
    });
    expect(approvedState.status).toBe("approved");
    expect(approvedState.currentApprovedArtifactId).toBe(reqAArtifactId);

    // Phase authority is current and usable
    const phaseAuthority = await currentnessService.getPhaseAuthorityCurrentness(
      prisma,
      projectId,
      "requirements",
    );
    expect(phaseAuthority.hasUsableAuthority).toBe(true);
    expect(phaseAuthority.isCurrent).toBe(true);
    expect(phaseAuthority.isStale).toBe(false);
  });

  test("2. Confirm Brief B invalidates upstream authority, rejecting Documentation generation with 409 PLANNING_STALE_UPSTREAM", async () => {
    // Reconfirm brief to create revision 2 and confirmation B
    const confB = await reconfirmBrief(projectId, 2, "Updated Live Brief B", "# Updated Live Brief B");
    confirmationBId = confB.confirmationId;

    // Verify Confirmation A is marked STALE
    const staleConfA = await prisma.liveBriefConfirmation.findUnique({
      where: { id: confirmationAId },
    });
    expect(staleConfA?.status).toBe("STALE");

    // Verify Requirements A is now marked STALE
    const reqAArtifact = await prisma.phaseArtifact.findUniqueOrThrow({
      where: { id: reqAArtifactId },
    });
    const currentnessReqA = await currentnessService.getRequirementsArtifactCurrentness(
      prisma,
      projectId,
      reqAArtifact,
    );
    expect(currentnessReqA.isCurrent).toBe(false);
    expect(currentnessReqA.isStale).toBe(true);
    expect(currentnessReqA.staleReason).toContain("superseded");

    // Verify Requirements phase authority is now NOT usable
    const reqPhaseAuthority = await currentnessService.getPhaseAuthorityCurrentness(
      prisma,
      projectId,
      "requirements",
    );
    expect(reqPhaseAuthority.hasUsableAuthority).toBe(false);
    expect(reqPhaseAuthority.isStale).toBe(true);

    // Starting Documentation generation MUST FAIL with 409 PLANNING_STALE_UPSTREAM
    await expect(
      docRunService.start({
        projectId,
        actorId: ownerId,
        operation: "INITIAL_GENERATION",
        idempotencyKey: `doc-gen-${crypto.randomUUID()}`,
      }),
    ).rejects.toMatchObject({
      code: "PLANNING_STALE_UPSTREAM",
      httpStatus: 409,
    });
  });

  test("3. Historical records are preserved immutably and distinguish historical approval from current usable authority", async () => {
    // Artifact A row remains unchanged
    const artifactA = await prisma.phaseArtifact.findUniqueOrThrow({
      where: { id: reqAArtifactId },
    });
    expect(artifactA.lifecycleStatus).toBe(ArtifactLifecycleStatus.APPROVED);
    expect(artifactA.approved).toBe(true);
    expect(artifactA.version).toBe(1);

    // PhaseApproval row for Artifact A remains present and unchanged
    const approval = await prisma.phaseApproval.findFirst({
      where: { projectId, artifactId: reqAArtifactId },
    });
    expect(approval).not.toBeNull();
    expect(approval?.decision).toBe("approved");

    // But authority status is stale and cannot be used
    const currentness = await currentnessService.getRequirementsArtifactCurrentness(
      prisma,
      projectId,
      artifactA,
    );
    expect(currentness.isStale).toBe(true);
    expect(currentness.isCurrent).toBe(false);
  });

  test("4. Bypass attempts on stale Requirements are deterministically rejected", async () => {
    // 4a. Request approval on stale artifact A fails
    await expect(
      approvalService.requestApproval({
        projectId,
        phase: "requirements",
        artifactId: reqAArtifactId,
        expectedHash: reqAHash,
        actorId: ownerId,
      }),
    ).rejects.toMatchObject({
      code: "PLANNING_STALE_UPSTREAM",
      httpStatus: 409,
    });

    // 4b. Approve stale artifact A fails
    await expect(
      approvalService.approveArtifact({
        projectId,
        phase: "requirements",
        artifactId: reqAArtifactId,
        expectedHash: reqAHash,
        actorId: ownerId,
      }),
    ).rejects.toMatchObject({
      code: "PLANNING_STALE_UPSTREAM",
      httpStatus: 409,
    });

    // 4c. Revise stale artifact A fails
    await expect(
      reqRunService.startRequirementsRun({
        projectId,
        actorId: ownerId,
        operation: "DOCUMENT_REVISION",
        idempotencyKey: `bypass-rev-${crypto.randomUUID()}`,
        baseArtifactId: reqAArtifactId,
        instruction: "Attempting to revise stale requirements",
      }),
    ).rejects.toMatchObject({
      code: "PLANNING_STALE_UPSTREAM",
      httpStatus: 409,
    });
  });

  test("5. In-flight race condition: Live Brief reconfirmed during generation rejects finalization", async () => {
    const raceProjectId = `race-proj-${crypto.randomUUID()}`;
    await prisma.project.create({
      data: { id: raceProjectId, name: "Race Test Project", userId: ownerId },
    });
    await phaseService.ensurePhaseStates(raceProjectId, ownerId);

    const raceConfA = await createConfirmedBrief(raceProjectId, 1, "Race Brief A", "# Race Brief A");

    // Generate Requirements
    const raceReq = await reqGenService.generateInitialRequirements({
      projectId: raceProjectId,
      actorId: ownerId,
      idempotencyKey: `race-req-${crypto.randomUUID()}`,
      briefConfirmationId: raceConfA.confirmationId,
    });
    expect(raceReq.run.status).toBe("completed");
    expect(raceReq.artifact).not.toBeNull();
    const raceArtifact = raceReq.artifact!;
    await approvalService.requestApproval({
      projectId: raceProjectId,
      phase: "requirements",
      artifactId: raceArtifact.id,
      expectedHash: raceArtifact.contentHash!,
      actorId: ownerId,
    });
    await approvalService.approveArtifact({
      projectId: raceProjectId,
      phase: "requirements",
      artifactId: raceArtifact.id,
      expectedHash: raceArtifact.contentHash!,
      actorId: ownerId,
    });

    // Start Documentation run while Confirmation A is active
    const startResult = await docRunService.start({
      projectId: raceProjectId,
      actorId: ownerId,
      operation: "INITIAL_GENERATION",
      idempotencyKey: `race-doc-run-${crypto.randomUUID()}`,
    });
    expect(startResult.reused).toBe(false);
    const inFlightRunId = startResult.run.id;

    // IN-FLIGHT RACE: Confirm Live Brief B while Documentation run is running!
    await reconfirmBrief(raceProjectId, 2, "Race Brief B", "# Race Brief B");

    // Now finalization of the Documentation run MUST fail with 409 PLANNING_STALE_UPSTREAM
    const docContent = mockDocumentationContent(raceArtifact.id, raceArtifact.version, raceArtifact.contentHash!);
    await expect(
      docRunService.finalize({
        projectId: raceProjectId,
        runId: inFlightRunId,
        actorId: ownerId,
        structuredContent: docContent,
        audit: { modelUsage: {}, costUSD: 0.01 },
      }),
    ).rejects.toMatchObject({
      code: "PLANNING_STALE_UPSTREAM",
      httpStatus: 409,
    });
  });

  test("6. Downstream Architecture handoff preflight rejects stale upstream", async () => {
    const reqAArtifact = await prisma.phaseArtifact.findUniqueOrThrow({
      where: { id: reqAArtifactId },
    });
    await expect(
      currentnessService.assertRequirementsCurrentForHandoff(prisma, projectId, reqAArtifact),
    ).rejects.toMatchObject({
      code: "PLANNING_STALE_UPSTREAM",
      httpStatus: 409,
    });
  });

  test("7. Recovery: Generating and approving Requirements B restores current authority and unblocks Documentation", async () => {
    // Generate Requirements B against active Confirmation B
    const recGateway = {
      callStructured: jest.fn(async () => mockLlmResult(mockRequirementsContent("Brief B (Recovered)"))),
    } as unknown as Pick<LLMGateway, "callStructured">;
    const recGenService = new PlanningGenerationService(prisma, {
      gateway: recGateway,
      artifacts: artifactService,
      runs: reqRunService,
    });

    const recResult = await recGenService.generateInitialRequirements({
      projectId,
      actorId: ownerId,
      idempotencyKey: `recovery-req-b-${crypto.randomUUID()}`,
      briefConfirmationId: confirmationBId,
    });
    expect(recResult.run.status).toBe("completed");
    expect(recResult.artifact).not.toBeNull();
    const recArtifact = recResult.artifact!;
    reqBArtifactId = recArtifact.id;
    expect(recArtifact.version).toBe(2);
    expect(recArtifact.previousVersionId).toBe(reqAArtifactId);

    // Verify Requirements B is current
    const currentnessReqB = await currentnessService.getRequirementsArtifactCurrentness(
      prisma,
      projectId,
      recArtifact,
    );
    expect(currentnessReqB.isCurrent).toBe(true);
    expect(currentnessReqB.isStale).toBe(false);

    // Historical Requirements A remains version 1 and untouched
    const reqA = await prisma.phaseArtifact.findUniqueOrThrow({ where: { id: reqAArtifactId } });
    expect(reqA.version).toBe(1);

    // Request approval on Requirements B
    await approvalService.requestApproval({
      projectId,
      phase: "requirements",
      artifactId: reqBArtifactId,
      expectedHash: recArtifact.contentHash!,
      actorId: ownerId,
    });

    // Approve Requirements B
    const approvedState = await approvalService.approveArtifact({
      projectId,
      phase: "requirements",
      artifactId: reqBArtifactId,
      expectedHash: recArtifact.contentHash!,
      actorId: ownerId,
    });
    expect(approvedState.status).toBe("approved");
    expect(approvedState.currentApprovedArtifactId).toBe(reqBArtifactId);

    // Phase authority is now restored to current and usable!
    const restoredAuthority = await currentnessService.getPhaseAuthorityCurrentness(
      prisma,
      projectId,
      "requirements",
    );
    expect(restoredAuthority.hasUsableAuthority).toBe(true);
    expect(restoredAuthority.isCurrent).toBe(true);
    expect(restoredAuthority.isStale).toBe(false);

    // Documentation generation CAN NOW PROCEED!
    const docStart = await docRunService.start({
      projectId,
      actorId: ownerId,
      operation: "INITIAL_GENERATION",
      idempotencyKey: `doc-gen-b-${crypto.randomUUID()}`,
    });
    expect(docStart.reused).toBe(false);
    expect(docStart.run.status).toBe("running");

    // Finalize Documentation generation
    const docContent = mockDocumentationContent(
      reqBArtifactId,
      2,
      recArtifact.contentHash!,
      mockRequirementsContent("Brief B (Recovered)"),
    );
    const finalizeResult = await docRunService.finalize({
      projectId,
      runId: docStart.run.id,
      actorId: ownerId,
      structuredContent: docContent,
      audit: { modelUsage: {}, costUSD: 0.02 },
    });
    expect(finalizeResult.artifact.version).toBe(1);
    expect(finalizeResult.readiness.ready).toBe(true);
  });

  test("8. Two-user / two-project authorization and isolation", async () => {
    // Non-member (foreignOwnerId) cannot read Project 1 phase states -> 404 (information hiding)
    await expect(
      phaseService.getPhaseStates(projectId, foreignOwnerId),
    ).rejects.toMatchObject({
      code: "PLANNING_PROJECT_NOT_FOUND",
      httpStatus: 404,
    });

    // Member (memberId) can read Project 1 phase states
    const memberStates = await phaseService.getPhaseStates(projectId, memberId);
    expect(memberStates.length).toBeGreaterThan(0);

    // Member (not owner) cannot approve -> 403
    await expect(
      approvalService.approveArtifact({
        projectId,
        phase: "requirements",
        artifactId: reqBArtifactId,
        expectedHash: "irrelevant",
        actorId: memberId,
      }),
    ).rejects.toMatchObject({
      code: "PLANNING_OWNER_REQUIRED",
      httpStatus: 403,
    });
  });

  test("9. PhaseService.getPhaseStates enriches currentness state without fabricating phase status and restores workflow runs", async () => {
    const states = await phaseService.getPhaseStates(projectId, ownerId);
    const reqState = states.find((s) => s.phase === "requirements");
    expect(reqState).toBeDefined();
    // Database status remains 'approved'
    expect(reqState?.status).toBe("approved");
    // Enriched currentness fields are populated accurately
    expect(reqState?.isCurrent).toBe(true);
    expect(reqState?.hasUsableAuthority).toBe(true);
    expect(reqState?.isStale).toBe(false);
    expect(reqState?.staleReason).toBeNull();

    // Workflow runs restoration
    const runs = await phaseService.getWorkflowRuns(projectId, ownerId);
    expect(runs.length).toBeGreaterThan(0);
    const reqRuns = runs.filter((r) => r.currentPhase === "requirements");
    expect(reqRuns.length).toBeGreaterThanOrEqual(2);
  });

  test("10. Modern project without confirmed brief: zero-confirmation bypass rejected", async () => {
    const unconfirmedProjId = `unconf-proj-${crypto.randomUUID()}`;
    await prisma.project.create({
      data: { id: unconfirmedProjId, name: "Unconfirmed Modern Project", userId: ownerId },
    });
    await phaseService.ensurePhaseStates(unconfirmedProjId, ownerId);

    const reqContent = mockRequirementsContent("Unconfirmed");
    const unconfirmedArtifact = await prisma.phaseArtifact.create({
      data: {
        projectId: unconfirmedProjId,
        phase: "requirements",
        type: "requirements_document",
        version: 1,
        title: "Unconfirmed Requirements",
        content: renderRequirementsMarkdown(reqContent),
        contentHash: hashRequirementsContent(reqContent),
        structuredContent: reqContent as any,
        lifecycleStatus: "DRAFT",
        createdBy: ownerId,
        createdByType: "HUMAN",
        changeKind: "INITIAL_GENERATION",
      },
    });

    // 1. Artifact currentness must be NO_ACTIVE_BRIEF, NOT CURRENT via legacy fallback
    const artCurrentness = await currentnessService.getRequirementsArtifactCurrentness(
      prisma,
      unconfirmedProjId,
      unconfirmedArtifact,
    );
    expect(artCurrentness.isCurrent).toBe(false);
    expect(artCurrentness.isStale).toBe(true);
    expect(artCurrentness.status).toBe("NO_ACTIVE_BRIEF");

    // 2. Downstream handoff preflight rejects with 409 PLANNING_STALE_UPSTREAM
    await expect(
      currentnessService.assertRequirementsCurrentForHandoff(
        prisma,
        unconfirmedProjId,
        unconfirmedArtifact,
      ),
    ).rejects.toMatchObject({
      code: "PLANNING_STALE_UPSTREAM",
      httpStatus: 409,
    });

    // 3. Phase authority currentness when artifact is currentArtifactId
    await prisma.projectPhaseState.update({
      where: { projectId_phase: { projectId: unconfirmedProjId, phase: "requirements" } },
      data: { currentArtifactId: unconfirmedArtifact.id },
    });
    const phaseCurrentness = await currentnessService.getPhaseAuthorityCurrentness(
      prisma,
      unconfirmedProjId,
      "requirements",
    );
    expect(phaseCurrentness.hasUsableAuthority).toBe(false);
    expect(phaseCurrentness.isCurrent).toBe(false);
    expect(phaseCurrentness.isStale).toBe(true);
  });

  test("11. Manual Requirements creation on modern project without active Live Brief confirmation is rejected", async () => {
    const unconfirmedProjId = `manual-proj-${crypto.randomUUID()}`;
    await prisma.project.create({
      data: { id: unconfirmedProjId, name: "Manual Unconfirmed Project", userId: ownerId },
    });
    await phaseService.ensurePhaseStates(unconfirmedProjId, ownerId);

    await expect(
      artifactService.createInitialArtifact({
        projectId: unconfirmedProjId,
        actorId: ownerId,
        title: "Manual Requirements",
        structuredContent: mockRequirementsContent("Manual"),
      }),
    ).rejects.toMatchObject({
      code: "PLANNING_BRIEF_REQUIRED",
      httpStatus: 422,
    });
  });

  test("12. PhaseService currentness and version comparison APIs return accurate diff and enforce project isolation", async () => {
    const currentReqBCurrentness = await phaseService.getArtifactCurrentness(
      projectId,
      reqBArtifactId,
      ownerId,
    );
    expect(currentReqBCurrentness.isCurrent).toBe(true);
    expect(currentReqBCurrentness.isStale).toBe(false);
    expect(currentReqBCurrentness.status).toBe("CURRENT");
    expect(currentReqBCurrentness.phase).toBe("requirements");

    const staleReqACurrentness = await phaseService.getArtifactCurrentness(
      projectId,
      reqAArtifactId,
      ownerId,
    );
    expect(staleReqACurrentness.isCurrent).toBe(false);
    expect(staleReqACurrentness.isStale).toBe(true);
    expect(staleReqACurrentness.status).toBe("STALE");

    const diffResult = await phaseService.compareArtifactVersions(
      projectId,
      reqBArtifactId,
      reqAArtifactId,
      ownerId,
    );
    expect(diffResult.phase).toBe("requirements");
    expect(diffResult.baseArtifact.id).toBe(reqAArtifactId);
    expect(diffResult.targetArtifact.id).toBe(reqBArtifactId);
    expect(diffResult.diff).toBeDefined();

    await expect(
      phaseService.getArtifactCurrentness(foreignProjectId, reqBArtifactId, foreignOwnerId),
    ).rejects.toMatchObject({
      code: "PLANNING_ARTIFACT_NOT_FOUND",
      httpStatus: 404,
    });
  });

  test("13. In-flight Requirements revision race: base Requirements become stale when Live Brief reconfirms during revision", async () => {
    const revStart = await reqRunService.startRequirementsRun({
      projectId,
      actorId: ownerId,
      operation: "DOCUMENT_REVISION",
      baseArtifactId: reqBArtifactId,
      instruction: "Apply critical scope changes",
      idempotencyKey: `race-req-run-${crypto.randomUUID()}`,
    });
    expect(revStart.reused).toBe(false);
    const inFlightRevRunId = revStart.run.id;

    await reconfirmBrief(projectId, 3, "Live Brief C (Race)", "# Live Brief C");

    const successorContent = mockRequirementsContent("Brief B (Revised)");
    await expect(
      reqRunService.finalizeRequirementsRevision({
        projectId,
        runId: inFlightRevRunId,
        actorId: ownerId,
        structuredContent: successorContent,
        audit: { modelUsage: {}, costUSD: 0.01 },
      }),
    ).rejects.toMatchObject({
      code: "PLANNING_STALE_UPSTREAM",
      httpStatus: 409,
    });
  });

  test("14. Historical artifacts and unverified approvals are not automatically current or usable without valid authority", async () => {
    const historicalProjId = `hist-proj-${crypto.randomUUID()}`;
    await prisma.project.create({
      data: {
        id: historicalProjId,
        name: "Historical Project",
        userId: ownerId,
        createdAt: new Date("2026-08-01T00:00:00.000Z"),
      },
    });
    await phaseService.ensurePhaseStates(historicalProjId, ownerId);

    const histContent = mockRequirementsContent("Historical");
    const histArtifact = await prisma.phaseArtifact.create({
      data: {
        projectId: historicalProjId,
        phase: REQUIREMENTS_PHASE,
        type: REQUIREMENTS_ARTIFACT_TYPE,
        version: 1,
        schemaVersion: REQUIREMENTS_SCHEMA_VERSION,
        title: "Historical Requirements",
        content: renderRequirementsMarkdown(histContent),
        contentHash: hashRequirementsContent(histContent),
        structuredContent: histContent as any,
        lifecycleStatus: "APPROVED",
        createdBy: ownerId,
        createdByType: "HUMAN",
        changeKind: "INITIAL_GENERATION",
        createdAt: new Date("2026-08-01T00:00:00.000Z"),
      },
    });

    const histApproval = await prisma.phaseApproval.create({
      data: {
        projectId: historicalProjId,
        phase: REQUIREMENTS_PHASE,
        artifactId: histArtifact.id,
        artifactVersion: 1,
        artifactContentHash: histArtifact.contentHash,
        legacyUnverified: true,
        approvedById: ownerId,
        approvedAt: new Date("2026-08-01T00:00:00.000Z"),
        decision: "approved",
      },
    });

    // 1. Currentness is NO_ACTIVE_BRIEF, NOT CURRENT via historical bypass
    const currentness = await currentnessService.getRequirementsArtifactCurrentness(
      prisma,
      historicalProjId,
      histArtifact,
    );
    expect(currentness.isCurrent).toBe(false);
    expect(currentness.isStale).toBe(true);
    expect(currentness.status).toBe("NO_ACTIVE_BRIEF");

    // 2. Downstream handoff preflight rejects with 409 PLANNING_STALE_UPSTREAM
    await expect(
      currentnessService.assertRequirementsCurrentForHandoff(
        prisma,
        historicalProjId,
        histArtifact,
      ),
    ).rejects.toMatchObject({
      code: "PLANNING_STALE_UPSTREAM",
      httpStatus: 409,
    });

    // 3. Historical artifact and approval records remain preserved in the database
    const preservedArtifact = await prisma.phaseArtifact.findUnique({ where: { id: histArtifact.id } });
    expect(preservedArtifact).not.toBeNull();
    const preservedApproval = await prisma.phaseApproval.findUnique({ where: { id: histApproval.id } });
    expect(preservedApproval).not.toBeNull();
    expect(preservedApproval?.legacyUnverified).toBe(true);
  });

  test("15. Unconfirmed project cannot approve or consume Requirements authority through alternate routes", async () => {
    const unconfProjId = `unconf-alt-${crypto.randomUUID()}`;
    await prisma.project.create({
      data: { id: unconfProjId, name: "Unconfirmed Alt", userId: ownerId },
    });
    await phaseService.ensurePhaseStates(unconfProjId, ownerId);

    const reqContent = mockRequirementsContent("Alt");
    const unconfArtifact = await prisma.phaseArtifact.create({
      data: {
        projectId: unconfProjId,
        phase: REQUIREMENTS_PHASE,
        type: REQUIREMENTS_ARTIFACT_TYPE,
        version: 1,
        schemaVersion: REQUIREMENTS_SCHEMA_VERSION,
        title: "Alt Requirements",
        content: renderRequirementsMarkdown(reqContent),
        contentHash: hashRequirementsContent(reqContent),
        structuredContent: reqContent as any,
        lifecycleStatus: "DRAFT",
        createdBy: ownerId,
        createdByType: "HUMAN",
        changeKind: "INITIAL_GENERATION",
      },
    });

    await prisma.projectPhaseState.update({
      where: { projectId_phase: { projectId: unconfProjId, phase: REQUIREMENTS_PHASE } },
      data: {
        status: "awaiting_approval",
        currentArtifactId: unconfArtifact.id,
        approvalCandidateArtifactId: unconfArtifact.id,
      },
    });

    // Attempting to approve without confirmed brief authority fails with 409
    await expect(
      approvalService.approveArtifact({
        projectId: unconfProjId,
        phase: REQUIREMENTS_PHASE,
        artifactId: unconfArtifact.id,
        expectedHash: unconfArtifact.contentHash!,
        actorId: ownerId,
      }),
    ).rejects.toMatchObject({
      code: "PLANNING_STALE_UPSTREAM",
      httpStatus: 409,
    });

    // Attempting to consume unconfirmed Requirements in Documentation preflight fails
    const docContent = mockDocumentationContent(unconfArtifact.id, 1, unconfArtifact.contentHash!, reqContent);
    const docArtifact = await prisma.phaseArtifact.create({
      data: {
        projectId: unconfProjId,
        phase: DOCUMENTATION_PHASE,
        type: DOCUMENTATION_ARTIFACT_TYPE,
        version: 1,
        schemaVersion: DOCUMENTATION_SCHEMA_VERSION,
        title: "Unconfirmed Docs",
        content: renderDocumentationMarkdown(docContent),
        contentHash: hashDocumentationContent(docContent),
        structuredContent: docContent as any,
        lifecycleStatus: "DRAFT",
        createdBy: ownerId,
        createdByType: "HUMAN",
        changeKind: "INITIAL_GENERATION",
      },
    });

    const docCurrentness = await currentnessService.getDocumentationArtifactCurrentness(
      prisma,
      unconfProjId,
      docArtifact,
    );
    expect(docCurrentness.isCurrent).toBe(false);
    expect(docCurrentness.isStale).toBe(true);
  });
});


