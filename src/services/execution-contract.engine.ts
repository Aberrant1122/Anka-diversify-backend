/**
 * Execution Contract Engine
 *
 * Converts a TaskClassificationResult into a typed ExecutionContract
 * that governs every downstream pipeline stage:
 *   - Repository search scope
 *   - Context retrieval filtering
 *   - Code generation guardrails (injected into LLM system prompt)
 *   - Diff critic enforcement
 */

import { ExecutionContract, TaskClassificationResult, TaskType } from "../types";
import { routeTask } from "./task-router.engine";

// ── Per-TaskType contract rule table ─────────────────────────────────────────

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
    diffCriticEnabled: false, // Feature scope is intentionally broad
  },
  BUG_FIX: {
    allowedActions: ["modify_file", "add_null_check", "update_types", "fix_import", "add_error_boundary"],
    forbiddenActions: ["create_new_pages", "delete_folders", "restructure_modules", "add_new_features"],
    maxFiles: 10,
    diffCriticEnabled: true,
  },
  REFACTOR: {
    allowedActions: ["rename_symbol", "move_file", "update_imports", "split_module", "extract_utility"],
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
    diffCriticEnabled: false, // Config changes are small and explicit
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
};

import { TargetPathExtractor } from "../ai/contracts/TargetPathExtractor";

/**
 * Build a contextScope that is wide enough for the task type.
 *
 * - DELETE_*: only targetPaths + their parent directories
 * - NEW_FEATURE: also include "src/" to allow reading existing code
 * - BUG_FIX / REFACTOR / OPTIMIZATION: targetPaths + src/ skeleton
 * - CONFIG_CHANGE / DOCS: targetPaths only
 */
function buildContextScope(taskType: TaskType, targetPaths: string[]): string[] {
  const parents = targetPaths.map((p) => {
    const parts = p.split("/");
    return parts.length > 1 ? parts.slice(0, -1).join("/") : p;
  });

  const base = [...new Set([...targetPaths, ...parents])];

  switch (taskType) {
    case "DELETE_FOLDER":
    case "DELETE_FILE":
      return base; // Tight scope: only the target and its parent

    case "NEW_FEATURE":
    case "REFACTOR":
    case "OPTIMIZATION":
      // Wide scope: allow reading the whole src tree for context
      return [...new Set([...base, "src", "app", "lib", "components", "services"])];

    case "BUG_FIX":
      return [...new Set([...base, "src", "app"])];

    case "FILE_CREATION":
      return [...new Set([...base, "src", "components", "lib"])];

    case "CONFIG_CHANGE":
    case "DOCS":
    default:
      return base;
  }
}

export function detectCompoundIntent(message: string): {
  isCompound: boolean;
  hasDeletion: boolean;
  hasEnhancementOrCreation: boolean;
  operations: string[];
} {
  const hasDeletion = /\b(?:remove|delete|drop|prune|clean\s+up|purge)\b/i.test(message);
  const hasEnhancementOrCreation = /\b(?:enhance|improve|add|create|build|update|modify|redesign|style|implement)\b/i.test(message);
  const isCompound = hasDeletion && hasEnhancementOrCreation;
  const operations: string[] = [];
  if (hasDeletion) operations.push("DELETE");
  if (hasEnhancementOrCreation) operations.push("ENHANCE_OR_CREATE");

  return {
    isCompound,
    hasDeletion,
    hasEnhancementOrCreation,
    operations,
  };
}

// ── Main Builder ──────────────────────────────────────────────────────────────

/**
 * Build an ExecutionContract from a classified intent.
 *
 * @param classification - Output of classifyIntentAndAmbiguity()
 * @param message        - Original user message (used for path extraction fallback)
 * @returns ExecutionContract that drives all downstream pipeline stages
 */
export function buildExecutionContract(
  classification: TaskClassificationResult,
  message: string,
  repositoryFiles?: string[],
): ExecutionContract {
  const rules = CONTRACT_RULES[classification.taskType] || CONTRACT_RULES.NEW_FEATURE;
  const compound = detectCompoundIntent(message);

  let targetPaths = TargetPathExtractor.extract(message, {
    repoFiles: repositoryFiles || [],
    taskType: classification.taskType,
    classifierTarget: classification.targetPath,
  });

  // If no explicit targets extracted, resolve repository-grounded targets for named entities
  if (targetPaths.length === 0 && repositoryFiles && repositoryFiles.length > 0) {
    const grounded = TargetPathExtractor.extractGroundedEntities(message, repositoryFiles);
    if (grounded.length > 0) {
      targetPaths = grounded;
    }
  }

  // If deletion is requested and grounded files exist, also include direct reference files (e.g. app/page.tsx)
  if ((classification.taskType === "DELETE_FOLDER" || classification.taskType === "DELETE_FILE" || compound.hasDeletion) && targetPaths.length > 0 && repositoryFiles) {
    const additionalGrounded = new Set<string>(targetPaths);
    for (const tp of targetPaths) {
      const baseName = tp.split("/").pop()?.replace(/\.[\w]+$/, "") || tp;
      if (baseName.length > 2) {
        for (const file of repositoryFiles) {
          const normFile = file.replace(/\\/g, "/");
          if (normFile === "app/page.tsx" || normFile === "pages/index.tsx" || normFile === "src/app/page.tsx") {
            additionalGrounded.add(normFile);
          }
        }
      }
    }
    targetPaths = Array.from(additionalGrounded);
  }

  const primaryTarget = targetPaths[0];

  // Search scope is targetPaths + their parents (for import reference discovery)
  const searchScope: string[] = targetPaths.length > 0
    ? [...new Set([
        ...targetPaths,
        ...targetPaths.map((p) => {
          const parts = p.split("/");
          return parts.length > 1 ? parts.slice(0, -1).join("/") : p;
        }),
      ])]
    : ["src", "app", "lib", "components"]; // Generic fallback if no path known

  const contextScope = buildContextScope(classification.taskType, targetPaths.length > 0 ? targetPaths : searchScope);

  let allowedActions = [...rules.allowedActions];
  let forbiddenActions = [...rules.forbiddenActions];
  let diffCriticEnabled = rules.diffCriticEnabled;

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
      (act) => !allowedSet.has(act) && act !== "create_components" && act !== "create_utilities" && act !== "create_files" && act !== "modify_file" && act !== "refactor"
    );
  }

  // Build a human-readable goal from the task type and target
  const goalPrefix: Record<TaskType, string> = {
    DELETE_FOLDER: "Delete folder",
    DELETE_FILE: "Delete file",
    NEW_FEATURE: "Build new feature",
    BUG_FIX: "Fix bug in",
    REFACTOR: "Refactor",
    FILE_CREATION: "Create file in",
    CONFIG_CHANGE: "Update configuration",
    DOCS: "Update documentation for",
    OPTIMIZATION: "Optimize",
  };
  const goal = compound.isCompound
    ? `Execute compound task: remove references and enhance UI — ${message.slice(0, 80)}`
    : `${goalPrefix[classification.taskType]} ${primaryTarget ? `"${primaryTarget}"` : "(project-wide)"} — ${message.slice(0, 80)}`;

  // Route task to optimal pipeline and target environment (passing repositoryFiles for tech-stack auto-detection)
  const route = routeTask(message, classification, repositoryFiles);

  let maxFilesCap = rules.maxFiles;
  if (compound.isCompound) {
    maxFilesCap = Math.max(maxFilesCap, 15);
  } else if (classification.taskType === "NEW_FEATURE" && (classification.estimatedComplexity === "LARGE" || classification.estimatedComplexity === "COMPLEX")) {
    maxFilesCap = 15;
  } else if (classification.taskType === "NEW_FEATURE") {
    maxFilesCap = 7;
  }

  if (route.pipeline === "STANDALONE") {
    maxFilesCap = 5;
  }

  return {
    goal,
    taskType: classification.taskType,
    risk: classification.risk,
    estimatedComplexity: classification.estimatedComplexity,
    pipeline: route.pipeline,
    environment: route.environment,
    repositoryRequired: route.repositoryRequired,
    expectedFiles: route.expectedFiles.length > 0 ? route.expectedFiles : (targetPaths.length > 0 ? targetPaths : []),
    validationType: route.validationType,
    targetPaths,
    allowedActions,
    forbiddenActions,
    maxFiles: maxFilesCap,
    searchScope,
    contextScope,
    diffCriticEnabled,
  };
}

