-- CreateTable
CREATE TABLE "project_repositories" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "githubUrl" TEXT NOT NULL,
    "githubToken" TEXT,
    "localPath" TEXT,
    "defaultBranch" TEXT NOT NULL DEFAULT 'main',
    "environments" JSONB,
    "languages" JSONB,
    "frameworks" JSONB,
    "buildCommand" TEXT,
    "testCommand" TEXT,
    "lintCommand" TEXT,
    "typecheckCommand" TEXT,
    "currentIndexedCommit" TEXT,
    "ownerUserId" TEXT,
    "dependencies" JSONB,
    "executionPolicy" JSONB,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_repositories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_manifests" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "taskId" TEXT,
    "subTaskId" TEXT,
    "manifestJson" JSONB NOT NULL,
    "validationStatus" TEXT NOT NULL,
    "validationErrors" JSONB,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMP(3),

    CONSTRAINT "agent_manifests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_decompositions" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "parentTaskId" TEXT,
    "userRequest" TEXT NOT NULL,
    "graphJson" JSONB NOT NULL,
    "totalSubTasks" INTEGER NOT NULL,
    "completedSubTasks" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "task_decompositions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sub_task_executions" (
    "id" TEXT NOT NULL,
    "decompositionId" TEXT NOT NULL,
    "subTaskId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "targetFiles" JSONB NOT NULL,
    "manifestId" TEXT,
    "status" TEXT NOT NULL,
    "executionOrder" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "errorLog" TEXT,

    CONSTRAINT "sub_task_executions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_repositories_projectId_idx" ON "project_repositories"("projectId");

-- CreateIndex
CREATE INDEX "agent_manifests_projectId_sessionId_idx" ON "agent_manifests"("projectId", "sessionId");

-- CreateIndex
CREATE INDEX "agent_manifests_taskId_idx" ON "agent_manifests"("taskId");

-- CreateIndex
CREATE INDEX "task_decompositions_projectId_sessionId_idx" ON "task_decompositions"("projectId", "sessionId");

-- CreateIndex
CREATE INDEX "sub_task_executions_decompositionId_executionOrder_idx" ON "sub_task_executions"("decompositionId", "executionOrder");

-- CreateIndex
CREATE INDEX "sub_task_executions_status_idx" ON "sub_task_executions"("status");

-- AddForeignKey
ALTER TABLE "project_repositories" ADD CONSTRAINT "project_repositories_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_manifests" ADD CONSTRAINT "agent_manifests_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_decompositions" ADD CONSTRAINT "task_decompositions_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sub_task_executions" ADD CONSTRAINT "sub_task_executions_decompositionId_fkey" FOREIGN KEY ("decompositionId") REFERENCES "task_decompositions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
