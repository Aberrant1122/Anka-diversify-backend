import path from "path";
import { TargetPathExtractor } from "./TargetPathExtractor";
import { normalizeRepoPath } from "../repository/SemanticContextResolver";
import { RepositoryEvidenceStore } from "../repository/RepositoryEvidenceStore";

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
}

export interface DestructiveResolveOptions {
  isDestructive?: boolean;
  operation?: string;
  taskType?: string;
  targetPath?: string;
  evidenceStore?: RepositoryEvidenceStore;
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

        return {
          status: "RESOLVED",
          targetCertainty: "EXPLICIT",
          candidatePaths,
          targetEvidenceIds: this.collectEvidenceIds(candidatePaths, options?.evidenceStore),
          reason: `Explicit path verified in repository: ${normExplicit}`,
          isDestructive: true,
          isInFileModification: false,
          requiresClarification: false,
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
      return {
        status: "RESOLVED",
        targetCertainty: "EXPLICIT",
        candidatePaths: explicitPaths,
        targetEvidenceIds: this.collectEvidenceIds(explicitPaths, options?.evidenceStore),
        reason: `Explicit user path(s) extracted and verified: ${explicitPaths.join(", ")}`,
        isDestructive: true,
        isInFileModification: false,
        requiresClarification: false,
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

      // If phrase has multiple words and ends with a vague target word (e.g. "dashboard code", "calculator feature"),
      // strip the trailing vague word so the entity token matches the entity name.
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

        if (isExactStem || isSuffixMatch || isDirMatch) {
          matches.push(rf);
        } else if (tokenWords.length >= 2) {
          const stemTokens = TargetPathExtractor.tokenizeEntity(stem);
          if (tokenWords.every((tw) => stemTokens.includes(tw))) {
            matches.push(rf);
          }
        } else if (isPathMatch) {
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
        return {
          status: "RESOLVED",
          targetCertainty: "GROUNDED_UNIQUE",
          candidatePaths: codeMatches,
          targetEvidenceIds: this.collectEvidenceIds(codeMatches, options?.evidenceStore),
          reason: `Uniquely resolved entity "${token}" to repository file: ${codeMatches[0]}`,
          isDestructive: true,
          isInFileModification: false,
          requiresClarification: false,
        };
      }

      // Step 6: Cluster multiple matching files into feature subgraphs
      const clusters = this.clusterCandidateFiles(codeMatches, key);

      if (clusters.size === 1) {
        // All matching files belong to one coherent feature subgraph!
        const coherentFeatureFiles = Array.from(clusters.values())[0];
        return {
          status: "RESOLVED",
          targetCertainty: "GROUNDED_UNIQUE",
          candidatePaths: coherentFeatureFiles,
          targetEvidenceIds: this.collectEvidenceIds(coherentFeatureFiles, options?.evidenceStore),
          reason: `Resolved feature "${token}" to coherent subgraph: ${coherentFeatureFiles.join(", ")}`,
          isDestructive: true,
          isInFileModification: false,
          requiresClarification: false,
        };
      }

      // Multiple materially different feature targets exist -> genuine ambiguity
      return {
        status: "AMBIGUOUS",
        targetCertainty: "AMBIGUOUS",
        candidatePaths: [],
        targetEvidenceIds: [],
        reason: `Multiple matching files were found for "${token}": ${codeMatches.join(", ")}.`,
        isDestructive: true,
        isInFileModification: false,
        requiresClarification: true,
        clarificationQuestion: `Multiple matching files were found for "${token}": ${codeMatches.join(", ")}. Please clarify which file to delete.`,
        clarificationOptions: [...codeMatches, "Cancel deletion"],
      };
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
  private static clusterCandidateFiles(files: string[], tokenKey: string): Map<string, string[]> {
    const clusters = new Map<string, string[]>();

    for (const file of files) {
      const dir = path.dirname(file).replace(/\\/g, "/");
      const stem = path.basename(file).replace(/\.[^.]+$/, "");
      const stemKey = TargetPathExtractor.normalizeEntityKey(stem);

      let clusterKey: string;
      if (stemKey === "index" || stemKey === "types" || stemKey === "styles" || stemKey.endsWith(".test") || stemKey.endsWith(".spec")) {
        clusterKey = dir;
      } else if (file.endsWith(".css") || file.endsWith(".scss")) {
        clusterKey = dir;
      } else {
        // Sibling feature components in a generic directory (e.g. src/components/activity/LegacyActivityWidget vs NewActivityWidget)
        clusterKey = `${dir}/${stemKey}`;
      }

      if (!clusters.has(clusterKey)) {
        clusters.set(clusterKey, []);
      }
      clusters.get(clusterKey)!.push(file);
    }

    // If multiple clusters exist, check if all primary components share the same feature stem in the same directory
    if (clusters.size > 1) {
      const distinctDirs = new Set(files.map((f) => path.dirname(f).replace(/\\/g, "/")));
      if (distinctDirs.size === 1) {
        const primaryStems = new Set<string>();
        for (const file of files) {
          const base = path.basename(file).replace(/\.[^.]+$/, "").replace(/\.(test|spec)$/, "");
          const baseKey = TargetPathExtractor.normalizeEntityKey(base);
          if (baseKey !== "index" && baseKey !== "types" && baseKey !== "styles" && !file.endsWith(".css") && !file.endsWith(".scss")) {
            primaryStems.add(baseKey);
          }
        }
        // If there is only 1 primary component stem in this directory (e.g. Calculator.tsx + index.ts + Calculator.css), collapse to 1 cluster
        if (primaryStems.size <= 1) {
          const singleCluster = new Map<string, string[]>();
          singleCluster.set(Array.from(clusters.keys())[0], files);
          return singleCluster;
        }
      }
    }

    return clusters;
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
