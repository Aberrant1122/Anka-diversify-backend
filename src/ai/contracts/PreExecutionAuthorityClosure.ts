import { AgentFileChange } from "../shared/types";
import { FileManifest } from "../../types";
import { PolicyContract } from "./PolicyContract";
import { TaskIntentSpec } from "../shared/TaskIntentSpec";
import { EvidenceBoundWriteSetResolver, PlannedChange, WriteAuthorizationResult } from "./EvidenceBoundWriteSetResolver";
import { RepositoryEvidenceStore } from "../repository/RepositoryEvidenceStore";
import { normalizeRepoPath } from "../repository/SemanticContextResolver";
import { MonorepoDescriptor } from "../workspace/MonorepoDetector";
import { resolveEffectiveAction } from "./ExecutionScopeEnforcer";

export interface PreExecutionAuthorityClosureInput {
  changes: readonly AgentFileChange[];
  policy: PolicyContract;
  intentSpec: TaskIntentSpec;
  evidenceStore: RepositoryEvidenceStore;
  existingFiles: readonly string[];
  repositoryId: string;
  workspaceRoot?: string;
  baseRevision?: string;
  stageId: string;
  runId?: string;
  monorepo?: MonorepoDescriptor | null;
  /** Planning data may supply audit metadata, never authority by itself. */
  manifest?: FileManifest | null;
}

export interface PreExecutionAuthorityClosureResult {
  readonly result: WriteAuthorizationResult;
  readonly proposedChanges: readonly PlannedChange[];
  readonly valid: boolean;
}

/**
 * Reconciles the actual, untrusted generated mutation set before any validation
 * transaction can snapshot or mutate a worktree.  Candidate paths may cause an
 * authentic repository observation, but are never themselves evidence.
 */
export class PreExecutionAuthorityClosure {
  public static close(input: PreExecutionAuthorityClosureInput): PreExecutionAuthorityClosureResult {
    const existing = new Set(input.existingFiles.map(normalizeRepoPath));
    const proposedChanges: PlannedChange[] = input.changes.map((change) => {
      const path = normalizeRepoPath(change.path);
      const action = resolveEffectiveAction(change, existing.has(path));
      const manifestEntry = input.manifest?.files.find((entry) => normalizeRepoPath(entry.path) === path);

      // This read authenticates only current file existence.  Relation evidence
      // must still come from an independent deterministic observation already in
      // the store; FILE evidence alone is rejected by the resolver for MODIFY.
      if ((action === "modify" || action === "delete") && input.workspaceRoot) {
        input.evidenceStore.observeRepository({ kind: "FILE", filePath: path, provenance: "REPO_READ" });
      }

      const observedEvidenceIds = input.evidenceStore
        .getEvidenceForFile(path)
        .filter((evidence) => input.evidenceStore.isAuthorityEligible(evidence))
        .map((evidence) => evidence.id);
      // Manifest-provided IDs are only references to facts that already exist in
      // this backend store.  Invented or advisory IDs still fail in the resolver.
      const evidenceIds = Array.from(new Set([...(manifestEntry?.evidenceIds || []), ...observedEvidenceIds]));

      return {
        path,
        action,
        reason: change.description || `Generated ${action} proposal for ${path}`,
        evidenceIds,
        dependencies: manifestEntry?.dependencies || [],
      };
    });

    const result = EvidenceBoundWriteSetResolver.resolve({
      policy: input.policy,
      intentSpec: input.intentSpec,
      proposedChanges: [...proposedChanges],
      evidenceStore: input.evidenceStore,
      existingFiles: [...input.existingFiles],
      monorepo: input.monorepo,
      targetRepositoryId: input.repositoryId,
      workspaceRoot: input.workspaceRoot,
      baseRevision: input.baseRevision,
      stageId: input.stageId,
      runId: input.runId,
    });

    // Atomic action groups may run only when every generated change has an
    // exact action grant.  A partially proven group never reaches execution.
    return { result, proposedChanges, valid: result.rejectedPaths.length === 0 && result.authorizedChanges.length === proposedChanges.length };
  }
}
