-- Checkpoint 1A: additive Requirements planning data foundation.
-- Existing string phase/status columns and the PhaseArtifact.approved flag remain
-- in place for compatibility until the application-service migration lands.

-- CreateEnum
CREATE TYPE "ArtifactChangeKind" AS ENUM (
    'INITIAL_GENERATION',
    'MANUAL_EDIT',
    'AI_DOCUMENT_REVISION',
    'AI_SECTION_REVISION',
    'AI_SECTION_REGENERATION',
    'FEEDBACK_APPLICATION',
    'IMPORT'
);

-- CreateEnum
CREATE TYPE "ArtifactActorType" AS ENUM ('HUMAN', 'AI', 'SYSTEM');

-- CreateEnum
CREATE TYPE "ArtifactLifecycleStatus" AS ENUM ('DRAFT', 'AWAITING_APPROVAL', 'APPROVED');

-- CreateEnum
CREATE TYPE "WorkflowOperation" AS ENUM (
    'INITIAL_GENERATION',
    'DOCUMENT_REVISION',
    'SECTION_REVISION',
    'SECTION_REGENERATION',
    'FEEDBACK_APPLICATION',
    'CHANGE_SUMMARIZATION',
    'APPROVAL_PREPARATION',
    'NEXT_PHASE_GENERATION',
    'LEGACY_PHASE_RUN'
);

-- AlterTable: project_phase_states
ALTER TABLE "project_phase_states"
ADD COLUMN "currentArtifactId" TEXT,
ADD COLUMN "approvalCandidateArtifactId" TEXT,
ADD COLUMN "currentApprovedArtifactId" TEXT,
ADD COLUMN "activeRunId" TEXT,
ADD COLUMN "stateVersion" INTEGER NOT NULL DEFAULT 0;

-- AlterTable: phase_artifacts
ALTER TABLE "phase_artifacts"
ADD COLUMN "structuredContent" JSONB,
ADD COLUMN "schemaVersion" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "contentHash" TEXT,
ADD COLUMN "previousVersionId" TEXT,
ADD COLUMN "basedOnArtifactId" TEXT,
ADD COLUMN "changeKind" "ArtifactChangeKind",
ADD COLUMN "createdByType" "ArtifactActorType",
ADD COLUMN "lifecycleStatus" "ArtifactLifecycleStatus" NOT NULL DEFAULT 'DRAFT',
ADD COLUMN "approvedAt" TIMESTAMP(3),
ADD COLUMN "supersededAt" TIMESTAMP(3);

-- Preserve the meaning of the legacy approved projection.
UPDATE "phase_artifacts"
SET "lifecycleStatus" = 'APPROVED',
    "approvedAt" = COALESCE("approvedAt", "createdAt")
WHERE "approved" = TRUE;

-- AlterTable: phase_approvals. artifactId remains nullable only so historical
-- decisions with no provable exact artifact can be retained as unverified.
ALTER TABLE "phase_approvals"
ADD COLUMN "artifactId" TEXT,
ADD COLUMN "artifactVersion" INTEGER,
ADD COLUMN "artifactContentHash" TEXT,
ADD COLUMN "legacyUnverified" BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE "phase_approvals"
SET "legacyUnverified" = TRUE
WHERE "artifactId" IS NULL;

-- AlterTable: workflow_runs
ALTER TABLE "workflow_runs"
ADD COLUMN "operation" "WorkflowOperation",
ADD COLUMN "baseArtifactId" TEXT,
ADD COLUMN "inputArtifactId" TEXT,
ADD COLUMN "outputArtifactId" TEXT,
ADD COLUMN "contextManifest" JSONB,
ADD COLUMN "contextHash" TEXT,
ADD COLUMN "targetSectionKey" TEXT,
ADD COLUMN "initiatedById" TEXT,
ADD COLUMN "initiatedByType" "ArtifactActorType",
ADD COLUMN "idempotencyKey" TEXT,
ADD COLUMN "errorCode" TEXT,
ADD COLUMN "errorMessage" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "phase_artifacts_projectId_phase_type_version_key"
ON "phase_artifacts"("projectId", "phase", "type", "version");

-- CreateIndex
CREATE INDEX "phase_artifacts_projectId_phase_type_createdAt_idx"
ON "phase_artifacts"("projectId", "phase", "type", "createdAt");

-- CreateIndex
CREATE INDEX "phase_artifacts_previousVersionId_idx" ON "phase_artifacts"("previousVersionId");

-- CreateIndex
CREATE INDEX "phase_artifacts_basedOnArtifactId_idx" ON "phase_artifacts"("basedOnArtifactId");

-- CreateIndex
CREATE INDEX "project_phase_states_projectId_status_idx" ON "project_phase_states"("projectId", "status");

-- CreateIndex
CREATE INDEX "project_phase_states_currentArtifactId_idx" ON "project_phase_states"("currentArtifactId");

-- CreateIndex
CREATE INDEX "project_phase_states_approvalCandidateArtifactId_idx"
ON "project_phase_states"("approvalCandidateArtifactId");

-- CreateIndex
CREATE INDEX "project_phase_states_currentApprovedArtifactId_idx"
ON "project_phase_states"("currentApprovedArtifactId");

-- CreateIndex
CREATE INDEX "project_phase_states_activeRunId_idx" ON "project_phase_states"("activeRunId");

-- CreateIndex
CREATE INDEX "phase_approvals_artifactId_approvedAt_idx" ON "phase_approvals"("artifactId", "approvedAt");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_runs_projectId_idempotencyKey_key"
ON "workflow_runs"("projectId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "workflow_runs_projectId_currentPhase_startedAt_idx"
ON "workflow_runs"("projectId", "currentPhase", "startedAt");

-- CreateIndex
CREATE INDEX "workflow_runs_baseArtifactId_idx" ON "workflow_runs"("baseArtifactId");

-- CreateIndex
CREATE INDEX "workflow_runs_inputArtifactId_idx" ON "workflow_runs"("inputArtifactId");

-- CreateIndex
CREATE INDEX "workflow_runs_outputArtifactId_idx" ON "workflow_runs"("outputArtifactId");

-- AddForeignKey
ALTER TABLE "project_phase_states"
ADD CONSTRAINT "project_phase_states_currentArtifactId_fkey"
FOREIGN KEY ("currentArtifactId") REFERENCES "phase_artifacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_phase_states"
ADD CONSTRAINT "project_phase_states_approvalCandidateArtifactId_fkey"
FOREIGN KEY ("approvalCandidateArtifactId") REFERENCES "phase_artifacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_phase_states"
ADD CONSTRAINT "project_phase_states_currentApprovedArtifactId_fkey"
FOREIGN KEY ("currentApprovedArtifactId") REFERENCES "phase_artifacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_phase_states"
ADD CONSTRAINT "project_phase_states_activeRunId_fkey"
FOREIGN KEY ("activeRunId") REFERENCES "workflow_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "phase_artifacts"
ADD CONSTRAINT "phase_artifacts_previousVersionId_fkey"
FOREIGN KEY ("previousVersionId") REFERENCES "phase_artifacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "phase_artifacts"
ADD CONSTRAINT "phase_artifacts_basedOnArtifactId_fkey"
FOREIGN KEY ("basedOnArtifactId") REFERENCES "phase_artifacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "phase_approvals"
ADD CONSTRAINT "phase_approvals_artifactId_fkey"
FOREIGN KEY ("artifactId") REFERENCES "phase_artifacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_runs"
ADD CONSTRAINT "workflow_runs_baseArtifactId_fkey"
FOREIGN KEY ("baseArtifactId") REFERENCES "phase_artifacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_runs"
ADD CONSTRAINT "workflow_runs_inputArtifactId_fkey"
FOREIGN KEY ("inputArtifactId") REFERENCES "phase_artifacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_runs"
ADD CONSTRAINT "workflow_runs_outputArtifactId_fkey"
FOREIGN KEY ("outputArtifactId") REFERENCES "phase_artifacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Database-level protection for immutable artifact content versions. Lifecycle
-- metadata may advance, and nullable legacy metadata may be filled once during
-- reconciliation, but established content/hash/provenance cannot be rewritten.
CREATE OR REPLACE FUNCTION "enforce_phase_artifact_content_immutability"()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW."projectId" IS DISTINCT FROM OLD."projectId"
       OR NEW."phase" IS DISTINCT FROM OLD."phase"
       OR NEW."type" IS DISTINCT FROM OLD."type"
       OR NEW."title" IS DISTINCT FROM OLD."title"
       OR NEW."content" IS DISTINCT FROM OLD."content"
       OR NEW."schemaVersion" IS DISTINCT FROM OLD."schemaVersion"
       OR NEW."version" IS DISTINCT FROM OLD."version"
       OR NEW."createdBy" IS DISTINCT FROM OLD."createdBy"
       OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
       OR (OLD."structuredContent" IS NOT NULL AND NEW."structuredContent" IS DISTINCT FROM OLD."structuredContent")
       OR (OLD."contentHash" IS NOT NULL AND NEW."contentHash" IS DISTINCT FROM OLD."contentHash")
       OR (OLD."changeKind" IS NOT NULL AND NEW."changeKind" IS DISTINCT FROM OLD."changeKind")
       OR (OLD."createdByType" IS NOT NULL AND NEW."createdByType" IS DISTINCT FROM OLD."createdByType")
    THEN
        RAISE EXCEPTION 'PhaseArtifact content versions are immutable; create a successor version instead'
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "phase_artifacts_content_immutable"
BEFORE UPDATE ON "phase_artifacts"
FOR EACH ROW
EXECUTE FUNCTION "enforce_phase_artifact_content_immutability"();
