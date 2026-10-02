-- Controlled Architecture-derived Kanban task lifecycle. Existing Kanban rows
-- remain legacy/non-executable because implementationEligible defaults false.
ALTER TABLE "kanban_tasks"
ADD COLUMN "implementationEligible" BOOLEAN NOT NULL DEFAULT FALSE,
ADD COLUMN "implementationState" TEXT,
ADD COLUMN "stateVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "architectureArtifactId" TEXT,
ADD COLUMN "architectureVersion" INTEGER,
ADD COLUMN "architectureContentHash" TEXT,
ADD COLUMN "architectureApprovalId" TEXT,
ADD COLUMN "planningAuthorityFingerprint" TEXT,
ADD COLUMN "architectureComponentIds" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN "repositoryId" TEXT,
ADD COLUMN "approvedVersion" INTEGER,
ADD COLUMN "approvedById" TEXT,
ADD COLUMN "approvedAt" TIMESTAMP(3),
ADD COLUMN "approvedTaskFingerprint" TEXT;

CREATE TABLE "implementation_task_dependencies" (
  "taskId" TEXT NOT NULL,
  "dependencyTaskId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "implementation_task_dependencies_pkey" PRIMARY KEY ("taskId", "dependencyTaskId"),
  CONSTRAINT "implementation_task_dependency_not_self" CHECK ("taskId" <> "dependencyTaskId")
);

CREATE TABLE "implementation_task_executions" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "taskId" TEXT NOT NULL,
  "repositoryId" TEXT NOT NULL,
  "initiatedById" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "requestIdentity" TEXT NOT NULL,
  "approvedTaskVersion" INTEGER NOT NULL,
  "taskSnapshot" JSONB NOT NULL,
  "planningAuthority" JSONB NOT NULL,
  "authorityFingerprint" TEXT NOT NULL,
  "state" TEXT NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "heartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseExpiresAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  "reviewedAt" TIMESTAMP(3),
  "reviewedById" TEXT,
  "reviewComments" TEXT,
  "sessionId" TEXT,
  "runId" TEXT,
  "worktreePath" TEXT,
  "branchName" TEXT,
  "baseCommitSha" TEXT,
  "changedFiles" JSONB NOT NULL DEFAULT '[]',
  "diffSummary" TEXT,
  "validationEvidence" JSONB,
  "gitApprovalId" TEXT,
  "gitApprovalExpiresAt" TIMESTAMP(3),
  "commitSha" TEXT,
  "pushed" BOOLEAN,
  "remote" TEXT,
  "reviewId" TEXT,
  "reviewUrl" TEXT,
  "failureCategory" TEXT,
  "failureDiagnostic" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "implementation_task_executions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "kanban_tasks_implementationEligible_implementationState_idx"
ON "kanban_tasks"("implementationEligible", "implementationState");
CREATE INDEX "kanban_tasks_repositoryId_idx" ON "kanban_tasks"("repositoryId");
CREATE INDEX "implementation_task_dependencies_dependencyTaskId_idx"
ON "implementation_task_dependencies"("dependencyTaskId");
CREATE UNIQUE INDEX "implementation_task_executions_taskId_idempotencyKey_key"
ON "implementation_task_executions"("taskId", "idempotencyKey");
CREATE UNIQUE INDEX "implementation_task_executions_one_active_per_task"
ON "implementation_task_executions"("taskId") WHERE "state" = 'running';
CREATE INDEX "implementation_task_executions_projectId_taskId_createdAt_idx"
ON "implementation_task_executions"("projectId", "taskId", "createdAt");
CREATE INDEX "implementation_task_executions_state_leaseExpiresAt_idx"
ON "implementation_task_executions"("state", "leaseExpiresAt");

ALTER TABLE "kanban_tasks" ADD CONSTRAINT "kanban_tasks_repositoryId_fkey"
FOREIGN KEY ("repositoryId") REFERENCES "project_repositories"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "implementation_task_dependencies" ADD CONSTRAINT "implementation_task_dependencies_taskId_fkey"
FOREIGN KEY ("taskId") REFERENCES "kanban_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "implementation_task_dependencies" ADD CONSTRAINT "implementation_task_dependencies_dependencyTaskId_fkey"
FOREIGN KEY ("dependencyTaskId") REFERENCES "kanban_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "implementation_task_executions" ADD CONSTRAINT "implementation_task_executions_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "implementation_task_executions" ADD CONSTRAINT "implementation_task_executions_taskId_fkey"
FOREIGN KEY ("taskId") REFERENCES "kanban_tasks"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "implementation_task_executions" ADD CONSTRAINT "implementation_task_executions_repositoryId_fkey"
FOREIGN KEY ("repositoryId") REFERENCES "project_repositories"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
