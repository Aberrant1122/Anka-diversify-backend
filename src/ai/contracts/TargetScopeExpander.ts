import path from "path";
import fs from "fs";
import { ExecutionContract, BaselineDiagnostic } from "../../types";
import { ExtendedKnowledgeGraph } from "../shared/types";
import { normalizeRepoPath } from "../repository/SemanticContextResolver";

export type ScopeEvidenceType =
  | "IMPORT_RELATION"
  | "EXPORT_RELATION"
  | "DEPENDENCY_GRAPH"
  | "COMPONENT_GRAPH"
  | "SYMBOL_REFERENCE"
  | "COMPILER_TRACE"
  | "DIAGNOSTIC_REFERENCE";

export interface ScopeExpansionResult {
  expandedTargetPaths: string[];
  approvedExpansions: Array<{ path: string; evidence: ScopeEvidenceType; sourceTarget: string }>;
  rejectedCandidates: Array<{ path: string; reason: string }>;
}

export interface TargetScopeExpanderParams {
  contract: ExecutionContract;
  candidatePaths: string[];
  knowledgeGraph?: ExtendedKnowledgeGraph | null;
  snapshotFiles?: Array<{ path: string; content?: string }>;
  localPath?: string | null;
  fileContext?: Record<string, string>;
  baselineDiagnostics?: BaselineDiagnostic[];
}

/**
 * Checks whether an import/export module specifier in sourceFile resolves to targetFile.
 */
export function matchesModuleSpecifier(sourceFile: string, specifier: string, targetFile: string): boolean {
  if (!specifier || typeof specifier !== "string") return false;

  const normSource = normalizeRepoPath(sourceFile);
  const normTarget = normalizeRepoPath(targetFile);

  const cleanSpec = specifier.trim().replace(/^['"]|['"]$/g, "");
  let resolved = "";

  if (cleanSpec.startsWith("@/")) {
    resolved = normalizeRepoPath(cleanSpec.substring(2));
  } else if (cleanSpec.startsWith("./") || cleanSpec.startsWith("../")) {
    const sourceDir = path.dirname(normSource);
    resolved = normalizeRepoPath(path.join(sourceDir, cleanSpec));
  } else {
    resolved = normalizeRepoPath(cleanSpec);
  }

  if (resolved === normTarget) return true;

  // Extensionless match (e.g. ./CalculatorButton -> components/CalculatorButton.tsx)
  const normTargetNoExt = normTarget.replace(/\.[a-zA-Z0-9]+$/, "");
  const resolvedNoExt = resolved.replace(/\.[a-zA-Z0-9]+$/, "");

  if (resolvedNoExt === normTargetNoExt) return true;

  // Index file match (e.g. ./Calculator -> components/Calculator/index.tsx)
  if (normTargetNoExt === `${resolvedNoExt}/index`) return true;

  return false;
}

/**
 * Retrieves full text content for a file from fileContext, snapshotFiles, or disk.
 */
function getFileContent(
  filePath: string,
  fileContext?: Record<string, string>,
  snapshotFiles?: Array<{ path: string; content?: string }>,
  localPath?: string | null,
): string | null {
  const norm = normalizeRepoPath(filePath);

  if (fileContext && typeof fileContext[norm] === "string") {
    return fileContext[norm];
  }

  if (Array.isArray(snapshotFiles)) {
    const found = snapshotFiles.find((f) => normalizeRepoPath(f?.path) === norm);
    if (found && typeof found.content === "string") {
      return found.content;
    }
  }

  if (localPath) {
    const absPath = path.join(localPath, norm);
    if (fs.existsSync(absPath) && fs.statSync(absPath).isFile()) {
      try {
        return fs.readFileSync(absPath, "utf8");
      } catch {}
    }
  }

  return null;
}

/**
 * Extracts exported symbol names from file source code.
 */
function extractExportedSymbols(content: string): string[] {
  const symbols: string[] = [];
  const exportMatches = content.matchAll(
    /export\s+(?:default\s+)?(?:interface|class|function|type|const|let|var|enum)\s+([A-Za-z0-9_]+)/g
  );
  for (const match of exportMatches) {
    if (match[1]) symbols.push(match[1]);
  }
  return symbols;
}

/**
 * Evaluates whether there is deterministic evidence connecting candidatePath to approvedPath.
 */
function evaluateEvidence(
  approvedPath: string,
  candidatePath: string,
  knowledgeGraph?: ExtendedKnowledgeGraph | null,
  fileContext?: Record<string, string>,
  snapshotFiles?: Array<{ path: string; content?: string }>,
  localPath?: string | null,
  baselineDiagnostics?: BaselineDiagnostic[],
): ScopeEvidenceType | null {
  const normApproved = normalizeRepoPath(approvedPath);
  const normCandidate = normalizeRepoPath(candidatePath);

  if (normApproved === normCandidate) return null;

  const approvedContent = getFileContent(normApproved, fileContext, snapshotFiles, localPath);
  const candidateContent = getFileContent(normCandidate, fileContext, snapshotFiles, localPath);

  // 1. Direct Import / Export Relationship in Source Code
  if (approvedContent) {
    const importMatches = approvedContent.matchAll(
      /(?:import\s+(?:[\w\s{},*]+)\s+from\s+|export\s+(?:[\w\s{},*]+)\s+from\s+|require\s*\(\s*)["']([^"']+)["']/g
    );
    for (const match of importMatches) {
      if (match[1] && matchesModuleSpecifier(normApproved, match[1], normCandidate)) {
        return "IMPORT_RELATION";
      }
    }
  }

  if (candidateContent) {
    const importMatches = candidateContent.matchAll(
      /(?:import\s+(?:[\w\s{},*]+)\s+from\s+|export\s+(?:[\w\s{},*]+)\s+from\s+|require\s*\(\s*)["']([^"']+)["']/g
    );
    for (const match of importMatches) {
      if (match[1] && matchesModuleSpecifier(normCandidate, match[1], normApproved)) {
        return "IMPORT_RELATION";
      }
    }
  }

  // 2. Knowledge Graph: Imports & Dependency Graph
  if (knowledgeGraph) {
    if (Array.isArray(knowledgeGraph.imports)) {
      for (const imp of knowledgeGraph.imports) {
        if (
          normalizeRepoPath(imp.file) === normApproved &&
          matchesModuleSpecifier(normApproved, imp.source, normCandidate)
        ) {
          return "IMPORT_RELATION";
        }
        if (
          normalizeRepoPath(imp.file) === normCandidate &&
          matchesModuleSpecifier(normCandidate, imp.source, normApproved)
        ) {
          return "IMPORT_RELATION";
        }
      }
    }

    if (knowledgeGraph.dependencyGraph) {
      const depsApproved = knowledgeGraph.dependencyGraph[normApproved] || [];
      for (const dep of depsApproved) {
        if (matchesModuleSpecifier(normApproved, dep, normCandidate)) {
          return "DEPENDENCY_GRAPH";
        }
      }
      const depsCandidate = knowledgeGraph.dependencyGraph[normCandidate] || [];
      for (const dep of depsCandidate) {
        if (matchesModuleSpecifier(normCandidate, dep, normApproved)) {
          return "DEPENDENCY_GRAPH";
        }
      }
    }

    if (knowledgeGraph.componentNodes) {
      for (const node of Object.values(knowledgeGraph.componentNodes)) {
        const nodeFile = normalizeRepoPath(node.file);
        if (nodeFile === normApproved) {
          if (node.whoImportsIt?.some((importer) => normalizeRepoPath(importer.file) === normCandidate)) {
            return "COMPONENT_GRAPH";
          }
          if (node.whoRendersIt?.some((renderer) => normalizeRepoPath(renderer.file) === normCandidate)) {
            return "COMPONENT_GRAPH";
          }
        } else if (nodeFile === normCandidate) {
          if (node.whoImportsIt?.some((importer) => normalizeRepoPath(importer.file) === normApproved)) {
            return "COMPONENT_GRAPH";
          }
          if (node.whoRendersIt?.some((renderer) => normalizeRepoPath(renderer.file) === normApproved)) {
            return "COMPONENT_GRAPH";
          }
        }
      }
    }
  }

  // 3. Symbol Dependency Reference (e.g. candidate defines a symbol that approved uses, or vice versa)
  if (approvedContent && candidateContent) {
    const candidateSymbols = extractExportedSymbols(candidateContent);
    for (const sym of candidateSymbols) {
      if (sym.length > 2 && new RegExp(`\\b${sym}\\b`).test(approvedContent)) {
        return "SYMBOL_REFERENCE";
      }
    }

    const approvedSymbols = extractExportedSymbols(approvedContent);
    for (const sym of approvedSymbols) {
      if (sym.length > 2 && new RegExp(`\\b${sym}\\b`).test(candidateContent)) {
        return "SYMBOL_REFERENCE";
      }
    }
  }

  // 4. Compiler Diagnostic / Import Trace Reference
  if (Array.isArray(baselineDiagnostics)) {
    const candidateBase = path.basename(normCandidate);
    const candidateBaseNoExt = candidateBase.replace(/\.[a-zA-Z0-9]+$/, "");

    for (const diag of baselineDiagnostics) {
      const msg = diag.message || "";
      if (
        msg.includes(normCandidate) ||
        msg.includes(`./${normCandidate}`) ||
        (candidateBaseNoExt.length > 3 && msg.includes(candidateBaseNoExt))
      ) {
        return "COMPILER_TRACE";
      }
      if (diag.filePath && normalizeRepoPath(diag.filePath) === normCandidate) {
        return "DIAGNOSTIC_REFERENCE";
      }
      if (diag.symbolName && candidateContent && extractExportedSymbols(candidateContent).includes(diag.symbolName)) {
        return "DIAGNOSTIC_REFERENCE";
      }
    }
  }

  return null;
}

export class TargetScopeExpander {
  /**
   * Deterministically expands ExecutionContract targetPaths for broad build-repair tasks
   * ONLY when candidate paths have verified repository / graph / compiler evidence.
   */
  public static expandBroadRepairTargetPaths(params: TargetScopeExpanderParams): ScopeExpansionResult {
    const {
      contract,
      candidatePaths = [],
      knowledgeGraph,
      snapshotFiles = [],
      localPath,
      fileContext,
      baselineDiagnostics = [],
    } = params;

    const initialTargets = (contract.targetPaths || [])
      .filter((tp) => tp && !tp.includes("project-wide") && !tp.includes("*"))
      .map(normalizeRepoPath);

    const approvedSet = new Set<string>(initialTargets);
    const approvedExpansions: Array<{ path: string; evidence: ScopeEvidenceType; sourceTarget: string }> = [];
    const candidateNormSet = new Set(
      candidatePaths
        .filter((cp) => typeof cp === "string" && cp.trim().length > 0)
        .map(normalizeRepoPath)
    );

    // Filter out already approved initial targets
    const pendingCandidates = Array.from(candidateNormSet).filter((cp) => !approvedSet.has(cp));

    // Iterative transitive expansion (e.g. A -> B -> C)
    const maxRounds = Math.min(contract.maxFiles || 5, 5);
    let changed = true;
    let round = 0;

    while (changed && round < maxRounds) {
      changed = false;
      round++;

      for (let i = pendingCandidates.length - 1; i >= 0; i--) {
        const candidate = pendingCandidates[i];
        let foundEvidence: ScopeEvidenceType | null = null;
        let matchedSourceTarget = "";

        for (const approvedPath of Array.from(approvedSet)) {
          const evidence = evaluateEvidence(
            approvedPath,
            candidate,
            knowledgeGraph,
            fileContext,
            snapshotFiles,
            localPath,
            baselineDiagnostics
          );

          if (evidence) {
            foundEvidence = evidence;
            matchedSourceTarget = approvedPath;
            break;
          }
        }

        if (foundEvidence) {
          approvedSet.add(candidate);
          approvedExpansions.push({
            path: candidate,
            evidence: foundEvidence,
            sourceTarget: matchedSourceTarget,
          });
          pendingCandidates.splice(i, 1);
          changed = true;
        }
      }
    }

    const rejectedCandidates = pendingCandidates.map((cp) => ({
      path: cp,
      reason: "No verified dependency, graph edge, or import relation to approved target paths",
    }));

    // Observability logging
    console.log(
      `[CONTRACT_SCOPE] mode=BROAD_BUILD_REPAIR initialTargets=${initialTargets.length} expandedTargets=${approvedSet.size}`
    );
    for (const exp of approvedExpansions) {
      console.log(
        `[CONTRACT_SCOPE] candidate=${exp.path} evidence=${exp.evidence} approved=true (source=${exp.sourceTarget})`
      );
    }
    for (const rej of rejectedCandidates) {
      console.log(`[CONTRACT_SCOPE] candidate=${rej.path} evidence=NONE approved=false`);
    }

    return {
      expandedTargetPaths: Array.from(approvedSet),
      approvedExpansions,
      rejectedCandidates,
    };
  }
}
