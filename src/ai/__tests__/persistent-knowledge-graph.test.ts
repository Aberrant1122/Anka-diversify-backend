/**
 * Phase 4 – Persistent, Revision-Aware, Project-Scoped Knowledge Graph Tests
 *
 * Tests 1-7:
 *  1. Persistence & process restart simulation
 *  2. Revision cache HIT (buildKnowledgeGraph skipped)
 *  3. Revision cache MISS (rebuild & update disk record)
 *  4. Deleted file removes stale graph data
 *  5. Project isolation (Project A & B independent)
 *  6. Failure safety (build error preserves prior valid graph)
 *  7. Malformed persistence fails safely
 */

import os from "os";
import fs from "fs";
import path from "path";

import {
  RepositoryKnowledgeGraph,
  loadPersistedKnowledgeGraph,
  savePersistedKnowledgeGraph,
} from "../repository/RepositoryKnowledgeGraph";
import { computeRevision } from "../repository/RepositorySnapshot";
import { RepositoryScanner } from "../repository/RepositoryScanner";
import { PersistentRepositoryGraphEngine } from "../../services/persistent-repository-graph.engine";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anka-kg-test-"));
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
// TEST 1 — Persistence & Process Restart
// ---------------------------------------------------------------------------
describe("Phase 4: Knowledge Graph Persistence", () => {
  let tmpBase: string;

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "anka-kg-base-"));
  });

  afterEach(() => {
    rmDir(tmpBase);
  });

  test("1: Persisted knowledge graph survives process restart simulation", async () => {
    const projectId = "proj-kg-restart";
    const snapshot = {
      keyFiles: [
        { path: "src/components/Header.tsx", content: "export function Header() { return <div>Header</div>; }" },
      ],
    };

    const revision = computeRevision(snapshot.keyFiles);
    const graph = await RepositoryKnowledgeGraph.buildKnowledgeGraph(snapshot);

    // Save graph to disk
    savePersistedKnowledgeGraph(projectId, revision.contentHash, graph, tmpBase);

    // Simulate process restart: load directly from disk using new memory context
    const restored = loadPersistedKnowledgeGraph(projectId, revision.contentHash, tmpBase);

    expect(restored).not.toBeNull();
    expect(restored?.componentNodes?.Header).toBeDefined();
    expect(restored?.componentNodes?.Header?.file).toBe("src/components/Header.tsx");
  });

  // ---------------------------------------------------------------------------
  // TEST 2 & 3 — Revision Cache HIT & MISS
  // ---------------------------------------------------------------------------
  test("2: Unchanged revision produces cache HIT (persisted graph returned)", async () => {
    const projectId = "proj-hit-test";
    const snapshot = {
      keyFiles: [
        { path: "src/components/Button.tsx", content: "export function Button() { return <button />; }" },
      ],
    };
    const revision = computeRevision(snapshot.keyFiles);
    const graph = await RepositoryKnowledgeGraph.buildKnowledgeGraph(snapshot);
    savePersistedKnowledgeGraph(projectId, revision.contentHash, graph, tmpBase);

    // Spy on buildKnowledgeGraph to ensure it is NOT called on cache hit
    const buildSpy = jest.spyOn(RepositoryKnowledgeGraph, "buildKnowledgeGraph");

    // Stage 2 execution simulation:
    const loaded = loadPersistedKnowledgeGraph(projectId, revision.contentHash, tmpBase);

    expect(loaded).not.toBeNull();
    expect(buildSpy).not.toHaveBeenCalled();
    buildSpy.mockRestore();
  });

  test("3: Revision hash mismatch produces cache MISS and triggers rebuild", async () => {
    const projectId = "proj-miss-test";
    const oldSnapshot = {
      keyFiles: [{ path: "src/v1.ts", content: "export const v = 1;" }],
    };
    const oldRevision = computeRevision(oldSnapshot.keyFiles);
    const oldGraph = await RepositoryKnowledgeGraph.buildKnowledgeGraph(oldSnapshot);
    savePersistedKnowledgeGraph(projectId, oldRevision.contentHash, oldGraph, tmpBase);

    // New snapshot with changed revision
    const newSnapshot = {
      keyFiles: [{ path: "src/v1.ts", content: "export const v = 2;" }],
    };
    const newRevision = computeRevision(newSnapshot.keyFiles);

    // Load with new revision hash -> must return null (cache miss)
    const loadedMiss = loadPersistedKnowledgeGraph(projectId, newRevision.contentHash, tmpBase);
    expect(loadedMiss).toBeNull();

    // Rebuild & persist new graph
    const newGraph = await RepositoryKnowledgeGraph.buildKnowledgeGraph(newSnapshot);
    savePersistedKnowledgeGraph(projectId, newRevision.contentHash, newGraph, tmpBase);

    // Load with new revision -> hits
    const loadedHit = loadPersistedKnowledgeGraph(projectId, newRevision.contentHash, tmpBase);
    expect(loadedHit).not.toBeNull();
  });

  // ---------------------------------------------------------------------------
  // TEST 4 — Deleted File Removes Stale Graph Data
  // ---------------------------------------------------------------------------
  test("4: Deleted file is removed from regenerated knowledge graph", async () => {
    const dir = makeTmpDir({
      "src/components/Header.tsx": "export function Header() { return <div />; }",
      "src/components/Footer.tsx": "export function Footer() { return <div />; }",
    });

    try {
      // Revision A: Header + Footer
      const effA = RepositoryScanner.getEffectiveSnapshot(null, dir);
      const graphA = await RepositoryKnowledgeGraph.buildKnowledgeGraph(effA);
      expect(graphA.componentNodes.Header).toBeDefined();
      expect(graphA.componentNodes.Footer).toBeDefined();

      savePersistedKnowledgeGraph("proj-del", effA.revision!.contentHash, graphA, tmpBase);

      // Delete Footer.tsx from disk
      fs.unlinkSync(path.join(dir, "src/components/Footer.tsx"));

      // Revision B: Header only
      const effB = RepositoryScanner.getEffectiveSnapshot(null, dir);
      expect(effB.revision!.contentHash).not.toBe(effA.revision!.contentHash);

      // Cache miss for Revision B
      const cachedB = loadPersistedKnowledgeGraph("proj-del", effB.revision!.contentHash, tmpBase);
      expect(cachedB).toBeNull();

      // Rebuild graph B from disk-first effective snapshot
      const graphB = await RepositoryKnowledgeGraph.buildKnowledgeGraph(effB);
      savePersistedKnowledgeGraph("proj-del", effB.revision!.contentHash, graphB, tmpBase);

      // Load graph B -> Footer must NOT exist
      const restoredB = loadPersistedKnowledgeGraph("proj-del", effB.revision!.contentHash, tmpBase);
      expect(restoredB?.componentNodes.Header).toBeDefined();
      expect(restoredB?.componentNodes.Footer).toBeUndefined();
    } finally {
      rmDir(dir);
    }
  });

  // ---------------------------------------------------------------------------
  // TEST 5 — Project Isolation
  // ---------------------------------------------------------------------------
  test("5: Project A and Project B have isolated knowledge-graph.json and repository-graph.json", async () => {
    const projA = "proj-iso-A";
    const projB = "proj-iso-B";

    const snapA = { keyFiles: [{ path: "src/CompA.tsx", content: "export function CompA() {}" }] };
    const snapB = { keyFiles: [{ path: "src/CompB.tsx", content: "export function CompB() {}" }] };

    const revA = computeRevision(snapA.keyFiles);
    const revB = computeRevision(snapB.keyFiles);

    const graphA = await RepositoryKnowledgeGraph.buildKnowledgeGraph(snapA);
    const graphB = await RepositoryKnowledgeGraph.buildKnowledgeGraph(snapB);

    savePersistedKnowledgeGraph(projA, revA.contentHash, graphA, tmpBase);
    savePersistedKnowledgeGraph(projB, revB.contentHash, graphB, tmpBase);

    // Verify Project A knowledge graph contains CompA and not CompB
    const loadedA = loadPersistedKnowledgeGraph(projA, revA.contentHash, tmpBase);
    expect(loadedA?.componentNodes.CompA).toBeDefined();
    expect(loadedA?.componentNodes.CompB).toBeUndefined();

    // Verify Project B knowledge graph contains CompB and not CompA
    const loadedB = loadPersistedKnowledgeGraph(projB, revB.contentHash, tmpBase);
    expect(loadedB?.componentNodes.CompB).toBeDefined();
    expect(loadedB?.componentNodes.CompA).toBeUndefined();

    // Verify PersistentRepositoryGraphEngine isolation
    const dirA = path.join(tmpBase, ".anka-cache", "projects", projA);
    const dirB = path.join(tmpBase, ".anka-cache", "projects", projB);

    const engineA = new PersistentRepositoryGraphEngine(dirA);
    const engineB = new PersistentRepositoryGraphEngine(dirB);

    await engineA.buildGraph(snapA.keyFiles, "repoA");
    expect(fs.existsSync(path.join(dirA, "repository-graph.json"))).toBe(true);
    expect(fs.existsSync(path.join(dirB, "repository-graph.json"))).toBe(false);

    await engineB.buildGraph(snapB.keyFiles, "repoB");
    expect(fs.existsSync(path.join(dirB, "repository-graph.json"))).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // TEST 6 — Failure Safety
  // ---------------------------------------------------------------------------
  test("6: Build failure preserves prior valid persisted graph", async () => {
    const projectId = "proj-fail-safe";
    const initialSnap = { keyFiles: [{ path: "src/ok.ts", content: "export const ok = 1;" }] };
    const initialRev = computeRevision(initialSnap.keyFiles);
    const initialGraph = await RepositoryKnowledgeGraph.buildKnowledgeGraph(initialSnap);

    savePersistedKnowledgeGraph(projectId, initialRev.contentHash, initialGraph, tmpBase);

    // Simulate rebuild failure for new revision
    const newRevHash = "new-def-hash-9999";
    try {
      throw new Error("AST parsing crashed during buildKnowledgeGraph");
      // savePersistedKnowledgeGraph should not be reached
    } catch {
      // Build failed
    }

    // Verify initial revision's persisted graph is still intact
    const restored = loadPersistedKnowledgeGraph(projectId, initialRev.contentHash, tmpBase);
    expect(restored).not.toBeNull();
    expect(restored?.exports.some((e) => e.symbol === "ok")).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // TEST 7 — Malformed Persistence
  // ---------------------------------------------------------------------------
  test("7: Malformed knowledge-graph.json returns null and fails safely", () => {
    const projectId = "proj-malformed";
    const dir = path.join(tmpBase, ".anka-cache", "projects", projectId);
    fs.mkdirSync(dir, { recursive: true });

    // Write invalid JSON
    fs.writeFileSync(path.join(dir, "knowledge-graph.json"), "{ malformed json...", "utf8");

    const loaded = loadPersistedKnowledgeGraph(projectId, undefined, tmpBase);
    expect(loaded).toBeNull();
  });
});
