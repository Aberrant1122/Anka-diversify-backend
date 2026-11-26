import express from "express";
import http from "http";
import jwt from "jsonwebtoken";
import { authenticateToken } from "../auth";
import { requireProjectOwner, bindProjectResources, bindTaskChildren, requireProjectTaskBody, bindKanbanResource } from "../project-owner";
import { sessionVersion } from "../../security/session-version";
import { JWT_SECRET } from "../../config/env";
import { prisma } from "../../services/database";

jest.mock("../../services/database", () => ({ prisma: {
  user: { findUnique: jest.fn() }, project: { findFirst: jest.fn() },
  projectTask: { findFirst: jest.fn() }, projectFile: { findFirst: jest.fn() },
  taskComment: { findFirst: jest.fn() }, taskChecklistItem: { findFirst: jest.fn() },
  kanbanTask: { findFirst: jest.fn() }, clarificationQA: { findFirst: jest.fn() },
} }));
const user = { id: "owner", email: "owner@example.test", password: "synthetic-hash", status: "active", role: "developer" };
const token = (extra: object = {}) => jwt.sign({ userId: user.id, sessionVersion: sessionVersion(user), role: "admin", ...extra }, JWT_SECRET);

describe("current user and project owner boundary", () => {
  let server: http.Server;
  let base: string;
  const seen = jest.fn();
  beforeAll(async () => {
    const app = express(); app.use(express.json()); app.use(authenticateToken);
    app.get("/identity", (req, res) => res.json(req.user));
    const router = express.Router();
    router.param("id", requireProjectOwner);
    bindProjectResources(router, { taskId: "projectTask", fileId: "projectFile" });
    router.param("commentId", bindTaskChildren);
    router.get("/:id/tasks/:taskId/comments/:commentId", (req, res) => { seen(); res.json({ ok: true }); });
    router.get("/:id/files/:fileId", (req, res) => { seen(); res.json({ ok: true }); });
    router.post("/:id/tasks", requireProjectTaskBody, (req, res) => { seen(); res.json({ ok: true }); });
    router.post("/:id/upload", bindTaskChildren, (req, res) => { seen(); res.json({ ok: true }); });
    router.post("/:id/clarification", bindKanbanResource, (req, res) => { seen(); res.json({ ok: true }); });
    app.use("/projects", router);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>(r => server.on("listening", r));
    base = "http://127.0.0.1:" + (server.address() as any).port;
  });
  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({ ...user });
    (prisma.project.findFirst as jest.Mock).mockResolvedValue({ id: "p" });
    for (const key of ["projectTask", "projectFile", "taskComment", "taskChecklistItem", "kanbanTask"] as const) (prisma[key].findFirst as jest.Mock).mockResolvedValue({ id: "child" });
  });
  afterAll(() => new Promise<void>(r => server.close(() => r())));
  const call = (path: string, bearer: string | null = token(), body?: unknown) => fetch(base + path, {
    method: body ? "POST" : "GET", headers: { ...(bearer ? { Authorization: "Bearer " + bearer } : {}), "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  it("uses current role rather than an embedded admin claim", async () => {
    const response = await call("/identity");
    expect(await response.json()).toEqual({ userId: "owner", email: user.email, role: "developer" });
  });
  it.each([null, "invalid", jwt.sign({ userId: "owner" }, JWT_SECRET), token({ sessionVersion: "old" })])("rejects missing, invalid and legacy sessions", async bearer => {
    expect((await call("/identity", bearer)).status).toBe(401);
  });
  it.each([null, { ...user, status: "inactive" }, { ...user, password: "reset-password-hash" }])("revokes missing/inactive/password-changed sessions", async record => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(record);
    expect((await call("/identity")).status).toBe(401);
  });
  it("does not grant cross-project access to an admin token", async () => {
    (prisma.project.findFirst as jest.Mock).mockResolvedValue(null);
    expect((await call("/projects/foreign/files/f")).status).toBe(404);
    expect(seen).not.toHaveBeenCalled();
    expect(prisma.project.findFirst).toHaveBeenCalledWith({ where: { id: "foreign", userId: "owner" }, select: { id: true } });
  });
  it.each(["projectFile", "projectTask", "taskComment"] as const)("rejects foreign %s", async model => {
    (prisma[model].findFirst as jest.Mock).mockResolvedValue(null);
    const path = model === "projectFile" ? "/projects/p/files/f" : "/projects/p/tasks/t/comments/c";
    expect((await call(path)).status).toBe(404);
    expect(seen).not.toHaveBeenCalled();
  });
  it("binds nested comments to both project and task", async () => {
    expect((await call("/projects/p/tasks/t/comments/c")).status).toBe(200);
    expect(prisma.taskComment.findFirst).toHaveBeenCalledWith({ where: { id: "c", projectId: "p", taskId: "t" }, select: { id: true } });
  });
  it("checks sprint body task references", async () => {
    (prisma.projectTask.findFirst as jest.Mock).mockResolvedValue(null);
    expect((await call("/projects/p/tasks", token(), { taskId: "foreign" })).status).toBe(404);
    expect(seen).not.toHaveBeenCalled();
  });
  it("rejects cross-project object-store keys", async () => {
    expect((await call("/projects/p/upload", token(), { s3Key: "projects/foreign/object" })).status).toBe(404);
    expect(seen).not.toHaveBeenCalled();
  });
  it("binds Kanban body task references to the board project", async () => {
    expect((await call("/projects/p/clarification", token(), { taskId: "k" })).status).toBe(200);
    expect(prisma.kanbanTask.findFirst).toHaveBeenCalledWith({ where: { id: "k", stage: { board: { projectId: "p" } } }, select: { id: true } });
  });
});
