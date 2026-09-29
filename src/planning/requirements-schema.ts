import crypto from "crypto";
import { PlanningDomainError } from "./planning-errors";
import { REQUIREMENTS_VERSIONS } from "./requirements-run-config";

export const REQUIREMENTS_SCHEMA_VERSION = REQUIREMENTS_VERSIONS.canonicalSchema;
export const REQUIREMENTS_RENDERER_VERSION = 1;
export const REQUIREMENTS_PHASE = "requirements" as const;
export const REQUIREMENTS_ARTIFACT_TYPE = "requirements_doc" as const;

export interface NamedRequirementsItem {
  id: string;
  name: string;
  description: string;
}

export interface UserStory {
  id: string;
  actor: string;
  capability: string;
  benefit: string;
  acceptanceCriteriaIds: string[];
}

export interface RequirementItem {
  id: string;
  title: string;
  description: string;
}

export interface RequirementsTextItem {
  id: string;
  description: string;
}

export interface RequirementsIntegration {
  id: string;
  name: string;
  description: string;
  required: boolean;
}

export interface AcceptanceCriterion {
  id: string;
  description: string;
  relatedRequirementIds: string[];
}

export interface UnresolvedQuestion {
  id: string;
  question: string;
}

export interface RequirementsContent {
  projectGoal: string;
  problemStatement: string;
  usersAndActors: NamedRequirementsItem[];
  userStories: UserStory[];
  functionalRequirements: RequirementItem[];
  nonFunctionalRequirements: RequirementItem[];
  constraints: RequirementsTextItem[];
  integrations: RequirementsIntegration[];
  assumptions: RequirementsTextItem[];
  acceptanceCriteria: AcceptanceCriterion[];
  outOfScope: RequirementsTextItem[];
  unresolvedQuestions: UnresolvedQuestion[];
}

export const REQUIREMENTS_ROOT_FIELDS = [
  "projectGoal",
  "problemStatement",
  "usersAndActors",
  "userStories",
  "functionalRequirements",
  "nonFunctionalRequirements",
  "constraints",
  "integrations",
  "assumptions",
  "acceptanceCriteria",
  "outOfScope",
  "unresolvedQuestions",
] as const;

const ROOT_KEYS = REQUIREMENTS_ROOT_FIELDS;

function invalid(path: string, message: string): never {
  throw new PlanningDomainError(
    "PLANNING_ARTIFACT_INVALID",
    `Invalid Requirements content at ${path}: ${message}`,
    422,
    { path },
  );
}

function objectAt(value: unknown, path: string, allowedKeys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid(path, "expected an object");
  }
  const object = value as Record<string, unknown>;
  const unknownKeys = Object.keys(object).filter((key) => !allowedKeys.includes(key));
  if (unknownKeys.length > 0) invalid(path, `unknown fields: ${unknownKeys.join(", ")}`);
  return object;
}

function stringAt(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    invalid(path, "expected a non-empty string");
  }
  return value.trim().replace(/\r\n/g, "\n");
}

function idAt(value: unknown, path: string): string {
  const id = stringAt(value, path);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) {
    invalid(path, "must be a stable ID using letters, numbers, '.', '_' or '-'");
  }
  return id;
}

function booleanAt(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") invalid(path, "expected a boolean");
  return value;
}

function stringArrayAt(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) invalid(path, "expected an array");
  return value.map((item, index) => idAt(item, `${path}[${index}]`));
}

function arrayAt<T>(value: unknown, path: string, parse: (item: unknown, path: string) => T): T[] {
  if (!Array.isArray(value)) invalid(path, "expected an array");
  return value.map((item, index) => parse(item, `${path}[${index}]`));
}

function parseNamed(value: unknown, path: string): NamedRequirementsItem {
  const object = objectAt(value, path, ["id", "name", "description"]);
  return {
    id: idAt(object.id, `${path}.id`),
    name: stringAt(object.name, `${path}.name`),
    description: stringAt(object.description, `${path}.description`),
  };
}

function parseStory(value: unknown, path: string): UserStory {
  const object = objectAt(value, path, ["id", "actor", "capability", "benefit", "acceptanceCriteriaIds"]);
  return {
    id: idAt(object.id, `${path}.id`),
    actor: stringAt(object.actor, `${path}.actor`),
    capability: stringAt(object.capability, `${path}.capability`),
    benefit: stringAt(object.benefit, `${path}.benefit`),
    acceptanceCriteriaIds: stringArrayAt(object.acceptanceCriteriaIds, `${path}.acceptanceCriteriaIds`),
  };
}

function parseRequirement(value: unknown, path: string): RequirementItem {
  const object = objectAt(value, path, ["id", "title", "description"]);
  return {
    id: idAt(object.id, `${path}.id`),
    title: stringAt(object.title, `${path}.title`),
    description: stringAt(object.description, `${path}.description`),
  };
}

function parseTextItem(value: unknown, path: string): RequirementsTextItem {
  const object = objectAt(value, path, ["id", "description"]);
  return {
    id: idAt(object.id, `${path}.id`),
    description: stringAt(object.description, `${path}.description`),
  };
}

function parseIntegration(value: unknown, path: string): RequirementsIntegration {
  const object = objectAt(value, path, ["id", "name", "description", "required"]);
  return {
    id: idAt(object.id, `${path}.id`),
    name: stringAt(object.name, `${path}.name`),
    description: stringAt(object.description, `${path}.description`),
    required: booleanAt(object.required, `${path}.required`),
  };
}

function parseAcceptance(value: unknown, path: string): AcceptanceCriterion {
  const object = objectAt(value, path, ["id", "description", "relatedRequirementIds"]);
  return {
    id: idAt(object.id, `${path}.id`),
    description: stringAt(object.description, `${path}.description`),
    relatedRequirementIds: stringArrayAt(object.relatedRequirementIds, `${path}.relatedRequirementIds`),
  };
}

function parseQuestion(value: unknown, path: string): UnresolvedQuestion {
  const object = objectAt(value, path, ["id", "question"]);
  return {
    id: idAt(object.id, `${path}.id`),
    question: stringAt(object.question, `${path}.question`),
  };
}

export function parseRequirementsContent(value: unknown): RequirementsContent {
  const object = objectAt(value, "requirements", ROOT_KEYS);
  for (const key of ROOT_KEYS) {
    if (!(key in object)) invalid(`requirements.${key}`, "field is required");
  }

  const content: RequirementsContent = {
    projectGoal: stringAt(object.projectGoal, "requirements.projectGoal"),
    problemStatement: stringAt(object.problemStatement, "requirements.problemStatement"),
    usersAndActors: arrayAt(object.usersAndActors, "requirements.usersAndActors", parseNamed),
    userStories: arrayAt(object.userStories, "requirements.userStories", parseStory),
    functionalRequirements: arrayAt(object.functionalRequirements, "requirements.functionalRequirements", parseRequirement),
    nonFunctionalRequirements: arrayAt(object.nonFunctionalRequirements, "requirements.nonFunctionalRequirements", parseRequirement),
    constraints: arrayAt(object.constraints, "requirements.constraints", parseTextItem),
    integrations: arrayAt(object.integrations, "requirements.integrations", parseIntegration),
    assumptions: arrayAt(object.assumptions, "requirements.assumptions", parseTextItem),
    acceptanceCriteria: arrayAt(object.acceptanceCriteria, "requirements.acceptanceCriteria", parseAcceptance),
    outOfScope: arrayAt(object.outOfScope, "requirements.outOfScope", parseTextItem),
    unresolvedQuestions: arrayAt(object.unresolvedQuestions, "requirements.unresolvedQuestions", parseQuestion),
  };

  const idEntries: Array<[string, string]> = [];
  for (const key of ROOT_KEYS) {
    const section = content[key];
    if (Array.isArray(section)) {
      section.forEach((item) => idEntries.push([item.id, key]));
    }
  }
  const seen = new Map<string, string>();
  for (const [id, section] of idEntries) {
    const previous = seen.get(id);
    if (previous) invalid(`requirements.${section}`, `ID '${id}' is already used in ${previous}`);
    seen.set(id, section);
  }

  const acceptanceIds = new Set(content.acceptanceCriteria.map((item) => item.id));
  content.userStories.forEach((story, storyIndex) => {
    story.acceptanceCriteriaIds.forEach((id) => {
      if (!acceptanceIds.has(id)) invalid(`requirements.userStories[${storyIndex}].acceptanceCriteriaIds`, `unknown acceptance criterion '${id}'`);
    });
  });
  const requirementIds = new Set([
    ...content.functionalRequirements.map((item) => item.id),
    ...content.nonFunctionalRequirements.map((item) => item.id),
  ]);
  content.acceptanceCriteria.forEach((criterion, index) => {
    criterion.relatedRequirementIds.forEach((id) => {
      if (!requirementIds.has(id)) invalid(`requirements.acceptanceCriteria[${index}].relatedRequirementIds`, `unknown requirement '${id}'`);
    });
  });

  return content;
}

function renderList(items: readonly string[]): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "_None._";
}

export function renderRequirementsMarkdown(input: RequirementsContent): string {
  const content = parseRequirementsContent(input);
  const sections = [
    `# Requirements\n\n## Project Goal\n\n${content.projectGoal}`,
    `## Problem Statement\n\n${content.problemStatement}`,
    `## Users and Actors\n\n${renderList(content.usersAndActors.map((item) => `**${item.name}** (\`${item.id}\`) - ${item.description}`))}`,
    `## User Stories\n\n${renderList(content.userStories.map((item) => `\`${item.id}\` As ${item.actor}, I want ${item.capability}, so that ${item.benefit}. Acceptance: ${item.acceptanceCriteriaIds.length > 0 ? item.acceptanceCriteriaIds.map((id) => `\`${id}\``).join(", ") : "none linked"}`))}`,
    `## Functional Requirements\n\n${renderList(content.functionalRequirements.map((item) => `\`${item.id}\` **${item.title}** - ${item.description}`))}`,
    `## Non-Functional Requirements\n\n${renderList(content.nonFunctionalRequirements.map((item) => `\`${item.id}\` **${item.title}** - ${item.description}`))}`,
    `## Constraints\n\n${renderList(content.constraints.map((item) => `\`${item.id}\` ${item.description}`))}`,
    `## Integrations\n\n${renderList(content.integrations.map((item) => `\`${item.id}\` **${item.name}** (${item.required ? "required" : "optional"}) - ${item.description}`))}`,
    `## Assumptions\n\n${renderList(content.assumptions.map((item) => `\`${item.id}\` ${item.description}`))}`,
    `## Acceptance Criteria\n\n${renderList(content.acceptanceCriteria.map((item) => `\`${item.id}\` ${item.description}${item.relatedRequirementIds.length > 0 ? ` (Requirements: ${item.relatedRequirementIds.map((id) => `\`${id}\``).join(", ")})` : ""}`))}`,
    `## Out of Scope\n\n${renderList(content.outOfScope.map((item) => `\`${item.id}\` ${item.description}`))}`,
    `## Unresolved Questions\n\n${renderList(content.unresolvedQuestions.map((item) => `\`${item.id}\` ${item.question}`))}`,
  ];
  return `${sections.join("\n\n")}\n`;
}

export function hashRequirementsContent(input: RequirementsContent): string {
  const content = parseRequirementsContent(input);
  const hashInput = JSON.stringify({
    artifact: REQUIREMENTS_ARTIFACT_TYPE,
    schemaVersion: REQUIREMENTS_SCHEMA_VERSION,
    rendererVersion: REQUIREMENTS_RENDERER_VERSION,
    content,
  });
  return crypto.createHash("sha256").update(hashInput, "utf8").digest("hex");
}
