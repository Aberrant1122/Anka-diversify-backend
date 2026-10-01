import { ArtifactChangeKind, ArtifactLifecycleStatus, PhaseArtifact } from "@prisma/client";
import {
  preflightArchitectureHandoff,
} from "../documentation-architecture-preflight";
import {
  DOCUMENTATION_ARTIFACT_TYPE,
  DOCUMENTATION_SCHEMA_VERSION,
  DocumentationContent,
  DocumentationProviderDraft,
  hashDocumentationContent,
  renderDocumentationMarkdown,
} from "../documentation-schema";
import {
  hashRequirementsContent,
  renderRequirementsMarkdown,
  REQUIREMENTS_ARTIFACT_TYPE,
  REQUIREMENTS_SCHEMA_VERSION,
  RequirementsContent,
} from "../requirements-schema";
import { assembleDocumentationContent } from "../documentation-assembly";
import { PlanningDomainError } from "../planning-errors";

function sampleRequirements(): RequirementsContent {
  return {
    projectGoal: "Build system",
    problemStatement: "Problem description",
    usersAndActors: [{ id: "ACT-1", name: "User", description: "Standard user" }],
    userStories: [
      {
        id: "US-1",
        actor: "User",
        capability: "Do work",
        benefit: "Save time",
        acceptanceCriteriaIds: ["AC-1"],
      },
    ],
    functionalRequirements: [
      { id: "FR-1", title: "Function", description: "Perform function" },
    ],
    nonFunctionalRequirements: [
      { id: "NFR-1", title: "Non-function", description: "Security and audit" },
    ],
    constraints: [],
    integrations: [],
    assumptions: [],
    acceptanceCriteria: [
      { id: "AC-1", description: "Criteria", relatedRequirementIds: ["FR-1"] },
    ],
    outOfScope: [],
    unresolvedQuestions: [],
  };
}

function sampleDraft(req: RequirementsContent): DocumentationProviderDraft {
  return {
    overview: {
      summary: "Overview summary",
      scope: "Overview scope",
      goals: ["Goal 1"],
      nonGoals: ["Non-goal 1"],
    },
    systemActors: [
      {
        id: "DOC-ACTOR-1",
        name: "Actor",
        description: "Actor description",
        sourceActorIds: ["ACT-1"],
      },
    ],
    features: [
      {
        id: "DOC-FEAT-1",
        title: "Feature",
        description: "Feature description",
        workflowSteps: ["Step 1"],
        actorIds: ["DOC-ACTOR-1"],
        access: "controlled",
        sourceRequirementIds: ["FR-1"],
        sourceUserStoryIds: ["US-1"],
      },
    ],
    apiContracts: {
      applicable: true,
      rationale: "Rationale",
      items: [
        {
          id: "DOC-API-1",
          name: "API",
          description: "API description",
          interaction: { kind: "http", method: "GET", path: "/test" },
          access: "controlled",
          input: { description: "Input", fields: [] },
          success: { description: "Success", fields: [] },
          relatedFeatureIds: ["DOC-FEAT-1"],
          relatedEntityIds: ["DOC-ENT-1"],
          errorBehaviorIds: ["DOC-ERR-1"],
          sourceRequirementIds: ["NFR-1"],
          sourceUserStoryIds: ["US-1"],
        },
      ],
    },
    dataEntities: {
      applicable: true,
      rationale: "Rationale",
      items: [
        {
          id: "DOC-ENT-1",
          name: "Entity",
          description: "Entity description",
          fields: [
            {
              name: "id",
              logicalType: "identifier",
              required: true,
              description: "ID field",
              allowedValues: [],
              validationRules: [],
            },
          ],
          relationships: [],
          sourceRequirementIds: ["NFR-1"],
          sourceUserStoryIds: [],
        },
      ],
    },
    businessRules: [
      {
        id: "DOC-BR-1",
        title: "Rule",
        condition: "Condition",
        expectedBehavior: "Behavior",
        relatedFeatureIds: ["DOC-FEAT-1"],
        relatedEntityIds: [],
        sourceRequirementIds: ["FR-1"],
        sourceUserStoryIds: [],
      },
    ],
    permissionRules: {
      applicable: true,
      rationale: "Rationale",
      items: [
        {
          id: "DOC-PR-1",
          title: "Permission",
          description: "Description",
          effect: "allow",
          actorIds: ["DOC-ACTOR-1"],
          actions: ["read"],
          relatedFeatureIds: ["DOC-FEAT-1"],
          relatedApiContractIds: ["DOC-API-1"],
        },
      ],
    },
    errorBehaviors: [
      {
        id: "DOC-ERR-1",
        code: "ERR_1",
        scenario: "Scenario",
        expectedSystemBehavior: "Behavior",
        recoveryBehavior: "Recovery",
        relatedFeatureIds: ["DOC-FEAT-1"],
        relatedApiContractIds: ["DOC-API-1"],
        httpStatus: 400,
      },
    ],
    edgeCases: [
      {
        id: "DOC-EC-1",
        scenario: "Edge scenario",
        expectedHandling: "Handling",
        relatedFeatureIds: ["DOC-FEAT-1"],
        relatedApiContractIds: ["DOC-API-1"],
        relatedEntityIds: ["DOC-ENT-1"],
      },
    ],
    unresolvedQuestions: [],
  };
}

describe("preflightArchitectureHandoff", () => {
  const projectId = "project-1";
  const reqId = "req-artifact-v1";
  const docId = "doc-artifact-v1";

  const reqContent = sampleRequirements();
  const reqHash = hashRequirementsContent(reqContent);
  const reqMarkdown = renderRequirementsMarkdown(reqContent);

  const docContent = assembleDocumentationContent(
    sampleDraft(reqContent),
    { artifactId: reqId, version: 1, contentHash: reqHash },
    reqContent,
  );
  const docHash = hashDocumentationContent(docContent);
  const docMarkdown = renderDocumentationMarkdown(docContent);

  function createValidPrismaMock() {
    const validReqArtifact: PhaseArtifact = {
      id: reqId,
      projectId,
      phase: "requirements",
      type: REQUIREMENTS_ARTIFACT_TYPE,
      schemaVersion: REQUIREMENTS_SCHEMA_VERSION,
      version: 1,
      title: "Requirements v1",
      lifecycleStatus: ArtifactLifecycleStatus.APPROVED,
      changeKind: ArtifactChangeKind.INITIAL_GENERATION,
      content: reqMarkdown,
      contentHash: reqHash,
      structuredContent: reqContent as any,
      basedOnArtifactId: null,
      previousVersionId: null,
      createdBy: "owner-1",
      createdByType: null,
      approved: true,
      approvedAt: new Date("2026-09-01T00:00:00Z"),
      supersededAt: null,
      createdAt: new Date("2026-09-01T00:00:00Z"),
    };

    const validDocArtifact: PhaseArtifact = {
      id: docId,
      projectId,
      phase: "documentation",
      type: DOCUMENTATION_ARTIFACT_TYPE,
      schemaVersion: DOCUMENTATION_SCHEMA_VERSION,
      version: 1,
      title: "Documentation v1",
      lifecycleStatus: ArtifactLifecycleStatus.APPROVED,
      changeKind: ArtifactChangeKind.INITIAL_GENERATION,
      content: docMarkdown,
      contentHash: docHash,
      structuredContent: docContent as any,
      basedOnArtifactId: null,
      previousVersionId: null,
      createdBy: "owner-1",
      createdByType: null,
      approved: true,
      approvedAt: new Date("2026-09-02T00:00:00Z"),
      supersededAt: null,
      createdAt: new Date("2026-09-02T00:00:00Z"),
    };

    return {
      project: {
        findUnique: jest.fn().mockResolvedValue({ id: projectId, name: "Test Project" }),
      },
      projectPhaseState: {
        findUnique: jest.fn().mockImplementation(({ where }) => {
          if (where.projectId_phase?.phase === "requirements") {
            return Promise.resolve({ currentApprovedArtifactId: reqId });
          }
          if (where.projectId_phase?.phase === "documentation") {
            return Promise.resolve({ currentApprovedArtifactId: docId });
          }
          return Promise.resolve(null);
        }),
      },
      phaseArtifact: {
        findUnique: jest.fn().mockImplementation(({ where }) => {
          if (where.id === reqId) return Promise.resolve(validReqArtifact);
          if (where.id === docId) return Promise.resolve(validDocArtifact);
          return Promise.resolve(null);
        }),
      },
      phaseApproval: {
        findFirst: jest.fn().mockImplementation(({ where }) => {
          if (where.phase === "requirements" && where.artifactId === reqId) {
            return Promise.resolve({ id: "approval-req-1", createdAt: new Date(), approvedById: "owner-1" });
          }
          if (where.phase === "documentation" && where.artifactId === docId) {
            return Promise.resolve({ id: "approval-doc-1", createdAt: new Date(), approvedById: "owner-1" });
          }
          return Promise.resolve(null);
        }),
      },
      validReqArtifact,
      validDocArtifact,
    };
  }

  test("succeeds when Requirements and Documentation authorities are valid, approved, and provenance matches", async () => {
    const mock = createValidPrismaMock();
    const result = await preflightArchitectureHandoff(mock as any, projectId);

    expect(result.projectId).toBe(projectId);
    expect(result.requirements.artifact.id).toBe(reqId);
    expect(result.requirements.contentHash).toBe(reqHash);
    expect(result.documentation.artifact.id).toBe(docId);
    expect(result.documentation.contentHash).toBe(docHash);
    expect(result.documentation.content.sourceRequirements.artifactId).toBe(reqId);
  });

  test("fails if project is not found", async () => {
    const mock = createValidPrismaMock();
    mock.project.findUnique.mockResolvedValueOnce(null);

    await expect(preflightArchitectureHandoff(mock as any, projectId)).rejects.toMatchObject({
      code: "PLANNING_PROJECT_NOT_FOUND",
      httpStatus: 404,
    });
  });

  test("fails if Requirements authority is not approved", async () => {
    const mock = createValidPrismaMock();
    mock.projectPhaseState.findUnique.mockImplementationOnce(() => Promise.resolve(null));

    await expect(preflightArchitectureHandoff(mock as any, projectId)).rejects.toMatchObject({
      code: "PLANNING_ACTION_LOCKED",
      httpStatus: 409,
    });
  });

  test("fails if Requirements artifact is corrupted or not APPROVED lifecycle", async () => {
    const mock = createValidPrismaMock();
    mock.phaseArtifact.findUnique.mockImplementationOnce(() =>
      Promise.resolve({ ...mock.validReqArtifact, lifecycleStatus: ArtifactLifecycleStatus.DRAFT, approved: false }),
    );

    await expect(preflightArchitectureHandoff(mock as any, projectId)).rejects.toMatchObject({
      code: "PLANNING_ARTIFACT_INVALID",
      httpStatus: 422,
    });
  });

  test("fails if Requirements PhaseApproval record is missing", async () => {
    const mock = createValidPrismaMock();
    mock.phaseApproval.findFirst.mockResolvedValueOnce(null);

    await expect(preflightArchitectureHandoff(mock as any, projectId)).rejects.toMatchObject({
      code: "PLANNING_ARTIFACT_INVALID",
      httpStatus: 422,
    });
  });

  test("fails if Documentation authority is not approved", async () => {
    const mock = createValidPrismaMock();
    mock.projectPhaseState.findUnique.mockImplementation(({ where }) => {
      if (where.projectId_phase?.phase === "documentation") return Promise.resolve(null);
      return Promise.resolve({ currentApprovedArtifactId: reqId });
    });

    await expect(preflightArchitectureHandoff(mock as any, projectId)).rejects.toMatchObject({
      code: "PLANNING_ACTION_LOCKED",
      httpStatus: 409,
    });
  });

  test("fails if Documentation content hash is corrupted", async () => {
    const mock = createValidPrismaMock();
    mock.phaseArtifact.findUnique.mockImplementation(({ where }) => {
      if (where.id === docId) {
        return Promise.resolve({ ...mock.validDocArtifact, contentHash: "corrupted_hash" });
      }
      return Promise.resolve(mock.validReqArtifact);
    });

    await expect(preflightArchitectureHandoff(mock as any, projectId)).rejects.toMatchObject({
      code: "PLANNING_ARTIFACT_INVALID",
      httpStatus: 422,
    });
  });

  test("fails if Documentation PhaseApproval record is missing", async () => {
    const mock = createValidPrismaMock();
    mock.phaseApproval.findFirst.mockImplementation(({ where }) => {
      if (where.phase === "documentation") return Promise.resolve(null);
      return Promise.resolve({ id: "approval-req-1", createdAt: new Date(), approvedById: "owner-1" });
    });

    await expect(preflightArchitectureHandoff(mock as any, projectId)).rejects.toMatchObject({
      code: "PLANNING_ARTIFACT_INVALID",
      httpStatus: 422,
    });
  });

  test("fails if Documentation.sourceRequirements.artifactId != Requirements.id (stale)", async () => {
    const mock = createValidPrismaMock();
    const staleDocContent: DocumentationContent = {
      ...docContent,
      sourceRequirements: { artifactId: "old-req-id", version: 1, contentHash: reqHash },
    };
    const staleDocHash = hashDocumentationContent(staleDocContent);
    const staleDocMarkdown = renderDocumentationMarkdown(staleDocContent);

    mock.phaseArtifact.findUnique.mockImplementation(({ where }) => {
      if (where.id === docId) {
        return Promise.resolve({
          ...mock.validDocArtifact,
          content: staleDocMarkdown,
          contentHash: staleDocHash,
          structuredContent: staleDocContent as any,
        });
      }
      return Promise.resolve(mock.validReqArtifact);
    });
    mock.phaseApproval.findFirst.mockImplementation(({ where }) => {
      if (where.phase === "documentation") {
        return Promise.resolve({ id: "approval-doc-1", createdAt: new Date(), approvedById: "owner-1" });
      }
      return Promise.resolve({ id: "approval-req-1", createdAt: new Date(), approvedById: "owner-1" });
    });

    await expect(preflightArchitectureHandoff(mock as any, projectId)).rejects.toMatchObject({
      code: "PLANNING_ACTION_LOCKED",
      httpStatus: 409,
    });
  });

  test("fails if Documentation.sourceRequirements.version != Requirements.version (stale)", async () => {
    const mock = createValidPrismaMock();
    const staleDocContent: DocumentationContent = {
      ...docContent,
      sourceRequirements: { artifactId: reqId, version: 2, contentHash: reqHash },
    };
    const staleDocHash = hashDocumentationContent(staleDocContent);
    const staleDocMarkdown = renderDocumentationMarkdown(staleDocContent);

    mock.phaseArtifact.findUnique.mockImplementation(({ where }) => {
      if (where.id === docId) {
        return Promise.resolve({
          ...mock.validDocArtifact,
          content: staleDocMarkdown,
          contentHash: staleDocHash,
          structuredContent: staleDocContent as any,
        });
      }
      return Promise.resolve(mock.validReqArtifact);
    });
    mock.phaseApproval.findFirst.mockImplementation(({ where }) => {
      if (where.phase === "documentation") {
        return Promise.resolve({ id: "approval-doc-1", createdAt: new Date(), approvedById: "owner-1" });
      }
      return Promise.resolve({ id: "approval-req-1", createdAt: new Date(), approvedById: "owner-1" });
    });

    await expect(preflightArchitectureHandoff(mock as any, projectId)).rejects.toMatchObject({
      code: "PLANNING_ACTION_LOCKED",
      httpStatus: 409,
    });
  });

  test("fails if Documentation.sourceRequirements.contentHash != Requirements.contentHash (stale)", async () => {
    const mock = createValidPrismaMock();
    const staleDocContent: DocumentationContent = {
      ...docContent,
      sourceRequirements: {
        artifactId: reqId,
        version: 1,
        contentHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      },
    };
    const staleDocHash = hashDocumentationContent(staleDocContent);
    const staleDocMarkdown = renderDocumentationMarkdown(staleDocContent);

    mock.phaseArtifact.findUnique.mockImplementation(({ where }) => {
      if (where.id === docId) {
        return Promise.resolve({
          ...mock.validDocArtifact,
          content: staleDocMarkdown,
          contentHash: staleDocHash,
          structuredContent: staleDocContent as any,
        });
      }
      return Promise.resolve(mock.validReqArtifact);
    });
    mock.phaseApproval.findFirst.mockImplementation(({ where }) => {
      if (where.phase === "documentation") {
        return Promise.resolve({ id: "approval-doc-1", createdAt: new Date(), approvedById: "owner-1" });
      }
      return Promise.resolve({ id: "approval-req-1", createdAt: new Date(), approvedById: "owner-1" });
    });

    await expect(preflightArchitectureHandoff(mock as any, projectId)).rejects.toMatchObject({
      code: "PLANNING_ACTION_LOCKED",
      httpStatus: 409,
    });
  });
});
