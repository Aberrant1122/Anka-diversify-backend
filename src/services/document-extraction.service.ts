import { prisma } from "./database";
import { createEvidenceSnapshot, deleteFromS3, fetchFromS3 } from "./upload.service";
import {
  detectEvidenceFormat,
  isSupportedEvidenceDocument,
  parseDocumentEvidence,
  computeSha256,
  MAX_EXTRACTION_BYTES,
} from "./document-parser";
import { DocumentExtractionStatus, DocumentRegistrationStatus, EvidenceLocatorType, Prisma } from "@prisma/client";
import { PlanningAuthorizationService } from "./planning-authorization.service";

const authorization = new PlanningAuthorizationService(prisma);

export interface DocumentExtractionSummary {
  eligible: boolean;
  registrationStatus?: "NOT_PROCESSED" | DocumentRegistrationStatus;
  registrationAttempt?: number | null;
  canRetry?: boolean;
  sourceId?: string | null;
  sourceVersion?: number | null;
  contentHash?: string | null;
  status?: DocumentExtractionStatus | null;
  currentAttempt?: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  passageCount: number;
}

export interface PaginatedEvidenceResult {
  spans: Array<{
    id: string;
    ordinal: number;
    text: string;
    locatorType: EvidenceLocatorType;
    pageNumber: number | null;
    paragraphNumber: number | null;
    startOffset: number | null;
    endOffset: number | null;
    sourceId: string;
    sourceVersion: number;
    contentHash: string;
  }>;
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasMore: boolean;
}

export function sanitizeErrorMessage(error: any): string {
  if (error?.code === "DOCUMENT_TOO_LARGE") {
    return "Document exceeds the maximum supported extraction size of 20 MB.";
  }
  if (error?.code === "DOCUMENT_EXCEEDS_PAGE_LIMIT") {
    return "PDF document exceeds the maximum page limit (1000 pages).";
  }
  if (error?.code === "INVALID_DOCUMENT_SIGNATURE") {
    return "The uploaded file does not match a valid PDF or DOCX binary signature.";
  }
  if (error?.code === "NO_EXTRACTABLE_TEXT") {
    return "No extractable text was found in the document.";
  }
  if (error?.code === "MALFORMED_PDF") {
    return "The PDF file is corrupted or could not be parsed.";
  }
  if (error?.code === "MALFORMED_DOCX") {
    return "The DOCX file is corrupted or could not be parsed.";
  }
  if (error?.code === "INTERRUPTED_BY_RESTART") {
    return "Extraction was interrupted by server restart. Please retry.";
  }
  if (error?.code === "SOURCE_CHANGED") {
    return "The stored document no longer matches its confirmed source. Please upload it again.";
  }
  if (error?.code === "SOURCE_NOT_FROZEN") {
    return "This document predates protected source storage. Please upload it again.";
  }
  if (error?.code === "NoSuchKey" || error?.code === "NotFound") {
    return "The original uploaded document is missing from storage. Please upload it again.";
  }
  return "Document extraction encountered an unexpected processing error. Please retry.";
}

function registrationError(error: unknown): { errorCode: string; errorMessage: string } {
  const storageError = error as { code?: unknown; name?: unknown } | null;
  const code = storageError?.code || storageError?.name;
  if (code === "NoSuchKey" || code === "NotFound") {
    return { errorCode: "ORIGINAL_OBJECT_MISSING", errorMessage: "The original uploaded document is missing from storage. Please upload it again." };
  }
  return { errorCode: "SNAPSHOT_FAILED", errorMessage: "We could not preserve this document for processing. Please retry processing." };
}

export class DocumentExtractionService {
  private static draining = false;
  private static drainRequested = false;
  private static readonly WORKER_COUNT = 4;

  /**
   * Deterministic eligibility check for evidence extraction.
   */
  static isEligible(filename: string, mimetype?: string): boolean {
    return isSupportedEvidenceDocument(filename, mimetype);
  }

  /**
   * Registers a DocumentSource and an initial PENDING extraction run if the ProjectFile
   * is eligible. Does not block upload confirmation.
   */
  static async registerAndTriggerExtraction(projectFile: {
    id: string;
    projectId: string;
    name: string;
    type?: string;
    s3Key?: string | null;
  }, retryRegistration = false): Promise<{ sourceId: string; runId: string } | null> {
    if (!projectFile.s3Key || !this.isEligible(projectFile.name, projectFile.type)) {
      return null;
    }

    // A ProjectFile row lock serializes registration claims across processes.
    // No transaction is held while S3 copies bytes.
    const claim = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM project_files WHERE id = ${projectFile.id} AND "projectId" = ${projectFile.projectId} FOR UPDATE`;
      const existing = await tx.documentSource.findUnique({ where: { projectFileId: projectFile.id } });
      if (existing) return null;
      const latest = await tx.documentRegistrationAttempt.findFirst({
        where: { projectFileId: projectFile.id }, orderBy: { attempt: "desc" },
      });
      if (latest?.status === DocumentRegistrationStatus.PROCESSING ||
          (latest?.status === DocumentRegistrationStatus.FAILED && !retryRegistration)) return null;
      return tx.documentRegistrationAttempt.create({
        data: { projectId: projectFile.projectId, projectFileId: projectFile.id,
          attempt: (latest?.attempt || 0) + 1, status: DocumentRegistrationStatus.PROCESSING },
      });
    });

    let source = await prisma.documentSource.findUnique({
      where: { projectFileId: projectFile.id },
    });

    if (!source && claim) {
      // The presigned PUT remains replayable for its lifetime. Evidence always reads
      // this server-owned copy, whose key is never exposed to the browser.
      let snapshotKey: string | null = null;
      try {
        snapshotKey = await createEvidenceSnapshot(projectFile.projectId, projectFile.s3Key);
        const created = await prisma.$transaction(async (tx) => {
          const frozen = await tx.documentSource.create({
            data: {
              projectId: projectFile.projectId, projectFileId: projectFile.id,
              sourceVersion: 1, originalFilename: projectFile.name,
              mimeType: projectFile.type || "application/octet-stream",
              s3Key: snapshotKey!, byteSize: 0, contentHash: "",
            },
          });
          const run = await tx.documentExtractionRun.create({
            data: { projectId: projectFile.projectId, sourceId: frozen.id,
              attempt: 1, status: DocumentExtractionStatus.PENDING, parser: "anka-document-parser-v1" },
          });
          await tx.documentRegistrationAttempt.update({
            where: { id: claim.id },
            data: { status: DocumentRegistrationStatus.REGISTERED, completedAt: new Date() },
          });
          return { source: frozen, run };
        });
        this.triggerRun(created.run.id);
        return { sourceId: created.source.id, runId: created.run.id };
      } catch (error) {
        if (snapshotKey) {
          try { await deleteFromS3(snapshotKey); }
          catch (cleanupError) {
            console.error("Evidence snapshot cleanup failed:", registrationError(cleanupError).errorCode);
          }
        }
        const diagnostic = snapshotKey
          ? { errorCode: "REGISTRATION_PERSIST_FAILED",
              errorMessage: "We could not finish registering this document. Please retry processing." }
          : registrationError(error);
        await prisma.documentRegistrationAttempt.update({
          where: { id: claim.id },
          data: { status: DocumentRegistrationStatus.FAILED, ...diagnostic, completedAt: new Date() },
        });
        console.error("Evidence registration failed:", diagnostic.errorCode);
        return null;
      }
    }

    if (!source) return null;

    // Repeated confirmation never acts as a retry, including after failure.
    const lastRun = await prisma.documentExtractionRun.findFirst({
      where: { sourceId: source.id },
      orderBy: { attempt: "desc" },
    });
    if (lastRun) {
      if (lastRun.status === DocumentExtractionStatus.PENDING) this.triggerRun(lastRun.id);
      return { sourceId: source.id, runId: lastRun.id };
    }

    let run;
    try {
      run = await prisma.documentExtractionRun.create({
        data: {
          projectId: projectFile.projectId,
          sourceId: source.id,
          attempt: 1,
          status: DocumentExtractionStatus.PENDING,
          parser: "anka-document-parser-v1",
        },
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
      run = await prisma.documentExtractionRun.findFirst({
        where: { sourceId: source.id }, orderBy: { attempt: "desc" },
      });
      if (!run) throw error;
    }

    // Schedule extraction worker in background
    this.triggerRun(run.id);

    return { sourceId: source.id, runId: run.id };
  }

  /**
   * Schedules execution of a specific run asynchronously.
   */
  static triggerRun(_runId: string): void {
    this.drainRequested = true;
    if (this.draining) return;
    this.draining = true;
    setImmediate(() => {
      this.drainPendingRuns().catch((error) => {
        console.error("[Extraction Worker Error]:", error instanceof Error ? error.message : error);
      });
    });
  }

  /** At most four workers claim oldest PENDING attempts until the backlog is empty. */
  private static async drainPendingRuns(): Promise<void> {
    try {
      do {
        this.drainRequested = false;
        await Promise.all(Array.from({ length: this.WORKER_COUNT }, async () => {
          while (true) {
            const next = await prisma.documentExtractionRun.findFirst({
              where: { status: DocumentExtractionStatus.PENDING },
              orderBy: [{ createdAt: "asc" }, { id: "asc" }],
              select: { id: true },
            });
            if (!next) return;
            await this.executeRun(next.id);
          }
        }));
      } while (this.drainRequested);
    } finally {
      this.draining = false;
      if (this.drainRequested) this.triggerRun("");
    }
  }

  /**
   * Deterministic claiming and execution worker for an extraction run.
   */
  static async executeRun(runId: string): Promise<void> {
    // Atomic state claim: only one worker can claim a PENDING run
    const claim = await prisma.documentExtractionRun.updateMany({
      where: {
        id: runId,
        status: DocumentExtractionStatus.PENDING,
      },
      data: {
        status: DocumentExtractionStatus.PROCESSING,
        startedAt: new Date(),
      },
    });

    if (claim.count === 0) {
      // Already claimed or not in PENDING status
      return;
    }

    const run = await prisma.documentExtractionRun.findUnique({
      where: { id: runId },
      include: { source: true },
    });

    if (!run || !run.source) {
      return;
    }

    try {
      if (!run.source.s3Key.startsWith(`projects/${run.projectId}/document-evidence/`)) {
        const error = new Error("Evidence source has no server-owned snapshot");
        (error as Error & { code?: string }).code = "SOURCE_NOT_FROZEN";
        throw error;
      }
      // 1. Fetch bounded bytes from S3
      const { buffer, byteSize } = await fetchFromS3(run.source.s3Key, MAX_EXTRACTION_BYTES);

      // 2. Compute SHA-256 hash
      const contentHash = computeSha256(buffer);

      // Initialize the source hash once. Subsequent attempts must match exactly.
      const initialized = await prisma.documentSource.updateMany({
        where: { id: run.sourceId, contentHash: "" },
        data: { byteSize, contentHash },
      });
      if (initialized.count === 0) {
        const stored = await prisma.documentSource.findUnique({ where: { id: run.sourceId } });
        if (!stored || stored.contentHash !== contentHash || stored.byteSize !== byteSize) {
          const error = new Error("Stored evidence source changed");
          (error as Error & { code?: string }).code = "SOURCE_CHANGED";
          throw error;
        }
      }

      // 4. Detect format
      const format = detectEvidenceFormat(run.source.originalFilename, run.source.mimeType);
      if (!format) {
        const err = new Error("Unsupported document format for extraction");
        (err as any).code = "UNSUPPORTED_FORMAT";
        throw err;
      }

      // 5. Parse evidence spans
      const spans = await parseDocumentEvidence(buffer, format);

      // 6. Atomically persist evidence spans and transition run to READY
      await prisma.$transaction(async (tx) => {
        // Clear any spans for this specific run attempt if re-run
        await tx.evidenceSpan.deleteMany({
          where: { extractionRunId: run.id },
        });

        if (spans.length > 0) {
          await tx.evidenceSpan.createMany({
            data: spans.map((s) => ({
              projectId: run.projectId,
              sourceId: run.sourceId,
              extractionRunId: run.id,
              ordinal: s.ordinal,
              locatorType: s.locatorType,
              pageNumber: s.pageNumber,
              paragraphNumber: s.paragraphNumber,
              startOffset: s.startOffset,
              endOffset: s.endOffset,
              text: s.text,
              textHash: s.textHash,
            })),
          });
        }

        const completed = await tx.documentExtractionRun.updateMany({
          where: { id: run.id, status: DocumentExtractionStatus.PROCESSING },
          data: {
            status: DocumentExtractionStatus.READY,
            completedAt: new Date(),
            errorCode: null,
            errorMessage: null,
          },
        });
        if (completed.count !== 1) throw new Error("Extraction attempt is no longer active");
      });
    } catch (error: any) {
      const errorCode = error?.code || "EXTRACTION_FAILED";
      const errorMessage = sanitizeErrorMessage(error);

      await prisma.documentExtractionRun.updateMany({
        where: { id: runId, status: DocumentExtractionStatus.PROCESSING },
        data: {
          status: DocumentExtractionStatus.FAILED,
          errorCode,
          errorMessage,
          completedAt: new Date(),
        },
      });
    }
  }

  /**
   * Retries extraction for a ProjectFile idempotently.
   */
  static async retryExtraction(
    projectId: string,
    fileId: string,
    actorId: string,
  ): Promise<DocumentExtractionSummary> {
    await authorization.assertCanEdit(projectId, actorId);
    const file = await prisma.projectFile.findFirst({
      where: { id: fileId, projectId },
    });

    if (!file) {
      throw new Error("File not found");
    }

    if (!this.isEligible(file.name, file.type)) {
      const err = new Error("File is not an eligible document for extraction");
      (err as any).statusCode = 400;
      throw err;
    }

    let source = await prisma.documentSource.findUnique({
      where: { projectFileId: file.id },
    });

    if (!source) {
      if (!file.s3Key) {
        const err = new Error("File has no storage key");
        (err as any).statusCode = 400;
        throw err;
      }
      await this.registerAndTriggerExtraction(file, true);
      source = await prisma.documentSource.findUnique({ where: { projectFileId: file.id } });
      if (!source) return this.getExtractionSummary(projectId, fileId);
    }

    // PostgreSQL row lock serializes the read of the latest attempt and its
    // successor creation across requests and server processes.
    let runId: string | null = null;
    try {
      runId = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM document_sources WHERE id = ${source.id} FOR UPDATE`;
        const latestRun = await tx.documentExtractionRun.findFirst({
          where: { sourceId: source.id },
          orderBy: { attempt: "desc" },
        });
        if (latestRun && latestRun.status !== DocumentExtractionStatus.FAILED) {
          return latestRun.status === DocumentExtractionStatus.PENDING ? latestRun.id : null;
        }
        const created = await tx.documentExtractionRun.create({
          data: {
            projectId,
            sourceId: source.id,
            attempt: (latestRun?.attempt || 0) + 1,
            status: DocumentExtractionStatus.PENDING,
            parser: "anka-document-parser-v1",
          },
        });
        return created.id;
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
      const winner = await prisma.documentExtractionRun.findFirst({
        where: { sourceId: source.id }, orderBy: { attempt: "desc" },
      });
      if (!winner) throw error;
      runId = winner.status === DocumentExtractionStatus.PENDING ? winner.id : null;
    }
    if (runId) this.triggerRun(runId);

    return this.getExtractionSummary(projectId, fileId);
  }

  /**
   * Retrieves summary extraction metadata for a ProjectFile.
   */
  static async getExtractionSummary(
    projectId: string,
    fileId: string
  ): Promise<DocumentExtractionSummary> {
    const file = await prisma.projectFile.findFirst({
      where: { id: fileId, projectId },
    });

    if (!file) {
      throw new Error("File not found");
    }

    const eligible = this.isEligible(file.name, file.type);
    if (!eligible) {
      return { eligible: false, passageCount: 0 };
    }

    const source = await prisma.documentSource.findUnique({
      where: { projectFileId: file.id },
      include: {
        extractionRuns: {
          orderBy: { attempt: "desc" },
          take: 1,
        },
      },
    });

    if (!source || source.extractionRuns.length === 0) {
      const registration = await prisma.documentRegistrationAttempt.findFirst({
        where: { projectFileId: file.id }, orderBy: { attempt: "desc" },
      });
      return {
        eligible: true,
        registrationStatus: source ? DocumentRegistrationStatus.REGISTERED : registration?.status || "NOT_PROCESSED",
        registrationAttempt: registration?.attempt || null,
        canRetry: Boolean(file.s3Key),
        sourceId: source?.id || null,
        sourceVersion: source?.sourceVersion || null,
        contentHash: source?.contentHash || null,
        status: null,
        errorCode: registration?.status === DocumentRegistrationStatus.FAILED ? registration.errorCode : null,
        errorMessage: registration?.status === DocumentRegistrationStatus.FAILED ? registration.errorMessage : null,
        passageCount: 0,
      };
    }

    const latestRun = source.extractionRuns[0];

    // If the latest run is READY, count its spans
    let passageCount = 0;
    if (latestRun.status === DocumentExtractionStatus.READY) {
      passageCount = await prisma.evidenceSpan.count({
        where: { extractionRunId: latestRun.id },
      });
    }

    return {
      eligible: true,
      registrationStatus: DocumentRegistrationStatus.REGISTERED,
      canRetry: true,
      sourceId: source.id,
      sourceVersion: source.sourceVersion,
      contentHash: source.contentHash || null,
      status: latestRun.status,
      currentAttempt: latestRun.attempt,
      errorCode: latestRun.errorCode,
      errorMessage: latestRun.errorMessage,
      startedAt: latestRun.startedAt?.toISOString() || null,
      completedAt: latestRun.completedAt?.toISOString() || null,
      passageCount,
    };
  }

  /**
   * Retrieves paginated evidence spans for a ProjectFile's active extraction run.
   */
  static async getEvidenceSpans(
    projectId: string,
    fileId: string,
    page: number = 1,
    limit: number = 50
  ): Promise<PaginatedEvidenceResult> {
    const boundedPage = Math.max(1, page);
    const boundedLimit = Math.min(100, Math.max(1, limit));

    const file = await prisma.projectFile.findFirst({
      where: { id: fileId, projectId },
    });

    if (!file) {
      throw new Error("File not found");
    }

    const source = await prisma.documentSource.findUnique({
      where: { projectFileId: file.id },
    });

    if (!source) {
      return {
        spans: [],
        total: 0,
        page: boundedPage,
        limit: boundedLimit,
        totalPages: 0,
        hasMore: false,
      };
    }

    // Find the latest READY run
    const readyRun = await prisma.documentExtractionRun.findFirst({
      where: {
        sourceId: source.id,
        status: DocumentExtractionStatus.READY,
      },
      orderBy: { attempt: "desc" },
    });

    if (!readyRun) {
      return {
        spans: [],
        total: 0,
        page: boundedPage,
        limit: boundedLimit,
        totalPages: 0,
        hasMore: false,
      };
    }

    const total = await prisma.evidenceSpan.count({
      where: { extractionRunId: readyRun.id },
    });

    const spans = await prisma.evidenceSpan.findMany({
      where: { extractionRunId: readyRun.id },
      orderBy: { ordinal: "asc" },
      skip: (boundedPage - 1) * boundedLimit,
      take: boundedLimit,
    });

    const totalPages = Math.ceil(total / boundedLimit);
    const hasMore = boundedPage < totalPages;

    return {
      spans: spans.map((s) => ({
        id: s.id,
        ordinal: s.ordinal,
        text: s.text,
        locatorType: s.locatorType,
        pageNumber: s.pageNumber,
        paragraphNumber: s.paragraphNumber,
        startOffset: s.startOffset,
        endOffset: s.endOffset,
        sourceId: source.id,
        sourceVersion: source.sourceVersion,
        contentHash: source.contentHash,
      })),
      total,
      page: boundedPage,
      limit: boundedLimit,
      totalPages,
      hasMore,
    };
  }

  /**
   * Single-extractor-process restart policy: every interrupted PROCESSING
   * attempt becomes FAILED and needs an explicit user retry. PENDING attempts
   * remain durable and drain oldest first. This policy is not a multi-instance
   * lease; a second live server must not call it during another's extraction.
   */
  static async reconcileOnStartup(): Promise<{ recovered: number; markedStale: number }> {
    await prisma.documentRegistrationAttempt.updateMany({
      where: { status: DocumentRegistrationStatus.PROCESSING },
      data: { status: DocumentRegistrationStatus.FAILED,
        errorCode: "REGISTRATION_INTERRUPTED",
        errorMessage: "Document registration was interrupted by server restart. Please retry processing.",
        completedAt: new Date() },
    });
    // 1. Stale runs currently PROCESSING from previous process
    const staleRuns = await prisma.documentExtractionRun.updateMany({
      where: {
        status: DocumentExtractionStatus.PROCESSING,
      },
      data: {
        status: DocumentExtractionStatus.FAILED,
        errorCode: "INTERRUPTED_BY_RESTART",
        errorMessage: "Extraction was interrupted by server restart. Please retry.",
        completedAt: new Date(),
      },
    });

    // All pending work is drained by the bounded worker pool, oldest first.
    const pendingCount = await prisma.documentExtractionRun.count({
      where: { status: DocumentExtractionStatus.PENDING },
    });
    if (pendingCount > 0) this.triggerRun("");

    return {
      recovered: pendingCount,
      markedStale: staleRuns.count,
    };
  }
}
