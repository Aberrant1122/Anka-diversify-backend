-- AlterTable
ALTER TABLE "project_decisions" ADD COLUMN     "artifactId" TEXT,
ADD COLUMN     "phase" TEXT;

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "architectureApprovedAt" TIMESTAMP(3),
ADD COLUMN     "currentPhase" TEXT,
ADD COLUMN     "lastWorkflowRunId" TEXT;

-- CreateTable
CREATE TABLE "project_phase_states" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'not_started',
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "notes" TEXT,

    CONSTRAINT "project_phase_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "phase_artifacts" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approved" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "phase_artifacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "phase_approvals" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "approvedById" TEXT NOT NULL,
    "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decision" TEXT NOT NULL,
    "comments" TEXT,

    CONSTRAINT "phase_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_runs" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "triggerType" TEXT NOT NULL,
    "currentPhase" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "modelUsage" JSONB,
    "costUSD" DOUBLE PRECISION,

    CONSTRAINT "workflow_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "project_phase_states_projectId_phase_key" ON "project_phase_states"("projectId", "phase");

-- CreateIndex
CREATE INDEX "phase_artifacts_projectId_phase_idx" ON "phase_artifacts"("projectId", "phase");

-- CreateIndex
CREATE INDEX "phase_approvals_projectId_phase_idx" ON "phase_approvals"("projectId", "phase");

-- AddForeignKey
ALTER TABLE "project_decisions" ADD CONSTRAINT "project_decisions_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "phase_artifacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_phase_states" ADD CONSTRAINT "project_phase_states_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "phase_artifacts" ADD CONSTRAINT "phase_artifacts_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "phase_approvals" ADD CONSTRAINT "phase_approvals_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
