import { DocumentationContent, DocumentationProviderDraft, DocumentationProviderRoot } from "../documentation-schema";
import {
  DOCUMENTATION_SECTION_DEPENDENCY_CLOSURE,
  computeDocumentationDiff,
  isNoOpDocumentationRevision,
  validateDocumentationRevisionStableIds,
  validateDocumentationRevisionTarget,
  validateDocumentationSectionScope,
} from "../documentation-revision-policy";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function draft(): DocumentationProviderDraft {
  return {
    overview: { summary: "Summary", scope: "Scope", goals: [], nonGoals: [] },
    systemActors: [{ id: "A", name: "Actor", description: "Actor", sourceActorIds: [] }],
    features: [{ id: "F", title: "Feature", description: "Feature", workflowSteps: ["Work"], actorIds: ["A"], access: "public", sourceRequirementIds: ["FR-1"], sourceUserStoryIds: [] }],
    apiContracts: { applicable: false, rationale: "None", items: [] },
    dataEntities: { applicable: false, rationale: "None", items: [] },
    businessRules: [{ id: "B", title: "Rule", condition: "Always", expectedBehavior: "Work", relatedFeatureIds: ["F"], relatedEntityIds: [], sourceRequirementIds: [], sourceUserStoryIds: [] }],
    permissionRules: { applicable: false, rationale: "Public", items: [] },
    errorBehaviors: [{ id: "ER", code: "FAILED", scenario: "Failure", expectedSystemBehavior: "Reject", recoveryBehavior: "Retry", relatedFeatureIds: ["F"], relatedApiContractIds: [] }],
    edgeCases: [{ id: "EC", scenario: "Boundary", expectedHandling: "Handle", relatedFeatureIds: ["F"], relatedApiContractIds: [], relatedEntityIds: [] }],
    unresolvedQuestions: [],
  };
}

function canonical(input = draft()): DocumentationContent {
  return { ...input, requirementsTraceability: [{ requirementId: "FR-1", requirementKind: "functional", coveredByFeatureIds: ["F"], coveredByApiContractIds: [], coveredByDataEntityIds: [], coveredByBusinessRuleIds: [], coverageStatus: "covered" }], sourceRequirements: { artifactId: "REQ", version: 1, contentHash: "a".repeat(64) } };
}

describe("Documentation revision policy", () => {
  test("detects canonical provider-owned no-ops and ignores server-owned root changes", () => {
    expect(isNoOpDocumentationRevision(draft(), clone(draft()))).toBe(true);
    const next = canonical(); next.sourceRequirements.version = 2; next.requirementsTraceability[0].coveredByBusinessRuleIds = ["B"];
    expect(isNoOpDocumentationRevision(canonical(), next)).toBe(true);
    expect(computeDocumentationDiff(canonical(), next).changedRootSections).toEqual([]);
  });

  test("reports changed roots and added, removed, retained, and modified IDs", () => {
    const base = draft(); const next = clone(base);
    next.overview.summary = "Changed";
    next.features[0].description = "Modified";
    next.businessRules = [];
    next.edgeCases.push({ ...clone(next.edgeCases[0]), id: "EC-2", scenario: "Another" });
    expect(computeDocumentationDiff(base, next)).toEqual(expect.objectContaining({
      changedRootSections: ["overview", "features", "businessRules", "edgeCases"],
      addedIds: ["EC-2"], removedIds: ["B"], modifiedIds: ["F"],
    }));
    expect(computeDocumentationDiff(base, next).retainedIds).toEqual(expect.arrayContaining(["A", "EC", "ER"]));
  });

  test("rejects an existing ID moved to another root", () => {
    const base = draft(); const next = clone(base);
    const moved = next.businessRules.pop()!;
    next.edgeCases.push({ id: moved.id, scenario: moved.condition, expectedHandling: moved.expectedBehavior, relatedFeatureIds: moved.relatedFeatureIds, relatedApiContractIds: [], relatedEntityIds: [] });
    expect(() => validateDocumentationRevisionStableIds(base, next)).toThrow(expect.objectContaining({ code: "DOCUMENTATION_STABLE_ID_INVALID" }));
  });

  test("rejects invalid and document-wide duplicate successor IDs", () => {
    const invalid = draft(); invalid.features[0].id = "bad id";
    expect(() => validateDocumentationRevisionStableIds(draft(), invalid)).toThrow(expect.objectContaining({ code: "DOCUMENTATION_STABLE_ID_INVALID" }));
    const duplicate = draft(); duplicate.edgeCases[0].id = "F";
    expect(() => validateDocumentationRevisionStableIds(draft(), duplicate)).toThrow(expect.objectContaining({ code: "DOCUMENTATION_STABLE_ID_INVALID" }));
  });

  test("rejects exact-payload ID churn but allows retained-ID edits and legitimate additions/removals", () => {
    const churn = draft(); churn.edgeCases[0].id = "EC-NEW";
    expect(() => validateDocumentationRevisionStableIds(draft(), churn)).toThrow(expect.objectContaining({ code: "DOCUMENTATION_STABLE_ID_INVALID" }));
    const legitimate = draft(); legitimate.features[0].description = "New description"; legitimate.businessRules = [];
    legitimate.edgeCases.push({ ...clone(legitimate.edgeCases[0]), id: "EC-2", scenario: "Different payload" });
    expect(() => validateDocumentationRevisionStableIds(draft(), legitimate)).not.toThrow();
  });

  test.each(Object.entries(DOCUMENTATION_SECTION_DEPENDENCY_CLOSURE) as Array<[DocumentationProviderRoot, readonly DocumentationProviderRoot[]]>)
  ("accepts every root in the %s closure", (target, allowed) => {
    expect(validateDocumentationRevisionTarget("SECTION_REVISION", target)).toEqual({ targetSectionKey: target, allowedSectionKeys: allowed });
    expect(() => validateDocumentationSectionScope(target, allowed, allowed)).not.toThrow();
  });

  test.each(Object.entries(DOCUMENTATION_SECTION_DEPENDENCY_CLOSURE) as Array<[DocumentationProviderRoot, readonly DocumentationProviderRoot[]]>)
  ("rejects an escape from the %s closure", (target, allowed) => {
    const escape = (Object.keys(DOCUMENTATION_SECTION_DEPENDENCY_CLOSURE) as DocumentationProviderRoot[]).find((key) => !allowed.includes(key));
    expect(escape).toBeDefined();
    expect(() => validateDocumentationSectionScope(target, allowed, [escape!])).toThrow(expect.objectContaining({ code: "DOCUMENTATION_SECTION_SCOPE_INVALID" }));
  });

  test("rejects server-owned targets, unknown operations, and whole-document targets", () => {
    for (const target of ["sourceRequirements", "requirementsTraceability"]) {
      expect(() => validateDocumentationRevisionTarget("SECTION_REGENERATION", target)).toThrow(expect.objectContaining({ code: "DOCUMENTATION_SECTION_SCOPE_INVALID" }));
    }
    expect(() => validateDocumentationRevisionTarget("UNKNOWN", null)).toThrow(expect.objectContaining({ code: "DOCUMENTATION_SECTION_SCOPE_INVALID" }));
    expect(() => validateDocumentationRevisionTarget("DOCUMENT_REVISION", "overview")).toThrow(expect.objectContaining({ code: "DOCUMENTATION_SECTION_SCOPE_INVALID" }));
    expect(validateDocumentationRevisionTarget("FEEDBACK_APPLICATION", null)).toEqual({ targetSectionKey: null, allowedSectionKeys: null });
  });
});
