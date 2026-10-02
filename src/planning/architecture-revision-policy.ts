import { ArchitectureAuthoredDraft, ArchitectureContent, ArchitectureValidationError } from "./architecture-schema";
import { canonicalJson } from "./requirements-context";

export type ArchitectureRevisionOperation = "DOCUMENT_REVISION" | "FEEDBACK_APPLICATION";
export interface ComponentRetirement { retiredComponentId: string; replacementComponentId: string | null }
export type ArchitectureIdentitySection = "components" | "dataDesign" | "interfaceDesign" | "integrationDesign" | "unresolvedQuestions";
export interface IdentityRetirement { section: ArchitectureIdentitySection; retiredId: string; replacementId: string | null }
const COMPONENT_ID = /^ARCH-COMP-[A-Z0-9]+(?:-[A-Z0-9]+)*$/;
const ID_PATTERNS: Record<ArchitectureIdentitySection, RegExp> = {
  components: COMPONENT_ID,
  dataDesign: /^ARCH-DATA-[A-Z0-9]+(?:-[A-Z0-9]+)*$/,
  interfaceDesign: /^ARCH-IFACE-[A-Z0-9]+(?:-[A-Z0-9]+)*$/,
  integrationDesign: /^ARCH-INT-[A-Z0-9]+(?:-[A-Z0-9]+)*$/,
  unresolvedQuestions: /^ARCH-Q-[A-Z0-9]+(?:-[A-Z0-9]+)*$/,
};
export function normalizeIdentityRetirements(value: unknown): IdentityRetirement[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64) throw new ArchitectureValidationError("identityRetirements must be an array of at most 64 declarations.", "identityRetirements");
  const retired = new Set<string>(), replacements = new Set<string>();
  return value.map((raw, index) => {
    const path = `identityRetirements.${index}`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ArchitectureValidationError("Invalid identity retirement declaration.", path);
    const item = raw as Record<string, unknown>;
    const section = item.section;
    if (Object.keys(item).length !== 3 || !Object.prototype.hasOwnProperty.call(item, "section") ||
        !Object.prototype.hasOwnProperty.call(item, "retiredId") || !Object.prototype.hasOwnProperty.call(item, "replacementId") ||
        typeof section !== "string" || !Object.prototype.hasOwnProperty.call(ID_PATTERNS, section) ||
        typeof item.retiredId !== "string" || !ID_PATTERNS[section as ArchitectureIdentitySection].test(item.retiredId) ||
        (item.replacementId !== null && (typeof item.replacementId !== "string" || !ID_PATTERNS[section as ArchitectureIdentitySection].test(item.replacementId))) ||
        item.retiredId === item.replacementId)
      throw new ArchitectureValidationError("Invalid identity retirement declaration.", path);
    const retiredKey = `${section}:${item.retiredId}`;
    const replacementKey = item.replacementId === null ? null : `${section}:${item.replacementId}`;
    if (retired.has(retiredKey) || (replacementKey && replacements.has(replacementKey)))
      throw new ArchitectureValidationError("Duplicate or conflicting identity retirement declaration.", path);
    retired.add(retiredKey);
    if (replacementKey) replacements.add(replacementKey);
    return { section: section as ArchitectureIdentitySection, retiredId: item.retiredId, replacementId: item.replacementId as string | null };
  }).sort((a, b) => a.section.localeCompare(b.section) || a.retiredId.localeCompare(b.retiredId));
}
export function normalizeComponentRetirements(value: unknown): ComponentRetirement[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64) throw new ArchitectureValidationError("componentRetirements must be an array of at most 64 declarations.", "componentRetirements");
  const seen = new Set<string>();
  const replacements = new Set<string>();
  return value.map((raw, index) => {
    const path = `componentRetirements.${index}`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ArchitectureValidationError("Invalid component retirement declaration.", path);
    const item = raw as Record<string, unknown>;
    if (Object.keys(item).length !== 2 || !Object.prototype.hasOwnProperty.call(item, "retiredComponentId") || !Object.prototype.hasOwnProperty.call(item, "replacementComponentId") ||
        typeof item.retiredComponentId !== "string" || !COMPONENT_ID.test(item.retiredComponentId) ||
        (item.replacementComponentId !== null && (typeof item.replacementComponentId !== "string" || !COMPONENT_ID.test(item.replacementComponentId))) ||
        item.retiredComponentId === item.replacementComponentId || seen.has(item.retiredComponentId) ||
        (typeof item.replacementComponentId === "string" && replacements.has(item.replacementComponentId)))
      throw new ArchitectureValidationError("Invalid or duplicate component retirement declaration.", path);
    seen.add(item.retiredComponentId);
    if (typeof item.replacementComponentId === "string") replacements.add(item.replacementComponentId);
    return { retiredComponentId: item.retiredComponentId, replacementComponentId: item.replacementComponentId as string | null };
  }).sort((a, b) => a.retiredComponentId.localeCompare(b.retiredComponentId));
}
function allRetirements(components: ComponentRetirement[], identities: IdentityRetirement[]): IdentityRetirement[] {
  const combined = [
    ...components.map((item) => ({ section: "components" as const, retiredId: item.retiredComponentId, replacementId: item.replacementComponentId })),
    ...identities,
  ];
  return normalizeIdentityRetirements(combined);
}
function sectionItems(content: ArchitectureContent, section: ArchitectureIdentitySection): Array<{ id: string }> {
  return section === "components" || section === "unresolvedQuestions" ? content[section] : content[section].items;
}
export function validateIdentityRetirementBase(base: ArchitectureContent, components: ComponentRetirement[], identities: IdentityRetirement[]): void {
  for (const item of allRetirements(components, identities)) {
    const ids = new Set(sectionItems(base, item.section).map((entry) => entry.id));
    if (!ids.has(item.retiredId) || (item.replacementId !== null && ids.has(item.replacementId)))
      throw new ArchitectureValidationError("Identity retirement does not match the accepted base.", "identityRetirements");
  }
}
export const ARCHITECTURE_REVISION_OPERATIONS: readonly ArchitectureRevisionOperation[] = ["DOCUMENT_REVISION", "FEEDBACK_APPLICATION"];
export const ARCHITECTURE_AUTHORED_ROOTS = ["overview", "components", "dataDesign", "interfaceDesign", "integrationDesign", "crossCuttingDesign", "implementationSequence", "unresolvedQuestions"] as const;
export interface ArchitectureDeterministicDiff {
  changedRootSections: string[];
  addedIds: string[];
  removedIds: string[];
  retainedIds: string[];
  modifiedIds: string[];
  provenanceChanged: boolean;
}
type Identified = { id: string };
function entries(content: ArchitectureAuthoredDraft | ArchitectureContent): Map<string, { section: string; payload: string }> {
  const sections: Array<[string, Identified[]]> = [
    ["components", content.components], ["dataDesign", content.dataDesign.items],
    ["interfaceDesign", content.interfaceDesign.items], ["integrationDesign", content.integrationDesign.items],
    ["unresolvedQuestions", content.unresolvedQuestions],
  ];
  const result = new Map<string, { section: string; payload: string }>();
  for (const [section, items] of sections) for (const item of items) {
    if (result.has(item.id)) throw new ArchitectureValidationError("Stable ID is duplicated across Architecture sections.", section);
    const { id: _id, ...body } = item;
    result.set(item.id, { section, payload: canonicalJson(body) });
  }
  return result;
}
export function computeArchitectureDiff(base: ArchitectureContent, next: ArchitectureContent): ArchitectureDeterministicDiff {
  const previous = entries(base), successor = entries(next);
  const addedIds: string[] = [], removedIds: string[] = [], retainedIds: string[] = [], modifiedIds: string[] = [];
  for (const [id, item] of successor) {
    const old = previous.get(id);
    if (!old) addedIds.push(id);
    else if (old.section === item.section && old.payload === item.payload) retainedIds.push(id);
    else modifiedIds.push(id);
  }
  for (const id of previous.keys()) if (!successor.has(id)) removedIds.push(id);
  return {
    changedRootSections: ARCHITECTURE_AUTHORED_ROOTS.filter((key) => canonicalJson(base[key]) !== canonicalJson(next[key])),
    addedIds: addedIds.sort(), removedIds: removedIds.sort(), retainedIds: retainedIds.sort(), modifiedIds: modifiedIds.sort(),
    provenanceChanged: canonicalJson(base.sourceRequirements) !== canonicalJson(next.sourceRequirements) ||
      canonicalJson(base.sourceDocumentation) !== canonicalJson(next.sourceDocumentation),
  };
}
export function validateArchitectureRevisionStableIds(base: ArchitectureContent, next: ArchitectureContent,
  componentDeclarations: ComponentRetirement[] = [], identityDeclarations: IdentityRetirement[] = []): void {
  const components = normalizeComponentRetirements(componentDeclarations);
  const identities = normalizeIdentityRetirements(identityDeclarations);
  const retirements = allRetirements(components, identities);
  validateIdentityRetirementBase(base, components, identities);
  const declared = new Map(retirements.map((item) => [`${item.section}:${item.retiredId}`, item.replacementId]));
  for (const section of Object.keys(ID_PATTERNS) as ArchitectureIdentitySection[]) {
    const nextIds = new Set(sectionItems(next, section).map((item) => item.id));
    for (const item of sectionItems(base, section)) {
      if (!nextIds.has(item.id) && !declared.has(`${section}:${item.id}`))
        throw new ArchitectureValidationError("Architecture ID removal requires editor-authorized retirement.", section);
    }
    for (const item of retirements.filter((entry) => entry.section === section)) {
      if (nextIds.has(item.retiredId) || (item.replacementId !== null && !nextIds.has(item.replacementId)))
        throw new ArchitectureValidationError("Unused or inconsistent identity retirement declaration.", section);
    }
  }
  for (const item of base.dataDesign.items) {
    const retained = next.dataDesign.items.find((entry) => entry.id === item.id);
    if (retained && retained.documentationEntityId !== item.documentationEntityId)
      throw new ArchitectureValidationError("Retained data design changed its Documentation anchor.", "dataDesign");
  }
  for (const item of base.interfaceDesign.items) {
    const retained = next.interfaceDesign.items.find((entry) => entry.id === item.id);
    if (retained && retained.documentationApiId !== item.documentationApiId)
      throw new ArchitectureValidationError("Retained interface design changed its Documentation anchor.", "interfaceDesign");
  }
  const previous = entries(base), successor = entries(next);
  for (const [id, item] of successor) {
    const old = previous.get(id);
    if (old && old.section !== item.section) throw new ArchitectureValidationError("Stable ID moved between Architecture sections.", item.section);
  }
  for (const [oldId, old] of previous) {
    if (successor.has(oldId)) continue;
    if (declared.has(`${old.section}:${oldId}`)) continue;
    for (const [newId, item] of successor) if (!previous.has(newId) && old.section === item.section && old.payload === item.payload)
      throw new ArchitectureValidationError("Unchanged Architecture item changed its stable ID.", item.section);
  }
}
