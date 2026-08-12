/**
 * Phase 2 – Repository Revision & Context Freshness
 *
 * Tests 1-7:
 *  1. Identical repository  → identical revision hash
 *  2. File content change   → different hash
 *  3. File path change      → different hash
 *  4. File ordering         → same hash (sort-stable)
 *  5. Disk content vs stale snapshot → revision reflects disk
 *  6. Stale revision is detected
 *  7. Unchanged revision → intelligence can be reused (revisionChanged === false)
 */

import os from "os";
import fs from "fs";
import path from "path";

import { computeRevision, RepositoryRevision } from "../repository/RepositorySnapshot";
import { RepositoryScanner } from "../repository/RepositoryScanner";

// ---------------------------------------------------------------------------
// Helpers (local copies – keep tests self-contained)
// ---------------------------------------------------------------------------

function makeTmpDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anka-rev-test-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
  return dir;
}

function rmDir(dir: string) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 1. Identical repository content → identical revision hash
// ---------------------------------------------------------------------------
describe("RepositoryRevision – computeRevision()", () => {
  test("1: identical file set produces identical contentHash", () => {
    const files = [
      { path: "src/a.ts", content: "export const A = 1;" },
      { path: "src/b.ts", content: "export const B = 2;" },
    ];

    const r1 = computeRevision(files);
    const r2 = computeRevision(files);

    expect(r1.contentHash).toBe(r2.contentHash);
    expect(r1.fileCount).toBe(2);
  });

  // 2. File content change → different hash
  test("2: changing file content produces different contentHash", () => {
    const original = [{ path: "src/a.ts", content: "v1" }];
    const modified = [{ path: "src/a.ts", content: "v2" }];

    const r1 = computeRevision(original);
    const r2 = computeRevision(modified);

    expect(r1.contentHash).not.toBe(r2.contentHash);
  });

  // 3. File path change → different hash
  test("3: changing a file path produces different contentHash", () => {
    const original = [{ path: "src/a.ts", content: "same" }];
    const renamed = [{ path: "src/z.ts", content: "same" }];

    const r1 = computeRevision(original);
    const r2 = computeRevision(renamed);

    expect(r1.contentHash).not.toBe(r2.contentHash);
  });

  // 4. Input ordering should NOT affect the hash (sort-stable)
  test("4: file ordering in input does not affect contentHash", () => {
    const filesAB = [
      { path: "src/b.ts", content: "B" },
      { path: "src/a.ts", content: "A" },
    ];
    const filesBA = [
      { path: "src/a.ts", content: "A" },
      { path: "src/b.ts", content: "B" },
    ];

    const r1 = computeRevision(filesAB);
    const r2 = computeRevision(filesBA);

    expect(r1.contentHash).toBe(r2.contentHash);
  });

  // Sanity: fileCount reflects actual entries
  test("fileCount matches the number of files provided", () => {
    const files = [
      { path: "src/a.ts", content: "" },
      { path: "src/b.ts", content: "" },
      { path: "src/c.ts", content: "" },
    ];
    expect(computeRevision(files).fileCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 5. Disk content vs stale snapshot → revision reflects disk content
// ---------------------------------------------------------------------------
describe("RepositoryRevision – disk content wins in revision", () => {
  let dir: string;
  afterEach(() => rmDir(dir));

  test("5: revision is computed from disk content, not stale snapshot content", () => {
    dir = makeTmpDir({ "src/svc.ts": "DISK_VERSION" });

    const snapshot = {
      repoName: "test",
      defaultBranch: "main",
      description: "",
      languages: {},
      fileTree: ["src/svc.ts"],
      keyFiles: [{ path: "src/svc.ts", content: "STALE_VERSION" }],
      lastSyncedAt: new Date(),
    };

    const effective = RepositoryScanner.getEffectiveSnapshot(snapshot, dir);

    // Verify the file content in effective snapshot is the disk version
    const svc = effective.keyFiles.find((f) => f.path === "src/svc.ts");
    expect(svc?.content).toBe("DISK_VERSION");

    // Verify the revision hash equals what we'd compute from disk content
    const expectedRevision = computeRevision([{ path: "src/svc.ts", content: "DISK_VERSION" }]);
    expect(effective.revision?.contentHash).toBe(expectedRevision.contentHash);
  });
});

// ---------------------------------------------------------------------------
// 6. Stale revision is detected
// ---------------------------------------------------------------------------
describe("RepositoryRevision – staleness detection", () => {
  let dir: string;
  afterEach(() => rmDir(dir));

  test("6: revision hash changes when a disk file is updated", () => {
    dir = makeTmpDir({ "src/api.ts": "VERSION_1" });

    const snapshot1 = {
      repoName: "test",
      defaultBranch: "main",
      description: "",
      languages: {},
      fileTree: ["src/api.ts"],
      keyFiles: [],
      lastSyncedAt: new Date(),
    };

    const effective1 = RepositoryScanner.getEffectiveSnapshot(snapshot1, dir);
    const hashBefore = effective1.revision?.contentHash;

    // Simulate file being updated on disk
    fs.writeFileSync(path.join(dir, "src/api.ts"), "VERSION_2", "utf8");

    const effective2 = RepositoryScanner.getEffectiveSnapshot(snapshot1, dir);
    const hashAfter = effective2.revision?.contentHash;

    expect(hashBefore).toBeDefined();
    expect(hashAfter).toBeDefined();
    expect(hashBefore).not.toBe(hashAfter);
  });
});

// ---------------------------------------------------------------------------
// 7. Unchanged revision means intelligence can be reused
// ---------------------------------------------------------------------------
describe("RepositoryRevision – unchanged revision guards re-indexing", () => {
  let dir: string;
  afterEach(() => rmDir(dir));

  test("7: two calls to getEffectiveSnapshot on unchanged disk produce identical contentHash", () => {
    dir = makeTmpDir({ "src/util.ts": "export const X = 42;" });

    const snapshot = {
      repoName: "test",
      defaultBranch: "main",
      description: "",
      languages: {},
      fileTree: ["src/util.ts"],
      keyFiles: [],
      lastSyncedAt: new Date(),
    };

    const eff1 = RepositoryScanner.getEffectiveSnapshot(snapshot, dir);
    const eff2 = RepositoryScanner.getEffectiveSnapshot(snapshot, dir);

    // The hash must be the same when disk content has not changed.
    // In the pipeline this means revisionChanged === false and indexing is skipped.
    expect(eff1.revision?.contentHash).toBe(eff2.revision?.contentHash);

    // Simulate the in-pipeline staleness check logic
    const lastIndexed = eff1.revision!.contentHash;
    const current = eff2.revision!.contentHash;
    const revisionChanged = current !== lastIndexed;
    expect(revisionChanged).toBe(false);
  });
});
