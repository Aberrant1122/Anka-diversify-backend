import { getOpenAI } from "../shared/utils";
import { INTENT_CLASSIFIER_PROMPT } from "../prompts/classification";
import { TaskType, TaskRisk, TaskComplexity, TaskClassificationResult } from "./TaskTypes";
import { TaskClassifier } from "./TaskClassifier";

export class IntentClassifier {
  static async classifyIntentAndAmbiguity(
    message: string,
    projectContext: any,
  ): Promise<TaskClassificationResult> {
    const isDeleteFolder = /remove|delete|rm\s+-rf|clean/i.test(message) && /folder|dir|directory|cache|lib|dist|build/i.test(message);
    const isDeleteFile = /remove|delete|unlink/i.test(message) && /file|\.ts|\.tsx|\.js|\.json|\.css/i.test(message);
    const isNewFeature = /build|create|add|implement|design|generate|setup/i.test(message) && /auth|authentication|login|feature|dashboard|payment|page|component|service/i.test(message);

    const openai = getOpenAI();

    try {
      const completion = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          { role: "system", content: INTENT_CLASSIFIER_PROMPT },
          {
            role: "user",
            content: `USER REQUEST: ${message}\nPROJECT: ${projectContext?.project?.name || "Workspace"}\nACTIVE TASKS:\n${(projectContext?.activeTasks || []).map((t: any) => `- ${t.title}`).join("\n")}`,
          },
        ],
        temperature: 0.1,
        response_format: { type: "json_object" },
      });

      const parsed = JSON.parse(completion.choices[0]?.message?.content || "{}");
      const isActionRequest = /create|build|make|design|generate|add|remove|delete|rm|fix|update/i.test(message);

      const defaults = TaskClassifier.evaluateDefaults(message);

      const taskType: TaskType = parsed.taskType || defaults.taskType;
      const risk: TaskRisk = parsed.risk || defaults.risk;
      const estimatedComplexity: TaskComplexity = parsed.estimatedComplexity || defaults.estimatedComplexity;
      const intent = parsed.intent || (taskType === "DELETE_FOLDER" || taskType === "DELETE_FILE" ? "REFACTOR" : "NEW_FEATURE");
      const confidence = isActionRequest ? 0.95 : (typeof parsed.confidence === "number" ? parsed.confidence : 0.85);
      const requiresClarification = isActionRequest ? false : Boolean(parsed.requiresClarification && confidence < 0.70);

      let parsedTargetPath: string | undefined;
      if (typeof parsed.targetPath === "string" && parsed.targetPath.trim()) {
        parsedTargetPath = parsed.targetPath.trim();
      } else if (Array.isArray(parsed.targetPath) && parsed.targetPath.length > 0) {
        parsedTargetPath = String(parsed.targetPath[0]).trim() || undefined;
      }

      let regexTargetPath: string | undefined;
      if (!parsedTargetPath && (isDeleteFolder || isDeleteFile)) {
        const extracted = message.replace(
          /.*(?:remove|delete|rm)\s+(?:folder\s+|dir(?:ectory)?\s+|file\s+)?["']?([\w\-./\\]+)["']?.*/i,
          "$1",
        );
        if (extracted !== message && extracted.length < message.length && /[\w\-./\\]/.test(extracted)) {
          regexTargetPath = extracted.trim();
        }
      }

      const targetPath = parsedTargetPath || regexTargetPath;

      return {
        taskType,
        risk,
        estimatedComplexity,
        intent,
        confidence,
        requiresClarification,
        reasoning: parsed.reasoning || `Classified as ${taskType} (${risk} risk, ${estimatedComplexity} complexity)`,
        targetPath,
        question: parsed.question,
        options: parsed.options,
      };
    } catch {
      const defaults = TaskClassifier.evaluateDefaults(message);
      return {
        taskType: defaults.taskType,
        risk: defaults.risk,
        estimatedComplexity: defaults.estimatedComplexity,
        intent: defaults.taskType === "DELETE_FOLDER" || defaults.taskType === "DELETE_FILE" ? "REFACTOR" : "NEW_FEATURE",
        confidence: 0.95,
        requiresClarification: false,
        reasoning: `Fallback intent classifier determined ${defaults.taskType} (${defaults.risk} risk)`,
      };
    }
  }
}
