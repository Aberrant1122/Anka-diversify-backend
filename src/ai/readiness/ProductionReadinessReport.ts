export const RELEASE_READINESS_CATEGORIES = [
  "ARCHITECTURE",
  "AUTHORIZATION",
  "EDITING",
  "VALIDATION",
  "ROLLBACK",
  "COMPLETION",
  "LOOP",
  "GIT_ISOLATION",
  "SHIPPING",
  "REMOTE_REVIEW",
  "SECURITY",
  "CONCURRENCY",
  "RECOVERY",
  "REGRESSIONS",
] as const;

export type ReleaseReadinessCategory = (typeof RELEASE_READINESS_CATEGORIES)[number];
export type ReleaseReadinessStatus = "PASS" | "FAIL" | "NOT_TESTED";
export type OverallReadiness = "PRODUCTION_CAPABLE_BETA" | "NOT_READY";

export interface ReleaseReadinessEvidence {
  readonly id: string;
  readonly category: ReleaseReadinessCategory;
  readonly passed: boolean;
  readonly testId: string;
}

export interface ProviderInvariantCounts {
  readonly generativeProviderBypass: number;
  readonly embeddingProviderBypass: number;
  readonly hardcodedGenerativeModelSelection: number;
  readonly callStructuredMissingValidate: number;
  readonly modelDerivedOperationalSuccess: number;
}

export interface ReleaseSeverityCounts {
  readonly blocker: number;
  readonly high: number;
  readonly medium: number;
}

export interface ProductionReadinessInput {
  readonly evidence: readonly ReleaseReadinessEvidence[];
  readonly invariantCounts: ProviderInvariantCounts;
  readonly severityCounts: ReleaseSeverityCounts;
  readonly typeScriptPassed: boolean;
  readonly diffCheckPassed: boolean;
}

export interface ProductionReadinessCategoryResult {
  readonly category: ReleaseReadinessCategory;
  readonly status: ReleaseReadinessStatus;
  readonly evidenceIds: readonly string[];
  readonly testIds: readonly string[];
}

export interface ProductionReadinessReport {
  readonly source: "DETERMINISTIC_CP12_READINESS_EVALUATOR";
  readonly categories: Readonly<Record<ReleaseReadinessCategory, ProductionReadinessCategoryResult>>;
  readonly invariantCounts: ProviderInvariantCounts;
  readonly severityCounts: ReleaseSeverityCounts;
  readonly typeScriptPassed: boolean;
  readonly diffCheckPassed: boolean;
  readonly overall: OverallReadiness;
}

const COUNT_FIELDS: readonly (keyof ProviderInvariantCounts)[] = [
  "generativeProviderBypass",
  "embeddingProviderBypass",
  "hardcodedGenerativeModelSelection",
  "callStructuredMissingValidate",
  "modelDerivedOperationalSuccess",
];

function requireCount(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function requireText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} must be a non-empty string`);
  return normalized;
}

function freezeInvariantCounts(counts: ProviderInvariantCounts): ProviderInvariantCounts {
  return Object.freeze({
    generativeProviderBypass: requireCount(counts.generativeProviderBypass, "generativeProviderBypass"),
    embeddingProviderBypass: requireCount(counts.embeddingProviderBypass, "embeddingProviderBypass"),
    hardcodedGenerativeModelSelection: requireCount(counts.hardcodedGenerativeModelSelection, "hardcodedGenerativeModelSelection"),
    callStructuredMissingValidate: requireCount(counts.callStructuredMissingValidate, "callStructuredMissingValidate"),
    modelDerivedOperationalSuccess: requireCount(counts.modelDerivedOperationalSuccess, "modelDerivedOperationalSuccess"),
  });
}

/**
 * Deterministic CP12 release gate. It consumes only explicit test/tool evidence;
 * model prose, manifests, plans, and agent responses are intentionally absent.
 */
export class ProductionReadinessEvaluator {
  public static evaluate(input: ProductionReadinessInput): ProductionReadinessReport {
    if (!input || !Array.isArray(input.evidence)) throw new Error("Readiness evidence is required");

    const seenEvidenceIds = new Set<string>();
    const evidence = input.evidence.map((item) => {
      if (!RELEASE_READINESS_CATEGORIES.includes(item.category)) {
        throw new Error(`Unknown release-readiness category: ${String(item.category)}`);
      }
      const id = requireText(item.id, "evidence id");
      const testId = requireText(item.testId, "test id");
      if (seenEvidenceIds.has(id)) throw new Error(`Duplicate readiness evidence id: ${id}`);
      if (typeof item.passed !== "boolean") throw new Error(`Readiness evidence ${id} requires a boolean result`);
      seenEvidenceIds.add(id);
      return Object.freeze({ id, category: item.category, passed: item.passed, testId });
    });

    const categories = {} as Record<ReleaseReadinessCategory, ProductionReadinessCategoryResult>;
    for (const category of RELEASE_READINESS_CATEGORIES) {
      const categoryEvidence = evidence.filter((item) => item.category === category);
      const status: ReleaseReadinessStatus = categoryEvidence.length === 0
        ? "NOT_TESTED"
        : categoryEvidence.every((item) => item.passed)
          ? "PASS"
          : "FAIL";
      categories[category] = Object.freeze({
        category,
        status,
        evidenceIds: Object.freeze(categoryEvidence.map((item) => item.id).sort()),
        testIds: Object.freeze([...new Set(categoryEvidence.map((item) => item.testId))].sort()),
      });
    }

    const invariantCounts = freezeInvariantCounts(input.invariantCounts);
    const severityCounts = Object.freeze({
      blocker: requireCount(input.severityCounts.blocker, "blocker"),
      high: requireCount(input.severityCounts.high, "high"),
      medium: requireCount(input.severityCounts.medium, "medium"),
    });
    const mandatoryCategoriesPass = RELEASE_READINESS_CATEGORIES.every(
      (category) => categories[category].status === "PASS",
    );
    const invariantCountsAreZero = COUNT_FIELDS.every((field) => invariantCounts[field] === 0);
    const overall: OverallReadiness = mandatoryCategoriesPass
      && severityCounts.blocker === 0
      && severityCounts.high === 0
      && input.typeScriptPassed === true
      && input.diffCheckPassed === true
      && invariantCountsAreZero
      ? "PRODUCTION_CAPABLE_BETA"
      : "NOT_READY";

    return Object.freeze({
      source: "DETERMINISTIC_CP12_READINESS_EVALUATOR",
      categories: Object.freeze(categories),
      invariantCounts,
      severityCounts,
      typeScriptPassed: input.typeScriptPassed === true,
      diffCheckPassed: input.diffCheckPassed === true,
      overall,
    });
  }
}
