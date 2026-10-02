import {
  computeRequirementsDiff,
  isNoOpRequirementsRevision,
  REQUIREMENTS_SECTION_DEPENDENCY_CLOSURE,
  validateRequirementsRevisionTarget,
  validateRequirementsSectionScope,
  validateRevisionOperation,
  validateRevisionStableIds,
} from "../requirements-revision-policy";
import { RequirementsContent } from "../requirements-schema";

function baseContent(): RequirementsContent {
  return {
    projectGoal: "Build an auditable planner",
    problemStatement: "Planning inputs need deterministic provenance.",
    usersAndActors: [
      { id: "ACTOR-001", name: "Owner", description: "Owns planning." },
      { id: "ACTOR-002", name: "Reviewer", description: "Reviews planning." },
    ],
    userStories: [
      {
        id: "US-001",
        actor: "Owner",
        capability: "prepare requirements",
        benefit: "scope is reviewable",
        acceptanceCriteriaIds: ["AC-001"],
      },
    ],
    functionalRequirements: [
      { id: "FR-001", title: "Prepare Run", description: "Prepare a run." },
      { id: "FR-002", title: "Retain Provenance", description: "Store manifest." },
    ],
    nonFunctionalRequirements: [
      { id: "NFR-001", title: "Auditability", description: "Retain provenance." },
    ],
    constraints: [{ id: "CON-001", description: "Do not call an LLM." }],
    integrations: [
      { id: "INT-001", name: "Gateway", description: "Connects LLM.", required: true },
    ],
    assumptions: [{ id: "ASM-001", description: "Single active run." }],
    acceptanceCriteria: [
      { id: "AC-001", description: "Run is recorded.", relatedRequirementIds: ["FR-001"] },
    ],
    outOfScope: [{ id: "OOS-001", description: "Documentation generation." }],
    unresolvedQuestions: [{ id: "UQ-001", question: "Max retry limit?" }],
  };
}

describe("requirements-revision-policy", () => {
  describe("validateRevisionOperation", () => {
    test("accepts all four Requirements revision operations", () => {
      expect(() => validateRevisionOperation("DOCUMENT_REVISION")).not.toThrow();
      expect(() => validateRevisionOperation("FEEDBACK_APPLICATION")).not.toThrow();
      expect(() => validateRevisionOperation("SECTION_REVISION")).not.toThrow();
      expect(() => validateRevisionOperation("SECTION_REGENERATION")).not.toThrow();
    });

    test("rejects non-revision operations", () => {
      expect(() => validateRevisionOperation("INITIAL_GENERATION")).toThrow(
        expect.objectContaining({ code: "PLANNING_ARTIFACT_INVALID", httpStatus: 422 }),
      );
    });
  });

  describe("section authority", () => {
    test("defines the exact asymmetric dependency closure", () => {
      expect(REQUIREMENTS_SECTION_DEPENDENCY_CLOSURE).toEqual({
        projectGoal: ["projectGoal"],
        problemStatement: ["problemStatement"],
        usersAndActors: ["usersAndActors", "userStories"],
        userStories: ["userStories", "acceptanceCriteria"],
        functionalRequirements: ["functionalRequirements", "acceptanceCriteria", "userStories"],
        nonFunctionalRequirements: ["nonFunctionalRequirements", "acceptanceCriteria", "userStories"],
        constraints: ["constraints"],
        integrations: ["integrations"],
        assumptions: ["assumptions"],
        acceptanceCriteria: ["acceptanceCriteria", "userStories"],
        outOfScope: ["outOfScope"],
        unresolvedQuestions: ["unresolvedQuestions"],
      });
    });

    test.each([undefined, null, "", "   ", "unknownSection"])(
      "rejects invalid section target %p",
      (targetSectionKey) => {
        expect(() => validateRequirementsRevisionTarget("SECTION_REVISION", targetSectionKey)).toThrow(
          expect.objectContaining({ code: "PLANNING_INVALID_SECTION", httpStatus: 422 }),
        );
      },
    );

    test.each(["DOCUMENT_REVISION", "FEEDBACK_APPLICATION"])(
      "rejects a target supplied to %s",
      (operation) => {
        expect(() => validateRequirementsRevisionTarget(operation, "constraints")).toThrow(
          expect.objectContaining({ code: "PLANNING_INVALID_SECTION", httpStatus: 422 }),
        );
      },
    );

    test("returns a normalized finite target and its closure", () => {
      expect(validateRequirementsRevisionTarget("SECTION_REGENERATION", " functionalRequirements ")).toEqual({
        targetSectionKey: "functionalRequirements",
        allowedSectionKeys: ["functionalRequirements", "acceptanceCriteria", "userStories"],
      });
    });

    test("permits only changed roots inside the snapshotted closure", () => {
      expect(() => validateRequirementsSectionScope(
        "functionalRequirements",
        ["functionalRequirements", "acceptanceCriteria", "userStories"],
        ["functionalRequirements", "acceptanceCriteria", "userStories"],
      )).not.toThrow();
      expect(() => validateRequirementsSectionScope(
        "acceptanceCriteria",
        ["acceptanceCriteria", "userStories"],
        ["acceptanceCriteria", "functionalRequirements"],
      )).toThrow(expect.objectContaining({
        code: "PLANNING_SECTION_SCOPE_VIOLATION",
        httpStatus: 422,
        details: {
          targetSectionKey: "acceptanceCriteria",
          allowedSections: ["acceptanceCriteria", "userStories"],
          changedSections: ["acceptanceCriteria", "functionalRequirements"],
        },
      }));
    });
  });

  describe("isNoOpRequirementsRevision", () => {
    test("detects identical canonical content as a no-op", () => {
      const base = baseContent();
      const same = baseContent();
      expect(isNoOpRequirementsRevision(base, same)).toBe(true);
    });

    test("returns false when any content field changes", () => {
      const base = baseContent();
      const changed = baseContent();
      changed.projectGoal = "Updated goal";
      expect(isNoOpRequirementsRevision(base, changed)).toBe(false);
    });
  });

  describe("validateRevisionStableIds", () => {
    test("permits unchanged entities retaining their ID", () => {
      const base = baseContent();
      const successor = baseContent();
      successor.projectGoal = "Slightly revised goal";
      expect(() => validateRevisionStableIds(base, successor)).not.toThrow();
    });

    test("permits modified entity representing same concept retaining its ID", () => {
      const base = baseContent();
      const successor = baseContent();
      successor.functionalRequirements[0].description = "Prepare a run with extra validation.";
      expect(() => validateRevisionStableIds(base, successor)).not.toThrow();
    });

    test("permits new entities with new IDs and removed entities", () => {
      const base = baseContent();
      const successor = baseContent();
      // Remove FR-002
      successor.functionalRequirements = [successor.functionalRequirements[0]];
      // Add genuinely new FR-003
      successor.functionalRequirements.push({
        id: "FR-003",
        title: "Export Artifact",
        description: "Export requirements to markdown format.",
      });
      expect(() => validateRevisionStableIds(base, successor)).not.toThrow();
    });

    test("rejects moving an ID into another root section", () => {
      const base = baseContent();
      const successor = baseContent();
      // Move CON-001 into assumptions
      successor.constraints = [];
      successor.assumptions.push({ id: "CON-001", description: "Do not call an LLM." });
      expect(() => validateRevisionStableIds(base, successor)).toThrow(
        expect.objectContaining({
          code: "PLANNING_ARTIFACT_INVALID",
          httpStatus: 422,
          message: expect.stringContaining("cannot move from root section 'constraints' to 'assumptions'"),
        }),
      );
    });

    test("rejects churned ID for byte/canonically unchanged entity", () => {
      const base = baseContent();
      const successor = baseContent();
      // Remove FR-001 (title: "Prepare Run", description: "Prepare a run.")
      // And introduce FR-999 with the exact same payload
      successor.functionalRequirements = [
        { id: "FR-999", title: "Prepare Run", description: "Prepare a run." },
        base.functionalRequirements[1],
      ];
      expect(() => validateRevisionStableIds(base, successor)).toThrow(
        expect.objectContaining({
          code: "PLANNING_ARTIFACT_INVALID",
          httpStatus: 422,
          message: expect.stringContaining("churned ID from 'FR-001' to 'FR-999'"),
        }),
      );
    });
  });

  describe("computeRequirementsDiff", () => {
    test("deterministically identifies changed sections, added, removed, retained, and modified IDs", () => {
      const base = baseContent();
      const successor = baseContent();

      // Modify projectGoal
      successor.projectGoal = "Build an auditable and extensible planner";

      // Modify FR-001 (same ID, changed content)
      successor.functionalRequirements[0].description = "Prepare a run with schema checks.";

      // Remove FR-002
      successor.functionalRequirements = [
        successor.functionalRequirements[0],
        { id: "FR-003", title: "New Requirement", description: "Brand new entity." },
      ];

      const diff = computeRequirementsDiff(base, successor);

      expect(diff.changedRootSections).toEqual(["projectGoal", "functionalRequirements"]);
      expect(diff.addedIds).toEqual(["FR-003"]);
      expect(diff.removedIds).toEqual(["FR-002"]);
      expect(diff.modifiedIds).toEqual(["FR-001"]);
      expect(diff.retainedIds).toContain("ACTOR-001");
      expect(diff.retainedIds).toContain("CON-001");
      expect(diff.retainedIds).not.toContain("FR-001");
      expect(diff.retainedIds).not.toContain("FR-002");
    });
  });
});
