import { DocumentExtractionService, sanitizeErrorMessage } from "../document-extraction.service";
import * as uploadService from "../upload.service";
import { DocumentExtractionStatus, EvidenceLocatorType } from "@prisma/client";
import { computeSha256 } from "../document-parser";

jest.mock("../planning-authorization.service", () => ({
  PlanningAuthorizationService: jest.fn().mockImplementation(() => ({
    assertCanEdit: jest.fn().mockResolvedValue({ id: "proj-1" }),
  })),
}));

// Mock database
jest.mock("../database", () => {
  const documentExtractionRun = {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  };
  const documentSource = {
    findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn(),
  };
  const documentRegistrationAttempt = {
    findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn(),
  };
  return {
    prisma: {
      documentSource,
      documentRegistrationAttempt,
      documentExtractionRun,
      evidenceSpan: {
        findMany: jest.fn(),
        count: jest.fn(),
        createMany: jest.fn(),
        deleteMany: jest.fn(),
      },
      projectFile: {
        findFirst: jest.fn(),
      },
      $transaction: jest.fn((callback) => callback({
        $queryRaw: jest.fn().mockResolvedValue([{ id: "source-1" }]),
        documentSource,
        documentRegistrationAttempt,
        documentExtractionRun,
        evidenceSpan: {
          deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
          createMany: jest.fn().mockResolvedValue({ count: 2 }),
        },
      })),
    },
  };
});

const { prisma } = require("../database");

describe("DocumentExtractionService Unit & Service Tests (CP1.1)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(DocumentExtractionService, "triggerRun").mockImplementation(() => undefined);
    jest.spyOn(uploadService, "createEvidenceSnapshot").mockResolvedValue("projects/proj-1/document-evidence/snapshot-1");
    prisma.documentSource.updateMany.mockResolvedValue({ count: 1 });
    prisma.documentRegistrationAttempt.findFirst.mockResolvedValue(null);
    prisma.documentRegistrationAttempt.create.mockResolvedValue({ id: "registration-1", attempt: 1 });
    prisma.documentRegistrationAttempt.updateMany.mockResolvedValue({ count: 0 });
  });

  describe("Eligibility & Registration", () => {
    test("snapshot storage failure records a safe registration failure without a source or run", async () => {
      prisma.documentSource.findUnique.mockResolvedValue(null);
      const providerError = Object.assign(new Error("private provider detail"), { name: "NoSuchKey" });
      (uploadService.createEvidenceSnapshot as jest.Mock).mockRejectedValue(providerError);
      const log = jest.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const result = await DocumentExtractionService.registerAndTriggerExtraction({
          id: "file-pdf", projectId: "proj-1", name: "contract.pdf",
          type: "application/pdf", s3Key: "projects/proj-1/contract.pdf",
        });
        expect(result).toBeNull();
        expect(prisma.documentSource.create).not.toHaveBeenCalled();
        expect(prisma.documentExtractionRun.create).not.toHaveBeenCalled();
        expect(prisma.documentRegistrationAttempt.update).toHaveBeenCalledWith(expect.objectContaining({
          data: expect.objectContaining({ status: "FAILED", errorCode: "ORIGINAL_OBJECT_MISSING" }),
        }));
        expect(log).not.toHaveBeenCalledWith(expect.anything(), providerError);
      } finally {
        log.mockRestore();
      }
    });

    test("metadata exposes failed registration without inventing a source or extraction run", async () => {
      prisma.projectFile.findFirst.mockResolvedValue({
        id: "file-pdf", projectId: "proj-1", name: "contract.pdf",
        type: "application/pdf", s3Key: "projects/proj-1/contract.pdf",
      });
      prisma.documentSource.findUnique.mockResolvedValue(null);
      prisma.documentRegistrationAttempt.findFirst.mockResolvedValue({
        attempt: 2, status: "FAILED", errorCode: "SNAPSHOT_FAILED",
        errorMessage: "We could not preserve this document for processing. Please retry processing.",
      });
      expect(await DocumentExtractionService.getExtractionSummary("proj-1", "file-pdf"))
        .toMatchObject({ eligible: true, registrationStatus: "FAILED", registrationAttempt: 2,
          sourceId: null, status: null, errorCode: "SNAPSHOT_FAILED", canRetry: true });
      expect(prisma.documentExtractionRun.create).not.toHaveBeenCalled();
    });

    test("unsupported ordinary file remains a normal ProjectFile with no source or job created", async () => {
      const isEligible = DocumentExtractionService.isEligible("screenshot.png", "image/png");
      expect(isEligible).toBe(false);

      const res = await DocumentExtractionService.registerAndTriggerExtraction({
        id: "file-img",
        projectId: "proj-1",
        name: "screenshot.png",
        type: "image",
        s3Key: "projects/proj-1/screenshot.png",
      });

      expect(res).toBeNull();
      expect(prisma.documentSource.create).not.toHaveBeenCalled();
      expect(prisma.documentExtractionRun.create).not.toHaveBeenCalled();
    });

    test("supported document creates one DocumentSource and one PENDING attempt", async () => {
      const isEligible = DocumentExtractionService.isEligible("contract.pdf", "application/pdf");
      expect(isEligible).toBe(true);

      prisma.documentSource.findUnique.mockResolvedValue(null);
      prisma.documentSource.create.mockResolvedValue({
        id: "source-1",
        projectId: "proj-1",
        projectFileId: "file-pdf",
        sourceVersion: 1,
        originalFilename: "contract.pdf",
        s3Key: "projects/proj-1/contract.pdf",
      });
      prisma.documentExtractionRun.findFirst.mockResolvedValue(null);
      prisma.documentExtractionRun.create.mockResolvedValue({
        id: "run-1",
        projectId: "proj-1",
        sourceId: "source-1",
        attempt: 1,
        status: DocumentExtractionStatus.PENDING,
      });

      const res = await DocumentExtractionService.registerAndTriggerExtraction({
        id: "file-pdf",
        projectId: "proj-1",
        name: "contract.pdf",
        type: "application/pdf",
        s3Key: "projects/proj-1/contract.pdf",
      });

      expect(res).toEqual({ sourceId: "source-1", runId: "run-1" });
      expect(prisma.documentSource.create).toHaveBeenCalledTimes(1);
      expect(uploadService.createEvidenceSnapshot).toHaveBeenCalledWith(
        "proj-1", "projects/proj-1/contract.pdf",
      );
      expect(prisma.documentSource.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ s3Key: "projects/proj-1/document-evidence/snapshot-1" }),
      }));
      expect(prisma.documentExtractionRun.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            projectId: "proj-1",
            sourceId: "source-1",
            attempt: 1,
            status: DocumentExtractionStatus.PENDING,
          }),
        })
      );
    });

    test("repeated confirm on already existing source does not create duplicate DocumentSource", async () => {
      prisma.documentSource.findUnique.mockResolvedValue({
        id: "source-existing",
        projectId: "proj-1",
        projectFileId: "file-pdf",
      });
      // Active run already pending
      prisma.documentExtractionRun.findFirst.mockResolvedValue({
        id: "run-active",
        status: DocumentExtractionStatus.PENDING,
      });

      const res = await DocumentExtractionService.registerAndTriggerExtraction({
        id: "file-pdf",
        projectId: "proj-1",
        name: "contract.pdf",
        type: "application/pdf",
        s3Key: "projects/proj-1/contract.pdf",
      });

      expect(res).toEqual({ sourceId: "source-existing", runId: "run-active" });
      expect(prisma.documentSource.create).not.toHaveBeenCalled();
    });
  });

  describe("Execution & Error Safety", () => {
    test("changed snapshot bytes fail without overwriting established source identity", async () => {
      const originalHash = computeSha256(Buffer.from("original"));
      prisma.documentExtractionRun.updateMany.mockResolvedValue({ count: 1 });
      prisma.documentExtractionRun.findUnique.mockResolvedValue({
        id: "run-retry", projectId: "proj-1", sourceId: "source-1",
        source: { s3Key: "projects/proj-1/document-evidence/snapshot-1", originalFilename: "doc.pdf", mimeType: "application/pdf" },
      });
      prisma.documentSource.updateMany.mockResolvedValue({ count: 0 });
      prisma.documentSource.findUnique.mockResolvedValue({
        id: "source-1", contentHash: originalHash, byteSize: 8,
      });
      jest.spyOn(uploadService, "fetchFromS3").mockResolvedValue({
        buffer: Buffer.from("changed"), byteSize: 7,
      });

      await DocumentExtractionService.executeRun("run-retry");

      expect(prisma.documentSource.update).not.toHaveBeenCalled();
      expect(prisma.documentExtractionRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ status: DocumentExtractionStatus.FAILED, errorCode: "SOURCE_CHANGED" }),
      }));
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    test("legacy mutable source cannot be re-extracted", async () => {
      prisma.documentExtractionRun.updateMany.mockResolvedValue({ count: 1 });
      prisma.documentExtractionRun.findUnique.mockResolvedValue({
        id: "run-legacy", projectId: "proj-1", sourceId: "source-1",
        source: { s3Key: "projects/proj-1/legacy.pdf", originalFilename: "legacy.pdf", mimeType: "application/pdf" },
      });
      await DocumentExtractionService.executeRun("run-legacy");
      expect(uploadService.fetchFromS3).not.toHaveBeenCalled();
      expect(prisma.documentExtractionRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ status: DocumentExtractionStatus.FAILED, errorCode: "SOURCE_NOT_FROZEN" }),
      }));
    });

    test("concurrency guard: already claimed run is not executed twice", async () => {
      // updateMany returns count 0 if run was already claimed or not PENDING
      prisma.documentExtractionRun.updateMany.mockResolvedValue({ count: 0 });

      await DocumentExtractionService.executeRun("run-claimed");
      expect(prisma.documentExtractionRun.findUnique).not.toHaveBeenCalled();
    });

    test("oversized storage bytes (> 20 MB) fail extraction safely with DOCUMENT_TOO_LARGE", async () => {
      prisma.documentExtractionRun.updateMany.mockResolvedValue({ count: 1 });
      prisma.documentExtractionRun.findUnique.mockResolvedValue({
        id: "run-oversized",
        projectId: "proj-1",
        sourceId: "source-1",
        source: {
          id: "source-1",
          originalFilename: "large.pdf",
          mimeType: "application/pdf",
          s3Key: "projects/proj-1/document-evidence/large-snapshot",
        },
      });

      const sizeError = new Error("Document exceeds maximum size limit of 20971520 bytes");
      (sizeError as any).code = "DOCUMENT_TOO_LARGE";
      jest.spyOn(uploadService, "fetchFromS3").mockRejectedValue(sizeError);

      await DocumentExtractionService.executeRun("run-oversized");

      expect(prisma.documentExtractionRun.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "run-oversized", status: DocumentExtractionStatus.PROCESSING },
          data: expect.objectContaining({
            status: DocumentExtractionStatus.FAILED,
            errorCode: "DOCUMENT_TOO_LARGE",
            errorMessage: expect.stringContaining("maximum supported extraction size of 20 MB"),
          }),
        })
      );
    });

    test("misleading PDF filename with non-PDF bytes fails safely without becoming READY", async () => {
      prisma.documentExtractionRun.updateMany.mockResolvedValue({ count: 1 });
      prisma.documentExtractionRun.findUnique.mockResolvedValue({
        id: "run-fake",
        projectId: "proj-1",
        sourceId: "source-1",
        source: {
          id: "source-1",
          originalFilename: "fake.pdf",
          mimeType: "application/pdf",
          s3Key: "projects/proj-1/document-evidence/fake-snapshot",
        },
      });

      jest.spyOn(uploadService, "fetchFromS3").mockResolvedValue({
        buffer: Buffer.from("NOT_A_VALID_PDF_BINARY_STREAM"),
        byteSize: 30,
      });

      await DocumentExtractionService.executeRun("run-fake");

      expect(prisma.documentExtractionRun.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "run-fake", status: DocumentExtractionStatus.PROCESSING },
          data: expect.objectContaining({
            status: DocumentExtractionStatus.FAILED,
            errorCode: "INVALID_DOCUMENT_SIGNATURE",
            errorMessage: expect.stringContaining("does not match a valid PDF or DOCX binary signature"),
          }),
        })
      );
    });
  });

  describe("Retry Semantics", () => {
    test("retry on FAILED extraction creates exactly one next attempt", async () => {
      prisma.projectFile.findFirst.mockResolvedValue({
        id: "file-1",
        projectId: "proj-1",
        name: "doc.pdf",
        type: "application/pdf",
        s3Key: "projects/proj-1/doc.pdf",
      });
      prisma.documentSource.findUnique.mockResolvedValue({
        id: "source-1",
        projectId: "proj-1",
        projectFileId: "file-1",
        sourceVersion: 1,
        contentHash: "hash-abc",
        extractionRuns: [],
      });
      // Latest run was attempt 1, FAILED
      prisma.documentExtractionRun.findFirst.mockResolvedValue({
        id: "run-attempt-1",
        attempt: 1,
        status: DocumentExtractionStatus.FAILED,
      });
      prisma.documentExtractionRun.create.mockResolvedValue({
        id: "run-attempt-2",
        attempt: 2,
        status: DocumentExtractionStatus.PENDING,
      });

      await DocumentExtractionService.retryExtraction("proj-1", "file-1", "owner-1");

      expect(prisma.documentExtractionRun.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            sourceId: "source-1",
            attempt: 2,
            status: DocumentExtractionStatus.PENDING,
          }),
        })
      );
    });

    test("retry while active (PENDING/PROCESSING) is a no-op that does not create duplicate run", async () => {
      prisma.projectFile.findFirst.mockResolvedValue({
        id: "file-1",
        projectId: "proj-1",
        name: "doc.pdf",
        type: "application/pdf",
        s3Key: "projects/proj-1/doc.pdf",
      });
      prisma.documentSource.findUnique.mockResolvedValue({
        id: "source-1",
        extractionRuns: [
          {
            id: "run-active",
            attempt: 1,
            status: DocumentExtractionStatus.PROCESSING,
          },
        ],
      });
      prisma.documentExtractionRun.findFirst.mockResolvedValue({
        id: "run-active",
        attempt: 1,
        status: DocumentExtractionStatus.PROCESSING,
      });

      await DocumentExtractionService.retryExtraction("proj-1", "file-1", "owner-1");

      expect(prisma.documentExtractionRun.create).not.toHaveBeenCalled();
    });

    test("retry on already READY document does not re-extract", async () => {
      prisma.projectFile.findFirst.mockResolvedValue({
        id: "file-1",
        projectId: "proj-1",
        name: "doc.pdf",
        type: "application/pdf",
        s3Key: "projects/proj-1/doc.pdf",
      });
      prisma.documentSource.findUnique.mockResolvedValue({
        id: "source-1",
        extractionRuns: [
          {
            id: "run-ready",
            attempt: 1,
            status: DocumentExtractionStatus.READY,
          },
        ],
      });
      prisma.documentExtractionRun.findFirst.mockResolvedValue({
        id: "run-ready",
        attempt: 1,
        status: DocumentExtractionStatus.READY,
      });

      await DocumentExtractionService.retryExtraction("proj-1", "file-1", "owner-1");

      expect(prisma.documentExtractionRun.create).not.toHaveBeenCalled();
    });
  });

  describe("Startup Reconciliation", () => {
    test("bounded workers drain 120 pending attempts oldest first without repeating failures", async () => {
      (DocumentExtractionService.triggerRun as jest.Mock).mockRestore();
      const pending = Array.from({ length: 120 }, (_, index) => ({ id: `pending-${index}` }));
      const seen: string[] = [];
      let active = 0;
      let maximumActive = 0;
      prisma.documentExtractionRun.updateMany.mockResolvedValue({ count: 0 });
      prisma.documentExtractionRun.count.mockResolvedValue(120);
      prisma.documentExtractionRun.findFirst.mockImplementation(async () => pending.shift() ?? null);
      jest.spyOn(DocumentExtractionService, "executeRun").mockImplementation(async (id: string) => {
        active++;
        maximumActive = Math.max(maximumActive, active);
        await new Promise<void>((resolve) => setImmediate(resolve));
        seen.push(id);
        active--;
      });

      const recovery = await DocumentExtractionService.reconcileOnStartup();
      DocumentExtractionService.triggerRun("pending-0"); // duplicate scheduler request
      for (let tick = 0; seen.length < 120 && tick < 200; tick++) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }

      expect(recovery.recovered).toBe(120);
      expect(seen).toHaveLength(120);
      expect(new Set(seen).size).toBe(120);
      expect(maximumActive).toBeLessThanOrEqual(4);
      expect(prisma.documentExtractionRun.findFirst).toHaveBeenCalledWith(expect.objectContaining({
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }));
    });

    test("marks stale PROCESSING runs as FAILED and reschedules PENDING runs", async () => {
      prisma.documentExtractionRun.updateMany.mockResolvedValue({ count: 2 });
      prisma.documentExtractionRun.count.mockResolvedValue(2);

      const res = await DocumentExtractionService.reconcileOnStartup();

      expect(res.markedStale).toBe(2);
      expect(res.recovered).toBe(2);
      expect(prisma.documentRegistrationAttempt.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { status: "PROCESSING" },
        data: expect.objectContaining({ status: "FAILED", errorCode: "REGISTRATION_INTERRUPTED" }),
      }));
      expect(prisma.documentExtractionRun.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: DocumentExtractionStatus.PROCESSING },
          data: expect.objectContaining({
            status: DocumentExtractionStatus.FAILED,
            errorCode: "INTERRUPTED_BY_RESTART",
          }),
        })
      );
    });
  });
});
