import {
  parseRequirementsContent,
  REQUIREMENTS_ROOT_FIELDS,
  RequirementsContent,
} from "./requirements-schema";

const idSchema = {
  type: "string",
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
} as const;

const textSchema = { type: "string", minLength: 1 } as const;

function objectArray(properties: Record<string, unknown>, required: readonly string[]) {
  return {
    type: "array",
    items: {
      type: "object",
      additionalProperties: false,
      properties,
      required: [...required],
    },
  };
}

export const REQUIREMENTS_PROVIDER_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    projectGoal: textSchema,
    problemStatement: textSchema,
    usersAndActors: objectArray(
      { id: idSchema, name: textSchema, description: textSchema },
      ["id", "name", "description"],
    ),
    userStories: objectArray(
      {
        id: idSchema,
        actor: textSchema,
        capability: textSchema,
        benefit: textSchema,
        acceptanceCriteriaIds: { type: "array", items: idSchema },
      },
      ["id", "actor", "capability", "benefit", "acceptanceCriteriaIds"],
    ),
    functionalRequirements: objectArray(
      { id: idSchema, title: textSchema, description: textSchema },
      ["id", "title", "description"],
    ),
    nonFunctionalRequirements: objectArray(
      { id: idSchema, title: textSchema, description: textSchema },
      ["id", "title", "description"],
    ),
    constraints: objectArray({ id: idSchema, description: textSchema }, ["id", "description"]),
    integrations: objectArray(
      { id: idSchema, name: textSchema, description: textSchema, required: { type: "boolean" } },
      ["id", "name", "description", "required"],
    ),
    assumptions: objectArray({ id: idSchema, description: textSchema }, ["id", "description"]),
    acceptanceCriteria: objectArray(
      {
        id: idSchema,
        description: textSchema,
        relatedRequirementIds: { type: "array", items: idSchema },
      },
      ["id", "description", "relatedRequirementIds"],
    ),
    outOfScope: objectArray({ id: idSchema, description: textSchema }, ["id", "description"]),
    unresolvedQuestions: objectArray({ id: idSchema, question: textSchema }, ["id", "question"]),
  },
  required: [...REQUIREMENTS_ROOT_FIELDS],
};

export function validateGeneratedRequirements(parsed: unknown): {
  valid: boolean;
  errors?: string[];
  data?: RequirementsContent;
} {
  try {
    return { valid: true, data: parseRequirementsContent(parsed) };
  } catch (error) {
    return {
      valid: false,
      errors: [error instanceof Error ? error.message : "Requirements validation failed."],
    };
  }
}
