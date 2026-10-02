import { ArchitectureContent } from "../architecture-schema";
import { computeArchitectureDiff, normalizeComponentRetirements, normalizeIdentityRetirements, validateArchitectureRevisionStableIds } from "../architecture-revision-policy";
import { architectureDraft } from "./architecture-test-fixtures";

const source = { artifactId: "source", version: 1, contentHash: "a".repeat(64) };
function canonical(draft = architectureDraft()): ArchitectureContent {
  return { ...draft, sourceRequirements: source, sourceDocumentation: source,
    traceability: { features: [], interfaces: [], dataEntities: [], nonFunctionalRequirements: [] } };
}

describe("Architecture revision policy", () => {
  test("diff is deterministic across authored sections and provenance", () => {
    const base = canonical();
    const next = canonical();
    next.components[0].designNotes = "Different transaction policy";
    next.unresolvedQuestions.push({ id: "ARCH-Q-NEW", question: "Who owns deploys?", blocksDecision: false });
    next.sourceDocumentation = { ...source, artifactId: "new-source" };
    validateArchitectureRevisionStableIds(base, next);
    expect(computeArchitectureDiff(base, next)).toEqual({
      changedRootSections: ["components", "unresolvedQuestions"],
      addedIds: ["ARCH-Q-NEW"], removedIds: [], retainedIds: ["ARCH-DATA-STATE", "ARCH-IFACE-API"],
      modifiedIds: ["ARCH-COMP-API"], provenanceChanged: true,
    });
  });

  test("unchanged item cannot churn its stable ID; legitimate addition is allowed", () => {
    const base = canonical();
    const churn = canonical();
    churn.components[0].id = "ARCH-COMP-RENAMED";
    churn.dataDesign.items[0].componentId = "ARCH-COMP-RENAMED";
    churn.interfaceDesign.items[0].componentId = "ARCH-COMP-RENAMED";
    churn.implementationSequence = ["ARCH-COMP-RENAMED"];
    expect(() => validateArchitectureRevisionStableIds(base, churn)).toThrow(/retirement/i);
    const addition = canonical();
    addition.unresolvedQuestions.push({ id: "ARCH-Q-NEW", question: "Decision?", blocksDecision: false });
    expect(() => validateArchitectureRevisionStableIds(base, addition)).not.toThrow();
  });

  test("modified notes and retargeted references do not authorize component removal", () => {
    const base = canonical(), next = canonical();
    next.components[0].id = "ARCH-COMP-NEW";
    next.components[0].designNotes = "Different transaction policy";
    next.dataDesign.items[0].componentId = "ARCH-COMP-NEW";
    next.interfaceDesign.items[0].componentId = "ARCH-COMP-NEW";
    next.implementationSequence = ["ARCH-COMP-NEW"];
    expect(() => validateArchitectureRevisionStableIds(base, next)).toThrow(/retirement/i);
    expect(() => validateArchitectureRevisionStableIds(base, next, [
      { retiredComponentId: "ARCH-COMP-API", replacementComponentId: "ARCH-COMP-NEW" },
    ])).not.toThrow();
  });

  test("authorized retirement without replacement and same-ID edits are valid", () => {
    const base = canonical();
    base.components.push({ ...base.components[0], id: "ARCH-COMP-OLD", dependencyIds: [], documentationFeatureIds: [], designNotes: "Legacy" });
    const next = canonical();
    next.components[0].designNotes = "Improved";
    expect(() => validateArchitectureRevisionStableIds(base, next, [
      { retiredComponentId: "ARCH-COMP-OLD", replacementComponentId: null },
    ])).not.toThrow();
    expect(() => validateArchitectureRevisionStableIds(canonical(), next)).not.toThrow();
  });

  test("retirement declarations are bounded, normalized and consumed", () => {
    const base = canonical(), next = canonical();
    expect(normalizeComponentRetirements([
      { retiredComponentId: "ARCH-COMP-Z", replacementComponentId: null },
      { retiredComponentId: "ARCH-COMP-A", replacementComponentId: "ARCH-COMP-B" },
    ]).map((item) => item.retiredComponentId)).toEqual(["ARCH-COMP-A", "ARCH-COMP-Z"]);
    for (const invalid of [
      [{ retiredComponentId: "ARCH-COMP-API", replacementComponentId: null, extra: true }],
      [{ retiredComponentId: "ARCH-COMP-API", replacementComponentId: null }, { retiredComponentId: "ARCH-COMP-API", replacementComponentId: null }],
      [{ retiredComponentId: "ARCH-COMP-API", replacementComponentId: "ARCH-COMP-API" }],
    ]) expect(() => normalizeComponentRetirements(invalid)).toThrow();
    expect(() => validateArchitectureRevisionStableIds(base, next, [
      { retiredComponentId: "ARCH-COMP-MISSING", replacementComponentId: null },
    ])).toThrow(/base/i);
    expect(() => validateArchitectureRevisionStableIds(base, next, [
      { retiredComponentId: "ARCH-COMP-API", replacementComponentId: "ARCH-COMP-API" },
    ])).toThrow();
    expect(() => validateArchitectureRevisionStableIds(base, next, [
      { retiredComponentId: "ARCH-COMP-API", replacementComponentId: null },
    ])).toThrow(/unused/i);
    const removed = canonical();
    removed.components[0].id = "ARCH-COMP-NEW";
    expect(() => validateArchitectureRevisionStableIds(base, removed, [
      { retiredComponentId: "ARCH-COMP-API", replacementComponentId: "ARCH-COMP-ABSENT" },
    ])).toThrow(/inconsistent/i);
    expect(() => normalizeComponentRetirements([
      { retiredComponentId: "ARCH-COMP-API", replacementComponentId: "ARCH-COMP-NEW" },
      { retiredComponentId: "ARCH-COMP-OLD", replacementComponentId: "ARCH-COMP-NEW" },
    ])).toThrow(/duplicate/i);
  });

  test.each([
    { section: "dataDesign" as const, oldId: "ARCH-DATA-STATE", newId: "ARCH-DATA-NEW", change: "persistence" as const },
    { section: "interfaceDesign" as const, oldId: "ARCH-IFACE-API", newId: "ARCH-IFACE-NEW", change: "transport" as const },
  ])("$section requires authorization despite changed authored fields and a retained Documentation anchor", ({ section, oldId, newId, change }) => {
    const base = canonical(), next = canonical();
    const item = next[section].items[0];
    item.id = newId;
    if (change === "persistence" && "persistence" in item) item.persistence = "New storage";
    if (change === "transport" && "transport" in item) item.transport = "gRPC";
    expect(() => validateArchitectureRevisionStableIds(base, next)).toThrow(/retirement/i);
    expect(() => validateArchitectureRevisionStableIds(base, next, [], [
      { section, retiredId: oldId, replacementId: newId },
    ])).not.toThrow();
    expect(() => validateArchitectureRevisionStableIds(base, next, [], [
      { section, retiredId: oldId, replacementId: null },
    ])).not.toThrow();
    const sameId = canonical();
    const retained = sameId[section].items[0];
    if (change === "persistence" && "persistence" in retained) retained.persistence = "New storage";
    if (change === "transport" && "transport" in retained) retained.transport = "gRPC";
    expect(() => validateArchitectureRevisionStableIds(base, sameId)).not.toThrow();
  });

  test("retained data and interface IDs cannot move to another Documentation anchor", () => {
    const base = canonical(), data = canonical(), iface = canonical();
    data.dataDesign.items[0].documentationEntityId = "DOC-ENTITY-OTHER";
    iface.interfaceDesign.items[0].documentationApiId = "DOC-API-OTHER";
    expect(() => validateArchitectureRevisionStableIds(base, data)).toThrow(/Documentation anchor/i);
    expect(() => validateArchitectureRevisionStableIds(base, iface)).toThrow(/Documentation anchor/i);
  });

  test("integration identities and question resolution require explicit retirement", () => {
    const base = canonical();
    base.integrationDesign = { applicable: true, rationale: "External service", items: [{ id: "ARCH-INT-OLD", componentId: "ARCH-COMP-API",
      requirementIntegrationIds: ["REQ-INT"], externalBoundary: "Partner", failureStrategy: "Retry", credentialOwner: "external_operator", reliability: "Monitor" }] };
    base.unresolvedQuestions = [{ id: "ARCH-Q-OLD", question: "Who owns deploys?", blocksDecision: false }];
    const renamed = canonical();
    renamed.integrationDesign = { ...base.integrationDesign, items: [{ ...base.integrationDesign.items[0], id: "ARCH-INT-NEW", reliability: "Alert" }] };
    renamed.unresolvedQuestions = [{ id: "ARCH-Q-NEW", question: "Who owns rollout?", blocksDecision: false }];
    expect(() => validateArchitectureRevisionStableIds(base, renamed)).toThrow(/retirement/i);
    expect(() => validateArchitectureRevisionStableIds(base, renamed, [], [
      { section: "integrationDesign", retiredId: "ARCH-INT-OLD", replacementId: "ARCH-INT-NEW" },
      { section: "unresolvedQuestions", retiredId: "ARCH-Q-OLD", replacementId: "ARCH-Q-NEW" },
    ])).not.toThrow();
    const resolved = canonical();
    resolved.integrationDesign = base.integrationDesign;
    expect(() => validateArchitectureRevisionStableIds(base, resolved, [], [
      { section: "unresolvedQuestions", retiredId: "ARCH-Q-OLD", replacementId: null },
    ])).not.toThrow();
  });

  test("identity declarations reject wrong family, reused replacements, and unused entries", () => {
    const base = canonical(), next = canonical();
    expect(() => normalizeIdentityRetirements([
      { section: "dataDesign", retiredId: "ARCH-IFACE-API", replacementId: null },
    ])).toThrow();
    expect(() => normalizeIdentityRetirements([
      { section: "dataDesign", retiredId: "ARCH-DATA-STATE", replacementId: "ARCH-DATA-NEW" },
      { section: "dataDesign", retiredId: "ARCH-DATA-OTHER", replacementId: "ARCH-DATA-NEW" },
    ])).toThrow(/conflicting/i);
    expect(() => validateArchitectureRevisionStableIds(base, next, [], [
      { section: "dataDesign", retiredId: "ARCH-DATA-MISSING", replacementId: null },
    ])).toThrow(/base/i);
    expect(() => validateArchitectureRevisionStableIds(base, next, [], [
      { section: "interfaceDesign", retiredId: "ARCH-IFACE-API", replacementId: null },
    ])).toThrow(/unused/i);
    expect(() => validateArchitectureRevisionStableIds(base, next, [], [
      { section: "dataDesign", retiredId: "ARCH-DATA-STATE", replacementId: "ARCH-DATA-NEW" },
    ])).toThrow(/unused/i);
    expect(() => validateArchitectureRevisionStableIds(base, next, [
      { retiredComponentId: "ARCH-COMP-API", replacementComponentId: null },
    ], [
      { section: "components", retiredId: "ARCH-COMP-API", replacementId: null },
    ])).toThrow(/Duplicate/i);
  });
});
