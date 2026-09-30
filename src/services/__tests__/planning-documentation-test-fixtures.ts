import crypto from "crypto";
import { PhaseArtifact, PrismaClient } from "@prisma/client";
import { assembleDocumentationContent } from "../../planning/documentation-assembly";
import {
  DocumentationContent,
  DocumentationProviderDraft,
} from "../../planning/documentation-schema";
import {
  hashRequirementsContent,
  RequirementsContent,
} from "../../planning/requirements-schema";
import { PlanningApprovalService } from "../planning-approval.service";
import { PlanningArtifactService } from "../planning-artifact.service";
import { PlanningDocumentationArtifactService } from "../planning-documentation-artifact.service";

const databaseUrl = process.env.DATABASE_URL;
const isolatedSchema = databaseUrl ? new URL(databaseUrl).searchParams.get("schema") : null;
if (!isolatedSchema?.startsWith("planning_checkpoint_1b_")) {
  throw new Error("Documentation lifecycle tests require an isolated planning_checkpoint_1b_* PostgreSQL schema");
}

export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export function requirements(label = "docs"): RequirementsContent {
  const safe = label.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  return {
    projectGoal: `Deliver ${label}`,
    problemStatement: `The project needs ${label}.`,
    usersAndActors: [{ id: `ACT-${safe}`, name: "Owner", description: "Owns the outcome." }],
    userStories: [{ id: `US-${safe}`, actor: "Owner", capability: "work", benefit: "value", acceptanceCriteriaIds: [`AC-${safe}`] }],
    functionalRequirements: [{ id: `FR-${safe}`, title: "Work", description: "Support the workflow." }],
    nonFunctionalRequirements: [{ id: `NFR-${safe}`, title: "Audit", description: "Keep an audit trail." }],
    constraints: [],
    integrations: [],
    assumptions: [],
    acceptanceCriteria: [{ id: `AC-${safe}`, description: "The workflow succeeds.", relatedRequirementIds: [`FR-${safe}`] }],
    outOfScope: [],
    unresolvedQuestions: [],
  };
}

export function documentationDraft(req: RequirementsContent): DocumentationProviderDraft {
  const actor = req.usersAndActors[0].id;
  const story = req.userStories[0].id;
  const functional = req.functionalRequirements[0].id;
  const nonFunctional = req.nonFunctionalRequirements[0].id;
  return {
    overview: { summary: "Canonical Documentation", scope: "The approved scope", goals: [], nonGoals: [] },
    systemActors: [{ id: "DOC-ACTOR", name: "Owner", description: "Uses the workflow.", sourceActorIds: [actor] }],
    features: [{ id: "DOC-FEATURE", title: "Workflow", description: "Runs the workflow.", workflowSteps: ["Start", "Finish"], actorIds: ["DOC-ACTOR"], access: "controlled", sourceRequirementIds: [functional], sourceUserStoryIds: [story] }],
    apiContracts: { applicable: true, rationale: "A service contract is required.", items: [{ id: "DOC-API", name: "Run workflow", description: "Runs it.", interaction: { kind: "http", method: "POST", path: "/workflow" }, access: "controlled", input: { description: "Input", fields: [] }, success: { description: "Success", fields: [] }, relatedFeatureIds: ["DOC-FEATURE"], relatedEntityIds: ["DOC-ENTITY"], errorBehaviorIds: ["DOC-ERROR"], sourceRequirementIds: [nonFunctional], sourceUserStoryIds: [story] }] },
    dataEntities: { applicable: true, rationale: "State is persisted.", items: [{ id: "DOC-ENTITY", name: "Workflow", description: "Workflow state.", fields: [{ name: "id", logicalType: "identifier", required: true, description: "Identifier", allowedValues: [], validationRules: [] }], relationships: [], sourceRequirementIds: [nonFunctional], sourceUserStoryIds: [] }] },
    businessRules: [{ id: "DOC-RULE", title: "Owner review", condition: "Before approval", expectedBehavior: "Require the owner.", relatedFeatureIds: ["DOC-FEATURE"], relatedEntityIds: [], sourceRequirementIds: [functional], sourceUserStoryIds: [] }],
    permissionRules: { applicable: true, rationale: "The workflow is controlled.", items: [{ id: "DOC-PERMISSION", title: "Owner access", description: "Allow the owner.", effect: "allow", actorIds: ["DOC-ACTOR"], actions: ["approve"], relatedFeatureIds: ["DOC-FEATURE"], relatedApiContractIds: ["DOC-API"] }] },
    errorBehaviors: [{ id: "DOC-ERROR", code: "WORKFLOW_FAILED", scenario: "The workflow fails.", expectedSystemBehavior: "Reject safely.", recoveryBehavior: "Retry.", relatedFeatureIds: ["DOC-FEATURE"], relatedApiContractIds: ["DOC-API"], httpStatus: 409 }],
    edgeCases: [{ id: "DOC-EDGE", scenario: "Concurrent approval", expectedHandling: "Only one succeeds.", relatedFeatureIds: ["DOC-FEATURE"], relatedApiContractIds: ["DOC-API"], relatedEntityIds: ["DOC-ENTITY"] }],
    unresolvedQuestions: [],
  };
}

export function documentationContent(
  artifact: PhaseArtifact,
  req: RequirementsContent,
  draft = documentationDraft(req),
): DocumentationContent {
  if (!artifact.contentHash) throw new Error("Approved Requirements fixture is missing a hash.");
  return assembleDocumentationContent(draft, {
    artifactId: artifact.id,
    version: artifact.version,
    contentHash: artifact.contentHash,
  }, req);
}

export function hashOf(artifact: PhaseArtifact): string {
  if (!artifact.contentHash) throw new Error(`Artifact ${artifact.id} is missing its content hash.`);
  return artifact.contentHash;
}

export class DocumentationLifecycleFixture {
  readonly prisma = new PrismaClient();
  readonly requirementsArtifacts = new PlanningArtifactService(this.prisma);
  readonly documentationArtifacts = new PlanningDocumentationArtifactService(this.prisma);
  readonly approvals = new PlanningApprovalService(this.prisma);
  readonly ownerId = `docs-owner-${crypto.randomUUID()}`;
  readonly memberId = `docs-member-${crypto.randomUUID()}`;
  readonly outsiderId = `docs-outsider-${crypto.randomUUID()}`;
  private readonly projectIds: string[] = [];

  async start(): Promise<void> {
    await this.prisma.user.createMany({ data: [
      { id: this.ownerId, email: `${this.ownerId}@anka.test`, password: "unused" },
      { id: this.memberId, email: `${this.memberId}@anka.test`, password: "unused" },
      { id: this.outsiderId, email: `${this.outsiderId}@anka.test`, password: "unused" },
    ] });
  }

  async stop(): Promise<void> {
    for (const projectId of this.projectIds.reverse()) {
      await this.prisma.project.delete({ where: { id: projectId } });
    }
    await this.prisma.user.deleteMany({ where: { id: { in: [this.ownerId, this.memberId, this.outsiderId] } } });
    await this.prisma.$disconnect();
  }

  async createProject(member = false): Promise<string> {
    const id = `docs-project-${crypto.randomUUID()}`;
    await this.prisma.project.create({ data: { id, name: "Documentation lifecycle", userId: this.ownerId } });
    if (member) await this.prisma.projectMember.create({ data: { projectId: id, userId: this.memberId } });
    this.projectIds.push(id);
    return id;
  }

  async approveRequirements(projectId: string, label = "docs"): Promise<{ artifact: PhaseArtifact; content: RequirementsContent }> {
    const content = requirements(label);
    const artifact = await this.requirementsArtifacts.createInitialArtifact({
      projectId,
      actorId: this.ownerId,
      title: "Requirements",
      structuredContent: content,
    });
    await this.approvals.requestApproval({ projectId, phase: "requirements", artifactId: artifact.id, expectedHash: hashOf(artifact), actorId: this.ownerId });
    await this.approvals.approveArtifact({ projectId, phase: "requirements", artifactId: artifact.id, expectedHash: hashOf(artifact), actorId: this.ownerId });
    return { artifact, content };
  }

  async approveNextRequirements(
    projectId: string,
    base: PhaseArtifact,
    label: string,
  ): Promise<{ artifact: PhaseArtifact; content: RequirementsContent }> {
    const content = requirements(label);
    const artifact = await this.requirementsArtifacts.createManualRevision({
      projectId,
      actorId: this.ownerId,
      baseArtifactId: base.id,
      baseContentHash: hashOf(base),
      structuredContent: content,
    });
    await this.approvals.requestApproval({ projectId, phase: "requirements", artifactId: artifact.id, expectedHash: hashOf(artifact), actorId: this.ownerId });
    await this.approvals.approveArtifact({ projectId, phase: "requirements", artifactId: artifact.id, expectedHash: hashOf(artifact), actorId: this.ownerId });
    return { artifact, content };
  }
}

export function assertRequirementsHash(req: RequirementsContent, artifact: PhaseArtifact): void {
  if (artifact.contentHash !== hashRequirementsContent(req)) throw new Error("Requirements fixture hash mismatch.");
}
