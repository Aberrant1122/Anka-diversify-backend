-- AlterTable
ALTER TABLE "context_snapshots" ADD COLUMN     "evidenceLabels" JSONB;

-- CreateTable
CREATE TABLE "architecture_drift_records" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "affectedScope" JSONB,
    "evidence" JSONB,
    "risk" TEXT NOT NULL DEFAULT 'medium',
    "proposedResolution" TEXT,
    "ownerUserId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "detectedBy" TEXT NOT NULL DEFAULT 'heuristic',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "architecture_drift_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "architecture_drift_records_projectId_status_idx" ON "architecture_drift_records"("projectId", "status");

-- AddForeignKey
ALTER TABLE "architecture_drift_records" ADD CONSTRAINT "architecture_drift_records_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
