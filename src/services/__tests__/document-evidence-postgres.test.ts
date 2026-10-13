import crypto from "crypto";
import { DocumentExtractionStatus, PrismaClient } from "@prisma/client";
import { DocumentExtractionService } from "../document-extraction.service";
import { computeSha256 } from "../document-parser";
import { ProjectService } from "../project-service";
import * as uploadService from "../upload.service";

const databaseUrl = process.env.DATABASE_URL;
const isolatedSchema = databaseUrl ? new URL(databaseUrl).searchParams.get("schema") : null;
if (!isolatedSchema?.startsWith("planning_checkpoint_document_evidence_")) {
  throw new Error("Document evidence integration requires an isolated local test schema");
}

jest.mock("../upload.service", () => ({
  createEvidenceSnapshot: jest.fn(),
  fetchFromS3: jest.fn(),
  deleteFromS3: jest.fn().mockResolvedValue(undefined),
}));

const prisma = new PrismaClient();
const userId = `evidence-user-${crypto.randomUUID()}`;
const projectA = `evidence-a-${crypto.randomUUID()}`;
const projectB = `evidence-b-${crypto.randomUUID()}`;

function pdfBytes(text: string): Promise<Buffer> {
  const PDFDocument = require("pdfkit");
  return new Promise((resolve, reject) => {
    const document = new PDFDocument();
    const chunks: Buffer[] = [];
    document.on("data", (chunk: Buffer) => chunks.push(chunk));
    document.on("end", () => resolve(Buffer.concat(chunks)));
    document.on("error", reject);
    document.text(text);
    document.end();
  });
}

async function fileAndSource(projectId: string, bytes: Buffer = Buffer.from("source bytes")) {
  const file = await prisma.projectFile.create({
    data: { projectId, name: "source.pdf", type: "application/pdf", s3Key: `projects/${projectId}/${crypto.randomUUID()}.pdf` },
  });
  const source = await prisma.documentSource.create({
    data: {
      projectId, projectFileId: file.id, originalFilename: file.name,
      mimeType: file.type, s3Key: `projects/${projectId}/document-evidence/${crypto.randomUUID()}`,
      sourceVersion: 1, byteSize: bytes.length, contentHash: computeSha256(bytes),
    },
  });
  return { file, source };
}

async function unregisteredFile(projectId: string) {
  return prisma.projectFile.create({
    data: { projectId, name: "intake.pdf", type: "application/pdf",
      s3Key: `projects/${projectId}/${crypto.randomUUID()}.pdf` },
  });
}

describe("Document evidence with real isolated PostgreSQL", () => {
  beforeAll(async () => {
    await prisma.user.create({ data: { id: userId, email: `${userId}@anka.test`, password: "not-used" } });
    await prisma.project.createMany({ data: [
      { id: projectA, name: "Evidence A", userId },
      { id: projectB, name: "Evidence B", userId },
    ] });
  });

  beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    jest.spyOn(DocumentExtractionService, "triggerRun").mockImplementation(() => undefined);
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  test("overlapping retries accept one attempt and preserve failed history", async () => {
    const { file, source } = await fileAndSource(projectA);
    await prisma.documentExtractionRun.create({
      data: { projectId: projectA, sourceId: source.id, attempt: 1, status: "FAILED", parser: "test" },
    });
    const replies = await Promise.all(Array.from({ length: 16 }, () =>
      DocumentExtractionService.retryExtraction(projectA, file.id, userId),
    ));
    expect(replies.every((reply) => reply.currentAttempt === 2)).toBe(true);
    const runs = await prisma.documentExtractionRun.findMany({
      where: { sourceId: source.id }, orderBy: { attempt: "asc" },
    });
    expect(runs.map((run) => [run.attempt, run.status])).toEqual([
      [1, "FAILED"], [2, "PENDING"],
    ]);
    await prisma.projectFile.delete({ where: { id: file.id } });
  });

  test("snapshot failure is durable, repeated confirmation is inert, and retry registers one source", async () => {
    const file = await unregisteredFile(projectA);
    expect(await DocumentExtractionService.getExtractionSummary(projectA, file.id))
      .toMatchObject({ registrationStatus: "NOT_PROCESSED", status: null, canRetry: true });
    const snapshot = `projects/${projectA}/document-evidence/${crypto.randomUUID()}`;
    const copy = jest.spyOn(uploadService, "createEvidenceSnapshot")
      .mockRejectedValueOnce(Object.assign(new Error("provider detail"), { code: "ServiceUnavailable" }))
      .mockResolvedValue(snapshot);
    expect(await DocumentExtractionService.registerAndTriggerExtraction(file)).toBeNull();
    expect(await DocumentExtractionService.registerAndTriggerExtraction(file)).toBeNull();
    expect(copy).toHaveBeenCalledTimes(1);
    const failed = await DocumentExtractionService.getExtractionSummary(projectA, file.id);
    expect(failed).toMatchObject({ registrationStatus: "FAILED", status: null,
      errorCode: "SNAPSHOT_FAILED", canRetry: true });
    expect(failed.errorMessage).not.toContain("provider detail");
    expect(await prisma.documentSource.count({ where: { projectFileId: file.id } })).toBe(0);
    expect(await prisma.documentExtractionRun.count({ where: { projectId: projectA } })).toBe(0);

    const recovered = await DocumentExtractionService.retryExtraction(projectA, file.id, userId);
    expect(recovered).toMatchObject({ registrationStatus: "REGISTERED", status: "PENDING", currentAttempt: 1 });
    const source = await prisma.documentSource.findUniqueOrThrow({ where: { projectFileId: file.id } });
    expect(source.s3Key).toBe(snapshot);
    expect(source.s3Key).not.toBe(file.s3Key);
    expect(await prisma.documentRegistrationAttempt.findMany({
      where: { projectFileId: file.id }, orderBy: { attempt: "asc" },
    })).toEqual(expect.arrayContaining([
      expect.objectContaining({ attempt: 1, status: "FAILED", errorCode: "SNAPSHOT_FAILED" }),
      expect.objectContaining({ attempt: 2, status: "REGISTERED" }),
    ]));
    expect(await DocumentExtractionService.registerAndTriggerExtraction(file)).toMatchObject({ sourceId: source.id });
    expect(copy).toHaveBeenCalledTimes(2);
    await prisma.projectFile.delete({ where: { id: file.id } });
  });

  test("repeated upload confirmation resolves to the same ProjectFile", async () => {
    const storageKey = `projects/${projectA}/${crypto.randomUUID()}.pdf`;
    const service = new ProjectService();
    const first = await service.createFile({ projectId: projectA, name: "confirmed.pdf",
      type: "application/pdf", s3Key: storageKey, confirmedUploadKey: storageKey }, userId);
    const again = await service.createFile({ projectId: projectA, name: "different.pdf",
      type: "application/pdf", s3Key: storageKey, confirmedUploadKey: storageKey }, userId);
    expect(again.id).toBe(first.id);
    expect(again.name).toBe("confirmed.pdf");
    const simultaneous = await Promise.all(Array.from({ length: 8 }, () =>
      service.createFile({ projectId: projectA, name: "different.pdf", type: "application/pdf",
        s3Key: storageKey, confirmedUploadKey: storageKey }, userId)));
    expect(simultaneous.every((file) => file.id === first.id)).toBe(true);
    expect(await prisma.projectFile.count({ where: { confirmedUploadKey: storageKey } })).toBe(1);
    await prisma.projectFile.delete({ where: { id: first.id } });
  });

  test("concurrent registration retries claim one snapshot and one initial run", async () => {
    const file = await unregisteredFile(projectA);
    let releaseCopy!: (key: string) => void;
    const copyStarted = new Promise<void>((resolve) => {
      jest.spyOn(uploadService, "createEvidenceSnapshot").mockImplementation(() => {
        resolve();
        return new Promise<string>((release) => { releaseCopy = release; });
      });
    });
    const first = DocumentExtractionService.retryExtraction(projectA, file.id, userId);
    await copyStarted;
    const others = Promise.all(Array.from({ length: 8 }, () =>
      DocumentExtractionService.retryExtraction(projectA, file.id, userId)));
    const inFlight = await DocumentExtractionService.getExtractionSummary(projectA, file.id);
    expect(inFlight.registrationStatus).toBe("PROCESSING");
    releaseCopy(`projects/${projectA}/document-evidence/${crypto.randomUUID()}`);
    await Promise.all([first, others]);
    expect(uploadService.createEvidenceSnapshot).toHaveBeenCalledTimes(1);
    expect(await prisma.documentSource.count({ where: { projectFileId: file.id } })).toBe(1);
    const source = await prisma.documentSource.findUniqueOrThrow({ where: { projectFileId: file.id } });
    expect(await prisma.documentExtractionRun.count({ where: { sourceId: source.id } })).toBe(1);
    await prisma.projectFile.delete({ where: { id: file.id } });
  });

  test("missing original is diagnosed and failed registration history survives restart and retry", async () => {
    const file = await unregisteredFile(projectA);
    jest.spyOn(uploadService, "createEvidenceSnapshot")
      .mockRejectedValueOnce(Object.assign(new Error("s3 key detail"), { name: "NoSuchKey" }))
      .mockRejectedValueOnce(new Error("still unavailable"));
    await DocumentExtractionService.registerAndTriggerExtraction(file);
    const first = await DocumentExtractionService.getExtractionSummary(projectA, file.id);
    expect(first).toMatchObject({ registrationStatus: "FAILED", errorCode: "ORIGINAL_OBJECT_MISSING" });
    expect(first.errorMessage).not.toContain("s3 key detail");
    await DocumentExtractionService.reconcileOnStartup();
    expect((await DocumentExtractionService.getExtractionSummary(projectA, file.id)).errorCode)
      .toBe("ORIGINAL_OBJECT_MISSING");
    await DocumentExtractionService.retryExtraction(projectA, file.id, userId);
    const attempts = await prisma.documentRegistrationAttempt.findMany({
      where: { projectFileId: file.id }, orderBy: { attempt: "asc" },
    });
    expect(attempts.map((attempt) => [attempt.attempt, attempt.errorCode])).toEqual([
      [1, "ORIGINAL_OBJECT_MISSING"], [2, "SNAPSHOT_FAILED"],
    ]);
    await prisma.projectFile.delete({ where: { id: file.id } });
  });

  test("restart turns interrupted registration into a persistent retryable failure", async () => {
    const file = await unregisteredFile(projectA);
    await prisma.documentRegistrationAttempt.create({
      data: { projectId: projectA, projectFileId: file.id, attempt: 1 },
    });
    await DocumentExtractionService.reconcileOnStartup();
    expect(await DocumentExtractionService.getExtractionSummary(projectA, file.id))
      .toMatchObject({ registrationStatus: "FAILED", errorCode: "REGISTRATION_INTERRUPTED" });
    jest.spyOn(uploadService, "createEvidenceSnapshot")
      .mockResolvedValue(`projects/${projectA}/document-evidence/${crypto.randomUUID()}`);
    expect((await DocumentExtractionService.retryExtraction(projectA, file.id, userId)).status).toBe("PENDING");
    await prisma.projectFile.delete({ where: { id: file.id } });
  });

  test("source, run and span relations cascade from ProjectFile", async () => {
    const { file, source } = await fileAndSource(projectA);
    const run = await prisma.documentExtractionRun.create({
      data: { projectId: projectA, sourceId: source.id, attempt: 1, status: "READY", parser: "test" },
    });
    await prisma.evidenceSpan.create({
      data: { projectId: projectA, sourceId: source.id, extractionRunId: run.id,
        ordinal: 1, locatorType: "PDF_PAGE", pageNumber: 1, text: "evidence", textHash: computeSha256(Buffer.from("evidence")) },
    });
    const evidence = await DocumentExtractionService.getEvidenceSpans(projectA, file.id);
    expect(evidence.spans).toHaveLength(1);
    expect(evidence.spans[0].contentHash).toBe(source.contentHash);
    await prisma.projectFile.delete({ where: { id: file.id } });
    expect(await prisma.documentSource.count({ where: { id: source.id } })).toBe(0);
    expect(await prisma.documentExtractionRun.count({ where: { id: run.id } })).toBe(0);
    expect(await prisma.evidenceSpan.count({ where: { extractionRunId: run.id } })).toBe(0);
  });

  test("cross-project retry and evidence reject before storage and mutation", async () => {
    const { file, source } = await fileAndSource(projectB);
    await expect(DocumentExtractionService.retryExtraction(projectA, file.id, userId)).rejects.toThrow("File not found");
    await expect(DocumentExtractionService.getEvidenceSpans(projectA, file.id)).rejects.toThrow("File not found");
    expect(uploadService.fetchFromS3).not.toHaveBeenCalled();
    expect(await prisma.documentExtractionRun.count({ where: { sourceId: source.id } })).toBe(0);
    await prisma.projectFile.delete({ where: { id: file.id } });
  });

  test("cross-project registration retry is denied before snapshot access", async () => {
    const file = await unregisteredFile(projectB);
    const copy = jest.spyOn(uploadService, "createEvidenceSnapshot");
    await expect(DocumentExtractionService.retryExtraction(projectA, file.id, userId)).rejects.toThrow("File not found");
    expect(copy).not.toHaveBeenCalled();
    expect(await prisma.documentRegistrationAttempt.count({ where: { projectFileId: file.id } })).toBe(0);
    await prisma.projectFile.delete({ where: { id: file.id } });
  });

  test("two execution claims cannot process one attempt twice", async () => {
    const { file, source } = await fileAndSource(projectA);
    const run = await prisma.documentExtractionRun.create({
      data: { projectId: projectA, sourceId: source.id, attempt: 1, parser: "test" },
    });
    jest.spyOn(uploadService, "fetchFromS3").mockRejectedValue(new Error("transient storage failure"));
    await Promise.all([
      DocumentExtractionService.executeRun(run.id),
      DocumentExtractionService.executeRun(run.id),
    ]);
    expect(uploadService.fetchFromS3).toHaveBeenCalledTimes(1);
    const stored = await prisma.documentExtractionRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(stored.status).toBe(DocumentExtractionStatus.FAILED);
    await prisma.projectFile.delete({ where: { id: file.id } });
  });

  test("source hash remains unchanged after different bytes on retry", async () => {
    const bytes = Buffer.from("original bytes");
    const { file, source } = await fileAndSource(projectA, bytes);
    const run = await prisma.documentExtractionRun.create({
      data: { projectId: projectA, sourceId: source.id, attempt: 1, parser: "test" },
    });
    jest.spyOn(uploadService, "fetchFromS3").mockResolvedValue({ buffer: Buffer.from("changed bytes"), byteSize: 13 });
    await DocumentExtractionService.executeRun(run.id);
    const storedSource = await prisma.documentSource.findUniqueOrThrow({ where: { id: source.id } });
    const storedRun = await prisma.documentExtractionRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(storedSource.contentHash).toBe(computeSha256(bytes));
    expect(storedRun.status).toBe(DocumentExtractionStatus.FAILED);
    expect(storedRun.errorCode).toBe("SOURCE_CHANGED");
    expect(await prisma.evidenceSpan.count({ where: { extractionRunId: run.id } })).toBe(0);
    await prisma.projectFile.delete({ where: { id: file.id } });
  });

  test("span insertion failure rolls back READY and leaves no partial evidence", async () => {
    const bytes = await pdfBytes("Evidence span insertion must be atomic.");
    const { file, source } = await fileAndSource(projectA, bytes);
    const run = await prisma.documentExtractionRun.create({
      data: { projectId: projectA, sourceId: source.id, attempt: 1, parser: "test" },
    });
    jest.spyOn(uploadService, "fetchFromS3").mockResolvedValue({ buffer: bytes, byteSize: bytes.length });
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION fail_document_evidence_insert() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'injected span insertion failure'; END;
      $$ LANGUAGE plpgsql
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER fail_document_evidence_insert
      BEFORE INSERT ON evidence_spans FOR EACH ROW
      EXECUTE FUNCTION fail_document_evidence_insert()
    `);
    try {
      await DocumentExtractionService.executeRun(run.id);
      const stored = await prisma.documentExtractionRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(stored.status).toBe(DocumentExtractionStatus.FAILED);
      expect(await prisma.evidenceSpan.count({ where: { extractionRunId: run.id } })).toBe(0);
    } finally {
      await prisma.$executeRawUnsafe("DROP TRIGGER IF EXISTS fail_document_evidence_insert ON evidence_spans");
      await prisma.$executeRawUnsafe("DROP FUNCTION IF EXISTS fail_document_evidence_insert()");
    }
    await prisma.projectFile.delete({ where: { id: file.id } });
  });

  test("startup drains 120 persisted pending attempts without automatic failed retries", async () => {
    const { file, source } = await fileAndSource(projectA);
    await prisma.documentExtractionRun.createMany({
      data: Array.from({ length: 120 }, (_, index) => ({
        projectId: projectA, sourceId: source.id, attempt: index + 1,
        status: DocumentExtractionStatus.PENDING, parser: "test",
      })),
    });
    (DocumentExtractionService.triggerRun as jest.Mock).mockRestore();
    const processed = new Set<string>();
    jest.spyOn(DocumentExtractionService, "executeRun").mockImplementation(async (id) => {
      const claim = await prisma.documentExtractionRun.updateMany({
        where: { id, status: DocumentExtractionStatus.PENDING },
        data: { status: DocumentExtractionStatus.FAILED },
      });
      if (claim.count === 1) processed.add(id);
    });
    const recovery = await DocumentExtractionService.reconcileOnStartup();
    expect(recovery.recovered).toBeGreaterThanOrEqual(120);
    for (let tick = 0; processed.size < 120 && tick < 400; tick++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    expect(processed.size).toBe(120);
    expect(await prisma.documentExtractionRun.count({
      where: { sourceId: source.id, status: DocumentExtractionStatus.PENDING },
    })).toBe(0);
    await prisma.projectFile.delete({ where: { id: file.id } });
  }, 30000);
});
