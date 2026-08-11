export * from "../../types";

export interface SearchPlanStep {
  id: number;
  target: string;
  action: string;
  query: string;
}

export interface ConfidenceResult {
  totalConfidence: number;
  breakdown: { C_symbol: number; C_route: number; C_type: number; C_reuse: number };
  decision: "PROCEED" | "SEARCH_MORE";
  reasoning: string;
  nextSearches?: Array<{ tool: string; args: Record<string, any> }>;
}

export interface FeatureValidationCheck {
  id: string;
  label: string;
  status: "PASS" | "FAIL" | "WARN";
  checked: boolean;
  details: string;
}

export interface FeatureValidationResult {
  overallPassed: boolean;
  checks: FeatureValidationCheck[];
  failedChecks: string[];
  repairActions: Array<{ checkId: string; action: string; suggestedTool: string }>;
}

export interface RepositoryExecutionMemory {
  taskId: string;
  projectId: string;
  discoveredSymbols: Map<string, { filePath: string; line: number }>;
  discoveredRoutes: string[];
  discoveredServices: string[];
  discoveredModels: string[];
  inspectedFiles: Set<string>;
  searchPlanHistory: Array<{ stepId: number; tool: string; resultCount: number }>;
  currentConfidence: number;
}
