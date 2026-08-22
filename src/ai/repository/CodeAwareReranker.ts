import path from "path";
import { SemanticSearchResult } from "../../services/semantic-retrieval.engine";
import { normalizeRepoPath } from "./SemanticContextResolver";

export type RerankReason =
  | "target-path"
  | "exact-symbol"
  | "symbol-content"
  | "entity-match"
  | "route-match";

export interface RerankedSemanticResult extends SemanticSearchResult {
  rerankScore: number;
  rerankReasons: RerankReason[];
}

export interface DiscoveredSymbolLocation {
  filePath: string;
  line?: number;
}

export interface CodeAwareRerankContext {
  targetPath?: string;
  discoveredSymbols?:
    | Map<string, DiscoveredSymbolLocation>
    | Record<string, DiscoveredSymbolLocation>
    | Array<[string, DiscoveredSymbolLocation]>;
  discoveredServices?: string[];
  discoveredModels?: string[];
  discoveredRoutes?: string[];
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeIdentifier(str: string): string {
  if (!str || typeof str !== "string") return "";
  return str
    .trim()
    .toLowerCase()
    .replace(/[-_.]/g, "");
}

/**
 * Normalizes discovered symbols into a standard array of [symbolName, { filePath, line }].
 */
function extractSymbolEntries(
  symbols?: CodeAwareRerankContext["discoveredSymbols"]
): Array<[string, DiscoveredSymbolLocation]> {
  if (!symbols) return [];

  if (symbols instanceof Map) {
    return Array.from(symbols.entries()).filter(
      ([k, v]) => typeof k === "string" && v && typeof v.filePath === "string"
    );
  }

  if (Array.isArray(symbols)) {
    return symbols.filter(
      (entry): entry is [string, DiscoveredSymbolLocation] =>
        Array.isArray(entry) &&
        typeof entry[0] === "string" &&
        entry[1] &&
        typeof entry[1].filePath === "string"
    );
  }

  if (typeof symbols === "object") {
    return Object.entries(symbols).filter(
      ([k, v]) => typeof k === "string" && v && typeof (v as any).filePath === "string"
    ) as Array<[string, DiscoveredSymbolLocation]>;
  }

  return [];
}

/**
 * Pure deterministic code-aware reranker for semantic search results.
 *
 * Scoring Formula:
 *   rerankScore = hybridScore + min(totalBonus, 0.40)
 *
 * Grounded Signals:
 *   - target-path: +0.25 (exact normalized target file path match)
 *   - exact-symbol: +0.20 (symbol name matches chunk.name AND symbol.filePath matches chunk.filePath)
 *   - symbol-content: +0.08 (symbol verified in chunk.filePath is present in chunk.content)
 *   - entity-match: +0.10 (exact normalized match against discoveredServices/Models and chunk.name or file basename)
 *   - route-match: +0.08 (exact route name/pattern match for route chunk)
 *
 * Invariants:
 *   - Pure and immutable (does not modify input candidates)
 *   - Deterministic tie-breaking
 *   - Preserves underlying hybridScore and similarityScore
 */
export function rerankSemanticResults(
  results: SemanticSearchResult[],
  context: CodeAwareRerankContext
): RerankedSemanticResult[] {
  if (!Array.isArray(results) || results.length === 0) {
    return [];
  }

  const normalizedTargetPath = context.targetPath
    ? normalizeRepoPath(context.targetPath)
    : "";

  const symbolEntries = extractSymbolEntries(context.discoveredSymbols);

  const normalizedEntities = new Set<string>();
  if (Array.isArray(context.discoveredServices)) {
    for (const s of context.discoveredServices) {
      if (typeof s === "string") {
        const norm = normalizeIdentifier(path.basename(s).replace(/\.(ts|tsx|js|jsx)$/, ""));
        if (norm) normalizedEntities.add(norm);
      }
    }
  }
  if (Array.isArray(context.discoveredModels)) {
    for (const m of context.discoveredModels) {
      if (typeof m === "string") {
        const norm = normalizeIdentifier(m);
        if (norm) normalizedEntities.add(norm);
      }
    }
  }

  const normalizedRoutes = new Set<string>();
  if (Array.isArray(context.discoveredRoutes)) {
    for (const r of context.discoveredRoutes) {
      if (typeof r === "string") {
        const norm = r.trim().replace(/\s+/g, " ");
        if (norm) normalizedRoutes.add(norm);
      }
    }
  }

  const reranked: Array<{ item: RerankedSemanticResult; originalIndex: number }> = [];

  for (let i = 0; i < results.length; i++) {
    const res = results[i];
    const chunk = res.chunk;
    const reasons: RerankReason[] = [];
    let totalBonus = 0;

    const chunkNormPath = chunk?.filePath ? normalizeRepoPath(chunk.filePath) : "";

    // Signal 1: Exact Target Path (+0.25)
    if (normalizedTargetPath && chunkNormPath && chunkNormPath === normalizedTargetPath) {
      totalBonus += 0.25;
      reasons.push("target-path");
    }

    // Signal 2: Exact Symbol Match (+0.20)
    // Requires BOTH chunk.name === symbolName AND symbol.filePath === chunk.filePath
    let exactSymbolMatched = false;
    if (chunk?.name && chunkNormPath && symbolEntries.length > 0) {
      for (const [symName, symLoc] of symbolEntries) {
        if (
          symName === chunk.name &&
          normalizeRepoPath(symLoc.filePath) === chunkNormPath
        ) {
          exactSymbolMatched = true;
          totalBonus += 0.20;
          reasons.push("exact-symbol");
          break;
        }
      }
    }

    // Signal 3: Symbol Present in Implementation (+0.08)
    // Only consider discovered symbols verified to belong to this chunk's filePath
    if (!exactSymbolMatched && chunk?.content && chunkNormPath && symbolEntries.length > 0) {
      for (const [symName, symLoc] of symbolEntries) {
        if (normalizeRepoPath(symLoc.filePath) === chunkNormPath) {
          const wordRegex = new RegExp(`\\b${escapeRegExp(symName)}\\b`);
          if (wordRegex.test(chunk.content)) {
            totalBonus += 0.08;
            reasons.push("symbol-content");
            break;
          }
        }
      }
    }

    // Signal 4: Grounded Service / Model Entity (+0.10)
    if (normalizedEntities.size > 0 && chunk) {
      const chunkNameNorm = normalizeIdentifier(chunk.name || "");
      const baseNameNorm = chunk.filePath
        ? normalizeIdentifier(path.basename(chunk.filePath).replace(/\.[^.]+$/, ""))
        : "";

      let entityMatched = false;
      for (const entity of normalizedEntities) {
        if (
          (chunkNameNorm && chunkNameNorm === entity) ||
          (baseNameNorm && baseNameNorm === entity)
        ) {
          entityMatched = true;
          break;
        }
      }

      if (entityMatched) {
        totalBonus += 0.10;
        reasons.push("entity-match");
      }
    }

    // Signal 5: Grounded Route Match (+0.08)
    if (chunk?.chunkType === "route" && chunk.name && normalizedRoutes.size > 0) {
      const chunkRouteNorm = chunk.name.trim().replace(/\s+/g, " ");
      if (normalizedRoutes.has(chunkRouteNorm)) {
        totalBonus += 0.08;
        reasons.push("route-match");
      }
    }

    // Combined Bonus Cap: +0.40
    const cappedBonus = Math.min(totalBonus, 0.40);
    const rerankScore = res.hybridScore + cappedBonus;

    reranked.push({
      item: {
        ...res,
        rerankScore,
        rerankReasons: reasons,
      },
      originalIndex: i,
    });
  }

  // Stable deterministic sorting
  reranked.sort((a, b) => {
    if (b.item.rerankScore !== a.item.rerankScore) {
      return b.item.rerankScore - a.item.rerankScore;
    }
    if (b.item.hybridScore !== a.item.hybridScore) {
      return b.item.hybridScore - a.item.hybridScore;
    }
    return a.originalIndex - b.originalIndex;
  });

  return reranked.map((r) => r.item);
}
