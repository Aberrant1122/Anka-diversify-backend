const fs = require("fs");
const path = require("path");

const sessionPath = path.join(__dirname, "../src/services/session.ts");
const content = fs.readFileSync(sessionPath, "utf8");

const match = content.match(/function\s+getSessionTtlSeconds\s*\([^)]*\)[^{]*\{([\s\S]*?)\}/);
if (!match) {
  console.error("Could not find getSessionTtlSeconds definition");
  process.exit(1);
}

const getSessionTtlSeconds = new Function(match[1]);
const ttl = getSessionTtlSeconds();

if (ttl !== 7200) {
  console.error(`Assertion failed: expected getSessionTtlSeconds() to return 7200, got ${ttl}`);
  process.exit(1);
}

console.log("All session ttl tests passed.");
