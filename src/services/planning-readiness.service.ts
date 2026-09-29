import { PlanningDomainError } from "../planning/planning-errors";
import {
  hashRequirementsContent,
  parseRequirementsContent,
  renderRequirementsMarkdown,
  RequirementsContent,
} from "../planning/requirements-schema";

export interface RequirementsReadinessItem {
  code: string;
  path?: string;
  message: string;
  itemIds?: string[];
}

export interface RequirementsReadiness {
  ready: boolean;
  artifactId: string;
  contentHash: string;
  blockers: RequirementsReadinessItem[];
  warnings: RequirementsReadinessItem[];
}

export interface RequirementsReadinessArtifact {
  id: string;
  content: string;
  structuredContent: unknown;
  contentHash: string | null;
}

export interface EvaluateRequirementsReadinessInput {
  artifact: RequirementsReadinessArtifact;
  expectedHash?: string;
}

function normalizeIntegrationName(name: string): string {
  return name.trim().toLocaleLowerCase("en-US").replace(/\s+/g, " ");
}

export class PlanningReadinessService {
  evaluateRequirements(input: EvaluateRequirementsReadinessInput): RequirementsReadiness {
    const { artifact, expectedHash } = input;
    if (expectedHash !== undefined && (!expectedHash || artifact.contentHash !== expectedHash)) {
      throw new PlanningDomainError(
        "PLANNING_ARTIFACT_HASH_MISMATCH",
        "The Requirements content hash does not match the reviewed artifact.",
        409,
        { artifactId: artifact.id, expectedHash, actualHash: artifact.contentHash },
      );
    }

    const content = parseRequirementsContent(artifact.structuredContent);
    const calculatedHash = hashRequirementsContent(content);
    const rendered = renderRequirementsMarkdown(content);
    if (!artifact.contentHash || artifact.contentHash !== calculatedHash || artifact.content !== rendered) {
      throw new PlanningDomainError(
        "PLANNING_ARTIFACT_INVALID",
        "The persisted Requirements rendering or hash is inconsistent with its canonical structured content.",
        422,
        { artifactId: artifact.id },
      );
    }

    const blockers = this.collectBlockers(content);
    const warnings = this.collectWarnings(content);
    return {
      ready: blockers.length === 0,
      artifactId: artifact.id,
      contentHash: artifact.contentHash,
      blockers,
      warnings,
    };
  }

  private collectBlockers(content: RequirementsContent): RequirementsReadinessItem[] {
    const blockers: RequirementsReadinessItem[] = [];

    if (content.unresolvedQuestions.length > 0) {
      blockers.push({
        code: "REQUIREMENTS_UNRESOLVED_QUESTIONS",
        path: "unresolvedQuestions",
        message: "Resolve, remove, or explicitly reclassify all unresolved questions before approval.",
        itemIds: content.unresolvedQuestions.map((question) => question.id),
      });
    }

    if (content.functionalRequirements.length === 0) {
      blockers.push({
        code: "REQUIREMENTS_FUNCTIONAL_REQUIREMENTS_REQUIRED",
        path: "functionalRequirements",
        message: "At least one functional requirement is required before approval.",
      });
    }

    if (content.acceptanceCriteria.length === 0) {
      blockers.push({
        code: "REQUIREMENTS_ACCEPTANCE_CRITERIA_REQUIRED",
        path: "acceptanceCriteria",
        message: "At least one acceptance criterion is required before approval.",
      });
    }

    const coveredRequirementIds = new Set(
      content.acceptanceCriteria.flatMap((criterion) => criterion.relatedRequirementIds),
    );
    const uncoveredRequirementIds = content.functionalRequirements
      .filter((requirement) => !coveredRequirementIds.has(requirement.id))
      .map((requirement) => requirement.id);
    if (uncoveredRequirementIds.length > 0) {
      blockers.push({
        code: "REQUIREMENTS_FUNCTIONAL_REQUIREMENT_UNCOVERED",
        path: "functionalRequirements",
        message: "Every functional requirement must be covered by at least one acceptance criterion.",
        itemIds: uncoveredRequirementIds,
      });
    }

    const uncoveredStoryIds = content.userStories
      .filter((story) => story.acceptanceCriteriaIds.length === 0)
      .map((story) => story.id);
    if (uncoveredStoryIds.length > 0) {
      blockers.push({
        code: "REQUIREMENTS_USER_STORY_ACCEPTANCE_REQUIRED",
        path: "userStories",
        message: "Every user story must reference at least one acceptance criterion.",
        itemIds: uncoveredStoryIds,
      });
    }

    if (content.userStories.length > 0 && content.usersAndActors.length === 0) {
      blockers.push({
        code: "REQUIREMENTS_ACTOR_REQUIRED",
        path: "usersAndActors",
        message: "At least one actor is required when user stories exist.",
      });
    }

    const integrationsByName = new Map<string, typeof content.integrations>();
    for (const integration of content.integrations) {
      const normalizedName = normalizeIntegrationName(integration.name);
      const existing = integrationsByName.get(normalizedName) ?? [];
      existing.push(integration);
      integrationsByName.set(normalizedName, existing);
    }
    const conflictingIntegrationIds = [...integrationsByName.values()]
      .filter((integrations) => new Set(integrations.map((integration) => integration.required)).size > 1)
      .flatMap((integrations) => integrations.map((integration) => integration.id));
    if (conflictingIntegrationIds.length > 0) {
      blockers.push({
        code: "REQUIREMENTS_INTEGRATION_DECLARATION_CONFLICT",
        path: "integrations",
        message: "Integrations with the same normalized name cannot conflict on whether they are required.",
        itemIds: conflictingIntegrationIds,
      });
    }

    return blockers;
  }

  private collectWarnings(content: RequirementsContent): RequirementsReadinessItem[] {
    const warnings: RequirementsReadinessItem[] = [];

    if (content.nonFunctionalRequirements.length === 0) {
      warnings.push({
        code: "REQUIREMENTS_NO_NON_FUNCTIONAL_REQUIREMENTS",
        path: "nonFunctionalRequirements",
        message: "No non-functional requirements are currently defined.",
      });
    }

    if (content.assumptions.length > 0) {
      warnings.push({
        code: "REQUIREMENTS_ASSUMPTIONS_PRESENT",
        path: "assumptions",
        message: "Confirm that the recorded assumptions are acceptable before approval.",
        itemIds: content.assumptions.map((assumption) => assumption.id),
      });
    }

    if (content.usersAndActors.length === 0 && content.userStories.length === 0) {
      warnings.push({
        code: "REQUIREMENTS_NO_ACTORS",
        path: "usersAndActors",
        message: "No users or actors are currently defined.",
      });
    }

    return warnings;
  }
}
