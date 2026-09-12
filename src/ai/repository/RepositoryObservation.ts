import fs from "fs";
import path from "path";
import { normalizeRepoPath } from "./SemanticContextResolver";
import type {
  AddEvidenceParams,
  RepositoryEvidenceKind,
  RepositoryEvidenceProvenance,
} from "./RepositoryEvidenceStore";

export interface RepositoryObservationReceipt {
  readonly repositoryId: string;
  readonly workspaceRoot: string;
}

interface ObservationDetails {
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

function readObservedFile(workspaceRoot: string, filePath: string): { normalizedPath: string; content: string } | null {
  const normalizedPath = normalizeRepoPath(filePath);
  const absolutePath = path.resolve(workspaceRoot, normalizedPath);
  const relative = path.relative(path.resolve(workspaceRoot), absolutePath);
  if (!normalizedPath || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  try {
    const stat = fs.statSync(absolutePath);
    if (!stat.isFile()) return null;
    return { normalizedPath, content: fs.readFileSync(absolutePath, "utf8") };
  } catch {
    return null;
  }
}

export class RepositoryObservationTools {
  private constructor() {}

  public static observeFile(
    repositoryId: string,
    workspaceRoot: string,
    filePath: string,
  ): RepositoryObservationReceipt | null {
    const observed = readObservedFile(workspaceRoot, filePath);
    if (!observed) return null;
    return FileSystemObservationReceipt.create(repositoryId, path.resolve(workspaceRoot), {
      kind: "FILE",
      filePath: observed.normalizedPath,
      provenance: "REPO_READ",
    });
  }

  public static observeSymbol(
    repositoryId: string,
    workspaceRoot: string,
    filePath: string,
    symbol: string,
  ): RepositoryObservationReceipt | null {
    const observed = readObservedFile(workspaceRoot, filePath);
    const normalizedSymbol = symbol.trim();
    if (!observed || !normalizedSymbol || !observed.content.includes(normalizedSymbol)) return null;
    return FileSystemObservationReceipt.create(repositoryId, path.resolve(workspaceRoot), {
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
    const source = readObservedFile(workspaceRoot, sourceFile);
    const normalizedTarget = normalizeRepoPath(targetFile);
    if (!source || !normalizedTarget || normalizedTarget.startsWith("../") || path.posix.isAbsolute(normalizedTarget)) return null;
    const targetStem = path.posix.basename(normalizedTarget, path.posix.extname(normalizedTarget));
    const relationTokens = [symbol?.trim(), targetStem].filter((value): value is string => Boolean(value));
    if (!relationTokens.some((token) => source.content.includes(token))) return null;
    return FileSystemObservationReceipt.create(repositoryId, path.resolve(workspaceRoot), {
      kind: "REFERENCE",
      filePath: normalizedTarget,
      sourceFile: source.normalizedPath,
      symbol: symbol?.trim() || undefined,
      provenance: "REFERENCE_SEARCH",
    });
  }

  public static observe(
    repositoryId: string,
    workspaceRoot: string,
    params: AddEvidenceParams,
  ): RepositoryObservationReceipt | null {
    if (params.provenance === "SEMANTIC_SEARCH" || params.kind === "DIAGNOSTIC") return null;
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
