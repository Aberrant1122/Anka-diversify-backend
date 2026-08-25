const fs = require("fs");
const path = require("path");

const tokenPath = path.join(__dirname, "../src/modules/auth/services/token-validation.service.ts");
const content = fs.readFileSync(tokenPath, "utf8");

const match = content.match(/function\s+isTokenValid\s*\([^)]*\)[^{]*\{([\s\S]*?)\}/);
if (!match) {
  console.error("Could not find isTokenValid in token-validation.service.ts");
  process.exit(1);
}

const isTokenValid = new Function("token", match[1]);

const shortToken = "short_16_chars__";
const validToken = "valid_token_that_is_at_least_32_characters_long";

if (isTokenValid(shortToken) !== false) {
  console.error(`Assertion failed: short token (${shortToken.length} chars) should be invalid (expected false)`);
  process.exit(1);
}

if (isTokenValid(validToken) !== true) {
  console.error(`Assertion failed: valid token (${validToken.length} chars) should be valid (expected true)`);
  process.exit(1);
}

console.log("All nested token validation tests passed.");
