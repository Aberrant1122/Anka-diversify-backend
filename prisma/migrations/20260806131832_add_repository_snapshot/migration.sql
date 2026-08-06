-- CreateTable
CREATE TABLE "repository_snapshots" (
    "id" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "githubUrl" TEXT NOT NULL,
    "repoName" TEXT NOT NULL,
    "defaultBranch" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "fileTree" TEXT NOT NULL,
    "languages" TEXT NOT NULL,
    "keyFiles" TEXT NOT NULL,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "repository_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kanban_boards" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kanban_boards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kanban_stages" (
    "id" TEXT NOT NULL,
    "boardId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "kanban_stages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kanban_tasks" (
    "id" TEXT NOT NULL,
    "stageId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "acceptanceCriteria" JSONB NOT NULL DEFAULT '[]',
    "targetFiles" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'todo',
    "order" INTEGER NOT NULL DEFAULT 0,
    "executionLogs" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kanban_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clarification_qas" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "options" JSONB NOT NULL DEFAULT '[]',
    "selectedOption" TEXT,
    "userNotes" TEXT,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "clarification_qas_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "repository_snapshots_repositoryId_key" ON "repository_snapshots"("repositoryId");

-- CreateIndex
CREATE UNIQUE INDEX "kanban_boards_projectId_key" ON "kanban_boards"("projectId");

-- CreateIndex
CREATE INDEX "kanban_stages_boardId_order_idx" ON "kanban_stages"("boardId", "order");

-- CreateIndex
CREATE INDEX "kanban_tasks_stageId_order_idx" ON "kanban_tasks"("stageId", "order");

-- CreateIndex
CREATE INDEX "kanban_tasks_status_idx" ON "kanban_tasks"("status");

-- CreateIndex
CREATE INDEX "clarification_qas_taskId_resolved_idx" ON "clarification_qas"("taskId", "resolved");

-- AddForeignKey
ALTER TABLE "repository_snapshots" ADD CONSTRAINT "repository_snapshots_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "project_repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kanban_boards" ADD CONSTRAINT "kanban_boards_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kanban_stages" ADD CONSTRAINT "kanban_stages_boardId_fkey" FOREIGN KEY ("boardId") REFERENCES "kanban_boards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kanban_tasks" ADD CONSTRAINT "kanban_tasks_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "kanban_stages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clarification_qas" ADD CONSTRAINT "clarification_qas_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "kanban_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
