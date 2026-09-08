/**
 * Task Router Engine
 *
 * Routes tasks based strictly on:
 *   1. Repository-detected architecture and stack
 *   2. Structured intent and classification
 *   3. Supported capabilities
 *
 * Invariants (Phase 1B):
 *   - No prompt regex routing (REACT_TS_PATTERNS, HTML_CSS_JS_PATTERNS, PYTHON_PATTERNS removed)
 *   - No choosing stack based on user prompt wording
 *   - Same prompt routes according to repository architecture
 */

import {
  PipelineMode,
  TargetEnvironment,
  TaskClassificationResult,
  ValidationType,
} from "../types";

export interface TaskRouteResult {
  pipeline: PipelineMode;
  environment: TargetEnvironment;
  repositoryRequired: boolean;
  expectedFiles: string[];
  validationType: ValidationType;
}

export function routeTask(
  message: string,
  classification: TaskClassificationResult,
  repositoryFiles?: string[],
): TaskRouteResult {
  const taskType = classification.taskType;

  // 1. Direct answer / Clarification needed
  if (classification.requiresClarification || taskType === "UNKNOWN") {
    return {
      pipeline: "DIRECT_ANSWER",
      environment: "GENERIC",
      repositoryRequired: false,
      expectedFiles: [],
      validationType: "NONE",
    };
  }

  // 2. Documentation tasks
  if (taskType === "DOCS") {
    return {
      pipeline: "DOCUMENTATION",
      environment: "MARKDOWN",
      repositoryRequired: false,
      expectedFiles: ["README.md"],
      validationType: "NONE",
    };
  }

  // Filter out system or dependency directories
  const userFiles = (repositoryFiles || []).filter(
    (f) =>
      !f.includes("node_modules") &&
      !f.includes(".git") &&
      !f.includes(".next") &&
      !f.includes("dist") &&
      !f.includes("anka-os-backend")
  );

  // Repository stack detection based strictly on repository evidence
  const isPythonRepo = userFiles.some(
    (f) =>
      /\.py$/i.test(f) ||
      /(?:requirements\.txt|pyproject\.toml|Pipfile|setup\.py)$/i.test(f)
  );

  const hasPackageJson = userFiles.some((f) => f.endsWith("package.json"));
  const hasTsConfig = userFiles.some((f) => f.endsWith("tsconfig.json"));
  const hasReactFiles = userFiles.some((f) => /\.(?:tsx|jsx)$/i.test(f));
  const hasTsFiles = userFiles.some((f) => /\.ts$/i.test(f) && !f.endsWith(".d.ts"));
  const hasHtmlFiles = userFiles.some((f) => /\.html$/i.test(f));
  const hasCssFiles = userFiles.some((f) => /\.(?:css|scss)$/i.test(f));

  const isNodeOrTsRepo = hasPackageJson || hasTsConfig || hasReactFiles || hasTsFiles;
  const isVanillaWebRepo =
    userFiles.length > 0 &&
    hasHtmlFiles &&
    !isNodeOrTsRepo &&
    !isPythonRepo;

  // If repository has Python stack
  if (isPythonRepo) {
    return {
      pipeline: "REPOSITORY",
      environment: "PYTHON",
      repositoryRequired: true,
      expectedFiles: classification.targetPath ? [classification.targetPath] : [],
      validationType: "PYTHON_SYNTAX",
    };
  }

  // If repository is Node / TypeScript
  if (isNodeOrTsRepo) {
    // If it has frontend UI components or pages
    const isFrontendOrFullstack = hasReactFiles || userFiles.some((f) => /(?:components|pages|views|app)\//i.test(f));
    const environment: TargetEnvironment = isFrontendOrFullstack ? "REACT_TS" : "NODE_JS";

    return {
      pipeline: "REPOSITORY",
      environment,
      repositoryRequired: true,
      expectedFiles: classification.targetPath ? [classification.targetPath] : [],
      validationType: "TYPESCRIPT_BUILD",
    };
  }

  // If repository is pure Vanilla HTML/CSS/JS
  if (isVanillaWebRepo) {
    const webFiles = userFiles.filter((f) => /\.(?:html|css|js)$/i.test(f));
    return {
      pipeline: "REPOSITORY",
      environment: "HTML_CSS_JS",
      repositoryRequired: true,
      expectedFiles: webFiles.length > 0 ? webFiles : ["index.html", "style.css", "script.js"],
      validationType: "BROWSER_HTML",
    };
  }

  // If repository is completely empty (no files) -> standalone fallback
  if (userFiles.length === 0) {
    return {
      pipeline: "STANDALONE",
      environment: "HTML_CSS_JS",
      repositoryRequired: false,
      expectedFiles: ["index.html", "style.css", "script.js"],
      validationType: "BROWSER_HTML",
    };
  }

  // Default fallback for general repositories
  return {
    pipeline: "REPOSITORY",
    environment: "REACT_TS",
    repositoryRequired: true,
    expectedFiles: classification.targetPath ? [classification.targetPath] : [],
    validationType: "TYPESCRIPT_BUILD",
  };
}
