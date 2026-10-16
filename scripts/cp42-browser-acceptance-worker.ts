import path from "path";
import fs from "fs";
import http from "http";
import os from "os";
import crypto from "crypto";
import { spawn, spawnSync, ChildProcess } from "child_process";
import jwt from "jsonwebtoken";
import express from "express";
import cors from "cors";
import { chromium } from "playwright-core";
import { DocumentationLifecycleFixture, documentationContent, hashOf } from "../src/services/__tests__/planning-documentation-test-fixtures";
import { architectureDraft } from "../src/planning/__tests__/architecture-test-fixtures";
import { PlanningArchitectureArtifactService } from "../src/services/planning-architecture-artifact.service";
import { authenticateToken } from "../src/middleware/auth";
import projectRoutesModule from "../src/routes/project-routes";

function ensurePortFree(port: number): void {
  try {
    const output = spawnSync(
      `powershell -Command "Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess"`,
      { shell: true, encoding: "utf8" }
    );
    const pid = output.stdout?.trim();
    if (pid && !isNaN(Number(pid))) {
      console.log(`[Port Cleanup] Freeing port ${port} by terminating PID ${pid}...`);
      spawnSync(`taskkill /pid ${pid} /T /F`, { shell: true, stdio: "ignore" });
    }
  } catch {}
}

function chromiumExecutable(): string {
  const roots = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "ms-playwright"),
    process.env.USERPROFILE && path.join(process.env.USERPROFILE, ".cache", "ms-playwright"),
    process.env.USERPROFILE && path.join(process.env.USERPROFILE, "AppData", "Local", "ms-playwright"),
  ].filter(Boolean) as string[];

  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const name of fs.readdirSync(root).sort().reverse()) {
      const chromePath = path.join(root, name, "chrome-win64", "chrome.exe");
      if (fs.existsSync(chromePath)) return chromePath;
    }
    for (const name of fs.readdirSync(root).sort().reverse()) {
      const shellPath = path.join(root, name, "chrome-headless-shell-win64", "chrome-headless-shell.exe");
      if (fs.existsSync(shellPath)) return shellPath;
    }
  }
  throw new Error("Chromium executable was not found.");
}

async function waitForPort(port: number, timeout = 45000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      await new Promise<void>((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}/`, (res) => {
          res.resume();
          resolve();
        });
        req.on("error", reject);
        req.setTimeout(1000, () => req.destroy(new Error("timeout")));
      });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`Port ${port} did not become ready within ${timeout}ms.`);
}

export async function runWorker(): Promise<void> {
  console.log("[CP4.2 Browser Acceptance] Initializing test fixture with real authority...");
  const fixture = new DocumentationLifecycleFixture();
  let backendServer: http.Server | null = null;
  let frontendProcess: ChildProcess | null = null;
  let browser: any = null;
  let tempRepoDir = "";

  try {
    await fixture.start();
    const projectId = await fixture.createProject(true);
    const ownerId = fixture.ownerId;
    const memberId = fixture.memberId;

    const ownerUser = {
      id: ownerId,
      email: `${ownerId}@anka.test`,
      name: "Project Owner",
      role: "owner",
    };
    const memberUser = {
      id: memberId,
      email: `${memberId}@anka.test`,
      name: "Team Member",
      role: "member",
    };

    const jwtSecret = process.env.JWT_SECRET || "your_jwt_secret_here";
    const ownerToken = jwt.sign({ userId: ownerId, email: ownerUser.email }, jwtSecret, { expiresIn: "1h" });
    const memberToken = jwt.sign({ userId: memberId, email: memberUser.email }, jwtSecret, { expiresIn: "1h" });

    // Seed approved Requirements, Documentation, and Architecture
    const req = await fixture.approveRequirements(projectId, "cp42-browser");
    const doc = await fixture.documentationArtifacts.createInitialArtifact({
      projectId,
      actorId: ownerId,
      title: "Documentation",
      structuredContent: documentationContent(req.artifact, req.content),
    });
    await fixture.approvals.requestDocumentationApproval({
      projectId,
      artifactId: doc.id,
      expectedHash: hashOf(doc),
      actorId: ownerId,
    });
    await fixture.approvals.approveDocumentationArtifact({
      projectId,
      artifactId: doc.id,
      expectedHash: hashOf(doc),
      actorId: ownerId,
    });

    const draft = architectureDraft(req.content.nonFunctionalRequirements[0].id);
    draft.overview.technicalDirection = "TypeScript Node.js microservice architecture with Express";

    const arch = await new PlanningArchitectureArtifactService(fixture.prisma).create({
      projectId,
      actorId: ownerId,
      title: "Architecture",
      structuredContent: draft,
    });
    await fixture.approvals.requestArchitectureApproval({
      projectId,
      artifactId: arch.id,
      expectedHash: hashOf(arch),
      actorId: ownerId,
    });
    await fixture.approvals.approveArchitectureArtifact({
      projectId,
      artifactId: arch.id,
      expectedHash: hashOf(arch),
      actorId: ownerId,
    });

    // Advance project phase to implementation
    await fixture.prisma.project.update({
      where: { id: projectId },
      data: { currentPhase: "implementation", phase: "implementation" },
    });

    console.log(`[CP4.2 Browser Acceptance] Project ${projectId} initialized with approved Architecture.`);

    // Prepare clean workspace boundary target directory
    tempRepoDir = path.resolve(os.tmpdir(), `anka-browser-repo-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`);

    // Free ports 3001 and 3000
    ensurePortFree(3001);
    ensurePortFree(3000);

    // Launch Express backend on 3001
    const app = express();
    app.use(cors({ origin: true, credentials: true, allowedHeaders: ["Content-Type", "Authorization", "X-User-ID", "X-User-Name", "Idempotency-Key"] }));
    app.use(express.json());
    app.use((req, res, next) => {
      console.log(`[Test Backend Req] ${req.method} ${req.originalUrl}`);
      next();
    });
    app.use("/api/projects", authenticateToken, projectRoutesModule);

    backendServer = http.createServer(app);
    await new Promise<void>((resolve) => backendServer!.listen(3001, "127.0.0.1", resolve));
    console.log("[CP4.2 Browser Acceptance] Test backend listening on 127.0.0.1:3001");

    // Launch Next.js frontend on 3000
    const frontendDir = path.resolve(__dirname, "../../anka-diversify-os");
    console.log(`[CP4.2 Browser Acceptance] Launching Next.js frontend from ${frontendDir}...`);
    frontendProcess = spawn("npx", ["next", "start", "-p", "3000"], {
      cwd: frontendDir,
      shell: true,
      stdio: "pipe",
      env: { ...process.env, NEXT_PUBLIC_API_URL: "http://127.0.0.1:3001/api" },
    });

    await waitForPort(3000, 45000);
    console.log("[CP4.2 Browser Acceptance] Next.js frontend ready on 127.0.0.1:3000");

    const execPath = chromiumExecutable();
    console.log(`[CP4.2 Browser Acceptance] Using Chromium: ${execPath}`);

    const evidenceDir = process.env.BROWSER_EVIDENCE_DIR || path.resolve("C:/Users/PCC/.gemini/antigravity-ide/brain/ec3533a4-76d6-4451-90ae-b62b7b3fb2d4/browser_evidence");
    fs.mkdirSync(evidenceDir, { recursive: true });

    browser = await chromium.launch({ executablePath: execPath, headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();

    page.on("console", (msg: any) => {
      if (msg.type() === "error") console.log(`[Browser Console Error] ${msg.text()}`);
    });
    page.on("request", (req: any) => {
      if (req.url().includes("/api/")) console.log(`[Browser API Req] ${req.method()} ${req.url()}`);
    });
    page.on("response", (res: any) => {
      if (res.url().includes("/api/")) console.log(`[Browser API Res] ${res.status()} ${res.url()}`);
    });

    // ── STEP 1: Owner authentication & navigation to Repositories tab ──────────
    console.log("[CP4.2 Journey Step 1] Setting owner authentication and opening project...");
    await page.goto("http://127.0.0.1:3000", { waitUntil: "domcontentloaded" });
    await page.evaluate(
      ({ authToken, currentUser }) => {
        localStorage.setItem("authToken", authToken);
        localStorage.setItem("user", JSON.stringify(currentUser));
      },
      { authToken: ownerToken, currentUser: ownerUser }
    );

    console.log("[CP4.2 Journey Step 1] Navigating to Repositories tab...");
    await page.goto(`http://127.0.0.1:3000/development/projects/${projectId}?tab=repositories`, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await page.waitForSelector("h1", { timeout: 15000 });

    // Explicitly click Repositories tab to ensure tab content is active
    const repoTab = page.locator("button[role='tab']").filter({ hasText: "Repositories" });
    await repoTab.waitFor({ state: "visible", timeout: 15000 });
    await repoTab.click();

    // ── STEP 2: Verify Initial Empty State ────────────────────────────────────
    console.log("[CP4.2 Journey Step 2] Verifying initial empty repository state...");
    await page.getByText("No Git Repository Bound").waitFor({ state: "visible", timeout: 15000 });
    const initBtn = page.locator("#btn-init-new-repo");
    await initBtn.waitFor({ state: "visible", timeout: 10000 });
    if (!(await initBtn.isEnabled())) throw new Error("Expected initBtn to be enabled");
    await page.screenshot({ path: path.join(evidenceDir, "cp42_browser_1_repositories_empty.png"), fullPage: true });
    console.log("[CP4.2 Journey Step 2] Empty repository view verified with active Initialize New Repository button.");

    // ── STEP 3: Open Initialize New Repository Modal & Review Plan ───────────
    console.log("[CP4.2 Journey Step 3] Opening bootstrap modal and awaiting plan generation...");
    const [planResponse] = await Promise.all([
      page.waitForResponse((res: any) => res.url().includes("/repositories/bootstrap-plan") && res.request().method() === "POST"),
      initBtn.click(),
    ]);

    if (planResponse.status() !== 200) {
      throw new Error(`Expected plan request to return 200, got ${planResponse.status()}`);
    }
    console.log(`[CP4.2 Journey Step 3] Plan API returned HTTP 200.`);

    // Verify modal elements
    await page.getByRole("heading", { name: "Initialize New Repository" }).waitFor({ state: "visible", timeout: 10000 });
    await page.getByText("typescript-node").waitFor({ state: "visible", timeout: 10000 });
    await page.getByText("Planned Foundational Files").waitFor({ state: "visible", timeout: 10000 });

    // Set custom target directory in the input
    const inputRoot = page.locator("#input-bootstrap-root");
    await inputRoot.waitFor({ state: "visible", timeout: 5000 });
    await inputRoot.fill(tempRepoDir);

    await page.screenshot({ path: path.join(evidenceDir, "cp42_browser_2_bootstrap_plan_review.png"), fullPage: true });
    console.log("[CP4.2 Journey Step 3] Bootstrap plan reviewed: typescript-node template, TypeScript language, foundational files.");

    // ── STEP 4: Explicit Owner Confirmation & Execution ───────────────────────
    console.log("[CP4.2 Journey Step 4] Checking owner authorization and confirming initialization...");
    const confirmCheckbox = page.locator("#checkbox-confirm-bootstrap");
    await confirmCheckbox.check();

    const executeBtn = page.locator("#btn-confirm-bootstrap");
    await executeBtn.waitFor({ state: "visible", timeout: 5000 });
    if (!(await executeBtn.isEnabled())) throw new Error("Expected executeBtn to be enabled");

    const [bootstrapResponse] = await Promise.all([
      page.waitForResponse((res: any) => res.url().includes("/repositories/bootstrap-init") && res.request().method() === "POST"),
      executeBtn.click(),
    ]);

    if (![200, 201].includes(bootstrapResponse.status())) {
      throw new Error(`Expected bootstrap request to return 200 or 201, got ${bootstrapResponse.status()}`);
    }
    const bootstrapJson = await bootstrapResponse.json();
    const bootstrapData = bootstrapJson.data || bootstrapJson;
    console.log(`[CP4.2 Journey Step 4] Bootstrap completed with baseline SHA: ${bootstrapData.baselineCommitSha}`);

    // Verify success banner in modal
    await page.locator("#bootstrap-success-banner").waitFor({ state: "visible", timeout: 10000 });
    await page.getByText("Repository Initialized & Bound!").waitFor({ state: "visible", timeout: 10000 });
    await page.screenshot({ path: path.join(evidenceDir, "cp42_browser_3_bootstrap_success_modal.png"), fullPage: true });

    // ── STEP 5: Close Modal & Verify Repository Card in UI ───────────────────
    console.log("[CP4.2 Journey Step 5] Closing modal and verifying bound repository card...");
    const doneBtn = page.getByRole("button", { name: "Done", exact: true });
    await doneBtn.click();

    // Verify primary repository card
    await page.locator('[data-testid="primary-repo-card"]').waitFor({ state: "visible", timeout: 10000 });
    const baselineBadge = page.locator('[data-testid="repo-baseline-commit"]');
    await baselineBadge.waitFor({ state: "visible", timeout: 10000 });
    const renderedSha = await baselineBadge.innerText();
    console.log(`[CP4.2 Journey Step 5] Bound repository baseline commit visible: ${renderedSha}`);
    if (renderedSha.length < 7) throw new Error("Expected renderedSha length to be at least 7");

    // Verify worktree readiness
    await page.getByText("Isolated Ready").waitFor({ state: "visible", timeout: 10000 });
    await page.screenshot({ path: path.join(evidenceDir, "cp42_browser_4_repository_card_bound.png"), fullPage: true });

    // ── STEP 6: Refresh Browser & Verify Persisted Binding ───────────────────
    console.log("[CP4.2 Journey Step 6] Refreshing browser to verify durable persistence...");
    await page.reload({ waitUntil: "domcontentloaded" });

    // Ensure on Repositories tab
    await page.waitForSelector("h1", { timeout: 15000 });
    const reloadRepoTab = page.locator("button[role='tab']").filter({ hasText: "Repositories" });
    if (await reloadRepoTab.isVisible()) {
      await reloadRepoTab.click();
    }

    await page.locator('[data-testid="primary-repo-card"]').waitFor({ state: "visible", timeout: 10000 });
    const persistedBaseline = page.locator('[data-testid="repo-baseline-commit"]');
    await persistedBaseline.waitFor({ state: "visible", timeout: 10000 });
    const persistedSha = await persistedBaseline.innerText();
    if (persistedSha !== renderedSha) throw new Error(`Expected persistedSha ${persistedSha} to equal ${renderedSha}`);
    console.log(`[CP4.2 Journey Step 6] Persisted baseline commit verified after reload: ${persistedSha}`);
    await page.screenshot({ path: path.join(evidenceDir, "cp42_browser_5_persisted_after_refresh.png"), fullPage: true });

    // ── STEP 7: Verify Non-Owner Member View (Read-Only Enforcement) ─────────
    console.log("[CP4.2 Journey Step 7] Switching to non-owner member and testing authorization boundary...");
    await page.evaluate(
      ({ mToken, mUser }) => {
        localStorage.setItem("authToken", mToken);
        localStorage.setItem("user", JSON.stringify(mUser));
      },
      { mToken: memberToken, mUser: memberUser }
    );

    await page.reload({ waitUntil: "domcontentloaded" });
    const memberRepoTab = page.locator("button[role='tab']").filter({ hasText: "Repositories" });
    if (await memberRepoTab.isVisible()) {
      await memberRepoTab.click();
    }

    // Verify non-owner warning banner is visible
    await page.locator('[data-testid="owner-warning-banner"]').waitFor({ state: "visible", timeout: 10000 });
    await page.getByText("Only the project owner can initialize, bind, or modify repository settings.").waitFor({ state: "visible", timeout: 10000 });

    // Verify mutation buttons are disabled
    const memberInitBtn = page.locator("#btn-init-new-repo");
    const memberConnectBtn = page.locator("#btn-connect-existing");
    if (!(await memberInitBtn.isDisabled())) throw new Error("Expected memberInitBtn to be disabled");
    if (!(await memberConnectBtn.isDisabled())) throw new Error("Expected memberConnectBtn to be disabled");

    await page.screenshot({ path: path.join(evidenceDir, "cp42_browser_6_non_owner_read_only.png"), fullPage: true });
    console.log("[CP4.2 Journey Step 7] Non-owner read-only enforcement verified in browser.");

    console.log("[CP4.2 Browser Acceptance] All 7 browser journey steps PASSED successfully!");
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
    if (frontendProcess) {
      frontendProcess.kill();
    }
    if (backendServer) {
      backendServer.close();
    }
    ensurePortFree(3001);
    ensurePortFree(3000);
    await fixture.stop().catch(() => {});

    // Clean up temporary repo directory
    if (tempRepoDir && fs.existsSync(tempRepoDir)) {
      try {
        await fs.promises.rm(tempRepoDir, { recursive: true, force: true });
      } catch {}
    }
  }
}

if (require.main === module) {
  runWorker().catch((err) => {
    console.error("[CP4.2 Browser Worker Failure]", err);
    process.exit(1);
  });
}
