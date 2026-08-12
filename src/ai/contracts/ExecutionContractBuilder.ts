import { ExecutionContract, TaskClassificationResult, TaskType } from "../shared/types";
import { routeTask } from "../../services/task-router.engine";

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
};

function extractTargetPathsFromMessage(message: string): string[] {
  const paths: string[] = [];

  const quotedMatches = message.matchAll(/["']([\w\-./\\]+)["']/g);
  for (const m of quotedMatches) {
    if (m[1] && (/[\w\-./\\]+\.[\w]+/.test(m[1]) || /[\w\-.]+\/[\w\-.]+/.test(m[1]))) {
      paths.push(m[1].replace(/\\/g, "/").replace(/^\//, ""));
    }
  }

  const unquotedMatches = message.matchAll(/\b([\w\-./\\]+\.(?:html|css|js|ts|tsx|jsx|json|py|md))\b/gi);
  for (const m of unquotedMatches) {
    const p = m[1].replace(/\\/g, "/").replace(/^\//, "");
    if (!paths.includes(p)) paths.push(p);
  }

  return Array.from(new Set(paths));
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
): ExecutionContract {
  const { taskType, risk, estimatedComplexity } = classification;
  const rules = CONTRACT_RULES[taskType] || CONTRACT_RULES.NEW_FEATURE;

  const rawTargetPaths: string[] = [];
  if (classification.targetPath) {
    rawTargetPaths.push(classification.targetPath.replace(/\\/g, "/").replace(/^\//, ""));
  }
  const extractedPaths = extractTargetPathsFromMessage(message);
  for (const p of extractedPaths) {
    if (!rawTargetPaths.includes(p)) rawTargetPaths.push(p);
  }

  const targetPaths = Array.from(new Set(rawTargetPaths));
  const contextScope = resolveContextScope(taskType, targetPaths, repoFileNames);
  const searchScope = [...contextScope];
  const route = routeTask(message, classification, repoFileNames);

  let allowedActions = [...rules.allowedActions];
  let forbiddenActions = [...rules.forbiddenActions];
  let diffCriticEnabled = rules.diffCriticEnabled;

  if (route.pipeline === "STANDALONE") {
    allowedActions = ["create_standalone_assets", "write_html", "write_css", "write_js", "modify_standalone_files"];
    forbiddenActions = ["create_react_components", "add_next_pages", "create_typescript_interfaces", "import_backend_modules"];
    diffCriticEnabled = false;
  }

  let maxFilesCap = rules.maxFiles;
  if (taskType === "NEW_FEATURE" && (estimatedComplexity === "LARGE" || estimatedComplexity === "COMPLEX")) {
    maxFilesCap = 15;
  } else if (taskType === "NEW_FEATURE") {
    maxFilesCap = 7;
  }

  if (route.pipeline === "STANDALONE") {
    maxFilesCap = 5;
  }

  const goalPrefix: Record<TaskType, string> = {
    DELETE_FOLDER: "Delete directory and clean import references",
    DELETE_FILE: "Delete file and update import references",
    NEW_FEATURE: "Implement feature",
    BUG_FIX: "Repair bug and resolve errors in",
    REFACTOR: "Refactor architecture for",
    FILE_CREATION: "Create file",
    CONFIG_CHANGE: "Update configuration for",
    DOCS: "Update documentation for",
    OPTIMIZATION: "Optimize performance for",
  };
  const primaryTarget = targetPaths[0] || "";
  const goal = `${goalPrefix[classification.taskType]} ${primaryTarget ? `"${primaryTarget}"` : "(project-wide)"} — ${message.slice(0, 80)}`;

  return {
    goal,
    taskType,
    risk,
    estimatedComplexity,
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
