import fs from "fs";
import path from "path";
import crypto from "crypto";
import { normalizeRepoPath } from "./SemanticContextResolver";
import { RepositoryKnowledgeGraph, savePersistedKnowledgeGraph } from "./RepositoryKnowledgeGraph";
import { RepositoryEvidenceStore } from "./RepositoryEvidenceStore";

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  "__pycache__",
]);

function scanFilesOnDisk(dir: string, baseDir: string = dir): Array<{ path: string; content: string }> {
  const result: Array<{ path: string; content: string }> = [];
  if (!dir || !fs.existsSync(dir)) return result;

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        result.push(...scanFilesOnDisk(fullPath, baseDir));
      } else if (entry.isFile()) {
        const rel = path.relative(baseDir, fullPath).replace(/\\/g, "/");
        try {
          const content = fs.readFileSync(fullPath, "utf8");
          result.push({ path: rel, content });
        } catch {
          // Ignore read errors
        }
      }
    }
  } catch {
    // Ignore directory traversal errors
  }
  return result;
}

export interface RefreshedRepositoryState {
  revisionHash: string;
  snapshot: {
    keyFiles: Array<{ path: string; content: string }>;
    fileTree: string[];
    revision: { contentHash: string };
  };
  knowledgeGraph: any;
}

/**
 * RepositoryStateRefresher ensures that every TaskExecutionPlan stage investigates
 * the exact, freshly verified repository state produced by the preceding stage.
 *
 * Invariants:
 * 1. Generates a new analysis identity (revisionHash) after every verified stage mutation.
 * 2. Invalidates and recomputes AST, symbol, import/reference edges, and semantic chunks.
 * 3. Invalidates diagnostic evidence from prior stages so stale errors cannot authorize writes.
 * 4. On rollback, restores analysis state corresponding exactly to the restored checkpoint.
 */
export class RepositoryStateRefresher {
  /**
   * Computes a deterministic content hash across all current source files on disk.
   */
  public static computeRepositoryRevision(localPath: string, projectId: string = "default-project"): string {
    if (!localPath || !fs.existsSync(localPath)) {
      return `rev_${projectId}_empty`;
    }

    const files = scanFilesOnDisk(localPath);
    files.sort((a, b) => a.path.localeCompare(b.path));

    const hasher = crypto.createHash("sha256");
    hasher.update(projectId);

    for (const f of files) {
      hasher.update(f.path);
      hasher.update(f.content);
    }

    return `rev_${hasher.digest("hex").slice(0, 16)}`;
  }

  /**
   * Refreshes the repository state from disk:
   * 1. Scans the actual files currently on disk.
   * 2. Computes the new revisionHash.
   * 3. Rebuilds the knowledge graph from disk.
   * 4. Persists the new knowledge graph keyed by the new revisionHash.
   */
  public static async refreshRepositoryState(params: {
    projectId: string;
    localPath: string;
    customBaseDir?: string;
  }): Promise<RefreshedRepositoryState> {
    const { projectId, localPath, customBaseDir } = params;

    const files = scanFilesOnDisk(localPath);
    const revisionHash = this.computeRepositoryRevision(localPath, projectId);

    const snapshot = {
      keyFiles: files,
      fileTree: files.map((f) => f.path),
      revision: { contentHash: revisionHash },
    };

    // Build fresh knowledge graph from current disk files
    const knowledgeGraph = await RepositoryKnowledgeGraph.buildKnowledgeGraph(snapshot);

    // Save persisted graph keyed by the new revisionHash
    savePersistedKnowledgeGraph(projectId, revisionHash, knowledgeGraph, customBaseDir);

    return {
      revisionHash,
      snapshot,
      knowledgeGraph,
    };
  }

  /**
   * Invalidates stale diagnostics in the RepositoryEvidenceStore.
   * Stale diagnostics from completed/previous stages can NEVER grant write authority.
   */
  public static invalidateStaleDiagnostics(
    evidenceStore: RepositoryEvidenceStore,
    completedCheckpointId?: string
  ): number {
    return evidenceStore.markDiagnosticStale(completedCheckpointId);
  }

  /**
   * Resets analysis state after a stage fails and rolls back to checkpoint.
   */
  public static async onRollback(params: {
    projectId: string;
    localPath: string;
    customBaseDir?: string;
  }): Promise<RefreshedRepositoryState> {
    return this.refreshRepositoryState(params);
  }
}
