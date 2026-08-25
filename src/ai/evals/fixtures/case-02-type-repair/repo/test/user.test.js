const fs = require("fs");
const path = require("path");

const filePath = path.join(__dirname, "../src/services/user.service.ts");
const content = fs.readFileSync(filePath, "utf8");

function extractFunctionBody(code, funcName) {
  const startIdx = code.indexOf(`function ${funcName}`);
  if (startIdx === -1) return null;
  const firstBrace = code.indexOf('{', startIdx);
  if (firstBrace === -1) return null;
  let depth = 1;
  let i = firstBrace + 1;
  while (i < code.length && depth > 0) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') depth--;
    i++;
  }
  return code.slice(firstBrace + 1, i - 1);
}

const body = extractFunctionBody(content, "formatUser");
if (!body) {
  console.error("Could not find formatUser function definition.");
  process.exit(1);
}

const fn = new Function("id", "name", body);
const res = fn("u1", "Alice");

if (!res || typeof res !== "object") {
  console.error("formatUser must return an object.");
  process.exit(1);
}

if (res.id !== "u1" || res.name !== "Alice") {
  console.error(`Invalid id/name: expected id 'u1' and name 'Alice', got id '${res.id}' and name '${res.name}'`);
  process.exit(1);
}

if (res.role !== "user") {
  console.error(`Assertion failed: expected role 'user', got '${res.role}'`);
  process.exit(1);
}

console.log("All user service tests passed.");
