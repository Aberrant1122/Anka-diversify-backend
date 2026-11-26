-- CreateTable
CREATE TABLE "WorkspaceDocument" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "previousId" TEXT,
    "sourceMainId" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkspaceDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceHead" (
    "projectId" TEXT NOT NULL,
    "stateVersion" INTEGER NOT NULL DEFAULT 0,
    "mainId" TEXT,
    "architectureId" TEXT,
    "approvalId" TEXT,

    CONSTRAINT "WorkspaceHead_pkey" PRIMARY KEY ("projectId")
);

-- CreateTable
CREATE TABLE "WorkspaceApproval" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "mainId" TEXT NOT NULL,
    "architectureId" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkspaceApproval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceRun" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "approvalId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "authority" JSONB NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkspaceRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceEvent" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "runId" TEXT,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkspaceEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WorkspaceDocument_projectId_kind_idx" ON "WorkspaceDocument"("projectId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceDocument_projectId_kind_version_key" ON "WorkspaceDocument"("projectId", "kind", "version");

-- CreateIndex
CREATE INDEX "WorkspaceApproval_projectId_createdAt_idx" ON "WorkspaceApproval"("projectId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceRun_projectId_idempotencyKey_key" ON "WorkspaceRun"("projectId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "WorkspaceEvent_projectId_createdAt_idx" ON "WorkspaceEvent"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "WorkspaceEvent_runId_createdAt_idx" ON "WorkspaceEvent"("runId", "createdAt");

-- AddForeignKey
ALTER TABLE "WorkspaceDocument" ADD CONSTRAINT "WorkspaceDocument_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceDocument" ADD CONSTRAINT "WorkspaceDocument_previousId_fkey" FOREIGN KEY ("previousId") REFERENCES "WorkspaceDocument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceDocument" ADD CONSTRAINT "WorkspaceDocument_sourceMainId_fkey" FOREIGN KEY ("sourceMainId") REFERENCES "WorkspaceDocument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceHead" ADD CONSTRAINT "WorkspaceHead_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceApproval" ADD CONSTRAINT "WorkspaceApproval_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceRun" ADD CONSTRAINT "WorkspaceRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceRun" ADD CONSTRAINT "WorkspaceRun_approvalId_fkey" FOREIGN KEY ("approvalId") REFERENCES "WorkspaceApproval"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceEvent" ADD CONSTRAINT "WorkspaceEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceEvent" ADD CONSTRAINT "WorkspaceEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "WorkspaceRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Immutable evidence is append-only, including under accidental application writes.
CREATE FUNCTION workspace_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Workspace authority records are immutable'; END;
$$;
CREATE TRIGGER workspace_document_immutable BEFORE UPDATE OR DELETE ON "WorkspaceDocument" FOR EACH ROW EXECUTE FUNCTION workspace_reject_mutation();
CREATE TRIGGER workspace_approval_immutable BEFORE UPDATE OR DELETE ON "WorkspaceApproval" FOR EACH ROW EXECUTE FUNCTION workspace_reject_mutation();
CREATE TRIGGER workspace_run_immutable BEFORE UPDATE OR DELETE ON "WorkspaceRun" FOR EACH ROW EXECUTE FUNCTION workspace_reject_mutation();
CREATE TRIGGER workspace_event_immutable BEFORE UPDATE OR DELETE ON "WorkspaceEvent" FOR EACH ROW EXECUTE FUNCTION workspace_reject_mutation();
ALTER TABLE "WorkspaceHead" ADD CONSTRAINT workspace_head_main_fk FOREIGN KEY ("mainId") REFERENCES "WorkspaceDocument"("id") ON DELETE RESTRICT;
ALTER TABLE "WorkspaceHead" ADD CONSTRAINT workspace_head_architecture_fk FOREIGN KEY ("architectureId") REFERENCES "WorkspaceDocument"("id") ON DELETE RESTRICT;
ALTER TABLE "WorkspaceHead" ADD CONSTRAINT workspace_head_approval_fk FOREIGN KEY ("approvalId") REFERENCES "WorkspaceApproval"("id") ON DELETE RESTRICT;
ALTER TABLE "WorkspaceApproval" ADD CONSTRAINT workspace_approval_main_fk FOREIGN KEY ("mainId") REFERENCES "WorkspaceDocument"("id") ON DELETE RESTRICT;
ALTER TABLE "WorkspaceApproval" ADD CONSTRAINT workspace_approval_architecture_fk FOREIGN KEY ("architectureId") REFERENCES "WorkspaceDocument"("id") ON DELETE RESTRICT;
