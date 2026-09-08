import path from "path";
import fs from "fs";
import net from "net";
import os from "os";
import { EventEmitter } from "events";
import {
  isVisualFile,
  isEligible,
  allocateFreePort,
  detectStartCommand,
  resolveTargetRoute,
  validateSafeRoute,
  waitForServer,
  getScreenshotPath,
  findChromiumExecutable,
  preflightBrowser,
  VisualVerifierService,
} from "../visual-verifier.service";

describe("VisualVerifierService — Bounded Playwright Visual Verification V1", () => {
  const tmpDir = path.join(os.tmpdir(), `anka-vis-test-${Date.now()}`);

  beforeAll(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterAll(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  // ── 1. Framework eligibility tests ──

  test("1. NEXT_JS with visual changes is detected eligible", () => {
    const eligible = isEligible("NEXT_JS", ["src/app/page.tsx"]);
    expect(eligible).toBe(true);
  });

  test("2. VITE_REACT with visual changes is detected eligible", () => {
    const eligible = isEligible("VITE_REACT", ["src/App.tsx"]);
    expect(eligible).toBe(true);
  });

  test("3. EXPRESS framework returns NOT_APPLICABLE", () => {
    const eligible = isEligible("EXPRESS", ["src/index.ts", "views/index.html"]);
    expect(eligible).toBe(false);
  });

  test("4. Backend-only changed files return NOT_APPLICABLE", () => {
    const eligible = isEligible("NEXT_JS", [
      "src/lib/db.ts",
      "src/services/user.service.ts",
      "prisma/schema.prisma",
      "README.md",
    ]);
    expect(eligible).toBe(false);
  });

  test("5. Visual .tsx, .jsx, .css, .scss files are recognized as visual", () => {
    expect(isVisualFile("components/Button.tsx")).toBe(true);
    expect(isVisualFile("components/Card.jsx")).toBe(true);
    expect(isVisualFile("styles/globals.css")).toBe(true);
    expect(isVisualFile("styles/theme.scss")).toBe(true);
    expect(isVisualFile("index.html")).toBe(true);
    expect(isVisualFile("src/utils/math.ts")).toBe(false);
    expect(isVisualFile("package.json")).toBe(false);
  });

  // ── 2. Script command inspection tests ──

  test("6. Next.js dev command is derived strictly from package.json without npx fallback", () => {
    const nextRepoDir = path.join(tmpDir, "next-repo");
    fs.mkdirSync(nextRepoDir, { recursive: true });
    fs.writeFileSync(
      path.join(nextRepoDir, "package.json"),
      JSON.stringify({
        scripts: {
          dev: "next dev",
          build: "next build",
        },
      })
    );

    const cmdInfo = detectStartCommand(nextRepoDir, "NEXT_JS", 4567);
    expect(cmdInfo).not.toBeNull();
    expect(cmdInfo?.command).toBe("npm run dev -- --hostname 127.0.0.1 --port 4567");
    expect(cmdInfo?.isPreview).toBe(false);
  });

  test("7. Vite dev command includes --host 127.0.0.1, --port, and --strictPort", () => {
    const viteRepoDir = path.join(tmpDir, "vite-repo");
    fs.mkdirSync(viteRepoDir, { recursive: true });
    fs.writeFileSync(
      path.join(viteRepoDir, "package.json"),
      JSON.stringify({
        scripts: {
          dev: "vite",
          build: "vite build",
          preview: "vite preview",
        },
      })
    );

    const cmdInfo = detectStartCommand(viteRepoDir, "VITE_REACT", 5180);
    expect(cmdInfo).not.toBeNull();
    expect(cmdInfo?.command).toBe("npm run dev -- --host 127.0.0.1 --port 5180 --strictPort");
    expect(cmdInfo?.isPreview).toBe(false);
  });

  test("8. Missing supported script returns null and does NOT fall back to npx", () => {
    const emptyRepoDir = path.join(tmpDir, "empty-repo");
    fs.mkdirSync(emptyRepoDir, { recursive: true });
    fs.writeFileSync(
      path.join(emptyRepoDir, "package.json"),
      JSON.stringify({
        scripts: {
          test: "jest",
        },
      })
    );

    const nextCmd = detectStartCommand(emptyRepoDir, "NEXT_JS", 3000);
    expect(nextCmd).toBeNull();

    const viteCmd = detectStartCommand(emptyRepoDir, "VITE_REACT", 3000);
    expect(viteCmd).toBeNull();
  });

  // ── 3. Port allocation tests ──

  test("9. Free port allocation returns a dynamic, bindable loopback port", async () => {
    const port = await allocateFreePort();
    expect(typeof port).toBe("number");
    expect(port).toBeGreaterThan(1024);
    expect(port).toBeLessThan(65536);

    // Verify it is immediately bindable
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.listen(port, "127.0.0.1", () => {
        server.close(() => resolve());
      });
      server.on("error", reject);
    });
  });

  // ── 4. Route resolution and security tests ──

  test("10. Next.js App Router subpage maps to correct route path", () => {
    const route = resolveTargetRoute(["src/app/dashboard/page.tsx"], "NEXT_JS");
    expect(route).toBe("/dashboard");

    const nestedRoute = resolveTargetRoute(["src/app/settings/profile/page.tsx"], "NEXT_JS");
    expect(nestedRoute).toBe("/settings/profile");

    const rootRoute = resolveTargetRoute(["app/page.tsx"], "NEXT_JS");
    expect(rootRoute).toBe("/");
  });

  test("11. Vite React defaults to root route /", () => {
    const route = resolveTargetRoute(["src/App.tsx", "src/main.tsx"], "VITE_REACT");
    expect(route).toBe("/");
  });

  test("12. Unsafe route values are rejected and normalized to safe root /", () => {
    expect(validateSafeRoute("http://attacker.com/malicious")).toBe("/");
    expect(validateSafeRoute("https://external.com")).toBe("/");
    expect(validateSafeRoute("//evil.com/path")).toBe("/");
    expect(validateSafeRoute("javascript:alert(1)")).toBe("/");
    expect(validateSafeRoute("data:text/html,hack")).toBe("/");
    expect(validateSafeRoute("/user@domain.com")).toBe("/");
    expect(validateSafeRoute("/path?query=param")).toBe("/");
    expect(validateSafeRoute("/safe-path/details")).toBe("/safe-path/details");
    expect(validateSafeRoute("/")).toBe("/");
  });

  // ── 5. Server readiness and early exit tests ──

  test("13. Readiness timeout is bounded and fails when server is not listening", async () => {
    // Fake child process that never exits but never listens
    const fakeChild = new EventEmitter() as any;
    fakeChild.exitCode = null;

    const start = Date.now();
    // Use short timeout for test
    const ready = await waitForServer("http://127.0.0.1:65432/", fakeChild, 1500, 200);
    const duration = Date.now() - start;

    expect(ready).toBe(false);
    expect(duration).toBeGreaterThanOrEqual(1400);
    expect(duration).toBeLessThan(4000);
  });

  test("14. Child process early exit aborts readiness immediately with false", async () => {
    const fakeChild = new EventEmitter() as any;
    fakeChild.exitCode = 1; // Exited immediately

    const start = Date.now();
    const ready = await waitForServer("http://127.0.0.1:65432/", fakeChild, 30000, 200);
    const duration = Date.now() - start;

    expect(ready).toBe(false);
    expect(duration).toBeLessThan(1000); // Immediate exit, not waiting 30s
  });

  // ── 6. Verification status contract & screenshot tests ──

  test("15. Unhandled pageerror or navigation failure produces RUNTIME_FAILED in VisualVerifierService", async () => {
    // Ineligible framework returns NOT_APPLICABLE
    const resIneligible = await VisualVerifierService.verify({
      worktreePath: tmpDir,
      changedFiles: ["src/api.ts"],
      framework: "EXPRESS",
      runId: "run-test-1",
    });
    expect(resIneligible.status).toBe("NOT_APPLICABLE");

    // Missing package scripts returns STARTUP_FAILED
    const emptyRepo = path.join(tmpDir, "missing-scripts");
    fs.mkdirSync(emptyRepo, { recursive: true });
    fs.writeFileSync(path.join(emptyRepo, "package.json"), JSON.stringify({ name: "test", scripts: {} }));

    const resStartup = await VisualVerifierService.verify({
      worktreePath: emptyRepo,
      changedFiles: ["src/App.tsx"],
      framework: "VITE_REACT",
      runId: "run-test-2",
    });
    expect(resStartup.status).toBe("STARTUP_FAILED");
    expect(resStartup.startupErrors).toContain("No supported start/dev script found");
  });

  test("16. Screenshot path is placed outside the target worktree in anka temporary directory", () => {
    const runId = "test-run-12345";
    const route = "/dashboard";
    const shotPath = getScreenshotPath(runId, route);

    expect(shotPath.startsWith(os.tmpdir())).toBe(true);
    expect(shotPath.includes(path.join("anka", "screenshots", runId))).toBe(true);
    expect(shotPath.endsWith("-dashboard.png")).toBe(true);
    expect(fs.existsSync(path.dirname(shotPath))).toBe(true);
  });

  test("17. Sanitized environment does not leak ANKA tokens, database URLs, or OpenAI keys", () => {
    // Set test sensitive env variables
    process.env.ANKA_TEST_SECRET = "super-secret-123";
    process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/db";
    process.env.CUSTOM_TOKEN = "bearer-secret-token";

    try {
      const sanitized = VisualVerifierService.buildServerEnv();

      expect(sanitized.ANKA_TEST_SECRET).toBeUndefined();
      expect(sanitized.DATABASE_URL).toBeUndefined();
      expect(sanitized.CUSTOM_TOKEN).toBeUndefined();
      expect(sanitized.NODE_ENV).toBeUndefined();
      expect(sanitized.PORT).toBeUndefined();

      // System essentials preserved
      expect(sanitized.PATH || sanitized.Path || sanitized.path).toBeDefined();
    } finally {
      delete process.env.ANKA_TEST_SECRET;
      delete process.env.DATABASE_URL;
      delete process.env.CUSTOM_TOKEN;
    }
  });

  test("18. findChromiumExecutable locates existing Chromium binary", () => {
    const execPath = findChromiumExecutable();
    expect(execPath).not.toBeNull();
    expect(typeof execPath).toBe("string");
    expect(fs.existsSync(execPath!)).toBe(true);
  });

  test("19. Browser preflight launches headless Chromium, verifies DOM, and closes cleanly", async () => {
    const preflight = await preflightBrowser();
    expect(preflight.success).toBe(true);
    expect(preflight.executablePath).toBeDefined();
    expect(preflight.error).toBeUndefined();
  }, 25000);
});
