import { getOpenAI } from "../shared/utils";
import { INTENT_CLASSIFIER_PROMPT } from "../prompts/classification";
import { TaskType, TaskRisk, TaskComplexity, TaskClassificationResult } from "./TaskTypes";
import { TaskSuccessCondition } from "../../types";
import { DestructiveSafetyEvaluator } from "./DestructiveSafetyEvaluator";
import { TargetPathExtractor } from "../contracts/TargetPathExtractor";
import { LLMGateway } from "../gateway/LLMGateway";
import { PipelineStages } from "../gateway/PipelineStage";
import { ClarificationPolicy } from "../gateway/ClarificationPolicy";
import { AgentOutcomeType } from "../gateway/AgentOutcome";

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
const VALID_INTENTS = new Set<TaskClassificationResult["intent"]>([
  "BUG_FIX", "FEATURE_ADD", "REFACTOR", "DOCS", "OPTIMIZATION", "DELETE_FOLDER",
  "DELETE_FILE", "NEW_FEATURE", "UNKNOWN", "CLASSIFICATION_FAILED",
]);
const VALID_SUCCESS_CONDITIONS = new Set<TaskSuccessCondition>([
  "SOURCE_DIAGNOSTICS", "BUILD", "TEST_FAILURE", "BEHAVIORAL_VALIDATION", "DETERMINISTIC_STATE",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const set = new Set(allowed);
  return Object.keys(value).every((key) => set.has(key));
}

function isSafeRelativePath(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.includes("\0")) return false;
  const normalized = value.replace(/\\/g, "/");
  return !normalized.startsWith("/") && !/^[A-Za-z]:\//.test(normalized) && normalized.split("/").every((part) => part && part !== "." && part !== "..");
}

export class IntentClassifier {
  /**
   * Classifies user intent and evaluates ambiguity.
   *
   * Invariants (Phase 1B):
   * 1. LLM structured classification via LLMGateway is the ONLY semantic authority.
   * 2. No prompt keywords or regex overrides decide taskType, risk, complexity, intent, or target path.
   * 3. Explicit literal file paths supplied by user are parsed deterministically.
   * 4. If LLM result is unavailable or malformed, fails closed with UNKNOWN / CLASSIFICATION_FAILED.
   * 5. Destructive safety checks execute deterministically only after structured intent is established.
   * 6. Provider/technical errors NEVER produce user clarification requests.
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
      const gateway = LLMGateway.getInstance();
      const structuredRes = await gateway.callStructured<{
        taskType: TaskType;
        risk: TaskRisk;
        estimatedComplexity: TaskComplexity;
        intent: string;
        targetPath?: string | string[];
        confidence: number;
        requiresClarification: boolean;
        question?: string;
        options?: string[];
        reasoning: string;
        successCondition?: TaskSuccessCondition;
        stages?: any[];
      }>({
        stage: PipelineStages.INTENT_CLASSIFICATION,
        openaiClient,
        messages: [
          { role: "system", content: INTENT_CLASSIFIER_PROMPT },
          {
            role: "user",
            content: `USER REQUEST: ${message}\nPROJECT: ${projectContext?.project?.name || "Workspace"}\nACTIVE TASKS:\n${(projectContext?.activeTasks || []).map((t: any) => `- ${t.title}`).join("\n")}`,
          },
        ],
        temperature: 0.1,
        schema: {
          name: "IntentClassificationSchema",
          strict: false,
          schema: {
            type: "object",
            properties: {
              taskType: {
                type: "string",
                enum: Array.from(VALID_TASK_TYPES),
              },
              risk: {
                type: "string",
                enum: Array.from(VALID_RISKS),
              },
              estimatedComplexity: {
                type: "string",
                enum: Array.from(VALID_COMPLEXITIES),
              },
              intent: { type: "string" },
              targetPath: {
                anyOf: [
                  { type: "string" },
                  { type: "array", items: { type: "string" } },
                ],
              },
              confidence: { type: "number" },
              requiresClarification: { type: "boolean" },
              question: { type: "string" },
              options: { type: "array", items: { type: "string" } },
              reasoning: { type: "string" },
              successCondition: {
                type: "string",
                enum: Array.from(VALID_SUCCESS_CONDITIONS),
              },
              stages: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    id: { type: "string" },
                    taskType: { type: "string" },
                    goal: { type: "string" },
                    successCondition: {
                      type: "string",
                      enum: Array.from(VALID_SUCCESS_CONDITIONS),
                    },
                    targetPath: { type: "string" },
                    dependsOn: { type: "array", items: { type: "string" } },
                  },
                  required: ["id", "taskType", "goal", "dependsOn"],
                },
              },
            },
            required: ["taskType", "risk", "estimatedComplexity", "intent", "confidence", "requiresClarification", "reasoning"],
            additionalProperties: false,
          },
          validate: (parsed) => {
            if (!isRecord(parsed) || !onlyKeys(parsed, ["taskType", "risk", "estimatedComplexity", "intent", "targetPath", "confidence", "requiresClarification", "question", "options", "reasoning", "successCondition", "stages"])) return { valid: false, errors: ["Parsed intent output contains invalid fields"] };
            if (!VALID_TASK_TYPES.has(parsed.taskType as TaskType)) return { valid: false, errors: [`Invalid or missing taskType: ${parsed.taskType}`] };
            if (!VALID_RISKS.has(parsed.risk as TaskRisk)) return { valid: false, errors: ["Invalid or missing risk"] };
            if (!VALID_COMPLEXITIES.has(parsed.estimatedComplexity as TaskComplexity)) return { valid: false, errors: ["Invalid or missing estimatedComplexity"] };
            if (!VALID_INTENTS.has(parsed.intent as TaskClassificationResult["intent"])) return { valid: false, errors: ["Invalid or missing intent"] };
            if (typeof parsed.confidence !== "number" || !Number.isFinite(parsed.confidence) || parsed.confidence < 0 || parsed.confidence > 1) return { valid: false, errors: ["Invalid or missing confidence"] };
            if (typeof parsed.requiresClarification !== "boolean") return { valid: false, errors: ["Invalid or missing clarification flag"] };
            if (typeof parsed.reasoning !== "string" || !parsed.reasoning.trim() || (parsed.question !== undefined && (typeof parsed.question !== "string" || !parsed.question.trim()))) return { valid: false, errors: ["Invalid narrative field"] };
            if (parsed.successCondition !== undefined && !VALID_SUCCESS_CONDITIONS.has(parsed.successCondition as TaskSuccessCondition)) return { valid: false, errors: ["Invalid successCondition"] };
            if (parsed.options !== undefined && (!Array.isArray(parsed.options) || parsed.options.some((item) => typeof item !== "string" || !item.trim()))) return { valid: false, errors: ["Invalid clarification options"] };
            const paths = Array.isArray(parsed.targetPath) ? parsed.targetPath : parsed.targetPath === undefined ? [] : [parsed.targetPath];
            if (paths.some((item) => !isSafeRelativePath(item))) return { valid: false, errors: ["Invalid targetPath"] };
            if (parsed.stages !== undefined) {
              if (!Array.isArray(parsed.stages) || parsed.stages.length === 0) return { valid: false, errors: ["Invalid stages"] };
              const ids = new Set<string>();
              for (const stage of parsed.stages) {
                if (!isRecord(stage) || !onlyKeys(stage, ["id", "taskType", "goal", "successCondition", "targetPath", "dependsOn"]) || typeof stage.id !== "string" || !stage.id.trim() || ids.has(stage.id) || !VALID_TASK_TYPES.has(stage.taskType as TaskType) || typeof stage.goal !== "string" || !stage.goal.trim() || (stage.successCondition !== undefined && !VALID_SUCCESS_CONDITIONS.has(stage.successCondition as TaskSuccessCondition)) || (stage.targetPath !== undefined && !isSafeRelativePath(stage.targetPath)) || !Array.isArray(stage.dependsOn) || stage.dependsOn.some((id) => typeof id !== "string" || !id.trim() || id === stage.id)) return { valid: false, errors: ["Invalid stage decomposition"] };
                ids.add(stage.id);
              }
              if (parsed.stages.some((stage: any) => stage.dependsOn.some((id: string) => !ids.has(id)))) return { valid: false, errors: ["Stage dependency references an unknown ID"] };
            }
            return { valid: true };
          },
        },
      });

      const parsed = structuredRes.content;

      let taskType: TaskType = parsed.taskType;
      const risk: TaskRisk = parsed.risk && VALID_RISKS.has(parsed.risk) ? parsed.risk : "MEDIUM";
      const estimatedComplexity: TaskComplexity = parsed.estimatedComplexity && VALID_COMPLEXITIES.has(parsed.estimatedComplexity)
        ? parsed.estimatedComplexity
        : "MEDIUM";
      let intent: TaskClassificationResult["intent"] = (parsed.intent && VALID_INTENTS.has(parsed.intent as any))
        ? (parsed.intent as TaskClassificationResult["intent"])
        : (taskType === "DELETE_FOLDER" || taskType === "DELETE_FILE" ? taskType : "NEW_FEATURE");

      // Extract target path from explicit user input or structured LLM response
      let parsedTargetPath: string | undefined;
      if (typeof parsed.targetPath === "string" && parsed.targetPath.trim()) {
        parsedTargetPath = parsed.targetPath.trim();
      } else if (Array.isArray(parsed.targetPath) && parsed.targetPath.length > 0) {
        parsedTargetPath = String(parsed.targetPath[0]).trim() || undefined;
      }

      let targetPath = explicitUserPaths[0] || parsedTargetPath;

      let confidence = typeof parsed.confidence === "number" ? parsed.confidence : 0.85;
      let rawRequiresClarification = Boolean(parsed.requiresClarification);
      let clarificationQuestion = parsed.question;
      let clarificationOptions = parsed.options;
      let reasoning = parsed.reasoning || `Classified as ${taskType} (${risk} risk, ${estimatedComplexity} complexity)`;

      // Deterministic safety checks run AFTER intent is established
      // Only an explicit user path from the prompt can be treated as targetPath for safety;
      // never let an LLM-guessed path bypass repository ambiguity evaluation.
      const destructiveSafety = DestructiveSafetyEvaluator.evaluate(message, effectiveRepoFiles, {
        taskType,
        targetPath: explicitUserPaths[0],
      });

      let requiresClarification = rawRequiresClarification;

      if (
        taskType === "DELETE_FOLDER" ||
        taskType === "DELETE_FILE" ||
        intent === "DELETE_FOLDER" ||
        intent === "DELETE_FILE" ||
        destructiveSafety.isDestructive
      ) {
        if (destructiveSafety.isInFileModification) {
          taskType = "BUG_FIX";
          intent = "BUG_FIX";
          requiresClarification = false;
          confidence = 0.95;
        } else {
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
      }

      // Clarification Decision routing via ClarificationPolicy
      let outcome: AgentOutcomeType | undefined = undefined;
      if (requiresClarification) {
        const decision = ClarificationPolicy.evaluate({
          category: "USER_AMBIGUITY",
          question: clarificationQuestion,
          options: clarificationOptions,
          reason: reasoning,
          targetPath,
        });
        requiresClarification = decision.requiresClarification;
        outcome = decision.outcome;
      }

      let stages: TaskClassificationResult["stages"] = undefined;
      if (Array.isArray(parsed.stages) && parsed.stages.length > 0) {
        const validatedStages = [];
        for (let i = 0; i < parsed.stages.length; i++) {
          const s = parsed.stages[i];
          if (s && typeof s.goal === "string" && s.goal.trim()) {
            validatedStages.push({
              id: s.id.trim(),
              name: s.goal.trim(),
              taskType: s.taskType as TaskType,
              goal: s.goal.trim(),
              successCondition: s.successCondition as TaskSuccessCondition | undefined,
              targetPath: typeof s.targetPath === "string" && s.targetPath.trim() ? s.targetPath.trim() : undefined,
              dependsOn: s.dependsOn,
            });
          }
        }
        if (validatedStages.length > 0) {
          stages = validatedStages;
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
        successCondition: parsed.successCondition && VALID_SUCCESS_CONDITIONS.has(parsed.successCondition)
          ? parsed.successCondition
          : "BEHAVIORAL_VALIDATION",
        targetPath,
        question: requiresClarification ? clarificationQuestion : undefined,
        options: requiresClarification ? clarificationOptions : undefined,
        stages,
        outcome,
      };
    } catch (err: any) {
      // Technical/provider failure: NEVER becomes user clarification!
      const failureDecision = ClarificationPolicy.evaluate({
        category: "TECHNICAL_FAILURE",
        technicalError: err instanceof Error ? err : new Error(String(err)),
        reason: err?.message || "Classification failed due to technical failure.",
      });

      return {
        taskType: "UNKNOWN",
        risk: "HIGH",
        estimatedComplexity: "COMPLEX",
        intent: "CLASSIFICATION_FAILED",
        confidence: 0,
        requiresClarification: false, // Strictly FALSE on technical failure
        reasoning: `Classification failed due to technical failure: ${failureDecision.reason}`,
        targetPath: explicitUserPaths[0],
        question: undefined,
        options: [],
        outcome: "TECHNICAL_FAILURE",
        technicalError: failureDecision.technicalError,
      };
    }
  }
}
