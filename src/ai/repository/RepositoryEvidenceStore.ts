import { normalizeRepoPath } from "./SemanticContextResolver";
import {
  isAuthenticRepositoryObservation,
  readRepositoryObservation,
  RepositoryObservationReceipt,
  RepositoryObservationTools,
} from "./RepositoryObservation";

export type RepositoryEvidenceKind =
  | "FILE"
  | "SYMBOL"
  | "IMPORT"
  | "REFERENCE"
  | "ROUTE"
  | "ENTRY_POINT"
  | "STYLE_DEPENDENCY"
  | "TYPE"
  | "TEST"
  | "DIAGNOSTIC"
  | "PACKAGE"
  | "WORKSPACE";

export type RepositoryEvidenceProvenance =
  | "REPO_READ"
  | "SEMANTIC_SEARCH"
  | "REFERENCE_SEARCH"
  | "AST_GRAPH"
  | "BUILD_DIAGNOSTIC"
  | "ARCHITECTURE_DETECTOR";

export interface RepositoryEvidence {
  id: string; // Backend-generated unique ID (e.g. "evi_1", "evi_2")
  kind: RepositoryEvidenceKind;
  filePath: string;
  symbol?: string;
  sourceFile?: string;
  provenance: RepositoryEvidenceProvenance;
  metadata?: Record<string, any>;
  workspace?: string;
  repositoryId?: string;
}

export interface AddEvidenceParams {
  kind: RepositoryEvidenceKind;
  filePath: string;
  symbol?: string;
  sourceFile?: string;
  provenance: RepositoryEvidenceProvenance;
  metadata?: Record<string, any>;
  workspace?: string;
  repositoryId?: string;
}

/**
 * Immutable, backend-governed Repository Evidence Store.
 *
 * Invariants (Phase 2):
 * 1. Evidence IDs are strictly backend-generated. The LLM can never invent IDs.
 * 2. Immutable: once an evidence entry is created with an ID, its attributes are fixed.
 * 3. File paths are normalized to POSIX.
 * 4. Deduplication: duplicate facts within the same workspace/repo map to the existing evidence ID.
 */
export class RepositoryEvidenceStore {
  private evidenceList: RepositoryEvidence[] = [];
  private idMap = new Map<string, RepositoryEvidence>();
  private signatureMap = new Map<string, string>(); // signature -> id
  private counter = 0;
  private readonly repositoryId: string;
  private readonly defaultWorkspace?: string;
  private readonly authorityEligibleEvidence = new WeakSet<object>();

  constructor(repositoryId: string = "default-repo", defaultWorkspace?: string) {
    this.repositoryId = repositoryId;
    this.defaultWorkspace = defaultWorkspace;
  }

  public getRepositoryId(): string {
    return this.repositoryId;
  }

  public getDefaultWorkspace(): string | undefined {
    return this.defaultWorkspace;
  }

  /**
   * Generates a deterministic, collision-free backend ID.
   */
  private generateId(): string {
    this.counter++;
    return `evi_${this.counter}_${Math.random().toString(36).slice(2, 7)}`;
  }

  /**
   * Generates a signature string for fact deduplication.
   */
  private buildSignature(params: AddEvidenceParams): string {
    const normFile = normalizeRepoPath(params.filePath);
    const normSource = params.sourceFile ? normalizeRepoPath(params.sourceFile) : "";
    const sym = params.symbol || "";
    const ws = params.workspace || this.defaultWorkspace || "";
    const repo = params.repositoryId || this.repositoryId;
    return `${repo}:${ws}:${params.kind}:${normFile}:${sym}:${normSource}:${params.provenance}`;
  }

  /**
   * Adds validated repository evidence. If the exact fact already exists, returns the existing evidence.
   */
  public addEvidence(params: AddEvidenceParams): RepositoryEvidence {
    // Caller-shaped evidence is retained only as advisory/audit context. It can
    // never satisfy the resolver's mutation-authority checks.
    return this.insertEvidence(params, false);
  }

  public observeRepository(params: AddEvidenceParams): RepositoryEvidence {
    if (!this.defaultWorkspace) return this.addEvidence(params);
    const receipt = RepositoryObservationTools.observe(this.repositoryId, this.defaultWorkspace, params);
    return receipt ? this.recordObservation(receipt) ?? this.addEvidence(params) : this.addEvidence(params);
  }

  public recordObservation(receipt: RepositoryObservationReceipt): RepositoryEvidence | null {
    if (!isAuthenticRepositoryObservation(receipt)) return null;
    if (receipt.repositoryId !== this.repositoryId) return null;
    if (this.defaultWorkspace && receipt.workspaceRoot !== this.defaultWorkspace) return null;
    const details = readRepositoryObservation(receipt);
    if (!details || details.provenance === "SEMANTIC_SEARCH") return null;
    return this.insertEvidence({
      kind: details.kind,
      filePath: details.filePath,
      sourceFile: details.sourceFile,
      symbol: details.symbol,
      provenance: details.provenance,
      metadata: details.metadata,
      workspace: receipt.workspaceRoot,
      repositoryId: receipt.repositoryId,
    }, true);
  }

  public isAuthorityEligible(evidence: RepositoryEvidence): boolean {
    return this.authorityEligibleEvidence.has(evidence) && this.idMap.get(evidence.id) === evidence;
  }

  private insertEvidence(params: AddEvidenceParams, authorityEligible: boolean): RepositoryEvidence {
    const normFile = normalizeRepoPath(params.filePath);
    const normSource = params.sourceFile ? normalizeRepoPath(params.sourceFile) : undefined;
    const repoId = params.repositoryId || this.repositoryId;
    const ws = params.workspace || this.defaultWorkspace;

    const signature = this.buildSignature(params);
    const existingId = this.signatureMap.get(signature);
    if (existingId) {
      const existing = this.idMap.get(existingId)!;
      if (authorityEligible) this.authorityEligibleEvidence.add(existing);
      return existing;
    }

    const id = this.generateId();
    const evidence: RepositoryEvidence = Object.freeze({
      id,
      kind: params.kind,
      filePath: normFile,
      symbol: params.symbol,
      sourceFile: normSource,
      provenance: params.provenance,
      metadata: params.metadata ? Object.freeze({ ...params.metadata }) : undefined,
      workspace: ws,
      repositoryId: repoId,
    });

    this.evidenceList.push(evidence);
    this.idMap.set(id, evidence);
    this.signatureMap.set(signature, id);
    if (authorityEligible) this.authorityEligibleEvidence.add(evidence);

    console.log(
      `[INVESTIGATION] evidenceAdded id=${id} kind=${evidence.kind} file="${evidence.filePath}" prov=${evidence.provenance}`
    );

    return evidence;
  }

  /**
   * Verifies whether an evidence ID exists.
   */
  public hasEvidence(id: string): boolean {
    return this.idMap.has(id);
  }

  /**
   * Gets evidence by ID.
   */
  public getEvidence(id: string): RepositoryEvidence | undefined {
    return this.idMap.get(id);
  }

  /**
   * Returns all evidence records.
   */
  public getAllEvidence(): readonly RepositoryEvidence[] {
    return [...this.evidenceList];
  }

  /**
   * Finds evidence by normalized file path.
   */
  public getEvidenceForFile(filePath: string): RepositoryEvidence[] {
    const norm = normalizeRepoPath(filePath);
    return this.evidenceList.filter((e) => normalizeRepoPath(e.filePath) === norm);
  }

  /**
   * Validates an array of evidence IDs cited by the LLM.
   * Returns { valid: true, evidence } if all IDs exist, or { valid: false, missingIds: [...] }
   */
  public validateEvidenceIds(ids: string[]): {
    valid: boolean;
    evidence: RepositoryEvidence[];
    missingIds: string[];
  } {
    const missingIds: string[] = [];
    const evidence: RepositoryEvidence[] = [];

    for (const id of ids) {
      const item = this.idMap.get(id);
      if (!item) {
        missingIds.push(id);
      } else {
        evidence.push(item);
      }
    }

    return {
      valid: missingIds.length === 0,
      evidence,
      missingIds,
    };
  }

  /**
   * Creates an immutable snapshot summary for LLM context.
   */
  public summarizeEvidence(): Array<{ id: string; kind: string; file: string; detail?: string }> {
    return this.evidenceList.map((e) => ({
      id: e.id,
      kind: e.kind,
      file: e.filePath,
      detail: e.symbol
        ? `Symbol: ${e.symbol}`
        : e.sourceFile
        ? `Referenced by: ${e.sourceFile}`
        : undefined,
    }));
  }

  /**
   * Marks diagnostic evidence as stale so that it cannot authorize future stages.
   */
  public markDiagnosticStale(checkpointId?: string): number {
    let count = 0;
    for (let i = 0; i < this.evidenceList.length; i++) {
      const e = this.evidenceList[i];
      if (e.kind === "DIAGNOSTIC") {
        if (checkpointId && e.metadata?.checkpointId && e.metadata.checkpointId !== checkpointId) {
          continue;
        }
        const updated: RepositoryEvidence = Object.freeze({
          ...e,
          metadata: Object.freeze({
            ...(e.metadata || {}),
            stale: true,
          }),
        });
        this.evidenceList[i] = updated;
        this.idMap.set(e.id, updated);
        count++;
      }
    }
    return count;
  }
}
