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
  /calculator/i,
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
): TaskRouteResult {
  const msgLower = message.toLowerCase();
  const taskType = classification.taskType;

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

  const mentionsRepoFiles = /(?:src\/|app\/|components\/|lib\/|services\/|routes\/|controllers\/|pages\/|package\.json|\.env)/i.test(message);

  if (repoMandatoryTypes.has(taskType) || mentionsRepoFiles) {
    const isPython = PYTHON_PATTERNS.some((p) => p.test(message));
    return {
      pipeline: "REPOSITORY",
      environment: isPython ? "PYTHON" : "REACT_TS",
      repositoryRequired: true,
      expectedFiles: classification.targetPath ? [classification.targetPath] : [],
      validationType: isPython ? "PYTHON_SYNTAX" : "TYPESCRIPT_BUILD",
    };
  }

  // ── 3. Detect STANDALONE vs REPOSITORY for NEW_FEATURE / FILE_CREATION ──────
  const isExplicitHtmlCssJs = HTML_CSS_JS_PATTERNS.some((p) => p.test(message));
  const isExplicitReact = REACT_TS_PATTERNS.some((p) => p.test(message));
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

  // If request asks to create a simple widget/calculator/tool without specifying React
  const isStandaloneAppPattern = /create\s+(?:a\s+)?(?:simple\s+)?(?:calculator|timer|stopwatch|todo\s*app|converter|clock|quiz|game)/i.test(message);
  if (isStandaloneAppPattern && !isExplicitReact && !mentionsRepoFiles) {
    return {
      pipeline: "STANDALONE",
      environment: "HTML_CSS_JS",
      repositoryRequired: false,
      expectedFiles: ["index.html", "style.css", "script.js"],
      validationType: "BROWSER_HTML",
    };
  }

  // Default: REPOSITORY pipeline (React/TS)
  return {
    pipeline: "REPOSITORY",
    environment: "REACT_TS",
    repositoryRequired: true,
    expectedFiles: [],
    validationType: "TYPESCRIPT_BUILD",
  };
}
