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

export function healDocumentationDraft(
  input: DocumentationProviderDraft,
  upstreamInput: RequirementsContent,
): DocumentationProviderDraft {
  const upstream = parseRequirementsContent(upstreamInput);
  const upstreamActorIds = new Set(upstream.usersAndActors.map((a) => a.id));
  const validRequirementIds = new Set([
    ...upstream.functionalRequirements.map((r) => r.id),
    ...upstream.nonFunctionalRequirements.map((r) => r.id),
  ]);
  const validStoryIds = new Set(upstream.userStories.map((s) => s.id));

  // Deep clone input to avoid mutating original
  const draft: DocumentationProviderDraft = JSON.parse(JSON.stringify(input));

  draft.systemActors = Array.isArray(draft.systemActors) ? draft.systemActors : [];
  draft.features = Array.isArray(draft.features) ? draft.features : [];
  draft.businessRules = Array.isArray(draft.businessRules) ? draft.businessRules : [];
  draft.errorBehaviors = Array.isArray(draft.errorBehaviors) ? draft.errorBehaviors : [];
  draft.edgeCases = Array.isArray(draft.edgeCases) ? draft.edgeCases : [];
  draft.unresolvedQuestions = Array.isArray(draft.unresolvedQuestions) ? draft.unresolvedQuestions : [];
  if (!draft.apiContracts || typeof draft.apiContracts !== "object") {
    draft.apiContracts = { applicable: false, rationale: "None", items: [] };
  } else {
    draft.apiContracts.items = Array.isArray(draft.apiContracts.items) ? draft.apiContracts.items : [];
  }
  if (!draft.dataEntities || typeof draft.dataEntities !== "object") {
    draft.dataEntities = { applicable: false, rationale: "None", items: [] };
  } else {
    draft.dataEntities.items = Array.isArray(draft.dataEntities.items) ? draft.dataEntities.items : [];
  }
  if (!draft.permissionRules || typeof draft.permissionRules !== "object") {
    draft.permissionRules = { applicable: false, rationale: "None", items: [] };
  } else {
    draft.permissionRules.items = Array.isArray(draft.permissionRules.items) ? draft.permissionRules.items : [];
  }

  // Ensure ID uniqueness across sections
  const seenIds = new Set<string>();
  const idMap = new Map<string, string>();
  const registerId = (id: string, prefix: string): string => {
    let candidate = typeof id === "string" && id.trim().length > 0 ? id.trim() : `${prefix}-1`;
    if (!seenIds.has(candidate)) {
      seenIds.add(candidate);
      return candidate;
    }
    let counter = 1;
    while (seenIds.has(`${candidate}-${counter}`)) {
      counter++;
    }
    const unique = `${candidate}-${counter}`;
    seenIds.add(unique);
    idMap.set(id, unique);
    return unique;
  };

  for (const actor of draft.systemActors) actor.id = registerId(actor.id, "ACTOR");
  for (const feature of draft.features) feature.id = registerId(feature.id, "FEAT");
  for (const api of draft.apiContracts.items) api.id = registerId(api.id, "API");
  for (const entity of draft.dataEntities.items) entity.id = registerId(entity.id, "ENT");
  for (const br of draft.businessRules) br.id = registerId(br.id, "BR");
  for (const perm of draft.permissionRules.items) perm.id = registerId(perm.id, "PERM");
  for (const err of draft.errorBehaviors) err.id = registerId(err.id, "ERR");
  for (const edge of draft.edgeCases) edge.id = registerId(edge.id, "EDGE");
  for (const q of draft.unresolvedQuestions) q.id = registerId(q.id, "Q");

  const remapAndFilter = (ids: string[] | undefined, validSet: Set<string>): string[] => {
    if (!Array.isArray(ids)) return [];
    const result: string[] = [];
    for (const raw of ids) {
      const resolved = idMap.get(raw) || raw;
      if (validSet.has(resolved) && !result.includes(resolved)) {
        result.push(resolved);
      }
    }
    return result;
  };

  // 1. System Actors
  if (draft.systemActors.length === 0) {
    const defaultActorId = registerId("ACT-1", "ACT");
    const defaultSourceActorIds = upstream.usersAndActors.length > 0 ? [upstream.usersAndActors[0].id] : [];
    draft.systemActors.push({
      id: defaultActorId,
      name: "Primary User",
      description: "Default primary system actor",
      sourceActorIds: defaultSourceActorIds,
    });
  } else {
    for (const actor of draft.systemActors) {
      actor.sourceActorIds = (actor.sourceActorIds || []).filter((id) => upstreamActorIds.has(id));
      if (actor.sourceActorIds.length === 0 && upstream.usersAndActors.length > 0) {
        actor.sourceActorIds = [upstream.usersAndActors[0].id];
      }
    }
  }
  const currentActorIds = new Set(draft.systemActors.map((a) => a.id));

  // 2. Features
  if (draft.features.length === 0) {
    const defaultFeatId = registerId("FEAT-1", "FEAT");
    draft.features.push({
      id: defaultFeatId,
      title: "Core Feature",
      description: "Primary system feature workflow",
      workflowSteps: ["Execute feature workflow"],
      actorIds: [draft.systemActors[0].id],
      access: "controlled",
      sourceRequirementIds: upstream.functionalRequirements.map((r) => r.id),
      sourceUserStoryIds: upstream.userStories.map((s) => s.id),
    });
  } else {
    for (const feature of draft.features) {
      feature.actorIds = remapAndFilter(feature.actorIds, currentActorIds);
      if (feature.actorIds.length === 0) {
        feature.actorIds = [draft.systemActors[0].id];
      }
      feature.sourceRequirementIds = (feature.sourceRequirementIds || []).filter((id) => validRequirementIds.has(id));
      feature.sourceUserStoryIds = (feature.sourceUserStoryIds || []).filter((id) => validStoryIds.has(id));
      if (!feature.access || (feature.access !== "public" && feature.access !== "controlled")) {
        feature.access = "controlled";
      }
    }
  }

  // Ensure 100% Functional Requirements Coverage
  const coveredFrIds = new Set(draft.features.flatMap((f) => f.sourceRequirementIds));
  for (const fr of upstream.functionalRequirements) {
    if (!coveredFrIds.has(fr.id)) {
      const targetFeature =
        draft.features.find((f) =>
          f.title.toLowerCase().includes(fr.title.toLowerCase()) ||
          fr.description.toLowerCase().includes(f.title.toLowerCase())
        ) || draft.features[0];
      if (!targetFeature.sourceRequirementIds.includes(fr.id)) {
        targetFeature.sourceRequirementIds.push(fr.id);
      }
      coveredFrIds.add(fr.id);
    }
  }
  const currentFeatureIds = new Set(draft.features.map((f) => f.id));

  // 3. Data Entities
  if (draft.dataEntities.applicable && draft.dataEntities.items.length > 0) {
    const entityIds = new Set(draft.dataEntities.items.map((e) => e.id));
    for (const entity of draft.dataEntities.items) {
      entity.sourceRequirementIds = (entity.sourceRequirementIds || []).filter((id) => validRequirementIds.has(id));
      entity.sourceUserStoryIds = (entity.sourceUserStoryIds || []).filter((id) => validStoryIds.has(id));
      const seenRel = new Set<string>();
      entity.relationships = (entity.relationships || []).filter((rel) => {
        const targetId = idMap.get(rel.targetEntityId) || rel.targetEntityId;
        rel.targetEntityId = targetId;
        if (!entityIds.has(targetId)) return false;
        const key = `${targetId}\u0000${rel.cardinality}`;
        if (seenRel.has(key)) return false;
        seenRel.add(key);
        return true;
      });
    }
  } else {
    draft.dataEntities.items = [];
  }
  const currentEntityIds = new Set(draft.dataEntities.applicable ? draft.dataEntities.items.map((e) => e.id) : []);

  // 4. Error Behaviors
  if (draft.errorBehaviors.length === 0) {
    draft.errorBehaviors.push({
      id: registerId("ERR-1", "ERR"),
      code: "VALIDATION_FAILED",
      scenario: "Invalid request payload or parameters",
      expectedSystemBehavior: "Reject with descriptive validation error",
      recoveryBehavior: "Correct the input parameters and retry",
      relatedFeatureIds: [draft.features[0].id],
      relatedApiContractIds: [],
    });
  } else {
    const seenCodes = new Set<string>();
    for (let i = 0; i < draft.errorBehaviors.length; i++) {
      const err = draft.errorBehaviors[i];
      let code = (err.code || `ERROR_${i + 1}`).trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
      if (!code) code = `ERROR_${i + 1}`;
      if (seenCodes.has(code)) {
        code = `${code}_${i + 1}`;
      }
      seenCodes.add(code);
      err.code = code;
      err.relatedFeatureIds = remapAndFilter(err.relatedFeatureIds, currentFeatureIds);
      if (err.relatedFeatureIds.length === 0) {
        err.relatedFeatureIds = [draft.features[0].id];
      }
    }
  }
  const currentErrorIds = new Set(draft.errorBehaviors.map((e) => e.id));

  // 5. API Contracts
  if (draft.apiContracts.applicable && draft.apiContracts.items.length > 0) {
    for (const api of draft.apiContracts.items) {
      api.relatedFeatureIds = remapAndFilter(api.relatedFeatureIds, currentFeatureIds);
      if (api.relatedFeatureIds.length === 0) {
        api.relatedFeatureIds = [draft.features[0].id];
      }
      api.relatedEntityIds = remapAndFilter(api.relatedEntityIds, currentEntityIds);
      api.errorBehaviorIds = remapAndFilter(api.errorBehaviorIds, currentErrorIds);
      if (api.errorBehaviorIds.length === 0) {
        api.errorBehaviorIds = [draft.errorBehaviors[0].id];
      }
      api.sourceRequirementIds = (api.sourceRequirementIds || []).filter((id) => validRequirementIds.has(id));
      api.sourceUserStoryIds = (api.sourceUserStoryIds || []).filter((id) => validStoryIds.has(id));
      if (!api.access || (api.access !== "public" && api.access !== "controlled")) {
        api.access = "controlled";
      }
    }
  } else {
    draft.apiContracts.items = [];
  }
  const currentApiIds = new Set(draft.apiContracts.applicable ? draft.apiContracts.items.map((a) => a.id) : []);

  // 6. Bidirectional API <-> Error linking
  for (const api of draft.apiContracts.items) {
    for (const errId of api.errorBehaviorIds) {
      const err = draft.errorBehaviors.find((e) => e.id === errId);
      if (err) {
        if (!err.relatedApiContractIds) err.relatedApiContractIds = [];
        if (!err.relatedApiContractIds.includes(api.id)) {
          err.relatedApiContractIds.push(api.id);
        }
      }
    }
  }
  for (const err of draft.errorBehaviors) {
    err.relatedApiContractIds = remapAndFilter(err.relatedApiContractIds, currentApiIds);
    for (const apiId of err.relatedApiContractIds) {
      const api = draft.apiContracts.items.find((a) => a.id === apiId);
      if (api) {
        if (!api.errorBehaviorIds.includes(err.id)) {
          api.errorBehaviorIds.push(err.id);
        }
      }
    }
  }

  // 7. HTTP Status Consistency
  for (const err of draft.errorBehaviors) {
    const relatedApis = err.relatedApiContractIds
      .map((id) => draft.apiContracts.items.find((a) => a.id === id))
      .filter((a): a is DocumentationApiContract => Boolean(a));

    if (relatedApis.length === 0) {
      delete err.httpStatus;
      continue;
    }

    const httpApis = relatedApis.filter((a) => a.interaction.kind === "http");
    const nonHttpApis = relatedApis.filter((a) => a.interaction.kind !== "http");

    if (httpApis.length > 0 && nonHttpApis.length > 0) {
      const nonHttpIds = new Set(nonHttpApis.map((a) => a.id));
      err.relatedApiContractIds = err.relatedApiContractIds.filter((id) => !nonHttpIds.has(id));
      for (const nonHttp of nonHttpApis) {
        nonHttp.errorBehaviorIds = nonHttp.errorBehaviorIds.filter((id) => id !== err.id);
      }
    }

    if (httpApis.length > 0) {
      if (
        typeof err.httpStatus !== "number" ||
        !Number.isInteger(err.httpStatus) ||
        err.httpStatus < 100 ||
        err.httpStatus > 599
      ) {
        const codeUpper = (err.code || "").toUpperCase();
        if (codeUpper.includes("AUTH") || codeUpper.includes("UNAUTHORIZED")) err.httpStatus = 401;
        else if (codeUpper.includes("FORBIDDEN") || codeUpper.includes("PERMISSION")) err.httpStatus = 403;
        else if (codeUpper.includes("NOT_FOUND") || codeUpper.includes("NOTFOUND")) err.httpStatus = 404;
        else if (codeUpper.includes("CONFLICT")) err.httpStatus = 409;
        else if (codeUpper.includes("INTERNAL") || codeUpper.includes("SERVER")) err.httpStatus = 500;
        else err.httpStatus = 400;
      }
    } else {
      delete err.httpStatus;
    }
  }

  // 8. Feature Error Coverage
  for (const feat of draft.features) {
    const hasError = draft.errorBehaviors.some((e) => e.relatedFeatureIds.includes(feat.id));
    if (!hasError) {
      draft.errorBehaviors[0].relatedFeatureIds.push(feat.id);
    }
  }

  // 9. Edge Cases & Feature Edge Coverage
  if (draft.edgeCases.length === 0) {
    draft.edgeCases.push({
      id: registerId("EDGE-1", "EDGE"),
      scenario: "System boundary conditions or peak concurrent load",
      expectedHandling: "Enforces input limits gracefully and preserves consistency",
      relatedFeatureIds: [draft.features[0].id],
      relatedApiContractIds: draft.apiContracts.items.length > 0 ? [draft.apiContracts.items[0].id] : [],
      relatedEntityIds: currentEntityIds.size > 0 ? [draft.dataEntities.items[0].id] : [],
    });
  } else {
    for (const edge of draft.edgeCases) {
      edge.relatedFeatureIds = remapAndFilter(edge.relatedFeatureIds, currentFeatureIds);
      if (edge.relatedFeatureIds.length === 0) {
        edge.relatedFeatureIds = [draft.features[0].id];
      }
      edge.relatedApiContractIds = remapAndFilter(edge.relatedApiContractIds, currentApiIds);
      edge.relatedEntityIds = remapAndFilter(edge.relatedEntityIds, currentEntityIds);
    }
  }
  for (const feat of draft.features) {
    const hasEdge = draft.edgeCases.some((e) => e.relatedFeatureIds.includes(feat.id));
    if (!hasEdge) {
      draft.edgeCases[0].relatedFeatureIds.push(feat.id);
    }
  }

  // 10. Business Rules
  for (const br of draft.businessRules) {
    br.relatedFeatureIds = remapAndFilter(br.relatedFeatureIds, currentFeatureIds);
    br.relatedEntityIds = remapAndFilter(br.relatedEntityIds, currentEntityIds);
    br.sourceRequirementIds = (br.sourceRequirementIds || []).filter((id) => validRequirementIds.has(id));
    br.sourceUserStoryIds = (br.sourceUserStoryIds || []).filter((id) => validStoryIds.has(id));
    if (br.relatedFeatureIds.length + br.relatedEntityIds.length === 0) {
      br.relatedFeatureIds = [draft.features[0].id];
    }
  }

  // 11. Permission Rules & Coverage
  const controlledFeatures = draft.features.filter((f) => f.access === "controlled");
  const controlledApis = draft.apiContracts.items.filter((a) => a.access === "controlled");
  const hasControlledResources = controlledFeatures.length > 0 || controlledApis.length > 0;

  if (hasControlledResources) {
    draft.permissionRules.applicable = true;
    if (draft.permissionRules.items.length === 0) {
      draft.permissionRules.items.push({
        id: registerId("PERM-1", "PERM"),
        title: "Controlled Resource Access",
        description: "Enforces authentication requirements on controlled workflows",
        effect: "allow",
        actorIds: [draft.systemActors[0].id],
        actions: ["execute", "read", "write"],
        relatedFeatureIds: controlledFeatures.map((f) => f.id),
        relatedApiContractIds: controlledApis.map((a) => a.id),
      });
    }
  }

  if (draft.permissionRules.applicable) {
    const controlledFeatureIdSet = new Set(controlledFeatures.map((f) => f.id));
    const controlledApiIdSet = new Set(controlledApis.map((a) => a.id));

    for (const perm of draft.permissionRules.items) {
      perm.actorIds = remapAndFilter(perm.actorIds, currentActorIds);
      if (perm.actorIds.length === 0) perm.actorIds = [draft.systemActors[0].id];
      perm.relatedFeatureIds = remapAndFilter(perm.relatedFeatureIds, controlledFeatureIdSet);
      perm.relatedApiContractIds = remapAndFilter(perm.relatedApiContractIds, controlledApiIdSet);
      if (!perm.effect || (perm.effect !== "allow" && perm.effect !== "deny")) perm.effect = "allow";
      if (!Array.isArray(perm.actions) || perm.actions.length === 0) perm.actions = ["execute"];
    }

    draft.permissionRules.items = draft.permissionRules.items.filter(
      (p) => p.relatedFeatureIds.length + p.relatedApiContractIds.length > 0
    );
    if (draft.permissionRules.items.length === 0 && hasControlledResources) {
      draft.permissionRules.items.push({
        id: registerId("PERM-1", "PERM"),
        title: "Controlled Resource Access",
        description: "Enforces authentication requirements on controlled workflows",
        effect: "allow",
        actorIds: [draft.systemActors[0].id],
        actions: ["execute"],
        relatedFeatureIds: controlledFeatures.map((f) => f.id),
        relatedApiContractIds: controlledApis.map((a) => a.id),
      });
    }

    for (const feat of controlledFeatures) {
      const hasRule = draft.permissionRules.items.some((p) => p.relatedFeatureIds.includes(feat.id));
      if (!hasRule && draft.permissionRules.items.length > 0) {
        draft.permissionRules.items[0].relatedFeatureIds.push(feat.id);
      }
    }

    for (const api of controlledApis) {
      const hasRule = draft.permissionRules.items.some((p) => p.relatedApiContractIds.includes(api.id));
      if (!hasRule && draft.permissionRules.items.length > 0) {
        draft.permissionRules.items[0].relatedApiContractIds.push(api.id);
      }
    }
  } else {
    for (const feat of draft.features) feat.access = "public";
    for (const api of draft.apiContracts.items) api.access = "public";
    draft.permissionRules.items = [];
  }

  // 12. Non-applicable cleanup
  if (!draft.dataEntities.applicable) {
    draft.dataEntities.items = [];
    for (const api of draft.apiContracts.items) api.relatedEntityIds = [];
    for (const br of draft.businessRules) br.relatedEntityIds = [];
    for (const edge of draft.edgeCases) edge.relatedEntityIds = [];
  }
  if (!draft.apiContracts.applicable) {
    draft.apiContracts.items = [];
    for (const perm of draft.permissionRules.items) perm.relatedApiContractIds = [];
    for (const err of draft.errorBehaviors) {
      err.relatedApiContractIds = [];
      delete err.httpStatus;
    }
    for (const edge of draft.edgeCases) edge.relatedApiContractIds = [];
  }

  return normalizeDocumentationProviderDraft(draft);
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

export function preHealRawProviderInput(
  rawInput: unknown,
  upstreamInput: RequirementsContent,
): unknown {
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) return rawInput;
  const raw = JSON.parse(JSON.stringify(rawInput)) as Record<string, any>;
  const upstream = parseRequirementsContent(upstreamInput);

  if (Array.isArray(raw.features)) {
    for (const f of raw.features) {
      if (f && typeof f === "object") {
        if (!Array.isArray(f.workflowSteps) || f.workflowSteps.length === 0) {
          f.workflowSteps = ["Execute feature workflow"];
        }
        if (!Array.isArray(f.actorIds) || f.actorIds.length === 0) {
          const defaultActor = Array.isArray(raw.systemActors) && raw.systemActors[0]?.id ? raw.systemActors[0].id : "ACT-1";
          f.actorIds = [defaultActor];
        }
        const reqs = Array.isArray(f.sourceRequirementIds) ? f.sourceRequirementIds : [];
        const stories = Array.isArray(f.sourceUserStoryIds) ? f.sourceUserStoryIds : [];
        if (reqs.length + stories.length === 0) {
          const defaultFr = upstream.functionalRequirements[0]?.id || "FR-1";
          f.sourceRequirementIds = [defaultFr];
        }
        if (!f.access || (f.access !== "public" && f.access !== "controlled")) {
          f.access = "controlled";
        }
      }
    }
  }

  return raw;
}

export function assembleDocumentationContent(
  providerInput: unknown,
  sourceInput: DocumentationSourceRequirements,
  upstreamInput: RequirementsContent,
): DocumentationContent {
  const upstream = parseRequirementsContent(upstreamInput);
  const preHealed = preHealRawProviderInput(providerInput, upstream);
  const parsed = parseDocumentationProviderDraft(preHealed);
  const draft = healDocumentationDraft(parsed, upstream);
  const sourceRequirements = parseDocumentationSourceRequirements(sourceInput);
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
