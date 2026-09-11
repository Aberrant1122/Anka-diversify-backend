import path from "path";
import { ExecutionContract, TaskClassificationResult, TaskType } from "../shared/types";
import { FileActionObligation } from "../shared/TaskExecutionPlan";
import { routeTask } from "../../services/task-router.engine";
import { TargetPathExtractor } from "./TargetPathExtractor";
import { TargetScopeExpander } from "./TargetScopeExpander";
import { MonorepoDescriptor } from "../workspace/MonorepoDetector";
import { PolicyContract, POLICY_RULES } from "./PolicyContract";
import { TaskIntentSpec } from "../shared/TaskIntentSpec";

interface ContractRules {
  allowedActions: string[];
  forbiddenActions: string[];
  maxFiles: number;
  diffCriticEnabled: boolean;
}

const CONTRACT_RULES: Record<TaskType, ContractRules> = {
  DELETE_FOLDER: {
    allowedActions: ["delete_folder", "remove_imports", "update_references", "clean_barrel_exports"],
    forbiddenActions: ["refactor", "rename", "move_files", "merge_types", "create_utilities", "create_components", "add_routes"],
    maxFiles: 12,
    diffCriticEnabled: true,
  },
  DELETE_FILE: {
    allowedActions: ["delete_file", "remove_imports", "update_references"],
    forbiddenActions: ["refactor", "rename", "merge_types", "create_new_files", "add_routes"],
    maxFiles: 8,
    diffCriticEnabled: true,
  },
  NEW_FEATURE: {
    allowedActions: ["create_files", "add_routes", "add_imports", "write_service", "write_controller", "write_types", "write_tests"],
    forbiddenActions: ["delete_unrelated_folders", "delete_unrelated_files", "modify_core_config_without_reason"],
    maxFiles: 30,
    diffCriticEnabled: false,
  },
  BUG_FIX: {
    allowedActions: ["modify_file", "add_null_check", "update_types", "fix_import", "add_error_boundary"],
    forbiddenActions: ["create_new_pages", "delete_folders", "restructure_modules", "add_new_features"],
    maxFiles: 10,
    diffCriticEnabled: true,
  },
  REFACTOR: {
    allowedActions: ["modify_file", "rename_symbol", "move_file", "update_imports", "split_module", "extract_utility"],
    forbiddenActions: ["add_new_business_logic", "change_api_contract", "delete_unrelated", "add_new_routes"],
    maxFiles: 20,
    diffCriticEnabled: true,
  },
  FILE_CREATION: {
    allowedActions: ["create_file", "add_imports", "register_export"],
    forbiddenActions: ["modify_existing_core", "delete", "restructure"],
    maxFiles: 5,
    diffCriticEnabled: true,
  },
  CONFIG_CHANGE: {
    allowedActions: ["edit_config", "update_env", "modify_build_config"],
    forbiddenActions: ["modify_source_logic", "delete_folders", "add_features", "add_routes"],
    maxFiles: 4,
    diffCriticEnabled: false,
  },
  DOCS: {
    allowedActions: ["write_comments", "update_readme", "add_jsdoc", "update_changelog"],
    forbiddenActions: ["modify_source", "delete", "add_logic", "change_api"],
    maxFiles: 3,
    diffCriticEnabled: false,
  },
  OPTIMIZATION: {
    allowedActions: ["rewrite_queries", "add_memoization", "remove_dead_code", "add_caching", "reduce_bundle"],
    forbiddenActions: ["add_features", "change_api_contracts", "add_new_routes", "restructure_completely"],
    maxFiles: 15,
    diffCriticEnabled: true,
  },
  UNKNOWN: {
    allowedActions: [],
    forbiddenActions: ["delete_folder", "delete_file", "create_files", "modify_file"],
    maxFiles: 0,
    diffCriticEnabled: true,
  },
};

export interface ExecutionContractOptions {
  fileContext?: Record<string, string>;
  snapshotFiles?: Array<{ path: string; content?: string }>;
  localPath?: string | null;
  knowledgeGraph?: any;
  monorepo?: MonorepoDescriptor | null;
}


export interface CompoundIntentAnalysis {
  isCompound: boolean;
  hasDeletion: boolean;
  hasEnhancementOrCreation: boolean;
  hasReferenceCleanup: boolean;
  operations: string[];
}

export function detectCompoundIntent(
  message: string,
  classification?: TaskClassificationResult
): CompoundIntentAnalysis {
  let hasDeletion = /\b(?:remove|delete|drop|prune|clean\s+up|purge|replace)\b/i.test(message);
  let hasEnhancementOrCreation = /\b(?:enhance|improve|add|create|build|update|modify|redesign|style|implement)\b/i.test(message);

  if (classification) {
    const taskType = classification.taskType;
    const intent = classification.intent;
    if (taskType === "DELETE_FOLDER" || taskType === "DELETE_FILE" || intent === "DELETE_FOLDER" || intent === "DELETE_FILE") {
      hasDeletion = true;
    }
    if (taskType === "NEW_FEATURE" || taskType === "FILE_CREATION" || intent === "NEW_FEATURE" || intent === "FEATURE_ADD") {
      hasEnhancementOrCreation = true;
    }
  }

  const hasReferenceCleanup = hasDeletion || classification?.intent === "REFACTOR";
  const isCompound = hasDeletion && hasEnhancementOrCreation;

  const operations: string[] = [];
  if (hasDeletion) operations.push("DELETE");
  if (hasEnhancementOrCreation) operations.push("ENHANCE_OR_CREATE");
  if (hasReferenceCleanup) operations.push("CLEAN_REFERENCES");

  return {
    isCompound,
    hasDeletion,
    hasEnhancementOrCreation,
    hasReferenceCleanup,
    operations,
  };
}

export function detectReferenceCleanupIntent(
  message: string,
  classification?: TaskClassificationResult
): boolean {
  if (classification) {
    return classification.taskType === "DELETE_FOLDER" || classification.taskType === "DELETE_FILE" || classification.intent === "REFACTOR";
  }
  return /\b(?:clean(?:up|\s+up)?|remove\s+unused|update\s+importers|clean\s+every\s+reference|reference\s+cleanup)\b/i.test(message);
}

function resolveContextScope(
  taskType: TaskType,
  targetPaths: string[],
  repoFileNames: string[],
): string[] {
  const scopeSet = new Set<string>();

  for (const tp of targetPaths) {
    scopeSet.add(tp);

    const isFolder = !/\.[\w]+$/.test(tp);
    const normalizedTarget = tp.replace(/\\/g, "/").replace(/\/$/, "");

    for (const file of repoFileNames) {
      const normFile = file.replace(/\\/g, "/");

      if (isFolder && normFile.startsWith(`${normalizedTarget}/`)) {
        scopeSet.add(normFile);
      }

      if (!isFolder && normFile === normalizedTarget) {
        scopeSet.add(normFile);
      }
    }
  }

  if (taskType === "DELETE_FOLDER" || taskType === "DELETE_FILE") {
    for (const tp of targetPaths) {
      const baseName = tp.split("/").pop()?.replace(/\.[\w]+$/, "") || tp;
      if (baseName.length > 2) {
        for (const file of repoFileNames) {
          const normFile = file.replace(/\\/g, "/");
          if (normFile.includes(baseName) || normFile.endsWith("index.ts") || normFile.endsWith("index.js")) {
            scopeSet.add(normFile);
          }
        }
      }
    }
  }

  return Array.from(scopeSet);
}

export function buildExecutionContract(
  classification: TaskClassificationResult,
  message: string,
  repoFileNames: string[] = [],
  options?: ExecutionContractOptions,
): ExecutionContract {
  const { taskType, risk, estimatedComplexity } = classification;
  const rules = CONTRACT_RULES[taskType] || CONTRACT_RULES.NEW_FEATURE;
  const compound = detectCompoundIntent(message, classification);

  const targetProvenance: Record<string, string> = {};

  const extractedInfos = TargetPathExtractor.extractWithProvenance(message, {
    repoFiles: repoFileNames,
    taskType,
    classifierTarget: classification.targetPath,
  });

  for (const info of extractedInfos) {
    targetProvenance[info.path] = info.provenance;
  }
  let targetPaths = extractedInfos.map((i) => i.path);

  // Resolve repository-grounded targets for unique named entities if no explicit paths found,
  // or for destructive tasks with uniquely grounded targets
  if (
    !classification.requiresClarification &&
    taskType !== "UNKNOWN" &&
    repoFileNames.length > 0 &&
    (targetPaths.length === 0 || taskType === "DELETE_FOLDER" || taskType === "DELETE_FILE" || compound.hasDeletion)
  ) {
    const groundedInfos = TargetPathExtractor.extractGroundedEntitiesWithProvenance(message, repoFileNames);
    for (const g of groundedInfos) {
      if (!targetPaths.includes(g.path)) {
        targetPaths.push(g.path);
      }
      if (targetProvenance[g.path] !== "EXPLICIT_USER_PATH") {
        targetProvenance[g.path] = g.provenance;
      }
    }
  }

  // Supporting reverse-reference expansion for grounded DELETE targets
  const hasCleanupIntent = detectReferenceCleanupIntent(message, classification) || compound.hasReferenceCleanup;

  let authorizedDeleteTargets: string[] = [];
  if ((taskType === "DELETE_FOLDER" || taskType === "DELETE_FILE" || compound.hasDeletion) && targetPaths.length > 0) {
    const additionalGrounded = new Set<string>(targetPaths);
    for (const tp of targetPaths) {
      const baseName = path.basename(tp).replace(/\.[\w]+$/, "");
      if (baseName.length > 2) {
        for (const file of repoFileNames) {
          const normFile = file.replace(/\\/g, "/");
          if (normFile.toLowerCase().includes(baseName.toLowerCase()) || normFile === "app/page.tsx" || normFile === "pages/index.tsx" || normFile === "src/app/page.tsx") {
            additionalGrounded.add(normFile);
            if (!targetProvenance[normFile]) {
              targetProvenance[normFile] = "DETERMINISTIC_REFERENCE_CLEANUP";
            }
          }
        }
      }
    }

    authorizedDeleteTargets = targetPaths.filter(
      (tp) =>
        (targetProvenance[tp] === "EXPLICIT_USER_PATH" ||
          targetProvenance[tp] === "UNIQUE_NAMED_ENTITY" ||
          targetProvenance[tp] === "REPOSITORY_GROUNDED") &&
        !TargetPathExtractor.isHttpRouteIdentifier(tp, message)
    );

    if (hasCleanupIntent && authorizedDeleteTargets.length > 0) {
      for (const delTarget of authorizedDeleteTargets) {
        const importers = TargetScopeExpander.findDirectImporters({
          targetPath: delTarget,
          repoFiles: repoFileNames,
          fileContext: options?.fileContext,
          snapshotFiles: options?.snapshotFiles,
          localPath: options?.localPath,
          knowledgeGraph: options?.knowledgeGraph,
          monorepo: options?.monorepo,
        });

        for (const imp of importers) {
          if (!additionalGrounded.has(imp)) {
            additionalGrounded.add(imp);
            targetProvenance[imp] = "DETERMINISTIC_REFERENCE_CLEANUP";
          }
        }
      }
    }

    targetPaths = Array.from(additionalGrounded);
  }

  // Fail closed on classification ambiguity or clarification
  if (classification.requiresClarification || taskType === "UNKNOWN") {
    targetPaths = [];
  }

  const contextScope = resolveContextScope(taskType, targetPaths, repoFileNames);

  // Define allowed/forbidden actions
  let allowedActions = [...rules.allowedActions];
  let forbiddenActions = [...rules.forbiddenActions];

  if (hasCleanupIntent && authorizedDeleteTargets.length > 0) {
    if (!allowedActions.includes("modify_file")) {
      allowedActions.push("modify_file");
    }
  }

  if (compound.isCompound && compound.hasDeletion && compound.hasEnhancementOrCreation) {
    const compoundAllowed = [
      "delete_folder",
      "delete_file",
      "remove_imports",
      "update_references",
      "clean_barrel_exports",
      "modify_file",
      "create_components",
      "create_files",
      "add_imports",
      "write_types",
    ];
    allowedActions = Array.from(new Set([...allowedActions, ...compoundAllowed]));
    const allowedSet = new Set(allowedActions);
    forbiddenActions = forbiddenActions.filter(
      (act) =>
        !allowedSet.has(act) &&
        act !== "create_components" &&
        act !== "create_utilities" &&
        act !== "create_files" &&
        act !== "modify_file" &&
        act !== "refactor"
    );
  }

  if (classification.requiresClarification || taskType === "UNKNOWN") {
    if (taskType === "DELETE_FILE" || taskType === "DELETE_FOLDER" || compound.hasDeletion || hasCleanupIntent) {
      allowedActions = [];
    } else {
      allowedActions = allowedActions.filter((a) => a !== "delete_file" && a !== "delete_folder");
    }
    if (!forbiddenActions.includes("delete_file")) forbiddenActions.push("delete_file");
    if (!forbiddenActions.includes("delete_folder")) forbiddenActions.push("delete_folder");
  }

  // Dynamic route determination based on repository and structured classification
  const route = routeTask(message, classification, repoFileNames);

  let searchScope: string[] = [];
  if (targetPaths.length > 0) {
    searchScope = targetPaths.map((tp) => {
      if (/\.[\w]+$/.test(tp)) {
        const dir = path.dirname(tp);
        return dir === "." ? "" : dir;
      }
      return tp;
    }).filter(Boolean);
  }

  let maxFilesCap = rules.maxFiles;
  if (compound.isCompound) {
    maxFilesCap = Math.max(maxFilesCap, 15);
  } else if (taskType === "NEW_FEATURE" && (estimatedComplexity === "LARGE" || estimatedComplexity === "COMPLEX")) {
    maxFilesCap = 15;
  } else if (taskType === "NEW_FEATURE") {
    maxFilesCap = 7;
  }

  return {
    goal: message,
    taskType,
    risk,
    estimatedComplexity,
    pipeline: route.pipeline,
    environment: route.environment,
    repositoryRequired: route.repositoryRequired,
    expectedFiles: route.expectedFiles,
    validationType: route.validationType,
    targetPaths,
    contextScope,
    searchScope,
    allowedActions,
    forbiddenActions,
    maxFiles: maxFilesCap,
    diffCriticEnabled: rules.diffCriticEnabled,
    targetProvenance,
  };
}

/**
 * Builds a PolicyContract containing ONLY task boundaries, risk, allowed/forbidden actions,
 * and user explicit constraints. Contains ZERO inferred targetPaths.
 */
export function buildPolicyContract(
  intentSpec: TaskIntentSpec,
  repoFileNames: string[] = [],
  options?: ExecutionContractOptions
): PolicyContract {
  const rules = POLICY_RULES[intentSpec.taskType] || POLICY_RULES.NEW_FEATURE;
  const taskIntent =
    intentSpec.taskType === "FILE_CREATION"
      ? "NEW_FEATURE"
      : intentSpec.taskType === "CONFIG_CHANGE"
      ? "NEW_FEATURE"
      : (intentSpec.taskType as any);

  const dummyClassification: TaskClassificationResult = {
    taskType: intentSpec.taskType,
    risk: intentSpec.risk,
    estimatedComplexity: intentSpec.estimatedComplexity,
    intent: taskIntent,
    confidence: 0.9,
    requiresClarification: intentSpec.requiresClarification,
    reasoning: intentSpec.reasoning || "Policy contract classification",
    targetPath: intentSpec.explicitUserPaths[0],
  };

  const route = routeTask(intentSpec.goal, dummyClassification, repoFileNames);

  let allowedActions = [...rules.allowedActions];
  let forbiddenActions = [...rules.forbiddenActions];

  if (intentSpec.requiresClarification || intentSpec.taskType === "UNKNOWN") {
    allowedActions = allowedActions.filter((a) => a !== "delete_file" && a !== "delete_folder");
    if (!forbiddenActions.includes("delete_file")) forbiddenActions.push("delete_file");
    if (!forbiddenActions.includes("delete_folder")) forbiddenActions.push("delete_folder");
  }

  return {
    goal: intentSpec.goal,
    taskType: intentSpec.taskType,
    risk: intentSpec.risk,
    estimatedComplexity: intentSpec.estimatedComplexity,
    destructive: intentSpec.destructive,
    allowedActions,
    forbiddenActions,
    maxFiles: rules.maxFiles,
    diffCriticEnabled: rules.diffCriticEnabled,
    pipeline: route.pipeline,
    environment: route.environment,
    repositoryRequired: route.repositoryRequired,
    expectedFiles: route.expectedFiles,
    validationType: route.validationType,
    explicitUserPaths: intentSpec.explicitUserPaths,
    userConstraints: intentSpec.constraints,
    requiresClarification: intentSpec.requiresClarification,
    workspaceRoot: options?.localPath || undefined,
  };
}

/**
 * Builds an execution-planning contract from policy and deterministically
 * grounded candidate paths. CapabilityGuard remains mutation authority.
 */
export function buildFinalExecutionContract(
  policy: PolicyContract,
  plannedTargetPaths: string[],
  repoFileNames: string[] = [],
  actionObligations?: FileActionObligation[]
): ExecutionContract {
  const searchScope = plannedTargetPaths
    .map((tp) => {
      if (/\.[\w]+$/.test(tp)) {
        const dir = path.dirname(tp);
        return dir === "." ? "" : dir;
      }
      return tp;
    })
    .filter(Boolean);

  const contextScope = resolveContextScope(policy.taskType, plannedTargetPaths, repoFileNames);
  const targetProvenance: Record<string, string> = {};
  for (const tp of plannedTargetPaths) {
    targetProvenance[tp] = "EVIDENCE_BOUND_PLAN";
  }

  return {
    goal: policy.goal,
    taskType: policy.taskType,
    risk: policy.risk,
    estimatedComplexity: policy.estimatedComplexity,
    pipeline: policy.pipeline,
    environment: policy.environment,
    repositoryRequired: policy.repositoryRequired,
    expectedFiles: policy.expectedFiles,
    validationType: policy.validationType,
    targetPaths: plannedTargetPaths,
    contextScope,
    searchScope,
    allowedActions: policy.allowedActions,
    forbiddenActions: policy.forbiddenActions,
    maxFiles: policy.maxFiles,
    diffCriticEnabled: policy.diffCriticEnabled,
    targetProvenance,
    actionObligations,
  };
}
