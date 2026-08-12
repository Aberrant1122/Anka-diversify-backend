import { TaskType, TaskRisk, TaskComplexity } from "./TaskTypes";

export class TaskClassifier {
  static evaluateDefaults(message: string): {
    taskType: TaskType;
    risk: TaskRisk;
    estimatedComplexity: TaskComplexity;
  } {
    const isDeleteFolder = /remove|delete|rm\s+-rf|clean/i.test(message) && /folder|dir|directory|cache|lib|dist|build/i.test(message);
    const isDeleteFile = /remove|delete|unlink/i.test(message) && /file|\.ts|\.tsx|\.js|\.json|\.css/i.test(message);
    const isNewFeature = /build|create|add|implement|design|generate|setup/i.test(message) && /auth|authentication|login|feature|dashboard|payment|page|component|service/i.test(message);

    if (isDeleteFolder) {
      return { taskType: "DELETE_FOLDER", risk: "LOW", estimatedComplexity: "SMALL" };
    }
    if (isDeleteFile) {
      return { taskType: "DELETE_FILE", risk: "LOW", estimatedComplexity: "SMALL" };
    }
    if (isNewFeature) {
      return { taskType: "NEW_FEATURE", risk: "HIGH", estimatedComplexity: "LARGE" };
    }
    return { taskType: "NEW_FEATURE", risk: "MEDIUM", estimatedComplexity: "MEDIUM" };
  }
}
