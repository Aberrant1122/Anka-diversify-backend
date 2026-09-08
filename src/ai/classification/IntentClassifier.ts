import { getOpenAI } from "../shared/utils";
import { INTENT_CLASSIFIER_PROMPT } from "../prompts/classification";
import { TaskType, TaskRisk, TaskComplexity, TaskClassificationResult } from "./TaskTypes";
import { DestructiveSafetyEvaluator } from "./DestructiveSafetyEvaluator";
import { TargetPathExtractor } from "../contracts/TargetPathExtractor";

const VALID_TASK_TYPES = new Set<TaskType>([
  "DELETE_FOLDER",
  "DELETE_FILE",
  "NEW_FEATURE",
  "BUG_FIX",
  "REFACTOR",
  "FILE_CREATION",
  "CONFIG_CHANGE",
  "DOCS",
  "OPTIMIZATION",
]);

const VALID_RISKS = new Set<TaskRisk>(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
const VALID_COMPLEXITIES = new Set<TaskComplexity>(["SMALL", "MEDIUM", "LARGE", "COMPLEX"]);

export class IntentClassifier {
  /**
   * Classifies user intent and evaluates ambiguity.
   *
   * Invariants (Phase 1B):
   * 1. LLM structured classification is the ONLY semantic authority.
   * 2. No prompt keywords or regex overrides decide taskType, risk, complexity, intent, or target path.
   * 3. Explicit literal file paths supplied by user are parsed deterministically.
   * 4. If LLM result is unavailable or malformed, fails closed with UNKNOWN / CLASSIFICATION_FAILED.
   * 5. Destructive safety checks execute deterministically only after structured intent is established.
   */
  static async classifyIntentAndAmbiguity(
    message: string,
    projectContext: any,
    repoFiles?: string[],
    openaiClient?: any,
  ): Promise<TaskClassificationResult> {
    const effectiveRepoFiles: string[] =
      repoFiles ||
      projectContext?.repoFiles ||
      (Array.isArray(projectContext?.fileTree) ? projectContext.fileTree : []) ||
      (Array.isArray(projectContext?.keyFiles) ? projectContext.keyFiles.map((f: any) => typeof f === "string" ? f : f?.path || "") : []);

    const explicitUserPaths = TargetPathExtractor.extractWithProvenance(message, { repoFiles: effectiveRepoFiles })
      .filter((p) => p.provenance === "EXPLICIT_USER_PATH")
      .map((p) => p.path);

    try {
      const openai = openaiClient || getOpenAI();
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

      // Strict schema validation of LLM output
      if (!parsed.taskType || !VALID_TASK_TYPES.has(parsed.taskType)) {
        return {
          taskType: "UNKNOWN",
          risk: "HIGH",
          estimatedComplexity: "COMPLEX",
          intent: "CLASSIFICATION_FAILED",
          confidence: 0,
          requiresClarification: true,
          reasoning: "Classification failed: structured taskType is missing or invalid.",
          targetPath: explicitUserPaths[0],
          question: "Could you please clarify your request?",
          options: [],
        };
      }

      const taskType: TaskType = parsed.taskType;
      const risk: TaskRisk = VALID_RISKS.has(parsed.risk) ? parsed.risk : "MEDIUM";
      const estimatedComplexity: TaskComplexity = VALID_COMPLEXITIES.has(parsed.estimatedComplexity)
        ? parsed.estimatedComplexity
        : "MEDIUM";
      const intent = parsed.intent || (taskType === "DELETE_FOLDER" || taskType === "DELETE_FILE" ? taskType : "NEW_FEATURE");

      // Extract target path from explicit user input or structured LLM response
      let parsedTargetPath: string | undefined;
      if (typeof parsed.targetPath === "string" && parsed.targetPath.trim()) {
        parsedTargetPath = parsed.targetPath.trim();
      } else if (Array.isArray(parsed.targetPath) && parsed.targetPath.length > 0) {
        parsedTargetPath = String(parsed.targetPath[0]).trim() || undefined;
      }

      let targetPath = explicitUserPaths[0] || parsedTargetPath;

      let confidence = typeof parsed.confidence === "number" ? parsed.confidence : 0.85;
      let requiresClarification = Boolean(parsed.requiresClarification);
      let clarificationQuestion = parsed.question;
      let clarificationOptions = parsed.options;
      let reasoning = parsed.reasoning || `Classified as ${taskType} (${risk} risk, ${estimatedComplexity} complexity)`;

      // Deterministic safety checks run AFTER intent is established
      if (taskType === "DELETE_FOLDER" || taskType === "DELETE_FILE" || intent === "DELETE_FOLDER" || intent === "DELETE_FILE") {
        const destructiveSafety = DestructiveSafetyEvaluator.evaluate(targetPath || message, effectiveRepoFiles, {
          isDestructive: true,
          taskType,
          targetPath,
        });

        if (destructiveSafety.groundedTargets.length > 0 && !targetPath) {
          targetPath = destructiveSafety.groundedTargets[0];
        }

        if (destructiveSafety.requiresClarification) {
          requiresClarification = true;
          confidence = 0.80;
          clarificationQuestion = destructiveSafety.clarificationQuestion || clarificationQuestion;
          clarificationOptions = destructiveSafety.clarificationOptions || clarificationOptions;
          reasoning = destructiveSafety.clarificationQuestion || "Destructive target is ambiguous or ungrounded.";
        } else {
          requiresClarification = false;
          confidence = 0.95;
        }
      }

      return {
        taskType,
        risk,
        estimatedComplexity,
        intent,
        confidence,
        requiresClarification,
        reasoning,
        targetPath,
        question: clarificationQuestion,
        options: clarificationOptions,
      };
    } catch {
      // Fail closed: Do NOT guess taskType, risk, complexity, intent, or target path from prompt keywords
      return {
        taskType: "UNKNOWN",
        risk: "HIGH",
        estimatedComplexity: "COMPLEX",
        intent: "CLASSIFICATION_FAILED",
        confidence: 0,
        requiresClarification: true,
        reasoning: "Classification failed: LLM structured response unavailable or malformed.",
        targetPath: explicitUserPaths[0],
        question: "Could you please clarify your request?",
        options: [],
      };
    }
  }
}
