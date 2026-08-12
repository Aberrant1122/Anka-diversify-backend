import fs from "fs";
import path from "path";
import { performance } from "perf_hooks";
import { RepositoryToolEngine } from "./repository-tool.engine";
import { PersistentRepositoryGraphEngine } from "./persistent-repository-graph.engine";
import { ExecutionContract } from "../types";

// ─── Interfaces & Data Schemas ────────────────────────────────────────────────

export interface SearchQueryItem {
  tool: string;
  params: Record<string, any>;
  reason: string;
}

export interface DiscoveredSymbol {
  name: string;
  kind: "function" | "class" | "interface" | "component" | "route" | "service" | "api" | "model" | "symbol";
  filePath: string;
  line?: number;
  firstDiscoveredRound: number;
}

export interface ReasoningRoundRecord {
  round: number;
  queriesExecuted: SearchQueryItem[];
  newSymbolsFound: DiscoveredSymbol[];
  newFilesExplored: string[];
  previousConfidence: number;
  newConfidence: number;
  confidenceDelta: number;
  evaluationReason: string;
  durationMs: number;
}

export interface ReasoningTrace {
  sessionId: string;
  originalRequest: string;
  intent: string;
  maxRounds: number;
  confidenceThreshold: number;
  finalConfidence: number;
  reachedThreshold: boolean;
  totalRounds: number;
  totalTimeMs: number;
  rounds: ReasoningRoundRecord[];
  allDiscoveredSymbols: Map<string, DiscoveredSymbol>;
  allExploredFiles: Set<string>;
}

export interface IterativeReasoningOptions {
  maxRounds?: number;
  confidenceThreshold?: number;
  snapshot: any;
  /** Optional Execution Contract to scope searches and context retrieval */
  contract?: ExecutionContract;
  projectId?: string;
  toolEngine?: RepositoryToolEngine;
}

// ─── Iterative Reasoning Agent Engine ─────────────────────────────────────────

export class IterativeReasoningEngine {
  private toolEngine: RepositoryToolEngine;
  private graphEngine: PersistentRepositoryGraphEngine;
  private maxRounds: number;
  private confidenceThreshold: number;
  private contract: ExecutionContract | undefined;

  constructor(options: IterativeReasoningOptions) {
    this.toolEngine = options.toolEngine || new RepositoryToolEngine(options.snapshot);
    const cacheDir = options.projectId
      ? path.join(process.cwd(), ".anka-cache", "projects", options.projectId)
      : undefined;
    this.graphEngine = new PersistentRepositoryGraphEngine(cacheDir);
    this.maxRounds = options.maxRounds || 5;
    this.confidenceThreshold = options.confidenceThreshold || 0.80;
    this.contract = options.contract;
  }

  /**
   * Filter a file context map to only include paths within the contract's contextScope.
   * When the contract has a tight scope (DELETE_FOLDER, BUG_FIX, etc.) this prevents
   * unrelated files (Sidebar, Analytics, Dashboard) from entering the LLM window.
   */
  public filterFilesByContractScope(
    fileContext: Record<string, string>,
  ): Record<string, string> {
    if (!this.contract || this.contract.contextScope.length === 0) return fileContext;

    // For broad-scope task types, don't filter (keep all discovered context)
    const broadScopeTypes = new Set(["NEW_FEATURE", "REFACTOR", "OPTIMIZATION"]);
    if (broadScopeTypes.has(this.contract.taskType)) return fileContext;

    const scope = this.contract.contextScope;
    const filtered: Record<string, string> = {};

    for (const [filePath, content] of Object.entries(fileContext)) {
      const normalised = filePath.replace(/\\/g, "/");
      const inScope = scope.some((s) => normalised.startsWith(s) || normalised.includes(`/${s}/`) || normalised === s);
      if (inScope) {
        filtered[filePath] = content;
      }
    }

    return filtered;
  }

  /**
   * Execute the multi-round iterative reasoning loop.
   */
  public async executeReasoningLoop(
    originalRequest: string,
    intent: string,
    contract?: ExecutionContract,
  ): Promise<ReasoningTrace> {
    // Use constructor contract if no override provided
    if (contract) this.contract = contract;
    const startTime = performance.now();
    const sessionId = `reasoning_${Date.now()}`;

    const executedQueryHashes = new Set<string>();
    const allDiscoveredSymbols = new Map<string, DiscoveredSymbol>();
    const allExploredFiles = new Set<string>();
    const rounds: ReasoningRoundRecord[] = [];

    let currentConfidence = 0.20;
    let roundNumber = 1;

    while (roundNumber <= this.maxRounds && currentConfidence < this.confidenceThreshold) {
      const roundStart = performance.now();
      const previousConfidence = currentConfidence;

      // 1. Generate NEW Search Plan (Deduplicated against executedQueryHashes)
      const queries = this.generateNewSearchPlan(
        originalRequest,
        intent,
        roundNumber,
        allDiscoveredSymbols,
        allExploredFiles,
        executedQueryHashes,
      );

      if (queries.length === 0) {
        // No new search queries to generate
        break;
      }

      // 2. Execute Searches & Track Results
      const newSymbolsThisRound: DiscoveredSymbol[] = [];
      const newFilesThisRound = new Set<string>();

      for (const q of queries) {
        const queryHash = `${q.tool}:${JSON.stringify(q.params)}`;
        executedQueryHashes.add(queryHash);

        const dispatchRes = this.toolEngine.dispatch(q.tool, q.params);
        this.extractSymbolsAndFilesFromResults(
          q.tool,
          dispatchRes,
          roundNumber,
          newSymbolsThisRound,
          newFilesThisRound,
          allDiscoveredSymbols,
          allExploredFiles,
        );
      }

      // 3. Evaluate Confidence Improvement
      const evalRes = this.evaluateConfidence(
        originalRequest,
        allDiscoveredSymbols,
        allExploredFiles,
        previousConfidence,
      );

      currentConfidence = evalRes.confidence;
      const confidenceDelta = parseFloat((currentConfidence - previousConfidence).toFixed(2));
      const roundDurationMs = performance.now() - roundStart;

      rounds.push({
        round: roundNumber,
        queriesExecuted: queries,
        newSymbolsFound: newSymbolsThisRound,
        newFilesExplored: Array.from(newFilesThisRound),
        previousConfidence,
        newConfidence: currentConfidence,
        confidenceDelta,
        evaluationReason: evalRes.reason,
        durationMs: parseFloat(roundDurationMs.toFixed(2)),
      });

      roundNumber++;
    }

    const totalTimeMs = parseFloat((performance.now() - startTime).toFixed(2));
    const reachedThreshold = currentConfidence >= this.confidenceThreshold;

    const trace: ReasoningTrace = {
      sessionId,
      originalRequest,
      intent,
      maxRounds: this.maxRounds,
      confidenceThreshold: this.confidenceThreshold,
      finalConfidence: currentConfidence,
      reachedThreshold,
      totalRounds: rounds.length,
      totalTimeMs,
      rounds,
      allDiscoveredSymbols,
      allExploredFiles,
    };

    this.saveReasoningTraceReport(trace);
    return trace;
  }

  private extractSearchKeywords(text: string): string[] {
    if (!text) return [];
    const stopwords = new Set([
      "currently", "in", "the", "my", "ai", "coding", "agent", "showing", "incorrect", "or",
      "fake", "stages", "instead", "of", "real", "ingoing", "project", "i", "need", "you",
      "to", "make", "it", "show", "like", "app", "please", "fix", "add", "update", "create",
      "is", "not", "doing", "repo", "searching", "giving", "me", "good", "responses", "why",
      "solve", "issue", "and", "a", "an", "for", "with", "this", "that", "on", "at", "to",
      "how", "can", "what", "which", "where", "when", "does", "do", "did", "have", "has", "had",
      "curretly", "some", "any", "all", "more", "most", "about", "above", "below", "from"
    ]);
    const words = text.toLowerCase().replace(/[^a-z0-9_\-\s]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !stopwords.has(w));
    return [...new Set(words)];
  }

  // ── Plan Generator (Deduplicated) ───────────────────────────────────────────

  private generateNewSearchPlan(
    request: string,
    intent: string,
    round: number,
    symbols: Map<string, DiscoveredSymbol>,
    exploredFiles: Set<string>,
    executedHashes: Set<string>,
  ): SearchQueryItem[] {
    const candidates: SearchQueryItem[] = [];
    const contract = this.contract;

    if (round === 1) {
      // ── Contract-Scoped Round 1 Search ────────────────────────────────────────
      // If we have a contract with explicit targetPaths, search those FIRST
      // instead of doing a broad keyword sweep of the whole repo.
      if (contract && contract.targetPaths.length > 0) {
        for (const targetPath of contract.targetPaths.slice(0, 3)) {
          candidates.push({
            tool: "repo_readFile",
            params: { filePath: targetPath },
            reason: `Contract-scoped: read target path "${targetPath}"`,
          });
          // Also find files that import from this target path (import references)
          candidates.push({
            tool: "repo_grepSearch",
            params: { pattern: targetPath, caseSensitive: false },
            reason: `Contract-scoped: find all imports of "${targetPath}"`,
          });
        }

        // Add a keyword search restricted to the search scope
        const keywords = this.extractSearchKeywords(request);
        if (keywords.length > 0) {
          candidates.push({
            tool: "repo_grepSearch",
            params: { pattern: keywords[0], caseSensitive: false },
            reason: `Contract-scoped keyword grep for "${keywords[0]}"`,
          });
        }
      } else {
        // ── Generic Round 1 (no contract target paths) ──────────────────────────
        const keywords = this.extractSearchKeywords(request);
        candidates.push({ tool: "repo_semanticSearch", params: { query: request, limit: 5 }, reason: "Initial vector search for request intent" });

        if (keywords.length > 0) {
          const primaryKeyword = keywords[0];
          const secondaryKeyword = keywords[1] || keywords[0];
          candidates.push({ tool: "repo_grepSearch", params: { pattern: primaryKeyword, caseSensitive: false }, reason: `Grep search for keyword "${primaryKeyword}"` });
          candidates.push({ tool: "repo_findComponent", params: { componentName: primaryKeyword }, reason: `Search UI components matching "${primaryKeyword}"` });
          candidates.push({ tool: "repo_findService", params: { serviceName: secondaryKeyword }, reason: `Search services matching "${secondaryKeyword}"` });
        } else {
          candidates.push({ tool: "repo_grepSearch", params: { pattern: request.slice(0, 15), caseSensitive: false }, reason: "Initial grep search fallback" });
        }
      }
    } else {
      // ── Round 2+: Follow discovered symbols ───────────────────────────────────
      for (const [sName, sObj] of symbols.entries()) {
        // In contract mode, only follow references within the searchScope
        if (contract && contract.searchScope.length > 0) {
          const inScope = contract.searchScope.some(
            (s) => sObj.filePath.replace(/\\/g, "/").startsWith(s),
          );
          if (!inScope) continue;
        }

        if (sObj.kind === "service" || sObj.kind === "function") {
          candidates.push({
            tool: "repo_findReferences",
            params: { symbolName: sName },
            reason: `Trace call references of discovered ${sObj.kind} "${sName}"`,
          });
        } else if (sObj.kind === "component") {
          candidates.push({
            tool: "repo_findComponent",
            params: { componentName: sName },
            reason: `Inspect parent/child relations of UI component "${sName}"`,
          });
        }
      }

      // Refined semantic search — restrict to searchScope paths if contract exists
      const scopeHint = contract && contract.searchScope.length > 0
        ? ` (scope: ${contract.searchScope.slice(0, 2).join(", ")})`
        : "";
      candidates.push({
        tool: "repo_semanticSearch",
        params: { query: `${request} ${Array.from(symbols.keys()).slice(0, 3).join(" ")}`, limit: 5 },
        reason: `Refined semantic search${scopeHint}`,
      });
    }

    // Filter out already executed queries
    const deduplicated = candidates.filter((c) => {
      const qHash = `${c.tool}:${JSON.stringify(c.params)}`;
      return !executedHashes.has(qHash);
    });

    return deduplicated.slice(0, 4); // Max 4 queries per round
  }

  // ── Result Scanner & Symbol Extractor ────────────────────────────────────────

  private extractSymbolsAndFilesFromResults(
    tool: string,
    results: any,
    round: number,
    newSymbolsThisRound: DiscoveredSymbol[],
    newFilesThisRound: Set<string>,
    allSymbols: Map<string, DiscoveredSymbol>,
    allFiles: Set<string>,
  ) {
    if (!results) return;

    let parsed = results;
    if (typeof results === "string") {
      try {
        parsed = JSON.parse(results);
      } catch {
        parsed = results;
      }
    }

    // Handle array or wrapped object results
    const items = Array.isArray(parsed) ? parsed : (parsed.results || parsed.matches || [parsed]);

    for (const item of items) {
      const filePath = item.filePath || item.path || item.file;
      if (filePath) {
        const norm = filePath.replace(/\\/g, "/");
        newFilesThisRound.add(norm);
        allFiles.add(norm);
      }

      let symbolName = item.symbolName || item.componentName || item.serviceName || item.modelName || item.name;
      if (!symbolName && filePath) {
        const base = path.basename(filePath, path.extname(filePath));
        if (base && base !== "index" && base !== "page") symbolName = base;
      }

      if (symbolName && typeof symbolName === "string") {
        let kind: DiscoveredSymbol["kind"] = "symbol";
        if (tool.includes("Component")) kind = "component";
        else if (tool.includes("Service")) kind = "service";
        else if (tool.includes("Route")) kind = "route";
        else if (tool.includes("Model")) kind = "model";

        if (!allSymbols.has(symbolName)) {
          const symObj: DiscoveredSymbol = {
            name: symbolName,
            kind,
            filePath: filePath || "unknown",
            line: item.location?.startLine || item.line,
            firstDiscoveredRound: round,
          };
          allSymbols.set(symbolName, symObj);
          newSymbolsThisRound.push(symObj);
        }
      }
    }
  }

  // ── Confidence Evaluation Engine ─────────────────────────────────────────────

  private evaluateConfidence(
    request: string,
    symbols: Map<string, DiscoveredSymbol>,
    exploredFiles: Set<string>,
    previousConfidence: number,
  ): { confidence: number; reason: string } {
    const symbolCount = symbols.size;
    const fileCount = exploredFiles.size;

    if (symbolCount === 0 && fileCount === 0) {
      return { confidence: 0.20, reason: "No relevant code symbols or files discovered yet." };
    }

    let confidence = 0.30;

    // Symbol coverage contribution (up to 0.40)
    const symbolBonus = Math.min(0.40, symbolCount * 0.10);
    confidence += symbolBonus;

    // File coverage contribution (up to 0.20)
    const fileBonus = Math.min(0.20, fileCount * 0.05);
    confidence += fileBonus;

    // Diverse entity type bonus (up to 0.10)
    const kinds = new Set(Array.from(symbols.values()).map((s) => s.kind));
    if (kinds.size >= 2) confidence += 0.10;

    confidence = parseFloat(Math.min(0.95, confidence).toFixed(2));
    const delta = (confidence - previousConfidence).toFixed(2);

    return {
      confidence,
      reason: `Discovered ${symbolCount} symbols across ${fileCount} files (${kinds.size} entity types). Confidence improved by +${delta}.`,
    };
  }

  // ── Report Generator ─────────────────────────────────────────────────────────

  private saveReasoningTraceReport(trace: ReasoningTrace) {
    let md = `# ITERATIVE REASONING AGENT TRACE REPORT\n\n`;
    md += `**Session ID**: \`${trace.sessionId}\`  \n`;
    md += `**Original Request**: "${trace.originalRequest}"  \n`;
    md += `**Intent**: \`${trace.intent}\`  \n`;
    md += `**Final Confidence**: **${(trace.finalConfidence * 100).toFixed(0)}%** (Threshold: ${(trace.confidenceThreshold * 100).toFixed(0)}%)  \n`;
    md += `**Gate Status**: ${trace.reachedThreshold ? "✅ **GATE PASSED (Proceed to Coding)**" : "⚠️ **MAX ROUNDS REACHED**"}  \n`;
    md += `**Total Rounds Executed**: ${trace.totalRounds} / ${trace.maxRounds}  \n`;
    md += `**Total Duration**: ${trace.totalTimeMs} ms  \n\n`;
    md += `---\n\n`;
    md += `## 🔄 Multi-Round Reasoning Trace\n\n`;

    for (const r of trace.rounds) {
      md += `### 📍 Round ${r.round} (Confidence: ${(r.previousConfidence * 100).toFixed(0)}% ➔ **${(r.newConfidence * 100).toFixed(0)}%** | +${(r.confidenceDelta * 100).toFixed(0)}%)\n`;
      md += `- **Queries Executed**:\n`;
      for (const q of r.queriesExecuted) {
        md += `  • \`${q.tool}\` (Params: \`${JSON.stringify(q.params)}\`) — *${q.reason}*\n`;
      }
      md += `- **New Symbols Discovered**: ${r.newSymbolsFound.map((s) => `\`${s.name}\` (${s.kind})`).join(", ") || "None"}\n`;
      md += `- **New Files Explored**: ${r.newFilesExplored.map((f) => `\`${path.basename(f)}\``).join(", ") || "None"}\n`;
      md += `- **Evaluation**: *${r.evaluationReason}*\n\n`;
    }

    try {
      const outputDir = path.join(process.cwd(), "benchmarks");
      if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
      fs.writeFileSync(path.join(outputDir, "reasoning-trace-summary.md"), md, "utf8");
    } catch {}
  }
}
