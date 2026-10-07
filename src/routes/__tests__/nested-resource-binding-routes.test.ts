import express from "express";
import http from "http";
import jwt from "jsonwebtoken";
import { JWT_SECRET } from "../../config/env";
import { authenticateToken } from "../../middleware/auth";
import { errorHandler } from "../../middleware";

const mockDownstream = jest.fn((_name: string, _req: express.Request, res: express.Response) =>
  res.status(200).json({ ok: true }));
const mockProject = jest.fn();
const mockUser = jest.fn();
const mockMembership = jest.fn();
const mockFile = jest.fn();
const mockSession = jest.fn();
const mockSprint = jest.fn();
const mockTask = jest.fn();
const mockDocument = jest.fn();

jest.mock("../../config/env", () => ({ JWT_SECRET: "nested-binding-test-secret" }));
jest.mock("../../services/database", () => ({ prisma: {
  project: { findUnique: mockProject }, user: { findUnique: mockUser },
  projectMember: { findUnique: mockMembership },
  projectFile: { findFirst: mockFile }, aiChatSession: { findFirst: mockSession },
  sprint: { findFirst: mockSprint }, projectTask: { findFirst: mockTask },
  projectDocument: { findFirst: mockDocument },
} }));

function controllerMock(className: string) {
  return { [className]: class {
    constructor() {
      return new Proxy(this, { get: (_target, key) =>
        (req: express.Request, res: express.Response) => mockDownstream(String(key), req, res) });
    }
  } };
}
jest.mock("../../controllers/project-controller", () => controllerMock("ProjectController"));
jest.mock("../../controllers/ai-controller", () => controllerMock("AiController"));
jest.mock("../../controllers/sprint-controller", () => controllerMock("SprintController"));
jest.mock("../../controllers/phase-controller", () => controllerMock("PhaseController"));
jest.mock("../../controllers/kanban-controller", () => controllerMock("KanbanController"));
jest.mock("../../controllers/project-repository-controller", () => controllerMock("ProjectRepositoryController"));
jest.mock("../../controllers/terminal-controller", () => controllerMock("TerminalController"));

const projectRoutes = require("../project-routes").default;
const aiRoutes = require("../ai-routes").default;
const owner = "both-projects-user";
const auth = `Bearer ${jwt.sign({ userId: owner, role: "member" }, JWT_SECRET)}`;

describe("CP0.2 production route nested resource binding", () => {
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
  afterAll(async () => new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve())));
  beforeEach(() => {
    jest.clearAllMocks();
    mockProject.mockImplementation(async ({ where }: { where: { id: string } }) =>
      ["project-a", "project-b"].includes(where.id) ? { id: where.id, userId: owner } : null);
    mockUser.mockResolvedValue({ role: "member" });
    mockMembership.mockResolvedValue({ id: "member" });
    for (const lookup of [mockFile, mockSession, mockSprint, mockTask, mockDocument]) {
      lookup.mockImplementation(async ({ where }: { where: { id: string; projectId: string; userId?: string } }) =>
        where.id === `${where.projectId}-resource` &&
        (!where.userId || where.userId === owner) ? { id: where.id } : null);
    }
  });

  async function call(method: string, path: string, body?: object) {
    const response = await fetch(base + path, {
      method, headers: { authorization: auth, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }

  const cases: [string, string, string, object | undefined][] = [
    ["GET", "/api/projects/project-a/files/ID/download", "getFileDownloadUrl", undefined],
    ["DELETE", "/api/projects/project-a/files/ID", "deleteFile", undefined],
    ["DELETE", "/api/projects/project-a/documents/ID", "deleteProjectDocument", undefined],
    ["PUT", "/api/projects/project-a/tasks/ID", "updateTask", {}],
    ["GET", "/api/ai/projects/project-a/sessions/ID/messages", "getProjectSessionMessages", undefined],
    ["GET", "/api/ai/projects/project-a/sprints/ID/suggest", "suggestSprintTasks", undefined],
  ];
  test.each(cases)("%s %s binds before %s", async (method, template, handler, body) => {
    const same = await call(method, template.replace("ID", "project-a-resource"), body);
    expect(same.status).toBe(200);
    expect(mockDownstream).toHaveBeenCalledWith(handler, expect.anything(), expect.anything());

    mockDownstream.mockClear();
    const cross = await call(method, template.replace("ID", "project-b-resource"), body);
    const missing = await call(method, template.replace("ID", "missing-resource"), body);
    expect(cross).toEqual(missing);
    expect(cross.status).toBe(404);
    expect(mockDownstream).not.toHaveBeenCalled();
  });

  test("project chat and coding agent reject a B session before context or model handlers", async () => {
    for (const path of ["/api/ai/projects/project-a/chat", "/api/ai/projects/project-a/agent/run", "/api/ai/projects/project-a/agent/stream"]) {
      expect((await call("POST", path, { message: "hello", sessionId: "project-a-resource" })).status).toBe(200);
      mockDownstream.mockClear();
      expect((await call("POST", path, { message: "hello", sessionId: "project-b-resource" })).status).toBe(404);
      expect(mockDownstream).not.toHaveBeenCalled();
    }
  });

  test("sprint task input from B is blocked before sprint mutation", async () => {
    expect((await call("POST", "/api/projects/project-a/sprints/project-a-resource/tasks", { taskId: "project-a-resource" })).status).toBe(200);
    mockDownstream.mockClear();
    expect((await call("POST", "/api/projects/project-a/sprints/project-a-resource/tasks", { taskId: "project-b-resource" })).status).toBe(404);
    expect(mockDownstream).not.toHaveBeenCalled();
  });
});
