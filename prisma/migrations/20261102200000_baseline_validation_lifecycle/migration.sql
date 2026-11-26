
-- Additive baseline authority only. No runtime, dispatcher, or permissions installed.
ALTER TABLE "WorkspaceApproval" ADD COLUMN "baselineRequestKey" TEXT;
ALTER TABLE "WorkspaceApproval" ADD CONSTRAINT workspace_approval_baseline_request_key UNIQUE ("projectId",purpose,"baselineRequestKey");
ALTER TABLE "WorkspaceApproval" ADD CONSTRAINT workspace_approval_scope_purpose_key UNIQUE (id,"projectId",purpose);
ALTER TABLE "WorkspaceRun" ADD CONSTRAINT workspace_run_scope_purpose_key UNIQUE (id,"projectId",purpose);
ALTER TABLE "WorkspaceHead" ADD COLUMN "baselineApprovalId" TEXT;
ALTER TABLE "WorkspaceHead" ADD COLUMN "baselinePurpose" TEXT NOT NULL DEFAULT 'BASELINE_VALIDATION';
ALTER TABLE "WorkspaceHead" ADD CONSTRAINT workspace_head_baseline_purpose_check CHECK ("baselinePurpose"='BASELINE_VALIDATION');
ALTER TABLE "WorkspaceHead" ADD CONSTRAINT workspace_head_baseline_approval_fk
  FOREIGN KEY ("baselineApprovalId","projectId","baselinePurpose") REFERENCES "WorkspaceApproval"(id,"projectId",purpose) ON DELETE RESTRICT ON UPDATE NO ACTION;
CREATE TABLE "BaselineValidationOperation" (
  id TEXT PRIMARY KEY, "projectId" TEXT NOT NULL, "runId" TEXT NOT NULL UNIQUE,
  purpose TEXT NOT NULL DEFAULT 'BASELINE_VALIDATION' CHECK (purpose='BASELINE_VALIDATION'),
  "idempotencyKey" TEXT NOT NULL, "inputHash" TEXT NOT NULL, "stateVersion" INTEGER NOT NULL,
  authority JSONB NOT NULL, "createdBy" TEXT NOT NULL, "jobId" TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'PREPARING', result JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT baseline_operation_run_scope_fk FOREIGN KEY ("runId","projectId",purpose) REFERENCES "WorkspaceRun"(id,"projectId",purpose) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT baseline_operation_status CHECK (status IN ('PREPARING','RUNNING','CLEANUP_REQUIRED','COMPLETED','FAILED','CONFLICTED')),
  CONSTRAINT "BaselineValidationOperation_projectId_idempotencyKey_key" UNIQUE ("projectId","idempotencyKey")
);
CREATE INDEX "BaselineValidationOperation_projectId_createdAt_idx" ON "BaselineValidationOperation"("projectId","createdAt");
CREATE FUNCTION baseline_operation_preserve_authority() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW)-ARRAY['status','result','updatedAt']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','result','updatedAt']) THEN
    RAISE EXCEPTION 'Baseline operation authority is immutable';
  END IF;
  IF NOT ((OLD.status='PREPARING' AND NEW.status IN ('RUNNING','CLEANUP_REQUIRED'))
    OR (OLD.status='RUNNING' AND NEW.status='CLEANUP_REQUIRED')
    OR (OLD.status='CLEANUP_REQUIRED' AND NEW.status IN ('COMPLETED','FAILED','CONFLICTED'))) THEN
    RAISE EXCEPTION 'Baseline operation transition denied';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER baseline_operation_immutable BEFORE UPDATE ON "BaselineValidationOperation" FOR EACH ROW EXECUTE FUNCTION baseline_operation_preserve_authority();
CREATE TRIGGER baseline_operation_no_delete BEFORE DELETE ON "BaselineValidationOperation" FOR EACH ROW EXECUTE FUNCTION workspace_reject_mutation();
