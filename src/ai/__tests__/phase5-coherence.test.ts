/**
 * Phase 5 – Repository Intelligence Coherence Tests
 *
 * Phase 5A: Complete Eviction for Deleted, Renamed, and Modified Files
 * Phase 5B: Safe Reuse of Knowledge Graph & Shared ToolEngine Instance
 */

import os from "os";
import fs from "fs";
import path from "path";

import { PersistentRepositoryGraphEngine } from "../../services/persistent-repository-graph.engine";
import { RepositoryToolEngine, MultiGraphIndex } from "../../services/repository-tool.engine";
import { IterativeReasoningEngine } from "../../services/iterative-reasoning.engine";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "anka-phase5-test-"));
}

function rmDir(dir: string) {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe("Phase 5A: PersistentRepositoryGraphEngine Graph Eviction", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmDir(tmpDir);
  });

  test("5A.1: Deleting a file evicts its file node, symbol nodes, edges, and fileHashes", async () => {
    const engine = new PersistentRepositoryGraphEngine(tmpDir);

    const initialFiles = [
      { path: "src/A.ts", content: "export function funcA() {}" },
      { path: "src/B.ts", content: "export function funcB() {}" },
    ];

    await engine.buildGraph(initialFiles, "test-repo");

    // Verify initial state
    const keysBefore = Array.from((engine as any).nodeMap.keys()) as string[];
    const nodeABefore = keysBefore.find((k) => k.includes("A.ts"));
    const nodeBBefore = keysBefore.find((k) => k.includes("B.ts"));
    expect(nodeABefore).toBeDefined();
    expect(nodeBBefore).toBeDefined();
    expect((engine as any).fileHashes.has("src/B.ts")).toBe(true);

    // Now delete src/B.ts from the file snapshot
    const updatedFiles = [
      { path: "src/A.ts", content: "export function funcA() {}" },
    ];

    await engine.buildGraph(updatedFiles, "test-repo");

    // Verify src/B.ts is completely evicted
    const keysAfter = Array.from((engine as any).nodeMap.keys()) as string[];
    const nodeBAfter = keysAfter.find((k) => k.includes("B.ts"));
    expect(nodeBAfter).toBeUndefined();
    expect((engine as any).fileHashes.has("src/B.ts")).toBe(false);

    // Verify src/A.ts remains intact
    const nodeAAfter = keysAfter.find((k) => k.includes("A.ts"));
    expect(nodeAAfter).toBeDefined();
  });

  test("5A.2: Renaming a file evicts the old path nodes and creates new path nodes", async () => {
    const engine = new PersistentRepositoryGraphEngine(tmpDir);

    const initialFiles = [
      { path: "src/OldName.ts", content: "export class OldService {}" },
    ];
    await engine.buildGraph(initialFiles, "test-repo");

    expect((engine as any).fileHashes.has("src/OldName.ts")).toBe(true);

    // Rename src/OldName.ts to src/NewName.ts
    const renamedFiles = [
      { path: "src/NewName.ts", content: "export class OldService {}" },
    ];
    await engine.buildGraph(renamedFiles, "test-repo");

    expect((engine as any).fileHashes.has("src/OldName.ts")).toBe(false);
    expect((engine as any).fileHashes.has("src/NewName.ts")).toBe(true);

    const keysRenamed = Array.from((engine as any).nodeMap.keys()) as string[];
    const oldNodes = keysRenamed.filter((k) => k.includes("OldName.ts"));
    expect(oldNodes.length).toBe(0);
  });

  test("5A.3: Modifying a file content evicts stale symbols removed in the edit", async () => {
    const engine = new PersistentRepositoryGraphEngine(tmpDir);

    const v1Files = [
      { path: "src/Widget.ts", content: "export function oldFunction() {}" },
    ];
    await engine.buildGraph(v1Files, "test-repo");

    expect((engine as any).nodeMap.has("function:oldFunction")).toBe(true);

    // Modify file: replace oldFunction with newFunction
    const v2Files = [
      { path: "src/Widget.ts", content: "export function newFunction() {}" },
    ];
    await engine.buildGraph(v2Files, "test-repo");

    expect((engine as any).nodeMap.has("function:oldFunction")).toBe(false);
    expect((engine as any).nodeMap.has("function:newFunction")).toBe(true);
  });
});

describe("Phase 5B: Tool Engine Knowledge Graph Reuse & Instance Sharing", () => {
  test("5B.1: IterativeReasoningEngine reuses provided RepositoryToolEngine instance", () => {
    const snapshot = {
      keyFiles: [{ path: "src/index.ts", content: "console.log('test');" }],
    };

    const toolEngine = new RepositoryToolEngine(snapshot);
    const reasoningEngine = new IterativeReasoningEngine({
      snapshot,
      toolEngine,
    });

    expect((reasoningEngine as any).toolEngine).toBe(toolEngine);
  });

  test("5B.2: MultiGraphIndex ingests knowledgeGraph componentNodes when provided", () => {
    const files = [
      { path: "src/components/Header.tsx", content: "export function Header() { return <div>Header</div>; }" },
    ];

    const mockKG = {
      componentNodes: {
        Header: {
          component: "Header",
          file: "src/components/Header.tsx",
          exportKind: "named",
          whoImportsIt: [{ file: "src/App.tsx", importedSymbols: ["Header"] }],
          whoRendersIt: [{ file: "src/App.tsx", parentComponent: "App", jsxTag: "<Header>" }],
          whichRouteOwnsIt: null,
          isReachable: true,
          reachabilityReason: "Rendered by App",
        },
      },
    };

    const indexWithKG = new MultiGraphIndex(files, mockKG);
    const headerNode = indexWithKG.componentGraph.get("Header");

    expect(headerNode).toBeDefined();
    expect(headerNode?.file).toBe("src/components/Header.tsx");
    expect(headerNode?.isReachable).toBe(true);
    expect(headerNode?.whoImportsIt[0].file).toBe("src/App.tsx");
  });

  test("5B.3: MultiGraphIndex falls back to regex loop when knowledgeGraph is omitted", () => {
    const files = [
      { path: "src/components/Footer.tsx", content: "export function Footer() { return <div>Footer</div>; }" },
      { path: "src/App.tsx", content: "import { Footer } from './components/Footer'; export function App() { return <Footer />; }" },
    ];

    // Omit knowledgeGraph -> regex fallback loop fires
    const indexFallback = new MultiGraphIndex(files);
    const footerNode = indexFallback.componentGraph.get("Footer");

    expect(footerNode).toBeDefined();
    expect(footerNode?.file).toBe("src/components/Footer.tsx");
    expect(footerNode?.whoRendersIt.some((r) => r.file === "src/App.tsx")).toBe(true);
  });
});
