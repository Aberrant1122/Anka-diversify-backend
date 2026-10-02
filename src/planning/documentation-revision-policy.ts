import { canonicalJson } from "./requirements-context";
import {
  DOCUMENTATION_PROVIDER_ROOT_FIELDS,
  DocumentationContent,
  DocumentationProviderDraft,
  DocumentationProviderRoot,
  DocumentationValidationError,
} from "./documentation-schema";

export const DOCUMENTATION_REVISION_OPERATIONS = Object.freeze([
  "DOCUMENT_REVISION",
  "FEEDBACK_APPLICATION",
  "SECTION_REVISION",
  "SECTION_REGENERATION",
] as const);

export type DocumentationRevisionOperation = (typeof DOCUMENTATION_REVISION_OPERATIONS)[number];

export const DOCUMENTATION_SECTION_DEPENDENCY_CLOSURE = Object.freeze({
  overview: ["overview"] as const,
  systemActors: ["systemActors", "features", "permissionRules"] as const,
  features: ["features", "apiContracts", "businessRules", "permissionRules", "errorBehaviors", "edgeCases"] as const,
  apiContracts: ["apiContracts", "dataEntities", "permissionRules", "errorBehaviors", "edgeCases"] as const,
  dataEntities: ["dataEntities", "apiContracts", "businessRules", "edgeCases"] as const,
  businessRules: ["businessRules", "features", "errorBehaviors", "edgeCases"] as const,
  permissionRules: ["permissionRules", "features", "apiContracts", "errorBehaviors"] as const,
  errorBehaviors: ["errorBehaviors", "apiContracts"] as const,
  edgeCases: ["edgeCases"] as const,
  unresolvedQuestions: ["unresolvedQuestions"] as const,
}) satisfies Readonly<Record<DocumentationProviderRoot, readonly DocumentationProviderRoot[]>>;

export interface ValidatedDocumentationRevisionTarget {
  targetSectionKey: DocumentationProviderRoot | null;
  allowedSectionKeys: readonly DocumentationProviderRoot[] | null;
}

export interface DocumentationDeterministicDiff {
  changedRootSections: DocumentationProviderRoot[];
  addedIds: string[];
  removedIds: string[];
  retainedIds: string[];
  modifiedIds: string[];
}

interface ItemEntry {
  id: string;
  section: DocumentationProviderRoot;
  payloadJson: string;
}

const DOCUMENTATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function providerProjection(content: DocumentationProviderDraft | DocumentationContent): DocumentationProviderDraft {
  return {
    overview: content.overview,
    systemActors: content.systemActors,
    features: content.features,
    apiContracts: content.apiContracts,
    dataEntities: content.dataEntities,
    businessRules: content.businessRules,
    permissionRules: content.permissionRules,
    errorBehaviors: content.errorBehaviors,
    edgeCases: content.edgeCases,
    unresolvedQuestions: content.unresolvedQuestions,
  };
}

function payload(item: { id: string }): string {
  const record = { ...item } as Record<string, unknown>;
  delete record.id;
  return canonicalJson(record);
}

function entries(content: DocumentationProviderDraft | DocumentationContent): Map<string, ItemEntry> {
  const draft = providerProjection(content);
  const sectionItems: Array<[DocumentationProviderRoot, Array<{ id: string }>]> = [
    ["systemActors", draft.systemActors],
    ["features", draft.features],
    ["apiContracts", draft.apiContracts.items],
    ["dataEntities", draft.dataEntities.items],
    ["businessRules", draft.businessRules],
    ["permissionRules", draft.permissionRules.items],
    ["errorBehaviors", draft.errorBehaviors],
    ["edgeCases", draft.edgeCases],
    ["unresolvedQuestions", draft.unresolvedQuestions],
  ];
  const result = new Map<string, ItemEntry>();
  for (const [section, items] of sectionItems) {
    for (const item of items) {
      if (!DOCUMENTATION_ID_PATTERN.test(item.id)) {
        throw new DocumentationValidationError("DOCUMENTATION_STABLE_ID_INVALID", `Documentation ID '${item.id}' does not use the stable-ID syntax.`, section, { id: item.id, section });
      }
      const previous = result.get(item.id);
      if (previous) {
        throw new DocumentationValidationError("DOCUMENTATION_STABLE_ID_INVALID", `Documentation ID '${item.id}' is duplicated across '${previous.section}' and '${section}'.`, section, { id: item.id, previousSection: previous.section, section });
      }
      result.set(item.id, { id: item.id, section, payloadJson: payload(item) });
    }
  }
  return result;
}

export function validateDocumentationRevisionOperation(operation: string): asserts operation is DocumentationRevisionOperation {
  if (!DOCUMENTATION_REVISION_OPERATIONS.includes(operation as DocumentationRevisionOperation)) {
    throw new DocumentationValidationError("DOCUMENTATION_SECTION_SCOPE_INVALID", `Unsupported Documentation revision operation '${operation}'.`, "operation", { operation, allowed: DOCUMENTATION_REVISION_OPERATIONS });
  }
}

export function validateDocumentationRevisionTarget(
  operation: string,
  targetSectionKey: unknown,
): ValidatedDocumentationRevisionTarget {
  validateDocumentationRevisionOperation(operation);
  const sectionOperation = operation === "SECTION_REVISION" || operation === "SECTION_REGENERATION";
  if (!sectionOperation) {
    if (targetSectionKey !== undefined && targetSectionKey !== null) {
      throw new DocumentationValidationError("DOCUMENTATION_SECTION_SCOPE_INVALID", "targetSectionKey must be absent for whole-document Documentation revisions.", "targetSectionKey");
    }
    return { targetSectionKey: null, allowedSectionKeys: null };
  }
  const target = typeof targetSectionKey === "string" ? targetSectionKey.trim() : "";
  if (!DOCUMENTATION_PROVIDER_ROOT_FIELDS.includes(target as DocumentationProviderRoot)) {
    throw new DocumentationValidationError("DOCUMENTATION_SECTION_SCOPE_INVALID", "targetSectionKey must identify a provider-owned Documentation root.", "targetSectionKey", { allowedSections: DOCUMENTATION_PROVIDER_ROOT_FIELDS });
  }
  const key = target as DocumentationProviderRoot;
  return { targetSectionKey: key, allowedSectionKeys: DOCUMENTATION_SECTION_DEPENDENCY_CLOSURE[key] };
}

export function validateDocumentationSectionScope(
  targetSectionKey: DocumentationProviderRoot,
  allowedSectionKeys: readonly DocumentationProviderRoot[],
  changedRootSections: readonly DocumentationProviderRoot[],
): void {
  const allowed = new Set<DocumentationProviderRoot>(allowedSectionKeys);
  const forbidden = changedRootSections.filter((section) => !allowed.has(section));
  if (forbidden.length > 0) {
    throw new DocumentationValidationError("DOCUMENTATION_SECTION_SCOPE_INVALID", "Documentation section operation changed roots outside its dependency closure.", targetSectionKey, { targetSectionKey, allowedSections: [...allowedSectionKeys], changedSections: [...changedRootSections] });
  }
}

export function isNoOpDocumentationRevision(
  base: DocumentationProviderDraft | DocumentationContent,
  successor: DocumentationProviderDraft | DocumentationContent,
): boolean {
  return canonicalJson(providerProjection(base)) === canonicalJson(providerProjection(successor));
}

export function validateDocumentationRevisionStableIds(
  base: DocumentationProviderDraft | DocumentationContent,
  successor: DocumentationProviderDraft | DocumentationContent,
): void {
  const baseEntries = entries(base);
  const successorEntries = entries(successor);
  for (const [id, next] of successorEntries) {
    const previous = baseEntries.get(id);
    if (previous && previous.section !== next.section) {
      throw new DocumentationValidationError("DOCUMENTATION_STABLE_ID_INVALID", `Documentation ID '${id}' cannot move from '${previous.section}' to '${next.section}'.`, next.section, { id, fromSection: previous.section, toSection: next.section });
    }
  }
  for (const [oldId, previous] of baseEntries) {
    if (successorEntries.has(oldId)) continue;
    for (const [newId, next] of successorEntries) {
      if (!baseEntries.has(newId) && previous.section === next.section && previous.payloadJson === next.payloadJson) {
        throw new DocumentationValidationError("DOCUMENTATION_STABLE_ID_INVALID", `Unchanged Documentation item churned ID from '${oldId}' to '${newId}'.`, next.section, { previousId: oldId, newId, section: next.section });
      }
    }
  }
}

export function computeDocumentationDiff(
  base: DocumentationProviderDraft | DocumentationContent,
  successor: DocumentationProviderDraft | DocumentationContent,
): DocumentationDeterministicDiff {
  const previous = providerProjection(base);
  const next = providerProjection(successor);
  const changedRootSections = DOCUMENTATION_PROVIDER_ROOT_FIELDS.filter((field) => canonicalJson(previous[field]) !== canonicalJson(next[field]));
  const baseEntries = entries(previous);
  const successorEntries = entries(next);
  const addedIds: string[] = [];
  const removedIds: string[] = [];
  const retainedIds: string[] = [];
  const modifiedIds: string[] = [];
  for (const [id, item] of successorEntries) {
    const baseItem = baseEntries.get(id);
    if (!baseItem) addedIds.push(id);
    else if (baseItem.payloadJson === item.payloadJson) retainedIds.push(id);
    else modifiedIds.push(id);
  }
  for (const id of baseEntries.keys()) if (!successorEntries.has(id)) removedIds.push(id);
  return {
    changedRootSections: [...changedRootSections],
    addedIds: addedIds.sort(),
    removedIds: removedIds.sort(),
    retainedIds: retainedIds.sort(),
    modifiedIds: modifiedIds.sort(),
  };
}
