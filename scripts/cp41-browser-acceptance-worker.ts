import path from "path";
import fs from "fs";
import http from "http";
import { spawn, spawnSync, ChildProcess } from "child_process";
import jwt from "jsonwebtoken";
import express from "express";
import cors from "cors";
import { chromium } from "playwright-core";
import { DocumentationLifecycleFixture, requirements, documentationContent, hashOf } from "../src/services/__tests__/planning-documentation-test-fixtures";
import { architectureDraft } from "../src/planning/__tests__/architecture-test-fixtures";
import { PlanningArchitectureArtifactService } from "../src/services/planning-architecture-artifact.service";
import { LLMGateway } from "../src/ai/gateway/LLMGateway";
import { PipelineStages } from "../src/ai/gateway/PipelineStage";
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

async function waitForPort(port: number, timeout = 30000): Promise<void> {
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
  console.log("[CP4.1 Worker] Initializing test data with real authority...");
  const fixture = new DocumentationLifecycleFixture();
  let backendServer: http.Server | null = null;
  let frontendProcess: ChildProcess | null = null;
  let browser: any = null;

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

    // Seed repository
    const repo = await fixture.prisma.projectRepository.create({
      data: {
        id: "repo-core-backend",
        projectId,
        name: "anka-core-backend",
        role: "backend",
        githubUrl: "https://github.com/example/repo",
      },
    });

    // Seed approved Requirements, Documentation, and Architecture
    const req = await fixture.approveRequirements(projectId, "cp41-pw");
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
    draft.components = [
      {
        id: "ARCH-COMP-DATA",
        name: "Data Layer",
        responsibility: "Prisma schema & multi-tenant models",
        boundary: "Database",
        dependencyIds: [],
        documentationFeatureIds: ["DOC-FEATURE"],
        designNotes: "PostgreSQL schemas",
      },
      {
        id: "ARCH-COMP-SECURITY",
        name: "Security Guard",
        responsibility: "RBAC & token guards",
        boundary: "Auth",
        dependencyIds: ["ARCH-COMP-DATA"],
        documentationFeatureIds: ["DOC-FEATURE"],
        designNotes: "Owner verification",
      },
    ];
    draft.dataDesign.items[0].componentId = "ARCH-COMP-DATA";
    draft.interfaceDesign.items[0].componentId = "ARCH-COMP-SECURITY";
    draft.implementationSequence = ["ARCH-COMP-DATA", "ARCH-COMP-SECURITY"];

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

    // Advance project to implementation phase
    await fixture.prisma.project.update({
      where: { id: projectId },
      data: { currentPhase: "implementation", phase: "implementation" },
    });
    await fixture.prisma.projectPhaseState.upsert({
      where: { projectId_phase: { projectId, phase: "implementation" } },
      create: { projectId, phase: "implementation", status: "not_started", stateVersion: 0 },
      update: { status: "not_started" },
    });

    console.log(`[CP4.1 Worker] Project ${projectId} initialized with approved Architecture.`);

    // Configure LLMGateway mock for implementation planning decomposition
    const gateway = LLMGateway.getInstance();
    const originalCallStructured = gateway.callStructured.bind(gateway);
    gateway.callStructured = async function (args: any) {
      if (args.stage === PipelineStages.IMPLEMENTATION_PLANNING) {
        return {
          content: {
            stages: [
              {
                title: "Stage 1: Core Foundation & Storage",
                order: 0,
                tasks: [
                  {
                    key: "TASK-DB-SCHEMA",
                    title: "Define Multi-Tenant Prisma Schema & Migration",
                    description: "Create isolation boundaries and relational constraints according to ARCH-COMP-DATA",
                    acceptanceCriteria: ["Prisma migrate deploy succeeds", "Foreign keys validated"],
                    targetFiles: ["prisma/schema.prisma"],
                    architectureComponentIds: ["ARCH-COMP-DATA"],
                    dependencyKeys: [],
                    repositoryId: repo.id,
                  },
                  {
                    key: "TASK-AUTH-GUARD",
                    title: "Implement Token Authority Guard & RBAC",
                    description: "Enforce ownership verification and tenant preflight guards",
                    acceptanceCriteria: ["Unit tests pass", "403 on non-owner"],
                    targetFiles: ["src/auth/guard.ts"],
                    architectureComponentIds: ["ARCH-COMP-SECURITY"],
                    dependencyKeys: ["TASK-DB-SCHEMA"],
                    repositoryId: repo.id,
                  },
                ],
              },
            ],
          },
        } as any;
      }
      return originalCallStructured(args);
    };

    // Ensure ports 3001 and 3000 are free before launching servers
    ensurePortFree(3001);
    ensurePortFree(3000);

    // Launch isolated Express test backend on port 3001
    const app = express();
    app.use(cors({ origin: true, credentials: true, allowedHeaders: ["Content-Type", "Authorization", "X-User-ID", "X-User-Name", "Idempotency-Key"] }));
    app.use(express.json());
    app.use("/api/projects", authenticateToken, projectRoutesModule);

    backendServer = http.createServer(app);
    await new Promise<void>((resolve) => backendServer!.listen(3001, "127.0.0.1", resolve));
    console.log("[CP4.1 Worker] Test backend listening on 127.0.0.1:3001");

    // Launch Next.js frontend production server on port 3000
    const frontendDir = path.resolve(__dirname, "../../anka-diversify-os");
    console.log(`[CP4.1 Worker] Launching Next.js frontend from ${frontendDir}...`);
    frontendProcess = spawn("npx", ["next", "start", "-p", "3000"], {
      cwd: frontendDir,
      shell: true,
      stdio: "pipe",
      env: { ...process.env, NEXT_PUBLIC_API_URL: "http://127.0.0.1:3001/api" },
    });

    await waitForPort(3000, 45000);
    console.log("[CP4.1 Worker] Next.js frontend ready on 127.0.0.1:3000");

    const execPath = chromiumExecutable();
    console.log(`[CP4.1 Worker] Using Chromium: ${execPath}`);

    const evidenceDir = process.env.BROWSER_EVIDENCE_DIR || path.resolve("C:/Users/PCC/.gemini/antigravity-ide/brain/fefaf1c1-d484-479a-8759-eeeab804d1b2/browser_evidence");
    fs.mkdirSync(evidenceDir, { recursive: true });

    browser = await chromium.launch({ executablePath: execPath, headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });

    const page = await context.newPage();
    page.on("console", (msg: any) => {
      if (msg.type() === "error") console.log(`[Browser Console Error] ${msg.text()}`);
    });

    // ── STEP 1: Open authenticated project on Workflow tab ───────────────────
    console.log("[CP4.1 Journey Step 1] Navigating to origin and setting authentication...");
    await page.goto("http://127.0.0.1:3000", { waitUntil: "domcontentloaded" });
    await page.evaluate(
      ({ authToken, currentUser }) => {
        localStorage.setItem("authToken", authToken);
        localStorage.setItem("user", JSON.stringify(currentUser));
      },
      { authToken: ownerToken, currentUser: ownerUser }
    );

    console.log("[CP4.1 Journey Step 1] Navigating to Workflow interface...");
    await page.goto(`http://127.0.0.1:3000/development/projects/${projectId}?tab=workflow`, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await page.waitForSelector("h1", { timeout: 15000 });
    const heading = await page.locator("h1").innerText();
    console.log(`[CP4.1 Journey Step 1] Loaded project: ${heading}`);

    // ── STEP 2: Navigate to Implementation phase on PhaseStepper ──────────────
    console.log("[CP4.1 Journey Step 2] Selecting Implementation phase...");
    // Find phase button for implementation
    const implStepperButton = page.locator("button").filter({ hasText: "Implementation" }).first();
    await implStepperButton.click();

    // Verify "Implementation planning" view is visible
    await page.getByText("Implementation planning").waitFor({ state: "visible", timeout: 15000 });
    const generateBtn = page.getByRole("button", { name: "Generate tasks" });
    await generateBtn.waitFor({ state: "visible", timeout: 10000 });
    await page.screenshot({ path: path.join(evidenceDir, "cp41_browser_1_implementation_phase.png"), fullPage: true });
    console.log("[CP4.1 Journey Step 2] Implementation view active with Generate tasks button.");

    // ── STEP 3 & 4: Click task-decomposition control & observe POST request ────
    console.log("[CP4.1 Journey Step 3 & 4] Clicking Generate tasks and observing request...");
    const [generateResponse] = await Promise.all([
      page.waitForResponse((res: any) => res.url().includes(`/api/projects/${projectId}/kanban/generate`) && res.request().method() === "POST"),
      generateBtn.click(),
    ]);

    if (generateResponse.status() !== 200) {
      throw new Error(`Expected generate request to return 200, got ${generateResponse.status()}`);
    }
    console.log(`[CP4.1 Journey Step 3 & 4] Generation request succeeded with HTTP ${generateResponse.status()}.`);

    // ── STEP 5: Verify generated task drafts appear in UI ─────────────────────
    console.log("[CP4.1 Journey Step 5] Verifying generated task drafts appear in UI...");
    await page.getByText("Define Multi-Tenant Prisma Schema & Migration", { exact: true }).waitFor({ state: "visible", timeout: 15000 });
    await page.getByText("Implement Token Authority Guard & RBAC", { exact: true }).waitFor({ state: "visible", timeout: 15000 });

    const draftBadges = page.locator("[data-slot='badge'], .badge, [class*='badge']").filter({ hasText: /^draft$/i });
    const draftCount = await draftBadges.count();
    console.log(`[CP4.1 Journey Step 5] Generated tasks verified with ${draftCount} draft badges.`);
    if (draftCount < 2) throw new Error(`Expected at least 2 draft badges, found ${draftCount}`);

    // ── STEP 6: Inspect Architecture component mapping & metadata ────────────
    console.log("[CP4.1 Journey Step 6] Inspecting Architecture component badges and target files...");
    await page.getByText("ARCH-COMP-DATA", { exact: true }).waitFor({ state: "visible", timeout: 10000 });
    await page.getByText("ARCH-COMP-SECURITY", { exact: true }).waitFor({ state: "visible", timeout: 10000 });
    await page.getByText("prisma/schema.prisma", { exact: true }).waitFor({ state: "visible", timeout: 10000 });
    await page.getByText("src/auth/guard.ts", { exact: true }).waitFor({ state: "visible", timeout: 10000 });
    await page.screenshot({ path: path.join(evidenceDir, "cp41_browser_2_tasks_generated.png"), fullPage: true });
    console.log("[CP4.1 Journey Step 6] Component mapping and target files verified.");

    // ── STEP 7: Approve eligible task as owner ────────────────────────────────
    console.log("[CP4.1 Journey Step 7] Approving task as owner...");
    const approveBtn = page.getByRole("button", { name: /Approve task v0/i }).first();
    await approveBtn.waitFor({ state: "visible", timeout: 10000 });

    const [approveResponse] = await Promise.all([
      page.waitForResponse((res: any) => res.url().includes("/approve") && res.request().method() === "POST"),
      approveBtn.click(),
    ]);

    if (approveResponse.status() !== 200) {
      throw new Error(`Expected approve request to return 200, got ${approveResponse.status()}`);
    }
    console.log(`[CP4.1 Journey Step 7] Task approval succeeded with HTTP ${approveResponse.status()}.`);

    // Verify task state transitioned to approved
    await page.locator("[data-slot='badge'], .badge, [class*='badge']").filter({ hasText: /^approved$/i }).first().waitFor({ state: "visible", timeout: 10000 });
    await page.getByRole("button", { name: "Start execution" }).waitFor({ state: "visible", timeout: 10000 });
    await page.screenshot({ path: path.join(evidenceDir, "cp41_browser_3_task_approved.png"), fullPage: true });
    console.log("[CP4.1 Journey Step 7] Task state updated to approved; Start execution button available.");

    // ── STEP 8 & 9: Refresh browser & verify persisted task state ─────────────
    console.log("[CP4.1 Journey Step 8 & 9] Refreshing browser and checking persisted state...");
    await page.reload({ waitUntil: "domcontentloaded" });
    const workflowTab = page.locator("button[role='tab']").filter({ hasText: "Workflow" });
    await workflowTab.click();
    const implStepperButtonAfterReload = page.locator("button").filter({ hasText: "Implementation" }).first();
    await implStepperButtonAfterReload.click();
    await page.getByText("Implementation planning").waitFor({ state: "visible", timeout: 15000 });

    // Verify both tasks and their distinct states are preserved from database
    await page.getByText("Define Multi-Tenant Prisma Schema & Migration", { exact: true }).waitFor({ state: "visible", timeout: 15000 });
    await page.locator("[data-slot='badge'], .badge, [class*='badge']").filter({ hasText: /^approved$/i }).first().waitFor({ state: "visible", timeout: 10000 });
    await page.locator("[data-slot='badge'], .badge, [class*='badge']").filter({ hasText: /^draft$/i }).first().waitFor({ state: "visible", timeout: 10000 });
    await page.screenshot({ path: path.join(evidenceDir, "cp41_browser_4_persisted_after_refresh.png"), fullPage: true });
    console.log("[CP4.1 Journey Step 8 & 9] Persisted state after reload verified: 1 approved, 1 draft.");

    // ── STEP 10: Verify unauthorized users cannot approve ─────────────────────
    console.log("[CP4.1 Journey Step 10] Testing unauthorized member approval rejection...");
    // Switch auth token in localStorage to member
    await page.evaluate(
      ({ mToken, mUser }) => {
        localStorage.setItem("authToken", mToken);
        localStorage.setItem("user", JSON.stringify(mUser));
      },
      { mToken: memberToken, mUser: memberUser }
    );

    await page.reload({ waitUntil: "domcontentloaded" });
    const userInStorage = await page.evaluate(() => localStorage.getItem("user"));
    console.log(`[CP4.1 Journey Step 10] Active user in browser localStorage: ${userInStorage}`);
    const workflowTabMember = page.locator("button[role='tab']").filter({ hasText: "Workflow" });
    await workflowTabMember.click();
    const implStepperButtonMember = page.locator("button").filter({ hasText: "Implementation" }).first();
    await implStepperButtonMember.click();
    await page.getByText("Implementation planning").waitFor({ state: "visible", timeout: 15000 });

    // Verify member UI shows disabled button with owner notice
    await page.getByText("Only the project owner can approve artifacts").first().waitFor({ state: "visible", timeout: 15000 });
    const disabledApproveBtn = page.getByRole("button", { name: "Approve task (Owner only)" });
    await disabledApproveBtn.waitFor({ state: "visible", timeout: 10000 });
    if (!(await disabledApproveBtn.isDisabled())) {
      throw new Error("Expected Approve task (Owner only) button to be disabled for member");
    }

    // Direct API attempt by member must return 403 Forbidden
    const memberTasks = await fixture.prisma.kanbanTask.findMany({
      where: { stage: { board: { projectId } } },
    });
    const draftTask = memberTasks.find((t) => t.implementationState === "draft");
    if (!draftTask) throw new Error("Could not find draft task for 403 test");

    const apiAttempt = await page.request.post(`http://127.0.0.1:3001/api/projects/${projectId}/kanban/tasks/${draftTask.id}/approve`, {
      headers: {
        Authorization: `Bearer ${memberToken}`,
        "Content-Type": "application/json",
      },
      data: { expectedStateVersion: draftTask.stateVersion },
    });
    console.log(`[CP4.1 Journey Step 10] Direct member approval attempt returned HTTP ${apiAttempt.status()}`);
    if (apiAttempt.status() !== 403) {
      throw new Error(`Expected HTTP 403 Forbidden for member approval attempt, received ${apiAttempt.status()}`);
    }

    await page.screenshot({ path: path.join(evidenceDir, "cp41_browser_5_unauthorized_member_blocked.png"), fullPage: true });
    console.log("[CP4.1 Journey Step 10] Unauthorized user approval blocked in both UI and API (HTTP 403).");

    console.log("[CP4.1 Playwright Acceptance] ALL 10 USER JOURNEY STEPS SUCCESSFULLY VERIFIED!");
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (frontendProcess) {
      try {
        if (process.platform === "win32") {
          spawnSync(`taskkill /pid ${frontendProcess.pid} /T /F`, { shell: true, stdio: "ignore" });
        } else {
          frontendProcess.kill();
        }
      } catch {}
    }
    if (backendServer) await new Promise<void>((resolve) => backendServer!.close(() => resolve())).catch(() => {});
    ensurePortFree(3000);
    ensurePortFree(3001);
    await fixture.stop();
  }
}

if (require.main === module) {
  runWorker().catch((err) => {
    console.error("[CP4.1 Worker Error]", err);
    process.exit(1);
  });
}
