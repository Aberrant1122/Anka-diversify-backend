-- CreateTable
CREATE TABLE "repository_bootstrap_attempts" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PREPARED',
    "repositoryRoot" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "selectedStack" JSONB,
    "architectureFingerprint" TEXT,
    "baselineCommitSha" TEXT,
    "baseBranch" TEXT NOT NULL DEFAULT 'main',
    "repositoryId" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "repository_bootstrap_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "repository_bootstrap_attempts_projectId_idempotencyKey_key" ON "repository_bootstrap_attempts"("projectId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "repository_bootstrap_attempts_projectId_status_idx" ON "repository_bootstrap_attempts"("projectId", "status");

-- AddForeignKey
ALTER TABLE "repository_bootstrap_attempts" ADD CONSTRAINT "repository_bootstrap_attempts_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
