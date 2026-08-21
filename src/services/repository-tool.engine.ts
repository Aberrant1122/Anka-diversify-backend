import fs from "fs";
import path from "path";
import { SemanticRetrievalEngine } from "./semantic-retrieval.engine";

// ─── Result Types ─────────────────────────────────────────────────────────────

export interface RankedSearchResult {
  filePath: string;
  symbolName?: string;
  relevanceScore: number;
  confidenceScore: number;
  rankingReason: string;
  snippet: string;
  location: { startLine: number; endLine: number };
  dependencies: string[];
}

export interface FileContentResult {
  filePath: string;
  content: string;
  totalLines: number;
  found: boolean;
}

export interface RouteDiscoveryResult {
  routes: Array<{
    path: string;
    file: string;
    httpMethod?: string;
    relevanceScore: number;
    rankingReason: string;
  }>;
}

export interface ComponentDiscoveryResult {
  components: Array<{
    componentName: string;
    file: string;
    exportKind: string;
    isReachable: boolean;
    relevanceScore: number;
    snippet: string;
  }>;
}

export interface ServiceDiscoveryResult {
  services: Array<{
    serviceName: string;
    filePath: string;
    methods: string[];
    relevanceScore: number;
    snippet: string;
    rankingReason: string;
  }>;
}

export interface ApiDiscoveryResult {
  endpoints: Array<{
    pattern: string;
    file: string;
    httpMethod?: string;
    relevanceScore: number;
    snippet: string;
  }>;
}

export interface DatabaseModelResult {
  models: Array<{
    modelName: string;
    filePath: string;
    fields: string[];
    relevanceScore: number;
    snippet: string;
  }>;
}

export interface SymbolReferencesResult {
  references: Array<{
    file: string;
    line: number;
    context: string;
    referenceType: "import" | "call" | "render" | "definition";
    relevanceScore: number;
  }>;
}

export interface ArchitectureSearchResult {
  results: Array<{
    file: string;
    layer: string;
    description: string;
    snippet: string;
    relevanceScore: number;
    rankingReason: string;
  }>;
}

// ─── Symbol Normalizer Engine ───────────────────────────────────────────────

export class SymbolNormalizer {
  /**
   * Tokenize string across camelCase, PascalCase, snake_case, kebab-case, dot.case, and spaces.
   * e.g. "AIService", "AiService", "ai-service", "ai_service", "ai service", "ai.service"
   * ALL produce tokens: ["ai", "service"]
   */
  static tokenize(input: string): string[] {
    if (!input) return [];

    // Step 1: Replace non-alphanumeric delimiters with spaces
    let s = String(input).replace(/[-_./\\:@#]/g, " ");

    // Step 2: Split camelCase and PascalCase boundaries
    s = s.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
    s = s.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");

    // Step 3: Convert to lowercase tokens
    return s
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 0);
  }

  /**
   * Produce canonical normalized representation.
   * "AIService", "AiService", "ai-service", "ai_service", "ai service", "ai.service" -> "aiservice"
   */
  static canonical(input: string): string {
    return SymbolNormalizer.tokenize(input).join("");
  }
}

// ─── Multi-Tier Ranking & Scoring Engine ──────────────────────────────────────

export interface MatchEvaluation {
  score: number;
  confidence: number;
  matchType: "EXACT" | "NORMALIZED" | "PREFIX" | "SUBSTRING" | "TOKEN_SIMILARITY" | "NO_MATCH";
  reason: string;
}

export class ScoringEngine {
  static evaluate(target: string, query: string, contextBonus = 0): MatchEvaluation {
    if (!target || !query) {
      return { score: 0, confidence: 0, matchType: "NO_MATCH", reason: "Empty target or query" };
    }

    const tRaw = String(target).trim();
    const qRaw = String(query).trim();

    // 1. Exact Match
    if (tRaw === qRaw) {
      const score = Math.min(1.0, 1.0 + contextBonus);
      return { score, confidence: 1.0, matchType: "EXACT", reason: `Exact string match ("${tRaw}")` };
    }

    const cTarget = SymbolNormalizer.canonical(target);
    const cQuery = SymbolNormalizer.canonical(query);

    if (!cTarget || !cQuery) {
      return { score: 0, confidence: 0, matchType: "NO_MATCH", reason: "Failed normalization" };
    }

    // 2. Normalized Match
    if (cTarget === cQuery) {
      const score = Math.min(1.0, 0.95 + contextBonus);
      return { score, confidence: 0.95, matchType: "NORMALIZED", reason: `Normalized symbol match ("${cTarget}")` };
    }

    // 3. Prefix Match
    if (cTarget.startsWith(cQuery)) {
      const ratio = cQuery.length / cTarget.length;
      const score = Math.min(1.0, 0.80 + ratio * 0.10 + contextBonus);
      return { score, confidence: 0.85, matchType: "PREFIX", reason: `Prefix match ("${cQuery}" in "${cTarget}")` };
    }

    // 4. Substring Match
    if (cTarget.includes(cQuery)) {
      const ratio = cQuery.length / cTarget.length;
      const score = Math.min(1.0, 0.65 + ratio * 0.10 + contextBonus);
      return { score, confidence: 0.75, matchType: "SUBSTRING", reason: `Substring match ("${cQuery}" in "${cTarget}")` };
    }

    // 5. Token Similarity (Jaccard Index)
    const tTokens = SymbolNormalizer.tokenize(target);
    const qTokens = SymbolNormalizer.tokenize(query);
    const tSet = new Set(tTokens);

    const intersection = qTokens.filter((tok) => tSet.has(tok));
    const unionSize = new Set([...qTokens, ...tTokens]).size;

    if (intersection.length > 0) {
      const jaccard = intersection.length / Math.max(1, unionSize);
      const overlapRatio = intersection.length / qTokens.length;

      const score = Math.min(1.0, 0.20 + jaccard * 0.50 + overlapRatio * 0.20 + contextBonus);
      const confidence = Math.min(0.80, 0.40 + jaccard * 0.40);

      return {
        score,
        confidence,
        matchType: "TOKEN_SIMILARITY",
        reason: `Matched ${intersection.length}/${qTokens.length} query tokens [${intersection.join(", ")}]`,
      };
    }

    return { score: 0, confidence: 0, matchType: "NO_MATCH", reason: "No matching tokens" };
  }
}

// ─── Multi-Graph Index Engine ────────────────────────────────────────────────

interface SnapshotFile {
  path: string;
  content?: string;
}

export interface SymbolIndexEntry {
  symbolName: string;
  normalizedName: string;
  tokens: string[];
  file: string;
  line: number;
  kind: "class" | "function" | "interface" | "type" | "const" | "enum" | "method";
  exportKind: "default" | "named" | "none";
  snippet: string;
}

export interface FileIndexEntry {
  path: string;
  normalizedPath: string;
  baseName: string;
  normalizedBaseName: string;
  tokens: string[];
  extension: string;
  content: string;
  lines: string[];
  layer: "presentation" | "business" | "data" | "middleware" | "utility" | "unknown";
}

export interface ComponentGraphNode {
  name: string;
  normalizedName: string;
  file: string;
  exportKind: string;
  whoImportsIt: Array<{ file: string; symbols: string[] }>;
  whoRendersIt: Array<{ file: string; parentComponent: string; jsxTag: string }>;
  whichRouteOwnsIt: { routeFile: string; routePath: string } | null;
  isReachable: boolean;
  reachabilityReason: string;
  snippet: string;
}

export interface RouteGraphNode {
  path: string;
  normalizedPath: string;
  file: string;
  type: "app-router" | "pages-router" | "express-route";
  httpMethod?: string;
  snippet: string;
}

export interface ApiGraphNode {
  pattern: string;
  normalizedPattern: string;
  file: string;
  httpMethod?: string;
  snippet: string;
}

export interface PrismaModelGraphNode {
  name: string;
  normalizedName: string;
  file: string;
  fields: Array<{ name: string; type: string; isId: boolean }>;
  snippet: string;
}

export class MultiGraphIndex {
  public filesMap: Map<string, FileIndexEntry> = new Map();
  public symbolIndex: SymbolIndexEntry[] = [];
  public canonicalSymbolMap: Map<string, SymbolIndexEntry[]> = new Map();
  public tokenToSymbols: Map<string, SymbolIndexEntry[]> = new Map();

  public importGraph: Map<string, Array<{ source: string; symbols: string[] }>> = new Map();
  public exportGraph: Map<string, SymbolIndexEntry[]> = new Map();

  public componentGraph: Map<string, ComponentGraphNode> = new Map();
  public routeGraph: RouteGraphNode[] = [];
  public apiGraph: ApiGraphNode[] = [];
  public prismaModelGraph: PrismaModelGraphNode[] = [];

  constructor(snapshotFiles: SnapshotFile[], knowledgeGraph?: any) {
    this.buildIndices(snapshotFiles, knowledgeGraph);
  }

  private buildIndices(rawFiles: SnapshotFile[], knowledgeGraph?: any) {
    // 1. Build File Index
    for (const rf of rawFiles) {
      if (!rf.path) continue;
      const p = rf.path.replace(/\\/g, "/");
      const content = rf.content || "";
      const baseName = path.basename(p);
      const ext = path.extname(p).replace(".", "").toLowerCase();
      const lines = content.split("\n");

      let layer: FileIndexEntry["layer"] = "unknown";
      if (/components\/|pages\/|app\/|\.tsx$|\.jsx$/.test(p)) layer = "presentation";
      else if (/services\/|\.service\.ts$/.test(p)) layer = "business";
      else if (/prisma|schema|repository|models?|database/.test(p)) layer = "data";
      else if (/middleware|guards?|auth/.test(p)) layer = "middleware";
      else if (/utils\/|lib\/|helpers\//.test(p)) layer = "utility";

      const fileEntry: FileIndexEntry = {
        path: p,
        normalizedPath: SymbolNormalizer.canonical(p),
        baseName,
        normalizedBaseName: SymbolNormalizer.canonical(baseName),
        tokens: SymbolNormalizer.tokenize(p),
        extension: ext,
        content,
        lines,
        layer,
      };

      this.filesMap.set(p, fileEntry);
    }

    // 2. Build Export & Symbol Index + Import Graph
    for (const [p, fe] of this.filesMap.entries()) {
      const content = fe.content;
      const fileImports: Array<{ source: string; symbols: string[] }> = [];

      // Extract imports
      const importMatches = content.matchAll(
        /import\s+(?:\{([^}]+)\}|([A-Za-z0-9_]+))\s+from\s+["']([^"']+)["']/g,
      );
      for (const match of importMatches) {
        const namedSymbols = match[1] ? match[1].split(",").map((s) => s.trim().split(" as ")[0]) : [];
        const defaultSymbol = match[2] ? [match[2].trim()] : [];
        const importedSymbols = [...defaultSymbol, ...namedSymbols].filter(Boolean);
        const source = match[3];

        fileImports.push({ source, symbols: importedSymbols });
      }
      this.importGraph.set(p, fileImports);

      // Extract exports
      const exportMatches = content.matchAll(
        /export\s+(default\s+)?(interface|class|function|type|enum|const)\s+([A-Za-z0-9_]+)/g,
      );
      const fileExports: SymbolIndexEntry[] = [];

      for (const match of exportMatches) {
        const isDefault = Boolean(match[1]);
        const kind = match[2] as SymbolIndexEntry["kind"];
        const symName = match[3];

        const charIdx = match.index ?? 0;
        const line = fe.content.slice(0, charIdx).split("\n").length;
        const snippet = fe.lines.slice(Math.max(0, line - 1), line + 15).join("\n");

        const tokens = SymbolNormalizer.tokenize(symName);
        const canonicalName = SymbolNormalizer.canonical(symName);

        const symEntry: SymbolIndexEntry = {
          symbolName: symName,
          normalizedName: canonicalName,
          tokens,
          file: p,
          line,
          kind,
          exportKind: isDefault ? "default" : "named",
          snippet,
        };

        fileExports.push(symEntry);
        this.symbolIndex.push(symEntry);

        // Map by canonical symbol
        if (!this.canonicalSymbolMap.has(canonicalName)) {
          this.canonicalSymbolMap.set(canonicalName, []);
        }
        this.canonicalSymbolMap.get(canonicalName)!.push(symEntry);

        // Map by tokens
        for (const tok of tokens) {
          if (!this.tokenToSymbols.has(tok)) {
            this.tokenToSymbols.set(tok, []);
          }
          this.tokenToSymbols.get(tok)!.push(symEntry);
        }
      }

      this.exportGraph.set(p, fileExports);
    }

    // 3. Build Component Graph
    for (const sym of this.symbolIndex) {
      const isPascal = /^[A-Z][A-Za-z0-9]*$/.test(sym.symbolName);
      const isUIFile = sym.file.includes("components") || sym.file.endsWith(".tsx") || sym.file.endsWith(".jsx") || sym.file.includes("app/") || sym.file.includes("pages/");

      if (isPascal && isUIFile && (sym.kind === "function" || sym.kind === "const" || sym.kind === "class")) {
        const compNode: ComponentGraphNode = {
          name: sym.symbolName,
          normalizedName: sym.normalizedName,
          file: sym.file,
          exportKind: sym.exportKind,
          whoImportsIt: [],
          whoRendersIt: [],
          whichRouteOwnsIt: null,
          isReachable: false,
          reachabilityReason: "",
          snippet: sym.snippet,
        };

        this.componentGraph.set(sym.symbolName, compNode);
      }
    }

    // Cross-link Who Imports / Who Renders (reuse knowledgeGraph when available)
    if (knowledgeGraph && knowledgeGraph.componentNodes) {
      for (const [name, node] of Object.entries(knowledgeGraph.componentNodes as Record<string, any>)) {
        if (!this.componentGraph.has(name)) {
          const compNode: ComponentGraphNode = {
            name: node.component || name,
            normalizedName: SymbolNormalizer.canonical(node.component || name),
            file: node.file,
            exportKind: node.exportKind || "named",
            whoImportsIt: (node.whoImportsIt || []).map((i: any) => ({ file: i.file, symbols: i.importedSymbols || [] })),
            whoRendersIt: node.whoRendersIt || [],
            whichRouteOwnsIt: node.whichRouteOwnsIt || null,
            isReachable: Boolean(node.isReachable),
            reachabilityReason: node.reachabilityReason || "",
            snippet: `component ${node.component || name} in ${node.file}`,
          };
          this.componentGraph.set(name, compNode);
        } else {
          const existing = this.componentGraph.get(name)!;
          if (node.whoImportsIt && node.whoImportsIt.length > 0 && existing.whoImportsIt.length === 0) {
            existing.whoImportsIt = node.whoImportsIt.map((i: any) => ({ file: i.file, symbols: i.importedSymbols || [] }));
          }
          if (node.whoRendersIt && node.whoRendersIt.length > 0 && existing.whoRendersIt.length === 0) {
            existing.whoRendersIt = node.whoRendersIt;
          }
          if (node.whichRouteOwnsIt) existing.whichRouteOwnsIt = node.whichRouteOwnsIt;
          existing.isReachable = Boolean(node.isReachable);
          if (node.reachabilityReason) existing.reachabilityReason = node.reachabilityReason;
        }
      }
    } else {
      // Fallback regex cross-link loop when knowledgeGraph is not supplied
      for (const [p, fe] of this.filesMap.entries()) {
        for (const node of this.componentGraph.values()) {
          if (node.file === p) continue;

          if (fe.content.includes(node.name)) {
            if (fe.content.includes(`import`) && fe.content.includes(node.name)) {
              node.whoImportsIt.push({ file: p, symbols: [node.name] });
            }

            const jsxRegex = new RegExp(`<${node.name}(\\s|>|\\/)`);
            if (jsxRegex.test(fe.content)) {
              node.whoRendersIt.push({
                file: p,
                parentComponent: fe.baseName,
                jsxTag: `<${node.name}>`,
              });
            }
          }
        }
      }
    }

    // 4. Build Route Graph
    for (const [p, fe] of this.filesMap.entries()) {
      const isAppRoute = p.includes("app/") && (p.endsWith("page.tsx") || p.endsWith("page.jsx") || p.endsWith("page.js"));
      const isPagesRoute = p.includes("pages/") && !p.includes("pages/api/") && !p.includes("_app") && !p.includes("_document");

      if (isAppRoute || isPagesRoute) {
        let routePath = "";
        if (isAppRoute) {
          routePath = "/" + (p.split("app/")[1]?.replace(/\/page\.(tsx|jsx|js)$/, "") || "");
        } else {
          routePath = "/" + (p.split("pages/")[1]?.replace(/\.(tsx|jsx|js)$/, "") || "");
          if (routePath === "/index") routePath = "/";
        }

        const routeNode: RouteGraphNode = {
          path: routePath,
          normalizedPath: SymbolNormalizer.canonical(routePath),
          file: p,
          type: isAppRoute ? "app-router" : "pages-router",
          snippet: fe.lines.slice(0, 15).join("\n"),
        };

        this.routeGraph.push(routeNode);
      }
    }

    // Connect component ownership and reachability
    for (const node of this.componentGraph.values()) {
      const directRoute = this.routeGraph.find((r) => r.file === node.file);
      if (directRoute) {
        node.whichRouteOwnsIt = { routeFile: directRoute.file, routePath: directRoute.path };
        node.isReachable = true;
        node.reachabilityReason = `Directly owned by route "${directRoute.path}"`;
      } else if (node.whoRendersIt.length > 0) {
        node.isReachable = true;
        node.reachabilityReason = `Rendered by ${node.whoRendersIt.map((r) => r.parentComponent).join(", ")}`;
      } else if (node.whoImportsIt.length > 0) {
        node.isReachable = true;
        node.reachabilityReason = `Imported by ${node.whoImportsIt.map((i) => path.basename(i.file)).join(", ")}`;
      } else {
        node.isReachable = false;
        node.reachabilityReason = `Orphan component (not imported or rendered)`;
      }
    }

    // 5. Build API Graph
    for (const [p, fe] of this.filesMap.entries()) {
      const content = fe.content;
      const expressMatches = content.matchAll(
        /(?:router|app)\.(get|post|put|patch|delete|use)\s*\(\s*['"`]([^'"`]+)['"`]/g,
      );

      for (const m of expressMatches) {
        const httpMethod = m[1].toUpperCase();
        const pattern = m[2];
        this.apiGraph.push({
          pattern,
          normalizedPattern: SymbolNormalizer.canonical(pattern),
          file: p,
          httpMethod,
          snippet: fe.lines.slice(Math.max(0, fe.lines.findIndex((l) => l.includes(m[0]))), 15).join("\n"),
        });
      }

      if (p.includes("pages/api/") || (p.includes("app/api/") && p.endsWith("route.ts"))) {
        const routePath = p.includes("pages/api/")
          ? "/" + p.split("pages/api/")[1].replace(/\.(ts|js|tsx)$/, "")
          : "/" + p.split("app/")[1].replace(/\/route\.(ts|js)$/, "");

        this.apiGraph.push({
          pattern: routePath,
          normalizedPattern: SymbolNormalizer.canonical(routePath),
          file: p,
          snippet: fe.lines.slice(0, 15).join("\n"),
        });
      }
    }

    // 6. Build Prisma Model Graph
    for (const [p, fe] of this.filesMap.entries()) {
      if (p.endsWith(".prisma")) {
        const modelBlocks = fe.content.matchAll(/model\s+([A-Za-z0-9_]+)\s*\{([^}]+)\}/g);
        for (const block of modelBlocks) {
          const name = block[1];
          const body = block[2];
          const fields = body
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l && !l.startsWith("//") && !l.startsWith("@@"))
            .map((l) => {
              const parts = l.split(/\s+/);
              return { name: parts[0], type: parts[1] || "", isId: l.includes("@id") };
            })
            .filter((f) => f.name);

          this.prismaModelGraph.push({
            name,
            normalizedName: SymbolNormalizer.canonical(name),
            file: p,
            fields,
            snippet: `model ${name} {${body}}`,
          });
        }
      } else if (fe.extension === "ts" && (p.includes("type") || p.includes("interface") || p.includes("model"))) {
        const interfaceMatches = fe.content.matchAll(/(?:export\s+)?(?:interface|type)\s+([A-Za-z0-9_]+)/g);
        for (const m of interfaceMatches) {
          const name = m[1];
          this.prismaModelGraph.push({
            name,
            normalizedName: SymbolNormalizer.canonical(name),
            file: p,
            fields: [],
            snippet: fe.lines.slice(Math.max(0, fe.lines.findIndex((l) => l.includes(m[0]))), 15).join("\n"),
          });
        }
      }
    }
  }
}

// ─── Helper Utilities ─────────────────────────────────────────────────────────

function extractLines(content: string, start: number, end: number): string {
  const lines = content.split("\n");
  return lines.slice(Math.max(0, start - 1), Math.min(lines.length, end)).join("\n");
}

function extractImports(content: string): string[] {
  const matches = content.matchAll(/import\s+[^'"]*from\s+['"]([^'"]+)['"]/g);
  const deps: string[] = [];
  for (const m of matches) deps.push(m[1]);
  return deps;
}

export function scanDirectoryFiles(dirPath: string, rootDir = dirPath): SnapshotFile[] {
  if (!dirPath || !fs.existsSync(dirPath)) return [];
  const results: SnapshotFile[] = [];
  const ignoreDirs = new Set([
    "node_modules", ".git", ".next", "dist", "build", ".anka-cache",
    ".gemini", "coverage", "tmp", ".turbo", ".idea", ".vscode", "out"
  ]);

  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        if (!ignoreDirs.has(entry.name)) {
          results.push(...scanDirectoryFiles(fullPath, rootDir));
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        const validExts = [
          ".ts", ".tsx", ".js", ".jsx", ".json", ".css", ".scss",
          ".prisma", ".py", ".go", ".rs", ".md", ".sql", ".html"
        ];
        if (validExts.includes(ext) && entry.name !== "package-lock.json" && entry.name !== "yarn.lock") {
          try {
            const relPath = path.relative(rootDir, fullPath).replace(/\\/g, "/");
            const content = fs.readFileSync(fullPath, "utf8");
            results.push({ path: relPath, content });
          } catch {}
        }
      }
    }
  } catch {}

  return results;
}

/**
 * Merge disk files and snapshot files with DISK-FIRST precedence.
 *
 * Algorithm:
 *   1. Scan all candidateDirs (local workspace) and insert every file unconditionally.
 *   2. Walk snapshot entries; only insert when the normalised path is NOT already
 *      present (i.e. snapshot is a fallback for files unavailable locally).
 *
 * This ensures the local workspace is always authoritative. A stale DB snapshot
 * can never silently override an on-disk edit.
 */
export function mergeFilesWithDiskPriority(
  candidateDirs: string[],
  snapshotList: SnapshotFile[],
): SnapshotFile[] {
  const fileMap = new Map<string, SnapshotFile>();

  // ── 1. Disk first (authoritative) ─────────────────────────────────────────
  for (const cDir of candidateDirs) {
    const diskFiles = scanDirectoryFiles(cDir);
    for (const df of diskFiles) {
      const norm = df.path.replace(/\\/g, "/");
      fileMap.set(norm, { path: norm, content: df.content || "" });
    }
  }

  // ── 2. Snapshot fallback (only for paths not on disk) ─────────────────────
  for (const f of snapshotList) {
    if (f && f.path && typeof f.content === "string") {
      const norm = f.path.replace(/\\/g, "/");
      if (!fileMap.has(norm)) {
        fileMap.set(norm, { path: norm, content: f.content });
      }
    }
  }

  return Array.from(fileMap.values());
}

function getSnapshotFiles(snapshot: any, localPath?: string | null): SnapshotFile[] {
  // Collect snapshot entries
  const snapshotList: SnapshotFile[] = [];
  if (snapshot) {
    let list: SnapshotFile[] = [];
    if (Array.isArray(snapshot)) list = snapshot as SnapshotFile[];
    else if (Array.isArray(snapshot.keyFiles)) list = snapshot.keyFiles as SnapshotFile[];
    else if (Array.isArray(snapshot.repoSnapshot)) list = snapshot.repoSnapshot as SnapshotFile[];
    for (const f of list) {
      if (f && f.path && typeof f.content === "string") {
        snapshotList.push(f);
      }
    }
  }

  // Collect candidate directories for disk scanning.
  // ISOLATION RULE: only scan the explicitly-supplied localPath.
  // We intentionally do NOT fall back to process.cwd() or its parent,
  // which would cause the engine to mix in sibling projects or the ANKA
  // backend source directory itself.
  const candidateDirs: string[] = [];
  if (localPath && fs.existsSync(localPath)) {
    candidateDirs.push(localPath);
  }

  return mergeFilesWithDiskPriority(candidateDirs, snapshotList);
}

// ─── Production-Grade Repository Tool Engine ──────────────────────────────────

export class RepositoryToolEngine {
  private index: MultiGraphIndex;
  private rawFiles: SnapshotFile[];
  private semanticRetrievalEngine: SemanticRetrievalEngine;

  constructor(snapshot: any, localPath?: string | null, knowledgeGraph?: any) {
    this.rawFiles = getSnapshotFiles(snapshot, localPath);
    this.index = new MultiGraphIndex(this.rawFiles, knowledgeGraph);
    this.semanticRetrievalEngine = new SemanticRetrievalEngine();
  }

  // ── Tool 1: Read File ────────────────────────────────────────────────────────
  readFile(params: { filePath: string; startLine?: number; endLine?: number }): FileContentResult {
    const { filePath, startLine, endLine } = params || {};
    if (!filePath) return { filePath: "", content: "", totalLines: 0, found: false };

    const norm = filePath.replace(/\\/g, "/");
    let match = this.index.filesMap.get(norm);

    if (!match) {
      for (const [p, fe] of this.index.filesMap.entries()) {
        if (p.endsWith(norm) || fe.normalizedPath.endsWith(SymbolNormalizer.canonical(norm))) {
          match = fe;
          break;
        }
      }
    }

    if (!match) {
      return { filePath, content: "", totalLines: 0, found: false };
    }

    const sl = startLine ?? 1;
    const el = endLine ?? match.lines.length;
    const slice = extractLines(match.content, sl, el);

    return { filePath: match.path, content: slice, totalLines: match.lines.length, found: true };
  }

  // ── Tool 2: Find Route ───────────────────────────────────────────────────────
  findRoute(params: { pathPattern: string; httpMethod?: string }): RouteDiscoveryResult {
    const { pathPattern, httpMethod } = params || {};
    if (!pathPattern) return { routes: [] };

    const results: RouteDiscoveryResult["routes"] = [];

    for (const rNode of this.index.routeGraph) {
      const evalRes = ScoringEngine.evaluate(rNode.path + " " + rNode.file, pathPattern);
      if (evalRes.score < 0.1) continue;

      let methodScore = 1.0;
      if (httpMethod && rNode.httpMethod) {
        methodScore = rNode.httpMethod.toUpperCase() === httpMethod.toUpperCase() ? 1.0 : 0.4;
      }

      results.push({
        path: rNode.path,
        file: rNode.file,
        httpMethod,
        relevanceScore: evalRes.score * methodScore,
        rankingReason: `${evalRes.reason} (${rNode.type})`,
      });
    }

    // Also check API graph for route pattern matches
    for (const apiNode of this.index.apiGraph) {
      const evalRes = ScoringEngine.evaluate(apiNode.pattern + " " + apiNode.file, pathPattern);
      if (evalRes.score < 0.1) continue;

      if (httpMethod && apiNode.httpMethod && apiNode.httpMethod.toUpperCase() !== httpMethod.toUpperCase()) {
        continue;
      }

      if (!results.some((r) => r.path === apiNode.pattern && r.file === apiNode.file)) {
        results.push({
          path: apiNode.pattern,
          file: apiNode.file,
          httpMethod: apiNode.httpMethod || httpMethod,
          relevanceScore: evalRes.score,
          rankingReason: `${evalRes.reason} (API Route)`,
        });
      }
    }

    results.sort((a, b) => b.relevanceScore - a.relevanceScore);
    return { routes: results.slice(0, 10) };
  }

  // ── Tool 3: Find Component ───────────────────────────────────────────────────
  findComponent(params: { componentName: string; searchScope?: string }): ComponentDiscoveryResult {
    const { componentName, searchScope } = params || {};
    if (!componentName) return { components: [] };

    const results: ComponentDiscoveryResult["components"] = [];
    const scopeNorm = searchScope ? searchScope.replace(/\\/g, "/") : "";

    for (const compNode of this.index.componentGraph.values()) {
      if (scopeNorm && !compNode.file.includes(scopeNorm)) continue;

      const evalRes = ScoringEngine.evaluate(compNode.name, componentName);
      if (evalRes.score < 0.1) continue;

      results.push({
        componentName: compNode.name,
        file: compNode.file,
        exportKind: compNode.exportKind,
        isReachable: compNode.isReachable,
        relevanceScore: evalRes.score,
        snippet: compNode.snippet,
      });
    }

    // Deduplicate by componentName + file
    const uniqueMap = new Map<string, ComponentDiscoveryResult["components"][0]>();
    for (const c of results) {
      const key = `${c.componentName}:${c.file}`;
      if (!uniqueMap.has(key) || uniqueMap.get(key)!.relevanceScore < c.relevanceScore) {
        uniqueMap.set(key, c);
      }
    }

    const unique = Array.from(uniqueMap.values());
    unique.sort((a, b) => b.relevanceScore - a.relevanceScore);
    return { components: unique.slice(0, 10) };
  }

  // ── Tool 4: Find Service ─────────────────────────────────────────────────────
  findService(params: { serviceName: string; domain?: string }): ServiceDiscoveryResult {
    const { serviceName, domain } = params || {};
    if (!serviceName) return { services: [] };

    const results: ServiceDiscoveryResult["services"] = [];

    for (const [p, fe] of this.index.filesMap.entries()) {
      const isServiceFile = p.includes("service") || p.includes("services/");
      if (!isServiceFile) continue;

      let domainBonus = 0;
      if (domain) {
        const domainEval = ScoringEngine.evaluate(p, domain);
        if (domainEval.score < 0.1) continue;
        domainBonus = 0.1;
      }

      const evalRes = ScoringEngine.evaluate(fe.baseName + " " + p, serviceName, domainBonus);
      if (evalRes.score < 0.1) continue;

      const methodMatches = fe.content.matchAll(
        /(?:public|private|protected|async)?\s+(?:async\s+)?([a-zA-Z][a-zA-Z0-9_]*)\s*\(/g,
      );
      const methods: string[] = [];
      for (const m of methodMatches) {
        if (!["if", "for", "while", "switch", "catch", "function"].includes(m[1])) {
          methods.push(m[1]);
        }
      }

      const classMatch = fe.content.match(/(?:export\s+)?class\s+([A-Za-z0-9_]+)/);
      const svcName = classMatch ? classMatch[1] : path.basename(p, path.extname(p));

      results.push({
        serviceName: svcName,
        filePath: fe.path,
        methods: [...new Set(methods)].slice(0, 20),
        relevanceScore: evalRes.score,
        snippet: fe.lines.slice(0, 25).join("\n"),
        rankingReason: `${evalRes.reason} in service file`,
      });
    }

    results.sort((a, b) => b.relevanceScore - a.relevanceScore);
    return { services: results.slice(0, 8) };
  }

  // ── Tool 5: Find API ──────────────────────────────────────────────────────────
  findAPI(params: { endpointPattern: string; method?: string }): ApiDiscoveryResult {
    const { endpointPattern, method } = params || {};
    if (!endpointPattern) return { endpoints: [] };

    const results: ApiDiscoveryResult["endpoints"] = [];

    for (const apiNode of this.index.apiGraph) {
      const evalRes = ScoringEngine.evaluate(apiNode.pattern + " " + apiNode.file, endpointPattern);
      if (evalRes.score < 0.1) continue;

      if (method && apiNode.httpMethod && apiNode.httpMethod.toUpperCase() !== method.toUpperCase()) {
        continue;
      }

      results.push({
        pattern: apiNode.pattern,
        file: apiNode.file,
        httpMethod: apiNode.httpMethod || method?.toUpperCase(),
        relevanceScore: evalRes.score,
        snippet: apiNode.snippet,
      });
    }

    results.sort((a, b) => b.relevanceScore - a.relevanceScore);
    return { endpoints: results.slice(0, 10) };
  }

  // ── Tool 6: Find Model ────────────────────────────────────────────────────────
  findModel(params: { modelName: string }): DatabaseModelResult {
    const { modelName } = params || {};
    if (!modelName) return { models: [] };

    const results: DatabaseModelResult["models"] = [];

    for (const modelNode of this.index.prismaModelGraph) {
      const evalRes = ScoringEngine.evaluate(modelNode.name + " " + modelNode.file, modelName);
      if (evalRes.score < 0.1) continue;

      results.push({
        modelName: modelNode.name,
        filePath: modelNode.file,
        fields: modelNode.fields.map((f) => f.name),
        relevanceScore: evalRes.score,
        snippet: modelNode.snippet,
      });
    }

    results.sort((a, b) => b.relevanceScore - a.relevanceScore);
    return { models: results.slice(0, 8) };
  }

  // ── Tool 7: Find References ───────────────────────────────────────────────────
  findReferences(params: { symbolName: string; sourceFilePath?: string }): SymbolReferencesResult {
    const { symbolName, sourceFilePath } = params || {};
    if (!symbolName) return { references: [] };

    const results: SymbolReferencesResult["references"] = [];
    const cSym = SymbolNormalizer.canonical(symbolName);

    for (const [p, fe] of this.index.filesMap.entries()) {
      if (!fe.content.includes(symbolName) && !SymbolNormalizer.canonical(fe.content).includes(cSym)) {
        continue;
      }

      for (let i = 0; i < fe.lines.length; i++) {
        const line = fe.lines[i];
        if (!line.includes(symbolName) && !SymbolNormalizer.canonical(line).includes(cSym)) {
          continue;
        }

        let referenceType: SymbolReferencesResult["references"][0]["referenceType"] = "call";
        if (/import\s+/.test(line)) referenceType = "import";
        else if (new RegExp(`<${symbolName}[\\s/>]`).test(line)) referenceType = "render";
        else if (new RegExp(`(?:function|class|const|interface|type)\\s+${symbolName}`).test(line)) referenceType = "definition";

        const evalRes = ScoringEngine.evaluate(line, symbolName);
        const sourceBonus = sourceFilePath && p === sourceFilePath.replace(/\\/g, "/") ? 0.2 : 0;

        results.push({
          file: fe.path,
          line: i + 1,
          context: line.trim().slice(0, 200),
          referenceType,
          relevanceScore: Math.min(1.0, evalRes.score + sourceBonus),
        });
      }
    }

    results.sort((a, b) => b.relevanceScore - a.relevanceScore || a.line - b.line);
    return { references: results.slice(0, 30) };
  }

  // ── Tool 8: Search Architecture ───────────────────────────────────────────────
  searchArchitecture(params: {
    query: string;
    layer: "presentation" | "business" | "data" | "middleware";
  }): ArchitectureSearchResult {
    const { query, layer } = params || {};
    if (!query || !layer) return { results: [] };

    const results: ArchitectureSearchResult["results"] = [];

    for (const [p, fe] of this.index.filesMap.entries()) {
      if (fe.layer !== layer && fe.layer !== "unknown") continue;

      const evalRes = ScoringEngine.evaluate(p + " " + fe.content.slice(0, 500), query);
      if (evalRes.score < 0.05) continue;

      results.push({
        file: fe.path,
        layer: fe.layer,
        description: `${fe.layer} layer file: ${fe.baseName}`,
        snippet: fe.lines.slice(0, 20).join("\n"),
        relevanceScore: evalRes.score,
        rankingReason: `${evalRes.reason} in ${fe.layer} layer file "${fe.baseName}"`,
      });
    }

    results.sort((a, b) => b.relevanceScore - a.relevanceScore);
    return { results: results.slice(0, 10) };
  }

  // ── Tool 9: Semantic Search (Vector + Hybrid + Keyword Fallback) ───────────────
  semanticSearch(params: {
    query: string;
    limit?: number;
    fileExtensions?: string[];
  }): RankedSearchResult[] {
    const { query, limit = 10, fileExtensions } = params || {};
    if (!query) return [];

    const results: RankedSearchResult[] = [];

    for (const [p, fe] of this.index.filesMap.entries()) {
      if (fileExtensions && fileExtensions.length > 0) {
        if (!fileExtensions.some((feExt) => feExt.replace(".", "").toLowerCase() === fe.extension)) {
          continue;
        }
      }

      const evalRes = ScoringEngine.evaluate(p + " " + fe.content, query);
      if (evalRes.score < 0.05) continue;

      const deps = extractImports(fe.content).slice(0, 8);
      const firstMatchLineIndex = fe.lines.findIndex((l) =>
        SymbolNormalizer.canonical(l).includes(SymbolNormalizer.canonical(query)),
      );

      const startLine = firstMatchLineIndex >= 0 ? firstMatchLineIndex + 1 : 1;
      const snippet = fe.lines.slice(Math.max(0, startLine - 1), startLine + 10).join("\n");

      results.push({
        filePath: fe.path,
        relevanceScore: evalRes.score,
        confidenceScore: evalRes.confidence,
        rankingReason: `Hybrid Semantic (${evalRes.reason})`,
        snippet,
        location: { startLine, endLine: startLine + 10 },
        dependencies: deps,
      });
    }

    results.sort((a, b) => b.relevanceScore - a.relevanceScore);
    return results.slice(0, limit);
  }

  async semanticSearchAsync(params: {
    query: string;
    limit?: number;
    fileExtensions?: string[];
  }): Promise<RankedSearchResult[]> {
    const { query, limit = 10 } = params || {};
    if (!query) return [];

    try {
      await this.semanticRetrievalEngine.indexCodebase(this.rawFiles);
      const semHits = await this.semanticRetrievalEngine.search(query, limit);

      if (semHits.length > 0) {
        return semHits.map((h) => ({
          filePath: h.chunk.filePath,
          symbolName: h.chunk.name,
          relevanceScore: h.hybridScore,
          confidenceScore: h.confidenceScore,
          rankingReason: `Vector Semantic Search (${h.matchedBy}) similarity ${(h.hybridScore * 100).toFixed(0)}%`,
          snippet: h.chunk.content,
          location: { startLine: h.chunk.startLine, endLine: h.chunk.endLine },
          dependencies: extractImports(h.chunk.content).slice(0, 8),
        }));
      }
    } catch {
      /* Fallback to synchronous keyword search */
    }

    return this.semanticSearch(params);
  }

  // ── OpenAI Tool Definitions ────────────────────────────────────────────────────
  static getOpenAIToolDefinitions(): any[] {
    return [
      {
        type: "function",
        function: {
          name: "repo_readFile",
          description: "Read the content of a specific file from the repository.",
          parameters: {
            type: "object",
            properties: {
              filePath: { type: "string", description: "Relative file path" },
              startLine: { type: "number" },
              endLine: { type: "number" },
            },
            required: ["filePath"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "repo_findRoute",
          description: "Find routes matching a URL pattern.",
          parameters: {
            type: "object",
            properties: {
              pathPattern: { type: "string" },
              httpMethod: { type: "string" },
            },
            required: ["pathPattern"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "repo_findComponent",
          description: "Find UI components by name.",
          parameters: {
            type: "object",
            properties: {
              componentName: { type: "string" },
              searchScope: { type: "string" },
            },
            required: ["componentName"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "repo_findService",
          description: "Find backend services.",
          parameters: {
            type: "object",
            properties: {
              serviceName: { type: "string" },
              domain: { type: "string" },
            },
            required: ["serviceName"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "repo_findAPI",
          description: "Find API endpoints.",
          parameters: {
            type: "object",
            properties: {
              endpointPattern: { type: "string" },
              method: { type: "string" },
            },
            required: ["endpointPattern"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "repo_findModel",
          description: "Find database models or types.",
          parameters: {
            type: "object",
            properties: {
              modelName: { type: "string" },
            },
            required: ["modelName"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "repo_findReferences",
          description: "Find all usages of a symbol.",
          parameters: {
            type: "object",
            properties: {
              symbolName: { type: "string" },
              sourceFilePath: { type: "string" },
            },
            required: ["symbolName"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "repo_searchArchitecture",
          description: "Search by architectural layer.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string" },
              layer: { type: "string", enum: ["presentation", "business", "data", "middleware"] },
            },
            required: ["query", "layer"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "repo_semanticSearch",
          description: "Semantic search across repository.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string" },
              limit: { type: "number", description: "Optional: max results (default: 10)" },
              fileExtensions: {
                type: "array",
                items: { type: "string" },
                description: "Optional: filter by extension (e.g. ['ts', 'tsx', 'prisma'])",
              },
            },
            required: ["query"],
          },
        },
      },
    ];
  }

  // ── Tool Dispatcher ────────────────────────────────────────────────────────────
  dispatch(toolName: string, args: Record<string, any>): string {
    try {
      const safeArgs = args || {};
      switch (toolName) {
        case "repo_readFile":          return JSON.stringify(this.readFile(safeArgs as any));
        case "repo_findRoute":         return JSON.stringify(this.findRoute(safeArgs as any));
        case "repo_findComponent":     return JSON.stringify(this.findComponent(safeArgs as any));
        case "repo_findService":       return JSON.stringify(this.findService(safeArgs as any));
        case "repo_findAPI":           return JSON.stringify(this.findAPI(safeArgs as any));
        case "repo_findModel":         return JSON.stringify(this.findModel(safeArgs as any));
        case "repo_findReferences":    return JSON.stringify(this.findReferences(safeArgs as any));
        case "repo_searchArchitecture":return JSON.stringify(this.searchArchitecture(safeArgs as any));
        case "repo_semanticSearch":    return JSON.stringify(this.semanticSearch(safeArgs as any));
        default:
          return JSON.stringify({ error: `Unknown tool: ${toolName}` });
      }
    } catch (err) {
      return JSON.stringify({ error: String(err) });
    }
  }
}
