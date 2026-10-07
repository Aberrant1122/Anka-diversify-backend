import express from "express";
import http from "http";
import jwt from "jsonwebtoken";
import { JWT_SECRET } from "../../config/env";
import { authenticateToken } from "../../middleware/auth";
import { errorHandler } from "../../middleware";
import { TerminalSessionManager } from "../../services/terminal-session-manager";
import { ProjectGitHubService } from "../../services/github.service";
import { GitWorktreeService } from "../../services/git-worktree.service";

jest.mock("../../config/env", () => ({ JWT_SECRET: "residual-audit-test-secret" }));

const mockProjectFindUnique = jest.fn();
const mockUserFindUnique = jest.fn();
const mockProjectMemberFindUnique = jest.fn();
const mockAgentManifestFindUnique = jest.fn();
const mockAgentManifestUpdate = jest.fn();
const mockAgentManifestFindFirst = jest.fn();
const mockTaskDecompositionFindFirst = jest.fn();
const mockAiChatSessionFindFirst = jest.fn();
const mockProjectRepositoryFindFirst = jest.fn();
const mockProjectRepositoryFindMany = jest.fn();
const mockKanbanTaskFindFirst = jest.fn();
const mockKanbanTaskUpdate = jest.fn();

const mockProjectRuleFindFirst = jest.fn();
const mockProjectRuleFindUnique = jest.fn();
const mockProjectRuleUpdate = jest.fn();
const mockProjectRuleDelete = jest.fn();

const mockProjectDecisionFindFirst = jest.fn();
const mockProjectDecisionFindUnique = jest.fn();
const mockProjectDecisionUpdate = jest.fn();
const mockProjectDecisionDelete = jest.fn();

const mockPhaseArtifactFindUnique = jest.fn();
const mockPhaseArtifactFindFirst = jest.fn();
const mockPhaseArtifactFindMany = jest.fn();

const mockProjectPhaseStateFindUnique = jest.fn();
const mockProjectPhaseStateFindMany = jest.fn();

const mockWorkflowRunFindFirst = jest.fn();
const mockWorkflowRunFindMany = jest.fn();

const mockPrisma = {
  $transaction: jest.fn().mockImplementation(async (callback: any) => callback(mockPrisma)),
  project: { findUnique: (...args: any[]) => mockProjectFindUnique(...args) },
  user: { findUnique: (...args: any[]) => mockUserFindUnique(...args) },
  projectMember: { findUnique: (...args: any[]) => mockProjectMemberFindUnique(...args) },
  agentManifest: {
    findUnique: (...args: any[]) => mockAgentManifestFindUnique(...args),
    update: (...args: any[]) => mockAgentManifestUpdate(...args),
    findFirst: (...args: any[]) => mockAgentManifestFindFirst(...args),
  },
  taskDecomposition: {
    findFirst: (...args: any[]) => mockTaskDecompositionFindFirst(...args),
  },
  aiChatSession: {
    findFirst: (...args: any[]) => mockAiChatSessionFindFirst(...args),
  },
  projectRepository: {
    findFirst: (...args: any[]) => mockProjectRepositoryFindFirst(...args),
    findMany: (...args: any[]) => mockProjectRepositoryFindMany(...args),
  },
  kanbanTask: {
    findFirst: (...args: any[]) => mockKanbanTaskFindFirst(...args),
    update: (...args: any[]) => mockKanbanTaskUpdate(...args),
  },
  projectRule: {
    findFirst: (...args: any[]) => mockProjectRuleFindFirst(...args),
    findUnique: (...args: any[]) => mockProjectRuleFindUnique(...args),
    update: (...args: any[]) => mockProjectRuleUpdate(...args),
    delete: (...args: any[]) => mockProjectRuleDelete(...args),
  },
  projectDecision: {
    findFirst: (...args: any[]) => mockProjectDecisionFindFirst(...args),
    findUnique: (...args: any[]) => mockProjectDecisionFindUnique(...args),
    update: (...args: any[]) => mockProjectDecisionUpdate(...args),
    delete: (...args: any[]) => mockProjectDecisionDelete(...args),
  },
  phaseArtifact: {
    findFirst: (...args: any[]) => mockPhaseArtifactFindFirst(...args),
    findUnique: (...args: any[]) => mockPhaseArtifactFindUnique(...args),
    findMany: (...args: any[]) => mockPhaseArtifactFindMany(...args),
  },
  projectPhaseState: {
    findUnique: (...args: any[]) => mockProjectPhaseStateFindUnique(...args),
    findMany: (...args: any[]) => mockProjectPhaseStateFindMany(...args),
  },
  workflowRun: {
    findFirst: (...args: any[]) => mockWorkflowRunFindFirst(...args),
    findMany: (...args: any[]) => mockWorkflowRunFindMany(...args),
  },
};

(global as any).__mockPrisma = mockPrisma;
jest.mock("../../services/database", () => ({ prisma: mockPrisma }));
jest.mock("@prisma/client", () => {
  const actual = jest.requireActual("@prisma/client");
  return {
    ...actual,
    PrismaClient: jest.fn().mockImplementation(() => new Proxy({}, {
      get(_target: any, prop: string) {
        return (global as any).__mockPrisma?.[prop] || {};
      },
    })),
  };
});

// Mock GitHub sync service to prevent outbound calls
jest.spyOn(ProjectGitHubService, "buildRepositoryContext").mockResolvedValue(undefined as any);

const projectRoutes = require("../project-routes").default;
const aiRoutes = require("../ai-routes").default;

const userA = "user-a";
const userB = "user-b";
const dualUser = "dual-user";

const tokenA = `Bearer ${jwt.sign({ userId: userA, role: "member" }, JWT_SECRET)}`;
const tokenB = `Bearer ${jwt.sign({ userId: userB, role: "member" }, JWT_SECRET)}`;
const tokenDual = `Bearer ${jwt.sign({ userId: dualUser, role: "member" }, JWT_SECRET)}`;

describe("CP0.4 residual authorization inventory and adversarial audit", () => {
  let server: http.Server;
  let base: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use("/api/projects", authenticateToken, projectRoutes);
    app.use("/api/ai", authenticateToken, aiRoutes);
    app.use(errorHandler);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test port");
    base = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    TerminalSessionManager.resetInstance();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  beforeEach(() => {
    jest.clearAllMocks();

    mockProjectFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
      if (where.id === "project-a") return { id: "project-a", userId: userA, name: "Project A", currentPhase: "requirements" };
      if (where.id === "project-b") return { id: "project-b", userId: userB, name: "Project B", currentPhase: "requirements" };
      return null;
    });

    mockUserFindUnique.mockResolvedValue({ role: "member" });

    mockProjectMemberFindUnique.mockImplementation(
      async ({ where }: { where: { projectId_userId: { projectId: string; userId: string } } }) => {
        if (where.projectId_userId.userId === dualUser) {
          return { id: "membership-dual", projectId: where.projectId_userId.projectId, userId: dualUser };
        }
        return null;
      },
    );

    mockAgentManifestFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
      if (where.id === "manifest-a") {
        return {
          id: "manifest-a",
          projectId: "project-a",
          sessionId: "session-a",
          validationStatus: "pending",
        };
      }
      if (where.id === "manifest-b") {
        return {
          id: "manifest-b",
          projectId: "project-b",
          sessionId: "session-b",
          validationStatus: "pending",
        };
      }
      return null;
    });

    mockAgentManifestUpdate.mockImplementation(async ({ where, data }: { where: { id: string }; data: any }) => ({
      id: where.id,
      ...data,
    }));

    mockTaskDecompositionFindFirst.mockImplementation(async ({ where, select, include }: {
      where: { sessionId?: string; id?: string; projectId?: string };
      select?: { id: boolean; projectId: boolean };
      include?: { subTasksExecs: boolean };
    }) => {
      const projectId = where.sessionId === "session-a" || where.id === "decomp-a"
        ? "project-a"
        : where.sessionId === "session-b" || where.id === "decomp-b" ? "project-b" : undefined;
      if (!projectId || (where.projectId && where.projectId !== projectId)) return null;
      const id = projectId === "project-a" ? "decomp-a" : "decomp-b";
      if (select) return { id, projectId };
      if (include?.subTasksExecs) {
        return { id, projectId, sessionId: projectId === "project-a" ? "session-a" : "session-b",
          userRequest: `Decomposed task for ${projectId === "project-a" ? "A" : "B"}`, subTasksExecs: [] };
      }
      return null;
    });

    mockAiChatSessionFindFirst.mockImplementation(
      async ({ where }: { where: { id: string; projectId: string; userId: string } }) => {
        if (where.id === "session-a" && where.projectId === "project-a") {
          return { id: "session-a", projectId: "project-a", userId: where.userId };
        }
        if (where.id === "session-b" && where.projectId === "project-b") {
          return { id: "session-b", projectId: "project-b", userId: where.userId };
        }
        return null;
      },
    );

    mockAgentManifestFindFirst.mockImplementation(
      async ({ where }: { where: { projectId: string; sessionId?: string } }) => {
        if (where.projectId === "project-a") {
          return { id: "manifest-a", projectId: "project-a", sessionId: where.sessionId || "session-a" };
        }
        return null;
      },
    );

    mockProjectRepositoryFindFirst.mockImplementation(
      async ({ where }: { where: { id: string; projectId: string } }) => {
        if (where.id === "repo-a" && where.projectId === "project-a") {
          return { id: "repo-a", projectId: "project-a", githubUrl: "https://github.com/a/a", isPrimary: false };
        }
        if (where.id === "repo-b" && where.projectId === "project-b") {
          return { id: "repo-b", projectId: "project-b", githubUrl: "https://github.com/b/b", isPrimary: false };
        }
        return null;
      },
    );

    mockKanbanTaskFindFirst.mockImplementation(
      async ({ where }: { where: { id: string; stage?: { board?: { projectId?: string } } } }) => {
        const pId = where.stage?.board?.projectId;
        if (where.id === "task-a" && pId === "project-a") {
          return { id: "task-a", implementationEligible: false, status: "todo" };
        }
        if (where.id === "task-b" && pId === "project-b") {
          return { id: "task-b", implementationEligible: false, status: "todo" };
        }
        return null;
      },
    );

    mockKanbanTaskUpdate.mockImplementation(async ({ where, data }: { where: { id: string }; data: any }) => ({
      id: where.id,
      ...data,
    }));

    mockProjectRuleFindFirst.mockImplementation(async ({ where }: { where: { id: string; projectId: string } }) => {
      if (where.id === "rule-a" && where.projectId === "project-a") {
        return { id: "rule-a", projectId: "project-a", title: "Rule A" };
      }
      if (where.id === "rule-b" && where.projectId === "project-b") {
        return { id: "rule-b", projectId: "project-b", title: "Rule B" };
      }
      return null;
    });

    mockProjectRuleFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
      if (where.id === "rule-a") return { id: "rule-a", projectId: "project-a", title: "Rule A" };
      if (where.id === "rule-b") return { id: "rule-b", projectId: "project-b", title: "Rule B" };
      return null;
    });

    mockProjectRuleUpdate.mockImplementation(async ({ where, data }: { where: { id: string }; data: any }) => ({
      id: where.id,
      projectId: "project-a",
      ...data,
    }));

    mockProjectRuleDelete.mockResolvedValue(true);

    mockProjectDecisionFindFirst.mockImplementation(async ({ where }: { where: { id: string; projectId: string } }) => {
      if (where.id === "decision-a" && where.projectId === "project-a") {
        return { id: "decision-a", projectId: "project-a", title: "Decision A" };
      }
      if (where.id === "decision-b" && where.projectId === "project-b") {
        return { id: "decision-b", projectId: "project-b", title: "Decision B" };
      }
      return null;
    });

    mockProjectDecisionFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
      if (where.id === "decision-a") return { id: "decision-a", projectId: "project-a", title: "Decision A" };
      if (where.id === "decision-b") return { id: "decision-b", projectId: "project-b", title: "Decision B" };
      return null;
    });

    mockProjectDecisionUpdate.mockImplementation(async ({ where, data }: { where: { id: string }; data: any }) => ({
      id: where.id,
      projectId: "project-a",
      ...data,
    }));

    mockProjectDecisionDelete.mockResolvedValue(true);

    mockPhaseArtifactFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
      if (where.id === "artifact-a") {
        return {
          id: "artifact-a",
          projectId: "project-a",
          phase: "requirements",
          type: "requirements_doc",
          version: 1,
          title: "Requirements A",
          content: "# Requirements A",
          structuredContent: { problemStatement: "Test" },
          schemaVersion: "1.0",
          contentHash: "hash-a",
          lifecycleStatus: "DRAFT",
          approved: false,
        };
      }
      if (where.id === "artifact-b") {
        return {
          id: "artifact-b",
          projectId: "project-b",
          phase: "requirements",
          type: "requirements_doc",
          version: 1,
          title: "Requirements B",
          content: "# Requirements B",
          structuredContent: { problemStatement: "Test B" },
          schemaVersion: "1.0",
          contentHash: "hash-b",
          lifecycleStatus: "DRAFT",
          approved: false,
        };
      }
      return null;
    });

    mockWorkflowRunFindFirst.mockImplementation(async ({ where }: { where: { id: string; projectId: string } }) => {
      if (where.id === "run-a" && where.projectId === "project-a") {
        return { id: "run-a", projectId: "project-a", currentPhase: "requirements", status: "completed" };
      }
      if (where.id === "run-b" && where.projectId === "project-b") {
        return { id: "run-b", projectId: "project-b", currentPhase: "requirements", status: "completed" };
      }
      return null;
    });

    mockProjectPhaseStateFindUnique.mockImplementation(async ({ where }: { where: { projectId_phase?: { projectId: string; phase: string } } }) => {
      if (where.projectId_phase?.projectId === "project-a") {
        return {
          id: "state-a",
          projectId: "project-a",
          phase: "requirements",
          status: "in_progress",
          stateVersion: 1,
          currentArtifactId: "artifact-a",
        };
      }
      return null;
    });
  });

  async function call(method: string, path: string, auth: string, body?: object) {
    const res = await fetch(base + path, {
      method,
      headers: {
        authorization: auth,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return {
      status: res.status,
      body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
    };
  }

  describe("Agent Manifest Approval & Rejection Residual Authorization & Non-Disclosure", () => {
    test("authorized owner of project A can approve manifest A", async () => {
      const res = await call("POST", "/api/ai/agent/manifest/manifest-a/approve", tokenA);
      expect(res.status).toBe(200);
      expect(mockAgentManifestUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "manifest-a" },
          data: expect.objectContaining({ validationStatus: "approved" }),
        }),
      );
    });

    test("authenticated outsider user B and nonexistent manifest produce identical non-disclosing 404 on approve", async () => {
      const outsider = await call("POST", "/api/ai/agent/manifest/manifest-a/approve", tokenB);
      const missing = await call("POST", "/api/ai/agent/manifest/non-existent/approve", tokenB);
      expect(outsider.status).toBe(404);
      expect(outsider).toEqual(missing);
      expect(outsider.body).toEqual({ error: "Manifest not found" });
      expect(mockAgentManifestUpdate).not.toHaveBeenCalled();
    });

    test("authorized owner of project A can reject manifest A", async () => {
      const res = await call("POST", "/api/ai/agent/manifest/manifest-a/reject", tokenA);
      expect(res.status).toBe(200);
      expect(mockAgentManifestUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "manifest-a" },
          data: expect.objectContaining({ validationStatus: "rejected" }),
        }),
      );
    });

    test("authenticated outsider user B and nonexistent manifest produce identical non-disclosing 404 on reject", async () => {
      const outsider = await call("POST", "/api/ai/agent/manifest/manifest-a/reject", tokenB);
      const missing = await call("POST", "/api/ai/agent/manifest/non-existent/reject", tokenB);
      expect(outsider.status).toBe(404);
      expect(outsider).toEqual(missing);
      expect(outsider.body).toEqual({ error: "Manifest not found" });
      expect(mockAgentManifestUpdate).not.toHaveBeenCalled();
    });
  });

  describe("Task Decomposition Residual Authorization & Non-Disclosure", () => {
    test("authorized user A can get task decomposition for project A session", async () => {
      const res = await call("GET", "/api/ai/agent/decomposition/session-a", tokenA);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        success: true,
        data: expect.objectContaining({ id: "decomp-a", projectId: "project-a" }),
      });
      expect(mockTaskDecompositionFindFirst).toHaveBeenNthCalledWith(1, {
        where: { sessionId: "session-a" }, select: { id: true, projectId: true },
        orderBy: { createdAt: "desc" },
      });
      expect(mockTaskDecompositionFindFirst).toHaveBeenNthCalledWith(2, {
        where: { id: "decomp-a", projectId: "project-a" }, include: { subTasksExecs: true },
      });
    });

    test("authenticated outsider user B and nonexistent session produce identical non-disclosing 200 null response", async () => {
      const outsider = await call("GET", "/api/ai/agent/decomposition/session-a", tokenB);
      const missing = await call("GET", "/api/ai/agent/decomposition/non-existent", tokenB);
      expect(outsider.status).toBe(200);
      expect(outsider).toEqual(missing);
      expect(outsider.body).toEqual({ success: true, data: null });
      expect(mockTaskDecompositionFindFirst).toHaveBeenCalledTimes(2);
      expect(mockTaskDecompositionFindFirst.mock.calls.every(([query]) =>
        query.select?.id === true && query.select?.projectId === true && query.include === undefined,
      )).toBe(true);
    });
  });

  describe("Agent Manifest Generation Route Binding", () => {
    test("authorized user A with project A session generates manifest", async () => {
      const res = await call("POST", "/api/ai/projects/project-a/agent/manifest", tokenA, {
        sessionId: "session-a",
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true });
    });

    test("dual user cannot substitute project B session into project A manifest generation", async () => {
      const res = await call("POST", "/api/ai/projects/project-a/agent/manifest", tokenDual, {
        sessionId: "session-b",
      });
      expect(res.status).toBe(404);
      expect(mockAgentManifestFindFirst).not.toHaveBeenCalled();
    });

    test("outsider user B cannot call manifest generation on project A", async () => {
      const res = await call("POST", "/api/ai/projects/project-a/agent/manifest", tokenB, {
        sessionId: "session-a",
      });
      expect(res.status).toBe(404);
      expect(mockAgentManifestFindFirst).not.toHaveBeenCalled();
    });
  });

  describe("Rule & Decision Nested Resource Binding (Cross-Project Substitution Resistance)", () => {
    test("dual user cannot update Project B rule under Project A route", async () => {
      const res = await call("PUT", "/api/projects/project-a/rules/rule-b", tokenDual, {
        title: "Malicious update",
      });
      expect(res.status).toBe(404);
      expect(mockProjectRuleUpdate).not.toHaveBeenCalled();
    });

    test("dual user cannot delete Project B rule under Project A route", async () => {
      const res = await call("DELETE", "/api/projects/project-a/rules/rule-b", tokenDual);
      expect(res.status).toBe(404);
      expect(mockProjectRuleDelete).not.toHaveBeenCalled();
    });

    test("dual user cannot update Project B decision under Project A route", async () => {
      const res = await call("PUT", "/api/projects/project-a/decisions/decision-b", tokenDual, {
        title: "Malicious update",
      });
      expect(res.status).toBe(404);
      expect(mockProjectDecisionUpdate).not.toHaveBeenCalled();
    });

    test("dual user cannot delete Project B decision under Project A route", async () => {
      const res = await call("DELETE", "/api/projects/project-a/decisions/decision-b", tokenDual);
      expect(res.status).toBe(404);
      expect(mockProjectDecisionDelete).not.toHaveBeenCalled();
    });

    test("dual user with Project A rule succeeds on Project A route", async () => {
      const resPut = await call("PUT", "/api/projects/project-a/rules/rule-a", tokenDual, {
        title: "Legitimate update",
      });
      expect(resPut.status).toBe(200);
      expect(mockProjectRuleUpdate).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: "rule-a" },
        data: expect.objectContaining({ title: "Legitimate update" }),
      }));

      const resDel = await call("DELETE", "/api/projects/project-a/rules/rule-a", tokenDual);
      expect(resDel.status).toBe(200);
      expect(mockProjectRuleDelete).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "rule-a" } }));
    });

    test("dual user with Project A decision succeeds on Project A route", async () => {
      const resPut = await call("PUT", "/api/projects/project-a/decisions/decision-a", tokenDual, {
        title: "Legitimate decision update",
      });
      expect(resPut.status).toBe(200);
      expect(mockProjectDecisionUpdate).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: "decision-a" },
        data: expect.objectContaining({ title: "Legitimate decision update" }),
      }));

      const resDel = await call("DELETE", "/api/projects/project-a/decisions/decision-a", tokenDual);
      expect(resDel.status).toBe(200);
      expect(mockProjectDecisionDelete).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "decision-a" } }));
    });
  });

  describe("Phase Routes Nested Resource Binding (Cross-Project Substitution Resistance)", () => {
    test("dual user cannot read Project B artifact under Project A phase route", async () => {
      const res = await call("GET", "/api/projects/project-a/phases/artifacts/artifact-b", tokenDual);
      expect(res.status).toBe(404);
    });

    test("dual user cannot read Project B workflow run under Project A phase route", async () => {
      const res = await call("GET", "/api/projects/project-a/phases/runs/run-b", tokenDual);
      expect(res.status).toBe(404);
    });

    test("dual user cannot submit Project B artifact for approval under Project A phase route", async () => {
      const res = await call("POST", "/api/projects/project-a/phases/requirements/request-approval", tokenDual, {
        artifactId: "artifact-b",
        expectedHash: "hash-b",
      });
      expect(res.status).toBe(404);
    });

    test("dual user can read Project A artifact under Project A phase route", async () => {
      const res = await call("GET", "/api/projects/project-a/phases/artifacts/artifact-a", tokenDual);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true, data: expect.objectContaining({ id: "artifact-a" }) });
    });
  });

  describe("Cross-Project Substitution Resistance on Nested Resource Endpoints", () => {
    test("dual user cannot sync Project B repository under Project A route", async () => {
      const res = await call("POST", "/api/projects/project-a/repositories/repo-b/sync", tokenDual);
      expect(res.status).toBe(404);
      expect(ProjectGitHubService.buildRepositoryContext).not.toHaveBeenCalled();
    });

    test("dual user cannot update Project B kanban task status under Project A route", async () => {
      const res = await call("PATCH", "/api/projects/project-a/kanban/tasks/task-b/status", tokenDual, {
        status: "in_progress",
      });
      expect(res.status).toBe(404);
      expect(mockKanbanTaskUpdate).not.toHaveBeenCalled();
    });

    test("dual user cannot access Project B terminal session under Project A route", async () => {
      // Create session directly under Project B in manager
      const manager = TerminalSessionManager.getInstance();
      (manager as any).sessions.set("session-tb", {
        sessionId: "session-tb",
        projectId: "project-b",
        repositoryId: "repo-b",
        repositoryName: "repo-b",
        rootPath: "/fake/b",
        cwd: "/fake/b",
        env: {},
        activeProcess: null,
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        status: "idle",
      });

      const run = jest.spyOn(manager, "runCommand");
      const interrupt = jest.spyOn(manager, "interruptSession");
      const close = jest.spyOn(manager, "closeSession");
      try {
        for (const [method, suffix, body] of [
          ["GET", "", undefined],
          ["POST", "/command", { command: "echo forbidden" }],
          ["POST", "/interrupt", undefined],
          ["DELETE", "", undefined],
        ] as const) {
          const response = await call(method, `/api/projects/project-a/terminal/sessions/session-tb${suffix}`, tokenDual, body);
          expect(response.status).toBe(404);
        }
        expect(run).not.toHaveBeenCalled();
        expect(interrupt).not.toHaveBeenCalled();
        expect(close).not.toHaveBeenCalled();
      } finally {
        run.mockRestore();
        interrupt.mockRestore();
        close.mockRestore();
      }
    });

    test("terminal creation cannot select a Project B repository through Project A", async () => {
      mockProjectRepositoryFindFirst.mockResolvedValue(null);
      mockProjectRepositoryFindMany.mockImplementation(async ({ where }: { where: { projectId: string } }) => {
        if (where.projectId !== "project-a") throw new Error("Unexpected repository project scope");
        return [{ id: "repo-a", projectId: "project-a", name: "Repo A", localPath: "/fake/a", isPrimary: true }];
      });
      const manager = TerminalSessionManager.getInstance();
      const before = (manager as any).sessions.size;
      const response = await call("POST", "/api/projects/project-a/terminal/sessions", tokenDual,
        { repositoryId: "repo-b" });
      expect(response.status).toBe(400);
      expect(mockProjectRepositoryFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { projectId: "project-a" } }));
      expect((manager as any).sessions.size).toBe(before);
    });

    test("agent push rejects Project B approval through Project A before Git shipping", async () => {
      const implementationPreflight = require("../../planning/implementation-authority-preflight") as typeof import("../../planning/implementation-authority-preflight");
      const preflight = jest.spyOn(implementationPreflight, "currentImplementationAuthority")
        .mockResolvedValue({ fingerprint: "fixture" } as Awaited<ReturnType<typeof implementationPreflight.currentImplementationAuthority>>);
      const approvalId = "foreign-route-approval";
      const pending = (GitWorktreeService as any).pendingShippingApprovals as Map<string, unknown>;
      pending.set(approvalId, { userId: dualUser, projectId: "project-b", repositoryId: "repo-b", state: "AVAILABLE",
        approval: { approvalId, expiresAt: new Date(Date.now() + 60_000).toISOString() } });
      const ship = jest.spyOn(GitWorktreeService, "shipApprovedRun");
      try {
        const response = await call("POST", "/api/ai/projects/project-a/agent/push", tokenDual,
          { approvalId, commitMessage: "Do not ship", changes: [{ path: "src/a.ts", content: "safe" }] });
        expect(response.status).toBe(404);
        expect(ship).not.toHaveBeenCalled();
      } finally {
        pending.delete(approvalId);
        ship.mockRestore();
        preflight.mockRestore();
      }
    });
  });
});
