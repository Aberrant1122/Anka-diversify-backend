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
  JWT_SECRET: "requirements-generation-api-test-secret",
  ENCRYPTION_KEY: "requirements-generation-api-test-key".padEnd(32, "-"),
}));

type GenerationResult = Awaited<ReturnType<PhaseService["generateInitialRequirements"]>>;

function result(httpStatus: 200 | 201 | 202): GenerationResult {
  return {
    httpStatus,
    reused: httpStatus !== 201,
    run: { id: "run-1", status: httpStatus === 202 ? "running" : "completed" } as WorkflowRun,
    artifact: null,
    readiness: null,
  };
}

describe("Requirements initial-generation HTTP endpoint", () => {
  let server: http.Server;
  let baseUrl: string;
  const token = jwt.sign({ userId: "member-1" }, JWT_SECRET);
  let generationSpy: jest.SpyInstance;
  let legacyRunSpy: jest.SpyInstance;

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
    generationSpy = jest.spyOn(PhaseService.prototype, "generateInitialRequirements");
    legacyRunSpy = jest.spyOn(PhaseService.prototype, "runAutomatedPhase");
  });

  afterEach(() => {
    generationSpy.mockRestore();
    legacyRunSpy.mockRestore();
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  async function post(
    body: unknown,
    options: { authenticated?: boolean; idempotencyKey?: string } = {},
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (options.authenticated !== false) headers.authorization = `Bearer ${token}`;
    if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;
    const response = await fetch(`${baseUrl}/api/projects/project-1/phases/requirements/artifacts/generate`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    return { status: response.status, json: await response.json() as Record<string, unknown> };
  }

  test("requires JWT authentication", async () => {
    const response = await post({ brief: "Valid brief" }, {
      authenticated: false,
      idempotencyKey: "jwt-required",
    });
    expect(response.status).toBe(401);
    expect(generationSpy).not.toHaveBeenCalled();
  });

  test.each([
    ["missing Idempotency-Key", { brief: "Valid brief" }, undefined],
    ["blank brief", { brief: "   " }, "blank"],
    ["unknown body key", { brief: "Valid brief", arbitraryContext: "no" }, "unknown"],
    ["title", { brief: "Valid brief", title: "Not accepted" }, "title"],
    ["includeDecisionIds", { brief: "Valid brief", includeDecisionIds: ["decision-1"] }, "decisions"],
    ["non-boolean includeMemory", { brief: "Valid brief", includeMemory: "yes" }, "memory-type"],
  ])("rejects %s before invoking the service", async (_label, body, key) => {
    const response = await post(body, { idempotencyKey: key });
    expect(response.status).toBe(422);
    expect(response.json).toMatchObject({ error: "PLANNING_ARTIFACT_INVALID" });
    expect(generationSpy).not.toHaveBeenCalled();
  });

  test.each([
    [201, false],
    [200, true],
    [202, true],
  ] as const)("returns %s for the corresponding generation/replay result", async (status, reused) => {
    generationSpy.mockResolvedValueOnce(result(status));
    const response = await post({ brief: "Valid brief" }, { idempotencyKey: `status-${status}` });
    expect(response.status).toBe(status);
    expect(response.json).toMatchObject({ success: true, data: { reused } });
  });

  test("uses the known planning error envelope", async () => {
    generationSpy.mockRejectedValueOnce(new PlanningDomainError(
      "PLANNING_GENERATION_IN_PROGRESS",
      "A Requirements generation is already in progress.",
      409,
    ));
    const response = await post({ brief: "Valid brief" }, { idempotencyKey: "known-error" });
    expect(response.status).toBe(409);
    expect(response.json).toEqual({
      error: "PLANNING_GENERATION_IN_PROGRESS",
      message: "A Requirements generation is already in progress.",
    });
  });

  test("does not expose unexpected persistence exception text", async () => {
    generationSpy.mockRejectedValueOnce(new Error("sensitive SQL schema host and filesystem path"));
    const response = await post({ brief: "Valid brief" }, { idempotencyKey: "unexpected-error" });
    expect(response.status).toBe(500);
    expect(response.json).toEqual({
      error: "Internal server error",
      message: "The planning request could not be completed.",
    });
    expect(JSON.stringify(response.json)).not.toContain("sensitive SQL");
  });

  test("matches the explicit generation route before the generic phase route", async () => {
    generationSpy.mockResolvedValueOnce(result(201));
    const response = await post({ brief: "Valid brief" }, { idempotencyKey: "route-precedence" });
    expect(response.status).toBe(201);
    expect(generationSpy).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "project-1",
      actorId: "member-1",
      idempotencyKey: "route-precedence",
    }));
    expect(legacyRunSpy).not.toHaveBeenCalled();
  });
});
