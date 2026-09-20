import { bindUserRequest } from "../repository/TrustedTaskContext";
import {
  TaskExecutionPlan,
  TaskExecutionStage,
  TaskExecutionStageSpec,
  StageExecutionStatus,
  PriorVerifiedTarget,
} from "../shared/TaskExecutionPlan";
import type { ActionGroupJournalEntry } from "../runtime/VerifiedCheckpointJournal";
import { normalizeRepoPath } from "../repository/SemanticContextResolver";
import { createTaskIntentSpec, TaskIntentSpec } from "../shared/TaskIntentSpec";
import { TaskClassificationResult, TaskType } from "../classification/TaskTypes";
import { getOpenAI } from "../shared/utils";
import { LLMGateway } from "../gateway/LLMGateway";
import { PipelineStages } from "../gateway/PipelineStage";

export class TaskExecutionPlanManager {
  /**
   * Promotes only actually executed targets from an authentic VERIFIED journal
   * checkpoint. The copied path/action identities are advisory and contain no
   * evidence, capability, manifest, transaction, or revision authority.
   */
  public static recordVerifiedCheckpointTargets(
    plan: TaskExecutionPlan,
    checkpoint: Pick<ActionGroupJournalEntry, "status" | "attemptedActions">,
  ): TaskExecutionPlan {
    if (checkpoint.status !== "VERIFIED") return plan;

    const priorVerifiedTargets: PriorVerifiedTarget[] = checkpoint.attemptedActions.map((target) => ({
      path: normalizeRepoPath(target.path),
      action: target.action === "FILE_CREATE"
        ? "create"
        : target.action === "FILE_DELETE"
          ? "delete"
          : "modify",
    }));

    return { ...plan, priorVerifiedTargets };
  }

  public static clearPriorVerifiedTargets(plan: TaskExecutionPlan): TaskExecutionPlan {
    return plan.priorVerifiedTargets === undefined
      ? plan
      : { ...plan, priorVerifiedTargets: [] };
  }

  /**
   * Constructs the canonical TaskExecutionPlan from a user message and structured intent classification.
   * Preserves all decomposed stages or defaults to a 1-stage plan.
   */
  public static createTaskExecutionPlan(
    message: string,
    classification: TaskClassificationResult,
    explicitUserPaths: string[] = []
  ): TaskExecutionPlan {
    const classifiedStages = Array.isArray(classification.stages) ? classification.stages : [];
    const hasDistinctTaskTypes = new Set(classifiedStages.map((stage) => stage.taskType)).size > 1;
    const explicitPathSet = new Set(explicitUserPaths.map(normalizeRepoPath));
    const groundedStageTargets = classifiedStages
      .map((stage) => stage.targetPath && normalizeRepoPath(stage.targetPath))
      .filter((target): target is string => typeof target === "string" && explicitPathSet.has(target));
    const hasDistinctExplicitStageTargets = classifiedStages.length > 1 &&
      groundedStageTargets.length === classifiedStages.length &&
      new Set(groundedStageTargets).size === classifiedStages.length;
    const representsDistinctDeliverables = hasDistinctTaskTypes || hasDistinctExplicitStageTargets;
    const rawStages: TaskExecutionStageSpec[] = classifiedStages.length === 1 || representsDistinctDeliverables
      ? classifiedStages
      : [
          {
            id: "stage-1",
            name: message,
            taskType: classification.taskType,
            goal: message,
            targetPath: explicitUserPaths[0] || undefined,
            dependsOn: [],
          },
        ];

    const stages: TaskExecutionStage[] = rawStages.map((s, idx) => {
      const stageClassification: TaskClassificationResult = {
        taskType: s.taskType,
        risk: classification.risk,
        estimatedComplexity: classification.estimatedComplexity,
        intent: (s.taskType === "DELETE_FOLDER" || s.taskType === "DELETE_FILE"
          ? s.taskType
          : s.taskType === "BUG_FIX"
          ? "BUG_FIX"
          : s.taskType === "REFACTOR"
          ? "REFACTOR"
          : "NEW_FEATURE") as any,
        confidence: classification.confidence,
        requiresClarification: false,
        reasoning: `Stage ${idx + 1}: ${s.goal}`,
        successCondition: s.successCondition ?? (
          s.taskType === classification.taskType ? classification.successCondition : undefined
        ),
        targetPath: s.targetPath || (idx === 0 ? explicitUserPaths[0] : undefined),
      };

      const stageExplicitPaths = (s.targetPath && explicitUserPaths.includes(s.targetPath)) ? [s.targetPath] : idx === 0 ? explicitUserPaths : [];
      const stageIntent = createTaskIntentSpec(s.goal, stageClassification, stageExplicitPaths);
      bindUserRequest(stageIntent, message);

      return {
        id: s.id || `stage-${idx + 1}`,
        name: s.name || s.goal,
        intent: stageIntent,
        dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn : idx > 0 ? [`stage-${idx}`] : [],
        status: "PENDING" as StageExecutionStatus,
      };
    });

    return {
      id: `plan-${Date.now()}`,
      goal: message,
      stages,
      currentStageIndex: 0,
      status: "PENDING",
    };
  }

  /**
   * Parses client clarification format (e.g. "original\n\nCLARIFICATION SO FAR:\nQ: ...\nA: ...")
   * into structured components without mutating or relying on freeform text as truth.
   */
  public static parseClarificationInput(
    message: string
  ): { initialRequest: string; clarificationQas: Array<{ question: string; answer: string }> } | null {
    if (!message || typeof message !== "string") return null;

    const marker = "CLARIFICATION SO FAR:";
    const markerIndex = message.indexOf(marker);
    if (markerIndex === -1) return null;

    const initialRequest = message.slice(0, markerIndex).trim();
    const clarificationSection = message.slice(markerIndex + marker.length).trim();

    const qas: Array<{ question: string; answer: string }> = [];
    const lines = clarificationSection.split("\n");
    let currentQ = "";
    let currentA = "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("Q:") || trimmed.startsWith("❓")) {
        if (currentQ && currentA) {
          qas.push({ question: currentQ, answer: currentA });
          currentQ = "";
          currentA = "";
        }
        currentQ = trimmed.replace(/^Q:\s*/, "").replace(/^❓\s*/, "").trim();
      } else if (trimmed.startsWith("A:")) {
        currentA = trimmed.replace(/^A:\s*/, "").trim();
      } else if (currentA) {
        currentA += ` ${trimmed}`;
      } else if (currentQ) {
        currentQ += ` ${trimmed}`;
      }
    }

    if (currentQ && currentA) {
      qas.push({ question: currentQ, answer: currentA });
    }

    return {
      initialRequest: initialRequest || message,
      clarificationQas: qas,
    };
  }

  /**
   * Reorders plan stages based on user clarification response.
   * Invariant: Both/all stages are preserved. The clarification reorders priorities; it does NOT delete stages.
   */
  public static async reorderPlanWithClarification(
    plan: TaskExecutionPlan,
    clarificationAnswer: string,
    clarificationQuestion?: string,
    openaiClient?: any
  ): Promise<TaskExecutionPlan> {
    if (!plan.stages || plan.stages.length === 0) {
      return plan;
    }

    const trimmedAnswer = (clarificationAnswer || "").trim();

    // Negation check: "do not cancel", "don't cancel deletion", "continue, do not abort" must NOT cancel
    const isNegated =
      /\b(?:do\s+not|don'?t|never|not|no\s+need\s+to)\b.*\b(?:cancel|abort|skip|stop)\b/i.test(trimmedAnswer) ||
      /\bcontinue\b/i.test(trimmedAnswer);

    // Answer check: Must explicitly express cancellation of the destructive stage. Bare "no" must NOT cancel.
    const isExplicitCancellation =
      !isNegated &&
      (/\b(?:cancel|abort|skip)\b.*\b(?:deletion|delete|removal|remove|stage|operation)\b/i.test(trimmedAnswer) ||
        /^(?:cancel\s+deletion|cancel\s+delete|cancel\s+removal|abort\s+deletion)$/i.test(trimmedAnswer));

    // Identify the specific destructive stage associated with this clarification
    const activeOrCurrentStage = plan.stages[plan.currentStageIndex];
    const targetDestructiveStage =
      (activeOrCurrentStage &&
        (activeOrCurrentStage.intent.destructive ||
          activeOrCurrentStage.intent.taskType === "DELETE_FILE" ||
          activeOrCurrentStage.intent.taskType === "DELETE_FOLDER"))
        ? activeOrCurrentStage
        : plan.stages.find(
            (s) =>
              (s.status === "PENDING" || s.status === "RUNNING") &&
              (s.intent.destructive ||
                s.intent.taskType === "DELETE_FILE" ||
                s.intent.taskType === "DELETE_FOLDER")
          );

    const isDestructiveStage = Boolean(
      targetDestructiveStage &&
        (targetDestructiveStage.intent.destructive ||
          targetDestructiveStage.intent.taskType === "DELETE_FILE" ||
          targetDestructiveStage.intent.taskType === "DELETE_FOLDER")
    );

    const isDestructiveContext =
      isDestructiveStage &&
      ((clarificationQuestion && /\b(?:delete|deletion|remove|removal|target|matching|file)\b/i.test(clarificationQuestion)) ||
        /\b(?:deletion|delete|removal|remove)\b/i.test(trimmedAnswer));

    if (isExplicitCancellation && isDestructiveContext && targetDestructiveStage) {
        const updatedStages = plan.stages.map((s) => {
          if (s.id === targetDestructiveStage.id) {
            return { ...s, status: "CANCELLED" as StageExecutionStatus };
          }
          // If a sibling stage only had an artificial sequential dependency on the cancelled stage,
          // relieve the dependency so independent constructive work can proceed.
          if (
            s.dependsOn?.includes(targetDestructiveStage.id) &&
            !s.intent.destructive &&
            s.intent.taskType !== "DELETE_FILE" &&
            s.intent.taskType !== "DELETE_FOLDER"
          ) {
            return {
              ...s,
              dependsOn: s.dependsOn.filter((depId) => depId !== targetDestructiveStage.id),
            };
          }
          return s;
        });

        const intermediatePlan: TaskExecutionPlan = {
          ...plan,
          stages: updatedStages,
        };

        const nextEligible = this.getNextEligibleStage(intermediatePlan);
        const nextIndex = nextEligible
          ? updatedStages.findIndex((s) => s.id === nextEligible.id)
          : updatedStages.findIndex((s) => s.status === "PENDING");

        const hasPending = updatedStages.some((s) => s.status === "PENDING");
        const hasFailed = updatedStages.some((s) => s.status === "FAILED");
        const anyVerified = updatedStages.some((s) => s.status === "VERIFIED");

        let status: TaskExecutionPlan["status"] = "RUNNING";
        if (nextEligible) {
          status = "RUNNING";
        } else if (hasPending || hasFailed || !anyVerified) {
          status = "FAILED";
        } else {
          status = "COMPLETED";
        }

        return {
          ...intermediatePlan,
          currentStageIndex: nextIndex >= 0 ? nextIndex : plan.currentStageIndex,
          status,
        };
      }

    if (plan.stages.length <= 1) {
      return plan;
    }

    let prioritizedStageId: string | null = null;

    // 1. Try structured model-based priority matching
    try {
      const stageSummaries = plan.stages.map((s) => ({
        id: s.id,
        taskType: s.intent.taskType,
        goal: s.intent.goal,
      }));
      const allowedStageIds = new Set(plan.stages.map((stage) => stage.id));

      const prompt = `You are a Task Priority Classifier.
Given these planned execution stages:
${JSON.stringify(stageSummaries, null, 2)}

Clarification Question Asked: "${clarificationQuestion || "Which task to prioritize?"}"
User Clarification Answer: "${clarificationAnswer}"

Determine which stage ID the user chose to execute FIRST.
Respond ONLY with valid JSON:
{
  "prioritizedStageId": "stage-id-string"
}`;

      const gateway = LLMGateway.getInstance();
      const response = await gateway.callStructured<{ prioritizedStageId: string }>({
        stage: PipelineStages.PLAN_REORDER,
        openaiClient,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.0,
        schema: {
          name: "PlanReorderSchema",
          strict: true,
          schema: {
            type: "object",
            properties: {
              prioritizedStageId: { type: "string" },
            },
            required: ["prioritizedStageId"],
            additionalProperties: false,
          },
          validate: (parsed) => {
            const valid = Boolean(
              parsed && typeof parsed === "object" && !Array.isArray(parsed)
              && Object.keys(parsed).length === 1
              && typeof parsed.prioritizedStageId === "string"
              && allowedStageIds.has(parsed.prioritizedStageId)
            );
            return { valid, errors: valid ? undefined : ["prioritizedStageId must identify a current plan stage"], data: parsed };
          },
        },
      });

      const parsed = response.content;
      if (parsed.prioritizedStageId && plan.stages.some((s) => s.id === parsed.prioritizedStageId)) {
        prioritizedStageId = parsed.prioritizedStageId;
      }
    } catch {
      // Fallback to deterministic semantic matching below (zero user clarification manufactured)
    }

    // 2. Deterministic semantic token matching fallback (zero keyword hardcoding)
    if (!prioritizedStageId) {
      const answerTokens = new Set(
        clarificationAnswer
          .toLowerCase()
          .replace(/[^\w\s]/g, "")
          .split(/\s+/)
          .filter((t) => t.length > 2)
      );

      let bestScore = -1;
      for (const stage of plan.stages) {
        const goalTokens = stage.intent.goal
          .toLowerCase()
          .replace(/[^\w\s]/g, "")
          .split(/\s+/)
          .filter((t) => t.length > 2);

        let overlap = 0;
        for (const token of goalTokens) {
          if (answerTokens.has(token)) overlap++;
        }

        // Semantic alignment on taskType
        const typeToken = stage.intent.taskType.toLowerCase();
        if (clarificationAnswer.toLowerCase().includes(typeToken) || answerTokens.has(typeToken)) {
          overlap += 3;
        }

        if (overlap > bestScore) {
          bestScore = overlap;
          prioritizedStageId = stage.id;
        }
      }
    }

    if (!prioritizedStageId) {
      return plan;
    }

    const prioritizedIndex = plan.stages.findIndex((s) => s.id === prioritizedStageId);
    if (prioritizedIndex <= 0) {
      // Already first or not found
      return plan;
    }

    if ((plan.stages[prioritizedIndex].dependsOn || []).length > 0) {
      return plan;
    }

    const reorderedStages = [...plan.stages];
    const [prioritizedStage] = reorderedStages.splice(prioritizedIndex, 1);

    reorderedStages.unshift(prioritizedStage);

    return {
      ...plan,
      stages: reorderedStages,
      currentStageIndex: 0,
    };
  }

  /**
   * Advances the plan to the next stage upon successful verification of the current stage.
   */
  public static advancePlanStage(plan: TaskExecutionPlan): {
    plan: TaskExecutionPlan;
    nextStage: TaskExecutionStage | null;
  } {
    const updatedStages = [...plan.stages];
    if (
      updatedStages[plan.currentStageIndex] &&
      updatedStages[plan.currentStageIndex].status !== "CANCELLED"
    ) {
      updatedStages[plan.currentStageIndex] = {
        ...updatedStages[plan.currentStageIndex],
        status: "VERIFIED",
      };
    }

    const intermediatePlan: TaskExecutionPlan = {
      ...plan,
      stages: updatedStages,
    };

    const nextEligible = this.getNextEligibleStage(intermediatePlan);
    if (nextEligible) {
      const nextIndex = updatedStages.findIndex((s) => s.id === nextEligible.id);
      return {
        plan: {
          ...intermediatePlan,
          currentStageIndex: nextIndex,
          status: "RUNNING",
        },
        nextStage: nextEligible,
      };
    }

    const hasPending = updatedStages.some((s) => s.status === "PENDING");
    const hasFailed = updatedStages.some((s) => s.status === "FAILED");
    const anyVerified = updatedStages.some((s) => s.status === "VERIFIED");

    let terminalStatus: TaskExecutionPlan["status"] = "COMPLETED";
    if (hasPending || hasFailed || !anyVerified) {
      terminalStatus = "FAILED";
    }

    return {
      plan: {
        ...intermediatePlan,
        currentStageIndex: updatedStages.length,
        status: terminalStatus,
      },
      nextStage: null,
    };
  }

  /**
   * Updates status for a specific stage ID.
   */
  public static markStageStatus(
    plan: TaskExecutionPlan,
    stageId: string,
    status: StageExecutionStatus
  ): TaskExecutionPlan {
    const updatedStages = plan.stages.map((s) => (s.id === stageId ? { ...s, status } : s));
    return {
      ...plan,
      stages: updatedStages,
    };
  }

  /**
   * Evaluates whether a given stage is eligible to execute according to TaskExecutionPlan dependency structure:
   * 1. Stage status must be "PENDING".
   * 2. Every stage referenced in stage.dependsOn must exist and have status "VERIFIED".
   * If any dependency is PENDING, RUNNING, CANCELLED, or FAILED, returns false.
   */
  public static isStageEligible(plan: TaskExecutionPlan, stageId: string): boolean {
    const stage = plan.stages.find((s) => s.id === stageId);
    if (!stage) return false;
    if (stage.status !== "PENDING") return false;

    for (const depId of stage.dependsOn || []) {
      const depStage = plan.stages.find((s) => s.id === depId);
      if (!depStage) return false;
      if (depStage.status === "VERIFIED") continue;
      return false;
    }
    return true;
  }

  /**
   * Finds all dependent stages that depend directly or transitively on a specified stage ID.
   */
  public static getDependentStages(plan: TaskExecutionPlan, stageId: string): string[] {
    const dependent = new Set<string>();
    const queue = [stageId];

    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const stage of plan.stages) {
        if ((stage.dependsOn || []).includes(current) && !dependent.has(stage.id)) {
          dependent.add(stage.id);
          queue.push(stage.id);
        }
      }
    }

    return Array.from(dependent);
  }

  /**
   * Returns the next eligible stage in the plan, or null if no pending stage has its dependencies satisfied.
   */
  public static getNextEligibleStage(plan: TaskExecutionPlan): TaskExecutionStage | null {
    for (const stage of plan.stages) {
      if (this.isStageEligible(plan, stage.id)) {
        return stage;
      }
    }
    return null;
  }

  /**
   * Marks a stage as FAILED and sets plan status to FAILED.
   */
  public static failStage(plan: TaskExecutionPlan, stageId: string): TaskExecutionPlan {
    const updatedStages = plan.stages.map((s) =>
      s.id === stageId ? { ...s, status: "FAILED" as StageExecutionStatus } : s
    );
    return {
      ...plan,
      stages: updatedStages,
      status: "FAILED",
    };
  }
}
