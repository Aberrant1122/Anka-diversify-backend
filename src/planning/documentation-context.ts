import crypto from "crypto";
import { ArtifactLifecycleStatus, Prisma } from "@prisma/client";
import { PlanningDomainError } from "./planning-errors";
import { canonicalJson, hashCanonical } from "./requirements-context";
import {
  hashRequirementsContent,
  parseRequirementsContent,
  renderRequirementsMarkdown,
  REQUIREMENTS_ARTIFACT_TYPE,
  REQUIREMENTS_PHASE,
  REQUIREMENTS_SCHEMA_VERSION,
  RequirementsContent,
} from "./requirements-schema";
import {
  DOCUMENTATION_CONTEXT_BUILDER_VERSION,
  DOCUMENTATION_CONTEXT_SCHEMA_VERSION,
  DOCUMENTATION_FEEDBACK_PROMPT_VERSION,
  DOCUMENTATION_INPUT_LIMITS,
  DOCUMENTATION_MEMORY_MAX_BYTES,
  DOCUMENTATION_OPERATION,
  DOCUMENTATION_PHASE,
  DOCUMENTATION_PROMPT_VERSION,
  DOCUMENTATION_PROVIDER_SCHEMA_VERSION,
  DOCUMENTATION_REVISION_PROMPT_VERSION,
  DOCUMENTATION_SECTION_REGENERATION_PROMPT_VERSION,
  DOCUMENTATION_SECTION_REVISION_PROMPT_VERSION,
} from "./documentation-run-config";
import {
  DocumentationRevisionOperation,
  validateDocumentationRevisionTarget,
  ValidatedDocumentationRevisionTarget,
} from "./documentation-revision-policy";
import {
  DOCUMENTATION_ARTIFACT_TYPE,
  DOCUMENTATION_CANONICAL_JSON_MAX_BYTES,
  DOCUMENTATION_SCHEMA_VERSION,
  DocumentationContent,
  DocumentationProviderRoot,
  DocumentationValidationError,
  hashDocumentationContent,
  parseDocumentationContent,
  renderDocumentationMarkdown,
} from "./documentation-schema";

export type DocumentationRunOperation =
  | "INITIAL_GENERATION"
  | DocumentationRevisionOperation;

export interface DocumentationMemoryContext {
  id: string;
  version: number;
  lastUpdated: string;
  summary: string;
  byteLength: number;
  hash: string;
}

export interface DocumentationContextManifest {
  target: "documentation";
  operation: "INITIAL_GENERATION";
  project: { id: string; name: string; description: string | null; currentPhase: string | null };
  sourceRequirements: { artifactId: string; version: number; contentHash: string; schemaVersion: number };
  initiator: { id: string; type: "HUMAN" };
  memory: DocumentationMemoryContext | null;
  builderVersion: string;
  schemaVersion: number;
  promptVersion: string;
  providerSchemaVersion: string;
  contextHash: string;
  requestFingerprint?: string;
}

export interface DocumentationContextPayload {
  target: "documentation";
  operation: "INITIAL_GENERATION";
  project: DocumentationContextManifest["project"];
  sourceRequirements: DocumentationContextManifest["sourceRequirements"] & { content: RequirementsContent };
  initiator: { id: string; type: "HUMAN" };
  memory: DocumentationMemoryContext | null;
  versions: { builder: string; schema: number; prompt: string; providerSchema: string };
}

export interface BuiltDocumentationContext {
  payload: DocumentationContextPayload;
  manifest: DocumentationContextManifest;
  contextHash: string;
  requestFingerprint: string;
}

export interface DocumentationRevisionContextManifest {
  target: "documentation";
  operation: DocumentationRevisionOperation;
  project: { id: string; name: string; description: string | null; currentPhase: string | null };
  baseArtifact: { id: string; version: number; hash: string };
  sourceRequirements: { artifactId: string; version: number; contentHash: string; schemaVersion: number };
  instruction: { normalizedText: string; byteLength: number; hash: string; source: "submitted_feedback" | "submitted_instruction" };
  initiator: { id: string; type: "HUMAN" };
  memory: DocumentationMemoryContext | null;
  targetSectionKey?: DocumentationProviderRoot;
  allowedSectionKeys?: readonly DocumentationProviderRoot[];
  rebaseToCurrentRequirements?: boolean;
  builderVersion: string;
  schemaVersion: number;
  promptVersion: string;
  providerSchemaVersion: string;
  contextHash: string;
  requestFingerprint?: string;
}

export interface DocumentationRevisionContextPayload {
  target: "documentation";
  operation: DocumentationRevisionOperation;
  project: DocumentationRevisionContextManifest["project"];
  baseArtifact: DocumentationRevisionContextManifest["baseArtifact"] & { content: DocumentationContent };
  sourceRequirements: DocumentationRevisionContextManifest["sourceRequirements"] & { content: RequirementsContent };
  instruction: string;
  initiator: { id: string; type: "HUMAN" };
  memory: DocumentationMemoryContext | null;
  targetSectionKey?: DocumentationProviderRoot;
  allowedSectionKeys?: readonly DocumentationProviderRoot[];
  rebaseToCurrentRequirements?: boolean;
  versions: { builder: string; schema: number; prompt: string; providerSchema: string };
}

export interface BuiltDocumentationRevisionContext {
  payload: DocumentationRevisionContextPayload;
  manifest: DocumentationRevisionContextManifest;
  contextHash: string;
  requestFingerprint: string;
}

export type PreparedDocumentationContext =
  | BuiltDocumentationContext
  | BuiltDocumentationRevisionContext;


function normalizeMemory(value: string): string {
  return value.replace(/\r\n?/g, "\n").trim();
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

export class PlanningDocumentationContextBuilder {
  async buildInTransaction(tx: Prisma.TransactionClient, input: {
    projectId: string;
    actorId: string;
    includeMemory: boolean;
  }): Promise<BuiltDocumentationContext> {
    const project = await tx.project.findUnique({
      where: { id: input.projectId },
      select: {
        id: true, name: true, description: true, currentPhase: true,
        memorySummary: input.includeMemory
          ? { select: { id: true, version: true, lastUpdated: true, summary: true } }
          : false,
      },
    });
    if (!project) throw new PlanningDomainError("PLANNING_PROJECT_NOT_FOUND", "Project was not found or is not accessible.", 404);

    const requirementsState = await tx.projectPhaseState.findUnique({
      where: { projectId_phase: { projectId: input.projectId, phase: REQUIREMENTS_PHASE } },
      select: { currentApprovedArtifactId: true },
    });
    if (!requirementsState?.currentApprovedArtifactId) {
      throw new PlanningDomainError("PLANNING_ACTION_LOCKED", "Documentation generation requires approved Requirements.", 409);
    }
    const artifact = await tx.phaseArtifact.findUnique({ where: { id: requirementsState.currentApprovedArtifactId } });
    if (!artifact || artifact.projectId !== input.projectId || artifact.phase !== REQUIREMENTS_PHASE
      || artifact.type !== REQUIREMENTS_ARTIFACT_TYPE || artifact.schemaVersion !== REQUIREMENTS_SCHEMA_VERSION
      || artifact.structuredContent === null || artifact.lifecycleStatus !== ArtifactLifecycleStatus.APPROVED
      || !artifact.approved || !artifact.approvedAt) {
      throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", "The approved Requirements authority is invalid.", 422);
    }
    let requirements: RequirementsContent;
    try {
      requirements = parseRequirementsContent(artifact.structuredContent);
    } catch {
      throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", "The approved Requirements authority is invalid.", 422);
    }
    const contentHash = hashRequirementsContent(requirements);
    if (!artifact.contentHash || artifact.contentHash !== contentHash || artifact.content !== renderRequirementsMarkdown(requirements)) {
      throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", "The approved Requirements authority is corrupted.", 422);
    }
    const approval = await tx.phaseApproval.findFirst({
      where: {
        projectId: input.projectId, phase: REQUIREMENTS_PHASE, artifactId: artifact.id,
        artifactVersion: artifact.version, artifactContentHash: contentHash,
        decision: "approved", legacyUnverified: false,
      },
      select: { id: true },
    });
    if (!approval) throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", "The approved Requirements record is invalid.", 422);

    let memory: DocumentationMemoryContext | null = null;
    if (input.includeMemory && project.memorySummary) {
      const summary = normalizeMemory(project.memorySummary.summary);
      const byteLength = Buffer.byteLength(summary, "utf8");
      if (byteLength > DOCUMENTATION_MEMORY_MAX_BYTES) {
        throw new PlanningDomainError("PLANNING_INPUT_TOO_LARGE", "Project memory exceeds the configured UTF-8 byte limit.", 413, {
          input: "memory", byteLength, maxBytes: DOCUMENTATION_MEMORY_MAX_BYTES,
        });
      }
      memory = {
        id: project.memorySummary.id,
        version: project.memorySummary.version,
        lastUpdated: project.memorySummary.lastUpdated.toISOString(),
        summary,
        byteLength,
        hash: sha256(summary),
      };
    }
    const projectSnapshot = { id: project.id, name: project.name, description: project.description, currentPhase: project.currentPhase };
    const sourceRequirements = { artifactId: artifact.id, version: artifact.version, contentHash, schemaVersion: artifact.schemaVersion };
    const initiator = { id: input.actorId, type: "HUMAN" as const };
    const versions = {
      builder: DOCUMENTATION_CONTEXT_BUILDER_VERSION,
      schema: DOCUMENTATION_CONTEXT_SCHEMA_VERSION,
      prompt: DOCUMENTATION_PROMPT_VERSION,
      providerSchema: DOCUMENTATION_PROVIDER_SCHEMA_VERSION,
    };
    const unsigned = {
      target: "documentation" as const,
      operation: DOCUMENTATION_OPERATION,
      project: projectSnapshot,
      sourceRequirements,
      initiator,
      memory,
      builderVersion: versions.builder,
      schemaVersion: versions.schema,
      promptVersion: versions.prompt,
      providerSchemaVersion: versions.providerSchema,
    };
    const contextHash = hashCanonical({ ...unsigned, sourceRequirements: { ...sourceRequirements, content: requirements } });
    const requestFingerprint = hashCanonical({
      projectId: input.projectId,
      operation: DOCUMENTATION_OPERATION,
      sourceRequirementsArtifactId: artifact.id,
      sourceRequirementsVersion: artifact.version,
      sourceRequirementsHash: contentHash,
      includeMemory: input.includeMemory,
    });
    const manifest: DocumentationContextManifest = { ...unsigned, contextHash };
    const payload: DocumentationContextPayload = {
      target: "documentation", operation: DOCUMENTATION_OPERATION, project: projectSnapshot,
      sourceRequirements: { ...sourceRequirements, content: requirements }, initiator, memory, versions,
    };
    return { payload, manifest, contextHash, requestFingerprint };
  }

  async buildRevisionInTransaction(tx: Prisma.TransactionClient, input: {
    projectId: string;
    actorId: string;
    operation: DocumentationRevisionOperation;
    baseArtifactId: string;
    instruction: string;
    targetSectionKey?: string | null;
    includeMemory?: boolean;
    rebaseToCurrentRequirements?: boolean;
  }): Promise<BuiltDocumentationRevisionContext> {
    const instruction = boundedText(input.instruction, input.operation === "FEEDBACK_APPLICATION" ? "feedback" : "instruction");
    if (input.rebaseToCurrentRequirements !== undefined && input.rebaseToCurrentRequirements && input.operation !== "DOCUMENT_REVISION") {
      throw new PlanningDomainError(
        "PLANNING_ARTIFACT_INVALID",
        "rebaseToCurrentRequirements is only supported for DOCUMENT_REVISION operations.",
        422,
      );
    }

    let target: ValidatedDocumentationRevisionTarget;
    try {
      target = validateDocumentationRevisionTarget(input.operation, input.targetSectionKey);
    } catch (error) {
      if (error instanceof DocumentationValidationError) {
        throw new PlanningDomainError("PLANNING_INVALID_SECTION", error.message, 422, error.details);
      }
      throw error;
    }

    const project = await tx.project.findUnique({
      where: { id: input.projectId },
      select: {
        id: true,
        name: true,
        description: true,
        currentPhase: true,
        memorySummary: input.includeMemory
          ? { select: { id: true, version: true, lastUpdated: true, summary: true } }
          : false,
      },
    });
    if (!project) {
      throw new PlanningDomainError("PLANNING_PROJECT_NOT_FOUND", "Project was not found or is not accessible.", 404);
    }

    const baseArtifact = await tx.phaseArtifact.findUnique({
      where: { id: input.baseArtifactId },
    });
    if (
      !baseArtifact ||
      baseArtifact.projectId !== input.projectId ||
      baseArtifact.phase !== DOCUMENTATION_PHASE ||
      baseArtifact.type !== DOCUMENTATION_ARTIFACT_TYPE
    ) {
      throw new PlanningDomainError(
        "PLANNING_ARTIFACT_NOT_FOUND",
        "The Documentation base artifact was not found.",
        404,
      );
    }
    if (!baseArtifact.contentHash || baseArtifact.structuredContent === null) {
      throw new PlanningDomainError(
        "PLANNING_ARTIFACT_INVALID",
        "The Documentation base artifact is missing canonical content or its hash.",
        422,
      );
    }

    let baseContent: DocumentationContent;
    try {
      baseContent = parseDocumentationContent(baseArtifact.structuredContent);
    } catch {
      throw new PlanningDomainError(
        "PLANNING_ARTIFACT_INVALID",
        "The Documentation base artifact is not canonical.",
        422,
      );
    }
    const baseActualHash = hashDocumentationContent(baseContent);
    if (baseArtifact.contentHash !== baseActualHash || baseArtifact.content !== renderDocumentationMarkdown(baseContent)) {
      throw new PlanningDomainError(
        "PLANNING_ARTIFACT_INVALID",
        "The Documentation base artifact is corrupted.",
        422,
      );
    }
    const baseBytes = Buffer.byteLength(canonicalJson(baseContent), "utf8");
    if (baseBytes > DOCUMENTATION_INPUT_LIMITS.canonicalArtifactJsonBytes) {
      throw new PlanningDomainError(
        "PLANNING_INPUT_TOO_LARGE",
        "Canonical Documentation JSON exceeds the configured UTF-8 limit.",
        413,
        { input: "canonicalArtifactJson", byteLength: baseBytes, maxBytes: DOCUMENTATION_INPUT_LIMITS.canonicalArtifactJsonBytes },
      );
    }

    const requirementsState = await tx.projectPhaseState.findUnique({
      where: { projectId_phase: { projectId: input.projectId, phase: REQUIREMENTS_PHASE } },
      select: { currentApprovedArtifactId: true },
    });
    if (!requirementsState?.currentApprovedArtifactId) {
      throw new PlanningDomainError(
        "PLANNING_ACTION_LOCKED",
        "Documentation revision requires approved Requirements.",
        409,
      );
    }

    const currentApprovedRequirementsId = requirementsState.currentApprovedArtifactId;
    const baseSourceRequirementsId = baseContent.sourceRequirements.artifactId;
    const isUpstreamCurrent = baseSourceRequirementsId === currentApprovedRequirementsId;

    if (!isUpstreamCurrent) {
      if (input.operation !== "DOCUMENT_REVISION") {
        throw new PlanningDomainError(
          "PLANNING_ARTIFACT_INVALID",
          "Documentation base references stale Requirements authority. Rebase the whole document before applying section or feedback operations.",
          422,
          { currentApprovedRequirementsId, baseSourceRequirementsId },
        );
      }
      if (input.rebaseToCurrentRequirements !== true) {
        throw new PlanningDomainError(
          "PLANNING_ARTIFACT_INVALID",
          "Documentation base references stale Requirements authority. Explicit rebase is required.",
          422,
          { currentApprovedRequirementsId, baseSourceRequirementsId },
        );
      }
    }

    const targetReqArtifactId = currentApprovedRequirementsId;
    const reqArtifact = await tx.phaseArtifact.findUnique({
      where: { id: targetReqArtifactId },
    });
    if (
      !reqArtifact ||
      reqArtifact.projectId !== input.projectId ||
      reqArtifact.phase !== REQUIREMENTS_PHASE ||
      reqArtifact.type !== REQUIREMENTS_ARTIFACT_TYPE ||
      reqArtifact.schemaVersion !== REQUIREMENTS_SCHEMA_VERSION ||
      reqArtifact.structuredContent === null ||
      reqArtifact.lifecycleStatus !== ArtifactLifecycleStatus.APPROVED ||
      !reqArtifact.approved ||
      !reqArtifact.approvedAt
    ) {
      throw new PlanningDomainError(
        "PLANNING_ARTIFACT_INVALID",
        "The approved Requirements authority is invalid.",
        422,
      );
    }

    let requirements: RequirementsContent;
    try {
      requirements = parseRequirementsContent(reqArtifact.structuredContent);
    } catch {
      throw new PlanningDomainError(
        "PLANNING_ARTIFACT_INVALID",
        "The approved Requirements authority is invalid.",
        422,
      );
    }
    const reqHash = hashRequirementsContent(requirements);
    if (!reqArtifact.contentHash || reqArtifact.contentHash !== reqHash || reqArtifact.content !== renderRequirementsMarkdown(requirements)) {
      throw new PlanningDomainError(
        "PLANNING_ARTIFACT_INVALID",
        "The approved Requirements authority is corrupted.",
        422,
      );
    }
    const approval = await tx.phaseApproval.findFirst({
      where: {
        projectId: input.projectId,
        phase: REQUIREMENTS_PHASE,
        artifactId: reqArtifact.id,
        artifactVersion: reqArtifact.version,
        artifactContentHash: reqHash,
        decision: "approved",
        legacyUnverified: false,
      },
      select: { id: true },
    });
    if (!approval) {
      throw new PlanningDomainError(
        "PLANNING_ARTIFACT_INVALID",
        "The approved Requirements record is invalid.",
        422,
      );
    }

    let memory: DocumentationMemoryContext | null = null;
    if (input.includeMemory && project.memorySummary) {
      const summary = normalizeMemory(project.memorySummary.summary);
      const byteLength = Buffer.byteLength(summary, "utf8");
      if (byteLength > DOCUMENTATION_MEMORY_MAX_BYTES) {
        throw new PlanningDomainError("PLANNING_INPUT_TOO_LARGE", "Project memory exceeds the configured UTF-8 byte limit.", 413, {
          input: "memory",
          byteLength,
          maxBytes: DOCUMENTATION_MEMORY_MAX_BYTES,
        });
      }
      memory = {
        id: project.memorySummary.id,
        version: project.memorySummary.version,
        lastUpdated: project.memorySummary.lastUpdated.toISOString(),
        summary,
        byteLength,
        hash: sha256(summary),
      };
    }

    const projectSnapshot = {
      id: project.id,
      name: project.name,
      description: project.description,
      currentPhase: project.currentPhase,
    };
    const baseArtifactSnapshot = {
      id: baseArtifact.id,
      version: baseArtifact.version,
      hash: baseArtifact.contentHash,
    };
    const sourceRequirements = {
      artifactId: reqArtifact.id,
      version: reqArtifact.version,
      contentHash: reqHash,
      schemaVersion: reqArtifact.schemaVersion,
    };
    const initiator = { id: input.actorId, type: "HUMAN" as const };
    const promptVersion = revisionPromptVersion(input.operation);
    const versions = {
      builder: DOCUMENTATION_CONTEXT_BUILDER_VERSION,
      schema: DOCUMENTATION_CONTEXT_SCHEMA_VERSION,
      prompt: promptVersion,
      providerSchema: DOCUMENTATION_PROVIDER_SCHEMA_VERSION,
    };

    const unsignedManifest = {
      target: "documentation" as const,
      operation: input.operation,
      project: projectSnapshot,
      baseArtifact: baseArtifactSnapshot,
      sourceRequirements,
      instruction: {
        normalizedText: instruction,
        byteLength: Buffer.byteLength(instruction, "utf8"),
        hash: sha256(instruction),
        source: input.operation === "FEEDBACK_APPLICATION" ? ("submitted_feedback" as const) : ("submitted_instruction" as const),
      },
      initiator,
      memory,
      ...(target.targetSectionKey ? {
        targetSectionKey: target.targetSectionKey,
        allowedSectionKeys: target.allowedSectionKeys!,
      } : {}),
      ...(input.rebaseToCurrentRequirements ? { rebaseToCurrentRequirements: true } : {}),
      builderVersion: versions.builder,
      schemaVersion: versions.schema,
      promptVersion: versions.prompt,
      providerSchemaVersion: versions.providerSchema,
    };

    const contextHash = hashCanonical({
      ...unsignedManifest,
      baseArtifact: {
        ...baseArtifactSnapshot,
        content: baseContent,
      },
      sourceRequirements: {
        ...sourceRequirements,
        content: requirements,
      },
    });

    const requestFingerprint = hashCanonical({
      projectId: input.projectId,
      operation: input.operation,
      baseArtifactId: baseArtifact.id,
      baseArtifactHash: baseArtifact.contentHash,
      sourceRequirementsArtifactId: sourceRequirements.artifactId,
      sourceRequirementsVersion: sourceRequirements.version,
      sourceRequirementsHash: sourceRequirements.contentHash,
      targetSectionKey: target.targetSectionKey ?? null,
      instructionHash: sha256(instruction),
      includeMemory: input.includeMemory === true,
      rebaseToCurrentRequirements: input.rebaseToCurrentRequirements === true,
    });

    const manifest: DocumentationRevisionContextManifest = {
      ...unsignedManifest,
      contextHash,
    };

    const payload: DocumentationRevisionContextPayload = {
      target: "documentation",
      operation: input.operation,
      project: projectSnapshot,
      baseArtifact: {
        ...baseArtifactSnapshot,
        content: baseContent,
      },
      sourceRequirements: {
        ...sourceRequirements,
        content: requirements,
      },
      instruction,
      initiator,
      memory,
      ...(target.targetSectionKey ? {
        targetSectionKey: target.targetSectionKey,
        allowedSectionKeys: target.allowedSectionKeys!,
      } : {}),
      ...(input.rebaseToCurrentRequirements ? { rebaseToCurrentRequirements: true } : {}),
      versions,
    };

    return { payload, manifest, contextHash, requestFingerprint };
  }
}

function revisionPromptVersion(operation: DocumentationRevisionOperation): string {
  switch (operation) {
    case "FEEDBACK_APPLICATION":
      return DOCUMENTATION_FEEDBACK_PROMPT_VERSION;
    case "SECTION_REVISION":
      return DOCUMENTATION_SECTION_REVISION_PROMPT_VERSION;
    case "SECTION_REGENERATION":
      return DOCUMENTATION_SECTION_REGENERATION_PROMPT_VERSION;
    case "DOCUMENT_REVISION":
    default:
      return DOCUMENTATION_REVISION_PROMPT_VERSION;
  }
}

function boundedText(value: string, kind: "instruction" | "feedback" | "memory"): string {
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  if (!normalized && kind !== "memory") {
    throw new PlanningDomainError(
      "PLANNING_ARTIFACT_INVALID",
      kind === "feedback" ? "Explicit revision feedback is required." : "Explicit revision instruction is required.",
      422,
      { input: kind },
    );
  }
  const limit = kind === "memory"
    ? DOCUMENTATION_INPUT_LIMITS.memorySummaryBytes
    : DOCUMENTATION_INPUT_LIMITS.briefOrFeedbackBytes;
  const byteLength = Buffer.byteLength(normalized, "utf8");
  if (byteLength > limit) {
    throw new PlanningDomainError(
      "PLANNING_INPUT_TOO_LARGE",
      `Documentation ${kind} exceeds the configured UTF-8 byte limit.`,
      413,
      { input: kind, byteLength, maxBytes: limit },
    );
  }
  return normalized;
}
