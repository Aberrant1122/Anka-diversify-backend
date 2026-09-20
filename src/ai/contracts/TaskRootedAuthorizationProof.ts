import { RepositoryObservationTools } from "../repository/RepositoryObservation";
import { TaskIntentSpec } from "../shared/TaskIntentSpec";
import { RepositoryEvidence, RepositoryEvidenceStore } from "../repository/RepositoryEvidenceStore";
import { authoritySnapshot, withAuthoritySnapshot } from "../repository/AuthorityWorktree";
import { repositoryPath } from "../repository/RepositoryBoundary";
import { trustedUserRequest } from "../repository/TrustedTaskContext";
import { TargetPathExtractor } from "./TargetPathExtractor";
import { TaskAnchorResolver, isConstructiveFeatureRequest } from "../repository/TaskAnchorResolver";
import { isTrustedDiagnosticEvidence } from "../validation/DiagnosticNormalizer";
import { DestructiveTargetResolver } from "./DestructiveTargetResolver";
import { ResolvedTaskTarget } from "../shared/TaskExecutionPlan";
import { normalizeRepoPath } from "../repository/SemanticContextResolver";
import { isExistingPrimaryUIRefinement } from "../planning/RepositoryArchitectureDetector";
import path from "path";

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

  public static resolveTrustedDestructiveTarget(
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

  public static getDeterministicCleanupEligiblePaths(
    store: RepositoryEvidenceStore,
    intent: TaskIntentSpec,
  ): Set<string> {
    const eligible = new Set<string>();
    const trustedTarget = this.resolveTrustedDestructiveTarget(store, intent);

    const extract = (target?: ResolvedTaskTarget) => {
      if (!target) return;
      if (Array.isArray(target.importerPaths)) {
        for (const p of target.importerPaths) {
          if (typeof p === "string" && p.trim()) {
            eligible.add(normalizeRepoPath(p));
          }
        }
      }
      if (Array.isArray(target.actionObligations)) {
        for (const obligation of target.actionObligations) {
          if (
            obligation &&
            obligation.role === "DEPENDENCY_CLEANUP" &&
            obligation.requiredAction === "modify" &&
            typeof obligation.path === "string" &&
            obligation.path.trim()
          ) {
            eligible.add(normalizeRepoPath(obligation.path));
          }
        }
      }
    };

    extract(intent.resolvedTarget);
    extract(trustedTarget);

    return eligible;
  }

  public static isEligibleConstructiveCreateScope(
    candidate: string,
    anchorFilePath: string,
    _repositoryFiles: readonly string[] = [],
    intent?: TaskIntentSpec
  ): boolean {
    const normCandidate = normalizeRepoPath(candidate);

    // 1. Must be a safe relative source/component extension
    if (!/\.(?:tsx|jsx|ts|js|vue|svelte|css|scss|module\.css)$/i.test(normCandidate)) return false;

    // 2. Sensitive keywords: fail-closed against security, auth, admin, billing, payments, fraud, bypass, secrets
    const SENSITIVE_PATTERN = /(?:^|\/|_|-|\.)(?:security|auth|permissions?|credentials?|secrets?|admin|billing|payments?|fraud|bypass|privilege|tokens?)(?:\/|_|-|\.|$)/i;
    if (SENSITIVE_PATTERN.test(normCandidate)) {
      return false;
    }

    if (
      /(?:^|\/)(?:\.github|\.vscode|scripts|docker|ci|config|migrations)(?:\/|$)/i.test(
        normCandidate
      )
    ) {
      return false;
    }

    // 3. Must reside within bounded UI / component / feature directory derived from repository topology and anchor
    const isComponentScope =
      /^(?:(?:apps\/[^\/]+\/)?(?:src\/)?(?:components|ui|features|widgets)\/|(?:app\/components\/|src\/app\/components\/))/i.test(
        normCandidate
      );

    const anchorDir = path.dirname(anchorFilePath).replace(/\\/g, "/");
    const isAnchorSubScope =
      normCandidate.startsWith(`${anchorDir}/components/`) ||
      normCandidate.startsWith(`${anchorDir}/features/`) ||
      normCandidate.startsWith(`${anchorDir}/ui/`);

    if (!isComponentScope && !isAnchorSubScope) {
      return false;
    }

    // Bounded depth: max 5 path segments total (e.g. apps/web/src/components/MyWidget.tsx)
    const segments = normCandidate.split("/");
    if (segments.length > 5) return false;

    // 4. Deterministic Task-to-Candidate Relationship
    // If candidate was an explicit user path in intent, authority is grounded by explicit request
    if (intent) {
      const explicitPaths = new Set(
        (intent.explicitUserPaths || []).map(normalizeRepoPath)
      );
      if (explicitPaths.has(normCandidate)) {
        return true;
      }

      const req = trustedUserRequest(intent) || "";
      const goal = intent.goal || "";
      const opSubjects = (intent.operations || []).map((o) => o.subject || "").join(" ");
      const combinedTaskText = `${req} ${goal} ${opSubjects}`.trim();
      if (!combinedTaskText) return false;

      const singularize = (w: string): string => {
        if (w.length <= 3) return w;
        if (w.endsWith("ies") && w.length > 4) return w.slice(0, -3) + "y";
        if (w.endsWith("es") && !w.endsWith("ies") && (w.endsWith("shes") || w.endsWith("ches") || w.endsWith("sses") || w.endsWith("xes"))) {
          return w.slice(0, -2);
        }
        if (w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us") && !wordIsSpecialPlural(w)) {
          return w.slice(0, -1);
        }
        return w;
      };

      const wordIsSpecialPlural = (w: string) => w === "this" || w === "status" || w === "canvas";

      const rawTaskWords = TargetPathExtractor.tokenizeEntity(combinedTaskText);
      const substantiveTaskWords = rawTaskWords.filter(
        (w) =>
          !TargetPathExtractor.COMMAND_VERBS.has(w) &&
          !TargetPathExtractor.DIRECTIVE_VERBS.has(w) &&
          !TargetPathExtractor.GRAMMAR_WORDS.has(w) &&
          !TargetPathExtractor.VAGUE_TARGET_WORDS.has(w) &&
          !TargetPathExtractor.DESCRIPTIVE_MODIFIERS.has(w)
      );

      const taskTokens = new Set(substantiveTaskWords.map(singularize));
      if (taskTokens.size === 0) return false;

      const UI_WRAPPER_TOKENS = new Set([
        "component",
        "widget",
        "panel",
        "view",
        "screen",
        "page",
        "modal",
        "card",
        "item",
        "list",
        "container",
        "element",
        "wrapper",
        "header",
        "footer",
        "button",
        "bar",
        "dialog",
        "drawer",
        "table",
        "row",
        "form",
        "input",
        "box",
        "banner",
      ]);

      const baseName = path.basename(normCandidate);
      const stem = baseName.replace(/\.[^.]+$/, "");
      const stemTokens = TargetPathExtractor.tokenizeEntity(stem).map(singularize);

      const dirSegments = path
        .dirname(normCandidate)
        .split("/")
        .filter(
          (s) =>
            s &&
            ![
              "src",
              "apps",
              "app",
              "components",
              "ui",
              "features",
              "widgets",
              ".",
            ].includes(s)
        );
      const dirTokens = dirSegments.flatMap((s) =>
        TargetPathExtractor.tokenizeEntity(s).map(singularize)
      );

      const allCandidateTokens = [...dirTokens, ...stemTokens];
      if (allCandidateTokens.length === 0) return false;

      // Check A: No foreign domain tokens (every candidate token must be in UI_WRAPPER_TOKENS or in taskTokens)
      for (const ct of allCandidateTokens) {
        if (!UI_WRAPPER_TOKENS.has(ct) && !taskTokens.has(ct)) {
          return false;
        }
      }

      // Check B: Sufficient task grounding
      const domainTaskTokens = new Set(
        [...taskTokens].filter((t) => !UI_WRAPPER_TOKENS.has(t))
      );
      const domainCandidateTokens = allCandidateTokens.filter(
        (t) => !UI_WRAPPER_TOKENS.has(t)
      );

      if (domainTaskTokens.size > 0) {
        // Candidate cannot be purely generic wrapper tokens
        if (domainCandidateTokens.length === 0) return false;

        // If task specifies multiple domain tokens (e.g. "user", "profile"), candidate cannot match only 1 token (e.g. User.tsx)
        if (domainTaskTokens.size >= 2) {
          const matchedDomainTaskTokens = [...domainTaskTokens].filter((dt) =>
            domainCandidateTokens.includes(dt)
          );
          if (matchedDomainTaskTokens.length < domainTaskTokens.size) {
            return false;
          }
        } else {
          // Exactly 1 domain task token: candidate must match it
          const singleDomainToken = [...domainTaskTokens][0];
          if (!domainCandidateTokens.includes(singleDomainToken)) {
            return false;
          }
        }
      } else {
        // Task had only wrapper tokens (e.g. "add panel"): candidate must match task wrapper tokens
        const matched = allCandidateTokens.some((t) => taskTokens.has(t));
        if (!matched) return false;
      }
    }

    return true;
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
    const resolvedTarget = this.resolveTrustedDestructiveTarget(store, intent) ?? intent.resolvedTarget;
    const resolvedTargetPaths = new Set(
      [
        ...(this.resolveTrustedDestructiveTarget(store, intent)?.candidatePaths || []),
        ...(intent.resolvedTarget?.candidatePaths || []),
      ].map(normalizeRepoPath),
    );
    for (const file of resolvedTargetPaths) {
      const receipt = snapshot.files.has(file)
        ? RepositoryObservationTools.observeFile(store.getRepositoryId(), root, file)
        : null;
      if (receipt) store.recordObservation(receipt);
    }
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
    const resolvedTarget = this.resolveTrustedDestructiveTarget(store, intent) ?? intent.resolvedTarget;
    const isDestructiveTask = Boolean(intent.destructive || resolvedTarget);

    if (action === "modify" && isDestructiveTask) {
      const resolvedTargetPaths = new Set(
        [
          ...(this.resolveTrustedDestructiveTarget(store, intent)?.candidatePaths || []),
          ...(intent.resolvedTarget?.candidatePaths || []),
        ].map(normalizeRepoPath),
      );
      const request = trustedUserRequest(intent);
      const explicit = new Set(request === undefined ? [] : TargetPathExtractor.extractWithProvenance(request, { repoFiles: [...snapshot.files.keys()] })
        .filter((p) => p.provenance === "EXPLICIT_USER_PATH").map((p) => p.path));

      const destructiveRoots = roots.filter((root) =>
        root.kind === "FILE" && (
          resolvedTargetPaths.has(root.filePath) ||
          (intent.destructive && (explicit.has(root.filePath) || intent.operations.some((op) => op.kind === "DELETE" && normalizeRepoPath(op.subject) === root.filePath)))
        )
      ).sort((a, b) => a.filePath.localeCompare(b.filePath));

      const candidateObligation = (intent.resolvedTarget?.actionObligations ?? resolvedTarget?.actionObligations)?.find(
        (obligation) => normalizeRepoPath(obligation.path) === candidate,
      );
      const isObligationForbidden = candidateObligation && (
        candidateObligation.requiredAction !== "modify" || candidateObligation.role === "PRIMARY_TARGET"
      );

      const cleanupEligible = this.getDeterministicCleanupEligiblePaths(store, intent);

      if (cleanupEligible.has(candidate) && !isObligationForbidden && destructiveRoots.length > 0) {
        for (const root of destructiveRoots) {
          const queue = [{ file: root.filePath, ids: [] as string[] }];
          const visited = new Set<string>();
          while (queue.length > 0 && visited.size < 256) {
            const current = queue.shift()!;
            if (visited.has(current.file)) continue;
            visited.add(current.file);

            if (current.file === candidate && current.ids.length > 0) {
              return Object.freeze({
                action,
                candidatePath: candidate,
                rootEvidenceId: root.id,
                edgeEvidenceIds: Object.freeze(current.ids),
                repositoryRevision: snapshot.revision,
              });
            }

            if (current.ids.length >= 3) continue;

            for (const edge of edges) {
              if (edge.filePath !== current.file || !edge.sourceFile) continue;
              if (edge.sourceFile === root.filePath || !repositoryPath(workspace, edge.sourceFile)) continue;
              if (!cleanupEligible.has(edge.sourceFile)) continue;
              queue.push({ file: edge.sourceFile, ids: [...current.ids, edge.id] });
            }
          }
        }
      }
    }

    const request = trustedUserRequest(intent) ?? "";
    const isUiRefinement = isExistingPrimaryUIRefinement(request);

    if (action === "create" && !isDestructiveTask && !isUiRefinement && isConstructiveFeatureRequest(intent)) {
      for (const root of roots) {
        if (
          root.kind === "ENTRY_POINT" &&
          this.isEligibleConstructiveCreateScope(candidate, root.filePath, [...snapshot.files.keys()], intent)
        ) {
          const prospectiveReceipt = RepositoryObservationTools.observeProspectiveFile(
            store.getRepositoryId(),
            workspace,
            candidate
          );
          if (prospectiveReceipt) {
            store.recordObservation(prospectiveReceipt);
          }
          return Object.freeze({
            action: "create",
            candidatePath: candidate,
            rootEvidenceId: root.id,
            edgeEvidenceIds: Object.freeze([]),
            repositoryRevision: snapshot.revision,
          });
        }
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
