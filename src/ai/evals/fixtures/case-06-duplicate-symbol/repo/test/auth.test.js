const fs = require("fs");
const path = require("path");

const authPath = path.join(__dirname, "../src/auth/AuthService.ts");
const content = fs.readFileSync(authPath, "utf8");

const match = content.match(/validateSession\s*\([^)]*\)[^{]*\{([\s\S]*?)\}/);
if (!match) {
  console.error("Could not find validateSession definition in src/auth/AuthService.ts");
  process.exit(1);
}

const validateSession = new Function("token", match[1]);

if (validateSession("v2_auth_valid_token_123") !== true) {
  console.error("Assertion failed: validateSession should return true for token starting with 'v2_auth_'");
  process.exit(1);
}

if (validateSession("auth_legacy_token") !== false) {
  console.error("Assertion failed: validateSession should return false for old 'auth_' prefix token");
  process.exit(1);
}

if (validateSession("invalid_token") !== false) {
  console.error("Assertion failed: validateSession should return false for invalid token");
  process.exit(1);
}

console.log("All auth service duplicate symbol tests passed.");
