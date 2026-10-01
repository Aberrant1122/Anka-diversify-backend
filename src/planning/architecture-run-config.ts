import { WorkflowOperation } from "@prisma/client";
import { ARCHITECTURE_SCHEMA_VERSION } from "./architecture-schema";

export const ARCHITECTURE_OPERATION = WorkflowOperation.INITIAL_GENERATION;
export const ARCHITECTURE_CONTEXT_BUILDER_VERSION = "architecture-context-v1";
export const ARCHITECTURE_CONTEXT_SCHEMA_VERSION = ARCHITECTURE_SCHEMA_VERSION;
export const ARCHITECTURE_PROMPT_VERSION = "architecture-initial-generation-v1";
export const ARCHITECTURE_PROVIDER_SCHEMA_VERSION = "architecture-provider-schema-v1";
export const ARCHITECTURE_ACTIVE_RUN_STALE_MS = 15 * 60 * 1000;
export const ARCHITECTURE_MEMORY_MAX_BYTES = 16 * 1024;
export const ARCHITECTURE_MAX_INPUT_TOKENS = 64_000;
export const ARCHITECTURE_MAX_OUTPUT_TOKENS = 12_000;
