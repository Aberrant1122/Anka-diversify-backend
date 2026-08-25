const fs = require("fs");
const path = require("path");

const tokenPath = path.join(__dirname, "../src/token.service.ts");
const content = fs.readFileSync(tokenPath, "utf8");

const match = content.match(/isTokenExpired\s*\([^)]*\)[^{]*\{([\s\S]*?)\}/);
if (!match) {
  console.error("Could not find isTokenExpired definition in src/token.service.ts");
  process.exit(1);
}

const isTokenExpired = new Function("exp", match[1]);

const pastExp = Math.floor((Date.now() - 50000) / 1000);
const futureExp = Math.floor((Date.now() + 50000) / 1000);

if (isTokenExpired(pastExp) !== true) {
  console.error(`Assertion failed: past token (exp=${pastExp}) should be expired (expected true)`);
  process.exit(1);
}

if (isTokenExpired(futureExp) !== false) {
  console.error(`Assertion failed: future token (exp=${futureExp}) should NOT be expired (expected false)`);
  process.exit(1);
}

console.log("All token service tests passed.");
