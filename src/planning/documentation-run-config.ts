import { WorkflowOperation } from "@prisma/client";
import { DOCUMENTATION_SCHEMA_VERSION } from "./documentation-schema";
import { REQUIREMENTS_INPUT_LIMITS } from "./requirements-run-config";

export const DOCUMENTATION_PHASE = "documentation" as const;
export const DOCUMENTATION_OPERATION = WorkflowOperation.INITIAL_GENERATION;
export const DOCUMENTATION_CONTEXT_BUILDER_VERSION = "documentation-context-v1";
export const DOCUMENTATION_CONTEXT_SCHEMA_VERSION = DOCUMENTATION_SCHEMA_VERSION;
export const DOCUMENTATION_PROMPT_VERSION = "documentation-initial-generation-v1";
export const DOCUMENTATION_PROVIDER_SCHEMA_VERSION = "documentation-provider-schema-v1";
export const DOCUMENTATION_ACTIVE_RUN_STALE_MS = 15 * 60 * 1000;
export const DOCUMENTATION_MEMORY_MAX_BYTES = REQUIREMENTS_INPUT_LIMITS.memorySummaryBytes;
export const DOCUMENTATION_MAX_OUTPUT_TOKENS = 8_000;
