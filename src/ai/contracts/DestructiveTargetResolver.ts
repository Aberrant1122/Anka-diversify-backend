import path from "path";
import { TargetPathExtractor } from "./TargetPathExtractor";
import { normalizeRepoPath } from "../repository/SemanticContextResolver";
import { RepositoryEvidenceStore } from "../repository/RepositoryEvidenceStore";
import { ResolvedTaskTarget } from "../shared/TaskExecutionPlan";
import {
  getFileContent,
  extractExportedSymbols,
  evaluateDirectReverseReference,
} from "./TargetScopeExpander";
import { MonorepoDescriptor } from "../workspace/MonorepoDetector";
import { ExtendedKnowledgeGraph } from "../shared/types";

export type DestructiveTargetStatus = "RESOLVED" | "AMBIGUOUS" | "NOT_FOUND";

export interface DestructiveTargetResolution {
  status: DestructiveTargetStatus;
  targetCertainty: "EXPLICIT" | "GROUNDED_UNIQUE" | "AMBIGUOUS" | "NONEXISTENT" | "VAGUE";
  candidatePaths: string[];
  targetEvidenceIds: string[];
  reason: string;
  clarificationQuestion?: string;
  clarificationOptions?: string[];
  isDestructive: boolean;
  isInFileModification: boolean;
  requiresClarification: boolean;
  resolvedTarget?: ResolvedTaskTarget;
}

export interface DestructiveResolveOptions {
  isDestructive?: boolean;
  operation?: string;
  taskType?: string;
  targetPath?: string;
  evidenceStore?: RepositoryEvidenceStore;
  repositoryId?: string;
  fileContext?: Record<string, string>;
  snapshotFiles?: Array<{ path: string; content?: string }>;
  localPath?: string | null;
  monorepo?: MonorepoDescriptor | null;
  knowledgeGraph?: ExtendedKnowledgeGraph | null;
  selectedLogicalTarget?: string;
}

export interface FeatureCluster {
  id: string;
  name: string;
  files: string[];
  primaryStem: string;
  activeReferences: string[];
  resolutionSource?: "DETERMINISTIC_ACTIVE_GRAPH" | "DETERMINISTIC_UNIQUE" | "EXPLICIT_PATH" | "USER_CLARIFICATION";
}

/**
 * DestructiveTargetResolver
 *
 * Grounded deterministic resolution of destructive targets from repository evidence:
 * 1. Separates explicit destructive intent from target identity.
 * 2. Does not require the user to specify exact internal paths when repository evidence uniquely resolves the target.
 * 3. Never uses semantic similarity alone as DELETE authority.
 * 4. Structurally distinguishes a single coherent feature subgraph from ambiguous distinct targets.
 * 5. Fails closed with clarification when multiple materially different targets exist or target is nonexistent/vague.
 * 6. Hydrates authoritative backend FILE and IMPORT evidence before manifest planning.
 */
export class DestructiveTargetResolver {
  public static resolve(
    targetOrMessage: string,
    repoFiles: string[] = [],
    options?: DestructiveResolveOptions
  ): DestructiveTargetResolution {
    const trimmed = (targetOrMessage || "").trim();

    // Step 1: Detect in-file modifications (e.g. remove unused import, remove padding)
    const isInFileModification =
      options?.taskType === "BUG_FIX" ||
      options?.taskType === "REFACTOR" ||
      /\b(?:remove|delete)\s+(?:the\s+|an?\s+)?(?:extra\s+|all\s+|unused\s+)?(?:unused\s+import|import|imports|padding|margin|border|line|whitespace|comment|text|style|styles|class|classes|prop|props|property|properties|attribute|attributes|handler|listener)\b/i.test(
        trimmed
      );

    // Step 2: Determine destructive intent
    const isDestructiveVerb =
      /\b(?:delete|remove|rm|purge|drop|prune)\b/i.test(trimmed);

    const isDestructive =
      options?.isDestructive ??
      (options?.operation === "DELETE" ||
        options?.taskType === "DELETE_FILE" ||
        options?.taskType === "DELETE_FOLDER" ||
        (!isInFileModification && isDestructiveVerb));

    if (!isDestructive) {
      return {
        status: "RESOLVED",
        targetCertainty: "EXPLICIT",
        candidatePaths: [],
        targetEvidenceIds: [],
        reason: "Non-destructive operation",
        isDestructive: false,
        isInFileModification,
        requiresClarification: false,
      };
    }

    const normalizedRepo = (repoFiles || [])
      .map((f) => normalizeRepoPath(f))
      .filter(
        (f) =>
          !f.startsWith("node_modules/") &&
          !f.startsWith(".git/") &&
          !f.startsWith(".next/") &&
          !f.startsWith("dist/") &&
          !f.startsWith("build/")
      );

    // Step 3: Explicit filesystem path authority
    const explicitCandidate = options?.targetPath;
    if (explicitCandidate) {
      const normExplicit = normalizeRepoPath(explicitCandidate);
      const exists =
        normalizedRepo.includes(normExplicit) ||
        normalizedRepo.some((f) => f.startsWith(normExplicit + "/"));
      if (exists) {
        const candidatePaths = normalizedRepo.includes(normExplicit)
          ? [normExplicit]
          : normalizedRepo.filter((f) => f.startsWith(normExplicit + "/"));

        const cluster: FeatureCluster = {
          id: normExplicit,
          name: this.formatFeatureName(normExplicit),
          files: candidatePaths,
          primaryStem: path.basename(normExplicit).replace(/\.[^.]+$/, ""),
          activeReferences: [],
        };
        this.resolveActiveImplementation([cluster], normalizedRepo, options);
        const hydrated = this.hydrateFeatureEvidence(cluster, normalizedRepo, options);
        const resolvedTarget: ResolvedTaskTarget = {
          logicalTargetId: normExplicit,
          featureName: cluster.name,
          candidatePaths,
          evidenceIds: hydrated.evidenceIds,
          importerPaths: hydrated.importerPaths,
          resolutionSource: "EXPLICIT_PATH",
          status: "RESOLVED",
        };

        return {
          status: "RESOLVED",
          targetCertainty: "EXPLICIT",
          candidatePaths,
          targetEvidenceIds: hydrated.evidenceIds,
          reason: `Explicit path verified in repository: ${normExplicit}`,
          isDestructive: true,
          isInFileModification: false,
          requiresClarification: false,
          resolvedTarget,
        };
      }
    }

    const extractedWithProv = TargetPathExtractor.extractWithProvenance(trimmed, {
      repoFiles: normalizedRepo,
    });
    const explicitPaths = extractedWithProv
      .filter((p) => p.provenance === "EXPLICIT_USER_PATH")
      .map((p) => p.path);

    if (explicitPaths.length > 0) {
      const cluster: FeatureCluster = {
        id: explicitPaths[0],
        name: this.formatFeatureName(explicitPaths[0]),
        files: explicitPaths,
        primaryStem: path.basename(explicitPaths[0]).replace(/\.[^.]+$/, ""),
        activeReferences: [],
      };
      this.resolveActiveImplementation([cluster], normalizedRepo, options);
      const hydrated = this.hydrateFeatureEvidence(cluster, normalizedRepo, options);
      const resolvedTarget: ResolvedTaskTarget = {
        logicalTargetId: explicitPaths[0],
        featureName: cluster.name,
        candidatePaths: explicitPaths,
        evidenceIds: hydrated.evidenceIds,
        importerPaths: hydrated.importerPaths,
        resolutionSource: "EXPLICIT_PATH",
        status: "RESOLVED",
      };

      return {
        status: "RESOLVED",
        targetCertainty: "EXPLICIT",
        candidatePaths: explicitPaths,
        targetEvidenceIds: hydrated.evidenceIds,
        reason: `Explicit user path(s) extracted and verified: ${explicitPaths.join(", ")}`,
        isDestructive: true,
        isInFileModification: false,
        requiresClarification: false,
        resolvedTarget,
      };
    }

    // Step 4: Extract candidate entity tokens from the user request
    const candidateTokens: string[] = [];
    const DESCRIPTIVE_MODIFIERS = TargetPathExtractor.DESCRIPTIVE_MODIFIERS;
    const VAGUE_TARGET_WORDS = TargetPathExtractor.VAGUE_TARGET_WORDS;
    const NON_PATH_TECHNOLOGIES = (TargetPathExtractor as any).NON_PATH_TECHNOLOGIES || new Set();
    const BROAD_GENERIC_DIRS = (TargetPathExtractor as any).BROAD_GENERIC_DIRS || new Set();
    const ACTION_VERBS = new Set([
      "delete",
      "remove",
      "rm",
      "purge",
      "drop",
      "prune",
      "clean",
      "destroy",
      "replace",
      "fix",
      "update",
      "create",
      "add",
      "make",
      "build",
    ]);

    const extractedNamedTokens = TargetPathExtractor.extractNamedEntityTokens(trimmed);
    for (const tok of extractedNamedTokens) {
      let candidate = tok.trim();
      let words = candidate.toLowerCase().split(/\s+/);
      const conjIdx = words.findIndex((w) =>
        ["and", "or", "with", "from", "to", "in", "for", "then", "up", "down", "out", "away"].includes(w)
      );
      if (conjIdx === 0) continue;
      if (conjIdx > 0) {
        words = words.slice(0, conjIdx);
        candidate = words.join(" ");
      }

      const isAllVagueOrAction = words.every(
        (w) => VAGUE_TARGET_WORDS.has(w) || DESCRIPTIVE_MODIFIERS.has(w) || ACTION_VERBS.has(w)
      );
      if (isAllVagueOrAction) continue;

      if (
        candidate.length >= 3 &&
        !candidateTokens.includes(candidate) &&
        !ACTION_VERBS.has(candidate.toLowerCase()) &&
        !NON_PATH_TECHNOLOGIES.has(candidate.toLowerCase()) &&
        !BROAD_GENERIC_DIRS.has(candidate.toLowerCase())
      ) {
        candidateTokens.push(candidate);
      }
    }

    // Also match explicit action phrases: "remove the calculator", "delete calculator"
    const actionMatches = trimmed.matchAll(
      /\b(?:delete|remove|rm|purge|drop|prune|replace)\s+(?:the\s+|a\s+|an\s+)?(?:\b(?:deprecated|legacy|old|obsolete|unused|outdated|former)\s+)?([a-zA-Z0-9_\-]+(?:\s+[a-zA-Z0-9_\-]+)?)\b/gi
    );
    for (const m of actionMatches) {
      let phrase = m[1].trim();
      let words = phrase.toLowerCase().split(/\s+/);
      const conjIdx = words.findIndex((w) =>
        ["and", "or", "with", "from", "to", "in", "for", "then", "up", "down", "out", "away"].includes(w)
      );
      if (conjIdx === 0) continue;
      if (conjIdx > 0) {
        words = words.slice(0, conjIdx);
        phrase = words.join(" ");
      }

      const isAllVagueOrAction = words.every(
        (w) => VAGUE_TARGET_WORDS.has(w) || DESCRIPTIVE_MODIFIERS.has(w) || ACTION_VERBS.has(w)
      );
      if (isAllVagueOrAction) continue;

      if (words.length > 1 && VAGUE_TARGET_WORDS.has(words[words.length - 1])) {
        phrase = words.slice(0, words.length - 1).join(" ");
      }

      if (
        phrase.length >= 3 &&
        !candidateTokens.includes(phrase) &&
        !ACTION_VERBS.has(phrase.toLowerCase()) &&
        !NON_PATH_TECHNOLOGIES.has(phrase.toLowerCase()) &&
        !BROAD_GENERIC_DIRS.has(phrase.toLowerCase())
      ) {
        candidateTokens.push(phrase);
      }
    }

    if (candidateTokens.length === 0 || normalizedRepo.length === 0) {
      return {
        status: "NOT_FOUND",
        targetCertainty: "VAGUE",
        candidatePaths: [],
        targetEvidenceIds: [],
        reason: "The destructive request does not identify which files or components should be removed.",
        isDestructive: true,
        isInFileModification: false,
        requiresClarification: true,
        clarificationQuestion:
          "The request is destructive but does not identify which files or components should be removed. Please specify the exact file or component path to delete.",
        clarificationOptions: ["Specify target files or components", "Cancel deletion"],
      };
    }

    // Sort candidate tokens by length descending (longer, more specific phrases first)
    candidateTokens.sort((a, b) => b.length - a.length);

    // Step 5: Match candidate tokens against repository files and evaluate feature ownership structurally
    let firstAmbiguousResult: DestructiveTargetResolution | null = null;
    let firstNonexistentResult: DestructiveTargetResolution | null = null;

    for (const token of candidateTokens) {
      const key = TargetPathExtractor.normalizeEntityKey(token);
      if (key.length < 3) continue;

      const tokenWords = TargetPathExtractor.tokenizeEntity(token).filter(
        (w) => !DESCRIPTIVE_MODIFIERS.has(w) && !VAGUE_TARGET_WORDS.has(w) && !ACTION_VERBS.has(w)
      );

      const matches: string[] = [];
      for (const rf of normalizedRepo) {
        const baseName = path.basename(rf);
        const stem = baseName.replace(/\.[^.]+$/, "");
        const stemKey = TargetPathExtractor.normalizeEntityKey(stem);
        const parts = rf.split("/");
        const dirName = parts.length > 1 ? parts[parts.length - 2] : "";
        const dirKey = TargetPathExtractor.normalizeEntityKey(dirName);

        const isExactStem = stemKey === key;
        const isSuffixMatch = ["component", "view", "page", "screen", "widget"].some(
          (s) => stemKey === key + s
        );
        const isDirMatch = dirKey === key;
        const isPathMatch = rf.toLowerCase().split(/[\s\-_./\\]+/).includes(key);

        const stemTokens = TargetPathExtractor.tokenizeEntity(stem);
        const isStemTokenMatch = stemTokens.includes(key);
        const isPrefixOrSuffixStem = stemKey.startsWith(key) || stemKey.endsWith(key);

        if (isExactStem || isSuffixMatch || isDirMatch) {
          matches.push(rf);
        } else if (tokenWords.length >= 2) {
          if (tokenWords.every((tw) => stemTokens.includes(tw))) {
            matches.push(rf);
          }
        } else if (isStemTokenMatch || isPrefixOrSuffixStem || isPathMatch) {
          matches.push(rf);
        }
      }

      const codeMatches = matches.filter((m) =>
        /\.(?:tsx|ts|jsx|js|py|go|rs|css|scss)$/i.test(m)
      );

      if (codeMatches.length === 0) {
        if (!firstNonexistentResult) {
          firstNonexistentResult = {
            status: "NOT_FOUND",
            targetCertainty: "NONEXISTENT",
            candidatePaths: [],
            targetEvidenceIds: [],
            reason: `No repository file matching "${token}" was found.`,
            isDestructive: true,
            isInFileModification: false,
            requiresClarification: true,
            clarificationQuestion: `No repository file matching "${token}" was found. Please specify the exact file path to delete.`,
            clarificationOptions: ["Specify target file path", "Cancel deletion"],
          };
        }
        continue;
      }

      if (codeMatches.length === 1) {
        const cluster: FeatureCluster = {
          id: codeMatches[0],
          name: this.formatFeatureName(codeMatches[0]),
          files: codeMatches,
          primaryStem: path.basename(codeMatches[0]).replace(/\.[^.]+$/, ""),
          activeReferences: [],
        };
        this.resolveActiveImplementation([cluster], normalizedRepo, options);
        const hydrated = this.hydrateFeatureEvidence(cluster, normalizedRepo, options);
        const resolvedTarget: ResolvedTaskTarget = {
          logicalTargetId: cluster.id,
          featureName: cluster.name,
          candidatePaths: codeMatches,
          evidenceIds: hydrated.evidenceIds,
          importerPaths: hydrated.importerPaths,
          resolutionSource: "DETERMINISTIC_UNIQUE",
          status: "RESOLVED",
        };
        return {
          status: "RESOLVED",
          targetCertainty: "GROUNDED_UNIQUE",
          candidatePaths: codeMatches,
          targetEvidenceIds: hydrated.evidenceIds,
          reason: `Uniquely resolved entity "${token}" to repository file: ${codeMatches[0]}`,
          isDestructive: true,
          isInFileModification: false,
          requiresClarification: false,
          resolvedTarget,
        };
      }

      // Step 6: Cluster multiple matching files into feature subgraphs
      const clustersMap = this.clusterCandidateFiles(codeMatches, key, options);
      const clusters = Array.from(clustersMap.values());

      // Resolve active references for all candidate clusters structurally
      const activeResolution = this.resolveActiveImplementation(clusters, normalizedRepo, options);

      // If user passed a structured selection from a prior clarification
      if (options?.selectedLogicalTarget) {
        const userChoice = options.selectedLogicalTarget.trim().toLowerCase();
        const matchedCluster = clusters.find(
          (c) =>
            c.name.toLowerCase() === userChoice ||
            c.id.toLowerCase() === userChoice ||
            userChoice.includes(c.name.toLowerCase()) ||
            userChoice.includes(c.primaryStem.toLowerCase())
        );
        if (matchedCluster) {
          const hydrated = this.hydrateFeatureEvidence(matchedCluster, normalizedRepo, options);
          const resolvedTarget: ResolvedTaskTarget = {
            logicalTargetId: matchedCluster.id,
            featureName: matchedCluster.name,
            candidatePaths: matchedCluster.files,
            evidenceIds: hydrated.evidenceIds,
            importerPaths: hydrated.importerPaths,
            resolutionSource: "USER_CLARIFICATION",
            status: "RESOLVED",
          };
          return {
            status: "RESOLVED",
            targetCertainty: "GROUNDED_UNIQUE",
            candidatePaths: matchedCluster.files,
            targetEvidenceIds: hydrated.evidenceIds,
            reason: `Resolved feature "${token}" via user clarification to: ${matchedCluster.name} (${matchedCluster.files.join(", ")})`,
            isDestructive: true,
            isInFileModification: false,
            requiresClarification: false,
            resolvedTarget,
          };
        }
      }

      if (clusters.length === 1) {
        // All matching files belong to one coherent feature subgraph!
        const coherentCluster = clusters[0];
        const hydrated = this.hydrateFeatureEvidence(coherentCluster, normalizedRepo, options);
        const resolvedTarget: ResolvedTaskTarget = {
          logicalTargetId: coherentCluster.id,
          featureName: coherentCluster.name,
          candidatePaths: coherentCluster.files,
          evidenceIds: hydrated.evidenceIds,
          importerPaths: hydrated.importerPaths,
          resolutionSource: "DETERMINISTIC_UNIQUE",
          status: "RESOLVED",
        };
        return {
          status: "RESOLVED",
          targetCertainty: "GROUNDED_UNIQUE",
          candidatePaths: coherentCluster.files,
          targetEvidenceIds: hydrated.evidenceIds,
          reason: `Resolved feature "${token}" to coherent subgraph: ${coherentCluster.files.join(", ")}`,
          isDestructive: true,
          isInFileModification: false,
          requiresClarification: false,
          resolvedTarget,
        };
      }

      // Step 7: Resolve active implementation structurally
      if (activeResolution.resolvedCluster) {
        const activeCluster = activeResolution.resolvedCluster;
        const hydrated = this.hydrateFeatureEvidence(activeCluster, normalizedRepo, options);
        const resolvedTarget: ResolvedTaskTarget = {
          logicalTargetId: activeCluster.id,
          featureName: activeCluster.name,
          candidatePaths: activeCluster.files,
          evidenceIds: hydrated.evidenceIds,
          importerPaths: hydrated.importerPaths,
          resolutionSource: "DETERMINISTIC_ACTIVE_GRAPH",
          status: "RESOLVED",
        };
        return {
          status: "RESOLVED",
          targetCertainty: "GROUNDED_UNIQUE",
          candidatePaths: activeCluster.files,
          targetEvidenceIds: hydrated.evidenceIds,
          reason: `Autonomously resolved active feature "${token}" from structural repository evidence: ${activeCluster.name} (${activeCluster.files.join(", ")})`,
          isDestructive: true,
          isInFileModification: false,
          requiresClarification: false,
          resolvedTarget,
        };
      }

      // Step 8: Multiple active or independent product features exist -> genuine product-level ambiguity
      // FORBIDDEN UX: Never show raw internal file paths in clarification options!
      const productOptions = Array.from(new Set(clusters.map((c) => c.name)));
      const ambiguousResult: DestructiveTargetResolution = {
        status: "AMBIGUOUS",
        targetCertainty: "AMBIGUOUS",
        candidatePaths: [],
        targetEvidenceIds: [],
        reason: `Multiple matching files were found for "${token}": ${productOptions.join(", ")}.`,
        isDestructive: true,
        isInFileModification: false,
        requiresClarification: true,
        clarificationQuestion: `Multiple matching files were found for "${token}": ${productOptions.join(", ")}. Please clarify which one to delete.`,
        clarificationOptions: [...productOptions, "Cancel deletion"],
      };

      if (!firstAmbiguousResult) {
        firstAmbiguousResult = ambiguousResult;
      }
    }

    if (firstAmbiguousResult) {
      return firstAmbiguousResult;
    }

    if (firstNonexistentResult) {
      return firstNonexistentResult;
    }

    return {
      status: "NOT_FOUND",
      targetCertainty: "VAGUE",
      candidatePaths: [],
      targetEvidenceIds: [],
      reason: "The destructive request does not identify which files or components should be removed.",
      isDestructive: true,
      isInFileModification: false,
      requiresClarification: true,
      clarificationQuestion:
        "The request is destructive but does not identify which files or components should be removed. Please specify the exact file or component path to delete.",
      clarificationOptions: ["Specify target files or components", "Cancel deletion"],
    };
  }

  /**
   * Structurally clusters matching files into distinct feature subgraphs.
   * Files in the same feature component directory or sharing component stems form 1 cluster.
   * Competing components in different directories or distinct component stems form separate clusters.
   */
  private static clusterCandidateFiles(
    files: string[],
    tokenKey: string,
    options?: DestructiveResolveOptions
  ): Map<string, FeatureCluster> {
    const clusters = new Map<string, FeatureCluster>();

    // 1. First pass: group by dedicated directory or stem prefix
    for (const file of files) {
      const norm = normalizeRepoPath(file);
      const dir = path.dirname(norm).replace(/\\/g, "/");
      const base = path.basename(norm);
      const stem = base.replace(/\.[^.]+$/, "");
      const stemKey = TargetPathExtractor.normalizeEntityKey(stem);
      const dirParts = dir.split("/");
      const lastDir = dirParts[dirParts.length - 1] || "";
      const lastDirKey = TargetPathExtractor.normalizeEntityKey(lastDir);

      const isAuxiliary =
        stemKey === "index" ||
        stemKey === "types" ||
        stemKey === "styles" ||
        stemKey.endsWith(".test") ||
        stemKey.endsWith(".spec") ||
        norm.endsWith(".css") ||
        norm.endsWith(".scss");

      let clusterId: string;
      let primaryStem: string;

      if (isAuxiliary) {
        clusterId = dir;
        primaryStem = lastDir;
      } else if (lastDirKey === tokenKey) {
        // Dedicated directory for feature e.g. "src/components/calculator"
        if (stemKey === tokenKey || stemKey.startsWith(tokenKey)) {
          clusterId = dir;
          primaryStem = lastDir;
        } else {
          // Distinct component inside directory e.g. "LegacyActivityWidget" vs "NewActivityWidget"
          clusterId = `${dir}/${stem}`;
          primaryStem = stem;
        }
      } else if (stemKey === tokenKey || stemKey.startsWith(tokenKey)) {
        // Component in shared directory starting with feature token (e.g. "Calculator", "CalculatorButton", "CalculatorDisplay")
        clusterId = `${dir}/${tokenKey}`;
        primaryStem = tokenKey;
      } else {
        // Distinct domain-prefixed or competing component (e.g. "AdminTaxCalculator", "LegacyActivityWidget")
        clusterId = `${dir}/${stem}`;
        primaryStem = stem;
      }

      if (!clusters.has(clusterId)) {
        clusters.set(clusterId, {
          id: clusterId,
          name: this.formatFeatureName(primaryStem),
          files: [],
          primaryStem,
          activeReferences: [],
        });
      }
      clusters.get(clusterId)!.files.push(norm);
    }

    // 2. Second pass: merge auxiliary files in a directory into the primary component cluster of that directory
    const dirMap = new Map<string, string[]>();
    for (const [key, cluster] of clusters.entries()) {
      const d = path.dirname(cluster.files[0] || "");
      if (!dirMap.has(d)) dirMap.set(d, []);
      dirMap.get(d)!.push(key);
    }

    for (const [d, cKeys] of dirMap.entries()) {
      if (cKeys.includes(d) && cKeys.length > 1) {
        const nonAuxKeys = cKeys.filter((k) => k !== d);
        if (nonAuxKeys.length === 1) {
          const primaryCluster = clusters.get(nonAuxKeys[0])!;
          const auxCluster = clusters.get(d)!;
          for (const f of auxCluster.files) {
            if (!primaryCluster.files.includes(f)) {
              primaryCluster.files.push(f);
            }
          }
          clusters.delete(d);
        }
      }
    }

    // 3. Third pass: Merge sibling subcomponents that cross-import each other
    for (const [d, cKeys] of dirMap.entries()) {
      const activeKeys = cKeys.filter((k) => clusters.has(k));
      if (activeKeys.length > 1) {
        for (let i = 0; i < activeKeys.length; i++) {
          for (let j = i + 1; j < activeKeys.length; j++) {
            const c1 = clusters.get(activeKeys[i]);
            const c2 = clusters.get(activeKeys[j]);
            if (!c1 || !c2) continue;

            const crossImport = c1.files.some((f1) =>
              c2.files.some(
                (f2) =>
                  evaluateDirectReverseReference(f2, f1, {
                    fileContext: options?.fileContext,
                    snapshotFiles: options?.snapshotFiles,
                    localPath: options?.localPath,
                    monorepo: options?.monorepo,
                    knowledgeGraph: options?.knowledgeGraph,
                  }) !== null ||
                  evaluateDirectReverseReference(f1, f2, {
                    fileContext: options?.fileContext,
                    snapshotFiles: options?.snapshotFiles,
                    localPath: options?.localPath,
                    monorepo: options?.monorepo,
                    knowledgeGraph: options?.knowledgeGraph,
                  }) !== null
              )
            );

            if (crossImport) {
              for (const f of c2.files) {
                if (!c1.files.includes(f)) c1.files.push(f);
              }
              clusters.delete(activeKeys[j]);
            }
          }
        }
      }
    }

    return clusters;
  }

  /**
   * Resolves which candidate cluster is the actively integrated implementation in the repository.
   */
  private static resolveActiveImplementation(
    clusters: FeatureCluster[],
    normalizedRepo: string[],
    options?: DestructiveResolveOptions
  ): { resolvedCluster: FeatureCluster | null; activeClusters: FeatureCluster[] } {
    for (const cluster of clusters) {
      const clusterFilesSet = new Set(cluster.files.map(normalizeRepoPath));
      const externalFiles = normalizedRepo.filter((f) => !clusterFilesSet.has(f));

      for (const extFile of externalFiles) {
        if (
          extFile.startsWith("node_modules/") ||
          extFile.startsWith(".git/") ||
          extFile.startsWith("dist/") ||
          extFile.startsWith("build/")
        ) {
          continue;
        }

        const isReferencing = cluster.files.some((targetFile) => {
          return (
            evaluateDirectReverseReference(targetFile, extFile, {
              fileContext: options?.fileContext,
              snapshotFiles: options?.snapshotFiles,
              localPath: options?.localPath,
              monorepo: options?.monorepo,
              knowledgeGraph: options?.knowledgeGraph,
            }) !== null
          );
        });

        if (isReferencing && !cluster.activeReferences.includes(extFile)) {
          cluster.activeReferences.push(extFile);
        }
      }
    }

    const activeClusters = clusters.filter((c) => c.activeReferences.length > 0);

    if (activeClusters.length === 1) {
      return { resolvedCluster: activeClusters[0], activeClusters };
    }

    return { resolvedCluster: null, activeClusters };
  }

  /**
   * Deterministically hydrates authoritative backend FILE and IMPORT/REFERENCE evidence
   * into RepositoryEvidenceStore before manifest planning.
   */
  private static hydrateFeatureEvidence(
    cluster: FeatureCluster,
    normalizedRepo: string[],
    options?: DestructiveResolveOptions
  ): { evidenceIds: string[]; importerPaths: string[] } {
    const importerPaths: string[] = [...cluster.activeReferences];
    if (!options?.evidenceStore) {
      return { evidenceIds: [], importerPaths };
    }

    const evidenceStore = options.evidenceStore;
    const repoId = options.repositoryId || evidenceStore.getRepositoryId() || "default-repo";
    const hydratedEvidenceIds: string[] = [];

    // 1. Authoritative FILE existence evidence for every DELETE target file
    for (const filePath of cluster.files) {
      const norm = normalizeRepoPath(filePath);
      const fileExists = normalizedRepo.includes(norm);
      if (fileExists) {
        const fileEv = evidenceStore.addEvidence({
          kind: "FILE",
          filePath: norm,
          provenance: "REPO_READ",
          repositoryId: repoId,
          metadata: { exists: true, verified: true, featureTarget: cluster.id },
        });
        if (!hydratedEvidenceIds.includes(fileEv.id)) {
          hydratedEvidenceIds.push(fileEv.id);
        }

        const content = getFileContent(norm, options.fileContext, options.snapshotFiles, options.localPath);
        if (content) {
          const symbols = extractExportedSymbols(content);
          for (const sym of symbols) {
            const symEv = evidenceStore.addEvidence({
              kind: "SYMBOL",
              filePath: norm,
              symbol: sym,
              provenance: "REPO_READ",
              repositoryId: repoId,
              metadata: { exported: true },
            });
            if (!hydratedEvidenceIds.includes(symEv.id)) {
              hydratedEvidenceIds.push(symEv.id);
            }
          }
        }
      }
    }

    // 2. Authoritative FILE and IMPORT/REFERENCE evidence for every importer cleanup
    for (const impPath of importerPaths) {
      const normImp = normalizeRepoPath(impPath);
      const impFileEv = evidenceStore.addEvidence({
        kind: "FILE",
        filePath: normImp,
        provenance: "REPO_READ",
        repositoryId: repoId,
        metadata: { exists: true },
      });
      if (!hydratedEvidenceIds.includes(impFileEv.id)) {
        hydratedEvidenceIds.push(impFileEv.id);
      }

      for (const targetFile of cluster.files) {
        const normTarget = normalizeRepoPath(targetFile);
        const relType = evaluateDirectReverseReference(normTarget, normImp, {
          fileContext: options.fileContext,
          snapshotFiles: options.snapshotFiles,
          localPath: options.localPath,
          monorepo: options.monorepo,
          knowledgeGraph: options.knowledgeGraph,
        });

        if (relType) {
          const impRelEv = evidenceStore.addEvidence({
            kind: relType === "SYMBOL_REFERENCE" ? "REFERENCE" : "IMPORT",
            filePath: normImp,
            sourceFile: normTarget,
            provenance: "REPO_READ",
            repositoryId: repoId,
            metadata: { target: normTarget, relation: relType },
          });
          if (!hydratedEvidenceIds.includes(impRelEv.id)) {
            hydratedEvidenceIds.push(impRelEv.id);
          }
        }
      }
    }

    return { evidenceIds: hydratedEvidenceIds, importerPaths };
  }

  /**
   * Formats a cluster ID or token into a clean, human-readable product capability name.
   */
  private static formatFeatureName(raw: string): string {
    const base = path.basename(raw).replace(/\.[^.]+$/, "");
    if (base.toLowerCase() === "index" || base.toLowerCase() === "calculator") {
      const parts = raw.split("/").filter(Boolean);
      const nonGeneric = parts.filter(
        (p) => !["src", "components", "app", "pages", "index", "lib", "utils"].includes(p.toLowerCase())
      );
      if (nonGeneric.length > 0) {
        return nonGeneric
          .map((p) => p.replace(/([A-Z])/g, " $1").trim())
          .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
          .join(" ");
      }
    }

    const spaced = base.replace(/([A-Z][a-z]+)/g, " $1").replace(/([A-Z]+)/g, " $1").trim();
    return spaced
      .split(/\s+/)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  }

  private static collectEvidenceIds(
    paths: string[],
    evidenceStore?: RepositoryEvidenceStore
  ): string[] {
    if (!evidenceStore) return [];
    const ids: string[] = [];
    for (const p of paths) {
      const norm = normalizeRepoPath(p);
      const evidences = evidenceStore.getEvidenceForFile(norm);
      for (const ev of evidences) {
        if (!ids.includes(ev.id)) {
          ids.push(ev.id);
        }
      }
    }
    return ids;
  }
}
