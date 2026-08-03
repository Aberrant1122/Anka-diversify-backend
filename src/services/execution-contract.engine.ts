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

// ── Target Path Extractor ─────────────────────────────────────────────────────

/**
 * Extract target paths from the message if the classifier didn't provide complete ones.
 * Looks for quoted paths ('index.html', 'style.css'), bare file extensions, or folder names.
 */
function extractTargetPathsFromMessage(message: string): string[] {
  const paths: string[] = [];

  // Match all quoted filenames or paths: 'index.html', "style.css", `script.js`
  const quotedMatches = message.matchAll(/["']([\w\-./\\]+)["']/g);
  for (const m of quotedMatches) {
    if (m[1] && (/[\w\-./\\]+\.[\w]+/.test(m[1]) || /[\w\-.]+\/[\w\-.]+/.test(m[1]))) {
      paths.push(m[1].replace(/\\/g, "/").replace(/^\//, ""));
    }
  }

  // Match unquoted paths with extensions
  const unquotedMatches = message.matchAll(/\b([\w\-./\\]+\.(?:html|css|js|ts|tsx|jsx|json|py|md))\b/gi);
  for (const m of unquotedMatches) {
    paths.push(m[1].replace(/\\/g, "/").replace(/^\//, ""));
  }

  // Match bare folder names: "Remove lib folder" → "lib"
  if (paths.length === 0) {
    const bareMatch = message.match(/(?:remove|delete|rm|clean|clear)\s+["']?([\w\-]+)(?:\s+(?:folder|directory|dir|path))?["']?/i);
    if (bareMatch) paths.push(bareMatch[1]);
  }

  return [...new Set(paths)];
}

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
  const rules = CONTRACT_RULES[classification.taskType];

  // Determine target paths
  const extractedPaths = extractTargetPathsFromMessage(message);
  const rawTargetPaths: string[] = [];

  if (classification.targetPath) {
    if (typeof classification.targetPath === "string") {
      rawTargetPaths.push(classification.targetPath);
    } else if (Array.isArray(classification.targetPath)) {
      const arr = classification.targetPath as any[];
      for (const item of arr) {
        if (typeof item === "string") rawTargetPaths.push(item);
      }
    }
  }

  if (extractedPaths.length > 0) {
    rawTargetPaths.push(...extractedPaths);
  }

  const targetPaths: string[] = [...new Set(
    rawTargetPaths
      .map((p) => String(p).trim().replace(/\\/g, "/").replace(/\/$/, ""))
      .filter((p) => p.length > 0),
  )];

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
  const goal = `${goalPrefix[classification.taskType]} ${primaryTarget ? `"${primaryTarget}"` : "(project-wide)"} — ${message.slice(0, 80)}`;

  // Route task to optimal pipeline and target environment (passing repositoryFiles for tech-stack auto-detection)
  const route = routeTask(message, classification, repositoryFiles);

  let maxFilesCap = rules.maxFiles;
  if (classification.taskType === "NEW_FEATURE" && (classification.estimatedComplexity === "LARGE" || classification.estimatedComplexity === "COMPLEX")) {
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
    allowedActions: rules.allowedActions,
    forbiddenActions: rules.forbiddenActions,
    maxFiles: maxFilesCap,
    searchScope,
    contextScope,
    diffCriticEnabled: rules.diffCriticEnabled,
  };
}

