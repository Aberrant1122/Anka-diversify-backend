/**
 * WASM Binary Asset Copy & Sync Script
 *
 * Copies language WASM binaries from node_modules/tree-sitter-wasms/out
 * into src/assets/wasm (for dev/ts-node) and dist/assets/wasm (for production node dist).
 */

const fs = require("fs");
const path = require("path");

function copyWasmBinaries() {
  const nodeModulesWasmDir = path.resolve(__dirname, "../node_modules/tree-sitter-wasms/out");
  const srcDir = path.resolve(__dirname, "../src/assets/wasm");
  const distDir = path.resolve(__dirname, "../dist/assets/wasm");

  if (!fs.existsSync(srcDir)) fs.mkdirSync(srcDir, { recursive: true });
  if (!fs.existsSync(distDir)) fs.mkdirSync(distDir, { recursive: true });

  const targetWasmFiles = [
    "tree-sitter-typescript.wasm",
    "tree-sitter-tsx.wasm",
    "tree-sitter-html.wasm",
    "tree-sitter-javascript.wasm",
  ];

  let copiedCount = 0;

  // Copy main engine tree-sitter.wasm from web-tree-sitter
  const mainEngineWasm = path.resolve(__dirname, "../node_modules/web-tree-sitter/tree-sitter.wasm");
  if (fs.existsSync(mainEngineWasm)) {
    fs.copyFileSync(mainEngineWasm, path.join(srcDir, "tree-sitter.wasm"));
    fs.copyFileSync(mainEngineWasm, path.join(distDir, "tree-sitter-engine.wasm"));
    copiedCount++;
  }

  for (const filename of targetWasmFiles) {
    const sourcePath = path.join(nodeModulesWasmDir, filename);
    if (fs.existsSync(sourcePath)) {
      const srcDest = path.join(srcDir, filename);
      const distDest = path.join(distDir, filename);
      fs.copyFileSync(sourcePath, srcDest);
      fs.copyFileSync(sourcePath, distDest);
      copiedCount++;
    } else {
      console.warn(`[WASM Copy Warning] Source binary file not found: ${sourcePath}`);
    }
  }

  console.log(`[WASM Copy] Successfully synchronized ${copiedCount} WASM language binaries to src/assets/wasm/ and dist/assets/wasm/`);
}

copyWasmBinaries();
