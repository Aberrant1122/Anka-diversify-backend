import path from "path";
import { TargetPathExtractor } from "../contracts/TargetPathExtractor";

export interface DestructiveSafetyAssessment {
  isDestructive: boolean;
  isInFileModification: boolean;
  targetCertainty: "EXPLICIT" | "GROUNDED_UNIQUE" | "AMBIGUOUS" | "NONEXISTENT" | "VAGUE";
  requiresClarification: boolean;
  clarificationQuestion?: string;
  clarificationOptions?: string[];
  groundedTargets: string[];
}

export interface DestructiveSafetyOptions {
  isDestructive?: boolean;
  operation?: string;
  taskType?: string;
  targetPath?: string;
}

export class DestructiveSafetyEvaluator {
  /**
   * Evaluates a destructive operation for deterministic safety after intent is determined.
   *
   * Invariants:
   * 1. Destructive intent is governed by structured LLM intent / intentSpec, NOT prompt keyword detection.
   * 2. When intent is destructive (DELETE_FILE / DELETE_FOLDER / operation === "DELETE"):
   *    - Inspects target existence, uniqueness, ambiguity, and scope.
   *    - Grounded explicit path or unique entity -> SAFE (requiresClarification: false).
   *    - Ambiguous, nonexistent, or vague targets -> FAIL-CLOSED (requiresClarification: true).
   */
  public static evaluate(
    targetOrMessage: string,
    repoFiles: string[] = [],
    options?: DestructiveSafetyOptions
  ): DestructiveSafetyAssessment {
    // Determine whether this operation is destructive from structured intent options
    const isDestructive =
      options?.isDestructive ??
      (options?.operation === "DELETE" ||
        options?.taskType === "DELETE_FILE" ||
        options?.taskType === "DELETE_FOLDER" ||
        false);

    if (!isDestructive) {
      return {
        isDestructive: false,
        isInFileModification: options?.taskType === "BUG_FIX" || options?.taskType === "REFACTOR",
        targetCertainty: "EXPLICIT",
        requiresClarification: false,
        groundedTargets: [],
      };
    }

    const normalizedRepo = (repoFiles || [])
      .map((f) => f.replace(/\\/g, "/").replace(/^\//, ""))
      .filter((f) => !f.startsWith("node_modules/") && !f.startsWith(".git/") && !f.startsWith(".next/") && !f.startsWith("dist/"));

    // Step A: Explicit Filesystem Path Authority
    const explicitCandidate = options?.targetPath;
    if (explicitCandidate) {
      const normExplicit = explicitCandidate.replace(/\\/g, "/").replace(/^\//, "");
      const exists = normalizedRepo.includes(normExplicit) || normalizedRepo.some((f) => f.startsWith(normExplicit + "/"));
      if (exists) {
        return {
          isDestructive: true,
          isInFileModification: false,
          targetCertainty: "EXPLICIT",
          requiresClarification: false,
          groundedTargets: [normExplicit],
        };
      }
    }

    const extractedWithProv = TargetPathExtractor.extractWithProvenance(targetOrMessage, { repoFiles: normalizedRepo });
    const explicitPaths = extractedWithProv
      .filter((p) => p.provenance === "EXPLICIT_USER_PATH")
      .map((p) => p.path);

    if (explicitPaths.length > 0) {
      return {
        isDestructive: true,
        isInFileModification: false,
        targetCertainty: "EXPLICIT",
        requiresClarification: false,
        groundedTargets: explicitPaths,
      };
    }

    // Step B: Unique User-Named Repository Entity
    if (normalizedRepo.length > 0) {
      const groundedEntities = TargetPathExtractor.extractGroundedEntitiesWithProvenance(targetOrMessage, normalizedRepo);
      if (groundedEntities.length > 0) {
        return {
          isDestructive: true,
          isInFileModification: false,
          targetCertainty: "GROUNDED_UNIQUE",
          requiresClarification: false,
          groundedTargets: groundedEntities.map((g) => g.path),
        };
      }
    }

    // Step C: Check if a named entity exists but is ambiguous or nonexistent
    const candidateTokens: string[] = [];
    const DESCRIPTIVE_MODIFIERS = TargetPathExtractor.DESCRIPTIVE_MODIFIERS;
    const VAGUE_TARGET_WORDS = TargetPathExtractor.VAGUE_TARGET_WORDS;

    const namedEntityMatches = targetOrMessage.matchAll(/\b([A-Z][a-zA-Z0-9]{2,})\b/g);
    for (const m of namedEntityMatches) {
      const tok = m[1];
      if (!DESCRIPTIVE_MODIFIERS.has(tok.toLowerCase()) && !VAGUE_TARGET_WORDS.has(tok.toLowerCase())) {
        candidateTokens.push(tok);
      }
    }

    if (candidateTokens.length > 0 && normalizedRepo.length > 0) {
      let firstAmbiguousResult: DestructiveSafetyAssessment | null = null;
      let firstNonexistentResult: DestructiveSafetyAssessment | null = null;

      for (const tok of candidateTokens) {
        const key = TargetPathExtractor.normalizeEntityKey(tok);
        if (key.length < 3) continue;

        const tokenWords = TargetPathExtractor.tokenizeEntity(tok).filter(
          (w) => !DESCRIPTIVE_MODIFIERS.has(w) && !VAGUE_TARGET_WORDS.has(w)
        );

        const matches: string[] = [];
        for (const rf of normalizedRepo) {
          const stem = path.basename(rf).replace(/\.[^.]+$/, "");
          const stemKey = TargetPathExtractor.normalizeEntityKey(stem);
          const pathSegments = rf.toLowerCase().split(/[\s\-_./\\]+/);

          if (stemKey === key || pathSegments.includes(key)) {
            matches.push(rf);
          } else if (tokenWords.length >= 2) {
            const stemTokens = TargetPathExtractor.tokenizeEntity(stem);
            if (tokenWords.every((tw) => stemTokens.includes(tw))) {
              matches.push(rf);
            }
          }
        }

        const codeMatches = matches.filter((m) => /\.(?:tsx|ts|jsx|js|py|go|rs)$/i.test(m));

        if (codeMatches.length === 1) {
          return {
            isDestructive: true,
            isInFileModification: false,
            targetCertainty: "GROUNDED_UNIQUE",
            requiresClarification: false,
            groundedTargets: codeMatches,
          };
        } else if (codeMatches.length > 1) {
          firstAmbiguousResult = {
            isDestructive: true,
            isInFileModification: false,
            targetCertainty: "AMBIGUOUS",
            requiresClarification: true,
            clarificationQuestion: `Multiple matching files were found for "${tok}": ${codeMatches.join(", ")}. Please clarify which file to delete.`,
            clarificationOptions: [...codeMatches, "Cancel deletion"],
            groundedTargets: [],
          };
          break;
        } else if (matches.length === 0 && !firstNonexistentResult) {
          firstNonexistentResult = {
            isDestructive: true,
            isInFileModification: false,
            targetCertainty: "NONEXISTENT",
            requiresClarification: true,
            clarificationQuestion: `No repository file matching "${tok}" was found. Please specify the exact file path to delete.`,
            clarificationOptions: ["Specify target file path", "Cancel deletion"],
            groundedTargets: [],
          };
        }
      }

      if (firstAmbiguousResult) {
        return firstAmbiguousResult;
      }
      if (firstNonexistentResult) {
        return firstNonexistentResult;
      }
    }

    // Step D: Vague destructive request without specific target
    return {
      isDestructive: isDestructive,
      isInFileModification: false,
      targetCertainty: "VAGUE",
      requiresClarification: true,
      clarificationQuestion: "The request is destructive but does not identify which files or components should be removed. Please specify the exact file or component path to delete.",
      clarificationOptions: ["Specify target files or components", "Cancel deletion"],
      groundedTargets: [],
    };
  }
}
