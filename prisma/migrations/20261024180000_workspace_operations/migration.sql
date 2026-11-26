-- CreateTable
CREATE TABLE "WorkspaceOperation" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "runId" TEXT,
    "kind" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "stateVersion" INTEGER NOT NULL,
    "inputHash" TEXT NOT NULL,
    "context" JSONB NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "result" JSONB,
    "errorCode" TEXT,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "WorkspaceOperation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WorkspaceOperation_projectId_createdAt_idx" ON "WorkspaceOperation"("projectId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceOperation_projectId_kind_idempotencyKey_key" ON "WorkspaceOperation"("projectId", "kind", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "WorkspaceOperation" ADD CONSTRAINT "WorkspaceOperation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceOperation" ADD CONSTRAINT "WorkspaceOperation_runId_fkey" FOREIGN KEY ("runId") REFERENCES "WorkspaceRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Only completion fields may change; the request and exact input context cannot.
CREATE FUNCTION workspace_operation_preserve_input() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['status','result','errorCode','completedAt']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','result','errorCode','completedAt']) THEN
    RAISE EXCEPTION 'Workspace operation authority is immutable';
  END IF;
  IF OLD.status <> 'RUNNING' THEN RAISE EXCEPTION 'Workspace operation is terminal'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER workspace_operation_input_immutable BEFORE UPDATE ON "WorkspaceOperation" FOR EACH ROW EXECUTE FUNCTION workspace_operation_preserve_input();
CREATE TRIGGER workspace_operation_no_delete BEFORE DELETE ON "WorkspaceOperation" FOR EACH ROW EXECUTE FUNCTION workspace_reject_mutation();
ALTER TABLE "WorkspaceOperation" ADD CONSTRAINT workspace_operation_status CHECK (status IN ('RUNNING','COMPLETED','FAILED','CONFLICTED'));
