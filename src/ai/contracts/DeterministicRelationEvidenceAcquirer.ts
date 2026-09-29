import { TaskRootedAuthorizationVerifier } from "./TaskRootedAuthorizationProof";
import { authoritySnapshot, withAuthoritySnapshot } from "../repository/AuthorityWorktree";
import { TaskIntentSpec } from "../shared/TaskIntentSpec";
import { RepositoryEvidence, RepositoryEvidenceStore } from "../repository/RepositoryEvidenceStore";
import { RepositoryObservationTools } from "../repository/RepositoryObservation";
import { normalizeRepoPath } from "../repository/SemanticContextResolver";
import { resolveLocalImportEdges } from "../repository/DeterministicImportResolver";
import { TaskAnchorResolver } from "../repository/TaskAnchorResolver";
import { ConstructiveCapabilityEnvelope, deriveConstructiveCandidateRelation, authenticatedConstructiveClause, candidateFitsAuthenticatedClause } from "./ConstructiveCapabilityEnvelope";
import type {
  GraphRootedCandidateRelationReceipt,
  ProspectiveEdgeRelation,
  VerifiedProspectiveFeatureGraph,
} from "../../types";
import path from "path";
import { repositoryPath } from "../repository/RepositoryBoundary";
import { trustedStageAuthorizationId } from "../repository/TrustedTaskContext";
import { isRoleCompatible } from "../planning/ProspectiveFeatureGraph";
import { detectRepositoryArchitecture } from "../planning/RepositoryArchitectureDetector";

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
    readonly constructiveEnvelope?: ConstructiveCapabilityEnvelope | null;
    readonly verifiedTopology?: VerifiedProspectiveFeatureGraph;
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
      if (fileReceipt) {
        input.evidenceStore.recordObservation(fileReceipt);
      } else if (!knownFiles.has(candidate)) {
        const relation = input.constructiveEnvelope &&
          input.constructiveEnvelope.repositoryRevision === authoritySnapshot(input.workspaceRoot).revision
          ? deriveConstructiveCandidateRelation(input.constructiveEnvelope, candidate)
          : undefined;
        const isEligibleCreate = [...anchors].some((anchor) =>
          TaskRootedAuthorizationVerifier.isEligibleConstructiveCreateScope(
            candidate,
            anchor,
            input.existingFiles,
            input.intentSpec,
            relation ?? undefined,
          )
        );
        if (isEligibleCreate) {
          const prospectiveReceipt = RepositoryObservationTools.observeProspectiveFile(
            input.repositoryId,
            input.workspaceRoot,
            candidate
          );
          if (prospectiveReceipt) {
            input.evidenceStore.recordObservation(prospectiveReceipt);
          }
        }
      }
    }

    if (input.verifiedTopology) {
      const topology = input.verifiedTopology;
      const currentRevision = authoritySnapshot(input.workspaceRoot).revision;
      const activeStageId = trustedStageAuthorizationId(input.intentSpec);
      const authenticatedClause = authenticatedConstructiveClause(input.intentSpec);

      const isTopologyValid =
        topology.authority === 0 &&
        activeStageId !== undefined &&
        topology.stageId === activeStageId &&
        authenticatedClause !== undefined &&
        topology.userClauseId === authenticatedClause.id &&
        path.resolve(topology.workspaceRoot) === path.resolve(input.workspaceRoot) &&
        topology.repositoryRevision === currentRevision;

      if (isTopologyValid && input.constructiveEnvelope) {
        interface GroundedRoot {
          readonly node: typeof topology.nodes[number];
          readonly rootEvidenceId: string;
          readonly integrationSurface: string;
        }
        const groundedRoots: GroundedRoot[] = [];

        for (const rootId of topology.featureRoots) {
          const rootNode = topology.nodes.find((n) => n.id === rootId);
          if (!rootNode || rootNode.kind !== "PROSPECTIVE" || rootNode.action !== "create") continue;
          const rootNorm = normalizeRepoPath(rootNode.path);
          if (knownFiles.has(rootNorm)) continue;

          const rootRelation = deriveConstructiveCandidateRelation(input.constructiveEnvelope, rootNorm);
          if (!rootRelation || !candidateFitsAuthenticatedClause(input.intentSpec, rootRelation)) continue;

          const rootAnchor = TaskRootedAuthorizationVerifier.roots(input.evidenceStore, input.intentSpec).find(
            (e) => e.kind === "ENTRY_POINT" && normalizeRepoPath(e.filePath) === rootRelation.integrationSurface
          );
          if (!rootAnchor) continue;

          if (!TaskRootedAuthorizationVerifier.isEligibleConstructiveCreateScope(
            rootNorm,
            rootAnchor.filePath,
            input.existingFiles,
            input.intentSpec,
            rootRelation
          )) {
            continue;
          }

          const rootReceipt = RepositoryObservationTools.observeProspectiveFile(
            input.repositoryId,
            input.workspaceRoot,
            rootNorm
          );
          if (rootReceipt) {
            input.evidenceStore.recordObservation(rootReceipt);
          }

          groundedRoots.push({
            node: rootNode,
            rootEvidenceId: rootAnchor.id,
            integrationSurface: rootAnchor.filePath,
          });
        }

        groundedRoots.sort((a, b) => a.node.id.localeCompare(b.node.id));

        if (groundedRoots.length > 0) {
          const SENSITIVE_PATTERN = /(?:^|\/|_|-|\.)(?:security|auth|permissions?|credentials?|secrets?|admin|billing|payments?|fraud|bypass|privilege|tokens?)(?:\/|_|-|\.|$)/i;
          const ALLOWED_SUPPORT_RELATIONS = new Set<ProspectiveEdgeRelation>(["RENDERS", "IMPORTS", "DEPENDS_ON", "REGISTERS"]);

          const snapshot = authoritySnapshot(input.workspaceRoot);
          const packageEntry = [...snapshot.files.entries()].find(([filePath]) => /(?:^|\/)package\.json$/i.test(filePath));
          let packageJsonContent: string | undefined;
          if (packageEntry) {
            try { packageJsonContent = Buffer.from(packageEntry[1], "base64").toString("utf8"); } catch {}
          }
          const architecture = detectRepositoryArchitecture([...snapshot.files.keys()], packageJsonContent);

          for (const candidate of candidates) {
            if (knownFiles.has(candidate)) continue;
            const existingReceipt = input.evidenceStore.getAllEvidence().some(
              (e) =>
                input.evidenceStore.isAuthorityEligible(e) &&
                e.repositoryRevision === currentRevision &&
                normalizeRepoPath(e.filePath) === candidate &&
                e.kind === "REFERENCE" &&
                e.metadata?.graphReceipt
            );
            if (existingReceipt) continue;

            const candidateNode = topology.nodes.find(
              (n) => n.kind === "PROSPECTIVE" && n.action === "create" && normalizeRepoPath(n.path) === candidate
            );
            if (!candidateNode) continue;

            if (!repositoryPath(input.workspaceRoot, candidate, true)) continue;
            if (SENSITIVE_PATTERN.test(candidate)) continue;
            if (/(?:^|\/)(?:\.github|\.vscode|scripts|docker|ci|config|migrations)(?:\/|$)/i.test(candidate)) continue;
            if (!/\.(?:tsx|jsx|ts|js|vue|svelte|css|scss|module\.css)$/i.test(candidate)) continue;

            if (!isRoleCompatible(candidateNode.role, candidate, architecture)) continue;

            interface PathStep {
              readonly nodeId: string;
              readonly chain: readonly {
                readonly sourceNodeId: string;
                readonly targetNodeId: string;
                readonly relation: ProspectiveEdgeRelation;
              }[];
            }

            let selectedGroundedRoot: GroundedRoot | null = null;
            let selectedChain: PathStep["chain"] | null = null;

            for (const groundedRoot of groundedRoots) {
              if (groundedRoot.node.id === candidateNode.id) continue;

              const queue: PathStep[] = [{ nodeId: groundedRoot.node.id, chain: [] }];
              const visited = new Set<string>([groundedRoot.node.id]);
              const maxSteps = topology.nodes.length;
              let steps = 0;

              while (queue.length > 0 && steps < maxSteps) {
                steps++;
                const current = queue.shift()!;

                const outgoingEdges = topology.edges
                  .filter((e) => e.sourceId === current.nodeId)
                  .sort((a, b) => `${a.relation}:${a.targetId}`.localeCompare(`${b.relation}:${b.targetId}`));

                let foundTarget = false;
                for (const edge of outgoingEdges) {
                  if (!ALLOWED_SUPPORT_RELATIONS.has(edge.relation)) continue;
                  const targetNode = topology.nodes.find((n) => n.id === edge.targetId);
                  if (!targetNode) continue;

                  if (edge.relation === "RENDERS" && targetNode.role !== "COMPONENT" && targetNode.role !== "CHILD_COMPONENT") continue;
                  if (edge.relation === "REGISTERS" && targetNode.role !== "ROUTE" && targetNode.role !== "MODULE") continue;
                  if (
                    (edge.relation === "IMPORTS" || edge.relation === "DEPENDS_ON") &&
                    targetNode.role !== "COMPONENT" &&
                    targetNode.role !== "CHILD_COMPONENT" &&
                    targetNode.role !== "MODULE" &&
                    targetNode.role !== "EXISTING_DEPENDENCY"
                  ) {
                    continue;
                  }

                  const targetNorm = normalizeRepoPath(targetNode.path);
                  if (targetNode.kind === "PROSPECTIVE") {
                    if (!repositoryPath(input.workspaceRoot, targetNorm, true)) continue;
                    if (SENSITIVE_PATTERN.test(targetNorm)) continue;
                    if (/(?:^|\/)(?:\.github|\.vscode|scripts|docker|ci|config|migrations)(?:\/|$)/i.test(targetNorm)) continue;
                  }

                  const nextChain = [
                    ...current.chain,
                    { sourceNodeId: edge.sourceId, targetNodeId: edge.targetId, relation: edge.relation },
                  ];

                  if (targetNode.id === candidateNode.id) {
                    selectedGroundedRoot = groundedRoot;
                    selectedChain = Object.freeze(nextChain);
                    foundTarget = true;
                    break;
                  }

                  if (!visited.has(targetNode.id)) {
                    visited.add(targetNode.id);
                    queue.push({ nodeId: targetNode.id, chain: nextChain });
                  }
                }

                if (foundTarget) break;
              }

              if (selectedChain) break;
            }

            if (selectedGroundedRoot && selectedChain && selectedChain.length > 0) {
              const prospectiveReceipt = RepositoryObservationTools.observeProspectiveFile(
                input.repositoryId,
                input.workspaceRoot,
                candidate
              );
              if (!prospectiveReceipt) continue;
              const absenceEv = input.evidenceStore.recordObservation(prospectiveReceipt);
              if (!absenceEv) continue;

              const receipt: GraphRootedCandidateRelationReceipt = Object.freeze({
                authority: 0 as const,
                stageId: activeStageId,
                userClauseId: authenticatedClause.id,
                workspaceRoot: path.resolve(input.workspaceRoot),
                repositoryRevision: currentRevision,
                graphFingerprint: topology.fingerprint,
                featureRootNodeId: selectedGroundedRoot.node.id,
                featureRootPath: normalizeRepoPath(selectedGroundedRoot.node.path),
                candidateNodeId: candidateNode.id,
                candidatePath: candidate,
                candidateAction: "create" as const,
                candidateRole: candidateNode.role,
                relationChain: selectedChain,
                prospectiveAbsenceEvidenceId: absenceEv.id,
                rootEvidenceId: selectedGroundedRoot.rootEvidenceId,
              });

              const graphRelationReceipt = RepositoryObservationTools.observeGraphRootedRelation(
                input.repositoryId,
                input.workspaceRoot,
                receipt
              );
              if (graphRelationReceipt) {
                input.evidenceStore.recordObservation(graphRelationReceipt);
              }
            }
          }
        }
      }
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

    const resolvedTarget = TaskRootedAuthorizationVerifier.resolveTrustedDestructiveTarget(input.evidenceStore, input.intentSpec) ?? input.intentSpec.resolvedTarget;
    const isDestructiveTask = Boolean(input.intentSpec.destructive || resolvedTarget);

    if (isDestructiveTask) {
      const destructiveTargetPaths = new Set<string>();
      if (input.intentSpec.resolvedTarget?.candidatePaths) {
        for (const p of input.intentSpec.resolvedTarget.candidatePaths) {
          const norm = normalizeRepoPath(p);
          if (knownFiles.has(norm)) destructiveTargetPaths.add(norm);
        }
      }
      if (resolvedTarget?.candidatePaths) {
        for (const p of resolvedTarget.candidatePaths) {
          const norm = normalizeRepoPath(p);
          if (knownFiles.has(norm)) destructiveTargetPaths.add(norm);
        }
      }
      if (input.intentSpec.destructive) {
        for (const op of input.intentSpec.operations) {
          if (op.kind === "DELETE" && op.subject) {
            const norm = normalizeRepoPath(op.subject);
            if (knownFiles.has(norm)) destructiveTargetPaths.add(norm);
          }
        }
        for (const p of input.intentSpec.explicitUserPaths) {
          const norm = normalizeRepoPath(p);
          if (knownFiles.has(norm)) destructiveTargetPaths.add(norm);
        }
      }

      // Ground strictly in verified task roots
      for (const target of destructiveTargetPaths) {
        if (!anchors.has(target)) destructiveTargetPaths.delete(target);
      }

      if (destructiveTargetPaths.size > 0) {
        const cleanupEligible = TaskRootedAuthorizationVerifier.getDeterministicCleanupEligiblePaths(
          input.evidenceStore,
          input.intentSpec,
        );
        const provenCleanupDepth = new Map<string, number>();
        for (const target of destructiveTargetPaths) {
          provenCleanupDepth.set(target, 0);
        }

        let changed = true;
        let pass = 0;
        while (changed && pass < MAX_STRUCTURAL_DEPTH) {
          changed = false;
          pass++;
          for (const candidate of candidates) {
            if (!cleanupEligible.has(candidate)) continue;
            if (provenCleanupDepth.has(candidate)) continue;
            if (!knownFiles.has(candidate)) continue;

            const edges = resolveLocalImportEdges(input.workspaceRoot, candidate);
            let minNextDepth = Number.POSITIVE_INFINITY;
            for (const edge of edges) {
              const targetFile = normalizeRepoPath(edge.targetFile);
              if (provenCleanupDepth.has(targetFile)) {
                const targetDepth = provenCleanupDepth.get(targetFile)!;
                const nextDepth = targetDepth + 1;
                if (nextDepth <= MAX_STRUCTURAL_DEPTH) {
                  const relationReceipt = RepositoryObservationTools.observeReference(
                    input.repositoryId,
                    input.workspaceRoot,
                    edge.sourceFile,
                    edge.targetFile,
                  );
                  if (relationReceipt) {
                    input.evidenceStore.recordObservation(relationReceipt);
                  }
                  if (nextDepth < minNextDepth) {
                    minNextDepth = nextDepth;
                  }
                }
              }
            }
            if (minNextDepth <= MAX_STRUCTURAL_DEPTH) {
              provenCleanupDepth.set(candidate, minNextDepth);
              changed = true;
            }
          }
        }
      }
    }

    const revision = authoritySnapshot(input.workspaceRoot).revision;
    const acquiredByCandidate = new Map<string, readonly string[]>();
    for (const candidate of candidates) {
      const evidenceIds = input.evidenceStore
        .getAllEvidence()
        .filter(
          (evidence) =>
            input.evidenceStore.isAuthorityEligible(evidence) &&
            evidence.repositoryRevision === revision &&
            (evidence.filePath === candidate || (evidence.kind === "IMPORT" && evidence.sourceFile === candidate)),
        )
        .map((evidence) => evidence.id);

      if (!knownFiles.has(candidate)) {
        const proof = TaskRootedAuthorizationVerifier.derive(
          input.evidenceStore,
          input.intentSpec,
          candidate,
          "create"
        );
        if (proof && proof.rootEvidenceId && !evidenceIds.includes(proof.rootEvidenceId)) {
          evidenceIds.push(proof.rootEvidenceId);
        }
      }

      if (evidenceIds.length > 0) acquiredByCandidate.set(candidate, Object.freeze(evidenceIds));
    }
    return acquiredByCandidate;
  }

}
