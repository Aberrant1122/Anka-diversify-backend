-- Additive contract preparation only; no baseline approval/dispatch path exists.
-- DEFAULT preserves existing immutable rows without rewriting their snapshots.
ALTER TABLE "WorkspaceApproval" ADD COLUMN "purpose" TEXT NOT NULL DEFAULT 'IMPLEMENTATION';
ALTER TABLE "WorkspaceRun" ADD COLUMN "purpose" TEXT NOT NULL DEFAULT 'IMPLEMENTATION';
ALTER TABLE "WorkspaceApproval" ADD CONSTRAINT workspace_approval_purpose_check
  CHECK ("purpose" IN ('IMPLEMENTATION','BASELINE_VALIDATION'));
ALTER TABLE "WorkspaceRun" ADD CONSTRAINT workspace_run_purpose_check
  CHECK ("purpose" IN ('IMPLEMENTATION','BASELINE_VALIDATION'));
ALTER TABLE "WorkspaceApproval" ADD CONSTRAINT workspace_approval_id_purpose_key UNIQUE ("id","purpose");
ALTER TABLE "WorkspaceRun" ADD CONSTRAINT workspace_run_approval_purpose_fk
  FOREIGN KEY ("approvalId","purpose") REFERENCES "WorkspaceApproval"("id","purpose") ON DELETE RESTRICT ON UPDATE NO ACTION;
