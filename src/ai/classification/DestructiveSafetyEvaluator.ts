import {
  DestructiveTargetResolver,
  DestructiveTargetResolution,
  DestructiveResolveOptions,
} from "../contracts/DestructiveTargetResolver";

export interface DestructiveSafetyAssessment {
  isDestructive: boolean;
  isInFileModification: boolean;
  targetCertainty: "EXPLICIT" | "GROUNDED_UNIQUE" | "AMBIGUOUS" | "NONEXISTENT" | "VAGUE";
  requiresClarification: boolean;
  clarificationQuestion?: string;
  clarificationOptions?: string[];
  groundedTargets: string[];
}

export interface DestructiveSafetyOptions extends DestructiveResolveOptions {}

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
    const resolution: DestructiveTargetResolution = DestructiveTargetResolver.resolve(
      targetOrMessage,
      repoFiles,
      options
    );

    return {
      isDestructive: resolution.isDestructive,
      isInFileModification: resolution.isInFileModification,
      targetCertainty: resolution.targetCertainty,
      requiresClarification: resolution.requiresClarification,
      clarificationQuestion: resolution.clarificationQuestion,
      clarificationOptions: resolution.clarificationOptions,
      groundedTargets: resolution.candidatePaths,
    };
  }
}
