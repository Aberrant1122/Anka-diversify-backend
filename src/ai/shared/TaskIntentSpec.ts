import { TaskType, TaskRisk, TaskComplexity, TaskClassificationResult } from "../classification/TaskTypes";

export type TaskOperationKind = "CREATE" | "MODIFY" | "DELETE" | "REPAIR" | "REFACTOR";

export interface TaskIntentOperation {
  kind: TaskOperationKind;
  subject: string;
  evidenceQuote?: string;
}

export interface TaskIntentSpec {
  goal: string;
  operations: TaskIntentOperation[];
  constraints: string[];
  acceptanceCriteria: string[];
  destructive: boolean;
  requiresClarification: boolean;
  taskType: TaskType;
  risk: TaskRisk;
  estimatedComplexity: TaskComplexity;
  explicitUserPaths: string[];
  reasoning?: string;
  question?: string;
  options?: string[];
}

/**
 * Derives a formal TaskIntentSpec from the structured LLM classification result and request message.
 *
 * Invariants (Phase 1 & Phase 2):
 * - ZERO feature-specific flags (no isDashboard, isTheme, isUIFeature, etc.).
 * - Destructive intent is strictly derived from taskType / structured operations.
 * - Explicit literal paths from the user are preserved as constraints/evidence.
 */
export function createTaskIntentSpec(
  message: string,
  classification: TaskClassificationResult,
  explicitUserPaths: string[] = []
): TaskIntentSpec {
  const operations: TaskIntentOperation[] = [];
  const isDestructive =
    classification.taskType === "DELETE_FOLDER" ||
    classification.taskType === "DELETE_FILE" ||
    classification.intent === "DELETE_FOLDER" ||
    classification.intent === "DELETE_FILE";

  if (isDestructive) {
    operations.push({
      kind: "DELETE",
      subject: classification.targetPath || explicitUserPaths[0] || message,
    });
  } else if (classification.taskType === "BUG_FIX") {
    operations.push({
      kind: "REPAIR",
      subject: classification.targetPath || explicitUserPaths[0] || message,
    });
  } else if (classification.taskType === "REFACTOR") {
    operations.push({
      kind: "REFACTOR",
      subject: classification.targetPath || explicitUserPaths[0] || message,
    });
  } else if (classification.taskType === "FILE_CREATION") {
    operations.push({
      kind: "CREATE",
      subject: classification.targetPath || explicitUserPaths[0] || message,
    });
  } else {
    // Default NEW_FEATURE / general constructive task
    operations.push({
      kind: "MODIFY",
      subject: message,
    });
    if (explicitUserPaths.length > 0) {
      for (const p of explicitUserPaths) {
        operations.push({
          kind: "MODIFY",
          subject: p,
        });
      }
    }
  }

  const constraints: string[] = [];
  if (explicitUserPaths.length > 0) {
    constraints.push(`User explicitly referenced path(s): ${explicitUserPaths.join(", ")}`);
  }

  const acceptanceCriteria: string[] = [
    `Fulfill user goal: ${message}`,
  ];
  if (isDestructive) {
    acceptanceCriteria.push("Ensure targeted entities are safely deleted and references cleaned up");
  } else {
    acceptanceCriteria.push("Ensure new/modified behavior builds without errors and passes tests");
  }

  return {
    goal: message,
    operations,
    constraints,
    acceptanceCriteria,
    destructive: isDestructive,
    requiresClarification: Boolean(classification.requiresClarification),
    taskType: classification.taskType,
    risk: classification.risk,
    estimatedComplexity: classification.estimatedComplexity,
    explicitUserPaths,
    reasoning: classification.reasoning,
    question: classification.question,
    options: classification.options,
  };
}
