import path from "path";
import fs from "fs";
import { ExecutionContract, BaselineDiagnostic } from "../../types";
import { ExtendedKnowledgeGraph } from "../shared/types";
import { normalizeRepoPath } from "../repository/SemanticContextResolver";
import { MonorepoDescriptor } from "../workspace/MonorepoDetector";
import {
  UiIntegrationScopeResolver,
  UiIntegrationScopeParams,
  UiIntegrationScopeResult,
} from "./UiIntegrationScopeResolver";

export {
  UiIntegrationScopeResolver,
  UiIntegrationScopeParams,
  UiIntegrationScopeResult,
};

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
  monorepo?: MonorepoDescriptor | null;
}

/**
 * Checks whether an import/export module specifier in sourceFile resolves to targetFile.
 */
export function matchesModuleSpecifier(
  sourceFile: string,
  specifier: string,
  targetFile: string,
  monorepo?: MonorepoDescriptor | null
): boolean {
  if (!specifier || typeof specifier !== "string") return false;

  const normSource = normalizeRepoPath(sourceFile);
  const normTarget = normalizeRepoPath(targetFile);

  const cleanSpec = specifier.trim().replace(/^['"]|['"]$/g, "");
  let resolved = "";

  // 1. Monorepo workspace package specifier mapping (e.g. @repo/ui -> packages/ui)
  if (monorepo && monorepo.packageByName) {
    for (const [pkgName, pkg] of monorepo.packageByName) {
      if (cleanSpec === pkgName) {
        // Pointing directly to the package root or entry file
        if (normTarget.startsWith(pkg.relativePath + "/")) {
          const subTarget = normTarget.slice(pkg.relativePath.length + 1);
          if (
            subTarget === "index" ||
            subTarget === "src/index" ||
            subTarget === "src/main" ||
            subTarget.startsWith("index.") ||
            subTarget.startsWith("src/index.") ||
            subTarget.startsWith("src/main.")
          ) {
            return true;
          }
        }
      } else if (cleanSpec.startsWith(pkgName + "/")) {
        const sub = cleanSpec.slice(pkgName.length + 1);
        const candidateResolved = normalizeRepoPath(path.join(pkg.relativePath, sub));
        const candidateResolvedSrc = normalizeRepoPath(path.join(pkg.relativePath, "src", sub));
        const normTargetNoExt = normTarget.replace(/\.[a-zA-Z0-9]+$/, "");
        const candNoExt = candidateResolved.replace(/\.[a-zA-Z0-9]+$/, "");
        const candSrcNoExt = candidateResolvedSrc.replace(/\.[a-zA-Z0-9]+$/, "");

        if (candidateResolved === normTarget || candidateResolvedSrc === normTarget) return true;
        if (candNoExt === normTargetNoExt || candSrcNoExt === normTargetNoExt) return true;
        if (normTargetNoExt === `${candNoExt}/index` || normTargetNoExt === `${candSrcNoExt}/index`) return true;
      }
    }
  }

  if (cleanSpec.startsWith("@/")) {
    resolved = normalizeRepoPath(cleanSpec.substring(2));
    if (normTarget.startsWith("src/") && !resolved.startsWith("src/")) {
      const withSrc = normalizeRepoPath(`src/${resolved}`);
      if (withSrc === normTarget || withSrc === normTarget.replace(/\.[a-zA-Z0-9]+$/, "")) return true;
    }
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
  monorepo?: MonorepoDescriptor | null,
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
      if (match[1] && matchesModuleSpecifier(normApproved, match[1], normCandidate, monorepo)) {
        return "IMPORT_RELATION";
      }
    }
  }

  if (candidateContent) {
    const importMatches = candidateContent.matchAll(
      /(?:import\s+(?:[\w\s{},*]+)\s+from\s+|export\s+(?:[\w\s{},*]+)\s+from\s+|require\s*\(\s*)["']([^"']+)["']/g
    );
    for (const match of importMatches) {
      if (match[1] && matchesModuleSpecifier(normCandidate, match[1], normApproved, monorepo)) {
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
   * Finds direct reverse-reference importers for a given target path using deterministic static code analysis.
   */
  public static findDirectImporters(params: {
    targetPath: string;
    repoFiles: string[];
    fileContext?: Record<string, string>;
    snapshotFiles?: Array<{ path: string; content?: string }>;
    localPath?: string | null;
    knowledgeGraph?: ExtendedKnowledgeGraph | null;
    monorepo?: MonorepoDescriptor | null;
  }): string[] {
    const result: string[] = [];
    for (const candidate of params.repoFiles) {
      if (candidate === params.targetPath) continue;
      const evidence = evaluateDirectReverseReference(params.targetPath, candidate, {
        fileContext: params.fileContext,
        snapshotFiles: params.snapshotFiles,
        localPath: params.localPath,
        knowledgeGraph: params.knowledgeGraph,
        monorepo: params.monorepo,
      });
      if (evidence) {
        result.push(candidate);
      }
    }
    return result;
  }

  /**
   * Deterministically expands ExecutionContract targetPaths for broad build-repair tasks
   * ONLY when candidate paths have verified repository / graph / compiler evidence.
   */
  public static expandBroadRepairTargetPaths(params: TargetScopeExpanderParams): ScopeExpansionResult {
    const {
      contract,
      candidatePaths = [],
      knowledgeGraph,
      snapshotFiles,
      localPath,
      fileContext,
      baselineDiagnostics,
      monorepo,
    } = params;

    const initialTargets = (contract.targetPaths || []).filter(Boolean);
    const approvedSet = new Set<string>(initialTargets);
    const approvedExpansions: Array<{ path: string; evidence: ScopeEvidenceType; sourceTarget: string }> = [];

    // Filter candidate paths against existing approved targets
    const pendingCandidates = candidatePaths.filter((cp) => !approvedSet.has(cp));

    // Iterative fixpoint expansion with proof chaining:
    // If Candidate B has evidence to Approved Target A, B becomes approved.
    // In subsequent iterations, Candidate C can prove evidence to B.
    let changed = true;
    while (changed && pendingCandidates.length > 0) {
      changed = false;

      for (let i = pendingCandidates.length - 1; i >= 0; i--) {
        const candidate = pendingCandidates[i];
        let foundEvidence: ScopeEvidenceType | null = null;
        let matchedSourceTarget: string = "";

        for (const approvedPath of Array.from(approvedSet)) {
          const evidence = evaluateEvidence(
            approvedPath,
            candidate,
            knowledgeGraph,
            fileContext,
            snapshotFiles,
            localPath,
            baselineDiagnostics,
            monorepo
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

  /**
   * Deterministically identifies files that directly import, render, or call symbols from
   * an authorized delete target file.
   * DIRECT-ONLY: Never transitively expands.
   */
  public static findDirectReverseReferences(
    deleteTarget: string,
    candidatePaths: string[],
    options?: {
      knowledgeGraph?: ExtendedKnowledgeGraph | null;
      snapshotFiles?: Array<{ path: string; content?: string }>;
      localPath?: string | null;
      fileContext?: Record<string, string>;
      monorepo?: MonorepoDescriptor | null;
    }
  ): string[] {
    const directImporters: string[] = [];
    for (const candidate of candidatePaths) {
      const evidence = evaluateDirectReverseReference(deleteTarget, candidate, options);
      if (evidence) {
        directImporters.push(candidate);
      }
    }
    return directImporters;
  }

  /**
   * Deterministically expands ExecutionContract targetPaths with supporting MODIFY authority
   * for files that are proven direct reverse-references of safely grounded DELETE targets.
   * 
   * Safety Invariants:
   * - Requires primary DELETE target to already be safely grounded (EXPLICIT_USER_PATH or UNIQUE_NAMED_ENTITY).
   * - Importers receive MODIFY-only authority, never DELETE.
   * - Strict direct relationship only (never transitively authorizes the whole dependency graph).
   * - Unrelated semantic files without direct references are strictly rejected.
   */
  public static expandReverseReferenceCleanupTargets(
    params: ReverseReferenceCleanupParams
  ): ReverseReferenceCleanupResult {
    const {
      contract,
      manifestFiles = [],
      candidatePaths = [],
      knowledgeGraph,
      snapshotFiles = [],
      localPath,
      fileContext,
      monorepo,
    } = params;

    const initialTargets = (contract.targetPaths || [])
      .filter((tp) => tp && !tp.includes("project-wide") && !tp.includes("*"))
      .map(normalizeRepoPath);

    // Safety check: Reverse-reference cleanup is ONLY for destructive/delete tasks
    const isDestructiveContract =
      contract.taskType === "DELETE_FOLDER" ||
      contract.taskType === "DELETE_FILE" ||
      (contract.allowedActions && (contract.allowedActions.includes("delete_folder") || contract.allowedActions.includes("delete_file"))) ||
      contract.goal?.toLowerCase().includes("delete") ||
      contract.goal?.toLowerCase().includes("remove") ||
      contract.goal?.toLowerCase().includes("prune");
    if (!isDestructiveContract) {
      return {
        expandedTargetPaths: initialTargets,
        approvedExpansions: [],
        rejectedCandidates: [],
      };
    }

    const approvedSet = new Set<string>(initialTargets);
    const approvedExpansions: Array<{
      path: string;
      evidence: ScopeEvidenceType;
      sourceTarget: string;
      action: "modify";
    }> = [];

    // Rule 1: Find safely grounded primary delete targets (EXPLICIT_USER_PATH or UNIQUE_NAMED_ENTITY)
    const authorizedDeleteTargets = initialTargets.filter((tp) => {
      const prov = contract.targetProvenance?.[tp];
      return (prov === "EXPLICIT_USER_PATH" || prov === "UNIQUE_NAMED_ENTITY") && !tp.endsWith(".css");
    });

    if (authorizedDeleteTargets.length === 0) {
      return {
        expandedTargetPaths: initialTargets,
        approvedExpansions: [],
        rejectedCandidates: [],
      };
    }

    // Determine candidates to evaluate: ONLY candidates intended for MODIFY
    const candidatePool = new Set<string>();
    for (const cp of candidatePaths) {
      if (cp && typeof cp === "string") candidatePool.add(normalizeRepoPath(cp));
    }
    for (const mf of manifestFiles) {
      if (mf && typeof mf.path === "string" && mf.action === "modify") {
        candidatePool.add(normalizeRepoPath(mf.path));
      }
    }

    const pendingCandidates = Array.from(candidatePool).filter((cp) => !approvedSet.has(cp));
    const rejectedCandidates: Array<{ path: string; reason: string }> = [];

    for (const candidate of pendingCandidates) {
      let foundEvidence: ScopeEvidenceType | null = null;
      let matchedDeleteTarget = "";

      for (const delTarget of authorizedDeleteTargets) {
        const evidence = evaluateDirectReverseReference(delTarget, candidate, {
          knowledgeGraph,
          fileContext,
          snapshotFiles,
          localPath,
          monorepo,
        });

        if (evidence) {
          foundEvidence = evidence;
          matchedDeleteTarget = delTarget;
          break;
        }
      }

      if (foundEvidence) {
        approvedSet.add(candidate);
        approvedExpansions.push({
          path: candidate,
          evidence: foundEvidence,
          sourceTarget: matchedDeleteTarget,
          action: "modify",
        });
      } else {
        rejectedCandidates.push({
          path: candidate,
          reason: "Not a verified direct importer or reference of an authorized delete target",
        });
      }
    }

    if (approvedExpansions.length > 0) {
      console.log(
        `[CONTRACT_SCOPE] mode=REVERSE_REFERENCE_CLEANUP approved=${approvedExpansions.length} targets=${approvedExpansions.map((e) => e.path).join(", ")}`
      );
    }

    return {
      expandedTargetPaths: Array.from(approvedSet),
      approvedExpansions,
      rejectedCandidates,
    };
  }

  /**
   * Deterministically expands ExecutionContract targetPaths with supporting authority
   * for files that are DIRECT neighbors of already authorized UI targets:
   * 1. A directly imported sibling stylesheet (e.g. DashboardPage.tsx -> DashboardPage.css)
   * 2. A directly imported child component (e.g. DashboardPage.tsx -> Header.tsx)
   * Strict direct relationship only: never recursively expands, never authorizes broad directories.
   */
  public static expandDirectUIReferences(
    params: DirectUIReferencesParams
  ): ScopeExpansionResult {
    const {
      contract,
      manifestFiles = [],
      candidatePaths = [],
      fileContext,
      snapshotFiles = [],
      localPath,
      monorepo,
    } = params;

    const initialTargets = (contract.targetPaths || [])
      .filter((tp) => tp && !tp.includes("project-wide") && !tp.includes("*"))
      .map(normalizeRepoPath);

    const approvedSet = new Set<string>(initialTargets);
    const approvedExpansions: Array<{
      path: string;
      evidence: ScopeEvidenceType;
      sourceTarget: string;
    }> = [];

    // Authorized UI targets must be non-stylesheet UI files
    const authorizedUITargets = initialTargets.filter((tp) => {
      return (
        !tp.endsWith(".css") &&
        !tp.endsWith(".scss") &&
        /(?:pages|components|app|views|screens)\/|(?:\.tsx|\.jsx)$/i.test(tp)
      );
    });

    if (authorizedUITargets.length === 0) {
      return {
        expandedTargetPaths: initialTargets,
        approvedExpansions: [],
        rejectedCandidates: [],
      };
    }

    // Candidate pool from manifest proposals and candidate paths
    const candidatePool = new Set<string>();
    for (const cp of candidatePaths) {
      if (cp && typeof cp === "string") candidatePool.add(normalizeRepoPath(cp));
    }
    for (const mf of manifestFiles) {
      if (mf && typeof mf.path === "string" && mf.action !== "delete") {
        candidatePool.add(normalizeRepoPath(mf.path));
      }
    }

    const pendingCandidates = Array.from(candidatePool).filter((cp) => !approvedSet.has(cp));
    const rejectedCandidates: Array<{ path: string; reason: string }> = [];

    for (const candidate of pendingCandidates) {
      let foundEvidence: ScopeEvidenceType | null = null;
      let matchedSourceTarget = "";

      for (const uiTarget of authorizedUITargets) {
        const targetContent = getFileContent(uiTarget, fileContext, snapshotFiles, localPath);
        if (!targetContent) continue;

        // 1. Directly imported sibling or local stylesheet
        if (candidate.endsWith(".css") || candidate.endsWith(".scss")) {
          const targetDir = path.dirname(uiTarget);
          const candidateDir = path.dirname(candidate);
          const candidateBase = path.basename(candidate);

          if (
            (targetDir === candidateDir || candidate.startsWith(`${targetDir}/`)) &&
            (targetContent.includes(candidateBase) ||
              matchesModuleSpecifier(uiTarget, `./${candidateBase}`, candidate, monorepo))
          ) {
            foundEvidence = "IMPORT_RELATION";
            matchedSourceTarget = uiTarget;
            break;
          }
        }

        // 2. Directly imported child component (e.g. Header.tsx imported by DashboardPage.tsx)
        if (/\.(?:tsx|jsx|ts|js)$/i.test(candidate)) {
          const importMatches = targetContent.matchAll(
            /(?:import\s+(?:[\w\s{},*]+)\s+from\s+|require\s*\(\s*)["']([^"']+)["']/g
          );
          for (const match of importMatches) {
            if (match[1] && matchesModuleSpecifier(uiTarget, match[1], candidate, monorepo)) {
              foundEvidence = "IMPORT_RELATION";
              matchedSourceTarget = uiTarget;
              break;
            }
          }
          if (foundEvidence) break;
        }
      }

      if (foundEvidence) {
        approvedSet.add(candidate);
        approvedExpansions.push({
          path: candidate,
          evidence: foundEvidence,
          sourceTarget: matchedSourceTarget,
        });
      } else {
        rejectedCandidates.push({
          path: candidate,
          reason: "Not a verified directly imported child component or sibling stylesheet of an authorized UI target",
        });
      }
    }

    if (approvedExpansions.length > 0) {
      console.log(
        `[CONTRACT_SCOPE] mode=DIRECT_UI_NEIGHBOR approved=${approvedExpansions.length} targets=${approvedExpansions.map((e) => e.path).join(", ")}`
      );
    }

    return {
      expandedTargetPaths: Array.from(approvedSet),
      approvedExpansions,
      rejectedCandidates,
    };
  }

  /**
   * Deterministically reconciles ExecutionContract targetPaths for cross-cutting UI features
   * (e.g. theme toggle, dark mode, providers, search UI, global navigation, layout integrations)
   * using architectural roles and deterministic repository evidence before ManifestValidator runs.
   */
  public static expandUiFeatureIntegrationTargets(
    params: UiIntegrationScopeParams
  ): UiIntegrationScopeResult {
    return UiIntegrationScopeResolver.resolveUiIntegrationScope(params);
  }
}

export interface DirectUIReferencesParams {
  contract: ExecutionContract;
  manifestFiles?: Array<{ path: string; action: "create" | "modify" | "delete" }>;
  candidatePaths?: string[];
  fileContext?: Record<string, string>;
  snapshotFiles?: Array<{ path: string; content?: string }>;
  localPath?: string | null;
  monorepo?: MonorepoDescriptor | null;
}

export interface ReverseReferenceCleanupParams {
  contract: ExecutionContract;
  manifestFiles?: Array<{ path: string; action: "create" | "modify" | "delete" }>;
  candidatePaths?: string[];
  knowledgeGraph?: ExtendedKnowledgeGraph | null;
  snapshotFiles?: Array<{ path: string; content?: string }>;
  localPath?: string | null;
  fileContext?: Record<string, string>;
  monorepo?: MonorepoDescriptor | null;
}

export interface ReverseReferenceCleanupResult {
  expandedTargetPaths: string[];
  approvedExpansions: Array<{
    path: string;
    evidence: ScopeEvidenceType;
    sourceTarget: string;
    action: "modify";
  }>;
  rejectedCandidates: Array<{
    path: string;
    reason: string;
  }>;
}

/**
 * Evaluates whether candidatePath is a DIRECT reverse reference (importer, renderer, static symbol caller)
 * of approvedDeletePath.
 * Strict direct relationship only: never transitively expands.
 */
export function evaluateDirectReverseReference(
  approvedDeletePath: string,
  candidatePath: string,
  options?: {
    knowledgeGraph?: ExtendedKnowledgeGraph | null;
    fileContext?: Record<string, string>;
    snapshotFiles?: Array<{ path: string; content?: string }>;
    localPath?: string | null;
    monorepo?: MonorepoDescriptor | null;
  }
): ScopeEvidenceType | null {
  const normDelete = normalizeRepoPath(approvedDeletePath);
  const normCandidate = normalizeRepoPath(candidatePath);

  if (normDelete === normCandidate) return null;

  // Never treat the dedicated stylesheet of the delete target as an importer
  const deleteStem = path.basename(normDelete).replace(/\.[a-zA-Z0-9]+$/, "");
  const candidateStem = path.basename(normCandidate).replace(/\.[a-zA-Z0-9]+$/, "");
  if (normCandidate.endsWith(".css") && candidateStem.toLowerCase() === deleteStem.toLowerCase()) {
    return null;
  }

  const { knowledgeGraph, fileContext, snapshotFiles, localPath, monorepo } = options || {};

  // 1. Direct Import / Require in Candidate Source Code
  const candidateContent = getFileContent(normCandidate, fileContext, snapshotFiles, localPath);
  if (candidateContent) {
    const importMatches = candidateContent.matchAll(
      /(?:import\s+(?:[\w\s{},*]+)\s+from\s+|export\s+(?:[\w\s{},*]+)\s+from\s+|require\s*\(\s*)["']([^"']+)["']/g
    );
    for (const match of importMatches) {
      if (match[1] && matchesModuleSpecifier(normCandidate, match[1], normDelete, monorepo)) {
        return "IMPORT_RELATION";
      }
    }

    // 2. Direct Static Symbol or JSX Component Reference
    const deleteSymbols = [deleteStem];
    const approvedContent = getFileContent(normDelete, fileContext, snapshotFiles, localPath);
    if (approvedContent) {
      deleteSymbols.push(...extractExportedSymbols(approvedContent));
    }

    for (const sym of deleteSymbols) {
      if (sym.length >= 3 && new RegExp(`\\b${sym}\\b`).test(candidateContent)) {
        return "SYMBOL_REFERENCE";
      }
    }
  }

  // 3. Deterministic Knowledge Graph Relationships
  if (knowledgeGraph) {
    if (Array.isArray(knowledgeGraph.imports)) {
      for (const imp of knowledgeGraph.imports) {
        if (
          normalizeRepoPath(imp.file) === normCandidate &&
          matchesModuleSpecifier(normCandidate, imp.source, normDelete, monorepo)
        ) {
          return "IMPORT_RELATION";
        }
      }
    }

    if (knowledgeGraph.dependencyGraph) {
      const depsCandidate = knowledgeGraph.dependencyGraph[normCandidate] || [];
      for (const dep of depsCandidate) {
        if (matchesModuleSpecifier(normCandidate, dep, normDelete, monorepo)) {
          return "DEPENDENCY_GRAPH";
        }
      }
    }

    if (knowledgeGraph.componentNodes) {
      for (const node of Object.values(knowledgeGraph.componentNodes)) {
        const nodeFile = normalizeRepoPath(node.file);
        if (nodeFile === normDelete) {
          if (node.whoImportsIt?.some((importer) => normalizeRepoPath(importer.file) === normCandidate)) {
            return "COMPONENT_GRAPH";
          }
          if (node.whoRendersIt?.some((renderer) => normalizeRepoPath(renderer.file) === normCandidate)) {
            return "COMPONENT_GRAPH";
          }
        }
      }
    }
  }

  return null;
}
