import fs from "fs";
import path from "path";
import crypto from "crypto";
import OpenAI from "openai";
import { WasmASTParserEngine } from "./ast-parser.engine";

// ─── Interfaces & Types ───────────────────────────────────────────────────────

export interface CodeChunk {
  id: string;
  filePath: string;
  chunkType:
    | "function"
    | "class"
    | "interface"
    | "component"
    | "route"
    | "model"
    | "service"
    | "controller"
    | "file";
  name: string;
  content: string;
  startLine: number;
  endLine: number;
  hash: string;
}

export interface SemanticSearchResult {
  chunk: CodeChunk;
  similarityScore: number;
  keywordScore: number;
  hybridScore: number;
  confidenceScore: number;
  matchedBy: "VECTOR" | "KEYWORD" | "HYBRID";
}

export interface IEmbeddingProvider {
  name: string;
  dimension: number;
  embedQuery(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}

// ─── Code Chunk Extractor ─────────────────────────────────────────────────────

export class CodeChunkExtractor {
  static extractChunks(filePath: string, content: string): CodeChunk[] {
    if (!content) return [];

    const chunks: CodeChunk[] = [];
    const lines = content.split("\n");
    const p = filePath.replace(/\\/g, "/");

    // Extract AST symbols via WASM Tree-Sitter Engine
    const tsSymbols = WasmASTParserEngine.extractSymbols(filePath, content);

    // Extract active imports header to bundle into code chunks
    const importHeaderLines = tsSymbols.imports.map((imp) => lines[imp.line - 1]).filter(Boolean);
    const importHeader = importHeaderLines.length > 0 ? importHeaderLines.join("\n") + "\n\n" : "";

    if (tsSymbols.functions.length > 0) {
      for (const func of tsSymbols.functions) {
        const startLine = func.startLine;
        const endLine = Math.max(startLine, func.endLine);
        const rawContent = lines.slice(startLine - 1, endLine).join("\n");
        const chunkContent = importHeader + rawContent;
        const hash = CodeChunkExtractor.hash(chunkContent);

        chunks.push({
          id: `${p}:function:${func.name}:${startLine}`,
          filePath: p,
          chunkType: "function",
          name: func.name,
          content: chunkContent,
          startLine,
          endLine,
          hash,
        });
      }
    } else {
      // Regex Fallback
      const fnMatches = content.matchAll(/(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)/g);
      for (const m of fnMatches) {
        const name = m[1];
        const idx = m.index ?? 0;
        const startLine = content.slice(0, idx).split("\n").length;
        const endLine = Math.min(lines.length, startLine + 30);
        const chunkContent = lines.slice(startLine - 1, endLine).join("\n");
        const hash = CodeChunkExtractor.hash(chunkContent);

        chunks.push({
          id: `${p}:function:${name}:${startLine}`,
          filePath: p,
          chunkType: "function",
          name,
          content: chunkContent,
          startLine,
          endLine,
          hash,
        });
      }
    }

    // 2. Classes (Services / Controllers / Repositories)
    const classMatches = content.matchAll(/(?:export\s+)?class\s+([A-Za-z0-9_]+)/g);
    for (const m of classMatches) {
      const name = m[1];
      const idx = m.index ?? 0;
      const startLine = content.slice(0, idx).split("\n").length;
      const endLine = Math.min(lines.length, startLine + 50);
      const chunkContent = importHeader + lines.slice(startLine - 1, endLine).join("\n");
      const hash = CodeChunkExtractor.hash(chunkContent);

      let chunkType: CodeChunk["chunkType"] = "class";
      if (name.toLowerCase().includes("service") || p.includes("services/")) chunkType = "service";
      else if (name.toLowerCase().includes("controller") || p.includes("controllers/")) chunkType = "controller";

      chunks.push({
        id: `${p}:${chunkType}:${name}:${startLine}`,
        filePath: p,
        chunkType,
        name,
        content: chunkContent,
        startLine,
        endLine,
        hash,
      });
    }

    // 3. Interfaces & Types
    const typeMatches = content.matchAll(
      /(?:export\s+)?(?:interface|type)\s+([A-Za-z0-9_]+)/g,
    );
    for (const m of typeMatches) {
      const name = m[1];
      const idx = m.index ?? 0;
      const startLine = content.slice(0, idx).split("\n").length;
      const endLine = Math.min(lines.length, startLine + 25);
      const chunkContent = lines.slice(startLine - 1, endLine).join("\n");
      const hash = CodeChunkExtractor.hash(chunkContent);

      chunks.push({
        id: `${p}:interface:${name}:${startLine}`,
        filePath: p,
        chunkType: "interface",
        name,
        content: chunkContent,
        startLine,
        endLine,
        hash,
      });
    }

    // 4. React Components
    if (p.endsWith(".tsx") || p.endsWith(".jsx") || p.includes("components/")) {
      const compMatches = content.matchAll(
        /export\s+(?:default\s+)?(?:function|const)\s+([A-Z][A-Za-z0-9_]*)/g,
      );
      for (const m of compMatches) {
        const name = m[1];
        const idx = m.index ?? 0;
        const startLine = content.slice(0, idx).split("\n").length;
        const endLine = Math.min(lines.length, startLine + 40);
        const chunkContent = lines.slice(startLine - 1, endLine).join("\n");
        const hash = CodeChunkExtractor.hash(chunkContent);

        chunks.push({
          id: `${p}:component:${name}:${startLine}`,
          filePath: p,
          chunkType: "component",
          name,
          content: chunkContent,
          startLine,
          endLine,
          hash,
        });
      }
    }

    // 5. Routes & Endpoints
    if (p.includes("app/") || p.includes("pages/") || p.includes("routes/")) {
      const routeMatches = content.matchAll(
        /(?:router|app)\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/g,
      );
      for (const m of routeMatches) {
        const method = m[1].toUpperCase();
        const pattern = m[2];
        const idx = m.index ?? 0;
        const startLine = content.slice(0, idx).split("\n").length;
        const endLine = Math.min(lines.length, startLine + 20);
        const chunkContent = lines.slice(startLine - 1, endLine).join("\n");
        const hash = CodeChunkExtractor.hash(chunkContent);

        chunks.push({
          id: `${p}:route:${method}:${pattern}`,
          filePath: p,
          chunkType: "route",
          name: `${method} ${pattern}`,
          content: chunkContent,
          startLine,
          endLine,
          hash,
        });
      }
    }

    // 6. Prisma Models
    if (p.endsWith(".prisma")) {
      const modelMatches = content.matchAll(/model\s+([A-Za-z0-9_]+)\s*\{([^}]+)\}/g);
      for (const m of modelMatches) {
        const name = m[1];
        const idx = m.index ?? 0;
        const startLine = content.slice(0, idx).split("\n").length;
        const chunkContent = m[0];
        const endLine = startLine + chunkContent.split("\n").length;
        const hash = CodeChunkExtractor.hash(chunkContent);

        chunks.push({
          id: `${p}:model:${name}:${startLine}`,
          filePath: p,
          chunkType: "model",
          name,
          content: chunkContent,
          startLine,
          endLine,
          hash,
        });
      }
    }

    // Fallback whole-file chunk if no fine-grained chunks extracted
    if (chunks.length === 0) {
      const hash = CodeChunkExtractor.hash(content.slice(0, 1000));
      chunks.push({
        id: `${p}:file:1`,
        filePath: p,
        chunkType: "file",
        name: path.basename(p),
        content: content.slice(0, 1000),
        startLine: 1,
        endLine: Math.min(lines.length, 50),
        hash,
      });
    }

    return chunks;
  }

  static hash(text: string): string {
    return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
  }
}

// ─── Embedding Providers ──────────────────────────────────────────────────────

export class OpenAIEmbeddingProvider implements IEmbeddingProvider {
  public name = "openai-text-embedding-3-small";
  public dimension = 1536;
  private client: OpenAI;

  constructor(apiKey?: string) {
    this.client = new OpenAI({ apiKey: apiKey || process.env.OPENAI_API_KEY });
  }

  async embedQuery(text: string): Promise<number[]> {
    const res = await this.client.embeddings.create({
      model: "text-embedding-3-small",
      input: text.slice(0, 8000),
    });
    return res.data[0]?.embedding || new Array(this.dimension).fill(0);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];
    const sliced = texts.map((t) => t.slice(0, 8000));
    const res = await this.client.embeddings.create({
      model: "text-embedding-3-small",
      input: sliced,
    });
    return res.data.map((d) => d.embedding);
  }
}

export class LocalDeterministicEmbeddingProvider implements IEmbeddingProvider {
  public name = "local-feature-hashing-128";
  public dimension = 128;

  async embedQuery(text: string): Promise<number[]> {
    return this.hashTextToVector(text);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.hashTextToVector(t));
  }

  private hashTextToVector(text: string): number[] {
    const vector = new Array(this.dimension).fill(0);
    const tokens = text.toLowerCase().split(/[\s/_\-.:;(){}\[\]"']+/).filter(Boolean);

    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      const h = crypto.createHash("md5").update(tok).digest();
      const index = Math.abs(h.readInt32BE(0)) % this.dimension;
      const val = (h.readInt8(4) % 10) / 10.0;
      vector[index] += val;
    }

    // L2 Normalize vector
    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1.0;
    return vector.map((v) => v / norm);
  }
}

export class PluggableEmbeddingProvider implements IEmbeddingProvider {
  private activeProvider: IEmbeddingProvider;

  constructor(apiKey?: string) {
    const key = apiKey || process.env.OPENAI_API_KEY;
    if (key && key.startsWith("sk-")) {
      this.activeProvider = new OpenAIEmbeddingProvider(key);
    } else {
      this.activeProvider = new LocalDeterministicEmbeddingProvider();
    }
  }

  get name() { return this.activeProvider.name; }
  get dimension() { return this.activeProvider.dimension; }

  async embedQuery(text: string): Promise<number[]> {
    try {
      return await this.activeProvider.embedQuery(text);
    } catch {
      // Fallback to local if OpenAI fails/times out
      return new LocalDeterministicEmbeddingProvider().embedQuery(text);
    }
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    try {
      return await this.activeProvider.embedBatch(texts);
    } catch {
      return new LocalDeterministicEmbeddingProvider().embedBatch(texts);
    }
  }
}

// ─── Embedding Cache Manager ──────────────────────────────────────────────────

export class EmbeddingCacheManager {
  private cachePath: string;
  private cache: Map<string, { vector: number[]; timestamp: number }> = new Map();

  constructor(cacheDir?: string) {
    const dir = cacheDir || path.join(process.cwd(), ".anka-cache");
    this.cachePath = path.join(dir, "vector-embeddings.json");
    this.loadCache();
  }

  private loadCache() {
    try {
      if (fs.existsSync(this.cachePath)) {
        const raw = fs.readFileSync(this.cachePath, "utf8");
        const parsed = JSON.parse(raw);
        for (const [k, v] of Object.entries(parsed)) {
          this.cache.set(k, v as any);
        }
      }
    } catch { /* ignore cache read failure */ }
  }

  public saveCache() {
    try {
      const dir = path.dirname(this.cachePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const obj: Record<string, any> = {};
      for (const [k, v] of this.cache.entries()) {
        obj[k] = v;
      }
      fs.writeFileSync(this.cachePath, JSON.stringify(obj), "utf8");
    } catch { /* ignore cache write failure */ }
  }

  public get(chunkHash: string): number[] | null {
    const hit = this.cache.get(chunkHash);
    return hit ? hit.vector : null;
  }

  public set(chunkHash: string, vector: number[]) {
    this.cache.set(chunkHash, { vector, timestamp: Date.now() });
  }

  public size(): number {
    return this.cache.size;
  }
}

// ─── Cosine Similarity Engine ─────────────────────────────────────────────────

export class CosineSimilarityEngine {
  static compute(v1: number[], v2: number[]): number {
    if (!v1 || !v2 || v1.length !== v2.length || v1.length === 0) return 0.0;

    let dotProduct = 0.0;
    let normA = 0.0;
    let normB = 0.0;

    for (let i = 0; i < v1.length; i++) {
      const a = v1[i];
      const b = v2[i];
      dotProduct += a * b;
      normA += a * a;
      normB += b * b;
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    if (denominator === 0) return 0.0;

    const sim = dotProduct / denominator;
    return Math.max(0.0, Math.min(1.0, sim));
  }
}

// ─── Semantic Retrieval Engine ───────────────────────────────────────────────

export class SemanticRetrievalEngine {
  private provider: IEmbeddingProvider;
  private cache: EmbeddingCacheManager;
  private vectorStore: Array<{ chunk: CodeChunk; vector: number[] }> = [];

  constructor(apiKey?: string, cacheDir?: string) {
    this.provider = new PluggableEmbeddingProvider(apiKey);
    this.cache = new EmbeddingCacheManager(cacheDir);
  }

  public get providerName(): string {
    return this.provider.name;
  }

  /**
   * Index codebase snapshot using incremental caching.
   * Only calls embedding provider for chunks whose hash is NOT in the cache.
   */
  async indexCodebase(snapshotFiles: Array<{ path: string; content?: string }>): Promise<{
    totalChunks: number;
    cachedHits: number;
    newlyEmbedded: number;
  }> {
    this.vectorStore = [];
    const allChunks: CodeChunk[] = [];

    for (const f of snapshotFiles) {
      if (!f.path || !f.content) continue;
      const chunks = CodeChunkExtractor.extractChunks(f.path, f.content);
      allChunks.push(...chunks);
    }

    const uncachedChunks: CodeChunk[] = [];
    let cachedHits = 0;

    for (const chunk of allChunks) {
      const cachedVec = this.cache.get(chunk.hash);
      if (cachedVec) {
        this.vectorStore.push({ chunk, vector: cachedVec });
        cachedHits++;
      } else {
        uncachedChunks.push(chunk);
      }
    }

    let newlyEmbedded = 0;
    if (uncachedChunks.length > 0) {
      const BATCH_SIZE = 20;
      for (let i = 0; i < uncachedChunks.length; i += BATCH_SIZE) {
        const batch = uncachedChunks.slice(i, i + BATCH_SIZE);
        const texts = batch.map((c) => `${c.chunkType} ${c.name} in ${c.filePath}\n${c.content}`);
        try {
          const vectors = await this.provider.embedBatch(texts);
          for (let j = 0; j < batch.length; j++) {
            const vec = vectors[j];
            const chunk = batch[j];
            if (vec) {
              this.cache.set(chunk.hash, vec);
              this.vectorStore.push({ chunk, vector: vec });
              newlyEmbedded++;
            }
          }
        } catch { /* continue on batch failure */ }
      }
      this.cache.saveCache();
    }

    return { totalChunks: allChunks.length, cachedHits, newlyEmbedded };
  }

  /**
   * Perform Hybrid Vector + Keyword Semantic Search.
   */
  async search(query: string, topK = 10): Promise<SemanticSearchResult[]> {
    if (!query || this.vectorStore.length === 0) return [];

    let queryVector: number[] = [];
    let vectorAvailable = true;

    try {
      queryVector = await this.provider.embedQuery(query);
    } catch {
      vectorAvailable = false;
    }

    const results: SemanticSearchResult[] = [];
    const qTokens = query.toLowerCase().split(/[\s/_\-.]+/).filter(Boolean);

    for (const entry of this.vectorStore) {
      const { chunk, vector } = entry;

      // 1. Vector Cosine Similarity
      const vectorSim = vectorAvailable ? CosineSimilarityEngine.compute(queryVector, vector) : 0;

      // 2. Keyword BM25-approximate score
      const contentLower = chunk.content.toLowerCase();
      const pathLower = chunk.filePath.toLowerCase();
      let termMatches = 0;

      for (const tok of qTokens) {
        if (contentLower.includes(tok) || pathLower.includes(tok)) termMatches++;
      }

      const keywordScore = qTokens.length > 0 ? termMatches / qTokens.length : 0;

      // 3. Hybrid Score Combination
      const hybridScore = vectorAvailable
        ? 0.70 * vectorSim + 0.30 * keywordScore
        : keywordScore;

      const confidenceScore = Math.min(1.0, hybridScore * 1.15);
      const matchedBy = vectorAvailable && vectorSim > 0.3 ? "VECTOR" : keywordScore > 0 ? "KEYWORD" : "HYBRID";

      if (hybridScore > 0.05) {
        results.push({
          chunk,
          similarityScore: vectorSim,
          keywordScore,
          hybridScore,
          confidenceScore,
          matchedBy,
        });
      }
    }

    results.sort((a, b) => b.hybridScore - a.hybridScore);
    return results.slice(0, topK);
  }

  /**
   * Perform multi-query semantic search across multiple grounded queries.
   * Merges results and deduplicates chunks, preserving the highest hybridScore.
   */
  async searchMany(
    queries: string[],
    topK = 10,
    perQueryK = 10
  ): Promise<SemanticSearchResult[]> {
    if (!Array.isArray(queries) || queries.length === 0 || this.vectorStore.length === 0) {
      return [];
    }

    // 1. Remove empty queries and deduplicate
    const seenQueries = new Set<string>();
    const normalizedQueries: string[] = [];

    for (const q of queries) {
      if (typeof q === "string") {
        const trimmed = q.trim();
        if (trimmed && !seenQueries.has(trimmed)) {
          seenQueries.add(trimmed);
          normalizedQueries.push(trimmed);
        }
      }
    }

    // 2. Cap at maximum 4 queries
    const cappedQueries = normalizedQueries.slice(0, 4);
    if (cappedQueries.length === 0) return [];

    // 3. For each query call existing this.search(query, perQueryK)
    const mergedMap = new Map<string, SemanticSearchResult>();

    for (const query of cappedQueries) {
      const results = await this.search(query, perQueryK);
      for (const res of results) {
        const chunkId = res.chunk?.id || `${res.chunk?.filePath}:${res.chunk?.startLine}:${res.chunk?.name}`;
        const existing = mergedMap.get(chunkId);
        if (!existing || res.hybridScore > existing.hybridScore) {
          mergedMap.set(chunkId, res);
        }
      }
    }

    // 4. Sort merged results by hybridScore descending
    const mergedResults = Array.from(mergedMap.values());
    mergedResults.sort((a, b) => b.hybridScore - a.hybridScore);

    // 5. Return topK
    return mergedResults.slice(0, topK);
  }

  public getCacheSize(): number {
    return this.cache.size();
  }

  public getProviderName(): string {
    return this.provider.name;
  }
}
