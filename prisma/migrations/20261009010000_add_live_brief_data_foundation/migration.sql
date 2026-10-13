-- CreateEnum
CREATE TYPE "IntakeStateStatus" AS ENUM ('EMPTY', 'EXPLORING', 'READY_FOR_CONFIRMATION', 'CONFIRMED');

-- CreateEnum
CREATE TYPE "ClaimCategory" AS ENUM ('GOAL', 'USER_PERSONA', 'WORKFLOW', 'SCOPE_IN', 'SCOPE_OUT', 'CONSTRAINT', 'ACCEPTANCE_CRITERION');

-- CreateEnum
CREATE TYPE "ClaimProvenance" AS ENUM ('DOCUMENT_EVIDENCE', 'USER_STATED', 'MODEL_PROPOSED');

-- CreateEnum
CREATE TYPE "ClaimStatus" AS ENUM ('PROPOSED', 'ACCEPTED', 'CONTESTED', 'SUPERSEDED', 'REJECTED');

-- CreateEnum
CREATE TYPE "QuestionStatus" AS ENUM ('OPEN', 'ANSWERED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "ContradictionStatus" AS ENUM ('ACTIVE', 'RESOLVED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "BriefRevisionActorType" AS ENUM ('USER', 'ASSISTANT_CONVERSATION', 'SYSTEM_INITIALIZATION');

-- CreateEnum
CREATE TYPE "BriefConfirmationStatus" AS ENUM ('ACTIVE', 'STALE');

-- CreateTable
CREATE TABLE "project_intake_states" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "status" "IntakeStateStatus" NOT NULL DEFAULT 'EMPTY',
    "currentBriefRevisionId" TEXT,
    "currentConfirmationId" TEXT,
    "activeSessionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_intake_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_claims" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "claimKey" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "category" "ClaimCategory" NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "provenance" "ClaimProvenance" NOT NULL,
    "status" "ClaimStatus" NOT NULL DEFAULT 'PROPOSED',
    "confidence" DOUBLE PRECISION,
    "sourceSpanIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "createdById" TEXT NOT NULL,
    "createdByType" TEXT NOT NULL DEFAULT 'HUMAN',
    "supersededById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_clarification_questions" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "category" "ClaimCategory" NOT NULL DEFAULT 'GOAL',
    "question" TEXT NOT NULL,
    "suggestedOptions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "status" "QuestionStatus" NOT NULL DEFAULT 'OPEN',
    "answer" TEXT,
    "answeredById" TEXT,
    "answeredAt" TIMESTAMP(3),
    "relatedClaimKeys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_clarification_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_contradictions" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "claimKeyA" TEXT NOT NULL,
    "claimKeyB" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" "ContradictionStatus" NOT NULL DEFAULT 'ACTIVE',
    "resolutionNote" TEXT,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_contradictions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "live_brief_revisions" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "revisionNumber" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "markdownContent" TEXT NOT NULL,
    "structuredClaims" JSONB NOT NULL,
    "evidenceManifest" JSONB NOT NULL,
    "contentHash" TEXT NOT NULL,
    "changeSummary" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdByType" "BriefRevisionActorType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "live_brief_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "live_brief_confirmations" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "briefRevisionId" TEXT NOT NULL,
    "briefRevisionNumber" INTEGER NOT NULL,
    "briefContentHash" TEXT NOT NULL,
    "confirmedById" TEXT NOT NULL,
    "confirmedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "BriefConfirmationStatus" NOT NULL DEFAULT 'ACTIVE',
    "notes" TEXT,
    "supersededAt" TIMESTAMP(3),
    "supersededById" TEXT,

    CONSTRAINT "live_brief_confirmations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "project_intake_states_projectId_key" ON "project_intake_states"("projectId");

-- CreateIndex
CREATE INDEX "project_intake_states_projectId_idx" ON "project_intake_states"("projectId");

-- CreateIndex
CREATE INDEX "project_intake_states_currentBriefRevisionId_idx" ON "project_intake_states"("currentBriefRevisionId");

-- CreateIndex
CREATE INDEX "project_intake_states_currentConfirmationId_idx" ON "project_intake_states"("currentConfirmationId");

-- CreateIndex
CREATE INDEX "project_intake_states_activeSessionId_idx" ON "project_intake_states"("activeSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "project_claims_projectId_claimKey_version_key" ON "project_claims"("projectId", "claimKey", "version");

-- CreateIndex
CREATE INDEX "project_claims_projectId_status_idx" ON "project_claims"("projectId", "status");

-- CreateIndex
CREATE INDEX "project_claims_projectId_category_status_idx" ON "project_claims"("projectId", "category", "status");

-- CreateIndex
CREATE INDEX "project_claims_projectId_claimKey_idx" ON "project_claims"("projectId", "claimKey");

-- CreateIndex
CREATE INDEX "project_clarification_questions_projectId_status_idx" ON "project_clarification_questions"("projectId", "status");

-- CreateIndex
CREATE INDEX "project_clarification_questions_projectId_category_idx" ON "project_clarification_questions"("projectId", "category");

-- CreateIndex
CREATE INDEX "project_contradictions_projectId_status_idx" ON "project_contradictions"("projectId", "status");

-- CreateIndex
CREATE INDEX "project_contradictions_projectId_claimKeyA_idx" ON "project_contradictions"("projectId", "claimKeyA");

-- CreateIndex
CREATE INDEX "project_contradictions_projectId_claimKeyB_idx" ON "project_contradictions"("projectId", "claimKeyB");

-- CreateIndex
CREATE UNIQUE INDEX "live_brief_revisions_projectId_revisionNumber_key" ON "live_brief_revisions"("projectId", "revisionNumber");

-- CreateIndex
CREATE INDEX "live_brief_revisions_projectId_createdAt_idx" ON "live_brief_revisions"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "live_brief_revisions_projectId_contentHash_idx" ON "live_brief_revisions"("projectId", "contentHash");

-- CreateIndex
CREATE UNIQUE INDEX "live_brief_confirmations_briefRevisionId_key" ON "live_brief_confirmations"("briefRevisionId");

-- CreateIndex
CREATE INDEX "live_brief_confirmations_projectId_status_idx" ON "live_brief_confirmations"("projectId", "status");

-- CreateIndex
CREATE INDEX "live_brief_confirmations_projectId_briefRevisionNumber_idx" ON "live_brief_confirmations"("projectId", "briefRevisionNumber");

-- CreateIndex
CREATE INDEX "live_brief_confirmations_briefRevisionId_idx" ON "live_brief_confirmations"("briefRevisionId");

-- AddForeignKey
ALTER TABLE "project_intake_states" ADD CONSTRAINT "project_intake_states_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_intake_states" ADD CONSTRAINT "project_intake_states_currentBriefRevisionId_fkey" FOREIGN KEY ("currentBriefRevisionId") REFERENCES "live_brief_revisions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_intake_states" ADD CONSTRAINT "project_intake_states_currentConfirmationId_fkey" FOREIGN KEY ("currentConfirmationId") REFERENCES "live_brief_confirmations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_claims" ADD CONSTRAINT "project_claims_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_clarification_questions" ADD CONSTRAINT "project_clarification_questions_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_contradictions" ADD CONSTRAINT "project_contradictions_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "live_brief_revisions" ADD CONSTRAINT "live_brief_revisions_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "live_brief_confirmations" ADD CONSTRAINT "live_brief_confirmations_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "live_brief_confirmations" ADD CONSTRAINT "live_brief_confirmations_briefRevisionId_fkey" FOREIGN KEY ("briefRevisionId") REFERENCES "live_brief_revisions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
