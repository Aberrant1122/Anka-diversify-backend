export const REQUIREMENTS_VERSIONS = Object.freeze({
  contextBuilder: "requirements-context-v1",
  canonicalSchema: 1,
  prompt: "requirements-initial-generation-v1",
  revisionPrompt: "requirements-revision-v1",
  providerSchema: "requirements-provider-schema-v1",
});

export const REQUIREMENTS_CONTEXT_BUILDER_VERSION = REQUIREMENTS_VERSIONS.contextBuilder;
export const REQUIREMENTS_CONTEXT_SCHEMA_VERSION = REQUIREMENTS_VERSIONS.canonicalSchema;
export const REQUIREMENTS_PROMPT_VERSION = REQUIREMENTS_VERSIONS.prompt;
export const REQUIREMENTS_REVISION_PROMPT_VERSION = REQUIREMENTS_VERSIONS.revisionPrompt;
export const REQUIREMENTS_PROVIDER_SCHEMA_VERSION = REQUIREMENTS_VERSIONS.providerSchema;

const KIB = 1024;

function configuredBytes(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export const REQUIREMENTS_INPUT_LIMITS = Object.freeze({
  briefOrFeedbackBytes: configuredBytes("PLANNING_REQUIREMENTS_TEXT_MAX_BYTES", 64 * KIB),
  canonicalArtifactJsonBytes: configuredBytes("PLANNING_REQUIREMENTS_JSON_MAX_BYTES", 256 * KIB),
  memorySummaryBytes: configuredBytes("PLANNING_REQUIREMENTS_MEMORY_MAX_BYTES", 64 * KIB),
});

export const REQUIREMENTS_ACTIVE_RUN_STALE_MS = configuredBytes(
  "PLANNING_REQUIREMENTS_RUN_STALE_MS",
  15 * 60 * 1000,
);
