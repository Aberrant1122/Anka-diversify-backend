import { assembleDocumentationContent } from "../../planning/documentation-assembly";
import {
  DocumentationContent,
  DocumentationProviderDraft,
  hashDocumentationContent,
  renderDocumentationMarkdown,
} from "../../planning/documentation-schema";
import { hashRequirementsContent, RequirementsContent } from "../../planning/requirements-schema";
import {
  DocumentationReadinessArtifact,
  PlanningDocumentationReadinessService,
} from "../planning-documentation-readiness.service";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function requirements(): RequirementsContent {
  return { projectGoal: "Goal", problemStatement: "Problem", usersAndActors: [{ id: "ACT", name: "User", description: "User" }], userStories: [{ id: "US", actor: "User", capability: "work", benefit: "value", acceptanceCriteriaIds: ["AC"] }], functionalRequirements: [{ id: "FR", title: "Work", description: "Work" }], nonFunctionalRequirements: [{ id: "NFR", title: "Quality", description: "Quality" }], constraints: [], integrations: [], assumptions: [], acceptanceCriteria: [{ id: "AC", description: "Done", relatedRequirementIds: ["FR"] }], outOfScope: [], unresolvedQuestions: [] };
}

function draft(): DocumentationProviderDraft {
  return {
    overview: { summary: "Summary", scope: "Scope", goals: [], nonGoals: [] },
    systemActors: [{ id: "A", name: "User", description: "User", sourceActorIds: ["ACT"] }],
    features: [{ id: "F", title: "Work", description: "Work", workflowSteps: ["Work"], actorIds: ["A"], access: "controlled", sourceRequirementIds: ["FR"], sourceUserStoryIds: ["US"] }],
    apiContracts: { applicable: true, rationale: "", items: [{ id: "API", name: "Work", description: "Work", interaction: { kind: "http", method: "POST", path: "/work" }, access: "controlled", input: { description: "Input", fields: [] }, success: { description: "Success", fields: [] }, relatedFeatureIds: ["F"], relatedEntityIds: ["E"], errorBehaviorIds: ["ERR"], sourceRequirementIds: ["NFR"], sourceUserStoryIds: [] }] },
    dataEntities: { applicable: true, rationale: "", items: [{ id: "E", name: "Entity", description: "Entity", fields: [{ name: "id", logicalType: "identifier", required: true, description: "ID", allowedValues: [], validationRules: [] }], relationships: [], sourceRequirementIds: [], sourceUserStoryIds: [] }] },
    businessRules: [{ id: "BR", title: "Rule", condition: "Always", expectedBehavior: "Work", relatedFeatureIds: ["F"], relatedEntityIds: [], sourceRequirementIds: [], sourceUserStoryIds: [] }],
    permissionRules: { applicable: true, rationale: "", items: [{ id: "P", title: "Allow", description: "Allow", effect: "allow", actorIds: ["A"], actions: ["work"], relatedFeatureIds: ["F"], relatedApiContractIds: ["API"] }] },
    errorBehaviors: [{ id: "ERR", code: "FAILED", scenario: "Failure", expectedSystemBehavior: "Reject", recoveryBehavior: "Retry", relatedFeatureIds: ["F"], relatedApiContractIds: ["API"], httpStatus: 400 }],
    edgeCases: [{ id: "EDGE", scenario: "Boundary", expectedHandling: "Handle", relatedFeatureIds: ["F"], relatedApiContractIds: ["API"], relatedEntityIds: ["E"] }], unresolvedQuestions: [],
  };
}

function content(input = draft(), req = requirements()): DocumentationContent {
  return assembleDocumentationContent(input, { artifactId: "REQ", version: 1, contentHash: hashRequirementsContent(req) }, req);
}

function artifact(value: DocumentationContent): DocumentationReadinessArtifact {
  return { id: "DOC", structuredContent: value, content: renderDocumentationMarkdown(value), contentHash: hashDocumentationContent(value) };
}

function evaluate(value: DocumentationContent, req = requirements()) {
  return new PlanningDocumentationReadinessService().evaluateDocumentation({ artifact: artifact(value), historicalRequirements: req, currentApprovedRequirements: value.sourceRequirements });
}

function blockerCodes(value: DocumentationContent): string[] { return evaluate(value).blockers.map(({ code }) => code); }

describe("PlanningDocumentationReadinessService", () => {
  test("returns ready for an intact, current, fully covered candidate", () => {
    const result = evaluate(content());
    expect(result).toEqual(expect.objectContaining({ ready: true, artifactId: "DOC", blockers: [], warnings: [] }));
  });

  test("reports unresolved questions", () => {
    const value = content(); value.unresolvedQuestions = [{ id: "Q", question: "Which?", impact: "Approval" }];
    expect(blockerCodes(value)).toContain("DOCS_UNRESOLVED_QUESTIONS");
  });

  test("reports malformed provenance and historical source hash mismatch", () => {
    const malformed = content() as unknown as { sourceRequirements: { contentHash: string } };
    malformed.sourceRequirements.contentHash = "INVALID";
    const malformedResult = new PlanningDocumentationReadinessService().evaluateDocumentation({ artifact: { id: "DOC", structuredContent: malformed, content: "", contentHash: null }, historicalRequirements: requirements(), currentApprovedRequirements: { artifactId: "REQ", version: 1, contentHash: "a".repeat(64) } });
    expect(malformedResult.blockers.map(({ code }) => code)).toEqual(["DOCS_SOURCE_REQUIREMENTS_INVALID"]);

    const value = content(); value.sourceRequirements.contentHash = "a".repeat(64);
    expect(evaluate(value).blockers.map(({ code }) => code)).toContain("DOCS_SOURCE_REQUIREMENTS_INVALID");
  });

  test("distinguishes valid historical provenance from stale current authority", () => {
    const value = content();
    const result = new PlanningDocumentationReadinessService().evaluateDocumentation({ artifact: artifact(value), historicalRequirements: requirements(), currentApprovedRequirements: { ...value.sourceRequirements, version: 2 } });
    expect(result.blockers.map(({ code }) => code)).toEqual(["DOCS_UPSTREAM_AUTHORITY_MISMATCH"]);
  });

  test.each([
    ["DOCS_SYSTEM_ACTORS_REQUIRED", (v: DocumentationContent) => { v.systemActors = []; }],
    ["DOCS_FEATURES_REQUIRED", (v: DocumentationContent) => { v.features = []; }],
    ["DOCS_API_APPLICABILITY_INVALID", (v: DocumentationContent) => { v.apiContracts = { applicable: false, rationale: "None", items: [] }; }],
    ["DOCS_DATA_APPLICABILITY_INVALID", (v: DocumentationContent) => { v.dataEntities = { applicable: false, rationale: "None", items: [] }; }],
    ["DOCS_PERMISSION_APPLICABILITY_INVALID", (v: DocumentationContent) => { v.permissionRules = { applicable: false, rationale: "None", items: [] }; }],
    ["DOCS_FUNCTIONAL_REQUIREMENT_UNCOVERED", (v: DocumentationContent) => { v.features[0].sourceRequirementIds = []; }],
    ["DOCS_DANGLING_REQUIREMENT_REFERENCE", (v: DocumentationContent) => { v.features[0].sourceRequirementIds = ["MISSING"]; }],
    ["DOCS_DANGLING_USER_STORY_REFERENCE", (v: DocumentationContent) => { v.features[0].sourceUserStoryIds = ["MISSING"]; }],
    ["DOCS_DANGLING_ACTOR_REFERENCE", (v: DocumentationContent) => { v.features[0].actorIds = ["MISSING"]; }],
    ["DOCS_DANGLING_FEATURE_REFERENCE", (v: DocumentationContent) => { v.apiContracts.items[0].relatedFeatureIds = ["MISSING"]; }],
    ["DOCS_DANGLING_API_REFERENCE", (v: DocumentationContent) => { v.edgeCases[0].relatedApiContractIds = ["MISSING"]; }],
    ["DOCS_DANGLING_ENTITY_REFERENCE", (v: DocumentationContent) => { v.apiContracts.items[0].relatedEntityIds = ["MISSING"]; }],
    ["DOCS_DANGLING_ERROR_REFERENCE", (v: DocumentationContent) => { v.apiContracts.items[0].errorBehaviorIds = ["MISSING"]; }],
    ["DOCS_ERROR_BEHAVIORS_REQUIRED", (v: DocumentationContent) => { v.errorBehaviors = []; }],
    ["DOCS_FEATURE_ERROR_COVERAGE_REQUIRED", (v: DocumentationContent) => { v.errorBehaviors[0].relatedFeatureIds = []; }],
    ["DOCS_EDGE_CASES_REQUIRED", (v: DocumentationContent) => { v.edgeCases = []; }],
    ["DOCS_FEATURE_EDGE_COVERAGE_REQUIRED", (v: DocumentationContent) => { v.edgeCases[0].relatedFeatureIds = []; }],
    ["DOCS_PERMISSION_COVERAGE_REQUIRED", (v: DocumentationContent) => { v.permissionRules.items[0].relatedFeatureIds = []; }],
    ["DOCS_API_PERMISSION_COVERAGE_REQUIRED", (v: DocumentationContent) => { v.permissionRules.items[0].relatedApiContractIds = []; }],
    ["DOCS_API_FEATURE_LINK_REQUIRED", (v: DocumentationContent) => { v.apiContracts.items[0].relatedFeatureIds = []; }],
    ["DOCS_API_ERROR_LINK_REQUIRED", (v: DocumentationContent) => { v.apiContracts.items[0].errorBehaviorIds = []; }],
    ["DOCS_ERROR_API_LINK_INCONSISTENT", (v: DocumentationContent) => { v.errorBehaviors[0].relatedApiContractIds = []; delete v.errorBehaviors[0].httpStatus; }],
    ["DOCS_HTTP_STATUS_INVALID", (v: DocumentationContent) => { v.errorBehaviors[0].httpStatus = 99; }],
  ] as const)("reports graph blocker %s", (expected, mutate) => {
    const value = content(); mutate(value); expect(blockerCodes(value)).toContain(expected);
  });

  test("reports independently corrupted traceability, hash, and Markdown", () => {
    const trace = content(); trace.requirementsTraceability[0].coveredByFeatureIds = [];
    expect(blockerCodes(trace)).toContain("DOCS_TRACEABILITY_INCONSISTENT");
    const value = content();
    const hashResult = new PlanningDocumentationReadinessService().evaluateDocumentation({ artifact: { ...artifact(value), contentHash: "0".repeat(64) }, historicalRequirements: requirements(), currentApprovedRequirements: value.sourceRequirements });
    expect(hashResult.blockers.map(({ code }) => code)).toContain("DOCS_HASH_MISMATCH");
    const renderResult = new PlanningDocumentationReadinessService().evaluateDocumentation({ artifact: { ...artifact(value), content: "corrupt" }, historicalRequirements: requirements(), currentApprovedRequirements: value.sourceRequirements });
    expect(renderResult.blockers.map(({ code }) => code)).toContain("DOCS_RENDER_MISMATCH");
  });

  test("allows valid N/A sections and emits a non-blocking review warning", () => {
    const input = draft(); input.features[0].access = "public";
    input.apiContracts = { applicable: false, rationale: "No interface", items: [] };
    input.dataEntities = { applicable: false, rationale: "No data", items: [] };
    input.permissionRules = { applicable: false, rationale: "Public", items: [] };
    input.errorBehaviors[0].relatedApiContractIds = []; delete input.errorBehaviors[0].httpStatus;
    input.edgeCases[0].relatedApiContractIds = []; input.edgeCases[0].relatedEntityIds = [];
    const result = evaluate(content(input));
    expect(result.ready).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(result.warnings.map(({ code }) => code)).toContain("DOCS_SECTION_NOT_APPLICABLE_REVIEW");
  });

  test("treats uncovered NFRs and absent business rules as warning-only", () => {
    const input = draft(); input.apiContracts.items[0].sourceRequirementIds = []; input.businessRules = [];
    const result = evaluate(content(input));
    expect(result.ready).toBe(true);
    expect(result.warnings.map(({ code }) => code)).toEqual(expect.arrayContaining(["DOCS_NONFUNCTIONAL_REQUIREMENT_UNCOVERED", "DOCS_NO_BUSINESS_RULES"]));
  });

  test("never mutates its input", () => {
    const value = content(); const input = { artifact: artifact(value), historicalRequirements: requirements(), currentApprovedRequirements: value.sourceRequirements };
    const before = JSON.stringify(input);
    new PlanningDocumentationReadinessService().evaluateDocumentation(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});
