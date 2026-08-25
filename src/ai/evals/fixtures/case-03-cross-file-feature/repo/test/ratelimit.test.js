const fs = require("fs");
const path = require("path");

const serverPath = path.join(__dirname, "../src/config/server.ts");
const limiterPath = path.join(__dirname, "../src/middleware/rateLimiter.ts");

const serverContent = fs.readFileSync(serverPath, "utf8");
const limiterContent = fs.readFileSync(limiterPath, "utf8");

// Parse config from server.ts
const configMatch = serverContent.match(/config:\s*ServerConfig\s*=\s*\{([\s\S]*?)\};/);
if (!configMatch) {
  console.error("Could not parse config object from server.ts");
  process.exit(1);
}
const configObj = new Function(`return {${configMatch[1]}}`)();

if (configObj.rateLimitMs !== 500) {
  console.error(`Assertion failed: config.rateLimitMs expected 500, got ${configObj.rateLimitMs}`);
  process.exit(1);
}

// Test getRateLimitMs fallback and value
const fnMatch = limiterContent.match(/function\s+getRateLimitMs\s*\([^)]*\)[^{]*\{([\s\S]*?)\}/);
if (!fnMatch) {
  console.error("Could not parse getRateLimitMs from rateLimiter.ts");
  process.exit(1);
}
const getRateLimitMs = new Function("config", fnMatch[1]);

// 1. With configured rateLimitMs:
const actualVal = getRateLimitMs(configObj);
if (actualVal !== 500) {
  console.error(`Assertion failed: getRateLimitMs(config) expected 500, got ${actualVal}`);
  process.exit(1);
}

// 2. With empty config fallback:
const fallbackVal = getRateLimitMs({});
if (fallbackVal !== 500) {
  console.error(`Assertion failed: getRateLimitMs({}) fallback expected 500, got ${fallbackVal}`);
  process.exit(1);
}

console.log("All cross-file rate limiter tests passed.");
