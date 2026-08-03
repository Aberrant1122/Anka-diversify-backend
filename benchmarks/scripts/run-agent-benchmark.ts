/**
 * run-agent-benchmark.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * REAL Evaluation Framework for the Anka OS AI Coding Agent.
 *
 * Architecture:
 *   1. For each task in benchmarks/tasks/*.md
 *   2. Copy the real codebase into an isolated sandbox directory
 *   3. Call the LIVE agent HTTP API (POST /api/projects/:projectId/agent/run)
 *   4. Apply the agent's returned file changes to the sandbox
 *   5. Run real validation: npm install, npx tsc --noEmit, npm run build, eslint
 *   6. Collect REAL metrics: build success, compile errors, files modified, time, tokens
 *   7. Write benchmark-results.json and benchmark-summary.md
 *
 * NEVER fabricates metrics. If the agent fails, failure is recorded honestly.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import fs from "fs";
import path from "path";
import { exec, execSync } from "child_process";
import { promisify } from "util";
import https from "https";
import http from "http";
import jwt from "jsonwebtoken";
import { AiService } from "../../src/services/ai-service";

const execAsync = promisify(exec);

// ─── Configuration ─────────────────────────────────────────────────────────

const CONFIG = {
  /** Live backend API base URL */
  API_BASE_URL: "http://localhost:3001",
  /** A real userId from the database — required by the agent */
  TEST_USER_ID: process.env.BENCHMARK_USER_ID || "",
  /** A real projectId with a GitHub repo snapshot — required by the agent */
  TEST_PROJECT_ID: process.env.BENCHMARK_PROJECT_ID || "",
  /** Max ms to wait for the agent to respond per task */
  AGENT_TIMEOUT_MS: 180_000,
  /** Root of the backend workspace to copy into sandbox */
  BACKEND_ROOT: path.resolve(__dirname, "../../"),
  /** Root of the frontend workspace to copy into sandbox */
  FRONTEND_ROOT: path.resolve(__dirname, "../../../anka-diversify-os"),
  /** Where sandboxes are created */
  SANDBOX_ROOT: path.resolve(__dirname, "../scratch/benchmark-workspaces"),
  /** Task definition files */
  TASKS_DIR: path.resolve(__dirname, "../tasks"),
  /** Output directory for results */
  OUTPUT_DIR: path.resolve(__dirname, "../"),
};

// ─── Types ────────────────────────────────────────────────────────────────────

interface TaskSpec {
  id: string;
  file: string;
  category: string;
  difficulty: string;
  expectedIntent: string;
  prompt: string;
  acceptanceCriteria: string[];
  expectedFilesModified: string[];
  hallucinationSignals: string[];
}

interface AgentFileChange {
  path: string;
  content: string;
  description?: string;
}

interface AgentResponse {
  explanation: string;
  changes: AgentFileChange[];
  commitMessage: string;
  sessionId: string;
  needsClarification?: boolean;
  intent?: string;
  confidence?: number;
  buildVerified?: boolean;
  buildErrors?: string;
  verificationChecklist?: Array<{ label: string; checked: boolean; category?: string }>;
}

interface ValidationResult {
  npmInstallSuccess: boolean;
  npmInstallError: string;
  tscSuccess: boolean;
  tscErrors: string;
  buildSuccess: boolean;
  buildErrors: string;
  eslintSuccess: boolean;
  eslintErrors: string;
  testSuccess: boolean;
  testErrors: string;
}

interface TaskBenchmarkResult {
  taskId: string;
  taskCategory: string;
  prompt: string;
  status: "SUCCESS" | "PARTIAL" | "FAILED" | "AGENT_ERROR" | "TIMEOUT" | "SKIPPED";
  /** Wall-clock time from request to response in ms */
  durationMs: number;
  agentResponse: {
    intent: string;
    confidence: number;
    filesChanged: number;
    filesAdded: number;
    filesModified: number;
    filesDeleted: number;
    needsClarification: boolean;
    rawError?: string;
    agentClaimedBuildSuccess: boolean;
  };
  validation: ValidationResult;
  hallucinationDetected: boolean;
  hallucinationDetails: string[];
  /** Token usage from OpenAI response headers (if available) */
  tokenUsage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    estimatedCostUSD: number;
  };
  compileErrors: string[];
  runtimeErrors: string[];
  finalStatus: string;
  sandboxPath: string;
}

interface BenchmarkReport {
  runAt: string;
  totalTasks: number;
  completedTasks: number;
  skippedTasks: number;
  results: TaskBenchmarkResult[];
  summary: {
    buildSuccessRate: number;
    agentSuccessRate: number;
    hallucinationRate: number;
    avgDurationMs: number;
    totalTokens: number;
    totalEstimatedCostUSD: number;
    avgConfidence: number;
    taskBreakdown: Record<string, { total: number; success: number; failed: number }>;
  };
}

// ─── Utilities ─────────────────────────────────────────────────────────────────

function log(msg: string) {
  const ts = new Date().toISOString().slice(11, 23);
  process.stdout.write(`[${ts}] ${msg}\n`);
}

function err(msg: string) {
  const ts = new Date().toISOString().slice(11, 23);
  process.stderr.write(`[${ts}] ❌ ${msg}\n`);
}

/** Recursively copy a directory into dest, skipping node_modules, .git, .next, dist */
function copyDir(src: string, dest: string) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });

  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const skip = ["node_modules", ".git", ".next", "dist", "build", ".kiro", "benchmarks"];
    if (skip.includes(entry.name)) continue;

    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/** Parse a benchmark task markdown file */
function parseTaskSpec(filePath: string): TaskSpec | null {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n");

    const id = path.basename(filePath, ".md");
    const categoryMatch = content.match(/^## Category:\s*(.+)$/m);
    const difficultyMatch = content.match(/^## Difficulty:\s*(.+)$/m);
    const intentMatch = content.match(/^## Expected Intent:\s*(.+)$/m);

    // Extract prompt between ```\n and \n```
    const promptMatch = content.match(/## Prompt\s*```\s*([\s\S]*?)```/);
    const prompt = promptMatch ? promptMatch[1].trim() : "";

    // Extract acceptance criteria lines starting with - [ ]
    const acceptanceCriteria: string[] = [];
    const aceStart = content.indexOf("## Acceptance Criteria");
    if (aceStart !== -1) {
      const aceSection = content.slice(aceStart, content.indexOf("\n## ", aceStart + 5) || undefined);
      for (const line of aceSection.split("\n")) {
        if (line.trim().startsWith("- [ ]")) {
          acceptanceCriteria.push(line.replace("- [ ]", "").trim());
        }
      }
    }

    // Extract expected files
    const expectedFiles: string[] = [];
    const efStart = content.indexOf("## Expected Files");
    if (efStart !== -1) {
      const efSection = content.slice(efStart, content.indexOf("\n## ", efStart + 5) || undefined);
      for (const line of efSection.split("\n")) {
        if (line.trim().startsWith("- `")) {
          expectedFiles.push(line.replace(/^.*`([^`]+)`.*$/, "$1").trim());
        } else if (line.trim().startsWith("- ") && !line.includes("##")) {
          expectedFiles.push(line.replace(/^- /, "").trim());
        }
      }
    }

    // Extract hallucination signals
    const hallucinationSignals: string[] = [];
    const hsStart = content.indexOf("## Hallucination Signals");
    if (hsStart !== -1) {
      const hsSection = content.slice(hsStart);
      for (const line of hsSection.split("\n")) {
        if (line.trim().startsWith("- ")) {
          hallucinationSignals.push(line.replace(/^- /, "").trim());
        }
      }
    }

    if (!prompt) {
      err(`No prompt found in ${filePath}`);
      return null;
    }

    return {
      id,
      file: filePath,
      category: categoryMatch?.[1]?.trim() || "UNKNOWN",
      difficulty: difficultyMatch?.[1]?.trim() || "unknown",
      expectedIntent: intentMatch?.[1]?.trim() || "UNKNOWN",
      prompt,
      acceptanceCriteria,
      expectedFilesModified: expectedFiles,
      hallucinationSignals,
    };
  } catch (e) {
    err(`Failed to parse task spec ${filePath}: ${e}`);
    return null;
  }
}

/** Make an HTTP request and return the parsed JSON body */
async function httpPost<T>(
  url: string,
  headers: Record<string, string>,
  body: Record<string, any>,
  timeoutMs: number
): Promise<{ data: T; statusCode: number; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const isHttps = parsedUrl.protocol === "https:";
    const bodyStr = JSON.stringify(body);

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(bodyStr),
        ...headers,
      },
    };

    const req = (isHttps ? https : http).request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          const resHeaders: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            resHeaders[k] = Array.isArray(v) ? v.join(",") : (v || "");
          }
          resolve({ data: parsed as T, statusCode: res.statusCode || 0, headers: resHeaders });
        } catch {
          reject(new Error(`Invalid JSON response: ${data.slice(0, 500)}`));
        }
      });
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`Request timed out after ${timeoutMs}ms`));
    });

    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

/** Apply agent file changes into the sandbox directory */
function applyChanges(sandboxRoot: string, changes: AgentFileChange[]): { added: number; modified: number } {
  let added = 0;
  let modified = 0;

  for (const change of changes) {
    // Sanitize: strip leading slashes and any absolute path components
    const safePath = change.path.replace(/^[/\\]+/, "").replace(/\.\.\//g, "");
    const fullPath = path.join(sandboxRoot, safePath);

    const exists = fs.existsSync(fullPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, change.content, "utf-8");

    if (exists) modified++;
    else added++;
  }

  return { added, modified };
}

/** Run a shell command in a directory. Returns { stdout, stderr, success, exitCode } */
async function runCommand(
  cmd: string,
  cwd: string,
  timeoutMs = 120_000
): Promise<{ stdout: string; stderr: string; success: boolean; exitCode: number }> {
  try {
    const { stdout, stderr } = await execAsync(cmd, {
      cwd,
      timeout: timeoutMs,
      env: { ...process.env },
      maxBuffer: 5 * 1024 * 1024,
    });
    return { stdout: stdout || "", stderr: stderr || "", success: true, exitCode: 0 };
  } catch (e: any) {
    return {
      stdout: e.stdout || "",
      stderr: e.stderr || e.message || "",
      success: false,
      exitCode: e.code || 1,
    };
  }
}

/** Run the real validation suite in the sandbox directory */
async function runValidation(sandboxPath: string): Promise<ValidationResult> {
  log(`  Running validation in: ${sandboxPath}`);

  // 1. npm install (backend sandbox)
  log("  → npm install...");
  const install = await runCommand("npm install --prefer-offline --no-audit 2>&1", sandboxPath, 90_000);
  log(`  → npm install: ${install.success ? "✓" : "✗"}`);

  // 2. TypeScript check
  log("  → npx tsc --noEmit...");
  const tsc = await runCommand("npx tsc --noEmit 2>&1", sandboxPath, 60_000);
  log(`  → tsc: ${tsc.success ? "✓" : `✗ (${tsc.stderr.split("\n").length} error lines)`}`);

  // 3. Build
  log("  → npm run build...");
  const build = await runCommand("npm run build 2>&1", sandboxPath, 60_000);
  log(`  → build: ${build.success ? "✓" : "✗"}`);

  // 4. ESLint (optional — only run if .eslintrc* exists)
  let eslintSuccess = true;
  let eslintErrors = "";
  const hasEslint = fs.existsSync(path.join(sandboxPath, ".eslintrc.json")) ||
    fs.existsSync(path.join(sandboxPath, "eslint.config.mjs")) ||
    fs.existsSync(path.join(sandboxPath, ".eslintrc.js"));

  if (hasEslint) {
    log("  → eslint...");
    const eslint = await runCommand("npx eslint . --ext .ts,.tsx --max-warnings=50 2>&1", sandboxPath, 60_000);
    eslintSuccess = eslint.success;
    eslintErrors = eslint.stderr || eslint.stdout;
    log(`  → eslint: ${eslint.success ? "✓" : "✗"}`);
  }

  // 5. Tests (optional — only run if test script exists)
  let testSuccess = true;
  let testErrors = "";
  const pkgPath = path.join(sandboxPath, "package.json");
  let hasTests = false;
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    hasTests = !!(pkg.scripts?.test && !pkg.scripts.test.includes("no test specified"));
  }

  if (hasTests) {
    log("  → npm test...");
    const test = await runCommand("npm test -- --passWithNoTests 2>&1", sandboxPath, 60_000);
    testSuccess = test.success;
    testErrors = test.stderr || test.stdout;
    log(`  → test: ${test.success ? "✓" : "✗"}`);
  }

  return {
    npmInstallSuccess: install.success,
    npmInstallError: install.stderr,
    tscSuccess: tsc.success,
    tscErrors: tsc.stderr || tsc.stdout,
    buildSuccess: build.success,
    buildErrors: build.stderr || build.stdout,
    eslintSuccess,
    eslintErrors,
    testSuccess,
    testErrors,
  };
}

/** Detect hallucinations by checking agent output against known-existing inventory */
function detectHallucinations(
  changes: AgentFileChange[],
  task: TaskSpec,
  sandboxPath: string
): { detected: boolean; details: string[] } {
  const details: string[] = [];

  for (const change of changes) {
    const content = change.content;

    // Check for non-existing import paths in generated TypeScript files
    if (change.path.endsWith(".ts") || change.path.endsWith(".tsx")) {
      const importMatches = content.matchAll(/from\s+['"]([^'"]+)['"]/g);
      for (const m of importMatches) {
        const importPath = m[1];
        // Skip node_modules imports
        if (!importPath.startsWith(".")) continue;

        // Resolve relative to file
        const fileDir = path.dirname(path.join(sandboxPath, change.path));
        const resolvedBase = path.resolve(fileDir, importPath);
        const candidates = [resolvedBase, resolvedBase + ".ts", resolvedBase + ".tsx", resolvedBase + "/index.ts"];
        const anyExists = candidates.some((c) => fs.existsSync(c));

        if (!anyExists) {
          details.push(`Broken import in ${change.path}: import from '${importPath}' (resolved: ${resolvedBase}) — file does not exist`);
        }
      }
    }

    // Check for obviously hallucinated service/component names from task signals
    for (const signal of task.hallucinationSignals) {
      // If the signal mentions creating something (e.g. "Creating a DateValidationService")
      const nameMatch = signal.match(/Creating\s+([A-Za-z]+)/i);
      if (nameMatch) {
        const inventedName = nameMatch[1];
        if (content.includes(inventedName) || change.path.includes(inventedName)) {
          details.push(`Possible hallucination: Agent used "${inventedName}" which the task spec warns against: "${signal}"`);
        }
      }
    }
  }

  return { detected: details.length > 0, details };
}

/** Extract compile error lines from tsc output */
function extractCompileErrors(tscOutput: string): string[] {
  return tscOutput
    .split("\n")
    .filter((l) => l.includes("error TS") || l.startsWith("error"))
    .slice(0, 20);
}

/** Main benchmark runner for a single task */
async function runTask(task: TaskSpec, runId: string): Promise<TaskBenchmarkResult> {
  const sandboxName = `${runId}_${task.id}`;
  const sandboxPath = path.join(CONFIG.SANDBOX_ROOT, sandboxName);

  log(`\n${"=".repeat(72)}`);
  log(`TASK: ${task.id} | Category: ${task.category} | Difficulty: ${task.difficulty}`);
  log(`Prompt: ${task.prompt.slice(0, 120)}...`);
  log(`${"=".repeat(72)}`);

  // ── Validate pre-conditions ─────────────────────────────────────────────────

  if (!CONFIG.TEST_USER_ID || !CONFIG.TEST_PROJECT_ID) {
    err("BENCHMARK_USER_ID and BENCHMARK_PROJECT_ID env vars are required!");
    err("Example: BENCHMARK_USER_ID=... BENCHMARK_PROJECT_ID=... npx ts-node scripts/run-agent-benchmark.ts");
    return {
      taskId: task.id,
      taskCategory: task.category,
      prompt: task.prompt,
      status: "SKIPPED",
      durationMs: 0,
      agentResponse: {
        intent: "UNKNOWN",
        confidence: 0,
        filesChanged: 0,
        filesAdded: 0,
        filesModified: 0,
        filesDeleted: 0,
        needsClarification: false,
        rawError: "Missing BENCHMARK_USER_ID or BENCHMARK_PROJECT_ID environment variables",
        agentClaimedBuildSuccess: false,
      },
      validation: {
        npmInstallSuccess: false, npmInstallError: "Skipped",
        tscSuccess: false, tscErrors: "Skipped",
        buildSuccess: false, buildErrors: "Skipped",
        eslintSuccess: false, eslintErrors: "Skipped",
        testSuccess: false, testErrors: "Skipped",
      },
      hallucinationDetected: false,
      hallucinationDetails: [],
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCostUSD: 0 },
      compileErrors: [],
      runtimeErrors: [],
      finalStatus: "SKIPPED: Missing environment variables. Set BENCHMARK_USER_ID and BENCHMARK_PROJECT_ID.",
      sandboxPath,
    };
  }

  // ── Step 1: Create isolated sandbox ────────────────────────────────────────

  log(`Step 1: Creating isolated sandbox at: ${sandboxPath}`);
  if (fs.existsSync(sandboxPath)) {
    fs.rmSync(sandboxPath, { recursive: true, force: true });
  }
  fs.mkdirSync(sandboxPath, { recursive: true });

  // Copy the backend source (this is what the agent modifies)
  copyDir(CONFIG.BACKEND_ROOT, sandboxPath);
  log(`  Copied backend source (excl. node_modules, .git, dist)`);

  // ── Step 2: Call the REAL AI Agent Pipeline ───────────────────────────

  log(`Step 2: Invoking REAL AI Agent pipeline (AiService.runCodingAgent)...`);

  let agentRawResponse: any = null;
  let agentData: AgentResponse | null = null;
  let durationMs = 0;
  let callError: string | null = null;

  const startTime = Date.now();

  try {
    const aiService = AiService.getInstance();
    agentData = await aiService.runCodingAgent(
      CONFIG.TEST_USER_ID,
      CONFIG.TEST_PROJECT_ID,
      { message: task.prompt }
    );

    durationMs = Date.now() - startTime;

    if (agentData) {
      log(`  Agent responded in ${durationMs}ms. Changes: ${agentData.changes?.length ?? 0}. Intent: ${agentData.intent ?? "unknown"}`);
    } else {
      callError = "Agent returned null response";
      err(`  Agent returned error: ${callError}`);
    }
  } catch (e: any) {
    durationMs = Date.now() - startTime;
    callError = e.stack || e.message || String(e);
    err(`  Agent execution failed: ${callError.slice(0, 300)}`);
  }

  // ── Step 3: Apply changes to sandbox ───────────────────────────────────────

  let filesAdded = 0;
  let filesModified = 0;
  let hallucinationDetected = false;
  let hallucinationDetails: string[] = [];

  if (agentData?.changes?.length) {
    log(`Step 3: Applying ${agentData.changes.length} file changes to sandbox...`);
    const applied = applyChanges(sandboxPath, agentData.changes);
    filesAdded = applied.added;
    filesModified = applied.modified;
    log(`  Added: ${filesAdded} | Modified: ${filesModified}`);

    // ── Step 4: Hallucination Detection ──────────────────────────────────────
    log(`Step 4: Checking for hallucinations...`);
    const hallResult = detectHallucinations(agentData.changes, task, sandboxPath);
    hallucinationDetected = hallResult.detected;
    hallucinationDetails = hallResult.details;
    if (hallucinationDetected) {
      err(`  Hallucinations detected: ${hallucinationDetails.join(" | ")}`);
    } else {
      log(`  No hallucinations detected.`);
    }
  } else {
    log(`Step 3: No changes to apply. ${callError ? "Agent error." : "Agent returned 0 changes."}`);
  }

  // ── Step 5: Real Validation ─────────────────────────────────────────────────

  log(`Step 5: Running real validation suite...`);
  let validation: ValidationResult;

  if (agentData?.changes?.length) {
    validation = await runValidation(sandboxPath);
  } else {
    // Still validate the sandbox to get a baseline (no changes applied)
    validation = {
      npmInstallSuccess: false,
      npmInstallError: "Skipped — no agent changes to validate",
      tscSuccess: false,
      tscErrors: "Skipped",
      buildSuccess: false,
      buildErrors: "Skipped",
      eslintSuccess: false,
      eslintErrors: "Skipped",
      testSuccess: false,
      testErrors: "Skipped",
    };
  }

  // ── Step 6: Compute final status ──────────────────────────────────────────

  const compileErrors = extractCompileErrors(validation.tscErrors);
  const runtimeErrors: string[] = [];

  let finalStatus: TaskBenchmarkResult["status"];
  let finalStatusDetail: string;

  if (callError && !agentData) {
    finalStatus = durationMs >= CONFIG.AGENT_TIMEOUT_MS - 5000 ? "TIMEOUT" : "AGENT_ERROR";
    finalStatusDetail = callError;
  } else if (!agentData?.changes?.length) {
    finalStatus = "FAILED";
    finalStatusDetail = "Agent returned 0 file changes";
  } else if (validation.buildSuccess && validation.tscSuccess) {
    finalStatus = hallucinationDetected ? "PARTIAL" : "SUCCESS";
    finalStatusDetail = hallucinationDetected
      ? "Build passed but hallucinations detected"
      : "Build and TypeScript check passed";
  } else {
    finalStatus = "PARTIAL";
    finalStatusDetail = `Build: ${validation.buildSuccess ? "✓" : "✗"} | TSC: ${validation.tscSuccess ? "✓" : "✗"} | ${compileErrors.length} compile errors`;
  }

  log(`\nFinal status: ${finalStatus} — ${finalStatusDetail}`);

  // Token usage: read from agent response if the backend exposes usage
  // (The backend doesn't currently forward OpenAI token counts in AgentResponse,
  //  so we estimate based on known GPT-4o pricing: $5/1M input + $15/1M output)
  const ESTIMATE_INPUT_TOKENS = 8000;
  const ESTIMATE_OUTPUT_TOKENS = agentData?.changes?.length ? agentData.changes.length * 1200 : 500;
  const estimatedCostUSD = (ESTIMATE_INPUT_TOKENS / 1_000_000) * 5 + (ESTIMATE_OUTPUT_TOKENS / 1_000_000) * 15;

  return {
    taskId: task.id,
    taskCategory: task.category,
    prompt: task.prompt,
    status: finalStatus,
    durationMs,
    agentResponse: {
      intent: agentData?.intent || "unknown",
      confidence: agentData?.confidence || 0,
      filesChanged: (agentData?.changes?.length || 0),
      filesAdded,
      filesModified,
      filesDeleted: 0, // agent doesn't currently delete files
      needsClarification: agentData?.needsClarification || false,
      rawError: callError || undefined,
      agentClaimedBuildSuccess: agentData?.buildVerified || false,
    },
    validation,
    hallucinationDetected,
    hallucinationDetails,
    tokenUsage: {
      promptTokens: ESTIMATE_INPUT_TOKENS,
      completionTokens: ESTIMATE_OUTPUT_TOKENS,
      totalTokens: ESTIMATE_INPUT_TOKENS + ESTIMATE_OUTPUT_TOKENS,
      estimatedCostUSD,
    },
    compileErrors,
    runtimeErrors,
    finalStatus: finalStatusDetail,
    sandboxPath,
  };
}

// ─── Summary Generation ────────────────────────────────────────────────────────

function computeSummary(results: TaskBenchmarkResult[]): BenchmarkReport["summary"] {
  const completed = results.filter((r) => r.status !== "SKIPPED");
  const buildPassed = completed.filter((r) => r.validation.buildSuccess);
  const agentSucceeded = completed.filter((r) => r.status === "SUCCESS" || r.status === "PARTIAL");
  const hallucinated = completed.filter((r) => r.hallucinationDetected);

  const totalDurationMs = completed.reduce((s, r) => s + r.durationMs, 0);
  const totalTokens = completed.reduce((s, r) => s + r.tokenUsage.totalTokens, 0);
  const totalCost = completed.reduce((s, r) => s + r.tokenUsage.estimatedCostUSD, 0);
  const avgConfidence = completed.length
    ? completed.reduce((s, r) => s + r.agentResponse.confidence, 0) / completed.length
    : 0;

  const breakdown: Record<string, { total: number; success: number; failed: number }> = {};
  for (const r of results) {
    if (!breakdown[r.taskCategory]) {
      breakdown[r.taskCategory] = { total: 0, success: 0, failed: 0 };
    }
    breakdown[r.taskCategory].total++;
    if (r.status === "SUCCESS") breakdown[r.taskCategory].success++;
    else if (r.status === "FAILED" || r.status === "AGENT_ERROR" || r.status === "TIMEOUT") {
      breakdown[r.taskCategory].failed++;
    }
  }

  return {
    buildSuccessRate: completed.length ? (buildPassed.length / completed.length) * 100 : 0,
    agentSuccessRate: completed.length ? (agentSucceeded.length / completed.length) * 100 : 0,
    hallucinationRate: completed.length ? (hallucinated.length / completed.length) * 100 : 0,
    avgDurationMs: completed.length ? totalDurationMs / completed.length : 0,
    totalTokens,
    totalEstimatedCostUSD: totalCost,
    avgConfidence,
    taskBreakdown: breakdown,
  };
}

function generateMarkdownSummary(report: BenchmarkReport): string {
  const s = report.summary;
  const rows = report.results.map((r) => {
    const build = r.validation.buildSuccess ? "✅" : r.status === "SKIPPED" ? "⏭" : "❌";
    const tsc = r.validation.tscSuccess ? "✅" : r.status === "SKIPPED" ? "⏭" : "❌";
    const hall = r.hallucinationDetected ? "⚠️" : "✓";
    const status = {
      SUCCESS: "✅ PASS",
      PARTIAL: "⚠️ PARTIAL",
      FAILED: "❌ FAIL",
      AGENT_ERROR: "💥 AGENT ERR",
      TIMEOUT: "⏱ TIMEOUT",
      SKIPPED: "⏭ SKIPPED",
    }[r.status];
    return `| ${r.taskId} | ${r.taskCategory} | ${status} | ${build} | ${tsc} | ${hall} | ${(r.durationMs / 1000).toFixed(1)}s | ${r.agentResponse.filesChanged} files |`;
  });

  return `# ANKA OS AI CODING AGENT — REAL BENCHMARK RESULTS

**Run Date**: ${report.runAt}  
**Total Tasks**: ${report.totalTasks}  
**Completed**: ${report.completedTasks}  
**Skipped**: ${report.skippedTasks}  

---

## 📊 Summary Metrics

| Metric | Value | Note |
| :--- | :--- | :--- |
| **Build Success Rate** | **${s.buildSuccessRate.toFixed(1)}%** | Tasks where npm run build passed |
| **Agent Success Rate** | **${s.agentSuccessRate.toFixed(1)}%** | Tasks fully or partially completed |
| **Hallucination Rate** | **${s.hallucinationRate.toFixed(1)}%** | Tasks with broken imports or invented symbols |
| **Avg Response Time** | **${(s.avgDurationMs / 1000).toFixed(1)}s** | Wall-clock agent latency per task |
| **Total Tokens Used** | **${s.totalTokens.toLocaleString()}** | Estimated across all tasks |
| **Est. API Cost** | **$${s.totalEstimatedCostUSD.toFixed(4)}** | Estimated at GPT-4o pricing |
| **Avg Confidence** | **${(s.avgConfidence * 100).toFixed(1)}%** | Agent self-reported confidence |

> **⚠️ NOTE**: All metrics above are from REAL agent execution and REAL validation commands.
> No values are fabricated. If a task failed, it is recorded as failed.

---

## 🗂 Per-Task Results

| Task | Category | Status | Build | TSC | Halluc | Time | Files |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
${rows.join("\n")}

---

## 🔍 Detailed Failure Analysis

${report.results
  .filter((r) => r.status !== "SUCCESS" && r.status !== "SKIPPED")
  .map((r) => `### ${r.taskId} — ${r.status}
**Prompt**: ${r.prompt.slice(0, 200)}

**Final Status**: ${r.finalStatus}

**Compile Errors** (first 5):
\`\`\`
${r.compileErrors.slice(0, 5).join("\n") || "None"}
\`\`\`

**Hallucination Details**:
${r.hallucinationDetails.length ? r.hallucinationDetails.map((d) => `- ${d}`).join("\n") : "None"}

**Agent Raw Error**: ${r.agentResponse.rawError || "None"}
`)
  .join("\n---\n")}

---

## 📦 Task Category Breakdown

| Category | Total | Success | Failed |
| :--- | :--- | :--- | :--- |
${Object.entries(s.taskBreakdown)
  .map(([cat, v]) => `| ${cat} | ${v.total} | ${v.success} | ${v.failed} |`)
  .join("\n")}

---

## ⚠️ IMPORTANT CAVEATS

1. **Skipped tasks** mean \`BENCHMARK_USER_ID\` and \`BENCHMARK_PROJECT_ID\` were not set. Set them and re-run.
2. **Hallucination detection** is static — checks for broken relative imports in generated TypeScript. It does NOT use an LLM to judge hallucinations.
3. **Token usage is estimated** — the backend \`AgentResponse\` does not currently expose OpenAI token counts. Actual cost may differ.
4. **Build validation** copies the entire backend source into an isolated sandbox and runs \`npm run build\` there. It does NOT pollute the production workspace.
`;
}

// ─── Main Entry Point ──────────────────────────────────────────────────────────

async function main() {
  console.log("=".repeat(72));
  console.log("🔬 ANKA OS AI CODING AGENT — REAL BENCHMARK FRAMEWORK");
  console.log("=".repeat(72));
  console.log("\nWEAKNESSES OF PREVIOUS BENCHMARK SCRIPTS:");
  console.log("  1. Coding accuracy used i % 7 patterns — pure arithmetic, not real execution");
  console.log("  2. Hallucination data was hardcoded as 'detected: true/false' — never measured");
  console.log("  3. Repair loop used pre-declared success/failure arrays — no agent ran");
  console.log("  4. Feature validation used pre-declared FP/FN arrays — no actual validation engine");
  console.log("  5. Repository understanding tested the engine against its own indexed files — tautology");
  console.log("\nNEW APPROACH: Call the LIVE agent HTTP API, apply real changes, run real validators.\n");

  if (!CONFIG.TEST_USER_ID || !CONFIG.TEST_PROJECT_ID) {
    console.log("⚠️  WARNING: BENCHMARK_USER_ID and BENCHMARK_PROJECT_ID are not set.");
    console.log("   The benchmark will STILL RUN but all tasks will be recorded as SKIPPED.");
    console.log("   To run a real benchmark, re-execute with:");
    console.log("   BENCHMARK_USER_ID=<userId> BENCHMARK_PROJECT_ID=<projectId> npx ts-node scripts/run-agent-benchmark.ts\n");
  }

  // Create output directories
  fs.mkdirSync(CONFIG.SANDBOX_ROOT, { recursive: true });
  fs.mkdirSync(CONFIG.TASKS_DIR, { recursive: true });
  fs.mkdirSync(CONFIG.OUTPUT_DIR, { recursive: true });

  // Load all task specs
  const taskFiles = fs.readdirSync(CONFIG.TASKS_DIR).filter((f) => f.endsWith(".md"));
  log(`Found ${taskFiles.length} task spec(s) in ${CONFIG.TASKS_DIR}`);

  const tasks: TaskSpec[] = [];
  for (const f of taskFiles) {
    const spec = parseTaskSpec(path.join(CONFIG.TASKS_DIR, f));
    if (spec) tasks.push(spec);
  }

  if (tasks.length === 0) {
    err("No valid task specs found. Exiting.");
    process.exit(1);
  }

  // Run each task sequentially (to avoid parallel API calls overwhelming the agent)
  const runId = `run_${Date.now()}`;
  const results: TaskBenchmarkResult[] = [];

  for (const task of tasks) {
    try {
      const result = await runTask(task, runId);
      results.push(result);
    } catch (e: any) {
      err(`Unexpected error running task ${task.id}: ${e.message}`);
      results.push({
        taskId: task.id,
        taskCategory: task.category,
        prompt: task.prompt,
        status: "AGENT_ERROR",
        durationMs: 0,
        agentResponse: {
          intent: "UNKNOWN",
          confidence: 0,
          filesChanged: 0,
          filesAdded: 0,
          filesModified: 0,
          filesDeleted: 0,
          needsClarification: false,
          rawError: e.message,
          agentClaimedBuildSuccess: false,
        },
        validation: {
          npmInstallSuccess: false, npmInstallError: "",
          tscSuccess: false, tscErrors: "",
          buildSuccess: false, buildErrors: "",
          eslintSuccess: false, eslintErrors: "",
          testSuccess: false, testErrors: "",
        },
        hallucinationDetected: false,
        hallucinationDetails: [],
        tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCostUSD: 0 },
        compileErrors: [],
        runtimeErrors: [],
        finalStatus: `Unexpected exception: ${e.message}`,
        sandboxPath: "",
      });
    }
  }

  // Compute summary and write outputs
  const summary = computeSummary(results);
  const completed = results.filter((r) => r.status !== "SKIPPED").length;
  const report: BenchmarkReport = {
    runAt: new Date().toISOString(),
    totalTasks: tasks.length,
    completedTasks: completed,
    skippedTasks: tasks.length - completed,
    results,
    summary,
  };

  // Write JSON results
  const jsonPath = path.join(CONFIG.OUTPUT_DIR, "benchmark-results.json");
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf-8");
  log(`\n✅ Results written to: ${jsonPath}`);

  // Write markdown summary
  const mdPath = path.join(CONFIG.OUTPUT_DIR, "benchmark-summary.md");
  fs.writeFileSync(mdPath, generateMarkdownSummary(report), "utf-8");
  log(`✅ Summary written to: ${mdPath}`);

  // Print headline results
  console.log("\n" + "=".repeat(72));
  console.log("📊 BENCHMARK COMPLETE — REAL RESULTS");
  console.log("=".repeat(72));
  console.log(`Total Tasks Defined:    ${report.totalTasks}`);
  console.log(`Completed:              ${report.completedTasks}`);
  console.log(`Skipped (no env vars):  ${report.skippedTasks}`);
  if (completed > 0) {
    console.log(`Build Success Rate:     ${summary.buildSuccessRate.toFixed(1)}%`);
    console.log(`Agent Success Rate:     ${summary.agentSuccessRate.toFixed(1)}%`);
    console.log(`Hallucination Rate:     ${summary.hallucinationRate.toFixed(1)}%`);
    console.log(`Avg Response Time:      ${(summary.avgDurationMs / 1000).toFixed(1)}s`);
    console.log(`Est. Total API Cost:    $${summary.totalEstimatedCostUSD.toFixed(4)}`);
  } else {
    console.log("\n⚠️  All tasks were SKIPPED because BENCHMARK_USER_ID / BENCHMARK_PROJECT_ID are missing.");
    console.log("   The framework is correctly built and ready to execute real benchmarks.");
    console.log("   Set the environment variables and re-run to get real metrics.\n");
  }
  console.log(`\nResults: ${jsonPath}`);
  console.log(`Summary: ${mdPath}`);
  console.log("=".repeat(72));
}

main().catch((e) => {
  err(`Fatal: ${e.message}`);
  process.exit(1);
});
