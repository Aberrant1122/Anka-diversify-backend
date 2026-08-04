import { WasmASTParserEngine } from "../ast-parser.engine";

async function runAstParserEngineTests() {
  console.log("[Test] Initializing WasmASTParserEngine...");
  await WasmASTParserEngine.initialize();
  console.log("  ✓ WasmASTParserEngine initialized successfully.");

  // Test 1: TypeScript Symbol Extraction
  const sampleTs = `
import React, { useState } from 'react';
import { calculateTax } from './tax-service';

export interface User {
  id: string;
}

export function renderUser(user: User) {
  return user.id;
}
`;

  const tsSymbols = WasmASTParserEngine.extractSymbols("sample.ts", sampleTs);
  console.log(`[Test] TS Symbols extracted: ${tsSymbols.imports.length} imports, ${tsSymbols.functions.length} functions.`);
  if (tsSymbols.imports.length < 2) throw new Error("Expected at least 2 imports");
  if (tsSymbols.functions.length < 1) throw new Error("Expected at least 1 function");
  if (tsSymbols.hasSyntaxErrors) throw new Error("Expected 0 syntax errors on clean TS code");
  console.log("  ✓ TS Symbol Extraction passed.");

  // Test 2: HTML DOM AST Parsing
  const sampleHtml = `
<!DOCTYPE html>
<html>
<head><title>Test</title></head>
<body>
  <div id="display" class="calc-display">0</div>
  <script src="script.js"></script>
</body>
</html>
`;

  const htmlDom = WasmASTParserEngine.parseHtmlDom(sampleHtml);
  console.log(`[Test] HTML DOM extracted: ${htmlDom.tags.length} tags, ${htmlDom.attributes.length} attributes.`);
  const hasDisplayId = htmlDom.attributes.some((a) => a.name === "id" && a.value === "display");
  const hasScriptSrc = htmlDom.attributes.some((a) => a.name === "src" && a.value === "script.js");
  if (!hasDisplayId || !hasScriptSrc) throw new Error("Expected #display ID and script.js src in HTML DOM AST");
  console.log("  ✓ HTML DOM AST Parsing passed.");

  // Test 3: Reverse Byte Patching
  const original = "function foo() { return 1; }";
  const patched = WasmASTParserEngine.applyReverseBytePatches(original, [
    { startByte: 24, endByte: 25, replacement: "42" },
  ]);
  if (!patched.includes("return 42;")) throw new Error("Reverse byte patching failed");
  console.log("  ✓ Reverse Byte Patching passed.");

  console.log("\n[WasmAST Engine Test Suite] ALL TESTS PASSED CLEANLY!");
}

runAstParserEngineTests().catch((e) => {
  console.error("[Test Failure]", e);
  process.exit(1);
});
