-- CreateTable
CREATE TABLE "project_repo_snapshots" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "githubUrl" TEXT NOT NULL,
    "repoName" TEXT NOT NULL,
    "defaultBranch" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "fileTree" TEXT NOT NULL,
    "languages" TEXT NOT NULL,
    "keyFiles" TEXT NOT NULL,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_repo_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "project_repo_snapshots_projectId_key" ON "project_repo_snapshots"("projectId");

-- AddForeignKey
ALTER TABLE "project_repo_snapshots" ADD CONSTRAINT "project_repo_snapshots_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
