import { sessionVersion } from "../../security/session-version";
jest.mock("../../services/database", () => ({ prisma: { user: { findUnique: jest.fn(async ({ where }: any) => ({ id: where.id, email: 'fixture@example.test', role: 'developer', status: 'active', password: 'fixture-hash' })) }, phaseArtifact: { findFirst: jest.fn(async () => ({ id: 'artifact' })) }, workflowRun: { findFirst: jest.fn(async () => ({ id: 'run' })) } } }));
import express from "express";
import { AddressInfo } from "net";
import terminalRoutes from "../../routes/terminal-routes";
import jwt from "jsonwebtoken";
import { JWT_SECRET } from "../../config/env";

describe("disabled terminal HTTP boundary", () => {
  const app = express();
  app.use("/projects/:projectId/terminal", terminalRoutes);
  let server: ReturnType<typeof app.listen>;
  let base: string;
  const token = jwt.sign({ userId: "test-owner", sessionVersion: sessionVersion({ id: "test-owner", password: "fixture-hash" }) }, JWT_SECRET);
  beforeAll(() => {
    server = app.listen(0, "127.0.0.1");
    return new Promise<void>((resolve) => server.on("listening", () => {
      base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
      resolve();
    }));
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
  it("rejects unauthenticated access", async () => {
    const response = await fetch(base + "/projects/p/terminal/sessions", { method: "POST" });
    expect(response.status).toBe(401);
  });
  it.each([
    ["POST", "/sessions"], ["GET", "/sessions/s"],
    ["POST", "/sessions/s/command"], ["POST", "/sessions/s/interrupt"],
    ["DELETE", "/sessions/s"],
  ])("rejects authenticated %s %s without opening SSE", async (method, route) => {
    const response = await fetch(base + "/projects/p/terminal" + route, {
      method, headers: { Authorization: "Bearer " + token },
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toMatchObject({ code: "TERMINAL_ISOLATION_REQUIRED" });
  });
});
