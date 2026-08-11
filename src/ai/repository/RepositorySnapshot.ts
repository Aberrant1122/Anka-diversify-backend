import crypto from "crypto";

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
