const fs = require("fs");
const path = require("path");

const authPath = path.join(__dirname, "../src/auth.ts");
const content = fs.readFileSync(authPath, "utf8");

const match = content.match(/export\s+const\s+jwtSecret\s*=\s*([^;\n]+)/);
if (!match) {
  console.error("Could not find jwtSecret export in src/auth.ts");
  process.exit(1);
}

const expr = match[1];

// 1. Test fallback when JWT_SECRET is unset
delete process.env.JWT_SECRET;
const defaultVal = new Function("process", `return ${expr}`)(process);
if (defaultVal !== "default-secret") {
  console.error(`Assertion failed: default jwtSecret expected 'default-secret', got '${defaultVal}'`);
  process.exit(1);
}

// 2. Test dynamic resolution when JWT_SECRET is set
process.env.JWT_SECRET = "custom-test-secret-1234";
const customVal = new Function("process", `return ${expr}`)(process);
if (customVal !== "custom-test-secret-1234") {
  console.error(`Assertion failed: dynamic jwtSecret expected 'custom-test-secret-1234', got '${customVal}'`);
  process.exit(1);
}

console.log("All auth scope tests passed.");
