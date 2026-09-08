import path from "path";
import fs from "fs";
import { ExecutionContract, FileManifest } from "../../types";
import { ExtendedKnowledgeGraph } from "../shared/types";
import { normalizeRepoPath } from "../repository/SemanticContextResolver";
import { MonorepoDescriptor } from "../workspace/MonorepoDetector";
import {
  RepositoryArchitectureSummary,
  detectAllActiveEntryRoots,
  detectPrimaryActiveEntryPoint,
  detectRepositoryArchitecture,
} from "../planning/RepositoryArchitectureDetector";
import { matchesModuleSpecifier } from "./TargetScopeExpander";
import { detectCompoundIntent } from "./ExecutionContractBuilder";

export type ArchitecturalRole =
  | "CONTROL"
  | "INTEGRATION_CONTAINER"
  | "STATE_PROVIDER_OWNER"
  | "ROOT_ENTRY"
  | "STYLE_OWNER"
  | "THEME_INFRASTRUCTURE"
  | "UNASSIGNED";

export type UiScopeDecisionReason =
  | "ACTIVE_INTEGRATION_ROOT"
  | "IMPORTED_BY_ACTIVE_ROOT"
  | "IMPORTED_BY_AUTHORIZED_TARGET"
  | "IMPORTED_BY_INTEGRATION_CONTAINER"
  | "ACTIVE_INTEGRATION_CONTAINER"
  | "WIRED_PROVIDER_OR_CONTEXT"
  | "DIRECT_REACHABILITY_PATH"
  | "INTEGRATED_COMPONENT"
  | "FRAMEWORK_ROOT_STYLESHEET"
  | "NO_DETERMINISTIC_RELATION"
  | "SEMANTIC_ONLY_REJECTED"
  | "ACTIVE_ENTRY_NOT_INTEGRATION_OWNER"
  | "LOCAL_TARGET_SUFFICIENT"
  | "ORPHAN_NEW_COMPONENT"
  | "CROSS_WORKSPACE_VIOLATION"
  | "CROSS_REPOSITORY_VIOLATION"
  | "UNREFERENCED_STYLESHEET"
  | "NON_FRONTEND_TASK"
  | "MAX_INTEGRATION_EXPANSIONS_EXCEEDED"
  | "AMBIGUOUS_RELATION";

export interface ExistingThemeInfrastructure {
  found: boolean;
  providers: string[];
  contexts: string[];
  hooks: string[];
  stylesheets: string[];
  controls: string[];
}

export interface UiIntegrationScopeExpansion {
  path: string;
  role: ArchitecturalRole;
  evidence: string;
  reason: UiScopeDecisionReason;
  sourceTarget?: string;
}

export interface UiIntegrationScopeResult {
  expandedTargetPaths: string[];
  approvedExpansions: UiIntegrationScopeExpansion[];
  rejectedCandidates: Array<{ path: string; reason: UiScopeDecisionReason | string }>;
  existingThemeInfrastructure: ExistingThemeInfrastructure;
}

export interface UiIntegrationScopeParams {
  contract: ExecutionContract;
  manifestFiles?: Array<{ path: string; action: "create" | "modify" | "delete"; dependencies?: string[] }>;
  candidatePaths?: string[];
  message?: string;
  taskType?: string;
  architectureSummary?: Partial<RepositoryArchitectureSummary>;
  knowledgeGraph?: ExtendedKnowledgeGraph | null;
  activeEntryRoots?: string[];
  semanticEvidence?: Array<{ path?: string; file?: string; score?: number } | string>;
  snapshotFiles?: Array<{ path: string; content?: string }>;
  localPath?: string | null;
  fileContext?: Record<string, string>;
  monorepo?: MonorepoDescriptor | null;
  repoIsBackend?: boolean;
}

/**
 * Retrieves full text content for a file from fileContext, snapshotFiles, or disk.
 */
function getFileContent(
  filePath: string,
  fileContext?: Record<string, string>,
  snapshotFiles?: Array<{ path: string; content?: string }>,
  localPath?: string | null
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
 * Extracts import and require module specifiers from file source code.
 */
function extractImportSpecifiers(content: string): string[] {
  const specifiers: string[] = [];
  const regex = /(?:import\s+(?:[\w\s{},*]+)\s+from\s+|export\s+(?:[\w\s{},*]+)\s+from\s+|require\s*\(\s*|import\s+)["']([^"']+)["']/g;
  for (const match of content.matchAll(regex)) {
    if (match[1]) {
      specifiers.push(match[1]);
    }
  }
  return specifiers;
}

/**
 * Checks whether sourceFile directly imports or references targetFile.
 */
function fileDirectlyImports(
  sourceFile: string,
  targetFile: string,
  options: {
    fileContext?: Record<string, string>;
    snapshotFiles?: Array<{ path: string; content?: string }>;
    localPath?: string | null;
    monorepo?: MonorepoDescriptor | null;
    knowledgeGraph?: ExtendedKnowledgeGraph | null;
  }
): boolean {
  const normSource = normalizeRepoPath(sourceFile);
  const normTarget = normalizeRepoPath(targetFile);
  if (normSource === normTarget) return false;

  const content = getFileContent(normSource, options.fileContext, options.snapshotFiles, options.localPath);
  if (content) {
    const specifiers = extractImportSpecifiers(content);
    for (const spec of specifiers) {
      if (matchesModuleSpecifier(normSource, spec, normTarget, options.monorepo)) {
        return true;
      }
    }

    // Direct fallback for stylesheets (e.g. import "./components.css" or target basename in import)
    if (normTarget.endsWith(".css") || normTarget.endsWith(".scss")) {
      const targetBase = path.basename(normTarget);
      if (content.includes(targetBase)) {
        const sourceDir = path.dirname(normSource);
        const targetDir = path.dirname(normTarget);
        if (sourceDir === targetDir || normTarget.startsWith(`${sourceDir}/`) || content.includes(normTarget)) {
          return true;
        }
      }
    }
  }

  if (options.knowledgeGraph) {
    if (Array.isArray(options.knowledgeGraph.imports)) {
      for (const imp of options.knowledgeGraph.imports) {
        if (
          normalizeRepoPath(imp.file) === normSource &&
          matchesModuleSpecifier(normSource, imp.source, normTarget, options.monorepo)
        ) {
          return true;
        }
      }
    }
    if (options.knowledgeGraph.dependencyGraph) {
      const deps = options.knowledgeGraph.dependencyGraph[normSource] || [];
      for (const dep of deps) {
        if (matchesModuleSpecifier(normSource, dep, normTarget, options.monorepo)) {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Scans repository files to detect existing UI state/theme infrastructure (Fix 5).
 * Generalized to inspect AST/content for contexts, providers, hooks, tokens, and controls without feature keywords.
 */
function scanExistingThemeInfrastructure(
  allFiles: string[],
  options: {
    fileContext?: Record<string, string>;
    snapshotFiles?: Array<{ path: string; content?: string }>;
    localPath?: string | null;
  }
): ExistingThemeInfrastructure {
  const providers: string[] = [];
  const contexts: string[] = [];
  const hooks: string[] = [];
  const stylesheets: string[] = [];
  const controls: string[] = [];

  for (const file of allFiles) {
    const norm = normalizeRepoPath(file);
    const base = path.basename(norm).toLowerCase();

    if (norm.endsWith(".css") || norm.endsWith(".scss")) {
      const content = getFileContent(norm, options.fileContext, options.snapshotFiles, options.localPath);
      // CSS custom properties (design tokens) or style attribute selectors
      if (content && (content.includes("--") || content.includes("[data-"))) {
        stylesheets.push(norm);
      }
    } else if (/\.(?:tsx|jsx|ts|js)$/i.test(norm)) {
      const content = getFileContent(norm, options.fileContext, options.snapshotFiles, options.localPath);
      if (content) {
        if (content.includes("createContext")) contexts.push(norm);
        if (content.includes(".Provider") || /\bProvider\b/.test(content)) providers.push(norm);
        if (/\buse[A-Z]\w+/.test(content)) hooks.push(norm);
      } else {
        if (base.includes("provider")) providers.push(norm);
        else if (base.includes("context")) contexts.push(norm);
        else if (base.startsWith("use")) hooks.push(norm);
      }
      if (/(?:components|ui)\/.*(?:\.tsx|\.jsx)$/i.test(norm)) {
        controls.push(norm);
      }
    }
  }

  const found =
    providers.length > 0 ||
    contexts.length > 0 ||
    hooks.length > 0 ||
    stylesheets.length > 0 ||
    controls.length > 0;

  return { found, providers, contexts, hooks, stylesheets, controls };
}

/**
 * Returns true if the target is an isolated leaf component change
 * without cross-cutting layout/application integration (Cluster E active entry principle).
 * Derived strictly from structural evidence (targets, manifest actions) without prompt keywords.
 */
function isLocalComponentOnlyTask(initialTargets: string[], manifestFiles?: Array<{ action: string }>): boolean {
  if (initialTargets.length !== 1) return false;

  // If there are created files, it is not a local leaf modification
  if (manifestFiles && manifestFiles.some((m) => m.action === "create")) {
    return false;
  }

  // Initial target is a single leaf UI component
  const isLeafComponentTarget = initialTargets.some((t) =>
    /(?:Button|Badge|Spinner|Avatar|Icon|Checkbox|Radio|Label|Tooltip|Input)\.(?:tsx|jsx)$/i.test(t)
  );

  return isLeafComponentTarget;
}

/**
 * Returns true if the proposed architecture represents a cross-cutting UI feature.
 * Derived purely from architectural roles and structural relationships, not prompt keyword lists.
 */
function requiresCrossCuttingIntegration(
  candidateFiles: string[],
  manifestFiles?: Array<{ action: string }>
): boolean {
  // Candidate pool spans multiple architectural roles (e.g. root/layout container + stylesheet or created component)
  const hasRootOrLayoutCandidate = candidateFiles.some((c) =>
    /(?:App|layout|_app|main|index|Header|Navbar|Sidebar|AppLayout)\.(?:tsx|jsx|js|ts)$/i.test(c)
  );
  const hasStyleCandidate = candidateFiles.some((c) => c.endsWith(".css") || c.endsWith(".scss"));
  const hasCreatedComponent =
    manifestFiles?.some((m) => m.action === "create") ||
    candidateFiles.some((c) => /(?:components|ui)\/.*(?:\.tsx|\.jsx)$/i.test(c));

  return hasRootOrLayoutCandidate && (hasStyleCandidate || hasCreatedComponent);
}

export class UiIntegrationScopeResolver {
  /**
   * Deterministically resolves and reconciles execution contract target paths
   * for constructive cross-cutting UI features before ManifestValidator runs.
   */
  public static resolveUiIntegrationScope(params: UiIntegrationScopeParams): UiIntegrationScopeResult {
    const {
      contract,
      manifestFiles = [],
      candidatePaths = [],
      message = contract.goal || "",
      snapshotFiles = [],
      localPath,
      fileContext,
      monorepo,
      knowledgeGraph,
      repoIsBackend,
    } = params;

    const initialTargets = (contract.targetPaths || [])
      .filter((tp) => tp && !tp.includes("project-wide") && !tp.includes("*"))
      .map(normalizeRepoPath);

    const approvedSet = new Set<string>(initialTargets);
    const approvedExpansions: UiIntegrationScopeExpansion[] = [];
    const rejectedCandidates: Array<{ path: string; reason: UiScopeDecisionReason | string }> = [];

    // All available file paths in snapshot / context
    const allRepoFiles = Array.from(
      new Set([
        ...initialTargets,
        ...snapshotFiles.map((f) => normalizeRepoPath(f.path)),
        ...Object.keys(fileContext || {}).map(normalizeRepoPath),
      ])
    ).filter(Boolean);

    // 1. Safety Gate: Destructive tasks must not be processed by UI integration resolver (Fix 3)
    const isDestructive =
      contract.taskType === "DELETE_FOLDER" ||
      contract.taskType === "DELETE_FILE" ||
      contract.allowedActions.includes("delete_file") ||
      contract.allowedActions.includes("delete_folder");

    if (isDestructive) {
      return {
        expandedTargetPaths: initialTargets,
        approvedExpansions: [],
        rejectedCandidates: [],
        existingThemeInfrastructure: {
          found: false,
          providers: [],
          contexts: [],
          hooks: [],
          stylesheets: [],
          controls: [],
        },
      };
    }

    // 2. Safety Gate: Pure backend / API tasks must not be expanded (Fix 3, Test 10, Test 15)
    const arch = params.architectureSummary || detectRepositoryArchitecture(allRepoFiles, undefined, monorepo);
    const hasFrontendFiles = allRepoFiles.some((f) => /\.(?:tsx|jsx|html)$/i.test(f));
    const isBackendOnly =
      repoIsBackend === true ||
      ((arch.framework === "EXPRESS" || arch.framework === "NODE_JS") && !hasFrontendFiles) ||
      (contract.environment === "NODE_JS" && !hasFrontendFiles);

    if (isBackendOnly) {
      console.log(`[UI_SCOPE] Task/repository is pure backend. UI integration scope resolver NOT invoked.`);
      return {
        expandedTargetPaths: initialTargets,
        approvedExpansions: [],
        rejectedCandidates: [],
        existingThemeInfrastructure: {
          found: false,
          providers: [],
          contexts: [],
          hooks: [],
          stylesheets: [],
          controls: [],
        },
      };
    }

    // 3. Scan existing theme & UI infrastructure (Fix 5)
    const themeInfra = scanExistingThemeInfrastructure(allRepoFiles, {
      fileContext,
      snapshotFiles,
      localPath,
    });

    // 4. Candidate Pool Formation: STRICTLY planner-proposed files only (Fix 7)
    const candidatePool = new Set<string>();
    for (const cp of candidatePaths) {
      if (cp && typeof cp === "string") candidatePool.add(normalizeRepoPath(cp));
    }
    for (const mf of manifestFiles) {
      if (mf && typeof mf.path === "string" && mf.action !== "delete") {
        candidatePool.add(normalizeRepoPath(mf.path));
      }
    }

    // Remove already approved initial targets from pending pool
    const pendingCandidates = Array.from(candidatePool).filter((cp) => !approvedSet.has(cp));
    if (pendingCandidates.length === 0) {
      return {
        expandedTargetPaths: initialTargets,
        approvedExpansions: [],
        rejectedCandidates: [],
        existingThemeInfrastructure: themeInfra,
      };
    }

    // 5. Active Roots & Reachability Baseline
    const rawActiveRoots = params.activeEntryRoots ? [...params.activeEntryRoots] : detectAllActiveEntryRoots(allRepoFiles, arch);
    const primaryActiveRoot = detectPrimaryActiveEntryPoint(allRepoFiles, arch);
    if (primaryActiveRoot && !rawActiveRoots.includes(primaryActiveRoot)) {
      rawActiveRoots.push(primaryActiveRoot);
    }
    const activeRoots = Array.from(new Set(rawActiveRoots.map(normalizeRepoPath)));

    // 6. Characterize Task Scope: Local Component vs Cross-Cutting Feature (Fix 10, Test 3, Test 9)
    const isLocalOnly = isLocalComponentOnlyTask(initialTargets, manifestFiles);
    const isCrossCutting = !isLocalOnly && requiresCrossCuttingIntegration(pendingCandidates, manifestFiles);

    // 7. Monorepo Frontend Workspace Boundaries (Fix 12, Test 14)
    let activeWorkspacePackagePrefix: string | null = null;
    if (monorepo?.isMonorepo) {
      for (const target of initialTargets) {
        for (const ws of monorepo.workspaces) {
          if (target.startsWith(ws.relativePath + "/")) {
            activeWorkspacePackagePrefix = ws.relativePath;
            break;
          }
        }
        if (activeWorkspacePackagePrefix) break;
      }
    }

    // 8. Bounded Iterative Integration Evaluation (Fix 8, Fix 6, Fix 9)
    const MAX_INTEGRATION_EXPANSIONS = 6;
    let changed = true;

    while (changed && pendingCandidates.length > 0) {
      changed = false;

      for (let i = pendingCandidates.length - 1; i >= 0; i--) {
        const candidate = pendingCandidates[i];

        // Monorepo Workspace Isolation Check (Fix 12, Test 14)
        if (monorepo?.isMonorepo && activeWorkspacePackagePrefix) {
          const candidateInSameWorkspace = candidate.startsWith(activeWorkspacePackagePrefix + "/");
          const candidateInSharedPackage = monorepo.workspaces.some(
            (ws) =>
              ws.relativePath !== activeWorkspacePackagePrefix &&
              candidate.startsWith(ws.relativePath + "/") &&
              (ws.relativePath.includes("shared") || ws.relativePath.includes("ui") || ws.relativePath.includes("common"))
          );

          if (!candidateInSameWorkspace && !candidateInSharedPackage) {
            console.log(`[UI_SCOPE] candidate=${candidate} decision=REJECTED reason=CROSS_WORKSPACE_VIOLATION`);
            rejectedCandidates.push({ path: candidate, reason: "CROSS_WORKSPACE_VIOLATION" });
            pendingCandidates.splice(i, 1);
            continue;
          }
        }

        // Multi-repo boundary safety check (Fix 12, Test 15)
        if (repoIsBackend) {
          console.log(`[UI_SCOPE] candidate=${candidate} decision=REJECTED reason=CROSS_REPOSITORY_VIOLATION`);
          rejectedCandidates.push({ path: candidate, reason: "CROSS_REPOSITORY_VIOLATION" });
          pendingCandidates.splice(i, 1);
          continue;
        }

        // Check maximum integration expansions boundary (Fix 8)
        if (approvedExpansions.length >= MAX_INTEGRATION_EXPANSIONS) {
          console.log(`[UI_SCOPE] candidate=${candidate} decision=REJECTED reason=MAX_INTEGRATION_EXPANSIONS_EXCEEDED`);
          rejectedCandidates.push({ path: candidate, reason: "MAX_INTEGRATION_EXPANSIONS_EXCEEDED" });
          pendingCandidates.splice(i, 1);
          continue;
        }

        let approvedRole: ArchitecturalRole | null = null;
        let approvedReason: UiScopeDecisionReason | null = null;
        let matchedSourceTarget = "";

        const isCandidateActiveRoot = activeRoots.includes(candidate) || activeRoots.some((r) => r.toLowerCase() === candidate.toLowerCase());
        const isCandidateStylesheet = candidate.endsWith(".css") || candidate.endsWith(".scss");

        // EVIDENCE A: Active Frontend Root / Shell Integration (Fix 10, Fix 6)
        if (isCandidateActiveRoot) {
          if (isLocalOnly) {
            // Principle: ACTIVE ENTRY IS NOT AUTOMATIC WRITE AUTHORITY
            console.log(`[UI_SCOPE] candidate=${candidate} decision=REJECTED reason=ACTIVE_ENTRY_NOT_INTEGRATION_OWNER`);
            rejectedCandidates.push({ path: candidate, reason: "ACTIVE_ENTRY_NOT_INTEGRATION_OWNER" });
            pendingCandidates.splice(i, 1);
            continue;
          }

          // Genuine cross-cutting feature requiring root/shell integration
          // Verify candidate actually imports/renders an approved target, or is modified to integrate the new feature
          const importsAnyApproved = Array.from(approvedSet).some((approved) =>
            fileDirectlyImports(candidate, approved, { fileContext, snapshotFiles, localPath, monorepo, knowledgeGraph })
          );

          const manifestDecl = manifestFiles.find((mf) => normalizeRepoPath(mf.path) === candidate);
          const manifestIntegratesApproved = manifestDecl?.action === "modify";

          if (isCrossCutting && (importsAnyApproved || manifestIntegratesApproved)) {
            approvedRole = "ROOT_ENTRY";
            approvedReason = "ACTIVE_INTEGRATION_ROOT";
            matchedSourceTarget = candidate;
          }
        }

        // EVIDENCE D: Stylesheet Authority (Fix 9, Fix 6)
        if (!approvedReason && isCandidateStylesheet) {
          if (isLocalOnly) {
            console.log(`[UI_SCOPE] candidate=${candidate} decision=REJECTED reason=LOCAL_TARGET_SUFFICIENT`);
            rejectedCandidates.push({ path: candidate, reason: "LOCAL_TARGET_SUFFICIENT" });
            pendingCandidates.splice(i, 1);
            continue;
          }

          // Case 1: Directly imported by an already-approved component/container
          for (const approved of Array.from(approvedSet)) {
            if (fileDirectlyImports(approved, candidate, { fileContext, snapshotFiles, localPath, monorepo, knowledgeGraph })) {
              approvedRole = "STYLE_OWNER";
              approvedReason = activeRoots.includes(approved)
                ? "IMPORTED_BY_ACTIVE_ROOT"
                : "IMPORTED_BY_AUTHORIZED_TARGET";
              matchedSourceTarget = approved;
              break;
            }
          }

          // Case 2: Framework root stylesheet loaded by active entry point (e.g. main.tsx -> index.css, layout.tsx -> globals.css)
          if (!approvedReason) {
            for (const root of activeRoots) {
              if (fileDirectlyImports(root, candidate, { fileContext, snapshotFiles, localPath, monorepo, knowledgeGraph })) {
                approvedRole = "STYLE_OWNER";
                approvedReason = "IMPORTED_BY_ACTIVE_ROOT";
                matchedSourceTarget = root;
                break;
              }
            }
          }

          // Case 3: Standard framework convention root stylesheet (globals.css / index.css)
          if (!approvedReason) {
            const candidateBase = path.basename(candidate).toLowerCase();
            if (candidateBase === "globals.css" || candidateBase === "index.css" || candidateBase === "app.css") {
              const isLoadedByEntry = activeRoots.some((r) =>
                fileDirectlyImports(r, candidate, { fileContext, snapshotFiles, localPath, monorepo, knowledgeGraph })
              );
              if (isLoadedByEntry) {
                approvedRole = "STYLE_OWNER";
                approvedReason = "FRAMEWORK_ROOT_STYLESHEET";
                matchedSourceTarget = activeRoots[0];
              }
            }
          }
        }

        // EVIDENCE C & B: Direct Reachability & Integration Container (Fix 6)
        if (!approvedReason && !isCandidateStylesheet) {
          // Check if candidate directly imports an approved UI target (Candidate is an Integration Container)
          for (const approved of Array.from(approvedSet)) {
            if (fileDirectlyImports(candidate, approved, { fileContext, snapshotFiles, localPath, monorepo, knowledgeGraph })) {
              approvedRole = "INTEGRATION_CONTAINER";
              approvedReason = "ACTIVE_INTEGRATION_CONTAINER";
              matchedSourceTarget = approved;
              break;
            }
          }

          // Check if candidate is directly imported by an already approved target
          if (!approvedReason) {
            for (const approved of Array.from(approvedSet)) {
              if (fileDirectlyImports(approved, candidate, { fileContext, snapshotFiles, localPath, monorepo, knowledgeGraph })) {
                approvedRole = "CONTROL";
                approvedReason = "IMPORTED_BY_AUTHORIZED_TARGET";
                matchedSourceTarget = approved;
                break;
              }
            }
          }

          // EVIDENCE E: Existing Provider / Context Wired into Active Tree (Fix 6, Fix 7)
          if (!approvedReason) {
            const candidateContent = getFileContent(candidate, fileContext, snapshotFiles, localPath);
            const isProviderOrContext =
              themeInfra.providers.includes(candidate) ||
              themeInfra.contexts.includes(candidate) ||
              themeInfra.hooks.includes(candidate) ||
              (candidateContent && (
                candidateContent.includes("createContext") ||
                candidateContent.includes(".Provider") ||
                /\bProvider\b/.test(candidateContent) ||
                /\buse[A-Z]\w+/.test(candidateContent)
              )) ||
              /(?:Provider|Context)\.(?:tsx|jsx|ts|js)$/i.test(candidate);

            if (isProviderOrContext) {
              // FIX 7: A provider-looking file is NOT authorized merely by name.
              // It MUST have deterministic wiring: directly imported by an active entry root or authorized container.
              const isWiredToActive =
                activeRoots.some((root) =>
                  fileDirectlyImports(root, candidate, { fileContext, snapshotFiles, localPath, monorepo, knowledgeGraph })
                ) ||
                Array.from(approvedSet).some((approved) =>
                  fileDirectlyImports(approved, candidate, { fileContext, snapshotFiles, localPath, monorepo, knowledgeGraph })
                );

              if (isWiredToActive) {
                approvedRole = "STATE_PROVIDER_OWNER";
                approvedReason = "WIRED_PROVIDER_OR_CONTEXT";
                matchedSourceTarget = activeRoots[0] || Array.from(approvedSet)[0];
              }
            }
          }

          // EVIDENCE F: Create + Integrate Support for New Components (Fix 11, Test 6, Test 7)
          if (!approvedReason) {
            const manifestDecl = manifestFiles.find((mf) => normalizeRepoPath(mf.path) === candidate);
            if (manifestDecl?.action === "create") {
              // Check if any reachable authorized integration container imports or renders candidate
              let hasIntegrationContainer = false;
              for (const approved of Array.from(approvedSet)) {
                const approvedDecl = manifestFiles.find((mf) => normalizeRepoPath(mf.path) === approved);
                if (
                  approvedDecl?.dependencies?.some(
                    (d) =>
                      normalizeRepoPath(d) === candidate ||
                      matchesModuleSpecifier(approved, d, candidate, monorepo)
                  )
                ) {
                  hasIntegrationContainer = true;
                  matchedSourceTarget = approved;
                  break;
                }
                const approvedContent = getFileContent(approved, fileContext, snapshotFiles, localPath);
                const candidateStem = path.basename(candidate).replace(/\.[^.]+$/, "");
                if (approvedContent && approvedContent.includes(candidateStem)) {
                  hasIntegrationContainer = true;
                  matchedSourceTarget = approved;
                  break;
                }
              }

              if (hasIntegrationContainer) {
                approvedRole = "CONTROL";
                approvedReason = "INTEGRATED_COMPONENT";
              } else {
                console.log(`[UI_SCOPE] candidate=${candidate} decision=REJECTED reason=ORPHAN_NEW_COMPONENT`);
                rejectedCandidates.push({ path: candidate, reason: "ORPHAN_NEW_COMPONENT" });
                pendingCandidates.splice(i, 1);
                continue;
              }
            }
          }
        }

        // Final decision for candidate
        if (approvedReason && approvedRole) {
          approvedSet.add(candidate);
          approvedExpansions.push({
            path: candidate,
            role: approvedRole,
            evidence: approvedReason,
            reason: approvedReason,
            sourceTarget: matchedSourceTarget,
          });
          console.log(`[UI_SCOPE] candidate=${candidate} decision=AUTHORIZED reason=${approvedReason}`);
          pendingCandidates.splice(i, 1);
          changed = true;
        }
      }
    }

    // Remaining candidates fail deterministic proof (Fix 7, Test 2, Test 8)
    for (const rejected of pendingCandidates) {
      const reason: UiScopeDecisionReason = rejected.endsWith(".css") || rejected.endsWith(".scss")
        ? "UNREFERENCED_STYLESHEET"
        : "NO_DETERMINISTIC_RELATION";
      console.log(`[UI_SCOPE] candidate=${rejected} decision=REJECTED reason=${reason}`);
      rejectedCandidates.push({ path: rejected, reason });
    }

    return {
      expandedTargetPaths: Array.from(approvedSet),
      approvedExpansions,
      rejectedCandidates,
      existingThemeInfrastructure: themeInfra,
    };
  }
}
