import { authoritySnapshot, withAuthoritySnapshot } from "../repository/AuthorityWorktree";
import { AgentFileChange } from "../shared/types";
import { FileManifest } from "../../types";
import { PolicyContract } from "./PolicyContract";
import { TaskIntentSpec } from "../shared/TaskIntentSpec";
import { EvidenceBoundWriteSetResolver, PlannedChange, WriteAuthorizationResult } from "./EvidenceBoundWriteSetResolver";
import { RepositoryEvidenceStore } from "../repository/RepositoryEvidenceStore";
import { normalizeRepoPath } from "../repository/SemanticContextResolver";
import { MonorepoDescriptor } from "../workspace/MonorepoDetector";
import { resolveEffectiveAction } from "./ExecutionScopeEnforcer";
import { DeterministicRelationEvidenceAcquirer } from "./DeterministicRelationEvidenceAcquirer";
import { ConstructiveCapabilityEnvelope, ConstructiveCapabilityEnvelopeBuilder } from "./ConstructiveCapabilityEnvelope";
import { detectRepositoryArchitecture } from "../planning/RepositoryArchitectureDetector";

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
    if (input.workspaceRoot) return withAuthoritySnapshot(input.workspaceRoot, () => this.closeBatch(input));
    return this.closeBatch(input);
  }

  private static closeBatch(input: PreExecutionAuthorityClosureInput): PreExecutionAuthorityClosureResult {
    const existing = new Set(input.existingFiles.map(normalizeRepoPath));
    const normalizedChanges = input.changes.map((change) => ({
      change,
      path: normalizeRepoPath(change.path),
      action: resolveEffectiveAction(change, existing.has(normalizeRepoPath(change.path))),
    }));

    // Late generated candidates trigger a bounded, read-only search from
    // independently task-grounded anchors.  The candidate and manifest are
    // never used as anchors or evidence.
    const snapshot = input.workspaceRoot ? authoritySnapshot(input.workspaceRoot) : undefined;
    let constructiveEnvelope: ConstructiveCapabilityEnvelope | null = null;
    if (input.workspaceRoot && snapshot) {
      const packageEntry = [...snapshot.files.entries()].find(([filePath]) => /(?:^|\/)package\.json$/i.test(filePath));
      let packageJsonContent: string | undefined;
      if (packageEntry) {
        try {
          packageJsonContent = Buffer.from(packageEntry[1], "base64").toString("utf8");
        } catch {}
      }
      const architecture = detectRepositoryArchitecture([...snapshot.files.keys()], packageJsonContent);
      constructiveEnvelope = ConstructiveCapabilityEnvelopeBuilder.build({
        intentSpec: input.intentSpec,
        workspaceRoot: input.workspaceRoot,
        repositoryRevision: snapshot.revision,
        architecture,
      });
    }

    DeterministicRelationEvidenceAcquirer.acquire({
      candidatePaths: normalizedChanges.map((entry) => entry.path),
      intentSpec: input.intentSpec,
      evidenceStore: input.evidenceStore,
      repositoryId: input.repositoryId,
      workspaceRoot: input.workspaceRoot,
      existingFiles: input.existingFiles,
      constructiveEnvelope,
      verifiedTopology: input.manifest?.verifiedTopology,
    });
    const proposedChanges: PlannedChange[] = normalizedChanges.map(({ change, path, action }) => {
      const manifestEntry = input.manifest?.files.find((entry) => normalizeRepoPath(entry.path) === path);

      // This read authenticates only current file existence.  Relation evidence
      // must still come from an independent deterministic observation already in
      // the store; FILE evidence alone is rejected by the resolver for MODIFY.
      if ((action === "modify" || action === "delete") && input.workspaceRoot) {
        input.evidenceStore.observeRepository({ kind: "FILE", filePath: path, provenance: "REPO_READ" });
      }

      const observedEvidenceIds = input.evidenceStore
        .getEvidenceForFile(path)
        .filter((evidence) => input.evidenceStore.isAuthorityEligible(evidence) && !!input.workspaceRoot && evidence.repositoryRevision === authoritySnapshot(input.workspaceRoot).revision)
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
