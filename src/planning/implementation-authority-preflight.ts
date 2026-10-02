import { ArtifactLifecycleStatus, PhaseArtifact, Prisma, PrismaClient } from "@prisma/client";
import { PlanningAuthorizationService } from "../services/planning-authorization.service";
import { PlanningArchitectureArtifactService } from "../services/planning-architecture-artifact.service";
import { PlanningArchitectureReadinessService } from "../services/planning-architecture-readiness.service";
import { prisma } from "../services/database";
import { ARCHITECTURE_ARTIFACT_TYPE, ARCHITECTURE_SCHEMA_VERSION, ArchitectureContent } from "./architecture-schema";
import { ApprovedAuthorityRecord, preflightArchitectureHandoff } from "./documentation-architecture-preflight";
import { PlanningDomainError } from "./planning-errors";
import { canonicalJson, hashCanonical } from "./requirements-context";

export interface ImplementationAuthority {
  readonly projectId: string;
  readonly actorId: string;
  readonly projectPhase: string;
  readonly implementationStatus: string;
  readonly requirements: Awaited<ReturnType<typeof preflightArchitectureHandoff>>["requirements"];
  readonly documentation: Awaited<ReturnType<typeof preflightArchitectureHandoff>>["documentation"];
  readonly architecture: ApprovedAuthorityRecord<ArchitectureContent>;
  readonly fingerprint: string;
}

const authorization = new PlanningAuthorizationService(prisma);
const architectureArtifacts = new PlanningArchitectureArtifactService(prisma);
const readiness = new PlanningArchitectureReadinessService();

export async function resolveImplementationAuthority(
  tx: Prisma.TransactionClient,
  projectId: string,
  actorId: string,
): Promise<ImplementationAuthority> {
  if (!actorId) throw new PlanningDomainError("PLANNING_PROJECT_NOT_FOUND", "Project was not found or is not accessible.", 404);
  await authorization.assertCanEditInTransaction(tx, projectId, actorId);
  const actor = await tx.user.findUnique({ where: { id: actorId }, select: { status: true } });
  if (actor?.status !== "active")
    throw new PlanningDomainError("PLANNING_FORBIDDEN", "An active project editor is required for Implementation execution.", 403);
  const [project, implementationState, architectureState] = await Promise.all([
    tx.project.findUnique({ where: { id: projectId }, select: { currentPhase: true } }),
    tx.projectPhaseState.findUnique({ where: { projectId_phase: { projectId, phase: "implementation" } } }),
    tx.projectPhaseState.findUnique({ where: { projectId_phase: { projectId, phase: "architecture" } } }),
  ]);
  if (!project || project.currentPhase !== "implementation" || !implementationState ||
      !["not_started", "in_progress"].includes(implementationState.status) ||
      !architectureState || architectureState.status !== "approved" ||
      !architectureState.currentApprovedArtifactId ||
      architectureState.currentArtifactId !== architectureState.currentApprovedArtifactId ||
      architectureState.activeRunId || architectureState.approvalCandidateArtifactId) {
    throw new PlanningDomainError("PLANNING_ACTION_LOCKED", "Implementation requires a current approved Architecture and eligible phase.", 409);
  }
  const upstream = await preflightArchitectureHandoff(tx, projectId);
  if (canonicalJson(upstream.requirements.artifact.structuredContent) !== canonicalJson(upstream.requirements.content) ||
      canonicalJson(upstream.documentation.artifact.structuredContent) !== canonicalJson(upstream.documentation.content))
    throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", "Approved upstream content is not canonical.", 422);
  const artifact = await tx.phaseArtifact.findUnique({ where: { id: architectureState.currentApprovedArtifactId } });
  if (!artifact || artifact.projectId !== projectId || artifact.phase !== "architecture" ||
      artifact.type !== ARCHITECTURE_ARTIFACT_TYPE || artifact.schemaVersion !== ARCHITECTURE_SCHEMA_VERSION ||
      artifact.lifecycleStatus !== ArtifactLifecycleStatus.APPROVED || !artifact.approved || !artifact.approvedAt) {
    throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", "Approved Architecture authority is invalid.", 422);
  }
  const content = architectureArtifacts.validatePersisted(artifact, upstream);
  const result = readiness.evaluateArchitecture(artifact, upstream);
  if (!result.ready) throw new PlanningDomainError("PLANNING_READINESS_BLOCKED", "Approved Architecture is not ready for Implementation.", 422, { blockers: result.blockers });
  const approval = await tx.phaseApproval.findFirst({ where: { projectId, phase: "architecture", artifactId: artifact.id,
    artifactVersion: artifact.version, artifactContentHash: artifact.contentHash, decision: "approved", legacyUnverified: false },
    select: { id: true, approvedAt: true, approvedById: true } });
  if (!approval || approval.approvedAt.toISOString() !== artifact.approvedAt.toISOString())
    throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", "Approved Architecture decision is invalid.", 422);
  for (const record of [upstream.requirements, upstream.documentation]) {
    const decision = await tx.phaseApproval.findUnique({ where: { id: record.approvalId }, select: { approvedAt: true, approvedById: true } });
    if (!decision || decision.approvedAt.toISOString() !== record.approvedAt.toISOString() || decision.approvedById !== record.approvedById)
      throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", "Approved planning decision is invalid.", 422);
  }
  const identity = (item: { artifact: PhaseArtifact; approvalId: string; approvedAt: Date; approvedById: string }) => ({
    artifactId: item.artifact.id, version: item.artifact.version, contentHash: item.artifact.contentHash,
    approvalId: item.approvalId, approvedAt: item.approvedAt.toISOString(), approvedById: item.approvedById,
  });
  const architecture = { artifact, content, contentHash: artifact.contentHash!, approvalId: approval.id,
    approvedAt: artifact.approvedAt, approvedById: approval.approvedById };
  for (const [phase, record] of [["requirements", upstream.requirements],
      ["documentation", upstream.documentation], ["architecture", architecture]] as const) {
    const latestApproved = await tx.phaseArtifact.findFirst({ where: { projectId, phase, approved: true },
      orderBy: { version: "desc" }, select: { id: true } });
    if (latestApproved?.id !== record.artifact.id)
      throw new PlanningDomainError("PLANNING_ACTION_LOCKED", "A planning authority pointer is superseded.", 409, { phase });
  }
  const fingerprint = hashCanonical({ projectId, projectPhase: project.currentPhase,
    implementationStatus: implementationState.status,
    requirements: identity(upstream.requirements), documentation: identity(upstream.documentation), architecture: identity(architecture) });
  return { ...upstream, actorId, projectPhase: project.currentPhase, implementationStatus: implementationState.status,
    architecture, fingerprint };
}

export async function currentImplementationAuthority(client: PrismaClient, projectId: string, actorId: string): Promise<ImplementationAuthority> {
  return client.$transaction((tx) => resolveImplementationAuthority(tx, projectId, actorId),
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function assertImplementationAuthorityCurrent(client: PrismaClient, accepted: ImplementationAuthority): Promise<ImplementationAuthority> {
  const current = await currentImplementationAuthority(client, accepted.projectId, accepted.actorId);
  if (current.fingerprint !== accepted.fingerprint)
    throw new PlanningDomainError("PLANNING_CONTEXT_CHANGED", "Implementation planning authority changed during execution.", 409);
  return current;
}
