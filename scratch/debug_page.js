const path = require("path");
const fs = require("fs");
const jwt = require("jsonwebtoken");
const { chromium } = require("playwright-core");

function chromiumExecutable() {
  const root = path.join(process.env.LOCALAPPDATA, "ms-playwright");
  for (const name of fs.readdirSync(root).sort().reverse()) {
    const candidate = path.join(root, name, "chrome-win64", "chrome.exe");
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error("Chromium not found");
}

async function main() {
  const execPath = chromiumExecutable();
  const browser = await chromium.launch({ executablePath: execPath, headless: true });
  const context = await browser.newContext();

  const user = { id: "cp41-owner-1", email: "owner@anka.test", name: "Lead Architect", role: "owner" };
  const token = jwt.sign({ userId: user.id }, "your_jwt_secret_here");

  await context.addInitScript(
    ({ token, user }) => {
      window.addEventListener("error", (e) => {
        console.log("[WINDOW ERROR EVENT]", e.message, e.filename, e.lineno, e.error?.stack);
      });
      window.addEventListener("unhandledrejection", (e) => {
        console.log("[WINDOW UNHANDLED REJECTION]", e.reason);
      });
      localStorage.setItem("authToken", token);
      localStorage.setItem("user", JSON.stringify(user));
    },
    { token, user }
  );

  // Intercept ONLY API calls to localhost:3001
  await context.route(/localhost:3001\/api|\/api\//, async (route) => {
    const url = route.request().url();
    console.log("[INTERCEPTED ROUTE]:", route.request().method(), url);
    if (url.includes("projects/cp41-journey-project")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: {
            id: "cp41-journey-project",
            name: "CP4.1 Architecture Handoff System",
            ownerId: user.id,
            userId: user.id,
            phase: "architecture",
            progress: 75,
            status: "active",
          },
        }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true, data: [] }),
    });
  });

  const page = await context.newPage();
  page.on("request", (req) => {
    console.log("[REQ]:", req.method(), req.url());
  });
  page.on("response", (res) => {
    console.log("[RES]:", res.status(), res.url());
  });
  page.on("console", (msg) => console.log(`[CONSOLE ${msg.type()}]:`, msg.text()));
  page.on("pageerror", (err) => console.log("[PAGEERROR]:", err));
  page.on("requestfailed", (req) => console.log("[REQ FAILED]:", req.method(), req.url(), req.failure()?.errorText));

  console.log("Navigating to http://127.0.0.1:3000/development/projects ...");
  const response = await page.goto("http://127.0.0.1:3000/development/projects", {
    waitUntil: "domcontentloaded",
  });
  console.log("HTTP response status:", response.status());

  await page.waitForTimeout(4000);
  const title = await page.title();
  console.log("Page title:", title);
  const h1 = await page.evaluate(() => document.querySelector("h1")?.textContent);
  console.log("H1:", h1);
  const buttons = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("button, a")).map((b) => ({
      tag: b.tagName,
      text: b.textContent?.trim(),
      href: b.href || null,
    })).filter(b => b.text);
  });
  console.log("CLICKABLE ELEMENTS:", buttons.slice(0, 10));

  await browser.close();
}

main().catch(console.error);
