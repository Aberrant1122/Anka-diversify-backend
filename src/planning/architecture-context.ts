import crypto from "crypto";
import { Prisma } from "@prisma/client";
import { ArchitectureHandoffAuthority } from "./documentation-architecture-preflight";
import { DocumentationContent } from "./documentation-schema";
import { RequirementsContent } from "./requirements-schema";
import { hashCanonical } from "./requirements-context";
import { PlanningDomainError } from "./planning-errors";
import {
  ARCHITECTURE_CONTEXT_BUILDER_VERSION, ARCHITECTURE_CONTEXT_SCHEMA_VERSION,
  ARCHITECTURE_MEMORY_MAX_BYTES, ARCHITECTURE_OPERATION,
  ARCHITECTURE_PROMPT_VERSION, ARCHITECTURE_PROVIDER_SCHEMA_VERSION,
} from "./architecture-run-config";

export interface ArchitectureSourceIdentity {
  artifactId: string; version: number; contentHash: string; schemaVersion: number;
  approvalId: string; approvedAt: string; approvedById: string;
}
export interface ArchitectureMemorySnapshot {
  id: string; version: number; lastUpdated: string; summary: string;
  byteLength: number; hash: string;
}
export interface ArchitectureContextManifest {
  target: "architecture"; operation: "INITIAL_GENERATION";
  project: { id: string; name: string; description: string | null; currentPhase: string | null };
  sourceRequirements: ArchitectureSourceIdentity;
  sourceDocumentation: ArchitectureSourceIdentity;
  includeMemory: boolean;
  memory: ArchitectureMemorySnapshot | null;
  initiator: { id: string; type: "HUMAN" };
  builderVersion: string; schemaVersion: number; promptVersion: string;
  providerSchemaVersion: string; contextHash: string; requestFingerprint: string;
}
export interface ArchitectureContextPayload {
  project: ArchitectureContextManifest["project"];
  sourceRequirements: ArchitectureSourceIdentity & { content: RequirementsContent };
  sourceDocumentation: ArchitectureSourceIdentity & { content: DocumentationContent };
  memory: ArchitectureMemorySnapshot | null;
}
export interface BuiltArchitectureContext {
  payload: ArchitectureContextPayload;
  manifest: ArchitectureContextManifest;
}

export function architectureRequestFingerprint(
  projectId: string, requirements: Pick<ArchitectureSourceIdentity, "artifactId" | "version" | "contentHash">,
  documentation: Pick<ArchitectureSourceIdentity, "artifactId" | "version" | "contentHash">,
  includeMemory: boolean,
): string {
  return hashCanonical({ projectId, operation: ARCHITECTURE_OPERATION,
    sourceRequirements: { artifactId: requirements.artifactId, version: requirements.version, contentHash: requirements.contentHash },
    sourceDocumentation: { artifactId: documentation.artifactId, version: documentation.version, contentHash: documentation.contentHash },
    includeMemory });
}

export class PlanningArchitectureContextBuilder {
  async buildInTransaction(tx: Prisma.TransactionClient, input: {
    projectId: string; actorId: string; includeMemory: boolean;
    authority: ArchitectureHandoffAuthority;
  }): Promise<BuiltArchitectureContext> {
    const project = await tx.project.findUnique({ where: { id: input.projectId }, select: {
      id: true, name: true, description: true, currentPhase: true,
      memorySummary: input.includeMemory ? { select: { id: true, version: true, lastUpdated: true, summary: true } } : false,
    } });
    if (!project) throw new PlanningDomainError("PLANNING_PROJECT_NOT_FOUND", "Project was not found or is not accessible.", 404);
    const source = (record: Pick<ArchitectureHandoffAuthority["requirements"], "artifact" | "contentHash" | "approvalId" | "approvedAt" | "approvedById">): ArchitectureSourceIdentity => ({
      artifactId: record.artifact.id, version: record.artifact.version,
      contentHash: record.contentHash, schemaVersion: record.artifact.schemaVersion,
      approvalId: record.approvalId, approvedAt: record.approvedAt.toISOString(),
      approvedById: record.approvedById,
    });
    const sourceRequirements = source(input.authority.requirements);
    const sourceDocumentation = source(input.authority.documentation);
    let memory: ArchitectureMemorySnapshot | null = null;
    if (input.includeMemory && project.memorySummary) {
      const summary = project.memorySummary.summary.replace(/\r\n?/g, "\n").trim();
      const byteLength = Buffer.byteLength(summary, "utf8");
      if (byteLength > ARCHITECTURE_MEMORY_MAX_BYTES) throw new PlanningDomainError(
        "PLANNING_INPUT_TOO_LARGE", "Project memory exceeds the configured UTF-8 byte limit.", 413,
        { input: "memory", byteLength, maxBytes: ARCHITECTURE_MEMORY_MAX_BYTES });
      memory = { id: project.memorySummary.id, version: project.memorySummary.version,
        lastUpdated: project.memorySummary.lastUpdated.toISOString(), summary, byteLength,
        hash: crypto.createHash("sha256").update(summary, "utf8").digest("hex") };
    }
    const projectSnapshot = { id: project.id, name: project.name,
      description: project.description, currentPhase: project.currentPhase };
    const payload: ArchitectureContextPayload = {
      project: projectSnapshot,
      sourceRequirements: { ...sourceRequirements, content: input.authority.requirements.content },
      sourceDocumentation: { ...sourceDocumentation, content: input.authority.documentation.content },
      memory,
    };
    const unsigned = { target: "architecture" as const, operation: ARCHITECTURE_OPERATION,
      project: projectSnapshot, sourceRequirements, sourceDocumentation,
      includeMemory: input.includeMemory, memory,
      initiator: { id: input.actorId, type: "HUMAN" as const },
      builderVersion: ARCHITECTURE_CONTEXT_BUILDER_VERSION,
      schemaVersion: ARCHITECTURE_CONTEXT_SCHEMA_VERSION,
      promptVersion: ARCHITECTURE_PROMPT_VERSION,
      providerSchemaVersion: ARCHITECTURE_PROVIDER_SCHEMA_VERSION };
    const contextHash = hashCanonical({ ...unsigned, payload });
    const requestFingerprint = architectureRequestFingerprint(input.projectId,
      sourceRequirements, sourceDocumentation, input.includeMemory);
    return { payload, manifest: { ...unsigned, contextHash, requestFingerprint } };
  }
}
