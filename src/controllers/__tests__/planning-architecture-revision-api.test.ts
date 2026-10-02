import express from "express";
import http from "http";
import jwt from "jsonwebtoken";
import { JWT_SECRET } from "../../config/env";
import { authenticateToken } from "../../middleware/auth";
import phaseRoutes from "../../routes/phase-routes";
import { PhaseService } from "../../services/phase-service";

jest.mock("../../config/env", () => ({ JWT_SECRET: "architecture-revision-api-secret",
  ENCRYPTION_KEY: "architecture-revision-api-key".padEnd(32, "-") }));

describe("Architecture revision API", () => {
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
  async function call(body: unknown, key?: string, auth = true) {
    const response = await fetch(`${baseUrl}/architecture/artifacts/base-1/revisions/ai`, { method: "POST",
      headers: { ...(auth ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json",
        ...(key ? { "Idempotency-Key": key } : {}) }, body: JSON.stringify(body) });
    return { status: response.status, json: await response.json() as Record<string, unknown> };
  }
  const base = { baseVersion: 2, baseContentHash: "a".repeat(64) };
  test("requires authentication, key, exact base and operation-specific fields", async () => {
    const spy = jest.spyOn(PhaseService.prototype, "reviseArchitecture").mockResolvedValue({
      run: {} as never, artifact: null, readiness: null, diff: null, reused: true, httpStatus: 202,
    });
    try {
      expect((await call({ ...base, operation: "DOCUMENT_REVISION", instruction: "Improve" }, "key", false)).status).toBe(401);
      expect((await call({ ...base, operation: "DOCUMENT_REVISION", instruction: "Improve" })).status).toBe(422);
      expect((await call({ operation: "DOCUMENT_REVISION", instruction: "Improve" }, "key")).status).toBe(422);
      expect((await call({ ...base, operation: "FEEDBACK_APPLICATION", instruction: "Wrong field" }, "key")).status).toBe(422);
      expect((await call({ ...base, operation: "FEEDBACK_APPLICATION", feedback: "Review", rebaseToCurrentAuthorities: true }, "key")).status).toBe(422);
      expect((await call({ ...base, operation: "DOCUMENT_REVISION", instruction: "Improve", traceability: {} }, "key")).status).toBe(422);
      expect(spy).not.toHaveBeenCalled();
      expect((await call({ ...base, operation: "FEEDBACK_APPLICATION", feedback: "Apply review" }, "key")).status).toBe(202);
      expect(spy).toHaveBeenCalledWith({ projectId: "project-1", actorId: "editor-1", idempotencyKey: "key",
        baseArtifactId: "base-1", ...base, operation: "FEEDBACK_APPLICATION", instruction: "Apply review",
        includeMemory: false, rebaseToCurrentAuthorities: false, componentRetirements: [], identityRetirements: [] });
    } finally { spy.mockRestore(); }
  });

  test("validates and sorts editor retirement declarations", async () => {
    const spy = jest.spyOn(PhaseService.prototype, "reviseArchitecture").mockResolvedValue({
      run: {} as never, artifact: null, readiness: null, diff: null, reused: true, httpStatus: 202,
    });
    const request = { ...base, operation: "DOCUMENT_REVISION", instruction: "Replace components" };
    try {
      for (const componentRetirements of [null, {}, [
        { retiredComponentId: "ARCH-COMP-API", replacementComponentId: null, extra: true },
      ], [
        { retiredComponentId: "ARCH-COMP-API", replacementComponentId: null },
        { retiredComponentId: "ARCH-COMP-API", replacementComponentId: null },
      ]]) expect((await call({ ...request, componentRetirements }, "key")).status).toBe(422);
      expect(spy).not.toHaveBeenCalled();
      expect((await call({ ...request, componentRetirements: [
        { retiredComponentId: "ARCH-COMP-Z", replacementComponentId: null },
        { retiredComponentId: "ARCH-COMP-API", replacementComponentId: "ARCH-COMP-NEW" },
      ] }, "key")).status).toBe(202);
      expect(spy).toHaveBeenCalledWith(expect.objectContaining({ componentRetirements: [
        { retiredComponentId: "ARCH-COMP-API", replacementComponentId: "ARCH-COMP-NEW" },
        { retiredComponentId: "ARCH-COMP-Z", replacementComponentId: null },
      ] }));
    } finally { spy.mockRestore(); }
  });

  test("validates and sorts section-scoped identity retirements", async () => {
    const spy = jest.spyOn(PhaseService.prototype, "reviseArchitecture").mockResolvedValue({
      run: {} as never, artifact: null, readiness: null, diff: null, reused: true, httpStatus: 202,
    });
    const request = { ...base, operation: "DOCUMENT_REVISION", instruction: "Replace designs" };
    try {
      for (const identityRetirements of [null, {}, [
        { section: "dataDesign", retiredId: "ARCH-DATA-STATE", replacementId: null, extra: true },
      ], [
        { section: "dataDesign", retiredId: "ARCH-IFACE-API", replacementId: null },
      ], [
        { section: "dataDesign", retiredId: "ARCH-DATA-STATE", replacementId: null },
        { section: "dataDesign", retiredId: "ARCH-DATA-STATE", replacementId: null },
      ]]) expect((await call({ ...request, identityRetirements }, "key")).status).toBe(422);
      expect(spy).not.toHaveBeenCalled();
      expect((await call({ ...request, identityRetirements: [
        { section: "interfaceDesign", retiredId: "ARCH-IFACE-API", replacementId: "ARCH-IFACE-NEW" },
        { section: "dataDesign", retiredId: "ARCH-DATA-STATE", replacementId: null },
      ] }, "key")).status).toBe(202);
      expect(spy).toHaveBeenCalledWith(expect.objectContaining({ identityRetirements: [
        { section: "dataDesign", retiredId: "ARCH-DATA-STATE", replacementId: null },
        { section: "interfaceDesign", retiredId: "ARCH-IFACE-API", replacementId: "ARCH-IFACE-NEW" },
      ] }));
    } finally { spy.mockRestore(); }
  });
});
