const fs = require("fs");
const path = require("path");

const filePath = path.join(__dirname, "../src/pagination.ts");
const content = fs.readFileSync(filePath, "utf8");

const match = content.match(/function\s+getPageOffset\s*\([^)]*\)[^{]*\{([\s\S]*?)\}/);
if (!match) {
  console.error("Could not find getPageOffset function definition.");
  process.exit(1);
}

const fnBody = match[1];
const getPageOffset = new Function("page", "limit", fnBody);

const offset1 = getPageOffset(1, 10);
const offset2 = getPageOffset(2, 10);

if (offset1 !== 0) {
  console.error(`Assertion failed: getPageOffset(1, 10) expected 0, got ${offset1}`);
  process.exit(1);
}

if (offset2 !== 10) {
  console.error(`Assertion failed: getPageOffset(2, 10) expected 10, got ${offset2}`);
  process.exit(1);
}

console.log("All pagination tests passed.");
