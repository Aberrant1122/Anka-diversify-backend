import express from "express";
import http from "http";
import fs from "fs";
import path from "path";
import jwt from "jsonwebtoken";
import { JWT_SECRET } from "../../config/env";
import { authenticateToken } from "../../middleware/auth";
import { errorHandler } from "../../middleware";
import { PlanningAuthorizationService } from "../../services/planning-authorization.service";

const mockDownstream = jest.fn((name: string, _req: express.Request, res: express.Response) =>
  res.status(200).json({ handler: name }));
const mockProjectFindUnique = jest.fn();
const mockUserFindUnique = jest.fn();
const mockMemberFindUnique = jest.fn();
const mockFileFindFirst = jest.fn();

jest.mock("../../config/env", () => ({ JWT_SECRET: "project-access-test-secret" }));
jest.mock("../../services/database", () => ({ prisma: {
  project: { findUnique: mockProjectFindUnique },
  user: { findUnique: mockUserFindUnique },
  projectMember: { findUnique: mockMemberFindUnique },
  projectFile: { findFirst: mockFileFindFirst },
} }));

// The production route registrations remain in the test path. Each controller
// method is a downstream spy, so a denied request reaching any handler fails.
function controllerMock(className: string) {
  return { [className]: class {
    constructor() {
      return new Proxy(this, { get: (_target, key) =>
        (_req: express.Request, res: express.Response) => mockDownstream(String(key), _req, res) });
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

const project = { id: "project-b", userId: "owner" };
function actor(userId: string, role = "member") {
  return `Bearer ${jwt.sign({ userId, role }, JWT_SECRET)}`;
}

type Case = [method: string, path: string, handler: string];
const inventory = fs.readFileSync(path.resolve(__dirname, "../../../docs/CP0_ENDPOINT_AUTHORIZATION_COVERAGE.md"), "utf8");
const httpInventory = inventory.split("## Complete HTTP surface")[1].split("## Project-sensitive coverage reconciliation")[0];
const completeProjectBoundRoutes: Array<[string, string]> = httpInventory.split("\n")
  .map((line) => line.match(/^\| (GET|POST|PUT|PATCH|DELETE) (\/[^| ]+) \|[^|]*\|[^|]*\| YES \|/))
  .filter((match): match is RegExpMatchArray => match !== null)
  .map((match): [string, string] => [match[1], match[2]])
  .filter(([, routePath]) => routePath.startsWith("/api/projects/:id") ||
    routePath.startsWith("/api/projects/:projectId") || routePath.startsWith("/api/ai/projects/:projectId"));
const legacy: Case[] = [
  ["GET", "/api/projects/project-b", "getProjectById"],
  ["POST", "/api/projects/project-b/files/presign", "presignUpload"],
  ["GET", "/api/projects/project-b/files/file-1/download", "getFileDownloadUrl"],
  ["POST", "/api/projects/project-b/tasks", "createTask"],
  ["GET", "/api/projects/project-b/members", "getProjectMembers"],
  ["POST", "/api/projects/project-b/chat", "sendChatMessage"],
  ["GET", "/api/projects/project-b/activities", "getActivities"],
  ["GET", "/api/projects/project-b/documents", "getProjectDocuments"],
  ["GET", "/api/projects/project-b/repo/file", "getRepoFile"],
  ["POST", "/api/projects/project-b/sync-github", "syncGithub"],
  ["POST", "/api/projects/project-b/rules", "createProjectRule"],
  ["POST", "/api/projects/project-b/decisions", "createProjectDecision"],
  ["PUT", "/api/projects/project-b/memory-summary", "saveMemorySummary"],
];
const nested: Case[] = [
  ["GET", "/api/projects/project-b/sprints", "getSprints"],
  ["GET", "/api/projects/project-b/phases", "getPhaseStates"],
  ["GET", "/api/projects/project-b/kanban", "getBoard"],
  ["POST", "/api/projects/project-b/repositories/repo-1/sync", "sync"],
  ["POST", "/api/projects/project-b/terminal/sessions", "createSession"],
  ["POST", "/api/projects/project-b/agent/multi-repo/run", "runMultiRepoAgent"],
];
const ai: Case[] = [
  ["POST", "/api/ai/projects/project-b/chat", "projectChat"],
  ["GET", "/api/ai/projects/project-b/sessions", "getProjectSessions"],
  ["GET", "/api/ai/projects/project-b/context", "getProjectContext"],
  ["GET", "/api/ai/projects/project-b/context-snapshots", "getContextSnapshots"],
  ["GET", "/api/ai/projects/project-b/file-reservations", "getFileReservations"],
  ["GET", "/api/ai/projects/project-b/drift-records", "getDriftRecords"],
  ["GET", "/api/ai/projects/project-b/health", "getProjectHealth"],
  ["GET", "/api/ai/projects/project-b/pull-requests", "listPullRequests"],
  ["POST", "/api/ai/projects/project-b/sprints/generate", "generateSprint"],
  ["POST", "/api/ai/projects/project-b/agent/run", "runAgent"],
  ["POST", "/api/ai/projects/project-b/agent/manifest", "generateManifest"],
  ["POST", "/api/ai/projects/project-b/tasks/suggest-order", "suggestTaskOrder"],
];

describe("project access at production router registrations", () => {
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
    mockProjectFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === project.id ? project : null);
    mockUserFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      ({ role: where.id === "admin" ? "admin" : "member" }));
    mockMemberFindUnique.mockImplementation(async ({ where }: { where: { projectId_userId: { userId: string } } }) =>
      where.projectId_userId.userId === "member" ? { id: "membership" } : null);
    mockFileFindFirst.mockImplementation(async ({ where }: { where: { id: string; projectId: string } }) =>
      where.id === "file-1" && where.projectId === project.id ? { id: "file-1" } : null);
  });

  async function call(method: string, path: string, authorization?: string) {
    const response = await fetch(base + path, { method, headers: authorization ? { authorization } : {} });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }

  test("real policy admits owner, member and system admin while edit and owner checks stay stricter", async () => {
    const policy = new PlanningAuthorizationService({
      project: { findUnique: mockProjectFindUnique }, user: { findUnique: mockUserFindUnique },
      projectMember: { findUnique: mockMemberFindUnique },
    } as unknown as ConstructorParameters<typeof PlanningAuthorizationService>[0]);
    for (const userId of ["owner", "member", "admin"]) {
      await expect(policy.assertCanRead(project.id, userId)).resolves.toMatchObject({ id: project.id });
      expect((await call("GET", "/api/projects/project-b", actor(userId))).status).toBe(200);
    }
    await expect(policy.assertCanEdit(project.id, "admin")).rejects.toMatchObject({ httpStatus: 404 });
    await expect(policy.assertOwner(project.id, "member")).rejects.toMatchObject({ httpStatus: 403 });
  });

  test("outsider and missing project return the same non-disclosing response", async () => {
    const outsider = await call("GET", "/api/projects/project-b", actor("outsider"));
    const missing = await call("GET", "/api/projects/missing", actor("outsider"));
    expect(outsider).toEqual(missing);
    expect(outsider).toMatchObject({ status: 404, body: { error: "PLANNING_PROJECT_NOT_FOUND" } });
    expect(mockDownstream).not.toHaveBeenCalled();
  });

  test("authentication and malformed project IDs reject before policy or handlers", async () => {
    expect((await call("GET", "/api/projects/project-b")).status).toBe(401);
    expect(mockProjectFindUnique).not.toHaveBeenCalled();
    expect((await call("GET", "/api/projects/%20", actor("owner"))).status).toBe(400);
    expect(mockProjectFindUnique).not.toHaveBeenCalled();
    expect(mockDownstream).not.toHaveBeenCalled();
  });

  test.each([...legacy, ...nested, ...ai])("%s %s crosses access boundary before %s", async (method, path, handler) => {
    expect((await call(method, path, actor("outsider"))).status).toBe(404);
    expect(mockDownstream).not.toHaveBeenCalled();
    expect((await call(method, path, actor("owner"))).body).toEqual({ handler });
    expect(mockDownstream).toHaveBeenCalledTimes(1);
  });

  test.each(completeProjectBoundRoutes)("complete inventory: %s %s crosses the project guard", async (method, template) => {
    const routePath = template.replace(/:(?:projectId|id)\b/g, "project-b")
      .replace(/:[A-Za-z][A-Za-z0-9]*/g, "resource-1");
    expect((await call(method, routePath, actor("outsider"))).status).toBe(404);
    expect(mockProjectFindUnique).toHaveBeenCalled();
    expect(mockDownstream).not.toHaveBeenCalled();
  });

  test("denied file presign and download never reach S3 signing handlers", async () => {
    for (const [method, path] of legacy.filter((entry) => /files\/(presign|file-1\/download)/.test(entry[1]))) {
      expect((await call(method, path, actor("outsider"))).status).toBe(404);
    }
    expect(mockDownstream).not.toHaveBeenCalled();
  });
  test("denied project chat and context never reach model or context handlers", async () => {
    for (const path of ["/api/ai/projects/project-b/chat", "/api/ai/projects/project-b/context"]) {
      expect((await call(path.endsWith("chat") ? "POST" : "GET", path, actor("outsider"))).status).toBe(404);
    }
    expect(mockDownstream).not.toHaveBeenCalled();
  });
  test("denied terminal session and repository sync never reach execution handlers", async () => {
    for (const path of ["/api/projects/project-b/terminal/sessions", "/api/projects/project-b/repositories/repo-1/sync"]) {
      expect((await call("POST", path, actor("outsider"))).status).toBe(404);
    }
    expect(mockDownstream).not.toHaveBeenCalled();
  });

  test("static, collection and general AI routes bypass project guard and keep role checks", async () => {
    const routes: Case[] = [
      ["GET", "/api/projects/documents/all", "getAllDocuments"],
      ["POST", "/api/projects/validate-github-token", "validateGitHubToken"],
      ["GET", "/api/projects", "getProjects"],
      ["POST", "/api/projects", "createProject"],
      ["POST", "/api/ai/general/chat", "generalChat"],
      ["POST", "/api/ai/agent/manifest/manifest-1/approve", "approveManifest"],
    ];
    for (const [method, path, handler] of routes) {
      expect((await call(method, path, actor("outsider"))).body).toEqual({ handler });
    }
    expect((await call("GET", "/api/projects/config/s3", actor("outsider"))).status).toBe(403);
    expect((await call("GET", "/api/projects/config/s3", actor("admin", "admin"))).body)
      .toEqual({ handler: "checkS3Config" });
    expect(mockProjectFindUnique).not.toHaveBeenCalled();
  });

  test("unexpected policy errors fail closed through the safe error path", async () => {
    mockProjectFindUnique.mockRejectedValue(new Error("database unavailable"));
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect((await call("GET", "/api/projects/project-b", actor("owner"))).status).toBe(500);
      expect(mockDownstream).not.toHaveBeenCalled();
    } finally { consoleError.mockRestore(); }
  });
});
