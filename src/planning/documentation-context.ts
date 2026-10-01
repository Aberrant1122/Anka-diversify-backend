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
  DOCUMENTATION_MEMORY_MAX_BYTES,
  DOCUMENTATION_OPERATION,
  DOCUMENTATION_PROMPT_VERSION,
  DOCUMENTATION_PROVIDER_SCHEMA_VERSION,
} from "./documentation-run-config";

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
}
