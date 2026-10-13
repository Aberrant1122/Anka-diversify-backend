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
      const found = candidates.find((candidate) => fs.existsSync(candidate));
      if (found) return found;
    }
  }
  throw new Error("Chromium executable was not found.");
}

async function waitForPort(port, timeout = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      await new Promise((resolve, reject) => {
        const request = http.get(`http://127.0.0.1:${port}/`, (response) => { response.resume(); resolve(); });
        request.on("error", reject);
        request.setTimeout(1_000, () => request.destroy(new Error("timeout")));
      });
      return;
    } catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
  }
  throw new Error(`Port ${port} did not become ready.`);
}

async function main() {
  const baseUrl = validateSafeTestDatabase(process.env.CP0_TEST_DATABASE_URL);
  const schemaName = `planning_checkpoint_cp2_browser_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
  assertSafeSchema(schemaName);
  const isolatedUrl = new URL(baseUrl.href);
  isolatedUrl.searchParams.set("schema", schemaName);
  const { PrismaClient } = require("@prisma/client");
  const rootPrisma = new PrismaClient({ datasources: { db: { url: baseUrl.href } } });
  const prisma = new PrismaClient({ datasources: { db: { url: isolatedUrl.href } } });
  let backend;
  let frontend;
  let browser;
  try {
    const migration = spawnSync("npx prisma migrate deploy", { shell: true, encoding: "utf8", env: { ...process.env, DATABASE_URL: isolatedUrl.href } });
    if (migration.status !== 0) throw new Error(migration.stderr || migration.stdout || "Migration failed");
    process.env.DATABASE_URL = isolatedUrl.href;
    const user = await prisma.user.create({ data: { id: "cp2-browser-owner", email: "cp2-browser@anka.test", name: "CP2 Owner", password: "unused" } });
    const project = await prisma.project.create({ data: {
      id: "cp2-browser-project", name: "CP2 Browser Project", description: "Idea-only browser fixture", userId: user.id,
    } });
    const token = jwt.sign({ userId: user.id, email: user.email }, process.env.JWT_SECRET || "default_test_secret", { expiresIn: "1h" });

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

    const frontendDir = path.resolve(__dirname, "../../anka-diversify-os");
    frontend = spawn("npx", ["next", "start", "-p", "3000"], { cwd: frontendDir, shell: true, stdio: "pipe" });
    await waitForPort(3000);
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
    await page.goto(`http://127.0.0.1:3000/development/projects/${project.id}`, { waitUntil: "domcontentloaded" });
    const tabs = page.getByRole("tab");
    await tabs.first().waitFor({ state: "visible", timeout: 15_000 });
    const labels = await tabs.allTextContents();
    const expected = ["Project Brief", "Kanban Board", "Workflow", "Files", "Repositories", "Code", "Activity", "AI Agent"];
    for (let index = 0; index < expected.length; index += 1) {
      if (!labels[index]?.includes(expected[index])) throw new Error(`Tab ${index + 1} was '${labels[index]}', expected '${expected[index]}'.`);
    }
    if (labels.some((label) => label.trim() === "Chat")) throw new Error("Standalone Chat tab is still visible.");
    const briefTab = page.getByRole("tab", { name: "Project Brief" });
    if (await briefTab.getAttribute("data-state") !== "active") throw new Error("Project Brief is not the default active tab.");
    const artifactDir = path.resolve("C:/Users/PCC/.gemini/antigravity-ide/brain/bda78bb3-70a3-47a3-b558-969de95556f4/browser_evidence");
    fs.mkdirSync(artifactDir, { recursive: true });

    await page.getByText("Editable Live Brief").waitFor({ state: "visible", timeout: 15_000 });
    await page.getByText("Idea-only intake is supported").waitFor({ state: "visible", timeout: 15_000 });
    const shot1 = path.join(artifactDir, "cp2_browser_1_brief_loaded.png");
    await page.screenshot({ path: shot1, fullPage: true });

    await page.getByRole("tab", { name: "Files" }).click();
    await page.waitForURL((url) => url.searchParams.get("tab") === "files", { timeout: 15_000 });
    await page.reload({ waitUntil: "domcontentloaded" });
    const filesTab = page.getByRole("tab", { name: "Files" });
    await filesTab.waitFor({ state: "visible", timeout: 15_000 });
    if (await filesTab.getAttribute("data-state") !== "active") throw new Error("URL-addressed Files tab was not restored.");
    const shot2 = path.join(artifactDir, "cp2_browser_2_tab_restored.png");
    await page.screenshot({ path: shot2, fullPage: true });

    // Switch back to Project Brief tab
    await page.getByRole("tab", { name: "Project Brief" }).click();
    await page.getByText("Editable Live Brief").waitFor({ state: "visible", timeout: 15_000 });
    const titleInput = page.getByLabel("Brief title");
    await titleInput.fill("CP2 Browser Project - Updated Revision");
    await page.getByRole("button", { name: "Save revision" }).click();
    await page.getByText(/Revision 2/).first().waitFor({ state: "visible", timeout: 10_000 });
    const shot3 = path.join(artifactDir, "cp2_browser_3_revision_updated.png");
    await page.screenshot({ path: shot3, fullPage: true });

    // Concurrency conflict (409) simulation
    const { LiveBriefService } = require("../dist/services/live-brief.service");
    const service = new LiveBriefService(prisma);
    await service.updateBrief({
      projectId: project.id,
      actorId: user.id,
      expectedRevisionNumber: 2,
      title: "Out-of-band revision from another session",
      markdownContent: "Concurrent update",
      changeSummary: "Concurrent edit",
    });

    await titleInput.fill("Conflicting browser update");
    await page.getByRole("button", { name: "Save revision" }).click();
    await page.getByText("The brief changed in another session. Latest state has been restored.").waitFor({ state: "visible", timeout: 10_000 });
    const shot4 = path.join(artifactDir, "cp2_browser_4_conflict_409.png");
    await page.screenshot({ path: shot4, fullPage: true });

    console.log("CP2 BROWSER ACCEPTANCE PASSED: 8 tabs ordered, Project Brief default, Chat absent, brief initialized, URL state restored, interactive edit saved to Revision 2, 409 conflict handled cleanly with state restoration.");
  } finally {
    if (browser) await browser.close();
    if (frontend) frontend.kill();
    if (backend) await new Promise((resolve) => backend.close(resolve));
    await prisma.$disconnect().catch(() => undefined);
    await rootPrisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await rootPrisma.$disconnect();
    console.log(`[CP2 Browser] Dropped isolated schema: ${schemaName}`);
  }
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
