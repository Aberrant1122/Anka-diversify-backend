/**
 * Tests for disk-first file precedence in Phase 1 reliability refactor.
 *
 * Covers requirements A–F from the user specification:
 *   A. Same file in snapshot and disk  → disk content wins
 *   B. File only in snapshot           → snapshot content returned
 *   C. File only on disk               → disk content returned
 *   D. Windows-style vs POSIX path     → one entry, disk wins
 *   E. RepositoryToolEngine follows same precedence (via getSnapshotFiles)
 *   F. RepositoryKnowledgeGraph receives disk version when both exist
 */

import os from "os";
import fs from "fs";
import path from "path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temporary directory, write files into it, return its path. */
function makeTmpDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anka-test-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
  return dir;
}

/** Recursively delete a directory (cleanup). */
function rmDir(dir: string) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Import the units under test AFTER helper setup so ts-jest picks them up.
// ---------------------------------------------------------------------------

import { mergeFilesWithDiskPriority } from "../../services/repository-tool.engine";
import { RepositoryScanner } from "../repository/RepositoryScanner";
import { RepositoryToolEngine } from "../../services/repository-tool.engine";
import { RepositoryKnowledgeGraph } from "../repository/RepositoryKnowledgeGraph";

// ---------------------------------------------------------------------------
// A. Disk content wins when same path exists in both snapshot and on disk
// ---------------------------------------------------------------------------
describe("mergeFilesWithDiskPriority – core precedence", () => {
  let dir: string;
  afterEach(() => rmDir(dir));

  test("A: disk content wins over snapshot content for same path", () => {
    dir = makeTmpDir({ "src/foo.ts": "NEW" });

    const snapshot = [{ path: "src/foo.ts", content: "OLD" }];
    const result = mergeFilesWithDiskPriority([dir], snapshot);

    const foo = result.find((f) => f.path === "src/foo.ts");
    expect(foo).toBeDefined();
    expect(foo!.content).toBe("NEW");
  });

  // B. Only in snapshot
  test("B: file only in snapshot is still returned", () => {
    dir = makeTmpDir({}); // empty dir
    const snapshot = [{ path: "remote/only.ts", content: "REMOTE" }];
    const result = mergeFilesWithDiskPriority([dir], snapshot);

    const remote = result.find((f) => f.path === "remote/only.ts");
    expect(remote).toBeDefined();
    expect(remote!.content).toBe("REMOTE");
  });

  // C. Only on disk
  test("C: file only on disk is returned", () => {
    dir = makeTmpDir({ "src/local.ts": "LOCAL" });
    const result = mergeFilesWithDiskPriority([dir], []);

    const local = result.find((f) => f.path === "src/local.ts");
    expect(local).toBeDefined();
    expect(local!.content).toBe("LOCAL");
  });

  // D. Windows-style backslash path in snapshot vs POSIX on disk → one entry, disk wins
  test("D: Windows snapshot path normalised to POSIX; disk content wins", () => {
    dir = makeTmpDir({ "src/bar.ts": "DISK_CONTENT" });

    // Snapshot uses Windows-style backslash path
    const snapshot = [{ path: "src\\bar.ts", content: "SNAPSHOT_CONTENT" }];
    const result = mergeFilesWithDiskPriority([dir], snapshot);

    // Should have exactly one entry for this file
    const bars = result.filter((f) => f.path === "src/bar.ts");
    expect(bars).toHaveLength(1);
    expect(bars[0].content).toBe("DISK_CONTENT");
  });
});

// ---------------------------------------------------------------------------
// E. RepositoryToolEngine respects disk-first via same logic
// ---------------------------------------------------------------------------
describe("RepositoryToolEngine – disk-first via getSnapshotFiles", () => {
  let dir: string;
  afterEach(() => rmDir(dir));

  test("E: readFile returns disk content, not stale snapshot content", () => {
    dir = makeTmpDir({ "src/service.ts": "DISK_SERVICE" });

    const snapshot = {
      keyFiles: [{ path: "src/service.ts", content: "STALE_SERVICE" }],
    };

    // Pass localPath so the engine scans it; snapshot provides stale fallback
    const engine = new RepositoryToolEngine(snapshot, dir);
    const result = engine.readFile({ filePath: "src/service.ts" });

    expect(result.found).toBe(true);
    expect(result.content).toBe("DISK_SERVICE");
  });
});

// ---------------------------------------------------------------------------
// F. RepositoryScanner.getEffectiveSnapshot feeds disk version to KnowledgeGraph
// ---------------------------------------------------------------------------
describe("RepositoryScanner + RepositoryKnowledgeGraph – disk content propagated", () => {
  let dir: string;
  afterEach(() => rmDir(dir));

  test("F: KnowledgeGraph receives disk file content when both snapshot and disk exist", async () => {
    const diskContent = `export function diskFn() { return 42; }`;
    dir = makeTmpDir({ "src/utils.ts": diskContent });

    const snapshot = {
      repoName: "test-repo",
      defaultBranch: "main",
      description: "",
      languages: {},
      fileTree: ["src/utils.ts"],
      keyFiles: [{ path: "src/utils.ts", content: "export function staleFn() {}" }],
      lastSyncedAt: new Date(),
    };

    const effective = RepositoryScanner.getEffectiveSnapshot(snapshot, dir);
    const utils = effective.keyFiles.find((f) => f.path === "src/utils.ts");

    expect(utils).toBeDefined();
    expect(utils!.content).toBe(diskContent);

    // Build knowledge graph and verify the exported symbol is from disk
    const kg = await RepositoryKnowledgeGraph.buildKnowledgeGraph(effective);
    const diskExport = kg.exports.find((e) => e.symbol === "diskFn");
    const staleExport = kg.exports.find((e) => e.symbol === "staleFn");

    expect(diskExport).toBeDefined();
    expect(staleExport).toBeUndefined();
  });
});
