-- CreateEnum
CREATE TYPE "DocumentExtractionStatus" AS ENUM ('PENDING', 'PROCESSING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "EvidenceLocatorType" AS ENUM ('PDF_PAGE', 'DOCX_PARAGRAPH');

-- CreateTable
CREATE TABLE "document_sources" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "projectFileId" TEXT NOT NULL,
    "sourceVersion" INTEGER NOT NULL DEFAULT 1,
    "originalFilename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "s3Key" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_extraction_runs" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "status" "DocumentExtractionStatus" NOT NULL DEFAULT 'PENDING',
    "parser" TEXT NOT NULL,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_extraction_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evidence_spans" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "extractionRunId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "locatorType" "EvidenceLocatorType" NOT NULL,
    "pageNumber" INTEGER,
    "paragraphNumber" INTEGER,
    "startOffset" INTEGER,
    "endOffset" INTEGER,
    "text" TEXT NOT NULL,
    "textHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evidence_spans_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "document_sources_projectFileId_key" ON "document_sources"("projectFileId");

-- CreateIndex
CREATE INDEX "document_sources_projectId_idx" ON "document_sources"("projectId");

-- CreateIndex
CREATE INDEX "document_extraction_runs_projectId_idx" ON "document_extraction_runs"("projectId");

-- CreateIndex
CREATE INDEX "document_extraction_runs_sourceId_idx" ON "document_extraction_runs"("sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "document_extraction_runs_sourceId_attempt_key" ON "document_extraction_runs"("sourceId", "attempt");

-- CreateIndex
CREATE INDEX "evidence_spans_projectId_idx" ON "evidence_spans"("projectId");

-- CreateIndex
CREATE INDEX "evidence_spans_sourceId_idx" ON "evidence_spans"("sourceId");

-- CreateIndex
CREATE INDEX "evidence_spans_extractionRunId_idx" ON "evidence_spans"("extractionRunId");

-- CreateIndex
CREATE UNIQUE INDEX "evidence_spans_extractionRunId_ordinal_key" ON "evidence_spans"("extractionRunId", "ordinal");

-- AddForeignKey
ALTER TABLE "document_sources" ADD CONSTRAINT "document_sources_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_sources" ADD CONSTRAINT "document_sources_projectFileId_fkey" FOREIGN KEY ("projectFileId") REFERENCES "project_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_extraction_runs" ADD CONSTRAINT "document_extraction_runs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_extraction_runs" ADD CONSTRAINT "document_extraction_runs_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "document_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_spans" ADD CONSTRAINT "evidence_spans_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_spans" ADD CONSTRAINT "evidence_spans_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "document_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_spans" ADD CONSTRAINT "evidence_spans_extractionRunId_fkey" FOREIGN KEY ("extractionRunId") REFERENCES "document_extraction_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
