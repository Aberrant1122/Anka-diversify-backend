import {
  REQUIREMENTS_PROVIDER_JSON_SCHEMA,
  validateGeneratedRequirements,
} from "../requirements-generation-schema";
import { REQUIREMENTS_ROOT_FIELDS } from "../requirements-schema";

function assertClosedObjects(value: unknown, path = "root"): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const object = value as Record<string, unknown>;
  if (object.type === "object") {
    expect(object.additionalProperties).toBe(false);
  }
  for (const [key, child] of Object.entries(object)) {
    assertClosedObjects(child, `${path}.${key}`);
  }
}

describe("Requirements provider schema", () => {
  function validRequirements(): Record<string, unknown> {
    return {
      projectGoal: "Goal",
      problemStatement: "Problem",
      usersAndActors: [{ id: "ACTOR-1", name: "Owner", description: "Owns it." }],
      userStories: [{
        id: "US-1",
        actor: "Owner",
        capability: "use it",
        benefit: "get value",
        acceptanceCriteriaIds: ["AC-1"],
      }],
      functionalRequirements: [{ id: "FR-1", title: "Feature", description: "Do it." }],
      nonFunctionalRequirements: [],
      constraints: [],
      integrations: [],
      assumptions: [],
      acceptanceCriteria: [{ id: "AC-1", description: "Works.", relatedRequirementIds: ["FR-1"] }],
      outOfScope: [],
      unresolvedQuestions: [],
    };
  }

  test("stays aligned with canonical root fields and closes every object", () => {
    const properties = REQUIREMENTS_PROVIDER_JSON_SCHEMA.properties as Record<string, unknown>;
    expect(Object.keys(properties)).toEqual([...REQUIREMENTS_ROOT_FIELDS]);
    expect(REQUIREMENTS_PROVIDER_JSON_SCHEMA.required).toEqual([...REQUIREMENTS_ROOT_FIELDS]);
    assertClosedObjects(REQUIREMENTS_PROVIDER_JSON_SCHEMA);
  });

  test("uses the canonical parser as the final validator", () => {
    const result = validateGeneratedRequirements({
      projectGoal: "Goal",
      problemStatement: "Problem",
      usersAndActors: [],
      userStories: [],
      functionalRequirements: [{ id: "FR-1", title: "Feature", description: "Do it." }],
      nonFunctionalRequirements: [],
      constraints: [],
      integrations: [],
      assumptions: [],
      acceptanceCriteria: [{ id: "AC-1", description: "Works.", relatedRequirementIds: ["MISSING"] }],
      outOfScope: [],
      unresolvedQuestions: [],
    });
    expect(result.valid).toBe(false);
    expect(result.errors?.[0]).toContain("unknown requirement 'MISSING'");
  });

  test.each([
    ["unknown root field", (content: Record<string, unknown>) => { content.extra = true; }, "unknown fields"],
    ["missing root field", (content: Record<string, unknown>) => { delete content.projectGoal; }, "field is required"],
    ["duplicate IDs", (content: Record<string, unknown>) => {
      content.constraints = [{ id: "FR-1", description: "Duplicate." }];
    }, "already used"],
    ["broken references", (content: Record<string, unknown>) => {
      content.acceptanceCriteria = [{ id: "AC-1", description: "Works.", relatedRequirementIds: ["MISSING"] }];
    }, "unknown requirement"],
    ["nested additional field", (content: Record<string, unknown>) => {
      content.usersAndActors = [{ id: "ACTOR-1", name: "Owner", description: "Owns it.", extra: true }];
    }, "unknown fields"],
  ])("rejects %s through canonical validation", (_name, mutate, expected) => {
    const content = validRequirements();
    mutate(content);
    const result = validateGeneratedRequirements(content);
    expect(result.valid).toBe(false);
    expect(result.errors?.[0]).toContain(expected);
  });
});
