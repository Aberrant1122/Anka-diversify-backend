import fs from "fs";
import { repositoryPath } from "./RepositoryBoundary";
import { authoritySnapshot, withAuthoritySnapshot } from "./AuthorityWorktree";
import path from "path";
import { normalizeRepoPath } from "./SemanticContextResolver";
import type {
  AddEvidenceParams,
  RepositoryEvidenceKind,
  RepositoryEvidenceProvenance,
} from "./RepositoryEvidenceStore";
import { fileDefinesSymbol, resolveLocalImportEdges } from "./DeterministicImportResolver";
import { describeFrameworkRoute, frameworkRouteMatches } from "./FrameworkRouteMatcher";
import { discoverStaticApiRegistrations, testExercisesRoute } from "./StaticApiArchitecture";
import { detectPrimaryActiveEntryPoint, detectRepositoryArchitecture } from "../planning/RepositoryArchitectureDetector";

export interface RepositoryObservationReceipt {
  readonly repositoryId: string;
  readonly workspaceRoot: string;
}

interface ObservationDetails {
  readonly repositoryRevision: string;
  readonly kind: RepositoryEvidenceKind;
  readonly filePath: string;
  readonly sourceFile?: string;
  readonly symbol?: string;
  readonly provenance: RepositoryEvidenceProvenance;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

const authenticReceipts = new WeakSet<object>();
const receiptDetails = new WeakMap<object, ObservationDetails>();

class FileSystemObservationReceipt implements RepositoryObservationReceipt {
  private constructor(
    public readonly repositoryId: string,
    public readonly workspaceRoot: string,
  ) {
    authenticReceipts.add(this);
    Object.freeze(this);
  }

  public static create(
    repositoryId: string,
    workspaceRoot: string,
    details: ObservationDetails,
  ): RepositoryObservationReceipt {
    const receipt = new FileSystemObservationReceipt(repositoryId, workspaceRoot);
    receiptDetails.set(receipt, Object.freeze({
      ...details,
      metadata: details.metadata ? Object.freeze({ ...details.metadata }) : undefined,
    }));
    return receipt;
  }
}

function readObservedFile(workspaceRoot: string, filePath: string): { normalizedPath: string; content: string; revision: string } | null {
  const normalizedPath = normalizeRepoPath(filePath);
  if (!repositoryPath(workspaceRoot, normalizedPath)) return null;
  try {
    const snapshot = authoritySnapshot(workspaceRoot);
    const encoded = snapshot.files.get(normalizedPath);
    if (encoded === undefined) return null;
    return { normalizedPath, content: Buffer.from(encoded, "base64").toString("utf8"), revision: snapshot.revision };
  } catch { return null; }
}

export class RepositoryObservationTools {
  private constructor() {}

  public static observeFile(
    repositoryId: string,
    workspaceRoot: string,
    filePath: string,
  ): RepositoryObservationReceipt | null {
    return withAuthoritySnapshot(workspaceRoot, () => this.observeFileBatch(repositoryId, workspaceRoot, filePath));
  }

  private static observeFileBatch(
    repositoryId: string,
    workspaceRoot: string,
    filePath: string,
  ): RepositoryObservationReceipt | null {
    const observed = readObservedFile(workspaceRoot, filePath);
    if (!observed) return null;
    return FileSystemObservationReceipt.create(repositoryId, path.resolve(workspaceRoot), {
      repositoryRevision: observed.revision,
      kind: "FILE",
      filePath: observed.normalizedPath,
      provenance: "REPO_READ",
    });
  }

  public static observeProspectiveFile(repositoryId: string, workspaceRoot: string, filePath: string): RepositoryObservationReceipt | null {
    return withAuthoritySnapshot(workspaceRoot, () => this.observeProspectiveFileBatch(repositoryId, workspaceRoot, filePath));
  }

  private static observeProspectiveFileBatch(repositoryId: string, workspaceRoot: string, filePath: string): RepositoryObservationReceipt | null {
    const absolute = repositoryPath(workspaceRoot, filePath, true);
    if (!absolute || fs.existsSync(absolute)) return null;
    const snapshot = authoritySnapshot(workspaceRoot);
    if (snapshot.files.has(filePath)) return null;
    return FileSystemObservationReceipt.create(repositoryId, path.resolve(workspaceRoot), {
      repositoryRevision: snapshot.revision, kind: "FILE", filePath, provenance: "REPO_READ", metadata: { prospective: true },
    });
  }

  public static observeSymbol(
    repositoryId: string,
    workspaceRoot: string,
    filePath: string,
    symbol: string,
  ): RepositoryObservationReceipt | null {
    return withAuthoritySnapshot(workspaceRoot, () => this.observeSymbolBatch(repositoryId, workspaceRoot, filePath, symbol));
  }

  private static observeSymbolBatch(
    repositoryId: string,
    workspaceRoot: string,
    filePath: string,
    symbol: string,
  ): RepositoryObservationReceipt | null {
    const normalizedSymbol = symbol.trim();
    const observed = readObservedFile(workspaceRoot, filePath);
    if (!observed || !normalizedSymbol || !fileDefinesSymbol(workspaceRoot, observed.normalizedPath, normalizedSymbol)) return null;
    return FileSystemObservationReceipt.create(repositoryId, path.resolve(workspaceRoot), {
      repositoryRevision: observed.revision,
      kind: "SYMBOL",
      filePath: observed.normalizedPath,
      symbol: normalizedSymbol,
      provenance: "AST_GRAPH",
    });
  }

  public static observeReference(
    repositoryId: string,
    workspaceRoot: string,
    sourceFile: string,
    targetFile: string,
    symbol?: string,
  ): RepositoryObservationReceipt | null {
    return withAuthoritySnapshot(workspaceRoot, () => this.observeReferenceBatch(repositoryId, workspaceRoot, sourceFile, targetFile, symbol));
  }

  private static observeReferenceBatch(
    repositoryId: string,
    workspaceRoot: string,
    sourceFile: string,
    targetFile: string,
    symbol?: string,
  ): RepositoryObservationReceipt | null {
    const source = readObservedFile(workspaceRoot, sourceFile);
    const target = readObservedFile(workspaceRoot, targetFile);
    if (!source || !target || source.revision !== target.revision) return null;
    const normalizedTarget = target.normalizedPath;
    const importEdge = resolveLocalImportEdges(workspaceRoot, source.normalizedPath)
      .find((edge) => edge.targetFile === normalizedTarget);
    if (!importEdge) return null;
    const normalizedSymbol = symbol?.trim();
    if (normalizedSymbol && !fileDefinesSymbol(workspaceRoot, normalizedTarget, normalizedSymbol)) return null;
    return FileSystemObservationReceipt.create(repositoryId, path.resolve(workspaceRoot), {
      repositoryRevision: source.revision,
      kind: "IMPORT",
      filePath: normalizedTarget,
      sourceFile: source.normalizedPath,
      symbol: normalizedSymbol || undefined,
      provenance: "AST_GRAPH",
      metadata: { moduleSpecifier: importEdge.moduleSpecifier },
    });
  }

  public static observeRuntimeRouteAnchor(
    repositoryId: string,
    workspaceRoot: string,
    routeFile: string,
    runtimeRoute: string,
  ): RepositoryObservationReceipt | null {
    return withAuthoritySnapshot(workspaceRoot, () => this.observeRuntimeRouteAnchorBatch(repositoryId, workspaceRoot, routeFile, runtimeRoute));
  }

  public static observeUiCompositionAnchor(
    repositoryId: string,
    workspaceRoot: string,
    entryFile: string,
  ): RepositoryObservationReceipt | null {
    return withAuthoritySnapshot(workspaceRoot, () => {
      const observed = readObservedFile(workspaceRoot, entryFile);
      if (!observed) return null;
      const bootstrapPattern = /^(?:(?:apps|packages)\/[^/]+\/)?(?:src\/)?(?:main|index)\.[cm]?[jt]sx?$/i;
      const mountPattern = /(?:\bcreateRoot\s*\(|\bReactDOM\.render\s*\(|\bcreateApp\s*\([^)]*\)\.mount\s*\(|\bnew\s+Vue\s*\()/;
      const isBootstrapRoot = bootstrapPattern.test(observed.normalizedPath) && mountPattern.test(observed.content);
      const isDetectedActiveEntry = detectPrimaryActiveEntryPoint([observed.normalizedPath]) !== null;
      if (!isBootstrapRoot && !isDetectedActiveEntry) return null;
      return FileSystemObservationReceipt.create(repositoryId, path.resolve(workspaceRoot), {
        repositoryRevision: observed.revision,
        kind: "ENTRY_POINT",
        filePath: observed.normalizedPath,
        provenance: "ARCHITECTURE_DETECTOR",
        metadata: { deterministicTaskAnchor: true, anchorKind: "UI_COMPOSITION_ROOT" },
      });
    });
  }

  public static observeArchitectureIntegrationAnchor(
    repositoryId: string,
    workspaceRoot: string,
    entryFile: string,
  ): RepositoryObservationReceipt | null {
    return withAuthoritySnapshot(workspaceRoot, () => {
      const observed = readObservedFile(workspaceRoot, entryFile);
      if (!observed) return null;
      const snapshot = authoritySnapshot(workspaceRoot);
      const packageEntry = [...snapshot.files.entries()].find(([filePath]) => /(?:^|\/)package\.json$/i.test(filePath));
      let packageJsonContent: string | undefined;
      if (packageEntry) {
        try {
          packageJsonContent = Buffer.from(packageEntry[1], "base64").toString("utf8");
        } catch {
          return null;
        }
      }
      const architecture = detectRepositoryArchitecture([...snapshot.files.keys()], packageJsonContent);
      if (architecture.framework !== "EXPRESS" || !architecture.existingEntryPoints.includes(observed.normalizedPath)) {
        return null;
      }
      return FileSystemObservationReceipt.create(repositoryId, path.resolve(workspaceRoot), {
        repositoryRevision: observed.revision,
        kind: "ENTRY_POINT",
        filePath: observed.normalizedPath,
        provenance: "ARCHITECTURE_DETECTOR",
        metadata: { deterministicTaskAnchor: true, anchorKind: "ARCHITECTURE_INTEGRATION_SURFACE" },
      });
    });
  }

  public static observeApiRouteAnchor(
    repositoryId: string,
    workspaceRoot: string,
    registrationFile: string,
    routeFile: string,
    routePrefix: string,
  ): RepositoryObservationReceipt | null {
    return withAuthoritySnapshot(workspaceRoot, () => {
      const match = discoverStaticApiRegistrations(workspaceRoot).find((registration) =>
        registration.registrationFile === normalizeRepoPath(registrationFile) &&
        registration.routeFile === normalizeRepoPath(routeFile) &&
        registration.routePrefix === routePrefix,
      );
      const observed = match ? readObservedFile(workspaceRoot, match.routeFile) : null;
      if (!match || !observed) return null;
      return FileSystemObservationReceipt.create(repositoryId, path.resolve(workspaceRoot), {
        repositoryRevision: observed.revision,
        kind: "ENTRY_POINT",
        filePath: match.routeFile,
        provenance: "ARCHITECTURE_DETECTOR",
        metadata: { deterministicTaskAnchor: true, anchorKind: "API_ROUTE_COMPOSITION", routePrefix, registrationFile: match.registrationFile },
      });
    });
  }

  public static observeApiTestAnchor(
    repositoryId: string,
    workspaceRoot: string,
    testFile: string,
    routePrefix: string,
  ): RepositoryObservationReceipt | null {
    return withAuthoritySnapshot(workspaceRoot, () => {
      const observed = readObservedFile(workspaceRoot, testFile);
      if (!observed || !/(?:^|\/)(?:tests?|__tests__)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(observed.normalizedPath) || !testExercisesRoute(observed.content, routePrefix)) return null;
      return FileSystemObservationReceipt.create(repositoryId, path.resolve(workspaceRoot), {
        repositoryRevision: observed.revision,
        kind: "ENTRY_POINT",
        filePath: observed.normalizedPath,
        provenance: "ARCHITECTURE_DETECTOR",
        metadata: { deterministicTaskAnchor: true, anchorKind: "API_TEST", routePrefix },
      });
    });
  }

  private static observeRuntimeRouteAnchorBatch(
    repositoryId: string,
    workspaceRoot: string,
    routeFile: string,
    runtimeRoute: string,
  ): RepositoryObservationReceipt | null {
    const observed = readObservedFile(workspaceRoot, routeFile);
    if (!observed) return null;
    const descriptor = describeFrameworkRoute(observed.normalizedPath);
    if (!descriptor || !frameworkRouteMatches(descriptor.routePattern, runtimeRoute)) return null;
    return FileSystemObservationReceipt.create(repositoryId, path.resolve(workspaceRoot), {
      // This receipt grounds traversal at the uniquely resolved runtime route
      // source and may authorize MODIFY of that exact source. It never grants
      // route-based CREATE or DELETE authority.
      repositoryRevision: observed.revision,
      kind: "ENTRY_POINT",
      filePath: descriptor.filePath,
      provenance: "ARCHITECTURE_DETECTOR",
      metadata: {
        deterministicTaskAnchor: true,
        runtimeRoute,
        routePattern: descriptor.routePattern,
        framework: descriptor.framework,
      },
    });
  }

  public static observeDiagnostic(repositoryId: string, workspaceRoot: string, filePath: string, metadata: Readonly<Record<string, unknown>>): RepositoryObservationReceipt | null {
    return withAuthoritySnapshot(workspaceRoot, () => this.observeDiagnosticBatch(repositoryId, workspaceRoot, filePath, metadata));
  }

  private static observeDiagnosticBatch(repositoryId: string, workspaceRoot: string, filePath: string, metadata: Readonly<Record<string, unknown>>): RepositoryObservationReceipt | null {
    const observed = readObservedFile(workspaceRoot, filePath);
    if (!observed) return null;
    return FileSystemObservationReceipt.create(repositoryId, path.resolve(workspaceRoot), {
      repositoryRevision: observed.revision, kind: "DIAGNOSTIC", filePath: observed.normalizedPath,
      provenance: "BUILD_DIAGNOSTIC", metadata,
    });
  }

  public static observe(
    repositoryId: string,
    workspaceRoot: string,
    params: AddEvidenceParams,
  ): RepositoryObservationReceipt | null {
    if (params.provenance === "SEMANTIC_SEARCH") return null;
    // Caller-shaped diagnostics are advisory. Only the diagnostic ingestion boundary issues roots.
    if (params.kind === "DIAGNOSTIC") return null;
    if (params.kind === "SYMBOL" && params.symbol) {
      return this.observeSymbol(repositoryId, workspaceRoot, params.filePath, params.symbol);
    }
    if ((params.kind === "REFERENCE" || params.kind === "IMPORT") && params.sourceFile) {
      return this.observeReference(repositoryId, workspaceRoot, params.sourceFile, params.filePath, params.symbol);
    }
    return this.observeFile(repositoryId, workspaceRoot, params.filePath);
  }
}

export function isAuthenticRepositoryObservation(value: unknown): value is RepositoryObservationReceipt {
  return typeof value === "object" && value !== null && authenticReceipts.has(value);
}

export function readRepositoryObservation(receipt: RepositoryObservationReceipt): ObservationDetails | null {
  return authenticReceipts.has(receipt) ? receiptDetails.get(receipt) ?? null : null;
}
