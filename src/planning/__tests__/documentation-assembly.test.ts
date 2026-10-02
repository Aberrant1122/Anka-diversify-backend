import {
  assembleDocumentationContent,
  collectDocumentationGraphIssues,
  deriveDocumentationRequirementsTraceability,
  normalizeDocumentationProviderDraft,
} from "../documentation-assembly";
import { DocumentationProviderDraft, DocumentationValidationError } from "../documentation-schema";
import { hashRequirementsContent, RequirementsContent } from "../requirements-schema";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function upstream(): RequirementsContent {
  return { projectGoal: "Goal", problemStatement: "Problem", usersAndActors: [{ id: "ACT-1", name: "User", description: "User" }], userStories: [{ id: "US-1", actor: "User", capability: "work", benefit: "value", acceptanceCriteriaIds: ["AC-1"] }], functionalRequirements: [{ id: "FR-1", title: "Work", description: "Work" }], nonFunctionalRequirements: [{ id: "NFR-1", title: "Quality", description: "Quality" }], constraints: [], integrations: [], assumptions: [], acceptanceCriteria: [{ id: "AC-1", description: "Done", relatedRequirementIds: ["FR-1"] }], outOfScope: [], unresolvedQuestions: [] };
}

function valid(): DocumentationProviderDraft {
  return {
    overview: { summary: "Summary", scope: "Scope", goals: [], nonGoals: [] },
    systemActors: [{ id: "A", name: "User", description: "User", sourceActorIds: ["ACT-1"] }],
    features: [{ id: "F", title: "Work", description: "Work", workflowSteps: ["Do work"], actorIds: ["A"], access: "controlled", sourceRequirementIds: ["FR-1"], sourceUserStoryIds: ["US-1"] }],
    apiContracts: { applicable: true, rationale: "", items: [{ id: "API", name: "Work", description: "Work", interaction: { kind: "http", method: "POST", path: "/work" }, access: "controlled", input: { description: "Input", fields: [] }, success: { description: "Success", fields: [] }, relatedFeatureIds: ["F"], relatedEntityIds: ["E"], errorBehaviorIds: ["ERR"], sourceRequirementIds: ["NFR-1"], sourceUserStoryIds: [] }] },
    dataEntities: { applicable: true, rationale: "", items: [{ id: "E", name: "Entity", description: "Entity", fields: [{ name: "id", logicalType: "identifier", required: true, description: "ID", allowedValues: [], validationRules: [] }], relationships: [{ targetEntityId: "E", cardinality: "one_to_many", required: false, description: "Self" }], sourceRequirementIds: [], sourceUserStoryIds: [] }] },
    businessRules: [{ id: "BR", title: "Rule", condition: "Always", expectedBehavior: "Work", relatedFeatureIds: ["F"], relatedEntityIds: [], sourceRequirementIds: [], sourceUserStoryIds: [] }],
    permissionRules: { applicable: true, rationale: "", items: [{ id: "P", title: "Allow", description: "Allow", effect: "allow", actorIds: ["A"], actions: ["work"], relatedFeatureIds: ["F"], relatedApiContractIds: ["API"] }] },
    errorBehaviors: [{ id: "ERR", code: "WORK_FAILED", scenario: "Failure", expectedSystemBehavior: "Reject", recoveryBehavior: "Retry", relatedFeatureIds: ["F"], relatedApiContractIds: ["API"], httpStatus: 400 }],
    edgeCases: [{ id: "EDGE", scenario: "Boundary", expectedHandling: "Handle", relatedFeatureIds: ["F"], relatedApiContractIds: ["API"], relatedEntityIds: ["E"] }], unresolvedQuestions: [],
  };
}

function source(requirements = upstream()) { return { artifactId: "REQ", version: 1, contentHash: hashRequirementsContent(requirements) }; }
function codes(value: DocumentationProviderDraft): string[] { return collectDocumentationGraphIssues(value, upstream()).map(({ code }) => code); }

describe("Documentation assembly", () => {
  test("assembles a valid graph, stamps provenance, sorts IDs, and derives functional/NFR traceability", () => {
    const input = valid();
    input.features.push({ ...clone(input.features[0]), id: "B", title: "Second", access: "public", sourceRequirementIds: ["NFR-1"], sourceUserStoryIds: [] });
    input.errorBehaviors.push({ ...clone(input.errorBehaviors[0]), id: "ERR-B", code: "B_FAILED", relatedFeatureIds: ["B"], relatedApiContractIds: [], httpStatus: undefined });
    delete input.errorBehaviors[1].httpStatus;
    input.edgeCases.push({ ...clone(input.edgeCases[0]), id: "EDGE-B", relatedFeatureIds: ["B"], relatedApiContractIds: [], relatedEntityIds: [] });
    const content = assembleDocumentationContent(input, source(), upstream());
    expect(content.features.map(({ id }) => id)).toEqual(["B", "F"]);
    expect(content.sourceRequirements).toEqual(source());
    expect(content.requirementsTraceability).toEqual(deriveDocumentationRequirementsTraceability(content, upstream()));
    expect(content.requirementsTraceability.map(({ requirementId, coverageStatus }) => [requirementId, coverageStatus])).toEqual([["FR-1", "covered"], ["NFR-1", "covered"]]);
  });

  test("rejects upstream hash mismatch and provider attempts to forge server roots", () => {
    expect(() => assembleDocumentationContent(valid(), { ...source(), contentHash: "0".repeat(64) }, upstream())).toThrow(expect.objectContaining({ code: "DOCUMENTATION_REFERENCE_INVALID" }));
    for (const root of ["sourceRequirements", "requirementsTraceability"]) {
      expect(() => assembleDocumentationContent({ ...valid(), [root]: {} }, source(), upstream())).toThrow(DocumentationValidationError);
    }
  });

  test.each([
    ["actor upstream", (d: DocumentationProviderDraft) => { d.systemActors[0].sourceActorIds = ["MISSING"]; }, "DOCS_DANGLING_ACTOR_REFERENCE"],
    ["feature actor", (d: DocumentationProviderDraft) => { d.features[0].actorIds = ["MISSING"]; }, "DOCS_DANGLING_ACTOR_REFERENCE"],
    ["requirement", (d: DocumentationProviderDraft) => { d.features[0].sourceRequirementIds = ["MISSING"]; }, "DOCS_DANGLING_REQUIREMENT_REFERENCE"],
    ["story", (d: DocumentationProviderDraft) => { d.features[0].sourceUserStoryIds = ["MISSING"]; }, "DOCS_DANGLING_USER_STORY_REFERENCE"],
    ["API feature", (d: DocumentationProviderDraft) => { d.apiContracts.items[0].relatedFeatureIds = ["MISSING"]; }, "DOCS_DANGLING_FEATURE_REFERENCE"],
    ["API entity", (d: DocumentationProviderDraft) => { d.apiContracts.items[0].relatedEntityIds = ["MISSING"]; }, "DOCS_DANGLING_ENTITY_REFERENCE"],
    ["API error", (d: DocumentationProviderDraft) => { d.apiContracts.items[0].errorBehaviorIds = ["MISSING"]; }, "DOCS_DANGLING_ERROR_REFERENCE"],
    ["entity relation", (d: DocumentationProviderDraft) => { d.dataEntities.items[0].relationships[0].targetEntityId = "MISSING"; }, "DOCS_DANGLING_ENTITY_REFERENCE"],
    ["business feature", (d: DocumentationProviderDraft) => { d.businessRules[0].relatedFeatureIds = ["MISSING"]; }, "DOCS_DANGLING_FEATURE_REFERENCE"],
    ["permission API", (d: DocumentationProviderDraft) => { d.permissionRules.items[0].relatedApiContractIds = ["MISSING"]; }, "DOCS_DANGLING_API_REFERENCE"],
    ["error feature", (d: DocumentationProviderDraft) => { d.errorBehaviors[0].relatedFeatureIds = ["MISSING"]; }, "DOCS_DANGLING_FEATURE_REFERENCE"],
    ["edge entity", (d: DocumentationProviderDraft) => { d.edgeCases[0].relatedEntityIds = ["MISSING"]; }, "DOCS_DANGLING_ENTITY_REFERENCE"],
  ] as const)("detects dangling %s references", (_name, mutate, expected) => {
    const input = valid(); mutate(input); expect(codes(input)).toContain(expected);
  });

  test("enforces document-wide ID uniqueness", () => {
    const input = valid(); input.edgeCases[0].id = "F";
    expect(() => collectDocumentationGraphIssues(input, upstream())).toThrow(expect.objectContaining({ code: "DOCUMENTATION_STABLE_ID_INVALID" }));
  });

  test("enforces coverage, permission access, API links, and bidirectional error consistency", () => {
    const cases: Array<[string, (d: DocumentationProviderDraft) => void, string]> = [
      ["functional", (d) => { d.features[0].sourceRequirementIds = []; }, "DOCS_FUNCTIONAL_REQUIREMENT_UNCOVERED"],
      ["feature error", (d) => { d.errorBehaviors[0].relatedFeatureIds = []; }, "DOCS_FEATURE_ERROR_COVERAGE_REQUIRED"],
      ["feature edge", (d) => { d.edgeCases[0].relatedFeatureIds = []; }, "DOCS_FEATURE_EDGE_COVERAGE_REQUIRED"],
      ["controlled feature", (d) => { d.permissionRules.items[0].relatedFeatureIds = []; }, "DOCS_PERMISSION_COVERAGE_REQUIRED"],
      ["controlled API", (d) => { d.permissionRules.items[0].relatedApiContractIds = []; }, "DOCS_API_PERMISSION_COVERAGE_REQUIRED"],
      ["API feature", (d) => { d.apiContracts.items[0].relatedFeatureIds = []; }, "DOCS_API_FEATURE_LINK_REQUIRED"],
      ["API error", (d) => { d.apiContracts.items[0].errorBehaviorIds = []; }, "DOCS_API_ERROR_LINK_REQUIRED"],
      ["reverse link", (d) => { d.errorBehaviors[0].relatedApiContractIds = []; delete d.errorBehaviors[0].httpStatus; }, "DOCS_ERROR_API_LINK_INCONSISTENT"],
      ["public permission target", (d) => { d.features[0].access = "public"; }, "DOCS_PERMISSION_APPLICABILITY_INVALID"],
    ];
    for (const [, mutate, expected] of cases) { const input = valid(); mutate(input); expect(codes(input)).toContain(expected); }
  });

  test("accepts a fully valid not-applicable API/data/permission graph", () => {
    const input = valid();
    input.features[0].access = "public";
    input.apiContracts = { applicable: false, rationale: "No machine interface.", items: [] };
    input.dataEntities = { applicable: false, rationale: "No logical data.", items: [] };
    input.permissionRules = { applicable: false, rationale: "All behavior is public.", items: [] };
    input.businessRules[0].relatedEntityIds = [];
    input.errorBehaviors[0].relatedApiContractIds = []; delete input.errorBehaviors[0].httpStatus;
    input.edgeCases[0].relatedApiContractIds = []; input.edgeCases[0].relatedEntityIds = [];
    expect(codes(input)).toEqual([]);
    const content = assembleDocumentationContent(input, source(), upstream());
    expect(content.requirementsTraceability.every((row) => row.coveredByApiContractIds.length === 0 && row.coveredByDataEntityIds.length === 0)).toBe(true);
  });

  test("detects applicability contradictions represented by cross-section references", () => {
    const api = valid(); api.apiContracts = { applicable: false, rationale: "None", items: [] };
    expect(codes(api)).toContain("DOCS_API_APPLICABILITY_INVALID");
    const data = valid(); data.dataEntities = { applicable: false, rationale: "None", items: [] };
    expect(codes(data)).toContain("DOCS_DATA_APPLICABILITY_INVALID");
    const permission = valid(); permission.permissionRules = { applicable: false, rationale: "None", items: [] };
    expect(codes(permission)).toContain("DOCS_PERMISSION_APPLICABILITY_INVALID");
  });

  test("enforces HTTP-only status rules, mixed transports, range, and link presence", () => {
    const missing = valid(); delete missing.errorBehaviors[0].httpStatus; expect(codes(missing)).toContain("DOCS_HTTP_STATUS_INVALID");
    const range = valid(); range.errorBehaviors[0].httpStatus = 99; expect(codes(range)).toContain("DOCS_HTTP_STATUS_INVALID");
    const orphan = valid(); orphan.errorBehaviors[0].relatedApiContractIds = []; expect(codes(orphan)).toContain("DOCS_HTTP_STATUS_INVALID");
    const nonHttp = valid(); nonHttp.apiContracts.items[0].interaction = { kind: "command", command: "work" }; expect(codes(nonHttp)).toContain("DOCS_HTTP_STATUS_INVALID");
    const mixed = valid();
    mixed.apiContracts.items.push({ ...clone(mixed.apiContracts.items[0]), id: "API-2", interaction: { kind: "event", direction: "publish", channel: "work" }, errorBehaviorIds: ["ERR"], relatedEntityIds: [] });
    mixed.errorBehaviors[0].relatedApiContractIds.push("API-2"); mixed.permissionRules.items[0].relatedApiContractIds.push("API-2");
    expect(codes(mixed)).toContain("DOCS_HTTP_STATUS_INVALID");
  });

  test("normalizes root arrays, reference arrays, and relationships without reordering authored workflows", () => {
    const input = valid(); input.features[0].actorIds = ["A"]; input.features[0].workflowSteps = ["z", "a"];
    input.dataEntities.items[0].relationships.push({ targetEntityId: "E", cardinality: "many_to_many", required: false, description: "Many" });
    const normalized = normalizeDocumentationProviderDraft(input);
    expect(normalized.features[0].workflowSteps).toEqual(["z", "a"]);
    expect(normalized.dataEntities.items[0].relationships.map(({ cardinality }) => cardinality)).toEqual(["many_to_many", "one_to_many"]);
  });

  test("retains uncovered NFR trace rows", () => {
    const input = valid(); input.apiContracts.items[0].sourceRequirementIds = [];
    const trace = deriveDocumentationRequirementsTraceability(input, upstream());
    expect(trace.find(({ requirementId }) => requirementId === "NFR-1")).toEqual(expect.objectContaining({ coverageStatus: "uncovered" }));
  });
});
