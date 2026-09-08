import { TaskType, TaskRisk, TaskComplexity } from "./TaskTypes";

/**
 * @deprecated TaskClassifier was a legacy keyword-based heuristic.
 * Per Phase 1B requirements, it is NON-AUTHORITATIVE and retained solely for diagnostic/telemetry purposes.
 * It MUST NOT be used in any production path affecting taskType, risk, complexity, intent, routing,
 * manifest, scope, validation, or write authorization.
 */
export class TaskClassifier {
  static evaluateDefaults(message: string): {
    taskType: TaskType;
    risk: TaskRisk;
    estimatedComplexity: TaskComplexity;
  } {
    // Diagnostic-only fallback representation
    return { taskType: "UNKNOWN", risk: "LOW", estimatedComplexity: "SMALL" };
  }
}
