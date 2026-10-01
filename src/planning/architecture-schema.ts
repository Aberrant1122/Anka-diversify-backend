import crypto from "crypto";
import { canonicalJson } from "./requirements-context";

export const ARCHITECTURE_SCHEMA_VERSION = 1;
export const ARCHITECTURE_ARTIFACT_TYPE = "architecture_doc" as const;
export const ARCHITECTURE_CANONICAL_JSON_MAX_BYTES = 128 * 1024;

export interface ArchitectureSource { artifactId: string; version: number; contentHash: string }
export interface ArchitectureComponent {
  id: string; name: string; responsibility: string; boundary: string;
  dependencyIds: string[]; documentationFeatureIds: string[]; designNotes: string;
}
export interface ArchitectureDataDesign {
  id: string; documentationEntityId: string; componentId: string;
  persistence: string; lifecycle: string; consistency: string;
}
export interface ArchitectureInterfaceDesign {
  id: string; documentationApiId: string; componentId: string;
  boundary: string; enforcement: string; transport: string;
}
export interface ArchitectureIntegrationDesign {
  id: string; componentId: string; requirementIntegrationIds: string[]; externalBoundary: string;
  failureStrategy: string; credentialOwner: "project_owner" | "platform_operator" | "external_operator"; reliability: string;
}
export interface ArchitectureSection<T> { applicable: boolean; rationale: string; items: T[] }
export interface ArchitectureNfrTreatment { requirementId: string; treatment: string }
export interface ArchitectureQuestion { id: string; question: string; blocksDecision: boolean }
export interface ArchitectureTraceability {
  features: { documentationId: string; componentIds: string[] }[];
  interfaces: { documentationId: string; designIds: string[] }[];
  dataEntities: { documentationId: string; designIds: string[] }[];
  nonFunctionalRequirements: { requirementId: string; treated: boolean }[];
}
export interface ArchitectureAuthoredDraft {
  overview: { approach: string; systemBoundary: string; technicalDirection: string };
  components: ArchitectureComponent[];
  dataDesign: ArchitectureSection<ArchitectureDataDesign>;
  interfaceDesign: ArchitectureSection<ArchitectureInterfaceDesign>;
  integrationDesign: ArchitectureSection<ArchitectureIntegrationDesign>;
  crossCuttingDesign: { authorization: string; security: string; reliability: string; observability: string; enforcedFeatureIds: string[]; nfrTreatments: ArchitectureNfrTreatment[] };
  implementationSequence: string[];
  unresolvedQuestions: ArchitectureQuestion[];
}
export interface ArchitectureContent extends ArchitectureAuthoredDraft {
  traceability: ArchitectureTraceability;
  sourceRequirements: ArchitectureSource;
  sourceDocumentation: ArchitectureSource;
}

export class ArchitectureValidationError extends Error {
  constructor(message: string, readonly path?: string) { super(message); }
}

const authoredRoots = ["overview", "components", "dataDesign", "interfaceDesign", "integrationDesign", "crossCuttingDesign", "implementationSequence", "unresolvedQuestions"];
const canonicalRoots = [...authoredRoots, "traceability", "sourceRequirements", "sourceDocumentation"];
const idPatterns: Record<string, RegExp> = {
  components: /^ARCH-COMP-[A-Z0-9]+(?:-[A-Z0-9]+)*$/,
  dataDesign: /^ARCH-DATA-[A-Z0-9]+(?:-[A-Z0-9]+)*$/,
  interfaceDesign: /^ARCH-IFACE-[A-Z0-9]+(?:-[A-Z0-9]+)*$/,
  integrationDesign: /^ARCH-INT-[A-Z0-9]+(?:-[A-Z0-9]+)*$/,
  unresolvedQuestions: /^ARCH-Q-[A-Z0-9]+(?:-[A-Z0-9]+)*$/,
};

function object(value: unknown, keys: string[], path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ArchitectureValidationError("Expected an object.", path);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !keys.includes(key)) || keys.some((key) => !(key in record))) {
    throw new ArchitectureValidationError("Fields do not match the Architecture schema.", path);
  }
  return record;
}
function str(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) throw new ArchitectureValidationError("Expected a non-empty string.", path);
  return value.trim();
}
function credentialOwner(value: unknown, path: string): ArchitectureIntegrationDesign["credentialOwner"] {
  if (value !== "project_owner" && value !== "platform_operator" && value !== "external_operator") throw new ArchitectureValidationError("Expected a credential ownership role, never a credential value.", path);
  return value;
}
function list(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new ArchitectureValidationError("Expected an array.", path);
  return value;
}
function strings(value: unknown, path: string, preserveOrder = false): string[] {
  const result = list(value, path).map((item, index) => str(item, `${path}.${index}`));
  if (new Set(result).size !== result.length) throw new ArchitectureValidationError("Duplicate reference.", path);
  return preserveOrder ? result : result.sort();
}
function items<T>(value: unknown, path: string, keys: string[], convert: (item: Record<string, unknown>, path: string) => T): T[] {
  const seen = new Set<string>();
  return list(value, path).map((raw, index) => {
    const itemPath = `${path}.${index}`;
    const item = object(raw, keys, itemPath);
    const id = str(item.id, `${itemPath}.id`);
    if (!idPatterns[path]?.test(id) || seen.has(id)) throw new ArchitectureValidationError("Invalid or duplicate stable ID.", `${itemPath}.id`);
    seen.add(id);
    return convert(item, itemPath);
  }).sort((a, b) => String((a as { id: string }).id).localeCompare(String((b as { id: string }).id)));
}
function section<T>(value: unknown, path: string, keys: string[], convert: (item: Record<string, unknown>, path: string) => T): ArchitectureSection<T> {
  const sectionValue = object(value, ["applicable", "rationale", "items"], path);
  if (typeof sectionValue.applicable !== "boolean") throw new ArchitectureValidationError("Expected a boolean.", `${path}.applicable`);
  const result = { applicable: sectionValue.applicable, rationale: typeof sectionValue.rationale === "string" ? sectionValue.rationale.trim() : "", items: items(sectionValue.items, path, keys, convert) };
  if (result.applicable && result.items.length === 0) throw new ArchitectureValidationError("Applicable design requires items.", path);
  if (!result.applicable && (result.items.length > 0 || !result.rationale)) throw new ArchitectureValidationError("Non-applicable design requires a reason and no items.", path);
  return result;
}

export function parseArchitectureAuthoredDraft(value: unknown): ArchitectureAuthoredDraft {
  const root = object(value, authoredRoots, "architecture");
  const overview = object(root.overview, ["approach", "systemBoundary", "technicalDirection"], "overview");
  const cross = object(root.crossCuttingDesign, ["authorization", "security", "reliability", "observability", "enforcedFeatureIds", "nfrTreatments"], "crossCuttingDesign");
  const treatments = list(cross.nfrTreatments, "crossCuttingDesign.nfrTreatments").map((raw, index) => {
    const item = object(raw, ["requirementId", "treatment"], `crossCuttingDesign.nfrTreatments.${index}`);
    return { requirementId: str(item.requirementId, "requirementId"), treatment: str(item.treatment, "treatment") };
  }).sort((a, b) => a.requirementId.localeCompare(b.requirementId));
  if (new Set(treatments.map((item) => item.requirementId)).size !== treatments.length) throw new ArchitectureValidationError("Duplicate NFR treatment.", "crossCuttingDesign.nfrTreatments");
  const draft: ArchitectureAuthoredDraft = {
    overview: { approach: str(overview.approach, "overview.approach"), systemBoundary: str(overview.systemBoundary, "overview.systemBoundary"), technicalDirection: str(overview.technicalDirection, "overview.technicalDirection") },
    components: items(root.components, "components", ["id", "name", "responsibility", "boundary", "dependencyIds", "documentationFeatureIds", "designNotes"], (item, path) => ({
      id: str(item.id, `${path}.id`), name: str(item.name, `${path}.name`), responsibility: str(item.responsibility, `${path}.responsibility`), boundary: str(item.boundary, `${path}.boundary`), dependencyIds: strings(item.dependencyIds, `${path}.dependencyIds`), documentationFeatureIds: strings(item.documentationFeatureIds, `${path}.documentationFeatureIds`), designNotes: str(item.designNotes, `${path}.designNotes`),
    })),
    dataDesign: section(root.dataDesign, "dataDesign", ["id", "documentationEntityId", "componentId", "persistence", "lifecycle", "consistency"], (item, path) => ({ id: str(item.id, `${path}.id`), documentationEntityId: str(item.documentationEntityId, `${path}.documentationEntityId`), componentId: str(item.componentId, `${path}.componentId`), persistence: str(item.persistence, `${path}.persistence`), lifecycle: str(item.lifecycle, `${path}.lifecycle`), consistency: str(item.consistency, `${path}.consistency`) })),
    interfaceDesign: section(root.interfaceDesign, "interfaceDesign", ["id", "documentationApiId", "componentId", "boundary", "enforcement", "transport"], (item, path) => ({ id: str(item.id, `${path}.id`), documentationApiId: str(item.documentationApiId, `${path}.documentationApiId`), componentId: str(item.componentId, `${path}.componentId`), boundary: str(item.boundary, `${path}.boundary`), enforcement: str(item.enforcement, `${path}.enforcement`), transport: str(item.transport, `${path}.transport`) })),
    integrationDesign: section(root.integrationDesign, "integrationDesign", ["id", "componentId", "requirementIntegrationIds", "externalBoundary", "failureStrategy", "credentialOwner", "reliability"], (item, path) => ({ id: str(item.id, `${path}.id`), componentId: str(item.componentId, `${path}.componentId`), requirementIntegrationIds: strings(item.requirementIntegrationIds, `${path}.requirementIntegrationIds`), externalBoundary: str(item.externalBoundary, `${path}.externalBoundary`), failureStrategy: str(item.failureStrategy, `${path}.failureStrategy`), credentialOwner: credentialOwner(item.credentialOwner, `${path}.credentialOwner`), reliability: str(item.reliability, `${path}.reliability`) })),
    crossCuttingDesign: { authorization: str(cross.authorization, "crossCuttingDesign.authorization"), security: str(cross.security, "crossCuttingDesign.security"), reliability: str(cross.reliability, "crossCuttingDesign.reliability"), observability: str(cross.observability, "crossCuttingDesign.observability"), enforcedFeatureIds: strings(cross.enforcedFeatureIds, "crossCuttingDesign.enforcedFeatureIds"), nfrTreatments: treatments },
    implementationSequence: strings(root.implementationSequence, "implementationSequence", true),
    unresolvedQuestions: items(root.unresolvedQuestions, "unresolvedQuestions", ["id", "question", "blocksDecision"], (item, path) => {
      if (typeof item.blocksDecision !== "boolean") throw new ArchitectureValidationError("Expected a boolean.", `${path}.blocksDecision`);
      return { id: str(item.id, `${path}.id`), question: str(item.question, `${path}.question`), blocksDecision: item.blocksDecision };
    }),
  };
  if (!draft.components.length) throw new ArchitectureValidationError("Architecture requires at least one component.", "components");
  return draft;
}

export function parseArchitectureContent(value: unknown): ArchitectureContent {
  const root = object(value, canonicalRoots, "architecture");
  const authored = parseArchitectureAuthoredDraft(Object.fromEntries(authoredRoots.map((key) => [key, root[key]])));
  const source = (key: "sourceRequirements" | "sourceDocumentation"): ArchitectureSource => {
    const record = object(root[key], ["artifactId", "version", "contentHash"], key);
    if (!Number.isSafeInteger(record.version) || (record.version as number) < 1 || !/^[a-f0-9]{64}$/.test(String(record.contentHash))) throw new ArchitectureValidationError("Invalid source descriptor.", key);
    return { artifactId: str(record.artifactId, `${key}.artifactId`), version: record.version as number, contentHash: record.contentHash as string };
  };
  const trace = object(root.traceability, ["features", "interfaces", "dataEntities", "nonFunctionalRequirements"], "traceability");
  const mapping = (key: "features" | "interfaces" | "dataEntities", member: "componentIds" | "designIds") => list(trace[key], `traceability.${key}`).map((raw, index) => {
    const record = object(raw, ["documentationId", member], `traceability.${key}.${index}`);
    return { documentationId: str(record.documentationId, "documentationId"), [member]: strings(record[member], member) };
  }).sort((a, b) => a.documentationId.localeCompare(b.documentationId));
  const nfrs = list(trace.nonFunctionalRequirements, "traceability.nonFunctionalRequirements").map((raw, index) => {
    const record = object(raw, ["requirementId", "treated"], `traceability.nonFunctionalRequirements.${index}`);
    if (typeof record.treated !== "boolean") throw new ArchitectureValidationError("Expected boolean.", "traceability.nonFunctionalRequirements.treated");
    return { requirementId: str(record.requirementId, "requirementId"), treated: record.treated };
  }).sort((a, b) => a.requirementId.localeCompare(b.requirementId));
  return { ...authored, traceability: { features: mapping("features", "componentIds") as ArchitectureTraceability["features"], interfaces: mapping("interfaces", "designIds") as ArchitectureTraceability["interfaces"], dataEntities: mapping("dataEntities", "designIds") as ArchitectureTraceability["dataEntities"], nonFunctionalRequirements: nfrs }, sourceRequirements: source("sourceRequirements"), sourceDocumentation: source("sourceDocumentation") };
}

export function hashArchitectureContent(content: ArchitectureContent): string {
  return crypto.createHash("sha256").update(canonicalJson(parseArchitectureContent(content))).digest("hex");
}
export function renderArchitectureMarkdown(content: ArchitectureContent): string {
  const canonical = parseArchitectureContent(content);
  const lines = ["# Architecture & Design", "", `Requirements: ${canonical.sourceRequirements.artifactId} v${canonical.sourceRequirements.version} (${canonical.sourceRequirements.contentHash})`, `Documentation: ${canonical.sourceDocumentation.artifactId} v${canonical.sourceDocumentation.version} (${canonical.sourceDocumentation.contentHash})`, ""];
  for (const key of authoredRoots) {
    lines.push(`## ${key}`, "", "```json", canonicalJson(canonical[key as keyof ArchitectureAuthoredDraft]), "```", "");
  }
  lines.push("## traceability", "", "```json", canonicalJson(canonical.traceability), "```", "");
  return `${lines.join("\n").trimEnd()}\n`;
}
