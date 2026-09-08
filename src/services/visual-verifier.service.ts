import path from "path";
import fs from "fs";
import net from "net";
import os from "os";
import { spawn, ChildProcess, exec } from "child_process";
import { chromium, Browser, BrowserContext, Page } from "playwright-core";
import { VisualVerificationResult, VisualVerificationStatus } from "../types";
import { ValidationEnvironmentPolicy } from "../ai/validation/ValidationEnvironmentPolicy";

export interface VisualVerifierOptions {
  worktreePath: string;
  changedFiles: Array<string | { path: string }>;
  framework: "NEXT_JS" | "VITE_REACT" | "EXPRESS" | "NODE_JS" | "UNKNOWN";
  runId: string;
  taskPrompt?: string;
}

const VISUAL_EXTENSIONS = new Set([
  ".tsx",
  ".jsx",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".html",
]);

/**
 * Returns true if the given file path is visual/frontend relevant.
 */
export function isVisualFile(filePath: string): boolean {
  if (!filePath) return false;
  const ext = path.extname(filePath).toLowerCase();
  if (VISUAL_EXTENSIONS.has(ext)) return true;
  const norm = filePath.replace(/\\/g, "/").toLowerCase();
  return (
    norm.includes("/app/") ||
    norm.startsWith("app/") ||
    norm.includes("/pages/") ||
    norm.startsWith("pages/") ||
    norm.includes("layout.") ||
    norm.includes("page.")
  );
}

/**
 * Evaluates whether visual verification is eligible to run.
 * Requires supported framework (NEXT_JS or VITE_REACT) and at least one visual file changed.
 */
export function isEligible(
  framework: string,
  changedFiles: Array<string | { path: string }>
): boolean {
  if (framework !== "NEXT_JS" && framework !== "VITE_REACT") {
    return false;
  }
  const filePaths = changedFiles.map((f) => (typeof f === "string" ? f : f.path));
  return filePaths.some(isVisualFile);
}

/**
 * Searches local ms-playwright directories for an existing Chromium or headless-shell binary.
 * Prefers chromium_headless_shell-*, then standard chromium-*.
 */
export function findChromiumExecutable(): string | null {
  const localAppData = process.env.LOCALAPPDATA;
  const homeDir = process.env.USERPROFILE || process.env.HOME;

  const searchRoots: string[] = [];
  if (localAppData) {
    searchRoots.push(path.join(localAppData, "ms-playwright"));
  }
  if (homeDir) {
    searchRoots.push(path.join(homeDir, ".cache", "ms-playwright"));
    searchRoots.push(path.join(homeDir, "AppData", "Local", "ms-playwright"));
  }

  for (const root of searchRoots) {
    if (!fs.existsSync(root)) continue;

    try {
      const entries = fs.readdirSync(root);

      // 1. Prefer chromium_headless_shell-*
      const headlessDirs = entries
        .filter((e) => e.startsWith("chromium_headless_shell-"))
        .sort()
        .reverse();

      for (const d of headlessDirs) {
        const fullDir = path.join(root, d);
        const candidates = [
          path.join(fullDir, "chrome-headless-shell-win64", "chrome-headless-shell.exe"),
          path.join(fullDir, "chrome-headless-shell-win", "chrome-headless-shell.exe"),
          path.join(fullDir, "chrome-headless-shell-linux", "chrome-headless-shell"),
          path.join(fullDir, "chrome-headless-shell-mac", "chrome-headless-shell"),
        ];
        for (const cand of candidates) {
          if (fs.existsSync(cand)) return cand;
        }
      }

      // 2. Fallback to normal chromium-*
      const chromiumDirs = entries
        .filter((e) => e.startsWith("chromium-"))
        .sort()
        .reverse();

      for (const d of chromiumDirs) {
        const fullDir = path.join(root, d);
        const candidates = [
          path.join(fullDir, "chrome-win64", "chrome.exe"),
          path.join(fullDir, "chrome-win", "chrome.exe"),
          path.join(fullDir, "chrome-linux", "chrome"),
          path.join(fullDir, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"),
        ];
        for (const cand of candidates) {
          if (fs.existsSync(cand)) return cand;
        }
      }
    } catch {
      // Continue to next search root
    }
  }

  return null;
}

/**
 * Preflight check ensuring the local Chromium binary can launch, render, and close cleanly.
 * Used for preflight verification only.
 */
export async function preflightBrowser(): Promise<{
  success: boolean;
  error?: string;
  executablePath?: string;
}> {
  const execPath = findChromiumExecutable();
  if (!execPath) {
    return { success: false, error: "Chromium binary not found in ms-playwright directory." };
  }

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ executablePath: execPath, headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto("data:text/html,<h1>ANKA Browser Preflight</h1>", {
      waitUntil: "load",
      timeout: 10000,
    });
    const text = await page.textContent("h1");
    if (text !== "ANKA Browser Preflight") {
      return { success: false, error: "Preflight page content mismatch." };
    }
    return { success: true, executablePath: execPath };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

/**
 * Allocates a free loopback port using native Node.js net.createServer.
 */
export async function allocateFreePort(host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, host, () => {
      const addr = srv.address() as net.AddressInfo;
      const port = addr.port;
      srv.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

/**
 * Inspects package.json to determine the framework start command.
 * Strictly derives commands from declared scripts. Fallback to npx next/vite is disallowed.
 */
export function detectStartCommand(
  worktreePath: string,
  framework: string,
  port: number
): { command: string; isPreview: boolean } | null {
  const pkgPath = path.join(worktreePath, "package.json");
  if (!fs.existsSync(pkgPath)) return null;

  let pkg: any = null;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  } catch {
    return null;
  }

  const scripts = pkg?.scripts || {};

  if (framework === "NEXT_JS") {
    if (scripts.dev) {
      return { command: `npm run dev -- --hostname 127.0.0.1 --port ${port}`, isPreview: false };
    }
    if (scripts.start) {
      return { command: `npm run start -- --hostname 127.0.0.1 --port ${port}`, isPreview: true };
    }
    return null;
  }

  if (framework === "VITE_REACT") {
    if (scripts.dev) {
      return { command: `npm run dev -- --host 127.0.0.1 --port ${port} --strictPort`, isPreview: false };
    }
    if (scripts.preview) {
      return { command: `npm run preview -- --host 127.0.0.1 --port ${port} --strictPort`, isPreview: true };
    }
    return null;
  }

  return null;
}

/**
 * Resolves the target route based on changed files and framework.
 */
export function resolveTargetRoute(
  changedFiles: Array<string | { path: string }>,
  framework: string,
  _taskPrompt?: string
): string {
  const filePaths = changedFiles.map((f) => (typeof f === "string" ? f : f.path));

  // 1. Next.js: Check changed files for route pages
  if (framework === "NEXT_JS") {
    for (const f of filePaths) {
      const norm = f.replace(/\\/g, "/").replace(/^\.\//, "");

      // App Router root
      if (
        norm === "app/page.tsx" ||
        norm === "app/page.jsx" ||
        norm === "src/app/page.tsx" ||
        norm === "src/app/page.jsx"
      ) {
        return "/";
      }

      // App Router subpage e.g. src/app/dashboard/page.tsx -> /dashboard
      const appMatch = norm.match(/(?:^|\/)(?:src\/)?app\/(.+?)\/page\.(?:tsx|jsx|ts|js)$/i);
      if (appMatch && appMatch[1]) {
        return `/${appMatch[1]}`;
      }

      // Pages Router root
      if (
        norm === "pages/index.tsx" ||
        norm === "pages/index.jsx" ||
        norm === "src/pages/index.tsx" ||
        norm === "src/pages/index.jsx"
      ) {
        return "/";
      }

      // Pages Router subpage e.g. pages/settings.tsx -> /settings
      const pagesMatch = norm.match(/(?:^|\/)(?:src\/)?pages\/(.+?)\.(?:tsx|jsx|ts|js)$/i);
      if (pagesMatch && pagesMatch[1] && !pagesMatch[1].startsWith("_")) {
        const sub = pagesMatch[1].replace(/\/index$/, "");
        return `/${sub}`;
      }
    }
  }

  // 2. Vite React or fallback
  return "/";
}

/**
 * Validates that a route string is safe for localhost navigation.
 * Rejects external protocols, credentials, hostnames, and arbitrary schemes.
 */
export function validateSafeRoute(route: string): string {
  if (!route || typeof route !== "string") return "/";
  const trimmed = route.trim();
  if (!trimmed.startsWith("/")) return "/";

  // Reject unsafe schemes, hostnames, protocols, double slashes
  if (
    trimmed.startsWith("//") ||
    /^(?:http:|https:|javascript:|data:|file:)/i.test(trimmed) ||
    /[@:?#]/.test(trimmed) ||
    !/^\/[a-zA-Z0-9_\-\/]*$/.test(trimmed)
  ) {
    return "/";
  }

  return trimmed;
}

/**
 * Bounded readiness poll targeting http://127.0.0.1:<port>/.
 * Terminates immediately if child process dies prematurely.
 */
export async function waitForServer(
  url: string,
  child: ChildProcess,
  timeoutMs = 30000,
  pollIntervalMs = 400
): Promise<boolean> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    if (child.exitCode !== null) {
      return false;
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (res) {
        return true;
      }
    } catch {
      // Server not ready yet
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  return false;
}

/**
 * Constructs an execution-scoped screenshot path outside the target worktree.
 */
export function getScreenshotPath(runId: string, route: string): string {
  const normalized = route.replace(/^\/+|\/+$/g, "");
  const cleanRoute = !normalized ? "root" : normalized.replace(/[^a-zA-Z0-9_\-]/g, "_");
  const timestamp = Date.now();
  const dir = path.join(os.tmpdir(), "anka", "screenshots", runId);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${timestamp}-${cleanRoute}.png`);
}

export class VisualVerifierService {
  /**
   * Constructs a sanitized, neutral environment for frontend servers.
   * Strips ANKA application secrets, DATABASE_URL, tokens, keys, and NODE_ENV/PORT contamination.
   */
  public static buildServerEnv(customEnv?: Record<string, string>): NodeJS.ProcessEnv {
    const sanitizedEnv = ValidationEnvironmentPolicy.getSanitizedEnv("terminal", {
      customEnv: {
        ...(customEnv || {}),
      },
    });

    for (const k of Object.keys(sanitizedEnv)) {
      const lower = k.toLowerCase();
      if (lower === "node_env" || lower === "port") {
        delete sanitizedEnv[k];
      }
    }
    return sanitizedEnv;
  }

  /**
   * Detects platform shell for executing repository start commands.
   */
  public static detectPlatformShell(): { shell: string; args: string[] } {
    if (process.platform === "win32") {
      const comSpec = process.env.COMSPEC || "cmd.exe";
      return { shell: comSpec, args: ["/d", "/s", "/c"] };
    }
    const userShell = process.env.SHELL || "/bin/sh";
    return { shell: userShell, args: ["-c"] };
  }

  /**
   * Recursively terminates child process and any spawned tree.
   */
  public static killProcessTree(child: ChildProcess, signal: "SIGINT" | "SIGTERM" | "SIGKILL" = "SIGKILL"): void {
    if (!child || !child.pid) return;
    try {
      if (process.platform === "win32") {
        exec(`taskkill /pid ${child.pid} /T /F`, () => {});
      } else {
        try {
          process.kill(-child.pid, signal);
        } catch {
          child.kill(signal);
        }
      }
    } catch {
      try {
        child.kill(signal);
      } catch {}
    }
  }

  /**
   * Executes bounded visual verification of an active frontend application.
   */
  public static async verify(options: VisualVerifierOptions): Promise<VisualVerificationResult> {
    const startTime = Date.now();
    const { worktreePath, changedFiles, framework, runId, taskPrompt } = options;

    // 1. Eligibility check
    const eligible = isEligible(framework, changedFiles);
    console.log(`[VISUAL_VERIFY] eligible=${eligible}`);
    console.log(`[VISUAL_VERIFY] framework=${framework}`);

    if (!eligible) {
      console.log(`[VISUAL_VERIFY] status=NOT_APPLICABLE`);
      console.log(`[VISUAL_VERIFY] durationMs=${Date.now() - startTime}`);
      return {
        status: "NOT_APPLICABLE",
        framework: framework === "NEXT_JS" || framework === "VITE_REACT" ? framework : "UNKNOWN",
        route: "/",
        pageErrors: [],
        consoleErrors: [],
        failedRequests: [],
        durationMs: Date.now() - startTime,
      };
    }

    // 2. Discover Chromium executable
    const executablePath = findChromiumExecutable();
    if (!executablePath) {
      console.log(`[VISUAL_VERIFY] browser=FAIL`);
      console.log(`[VISUAL_VERIFY] status=BROWSER_UNAVAILABLE`);
      console.log(`[VISUAL_VERIFY] durationMs=${Date.now() - startTime}`);
      return {
        status: "BROWSER_UNAVAILABLE",
        framework: framework as any,
        route: "/",
        pageErrors: ["Chromium browser binary not found in ms-playwright directory."],
        consoleErrors: [],
        failedRequests: [],
        durationMs: Date.now() - startTime,
      };
    }

    // 3. Port allocation
    let port: number;
    try {
      port = await allocateFreePort();
    } catch (err: any) {
      console.log(`[VISUAL_VERIFY] status=STARTUP_FAILED`);
      console.log(`[VISUAL_VERIFY] durationMs=${Date.now() - startTime}`);
      return {
        status: "STARTUP_FAILED",
        framework: framework as any,
        route: "/",
        startupErrors: `Failed to allocate free loopback port: ${err?.message || err}`,
        pageErrors: [],
        consoleErrors: [],
        failedRequests: [],
        durationMs: Date.now() - startTime,
      };
    }

    // 4. Determine start command
    const startCmdInfo = detectStartCommand(worktreePath, framework, port);
    if (!startCmdInfo) {
      console.log(`[VISUAL_VERIFY] status=STARTUP_FAILED`);
      console.log(`[VISUAL_VERIFY] durationMs=${Date.now() - startTime}`);
      return {
        status: "STARTUP_FAILED",
        framework: framework as any,
        route: "/",
        startupErrors: `No supported start/dev script found in repository package.json for framework ${framework}. Fallback to npx is disallowed.`,
        pageErrors: [],
        consoleErrors: [],
        failedRequests: [],
        durationMs: Date.now() - startTime,
      };
    }

    // 5. Route resolution & validation
    const rawRoute = resolveTargetRoute(changedFiles, framework, taskPrompt);
    const route = validateSafeRoute(rawRoute);
    const targetUrl = `http://127.0.0.1:${port}${route}`;

    console.log(`[VISUAL_VERIFY] route=${route}`);
    console.log(`[VISUAL_VERIFY] command=${startCmdInfo.command}`);
    console.log(`[VISUAL_VERIFY] port=${port}`);

    let serverProcess: ChildProcess | null = null;
    let browser: Browser | null = null;
    let context: BrowserContext | null = null;
    let startupStdout = "";
    let startupStderr = "";

    try {
      // 6. Spawn frontend server process with sanitized environment
      const env = VisualVerifierService.buildServerEnv();
      const platformShell = VisualVerifierService.detectPlatformShell();

      serverProcess = spawn(platformShell.shell, [...platformShell.args, startCmdInfo.command], {
        cwd: worktreePath,
        env,
        windowsHide: true,
      });

      serverProcess.stdout?.on("data", (chunk: Buffer) => {
        startupStdout = (startupStdout + chunk.toString()).slice(-2000);
      });
      serverProcess.stderr?.on("data", (chunk: Buffer) => {
        startupStderr = (startupStderr + chunk.toString()).slice(-2000);
      });

      // 7. Wait for server readiness
      const isReady = await waitForServer(`http://127.0.0.1:${port}/`, serverProcess, 30000, 400);
      console.log(`[VISUAL_VERIFY] readiness=${isReady ? "PASS" : "FAIL"}`);

      if (!isReady) {
        console.log(`[VISUAL_VERIFY] browser=NOT_REACHED`);
        console.log(`[VISUAL_VERIFY] screenshot=NONE`);
        console.log(`[VISUAL_VERIFY] status=STARTUP_FAILED`);
        console.log(`[VISUAL_VERIFY] durationMs=${Date.now() - startTime}`);
        const exitMsg =
          serverProcess.exitCode !== null
            ? ` (process exited with code ${serverProcess.exitCode})`
            : " (timed out after 30s)";
        const errDetails = startupStderr || startupStdout || "No output captured";
        return {
          status: "STARTUP_FAILED",
          framework: framework as any,
          route,
          url: targetUrl,
          startupErrors: `Frontend server failed to become ready at ${targetUrl}${exitMsg}. Diagnostics:\n${errDetails}`,
          pageErrors: [],
          consoleErrors: [],
          failedRequests: [],
          durationMs: Date.now() - startTime,
        };
      }

      // 8. Launch Playwright & configure listeners
      browser = await chromium.launch({
        executablePath,
        headless: true,
      });

      context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        ignoreHTTPSErrors: true,
      });

      const page: Page = await context.newPage();

      const pageErrors: string[] = [];
      const consoleErrors: string[] = [];
      const failedRequests: string[] = [];

      page.on("pageerror", (err) => {
        pageErrors.push(err?.message || String(err));
      });

      page.on("console", (msg) => {
        if (msg.type() === "error") {
          consoleErrors.push(msg.text());
        }
      });

      page.on("requestfailed", (req) => {
        failedRequests.push(`${req.method()} ${req.url()}: ${req.failure()?.errorText || "failed"}`);
      });

      // 9. Navigate to verified route
      let httpStatus: number | undefined;
      let title: string | undefined;
      let bodyVisible = false;
      let navError: string | null = null;

      try {
        const response = await page.goto(targetUrl, {
          waitUntil: "load",
          timeout: 15000,
        });
        httpStatus = response?.status();
        title = await page.title().catch(() => "");
        bodyVisible = await page.locator("body").isVisible().catch(() => false);
      } catch (err: any) {
        navError = err?.message || String(err);
      }

      // 10. Capture screenshot if navigation succeeded
      let screenshotPath: string | undefined;
      if (!navError && bodyVisible) {
        try {
          screenshotPath = getScreenshotPath(runId, route);
          await page.screenshot({ path: screenshotPath, fullPage: false });
        } catch {
          // Screenshot capture failure is non-fatal to runtime status
        }
      }

      // 11. Deterministic status evaluation
      let status: VisualVerificationStatus;
      if (
        navError ||
        !httpStatus ||
        httpStatus < 200 ||
        httpStatus >= 400 ||
        pageErrors.length > 0 ||
        !bodyVisible
      ) {
        status = "RUNTIME_FAILED";
      } else if (consoleErrors.length > 0 || failedRequests.length > 0) {
        status = "PASSED_WITH_WARNINGS";
      } else {
        status = "PASSED";
      }

      console.log(`[VISUAL_VERIFY] browser=${navError ? "FAIL" : "PASS"}`);
      console.log(`[VISUAL_VERIFY] httpStatus=${httpStatus ?? "NONE"}`);
      console.log(`[VISUAL_VERIFY] screenshot=${screenshotPath || "NONE"}`);
      console.log(`[VISUAL_VERIFY] status=${status}`);
      console.log(`[VISUAL_VERIFY] durationMs=${Date.now() - startTime}`);

      return {
        status,
        framework: framework as any,
        route,
        url: targetUrl,
        httpStatus,
        title,
        viewport: { width: 1280, height: 720 },
        screenshotPath,
        pageErrors: navError ? [...pageErrors, `Navigation error: ${navError}`] : pageErrors,
        consoleErrors,
        failedRequests,
        durationMs: Date.now() - startTime,
      };
    } finally {
      // 12. Cleanup
      if (context) {
        await context.close().catch(() => {});
      }
      if (browser) {
        await browser.close().catch(() => {});
      }
      if (serverProcess) {
        VisualVerifierService.killProcessTree(serverProcess, "SIGKILL");
      }
    }
  }
}
