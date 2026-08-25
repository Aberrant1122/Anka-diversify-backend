const fs = require("fs");
const path = require("path");

const gatewayPath = path.join(__dirname, "../src/payment/gateway.ts");
const checkoutPath = path.join(__dirname, "../src/payment/checkout.ts");

const gatewayContent = fs.readFileSync(gatewayPath, "utf8");
const checkoutContent = fs.readFileSync(checkoutPath, "utf8");

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

// Parse createGateway
const gwBody = extractFunctionBody(gatewayContent, "createGateway");
if (!gwBody) {
  console.error("Could not find createGateway in gateway.ts");
  process.exit(1);
}
const createGateway = new Function("opts", gwBody);

// Parse processCheckout
const coBody = extractFunctionBody(checkoutContent, "processCheckout");
if (!coBody) {
  console.error("Could not find processCheckout in checkout.ts");
  process.exit(1);
}
const processCheckout = new Function("apiKey", "createGateway", coBody);

const res = processCheckout("test_key_123", createGateway);

if (!res || res.apiKey !== "test_key_123") {
  console.error("Assertion failed: processCheckout should preserve apiKey");
  process.exit(1);
}

if (res.timeoutMs !== 3000) {
  console.error(`Assertion failed: expected timeoutMs = 3000, got ${res?.timeoutMs}`);
  process.exit(1);
}

console.log("All payment checkout tests passed.");
