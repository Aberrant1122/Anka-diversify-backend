import fs from "fs";
import path from "path";
import { computeRevision } from "./RepositorySnapshot";
import { repositoryPath } from "./RepositoryBoundary";

export interface AuthoritySnapshot {
  readonly revision: string;
  readonly canonicalRoot: string;
  readonly hasUnsupportedLinks: boolean;
  readonly files: ReadonlyMap<string, string>;
}
class SnapshotFiles implements ReadonlyMap<string, string> {
  readonly #values: Map<string, string>;
  constructor(values: Map<string, string>) { this.#values = values; Object.freeze(this); }
  get size(): number { return this.#values.size; }
  get(key: string): string | undefined { return this.#values.get(key); }
  has(key: string): boolean { return this.#values.has(key); }
  entries() { return this.#values.entries(); }
  keys() { return this.#values.keys(); }
  values() { return this.#values.values(); }
  [Symbol.iterator]() { return this.#values[Symbol.iterator](); }
  forEach(callback: (value: string, key: string, map: ReadonlyMap<string, string>) => void, thisArg?: unknown): void {
    this.#values.forEach((value, key) => callback.call(thisArg, value, key, this));
  }
}

const active = new Map<string, AuthoritySnapshot>();
const excluded = new Set([".git", "node_modules", ".next", "dist", "build", ".anka-cache", "coverage", ".turbo"]);

/** Disk-only corpus, using the snapshot content-hash algorithm. No Git HEAD or remote fallback. */
export function captureAuthoritySnapshot(root: string): AuthoritySnapshot {
  const canonicalRoot = fs.realpathSync(root);
  const files = new Map<string, string>();
  const links: Array<{ path: string; content: string }> = [];
  let count = 0;
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (++count > 100000) throw new Error("AUTHORITY_REPOSITORY_LIMIT");
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).replace(/\\/g, "/");
      // Links are deliberately unsupported in the authority corpus, including cycles.
      if (excluded.has(entry.name)) continue;
      if (entry.isSymbolicLink()) {
        links.push({ path: `authority-link:${relative}`, content: Buffer.from(fs.readlinkSync(absolute)).toString("base64") });
        continue;
      }
      if (!repositoryPath(root, relative)) throw new Error("AUTHORITY_BOUNDARY_VIOLATION");
      if (entry.isDirectory()) { if (!excluded.has(entry.name)) walk(absolute); }
      else if (entry.isFile()) files.set(relative, fs.readFileSync(absolute).toString("base64"));
    }
  };
  walk(root);
  return Object.freeze({ canonicalRoot, hasUnsupportedLinks: links.length > 0, revision: computeRevision([...files].map(([file, content]) => ({ path: file, content })).concat(links)).contentHash, files: new SnapshotFiles(files) });
}

export function authoritySnapshot(root: string): AuthoritySnapshot {
  return active.get(path.resolve(root)) ?? captureAuthoritySnapshot(root);
}

/** Synchronous observation batches share a single disk snapshot, never a cross-revision cache. */
export function withAuthoritySnapshot<T>(root: string, operation: () => T): T {
  const key = path.resolve(root);
  if (active.has(key)) return operation();
  active.set(key, captureAuthoritySnapshot(root));
  try { return operation(); } finally { active.delete(key); }
}

export function currentAuthorityRevision(root: string, revision: string): boolean {
  try { return captureAuthoritySnapshot(root).revision === revision; } catch { return false; }
}
