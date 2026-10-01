import { ArtifactLifecycleStatus, PhaseArtifact, Prisma, PrismaClient } from "@prisma/client";
import {
  hashRequirementsContent,
  parseRequirementsContent,
  renderRequirementsMarkdown,
  REQUIREMENTS_ARTIFACT_TYPE,
  REQUIREMENTS_SCHEMA_VERSION,
  RequirementsContent,
} from "./requirements-schema";
import {
  DOCUMENTATION_ARTIFACT_TYPE,
  DOCUMENTATION_SCHEMA_VERSION,
  DocumentationContent,
  hashDocumentationContent,
  parseDocumentationContent,
  renderDocumentationMarkdown,
} from "./documentation-schema";
import { DOCUMENTATION_PHASE } from "./documentation-run-config";
import { PlanningDomainError } from "./planning-errors";

export const ARCHITECTURE_PHASE = "architecture" as const;
export const REQUIREMENTS_PHASE = "requirements" as const;

export interface ApprovedAuthorityRecord<T> {
  artifact: PhaseArtifact;
  content: T;
  contentHash: string;
  approvalId: string;
  approvedAt: Date;
  approvedById: string;
}

export interface ArchitectureHandoffAuthority {
  projectId: string;
  requirements: ApprovedAuthorityRecord<RequirementsContent>;
  documentation: ApprovedAuthorityRecord<DocumentationContent>;
}

/**
 * Deterministic preflight verifying Requirements and Documentation authorities
 * prior to Architecture workflow initiation.
 *
 * Verifies exact:
 * - Requirements authority (currentApprovedArtifactId, type, schema, APPROVED lifecycle, hash, canonical Markdown, PhaseApproval record)
 * - Documentation authority (currentApprovedArtifactId, type, schema, APPROVED lifecycle, hash, canonical Markdown, PhaseApproval record)
 * - Provenance match: Documentation.sourceRequirements == current approved Requirements artifact (id, version, contentHash)
 */
export async function preflightArchitectureHandoff(
  prisma: PrismaClient | Prisma.TransactionClient,
  projectId: string,
): Promise<ArchitectureHandoffAuthority> {
  // 1. Verify Project
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, name: true },
  });
  if (!project) {
    throw new PlanningDomainError(
      "PLANNING_PROJECT_NOT_FOUND",
      "Project was not found or is not accessible.",
      404,
      { projectId },
    );
  }

  // 2. Verify Requirements Authority
  const reqState = await prisma.projectPhaseState.findUnique({
    where: { projectId_phase: { projectId, phase: REQUIREMENTS_PHASE } },
    select: { currentApprovedArtifactId: true },
  });
  if (!reqState?.currentApprovedArtifactId) {
    throw new PlanningDomainError(
      "PLANNING_ACTION_LOCKED",
      "Architecture requires approved Requirements authority.",
      409,
      { phase: REQUIREMENTS_PHASE },
    );
  }

  const reqArtifact = await prisma.phaseArtifact.findUnique({
    where: { id: reqState.currentApprovedArtifactId },
  });
  if (
    !reqArtifact ||
    reqArtifact.projectId !== projectId ||
    reqArtifact.phase !== REQUIREMENTS_PHASE ||
    reqArtifact.type !== REQUIREMENTS_ARTIFACT_TYPE ||
    reqArtifact.schemaVersion !== REQUIREMENTS_SCHEMA_VERSION ||
    reqArtifact.lifecycleStatus !== ArtifactLifecycleStatus.APPROVED ||
    !reqArtifact.approved ||
    !reqArtifact.approvedAt ||
    reqArtifact.structuredContent === null
  ) {
    throw new PlanningDomainError(
      "PLANNING_ARTIFACT_INVALID",
      "The approved Requirements authority is invalid or incomplete.",
      422,
      { artifactId: reqState.currentApprovedArtifactId },
    );
  }

  let reqContent: RequirementsContent;
  try {
    reqContent = parseRequirementsContent(reqArtifact.structuredContent);
  } catch (error) {
    throw new PlanningDomainError(
      "PLANNING_ARTIFACT_INVALID",
      "The approved Requirements structured content cannot be parsed.",
      422,
      { artifactId: reqArtifact.id },
    );
  }

  const reqHash = hashRequirementsContent(reqContent);
  if (
    !reqArtifact.contentHash ||
    reqArtifact.contentHash !== reqHash ||
    reqArtifact.content !== renderRequirementsMarkdown(reqContent)
  ) {
    throw new PlanningDomainError(
      "PLANNING_ARTIFACT_INVALID",
      "The approved Requirements authority hash or rendered markdown is corrupted.",
      422,
      { artifactId: reqArtifact.id },
    );
  }

  const reqApproval = await prisma.phaseApproval.findFirst({
    where: {
      projectId,
      phase: REQUIREMENTS_PHASE,
      artifactId: reqArtifact.id,
      artifactVersion: reqArtifact.version,
      artifactContentHash: reqHash,
      decision: "approved",
      legacyUnverified: false,
    },
    select: { id: true, createdAt: true, approvedById: true },
  });
  if (!reqApproval) {
    throw new PlanningDomainError(
      "PLANNING_ARTIFACT_INVALID",
      "The approved Requirements PhaseApproval record is missing or invalid.",
      422,
      { artifactId: reqArtifact.id },
    );
  }

  // 3. Verify Documentation Authority
  const docState = await prisma.projectPhaseState.findUnique({
    where: { projectId_phase: { projectId, phase: DOCUMENTATION_PHASE } },
    select: { currentApprovedArtifactId: true },
  });
  if (!docState?.currentApprovedArtifactId) {
    throw new PlanningDomainError(
      "PLANNING_ACTION_LOCKED",
      "Architecture requires approved Documentation authority.",
      409,
      { phase: DOCUMENTATION_PHASE },
    );
  }

  const docArtifact = await prisma.phaseArtifact.findUnique({
    where: { id: docState.currentApprovedArtifactId },
  });
  if (
    !docArtifact ||
    docArtifact.projectId !== projectId ||
    docArtifact.phase !== DOCUMENTATION_PHASE ||
    docArtifact.type !== DOCUMENTATION_ARTIFACT_TYPE ||
    docArtifact.schemaVersion !== DOCUMENTATION_SCHEMA_VERSION ||
    docArtifact.lifecycleStatus !== ArtifactLifecycleStatus.APPROVED ||
    !docArtifact.approved ||
    !docArtifact.approvedAt ||
    docArtifact.structuredContent === null
  ) {
    throw new PlanningDomainError(
      "PLANNING_ARTIFACT_INVALID",
      "The approved Documentation authority is invalid or incomplete.",
      422,
      { artifactId: docState.currentApprovedArtifactId },
    );
  }

  let docContent: DocumentationContent;
  try {
    docContent = parseDocumentationContent(docArtifact.structuredContent);
  } catch (error) {
    throw new PlanningDomainError(
      "PLANNING_ARTIFACT_INVALID",
      "The approved Documentation structured content cannot be parsed.",
      422,
      { artifactId: docArtifact.id },
    );
  }

  const docHash = hashDocumentationContent(docContent);
  if (
    !docArtifact.contentHash ||
    docArtifact.contentHash !== docHash ||
    docArtifact.content !== renderDocumentationMarkdown(docContent)
  ) {
    throw new PlanningDomainError(
      "PLANNING_ARTIFACT_INVALID",
      "The approved Documentation authority hash or rendered markdown is corrupted.",
      422,
      { artifactId: docArtifact.id },
    );
  }

  const docApproval = await prisma.phaseApproval.findFirst({
    where: {
      projectId,
      phase: DOCUMENTATION_PHASE,
      artifactId: docArtifact.id,
      artifactVersion: docArtifact.version,
      artifactContentHash: docHash,
      decision: "approved",
      legacyUnverified: false,
    },
    select: { id: true, createdAt: true, approvedById: true },
  });
  if (!docApproval) {
    throw new PlanningDomainError(
      "PLANNING_ARTIFACT_INVALID",
      "The approved Documentation PhaseApproval record is missing or invalid.",
      422,
      { artifactId: docArtifact.id },
    );
  }

  // 4. Exact Provenance Match Verification
  // Documentation.sourceRequirements must exactly reference the current approved Requirements artifact
  const source = docContent.sourceRequirements;
  if (
    source.artifactId !== reqArtifact.id ||
    source.version !== reqArtifact.version ||
    source.contentHash !== reqArtifact.contentHash
  ) {
    throw new PlanningDomainError(
      "PLANNING_ACTION_LOCKED",
      "Approved Documentation is stale: sourceRequirements does not match current approved Requirements authority.",
      409,
      {
        sourceRequirements: source,
        currentApprovedRequirements: {
          artifactId: reqArtifact.id,
          version: reqArtifact.version,
          contentHash: reqArtifact.contentHash,
        },
      },
    );
  }

  return {
    projectId,
    requirements: {
      artifact: reqArtifact,
      content: reqContent,
      contentHash: reqHash,
      approvalId: reqApproval.id,
      approvedAt: reqArtifact.approvedAt,
      approvedById: reqApproval.approvedById,
    },
    documentation: {
      artifact: docArtifact,
      content: docContent,
      contentHash: docHash,
      approvalId: docApproval.id,
      approvedAt: docArtifact.approvedAt,
      approvedById: docApproval.approvedById,
    },
  };
}
