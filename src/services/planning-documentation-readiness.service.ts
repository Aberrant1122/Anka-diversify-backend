import {
  collectDocumentationGraphIssues,
  traceabilityMatches,
} from "../planning/documentation-assembly";
import {
  DocumentationContent,
  DocumentationSourceRequirements,
  DocumentationValidationError,
  hashDocumentationContent,
  parseDocumentationContent,
  parseDocumentationSourceRequirements,
  renderDocumentationMarkdown,
} from "../planning/documentation-schema";
import {
  hashRequirementsContent,
  parseRequirementsContent,
  RequirementsContent,
} from "../planning/requirements-schema";

export type DocumentationReadinessCode =
  | "DOCS_UNRESOLVED_QUESTIONS"
  | "DOCS_SOURCE_REQUIREMENTS_INVALID"
  | "DOCS_UPSTREAM_AUTHORITY_MISMATCH"
  | "DOCS_SYSTEM_ACTORS_REQUIRED"
  | "DOCS_FEATURES_REQUIRED"
  | "DOCS_API_APPLICABILITY_INVALID"
  | "DOCS_DATA_APPLICABILITY_INVALID"
  | "DOCS_PERMISSION_APPLICABILITY_INVALID"
  | "DOCS_FUNCTIONAL_REQUIREMENT_UNCOVERED"
  | "DOCS_DANGLING_REQUIREMENT_REFERENCE"
  | "DOCS_DANGLING_USER_STORY_REFERENCE"
  | "DOCS_DANGLING_ACTOR_REFERENCE"
  | "DOCS_DANGLING_FEATURE_REFERENCE"
  | "DOCS_DANGLING_API_REFERENCE"
  | "DOCS_DANGLING_ENTITY_REFERENCE"
  | "DOCS_DANGLING_ERROR_REFERENCE"
  | "DOCS_TRACEABILITY_INCONSISTENT"
  | "DOCS_HASH_MISMATCH"
  | "DOCS_RENDER_MISMATCH"
  | "DOCS_ERROR_BEHAVIORS_REQUIRED"
  | "DOCS_FEATURE_ERROR_COVERAGE_REQUIRED"
  | "DOCS_EDGE_CASES_REQUIRED"
  | "DOCS_FEATURE_EDGE_COVERAGE_REQUIRED"
  | "DOCS_PERMISSION_COVERAGE_REQUIRED"
  | "DOCS_API_PERMISSION_COVERAGE_REQUIRED"
  | "DOCS_API_FEATURE_LINK_REQUIRED"
  | "DOCS_API_ERROR_LINK_REQUIRED"
  | "DOCS_ERROR_API_LINK_INCONSISTENT"
  | "DOCS_HTTP_STATUS_INVALID"
  | "DOCS_SECTION_NOT_APPLICABLE_REVIEW"
  | "DOCS_NONFUNCTIONAL_REQUIREMENT_UNCOVERED"
  | "DOCS_NO_BUSINESS_RULES";

export interface DocumentationReadinessItem {
  code: DocumentationReadinessCode;
  path?: string;
  message: string;
  itemIds?: string[];
}

export interface DocumentationReadiness {
  ready: boolean;
  artifactId: string;
  contentHash: string;
  blockers: DocumentationReadinessItem[];
  warnings: DocumentationReadinessItem[];
}

export interface DocumentationReadinessArtifact {
  id: string;
  content: string;
  structuredContent: unknown;
  contentHash: string | null;
}

export interface EvaluateDocumentationReadinessInput {
  artifact: DocumentationReadinessArtifact;
  historicalRequirements: unknown;
  currentApprovedRequirements: DocumentationSourceRequirements;
}

function item(
  code: DocumentationReadinessCode,
  path: string,
  message: string,
  itemIds?: string[],
): DocumentationReadinessItem {
  return { code, path, message, ...(itemIds && itemIds.length > 0 ? { itemIds: [...itemIds].sort() } : {}) };
}

function sourceInvalid(message: string): DocumentationReadinessItem {
  return item(
    "DOCS_SOURCE_REQUIREMENTS_INVALID",
    "sourceRequirements",
    message,
  );
}

function hasMalformedSource(error: unknown): boolean {
  return error instanceof DocumentationValidationError
    && Boolean(error.path?.startsWith("sourceRequirements"));
}

/** Pure, read-only readiness evaluation for a persisted Documentation candidate. */
export class PlanningDocumentationReadinessService {
  evaluateDocumentation(input: EvaluateDocumentationReadinessInput): DocumentationReadiness {
    const { artifact } = input;
    let content: DocumentationContent;
    try {
      content = parseDocumentationContent(artifact.structuredContent);
    } catch (error) {
      if (!hasMalformedSource(error)) throw error;
      const blockers = [sourceInvalid("The Documentation source Requirements provenance is malformed.")];
      return {
        ready: false,
        artifactId: artifact.id,
        contentHash: artifact.contentHash ?? "",
        blockers,
        warnings: [],
      };
    }

    const blockers: DocumentationReadinessItem[] = [];
    const warnings: DocumentationReadinessItem[] = [];
    let historicalRequirements: RequirementsContent | null = null;
    try {
      historicalRequirements = parseRequirementsContent(input.historicalRequirements);
      if (hashRequirementsContent(historicalRequirements) !== content.sourceRequirements.contentHash) {
        blockers.push(sourceInvalid("The supplied historical Requirements content does not match the recorded source hash."));
      }
    } catch {
      blockers.push(sourceInvalid("The supplied historical Requirements content is malformed."));
    }

    let currentApproved: DocumentationSourceRequirements | null = null;
    try {
      currentApproved = parseDocumentationSourceRequirements(input.currentApprovedRequirements);
    } catch {
      blockers.push(item(
        "DOCS_UPSTREAM_AUTHORITY_MISMATCH",
        "sourceRequirements",
        "The current approved Requirements authority descriptor is malformed.",
      ));
    }
    if (currentApproved && (
      currentApproved.artifactId !== content.sourceRequirements.artifactId
      || currentApproved.version !== content.sourceRequirements.version
      || currentApproved.contentHash !== content.sourceRequirements.contentHash
    )) {
      blockers.push(item(
        "DOCS_UPSTREAM_AUTHORITY_MISMATCH",
        "sourceRequirements",
        "Documentation is not based on the current approved Requirements authority.",
      ));
    }

    if (content.unresolvedQuestions.length > 0) {
      blockers.push(item(
        "DOCS_UNRESOLVED_QUESTIONS",
        "unresolvedQuestions",
        "Resolve all Documentation questions before approval.",
        content.unresolvedQuestions.map(({ id }) => id),
      ));
    }

    if (historicalRequirements) {
      blockers.push(...collectDocumentationGraphIssues(content, historicalRequirements));
      if (!traceabilityMatches(content, historicalRequirements)) {
        blockers.push(item(
          "DOCS_TRACEABILITY_INCONSISTENT",
          "requirementsTraceability",
          "Persisted Requirements traceability differs from deterministic recomputation.",
        ));
      }
    }

    const calculatedHash = hashDocumentationContent(content);
    if (!artifact.contentHash || artifact.contentHash !== calculatedHash) {
      blockers.push(item(
        "DOCS_HASH_MISMATCH",
        "contentHash",
        "The stored Documentation hash differs from its canonical structured content.",
      ));
    }
    if (artifact.content !== renderDocumentationMarkdown(content)) {
      blockers.push(item(
        "DOCS_RENDER_MISMATCH",
        "content",
        "The stored Documentation Markdown differs from deterministic rendering.",
      ));
    }

    const notApplicable = ([
      ["apiContracts", content.apiContracts.applicable],
      ["dataEntities", content.dataEntities.applicable],
      ["permissionRules", content.permissionRules.applicable],
    ] as const).filter(([, applicable]) => !applicable).map(([section]) => section);
    if (notApplicable.length > 0) {
      warnings.push(item(
        "DOCS_SECTION_NOT_APPLICABLE_REVIEW",
        "documentation",
        "Review conditional Documentation sections marked not applicable.",
        notApplicable,
      ));
    }

    const uncoveredNfrIds = content.requirementsTraceability
      .filter((trace) => trace.requirementKind === "non_functional" && trace.coverageStatus === "uncovered")
      .map((trace) => trace.requirementId);
    if (uncoveredNfrIds.length > 0) {
      warnings.push(item(
        "DOCS_NONFUNCTIONAL_REQUIREMENT_UNCOVERED",
        "requirementsTraceability",
        "One or more non-functional Requirements are not covered by Documentation.",
        uncoveredNfrIds,
      ));
    }
    if (content.businessRules.length === 0) {
      warnings.push(item(
        "DOCS_NO_BUSINESS_RULES",
        "businessRules",
        "No business rules are currently documented.",
      ));
    }

    return {
      ready: blockers.length === 0,
      artifactId: artifact.id,
      contentHash: artifact.contentHash ?? calculatedHash,
      blockers,
      warnings,
    };
  }
}
