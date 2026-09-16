import { RepositoryObservationTools } from "../repository/RepositoryObservation";
import { TaskIntentSpec } from "../shared/TaskIntentSpec";
import { RepositoryEvidence, RepositoryEvidenceStore } from "../repository/RepositoryEvidenceStore";
import { authoritySnapshot, withAuthoritySnapshot } from "../repository/AuthorityWorktree";
import { repositoryPath } from "../repository/RepositoryBoundary";
import { trustedUserRequest } from "../repository/TrustedTaskContext";
import { TargetPathExtractor } from "./TargetPathExtractor";
import { TaskAnchorResolver } from "../repository/TaskAnchorResolver";
import { isTrustedDiagnosticEvidence } from "../validation/DiagnosticNormalizer";
import { DestructiveTargetResolver } from "./DestructiveTargetResolver";
import { ResolvedTaskTarget } from "../shared/TaskExecutionPlan";
import { normalizeRepoPath } from "../repository/SemanticContextResolver";

export interface TaskRootedAuthorizationProof {
  readonly action: "create" | "modify" | "delete";
  readonly candidatePath: string;
  readonly rootEvidenceId: string;
  readonly edgeEvidenceIds: readonly string[];
  readonly repositoryRevision: string;
}

/**
 * Root policy: exact paths extracted again from backend-bound ORIGINAL user text,
 * current backend diagnostic receipts, unique UI/API routes resolved from that text,
 * or destructive targets independently re-resolved from that text and current bytes.
 * Arbitrary FILE, SYMBOL, semantic hits, generated paths and caller lineage are never roots.
 * A uniquely resolved runtime route may authorize MODIFY of its own route source.
 * Forward authenticated IMPORT edges extend authority at most three edges. A
 * destructive target may additionally authorize one exact incoming importer for
 * its resolver-issued DEPENDENCY_CLEANUP obligation.
 */
export class TaskRootedAuthorizationVerifier {
  private static readonly destructiveTargetCache = new WeakMap<
    TaskIntentSpec,
    WeakMap<RepositoryEvidenceStore, { revision: string; target?: ResolvedTaskTarget }>
  >();

  private static resolveTrustedDestructiveTarget(
    store: RepositoryEvidenceStore,
    intent: TaskIntentSpec,
  ): ResolvedTaskTarget | undefined {
    const workspace = store.getDefaultWorkspace();
    const request = trustedUserRequest(intent);
    if (!workspace || !request || !intent.destructive) return undefined;

    const snapshot = authoritySnapshot(workspace);
    const cached = this.destructiveTargetCache.get(intent)?.get(store);
    if (cached?.revision === snapshot.revision) return cached.target;
    const resolution = DestructiveTargetResolver.resolve(request, [...snapshot.files.keys()], {
      isDestructive: true,
      taskType: intent.taskType,
      evidenceStore: store,
      repositoryId: store.getRepositoryId(),
      localPath: workspace,
    });
    const target = resolution.status === "RESOLVED" ? resolution.resolvedTarget : undefined;
    let storeCache = this.destructiveTargetCache.get(intent);
    if (!storeCache) {
      storeCache = new WeakMap();
      this.destructiveTargetCache.set(intent, storeCache);
    }
    storeCache.set(store, { revision: snapshot.revision, target });
    return target;
  }

  public static roots(store: RepositoryEvidenceStore, intent: TaskIntentSpec): RepositoryEvidence[] {
    const root = store.getDefaultWorkspace();
    if (!root || !store.getCanonicalWorkspaceRoot()) return [];
    const snapshot = authoritySnapshot(root);
    if (snapshot.canonicalRoot !== store.getCanonicalWorkspaceRoot()) return [];
    const request = trustedUserRequest(intent);
    const explicit = new Set(request === undefined ? [] : TargetPathExtractor.extractWithProvenance(request, { repoFiles: [...snapshot.files.keys()] })
      .filter((p) => p.provenance === "EXPLICIT_USER_PATH").map((p) => p.path));
    for (const file of explicit) {
      const receipt = snapshot.files.has(file)
        ? RepositoryObservationTools.observeFile(store.getRepositoryId(), root, file)
        : RepositoryObservationTools.observeProspectiveFile(store.getRepositoryId(), root, file);
      if (receipt) store.recordObservation(receipt);
    }
    const resolvedTarget = this.resolveTrustedDestructiveTarget(store, intent);
    const resolvedTargetPaths = new Set(
      (resolvedTarget?.candidatePaths || []).map(normalizeRepoPath),
    );
    const routes = TaskAnchorResolver.resolve({ intentSpec: intent, repositoryFiles: [...snapshot.files.keys()], repositoryId: store.getRepositoryId(), workspaceRoot: root, evidenceStore: store });
    const taskAnchorFiles = new Set([...routes.anchors.map((a) => a.filePath), ...routes.uiAnchors, ...routes.apiAnchors, ...routes.testAnchors]);
    return store.getAllEvidence().filter((e) => store.isAuthorityEligible(e) && e.repositoryRevision === snapshot.revision && (
      (e.kind === "FILE" && (explicit.has(e.filePath) || resolvedTargetPaths.has(e.filePath))) ||
      (e.kind === "DIAGNOSTIC" && e.metadata?.stale !== true && isTrustedDiagnosticEvidence(e)) ||
      (e.kind === "ENTRY_POINT" && taskAnchorFiles.has(e.filePath))
    ));
  }

  public static derive(store: RepositoryEvidenceStore, intent: TaskIntentSpec, candidate: string, action: TaskRootedAuthorizationProof["action"]): TaskRootedAuthorizationProof | null {
    const root = store.getDefaultWorkspace();
    if (!root || !store.getCanonicalWorkspaceRoot()) return null;
    return withAuthoritySnapshot(root, () => this.deriveBatch(store, intent, candidate, action));
  }

  private static deriveBatch(store: RepositoryEvidenceStore, intent: TaskIntentSpec, candidate: string, action: TaskRootedAuthorizationProof["action"]): TaskRootedAuthorizationProof | null {
    if (!["create", "modify", "delete"].includes(action)) return null;
    const workspace = store.getDefaultWorkspace();
    if (!workspace || !repositoryPath(workspace, candidate, action === "create")) return null;
    const snapshot = authoritySnapshot(workspace);
    if (action === "create" ? snapshot.files.has(candidate) : !snapshot.files.has(candidate)) return null;
    const roots = this.roots(store, intent).sort((a, b) => a.filePath.localeCompare(b.filePath));
    // An explicitly requested CREATE has a prospective FILE receipt bound to its parent.
    const edges = store.getAllEvidence().filter((e) => store.isAuthorityEligible(e) && e.repositoryRevision === snapshot.revision && e.kind === "IMPORT" && e.sourceFile)
      .sort((a, b) => `${a.sourceFile}:${a.filePath}`.localeCompare(`${b.sourceFile}:${b.filePath}`));
    const resolvedTarget = this.resolveTrustedDestructiveTarget(store, intent);
    const isDependencyCleanup = resolvedTarget && action === "modify" && resolvedTarget.actionObligations?.some(
      (obligation) =>
        obligation.role === "DEPENDENCY_CLEANUP" &&
        obligation.requiredAction === "modify" &&
        normalizeRepoPath(obligation.path) === candidate,
    );
    if (resolvedTarget && isDependencyCleanup) {
      const targetPaths = new Set(resolvedTarget.candidatePaths.map(normalizeRepoPath));
      const incomingEdge = edges.find(
        (edge) => edge.sourceFile === candidate && targetPaths.has(edge.filePath),
      );
      const targetRoot = incomingEdge && roots.find((root) => root.filePath === incomingEdge.filePath);
      if (incomingEdge && targetRoot) {
        return Object.freeze({
          action,
          candidatePath: candidate,
          rootEvidenceId: targetRoot.id,
          edgeEvidenceIds: Object.freeze([incomingEdge.id]),
          repositoryRevision: snapshot.revision,
        });
      }
    }
    for (const root of roots) {
      const queue = [{ file: root.filePath, ids: [] as string[] }];
      const visited = new Set<string>();
      while (queue.length && visited.size < 256) {
        const current = queue.shift()!;
        if (visited.has(current.file)) continue;
        visited.add(current.file);
        const isDirectAnchorModify = root.kind === "ENTRY_POINT" && action === "modify" && current.ids.length === 0;
        if (current.file === candidate && (current.ids.length > 0 || root.kind !== "ENTRY_POINT" || isDirectAnchorModify)) {
          return Object.freeze({ action, candidatePath: candidate, rootEvidenceId: root.id, edgeEvidenceIds: Object.freeze(current.ids), repositoryRevision: snapshot.revision });
        }
        if (root.metadata?.anchorKind === "API_TEST") continue;
        if (current.ids.length >= 3 || action === "create") continue;
        for (const edge of edges) {
          if (edge.sourceFile !== current.file || edge.filePath === root.filePath || !repositoryPath(workspace, edge.filePath)) continue;
          queue.push({ file: edge.filePath, ids: [...current.ids, edge.id] });
        }
      }
    }
    return null;
  }

  /** Untrusted proof objects are checked by independent reconstruction from the store. */
  public static verify(store: RepositoryEvidenceStore, intent: TaskIntentSpec, proof: TaskRootedAuthorizationProof): boolean {
    const derived = this.derive(store, intent, proof.candidatePath, proof.action);
    return !!derived && JSON.stringify(derived) === JSON.stringify(proof);
  }
}
