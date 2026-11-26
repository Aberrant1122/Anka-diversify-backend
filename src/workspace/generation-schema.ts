const str = { type: "string" },
  strings = { type: "array", items: str };
const object = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const array = (items: unknown) => ({ type: "array", items });
const named = object({ id: str, description: str });
const question = object({
  id: str,
  question: str,
  blocking: { type: "boolean" },
});
export const MAIN_AUTHOR_SCHEMA = object({
  purpose: str,
  requirements: array(
    object({ id: str, description: str, acceptanceCriteria: array(named) }),
  ),
  features: array(named),
  journeys: array(named),
  constraints: strings,
  exclusions: strings,
  questions: array(question),
  decisions: array(named),
});
export const ARCHITECTURE_AUTHOR_SCHEMA = object({
  overview: str,
  components: array(named),
  dataMigrations: strings,
  interfaces: strings,
  security: strings,
  operations: strings,
  repositories: array(object({ id: str, baseline: str })),
  units: array(
    object({
      id: str,
      title: str,
      requirementIds: strings,
      dependsOn: strings,
      repositoryId: str,
      files: array(
        object({
          path: str,
          action: { type: "string", enum: ["create", "modify", "delete"] },
        }),
      ),
      checks: array(
        object({
          id: str,
          criterionId: str,
          type: {
            type: "string",
            enum: ["contains", "not_contains", "json", "absent"],
          },
          path: str,
          expected: str,
        }),
      ),
      commands: array(
        object({
          id: str,
          criterionId: str,
          argv: strings,
          cwd: str,
          timeoutMs: { type: "integer" },
        }),
      ),
    }),
  ),
  questions: array(question),
});
export const CODE_PROPOSAL_SCHEMA = object({
  scopeChangeRequired: { type: "boolean" },
  reason: str,
  changes: array(
    object({
      repositoryId: str,
      path: str,
      action: { type: "string", enum: ["create", "modify", "delete"] },
      content: { type: ["string", "null"] },
    }),
  ),
});
