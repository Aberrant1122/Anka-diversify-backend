import { SemanticSearchResult } from "../../services/semantic-retrieval.engine";

export interface SnapshotFileEntry {
  path: string;
  content?: string;
}

export interface CanonicalFileLookupEntry {
  path: string;
  content: string;
}

/**
 * Normalizes repository file paths for matching across operating systems.
 */
export function normalizeRepoPath(filePath: string): string {
  if (!filePath || typeof filePath !== "string") return "";
  return filePath
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\//, "");
}

/**
 * Builds a lookup from normalized path to the canonical snapshot file entry (canonical path + full content).
 */
export function buildFullFileLookup(
  rawSnapshotFiles: Array<SnapshotFileEntry | any>
): Map<string, CanonicalFileLookupEntry> {
  const lookup = new Map<string, CanonicalFileLookupEntry>();
  if (!Array.isArray(rawSnapshotFiles)) return lookup;

  for (const file of rawSnapshotFiles) {
    if (file && typeof file.path === "string" && typeof file.content === "string") {
      const norm = normalizeRepoPath(file.path);
      if (norm) {
        lookup.set(norm, {
          path: file.path,
          content: file.content,
        });
      }
    }
  }
  return lookup;
}

export interface EnrichFileContextParams {
  fileContext: Record<string, string>;
  semanticResults: SemanticSearchResult[];
  rawSnapshotFiles: Array<SnapshotFileEntry | any>;
  similarityThreshold?: number;
  hybridThreshold?: number;
}

/**
 * Enriches fileContext with FULL current file contents from the repository snapshot
 * for any semantic results meeting the score threshold.
 *
 * Rules:
 * 1. Semantic chunks never enter fileContext as if they were complete files.
 * 2. Uses the snapshot's canonical file path as the fileContext key.
 * 3. Replaces/upgrades existing partial fileContext content with verified full snapshot content.
 * 4. Removes non-canonical duplicate keys for the same normalized path.
 * 5. If full snapshot file does not exist, never inserts chunk.content and preserves existing context.
 */
export function enrichFileContextWithSemanticResults(
  params: EnrichFileContextParams
): Record<string, string> {
  const {
    fileContext,
    semanticResults,
    rawSnapshotFiles,
    similarityThreshold = 0.4,
    hybridThreshold = 0.35,
  } = params;

  if (!fileContext || typeof fileContext !== "object" || !Array.isArray(semanticResults)) {
    return fileContext || {};
  }

  const fullFileLookup = buildFullFileLookup(rawSnapshotFiles);

  for (const res of semanticResults) {
    if (!res.chunk?.filePath) continue;

    const rawChunkPath = res.chunk.filePath;
    const normPath = normalizeRepoPath(rawChunkPath);
    if (!normPath) continue;

    const passesThreshold =
      (typeof res.similarityScore === "number" && res.similarityScore > similarityThreshold) ||
      (typeof res.hybridScore === "number" && res.hybridScore > hybridThreshold);

    if (!passesThreshold) {
      continue;
    }

    const resolved = fullFileLookup.get(normPath);

    if (resolved) {
      const canonicalPath = resolved.path;
      const fullContent = resolved.content;

      // Clean up any non-canonical key variations in existing fileContext
      for (const existingKey of Object.keys(fileContext)) {
        if (normalizeRepoPath(existingKey) === normPath && existingKey !== canonicalPath) {
          delete fileContext[existingKey];
        }
      }

      fileContext[canonicalPath] = fullContent;
    }
    // If no full repository file can be resolved:
    // - Do NOT insert res.chunk.content
    // - Preserve any existing context as-is
  }

  return fileContext;
}
