import fs from "fs";
import path from "path";

/**
 * Resolves the active WASM binary assets directory.
 *
 * Checks production `dist/assets/wasm` first, then falls back to `src/assets/wasm`
 * for development under ts-node/tsx.
 */
export function resolveWasmDir(): string {
  const cwd = process.cwd();
  const distWasmDir = path.resolve(cwd, "dist", "assets", "wasm");

  if (fs.existsSync(distWasmDir)) {
    return distWasmDir;
  }

  const srcWasmDir = path.resolve(cwd, "src", "assets", "wasm");
  if (!fs.existsSync(srcWasmDir)) {
    fs.mkdirSync(srcWasmDir, { recursive: true });
  }

  return srcWasmDir;
}

/**
 * Returns the absolute filepath for a named `.wasm` binary file.
 */
export function getWasmFilePath(filename: string): string {
  const dir = resolveWasmDir();
  return path.join(dir, filename);
}
