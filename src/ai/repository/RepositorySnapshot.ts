import crypto from "crypto";
import fs from "fs";
import path from "path";

// ─── Repository Revision ──────────────────────────────────────────────────────

/**
 * A deterministic content fingerprint for the effective repository files
 * (i.e. the merged disk-first file set after Phase-1 precedence logic).
 *
 * The hash is stable:
 *  - Sort files by normalised POSIX path (eliminates scan-order variance).
 *  - Feed "path:content" for every file into SHA-256.
 *  - Identical repository content → identical hash regardless of when or
 *    where the fingerprint was computed.
 *  - Any change to a file path OR its content produces a different hash.
 *  - Timestamps are NOT included.
 */
export interface RepositoryRevision {
  /** Full-length SHA-256 hex string of the sorted (path, content) corpus. */
  contentHash: string;
  /** Number of files included in the hash. */
  fileCount: number;
  /** Wall-clock instant the revision was computed (for logging only – NOT hashed). */
  generatedAt: Date;
}

/**
 * Compute a RepositoryRevision from the effective file set.
 *
 * @param files - Array of {path, content} produced by disk-first merge.
 *                Paths MUST already be normalised to POSIX separators.
 */
export function computeRevision(
  files: ReadonlyArray<{ path: string; content?: string }>,
): RepositoryRevision {
  // 1. Normalise paths and filter out entries with no content to hash
  const entries = files
    .map((f) => ({ path: f.path.replace(/\\/g, "/"), content: f.content ?? "" }))
    .filter((f) => f.path.length > 0);

  // 2. Sort by normalised path → eliminates filesystem-traversal-order variance
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  // 3. Feed "path:content\n" blocks into a single SHA-256 digest
  const hasher = crypto.createHash("sha256");
  for (const { path, content } of entries) {
    hasher.update(`${path}:${content}\n`);
  }
  const contentHash = hasher.digest("hex");

  return {
    contentHash,
    fileCount: entries.length,
    generatedAt: new Date(),
  };
}

/**
 * Load persisted project revision from .anka-cache/projects/{projectId}/revision.json
 */
export function loadPersistedRevision(
  projectId: string,
  customBaseDir?: string,
): RepositoryRevision | null {
  try {
    const cwd = customBaseDir || process.cwd();
    const revPath = path.join(cwd, ".anka-cache", "projects", projectId, "revision.json");
    if (!fs.existsSync(revPath)) return null;
    const raw = fs.readFileSync(revPath, "utf8");
    const data = JSON.parse(raw);
    if (!data || typeof data.contentHash !== "string") return null;
    return {
      contentHash: data.contentHash,
      fileCount: typeof data.fileCount === "number" ? data.fileCount : 0,
      generatedAt: data.generatedAt ? new Date(data.generatedAt) : new Date(),
    };
  } catch {
    return null;
  }
}

/**
 * Save project revision to .anka-cache/projects/{projectId}/revision.json
 */
export function savePersistedRevision(
  projectId: string,
  revision: RepositoryRevision,
  customBaseDir?: string,
): void {
  try {
    const cwd = customBaseDir || process.cwd();
    const dir = path.join(cwd, ".anka-cache", "projects", projectId);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const revPath = path.join(dir, "revision.json");
    fs.writeFileSync(
      revPath,
      JSON.stringify(
        {
          contentHash: revision.contentHash,
          fileCount: revision.fileCount,
          generatedAt: revision.generatedAt.toISOString(),
        },
        null,
        2,
      ),
      "utf8",
    );
  } catch {}
}

// ─── Repository Snapshot Data ─────────────────────────────────────────────────

export interface RepositorySnapshotData {
  repoName: string;
  defaultBranch: string;
  description?: string;
  languages: Record<string, number>;
  fileTree: string[];
  keyFiles: Array<{ path: string; content?: string }>;
  lastSyncedAt: Date;
  /** Content fingerprint computed from the disk-first effective file set. Present after getEffectiveSnapshot(). */
  revision?: RepositoryRevision;
}
