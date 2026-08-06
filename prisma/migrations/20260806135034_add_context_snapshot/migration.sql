-- CreateTable
CREATE TABLE "context_snapshots" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "repositoryId" TEXT,
    "sessionId" TEXT NOT NULL,
    "userMessage" TEXT NOT NULL,
    "repoUrl" TEXT,
    "repoName" TEXT,
    "defaultBranch" TEXT,
    "repoLastSyncedAt" TIMESTAMP(3),
    "keyFilesUsed" JSONB,
    "approvedArchitectureId" TEXT,
    "taskType" TEXT,
    "risk" TEXT,
    "estimatedComplexity" TEXT,
    "targetPaths" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "context_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "context_snapshots_projectId_sessionId_idx" ON "context_snapshots"("projectId", "sessionId");

-- AddForeignKey
ALTER TABLE "context_snapshots" ADD CONSTRAINT "context_snapshots_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
