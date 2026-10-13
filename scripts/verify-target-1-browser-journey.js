const path = require("path");
const fs = require("fs");
const http = require("http");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");
const jwt = require("jsonwebtoken");
const { validateSafeTestDatabase, assertSafeSchema } = require("./run-cp0-acceptance");

function chromiumExecutable() {
  const roots = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "ms-playwright"),
    process.env.USERPROFILE && path.join(process.env.USERPROFILE, ".cache", "ms-playwright"),
    process.env.USERPROFILE && path.join(process.env.USERPROFILE, "AppData", "Local", "ms-playwright"),
  ].filter(Boolean);
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const name of fs.readdirSync(root).sort().reverse()) {
      const candidates = [
        path.join(root, name, "chrome-headless-shell-win64", "chrome-headless-shell.exe"),
        path.join(root, name, "chrome-win64", "chrome.exe"),
      ];
      const found = candidates.find((c) => fs.existsSync(c));
      if (found) return found;
    }
  }
  throw new Error("Chromium executable was not found.");
}

async function waitForPort(port, timeout = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      await new Promise((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}/`, (res) => { res.resume(); resolve(); });
        req.on("error", reject);
        req.setTimeout(1000, () => req.destroy(new Error("timeout")));
      });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error(`Port ${port} did not become ready.`);
}

async function main() {
  const baseUrl = validateSafeTestDatabase(process.env.CP0_TEST_DATABASE_URL);
  assertSafeSchema("planning_checkpoint_target_1");
  const schemaName = `planning_checkpoint_target_1_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
  assertSafeSchema(schemaName);
  const isolatedUrl = new URL(baseUrl.href);
  isolatedUrl.searchParams.set("schema", schemaName);

  const { PrismaClient } = require("@prisma/client");
  const rootPrisma = new PrismaClient({ datasources: { db: { url: baseUrl.href } } });
  const prisma = new PrismaClient({ datasources: { db: { url: isolatedUrl.href } } });

  let backend;
  let frontend;
  let browser;

  const artifactDir = path.resolve(__dirname, "../scratch/browser_evidence");
  fs.mkdirSync(artifactDir, { recursive: true });

  try {
    console.log(`[Target 1 & 4 Browser] Deploying migrations to isolated schema: ${schemaName}`);
    const migration = spawnSync("npx prisma migrate deploy", {
      shell: true,
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: isolatedUrl.href }
    });
    if (migration.status !== 0) throw new Error(migration.stderr || migration.stdout || "Migration failed");

    process.env.DATABASE_URL = isolatedUrl.href;

    // Seed Owner and Project
    const user = await prisma.user.create({
      data: { id: "cp2-journey-owner", email: "journey-owner@anka.test", name: "Journey Owner", password: "unused" }
    });
    const project = await prisma.project.create({
      data: { id: "cp2-journey-project", name: "Journey Verification Project", description: "Verification Project Description", userId: user.id }
    });
    const token = jwt.sign({ userId: user.id, email: user.email }, process.env.JWT_SECRET || "default_test_secret", { expiresIn: "1h" });

    // Mock LLMGateway for deterministic responses
    const { LLMGateway } = require("../dist/ai/gateway/LLMGateway");
    const gateway = LLMGateway.getInstance();

    gateway.callStructured = async (callConfig) => {
      console.log(`[Gateway Mock] stage=${callConfig.stage}, name=${callConfig.schema?.name}`);
      if (callConfig.schema?.name === "anka_project_intake") {
        return {
          content: {
            message: "I have analyzed your project idea and proposed four core claims covering goals, users, workflow, and acceptance criteria.",
            proposedClaims: [
              {
                claimKey: "claim-goal",
                category: "GOAL",
                title: "Core Verification Goal",
                content: "Automated continuous verification of multi-phase system architecture.",
                sourceSpanIds: [],
                confidence: 0.95
              },
              {
                claimKey: "claim-user",
                category: "USER_PERSONA",
                title: "Primary User Persona",
                content: "Independent senior full-stack verification engineers.",
                sourceSpanIds: [],
                confidence: 0.95
              },
              {
                claimKey: "claim-workflow",
                category: "WORKFLOW",
                title: "Verification Pipeline Workflow",
                content: "Structured intake leading to owner confirmation and deterministic requirements generation.",
                sourceSpanIds: [],
                confidence: 0.95
              },
              {
                claimKey: "claim-ac",
                category: "ACCEPTANCE_CRITERION",
                title: "Readiness Gate Acceptance Criterion",
                content: "Readiness must require explicit human acceptance of all required claim categories.",
                sourceSpanIds: [],
                confidence: 0.95
              }
            ],
            questions: [],
            contradictions: []
          },
          raw: "{}",
          finishReason: "stop",
          usage: { promptTokens: 50, completionTokens: 100, totalTokens: 150 },
          cached: false
        };
      }

      if (callConfig.schema?.name === "anka_initial_requirements") {
        return {
          content: {
            projectGoal: "Automated continuous verification of multi-phase system architecture.",
            problemStatement: "Verifying multi-phase systems without human gate authority leads to silent regressions.",
            usersAndActors: [{ id: "A-1", name: "Verification Engineer", description: "Senior engineer performing independent audits." }],
            userStories: [{ id: "U-1", actor: "Verification Engineer", capability: "Verify intake and handoff", benefit: "Ensure deterministic gates", acceptanceCriteriaIds: ["AC-1"] }],
            functionalRequirements: [{ id: "F-1", title: "Intake and Handoff Pipeline", description: "Enforce confirmed brief lineage before requirements generation." }],
            nonFunctionalRequirements: [{ id: "NF-1", title: "Readiness Determinism", description: "Derive readiness strictly from persisted records." }],
            constraints: [],
            integrations: [],
            assumptions: [],
            acceptanceCriteria: [{ id: "AC-1", description: "Zero bypass of owner confirmation", relatedRequirementIds: ["F-1"] }],
            outOfScope: [],
            unresolvedQuestions: []
          },
          raw: "{}",
          finishReason: "stop",
          usage: { promptTokens: 50, completionTokens: 100, totalTokens: 150 },
          cached: false,
          model: "gpt-4o-mini",
          latencyMs: 150,
          providerAttempts: [
            {
              attemptNumber: 1,
              kind: "initial",
              providerResponseId: "resp-1",
              providerRequestId: "req-1",
              model: "gpt-4o-mini",
              finishReason: "stop",
              promptTokens: 50,
              completionTokens: 100,
              totalTokens: 150,
              usageSource: "provider",
              latencyMs: 150,
            }
          ],
          rawResponse: {
            id: "resp-1",
            model: "gpt-4o-mini",
            usage: { prompt_tokens: 50, completion_tokens: 100, total_tokens: 150 }
          }
        };
      }

      throw new Error(`Unhandled mock schema: ${callConfig.schema?.name}`);
    };

    // Express server
    const express = require("express");
    const cors = require("cors");
    const app = express();
    app.use(cors({ origin: true, credentials: true, allowedHeaders: ["Content-Type", "Authorization", "X-User-ID", "X-User-Name", "Idempotency-Key"] }));
    app.use(express.json());
    const auth = require("../dist/middleware/auth");
    const projectRoutesModule = require("../dist/routes/project-routes");
    app.use("/api/projects", auth.authenticateToken, projectRoutesModule.default || projectRoutesModule);

    backend = http.createServer(app);
    await new Promise((resolve) => backend.listen(3001, "127.0.0.1", resolve));
    console.log("[Target 1 & 4 Browser] Backend listening on 127.0.0.1:3001");

    // Start Next.js frontend
    const frontendDir = path.resolve(__dirname, "../../anka-diversify-os");
    frontend = spawn("npx", ["next", "start", "-p", "3000"], { cwd: frontendDir, shell: true, stdio: "pipe" });
    await waitForPort(3000);
    console.log("[Target 1 & 4 Browser] Frontend listening on 127.0.0.1:3000");

    // Launch Playwright
    const { chromium } = require("playwright-core");
    browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true });
    const context = await browser.newContext();
    await context.addInitScript(({ authToken, currentUser }) => {
      localStorage.setItem("authToken", authToken);
      localStorage.setItem("user", JSON.stringify(currentUser));
    }, { authToken: token, currentUser: { id: user.id, email: user.email, name: user.name } });

    const page = await context.newPage();
    page.on("console", (msg) => console.log(`[Browser Console ${msg.type()}] ${msg.text()}`));
    page.on("requestfailed", (req) => console.log(`[Browser Req Failed] ${req.url()}: ${req.failure()?.errorText}`));
    page.on("response", (res) => {
      if (res.status() >= 400) console.log(`[Browser HTTP Error ${res.status()}] ${res.url()}`);
    });

    // Step 1: Open project
    console.log("[Target 1 Step 1] Navigating to project workspace...");
    await page.goto(`http://127.0.0.1:3000/development/projects/${project.id}`, { waitUntil: "domcontentloaded" });
    await page.getByText("Editable Live Brief").waitFor({ state: "visible", timeout: 15000 });
    const shot1 = path.join(artifactDir, "target1_1_project_opened.png");
    await page.screenshot({ path: shot1, fullPage: true });

    // Step 2: Idea entry & AI conversation
    console.log("[Target 1 Step 2] Entering project idea in intake message textarea...");
    const textarea = page.getByPlaceholder("Describe your goal, users, workflows, or source conflicts…");
    await textarea.fill("We are building an automated platform for continuous verification of multi-phase architecture.");
    const sendButton = page.getByLabel("Send intake message");
    await sendButton.click();

    // Step 3: Observe AI response & claim proposals
    console.log("[Target 1 Step 3] Waiting for AI response and claim proposals...");
    await page.getByText(/I have analyzed your project idea/).waitFor({ state: "visible", timeout: 15000 });
    await page.getByText("Core Verification Goal").waitFor({ state: "visible", timeout: 15000 });
    await page.getByText("Primary User Persona").waitFor({ state: "visible", timeout: 15000 });
    await page.getByText("Verification Pipeline Workflow").waitFor({ state: "visible", timeout: 15000 });
    await page.getByText("Readiness Gate Acceptance Criterion").waitFor({ state: "visible", timeout: 15000 });

    const shot2 = path.join(artifactDir, "target1_2_ai_proposals_received.png");
    await page.screenshot({ path: shot2, fullPage: true });

    // Step 4: Verify Readiness is BLOCKED before acceptance
    console.log("[Target 1 Step 4] Checking that Readiness is initially Blocked...");
    const readinessBadge = page.locator("section:has-text('Readiness')").getByText("Blocked").first();
    await readinessBadge.waitFor({ state: "visible", timeout: 5000 });

    // Step 5: Human acceptance of all 4 proposed claims
    console.log("[Target 1 Step 5] Accepting all 4 proposed claims...");
    for (let i = 0; i < 4; i++) {
      const acceptBtn = page.getByRole("button", { name: "Accept" }).first();
      await acceptBtn.waitFor({ state: "visible", timeout: 10000 });
      await acceptBtn.click();
      await page.waitForTimeout(1000); // Wait for optimistic update & reload
    }

    // Step 6: Verify Readiness transitions to READY
    console.log("[Target 1 Step 6] Verifying Readiness transitioned to Ready...");
    await page.getByText("All deterministic confirmation gates are satisfied.").waitFor({ state: "visible", timeout: 15000 });
    const readyBadge = page.locator("section:has-text('Readiness')").getByText("Ready").first();
    await readyBadge.waitFor({ state: "visible", timeout: 5000 });

    const shot3 = path.join(artifactDir, "target1_3_readiness_satisfied.png");
    await page.screenshot({ path: shot3, fullPage: true });

    // Step 7: Owner confirmation
    console.log("[Target 1 Step 7] Confirming exact revision as owner...");
    const confirmButton = page.getByRole("button", { name: "Confirm exact revision" });
    await confirmButton.waitFor({ state: "visible", timeout: 5000 });
    await confirmButton.click();

    await page.getByText(/is owner-confirmed with exact hash/).waitFor({ state: "visible", timeout: 15000 });
    const shot4 = path.join(artifactDir, "target1_4_owner_confirmed.png");
    await page.screenshot({ path: shot4, fullPage: true });

    // Step 8: Generate Requirements from confirmed brief
    console.log("[Target 1 Step 8] Clicking 'Generate Requirements from confirmed brief'...");
    const genReqBtn = page.getByRole("button", { name: "Generate Requirements from confirmed brief" });
    await genReqBtn.waitFor({ state: "visible", timeout: 5000 });
    await genReqBtn.click();

    console.log("[Target 1 Step 8] Waiting for Requirements generation workflow run to complete...");
    await page.getByText(/Workflow run/).waitFor({ state: "visible", timeout: 20000 });
    await page.getByText("completed").waitFor({ state: "visible", timeout: 20000 });
    const shot5 = path.join(artifactDir, "target1_5_requirements_generated.png");
    await page.screenshot({ path: shot5, fullPage: true });

    // TARGET 4 TEST: Refresh during / after execution
    console.log("[Target 4] Testing persistence and recovery by reloading page...");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByText("Editable Live Brief").waitFor({ state: "visible", timeout: 15000 });

    // Check what is restored:
    const briefRestored = await page.getByText(/is owner-confirmed with exact hash/).isVisible();
    const chatRestored = await page.getByText(/I have analyzed your project idea/).isVisible();
    const runRestored = await page.getByText(/Workflow run/).isVisible();

    console.log(`[Target 4 Findings on reload]:`);
    console.log(`- Brief confirmed status restored: ${briefRestored}`);
    console.log(`- Intake chat messages restored: ${chatRestored}`);
    console.log(`- Workflow run indicator in ProjectBrief restored: ${runRestored}`);

    const shot6 = path.join(artifactDir, "target4_refresh_recovery.png");
    await page.screenshot({ path: shot6, fullPage: true });

    // Step 9: Artifact Review on Workflow Tab
    console.log("[Target 1 Step 9] Navigating to Workflow tab for artifact review...");
    await page.getByRole("tab", { name: "Workflow" }).click();
    await page.waitForURL((url) => url.searchParams.get("tab") === "workflow", { timeout: 10000 });

    // Wait for PhaseDetailView to load Requirements artifact
    await page.getByText(/Requirements v1/).first().waitFor({ state: "visible", timeout: 15000 });
    await page.getByText(/Version 1 · DRAFT/).waitFor({ state: "visible", timeout: 15000 });
    await page.getByText("Automated continuous verification of multi-phase system architecture.").first().waitFor({ state: "visible", timeout: 15000 });

    // Verify Review & Approval card is visible
    await page.getByText("Review and approval").waitFor({ state: "visible", timeout: 10000 });
    await page.getByRole("button", { name: "Submit for approval" }).waitFor({ state: "visible", timeout: 10000 });

    const shot7 = path.join(artifactDir, "target1_6_artifact_review_workflow.png");
    await page.screenshot({ path: shot7, fullPage: true });

    console.log("\n=================== TARGET 1 & 4 FULL BROWSER PASS ===================");
    console.log("Full browser intake journey passed from project open to artifact review!");
    console.log(`Artifact screenshots saved to: ${artifactDir}`);
    console.log("======================================================================\n");

  } finally {
    if (browser) await browser.close();
    if (frontend) frontend.kill();
    if (backend) await new Promise((resolve) => backend.close(resolve));
    await prisma.$disconnect().catch(() => undefined);
    await rootPrisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await rootPrisma.$disconnect();
    console.log(`[Target 1 & 4 Browser] Dropped isolated schema: ${schemaName}`);
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
