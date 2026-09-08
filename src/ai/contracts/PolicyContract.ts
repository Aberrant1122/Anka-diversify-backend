import { TaskType, TaskRisk, TaskComplexity } from "../classification/TaskTypes";
import { PipelineMode, TargetEnvironment, ValidationType } from "../../types";

export interface PolicyContractRules {
  allowedActions: string[];
  forbiddenActions: string[];
  maxFiles: number;
  diffCriticEnabled: boolean;
}

export interface PolicyContract {
  goal: string;
  taskType: TaskType;
  risk: TaskRisk;
  estimatedComplexity: TaskComplexity;
  destructive: boolean;
  allowedActions: string[];
  forbiddenActions: string[];
  maxFiles: number;
  diffCriticEnabled: boolean;
  pipeline: PipelineMode;
  environment: TargetEnvironment;
  repositoryRequired: boolean;
  expectedFiles: string[];
  validationType: ValidationType;
  explicitUserPaths: string[];
  userConstraints: string[];
  requiresClarification: boolean;
  workspaceRoot?: string;
}

export const POLICY_RULES: Record<TaskType, PolicyContractRules> = {
  DELETE_FOLDER: {
    allowedActions: ["delete_folder", "remove_imports", "update_references", "clean_barrel_exports", "modify_file"],
    forbiddenActions: ["refactor", "rename", "move_files", "merge_types", "create_utilities", "create_components", "add_routes"],
    maxFiles: 12,
    diffCriticEnabled: true,
  },
  DELETE_FILE: {
    allowedActions: ["delete_file", "remove_imports", "update_references", "modify_file"],
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
  UNKNOWN: {
    allowedActions: [],
    forbiddenActions: ["delete_folder", "delete_file", "create_files", "modify_file"],
    maxFiles: 0,
    diffCriticEnabled: true,
  },
};
