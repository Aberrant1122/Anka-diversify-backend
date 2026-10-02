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
  JWT_SECRET: "documentation-revision-api-test-secret",
  ENCRYPTION_KEY: "documentation-revision-api-test-key".padEnd(32, "-"),
}));

type RevisionResult = Awaited<ReturnType<PhaseService["reviseDocumentation"]>>;

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

describe("Documentation revision HTTP endpoints", () => {
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
    revisionSpy = jest.spyOn(PhaseService.prototype, "reviseDocumentation");
  });

  afterEach(() => {
    revisionSpy.mockRestore();
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });

  async function post(
    path: string,
    body: unknown,
    options: { authenticated?: boolean; idempotencyKey?: string } = {},
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (options.authenticated !== false) headers.authorization = `Bearer ${token}`;
    if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;
    const response = await fetch(`${baseUrl}/api/projects/project-1/phases${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  test("requires JWT authentication", async () => {
    const response = await post(
      "/documentation/artifacts/artifact-v1/revisions",
      { operation: "DOCUMENT_REVISION", instruction: "Valid instruction" },
      { authenticated: false, idempotencyKey: "jwt-required" },
    );
    expect(response.status).toBe(401);
    expect(revisionSpy).not.toHaveBeenCalled();
  });

  test.each([
    ["missing Idempotency-Key", { operation: "DOCUMENT_REVISION", instruction: "Valid" }, undefined, "PLANNING_ARTIFACT_INVALID"],
    ["blank instruction", { operation: "DOCUMENT_REVISION", instruction: "   " }, "blank", "PLANNING_ARTIFACT_INVALID"],
    ["missing section target", { operation: "SECTION_REVISION", instruction: "Valid" }, "op-sec", "PLANNING_INVALID_SECTION"],
    ["null section target", { operation: "SECTION_REGENERATION", instruction: "Valid", targetSectionKey: null }, "null-sec", "PLANNING_INVALID_SECTION"],
    ["blank section target", { operation: "SECTION_REVISION", instruction: "Valid", targetSectionKey: "   " }, "blank-sec", "PLANNING_INVALID_SECTION"],
    ["unknown section target", { operation: "SECTION_REVISION", instruction: "Valid", targetSectionKey: "unknown" }, "unknown-sec", "PLANNING_INVALID_SECTION"],
    ["forbidden root section requirementsTraceability", { operation: "SECTION_REVISION", instruction: "Valid", targetSectionKey: "requirementsTraceability" }, "trace-sec", "PLANNING_INVALID_SECTION"],
    ["forbidden root section sourceRequirements", { operation: "SECTION_REVISION", instruction: "Valid", targetSectionKey: "sourceRequirements" }, "source-sec", "PLANNING_INVALID_SECTION"],
    ["initial gen operation", { operation: "INITIAL_GENERATION", instruction: "Valid" }, "op-init", "PLANNING_ARTIFACT_INVALID"],
    ["target on DOCUMENT_REVISION", { operation: "DOCUMENT_REVISION", instruction: "Valid", targetSectionKey: "systemActors" }, "target-key", "PLANNING_INVALID_SECTION"],
    ["target on FEEDBACK_APPLICATION", { operation: "FEEDBACK_APPLICATION", instruction: "Valid", targetSectionKey: "features" }, "feedback-target", "PLANNING_INVALID_SECTION"],
    ["rebase on SECTION_REVISION", { operation: "SECTION_REVISION", instruction: "Valid", targetSectionKey: "overview", rebaseToCurrentRequirements: true }, "rebase-section", "PLANNING_ARTIFACT_INVALID"],
    ["unknown body key", { operation: "DOCUMENT_REVISION", instruction: "Valid", extraField: "no" }, "unknown", "PLANNING_ARTIFACT_INVALID"],
    ["non-boolean includeMemory", { operation: "DOCUMENT_REVISION", instruction: "Valid", includeMemory: "yes" }, "memory-type", "PLANNING_ARTIFACT_INVALID"],
  ])("rejects %s before invoking the service", async (_label, body, key, errorCode) => {
    const response = await post("/documentation/artifacts/artifact-v1/revisions", body, { idempotencyKey: key });
    expect(response.status).toBe(422);
    expect(response.json).toMatchObject({ error: errorCode });
    expect(revisionSpy).not.toHaveBeenCalled();
  });

  test.each([
    [201, false],
    [200, true],
    [202, true],
  ] as const)("returns HTTP %i and preserves reused=%s on generic endpoint", async (status, reused) => {
    revisionSpy.mockResolvedValueOnce(result(status));
    const response = await post(
      "/documentation/artifacts/artifact-v1/revisions",
      {
        operation: "DOCUMENT_REVISION",
        instruction: "Update overview and add edge cases.",
        rebaseToCurrentRequirements: true,
      },
      { idempotencyKey: `idem-${status}` },
    );

    expect(response.status).toBe(status);
    expect(response.json).toMatchObject({ success: true, data: { reused } });
    expect(revisionSpy).toHaveBeenCalledWith({
      projectId: "project-1",
      baseArtifactId: "artifact-v1",
      actorId: "member-1",
      idempotencyKey: `idem-${status}`,
      operation: "DOCUMENT_REVISION",
      instruction: "Update overview and add edge cases.",
      targetSectionKey: null,
      includeMemory: false,
      rebaseToCurrentRequirements: true,
    });
  });

  test("dedicated /revise endpoint invokes DOCUMENT_REVISION", async () => {
    revisionSpy.mockResolvedValueOnce(result(201));
    const response = await post(
      "/documentation/artifacts/artifact-v1/revise",
      {
        instruction: "Refine features and error behaviors.",
        includeMemory: true,
        rebaseToCurrentRequirements: true,
      },
      { idempotencyKey: "idem-dedicated-revise" },
    );

    expect(response.status).toBe(201);
    expect(revisionSpy).toHaveBeenCalledWith({
      projectId: "project-1",
      baseArtifactId: "artifact-v1",
      actorId: "member-1",
      idempotencyKey: "idem-dedicated-revise",
      operation: "DOCUMENT_REVISION",
      instruction: "Refine features and error behaviors.",
      targetSectionKey: null,
      includeMemory: true,
      rebaseToCurrentRequirements: true,
    });
  });

  test("dedicated /feedback endpoint invokes FEEDBACK_APPLICATION", async () => {
    revisionSpy.mockResolvedValueOnce(result(201));
    const response = await post(
      "/documentation/artifacts/artifact-v1/feedback",
      {
        feedback: "Address security review findings.",
      },
      { idempotencyKey: "idem-dedicated-feedback" },
    );

    expect(response.status).toBe(201);
    expect(revisionSpy).toHaveBeenCalledWith({
      projectId: "project-1",
      baseArtifactId: "artifact-v1",
      actorId: "member-1",
      idempotencyKey: "idem-dedicated-feedback",
      operation: "FEEDBACK_APPLICATION",
      instruction: "Address security review findings.",
      targetSectionKey: null,
      includeMemory: false,
    });
  });

  test("dedicated /sections/:sectionKey/revise endpoint invokes SECTION_REVISION", async () => {
    revisionSpy.mockResolvedValueOnce(result(201));
    const response = await post(
      "/documentation/artifacts/artifact-v1/sections/features/revise",
      {
        instruction: "Add export data feature.",
      },
      { idempotencyKey: "idem-dedicated-sec-rev" },
    );

    expect(response.status).toBe(201);
    expect(revisionSpy).toHaveBeenCalledWith({
      projectId: "project-1",
      baseArtifactId: "artifact-v1",
      actorId: "member-1",
      idempotencyKey: "idem-dedicated-sec-rev",
      operation: "SECTION_REVISION",
      instruction: "Add export data feature.",
      targetSectionKey: "features",
      includeMemory: false,
    });
  });

  test("dedicated /sections/:sectionKey/regenerate endpoint invokes SECTION_REGENERATION", async () => {
    revisionSpy.mockResolvedValueOnce(result(201));
    const response = await post(
      "/documentation/artifacts/artifact-v1/sections/apiContracts/regenerate",
      {},
      { idempotencyKey: "idem-dedicated-sec-regen" },
    );

    expect(response.status).toBe(201);
    expect(revisionSpy).toHaveBeenCalledWith({
      projectId: "project-1",
      baseArtifactId: "artifact-v1",
      actorId: "member-1",
      idempotencyKey: "idem-dedicated-sec-regen",
      operation: "SECTION_REGENERATION",
      instruction: "Regenerate section apiContracts from authoritative context",
      targetSectionKey: "apiContracts",
      includeMemory: false,
    });
  });

  test("dedicated endpoints reject unknown fields", async () => {
    const response = await post(
      "/documentation/artifacts/artifact-v1/revise",
      { instruction: "Valid", invalidExtra: true },
      { idempotencyKey: "idem-extra" },
    );
    expect(response.status).toBe(422);
    expect(response.json).toMatchObject({ error: "PLANNING_ARTIFACT_INVALID" });
    expect(revisionSpy).not.toHaveBeenCalled();
  });
});
