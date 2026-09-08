/**
 * Canonical Prompt System Wrapper
 *
 * All authoritative prompts are maintained in src/ai/prompts/*.
 * Feature-specific templates, hardcoded UI components (Sidebar, Header, StatsCard, etc.),
 * calculator templates, dashboard manifests, and mock dashboard data have been removed.
 *
 * Production consumers: 0 (all migrated directly to src/ai/prompts/*).
 */

export * from "../../ai/prompts/coding";
export * from "../../ai/prompts/classification";
export * from "../../ai/prompts/repair";
export * from "../../ai/prompts/standalone";
export * from "../../ai/prompts/validation";
