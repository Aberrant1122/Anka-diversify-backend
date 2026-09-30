import crypto from "crypto";
import { canonicalJson } from "./requirements-context";

export const DOCUMENTATION_SCHEMA_VERSION = 1;
export const DOCUMENTATION_RENDERER_VERSION = 1;
export const DOCUMENTATION_ARTIFACT_TYPE = "documentation_doc" as const;
export const DOCUMENTATION_CANONICAL_JSON_MAX_BYTES = 128 * 1024;

export type DocumentationId = string;
export type UpstreamId = string;
export type DocumentationFeatureAccess = "public" | "controlled";
export type DocumentationLogicalType =
  | "string"
  | "integer"
  | "number"
  | "boolean"
  | "date"
  | "datetime"
  | "identifier"
  | "record"
  | "list"
  | "binary";

export interface ApplicableSection<T> {
  applicable: boolean;
  rationale: string;
  items: T[];
}

export interface DocumentationOverview {
  summary: string;
  scope: string;
  goals: string[];
  nonGoals: string[];
}

export interface DocumentationActor {
  id: DocumentationId;
  name: string;
  description: string;
  sourceActorIds: UpstreamId[];
}

export interface DocumentationFeature {
  id: DocumentationId;
  title: string;
  description: string;
  workflowSteps: string[];
  actorIds: DocumentationId[];
  access: DocumentationFeatureAccess;
  sourceRequirementIds: UpstreamId[];
  sourceUserStoryIds: UpstreamId[];
}

export type DocumentationHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";

export type DocumentationApiInteraction =
  | { kind: "http"; method: DocumentationHttpMethod; path: string }
  | { kind: "event"; direction: "publish" | "consume"; channel: string }
  | { kind: "command"; command: string }
  | { kind: "file"; direction: "import" | "export"; contractName: string };

export interface DocumentationLogicalField {
  name: string;
  logicalType: DocumentationLogicalType;
  required: boolean;
  description: string;
  allowedValues: string[];
  validationRules: string[];
}

export interface DocumentationDataShape {
  description: string;
  fields: DocumentationLogicalField[];
}

export interface DocumentationApiContract {
  id: DocumentationId;
  name: string;
  description: string;
  interaction: DocumentationApiInteraction;
  access: DocumentationFeatureAccess;
  input: DocumentationDataShape;
  success: DocumentationDataShape;
  relatedFeatureIds: DocumentationId[];
  relatedEntityIds: DocumentationId[];
  errorBehaviorIds: DocumentationId[];
  sourceRequirementIds: UpstreamId[];
  sourceUserStoryIds: UpstreamId[];
}

export type DocumentationRelationshipCardinality = "one_to_one" | "one_to_many" | "many_to_one" | "many_to_many";

export interface DocumentationEntityRelationship {
  targetEntityId: DocumentationId;
  cardinality: DocumentationRelationshipCardinality;
  required: boolean;
  description: string;
}

export interface DocumentationDataEntity {
  id: DocumentationId;
  name: string;
  description: string;
  fields: DocumentationLogicalField[];
  relationships: DocumentationEntityRelationship[];
  sourceRequirementIds: UpstreamId[];
  sourceUserStoryIds: UpstreamId[];
}

export interface DocumentationBusinessRule {
  id: DocumentationId;
  title: string;
  condition: string;
  expectedBehavior: string;
  relatedFeatureIds: DocumentationId[];
  relatedEntityIds: DocumentationId[];
  sourceRequirementIds: UpstreamId[];
  sourceUserStoryIds: UpstreamId[];
}

export type DocumentationPermissionEffect = "allow" | "deny";

export interface DocumentationPermissionRule {
  id: DocumentationId;
  title: string;
  description: string;
  effect: DocumentationPermissionEffect;
  actorIds: DocumentationId[];
  actions: string[];
  relatedFeatureIds: DocumentationId[];
  relatedApiContractIds: DocumentationId[];
}

export interface DocumentationErrorBehavior {
  id: DocumentationId;
  code: string;
  scenario: string;
  expectedSystemBehavior: string;
  recoveryBehavior: string;
  relatedFeatureIds: DocumentationId[];
  relatedApiContractIds: DocumentationId[];
  httpStatus?: number;
}

export interface DocumentationEdgeCase {
  id: DocumentationId;
  scenario: string;
  expectedHandling: string;
  relatedFeatureIds: DocumentationId[];
  relatedApiContractIds: DocumentationId[];
  relatedEntityIds: DocumentationId[];
}

export interface DocumentationUnresolvedQuestion {
  id: DocumentationId;
  question: string;
  impact: string;
}

export interface DocumentationSourceRequirements {
  artifactId: string;
  version: number;
  contentHash: string;
}

export type DocumentationRequirementKind = "functional" | "non_functional";
export type DocumentationCoverageStatus = "covered" | "uncovered";

export interface DocumentationRequirementTrace {
  requirementId: UpstreamId;
  requirementKind: DocumentationRequirementKind;
  coveredByFeatureIds: DocumentationId[];
  coveredByApiContractIds: DocumentationId[];
  coveredByDataEntityIds: DocumentationId[];
  coveredByBusinessRuleIds: DocumentationId[];
  coverageStatus: DocumentationCoverageStatus;
}

export interface DocumentationProviderDraft {
  overview: DocumentationOverview;
  systemActors: DocumentationActor[];
  features: DocumentationFeature[];
  apiContracts: ApplicableSection<DocumentationApiContract>;
  dataEntities: ApplicableSection<DocumentationDataEntity>;
  businessRules: DocumentationBusinessRule[];
  permissionRules: ApplicableSection<DocumentationPermissionRule>;
  errorBehaviors: DocumentationErrorBehavior[];
  edgeCases: DocumentationEdgeCase[];
  unresolvedQuestions: DocumentationUnresolvedQuestion[];
}

export interface DocumentationContent extends DocumentationProviderDraft {
  requirementsTraceability: DocumentationRequirementTrace[];
  sourceRequirements: DocumentationSourceRequirements;
}

export const DOCUMENTATION_PROVIDER_ROOT_FIELDS = Object.freeze([
  "overview", "systemActors", "features", "apiContracts", "dataEntities", "businessRules",
  "permissionRules", "errorBehaviors", "edgeCases", "unresolvedQuestions",
] as const);

export const DOCUMENTATION_ROOT_FIELDS = Object.freeze([
  "overview", "systemActors", "features", "apiContracts", "dataEntities", "businessRules",
  "permissionRules", "errorBehaviors", "edgeCases", "requirementsTraceability",
  "unresolvedQuestions", "sourceRequirements",
] as const);

export type DocumentationProviderRoot = (typeof DOCUMENTATION_PROVIDER_ROOT_FIELDS)[number];

export type DocumentationValidationCode =
  | "DOCUMENTATION_STRUCTURE_INVALID"
  | "DOCUMENTATION_REFERENCE_INVALID"
  | "DOCUMENTATION_APPLICABILITY_INVALID"
  | "DOCUMENTATION_TRACEABILITY_INVALID"
  | "DOCUMENTATION_STABLE_ID_INVALID"
  | "DOCUMENTATION_SECTION_SCOPE_INVALID"
  | "DOCUMENTATION_SIZE_EXCEEDED";

export class DocumentationValidationError extends Error {
  constructor(
    readonly code: DocumentationValidationCode,
    message: string,
    readonly path?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "DocumentationValidationError";
  }
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const LOGICAL_TYPES = new Set<DocumentationLogicalType>([
  "string", "integer", "number", "boolean", "date", "datetime", "identifier", "record", "list", "binary",
]);
const HTTP_METHODS = new Set<DocumentationHttpMethod>(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]);
const CARDINALITIES = new Set<DocumentationRelationshipCardinality>(["one_to_one", "one_to_many", "many_to_one", "many_to_many"]);

function structure(path: string, message: string): never {
  throw new DocumentationValidationError("DOCUMENTATION_STRUCTURE_INVALID", `Invalid Documentation content at ${path}: ${message}`, path);
}

function objectAt(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) structure(path, "expected an object");
  const object = value as Record<string, unknown>;
  const unknown = Object.keys(object).filter((key) => !keys.includes(key));
  if (unknown.length > 0) structure(path, `unknown fields: ${unknown.join(", ")}`);
  for (const key of keys) if (!(key in object)) structure(`${path}.${key}`, "field is required");
  return object;
}

function textAt(value: unknown, path: string, allowEmpty = false): string {
  if (typeof value !== "string") structure(path, "expected a string");
  const normalized = value.replace(/\r\n/g, "\n").trim();
  if (!allowEmpty && normalized.length === 0) structure(path, "expected a non-empty string");
  return normalized;
}

function idAt(value: unknown, path: string): string {
  const id = textAt(value, path);
  if (!ID_PATTERN.test(id)) structure(path, "must be a stable ID using letters, numbers, '.', '_' or '-'");
  return id;
}

function booleanAt(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") structure(path, "expected a boolean");
  return value;
}

function integerAt(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value)) structure(path, "expected an integer");
  return value as number;
}

function arrayAt<T>(value: unknown, path: string, parse: (item: unknown, path: string) => T): T[] {
  if (!Array.isArray(value)) structure(path, "expected an array");
  return value.map((item, index) => parse(item, `${path}[${index}]`));
}

function textArrayAt(value: unknown, path: string): string[] {
  return arrayAt(value, path, textAt);
}

function referenceArrayAt(value: unknown, path: string): string[] {
  const ids = arrayAt(value, path, idAt);
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) structure(path, `duplicate reference ID '${id}'`);
    seen.add(id);
  }
  return ids;
}

function parseOverview(value: unknown, path: string): DocumentationOverview {
  const object = objectAt(value, path, ["summary", "scope", "goals", "nonGoals"]);
  return {
    summary: textAt(object.summary, `${path}.summary`),
    scope: textAt(object.scope, `${path}.scope`),
    goals: textArrayAt(object.goals, `${path}.goals`),
    nonGoals: textArrayAt(object.nonGoals, `${path}.nonGoals`),
  };
}

function parseActor(value: unknown, path: string): DocumentationActor {
  const object = objectAt(value, path, ["id", "name", "description", "sourceActorIds"]);
  return { id: idAt(object.id, `${path}.id`), name: textAt(object.name, `${path}.name`), description: textAt(object.description, `${path}.description`), sourceActorIds: referenceArrayAt(object.sourceActorIds, `${path}.sourceActorIds`) };
}

function parseAccess(value: unknown, path: string): DocumentationFeatureAccess {
  if (value !== "public" && value !== "controlled") structure(path, "expected 'public' or 'controlled'");
  return value;
}

function parseFeature(value: unknown, path: string): DocumentationFeature {
  const object = objectAt(value, path, ["id", "title", "description", "workflowSteps", "actorIds", "access", "sourceRequirementIds", "sourceUserStoryIds"]);
  const workflowSteps = textArrayAt(object.workflowSteps, `${path}.workflowSteps`);
  const actorIds = referenceArrayAt(object.actorIds, `${path}.actorIds`);
  if (workflowSteps.length === 0) structure(`${path}.workflowSteps`, "at least one workflow step is required");
  if (actorIds.length === 0) structure(`${path}.actorIds`, "at least one actor is required");
  const sourceRequirementIds = referenceArrayAt(object.sourceRequirementIds, `${path}.sourceRequirementIds`);
  const sourceUserStoryIds = referenceArrayAt(object.sourceUserStoryIds, `${path}.sourceUserStoryIds`);
  if (sourceRequirementIds.length + sourceUserStoryIds.length === 0) structure(path, "at least one upstream Requirement or UserStory reference is required");
  return { id: idAt(object.id, `${path}.id`), title: textAt(object.title, `${path}.title`), description: textAt(object.description, `${path}.description`), workflowSteps, actorIds, access: parseAccess(object.access, `${path}.access`), sourceRequirementIds, sourceUserStoryIds };
}

function parseLogicalField(value: unknown, path: string): DocumentationLogicalField {
  const object = objectAt(value, path, ["name", "logicalType", "required", "description", "allowedValues", "validationRules"]);
  if (typeof object.logicalType !== "string" || !LOGICAL_TYPES.has(object.logicalType as DocumentationLogicalType)) structure(`${path}.logicalType`, "unsupported logical type");
  return { name: textAt(object.name, `${path}.name`), logicalType: object.logicalType as DocumentationLogicalType, required: booleanAt(object.required, `${path}.required`), description: textAt(object.description, `${path}.description`), allowedValues: textArrayAt(object.allowedValues, `${path}.allowedValues`), validationRules: textArrayAt(object.validationRules, `${path}.validationRules`) };
}

function parseShape(value: unknown, path: string, requireFields: boolean): DocumentationDataShape {
  const object = objectAt(value, path, ["description", "fields"]);
  const fields = arrayAt(object.fields, `${path}.fields`, parseLogicalField);
  if (requireFields && fields.length === 0) structure(`${path}.fields`, "at least one logical field is required");
  const names = new Set<string>();
  for (const field of fields) {
    if (names.has(field.name)) structure(`${path}.fields`, `duplicate logical field name '${field.name}'`);
    names.add(field.name);
  }
  return { description: textAt(object.description, `${path}.description`), fields };
}

function parseInteraction(value: unknown, path: string): DocumentationApiInteraction {
  if (!value || typeof value !== "object" || Array.isArray(value)) structure(path, "expected an interaction object");
  const kind = (value as Record<string, unknown>).kind;
  if (kind === "http") {
    const object = objectAt(value, path, ["kind", "method", "path"]);
    if (typeof object.method !== "string" || !HTTP_METHODS.has(object.method as DocumentationHttpMethod)) structure(`${path}.method`, "unsupported HTTP method");
    const route = textAt(object.path, `${path}.path`);
    if (!route.startsWith("/") || route.startsWith("//") || /^[a-z][a-z0-9+.-]*:\/\//i.test(route)) structure(`${path}.path`, "HTTP path must be relative and begin with '/'");
    return { kind, method: object.method as DocumentationHttpMethod, path: route };
  }
  if (kind === "event") {
    const object = objectAt(value, path, ["kind", "direction", "channel"]);
    if (object.direction !== "publish" && object.direction !== "consume") structure(`${path}.direction`, "expected 'publish' or 'consume'");
    return { kind, direction: object.direction, channel: textAt(object.channel, `${path}.channel`) };
  }
  if (kind === "command") {
    const object = objectAt(value, path, ["kind", "command"]);
    return { kind, command: textAt(object.command, `${path}.command`) };
  }
  if (kind === "file") {
    const object = objectAt(value, path, ["kind", "direction", "contractName"]);
    if (object.direction !== "import" && object.direction !== "export") structure(`${path}.direction`, "expected 'import' or 'export'");
    return { kind, direction: object.direction, contractName: textAt(object.contractName, `${path}.contractName`) };
  }
  structure(`${path}.kind`, "unsupported interaction kind");
}

function parseApi(value: unknown, path: string): DocumentationApiContract {
  const object = objectAt(value, path, ["id", "name", "description", "interaction", "access", "input", "success", "relatedFeatureIds", "relatedEntityIds", "errorBehaviorIds", "sourceRequirementIds", "sourceUserStoryIds"]);
  return {
    id: idAt(object.id, `${path}.id`), name: textAt(object.name, `${path}.name`), description: textAt(object.description, `${path}.description`),
    interaction: parseInteraction(object.interaction, `${path}.interaction`), access: parseAccess(object.access, `${path}.access`),
    input: parseShape(object.input, `${path}.input`, false), success: parseShape(object.success, `${path}.success`, false),
    relatedFeatureIds: referenceArrayAt(object.relatedFeatureIds, `${path}.relatedFeatureIds`), relatedEntityIds: referenceArrayAt(object.relatedEntityIds, `${path}.relatedEntityIds`),
    errorBehaviorIds: referenceArrayAt(object.errorBehaviorIds, `${path}.errorBehaviorIds`), sourceRequirementIds: referenceArrayAt(object.sourceRequirementIds, `${path}.sourceRequirementIds`), sourceUserStoryIds: referenceArrayAt(object.sourceUserStoryIds, `${path}.sourceUserStoryIds`),
  };
}

function parseRelationship(value: unknown, path: string): DocumentationEntityRelationship {
  const object = objectAt(value, path, ["targetEntityId", "cardinality", "required", "description"]);
  if (typeof object.cardinality !== "string" || !CARDINALITIES.has(object.cardinality as DocumentationRelationshipCardinality)) structure(`${path}.cardinality`, "unsupported relationship cardinality");
  return { targetEntityId: idAt(object.targetEntityId, `${path}.targetEntityId`), cardinality: object.cardinality as DocumentationRelationshipCardinality, required: booleanAt(object.required, `${path}.required`), description: textAt(object.description, `${path}.description`) };
}

function parseEntity(value: unknown, path: string): DocumentationDataEntity {
  const object = objectAt(value, path, ["id", "name", "description", "fields", "relationships", "sourceRequirementIds", "sourceUserStoryIds"]);
  const shape = parseShape({ description: object.description, fields: object.fields }, path, true);
  return { id: idAt(object.id, `${path}.id`), name: textAt(object.name, `${path}.name`), description: shape.description, fields: shape.fields, relationships: arrayAt(object.relationships, `${path}.relationships`, parseRelationship), sourceRequirementIds: referenceArrayAt(object.sourceRequirementIds, `${path}.sourceRequirementIds`), sourceUserStoryIds: referenceArrayAt(object.sourceUserStoryIds, `${path}.sourceUserStoryIds`) };
}

function parseBusinessRule(value: unknown, path: string): DocumentationBusinessRule {
  const object = objectAt(value, path, ["id", "title", "condition", "expectedBehavior", "relatedFeatureIds", "relatedEntityIds", "sourceRequirementIds", "sourceUserStoryIds"]);
  return { id: idAt(object.id, `${path}.id`), title: textAt(object.title, `${path}.title`), condition: textAt(object.condition, `${path}.condition`), expectedBehavior: textAt(object.expectedBehavior, `${path}.expectedBehavior`), relatedFeatureIds: referenceArrayAt(object.relatedFeatureIds, `${path}.relatedFeatureIds`), relatedEntityIds: referenceArrayAt(object.relatedEntityIds, `${path}.relatedEntityIds`), sourceRequirementIds: referenceArrayAt(object.sourceRequirementIds, `${path}.sourceRequirementIds`), sourceUserStoryIds: referenceArrayAt(object.sourceUserStoryIds, `${path}.sourceUserStoryIds`) };
}

function parsePermission(value: unknown, path: string): DocumentationPermissionRule {
  const object = objectAt(value, path, ["id", "title", "description", "effect", "actorIds", "actions", "relatedFeatureIds", "relatedApiContractIds"]);
  if (object.effect !== "allow" && object.effect !== "deny") structure(`${path}.effect`, "expected 'allow' or 'deny'");
  const actorIds = referenceArrayAt(object.actorIds, `${path}.actorIds`);
  const actions = textArrayAt(object.actions, `${path}.actions`);
  if (actorIds.length === 0) structure(`${path}.actorIds`, "at least one actor is required");
  if (actions.length === 0) structure(`${path}.actions`, "at least one action is required");
  return { id: idAt(object.id, `${path}.id`), title: textAt(object.title, `${path}.title`), description: textAt(object.description, `${path}.description`), effect: object.effect, actorIds, actions, relatedFeatureIds: referenceArrayAt(object.relatedFeatureIds, `${path}.relatedFeatureIds`), relatedApiContractIds: referenceArrayAt(object.relatedApiContractIds, `${path}.relatedApiContractIds`) };
}

function parseErrorBehavior(value: unknown, path: string): DocumentationErrorBehavior {
  if (!value || typeof value !== "object" || Array.isArray(value)) structure(path, "expected an object");
  const raw = value as Record<string, unknown>;
  const keys = ["id", "code", "scenario", "expectedSystemBehavior", "recoveryBehavior", "relatedFeatureIds", "relatedApiContractIds", ...(Object.prototype.hasOwnProperty.call(raw, "httpStatus") ? ["httpStatus"] : [])];
  const object = objectAt(value, path, keys);
  const httpStatus = Object.prototype.hasOwnProperty.call(object, "httpStatus") ? integerAt(object.httpStatus, `${path}.httpStatus`) : undefined;
  return { id: idAt(object.id, `${path}.id`), code: textAt(object.code, `${path}.code`), scenario: textAt(object.scenario, `${path}.scenario`), expectedSystemBehavior: textAt(object.expectedSystemBehavior, `${path}.expectedSystemBehavior`), recoveryBehavior: textAt(object.recoveryBehavior, `${path}.recoveryBehavior`), relatedFeatureIds: referenceArrayAt(object.relatedFeatureIds, `${path}.relatedFeatureIds`), relatedApiContractIds: referenceArrayAt(object.relatedApiContractIds, `${path}.relatedApiContractIds`), ...(httpStatus === undefined ? {} : { httpStatus }) };
}

function parseEdgeCase(value: unknown, path: string): DocumentationEdgeCase {
  const object = objectAt(value, path, ["id", "scenario", "expectedHandling", "relatedFeatureIds", "relatedApiContractIds", "relatedEntityIds"]);
  return { id: idAt(object.id, `${path}.id`), scenario: textAt(object.scenario, `${path}.scenario`), expectedHandling: textAt(object.expectedHandling, `${path}.expectedHandling`), relatedFeatureIds: referenceArrayAt(object.relatedFeatureIds, `${path}.relatedFeatureIds`), relatedApiContractIds: referenceArrayAt(object.relatedApiContractIds, `${path}.relatedApiContractIds`), relatedEntityIds: referenceArrayAt(object.relatedEntityIds, `${path}.relatedEntityIds`) };
}

function parseQuestion(value: unknown, path: string): DocumentationUnresolvedQuestion {
  const object = objectAt(value, path, ["id", "question", "impact"]);
  return { id: idAt(object.id, `${path}.id`), question: textAt(object.question, `${path}.question`), impact: textAt(object.impact, `${path}.impact`) };
}

function parseApplicable<T>(value: unknown, path: string, parseItem: (item: unknown, path: string) => T): ApplicableSection<T> {
  const object = objectAt(value, path, ["applicable", "rationale", "items"]);
  const applicable = booleanAt(object.applicable, `${path}.applicable`);
  const rationale = textAt(object.rationale, `${path}.rationale`, applicable);
  const items = arrayAt(object.items, `${path}.items`, parseItem);
  if (applicable && items.length === 0) structure(`${path}.items`, "applicable sections require at least one item");
  if (!applicable && items.length > 0) structure(`${path}.items`, "non-applicable sections must be empty");
  return { applicable, rationale, items };
}

function parseProviderObject(object: Record<string, unknown>, path: string): DocumentationProviderDraft {
  return {
    overview: parseOverview(object.overview, `${path}.overview`), systemActors: arrayAt(object.systemActors, `${path}.systemActors`, parseActor), features: arrayAt(object.features, `${path}.features`, parseFeature),
    apiContracts: parseApplicable(object.apiContracts, `${path}.apiContracts`, parseApi), dataEntities: parseApplicable(object.dataEntities, `${path}.dataEntities`, parseEntity), businessRules: arrayAt(object.businessRules, `${path}.businessRules`, parseBusinessRule),
    permissionRules: parseApplicable(object.permissionRules, `${path}.permissionRules`, parsePermission), errorBehaviors: arrayAt(object.errorBehaviors, `${path}.errorBehaviors`, parseErrorBehavior), edgeCases: arrayAt(object.edgeCases, `${path}.edgeCases`, parseEdgeCase), unresolvedQuestions: arrayAt(object.unresolvedQuestions, `${path}.unresolvedQuestions`, parseQuestion),
  };
}

export function parseDocumentationProviderDraft(value: unknown): DocumentationProviderDraft {
  return parseProviderObject(objectAt(value, "documentationDraft", DOCUMENTATION_PROVIDER_ROOT_FIELDS), "documentationDraft");
}

export function parseDocumentationSourceRequirements(value: unknown): DocumentationSourceRequirements {
  const object = objectAt(value, "sourceRequirements", ["artifactId", "version", "contentHash"]);
  const version = integerAt(object.version, "sourceRequirements.version");
  if (version < 1) structure("sourceRequirements.version", "must be at least 1");
  const contentHash = textAt(object.contentHash, "sourceRequirements.contentHash");
  if (!HASH_PATTERN.test(contentHash)) structure("sourceRequirements.contentHash", "must be a lowercase SHA-256 hash");
  return { artifactId: textAt(object.artifactId, "sourceRequirements.artifactId"), version, contentHash };
}

function parseTrace(value: unknown, path: string): DocumentationRequirementTrace {
  const object = objectAt(value, path, ["requirementId", "requirementKind", "coveredByFeatureIds", "coveredByApiContractIds", "coveredByDataEntityIds", "coveredByBusinessRuleIds", "coverageStatus"]);
  if (object.requirementKind !== "functional" && object.requirementKind !== "non_functional") structure(`${path}.requirementKind`, "unsupported Requirement kind");
  if (object.coverageStatus !== "covered" && object.coverageStatus !== "uncovered") structure(`${path}.coverageStatus`, "unsupported coverage status");
  return { requirementId: idAt(object.requirementId, `${path}.requirementId`), requirementKind: object.requirementKind, coveredByFeatureIds: referenceArrayAt(object.coveredByFeatureIds, `${path}.coveredByFeatureIds`), coveredByApiContractIds: referenceArrayAt(object.coveredByApiContractIds, `${path}.coveredByApiContractIds`), coveredByDataEntityIds: referenceArrayAt(object.coveredByDataEntityIds, `${path}.coveredByDataEntityIds`), coveredByBusinessRuleIds: referenceArrayAt(object.coveredByBusinessRuleIds, `${path}.coveredByBusinessRuleIds`), coverageStatus: object.coverageStatus };
}

export function parseDocumentationContent(value: unknown): DocumentationContent {
  const object = objectAt(value, "documentation", DOCUMENTATION_ROOT_FIELDS);
  const draft = parseProviderObject(object, "documentation");
  return { ...draft, requirementsTraceability: arrayAt(object.requirementsTraceability, "documentation.requirementsTraceability", parseTrace), sourceRequirements: parseDocumentationSourceRequirements(object.sourceRequirements) };
}

function list(items: readonly string[]): string { return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "_None._"; }
function refs(ids: readonly string[]): string { return ids.length > 0 ? ids.map((id) => `\`${id}\``).join(", ") : "none"; }
function renderFields(fields: readonly DocumentationLogicalField[]): string {
  return list(fields.map((field) => `**${field.name}** — ${field.logicalType}; ${field.required ? "required" : "optional"}; ${field.description}; allowed: ${field.allowedValues.join(", ") || "any"}; validation: ${field.validationRules.join("; ") || "none"}`));
}
function renderInteraction(interaction: DocumentationApiInteraction): string {
  if (interaction.kind === "http") return `${interaction.method} ${interaction.path}`;
  if (interaction.kind === "event") return `${interaction.direction} event on ${interaction.channel}`;
  if (interaction.kind === "command") return `command ${interaction.command}`;
  return `${interaction.direction} file contract ${interaction.contractName}`;
}
function conditional<T>(section: ApplicableSection<T>, render: (item: T) => string): string {
  if (!section.applicable) return `_Not applicable._\n\nRationale: ${section.rationale}`;
  return `${section.rationale ? `Rationale: ${section.rationale}\n\n` : ""}${list(section.items.map(render))}`;
}

export function renderDocumentationMarkdown(input: DocumentationContent): string {
  const content = parseDocumentationContent(input);
  const sections = [
    `# Documentation\n\n## Overview\n\n### Summary\n\n${content.overview.summary}\n\n### Scope\n\n${content.overview.scope}\n\n### Goals\n\n${list(content.overview.goals)}\n\n### Non-Goals\n\n${list(content.overview.nonGoals)}`,
    `## System Actors\n\n${list(content.systemActors.map((item) => `\`${item.id}\` **${item.name}** — ${item.description}; upstream actors: ${refs(item.sourceActorIds)}`))}`,
    `## Features\n\n${list(content.features.map((item) => `\`${item.id}\` **${item.title}** — ${item.description}; access: ${item.access}; actors: ${refs(item.actorIds)}; requirements: ${refs(item.sourceRequirementIds)}; stories: ${refs(item.sourceUserStoryIds)}; workflow: ${item.workflowSteps.join(" → ")}`))}`,
    `## API Contracts\n\n${conditional(content.apiContracts, (item) => `\`${item.id}\` **${item.name}** — ${item.description}; interaction: ${renderInteraction(item.interaction)}; access: ${item.access}; features: ${refs(item.relatedFeatureIds)}; entities: ${refs(item.relatedEntityIds)}; errors: ${refs(item.errorBehaviorIds)}\n  - Input: ${item.input.description}\n${renderFields(item.input.fields).split("\n").map((line) => `    ${line}`).join("\n")}\n  - Success: ${item.success.description}\n${renderFields(item.success.fields).split("\n").map((line) => `    ${line}`).join("\n")}`)}`,
    `## Data Entities\n\n${conditional(content.dataEntities, (item) => `\`${item.id}\` **${item.name}** — ${item.description}; requirements: ${refs(item.sourceRequirementIds)}; stories: ${refs(item.sourceUserStoryIds)}\n  - Fields:\n${renderFields(item.fields).split("\n").map((line) => `    ${line}`).join("\n")}\n  - Relationships: ${item.relationships.length ? item.relationships.map((relation) => `${relation.cardinality} → \`${relation.targetEntityId}\` (${relation.required ? "required" : "optional"}): ${relation.description}`).join("; ") : "none"}`)}`,
    `## Business Rules\n\n${list(content.businessRules.map((item) => `\`${item.id}\` **${item.title}** — If ${item.condition}, then ${item.expectedBehavior}; features: ${refs(item.relatedFeatureIds)}; entities: ${refs(item.relatedEntityIds)}; requirements: ${refs(item.sourceRequirementIds)}; stories: ${refs(item.sourceUserStoryIds)}`))}`,
    `## Permission Rules\n\n${conditional(content.permissionRules, (item) => `\`${item.id}\` **${item.title}** — ${item.effect}: ${item.description}; actors: ${refs(item.actorIds)}; actions: ${item.actions.join(", ")}; features: ${refs(item.relatedFeatureIds)}; APIs: ${refs(item.relatedApiContractIds)}`)}`,
    `## Error Behaviors\n\n${list(content.errorBehaviors.map((item) => `\`${item.id}\` **${item.code}** — ${item.scenario}; behavior: ${item.expectedSystemBehavior}; recovery: ${item.recoveryBehavior}; features: ${refs(item.relatedFeatureIds)}; APIs: ${refs(item.relatedApiContractIds)}${item.httpStatus === undefined ? "" : `; HTTP status: ${item.httpStatus}`}`))}`,
    `## Edge Cases\n\n${list(content.edgeCases.map((item) => `\`${item.id}\` ${item.scenario}; handling: ${item.expectedHandling}; features: ${refs(item.relatedFeatureIds)}; APIs: ${refs(item.relatedApiContractIds)}; entities: ${refs(item.relatedEntityIds)}`))}`,
    `## Requirements Traceability\n\n${list(content.requirementsTraceability.map((item) => `\`${item.requirementId}\` (${item.requirementKind}) — ${item.coverageStatus}; features: ${refs(item.coveredByFeatureIds)}; APIs: ${refs(item.coveredByApiContractIds)}; entities: ${refs(item.coveredByDataEntityIds)}; business rules: ${refs(item.coveredByBusinessRuleIds)}`))}`,
    `## Unresolved Questions\n\n${list(content.unresolvedQuestions.map((item) => `\`${item.id}\` ${item.question}; impact: ${item.impact}`))}`,
    `## Source Requirements\n\n- Artifact: \`${content.sourceRequirements.artifactId}\`\n- Version: ${content.sourceRequirements.version}\n- Content Hash: \`${content.sourceRequirements.contentHash}\``,
  ];
  return `${sections.join("\n\n")}\n`;
}

export function hashDocumentationContent(input: DocumentationContent): string {
  const content = parseDocumentationContent(input);
  return crypto.createHash("sha256").update(canonicalJson({ artifact: DOCUMENTATION_ARTIFACT_TYPE, schemaVersion: DOCUMENTATION_SCHEMA_VERSION, rendererVersion: DOCUMENTATION_RENDERER_VERSION, content }), "utf8").digest("hex");
}
