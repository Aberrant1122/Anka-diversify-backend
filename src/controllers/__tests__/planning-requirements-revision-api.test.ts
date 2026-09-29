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
  JWT_SECRET: "requirements-revision-api-test-secret",
  ENCRYPTION_KEY: "requirements-revision-api-test-key".padEnd(32, "-"),
}));

type RevisionResult = Awaited<ReturnType<PhaseService["reviseRequirements"]>>;

function result(httpStatus: 200 | 201 | 202): RevisionResult {
  return {
    httpStatus,
    reused: httpStatus !== 201,
    run: { id: "run-rev-1", status: httpStatus === 202 ? "running" : "completed" } as WorkflowRun,
    artifact: null,
    readiness: null,
    diff: null,
  };
}

describe("Requirements revision HTTP endpoint", () => {
  let server: http.Server;
  let baseUrl: string;
  const token = jwt.sign({ userId: "member-1" }, JWT_SECRET);
  let revisionSpy: jest.SpyInstance;

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
    revisionSpy = jest.spyOn(PhaseService.prototype, "reviseRequirements");
  });

  afterEach(() => {
    revisionSpy.mockRestore();
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  async function post(
    artifactId: string,
    body: unknown,
    options: { authenticated?: boolean; idempotencyKey?: string } = {},
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (options.authenticated !== false) headers.authorization = `Bearer ${token}`;
    if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;
    const response = await fetch(`${baseUrl}/api/projects/project-1/phases/requirements/artifacts/${artifactId}/revisions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    return { status: response.status, json: await response.json() as Record<string, unknown> };
  }

  test("requires JWT authentication", async () => {
    const response = await post("artifact-v1", {
      operation: "DOCUMENT_REVISION",
      instruction: "Valid instruction",
    }, {
      authenticated: false,
      idempotencyKey: "jwt-required",
    });
    expect(response.status).toBe(401);
    expect(revisionSpy).not.toHaveBeenCalled();
  });

  test.each([
    ["missing Idempotency-Key", { operation: "DOCUMENT_REVISION", instruction: "Valid" }, undefined],
    ["blank instruction", { operation: "DOCUMENT_REVISION", instruction: "   " }, "blank"],
    ["invalid operation", { operation: "SECTION_REVISION", instruction: "Valid" }, "op-sec"],
    ["initial gen operation", { operation: "INITIAL_GENERATION", instruction: "Valid" }, "op-init"],
    ["supplied targetSectionKey", { operation: "DOCUMENT_REVISION", instruction: "Valid", targetSectionKey: "usersAndActors" }, "target-key"],
    ["unknown body key", { operation: "DOCUMENT_REVISION", instruction: "Valid", arbitraryContext: "no" }, "unknown"],
    ["title in body", { operation: "DOCUMENT_REVISION", instruction: "Valid", title: "Not accepted" }, "title"],
    ["non-boolean includeMemory", { operation: "DOCUMENT_REVISION", instruction: "Valid", includeMemory: "yes" }, "memory-type"],
  ])("rejects %s before invoking the service", async (_label, body, key) => {
    const response = await post("artifact-v1", body, { idempotencyKey: key });
    expect(response.status).toBe(422);
    expect(response.json).toMatchObject({ error: "PLANNING_ARTIFACT_INVALID" });
    expect(revisionSpy).not.toHaveBeenCalled();
  });

  test.each([
    [201, false],
    [200, true],
    [202, true],
  ] as const)("returns HTTP %i and preserves reused=%s", async (status, reused) => {
    revisionSpy.mockResolvedValueOnce(result(status));
    const response = await post("artifact-v1", {
      operation: "DOCUMENT_REVISION",
      instruction: "Add measurable requirements.",
    }, { idempotencyKey: `idem-${status}` });

    expect(response.status).toBe(status);
    expect(response.json).toMatchObject({ success: true, data: { reused } });
    expect(revisionSpy).toHaveBeenCalledWith({
      projectId: "project-1",
      baseArtifactId: "artifact-v1",
      actorId: "member-1",
      idempotencyKey: `idem-${status}`,
      operation: "DOCUMENT_REVISION",
      instruction: "Add measurable requirements.",
      includeMemory: false,
    });
  });

  test("accepts FEEDBACK_APPLICATION and includeMemory=true", async () => {
    revisionSpy.mockResolvedValueOnce(result(201));
    const response = await post("artifact-v1", {
      operation: "FEEDBACK_APPLICATION",
      instruction: "Address review notes.",
      includeMemory: true,
    }, { idempotencyKey: "idem-feedback" });

    expect(response.status).toBe(201);
    expect(revisionSpy).toHaveBeenCalledWith({
      projectId: "project-1",
      baseArtifactId: "artifact-v1",
      actorId: "member-1",
      idempotencyKey: "idem-feedback",
      operation: "FEEDBACK_APPLICATION",
      instruction: "Address review notes.",
      includeMemory: true,
    });
  });

  test("translates PLANNING_REVISION_NO_CHANGES to HTTP 422", async () => {
    revisionSpy.mockRejectedValueOnce(
      new PlanningDomainError("PLANNING_REVISION_NO_CHANGES", "No changes made.", 422),
    );
    const response = await post("artifact-v1", {
      operation: "DOCUMENT_REVISION",
      instruction: "No change instruction",
    }, { idempotencyKey: "no-op" });

    expect(response.status).toBe(422);
    expect(response.json).toMatchObject({ error: "PLANNING_REVISION_NO_CHANGES" });
  });

  test("translates PLANNING_ACTION_LOCKED to HTTP 409", async () => {
    revisionSpy.mockRejectedValueOnce(
      new PlanningDomainError("PLANNING_ACTION_LOCKED", "Locked in awaiting_approval.", 409),
    );
    const response = await post("artifact-v1", {
      operation: "DOCUMENT_REVISION",
      instruction: "Instruction",
    }, { idempotencyKey: "locked" });

    expect(response.status).toBe(409);
    expect(response.json).toMatchObject({ error: "PLANNING_ACTION_LOCKED" });
  });

  test("translates unexpected errors to generic 500 error envelope", async () => {
    revisionSpy.mockRejectedValueOnce(new Error("sensitive SQL or filesystem info"));
    const response = await post("artifact-v1", {
      operation: "DOCUMENT_REVISION",
      instruction: "Instruction",
    }, { idempotencyKey: "error-500" });

    expect(response.status).toBe(500);
    expect(response.json).toEqual({
      error: "Internal server error",
      message: "The planning request could not be completed.",
    });
  });
});
