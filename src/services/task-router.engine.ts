/**
 * Task Router Engine
 *
 * Inspects user request, classified task intent, and target paths to route
 * the execution to the appropriate pipeline mode & target environment:
 *
 * Pipelines:
 *   - STANDALONE:     Building self-contained tools/widgets (HTML/CSS/JS calculator, single Python script, CLI)
 *   - REPOSITORY:     Modifying existing project code (React/TS app, Node routes, backend services)
 *   - DOCUMENTATION:  Updating docs/README/comments
 *   - DIRECT_ANSWER:  Conversational Q&A / clarification
 *
 * Environments:
 *   - HTML_CSS_JS:    Standard web stack without React/node build step
 *   - REACT_TS:       React + TypeScript application stack
 *   - NODE_JS:        Backend Node.js service
 *   - PYTHON:         Python script or module
 *   - MARKDOWN:       Documentation
 *   - GENERIC:        Other/Unspecified
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

// Key term patterns for environment detection
const HTML_CSS_JS_PATTERNS = [
  /html\s*[\/\,\s]*css\s*[\/\,\s]*(and\s*)?js/i,
  /html\s*css/i,
  /vanilla\s*js/i,
  /vanilla\s*javascript/i,
  /plain\s*html/i,
  /single\s*page\s*html/i,
  /index\.html/i,
  /landing\s*page/i,
  /standalone\s*widget/i,
  /canvas\s*game/i,
  /game\s*in\s*html/i,
];

const REACT_TS_PATTERNS = [
  /\breact\b/i,
  /\btsx\b/i,
  /next(?:\.js)?/i,
  /component/i,
  /useState|useEffect/i,
  /tailwinds?/i,
  /router|routing/i,
  /redux|zustand/i,
];

const PYTHON_PATTERNS = [
  /\bpython\b/i,
  /\bpy\b/i,
  /script\.py/i,
  /pip\s+install/i,
  /fastapi|flask|django/i,
];

/**
 * Route a task to its optimal pipeline mode and target technical environment.
 */
export function routeTask(
  message: string,
  classification: TaskClassificationResult,
  repositoryFiles?: string[],
): TaskRouteResult {
  const msgLower = message.toLowerCase();
  const taskType = classification.taskType;

  // Filter out any system or backend files
  const userFiles = (repositoryFiles || []).filter((f) => !f.includes("anka-os-backend") && !f.includes("node_modules"));
  const hasReactFiles = userFiles.some((f) => /\.tsx$|\.jsx$/i.test(f) || f.includes("package.json"));
  const hasTsFiles = userFiles.some((f) => /\.ts$/i.test(f) && !f.endsWith(".d.ts"));
  const hasHtmlCssJsFiles = userFiles.some((f) => /\.html$|\.css$|\.js$/i.test(f));
  const existingWebFiles = userFiles.filter((f) => /\.html$|\.css$|\.js$/i.test(f));
  const isExplicitReact = REACT_TS_PATTERNS.some((p) => p.test(message));
  const mentionsRepoFiles = /(?:src\/|app\/|components\/|lib\/|services\/|routes\/|controllers\/|pages\/|package\.json|\.env)/i.test(message);

  // If repository consists strictly of Vanilla Web (no React/TS) or is empty without explicit React mention -> STANDALONE HTML_CSS_JS
  const isVanillaWebRepo = (!hasReactFiles && !hasTsFiles && !isExplicitReact && !mentionsRepoFiles) || (userFiles.length > 0 && hasHtmlCssJsFiles && !hasReactFiles && !hasTsFiles);

  // ── 1. Check for DIRECT_ANSWER / DOCUMENTATION ───────────────────────────────
  if (classification.requiresClarification) {
    return {
      pipeline: "DIRECT_ANSWER",
      environment: "GENERIC",
      repositoryRequired: false,
      expectedFiles: [],
      validationType: "NONE",
    };
  }

  if (taskType === "DOCS") {
    return {
      pipeline: "DOCUMENTATION",
      environment: "MARKDOWN",
      repositoryRequired: false,
      expectedFiles: ["README.md"],
      validationType: "NONE",
    };
  }

  // If repository consists strictly of HTML/CSS/JS (no React/TS), route to HTML_CSS_JS
  if (isVanillaWebRepo) {
    return {
      pipeline: "STANDALONE",
      environment: "HTML_CSS_JS",
      repositoryRequired: false,
      expectedFiles: existingWebFiles.length > 0 ? existingWebFiles : ["index.html", "style.css", "script.js"],
      validationType: "BROWSER_HTML",
    };
  }

  // ── 2. Check for Explicit Repository Tasks ──────────────────────────────────
  // Deletions, bug fixes, refactoring, config changes always touch existing repo
  const repoMandatoryTypes = new Set([
    "DELETE_FOLDER",
    "DELETE_FILE",
    "BUG_FIX",
    "REFACTOR",
    "CONFIG_CHANGE",
    "OPTIMIZATION",
  ]);

  if (repoMandatoryTypes.has(taskType) || mentionsRepoFiles) {
    const isPython = PYTHON_PATTERNS.some((p) => p.test(message));
    const targetEnv: TargetEnvironment = isPython
      ? "PYTHON"
      : (hasReactFiles || hasTsFiles ? "REACT_TS" : "HTML_CSS_JS");
    const valType: ValidationType = isPython
      ? "PYTHON_SYNTAX"
      : (hasReactFiles || hasTsFiles ? "TYPESCRIPT_BUILD" : "BROWSER_HTML");

    return {
      pipeline: "REPOSITORY",
      environment: targetEnv,
      repositoryRequired: true,
      expectedFiles: classification.targetPath ? [classification.targetPath] : (isVanillaWebRepo ? existingWebFiles : []),
      validationType: valType,
    };
  }

  // ── 3. Detect STANDALONE vs REPOSITORY for NEW_FEATURE / FILE_CREATION ──────
  const isExplicitHtmlCssJs = HTML_CSS_JS_PATTERNS.some((p) => p.test(message));
  const isExplicitPython = PYTHON_PATTERNS.some((p) => p.test(message));

  // If prompt explicitly requests HTML/CSS/JS (e.g., "create a calculator with html css and js")
  // and DOES NOT mention React/components/existing routes → STANDALONE
  if (isExplicitHtmlCssJs && !isExplicitReact && !mentionsRepoFiles) {
    return {
      pipeline: "STANDALONE",
      environment: "HTML_CSS_JS",
      repositoryRequired: false,
      expectedFiles: ["index.html", "style.css", "script.js"],
      validationType: "BROWSER_HTML",
    };
  }

  // If prompt explicitly requests a Python script
  if (isExplicitPython && !mentionsRepoFiles) {
    const scriptMatch = message.match(/([\w\-]+\.py)/i);
    const scriptName = scriptMatch ? scriptMatch[1] : "main.py";
    return {
      pipeline: "STANDALONE",
      environment: "PYTHON",
      repositoryRequired: false,
      expectedFiles: [scriptName],
      validationType: "PYTHON_SYNTAX",
    };
  }

  // If request asks to create a simple widget/calculator/tool/standalone app without specifying React
  const isFrontendOnlyPattern = /frontend\s*only|mock\s*data|no\s*(real\s*)?backend|ui\s*only|client\s*only|standalone\s*(app|frontend|application)/i.test(message);
  const isStandaloneAppPattern = /create\s+(?:a\s+)?(?:simple\s+)?(?:calculator|timer|stopwatch|todo\s*app|ecommerce|e-commerce|converter|clock|quiz|game|landing\s*page|website|dashboard)/i.test(message) || isFrontendOnlyPattern;

  // Only route to standalone pipeline if there are NO user files in the repo AND no explicit repo files mentioned
  if (isStandaloneAppPattern && !isExplicitReact && !mentionsRepoFiles && userFiles.length === 0) {
    return {
      pipeline: "STANDALONE",
      environment: "HTML_CSS_JS",
      repositoryRequired: false,
      expectedFiles: ["index.html", "style.css", "script.js"],
      validationType: "BROWSER_HTML",
    };
  }

  // Default: REPOSITORY pipeline (React/TS if repo has TS/React or default, otherwise HTML_CSS_JS)
  const targetEnv: TargetEnvironment = hasReactFiles || hasTsFiles ? "REACT_TS" : (hasHtmlCssJsFiles ? "HTML_CSS_JS" : "REACT_TS");
  const valType: ValidationType = targetEnv === "REACT_TS" ? "TYPESCRIPT_BUILD" : "BROWSER_HTML";

  return {
    pipeline: "REPOSITORY",
    environment: targetEnv,
    repositoryRequired: userFiles.length > 0,
    expectedFiles: [],
    validationType: valType,
  };
}
