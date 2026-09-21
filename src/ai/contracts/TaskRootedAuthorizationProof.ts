import { RepositoryObservationTools } from "../repository/RepositoryObservation";
import { TaskIntentSpec } from "../shared/TaskIntentSpec";
import { RepositoryEvidence, RepositoryEvidenceStore } from "../repository/RepositoryEvidenceStore";
import { authoritySnapshot, withAuthoritySnapshot } from "../repository/AuthorityWorktree";
import { repositoryPath } from "../repository/RepositoryBoundary";
import { trustedUserRequest, trustedStageAuthorizationContext, trustedStageAuthorizationClause, bindStageAuthorizationClause } from "../repository/TrustedTaskContext";
import { TargetPathExtractor } from "./TargetPathExtractor";
import { UserClauseExtractor } from "./UserClauseAuthority";
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
const singularize = (w: string): string => {
  if (w.length <= 3) return w;
  if (w.endsWith("ies") && w.length > 4) return w.slice(0, -3) + "y";
  if (
    w.endsWith("es") &&
    !w.endsWith("ies") &&
    (w.endsWith("shes") || w.endsWith("ches") || w.endsWith("sses") || w.endsWith("xes"))
  ) {
    return w.slice(0, -2);
  }
  if (w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us") && !wordIsSpecialPlural(w)) {
    return w.slice(0, -1);
  }
  return w;
};

const wordIsSpecialPlural = (w: string) => w === "this" || w === "status" || w === "canvas";

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
    const request = trustedStageAuthorizationContext(intent) ?? trustedUserRequest(intent);
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

  public static readonly UI_WRAPPER_TOKENS = new Set([
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
    "dashboard",
  ]);

  public static deriveCanonicalStageEntity(intent?: TaskIntentSpec): {
    entityTokens: string[];
    canonicalKey?: string;
    entityName?: string;
    allSubstantiveTokens: string[];
  } {
    if (!intent) {
      return { entityTokens: [], allSubstantiveTokens: [] };
    }

    const authenticUserReq = trustedUserRequest(intent);
    let boundClause = trustedStageAuthorizationClause(intent);

    if (!boundClause && authenticUserReq) {
      const userClauses = UserClauseExtractor.extractClauses(authenticUserReq);
      if (userClauses.length === 1) {
        boundClause = userClauses[0];
        bindStageAuthorizationClause(intent, boundClause);
      } else if (userClauses.length > 1) {
        const boundResult = UserClauseExtractor.bindStageToClause(
          {
            taskType: intent.taskType,
            goal: intent.goal,
            name: intent.goal,
            targetPath: intent.explicitUserPaths?.[0],
          },
          userClauses
        );
        if (boundResult.clause) {
          boundClause = boundResult.clause;
          bindStageAuthorizationClause(intent, boundClause);
        }
      }
    }

    const ceilingTokens: Set<string> = boundClause
      ? new Set(boundClause.entityTokens)
      : authenticUserReq && UserClauseExtractor.extractClauses(authenticUserReq).length <= 1
      ? new Set(
          TargetPathExtractor.tokenizeEntity(authenticUserReq)
            .map(singularize)
            .filter(
              (w) =>
                !TargetPathExtractor.COMMAND_VERBS.has(w) &&
                !TargetPathExtractor.DIRECTIVE_VERBS.has(w) &&
                !TargetPathExtractor.GRAMMAR_WORDS.has(w) &&
                !TargetPathExtractor.VAGUE_TARGET_WORDS.has(w) &&
                !TargetPathExtractor.DESCRIPTIVE_MODIFIERS.has(w) &&
                !TargetPathExtractor.GENERIC_PROSE_WORDS.has(w)
            )
        )
      : new Set();

    const isSupportedByAuthenticUser = (tokens: string[]): boolean => {
      if (ceilingTokens.size === 0) return false;
      const domainTokens = tokens.filter((t) => !TaskRootedAuthorizationVerifier.UI_WRAPPER_TOKENS.has(t));
      if (domainTokens.length > 0) {
        return domainTokens.every((t) => ceilingTokens.has(t));
      }
      return tokens.every((t) => ceilingTokens.has(t));
    };

    // 1. Explicit operation subject belonging to active stage
    if (intent.operations) {
      for (const op of intent.operations) {
        if (op.kind === "CREATE" && op.subject && typeof op.subject === "string") {
          const cleanSubject = op.subject.trim();
          const isFilePath = /\.[a-zA-Z0-9]+$/.test(cleanSubject) || cleanSubject.includes("/");
          const entityStem = isFilePath
            ? path.basename(cleanSubject).replace(/\.[^.]+$/, "")
            : cleanSubject;
          const tokens = TargetPathExtractor.tokenizeEntity(entityStem).map(singularize);
          const substantive = tokens.filter(
            (w) =>
              !TargetPathExtractor.COMMAND_VERBS.has(w) &&
              !TargetPathExtractor.DIRECTIVE_VERBS.has(w) &&
              !TargetPathExtractor.GRAMMAR_WORDS.has(w) &&
              !TargetPathExtractor.VAGUE_TARGET_WORDS.has(w) &&
              !TargetPathExtractor.DESCRIPTIVE_MODIFIERS.has(w) &&
              !TargetPathExtractor.GENERIC_PROSE_WORDS.has(w)
          );
          if (substantive.length > 0 && substantive.length <= 4 && isSupportedByAuthenticUser(substantive)) {
            return {
              entityTokens: substantive,
              canonicalKey: TargetPathExtractor.normalizeEntityKey(substantive.join("")),
              entityName: substantive.join(" "),
              allSubstantiveTokens: substantive,
            };
          }
        }
      }
    }

    // 2. Resolved logical/task subject already stored in active stage
    if (intent.resolvedTarget?.featureName || intent.resolvedTarget?.logicalTargetId) {
      const targetName = (intent.resolvedTarget.featureName || intent.resolvedTarget.logicalTargetId).trim();
      const tokens = TargetPathExtractor.tokenizeEntity(targetName).map(singularize);
      const substantive = tokens.filter(
        (w) =>
          !TargetPathExtractor.COMMAND_VERBS.has(w) &&
          !TargetPathExtractor.DIRECTIVE_VERBS.has(w) &&
          !TargetPathExtractor.GRAMMAR_WORDS.has(w) &&
          !TargetPathExtractor.VAGUE_TARGET_WORDS.has(w) &&
          !TargetPathExtractor.DESCRIPTIVE_MODIFIERS.has(w) &&
          !TargetPathExtractor.GENERIC_PROSE_WORDS.has(w)
      );
      if (substantive.length > 0 && isSupportedByAuthenticUser(substantive)) {
        return {
          entityTokens: substantive,
          canonicalKey: TargetPathExtractor.normalizeEntityKey(substantive.join("")),
          entityName: substantive.join(" "),
          allSubstantiveTokens: substantive,
        };
      }
    }

    // Active stage goal text (stage authorization context preferred over raw compound message)
    const stageGoal =
      (trustedStageAuthorizationContext(intent) ?? intent.goal ?? "") ||
      (trustedUserRequest(intent) ?? "");

    const rawGoalWords = TargetPathExtractor.tokenizeEntity(stageGoal);
    const substantiveGoalWords = rawGoalWords.filter(
      (w) =>
        !TargetPathExtractor.COMMAND_VERBS.has(w) &&
        !TargetPathExtractor.DIRECTIVE_VERBS.has(w) &&
        !TargetPathExtractor.GRAMMAR_WORDS.has(w) &&
        !TargetPathExtractor.VAGUE_TARGET_WORDS.has(w) &&
        !TargetPathExtractor.DESCRIPTIVE_MODIFIERS.has(w) &&
        !TargetPathExtractor.GENERIC_PROSE_WORDS.has(w)
    );
    const substantiveGoalTokens = substantiveGoalWords.map(singularize);

    // 3. Deterministic entity extraction from active stage goal
    const extractedEntityPhrases = TargetPathExtractor.extractNamedEntityTokens(stageGoal);
    const sortedPhrases = [...extractedEntityPhrases].sort((a, b) => {
      const lenA = a.split(/\s+/).length;
      const lenB = b.split(/\s+/).length;
      return lenB - lenA;
    });

    for (const phrase of sortedPhrases) {
      const phraseTokens = TargetPathExtractor.tokenizeEntity(phrase).map(singularize);
      const substantivePhraseTokens = phraseTokens.filter(
        (w) =>
          !TargetPathExtractor.COMMAND_VERBS.has(w) &&
          !TargetPathExtractor.DIRECTIVE_VERBS.has(w) &&
          !TargetPathExtractor.GRAMMAR_WORDS.has(w) &&
          !TargetPathExtractor.VAGUE_TARGET_WORDS.has(w) &&
          !TargetPathExtractor.DESCRIPTIVE_MODIFIERS.has(w) &&
          !TargetPathExtractor.GENERIC_PROSE_WORDS.has(w)
      );
      if (substantivePhraseTokens.length > 0 && isSupportedByAuthenticUser(substantivePhraseTokens)) {
        return {
          entityTokens: substantivePhraseTokens,
          canonicalKey: TargetPathExtractor.normalizeEntityKey(substantivePhraseTokens.join("")),
          entityName: substantivePhraseTokens.join(" "),
          allSubstantiveTokens: substantiveGoalTokens.filter((t) => isSupportedByAuthenticUser([t])),
        };
      }
    }

    // 4. Conservative fallback tokens from active stage goal
    if (substantiveGoalTokens.length > 0) {
      const allowedGoalTokens = substantiveGoalTokens.filter((t) => isSupportedByAuthenticUser([t]));
      if (allowedGoalTokens.length > 0) {
        return {
          entityTokens: allowedGoalTokens,
          canonicalKey: TargetPathExtractor.normalizeEntityKey(allowedGoalTokens.join("")),
          entityName: allowedGoalTokens.join(" "),
          allSubstantiveTokens: allowedGoalTokens,
        };
      }
    }

    return {
      entityTokens: [],
      allSubstantiveTokens: [],
    };
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

      // --- PART 1 & 2: ORIGINAL USER REQUEST IS THE AUTHORITY CEILING ---
      const authenticUserReq = trustedUserRequest(intent);
      if (!authenticUserReq || typeof authenticUserReq !== "string" || !authenticUserReq.trim()) {
        // Model stage goal by itself has 0 authority
        return false;
      }

      let boundClause = trustedStageAuthorizationClause(intent);
      const userClauses = UserClauseExtractor.extractClauses(authenticUserReq);

      if (!boundClause) {
        if (userClauses.length === 1) {
          boundClause = userClauses[0];
        } else if (userClauses.length > 1) {
          const boundResult = UserClauseExtractor.bindStageToClause(
            {
              taskType: intent.taskType,
              goal: intent.goal,
              name: intent.goal,
              targetPath: intent.explicitUserPaths?.[0],
            },
            userClauses
          );
          if (boundResult.clause) {
            boundClause = boundResult.clause;
          }
        }
      }

      // In a compound user request, an active stage MUST deterministically bind to ONE originating user clause.
      // If ambiguous or unbound -> FAIL CLOSED! Never fall back to whole-request token bag.
      if (userClauses.length > 1 && !boundClause) {
        return false;
      }

      const boundClauseTokens: Set<string> = boundClause
        ? new Set(boundClause.entityTokens)
        : new Set(userClauses[0]?.entityTokens ?? []);

      if (boundClauseTokens.size === 0) {
        return false;
      }

      const derived = this.deriveCanonicalStageEntity(intent);
      const stageEntityTokens = new Set(derived.entityTokens);

      const stageGoalText =
        (boundClause?.sourceText ?? trustedStageAuthorizationContext(intent)) ||
        intent.goal ||
        authenticUserReq;

      const rawStageTokens = TargetPathExtractor.tokenizeEntity(stageGoalText)
        .map(singularize)
        .filter(
          (w) =>
            !TargetPathExtractor.COMMAND_VERBS.has(w) &&
            !TargetPathExtractor.DIRECTIVE_VERBS.has(w) &&
            !TargetPathExtractor.GRAMMAR_WORDS.has(w) &&
            !TargetPathExtractor.VAGUE_TARGET_WORDS.has(w) &&
            !TargetPathExtractor.DESCRIPTIVE_MODIFIERS.has(w) &&
            !TargetPathExtractor.GENERIC_PROSE_WORDS.has(w)
        );

      const opTokens: string[] = [];
      if (intent.operations) {
        for (const op of intent.operations) {
          if (op.kind === "CREATE" && op.subject) {
            const cleanSubject = op.subject.trim();
            const isFilePath = /\.[a-zA-Z0-9]+$/.test(cleanSubject) || cleanSubject.includes("/");
            const entityStem = isFilePath
              ? path.basename(cleanSubject).replace(/\.[^.]+$/, "")
              : cleanSubject;
            opTokens.push(
              ...TargetPathExtractor.tokenizeEntity(entityStem)
                .map(singularize)
                .filter(
                  (w) =>
                    !TargetPathExtractor.COMMAND_VERBS.has(w) &&
                    !TargetPathExtractor.DIRECTIVE_VERBS.has(w) &&
                    !TargetPathExtractor.GRAMMAR_WORDS.has(w) &&
                    !TargetPathExtractor.VAGUE_TARGET_WORDS.has(w) &&
                    !TargetPathExtractor.DESCRIPTIVE_MODIFIERS.has(w) &&
                    !TargetPathExtractor.GENERIC_PROSE_WORDS.has(w)
                )
            );
          }
        }
      }

      const resolvedTokens: string[] = [];
      if (intent.resolvedTarget?.featureName || intent.resolvedTarget?.logicalTargetId) {
        const targetName = (intent.resolvedTarget.featureName || intent.resolvedTarget.logicalTargetId).trim();
        resolvedTokens.push(
          ...TargetPathExtractor.tokenizeEntity(targetName)
            .map(singularize)
            .filter(
              (w) =>
                !TargetPathExtractor.COMMAND_VERBS.has(w) &&
                !TargetPathExtractor.DIRECTIVE_VERBS.has(w) &&
                !TargetPathExtractor.GRAMMAR_WORDS.has(w) &&
                !TargetPathExtractor.VAGUE_TARGET_WORDS.has(w) &&
                !TargetPathExtractor.DESCRIPTIVE_MODIFIERS.has(w) &&
                !TargetPathExtractor.GENERIC_PROSE_WORDS.has(w)
            )
        );
      }

      // Collect all substantive stage tokens across model-influenced sources
      const allSubstantiveStageTokens = new Set([
        ...derived.entityTokens,
        ...derived.allSubstantiveTokens,
        ...rawStageTokens,
        ...opTokens,
        ...resolvedTokens,
      ]);

      if (allSubstantiveStageTokens.size === 0) {
        return false;
      }

      // Extract non-wrapper stage domain tokens
      const stageDomainTokens = new Set(
        [...allSubstantiveStageTokens].filter((t) => !TaskRootedAuthorizationVerifier.UI_WRAPPER_TOKENS.has(t))
      );

      // Verify: stageDomain ⊆ boundClauseTokens
      // EVERY substantive non-wrapper stage-domain token must be supported by the bound originating user clause.
      if (stageDomainTokens.size > 0) {
        for (const sdt of stageDomainTokens) {
          if (!boundClauseTokens.has(sdt)) {
            // Model expansion beyond originating user clause authority ceiling! Fail closed!
            return false;
          }
        }
      } else {
        // Purely wrapper tokens: all must be supported by bound user clause
        for (const st of allSubstantiveStageTokens) {
          if (!boundClauseTokens.has(st)) {
            return false;
          }
        }
      }

      const allAuthorizedDomainTokens = new Set([
        ...[...stageEntityTokens].filter((t) => boundClauseTokens.has(t) || TaskRootedAuthorizationVerifier.UI_WRAPPER_TOKENS.has(t)),
        ...[...derived.allSubstantiveTokens].filter((t) => boundClauseTokens.has(t) || TaskRootedAuthorizationVerifier.UI_WRAPPER_TOKENS.has(t)),
        ...[...rawStageTokens].filter((t) => boundClauseTokens.has(t) || TaskRootedAuthorizationVerifier.UI_WRAPPER_TOKENS.has(t)),
      ]);

      if (allAuthorizedDomainTokens.size === 0) return false;

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

      // Check A: No foreign domain tokens (every candidate token must be in UI_WRAPPER_TOKENS or in allAuthorizedDomainTokens & boundClauseTokens)
      for (const ct of allCandidateTokens) {
        if (!TaskRootedAuthorizationVerifier.UI_WRAPPER_TOKENS.has(ct) && (!allAuthorizedDomainTokens.has(ct) || !boundClauseTokens.has(ct))) {
          return false;
        }
      }

      // Check B: Candidate cannot be purely generic wrapper tokens
      const domainCandidateTokens = allCandidateTokens.filter(
        (t) => !TaskRootedAuthorizationVerifier.UI_WRAPPER_TOKENS.has(t)
      );
      if (domainCandidateTokens.length === 0) {
        return false;
      }

      // Check C: Sufficient domain task grounding / meaningful overlap with canonical stage entity and bound clause
      const canonicalDomainTokens = new Set(
        [...stageEntityTokens].filter((t) => !TaskRootedAuthorizationVerifier.UI_WRAPPER_TOKENS.has(t) && boundClauseTokens.has(t))
      );
      const clauseDomainTokens = new Set(
        [...boundClauseTokens].filter((t) => !TaskRootedAuthorizationVerifier.UI_WRAPPER_TOKENS.has(t))
      );

      const targetDomainTokens = canonicalDomainTokens.size > 0 ? canonicalDomainTokens : clauseDomainTokens;

      if (targetDomainTokens.size > 0) {
        const matchedDomainTokens = [...targetDomainTokens].filter((sdt) =>
          domainCandidateTokens.includes(sdt)
        );

        if (matchedDomainTokens.length === 0) {
          return false;
        }

        // If the canonical entity has 2+ domain tokens (e.g. "user profile"),
        // candidate cannot match only 1 token (e.g. User.tsx)
        if (targetDomainTokens.size >= 2 && matchedDomainTokens.length < targetDomainTokens.size) {
          return false;
        }
      } else {
        // Canonical entity consisted solely of wrapper words; check stem match with entity tokens
        const matchesEntity = [...stageEntityTokens].some((et) =>
          allCandidateTokens.includes(et)
        );
        if (!matchesEntity) return false;
      }

      return true;
    }

    return false;
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

    const request = trustedStageAuthorizationContext(intent) ?? trustedUserRequest(intent) ?? "";
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
        const hasProspectiveCreate = store.getAllEvidence().some(
          (e) => e.kind === "FILE" && !snapshot.files.has(e.filePath) && store.isAuthorityEligible(e)
        );
        const isRouteAnchor = !!(
          root.metadata?.runtimeRoute ||
          root.metadata?.anchorKind === "API_ROUTE_COMPOSITION" ||
          root.metadata?.anchorKind === "API_TEST"
        );
        const isDirectAnchorModify =
          root.kind === "ENTRY_POINT" &&
          action === "modify" &&
          current.ids.length === 0 &&
          (isRouteAnchor || isUiRefinement || hasProspectiveCreate);
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
