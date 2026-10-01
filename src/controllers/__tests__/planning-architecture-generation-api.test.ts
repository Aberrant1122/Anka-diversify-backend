import express from "express";
import http from "http";
import jwt from "jsonwebtoken";
import { JWT_SECRET } from "../../config/env";
import { authenticateToken } from "../../middleware/auth";
import phaseRoutes from "../../routes/phase-routes";
import { PhaseService } from "../../services/phase-service";

jest.mock("../../config/env", () => ({ JWT_SECRET: "architecture-generation-api-secret",
  ENCRYPTION_KEY: "architecture-generation-api-key".padEnd(32, "-") }));

describe("Architecture generation API", () => {
  let server: http.Server;
  let baseUrl: string;
  const token = jwt.sign({ userId: "editor-1" }, JWT_SECRET);
  beforeAll(async () => {
    const app = express(); app.use(express.json());
    app.use("/api/projects/:projectId/phases", authenticateToken, phaseRoutes);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("No test port");
    baseUrl = `http://127.0.0.1:${address.port}/api/projects/project-1/phases`;
  });
  afterAll(async () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  async function call(method: "POST" | "GET", path: string, body?: unknown, key?: string, auth = true) {
    const response = await fetch(`${baseUrl}${path}`, { method,
      headers: { ...(auth ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(key ? { "Idempotency-Key": key } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, json: await response.json() as Record<string, unknown> };
  }
  test("requires authentication, key and strict Boolean-only body", async () => {
    const spy = jest.spyOn(PhaseService.prototype, "generateInitialArchitecture").mockResolvedValue({
      run: {} as never, artifact: null, readiness: null, reused: true, httpStatus: 202,
    });
    try {
      expect((await call("POST", "/architecture/artifacts/generate", {}, "key", false)).status).toBe(401);
      expect((await call("POST", "/architecture/artifacts/generate", {})).status).toBe(422);
      expect((await call("POST", "/architecture/artifacts/generate", { includeMemory: "true" }, "key")).status).toBe(422);
      expect((await call("POST", "/architecture/artifacts/generate", { sourceRequirements: "forged" }, "key")).status).toBe(422);
      expect(spy).not.toHaveBeenCalled();
      const accepted = await call("POST", "/architecture/artifacts/generate", { includeMemory: true }, "key");
      expect(accepted.status).toBe(202);
      expect(spy).toHaveBeenCalledWith({ projectId: "project-1", actorId: "editor-1",
        idempotencyKey: "key", includeMemory: true });
    } finally { spy.mockRestore(); }
  });

  test("run lookup is project-scoped through service", async () => {
    const spy = jest.spyOn(PhaseService.prototype, "getArchitectureRun").mockResolvedValue({ id: "run-1" } as never);
    try {
      const response = await call("GET", "/architecture/runs/run-1");
      expect(response).toMatchObject({ status: 200, json: { success: true, data: { id: "run-1" } } });
      expect(spy).toHaveBeenCalledWith("project-1", "run-1", "editor-1");
    } finally { spy.mockRestore(); }
  });
});
