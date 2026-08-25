const fs = require("fs");
const path = require("path");

const sessionPath = path.join(__dirname, "../src/session.ts");
const content = fs.readFileSync(sessionPath, "utf8");

const match = content.match(/isSessionActive\s*\([^)]*\)[^{]*\{([\s\S]*?)\}/);
if (!match) {
  console.error("Could not find isSessionActive definition in src/session.ts");
  process.exit(1);
}

const isSessionActive = new Function("createdAt", "maxAgeMs", match[1]);

const recentCreatedAt = Date.now() - 1000;
const oldCreatedAt = Date.now() - 100000;
const maxAge = 5000;

if (isSessionActive(recentCreatedAt, maxAge) !== true) {
  console.error("Assertion failed: recent session should be active (expected true)");
  process.exit(1);
}

if (isSessionActive(oldCreatedAt, maxAge) !== false) {
  console.error("Assertion failed: old session should NOT be active (expected false)");
  process.exit(1);
}

console.log("All session tests passed.");
