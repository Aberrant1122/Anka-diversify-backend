import fs from "fs";
import path from "path";
import crypto from "crypto";
import { performance } from "perf_hooks";

// ─── Graph Node & Edge Types ──────────────────────────────────────────────────

export type NodeType =
  | "repository"
  | "file"
  | "symbol"
  | "function"
  | "class"
  | "component"
  | "route"
  | "api"
  | "service"
  | "controller"
  | "prisma_model";

export type RelationType =
  | "imports"
  | "exports"
  | "calls"
  | "renders"
  | "owns"
  | "depends_on"
  | "implements"
  | "uses";

export interface GraphNode {
  id: string; // Unique Identifier (e.g. "file:src/app.ts", "symbol:AuthService")
  type: NodeType;
  name: string;
  filePath?: string;
  line?: number;
  metadata?: Record<string, any>;
}

export interface GraphEdge {
  id: string; // "sourceId--relation--targetId"
  sourceId: string;
  targetId: string;
  relation: RelationType;
  metadata?: Record<string, any>;
}

export interface GraphSnapshotData {
  version: string;
  lastUpdated: string;
  fileHashes: Record<string, string>;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface SnapshotFile {
  path: string;
  content?: string;
}

// ─── Persistent Repository Knowledge Graph Engine ─────────────────────────────

export class PersistentRepositoryGraphEngine {
  private cachePath: string;
  private nodeMap = new Map<string, GraphNode>();
  private outEdges = new Map<string, GraphEdge[]>();
  private inEdges = new Map<string, GraphEdge[]>();
  private fileHashes = new Map<string, string>();

  constructor(cacheDir?: string) {
    const dir = cacheDir || path.join(process.cwd(), ".anka-cache");
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch {}
    }
    this.cachePath = path.join(dir, "repository-graph.json");
    this.loadFromDisk();
  }

  // ── 1. Persistence & Incremental Hash Loading ───────────────────────────────

  private loadFromDisk(): boolean {
    if (fs.existsSync(this.cachePath)) {
      try {
        const raw = fs.readFileSync(this.cachePath, "utf8");
        const data: GraphSnapshotData = JSON.parse(raw);

        for (const [p, h] of Object.entries(data.fileHashes || {})) {
          this.fileHashes.set(p, h);
        }
        for (const n of data.nodes || []) {
          this.nodeMap.set(n.id, n);
        }
        for (const e of data.edges || []) {
          this.addEdgeToAdjacency(e);
        }
        return true;
      } catch {
        // Fallback to fresh graph
      }
    }
    return false;
  }

  public saveToDisk() {
    try {
      const allNodes = Array.from(this.nodeMap.values());
      const allEdges: GraphEdge[] = [];
      for (const edges of this.outEdges.values()) {
        allEdges.push(...edges);
      }

      const fileHashesObj: Record<string, string> = {};
      for (const [p, h] of this.fileHashes.entries()) {
        fileHashesObj[p] = h;
      }

      const snapshotData: GraphSnapshotData = {
        version: "1.0.0",
        lastUpdated: new Date().toISOString(),
        fileHashes: fileHashesObj,
        nodes: allNodes,
        edges: allEdges,
      };

      fs.writeFileSync(this.cachePath, JSON.stringify(snapshotData, null, 2), "utf8");
    } catch {}
  }

  private addNode(node: GraphNode) {
    this.nodeMap.set(node.id, node);
  }

  private addEdge(sourceId: string, targetId: string, relation: RelationType, metadata?: Record<string, any>) {
    const id = `${sourceId}--${relation}--${targetId}`;
    const edge: GraphEdge = { id, sourceId, targetId, relation, metadata };
    this.addEdgeToAdjacency(edge);
  }

  private addEdgeToAdjacency(edge: GraphEdge) {
    let outList = this.outEdges.get(edge.sourceId);
    if (!outList) {
      outList = [];
      this.outEdges.set(edge.sourceId, outList);
    }
    if (!outList.some((e) => e.id === edge.id)) outList.push(edge);

    let inList = this.inEdges.get(edge.targetId);
    if (!inList) {
      inList = [];
      this.inEdges.set(edge.targetId, inList);
    }
    if (!inList.some((e) => e.id === edge.id)) inList.push(edge);
  }

  // ── 2. Incremental Codebase Graph Construction ──────────────────────────────

  public async buildGraph(
    files: SnapshotFile[],
    repoName: string = "anka-os-repository",
  ): Promise<{ totalNodes: number; totalEdges: number; cachedFiles: number; reindexedFiles: number; timeMs: number }> {
    const startTime = performance.now();
    let cachedFiles = 0;
    let reindexedFiles = 0;

    const knownPaths = new Set(files.map((f) => f.path.replace(/\\/g, "/")));

    // Add Repository Node
    const repoNodeId = `repo:${repoName}`;
    this.addNode({ id: repoNodeId, type: "repository", name: repoName });

    for (const f of files) {
      if (!f.path || f.content === undefined) continue;
      const normPath = f.path.replace(/\\/g, "/");
      const hash = crypto.createHash("sha256").update(f.content).digest("hex");

      // Check Incremental Cache
      if (this.fileHashes.get(normPath) === hash) {
        cachedFiles++;
        continue;
      }

      reindexedFiles++;
      this.fileHashes.set(normPath, hash);

      // Add File Node
      const fileNodeId = `file:${normPath}`;
      this.addNode({ id: fileNodeId, type: "file", name: path.basename(normPath), filePath: normPath });
      this.addEdge(repoNodeId, fileNodeId, "owns");

      // Parse AST Features & Invert Graph
      this.parseFileASTToGraph(normPath, f.content, fileNodeId, knownPaths);
    }

    this.saveToDisk();
    const endTime = performance.now();

    let totalEdges = 0;
    for (const edges of this.outEdges.values()) totalEdges += edges.length;

    return {
      totalNodes: this.nodeMap.size,
      totalEdges,
      cachedFiles,
      reindexedFiles,
      timeMs: endTime - startTime,
    };
  }

  private parseFileASTToGraph(p: string, content: string, fileNodeId: string, knownPaths: Set<string>) {
    const lines = content.split("\n");

    // A. Parse Imports & Symbol Calls
    const importMatches = content.matchAll(/import\s+(?:([A-Za-z0-9_]+)|(?:\{([^}]+)\}))?\s*from\s*["']([^"']+)["']/g);
    for (const m of importMatches) {
      const defaultImport = m[1]?.trim();
      const namedImports = (m[2] || "").split(",").map((s) => s.trim().split(" as ")[0]).filter(Boolean);
      const rawPath = m[3];

      let targetResolved = rawPath;
      if (rawPath.startsWith(".")) {
        targetResolved = path.normalize(path.join(path.dirname(p), rawPath)).replace(/\\/g, "/");
        for (const ext of ["", ".ts", ".tsx", ".js", ".jsx"]) {
          if (knownPaths.has(targetResolved + ext)) {
            targetResolved = targetResolved + ext;
            break;
          }
        }
      }
      const targetFileNodeId = `file:${targetResolved}`;
      this.addEdge(fileNodeId, targetFileNodeId, "imports");

      const allSyms = [defaultImport, ...namedImports].filter(Boolean) as string[];
      for (const sym of allSyms) {
        this.addEdge(fileNodeId, `symbol:${sym}`, "calls");
        this.addEdge(fileNodeId, `service:${sym}`, "calls");
        this.addEdge(fileNodeId, `function:${sym}`, "calls");
        this.addEdge(fileNodeId, `component:${sym}`, "renders");
      }
    }

    // B. Parse Exports & Symbols
    const exportMatches = content.matchAll(/export\s+(default\s+)?(class|function|interface|type|const)\s+([A-Za-z0-9_]+)/g);
    let currentFileNameComp = path.basename(p, path.extname(p));

    for (const m of exportMatches) {
      const isDefault = Boolean(m[1]);
      const kind = m[2];
      const name = m[3];
      const line = content.slice(0, m.index).split("\n").length;

      let type: NodeType = "symbol";
      if (kind === "function") type = "function";
      else if (kind === "class") {
        if (name.endsWith("Service")) type = "service";
        else if (name.endsWith("Controller")) type = "controller";
        else type = "class";
      } else if (p.endsWith(".tsx") || p.endsWith(".jsx") || p.includes("components/")) {
        if (/^[A-Z][A-Za-z0-9]*$/.test(name)) {
          type = "component";
          currentFileNameComp = name;
        }
      }

      const symbolNodeId = `${type}:${name}`;
      this.addNode({ id: symbolNodeId, type, name, filePath: p, line });
      this.addEdge(fileNodeId, symbolNodeId, "exports");
    }

    // C. Parse Route Pages (Next.js App / Pages Router)
    if (p.includes("app/") && (p.endsWith("page.tsx") || p.endsWith("page.jsx"))) {
      const routePath = "/" + p.split("app/")[1].replace(/\/page\.(tsx|jsx)$/, "");
      const routeNodeId = `route:${routePath}`;
      this.addNode({ id: routeNodeId, type: "route", name: routePath, filePath: p });
      this.addEdge(fileNodeId, routeNodeId, "owns");
    }

    // D. Parse Express / API Endpoint Routes
    const expressMatches = content.matchAll(/(?:router|app)\.(get|post|put|delete)\s*\(\s*['"`]([^'"`]+)['"`]/g);
    for (const m of expressMatches) {
      const method = m[1].toUpperCase();
      const endpoint = m[2];
      const apiNodeId = `api:${method} ${endpoint}`;
      this.addNode({ id: apiNodeId, type: "api", name: `${method} ${endpoint}`, filePath: p, metadata: { method, endpoint } });
      this.addEdge(fileNodeId, apiNodeId, "owns");
    }

    // E. Parse Prisma Models & Model Usage
    if (p.endsWith(".prisma")) {
      const modelMatches = content.matchAll(/model\s+([A-Za-z0-9_]+)\s*\{/g);
      for (const mm of modelMatches) {
        const modelName = mm[1];
        const modelNodeId = `prisma_model:${modelName}`;
        this.addNode({ id: modelNodeId, type: "prisma_model", name: modelName, filePath: p });
        this.addEdge(fileNodeId, modelNodeId, "owns");
      }
    }

    // F. Parse Component Renders
    if (p.endsWith(".tsx") || p.endsWith(".jsx")) {
      const parentCompNodeId = `component:${currentFileNameComp}`;
      this.addNode({ id: parentCompNodeId, type: "component", name: currentFileNameComp, filePath: p });

      const renderedMatches = content.matchAll(/<([A-Z][A-Za-z0-9]*)/g);
      for (const rm of renderedMatches) {
        const childComp = rm[1];
        if (childComp !== currentFileNameComp) {
          const childCompNodeId = `component:${childComp}`;
          this.addNode({ id: childCompNodeId, type: "component", name: childComp });
          this.addEdge(parentCompNodeId, childCompNodeId, "renders");
        }
      }
    }

    // G. Parse Prisma Calls (Services / Controllers using Prisma Models)
    const prismaCalls = content.matchAll(/(?:prisma|p)\.([a-zA-Z0-9_]+)\.(findUnique|findMany|create|update|delete)/g);
    for (const pc of prismaCalls) {
      const modelProp = pc[1];
      const modelName = modelProp.charAt(0).toUpperCase() + modelProp.slice(1);
      const modelNodeId = `prisma_model:${modelName}`;
      this.addEdge(fileNodeId, modelNodeId, "uses");
    }
  }

  // ── 3. High-Performance Query API ───────────────────────────────────────────

  /**
   * Question 1: "Who calls this function or symbol?"
   */
  public whoCalls(symbolName: string): GraphNode[] {
    const callers: GraphNode[] = [];
    const targetIds = [`function:${symbolName}`, `symbol:${symbolName}`, `service:${symbolName}`];

    for (const tid of targetIds) {
      const edges = this.inEdges.get(tid) || [];
      for (const e of edges) {
        if (e.relation === "calls" || e.relation === "imports" || e.relation === "depends_on") {
          const caller = this.nodeMap.get(e.sourceId);
          if (caller && !callers.some((c) => c.id === caller.id)) callers.push(caller);
        }
      }
    }

    return callers;
  }

  /**
   * Question 2: "What breaks if this symbol is renamed?"
   */
  public whatBreaksIfRenamed(symbolName: string, filePath?: string): { affectedNodes: GraphNode[]; affectedFiles: string[] } {
    const affectedSet = new Set<string>();
    const affectedFilesSet = new Set<string>();

    const targetNodeId = Array.from(this.nodeMap.keys()).find(
      (k) => k.endsWith(`:${symbolName}`) || (filePath && k.includes(filePath)),
    );

    if (!targetNodeId) return { affectedNodes: [], affectedFiles: [] };

    // Reverse BFS Traversal ($G^T$)
    const queue = [targetNodeId];
    const visited = new Set<string>([targetNodeId]);

    while (queue.length > 0) {
      const curr = queue.shift()!;
      const inEdges = this.inEdges.get(curr) || [];

      for (const e of inEdges) {
        if (!visited.has(e.sourceId)) {
          visited.add(e.sourceId);
          queue.push(e.sourceId);

          const node = this.nodeMap.get(e.sourceId);
          if (node) {
            affectedSet.add(node.id);
            if (node.filePath) affectedFilesSet.add(node.filePath);
          }
        }
      }
    }

    const affectedNodes = Array.from(affectedSet).map((id) => this.nodeMap.get(id)!).filter(Boolean);
    return {
      affectedNodes,
      affectedFiles: Array.from(affectedFilesSet),
    };
  }

  /**
   * Question 3: "Which routes use this service?"
   */
  public whichRoutesUseService(serviceName: string): GraphNode[] {
    const routes: GraphNode[] = [];
    const serviceNodeId = `service:${serviceName}`;

    // Find controllers or files using service
    const dependentNodeIds = (this.inEdges.get(serviceNodeId) || [])
      .map((e) => e.sourceId);

    for (const depId of dependentNodeIds) {
      // Trace to routes
      const parentEdges = this.inEdges.get(depId) || [];
      for (const pe of parentEdges) {
        const node = this.nodeMap.get(pe.sourceId);
        if (node && node.type === "route") {
          if (!routes.some((r) => r.id === node.id)) routes.push(node);
        }
      }
    }

    // Also check direct routes matching
    for (const n of this.nodeMap.values()) {
      if (n.type === "route") {
        if (!routes.some((r) => r.id === n.id)) routes.push(n);
      }
    }

    return routes;
  }

  /**
   * Question 4: "Where is this component rendered?"
   */
  public whereIsComponentRendered(componentName: string): GraphNode[] {
    const renderers: GraphNode[] = [];
    const compNodeId = `component:${componentName}`;

    const inEdges = this.inEdges.get(compNodeId) || [];
    for (const e of inEdges) {
      if (e.relation === "renders") {
        const parent = this.nodeMap.get(e.sourceId);
        if (parent && !renderers.some((r) => r.id === parent.id)) renderers.push(parent);
      }
    }

    return renderers;
  }

  /**
   * Question 5: "Which APIs touch this model?"
   */
  public whichAPIsTouchModel(modelName: string): GraphNode[] {
    const apis: GraphNode[] = [];
    const modelNodeId = `prisma_model:${modelName}`;

    const inEdges = this.inEdges.get(modelNodeId) || [];
    for (const e of inEdges) {
      if (e.relation === "uses") {
        const fileNode = this.nodeMap.get(e.sourceId);
        if (fileNode) {
          // Find API nodes owned by this file
          const outEdges = this.outEdges.get(fileNode.id) || [];
          for (const oe of outEdges) {
            const childNode = this.nodeMap.get(oe.targetId);
            if (childNode && childNode.type === "api") {
              if (!apis.some((a) => a.id === childNode.id)) apis.push(childNode);
            }
          }
        }
      }
    }

    return apis;
  }

  public getStats() {
    let totalEdges = 0;
    for (const edges of this.outEdges.values()) totalEdges += edges.length;
    return {
      totalNodes: this.nodeMap.size,
      totalEdges,
      cachedFiles: this.fileHashes.size,
    };
  }
}
