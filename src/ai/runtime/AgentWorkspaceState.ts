import path from "path";
import type { DiagnosticBaselineComparison } from "./BaselineDiagnosticVerifier";

export type WorkspaceEvidenceKind = "MATERIALIZED_REPOSITORY" | "SEMANTIC_ADVISORY";

export interface WorkspaceEvidence {
  id: string;
  kind: WorkspaceEvidenceKind;
  description: string;
  path?: string;
  revision?: string;
}

export interface WorkspaceConstraint {
  id: string;
  description: string;
}

export interface WorkspaceValidationFact {
  id: string;
  command: string;
  passed: boolean;
  source: "DETERMINISTIC_TOOL";
}

export interface WorkingPlanReference {
  id: string;
  status: "NOT_STARTED" | "ACTIVE" | "BLOCKED" | "FINISHED";
}

export interface AgentWorkspaceSnapshot {
  repository: {
    projectId: string;
    repositoryId?: string;
    root: string;
    revision?: string;
  };
  evidence: readonly WorkspaceEvidence[];
  relevantPaths: readonly string[];
  constraints: readonly WorkspaceConstraint[];
  validationFacts: readonly WorkspaceValidationFact[];
  diagnosticComparisons: readonly DiagnosticBaselineComparison[];
  workingPlan?: WorkingPlanReference;
  authority: "KNOWLEDGE_ONLY_NO_MUTATION_AUTHORITY";
}

export interface AgentWorkspaceStateInput {
  projectId: string;
  repositoryId?: string;
  root: string;
  revision?: string;
  constraints?: WorkspaceConstraint[];
}

function requireText(value: string | undefined, field: string): string {
  if (!value || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function normalizeRelativePath(value: string): string {
  const candidate = requireText(value, "workspace path").replace(/\\/g, "/");
  if (path.isAbsolute(candidate) || candidate === ".." || candidate.startsWith("../")) {
    throw new Error(`Workspace path must remain repository-relative: ${value}`);
  }
  const normalized = path.posix.normalize(candidate).replace(/^\.\//, "");
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`Invalid repository-relative workspace path: ${value}`);
  }
  return normalized;
}

function freezeSnapshot(snapshot: AgentWorkspaceSnapshot): AgentWorkspaceSnapshot {
  Object.freeze(snapshot.repository);
  snapshot.evidence.forEach(Object.freeze);
  snapshot.constraints.forEach(Object.freeze);
  snapshot.validationFacts.forEach(Object.freeze);
  snapshot.diagnosticComparisons.forEach(Object.freeze);
  if (snapshot.workingPlan) Object.freeze(snapshot.workingPlan);
  Object.freeze(snapshot.evidence);
  Object.freeze(snapshot.relevantPaths);
  Object.freeze(snapshot.constraints);
  Object.freeze(snapshot.validationFacts);
  Object.freeze(snapshot.diagnosticComparisons);
  return Object.freeze(snapshot);
}

/** Immutable knowledge snapshot. It deliberately exposes no filesystem mutation operation. */
export class AgentWorkspaceState {
  private constructor(private readonly value: AgentWorkspaceSnapshot) {}

  public static create(input: AgentWorkspaceStateInput): AgentWorkspaceState {
    const root = path.resolve(requireText(input.root, "repository root"));
    const constraints = (input.constraints ?? []).map((constraint) => ({
      id: requireText(constraint.id, "constraint id"),
      description: requireText(constraint.description, "constraint description"),
    }));
    return new AgentWorkspaceState(freezeSnapshot({
      repository: {
        projectId: requireText(input.projectId, "projectId"),
        ...(input.repositoryId ? { repositoryId: requireText(input.repositoryId, "repositoryId") } : {}),
        root,
        ...(input.revision ? { revision: requireText(input.revision, "revision") } : {}),
      },
      evidence: [],
      relevantPaths: [],
      constraints,
      validationFacts: [],
      diagnosticComparisons: [],
      authority: "KNOWLEDGE_ONLY_NO_MUTATION_AUTHORITY",
    }));
  }

  public withEvidence(evidence: WorkspaceEvidence): AgentWorkspaceState {
    const normalized: WorkspaceEvidence = {
      id: requireText(evidence.id, "evidence id"),
      kind: evidence.kind,
      description: requireText(evidence.description, "evidence description"),
      ...(evidence.path ? { path: normalizeRelativePath(evidence.path) } : {}),
      ...(evidence.revision ? { revision: requireText(evidence.revision, "evidence revision") } : {}),
    };
    if (normalized.kind !== "MATERIALIZED_REPOSITORY" && normalized.kind !== "SEMANTIC_ADVISORY") {
      throw new Error(`Unsupported workspace evidence kind: ${String(normalized.kind)}`);
    }
    if (this.value.evidence.some((item) => item.id === normalized.id)) {
      throw new Error(`Duplicate workspace evidence id: ${normalized.id}`);
    }
    return this.copy({ evidence: [...this.value.evidence, normalized] });
  }

  public withRelevantPaths(paths: string[]): AgentWorkspaceState {
    const relevantPaths = [...new Set(paths.map(normalizeRelativePath))].sort();
    return this.copy({ relevantPaths });
  }

  public withValidationFact(fact: WorkspaceValidationFact): AgentWorkspaceState {
    if (fact.source !== "DETERMINISTIC_TOOL") {
      throw new Error("Validation facts require deterministic tool provenance");
    }
    if (typeof fact.passed !== "boolean") {
      throw new Error("Validation fact passed must be boolean");
    }
    const normalized: WorkspaceValidationFact = {
      id: requireText(fact.id, "validation fact id"),
      command: requireText(fact.command, "validation command"),
      passed: fact.passed,
      source: "DETERMINISTIC_TOOL",
    };
    if (this.value.validationFacts.some((item) => item.id === normalized.id)) {
      throw new Error(`Duplicate validation fact id: ${normalized.id}`);
    }
    return this.copy({ validationFacts: [...this.value.validationFacts, normalized] });
  }

  public withDiagnosticComparison(comparison: DiagnosticBaselineComparison): AgentWorkspaceState {
    if (comparison.source !== "DETERMINISTIC_COMPARISON") {
      throw new Error("Diagnostic comparisons require deterministic comparison provenance");
    }
    return this.copy({ diagnosticComparisons: [...this.value.diagnosticComparisons, comparison] });
  }

  public withWorkingPlan(reference: WorkingPlanReference): AgentWorkspaceState {
    const statuses: WorkingPlanReference["status"][] = ["NOT_STARTED", "ACTIVE", "BLOCKED", "FINISHED"];
    if (!statuses.includes(reference.status)) throw new Error(`Invalid working plan status: ${reference.status}`);
    return this.copy({ workingPlan: { id: requireText(reference.id, "working plan id"), status: reference.status } });
  }

  public snapshot(): AgentWorkspaceSnapshot {
    return this.value;
  }

  private copy(changes: Partial<AgentWorkspaceSnapshot>): AgentWorkspaceState {
    return new AgentWorkspaceState(freezeSnapshot({
      ...this.value,
      ...changes,
      repository: { ...this.value.repository },
      evidence: [...(changes.evidence ?? this.value.evidence)],
      relevantPaths: [...(changes.relevantPaths ?? this.value.relevantPaths)],
      constraints: [...this.value.constraints],
      validationFacts: [...(changes.validationFacts ?? this.value.validationFacts)],
      diagnosticComparisons: [...(changes.diagnosticComparisons ?? this.value.diagnosticComparisons)],
      ...(changes.workingPlan || this.value.workingPlan
        ? { workingPlan: { ...(changes.workingPlan ?? this.value.workingPlan!) } }
        : {}),
    }));
  }
}
