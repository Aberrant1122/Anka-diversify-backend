import express from "express";
import http from "http";
import jwt from "jsonwebtoken";
import { PhaseArtifact } from "@prisma/client";
import { JWT_SECRET } from "../../config/env";
import { authenticateToken } from "../../middleware/auth";
import phaseRoutes from "../../routes/phase-routes";
import { PhaseService } from "../../services/phase-service";

jest.mock("../../config/env", () => ({ JWT_SECRET: "architecture-api-test-secret", ENCRYPTION_KEY: "architecture-api-test-key".padEnd(32, "-") }));

describe("Architecture human HTTP routes", () => {
  let server: http.Server;
  let baseUrl: string;
  const token = jwt.sign({ userId: "editor-1" }, JWT_SECRET);
  const artifact = { id: "architecture-1", contentHash: "a".repeat(64) } as PhaseArtifact;
  const spies: jest.SpyInstance[] = [];
  beforeAll(async () => {
    const app = express(); app.use(express.json()); app.use("/api/projects/:projectId/phases", authenticateToken, phaseRoutes);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("No test port");
    baseUrl = `http://127.0.0.1:${address.port}/api/projects/project-1/phases`;
  });
  beforeEach(() => {
    spies.push(jest.spyOn(PhaseService.prototype, "createArchitectureArtifact").mockResolvedValue(artifact));
    spies.push(jest.spyOn(PhaseService.prototype, "getArchitectureReadiness").mockResolvedValue({ ready: true, artifactId: artifact.id, contentHash: artifact.contentHash!, blockers: [], warnings: [] }));
  });
  afterEach(() => { spies.splice(0).forEach((spy) => spy.mockRestore()); });
  afterAll(async () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  async function call(path: string, method = "POST", body?: unknown) {
    const response = await fetch(`${baseUrl}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, json: await response.json() as Record<string, unknown> };
  }
  test("creates initial and successor drafts with server-selected project and base", async () => {
    const first = await call("/architecture/artifacts", "POST", { title: "Architecture", structuredContent: { overview: {} } });
    expect(first.status).toBe(201);
    expect(spies[0]).toHaveBeenCalledWith(expect.objectContaining({ projectId: "project-1", actorId: "editor-1", title: "Architecture" }));
    const second = await call("/architecture/artifacts/architecture-1/revisions", "POST", { title: "Architecture v2", structuredContent: { overview: {} }, baseContentHash: artifact.contentHash });
    expect(second.status).toBe(201);
    expect(spies[0]).toHaveBeenCalledWith(expect.objectContaining({ baseArtifactId: "architecture-1", baseContentHash: artifact.contentHash }));
  });
  test("rejects forged provenance and status fields before service call", async () => {
    const response = await call("/architecture/artifacts", "POST", { title: "Forged", structuredContent: {}, approved: true });
    expect(response).toMatchObject({ status: 422, json: { error: "PLANNING_ARTIFACT_INVALID" } });
    expect(spies[0]).not.toHaveBeenCalled();
  });
  test("readiness route returns deterministic result", async () => {
    const response = await call("/architecture/artifacts/architecture-1/readiness", "GET");
    expect(response).toMatchObject({ status: 200, json: { success: true, data: { ready: true } } });
    expect(spies[1]).toHaveBeenCalledWith("project-1", "architecture-1", "editor-1", undefined);
  });
  test("Architecture approval body rejects unknown fields", async () => {
    const spy = jest.spyOn(PhaseService.prototype, "requestApproval").mockResolvedValue({} as any);
    try {
      const response = await call("/architecture/request-approval", "POST", { artifactId: artifact.id, expectedHash: artifact.contentHash, sourceDocumentation: "forged" });
      expect(response.status).toBe(422);
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });
});
