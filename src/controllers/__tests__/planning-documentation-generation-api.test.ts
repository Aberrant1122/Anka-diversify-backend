import express from "express";
import http from "http";
import jwt from "jsonwebtoken";
import { WorkflowRun } from "@prisma/client";
import { JWT_SECRET } from "../../config/env";
import { authenticateToken } from "../../middleware/auth";
import { PlanningDomainError } from "../../planning/planning-errors";
import phaseRoutes from "../../routes/phase-routes";
import { PhaseService } from "../../services/phase-service";

jest.mock("../../config/env", () => ({
  JWT_SECRET: "documentation-generation-api-test-secret",
  ENCRYPTION_KEY: "documentation-generation-api-test-key".padEnd(32, "-"),
}));

type Result = Awaited<ReturnType<PhaseService["generateInitialDocumentation"]>>;
function result(httpStatus: 200 | 201 | 202): Result {
  return { httpStatus, reused: httpStatus !== 201, run: { id: "run-1", status: httpStatus === 202 ? "running" : "completed" } as WorkflowRun, artifact: null, readiness: null };
}

describe("Documentation initial-generation HTTP endpoint", () => {
  let server: http.Server;
  let baseUrl: string;
  const token = jwt.sign({ userId: "member-1" }, JWT_SECRET);
  let generationSpy: jest.SpyInstance;
  let legacySpy: jest.SpyInstance;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use("/api/projects/:projectId/phases", authenticateToken, phaseRoutes);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not expose a TCP port.");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(() => {
    generationSpy = jest.spyOn(PhaseService.prototype, "generateInitialDocumentation");
    legacySpy = jest.spyOn(PhaseService.prototype, "runAutomatedPhase");
  });
  afterEach(() => { generationSpy.mockRestore(); legacySpy.mockRestore(); });
  afterAll(async () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

  async function post(body: unknown, options: { authenticated?: boolean; key?: string } = {}) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (options.authenticated !== false) headers.authorization = `Bearer ${token}`;
    if (options.key !== undefined) headers["idempotency-key"] = options.key;
    const response = await fetch(`${baseUrl}/api/projects/project-1/phases/documentation/artifacts/generate`, { method: "POST", headers, body: JSON.stringify(body) });
    return { status: response.status, json: await response.json() as Record<string, unknown> };
  }

  test("requires authentication", async () => {
    expect((await post({}, { authenticated: false, key: "key" })).status).toBe(401);
    expect(generationSpy).not.toHaveBeenCalled();
  });

  test.each([
    ["missing key", {}, undefined], ["empty key", {}, "   "], ["unknown field", { prompt: "no" }, "unknown"],
    ["invalid memory flag", { includeMemory: "yes" }, "memory"],
  ])("rejects %s before service invocation", async (_label, body, key) => {
    const response = await post(body, { key });
    expect(response.status).toBe(422);
    expect(response.json).toMatchObject({ error: "PLANNING_ARTIFACT_INVALID" });
    expect(generationSpy).not.toHaveBeenCalled();
  });

  test.each([[201, false], [200, true], [202, true]] as const)("returns %s generation semantics", async (status, reused) => {
    generationSpy.mockResolvedValueOnce(result(status));
    const response = await post({ includeMemory: true }, { key: `key-${status}` });
    expect(response.status).toBe(status);
    expect(response.json).toMatchObject({ success: true, data: { reused } });
    expect(generationSpy).toHaveBeenCalledWith(expect.objectContaining({ includeMemory: true, idempotencyKey: `key-${status}` }));
    expect(legacySpy).not.toHaveBeenCalled();
  });

  test("preserves safe planning errors", async () => {
    generationSpy.mockRejectedValueOnce(new PlanningDomainError("PLANNING_IDEMPOTENCY_CONFLICT", "Key was reused.", 409));
    const response = await post({}, { key: "conflict" });
    expect(response).toMatchObject({ status: 409, json: { error: "PLANNING_IDEMPOTENCY_CONFLICT", message: "Key was reused." } });
  });
});
