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
  assertSafeSchema("planning_checkpoint_target_2");
  const schemaName = `planning_checkpoint_target_2_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
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
    console.log(`[Target 2 Doc Browser] Deploying migrations to isolated schema: ${schemaName}`);
    const migration = spawnSync("npx prisma migrate deploy", {
      shell: true,
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: isolatedUrl.href }
    });
    if (migration.status !== 0) throw new Error(migration.stderr || migration.stdout || "Migration failed");

    process.env.DATABASE_URL = isolatedUrl.href;

    // Seed Owner and Project
    const user = await prisma.user.create({
      data: { id: "cp2-doc-owner", email: "doc-owner@anka.test", name: "Doc Owner", password: "unused" }
    });
    const project = await prisma.project.create({
      data: { id: "cp2-doc-project", name: "Document Journey Project", description: "Project with document evidence", userId: user.id }
    });
    const token = jwt.sign({ userId: user.id, email: user.email }, process.env.JWT_SECRET || "default_test_secret", { expiresIn: "1h" });

    // Seed ProjectFile, DocumentSource, and EvidenceSpan directly to represent READY extracted document
    const file = await prisma.projectFile.create({
      data: {
        id: "file-spec-pdf",
        projectId: project.id,
        name: "architecture_specification.pdf",
        type: "pdf",
        phase: "planning",
        size: "15 KB",
        url: "https://anka-test.s3.amazonaws.com/spec.pdf",
      }
    });

    const docSource = await prisma.documentSource.create({
      data: {
        id: "doc-spec-source",
        projectId: project.id,
        projectFileId: file.id,
        sourceVersion: 1,
        originalFilename: file.name,
        mimeType: "application/pdf",
        s3Key: "projects/spec.pdf",
        byteSize: 15360,
        contentHash: crypto.createHash("sha256").update("Specification text").digest("hex"),
      }
    });

    const extractionRun = await prisma.documentExtractionRun.create({
      data: {
        id: "run-spec-ext-1",
        projectId: project.id,
        sourceId: docSource.id,
        attempt: 1,
        status: "READY",
        parser: "pdf-parse",
      }
    });

    const spanText = "The system must export data in CSV and JSON formats with low latency.";
    const spanHash = crypto.createHash("sha256").update(spanText).digest("hex");
    const span = await prisma.evidenceSpan.create({
      data: {
        id: "span-spec-1",
        projectId: project.id,
        sourceId: docSource.id,
        extractionRunId: extractionRun.id,
        ordinal: 1,
        locatorType: "PDF_PAGE",
        pageNumber: 1,
        text: spanText,
        textHash: spanHash,
      }
    });

    console.log(`[Target 2 Seed] Created DocumentSource: ${docSource.id} (READY), EvidenceSpan: ${span.id}`);

    // Mock LLMGateway for deterministic source-grounded intake
    const { LLMGateway } = require("../dist/ai/gateway/LLMGateway");
    const gateway = LLMGateway.getInstance();

    gateway.callStructured = async (callConfig) => {
      console.log(`[Gateway Mock Doc] stage=${callConfig.stage}, name=${callConfig.schema?.name}`);
      if (callConfig.schema?.name === "anka_project_intake") {
        return {
          content: {
            message: "I verified your uploaded specification document and extracted 4 structured claims and 1 contradiction.",
            proposedClaims: [
              {
                claimKey: "claim-goal",
                category: "GOAL",
                title: "Data Export Capability",
                content: "Export verified data in CSV and JSON formats.",
                sourceSpanIds: [span.id], // Grounded in document span
                confidence: 0.98
              },
              {
                claimKey: "claim-user",
                category: "USER_PERSONA",
                title: "Data Analyst",
                content: "Analyst consuming exported CSV/JSON reports.",
                sourceSpanIds: [],
                confidence: 0.92
              },
              {
                claimKey: "claim-workflow",
                category: "WORKFLOW",
                title: "Export Generation Workflow",
                content: "Select project data, choose format, and trigger export job.",
                sourceSpanIds: [],
                confidence: 0.95
              },
              {
                claimKey: "claim-ac",
                category: "ACCEPTANCE_CRITERION",
                title: "Export Latency Threshold",
                content: "Low latency export completed under 2 seconds.",
                sourceSpanIds: [span.id], // Grounded in document span
                confidence: 0.95
              }
            ],
            questions: [],
            contradictions: [
              {
                claimKeyA: "claim-goal",
                claimKeyB: "claim-ac",
                description: "Latency requirement may conflict with very large dataset export."
              }
            ]
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
            projectGoal: "Export verified data in CSV and JSON formats.",
            problemStatement: "Users require low latency verified exports.",
            usersAndActors: [{ id: "A-1", name: "Data Analyst", description: "Analyst consuming exported reports." }],
            userStories: [{ id: "U-1", actor: "Data Analyst", capability: "Export data", benefit: "Quick analysis", acceptanceCriteriaIds: ["AC-1"] }],
            functionalRequirements: [{ id: "F-1", title: "CSV and JSON Exporter", description: "Export data in CSV and JSON formats." }],
            nonFunctionalRequirements: [{ id: "NF-1", title: "Export Latency", description: "Complete exports within 2 seconds." }],
            constraints: [],
            integrations: [],
            assumptions: [],
            acceptanceCriteria: [{ id: "AC-1", description: "Low latency export completed under 2s", relatedRequirementIds: ["F-1"] }],
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
              providerResponseId: "resp-doc-1",
              providerRequestId: "req-doc-1",
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
            id: "resp-doc-1",
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
    console.log("[Target 2 Doc Browser] Backend listening on 127.0.0.1:3001");

    // Start Next.js frontend
    const frontendDir = path.resolve(__dirname, "../../anka-diversify-os");
    frontend = spawn("npx", ["next", "start", "-p", "3000"], { cwd: frontendDir, shell: true, stdio: "pipe" });
    await waitForPort(3000);
    console.log("[Target 2 Doc Browser] Frontend listening on 127.0.0.1:3000");

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

    // Step 1: Open project and verify document source
    console.log("[Target 2 Step 1] Navigating to project workspace...");
    await page.goto(`http://127.0.0.1:3000/development/projects/${project.id}`, { waitUntil: "domcontentloaded" });
    await page.getByText("Editable Live Brief").waitFor({ state: "visible", timeout: 15000 });

    // Verify source document is visible with READY status
    await page.getByText("architecture_specification.pdf").first().waitFor({ state: "visible", timeout: 10000 });
    await page.getByText("READY").first().waitFor({ state: "visible", timeout: 10000 });

    const shot1 = path.join(artifactDir, "target2_1_ready_source_visible.png");
    await page.screenshot({ path: shot1, fullPage: true });

    // Step 2: Select source document checkbox and send intake message
    console.log("[Target 2 Step 2] Selecting source checkbox and sending intake message...");
    const sourceCheckbox = page.getByRole("checkbox").first();
    await sourceCheckbox.check();
    await page.getByText("1 of 1 READY sources selected").waitFor({ state: "visible", timeout: 5000 });

    const textarea = page.getByPlaceholder("Describe your goal, users, workflows, or source conflicts…");
    await textarea.fill("Analyze the uploaded specification and extract the data export requirements.");
    const sendButton = page.getByLabel("Send intake message");
    await sendButton.click();

    // Step 3: Verify source-grounded claim proposal and citations
    console.log("[Target 2 Step 3] Waiting for grounded claims and citation badges...");
    await page.getByText("Data Export Capability").waitFor({ state: "visible", timeout: 15000 });
    await page.getByText("Citations: 1 verified span(s)").first().waitFor({ state: "visible", timeout: 15000 });

    // Verify active contradiction is rendered
    await page.getByText("Latency requirement may conflict with very large dataset export.").waitFor({ state: "visible", timeout: 15000 });
    await page.getByText("ACTIVE").waitFor({ state: "visible", timeout: 10000 });

    const shot2 = path.join(artifactDir, "target2_2_grounded_claim_and_contradiction.png");
    await page.screenshot({ path: shot2, fullPage: true });

    // Step 4: Accept all 4 claims
    console.log("[Target 2 Step 4] Accepting all 4 proposed claims...");
    for (let i = 0; i < 4; i++) {
      const acceptBtn = page.getByRole("button", { name: "Accept" }).first();
      await acceptBtn.waitFor({ state: "visible", timeout: 10000 });
      await acceptBtn.click();
      await page.waitForTimeout(1000);
    }

    // Step 5: Verify readiness is still BLOCKED due to active contradiction
    console.log("[Target 2 Step 5] Verifying readiness is blocked by active contradiction...");
    await page.getByText(/material contradiction\(s\) remain unresolved/).waitFor({ state: "visible", timeout: 10000 });

    // Step 6: Conflict resolution in the browser
    console.log("[Target 2 Step 6] Resolving contradiction in the browser...");
    const resolutionInput = page.getByPlaceholder("Resolution decision");
    await resolutionInput.fill("Paginated streaming will be used for large datasets to keep latency under 2 seconds.");
    const resolveBtn = page.getByRole("button", { name: "Resolve" });
    await resolveBtn.click();

    await page.getByText("RESOLVED").waitFor({ state: "visible", timeout: 10000 });

    // Step 7: Verify Readiness is now satisfied
    console.log("[Target 2 Step 7] Verifying Readiness is satisfied after conflict resolution...");
    await page.getByText("All deterministic confirmation gates are satisfied.").waitFor({ state: "visible", timeout: 15000 });

    const shot3 = path.join(artifactDir, "target2_3_conflict_resolved_ready.png");
    await page.screenshot({ path: shot3, fullPage: true });

    // Step 8: Owner confirmation
    console.log("[Target 2 Step 8] Owner confirming brief with evidence manifest...");
    const confirmBtn = page.getByRole("button", { name: "Confirm exact revision" });
    await confirmBtn.click();
    await page.getByText(/is owner-confirmed with exact hash/).waitFor({ state: "visible", timeout: 15000 });

    // Step 9: Requirements generation and traceable lineage
    console.log("[Target 2 Step 9] Generating Requirements from confirmed brief...");
    const genBtn = page.getByRole("button", { name: "Generate Requirements from confirmed brief" });
    await genBtn.click();

    await page.getByText(/Workflow run/).waitFor({ state: "visible", timeout: 20000 });
    await page.getByText("completed", { exact: true }).waitFor({ state: "visible", timeout: 20000 });

    const shot4 = path.join(artifactDir, "target2_4_traceable_requirements_generated.png");
    await page.screenshot({ path: shot4, fullPage: true });

    // Step 10: Inspect backend WorkflowRun.context to verify traceable evidence manifest
    const latestRun = await prisma.workflowRun.findFirst({
      where: { projectId: project.id, operation: "INITIAL_GENERATION" },
      orderBy: { startedAt: "desc" }
    });

    const runContext = latestRun?.context;
    console.log("\n=================== TARGET 2 FINDINGS ===================");
    console.log(`WorkflowRun ID: ${latestRun?.id}`);
    console.log(`Confirmation ID in context: ${runContext?.briefAuthority?.confirmationId}`);
    console.log(`Evidence manifest count in context: ${runContext?.briefAuthority?.evidenceManifest?.length}`);
    if (runContext?.briefAuthority?.evidenceManifest?.length > 0) {
      const entry = runContext.briefAuthority.evidenceManifest[0];
      console.log(`Lineage trace: sourceId=${entry.sourceId}, spanId=${entry.spanId}, textHash=${entry.textHash}`);
    }
    console.log("=========================================================\n");

  } finally {
    if (browser) await browser.close();
    if (frontend) frontend.kill();
    if (backend) await new Promise((resolve) => backend.close(resolve));
    await prisma.$disconnect().catch(() => undefined);
    await rootPrisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await rootPrisma.$disconnect();
    console.log(`[Target 2 Doc Browser] Dropped isolated schema: ${schemaName}`);
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
