import { TargetPathExtractor } from "./TargetPathExtractor";
import { TaskType } from "../classification/TaskTypes";

export type UserClauseOperation = "DELETE" | "CREATE" | "MODIFY" | "REPAIR" | "REFACTOR" | "UNKNOWN";

export interface UserAuthorizedClause {
  readonly id: string;
  readonly sourceText: string;
  readonly sourceStart?: number;
  readonly sourceEnd?: number;
  readonly operation: UserClauseOperation;
  readonly subject: string;
  readonly entityTokens: readonly string[];
}

export interface StageClauseBindingResult {
  readonly clause?: UserAuthorizedClause;
  readonly isAmbiguous: boolean;
}

export const singularizeWord = (w: string): string => {
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

export class UserClauseExtractor {
  private static readonly DELETE_VERBS = new Set([
    "remove",
    "delete",
    "rm",
    "purge",
    "drop",
    "prune",
    "clean",
    "destroy",
  ]);

  private static readonly CREATE_VERBS = new Set([
    "implement",
    "add",
    "create",
    "build",
    "make",
    "introduce",
  ]);

  private static readonly MODIFY_VERBS = new Set([
    "update",
    "modify",
    "refactor",
    "fix",
    "replace",
    "rename",
    "edit",
    "enhance",
    "improve",
    "redesign",
    "change",
    "style",
  ]);

  public static extractSubstantiveTokens(text: string): string[] {
    if (!text || typeof text !== "string") return [];
    const rawTokens = TargetPathExtractor.tokenizeEntity(text).map(singularizeWord);
    return rawTokens.filter(
      (w) =>
        !TargetPathExtractor.COMMAND_VERBS.has(w) &&
        !TargetPathExtractor.DIRECTIVE_VERBS.has(w) &&
        !TargetPathExtractor.GRAMMAR_WORDS.has(w) &&
        !TargetPathExtractor.VAGUE_TARGET_WORDS.has(w) &&
        !TargetPathExtractor.DESCRIPTIVE_MODIFIERS.has(w) &&
        !TargetPathExtractor.GENERIC_PROSE_WORDS.has(w)
    );
  }

  /**
   * Deterministically extracts user-authorized clauses strictly from the trusted user request.
   * No LLM-generated text may become the source of clause authority.
   */
  public static extractClauses(message: string): UserAuthorizedClause[] {
    if (!message || typeof message !== "string" || !message.trim()) {
      return [];
    }

    const trimmed = message.trim();
    const commandPattern = Array.from(TargetPathExtractor.COMMAND_VERBS).join("|");
    const verbRegex = new RegExp(`\\b(${commandPattern})\\b`, "gi");

    interface ClauseMarker {
      verb: string;
      startIndex: number;
    }

    const markers: ClauseMarker[] = [];
    let match: RegExpExecArray | null;

    while ((match = verbRegex.exec(trimmed)) !== null) {
      const startIndex = match.index;
      const verb = match[1].toLowerCase();
      const preceding = trimmed.slice(0, startIndex);
      const precedingTrimmed = preceding.trim();

      const isImperativeClauseStart =
        startIndex === 0 ||
        /[.!?;\n]\s*$/.test(preceding) ||
        /(?:^|[,;])\s*(?:and\s+then|and|then|also|but|now)\s*$/i.test(precedingTrimmed) ||
        /\b(?:and\s+then|and|then|also|but|now)\s*$/i.test(precedingTrimmed) ||
        /[;,]\s*$/.test(precedingTrimmed);

      if (isImperativeClauseStart) {
        markers.push({ verb, startIndex });
      }
    }

    if (markers.length === 0) {
      // Fallback: single clause representing whole request
      const tokens = this.extractSubstantiveTokens(trimmed);
      return [
        {
          id: "clause-1",
          sourceText: trimmed,
          sourceStart: 0,
          sourceEnd: trimmed.length,
          operation: "UNKNOWN",
          subject: tokens.join(" ") || trimmed,
          entityTokens: tokens,
        },
      ];
    }

    const clauses: UserAuthorizedClause[] = [];

    for (let i = 0; i < markers.length; i++) {
      const current = markers[i];
      const next = i + 1 < markers.length ? markers[i + 1] : null;

      let clauseEnd = next ? next.startIndex : trimmed.length;
      let rawClauseText = trimmed.slice(current.startIndex, clauseEnd);

      // Strip trailing punctuation / conjunctions that lead into the next clause
      rawClauseText = rawClauseText
        .replace(/(?:[;,]|\b(?:and\s+then|and|then|also|but|now)\b|\s)+$/i, "")
        .trim();

      const op: UserClauseOperation = this.DELETE_VERBS.has(current.verb)
        ? "DELETE"
        : this.CREATE_VERBS.has(current.verb)
        ? "CREATE"
        : current.verb === "fix"
        ? "REPAIR"
        : current.verb === "refactor"
        ? "REFACTOR"
        : this.MODIFY_VERBS.has(current.verb)
        ? "MODIFY"
        : "UNKNOWN";

      const tokens = this.extractSubstantiveTokens(rawClauseText);
      const subject = tokens.join(" ") || rawClauseText;

      clauses.push({
        id: `clause-${i + 1}`,
        sourceText: rawClauseText,
        sourceStart: current.startIndex,
        sourceEnd: current.startIndex + rawClauseText.length,
        operation: op,
        subject,
        entityTokens: tokens,
      });
    }

    return clauses;
  }

  private static isOperationCompatible(stageType: TaskType, clauseOp: UserClauseOperation): boolean {
    if (clauseOp === "UNKNOWN") return true;

    if (stageType === "DELETE_FILE" || stageType === "DELETE_FOLDER") {
      return clauseOp === "DELETE";
    }

    if (stageType === "NEW_FEATURE" || stageType === "FILE_CREATION") {
      return clauseOp === "CREATE" || clauseOp === "MODIFY";
    }

    if (stageType === "BUG_FIX") {
      return clauseOp === "REPAIR" || clauseOp === "MODIFY";
    }

    if (stageType === "REFACTOR") {
      return clauseOp === "REFACTOR" || clauseOp === "MODIFY";
    }

    return clauseOp !== "DELETE";
  }

  /**
   * Deterministically associates an execution stage with ONE compatible user-authorized clause.
   * If mapping cannot be established confidently or is ambiguous: returns isAmbiguous = true / clause = undefined (fail closed).
   */
  public static bindStageToClause(
    stage: { taskType: TaskType; goal: string; name?: string; targetPath?: string },
    clauses: readonly UserAuthorizedClause[]
  ): StageClauseBindingResult {
    if (!clauses || clauses.length === 0) {
      return { clause: undefined, isAmbiguous: false };
    }

    if (clauses.length === 1) {
      const c = clauses[0];
      if (this.isOperationCompatible(stage.taskType, c.operation)) {
        return { clause: c, isAmbiguous: false };
      }
      return { clause: undefined, isAmbiguous: false };
    }

    // Compound request: Score each clause
    const stageGoalTokens = this.extractSubstantiveTokens(
      `${stage.goal || ""} ${stage.name || ""} ${stage.targetPath || ""}`
    );
    const stageTokenSet = new Set(stageGoalTokens);

    let bestScore = -Infinity;
    const scoredClauses: Array<{ clause: UserAuthorizedClause; score: number }> = [];

    for (const c of clauses) {
      if (!this.isOperationCompatible(stage.taskType, c.operation)) {
        continue;
      }

      let score = 10; // Base score for compatible operation

      // Subject / entity token overlap
      for (const tok of c.entityTokens) {
        if (stageTokenSet.has(tok)) {
          score += 15;
        }
      }

      // Check targetPath match
      if (stage.targetPath) {
        const normTarget = stage.targetPath.toLowerCase();
        for (const tok of c.entityTokens) {
          if (normTarget.includes(tok)) {
            score += 20;
          }
        }
      }

      // Exact source span / inclusion boost
      const cSourceNorm = c.sourceText.toLowerCase();
      const sGoalNorm = (stage.goal || "").toLowerCase();
      if (sGoalNorm.includes(cSourceNorm) || cSourceNorm.includes(sGoalNorm)) {
        score += 25;
      }

      scoredClauses.push({ clause: c, score });
      if (score > bestScore) {
        bestScore = score;
      }
    }

    if (scoredClauses.length === 0 || bestScore <= 0) {
      return { clause: undefined, isAmbiguous: false };
    }

    const topMatches = scoredClauses.filter((sc) => sc.score === bestScore);
    if (topMatches.length === 1) {
      return { clause: topMatches[0].clause, isAmbiguous: false };
    }

    // Multiple clauses tied for top score -> Ambiguous binding! Fail closed!
    return { clause: undefined, isAmbiguous: true };
  }
}
