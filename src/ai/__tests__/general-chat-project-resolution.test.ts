import { PrismaClient } from "@prisma/client";
import { LLMGateway } from "../gateway/LLMGateway";
import { PipelineStages } from "../gateway/PipelineStage";
import { ProjectChatService } from "../application/ProjectChatService";
import { PlanningAuthorizationService } from "../../services/planning-authorization.service";
import { RepositoryContextBuilder } from "../repository/RepositoryContextBuilder";

jest.mock("../memory/MemoryPersistence", () => ({
  MemoryPersistence: {
    getOrCreateSession: jest.fn().mockResolvedValue({ id: "session-gen-1", title: "General Session" }),
    saveMessage: jest.fn().mockResolvedValue(undefined),
    updateSessionTitle: jest.fn().mockResolvedValue(undefined),
    getMessageCount: jest.fn().mockResolvedValue(1),
  },
}));

jest.mock("../repository/RepositoryContextBuilder", () => ({
  RepositoryContextBuilder: {
    buildGeneralContext: jest.fn().mockResolvedValue({
      workspaceInfo: { user: { name: "User A", email: "user-a@example.com" }, totalProjects: 1, activeProjects: 1 },
    }),
    buildProjectContext: jest.fn().mockResolvedValue({
      project: { id: "p-dummy", name: "Dummy" },
      summary: null,
    }),
  },
}));

function llmToolResult<T>(content: T) {
  return { content, rawResponse: {}, finishReason: "stop", latencyMs: 1, model: "gpt-4o", stage: PipelineStages.APPLICATION_SUPPORT } as any;
}

type FixtureUser = { id: string; email: string; role: string; name?: string };
type FixtureProject = { id: string; name: string; userId: string; description?: string | null; phase?: string | null };

function createDatabaseFixture() {
  const users = new Map<string, FixtureUser>();
  const projects = new Map<string, FixtureProject>();
  const members = new Set<string>(); // "projectId:userId"

  const mockProjectDocumentCreate = jest.fn();

  function addUser(user: FixtureUser) {
    users.set(user.id, user);
  }

  function addProject(project: FixtureProject) {
    projects.set(project.id, project);
  }

  function addMember(projectId: string, userId: string) {
    members.add(`${projectId}:${userId}`);
  }

  const mockPrisma = {
    user: {
      findUnique: jest.fn().mockImplementation(async ({ where }: { where: { id: string } }) => {
        return users.get(where.id) ?? null;
      }),
    },
    project: {
      findUnique: jest.fn().mockImplementation(async ({ where }: { where: { id: string } }) => {
        const found = projects.get(where.id);
        if (!found) return null;
        return { id: found.id, name: found.name, userId: found.userId, description: found.description, phase: found.phase };
      }),
      findMany: jest.fn().mockImplementation(async (args: any) => {
        const all = Array.from(projects.values());
        const isSystemAdmin = args?.where?.userId === undefined && args?.where?.OR === undefined;
        let visible = all;

        if (!isSystemAdmin) {
          const orFilter = args?.where?.OR as Array<{ userId?: string; members?: { some: { userId: string } } }> | undefined;
          if (orFilter) {
            const allowedUserId = orFilter.find((f) => f.userId)?.userId;
            const memberUserId = orFilter.find((f) => f.members?.some?.userId)?.members?.some?.userId;
            visible = all.filter((p) => {
              if (allowedUserId && p.userId === allowedUserId) return true;
              if (memberUserId && members.has(`${p.id}:${memberUserId}`)) return true;
              return false;
            });
          }
        }

        const nameContains = args?.where?.name?.contains as string | undefined;
        if (nameContains) {
          const lower = nameContains.toLowerCase();
          visible = visible.filter((p) => p.name.toLowerCase().includes(lower));
        }

        if (args?.take && visible.length > args.take) {
          visible = visible.slice(0, args.take);
        }

        return visible.map((p) => ({
          id: p.id,
          name: p.name,
          description: p.description ?? null,
          phase: p.phase ?? null,
        }));
      }),
    },
    projectMember: {
      findUnique: jest.fn().mockImplementation(async ({ where }: { where: { projectId_userId: { projectId: string; userId: string } } }) => {
        const key = `${where.projectId_userId.projectId}:${where.projectId_userId.userId}`;
        if (members.has(key)) {
          return { id: `pm-${key}` };
        }
        return null;
      }),
    },
    projectDocument: {
      create: mockProjectDocumentCreate,
    },
  } as unknown as PrismaClient;

  return {
    addUser,
    addProject,
    addMember,
    mockPrisma,
    mockProjectDocumentCreate,
  };
}

describe("CP0.3 Authorization-Safe General-Chat Project Resolution", () => {
  let fixture: ReturnType<typeof createDatabaseFixture>;
  let authService: PlanningAuthorizationService;
  let chatService: ProjectChatService;

  beforeEach(() => {
    jest.clearAllMocks();
    fixture = createDatabaseFixture();

    // Users
    fixture.addUser({ id: "user-a", email: "user-a@example.com", role: "user", name: "User A" });
    fixture.addUser({ id: "user-b", email: "user-b@example.com", role: "user", name: "User B" });
    fixture.addUser({ id: "user-admin", email: "admin@example.com", role: "admin", name: "Admin" });

    // Distinct projects
    fixture.addProject({ id: "project-a", name: "Project Alpha", userId: "user-a" });
    fixture.addProject({ id: "project-b", name: "Project Beta", userId: "user-b" });
    fixture.addProject({ id: "project-m", name: "Project Shared Member", userId: "user-b" });
    fixture.addMember("project-m", "user-a");

    // Same-name projects (Zeus)
    fixture.addProject({ id: "project-zeus-a", name: "Zeus Platform", userId: "user-a" });
    fixture.addProject({ id: "project-zeus-b", name: "Zeus Platform", userId: "user-b" });

    // Duplicate authorized projects (Apollo)
    fixture.addProject({ id: "project-apollo-1", name: "Apollo", userId: "user-a" });
    fixture.addProject({ id: "project-apollo-2", name: "Apollo", userId: "user-a" });
    fixture.addProject({ id: "project-apollo-b", name: "Apollo", userId: "user-b" });

    // Substring ambiguous projects (Omega)
    fixture.addProject({ id: "project-omega-web", name: "Omega Web Client", userId: "user-a" });
    fixture.addProject({ id: "project-omega-api", name: "Omega API Server", userId: "user-a" });

    // Secret project inaccessible to user-a
    fixture.addProject({ id: "project-secret-b", name: "Stealth Secret Initiative", userId: "user-b" });

    authService = new PlanningAuthorizationService(fixture.mockPrisma);
    chatService = new ProjectChatService(fixture.mockPrisma, authService);
  });

  function setupToolInvocation(toolName: string, args: Record<string, unknown>, finalMessage = "Proposal processed.") {
    const callWithToolsSpy = jest.spyOn(LLMGateway.getInstance(), "callWithTools");
    callWithToolsSpy
      .mockResolvedValueOnce(
        llmToolResult({
          type: "tool_calls",
          text: null,
          toolCalls: [{ id: "call-1", name: toolName, arguments: args }],
        }) as any,
      )
      .mockResolvedValueOnce(
        llmToolResult({
          type: "text",
          text: finalMessage,
          toolCalls: [],
        }) as any,
      );
    return callWithToolsSpy;
  }

  function getToolResultJson(gatewaySpy: jest.SpyInstance): any {
    const round2Messages = gatewaySpy.mock.calls[1][0].messages;
    const toolMessage = round2Messages.find((m: any) => m.role === "tool");
    expect(toolMessage).toBeDefined();
    const content = toolMessage.content;
    expect(typeof content).toBe("string");
    return JSON.parse(content as string);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // A. DIRECT ID RESOLUTION
  // ──────────────────────────────────────────────────────────────────────────
  describe("A. Direct Project ID Resolution", () => {
    test("A.1: User A + Project A ID -> permitted, document proposal action created", async () => {
      const gatewaySpy = setupToolInvocation("propose_document", {
        projectId: "project-a",
        title: "PRD Requirements",
        content: "# Spec\nRequirements content",
        type: "requirements",
      });

      const response = await chatService.processGeneralChat("user-a", {
        message: "Propose requirements document for project-a",
      });

      expect(gatewaySpy).toHaveBeenCalledTimes(2);
      expect(response.actions).toHaveLength(1);
      expect(response.actions?.[0]).toEqual({
        type: "document_proposed",
        data: {
          title: "PRD Requirements",
          content: "# Spec\nRequirements content",
          type: "requirements",
          projectId: "project-a",
          projectName: "Project Alpha",
        },
      });

      const toolResult = getToolResultJson(gatewaySpy);
      expect(toolResult).toEqual({
        status: "proposed",
        message: "Document proposed to the user for review.",
      });
    });

    test("A.2: User A + Project B ID -> denied and non-disclosing error returned", async () => {
      const gatewaySpy = setupToolInvocation("propose_document", {
        projectId: "project-b",
        title: "Infiltrate Doc",
        content: "Unauthorized content",
        type: "documentation",
      });

      const response = await chatService.processGeneralChat("user-a", {
        message: "Propose doc for project-b",
      });

      expect(response.actions).toBeUndefined();

      const toolResult = getToolResultJson(gatewaySpy);
      expect(toolResult).toEqual({
        error: "Project not found or is not accessible. Call list_projects to get the correct project ID.",
      });
    });

    test("A.3: User A + nonexistent ID -> identical non-disclosing error behavior", async () => {
      const gatewaySpy = setupToolInvocation("propose_document", {
        projectId: "nonexistent-id-999",
        title: "Ghost Doc",
        content: "Content",
        type: "note",
      });

      const response = await chatService.processGeneralChat("user-a", {
        message: "Propose doc for ghost project",
      });

      expect(response.actions).toBeUndefined();

      const toolResult = getToolResultJson(gatewaySpy);
      expect(toolResult).toEqual({
        error: "Project not found or is not accessible. Call list_projects to get the correct project ID.",
      });
    });

    test("A.4: Rejected lookup does not create a proposal action", async () => {
      setupToolInvocation("propose_document", {
        projectId: "project-b",
        title: "Bad Proposal",
        content: "Content",
        type: "requirements",
      });

      const response = await chatService.processGeneralChat("user-a", {
        message: "Propose doc",
      });

      expect(response.actions).toBeUndefined();
    });

    test("A.5: Rejected lookup does not load unauthorized project content or persist documents", async () => {
      setupToolInvocation("propose_document", {
        projectId: "project-b",
        title: "Target B",
        content: "Content",
        type: "requirements",
      });

      await chatService.processGeneralChat("user-a", { message: "Test" });

      expect(fixture.mockProjectDocumentCreate).not.toHaveBeenCalled();
      expect(RepositoryContextBuilder.buildProjectContext).not.toHaveBeenCalled();
    });

    test("A.6: Rejected lookup sends error tool result, avoiding project-specific operations", async () => {
      const gatewaySpy = setupToolInvocation("propose_document", {
        projectId: "project-b",
        title: "Unauthorized Title",
        content: "Body",
        type: "requirements",
      });

      await chatService.processGeneralChat("user-a", { message: "Action" });

      const toolResult = getToolResultJson(gatewaySpy);
      expect(toolResult.error).toContain("Project not found or is not accessible");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // B. PROJECT NAME / TEXT RESOLUTION
  // ──────────────────────────────────────────────────────────────────────────
  describe("B. Project Name Resolution", () => {
    test("B.1: Unique authorized project name resolves successfully", async () => {
      setupToolInvocation("propose_document", {
        projectName: "Project Alpha",
        title: "Alpha Spec",
        content: "Alpha Content",
        type: "documentation",
      });

      const response = await chatService.processGeneralChat("user-a", {
        message: "Propose doc for Project Alpha",
      });

      expect(response.actions).toHaveLength(1);
      expect(response.actions?.[0]).toEqual({
        type: "document_proposed",
        data: {
          title: "Alpha Spec",
          content: "Alpha Content",
          type: "documentation",
          projectId: "project-a",
          projectName: "Project Alpha",
        },
      });
    });

    test("B.2: Name matching only an unauthorized project behaves as no authorized match", async () => {
      const gatewaySpy = setupToolInvocation("propose_document", {
        projectName: "Stealth Secret Initiative",
        title: "Leak Doc",
        content: "Content",
        type: "documentation",
      });

      const response = await chatService.processGeneralChat("user-a", {
        message: "Propose doc for secret project",
      });

      expect(response.actions).toBeUndefined();

      const toolResult = getToolResultJson(gatewaySpy);
      expect(toolResult).toEqual({
        error: "Project not found or is not accessible. Call list_projects to get the correct project ID.",
      });
    });

    test("B.3: Authorized and unauthorized projects sharing the same name resolve only the authorized project", async () => {
      setupToolInvocation("propose_document", {
        projectName: "Zeus Platform",
        title: "Zeus Architecture",
        content: "Arch Spec",
        type: "requirements",
      });

      const response = await chatService.processGeneralChat("user-a", {
        message: "Propose doc for Zeus Platform",
      });

      expect(response.actions).toHaveLength(1);
      // Must resolve strictly to user-a's project (project-zeus-a), not user-b's project
      expect(response.actions?.[0].data.projectId).toBe("project-zeus-a");
      expect(response.actions?.[0].data.projectName).toBe("Zeus Platform");
    });

    test("B.4: Two authorized projects sharing an ambiguous exact name do not select an arbitrary project", async () => {
      const gatewaySpy = setupToolInvocation("propose_document", {
        projectName: "Apollo",
        title: "Apollo Mission",
        content: "Flight Plan",
        type: "note",
      });

      const response = await chatService.processGeneralChat("user-a", {
        message: "Propose doc for Apollo",
      });

      // Ambiguity must prevent proposal creation
      expect(response.actions).toBeUndefined();

      const parsed = getToolResultJson(gatewaySpy);
      expect(parsed.error).toContain('Multiple projects match "Apollo"');
      expect(parsed.candidates).toHaveLength(2);
      expect(parsed.candidates.map((c: any) => c.id).sort()).toEqual(["project-apollo-1", "project-apollo-2"]);
    });

    test("B.4 (substring): Two authorized projects matching a substring request fail safely with ambiguity", async () => {
      const gatewaySpy = setupToolInvocation("propose_document", {
        projectName: "Omega",
        title: "Omega Integration",
        content: "Content",
        type: "note",
      });

      const response = await chatService.processGeneralChat("user-a", {
        message: "Propose doc for Omega",
      });

      expect(response.actions).toBeUndefined();

      const parsed = getToolResultJson(gatewaySpy);
      expect(parsed.error).toContain('Multiple projects match "Omega"');
      expect(parsed.candidates).toHaveLength(2);
      expect(parsed.candidates.map((c: any) => c.id).sort()).toEqual(["project-omega-api", "project-omega-web"]);
    });

    test("B.5: Ambiguity response contains no inaccessible project information", async () => {
      const gatewaySpy = setupToolInvocation("propose_document", {
        projectName: "Apollo",
        title: "Apollo Mission",
        content: "Content",
        type: "note",
      });

      await chatService.processGeneralChat("user-a", { message: "Propose doc for Apollo" });

      const parsed = getToolResultJson(gatewaySpy);

      // Inaccessible project-apollo-b MUST NOT appear in the ambiguity candidates
      const candidateIds = parsed.candidates.map((c: any) => c.id);
      expect(candidateIds).not.toContain("project-apollo-b");
      expect(candidateIds).toEqual(expect.arrayContaining(["project-apollo-1", "project-apollo-2"]));
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // C. MODEL / TOOL BOUNDARY
  // ──────────────────────────────────────────────────────────────────────────
  describe("C. Model / Tool Boundary", () => {
    test("C.1: list_projects enumerates only caller-visible projects and omits unauthorized projects", async () => {
      const gatewaySpy = setupToolInvocation("list_projects", {});

      await chatService.processGeneralChat("user-a", { message: "What projects do I have?" });

      const listed = getToolResultJson(gatewaySpy);
      const listedIds = listed.map((p: any) => p.id);

      // Visible projects: owned by user-a + member project (project-m)
      expect(listedIds).toContain("project-a");
      expect(listedIds).toContain("project-m");
      expect(listedIds).toContain("project-zeus-a");

      // Inaccessible projects MUST NOT be in the list
      expect(listedIds).not.toContain("project-b");
      expect(listedIds).not.toContain("project-zeus-b");
      expect(listedIds).not.toContain("project-secret-b");
      expect(listedIds).not.toContain("project-apollo-b");
    });

    test("C.2: User/model cannot bypass resolver by supplying unauthorized ID alongside authorized name", async () => {
      setupToolInvocation("propose_document", {
        projectId: "project-b",
        projectName: "Project Alpha",
        title: "Bypass Attempt",
        content: "Content",
        type: "requirements",
      });

      const response = await chatService.processGeneralChat("user-a", {
        message: "Propose doc",
      });

      // Must fail closed because projectId: project-b is unauthorized
      expect(response.actions).toBeUndefined();
    });

    test("C.3: Malformed project ID (whitespace or control chars) fails closed without proposing", async () => {
      setupToolInvocation("propose_document", {
        projectId: " project-a ", // Untrimmed/malformed
        title: "Malformed ID Test",
        content: "Content",
        type: "requirements",
      });

      const response = await chatService.processGeneralChat("user-a", {
        message: "Propose doc",
      });

      expect(response.actions).toBeUndefined();
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // D. AUTHORIZED ROLES (OWNER, MEMBER, SYSTEM ADMIN)
  // ──────────────────────────────────────────────────────────────────────────
  describe("D. Authorized Roles Verification", () => {
    test("D.1: Project Owner can resolve by ID and by name", async () => {
      const resById = await authService.resolveProjectForActor("user-a", { projectId: "project-a" });
      expect(resById).toEqual({
        status: "RESOLVED",
        project: { id: "project-a", name: "Project Alpha" },
      });

      const resByName = await authService.resolveProjectForActor("user-a", { projectName: "Project Alpha" });
      expect(resByName).toEqual({
        status: "RESOLVED",
        project: { id: "project-a", name: "Project Alpha" },
      });
    });

    test("D.2: Project Member can resolve shared project by ID and by name", async () => {
      // user-a is member of project-m (owned by user-b)
      const resById = await authService.resolveProjectForActor("user-a", { projectId: "project-m" });
      expect(resById).toEqual({
        status: "RESOLVED",
        project: { id: "project-m", name: "Project Shared Member" },
      });

      const resByName = await authService.resolveProjectForActor("user-a", { projectName: "Project Shared Member" });
      expect(resByName).toEqual({
        status: "RESOLVED",
        project: { id: "project-m", name: "Project Shared Member" },
      });
    });

    test("D.3: System Admin can resolve any project by ID and by name", async () => {
      // user-admin has role "admin", project-b is owned by user-b
      const resById = await authService.resolveProjectForActor("user-admin", { projectId: "project-b" });
      expect(resById).toEqual({
        status: "RESOLVED",
        project: { id: "project-b", name: "Project Beta" },
      });

      const resByName = await authService.resolveProjectForActor("user-admin", { projectName: "Project Beta" });
      expect(resByName).toEqual({
        status: "RESOLVED",
        project: { id: "project-b", name: "Project Beta" },
      });
    });

    test("D.4: Non-member regular user cannot resolve project-b by ID or name", async () => {
      const resById = await authService.resolveProjectForActor("user-a", { projectId: "project-b" });
      expect(resById).toEqual({ status: "NOT_FOUND" });

      const resByName = await authService.resolveProjectForActor("user-a", { projectName: "Project Beta" });
      expect(resByName).toEqual({ status: "NOT_FOUND" });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // E. SIDE-EFFECT ASSERTIONS
  // ──────────────────────────────────────────────────────────────────────────
  describe("E. Side-Effect Assertions on Denied Resolution", () => {
    test("E.1: Denied project resolution produces no document creation or project context reads", async () => {
      setupToolInvocation("propose_document", {
        projectId: "project-b",
        title: "Malicious Document",
        content: "Malicious Body",
        type: "requirements",
      });

      const response = await chatService.processGeneralChat("user-a", {
        message: "Attempt unauthorized action",
      });

      expect(response.actions).toBeUndefined();
      expect(fixture.mockProjectDocumentCreate).not.toHaveBeenCalled();
      expect(RepositoryContextBuilder.buildProjectContext).not.toHaveBeenCalled();
    });
  });

  describe("F. Project-chat proposal tools", () => {
    test.each(["propose_tasks", "generate_epic"])("%s rejects model-supplied project identities", (name) => {
      const task = { title: "Review access", priority: "high" };
      const base = name === "propose_tasks"
        ? { tasks: [task] }
        : { title: "Access review", description: "Review project access", tasks: [task] };
      const validate = (args: unknown) => (chatService as any).validateProjectToolCall(name, args);

      expect(validate(base).valid).toBe(true);
      expect(validate({ ...base, projectId: "project-b" }).valid).toBe(false);
      expect(validate({ ...base, tasks: [{ ...task, projectId: "project-b" }] }).valid).toBe(false);
      expect(fixture.mockProjectDocumentCreate).not.toHaveBeenCalled();
      expect(RepositoryContextBuilder.buildProjectContext).not.toHaveBeenCalled();
    });
  });
});
