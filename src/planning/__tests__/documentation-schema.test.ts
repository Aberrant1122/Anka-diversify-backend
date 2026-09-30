import { canonicalJson } from "../requirements-context";
import { hashRequirementsContent, RequirementsContent } from "../requirements-schema";
import { assembleDocumentationContent } from "../documentation-assembly";
import {
  DOCUMENTATION_CANONICAL_JSON_MAX_BYTES,
  DocumentationContent,
  DocumentationProviderDraft,
  DocumentationValidationError,
  hashDocumentationContent,
  parseDocumentationContent,
  parseDocumentationProviderDraft,
  renderDocumentationMarkdown,
} from "../documentation-schema";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function requirements(): RequirementsContent {
  return {
    projectGoal: "Ship deterministic planning.", problemStatement: "Teams need an exact plan.",
    usersAndActors: [{ id: "ACT-1", name: "Operator", description: "Runs the workflow." }],
    userStories: [{ id: "US-1", actor: "Operator", capability: "create records", benefit: "work is tracked", acceptanceCriteriaIds: ["AC-1"] }],
    functionalRequirements: [{ id: "FR-1", title: "Create", description: "Create a record." }],
    nonFunctionalRequirements: [{ id: "NFR-1", title: "Reliable", description: "Remain reliable." }],
    constraints: [], integrations: [], assumptions: [],
    acceptanceCriteria: [{ id: "AC-1", description: "A record is created.", relatedRequirementIds: ["FR-1"] }],
    outOfScope: [], unresolvedQuestions: [],
  };
}

function draft(): DocumentationProviderDraft {
  return {
    overview: { summary: "Summary", scope: "Scope", goals: ["Goal one"], nonGoals: [] },
    systemActors: [{ id: "DOC-ACTOR", name: "Operator", description: "Uses the system.", sourceActorIds: ["ACT-1"] }],
    features: [{ id: "DOC-FEATURE", title: "Create", description: "Creates records.", workflowSteps: ["Submit", "Store"], actorIds: ["DOC-ACTOR"], access: "controlled", sourceRequirementIds: ["FR-1"], sourceUserStoryIds: ["US-1"] }],
    apiContracts: { applicable: true, rationale: "Machine access is required.", items: [{ id: "DOC-API", name: "Create record", description: "Creates one record.", interaction: { kind: "http", method: "POST", path: "/records" }, access: "controlled", input: { description: "Create input.", fields: [{ name: "name", logicalType: "string", required: true, description: "Record name.", allowedValues: [], validationRules: ["non-empty"] }] }, success: { description: "Created record.", fields: [] }, relatedFeatureIds: ["DOC-FEATURE"], relatedEntityIds: ["DOC-ENTITY"], errorBehaviorIds: ["DOC-ERROR"], sourceRequirementIds: [], sourceUserStoryIds: [] }] },
    dataEntities: { applicable: true, rationale: "Records are logical data.", items: [{ id: "DOC-ENTITY", name: "Record", description: "A logical record.", fields: [{ name: "id", logicalType: "identifier", required: true, description: "Record identity.", allowedValues: [], validationRules: [] }], relationships: [], sourceRequirementIds: [], sourceUserStoryIds: [] }] },
    businessRules: [{ id: "DOC-RULE", title: "Reliability", condition: "A create is accepted", expectedBehavior: "The result is durable", relatedFeatureIds: ["DOC-FEATURE"], relatedEntityIds: [], sourceRequirementIds: ["NFR-1"], sourceUserStoryIds: [] }],
    permissionRules: { applicable: true, rationale: "Creation is controlled.", items: [{ id: "DOC-PERM", title: "Operator create", description: "Operators may create.", effect: "allow", actorIds: ["DOC-ACTOR"], actions: ["create"], relatedFeatureIds: ["DOC-FEATURE"], relatedApiContractIds: ["DOC-API"] }] },
    errorBehaviors: [{ id: "DOC-ERROR", code: "CREATE_FAILED", scenario: "Creation fails.", expectedSystemBehavior: "Return an error.", recoveryBehavior: "The operator may retry.", relatedFeatureIds: ["DOC-FEATURE"], relatedApiContractIds: ["DOC-API"], httpStatus: 400 }],
    edgeCases: [{ id: "DOC-EDGE", scenario: "Duplicate input.", expectedHandling: "Reject the duplicate.", relatedFeatureIds: ["DOC-FEATURE"], relatedApiContractIds: ["DOC-API"], relatedEntityIds: ["DOC-ENTITY"] }],
    unresolvedQuestions: [],
  };
}

function canonical(): DocumentationContent {
  const upstream = requirements();
  return assembleDocumentationContent(draft(), { artifactId: "requirements-1", version: 1, contentHash: hashRequirementsContent(upstream) }, upstream);
}

describe("Documentation schema", () => {
  test("accepts the exact provider and canonical shapes", () => {
    expect(parseDocumentationProviderDraft(draft())).toEqual(draft());
    expect(parseDocumentationContent(canonical())).toEqual(canonical());
  });

  test.each(["sourceRequirements", "requirementsTraceability", "extraRoot"])("rejects provider root %s", (root) => {
    const input = { ...draft(), [root]: {} };
    expect(() => parseDocumentationProviderDraft(input)).toThrow(DocumentationValidationError);
  });

  test("closes nested objects and validates unions, IDs, duplicate refs, fields, and envelopes", () => {
    const cases: unknown[] = [];
    const nested = clone(draft()); (nested.features[0] as unknown as Record<string, unknown>).extra = true; cases.push(nested);
    const interaction = clone(draft()); (interaction.apiContracts.items[0].interaction as unknown as { kind: string }).kind = "queue"; cases.push(interaction);
    const access = clone(draft()); (access.features[0] as unknown as { access: string }).access = "private"; cases.push(access);
    const id = clone(draft()); id.features[0].id = "bad id"; cases.push(id);
    const refs = clone(draft()); refs.features[0].actorIds.push("DOC-ACTOR"); cases.push(refs);
    const fields = clone(draft()); fields.apiContracts.items[0].input.fields.push(clone(fields.apiContracts.items[0].input.fields[0])); cases.push(fields);
    const envelope = clone(draft()); envelope.apiContracts.applicable = false; envelope.apiContracts.rationale = "Not needed"; cases.push(envelope);
    for (const value of cases) expect(() => parseDocumentationProviderDraft(value)).toThrow(DocumentationValidationError);
  });

  test("normalizes text while preserving authored list order", () => {
    const input = draft(); input.overview.summary = "  A\r\nB  "; input.overview.goals = [" second ", "first"];
    const parsed = parseDocumentationProviderDraft(input);
    expect(parsed.overview.summary).toBe("A\nB");
    expect(parsed.overview.goals).toEqual(["second", "first"]);
  });

  test("renders deterministically in locked section order with exactly one final newline", () => {
    const content = canonical();
    const rendered = renderDocumentationMarkdown(content);
    const headings = ["# Documentation", "## Overview", "## System Actors", "## Features", "## API Contracts", "## Data Entities", "## Business Rules", "## Permission Rules", "## Error Behaviors", "## Edge Cases", "## Requirements Traceability", "## Unresolved Questions", "## Source Requirements"];
    expect(headings.map((heading) => rendered.indexOf(heading))).toEqual([...headings.map((heading) => rendered.indexOf(heading))].sort((a, b) => a - b));
    expect(rendered).toContain("requirements-1");
    expect(rendered.endsWith("\n")).toBe(true);
    expect(rendered.endsWith("\n\n")).toBe(false);
    expect(renderDocumentationMarkdown(content)).toBe(rendered);
  });

  test("hashes the full canonical provenance and traceability deterministically", () => {
    const content = canonical();
    expect(hashDocumentationContent(content)).toBe(hashDocumentationContent(clone(content)));
    const provenance = clone(content); provenance.sourceRequirements.version += 1;
    const trace = clone(content); trace.requirementsTraceability[1].coverageStatus = "uncovered";
    expect(hashDocumentationContent(provenance)).not.toBe(hashDocumentationContent(content));
    expect(hashDocumentationContent(trace)).not.toBe(hashDocumentationContent(content));
  });

  test("accepts exactly 128 KiB canonical JSON and rejects one additional UTF-8 byte", () => {
    const upstream = requirements(); const source = { artifactId: "requirements-1", version: 1, contentHash: hashRequirementsContent(upstream) };
    const baseDraft = draft(); const base = assembleDocumentationContent(baseDraft, source, upstream);
    const missing = DOCUMENTATION_CANONICAL_JSON_MAX_BYTES - Buffer.byteLength(canonicalJson(base), "utf8");
    const exactDraft = draft(); exactDraft.overview.summary += "x".repeat(missing);
    const exact = assembleDocumentationContent(exactDraft, source, upstream);
    expect(Buffer.byteLength(canonicalJson(exact), "utf8")).toBe(DOCUMENTATION_CANONICAL_JSON_MAX_BYTES);
    exactDraft.overview.summary += "x";
    expect(() => assembleDocumentationContent(exactDraft, source, upstream)).toThrow(expect.objectContaining({ code: "DOCUMENTATION_SIZE_EXCEEDED" }));
  });

  test("measures multibyte content in UTF-8 bytes rather than characters", () => {
    const upstream = requirements(); const source = { artifactId: "requirements-1", version: 1, contentHash: hashRequirementsContent(upstream) };
    const input = draft(); input.overview.summary = "🙂".repeat(33_000);
    expect(input.overview.summary.length).toBeLessThan(DOCUMENTATION_CANONICAL_JSON_MAX_BYTES);
    expect(() => assembleDocumentationContent(input, source, upstream)).toThrow(expect.objectContaining({ code: "DOCUMENTATION_SIZE_EXCEEDED" }));
  });
});
