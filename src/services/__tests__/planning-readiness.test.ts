import {
  hashRequirementsContent,
  renderRequirementsMarkdown,
  RequirementsContent,
} from "../../planning/requirements-schema";
import { PlanningReadinessService, RequirementsReadinessArtifact } from "../planning-readiness.service";

function completeRequirements(): RequirementsContent {
  return {
    projectGoal: "Deliver a reviewable planning workflow.",
    problemStatement: "Requirements need deterministic approval safety.",
    usersAndActors: [{ id: "ACTOR-001", name: "Project owner", description: "Owns approval decisions." }],
    userStories: [{
      id: "US-001",
      actor: "Project owner",
      capability: "review exact Requirements versions",
      benefit: "approval authority is unambiguous",
      acceptanceCriteriaIds: ["AC-001"],
    }],
    functionalRequirements: [{ id: "FR-001", title: "Readiness gate", description: "Block incomplete Requirements." }],
    nonFunctionalRequirements: [{ id: "NFR-001", title: "Determinism", description: "Readiness is deterministic." }],
    constraints: [],
    integrations: [],
    assumptions: [],
    acceptanceCriteria: [{ id: "AC-001", description: "Incomplete Requirements cannot be submitted.", relatedRequirementIds: ["FR-001"] }],
    outOfScope: [],
    unresolvedQuestions: [],
  };
}

function artifact(content: RequirementsContent): RequirementsReadinessArtifact {
  return {
    id: "artifact-1",
    structuredContent: content,
    content: renderRequirementsMarkdown(content),
    contentHash: hashRequirementsContent(content),
  };
}

describe("PlanningReadinessService", () => {
  const service = new PlanningReadinessService();

  test("unresolved questions block readiness and report every question ID", () => {
    const content = completeRequirements();
    content.unresolvedQuestions = [
      { id: "UQ-001", question: "Which region is in scope?" },
      { id: "UQ-002", question: "What is the retention period?" },
    ];

    const result = service.evaluateRequirements({ artifact: artifact(content) });

    expect(result.ready).toBe(false);
    expect(result.blockers).toContainEqual(expect.objectContaining({
      code: "REQUIREMENTS_UNRESOLVED_QUESTIONS",
      path: "unresolvedQuestions",
      itemIds: ["UQ-001", "UQ-002"],
    }));
  });

  test("empty unresolved questions do not guarantee readiness when required sections are empty", () => {
    const content = completeRequirements();
    content.functionalRequirements = [];
    content.acceptanceCriteria = [];
    content.userStories = [];

    const result = service.evaluateRequirements({ artifact: artifact(content) });

    expect(result.ready).toBe(false);
    expect(result.blockers.map((blocker) => blocker.code)).toEqual(expect.arrayContaining([
      "REQUIREMENTS_FUNCTIONAL_REQUIREMENTS_REQUIRED",
      "REQUIREMENTS_ACCEPTANCE_CRITERIA_REQUIRED",
    ]));
  });

  test("an uncovered functional requirement blocks readiness", () => {
    const content = completeRequirements();
    content.functionalRequirements.push({ id: "FR-002", title: "Audit", description: "Retain an audit trail." });

    const result = service.evaluateRequirements({ artifact: artifact(content) });

    expect(result.blockers).toContainEqual(expect.objectContaining({
      code: "REQUIREMENTS_FUNCTIONAL_REQUIREMENT_UNCOVERED",
      itemIds: ["FR-002"],
    }));
  });

  test("a user story without acceptance criteria blocks readiness", () => {
    const content = completeRequirements();
    content.userStories[0].acceptanceCriteriaIds = [];

    const result = service.evaluateRequirements({ artifact: artifact(content) });

    expect(result.blockers).toContainEqual(expect.objectContaining({
      code: "REQUIREMENTS_USER_STORY_ACCEPTANCE_REQUIRED",
      itemIds: ["US-001"],
    }));
  });

  test("user stories with no actors block readiness without adding actor-ID semantics", () => {
    const content = completeRequirements();
    content.usersAndActors = [];

    const result = service.evaluateRequirements({ artifact: artifact(content) });

    expect(result.blockers).toContainEqual(expect.objectContaining({ code: "REQUIREMENTS_ACTOR_REQUIRED" }));
  });

  test("conflicting normalized integration declarations block readiness", () => {
    const content = completeRequirements();
    content.integrations = [
      { id: "INT-001", name: "Payment API", description: "Primary payment API.", required: true },
      { id: "INT-002", name: "  payment   api ", description: "Optional payment API.", required: false },
    ];

    const result = service.evaluateRequirements({ artifact: artifact(content) });

    expect(result.blockers).toContainEqual(expect.objectContaining({
      code: "REQUIREMENTS_INTEGRATION_DECLARATION_CONFLICT",
      itemIds: ["INT-001", "INT-002"],
    }));
  });

  test("deterministic warnings never make an otherwise complete artifact unready", () => {
    const content = completeRequirements();
    content.userStories = [];
    content.usersAndActors = [];
    content.nonFunctionalRequirements = [];
    content.assumptions = [{ id: "ASM-001", description: "The project owner remains available." }];

    const result = service.evaluateRequirements({ artifact: artifact(content) });

    expect(result.ready).toBe(true);
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      "REQUIREMENTS_NO_NON_FUNCTIONAL_REQUIREMENTS",
      "REQUIREMENTS_ASSUMPTIONS_PRESENT",
      "REQUIREMENTS_NO_ACTORS",
    ]);
  });

  test("complete canonical Requirements are approval-ready", () => {
    const canonicalArtifact = artifact(completeRequirements());
    const result = service.evaluateRequirements({
      artifact: canonicalArtifact,
      expectedHash: canonicalArtifact.contentHash ?? undefined,
    });

    expect(result).toMatchObject({
      ready: true,
      artifactId: "artifact-1",
      contentHash: canonicalArtifact.contentHash,
      blockers: [],
      warnings: [],
    });
  });

  test("canonical rendering and exact hash remain mandatory", () => {
    const canonicalArtifact = artifact(completeRequirements());

    expect(() => service.evaluateRequirements({
      artifact: { ...canonicalArtifact, content: `${canonicalArtifact.content}\nchanged` },
    })).toThrow(expect.objectContaining({ code: "PLANNING_ARTIFACT_INVALID" }));

    expect(() => service.evaluateRequirements({
      artifact: canonicalArtifact,
      expectedHash: "wrong-hash",
    })).toThrow(expect.objectContaining({ code: "PLANNING_ARTIFACT_HASH_MISMATCH" }));
  });
});
