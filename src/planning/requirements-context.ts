import crypto from "crypto";
import { PrismaClient, WorkflowOperation } from "@prisma/client";
import { PlanningDomainError } from "./planning-errors";
import {
  parseRequirementsContent,
  REQUIREMENTS_ARTIFACT_TYPE,
  REQUIREMENTS_PHASE,
  RequirementsContent,
} from "./requirements-schema";
import {
  REQUIREMENTS_CONTEXT_BUILDER_VERSION,
  REQUIREMENTS_CONTEXT_SCHEMA_VERSION,
  REQUIREMENTS_INPUT_LIMITS,
  REQUIREMENTS_PROMPT_VERSION,
  REQUIREMENTS_PROVIDER_SCHEMA_VERSION,
  REQUIREMENTS_REVISION_PROMPT_VERSION,
} from "./requirements-run-config";

export type RequirementsRunOperation =
  | "INITIAL_GENERATION"
  | "DOCUMENT_REVISION"
  | "SECTION_REVISION"
  | "SECTION_REGENERATION"
  | "FEEDBACK_APPLICATION";

export type RequirementsRevisionOperation = Exclude<RequirementsRunOperation, "INITIAL_GENERATION">;

export const REQUIREMENTS_RUN_OPERATIONS: readonly RequirementsRunOperation[] = Object.freeze([
  "INITIAL_GENERATION",
  "DOCUMENT_REVISION",
  "SECTION_REVISION",
  "SECTION_REGENERATION",
  "FEEDBACK_APPLICATION",
]);

export interface RequirementsProjectSnapshot {
  id: string;
  name: string;
  description: string | null;
  currentPhase: string | null;
}

export interface RequirementsMemoryContext {
  id: string;
  version: number;
  lastUpdated: string;
  summary: string;
  byteLength: number;
  hash: string;
}

export interface RequirementsContextManifest {
  target: "requirements";
  operation: RequirementsRunOperation;
  project: RequirementsProjectSnapshot;
  initiator: { id: string; type: "HUMAN" };
  brief?: { normalizedText: string; byteLength: number; hash: string; source: "submitted_brief" };
  baseArtifact?: { id: string; version: number; hash: string };
  instruction?: { normalizedText: string; byteLength: number; hash: string; source: "submitted_feedback" };
  memory?: RequirementsMemoryContext;
  targetSectionKey?: string;
  builderVersion: string;
  schemaVersion: number;
  promptVersion: string;
  providerSchemaVersion: string;
  contextHash: string;
}

export interface InitialRequirementsContextPayload {
  target: "requirements";
  operation: "INITIAL_GENERATION";
  project: RequirementsProjectSnapshot;
  brief: string;
  initiator: { id: string; type: "HUMAN" };
  memory?: RequirementsMemoryContext;
  versions: { builder: string; schema: number; prompt: string; providerSchema: string };
}

export interface RevisionRequirementsContextPayload {
  target: "requirements";
  operation: RequirementsRevisionOperation;
  project: RequirementsProjectSnapshot;
  baseArtifact: { id: string; version: number; hash: string; content: RequirementsContent };
  instruction: string;
  initiator: { id: string; type: "HUMAN" };
  memory?: RequirementsMemoryContext;
  targetSectionKey?: string;
  versions: { builder: string; schema: number; prompt: string; providerSchema: string };
}

export interface BuiltRequirementsContext<TPayload> {
  payload: TPayload;
  manifest: RequirementsContextManifest;
  contextHash: string;
}

function normalizeText(value: string): string {
  return value.replace(/\r\n?/g, "\n").trim();
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((result, key) => {
        const child = (value as Record<string, unknown>)[key];
        if (child !== undefined) result[key] = canonicalize(child);
        return result;
      }, {});
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function hashCanonical(value: unknown): string {
  return sha256(canonicalJson(value));
}

function boundedText(value: string, kind: "brief" | "feedback" | "memory"): string {
  const normalized = normalizeText(value);
  if (!normalized && kind !== "memory") {
    throw new PlanningDomainError(
      kind === "brief" ? "PLANNING_BRIEF_REQUIRED" : "PLANNING_ARTIFACT_INVALID",
      kind === "brief" ? "An explicit Requirements brief is required." : "Explicit revision feedback is required.",
      422,
      { input: kind },
    );
  }
  const limit = kind === "memory"
    ? REQUIREMENTS_INPUT_LIMITS.memorySummaryBytes
    : REQUIREMENTS_INPUT_LIMITS.briefOrFeedbackBytes;
  const byteLength = Buffer.byteLength(normalized, "utf8");
  if (byteLength > limit) {
    throw new PlanningDomainError(
      "PLANNING_INPUT_TOO_LARGE",
      `Requirements ${kind} exceeds the configured UTF-8 byte limit.`,
      413,
      { input: kind, byteLength, maxBytes: limit },
    );
  }
  return normalized;
}

export class PlanningRequirementsContextBuilder {
  constructor(private readonly prisma: PrismaClient) {}

  async buildInitial(input: {
    projectId: string;
    actorId: string;
    brief: string;
    includeMemory?: boolean;
  }): Promise<BuiltRequirementsContext<InitialRequirementsContextPayload>> {
    const brief = boundedText(input.brief, "brief");
    const { project, memory } = await this.loadProject(input.projectId, input.includeMemory === true);
    const initiator = { id: input.actorId, type: "HUMAN" as const };
    const versions = this.versions();
    const payload: InitialRequirementsContextPayload = {
      target: "requirements",
      operation: WorkflowOperation.INITIAL_GENERATION,
      project,
      brief,
      initiator,
      ...(memory ? { memory } : {}),
      versions,
    };
    const unsigned = {
      target: "requirements" as const,
      operation: WorkflowOperation.INITIAL_GENERATION,
      project,
      initiator,
      brief: {
        normalizedText: brief,
        byteLength: Buffer.byteLength(brief, "utf8"),
        hash: sha256(brief),
        source: "submitted_brief" as const,
      },
      ...(memory ? { memory } : {}),
      builderVersion: versions.builder,
      schemaVersion: versions.schema,
      promptVersion: versions.prompt,
      providerSchemaVersion: versions.providerSchema,
    };
    return this.finish(payload, unsigned);
  }

  async buildRevision(input: {
    projectId: string;
    actorId: string;
    operation: RequirementsRevisionOperation;
    baseArtifactId: string;
    instruction: string;
    targetSectionKey?: string;
    includeMemory?: boolean;
  }): Promise<BuiltRequirementsContext<RevisionRequirementsContextPayload>> {
    const instruction = boundedText(input.instruction, "feedback");
    const targetSectionKey = input.targetSectionKey ? normalizeText(input.targetSectionKey) : undefined;
    if (
      (input.operation === WorkflowOperation.SECTION_REVISION ||
        input.operation === WorkflowOperation.SECTION_REGENERATION) &&
      !targetSectionKey
    ) {
      throw new PlanningDomainError(
        "PLANNING_ARTIFACT_INVALID",
        "targetSectionKey is required for a section-scoped Requirements operation.",
        422,
        { field: "targetSectionKey" },
      );
    }
    const [{ project, memory }, artifact] = await Promise.all([
      this.loadProject(input.projectId, input.includeMemory === true),
      this.prisma.phaseArtifact.findUnique({ where: { id: input.baseArtifactId } }),
    ]);
    if (
      !artifact || artifact.projectId !== input.projectId || artifact.phase !== REQUIREMENTS_PHASE ||
      artifact.type !== REQUIREMENTS_ARTIFACT_TYPE
    ) {
      throw new PlanningDomainError(
        "PLANNING_ARTIFACT_NOT_FOUND",
        "The Requirements base artifact was not found.",
        404,
      );
    }
    if (!artifact.contentHash || artifact.structuredContent === null) {
      throw new PlanningDomainError(
        "PLANNING_ARTIFACT_INVALID",
        "The Requirements base artifact is missing canonical content or its hash.",
        422,
      );
    }
    const content = parseRequirementsContent(artifact.structuredContent);
    const contentBytes = Buffer.byteLength(canonicalJson(content), "utf8");
    if (contentBytes > REQUIREMENTS_INPUT_LIMITS.canonicalArtifactJsonBytes) {
      throw new PlanningDomainError(
        "PLANNING_INPUT_TOO_LARGE",
        "Canonical Requirements JSON exceeds the configured UTF-8 byte limit.",
        413,
        { input: "canonicalArtifactJson", byteLength: contentBytes, maxBytes: REQUIREMENTS_INPUT_LIMITS.canonicalArtifactJsonBytes },
      );
    }
    const initiator = { id: input.actorId, type: "HUMAN" as const };
    const versions = this.versions(input.operation);
    const baseArtifact = { id: artifact.id, version: artifact.version, hash: artifact.contentHash };
    const payload: RevisionRequirementsContextPayload = {
      target: "requirements",
      operation: input.operation,
      project,
      baseArtifact: { ...baseArtifact, content },
      instruction,
      initiator,
      ...(memory ? { memory } : {}),
      ...(targetSectionKey ? { targetSectionKey } : {}),
      versions,
    };
    const unsigned = {
      target: "requirements" as const,
      operation: input.operation,
      project,
      initiator,
      baseArtifact,
      instruction: {
        normalizedText: instruction,
        byteLength: Buffer.byteLength(instruction, "utf8"),
        hash: sha256(instruction),
        source: "submitted_feedback" as const,
      },
      ...(memory ? { memory } : {}),
      ...(targetSectionKey ? { targetSectionKey } : {}),
      builderVersion: versions.builder,
      schemaVersion: versions.schema,
      promptVersion: versions.prompt,
      providerSchemaVersion: versions.providerSchema,
    };
    return this.finish(payload, unsigned);
  }

  private versions(operation: RequirementsRunOperation = WorkflowOperation.INITIAL_GENERATION) {
    return {
      builder: REQUIREMENTS_CONTEXT_BUILDER_VERSION,
      schema: REQUIREMENTS_CONTEXT_SCHEMA_VERSION,
      prompt: operation !== WorkflowOperation.INITIAL_GENERATION
        ? REQUIREMENTS_REVISION_PROMPT_VERSION
        : REQUIREMENTS_PROMPT_VERSION,
      providerSchema: REQUIREMENTS_PROVIDER_SCHEMA_VERSION,
    };
  }

  private finish<TPayload>(payload: TPayload, unsigned: Omit<RequirementsContextManifest, "contextHash">): BuiltRequirementsContext<TPayload> {
    const contextHash = hashCanonical(unsigned);
    return { payload, manifest: { ...unsigned, contextHash }, contextHash };
  }

  private async loadProject(projectId: string, includeMemory: boolean): Promise<{
    project: RequirementsProjectSnapshot;
    memory?: RequirementsMemoryContext;
  }> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        name: true,
        description: true,
        currentPhase: true,
        memorySummary: includeMemory
          ? { select: { id: true, version: true, lastUpdated: true, summary: true } }
          : false,
      },
    });
    if (!project) {
      throw new PlanningDomainError("PLANNING_PROJECT_NOT_FOUND", "Project was not found or is not accessible.", 404);
    }
    const snapshot: RequirementsProjectSnapshot = {
      id: project.id,
      name: project.name,
      description: project.description,
      currentPhase: project.currentPhase,
    };
    if (!includeMemory || !project.memorySummary) return { project: snapshot };
    const summary = boundedText(project.memorySummary.summary, "memory");
    return {
      project: snapshot,
      memory: {
        id: project.memorySummary.id,
        version: project.memorySummary.version,
        lastUpdated: project.memorySummary.lastUpdated.toISOString(),
        summary,
        byteLength: Buffer.byteLength(summary, "utf8"),
        hash: sha256(summary),
      },
    };
  }
}
