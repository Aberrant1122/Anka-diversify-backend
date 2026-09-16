import { TaskRootedAuthorizationVerifier } from "./TaskRootedAuthorizationProof";
import { authoritySnapshot, withAuthoritySnapshot } from "../repository/AuthorityWorktree";
import { TaskIntentSpec } from "../shared/TaskIntentSpec";
import { RepositoryEvidence, RepositoryEvidenceStore } from "../repository/RepositoryEvidenceStore";
import { RepositoryObservationTools } from "../repository/RepositoryObservation";
import { normalizeRepoPath } from "../repository/SemanticContextResolver";
import { resolveLocalImportEdges } from "../repository/DeterministicImportResolver";
import { TaskAnchorResolver } from "../repository/TaskAnchorResolver";

const MAX_STRUCTURAL_DEPTH = 3;

/**
 * Read-only, bounded late-target evidence acquisition.  A generated path is
 * solely a lookup key: every recorded fact is re-observed from current bytes.
 */
export class DeterministicRelationEvidenceAcquirer {
  public static acquire(input: {
    readonly candidatePaths: readonly string[];
    readonly intentSpec: TaskIntentSpec;
    readonly evidenceStore: RepositoryEvidenceStore;
    readonly repositoryId: string;
    readonly workspaceRoot?: string;
    readonly existingFiles: readonly string[];
  }): ReadonlyMap<string, readonly string[]> {
    if (!input.workspaceRoot) return new Map();
    return withAuthoritySnapshot(input.workspaceRoot, () => this.acquireBatch(input));
  }

  private static acquireBatch(
    input: Parameters<typeof DeterministicRelationEvidenceAcquirer.acquire>[0],
  ): ReadonlyMap<string, readonly string[]> {
    if (!input.workspaceRoot) return new Map();
    TaskAnchorResolver.resolve({
      intentSpec: input.intentSpec,
      repositoryFiles: input.existingFiles,
      repositoryId: input.repositoryId,
      workspaceRoot: input.workspaceRoot,
      evidenceStore: input.evidenceStore,
    });
    const anchors = new Set(TaskRootedAuthorizationVerifier.roots(input.evidenceStore, input.intentSpec).map((e) => e.filePath));
    if (anchors.size === 0) return new Map();
    const knownFiles = new Set(input.existingFiles.map(normalizeRepoPath));
    const candidates = new Set(input.candidatePaths.map(normalizeRepoPath));

    for (const candidate of candidates) {
      // Authenticate candidate existence only; this is deliberately not a grant.
      const fileReceipt = RepositoryObservationTools.observeFile(input.repositoryId, input.workspaceRoot, candidate);
      if (fileReceipt) input.evidenceStore.recordObservation(fileReceipt);
    }

    const bestDepth = new Map<string, number>();
    const queue = [...anchors].map((filePath) => ({ filePath, depth: 0 }));
    for (const anchor of anchors) bestDepth.set(anchor, 0);
    while (queue.length > 0 && bestDepth.size < 256) {
      const current = queue.shift()!;
      if (current.depth >= MAX_STRUCTURAL_DEPTH) continue;
      for (const edge of resolveLocalImportEdges(input.workspaceRoot, current.filePath)) {
        if (!knownFiles.has(edge.targetFile)) continue;
        const relationReceipt = RepositoryObservationTools.observeReference(
          input.repositoryId,
          input.workspaceRoot,
          edge.sourceFile,
          edge.targetFile,
        );
        if (relationReceipt) input.evidenceStore.recordObservation(relationReceipt);

        const nextDepth = current.depth + 1;
        if ((bestDepth.get(edge.targetFile) ?? Number.POSITIVE_INFINITY) <= nextDepth) continue;
        bestDepth.set(edge.targetFile, nextDepth);
        // Traverse only the authenticated outgoing graph. Candidate paths do
        // not seed this queue and unrelated reverse references are never read.
        if (nextDepth < MAX_STRUCTURAL_DEPTH || candidates.has(edge.targetFile)) {
          queue.push({ filePath: edge.targetFile, depth: nextDepth });
        }
      }
    }

    const revision = authoritySnapshot(input.workspaceRoot).revision;
    const acquiredByCandidate = new Map<string, readonly string[]>();
    for (const candidate of candidates) {
      const evidenceIds = input.evidenceStore.getEvidenceForFile(candidate)
        .filter((evidence) => input.evidenceStore.isAuthorityEligible(evidence) && evidence.repositoryRevision === revision)
        .map((evidence) => evidence.id);
      if (evidenceIds.length > 0) acquiredByCandidate.set(candidate, Object.freeze(evidenceIds));
    }
    return acquiredByCandidate;
  }

}
