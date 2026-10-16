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
      localStorage.setItem("authToken", token);
      localStorage.setItem("user", JSON.stringify(user));
    },
    { token, user }
  );

  // ONLY route intercept API requests! DO NOT intercept Next.js chunks!
  await context.route(/localhost:3001\/api|\/api\//, async (route) => {
    const url = route.request().url();
    console.log("[INTERCEPTED API CALL]:", route.request().method(), url);
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
  page.on("console", (msg) => console.log("[PAGE LOG]", msg.type(), msg.text()));
  page.on("pageerror", (err) => console.log("[PAGE ERROR]", err.message));

  console.log("Navigating to project page...");
  await page.goto("http://127.0.0.1:3000/development/projects/cp41-journey-project", { waitUntil: "networkidle" });
  
  console.log("Triggering explicit fetch from inside page context...");
  const manualRes = await page.evaluate(async () => {
    try {
      const r = await fetch("http://localhost:3001/api/projects/cp41-journey-project");
      return await r.json();
    } catch (e) {
      return { err: e.message };
    }
  });
  console.log("Manual fetch response:", manualRes);

  const h1 = await page.evaluate(() => document.querySelector("h1")?.textContent);
  console.log("H1 text is:", h1);
  await browser.close();
}

main().catch(console.error);
