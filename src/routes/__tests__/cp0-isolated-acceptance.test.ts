import crypto from "crypto";
import express from "express";
import http from "http";
import jwt from "jsonwebtoken";
import { PrismaClient } from "@prisma/client";
import { JWT_SECRET } from "../../config/env";
import { authenticateToken } from "../../middleware/auth";
import { requireRole } from "../../middleware/rbac";
import { errorHandler } from "../../middleware";
import { PlanningAuthorizationService } from "../../services/planning-authorization.service";
import { AiService } from "../../ai/application/AiService";
import { PlanningArtifactService } from "../../services/planning-artifact.service";
import { PlanningDocumentationArtifactService } from "../../services/planning-documentation-artifact.service";
import { PlanningArchitectureArtifactService } from "../../services/planning-architecture-artifact.service";
import { PlanningApprovalService } from "../../services/planning-approval.service";
import { RequirementsContent } from "../../planning/requirements-schema";
import { DocumentationProviderDraft } from "../../planning/documentation-schema";
import { assembleDocumentationContent } from "../../planning/documentation-assembly";
import { architectureDraft } from "../../planning/__tests__/architecture-test-fixtures";
import { CodingAgent } from "../../ai/application/CodingAgent";
import * as uploadService from "../../services/upload.service";

// Strict safety guard: Fail closed if not running in an isolated planning_checkpoint_* PostgreSQL schema
const databaseUrl = process.env.DATABASE_URL;
const isolatedSchema = databaseUrl ? new URL(databaseUrl).searchParams.get("schema") : null;
if (!isolatedSchema?.startsWith("planning_checkpoint_")) {
  throw new Error(
    "cp0-isolated-acceptance.test.ts requires an isolated planning_checkpoint_* PostgreSQL schema",
  );
}

// ── External side effect mocking ──────────────────────────────────────────────
jest.mock("../../services/upload.service", () => ({
  generatePresignedUrl: jest.fn().mockImplementation((projectId: string, filename: string) =>
    Promise.resolve({
      uploadUrl: `https://mock-s3.local/upload/${projectId}/${filename}`,
      fileUrl: `https://mock-s3.local/files/${projectId}/${filename}`,
      key: `projects/${projectId}/${filename}`,
    }),
  ),
  generateDownloadUrl: jest.fn().mockImplementation((key: string) =>
    Promise.resolve(`https://mock-s3.local/download/${key}`),
  ),
  deleteFromS3: jest.fn().mockImplementation(() => Promise.resolve()),
  detectType: jest.fn().mockReturnValue("doc"),
}));

jest.mock("../../ai/gateway/LLMGateway", () => ({
  LLMGateway: {
    getInstance: jest.fn().mockReturnValue({
      callStructured: jest.fn().mockResolvedValue({ content: { tasks: [] } }),
      call: jest.fn().mockResolvedValue({ content: "mock-llm-response" }),
    }),
  },
  PipelineStages: {
    TASK_DECOMPOSITION: "TASK_DECOMPOSITION",
    AGENT_RUN: "AGENT_RUN",
  },
}));

jest.mock("../../services/github.service", () => ({
  ProjectGitHubService: jest.fn().mockImplementation(() => ({
    syncRepository: jest.fn().mockResolvedValue({ synced: true }),
    listPullRequests: jest.fn().mockResolvedValue([]),
  })),
}));

jest.mock("../../services/terminal-session-manager", () => ({
  TerminalSessionManager: {
    getInstance: jest.fn().mockReturnValue({
      shutdownAll: jest.fn(),
    }),
  },
}));

jest.mock("../../services/git-worktree.service", () => ({
  GitWorktreeService: Object.assign(jest.fn().mockImplementation(() => ({
    createWorktree: jest.fn(),
    removeWorktree: jest.fn(),
  })), { runIsolatedAgent: jest.fn() }),
}));

// Import real routes after mocks
const projectRoutes = require("../project-routes").default;
const aiRoutes = require("../ai-routes").default;
const adminRoutes = require("../admin-routes").default;

const prisma = new PrismaClient();
const planningAuth = new PlanningAuthorizationService(prisma);

function tokenFor(userId: string, role = "user"): string {
  return `Bearer ${jwt.sign({ userId, role }, JWT_SECRET)}`;
}

function authorityRequirements(): RequirementsContent {
  return {
    projectGoal: "Deliver an isolated security fixture", problemStatement: "Check project binding",
    usersAndActors: [{ id: "ACT-1", name: "Owner", description: "Owns the project" }],
    userStories: [{ id: "US-1", actor: "Owner", capability: "review", benefit: "security", acceptanceCriteriaIds: ["AC-1"] }],
    functionalRequirements: [{ id: "FR-1", title: "Review", description: "Review bounded changes" }],
    nonFunctionalRequirements: [{ id: "NFR-1", title: "Audit", description: "Keep an audit trail" }],
    constraints: [], integrations: [], assumptions: [],
    acceptanceCriteria: [{ id: "AC-1", description: "Binding holds", relatedRequirementIds: ["FR-1"] }],
    outOfScope: [], unresolvedQuestions: [],
  };
}

function authorityDocumentationDraft(): DocumentationProviderDraft {
  return {
    overview: { summary: "Security fixture", scope: "Project binding", goals: [], nonGoals: [] },
    systemActors: [{ id: "DOC-ACTOR", name: "Owner", description: "Reviews work", sourceActorIds: ["ACT-1"] }],
    features: [{ id: "DOC-FEATURE", title: "Review", description: "Review changes", workflowSteps: ["Start"],
      actorIds: ["DOC-ACTOR"], access: "controlled", sourceRequirementIds: ["FR-1"], sourceUserStoryIds: ["US-1"] }],
    apiContracts: { applicable: true, rationale: "Review endpoint", items: [{ id: "DOC-API", name: "Review", description: "Reviews work",
      interaction: { kind: "http", method: "POST", path: "/review" }, access: "controlled",
      input: { description: "Input", fields: [] }, success: { description: "Output", fields: [] },
      relatedFeatureIds: ["DOC-FEATURE"], relatedEntityIds: ["DOC-ENTITY"], errorBehaviorIds: ["DOC-ERROR"],
      sourceRequirementIds: ["NFR-1"], sourceUserStoryIds: ["US-1"] }] },
    dataEntities: { applicable: true, rationale: "Review state", items: [{ id: "DOC-ENTITY", name: "Review", description: "State",
      fields: [{ name: "id", logicalType: "identifier", required: true, description: "Identifier", allowedValues: [], validationRules: [] }],
      relationships: [], sourceRequirementIds: ["NFR-1"], sourceUserStoryIds: [] }] },
    businessRules: [{ id: "DOC-RULE", title: "Owner review", condition: "Before approval", expectedBehavior: "Require owner",
      relatedFeatureIds: ["DOC-FEATURE"], relatedEntityIds: [], sourceRequirementIds: ["FR-1"], sourceUserStoryIds: [] }],
    permissionRules: { applicable: true, rationale: "Controlled", items: [{ id: "DOC-PERM", title: "Owner",
      description: "Allow owner", effect: "allow", actorIds: ["DOC-ACTOR"], actions: ["approve"],
      relatedFeatureIds: ["DOC-FEATURE"], relatedApiContractIds: ["DOC-API"] }] },
    errorBehaviors: [{ id: "DOC-ERROR", code: "REVIEW_FAILED", scenario: "Failure", expectedSystemBehavior: "Reject",
      recoveryBehavior: "Retry", relatedFeatureIds: ["DOC-FEATURE"], relatedApiContractIds: ["DOC-API"], httpStatus: 409 }],
    edgeCases: [{ id: "DOC-EDGE", scenario: "Concurrent review", expectedHandling: "One wins",
      relatedFeatureIds: ["DOC-FEATURE"], relatedApiContractIds: ["DOC-API"], relatedEntityIds: ["DOC-ENTITY"] }],
    unresolvedQuestions: [],
  };
}

describe("CP0.5 Reproducible Isolated Authorization Acceptance Suite", () => {
  let server: http.Server;
  let baseUrl: string;

  // Canonical Fixture Identifiers
  const userAId = `cp0-user-a-${crypto.randomUUID()}`;
  const userBId = `cp0-user-b-${crypto.randomUUID()}`;
  const userDualId = `cp0-user-dual-${crypto.randomUUID()}`;
  const userAdminId = `cp0-user-admin-${crypto.randomUUID()}`;

  const tokenA = tokenFor(userAId);
  const tokenB = tokenFor(userBId);
  const tokenDual = tokenFor(userDualId);
  const tokenAdmin = tokenFor(userAdminId, "admin");

  const projectAId = `cp0-proj-a-${crypto.randomUUID()}`;
  const projectBId = `cp0-proj-b-${crypto.randomUUID()}`;

  let fileAId: string;
  let fileBId: string;
  let ruleAId: string;
  let ruleBId: string;
  let decisionAId: string;
  let decisionBId: string;
  let documentBId: string;
  let taskAId: string;
  let taskBId: string;
  let commentAId: string;
  let commentBId: string;
  let itemAId: string;
  let itemBId: string;
  let sprintAId: string;
  let sprintBId: string;
  let sessionAId: string;
  let sessionBId: string;
  let repoAId: string;
  let repoBId: string;
  let artifactAId: string;
  let artifactBId: string;
  let documentationArtifactBId: string;
  let architectureArtifactBId: string;
  let runAId: string;
  let runBId: string;
  let manifestAId: string;
  let manifestBId: string;
  let decompAId: string;
  let decompBId: string;
  let driftBId: string;
  let kanbanTaskBId: string;
  let kanbanTaskAId: string;
  let executionBId: string;
  let clarificationBId: string;

  beforeAll(async () => {
    // 1. Start test HTTP server
    const app = express();
    app.use(express.json());
    app.use("/api/projects", authenticateToken, projectRoutes);
    app.use("/api/ai", authenticateToken, aiRoutes);
    app.use("/api/admin", authenticateToken, requireRole("admin"), adminRoutes);
    app.use(errorHandler);

    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;

    // 2. Populate canonical database-backed CP0 authorization fixture
    await prisma.user.createMany({
      data: [
        { id: userAId, email: `a-${crypto.randomUUID()}@test.local`, password: "hash", role: "user" },
        { id: userBId, email: `b-${crypto.randomUUID()}@test.local`, password: "hash", role: "user" },
        { id: userDualId, email: `dual-${crypto.randomUUID()}@test.local`, password: "hash", role: "user" },
        { id: userAdminId, email: `admin-${crypto.randomUUID()}@test.local`, password: "hash", role: "admin" },
      ],
    });

    await prisma.project.create({
      data: {
        id: projectAId,
        name: "Project A Canonical",
        userId: userAId,
      },
    });

    await prisma.project.create({
      data: {
        id: projectBId,
        name: "Project B Canonical",
        userId: userBId,
      },
    });

    // Dual user has legitimate access to both Project A and Project B
    await prisma.projectMember.createMany({
      data: [
        { projectId: projectAId, userId: userDualId },
        { projectId: projectBId, userId: userDualId },
      ],
    });

    // Populate Project A project-owned resources
    const fileA = await prisma.projectFile.create({
      data: {
        projectId: projectAId,
        name: "document-a.pdf",
        s3Key: `projects/${projectAId}/${crypto.randomUUID()}.pdf`,
        uploadedBy: userAId,
      },
    });
    fileAId = fileA.id;

    const ruleA = await prisma.projectRule.create({
      data: {
        projectId: projectAId,
        title: "Rule A Title",
        description: "Rule A Description",
      },
    });
    ruleAId = ruleA.id;

    const decisionA = await prisma.projectDecision.create({
      data: {
        projectId: projectAId,
        title: "Decision A Title",
        description: "Decision A Description",
      },
    });
    decisionAId = decisionA.id;

    const taskA = await prisma.projectTask.create({
      data: {
        projectId: projectAId,
        title: "Task A Title",
      },
    });
    taskAId = taskA.id;

    const commentA = await prisma.taskComment.create({
      data: {
        projectId: projectAId,
        taskId: taskA.id,
        userId: userAId,
        userName: "User A",
        content: "Comment A content",
      },
    });
    commentAId = commentA.id;

    const itemA = await prisma.taskChecklistItem.create({
      data: {
        projectId: projectAId,
        taskId: taskA.id,
        text: "Checklist item A",
      },
    });
    itemAId = itemA.id;

    const sprintA = await prisma.sprint.create({
      data: {
        projectId: projectAId,
        name: "Sprint A",
        startDate: new Date(),
        endDate: new Date(Date.now() + 86400000),
      },
    });
    sprintAId = sprintA.id;

    const sessionA = await prisma.aiChatSession.create({
      data: {
        projectId: projectAId,
        userId: userDualId,
        type: "project",
        title: "Session A",
      },
    });
    sessionAId = sessionA.id;

    const repoA = await prisma.projectRepository.create({
      data: {
        projectId: projectAId,
        name: "repo-a",
        role: "backend",
        githubUrl: "https://github.com/org/repo-a",
      },
    });
    repoAId = repoA.id;

    const artifactA = await prisma.phaseArtifact.create({
      data: {
        projectId: projectAId,
        phase: "requirements",
        type: "requirements-spec",
        title: "Requirements A",
        content: "Requirements Content A",
        createdBy: userAId,
      },
    });
    artifactAId = artifactA.id;

    const runA = await prisma.workflowRun.create({
      data: {
        projectId: projectAId,
        triggerType: "manual",
        currentPhase: "requirements",
        status: "completed",
      },
    });
    runAId = runA.id;

    const manifestA = await prisma.agentManifest.create({
      data: {
        projectId: projectAId,
        sessionId: sessionA.id,
        manifestJson: { manifestVersion: "1.0.0", files: [] },
        validationStatus: "pending",
      },
    });
    manifestAId = manifestA.id;

    const decompA = await prisma.taskDecomposition.create({
      data: {
        projectId: projectAId,
        sessionId: sessionA.id,
        userRequest: "Decompose feature A",
        graphJson: {},
        totalSubTasks: 1,
        status: "completed",
      },
    });
    decompAId = decompA.id;

    // Populate Project B project-owned resources
    const fileB = await prisma.projectFile.create({
      data: {
        projectId: projectBId,
        name: "document-b.pdf",
        s3Key: `projects/${projectBId}/${crypto.randomUUID()}.pdf`,
        uploadedBy: userBId,
      },
    });
    fileBId = fileB.id;

    const ruleB = await prisma.projectRule.create({
      data: {
        projectId: projectBId,
        title: "Rule B Title",
        description: "Rule B Description",
      },
    });
    ruleBId = ruleB.id;

    const decisionB = await prisma.projectDecision.create({
      data: {
        projectId: projectBId,
        title: "Decision B Title",
        description: "Decision B Description",
      },
    });
    decisionBId = decisionB.id;

    const documentB = await prisma.projectDocument.create({
      data: { projectId: projectBId, title: "Document B", content: "Foreign document" },
    });
    documentBId = documentB.id;

    const taskB = await prisma.projectTask.create({
      data: {
        projectId: projectBId,
        title: "Task B Title",
      },
    });
    taskBId = taskB.id;

    const commentB = await prisma.taskComment.create({
      data: {
        projectId: projectBId,
        taskId: taskB.id,
        userId: userBId,
        userName: "User B",
        content: "Comment B content",
      },
    });
    commentBId = commentB.id;

    const itemB = await prisma.taskChecklistItem.create({
      data: {
        projectId: projectBId,
        taskId: taskB.id,
        text: "Checklist item B",
      },
    });
    itemBId = itemB.id;

    const sprintB = await prisma.sprint.create({
      data: {
        projectId: projectBId,
        name: "Sprint B",
        startDate: new Date(),
        endDate: new Date(Date.now() + 86400000),
      },
    });
    sprintBId = sprintB.id;

    const sessionB = await prisma.aiChatSession.create({
      data: {
        projectId: projectBId,
        userId: userDualId,
        type: "project",
        title: "Session B",
      },
    });
    sessionBId = sessionB.id;

    const repoB = await prisma.projectRepository.create({
      data: {
        projectId: projectBId,
        name: "repo-b",
        role: "backend",
        githubUrl: "https://github.com/org/repo-b",
      },
    });
    repoBId = repoB.id;

    const artifactB = await prisma.phaseArtifact.create({
      data: {
        projectId: projectBId,
        phase: "requirements",
        type: "requirements-spec",
        title: "Requirements B",
        content: "Requirements Content B",
        createdBy: userBId,
      },
    });
    artifactBId = artifactB.id;

    const documentationArtifactB = await prisma.phaseArtifact.create({
      data: { projectId: projectBId, phase: "documentation", type: "documentation_doc",
        title: "Documentation B", content: "Documentation B", createdBy: userBId },
    });
    documentationArtifactBId = documentationArtifactB.id;
    const architectureArtifactB = await prisma.phaseArtifact.create({
      data: { projectId: projectBId, phase: "architecture", type: "architecture_doc",
        title: "Architecture B", content: "Architecture B", createdBy: userBId },
    });
    architectureArtifactBId = architectureArtifactB.id;

    const runB = await prisma.workflowRun.create({
      data: {
        projectId: projectBId,
        triggerType: "manual",
        currentPhase: "requirements",
        status: "completed",
      },
    });
    runBId = runB.id;

    const manifestB = await prisma.agentManifest.create({
      data: {
        projectId: projectBId,
        sessionId: sessionB.id,
        manifestJson: { manifestVersion: "1.0.0", files: [] },
        validationStatus: "pending",
      },
    });
    manifestBId = manifestB.id;

    const decompB = await prisma.taskDecomposition.create({
      data: {
        projectId: projectBId,
        sessionId: sessionB.id,
        userRequest: "Decompose feature B",
        graphJson: {},
        totalSubTasks: 1,
        status: "completed",
      },
    });
    decompBId = decompB.id;

    const driftB = await prisma.architectureDriftRecord.create({
      data: { projectId: projectBId, description: "Project B drift", affectedScope: "backend", evidence: "fixture", risk: "medium" },
    });
    driftBId = driftB.id;

    const boardA = await prisma.kanbanBoard.create({ data: { projectId: projectAId } });
    const stageA = await prisma.kanbanStage.create({ data: { boardId: boardA.id, title: "Todo" } });
    const kanbanTaskA = await prisma.kanbanTask.create({
      data: { stageId: stageA.id, title: "Implementation A", description: "Local task", implementationEligible: true },
    });
    kanbanTaskAId = kanbanTaskA.id;
    const boardB = await prisma.kanbanBoard.create({ data: { projectId: projectBId } });
    const stageB = await prisma.kanbanStage.create({ data: { boardId: boardB.id, title: "Todo" } });
    const kanbanTaskB = await prisma.kanbanTask.create({
      data: { stageId: stageB.id, title: "Implementation B", description: "Foreign task", implementationEligible: true },
    });
    kanbanTaskBId = kanbanTaskB.id;
    const executionB = await prisma.implementationTaskExecution.create({
      data: { projectId: projectBId, taskId: kanbanTaskBId, repositoryId: repoBId,
        initiatedById: userBId, idempotencyKey: `foreign-${crypto.randomUUID()}`,
        requestIdentity: "foreign", approvedTaskVersion: 1, taskSnapshot: {}, planningAuthority: {},
        authorityFingerprint: "foreign", state: "awaiting_review", leaseExpiresAt: new Date(Date.now() + 60_000) },
    });
    executionBId = executionB.id;
    const clarificationB = await prisma.clarificationQA.create({
      data: { taskId: kanbanTaskBId, question: "Foreign clarification?", options: ["yes", "no"] },
    });
    clarificationBId = clarificationB.id;
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await prisma.$disconnect();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ────────────────────────────────────────────────────────────────────────────
  // 1. PROJECT ACCESS (Real PostgreSQL backing)
  // ────────────────────────────────────────────────────────────────────────────
  describe("Project Access & Non-Disclosure", () => {
    test("PR review and description routes reject inaccessible projects before AI dispatch", async () => {
      const service = AiService.getInstance();
      const review = jest.spyOn(service, "reviewPullRequest");
      const describe = jest.spyOn(service, "generatePRDescription");
      try {
        for (const action of ["review", "describe"]) {
          const response = await fetch(`${baseUrl}/api/ai/projects/${projectBId}/pull-requests/17/${action}`, {
            method: "POST", headers: { Authorization: tokenA },
          });
          expect(response.status).toBe(404);
        }
        expect(review).not.toHaveBeenCalled();
        expect(describe).not.toHaveBeenCalled();
      } finally {
        review.mockRestore();
        describe.mockRestore();
      }
    });

    test("phase start and run routes reject inaccessible projects before workflow creation", async () => {
      const before = await prisma.workflowRun.count({ where: { projectId: projectBId } });
      for (const action of ["start", "run"]) {
        const response = await fetch(`${baseUrl}/api/projects/${projectBId}/phases/requirements/${action}`, {
          method: "POST", headers: { Authorization: tokenA, "Content-Type": "application/json" },
          body: JSON.stringify({ brief: "Must not run" }),
        });
        expect(response.status).toBe(404);
      }
      expect(await prisma.workflowRun.count({ where: { projectId: projectBId } })).toBe(before);
    });


    test("project and document collections contain only actor-visible projects", async () => {
      const projectsResponse = await fetch(`${baseUrl}/api/projects`, { headers: { Authorization: tokenA } });
      expect(projectsResponse.status).toBe(200);
      const projects = (await projectsResponse.json()) as { data: Array<{ id: string }> };
      expect(projects.data.some((project) => project.id === projectAId)).toBe(true);
      expect(projects.data.some((project) => project.id === projectBId)).toBe(false);

      const documentsResponse = await fetch(`${baseUrl}/api/projects/documents/all`, { headers: { Authorization: tokenA } });
      expect(documentsResponse.status).toBe(200);
      const documents = (await documentsResponse.json()) as { data: Array<{ id: string }> };
      expect(documents.data.some((document) => document.id === fileAId)).toBe(true);
      expect(documents.data.some((document) => document.id === fileBId)).toBe(false);
    });

    test("project creation takes ownership from the authenticated actor", async () => {
      const response = await fetch(`${baseUrl}/api/projects`, {
        method: "POST", headers: { Authorization: tokenA, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Actor owned project", userId: userBId }),
      });
      expect(response.status).toBe(201);
      const body = (await response.json()) as { data: { id: string } };
      const created = await prisma.project.findUnique({ where: { id: body.data.id } });
      expect(created?.userId).toBe(userAId);
    });

    test("admin stats require the admin route boundary before aggregate disclosure", async () => {
      const denied = await fetch(`${baseUrl}/api/admin/stats`, { headers: { Authorization: tokenA } });
      expect(denied.status).toBe(403);
      const allowed = await fetch(`${baseUrl}/api/admin/stats`, { headers: { Authorization: tokenAdmin } });
      expect(allowed.status).toBe(200);
      const body = (await allowed.json()) as { data: { projects: Array<{ id: string }> } };
      expect(body.data.projects.some((project) => project.id === projectBId)).toBe(true);
    });

    test("User A can read permitted Project A resources from PostgreSQL", async () => {
      const res = await fetch(`${baseUrl}/api/projects/${projectAId}`, {
        headers: { Authorization: tokenA },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.data.id).toBe(projectAId);
      expect(body.data.name).toBe("Project A Canonical");
    });

    test("User A cannot read Project B (404 non-disclosing)", async () => {
      const res = await fetch(`${baseUrl}/api/projects/${projectBId}`, {
        headers: { Authorization: tokenA },
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as any;
      expect(body.error).toBe("PLANNING_PROJECT_NOT_FOUND");
    });

    test("User A cannot mutate Project B (404 non-disclosing on PUT)", async () => {
      const res = await fetch(`${baseUrl}/api/projects/${projectBId}`, {
        method: "PUT",
        headers: { Authorization: tokenA, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Malicious Rename" }),
      });
      expect(res.status).toBe(404);

      // Verify DB record was not mutated
      const projectB = await prisma.project.findUnique({ where: { id: projectBId } });
      expect(projectB?.name).toBe("Project B Canonical");
    });

    test("User A cannot delete Project B (404 non-disclosing on DELETE)", async () => {
      const res = await fetch(`${baseUrl}/api/projects/${projectBId}`, {
        method: "DELETE",
        headers: { Authorization: tokenA },
      });
      expect(res.status).toBe(404);

      // Verify DB record still exists
      const projectB = await prisma.project.findUnique({ where: { id: projectBId } });
      expect(projectB).not.toBeNull();
    });

    test("User A cannot create tasks in Project B (404 non-disclosing)", async () => {
      const res = await fetch(`${baseUrl}/api/projects/${projectBId}/tasks`, {
        method: "POST",
        headers: { Authorization: tokenA, "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Injected Task" }),
      });
      expect(res.status).toBe(404);

      const task = await prisma.projectTask.findFirst({
        where: { projectId: projectBId, title: "Injected Task" },
      });
      expect(task).toBeNull();
    });

    test("Non-existent project ID returns 404 with identical message", async () => {
      const fakeId = `fake-${crypto.randomUUID()}`;
      const res = await fetch(`${baseUrl}/api/projects/${fakeId}`, {
        headers: { Authorization: tokenA },
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as any;
      expect(body.error).toBe("PLANNING_PROJECT_NOT_FOUND");
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // 2. PROJECT FILES & S3 SIDE EFFECTS
  // ────────────────────────────────────────────────────────────────────────────
  describe("Project Files Ownership & Mocked S3 Verification", () => {
    test("User A can access File A through Project A and receives signed download URL", async () => {
      const res = await fetch(`${baseUrl}/api/projects/${projectAId}/files/${fileAId}/download`, {
        headers: { Authorization: tokenA },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.data.downloadUrl).toContain("mock-s3.local/download");
      expect(uploadService.generateDownloadUrl).toHaveBeenCalledTimes(1);
    });

    test("User A cannot access File B through Project A (404)", async () => {
      const res = await fetch(`${baseUrl}/api/projects/${projectAId}/files/${fileBId}/download`, {
        headers: { Authorization: tokenA },
      });
      expect(res.status).toBe(404);
      expect(uploadService.generateDownloadUrl).not.toHaveBeenCalled();
    });

    test("Dual User + route Project A + File B download is denied (404) and S3 is not called", async () => {
      const res = await fetch(`${baseUrl}/api/projects/${projectAId}/files/${fileBId}/download`, {
        headers: { Authorization: tokenDual },
      });
      expect(res.status).toBe(404);
      expect(uploadService.generateDownloadUrl).not.toHaveBeenCalled();
    });

    test("Dual User + route Project A + File B delete is denied (404) and S3 delete is not called", async () => {
      const res = await fetch(`${baseUrl}/api/projects/${projectAId}/files/${fileBId}`, {
        method: "DELETE",
        headers: { Authorization: tokenDual },
      });
      expect(res.status).toBe(404);
      expect(uploadService.deleteFromS3).not.toHaveBeenCalled();

      // Verify file B record still exists in real PostgreSQL
      const fileB = await prisma.projectFile.findUnique({ where: { id: fileBId } });
      expect(fileB).not.toBeNull();
    });

    test("Dual User + route Project A + File B confirmation is denied (404)", async () => {
      const foreignKey = `projects/${projectBId}/${crypto.randomUUID()}.pdf`;
      const foreignUrl = `https://anka-os-documents.s3.ap-south-1.amazonaws.com/${foreignKey}`;
      const res = await fetch(`${baseUrl}/api/projects/${projectAId}/files/confirm`, {
        method: "POST",
        headers: { Authorization: tokenDual, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "document-b.pdf", url: foreignUrl, s3Key: foreignKey }),
      });
      expect(res.status).toBe(404);
    });

    test("Dual User + route Project A + presign generates key strictly scoped to route project", async () => {
      const res = await fetch(`${baseUrl}/api/projects/${projectAId}/files/presign`, {
        method: "POST",
        headers: { Authorization: tokenDual, "Content-Type": "application/json" },
        body: JSON.stringify({ filename: "document.pdf", mimetype: "application/pdf" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.data.key.startsWith(`projects/${projectAId}/`)).toBe(true);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // 3. NESTED RESOURCE BINDING (Dual User Cross-Project Substitution)
  // ────────────────────────────────────────────────────────────────────────────
  describe("Dual User Cross-Project Nested Resource Binding", () => {
    const foreignAiCases: Array<{
      entry: string;
      method: string;
      path: () => string;
      body: () => Record<string, unknown>;
    }> = [
      { entry: "project chat session", method: "POST", path: () => `/api/ai/projects/${projectAId}/chat`, body: () => ({ message: "hello", sessionId: sessionBId }) },
      { entry: "coding agent session", method: "POST", path: () => `/api/ai/projects/${projectAId}/agent/run`, body: () => ({ message: "test", sessionId: sessionBId }) },
      { entry: "coding agent repository", method: "POST", path: () => `/api/ai/projects/${projectAId}/agent/run`, body: () => ({ message: "test", repositoryId: repoBId }) },
      { entry: "streaming agent session", method: "POST", path: () => `/api/ai/projects/${projectAId}/agent/stream`, body: () => ({ message: "test", sessionId: sessionBId }) },
      { entry: "streaming agent repository", method: "POST", path: () => `/api/ai/projects/${projectAId}/agent/stream`, body: () => ({ message: "test", repositoryId: repoBId }) },
      { entry: "manifest session", method: "POST", path: () => `/api/ai/projects/${projectAId}/agent/manifest`, body: () => ({ userRequest: "test", sessionId: sessionBId }) },
    ];

    test.each(foreignAiCases)("$entry denies a dual-authorized cross-project ID before agent dispatch", async ({ method, path, body }) => {
      const response = await fetch(`${baseUrl}${path()}`, {
        method,
        headers: { Authorization: tokenDual, "Content-Type": "application/json" },
        body: JSON.stringify(body()),
      });
      expect(response.status).toBe(404);
    });

    test("foreign drift record cannot be resolved through an accessible route project", async () => {
      const response = await fetch(`${baseUrl}/api/ai/projects/${projectAId}/drift-records/${driftBId}`, {
        method: "PATCH",
        headers: { Authorization: tokenDual, "Content-Type": "application/json" },
        body: JSON.stringify({ status: "dismissed" }),
      });
      expect(response.status).toBe(404);
      const record = await prisma.architectureDriftRecord.findUnique({ where: { id: driftBId } });
      expect(record?.status).toBe("open");
    });

    const foreignResourceCases: Array<{
      entry: string;
      method: string;
      path: () => string;
      body?: () => Record<string, unknown>;
    }> = [
      { entry: "task delete", method: "DELETE", path: () => `/api/projects/${projectAId}/tasks/${taskBId}` },
      { entry: "task comments list", method: "GET", path: () => `/api/projects/${projectAId}/tasks/${taskBId}/comments` },
      { entry: "task comments create", method: "POST", path: () => `/api/projects/${projectAId}/tasks/${taskBId}/comments`, body: () => ({ content: "foreign comment" }) },
      { entry: "task dependency add subject", method: "POST", path: () => `/api/projects/${projectAId}/tasks/${taskBId}/dependencies`, body: () => ({ blockingTaskId: taskAId }) },
      { entry: "task dependency add blocker", method: "POST", path: () => `/api/projects/${projectAId}/tasks/${taskAId}/dependencies`, body: () => ({ blockingTaskId: taskBId }) },
      { entry: "task dependency remove", method: "DELETE", path: () => `/api/projects/${projectAId}/tasks/${taskAId}/dependencies/${taskBId}` },
      { entry: "task checklist list", method: "GET", path: () => `/api/projects/${projectAId}/tasks/${taskBId}/checklist` },
      { entry: "task checklist create", method: "POST", path: () => `/api/projects/${projectAId}/tasks/${taskBId}/checklist`, body: () => ({ text: "foreign item" }) },
      { entry: "task checklist update", method: "PATCH", path: () => `/api/projects/${projectAId}/tasks/${taskAId}/checklist/${itemBId}`, body: () => ({ checked: true }) },
      { entry: "task checklist delete", method: "DELETE", path: () => `/api/projects/${projectAId}/tasks/${taskAId}/checklist/${itemBId}` },
      { entry: "rule update", method: "PUT", path: () => `/api/projects/${projectAId}/rules/${ruleBId}`, body: () => ({ title: "foreign rule" }) },
      { entry: "document delete", method: "DELETE", path: () => `/api/projects/${projectAId}/documents/${documentBId}` },
      { entry: "decision create with foreign artifact", method: "POST", path: () => `/api/projects/${projectAId}/decisions`, body: () => ({ title: "Foreign decision", description: "Must be denied", artifactId: artifactBId }) },
      { entry: "decision update", method: "PUT", path: () => `/api/projects/${projectAId}/decisions/${decisionBId}`, body: () => ({ title: "foreign decision" }) },
      { entry: "sprint update", method: "PUT", path: () => `/api/projects/${projectAId}/sprints/${sprintBId}`, body: () => ({ name: "foreign sprint" }) },
      { entry: "sprint delete", method: "DELETE", path: () => `/api/projects/${projectAId}/sprints/${sprintBId}` },
      { entry: "sprint task add: foreign sprint", method: "POST", path: () => `/api/projects/${projectAId}/sprints/${sprintBId}/tasks`, body: () => ({ taskId: taskAId }) },
      { entry: "sprint task add: foreign task", method: "POST", path: () => `/api/projects/${projectAId}/sprints/${sprintAId}/tasks`, body: () => ({ taskId: taskBId }) },
      { entry: "sprint task remove", method: "DELETE", path: () => `/api/projects/${projectAId}/sprints/${sprintAId}/tasks/${taskBId}` },
      { entry: "repository update", method: "PUT", path: () => `/api/projects/${projectAId}/repositories/${repoBId}`, body: () => ({ name: "foreign repo" }) },
      { entry: "repository sync", method: "POST", path: () => `/api/projects/${projectAId}/repositories/${repoBId}/sync` },
      { entry: "repository remove", method: "DELETE", path: () => `/api/projects/${projectAId}/repositories/${repoBId}` },
    ];

    test.each(foreignResourceCases)("$entry denies a dual-authorized cross-project ID", async ({ method, path, body }) => {
      const response = await fetch(`${baseUrl}${path()}`, {
        method,
        headers: { Authorization: tokenDual, ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body()) } : {}),
      });
      expect(response.status).toBe(404);
    });

    test("member removal uses the route project and cannot remove a member of B", async () => {
      await prisma.projectMember.create({ data: { projectId: projectBId, userId: userAId } });
      try {
        const response = await fetch(`${baseUrl}/api/projects/${projectAId}/members/${userAId}`, {
          method: "DELETE", headers: { Authorization: tokenDual },
        });
        expect(response.status).toBe(404);
        expect(await prisma.projectMember.findUnique({
          where: { projectId_userId: { projectId: projectBId, userId: userAId } },
        })).not.toBeNull();
      } finally {
        await prisma.projectMember.delete({ where: { projectId_userId: { projectId: projectBId, userId: userAId } } });
      }
    });

    test("Kanban task, execution, and clarification IDs from B cannot act through A", async () => {
      // The actor owns A and is also a member of B, so project access alone cannot explain denial.
      await prisma.projectMember.create({ data: { projectId: projectBId, userId: userAId } });
      try {
        const cases: Array<[string, string, string, Record<string, unknown> | undefined, number]> = [
          ["task status", "PATCH", `/api/projects/${projectAId}/kanban/tasks/${kanbanTaskBId}/status`, { status: "in_progress" }, 404],
          ["task edit", "PATCH", `/api/projects/${projectAId}/kanban/tasks/${kanbanTaskBId}`, { title: "foreign edit", expectedStateVersion: 0 }, 409],
          ["list executions", "GET", `/api/projects/${projectAId}/kanban/tasks/${kanbanTaskBId}/executions`, undefined, 404],
          ["get execution", "GET", `/api/projects/${projectAId}/kanban/tasks/${kanbanTaskAId}/executions/${executionBId}`, undefined, 404],
          ["accept foreign execution", "POST", `/api/projects/${projectAId}/kanban/tasks/${kanbanTaskAId}/executions/${executionBId}/accept`, { commitSummary: "No foreign acceptance", changes: [{ path: "src/a.ts", content: "safe" }] }, 409],
          ["reject foreign execution", "POST", `/api/projects/${projectAId}/kanban/tasks/${kanbanTaskAId}/executions/${executionBId}/reject`, { comments: "No foreign rejection" }, 409],
          ["clarification request", "POST", `/api/projects/${projectAId}/kanban/clarifications`, { taskId: kanbanTaskBId, question: "Foreign?", options: ["yes", "no"] }, 404],
          ["clarification resolve", "POST", `/api/projects/${projectAId}/kanban/clarifications/${clarificationBId}/resolve`, { selectedOption: "yes" }, 404],
        ];
        for (const [entry, method, path, body, expectedStatus] of cases) {
          const response = await fetch(`${baseUrl}${path}`, {
            method,
            headers: { Authorization: tokenA, ...(body ? { "Content-Type": "application/json" } : {}) },
            ...(body ? { body: JSON.stringify(body) } : {}),
          });
          expect({ entry, status: response.status }).toEqual({ entry, status: expectedStatus });
        }
        const taskB = await prisma.kanbanTask.findUnique({ where: { id: kanbanTaskBId } });
        const executionB = await prisma.implementationTaskExecution.findUnique({ where: { id: executionBId } });
        const clarificationB = await prisma.clarificationQA.findUnique({ where: { id: clarificationBId } });
        expect(taskB?.status).toBe("todo");
        expect(executionB?.state).toBe("awaiting_review");
        expect(clarificationB?.resolved).toBe(false);
      } finally {
        await prisma.projectMember.delete({ where: { projectId_userId: { projectId: projectBId, userId: userAId } } });
      }
    });

    test("Project Rule: Dual User calling Project A route with Project B rule is denied (404)", async () => {
      const res = await fetch(`${baseUrl}/api/projects/${projectAId}/rules/${ruleBId}`, {
        method: "DELETE",
        headers: { Authorization: tokenDual },
      });
      expect(res.status).toBe(404);

      // Verify Rule B was not deleted from PostgreSQL
      const ruleB = await prisma.projectRule.findUnique({ where: { id: ruleBId } });
      expect(ruleB).not.toBeNull();
    });

    test("Project Decision: Dual User calling Project A route with Project B decision is denied (404)", async () => {
      const res = await fetch(`${baseUrl}/api/projects/${projectAId}/decisions/${decisionBId}`, {
        method: "DELETE",
        headers: { Authorization: tokenDual },
      });
      expect(res.status).toBe(404);

      // Verify Decision B was not deleted from PostgreSQL
      const decisionB = await prisma.projectDecision.findUnique({ where: { id: decisionBId } });
      expect(decisionB).not.toBeNull();
    });

    test("Project Task: Dual User calling Project A route with Project B task is denied (404)", async () => {
      const res = await fetch(`${baseUrl}/api/projects/${projectAId}/tasks/${taskBId}`, {
        method: "PUT",
        headers: { Authorization: tokenDual, "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Mutated Task Title" }),
      });
      expect(res.status).toBe(404);

      const taskB = await prisma.projectTask.findUnique({ where: { id: taskBId } });
      expect(taskB?.title).toBe("Task B Title");
    });

    test("Task Comment: Dual User calling Project A route with Project B comment is denied (404)", async () => {
      const res = await fetch(`${baseUrl}/api/projects/${projectAId}/tasks/${taskAId}/comments/${commentBId}`, {
        method: "DELETE",
        headers: { Authorization: tokenDual },
      });
      expect(res.status).toBe(404);

      const commentB = await prisma.taskComment.findUnique({ where: { id: commentBId } });
      expect(commentB).not.toBeNull();
    });

    test("Task Checklist Item: Dual User calling Project A route with Project B checklist item is denied (404)", async () => {
      const res = await fetch(`${baseUrl}/api/projects/${projectAId}/tasks/${taskAId}/checklist/${itemBId}`, {
        method: "PUT",
        headers: { Authorization: tokenDual, "Content-Type": "application/json" },
        body: JSON.stringify({ checked: true }),
      });
      expect(res.status).toBe(404);

      const itemB = await prisma.taskChecklistItem.findUnique({ where: { id: itemBId } });
      expect(itemB?.checked).toBe(false);
    });

    test("Sprint: Dual User calling Project A route with Project B sprint suggest is denied (404)", async () => {
      const res = await fetch(`${baseUrl}/api/ai/projects/${projectAId}/sprints/${sprintBId}/suggest`, {
        headers: { Authorization: tokenDual },
      });
      expect(res.status).toBe(404);
    });

    test("AI Chat Session: Dual User calling Project A route with Project B session is denied (404)", async () => {
      const res = await fetch(`${baseUrl}/api/ai/projects/${projectAId}/sessions/${sessionBId}/messages`, {
        headers: { Authorization: tokenDual },
      });
      expect(res.status).toBe(404);
    });

    test("Project Repository: Dual User calling Project A route with Project B repository is denied (404)", async () => {
      const res = await fetch(`${baseUrl}/api/projects/${projectAId}/repositories/${repoBId}`, {
        headers: { Authorization: tokenDual },
      });
      expect(res.status).toBe(404);
    });

    test("Phase Artifact: Dual User calling Project A route with Project B artifact is denied (404)", async () => {
      const res = await fetch(`${baseUrl}/api/projects/${projectAId}/phases/artifacts/${artifactBId}`, {
        headers: { Authorization: tokenDual },
      });
      expect(res.status).toBe(404);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // 4. GENERAL CHAT PROJECT RESOLUTION (Real PostgreSQL backing)
  // ────────────────────────────────────────────────────────────────────────────
  describe("General Chat Actor-Scoped Project Resolution (DB Backed)", () => {
    test("Authorized project ID resolves correctly for actor", async () => {
      const resolution = await planningAuth.resolveProjectForActor(userAId, {
        projectId: projectAId,
      });
      expect(resolution).toEqual({
        status: "RESOLVED",
        project: { id: projectAId, name: "Project A Canonical" },
      });
    });

    test("Unauthorized project ID does not resolve for actor (NOT_FOUND)", async () => {
      const resolution = await planningAuth.resolveProjectForActor(userAId, {
        projectId: projectBId,
      });
      expect(resolution).toEqual({ status: "NOT_FOUND" });
    });

    test("Unauthorized project name does not resolve for actor (NOT_FOUND)", async () => {
      const resolution = await planningAuth.resolveProjectForActor(userAId, {
        projectName: "Project B Canonical",
      });
      expect(resolution).toEqual({ status: "NOT_FOUND" });
    });

    test("Hidden duplicate project name does not create false ambiguity for single-project owner", async () => {
      // Create Project B2 owned by User B with exact same name as Project A
      const dupName = `Shared Name ${crypto.randomUUID()}`;
      const projectA_dup = await prisma.project.create({
        data: { name: dupName, userId: userAId },
      });
      const projectB_dup = await prisma.project.create({
        data: { name: dupName, userId: userBId },
      });

      // User A can only see Project A_dup. Project B_dup is hidden from User A.
      const resolutionA = await planningAuth.resolveProjectForActor(userAId, {
        projectName: dupName,
      });
      expect(resolutionA).toEqual({
        status: "RESOLVED",
        project: { id: projectA_dup.id, name: dupName },
      });

      // Dual User has access to both projectA_dup and projectB_dup.
      await prisma.projectMember.createMany({
        data: [
          { projectId: projectA_dup.id, userId: userDualId },
          { projectId: projectB_dup.id, userId: userDualId },
        ],
      });

      // Dual User sees two visible duplicate names -> produces safe AMBIGUOUS result!
      const resolutionDual = await planningAuth.resolveProjectForActor(userDualId, {
        projectName: dupName,
      });
      expect(resolutionDual.status).toBe("AMBIGUOUS");
      if (resolutionDual.status === "AMBIGUOUS") {
        expect(resolutionDual.candidates.length).toBe(2);
        const candidateIds = resolutionDual.candidates.map((c) => c.id).sort();
        expect(candidateIds).toEqual([projectA_dup.id, projectB_dup.id].sort());
      }
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // 5. AGENT MANIFEST MUTATION AUTHORIZATION
  // ────────────────────────────────────────────────────────────────────────────
  describe("Agent Manifest Mutation Authorization", () => {
    test("Foreign manifest cannot be approved by outsider (404 non-disclosing)", async () => {
      const res = await fetch(`${baseUrl}/api/ai/agent/manifest/${manifestBId}/approve`, {
        method: "POST",
        headers: { Authorization: tokenA },
      });
      expect(res.status).toBe(404);

      // Verify PostgreSQL record status was NOT updated
      const manifestB = await prisma.agentManifest.findUnique({ where: { id: manifestBId } });
      expect(manifestB?.validationStatus).toBe("pending");
      expect(manifestB?.approvedAt).toBeNull();
    });

    test("Foreign manifest cannot be rejected by outsider (404 non-disclosing)", async () => {
      const res = await fetch(`${baseUrl}/api/ai/agent/manifest/${manifestBId}/reject`, {
        method: "POST",
        headers: { Authorization: tokenA },
      });
      expect(res.status).toBe(404);

      // Verify PostgreSQL record status was NOT updated
      const manifestB = await prisma.agentManifest.findUnique({ where: { id: manifestBId } });
      expect(manifestB?.validationStatus).toBe("pending");
    });

    test("Missing manifest ID returns 404 non-disclosing", async () => {
      const missingId = `missing-${crypto.randomUUID()}`;
      const res = await fetch(`${baseUrl}/api/ai/agent/manifest/${missingId}/approve`, {
        method: "POST",
        headers: { Authorization: tokenA },
      });
      expect(res.status).toBe(404);
    });

    test("Authorized project owner can approve own manifest", async () => {
      const res = await fetch(`${baseUrl}/api/ai/agent/manifest/${manifestAId}/approve`, {
        method: "POST",
        headers: { Authorization: tokenA },
      });
      expect(res.status).toBe(200);

      const manifestA = await prisma.agentManifest.findUnique({ where: { id: manifestAId } });
      expect(manifestA?.validationStatus).toBe("approved");
      expect(manifestA?.approvedAt).not.toBeNull();
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // 6. TASK DECOMPOSITION NON-DISCLOSURE
  // ────────────────────────────────────────────────────────────────────────────
  describe("Task Decomposition Non-Disclosure", () => {
    test("Accessible decomposition is returned to authorized actor", async () => {
      const res = await fetch(`${baseUrl}/api/ai/agent/decomposition/${sessionAId}`, {
        headers: { Authorization: tokenA },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.success).toBe(true);
      expect(body.data).not.toBeNull();
      expect(body.data.id).toBe(decompAId);
      expect(body.data.userRequest).toBe("Decompose feature A");
    });

    test("Inaccessible decomposition returns non-disclosing null payload (identical to non-existent session)", async () => {
      // User A attempts to view decomposition of Project B session
      const res = await fetch(`${baseUrl}/api/ai/agent/decomposition/${sessionBId}`, {
        headers: { Authorization: tokenA },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.success).toBe(true);
      expect(body.data).toBeNull();
    });

    test("Truly non-existent session returns identical null payload", async () => {
      const nonExistent = `non-existent-${crypto.randomUUID()}`;
      const res = await fetch(`${baseUrl}/api/ai/agent/decomposition/${nonExistent}`, {
        headers: { Authorization: tokenA },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.success).toBe(true);
      expect(body.data).toBeNull();
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // 7. PHASE / PLANNING RELATIONAL OWNERSHIP
  // ────────────────────────────────────────────────────────────────────────────
  describe("Phase / Planning Relational DB Ownership", () => {
    const foreignPlanningCases: Array<{
      entry: string;
      method: string;
      path: () => string;
      body?: () => Record<string, unknown>;
    }> = [
      { entry: "Requirements readiness", method: "GET", path: () => `/api/projects/${projectAId}/phases/requirements/artifacts/${artifactBId}/readiness` },
      { entry: "Requirements run", method: "GET", path: () => `/api/projects/${projectAId}/phases/runs/${runBId}` },
      { entry: "Architecture run", method: "GET", path: () => `/api/projects/${projectAId}/phases/architecture/runs/${runBId}` },
      { entry: "Requirements approval request", method: "POST", path: () => `/api/projects/${projectAId}/phases/requirements/request-approval`, body: () => ({ artifactId: artifactBId, expectedHash: "a".repeat(64) }) },
    ];

    test.each(foreignPlanningCases)("$entry rejects a Project B resource under Project A", async ({ method, path, body }) => {
      const response = await fetch(`${baseUrl}${path()}`, {
        method,
        headers: { Authorization: tokenDual, ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body()) } : {}),
      });
      expect(response.status).toBe(404);
    });

    test("Requirements owner decisions reject a foreign artifact after valid local phase preflight", async () => {
      await prisma.projectMember.create({ data: { projectId: projectBId, userId: userAId } });
      await prisma.projectPhaseState.create({
        data: { projectId: projectAId, phase: "requirements", status: "awaiting_approval",
          currentArtifactId: artifactAId, approvalCandidateArtifactId: artifactAId },
      });
      try {
        for (const [action, body] of [
          ["approve", { artifactId: artifactBId, expectedHash: "a".repeat(64) }],
          ["request-changes", { artifactId: artifactBId, expectedHash: "a".repeat(64), comments: "Foreign artifact" }],
        ] as const) {
          const response = await fetch(`${baseUrl}/api/projects/${projectAId}/phases/requirements/${action}`, {
            method: "POST", headers: { Authorization: tokenA, "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          expect({ action, status: response.status }).toEqual({ action, status: 404 });
        }
        expect(await prisma.phaseApproval.count({ where: { projectId: projectAId } })).toBe(0);
      } finally {
        await prisma.projectPhaseState.delete({ where: { projectId_phase: { projectId: projectAId, phase: "requirements" } } });
        await prisma.projectMember.delete({ where: { projectId_userId: { projectId: projectBId, userId: userAId } } });
      }
    });

    test("Requirements rejection is unavailable and cannot act on a foreign artifact", async () => {
      const before = await prisma.phaseApproval.count({ where: { projectId: projectAId } });
      const response = await fetch(`${baseUrl}/api/projects/${projectAId}/phases/requirements/reject`, {
        method: "POST", headers: { Authorization: tokenA, "Content-Type": "application/json" },
        body: JSON.stringify({ artifactId: artifactBId, expectedHash: "a".repeat(64), comments: "Reject" }),
      });
      expect(response.status).toBe(422);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("PLANNING_ACTION_NOT_IMPLEMENTED");
      expect(await prisma.phaseApproval.count({ where: { projectId: projectAId } })).toBe(before);
    });

    test("Requirements revision rejects a foreign base before creating a workflow run", async () => {
      const before = await prisma.workflowRun.count({ where: { projectId: projectAId } });
      const response = await fetch(`${baseUrl}/api/projects/${projectAId}/phases/requirements/artifacts/${artifactBId}/revisions`, {
        method: "POST",
        headers: { Authorization: tokenDual, "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ operation: "DOCUMENT_REVISION", instruction: "Revise the Requirements" }),
      });
      expect(response.status).toBe(404);
      expect(await prisma.workflowRun.count({ where: { projectId: projectAId } })).toBe(before);
    });

    test("Documentation revision routes reject a foreign Documentation base before workflow creation", async () => {
      const before = await prisma.workflowRun.count({ where: { projectId: projectAId } });
      const path = `/api/projects/${projectAId}/phases/documentation/artifacts/${documentationArtifactBId}`;
      for (const [suffix, body] of [
        ["/revisions", { operation: "DOCUMENT_REVISION", instruction: "Revise documentation" }],
        ["/revise", { instruction: "Revise document" }],
        ["/feedback", { feedback: "Apply feedback" }],
        ["/sections/overview/revise", { instruction: "Revise overview" }],
        ["/sections/overview/regenerate", {}],
      ] as const) {
        const response = await fetch(`${baseUrl}${path}${suffix}`, {
          method: "POST",
          headers: { Authorization: tokenDual, "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
          body: JSON.stringify(body),
        });
        expect({ suffix, status: response.status }).toEqual({ suffix, status: 404 });
      }
      expect(await prisma.workflowRun.count({ where: { projectId: projectAId } })).toBe(before);
    });

    test("Architecture AI revision rejects a foreign Architecture base before provider dispatch", async () => {
      await prisma.project.update({ where: { id: projectAId }, data: { currentPhase: "architecture" } });
      await prisma.projectPhaseState.create({ data: { projectId: projectAId, phase: "architecture", status: "in_progress" } });
      try {
        const response = await fetch(`${baseUrl}/api/projects/${projectAId}/phases/architecture/artifacts/${architectureArtifactBId}/revisions/ai`, {
          method: "POST",
          headers: { Authorization: tokenDual, "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
          body: JSON.stringify({ operation: "DOCUMENT_REVISION", baseVersion: 1,
            baseContentHash: "a".repeat(64), instruction: "Revise architecture" }),
        });
        expect(response.status).toBe(404);
      } finally {
        await prisma.projectPhaseState.delete({ where: { projectId_phase: { projectId: projectAId, phase: "architecture" } } });
        await prisma.project.update({ where: { id: projectAId }, data: { currentPhase: null } });
      }
    });

    test("approved planning authority still rejects foreign Architecture artifacts and implementation tasks", async () => {
      const authorizedProjectId = `cp0-authority-${crypto.randomUUID()}`;
      await prisma.project.create({ data: { id: authorizedProjectId, name: "Approved A", userId: userAId } });
      await prisma.projectMember.create({ data: { projectId: authorizedProjectId, userId: userDualId } });
      await prisma.projectMember.create({ data: { projectId: projectBId, userId: userAId } });
      const requirements = authorityRequirements();
      const approvals = new PlanningApprovalService(prisma);
      const requirementArtifact = await new PlanningArtifactService(prisma).createInitialArtifact({
        projectId: authorizedProjectId, actorId: userAId, title: "Requirements", structuredContent: requirements,
      });
      const reqHash = requirementArtifact.contentHash!;
      await approvals.requestApproval({ projectId: authorizedProjectId, phase: "requirements",
        artifactId: requirementArtifact.id, expectedHash: reqHash, actorId: userAId });
      await approvals.approveArtifact({ projectId: authorizedProjectId, phase: "requirements",
        artifactId: requirementArtifact.id, expectedHash: reqHash, actorId: userAId });
      const documentation = assembleDocumentationContent(authorityDocumentationDraft(), {
        artifactId: requirementArtifact.id, version: requirementArtifact.version, contentHash: reqHash,
      }, requirements);
      const documentationArtifact = await new PlanningDocumentationArtifactService(prisma).createInitialArtifact({
        projectId: authorizedProjectId, actorId: userAId, title: "Documentation", structuredContent: documentation,
      });
      const docHash = documentationArtifact.contentHash!;
      await approvals.requestDocumentationApproval({ projectId: authorizedProjectId,
        artifactId: documentationArtifact.id, expectedHash: docHash, actorId: userAId });
      await approvals.approveDocumentationArtifact({ projectId: authorizedProjectId,
        artifactId: documentationArtifact.id, expectedHash: docHash, actorId: userAId });
      const architecture = await new PlanningArchitectureArtifactService(prisma).create({
        projectId: authorizedProjectId, actorId: userAId, title: "Architecture",
        structuredContent: architectureDraft("NFR-1"),
      });
      const architectureHash = architecture.contentHash!;
      await approvals.requestArchitectureApproval({ projectId: authorizedProjectId,
        artifactId: architecture.id, expectedHash: architectureHash, actorId: userAId });
      await approvals.approveArchitectureArtifact({ projectId: authorizedProjectId,
        artifactId: architecture.id, expectedHash: architectureHash, actorId: userAId });
      await prisma.projectRepository.create({ data: { projectId: authorizedProjectId, name: "approved-repo",
        role: "backend", githubUrl: "https://github.com/org/approved-repo", localPath: process.cwd() } });

      try {
        const before = await prisma.phaseArtifact.count({ where: { projectId: authorizedProjectId, phase: "architecture" } });
        const readiness = await fetch(`${baseUrl}/api/projects/${authorizedProjectId}/phases/architecture/artifacts/${architectureArtifactBId}/readiness`, {
          headers: { Authorization: tokenDual },
        });
        expect(readiness.status).toBe(404);
        const successor = await fetch(`${baseUrl}/api/projects/${authorizedProjectId}/phases/architecture/artifacts/${architectureArtifactBId}/revisions`, {
          method: "POST", headers: { Authorization: tokenDual, "Content-Type": "application/json" },
          body: JSON.stringify({ title: "Foreign successor", structuredContent: architectureDraft("NFR-1"),
            baseContentHash: "a".repeat(64) }),
        });
        expect(successor.status).toBe(404);
        expect(await prisma.phaseArtifact.count({ where: { projectId: authorizedProjectId, phase: "architecture" } })).toBe(before);

        const codingAgent = jest.spyOn(CodingAgent, "runCodingAgent");
        try {
          const cases: Array<[string, Record<string, unknown>]> = [
            ["approve", { expectedStateVersion: 0 }],
            ["executions", { idempotencyKey: crypto.randomUUID() }],
          ];
          for (const [action, body] of cases) {
            const response = await fetch(`${baseUrl}/api/projects/${authorizedProjectId}/kanban/tasks/${kanbanTaskBId}/${action}`, {
              method: "POST", headers: { Authorization: tokenA, "Content-Type": "application/json" },
              body: JSON.stringify(body),
            });
            expect({ action, status: response.status }).toEqual({ action, status: 404 });
          }
          for (const prefix of ["/api/ai/projects", "/api/projects"]) {
            const response = await fetch(`${baseUrl}${prefix}/${authorizedProjectId}/agent/multi-repo/run`, {
              method: "POST", headers: { Authorization: tokenA, "Content-Type": "application/json" },
              body: JSON.stringify({ message: "Do not run", repositoryIds: [repoBId] }),
            });
            expect({ prefix, status: response.status }).toEqual({ prefix, status: 404 });
            const body = (await response.json()) as { error: string };
            expect(body.error).toBe("REPOSITORY_NOT_FOUND");
          }
          expect(codingAgent).not.toHaveBeenCalled();
        } finally {
          codingAgent.mockRestore();
        }
      } finally {
        await prisma.projectMember.delete({ where: { projectId_userId: { projectId: projectBId, userId: userAId } } });
      }
    });

    test("Real DB Phase Artifact belongs strictly to its project", async () => {
      const artA = await prisma.phaseArtifact.findUnique({ where: { id: artifactAId } });
      expect(artA?.projectId).toBe(projectAId);

      const artB = await prisma.phaseArtifact.findUnique({ where: { id: artifactBId } });
      expect(artB?.projectId).toBe(projectBId);
    });

    test("Real DB Workflow Run belongs strictly to its project", async () => {
      const runA = await prisma.workflowRun.findUnique({ where: { id: runAId } });
      expect(runA?.projectId).toBe(projectAId);

      const runB = await prisma.workflowRun.findUnique({ where: { id: runBId } });
      expect(runB?.projectId).toBe(projectBId);
    });

    test("Outsider User A cannot fetch Project B workflow runs (404 non-disclosing)", async () => {
      const res = await fetch(`${baseUrl}/api/projects/${projectBId}/phases/approvals`, {
        headers: { Authorization: tokenA },
      });
      expect(res.status).toBe(404);
    });
  });
});
