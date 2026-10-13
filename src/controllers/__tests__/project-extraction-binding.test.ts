import { Request, Response } from "express";
import { ProjectController } from "../project-controller";
import { requireProjectResources, routeResource } from "../../middleware/project-resource-binding";
import { DocumentExtractionService } from "../../services/document-extraction.service";
import * as uploadService from "../../services/upload.service";

// Mock database
jest.mock("../../services/database", () => {
  const findFirst = jest.fn();
  const findUnique = jest.fn();
  const projectFindUnique = jest.fn();
  const userFindUnique = jest.fn();
  const memberFindUnique = jest.fn();
  return {
    prisma: {
      project: { findUnique: projectFindUnique },
      user: { findUnique: userFindUnique },
      projectMember: { findUnique: memberFindUnique },
      projectFile: { findFirst },
      documentSource: { findUnique },
      documentExtractionRun: { findFirst, create: jest.fn() },
      evidenceSpan: { findMany: jest.fn(), count: jest.fn() },
    },
    mockFindFirst: findFirst,
    mockFindUnique: findUnique,
  };
});

const { prisma } = require("../../services/database");

describe("Document Evidence Authorization & Project Binding Security (CP1.1)", () => {
  const controller = new ProjectController();

  beforeEach(() => {
    jest.clearAllMocks();

    // Mock project for PlanningAuthorizationService
    prisma.project.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
      if (where.id === "project-a") {
        return { id: "project-a", userId: "user-a" };
      }
      if (where.id === "project-b") {
        return { id: "project-b", userId: "user-b" };
      }
      return null;
    });

    prisma.projectMember.findUnique.mockImplementation(async ({ where }: any) => {
      const { projectId, userId } = where?.projectId_userId || {};
      if (userId === "dual-access-user" && (projectId === "project-a" || projectId === "project-b")) {
        return { id: `member-${projectId}` };
      }
      return null;
    });

    prisma.user.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
      if (["user-a", "user-b", "dual-access-user"].includes(where.id)) {
        return { id: where.id, role: "user" };
      }
      return null;
    });

    // Mock projectFile.findFirst to simulate Project A having file-a, and Project B having file-b
    prisma.projectFile.findFirst.mockImplementation(async ({ where }: { where: { id: string; projectId: string } }) => {
      if (where.id === "file-a" && where.projectId === "project-a") {
        return {
          id: "file-a",
          projectId: "project-a",
          name: "spec-a.pdf",
          type: "application/pdf",
          s3Key: "projects/project-a/spec-a.pdf",
        };
      }
      if (where.id === "file-b" && where.projectId === "project-b") {
        return {
          id: "file-b",
          projectId: "project-b",
          name: "spec-b.pdf",
          type: "application/pdf",
          s3Key: "projects/project-b/spec-b.pdf",
        };
      }
      return null;
    });
  });

  function makeMockRes() {
    const response = { statusCode: 200, body: undefined as any };
    const res = {
      status(code: number) {
        response.statusCode = code;
        return this;
      },
      json(body: any) {
        response.body = body;
        return this;
      },
    } as unknown as Response;
    return { res, response };
  }

  describe("Non-Disclosing 404 on Cross-Project Access", () => {
    test("Project A route cannot read Project B extraction metadata (returns 404)", async () => {
      const req = {
        params: { id: "project-a", fileId: "file-b" },
        user: { userId: "dual-access-user" },
      } as unknown as Request;

      const { res, response } = makeMockRes();
      await controller.getFileExtraction(req, res);

      expect(response.statusCode).toBe(404);
      expect(response.body).toEqual({ success: false, error: "File not found" });
    });

    test("Project A route cannot read Project B evidence passages (returns 404)", async () => {
      const req = {
        params: { id: "project-a", fileId: "file-b" },
        query: {},
        user: { userId: "dual-access-user" },
      } as unknown as Request;

      const { res, response } = makeMockRes();
      await controller.getFileEvidence(req, res);

      expect(response.statusCode).toBe(404);
      expect(response.body).toEqual({ success: false, error: "File not found" });
    });

    test("Project A route cannot trigger retry on Project B file (returns 404 with zero side effects)", async () => {
      const createSnapshotSpy = jest.spyOn(uploadService, "createEvidenceSnapshot");
      const fetchS3Spy = jest.spyOn(uploadService, "fetchFromS3");
      const triggerRunSpy = jest.spyOn(DocumentExtractionService, "triggerRun");

      const req = {
        params: { id: "project-a", fileId: "file-b" },
        user: { userId: "dual-access-user" },
      } as unknown as Request;

      const { res, response } = makeMockRes();
      await controller.retryFileExtraction(req, res);

      expect(response.statusCode).toBe(404);
      expect(response.body).toEqual({ success: false, error: "File not found" });
      expect(prisma.documentExtractionRun.create).not.toHaveBeenCalled();
      expect(createSnapshotSpy).not.toHaveBeenCalled();
      expect(fetchS3Spy).not.toHaveBeenCalled();
      expect(triggerRunSpy).not.toHaveBeenCalled();
    });

    test("unauthorized actor cannot trigger retry on Project A file (returns 404 with zero side effects)", async () => {
      const createSnapshotSpy = jest.spyOn(uploadService, "createEvidenceSnapshot");
      const fetchS3Spy = jest.spyOn(uploadService, "fetchFromS3");
      const triggerRunSpy = jest.spyOn(DocumentExtractionService, "triggerRun");

      const req = {
        params: { id: "project-a", fileId: "file-a" },
        user: { userId: "unauthorized-user" },
      } as unknown as Request;

      const { res, response } = makeMockRes();
      await controller.retryFileExtraction(req, res);

      expect(response.statusCode).toBe(404);
      expect(response.body.success).toBe(false);
      expect(prisma.documentExtractionRun.create).not.toHaveBeenCalled();
      expect(createSnapshotSpy).not.toHaveBeenCalled();
      expect(fetchS3Spy).not.toHaveBeenCalled();
      expect(triggerRunSpy).not.toHaveBeenCalled();
    });
  });

  describe("Middleware-level Project Resource Binding Guard", () => {
    test("requireProjectResources middleware rejects cross-project fileId before controller execution", async () => {
      const middleware = requireProjectResources("id", routeResource("fileId", "file"));

      const req = {
        params: { id: "project-a", fileId: "file-b" },
        user: { userId: "dual-access-user" },
      } as unknown as Request;

      const { res, response } = makeMockRes();
      const next = jest.fn();

      await middleware(req, res, next);

      expect(response.statusCode).toBe(404);
      expect(response.body).toEqual({ error: "Resource not found" });
      expect(next).not.toHaveBeenCalled();
    });

    test("requireProjectResources middleware allows same-project fileId to proceed to next()", async () => {
      const middleware = requireProjectResources("id", routeResource("fileId", "file"));

      const req = {
        params: { id: "project-a", fileId: "file-a" },
        user: { userId: "dual-access-user" },
      } as unknown as Request;

      const { res } = makeMockRes();
      const next = jest.fn();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
    });
  });

  describe("Authorized Project Access Success", () => {
    test.each(["0", "-1", "1.5", "NaN", "Infinity", "1e3", "1000001", "abc"])(
      "evidence rejects invalid page %s with a client error",
      async (page) => {
        const req = { params: { id: "project-a", fileId: "file-a" }, query: { page } } as unknown as Request;
        const { res, response } = makeMockRes();
        await controller.getFileEvidence(req, res);
        expect(response.statusCode).toBe(400);
        expect(prisma.evidenceSpan.findMany).not.toHaveBeenCalled();
      },
    );

    test.each(["0", "-1", "1.5", "NaN", "Infinity", "101", "abc"])(
      "evidence rejects invalid limit %s with a client error",
      async (limit) => {
        const req = { params: { id: "project-a", fileId: "file-a" }, query: { limit } } as unknown as Request;
        const { res, response } = makeMockRes();
        await controller.getFileEvidence(req, res);
        expect(response.statusCode).toBe(400);
        expect(prisma.evidenceSpan.findMany).not.toHaveBeenCalled();
      },
    );

    test("evidence rejects unsupported cursor pagination", async () => {
      const req = { params: { id: "project-a", fileId: "file-a" }, query: { cursor: "span-1" } } as unknown as Request;
      const { res, response } = makeMockRes();
      await controller.getFileEvidence(req, res);
      expect(response.statusCode).toBe(400);
      expect(prisma.evidenceSpan.findMany).not.toHaveBeenCalled();
    });

    test("same-project file extraction succeeds and returns metadata", async () => {
      prisma.documentSource.findUnique.mockResolvedValue({
        id: "source-a",
        sourceVersion: 1,
        contentHash: "hash-123",
        extractionRuns: [
          {
            status: "READY",
            attempt: 1,
            startedAt: new Date(),
            completedAt: new Date(),
          },
        ],
      });
      prisma.evidenceSpan.count.mockResolvedValue(5);

      const req = {
        params: { id: "project-a", fileId: "file-a" },
        user: { userId: "user-a" },
      } as unknown as Request;

      const { res, response } = makeMockRes();
      await controller.getFileExtraction(req, res);

      expect(response.statusCode).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.eligible).toBe(true);
      expect(response.body.data.passageCount).toBe(5);
    });
  });
});
