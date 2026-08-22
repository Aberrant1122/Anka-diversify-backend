import { normalizeRepoPath } from "../repository/SemanticContextResolver";
import { RerankedSemanticResult } from "../repository/CodeAwareReranker";

export type FilePriorityCategory =
  | "TARGET"
  | "PRIMARY_IMPLEMENTATION"
  | "SUPPORTING"
  | "AUXILIARY";

export interface ContextPackerCandidate {
  filePath: string;
  content: string;
  priorityCategory: FilePriorityCategory;
  priorityRank: number; // 1 = TARGET, 2 = PRIMARY_IMPLEMENTATION, 3 = SUPPORTING, 4 = AUXILIARY
  rerankOrder: number;
  estimatedTokens: number;
}

export interface ContextPackerParams {
  fileContext: Record<string, string>;
  targetPath?: string;
  targetPaths?: string[];
  discoveredSymbols?:
    | Map<string, { filePath: string; line?: number }>
    | Record<string, { filePath: string; line?: number }>
    | Array<[string, { filePath: string; line?: number }]>;
  discoveredServices?: string[];
  discoveredModels?: string[];
  discoveredRoutes?: string[];
  semanticResults?: RerankedSemanticResult[];
  maxTokens?: number;
}

export interface ContextPackerResult {
  fileContext: Record<string, string>;
  includedFiles: string[];
  excludedFiles: string[];
  estimatedTokens: number;
  budgetExceededByRequiredFiles: boolean;
  telemetry: {
    contextFilesBeforePacking: number;
    contextFilesAfterPacking: number;
    estimatedTokensBeforePacking: number;
    estimatedTokensAfterPacking: number;
    filesExcludedByBudget: string[];
  };
}

/**
 * Estimates token count for a file including CodeGenerator delimiter overhead:
 * === filePath ===
 * content
 */
export function estimateFileTokens(filePath: string, content: string): number {
  if (!content || typeof content !== "string") return 0;
  // CodeGenerator formatting overhead: `=== ${filePath} ===\n\n`
  const overheadChars = filePath.length + 15;
  const totalChars = content.length + overheadChars;
  return Math.max(1, Math.ceil(totalChars / 4));
}

/**
 * Deterministically packs full repository files into a token budget.
 *
 * Rules:
 * 1. Priority primarily derived from grounded evidence:
 *    - Priority 1 (TARGET): Exact targetPath / targetPaths.
 *    - Priority 2 (PRIMARY_IMPLEMENTATION): Boosted by CodeAwareReranker or discovered services/models.
 *    - Priority 3 (SUPPORTING): Other retrieved/explored files.
 *    - Priority 4 (AUXILIARY): Low-ranked unboosted auxiliary files.
 * 2. High-ranking test files retain high priority if grounded retrieval boosted them.
 * 3. Preserves CodeAwareReranker ordering within each priority level.
 * 4. Whole-file guarantee: Complete file content included or completely excluded. Never truncated.
 * 5. Target file guarantee: Mandatory target files are kept even if exceeding budget, with explicit metadata.
 * 6. Pure and immutable: Does not mutate input fileContext.
 */
export function packFileContext(params: ContextPackerParams): ContextPackerResult {
  const {
    fileContext,
    targetPath,
    targetPaths = [],
    discoveredSymbols,
    discoveredServices = [],
    discoveredModels = [],
    semanticResults = [],
    maxTokens = 12000,
  } = params;

  if (!fileContext || typeof fileContext !== "object") {
    return {
      fileContext: {},
      includedFiles: [],
      excludedFiles: [],
      estimatedTokens: 0,
      budgetExceededByRequiredFiles: false,
      telemetry: {
        contextFilesBeforePacking: 0,
        contextFilesAfterPacking: 0,
        estimatedTokensBeforePacking: 0,
        estimatedTokensAfterPacking: 0,
        filesExcludedByBudget: [],
      },
    };
  }

  const allTargetPaths = new Set<string>();
  if (targetPath) {
    const norm = normalizeRepoPath(targetPath);
    if (norm) allTargetPaths.add(norm);
  }
  if (Array.isArray(targetPaths)) {
    for (const tp of targetPaths) {
      if (typeof tp === "string") {
        const norm = normalizeRepoPath(tp);
        if (norm) allTargetPaths.add(norm);
      }
    }
  }

  // Build semantic result lookup by normalized path
  const semanticLookup = new Map<string, { rank: number; result: RerankedSemanticResult }>();
  if (Array.isArray(semanticResults)) {
    semanticResults.forEach((res, idx) => {
      if (res.chunk?.filePath) {
        const norm = normalizeRepoPath(res.chunk.filePath);
        if (!semanticLookup.has(norm)) {
          semanticLookup.set(norm, { rank: idx, result: res });
        }
      }
    });
  }

  // Discovered services and models normalized sets
  const discoveredEntities = new Set<string>();
  if (Array.isArray(discoveredServices)) {
    for (const s of discoveredServices) {
      if (typeof s === "string") discoveredEntities.add(normalizeRepoPath(s));
    }
  }
  if (Array.isArray(discoveredModels)) {
    for (const m of discoveredModels) {
      if (typeof m === "string") discoveredEntities.add(m.trim().toLowerCase());
    }
  }

  const candidates: ContextPackerCandidate[] = [];
  let totalBeforeTokens = 0;
  const fileEntries = Object.entries(fileContext);

  for (let idx = 0; idx < fileEntries.length; idx++) {
    const [filePath, content] = fileEntries[idx];
    const normPath = normalizeRepoPath(filePath);
    const estTokens = estimateFileTokens(filePath, content);
    totalBeforeTokens += estTokens;

    const semInfo = semanticLookup.get(normPath);
    const rerankOrder = semInfo ? semInfo.rank : 1000 + idx;

    let priorityCategory: FilePriorityCategory = "SUPPORTING";
    let priorityRank = 3;

    // 1. TARGET
    if (allTargetPaths.has(normPath) || (semInfo && semInfo.result.rerankReasons?.includes("target-path"))) {
      priorityCategory = "TARGET";
      priorityRank = 1;
    }
    // 2. PRIMARY IMPLEMENTATION
    else if (
      discoveredEntities.has(normPath) ||
      (semInfo &&
        (semInfo.result.rerankReasons?.includes("exact-symbol") ||
          semInfo.result.rerankReasons?.includes("entity-match") ||
          semInfo.rank < 3))
    ) {
      priorityCategory = "PRIMARY_IMPLEMENTATION";
      priorityRank = 2;
    }
    // 3. SUPPORTING vs AUXILIARY
    else if (semInfo && semInfo.rank < 7) {
      priorityCategory = "SUPPORTING";
      priorityRank = 3;
    } else {
      priorityCategory = "AUXILIARY";
      priorityRank = 4;
    }

    candidates.push({
      filePath,
      content,
      priorityCategory,
      priorityRank,
      rerankOrder,
      estimatedTokens: estTokens,
    });
  }

  // Stable sort by priority rank -> rerankOrder -> filePath
  candidates.sort((a, b) => {
    if (a.priorityRank !== b.priorityRank) {
      return a.priorityRank - b.priorityRank;
    }
    if (a.rerankOrder !== b.rerankOrder) {
      return a.rerankOrder - b.rerankOrder;
    }
    return a.filePath.localeCompare(b.filePath);
  });

  const packedFileContext: Record<string, string> = {};
  const includedFiles: string[] = [];
  const excludedFiles: string[] = [];
  let currentTokens = 0;
  let budgetExceededByRequiredFiles = false;

  for (const candidate of candidates) {
    if (candidate.priorityCategory === "TARGET") {
      // Mandatory target file guarantee
      packedFileContext[candidate.filePath] = candidate.content;
      includedFiles.push(candidate.filePath);
      currentTokens += candidate.estimatedTokens;
      if (currentTokens > maxTokens) {
        budgetExceededByRequiredFiles = true;
      }
    } else {
      // Non-target files must fit within budget
      if (currentTokens + candidate.estimatedTokens <= maxTokens) {
        packedFileContext[candidate.filePath] = candidate.content;
        includedFiles.push(candidate.filePath);
        currentTokens += candidate.estimatedTokens;
      } else {
        excludedFiles.push(candidate.filePath);
      }
    }
  }

  return {
    fileContext: packedFileContext,
    includedFiles,
    excludedFiles,
    estimatedTokens: currentTokens,
    budgetExceededByRequiredFiles,
    telemetry: {
      contextFilesBeforePacking: fileEntries.length,
      contextFilesAfterPacking: includedFiles.length,
      estimatedTokensBeforePacking: totalBeforeTokens,
      estimatedTokensAfterPacking: currentTokens,
      filesExcludedByBudget: [...excludedFiles],
    },
  };
}
