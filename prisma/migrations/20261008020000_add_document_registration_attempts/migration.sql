CREATE TYPE "DocumentRegistrationStatus" AS ENUM ('PROCESSING', 'FAILED', 'REGISTERED');

ALTER TABLE "project_files" ADD COLUMN "confirmedUploadKey" TEXT;
CREATE UNIQUE INDEX "project_files_confirmedUploadKey_key" ON "project_files"("confirmedUploadKey");

CREATE TABLE "document_registration_attempts" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "projectFileId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "status" "DocumentRegistrationStatus" NOT NULL DEFAULT 'PROCESSING',
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "document_registration_attempts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "document_registration_attempts_projectFileId_attempt_key" ON "document_registration_attempts"("projectFileId", "attempt");
CREATE INDEX "document_registration_attempts_projectId_idx" ON "document_registration_attempts"("projectId");

ALTER TABLE "document_registration_attempts" ADD CONSTRAINT "document_registration_attempts_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "document_registration_attempts" ADD CONSTRAINT "document_registration_attempts_projectFileId_fkey" FOREIGN KEY ("projectFileId") REFERENCES "project_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;
