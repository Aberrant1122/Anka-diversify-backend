import { canonicalJson } from "./requirements-context";
import { hashRequirementsContent, parseRequirementsContent, RequirementsContent } from "./requirements-schema";
import {
  ApplicableSection,
  DOCUMENTATION_CANONICAL_JSON_MAX_BYTES,
  DocumentationApiContract,
  DocumentationBusinessRule,
  DocumentationContent,
  DocumentationDataEntity,
  DocumentationEdgeCase,
  DocumentationErrorBehavior,
  DocumentationFeature,
  DocumentationPermissionRule,
  DocumentationProviderDraft,
  DocumentationRequirementTrace,
  DocumentationSourceRequirements,
  DocumentationValidationError,
  parseDocumentationContent,
  parseDocumentationProviderDraft,
  parseDocumentationSourceRequirements,
} from "./documentation-schema";

export type DocumentationGraphIssueCode =
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
  | "DOCS_ERROR_BEHAVIORS_REQUIRED"
  | "DOCS_FEATURE_ERROR_COVERAGE_REQUIRED"
  | "DOCS_EDGE_CASES_REQUIRED"
  | "DOCS_FEATURE_EDGE_COVERAGE_REQUIRED"
  | "DOCS_PERMISSION_COVERAGE_REQUIRED"
  | "DOCS_API_PERMISSION_COVERAGE_REQUIRED"
  | "DOCS_API_FEATURE_LINK_REQUIRED"
  | "DOCS_API_ERROR_LINK_REQUIRED"
  | "DOCS_ERROR_API_LINK_INCONSISTENT"
  | "DOCS_HTTP_STATUS_INVALID";

export interface DocumentationGraphIssue {
  code: DocumentationGraphIssueCode;
  path: string;
  message: string;
  itemIds?: string[];
}

function sortedUnique(ids: readonly string[]): string[] {
  return [...ids].sort((a, b) => a.localeCompare(b));
}

function byId<T extends { id: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.id.localeCompare(b.id));
}

function normalizeApplicable<T extends { id: string }>(
  section: ApplicableSection<T>,
  normalizeItem: (item: T) => T,
): ApplicableSection<T> {
  return { ...section, items: byId(section.items.map(normalizeItem)) };
}

export function normalizeDocumentationProviderDraft(draft: DocumentationProviderDraft): DocumentationProviderDraft {
  return {
    overview: draft.overview,
    systemActors: byId(draft.systemActors.map((item) => ({ ...item, sourceActorIds: sortedUnique(item.sourceActorIds) }))),
    features: byId(draft.features.map((item) => ({ ...item, actorIds: sortedUnique(item.actorIds), sourceRequirementIds: sortedUnique(item.sourceRequirementIds), sourceUserStoryIds: sortedUnique(item.sourceUserStoryIds) }))),
    apiContracts: normalizeApplicable(draft.apiContracts, (item) => ({ ...item, relatedFeatureIds: sortedUnique(item.relatedFeatureIds), relatedEntityIds: sortedUnique(item.relatedEntityIds), errorBehaviorIds: sortedUnique(item.errorBehaviorIds), sourceRequirementIds: sortedUnique(item.sourceRequirementIds), sourceUserStoryIds: sortedUnique(item.sourceUserStoryIds) })),
    dataEntities: normalizeApplicable(draft.dataEntities, (item) => ({ ...item, relationships: [...item.relationships].sort((a, b) => a.targetEntityId.localeCompare(b.targetEntityId) || a.cardinality.localeCompare(b.cardinality)), sourceRequirementIds: sortedUnique(item.sourceRequirementIds), sourceUserStoryIds: sortedUnique(item.sourceUserStoryIds) })),
    businessRules: byId(draft.businessRules.map((item) => ({ ...item, relatedFeatureIds: sortedUnique(item.relatedFeatureIds), relatedEntityIds: sortedUnique(item.relatedEntityIds), sourceRequirementIds: sortedUnique(item.sourceRequirementIds), sourceUserStoryIds: sortedUnique(item.sourceUserStoryIds) }))),
    permissionRules: normalizeApplicable(draft.permissionRules, (item) => ({ ...item, actorIds: sortedUnique(item.actorIds), relatedFeatureIds: sortedUnique(item.relatedFeatureIds), relatedApiContractIds: sortedUnique(item.relatedApiContractIds) })),
    errorBehaviors: byId(draft.errorBehaviors.map((item) => ({ ...item, relatedFeatureIds: sortedUnique(item.relatedFeatureIds), relatedApiContractIds: sortedUnique(item.relatedApiContractIds) }))),
    edgeCases: byId(draft.edgeCases.map((item) => ({ ...item, relatedFeatureIds: sortedUnique(item.relatedFeatureIds), relatedApiContractIds: sortedUnique(item.relatedApiContractIds), relatedEntityIds: sortedUnique(item.relatedEntityIds) }))),
    unresolvedQuestions: byId(draft.unresolvedQuestions),
  };
}

function documentationIdEntries(draft: DocumentationProviderDraft): Array<{ id: string; section: string }> {
  return [
    ...draft.systemActors.map(({ id }) => ({ id, section: "systemActors" })),
    ...draft.features.map(({ id }) => ({ id, section: "features" })),
    ...draft.apiContracts.items.map(({ id }) => ({ id, section: "apiContracts" })),
    ...draft.dataEntities.items.map(({ id }) => ({ id, section: "dataEntities" })),
    ...draft.businessRules.map(({ id }) => ({ id, section: "businessRules" })),
    ...draft.permissionRules.items.map(({ id }) => ({ id, section: "permissionRules" })),
    ...draft.errorBehaviors.map(({ id }) => ({ id, section: "errorBehaviors" })),
    ...draft.edgeCases.map(({ id }) => ({ id, section: "edgeCases" })),
    ...draft.unresolvedQuestions.map(({ id }) => ({ id, section: "unresolvedQuestions" })),
  ];
}

function validateUniqueDocumentationIds(draft: DocumentationProviderDraft): void {
  const seen = new Map<string, string>();
  for (const entry of documentationIdEntries(draft)) {
    const previous = seen.get(entry.id);
    if (previous) {
      throw new DocumentationValidationError(
        "DOCUMENTATION_STABLE_ID_INVALID",
        `Documentation ID '${entry.id}' is already used in '${previous}' and cannot also be used in '${entry.section}'.`,
        entry.section,
        { id: entry.id, previousSection: previous, section: entry.section },
      );
    }
    seen.set(entry.id, entry.section);
  }
}

function issue(
  issues: DocumentationGraphIssue[],
  code: DocumentationGraphIssueCode,
  path: string,
  message: string,
  itemIds?: string[],
): void {
  issues.push({ code, path, message, ...(itemIds && itemIds.length > 0 ? { itemIds: sortedUnique(itemIds) } : {}) });
}

function missing(ids: readonly string[], available: ReadonlySet<string>): string[] {
  return ids.filter((id) => !available.has(id));
}

function allSourceItems(draft: DocumentationProviderDraft): Array<{
  path: string;
  sourceRequirementIds: string[];
  sourceUserStoryIds: string[];
}> {
  return [
    ...draft.features.map((item) => ({ path: `features.${item.id}`, sourceRequirementIds: item.sourceRequirementIds, sourceUserStoryIds: item.sourceUserStoryIds })),
    ...draft.apiContracts.items.map((item) => ({ path: `apiContracts.${item.id}`, sourceRequirementIds: item.sourceRequirementIds, sourceUserStoryIds: item.sourceUserStoryIds })),
    ...draft.dataEntities.items.map((item) => ({ path: `dataEntities.${item.id}`, sourceRequirementIds: item.sourceRequirementIds, sourceUserStoryIds: item.sourceUserStoryIds })),
    ...draft.businessRules.map((item) => ({ path: `businessRules.${item.id}`, sourceRequirementIds: item.sourceRequirementIds, sourceUserStoryIds: item.sourceUserStoryIds })),
  ];
}

export function collectDocumentationGraphIssues(
  input: DocumentationProviderDraft,
  upstreamInput: RequirementsContent,
): DocumentationGraphIssue[] {
  const draft = normalizeDocumentationProviderDraft(input);
  const upstream = parseRequirementsContent(upstreamInput);
  validateUniqueDocumentationIds(draft);
  const issues: DocumentationGraphIssue[] = [];
  const actorIds = new Set(draft.systemActors.map((item) => item.id));
  const featureIds = new Set(draft.features.map((item) => item.id));
  const apiIds = new Set(draft.apiContracts.items.map((item) => item.id));
  const entityIds = new Set(draft.dataEntities.items.map((item) => item.id));
  const errorIds = new Set(draft.errorBehaviors.map((item) => item.id));
  const upstreamActorIds = new Set(upstream.usersAndActors.map((item) => item.id));
  const requirementIds = new Set([...upstream.functionalRequirements, ...upstream.nonFunctionalRequirements].map((item) => item.id));
  const storyIds = new Set(upstream.userStories.map((item) => item.id));

  if (draft.systemActors.length === 0) issue(issues, "DOCS_SYSTEM_ACTORS_REQUIRED", "systemActors", "At least one system actor is required.");
  if (draft.features.length === 0) issue(issues, "DOCS_FEATURES_REQUIRED", "features", "At least one feature is required.");
  if (draft.errorBehaviors.length === 0) issue(issues, "DOCS_ERROR_BEHAVIORS_REQUIRED", "errorBehaviors", "At least one error behavior is required.");
  if (draft.edgeCases.length === 0) issue(issues, "DOCS_EDGE_CASES_REQUIRED", "edgeCases", "At least one edge case is required.");

  for (const actor of draft.systemActors) {
    const absent = missing(actor.sourceActorIds, upstreamActorIds);
    if (absent.length) issue(issues, "DOCS_DANGLING_ACTOR_REFERENCE", `systemActors.${actor.id}.sourceActorIds`, "Actor references unknown upstream actors.", absent);
  }
  for (const feature of draft.features) {
    const absentActors = missing(feature.actorIds, actorIds);
    if (absentActors.length) issue(issues, "DOCS_DANGLING_ACTOR_REFERENCE", `features.${feature.id}.actorIds`, "Feature references unknown Documentation actors.", absentActors);
  }
  for (const item of allSourceItems(draft)) {
    const absentRequirements = missing(item.sourceRequirementIds, requirementIds);
    const absentStories = missing(item.sourceUserStoryIds, storyIds);
    if (absentRequirements.length) issue(issues, "DOCS_DANGLING_REQUIREMENT_REFERENCE", `${item.path}.sourceRequirementIds`, "Item references unknown Requirements.", absentRequirements);
    if (absentStories.length) issue(issues, "DOCS_DANGLING_USER_STORY_REFERENCE", `${item.path}.sourceUserStoryIds`, "Item references unknown UserStories.", absentStories);
  }

  for (const api of draft.apiContracts.items) {
    const absentFeatures = missing(api.relatedFeatureIds, featureIds);
    const absentEntities = missing(api.relatedEntityIds, entityIds);
    const absentErrors = missing(api.errorBehaviorIds, errorIds);
    if (absentFeatures.length) issue(issues, "DOCS_DANGLING_FEATURE_REFERENCE", `apiContracts.${api.id}.relatedFeatureIds`, "API contract references unknown features.", absentFeatures);
    if (absentEntities.length) issue(issues, "DOCS_DANGLING_ENTITY_REFERENCE", `apiContracts.${api.id}.relatedEntityIds`, "API contract references unknown entities.", absentEntities);
    if (absentErrors.length) issue(issues, "DOCS_DANGLING_ERROR_REFERENCE", `apiContracts.${api.id}.errorBehaviorIds`, "API contract references unknown error behaviors.", absentErrors);
    if (api.relatedFeatureIds.length === 0) issue(issues, "DOCS_API_FEATURE_LINK_REQUIRED", `apiContracts.${api.id}.relatedFeatureIds`, "Every API contract must relate to a feature.", [api.id]);
    if (api.errorBehaviorIds.length === 0) issue(issues, "DOCS_API_ERROR_LINK_REQUIRED", `apiContracts.${api.id}.errorBehaviorIds`, "Every API contract must relate to an error behavior.", [api.id]);
  }

  for (const entity of draft.dataEntities.items) {
    const relationshipKeys = new Set<string>();
    for (const relation of entity.relationships) {
      if (!entityIds.has(relation.targetEntityId)) issue(issues, "DOCS_DANGLING_ENTITY_REFERENCE", `dataEntities.${entity.id}.relationships`, "Entity relationship references an unknown entity.", [relation.targetEntityId]);
      const key = `${relation.targetEntityId}\u0000${relation.cardinality}`;
      if (relationshipKeys.has(key)) issue(issues, "DOCS_DANGLING_ENTITY_REFERENCE", `dataEntities.${entity.id}.relationships`, "Duplicate entity relationship target/cardinality pair.", [relation.targetEntityId]);
      relationshipKeys.add(key);
    }
  }

  for (const rule of draft.businessRules) {
    const absentFeatures = missing(rule.relatedFeatureIds, featureIds);
    const absentEntities = missing(rule.relatedEntityIds, entityIds);
    if (absentFeatures.length) issue(issues, "DOCS_DANGLING_FEATURE_REFERENCE", `businessRules.${rule.id}.relatedFeatureIds`, "Business rule references unknown features.", absentFeatures);
    if (absentEntities.length) issue(issues, "DOCS_DANGLING_ENTITY_REFERENCE", `businessRules.${rule.id}.relatedEntityIds`, "Business rule references unknown entities.", absentEntities);
    if (rule.relatedFeatureIds.length + rule.relatedEntityIds.length === 0) issue(issues, "DOCS_DANGLING_FEATURE_REFERENCE", `businessRules.${rule.id}`, "Business rule must target at least one feature or entity.", [rule.id]);
  }

  for (const rule of draft.permissionRules.items) {
    const absentActors = missing(rule.actorIds, actorIds);
    const absentFeatures = missing(rule.relatedFeatureIds, featureIds);
    const absentApis = missing(rule.relatedApiContractIds, apiIds);
    if (absentActors.length) issue(issues, "DOCS_DANGLING_ACTOR_REFERENCE", `permissionRules.${rule.id}.actorIds`, "Permission rule references unknown actors.", absentActors);
    if (absentFeatures.length) issue(issues, "DOCS_DANGLING_FEATURE_REFERENCE", `permissionRules.${rule.id}.relatedFeatureIds`, "Permission rule references unknown features.", absentFeatures);
    if (absentApis.length) issue(issues, "DOCS_DANGLING_API_REFERENCE", `permissionRules.${rule.id}.relatedApiContractIds`, "Permission rule references unknown API contracts.", absentApis);
    if (rule.relatedFeatureIds.length + rule.relatedApiContractIds.length === 0) issue(issues, "DOCS_PERMISSION_APPLICABILITY_INVALID", `permissionRules.${rule.id}`, "Permission rule must target a feature or API contract.", [rule.id]);
    const publicFeatures = rule.relatedFeatureIds.filter((id) => draft.features.find((feature) => feature.id === id)?.access === "public");
    const publicApis = rule.relatedApiContractIds.filter((id) => draft.apiContracts.items.find((api) => api.id === id)?.access === "public");
    if (publicFeatures.length + publicApis.length > 0) issue(issues, "DOCS_PERMISSION_APPLICABILITY_INVALID", `permissionRules.${rule.id}`, "Permission rules may target only controlled features and APIs.", [...publicFeatures, ...publicApis]);
  }

  const errorCodes = new Set<string>();
  for (const behavior of draft.errorBehaviors) {
    const absentFeatures = missing(behavior.relatedFeatureIds, featureIds);
    const absentApis = missing(behavior.relatedApiContractIds, apiIds);
    if (absentFeatures.length) issue(issues, "DOCS_DANGLING_FEATURE_REFERENCE", `errorBehaviors.${behavior.id}.relatedFeatureIds`, "Error behavior references unknown features.", absentFeatures);
    if (absentApis.length) issue(issues, "DOCS_DANGLING_API_REFERENCE", `errorBehaviors.${behavior.id}.relatedApiContractIds`, "Error behavior references unknown APIs.", absentApis);
    if (behavior.relatedFeatureIds.length === 0) issue(issues, "DOCS_FEATURE_ERROR_COVERAGE_REQUIRED", `errorBehaviors.${behavior.id}.relatedFeatureIds`, "Every error behavior must relate to at least one feature.", [behavior.id]);
    if (errorCodes.has(behavior.code)) issue(issues, "DOCS_ERROR_API_LINK_INCONSISTENT", `errorBehaviors.${behavior.id}.code`, "Error behavior codes must be globally unique.", [behavior.id]);
    errorCodes.add(behavior.code);
    const relatedApis = behavior.relatedApiContractIds.map((id) => draft.apiContracts.items.find((api) => api.id === id)).filter((api): api is DocumentationApiContract => Boolean(api));
    const httpCount = relatedApis.filter((api) => api.interaction.kind === "http").length;
    const nonHttpCount = relatedApis.length - httpCount;
    const statusInvalid = behavior.httpStatus !== undefined && (!Number.isInteger(behavior.httpStatus) || behavior.httpStatus < 100 || behavior.httpStatus > 599);
    if (statusInvalid || (behavior.httpStatus !== undefined && relatedApis.length === 0) || (httpCount > 0 && nonHttpCount > 0) || (httpCount > 0 && behavior.httpStatus === undefined) || (nonHttpCount > 0 && behavior.httpStatus !== undefined)) {
      issue(issues, "DOCS_HTTP_STATUS_INVALID", `errorBehaviors.${behavior.id}.httpStatus`, "HTTP status does not match the related API transport contract.", [behavior.id]);
    }
  }

  for (const edge of draft.edgeCases) {
    const absentFeatures = missing(edge.relatedFeatureIds, featureIds);
    const absentApis = missing(edge.relatedApiContractIds, apiIds);
    const absentEntities = missing(edge.relatedEntityIds, entityIds);
    if (absentFeatures.length) issue(issues, "DOCS_DANGLING_FEATURE_REFERENCE", `edgeCases.${edge.id}.relatedFeatureIds`, "Edge case references unknown features.", absentFeatures);
    if (absentApis.length) issue(issues, "DOCS_DANGLING_API_REFERENCE", `edgeCases.${edge.id}.relatedApiContractIds`, "Edge case references unknown APIs.", absentApis);
    if (absentEntities.length) issue(issues, "DOCS_DANGLING_ENTITY_REFERENCE", `edgeCases.${edge.id}.relatedEntityIds`, "Edge case references unknown entities.", absentEntities);
    if (edge.relatedFeatureIds.length === 0) issue(issues, "DOCS_FEATURE_EDGE_COVERAGE_REQUIRED", `edgeCases.${edge.id}.relatedFeatureIds`, "Every edge case must relate to at least one feature.", [edge.id]);
  }

  if (!draft.apiContracts.applicable) {
    const conflicting = [
      ...draft.permissionRules.items.flatMap((item) => item.relatedApiContractIds),
      ...draft.errorBehaviors.flatMap((item) => item.relatedApiContractIds),
      ...draft.edgeCases.flatMap((item) => item.relatedApiContractIds),
    ];
    if (conflicting.length || draft.errorBehaviors.some((item) => item.httpStatus !== undefined)) issue(issues, "DOCS_API_APPLICABILITY_INVALID", "apiContracts", "Non-applicable APIs cannot be referenced and cannot have HTTP statuses.", conflicting);
  }
  if (!draft.dataEntities.applicable) {
    const conflicting = [
      ...draft.apiContracts.items.flatMap((item) => item.relatedEntityIds),
      ...draft.businessRules.flatMap((item) => item.relatedEntityIds),
      ...draft.edgeCases.flatMap((item) => item.relatedEntityIds),
    ];
    if (conflicting.length) issue(issues, "DOCS_DATA_APPLICABILITY_INVALID", "dataEntities", "Non-applicable data entities cannot be referenced.", conflicting);
  }
  if (!draft.permissionRules.applicable) {
    const controlled = [
      ...draft.features.filter((item) => item.access === "controlled").map((item) => item.id),
      ...draft.apiContracts.items.filter((item) => item.access === "controlled").map((item) => item.id),
    ];
    if (controlled.length) issue(issues, "DOCS_PERMISSION_APPLICABILITY_INVALID", "permissionRules", "Permissions cannot be non-applicable while controlled features or APIs exist.", controlled);
  }

  for (const api of draft.apiContracts.items) {
    for (const errorId of api.errorBehaviorIds) {
      const behavior = draft.errorBehaviors.find((item) => item.id === errorId);
      if (behavior && !behavior.relatedApiContractIds.includes(api.id)) issue(issues, "DOCS_ERROR_API_LINK_INCONSISTENT", `apiContracts.${api.id}.errorBehaviorIds`, "API/error links must be bidirectionally exact.", [api.id, errorId]);
    }
  }
  for (const behavior of draft.errorBehaviors) {
    for (const apiId of behavior.relatedApiContractIds) {
      const api = draft.apiContracts.items.find((item) => item.id === apiId);
      if (api && !api.errorBehaviorIds.includes(behavior.id)) issue(issues, "DOCS_ERROR_API_LINK_INCONSISTENT", `errorBehaviors.${behavior.id}.relatedApiContractIds`, "API/error links must be bidirectionally exact.", [behavior.id, apiId]);
    }
  }

  const uncoveredFunctional = upstream.functionalRequirements.filter((requirement) => !draft.features.some((feature) => feature.sourceRequirementIds.includes(requirement.id))).map((item) => item.id);
  if (uncoveredFunctional.length) issue(issues, "DOCS_FUNCTIONAL_REQUIREMENT_UNCOVERED", "features", "Every functional Requirement must be covered by a feature.", uncoveredFunctional);
  const featuresWithoutErrors = draft.features.filter((feature) => !draft.errorBehaviors.some((behavior) => behavior.relatedFeatureIds.includes(feature.id))).map((item) => item.id);
  if (featuresWithoutErrors.length) issue(issues, "DOCS_FEATURE_ERROR_COVERAGE_REQUIRED", "errorBehaviors", "Every feature requires error-behavior coverage.", featuresWithoutErrors);
  const featuresWithoutEdges = draft.features.filter((feature) => !draft.edgeCases.some((edge) => edge.relatedFeatureIds.includes(feature.id))).map((item) => item.id);
  if (featuresWithoutEdges.length) issue(issues, "DOCS_FEATURE_EDGE_COVERAGE_REQUIRED", "edgeCases", "Every feature requires edge-case coverage.", featuresWithoutEdges);
  const controlledFeaturesWithoutRules = draft.features.filter((feature) => feature.access === "controlled" && !draft.permissionRules.items.some((rule) => rule.relatedFeatureIds.includes(feature.id))).map((item) => item.id);
  if (controlledFeaturesWithoutRules.length) issue(issues, "DOCS_PERMISSION_COVERAGE_REQUIRED", "permissionRules", "Every controlled feature requires a permission rule.", controlledFeaturesWithoutRules);
  const controlledApisWithoutRules = draft.apiContracts.items.filter((api) => api.access === "controlled" && !draft.permissionRules.items.some((rule) => rule.relatedApiContractIds.includes(api.id))).map((item) => item.id);
  if (controlledApisWithoutRules.length) issue(issues, "DOCS_API_PERMISSION_COVERAGE_REQUIRED", "permissionRules", "Every controlled API requires a permission rule.", controlledApisWithoutRules);
  return issues;
}

export function validateDocumentationGraph(draft: DocumentationProviderDraft, upstream: RequirementsContent): void {
  const issues = collectDocumentationGraphIssues(draft, upstream);
  if (issues.length === 0) return;
  const first = issues[0];
  const applicability = first.code.includes("APPLICABILITY") || first.code.includes("PERMISSION");
  throw new DocumentationValidationError(
    applicability ? "DOCUMENTATION_APPLICABILITY_INVALID" : "DOCUMENTATION_REFERENCE_INVALID",
    first.message,
    first.path,
    { readinessCode: first.code, itemIds: first.itemIds, issues },
  );
}

function coveringIds<T extends { id: string; sourceRequirementIds: string[] }>(items: readonly T[], requirementId: string): string[] {
  return items.filter((item) => item.sourceRequirementIds.includes(requirementId)).map((item) => item.id).sort((a, b) => a.localeCompare(b));
}

export function deriveDocumentationRequirementsTraceability(
  draftInput: DocumentationProviderDraft,
  upstreamInput: RequirementsContent,
): DocumentationRequirementTrace[] {
  const draft = normalizeDocumentationProviderDraft(draftInput);
  const upstream = parseRequirementsContent(upstreamInput);
  const make = (requirementId: string, requirementKind: "functional" | "non_functional"): DocumentationRequirementTrace => {
    const coveredByFeatureIds = coveringIds(draft.features, requirementId);
    const coveredByApiContractIds = coveringIds(draft.apiContracts.items, requirementId);
    const coveredByDataEntityIds = coveringIds(draft.dataEntities.items, requirementId);
    const coveredByBusinessRuleIds = coveringIds(draft.businessRules, requirementId);
    const covered = requirementKind === "functional"
      ? coveredByFeatureIds.length > 0
      : coveredByFeatureIds.length + coveredByApiContractIds.length + coveredByDataEntityIds.length + coveredByBusinessRuleIds.length > 0;
    return { requirementId, requirementKind, coveredByFeatureIds, coveredByApiContractIds, coveredByDataEntityIds, coveredByBusinessRuleIds, coverageStatus: covered ? "covered" : "uncovered" };
  };
  return [
    ...[...upstream.functionalRequirements].sort((a, b) => a.id.localeCompare(b.id)).map((item) => make(item.id, "functional")),
    ...[...upstream.nonFunctionalRequirements].sort((a, b) => a.id.localeCompare(b.id)).map((item) => make(item.id, "non_functional")),
  ];
}

export function assembleDocumentationContent(
  providerInput: unknown,
  sourceInput: DocumentationSourceRequirements,
  upstreamInput: RequirementsContent,
): DocumentationContent {
  const draft = normalizeDocumentationProviderDraft(parseDocumentationProviderDraft(providerInput));
  const sourceRequirements = parseDocumentationSourceRequirements(sourceInput);
  const upstream = parseRequirementsContent(upstreamInput);
  const actualHash = hashRequirementsContent(upstream);
  if (actualHash !== sourceRequirements.contentHash) {
    throw new DocumentationValidationError("DOCUMENTATION_REFERENCE_INVALID", "Supplied Requirements content does not match sourceRequirements.contentHash.", "sourceRequirements.contentHash", { expectedHash: sourceRequirements.contentHash, actualHash });
  }
  validateDocumentationGraph(draft, upstream);
  const content = parseDocumentationContent({ ...draft, requirementsTraceability: deriveDocumentationRequirementsTraceability(draft, upstream), sourceRequirements });
  const byteLength = Buffer.byteLength(canonicalJson(content), "utf8");
  if (byteLength > DOCUMENTATION_CANONICAL_JSON_MAX_BYTES) {
    throw new DocumentationValidationError("DOCUMENTATION_SIZE_EXCEEDED", "Canonical Documentation JSON exceeds the 128 KiB UTF-8 limit.", "documentation", { byteLength, maxBytes: DOCUMENTATION_CANONICAL_JSON_MAX_BYTES });
  }
  return content;
}

export function traceabilityMatches(
  content: DocumentationContent,
  upstream: RequirementsContent,
): boolean {
  const expected = deriveDocumentationRequirementsTraceability(content, upstream);
  return canonicalJson(content.requirementsTraceability) === canonicalJson(expected);
}
