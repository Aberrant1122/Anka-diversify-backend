const path = require("path");
const fs = require("fs");
const jwt = require("jsonwebtoken");
const { chromium } = require("playwright-core");

function chromiumExecutable() {
  const root = path.join(process.env.LOCALAPPDATA, "ms-playwright");
  for (const name of fs.readdirSync(root).sort().reverse()) {
    const candidate = path.join(root, name, "chrome-headless-shell-win64", "chrome-headless-shell.exe");
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error("Chromium not found");
}

async function main() {
  const execPath = chromiumExecutable();
  const browser = await chromium.launch({ executablePath: execPath, headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  
  const user = { id: "cp41-owner-1", email: "owner@anka.test", name: "Lead Architect & Owner" };
  const token = jwt.sign({ userId: user.id, email: user.email }, "your_jwt_secret_here", { expiresIn: "1h" });

  await context.addInitScript(
    ({ authToken, currentUser }) => {
      localStorage.setItem("authToken", authToken);
      localStorage.setItem("user", JSON.stringify(currentUser));
    },
    { authToken: token, currentUser: user }
  );

  const page = await context.newPage();
  
  await page.route("**/*", async (route) => {
    const url = route.request().url();
    if (url.includes("api")) {
      console.log("[INTERCEPT API]:", route.request().method(), url);
    }
    route.continue();
  });

  page.on("console", (msg) => console.log(`[PAGE LOG] ${msg.type()}: ${msg.text()}`));
  page.on("pageerror", (err) => console.log(`[PAGE ERROR] ${err.message}`));

  await page.goto("http://127.0.0.1:3000/development/projects/cp41-journey-project", { waitUntil: "networkidle" });
  console.log("Current URL:", page.url());
  
  // Wait 3 seconds
  await page.waitForTimeout(3000);
  
  const bodyText = await page.evaluate(() => document.body.innerText);
  console.log("Body text:\n", bodyText.slice(0, 500));
  await browser.close();
}

main().catch(console.error);
