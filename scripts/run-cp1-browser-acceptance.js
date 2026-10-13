const path = require("path");
const fs = require("fs");
const http = require("http");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");
const jwt = require("jsonwebtoken");

// Invariant: Fail closed if disposable test database URL is not provided
const {
  validateSafeTestDatabase,
  assertSafeSchema,
  sanitizeOutput,
} = require("./run-cp0-acceptance");

// Find Chromium executable from visual verifier service
function findChromiumExecutable() {
  const localAppData = process.env.LOCALAPPDATA;
  const homeDir = process.env.USERPROFILE || process.env.HOME;
  const searchRoots = [];
  if (localAppData) searchRoots.push(path.join(localAppData, "ms-playwright"));
  if (homeDir) {
    searchRoots.push(path.join(homeDir, ".cache", "ms-playwright"));
    searchRoots.push(path.join(homeDir, "AppData", "Local", "ms-playwright"));
  }

  for (const root of searchRoots) {
    if (!fs.existsSync(root)) continue;
    try {
      const entries = fs.readdirSync(root);
      const headlessDirs = entries.filter((e) => e.startsWith("chromium_headless_shell-")).sort().reverse();
      for (const d of headlessDirs) {
        const cand = path.join(root, d, "chrome-headless-shell-win64", "chrome-headless-shell.exe");
        if (fs.existsSync(cand)) return cand;
      }
      const chromiumDirs = entries.filter((e) => e.startsWith("chromium-")).sort().reverse();
      for (const d of chromiumDirs) {
        const cand = path.join(root, d, "chrome-win64", "chrome.exe");
        if (fs.existsSync(cand)) return cand;
      }
    } catch {}
  }
  return null;
}

// Minimal valid PDF content with identifiable text
function createSamplePdf(text) {
  const streamContent = `BT\n/F1 12 Tf\n72 712 Td\n(${text}) Tj\nET`;
  const streamLength = Buffer.byteLength(streamContent);
  const pdfString = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>
endobj
4 0 obj
<< /Length ${streamLength} >>
stream
${streamContent}
endstream
endobj
5 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
xref
0 6
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000234 00000 n 
0000000357 00000 n 
trailer
<< /Size 6 /Root 1 0 R >>
startxref
434
%%EOF`;
  return Buffer.from(pdfString);
}

// Helper to wait for a port to be ready
async function waitForPort(port, timeoutMs = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await new Promise((resolve, reject) => {
        const req = http.get(`http://localhost:${port}/`, (res) => {
          res.resume();
          resolve();
        });
        req.on("error", reject);
        req.setTimeout(1000, () => {
          req.destroy();
          reject(new Error("Timeout"));
        });
      });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error(`Port ${port} did not respond within ${timeoutMs}ms`);
}

async function waitForDb(fn, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fn();
    if (res) return res;
    await new Promise((r) => setTimeout(r, 250));
  }
  return await fn();
}

async function main() {
  console.log("\n============================================================");
  console.log("  ANKA OS CP1.2: Connected Browser / API / DB Acceptance");
  console.log("============================================================\n");

  const chromiumPath = findChromiumExecutable();
  if (!chromiumPath) {
    console.error("FATAL: Chromium executable not found in ms-playwright directories.");
    process.exit(1);
  }
  console.log(`[Browser] Found Chromium at: ${chromiumPath}`);

  // 1. Database validation & schema isolation
  const baseUrl = validateSafeTestDatabase(process.env.CP0_TEST_DATABASE_URL);
  const schemaPrefix = "planning_checkpoint_cp1_acceptance";
  assertSafeSchema(schemaPrefix);
  const schemaName = `${schemaPrefix}_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
  assertSafeSchema(schemaName);

  const isolatedUrl = new URL(baseUrl.href);
  isolatedUrl.searchParams.set("schema", schemaName);
  console.log(`[DB] Using isolated schema: ${schemaName}`);

  const { PrismaClient } = require("@prisma/client");
  const rootPrisma = new PrismaClient({ datasources: { db: { url: baseUrl.href } } });

  // Point current process to the isolated schema
  process.env.DATABASE_URL = isolatedUrl.href;

  console.log("[DB] Deploying Prisma migrations...");
  const migrateResult = spawnSync("npx prisma migrate deploy", {
    shell: true,
    env: { ...process.env, DATABASE_URL: isolatedUrl.href },
    encoding: "utf8",
  });
  if (migrateResult.error || migrateResult.status !== 0) {
    throw new Error(`Prisma migration failed:\n${migrateResult.stderr || migrateResult.stdout}`);
  }
  console.log("[DB] Migrations applied successfully.");

  const isolatedPrisma = new PrismaClient({ datasources: { db: { url: isolatedUrl.href } } });

  let backendServer = null;
  let frontendProcess = null;
  let browser = null;

  try {
    // 2. Seed Test Users and Projects
    const userA = await isolatedPrisma.user.create({
      data: {
        id: "user-alpha",
        email: "alpha@anka.io",
        name: "Alpha User",
        password: "hashed_password",
        role: "user",
      },
    });

    const userB = await isolatedPrisma.user.create({
      data: {
        id: "user-beta",
        email: "beta@anka.io",
        name: "Beta User",
        password: "hashed_password",
        role: "user",
      },
    });

    const projectA = await isolatedPrisma.project.create({
      data: {
        id: "proj-alpha",
        name: "Alpha Architecture Project",
        description: "Project for CP1 browser acceptance testing",
        phase: "product-modeling",
        priority: "high",
        status: "active",
        userId: userA.id,
      },
    });

    await isolatedPrisma.projectMember.create({
      data: {
        projectId: projectA.id,
        userId: userA.id,
      },
    });

    const projectB = await isolatedPrisma.project.create({
      data: {
        id: "proj-beta",
        name: "Beta Forbidden Project",
        description: "Project for cross-project authorization testing",
        phase: "product-modeling",
        priority: "medium",
        status: "active",
        userId: userB.id,
      },
    });

    await isolatedPrisma.projectMember.create({
      data: {
        projectId: projectB.id,
        userId: userB.id,
      },
    });

    const jwtSecret = process.env.JWT_SECRET || "default_test_secret";
    const tokenA = jwt.sign({ userId: userA.id, email: userA.email }, jwtSecret, { expiresIn: "1h" });
    const tokenB = jwt.sign({ userId: userB.id, email: userB.email }, jwtSecret, { expiresIn: "1h" });

    console.log(`[Seed] Created User Alpha (${userA.id}), User Beta (${userB.id})`);
    console.log(`[Seed] Created Project Alpha (${projectA.id}), Project Beta (${projectB.id})`);

    // 3. Controlled Storage Fixture & Backend Setup
    const storageFixture = new Map();
    const express = require("express");
    const cors = require("cors");
    const app = express();

    app.use(cors({
      origin: true,
      credentials: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Origin", "X-Requested-With", "Content-Type", "Accept", "Authorization", "X-User-ID", "X-User-Name"],
    }));

    // Controlled Storage Fixture endpoint
    app.put(/^\/api\/test-storage\/upload\/(.+)$/, express.raw({ type: "*/*", limit: "25mb" }), (req, res) => {
      const key = req.params[0];
      storageFixture.set(key, req.body);
      res.status(200).send();
    });

    function resolveModule(relPath) {
      const distPath = path.join(__dirname, "../dist", relPath);
      if (fs.existsSync(`${distPath}.js`) || (fs.existsSync(distPath) && fs.statSync(distPath).isDirectory())) {
        return require(distPath);
      }
      return require(path.join(__dirname, "../src", relPath));
    }

    // Mock/interpose uploadService to use controlled storage fixture
    const uploadService = resolveModule("services/upload.service");
    const bucket = process.env.AWS_S3_BUCKET || process.env.AWS_S3_BUCKET_NAME || "anka-os-documents";
    const region = process.env.AWS_REGION || "ap-south-1";

    uploadService.generatePresignedUrl = async (projectId, filename) => {
      const ext = filename.includes(".") ? filename.split(".").pop() : "";
      const key = `projects/${projectId}/${crypto.randomUUID()}${ext ? `.${ext}` : ""}`;
      const url = `http://localhost:3001/api/test-storage/upload/${key}`;
      const fileUrl = `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
      return { uploadUrl: url, fileUrl, key, type: "doc" };
    };
    uploadService.createEvidenceSnapshot = async (projectId, sourceKey) => {
      const snapKey = `projects/${projectId}/document-evidence/${crypto.randomUUID()}`;
      const data = storageFixture.get(sourceKey);
      if (!data) throw new Error("NoSuchKey: Source upload missing");
      storageFixture.set(snapKey, data);
      return snapKey;
    };
    uploadService.fetchFromS3 = async (key, maxBytes = 20 * 1024 * 1024) => {
      const buf = storageFixture.get(key);
      if (!buf) {
        const err = new Error("NoSuchKey");
        err.code = "NoSuchKey";
        throw err;
      }
      return { buffer: buf, byteSize: buf.length };
    };
    uploadService.deleteFromS3 = async (key) => {
      storageFixture.delete(key);
    };

    // Mount backend routes
    app.use(express.json({ limit: "10mb" }));
    app.use(express.urlencoded({ extended: true }));

    app.use((req, res, next) => {
      console.log(`[API Req] ${req.method} ${req.url}`);
      next();
    });

    const { authenticateToken } = resolveModule("middleware/auth");
    const rawProjectRoutes = resolveModule("routes/project-routes");
    const projectRoutes = rawProjectRoutes.default || rawProjectRoutes;
    app.use("/api/projects", authenticateToken, projectRoutes);

    const { errorHandler } = resolveModule("middleware");
    app.use(errorHandler);

    backendServer = http.createServer(app);
    await new Promise((resolve) => backendServer.listen(3001, resolve));
    console.log("[Backend] Test Express API server listening on http://localhost:3001");

    // 4. Start Next.js Frontend Server
    const frontendDir = path.resolve(__dirname, "../../anka-diversify-os");
    console.log(`[Frontend] Launching Next.js production server from: ${frontendDir}`);
    frontendProcess = spawn("npx", ["next", "start", "-p", "3000"], {
      cwd: frontendDir,
      shell: true,
      stdio: "pipe",
    });

    frontendProcess.stdout.on("data", (d) => {
      const s = d.toString();
      if (s.includes("Ready")) console.log(`[Frontend Log] ${s.trim()}`);
    });
    frontendProcess.stderr.on("data", (d) => {
      console.error(`[Frontend Error] ${d.toString().trim()}`);
    });

    await waitForPort(3000, 30000);
    console.log("[Frontend] Next.js server ready at http://localhost:3000");

    // 5. Launch Browser via playwright-core
    const { chromium } = require("playwright-core");
    browser = await chromium.launch({
      executablePath: chromiumPath,
      headless: true,
    });
    const context = await browser.newContext();

    // Inject User Alpha authorization state
    await context.addInitScript(({ token, user }) => {
      localStorage.setItem("authToken", token);
      localStorage.setItem("user", JSON.stringify(user));
    }, { token: tokenA, user: { id: userA.id, name: userA.name, email: userA.email } });

    const page = await context.newPage();
    page.on("console", (msg) => console.log(`[Browser Console] ${msg.type()}: ${msg.text()}`));
    page.on("pageerror", (err) => console.error(`[Browser PageError] ${err.message}`));
    page.on("response", (res) => {
      if (res.url().includes("/api/")) console.log(`[API Res ${res.status()}] ${res.url()}`);
    });

    // ── Criterion 1: Authorized project user opens Files ────────────────────
    console.log("\n[Test 1/9] Checking Criterion 1: Authorized project user opens Files...");
    await page.goto(`http://localhost:3000/development/projects/${projectA.id}`, { waitUntil: "domcontentloaded" });
    
    // Wait for tabs to hydrate and click Files tab
    const filesTab = page.getByRole("tab", { name: /files/i });
    await filesTab.waitFor({ state: "visible", timeout: 15000 });
    await filesTab.click();

    // Verify Add File button or empty files banner is visible
    const addFileTrigger = page.getByText(/add file|add your first deliverable/i).first();
    await addFileTrigger.waitFor({ state: "visible", timeout: 10000 });
    console.log("  ✓ Criterion 1 PASSED: Files tab opened successfully by authorized user.");

    // ── Criterion 2: User uploads a valid PDF or DOCX ────────────────────────
    console.log("\n[Test 2/9] Checking Criterion 2: User uploads a valid PDF...");
    const sampleText = "ANKA Architecture Specification: CP1 Document Evidence Verified";
    const samplePdfBuffer = createSamplePdf(sampleText);
    const tempPdfPath = path.join(__dirname, "temp-test-evidence.pdf");
    fs.writeFileSync(tempPdfPath, samplePdfBuffer);

    try {
      // Find and click the Add File trigger button
      const addFileBtn = page.getByRole("button", { name: /add file/i }).first();
      if (await addFileBtn.isVisible()) {
        await addFileBtn.click();
      } else {
        const cardAdd = page.locator("div").filter({ hasText: /^Add File$/ }).last();
        await cardAdd.click();
      }

      // Upload file via hidden file input in the dialog
      const fileInput = page.locator('input[type="file"]');
      await fileInput.waitFor({ state: "attached", timeout: 5000 });
      await fileInput.setInputFiles(tempPdfPath);

      // Submit upload dialog
      const modalSubmit = page.getByRole("dialog").getByRole("button", { name: /^add file$/i });
      await modalSubmit.waitFor({ state: "visible", timeout: 5000 });
      await modalSubmit.click();

      // Wait for the modal to close and file card to appear
      await page.waitForSelector(`text=temp-test-evidence.pdf`, { timeout: 15000 });
      console.log("  ✓ Criterion 2 PASSED: Valid PDF uploaded via UI.");

      // ── Criterion 3: Backend registers actual uploaded bytes ─────────────────
      console.log("\n[Test 3/9] Checking Criterion 3: Backend registers actual uploaded bytes...");
      const dbFile = await waitForDb(() => isolatedPrisma.projectFile.findFirst({
        where: { projectId: projectA.id, name: "temp-test-evidence.pdf" },
      }), 15000);
      if (!dbFile) throw new Error("ProjectFile was not created in database");
      console.log(`  - ProjectFile ID: ${dbFile.id}, s3Key: ${dbFile.s3Key}`);

      const dbSource = await waitForDb(() => isolatedPrisma.documentSource.findUnique({
        where: { projectFileId: dbFile.id },
      }), 15000);
      if (!dbSource) throw new Error("DocumentSource was not registered for file");
      console.log(`  - DocumentSource ID: ${dbSource.id}, version: ${dbSource.sourceVersion}, snapshotKey: ${dbSource.s3Key}`);

      const uploadedBytes = storageFixture.get(dbFile.s3Key);
      if (!uploadedBytes || uploadedBytes.length !== samplePdfBuffer.length) {
        throw new Error(`Uploaded bytes mismatch: expected ${samplePdfBuffer.length}, got ${uploadedBytes?.length}`);
      }
      console.log(`  ✓ Criterion 3 PASSED: Backend registered ${uploadedBytes.length} bytes with DocumentSource.`);

      // ── Criterion 4: Extraction reaches READY ───────────────────────────────
      console.log("\n[Test 4/9] Checking Criterion 4: Extraction reaches READY...");
      // In the UI, polling updates the badge to "Ready · 1 passages"
      const readyBadge = page.locator("text=/Ready · \\d+ passages/");
      await readyBadge.waitFor({ state: "visible", timeout: 20000 });

      const dbRun = await isolatedPrisma.documentExtractionRun.findFirst({
        where: { sourceId: dbSource.id },
        orderBy: { attempt: "desc" },
      });
      if (dbRun?.status !== "READY") {
        throw new Error(`Extraction run status is ${dbRun?.status}, expected READY`);
      }
      console.log(`  ✓ Criterion 4 PASSED: Extraction status reached READY in UI and database.`);

      // ── Criterion 5: User opens evidence viewer ─────────────────────────────
      console.log("\n[Test 5/9] Checking Criterion 5: User opens evidence viewer...");
      const viewPassagesBtn = page.getByRole("button", { name: /view extracted passages/i });
      await viewPassagesBtn.waitFor({ state: "visible", timeout: 5000 });
      await viewPassagesBtn.click();

      const dialog = page.getByRole("dialog");
      await dialog.waitFor({ state: "visible", timeout: 5000 });
      console.log("  ✓ Criterion 5 PASSED: Evidence viewer dialog opened.");

      // ── Criterion 6: Correct page/paragraph passages are displayed ──────────
      console.log("\n[Test 6/9] Checking Criterion 6: Passages and metadata displayed...");
      await dialog.locator("text=temp-test-evidence.pdf").waitFor({ state: "visible", timeout: 5000 });
      await dialog.locator("text=Page 1").waitFor({ state: "visible", timeout: 5000 });
      await dialog.locator(`text=${sampleText}`).waitFor({ state: "visible", timeout: 5000 });
      
      const expectedSha = crypto.createHash("sha256").update(samplePdfBuffer).digest("hex");
      await dialog.locator(`text=${expectedSha}`).waitFor({ state: "visible", timeout: 5000 });
      console.log(`  ✓ Criterion 6 PASSED: Passage text, Page 1 locator, and SHA-256 hash (${expectedSha.slice(0, 16)}...) correctly displayed.`);

      // Close dialog
      const closeBtn = dialog.locator('button[aria-label="Close"], button:has-text("Close"), button.absolute').first();
      if (await closeBtn.isVisible()) await closeBtn.click();
      else await page.keyboard.press("Escape");

      // ── Criterion 7: Refresh preserves evidence ─────────────────────────────
      console.log("\n[Test 7/9] Checking Criterion 7: Refresh preserves evidence...");
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.getByRole("tab", { name: /files/i }).waitFor({ state: "visible", timeout: 15000 });
      await page.getByRole("tab", { name: /files/i }).click();
      await readyBadge.waitFor({ state: "visible", timeout: 10000 });
      await viewPassagesBtn.click();
      await dialog.waitFor({ state: "visible", timeout: 5000 });
      await dialog.locator(`text=${sampleText}`).waitFor({ state: "visible", timeout: 5000 });
      console.log("  ✓ Criterion 7 PASSED: Evidence persists and reloads correctly upon page refresh.");
      await page.keyboard.press("Escape");

      // ── Criterion 8: Failed extraction supports retry ────────────────────────
      console.log("\n[Test 8/9] Checking Criterion 8: Failed extraction supports retry...");
      // Simulate a failed extraction run on a second document
      const failedFile = await isolatedPrisma.projectFile.create({
        data: {
          projectId: projectA.id,
          name: "corrupted-report.pdf",
          type: "application/pdf",
          phase: "development",
          s3Key: `projects/${projectA.id}/corrupted.pdf`,
          uploadedBy: userA.id,
        },
      });
      const failedSource = await isolatedPrisma.documentSource.create({
        data: {
          projectId: projectA.id,
          projectFileId: failedFile.id,
          sourceVersion: 1,
          originalFilename: failedFile.name,
          mimeType: "application/pdf",
          s3Key: `projects/${projectA.id}/document-evidence/${crypto.randomUUID()}`,
          byteSize: samplePdfBuffer.length,
          contentHash: crypto.createHash("sha256").update(samplePdfBuffer).digest("hex"),
        },
      });
      storageFixture.set(failedSource.s3Key, samplePdfBuffer);

      await isolatedPrisma.documentExtractionRun.create({
        data: {
          projectId: projectA.id,
          sourceId: failedSource.id,
          attempt: 1,
          status: "FAILED",
          parser: "anka-document-parser-v1",
          errorCode: "PARSER_FAILURE",
          errorMessage: "Document extraction encountered an unexpected processing error. Please retry.",
        },
      });

      // Reload UI to show both files
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.getByRole("tab", { name: /files/i }).waitFor({ state: "visible", timeout: 15000 });
      await page.getByRole("tab", { name: /files/i }).click();

      // Locate the failed badge and retry button
      const failedBadge = page.locator("text=Failed");
      await failedBadge.waitFor({ state: "visible", timeout: 10000 });
      const retryBtn = page.getByRole("button", { name: /retry processing/i });
      await retryBtn.waitFor({ state: "visible", timeout: 5000 });

      // Click retry
      await retryBtn.click();
      console.log("  - Clicked Retry Processing button in UI");

      // Verify that retry initiated and reached READY (now 2 ready files present)
      await page.locator("text=/Ready · \\d+ passages/").nth(1).waitFor({ state: "visible", timeout: 25000 });
      console.log("  ✓ Criterion 8 PASSED: Failed extraction displayed diagnostic and successfully retried to READY.");

      // ── Criterion 9: Cross-project access is denied ──────────────────────────
      console.log("\n[Test 9/9] Checking Criterion 9: Cross-project access is denied...");
      // Seed a private file in Project Beta
      const betaFile = await isolatedPrisma.projectFile.create({
        data: {
          projectId: projectB.id,
          name: "beta-secret.pdf",
          type: "application/pdf",
          phase: "development",
          s3Key: `projects/${projectB.id}/beta-secret.pdf`,
          uploadedBy: userB.id,
        },
      });

      // 1. User Alpha attempts to access Project Beta's extraction
      const resBetaExtraction = await fetch(`http://localhost:3001/api/projects/${projectB.id}/files/${betaFile.id}/extraction`, {
        headers: { Authorization: `Bearer ${tokenA}`, "X-User-ID": userA.id },
      });
      if (resBetaExtraction.status !== 403 && resBetaExtraction.status !== 404) {
        throw new Error(`Expected 403/404 for cross-project extraction access, got ${resBetaExtraction.status}`);
      }

      // 2. User Alpha attempts to access Project Beta's evidence
      const resBetaEvidence = await fetch(`http://localhost:3001/api/projects/${projectB.id}/files/${betaFile.id}/evidence`, {
        headers: { Authorization: `Bearer ${tokenA}`, "X-User-ID": userA.id },
      });
      if (resBetaEvidence.status !== 403 && resBetaEvidence.status !== 404) {
        throw new Error(`Expected 403/404 for cross-project evidence access, got ${resBetaEvidence.status}`);
      }

      // 3. User Alpha attempts cross-project retry
      const resBetaRetry = await fetch(`http://localhost:3001/api/projects/${projectB.id}/files/${betaFile.id}/extraction/retry`, {
        method: "POST",
        headers: { Authorization: `Bearer ${tokenA}`, "X-User-ID": userA.id },
      });
      if (resBetaRetry.status !== 403 && resBetaRetry.status !== 404) {
        throw new Error(`Expected 403/404 for cross-project retry attempt, got ${resBetaRetry.status}`);
      }

      // 4. File substitution attack: Authorized Project Alpha URL, but passing betaFile.id
      const resSubAttack = await fetch(`http://localhost:3001/api/projects/${projectA.id}/files/${betaFile.id}/extraction`, {
        headers: { Authorization: `Bearer ${tokenA}`, "X-User-ID": userA.id },
      });
      if (resSubAttack.status !== 404) {
        throw new Error(`Expected 404 for file substitution attack, got ${resSubAttack.status}`);
      }

      // 5. In Browser: User Alpha attempts to navigate to Project Beta
      await page.goto(`http://localhost:3000/development/projects/${projectB.id}`, { waitUntil: "domcontentloaded" });
      const betaSecretInUi = await page.locator("text=beta-secret.pdf").isVisible();
      if (betaSecretInUi) {
        throw new Error("Project Beta file was leaked to User Alpha in UI!");
      }

      console.log("  ✓ Criterion 9 PASSED: Cross-project access denied across all endpoints & UI boundary.");

      console.log("\n============================================================");
      console.log("  ALL 9 CONNECTED ACCEPTANCE CRITERIA VERIFIED SUCCESSFULLY!");
      console.log("============================================================\n");
    } finally {
      if (fs.existsSync(tempPdfPath)) {
        try { fs.unlinkSync(tempPdfPath); } catch {}
      }
    }
  } finally {
    console.log("[Cleanup] Tearing down acceptance test resources...");
    if (browser) {
      try { await browser.close(); } catch {}
      console.log("[Cleanup] Browser closed.");
    }
    if (frontendProcess) {
      try {
        if (process.platform === "win32") {
          spawnSync(`taskkill /pid ${frontendProcess.pid} /f /t`, { shell: true });
        } else {
          frontendProcess.kill("SIGTERM");
        }
      } catch {}
      console.log("[Cleanup] Next.js frontend server terminated.");
    }
    if (backendServer) {
      try { await new Promise((r) => backendServer.close(r)); } catch {}
      console.log("[Cleanup] Express test backend server closed.");
    }
    // Allow background workers and connections to settle
    await new Promise((r) => setTimeout(r, 1000));
    try {
      await isolatedPrisma.$disconnect();
      const quotedSchema = assertSafeSchema(schemaName);
      await rootPrisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
      await rootPrisma.$disconnect();
      console.log(`[Cleanup] Dropped isolated schema: ${schemaName}`);
    } catch (cleanupErr) {
      console.error("[Cleanup Error]:", cleanupErr);
    }
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("\n❌ Acceptance test failed with error:", err);
    process.exit(1);
  });
}

module.exports = { main };
