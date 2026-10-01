import crypto from "crypto";
import {
  ArtifactActorType,
  ArtifactChangeKind,
  ArtifactLifecycleStatus,
  PhaseArtifact,
  Prisma,
  PrismaClient,
  ProjectPhaseState,
  WorkflowOperation,
  WorkflowRun,
} from "@prisma/client";
import {
  BuiltDocumentationContext,
  BuiltDocumentationRevisionContext,
  DocumentationContextManifest,
  DocumentationRevisionContextManifest,
  DocumentationRunOperation,
  PlanningDocumentationContextBuilder,
  PreparedDocumentationContext,
} from "../planning/documentation-context";
import {
  DOCUMENTATION_ACTIVE_RUN_STALE_MS,
  DOCUMENTATION_OPERATION,
  DOCUMENTATION_PHASE,
} from "../planning/documentation-run-config";
import {
  computeDocumentationDiff,
  DocumentationDeterministicDiff,
  DOCUMENTATION_REVISION_OPERATIONS,
  DocumentationRevisionOperation,
  isNoOpDocumentationRevision,
  validateDocumentationRevisionStableIds,
  validateDocumentationSectionScope,
} from "../planning/documentation-revision-policy";
import {
  assembleDocumentationContent,
  traceabilityMatches,
  validateDocumentationGraph,
} from "../planning/documentation-assembly";
import {
  DOCUMENTATION_ARTIFACT_TYPE,
  DocumentationContent,
  DocumentationProviderDraft,
  DocumentationValidationError,
  hashDocumentationContent,
  parseDocumentationContent,
  parseDocumentationProviderDraft,
} from "../planning/documentation-schema";
import { PlanningDomainError } from "../planning/planning-errors";
import { canonicalJson, hashCanonical } from "../planning/requirements-context";
import {
  hashRequirementsContent,
  parseRequirementsContent,
  REQUIREMENTS_PHASE,
} from "../planning/requirements-schema";
import { PlanningAuthorizationService } from "./planning-authorization.service";
import { PlanningDocumentationArtifactService } from "./planning-documentation-artifact.service";
import {
  DocumentationReadiness,
  PlanningDocumentationReadinessService,
} from "./planning-documentation-readiness.service";

const MAX_TRANSACTION_ATTEMPTS = 3;
type PersistedManifest = (DocumentationContextManifest | DocumentationRevisionContextManifest) & { requestFingerprint: string };

export interface DocumentationGenerationAudit {
  modelUsage: Prisma.InputJsonObject;
  costUSD: number | null;
}

export interface DocumentationRunFailure {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export type StartDocumentationRunInput =
  | {
      projectId: string;
      actorId: string;
      operation: "INITIAL_GENERATION";
      idempotencyKey: string;
      includeMemory?: boolean;
    }
  | {
      projectId: string;
      actorId: string;
      operation: DocumentationRevisionOperation;
      idempotencyKey: string;
      baseArtifactId: string;
      instruction: string;
      targetSectionKey?: string | null;
      includeMemory?: boolean;
      rebaseToCurrentRequirements?: boolean;
    };

export type StartDocumentationRunResult =
  | { run: WorkflowRun; context: PreparedDocumentationContext; reused: false }
  | { run: WorkflowRun; context: null; reused: true };

export interface FinalizeDocumentationRunResult {
  run: WorkflowRun;
  artifact: PhaseArtifact;
  readiness: DocumentationReadiness;
}

export interface FinalizeDocumentationRevisionInput {
  projectId: string;
  runId: string;
  actorId: string;
  structuredContent: unknown;
  audit: DocumentationGenerationAudit;
}

export interface FinalizeDocumentationRevisionResult {
  run: WorkflowRun;
  artifact: PhaseArtifact;
  readiness: DocumentationReadiness;
  diff: DocumentationDeterministicDiff;
}

function isRetryable(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2002" || error.code === "P2034");
}

function scopedKey(raw: string): string {
  const key = raw.trim();
  if (!key) throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", "Idempotency-Key is required for a Documentation AI operation.", 422, { field: "Idempotency-Key" });
  return `documentation:${crypto.createHash("sha256").update(key, "utf8").digest("hex")}`;
}

function manifestFrom(run: WorkflowRun): PersistedManifest | null {
  if (!run.contextManifest || typeof run.contextManifest !== "object" || Array.isArray(run.contextManifest)) return null;
  const value = run.contextManifest as Record<string, unknown>;
  return typeof value.requestFingerprint === "string" ? value as unknown as PersistedManifest : null;
}

function matchesPersistedRequest(input: StartDocumentationRunInput, run: WorkflowRun, manifest: PersistedManifest | null): boolean {
  if (!manifest || run.operation !== input.operation || manifest.operation !== input.operation || manifest.project?.id !== input.projectId) return false;
  const source = manifest.sourceRequirements;
  if (!source || typeof source.artifactId !== "string" || typeof source.version !== "number" || typeof source.contentHash !== "string") return false;
  if (input.operation === "INITIAL_GENERATION") {
    return manifest.requestFingerprint === hashCanonical({
      projectId: input.projectId,
      operation: input.operation,
      sourceRequirementsArtifactId: source.artifactId,
      sourceRequirementsVersion: source.version,
      sourceRequirementsHash: source.contentHash,
      includeMemory: input.includeMemory === true,
    });
  }
  if (!("baseArtifact" in manifest) || !("instruction" in manifest) || !manifest.baseArtifact || !manifest.instruction
    || manifest.baseArtifact.id !== input.baseArtifactId || run.baseArtifactId !== input.baseArtifactId
    || typeof manifest.baseArtifact.hash !== "string") return false;
  const instruction = input.instruction.replace(/\r\n?/g, "\n").trim();
  return manifest.requestFingerprint === hashCanonical({
    projectId: input.projectId,
    operation: input.operation,
    baseArtifactId: input.baseArtifactId,
    baseArtifactHash: manifest.baseArtifact.hash,
    sourceRequirementsArtifactId: source.artifactId,
    sourceRequirementsVersion: source.version,
    sourceRequirementsHash: source.contentHash,
    targetSectionKey: typeof input.targetSectionKey === "string" ? input.targetSectionKey.trim() : null,
    instructionHash: crypto.createHash("sha256").update(instruction, "utf8").digest("hex"),
    includeMemory: input.includeMemory === true,
    rebaseToCurrentRequirements: input.rebaseToCurrentRequirements === true,
  });
}

function failureJson(failure: DocumentationRunFailure): string {
  return canonicalJson({ message: failure.message.slice(0, 8_192), ...(failure.details ? { details: failure.details } : {}) });
}

function revisionChangeKind(operation: DocumentationRevisionOperation): ArtifactChangeKind {
  switch (operation) {
    case "DOCUMENT_REVISION":
      return ArtifactChangeKind.AI_DOCUMENT_REVISION;
    case "FEEDBACK_APPLICATION":
      return ArtifactChangeKind.FEEDBACK_APPLICATION;
    case "SECTION_REVISION":
      return ArtifactChangeKind.AI_SECTION_REVISION;
    case "SECTION_REGENERATION":
      return ArtifactChangeKind.AI_SECTION_REGENERATION;
  }
}

export class PlanningDocumentationRunService {
  private readonly authorization: PlanningAuthorizationService;
  private readonly contexts: PlanningDocumentationContextBuilder;
  private readonly artifacts: PlanningDocumentationArtifactService;
  private readonly readiness: PlanningDocumentationReadinessService;

  constructor(private readonly prisma: PrismaClient, dependencies: {
    authorization?: PlanningAuthorizationService;
    contexts?: PlanningDocumentationContextBuilder;
    artifacts?: PlanningDocumentationArtifactService;
    readiness?: PlanningDocumentationReadinessService;
  } = {}) {
    this.authorization = dependencies.authorization ?? new PlanningAuthorizationService(prisma);
    this.contexts = dependencies.contexts ?? new PlanningDocumentationContextBuilder();
    this.artifacts = dependencies.artifacts ?? new PlanningDocumentationArtifactService(prisma, this.authorization);
    this.readiness = dependencies.readiness ?? new PlanningDocumentationReadinessService();
  }

  async start(input: StartDocumentationRunInput): Promise<StartDocumentationRunResult> {
    const idempotencyKey = scopedKey(input.idempotencyKey);
    for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          await this.authorization.assertCanEditInTransaction(tx, input.projectId, input.actorId);
          const existing = await tx.workflowRun.findUnique({
            where: { projectId_idempotencyKey: { projectId: input.projectId, idempotencyKey } },
          });
          if (existing) {
            if (!matchesPersistedRequest(input, existing, manifestFrom(existing))) {
              throw new PlanningDomainError(
                "PLANNING_IDEMPOTENCY_CONFLICT",
                "The Idempotency-Key was already used with different Documentation request content.",
                409,
                { runId: existing.id },
              );
            }
            return { run: existing, context: null, reused: true };
          }
          const isInitial = input.operation === WorkflowOperation.INITIAL_GENERATION;
          const context: PreparedDocumentationContext = isInitial
            ? await this.contexts.buildInTransaction(tx, {
              projectId: input.projectId,
              actorId: input.actorId,
              includeMemory: input.includeMemory === true,
            })
            : await this.contexts.buildRevisionInTransaction(tx, {
              projectId: input.projectId,
              actorId: input.actorId,
              operation: input.operation,
              baseArtifactId: input.baseArtifactId,
              instruction: input.instruction,
              targetSectionKey: input.targetSectionKey,
              includeMemory: input.includeMemory === true,
              rebaseToCurrentRequirements: input.rebaseToCurrentRequirements === true,
            });

          let state = await tx.projectPhaseState.upsert({
            where: { projectId_phase: { projectId: input.projectId, phase: DOCUMENTATION_PHASE } },
            update: {},
            create: { projectId: input.projectId, phase: DOCUMENTATION_PHASE },
          });

          if (isInitial) {
            if (state.currentArtifactId) {
              throw new PlanningDomainError(
                "PLANNING_INITIAL_ARTIFACT_EXISTS",
                "Documentation already has an initial artifact.",
                409,
                { currentArtifactId: state.currentArtifactId },
              );
            }
          } else {
            if (!state.currentArtifactId) {
              throw new PlanningDomainError(
                "PLANNING_ARTIFACT_NOT_FOUND",
                "Documentation has no current artifact to revise.",
                404,
              );
            }
            if (state.currentArtifactId !== input.baseArtifactId) {
              throw new PlanningDomainError(
                "PLANNING_ARTIFACT_BASE_CHANGED",
                "The Documentation base artifact is no longer current.",
                409,
                { expectedBaseArtifactId: input.baseArtifactId, currentArtifactId: state.currentArtifactId },
              );
            }

            const baseArtifact = await tx.phaseArtifact.findUnique({
              where: { id: input.baseArtifactId },
              select: { lifecycleStatus: true, contentHash: true },
            });
            if (
              state.status === "awaiting_approval" ||
              state.approvalCandidateArtifactId !== null ||
              baseArtifact?.lifecycleStatus === ArtifactLifecycleStatus.AWAITING_APPROVAL
            ) {
              throw new PlanningDomainError(
                "PLANNING_ACTION_LOCKED",
                "Documentation AI revision is locked while awaiting human approval.",
                409,
                { status: state.status, candidateId: state.approvalCandidateArtifactId },
              );
            }
            const allowedStatuses = ["in_progress", "changes_requested", "approved"];
            if (!allowedStatuses.includes(state.status)) {
              throw new PlanningDomainError(
                "PLANNING_ACTION_LOCKED",
                `Revision is locked while Documentation is '${state.status}'.`,
                409,
                { status: state.status },
              );
            }
          }

          if (state.activeRunId) state = await this.recoverOrReject(tx, state);

          const persistedManifest: PersistedManifest = {
            ...context.manifest,
            requestFingerprint: context.requestFingerprint,
          };

          const run = await tx.workflowRun.create({
            data: {
              projectId: input.projectId,
              triggerType: "manual",
              currentPhase: DOCUMENTATION_PHASE,
              status: "running",
              operation: input.operation,
              baseArtifactId: isInitial ? null : input.baseArtifactId,
              inputArtifactId: isInitial
                ? (context as BuiltDocumentationContext).manifest.sourceRequirements.artifactId
                : input.baseArtifactId,
              outputArtifactId: null,
              contextManifest: persistedManifest as unknown as Prisma.InputJsonValue,
              contextHash: context.contextHash,
              targetSectionKey: !isInitial && input.targetSectionKey ? input.targetSectionKey : null,
              initiatedById: input.actorId,
              initiatedByType: ArtifactActorType.HUMAN,
              idempotencyKey,
            },
          });

          const leaseWhere = isInitial
            ? { id: state.id, stateVersion: state.stateVersion, activeRunId: null, currentArtifactId: null }
            : { id: state.id, stateVersion: state.stateVersion, activeRunId: null, currentArtifactId: input.baseArtifactId };

          const leased = await tx.projectPhaseState.updateMany({
            where: leaseWhere,
            data: { activeRunId: run.id, stateVersion: { increment: 1 } },
          });
          if (leased.count !== 1) {
            throw new PlanningDomainError("PLANNING_GENERATION_IN_PROGRESS", "Another Documentation AI operation acquired the active run lease.", 409);
          }

          return { run, context, reused: false };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        if (error instanceof PlanningDomainError || !isRetryable(error)) throw error;
        if (attempt === MAX_TRANSACTION_ATTEMPTS) break;
      }
    }
    throw new PlanningDomainError("PLANNING_CONCURRENT_UPDATE", "Could not acquire the Documentation run lease.", 409);
  }

  async finalize(input: {
    projectId: string;
    runId: string;
    actorId: string;
    structuredContent: unknown;
    audit: DocumentationGenerationAudit;
  }): Promise<FinalizeDocumentationRunResult> {
    for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          await this.authorization.assertCanEditInTransaction(tx, input.projectId, input.actorId);
          const run = await tx.workflowRun.findFirst({
            where: {
              id: input.runId,
              projectId: input.projectId,
              currentPhase: DOCUMENTATION_PHASE,
              operation: WorkflowOperation.INITIAL_GENERATION,
            },
          });
          const manifest = run ? manifestFrom(run) as (DocumentationContextManifest & { requestFingerprint: string }) | null : null;
          if (
            !run ||
            run.status !== "running" ||
            !manifest ||
            run.initiatedById !== input.actorId ||
            manifest.target !== "documentation" ||
            manifest.operation !== DOCUMENTATION_OPERATION ||
            run.contextHash !== manifest.contextHash ||
            run.inputArtifactId !== manifest.sourceRequirements.artifactId
          ) {
            throw new PlanningDomainError("PLANNING_CONTEXT_CHANGED", "The Documentation generation run is no longer current.", 409, { runId: input.runId });
          }

          const [state, requirementsState, requirementsArtifact, project] = await Promise.all([
            tx.projectPhaseState.findUnique({ where: { projectId_phase: { projectId: input.projectId, phase: DOCUMENTATION_PHASE } } }),
            tx.projectPhaseState.findUnique({ where: { projectId_phase: { projectId: input.projectId, phase: REQUIREMENTS_PHASE } }, select: { currentApprovedArtifactId: true } }),
            tx.phaseArtifact.findUnique({ where: { id: manifest.sourceRequirements.artifactId } }),
            tx.project.findUnique({ where: { id: input.projectId }, select: { id: true, name: true, description: true, currentPhase: true, memorySummary: true } }),
          ]);
          if (
            !state ||
            state.activeRunId !== run.id ||
            state.currentArtifactId !== null ||
            requirementsState?.currentApprovedArtifactId !== manifest.sourceRequirements.artifactId ||
            !requirementsArtifact ||
            requirementsArtifact.version !== manifest.sourceRequirements.version ||
            requirementsArtifact.contentHash !== manifest.sourceRequirements.contentHash ||
            !project
          ) {
            throw new PlanningDomainError("PLANNING_CONTEXT_CHANGED", "Documentation authority changed before generation could be persisted.", 409, { runId: run.id });
          }

          const requirements = parseRequirementsContent(requirementsArtifact.structuredContent);
          if (
            hashRequirementsContent(requirements) !== manifest.sourceRequirements.contentHash ||
            canonicalJson(manifest.project) !== canonicalJson({ id: project.id, name: project.name, description: project.description, currentPhase: project.currentPhase })
          ) {
            throw new PlanningDomainError("PLANNING_CONTEXT_CHANGED", "Documentation context changed before generation could be persisted.", 409, { runId: run.id });
          }

          if (manifest.memory) {
            const summary = project.memorySummary?.summary.replace(/\r\n?/g, "\n").trim();
            const hash = summary === undefined ? null : crypto.createHash("sha256").update(summary, "utf8").digest("hex");
            if (
              !project.memorySummary ||
              project.memorySummary.id !== manifest.memory.id ||
              project.memorySummary.version !== manifest.memory.version ||
              hash !== manifest.memory.hash
            ) {
              throw new PlanningDomainError("PLANNING_CONTEXT_CHANGED", "Opted-in project memory changed during Documentation generation.", 409, { runId: run.id });
            }
          }

          const { artifact, state: artifactState } = await this.artifacts.createInitialArtifactInTransaction(tx, {
            projectId: input.projectId,
            actorId: input.actorId,
            title: "Documentation v1",
            structuredContent: input.structuredContent,
            createdByType: ArtifactActorType.AI,
            changeKind: ArtifactChangeKind.INITIAL_GENERATION,
          });
          if (artifactState.id !== state.id || artifactState.stateVersion !== state.stateVersion) {
            throw new PlanningDomainError("PLANNING_CONTEXT_CHANGED", "Documentation state changed during finalization.", 409, { runId: run.id });
          }

          const advanced = await tx.projectPhaseState.updateMany({
            where: { id: state.id, stateVersion: state.stateVersion, activeRunId: run.id, currentArtifactId: null },
            data: {
              status: "in_progress",
              startedAt: state.startedAt ?? new Date(),
              currentArtifactId: artifact.id,
              approvalCandidateArtifactId: null,
              activeRunId: null,
              stateVersion: { increment: 1 },
            },
          });
          if (advanced.count !== 1) throw new PlanningDomainError("PLANNING_CONTEXT_CHANGED", "Documentation changed concurrently during finalization.", 409, { runId: run.id });

          await tx.project.update({ where: { id: input.projectId }, data: { currentPhase: DOCUMENTATION_PHASE } });
          const validated = await this.artifacts.validatePersistedArtifactInTransaction(tx, input.projectId, artifact);
          const readiness = this.readiness.evaluateDocumentation({
            artifact,
            historicalRequirements: validated.historicalRequirements,
            currentApprovedRequirements: validated.currentApprovedRequirements,
          });

          const completed = await tx.workflowRun.updateMany({
            where: { id: run.id, status: "running", outputArtifactId: null },
            data: {
              status: "completed",
              outputArtifactId: artifact.id,
              modelUsage: input.audit.modelUsage,
              costUSD: input.audit.costUSD,
              completedAt: new Date(),
              errorCode: null,
              errorMessage: null,
            },
          });
          if (completed.count !== 1) throw new PlanningDomainError("PLANNING_CONTEXT_CHANGED", "Documentation run changed concurrently during completion.", 409, { runId: run.id });

          return { run: await tx.workflowRun.findUniqueOrThrow({ where: { id: run.id } }), artifact, readiness };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        if (error instanceof PlanningDomainError || !isRetryable(error)) throw error;
        if (attempt === MAX_TRANSACTION_ATTEMPTS) break;
      }
    }
    throw new PlanningDomainError("PLANNING_CONCURRENT_UPDATE", "Documentation generation could not be finalized because planning state changed concurrently.", 409);
  }

  async finalizeRevision(input: FinalizeDocumentationRevisionInput): Promise<FinalizeDocumentationRevisionResult> {
    for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          await this.authorization.assertCanEditInTransaction(tx, input.projectId, input.actorId);

          const run = await tx.workflowRun.findFirst({
            where: {
              id: input.runId,
              projectId: input.projectId,
              currentPhase: DOCUMENTATION_PHASE,
            },
          });

          const manifest = run ? manifestFrom(run) as (DocumentationRevisionContextManifest & { requestFingerprint: string }) | null : null;
          if (
            !run ||
            run.status !== "running" ||
            !manifest ||
            run.initiatedById !== input.actorId ||
            manifest.target !== "documentation" ||
            !DOCUMENTATION_REVISION_OPERATIONS.includes(run.operation as DocumentationRevisionOperation) ||
            manifest.operation !== run.operation ||
            run.contextHash !== manifest.contextHash ||
            run.baseArtifactId !== manifest.baseArtifact.id
          ) {
            throw new PlanningDomainError("PLANNING_CONTEXT_CHANGED", "The Documentation revision run is no longer current.", 409, { runId: input.runId });
          }

          const [state, baseArtifact, requirementsState, requirementsArtifact, project] = await Promise.all([
            tx.projectPhaseState.findUnique({ where: { projectId_phase: { projectId: input.projectId, phase: DOCUMENTATION_PHASE } } }),
            tx.phaseArtifact.findUnique({ where: { id: manifest.baseArtifact.id } }),
            tx.projectPhaseState.findUnique({ where: { projectId_phase: { projectId: input.projectId, phase: REQUIREMENTS_PHASE } }, select: { currentApprovedArtifactId: true } }),
            tx.phaseArtifact.findUnique({ where: { id: manifest.sourceRequirements.artifactId } }),
            tx.project.findUnique({ where: { id: input.projectId }, select: { id: true, name: true, description: true, currentPhase: true, memorySummary: true } }),
          ]);

          if (
            !state ||
            state.activeRunId !== run.id ||
            state.currentArtifactId !== manifest.baseArtifact.id ||
            state.approvalCandidateArtifactId !== null ||
            !baseArtifact ||
            baseArtifact.version !== manifest.baseArtifact.version ||
            baseArtifact.contentHash !== manifest.baseArtifact.hash ||
            baseArtifact.lifecycleStatus === ArtifactLifecycleStatus.AWAITING_APPROVAL ||
            requirementsState?.currentApprovedArtifactId !== manifest.sourceRequirements.artifactId ||
            !requirementsArtifact ||
            requirementsArtifact.version !== manifest.sourceRequirements.version ||
            requirementsArtifact.contentHash !== manifest.sourceRequirements.contentHash ||
            !project
          ) {
            throw new PlanningDomainError("PLANNING_CONTEXT_CHANGED", "Documentation authority changed before revision could be persisted.", 409, { runId: run.id });
          }

          const requirements = parseRequirementsContent(requirementsArtifact.structuredContent);
          if (
            hashRequirementsContent(requirements) !== manifest.sourceRequirements.contentHash ||
            canonicalJson(manifest.project) !== canonicalJson({ id: project.id, name: project.name, description: project.description, currentPhase: project.currentPhase })
          ) {
            throw new PlanningDomainError("PLANNING_CONTEXT_CHANGED", "Documentation context changed before revision could be persisted.", 409, { runId: run.id });
          }

          if (manifest.memory) {
            const summary = project.memorySummary?.summary.replace(/\r\n?/g, "\n").trim();
            const hash = summary === undefined ? null : crypto.createHash("sha256").update(summary, "utf8").digest("hex");
            if (
              !project.memorySummary ||
              project.memorySummary.id !== manifest.memory.id ||
              project.memorySummary.version !== manifest.memory.version ||
              hash !== manifest.memory.hash
            ) {
              throw new PlanningDomainError("PLANNING_CONTEXT_CHANGED", "Opted-in project memory changed during Documentation revision.", 409, { runId: run.id });
            }
          }

          // Parse and assemble content
          let draft: DocumentationProviderDraft;
          try {
            draft = parseDocumentationProviderDraft(input.structuredContent);
          } catch (error) {
            throw new PlanningDomainError(
              "PLANNING_AI_INVALID_RESPONSE",
              "The model returned invalid Documentation content.",
              502,
              { details: error instanceof Error ? error.message : String(error) },
            );
          }

          let assembledContent: DocumentationContent;
          try {
            assembledContent = assembleDocumentationContent(
              draft,
              {
                artifactId: manifest.sourceRequirements.artifactId,
                version: manifest.sourceRequirements.version,
                contentHash: manifest.sourceRequirements.contentHash,
              },
              requirements,
            );
          } catch (error) {
            const size = error instanceof DocumentationValidationError && error.code === "DOCUMENTATION_SIZE_EXCEEDED";
            throw new PlanningDomainError(
              size ? "PLANNING_AI_OUTPUT_TOO_LARGE" : "PLANNING_AI_INVALID_RESPONSE",
              size ? "Generated Documentation exceeds the canonical size limit." : "The model returned invalid Documentation content.",
              502,
            );
          }

          try {
            validateDocumentationGraph(assembledContent, requirements);
          } catch (error) {
            throw new PlanningDomainError(
              "PLANNING_ARTIFACT_INVALID",
              "The assembled Documentation graph is invalid.",
              422,
              { details: error instanceof Error ? error.message : String(error) },
            );
          }

          if (!traceabilityMatches(assembledContent, requirements)) {
            throw new PlanningDomainError(
              "PLANNING_ARTIFACT_INVALID",
              "The Documentation Requirements traceability is invalid.",
              422,
            );
          }

          const baseContent = parseDocumentationContent(baseArtifact.structuredContent);
          try {
            validateDocumentationRevisionStableIds(baseContent, assembledContent);
          } catch (error) {
            throw new PlanningDomainError(
              "PLANNING_ARTIFACT_INVALID",
              error instanceof Error ? error.message : "Stable ID violation in Documentation revision.",
              422,
              error instanceof DocumentationValidationError ? error.details : undefined,
            );
          }

          const diff = computeDocumentationDiff(baseContent, assembledContent);

          if (run.operation === "SECTION_REVISION" || run.operation === "SECTION_REGENERATION") {
            try {
              validateDocumentationSectionScope(
                manifest.targetSectionKey!,
                manifest.allowedSectionKeys!,
                diff.changedRootSections,
              );
            } catch (error) {
              throw new PlanningDomainError(
                "PLANNING_SECTION_SCOPE_VIOLATION",
                error instanceof Error ? error.message : "Documentation section operation changed roots outside its dependency closure.",
                422,
                error instanceof DocumentationValidationError ? error.details : undefined,
              );
            }
          }

          const provenanceChanged = manifest.rebaseToCurrentRequirements === true
            && (baseContent.sourceRequirements.artifactId !== assembledContent.sourceRequirements.artifactId
              || baseContent.sourceRequirements.version !== assembledContent.sourceRequirements.version
              || baseContent.sourceRequirements.contentHash !== assembledContent.sourceRequirements.contentHash);
          if (!provenanceChanged && isNoOpDocumentationRevision(baseContent, assembledContent)) {
            throw new PlanningDomainError(
              "PLANNING_REVISION_NO_CHANGES",
              "Documentation revision produced no canonical changes.",
              422,
            );
          }

          const changeKind = revisionChangeKind(run.operation as DocumentationRevisionOperation);
          const { artifact, state: artifactState } = await this.artifacts.createSuccessorVersionInTransaction(tx, {
            projectId: input.projectId,
            actorId: input.actorId,
            baseArtifactId: baseArtifact.id,
            baseContentHash: baseArtifact.contentHash!,
            title: baseArtifact.title,
            structuredContent: assembledContent,
            createdByType: ArtifactActorType.AI,
            changeKind,
          });

          if (artifactState.id !== state.id || artifactState.stateVersion !== state.stateVersion) {
            throw new PlanningDomainError("PLANNING_CONTEXT_CHANGED", "Documentation state changed during finalization.", 409, { runId: run.id });
          }

          // Advance state: currentArtifactId becomes successor, activeRunId is released.
          // currentApprovedArtifactId is intentionally untouched!
          const advanced = await tx.projectPhaseState.updateMany({
            where: {
              id: state.id,
              stateVersion: state.stateVersion,
              activeRunId: run.id,
              currentArtifactId: baseArtifact.id,
            },
            data: {
              status: "in_progress",
              currentArtifactId: artifact.id,
              approvalCandidateArtifactId: null,
              activeRunId: null,
              stateVersion: { increment: 1 },
            },
          });
          if (advanced.count !== 1) {
            throw new PlanningDomainError("PLANNING_CONTEXT_CHANGED", "Documentation changed concurrently during finalization.", 409, { runId: run.id });
          }

          await tx.project.update({ where: { id: input.projectId }, data: { currentPhase: DOCUMENTATION_PHASE } });
          const validated = await this.artifacts.validatePersistedArtifactInTransaction(tx, input.projectId, artifact);
          const readiness = this.readiness.evaluateDocumentation({
            artifact,
            historicalRequirements: validated.historicalRequirements,
            currentApprovedRequirements: validated.currentApprovedRequirements,
          });

          const completed = await tx.workflowRun.updateMany({
            where: { id: run.id, status: "running", outputArtifactId: null },
            data: {
              status: "completed",
              outputArtifactId: artifact.id,
              modelUsage: input.audit.modelUsage,
              costUSD: input.audit.costUSD,
              completedAt: new Date(),
              errorCode: null,
              errorMessage: null,
            },
          });
          if (completed.count !== 1) {
            throw new PlanningDomainError("PLANNING_CONTEXT_CHANGED", "Documentation run changed concurrently during completion.", 409, { runId: run.id });
          }

          return {
            run: await tx.workflowRun.findUniqueOrThrow({ where: { id: run.id } }),
            artifact,
            readiness,
            diff,
          };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        if (error instanceof PlanningDomainError || !isRetryable(error)) throw error;
        if (attempt === MAX_TRANSACTION_ATTEMPTS) break;
      }
    }
    throw new PlanningDomainError("PLANNING_CONCURRENT_UPDATE", "Documentation revision could not be finalized because planning state changed concurrently.", 409);
  }

  async finish(projectId: string, runId: string, status: "failed" | "conflicted" | "cancelled", failure: DocumentationRunFailure, audit?: DocumentationGenerationAudit): Promise<WorkflowRun> {
    return this.prisma.$transaction(async (tx) => {
      const run = await tx.workflowRun.findFirst({ where: { id: runId, projectId, currentPhase: DOCUMENTATION_PHASE } });
      if (!run) throw new PlanningDomainError("PLANNING_PROJECT_NOT_FOUND", "Documentation run was not found or is not accessible.", 404);
      if (run.status === status) return run;
      if (run.status !== "running") throw new PlanningDomainError("PLANNING_CONTEXT_CHANGED", "Documentation run is already terminal.", 409, { runId, status: run.status });
      const updated = await tx.workflowRun.update({
        where: { id: run.id },
        data: {
          status,
          completedAt: new Date(),
          errorCode: failure.code,
          errorMessage: failureJson(failure),
          ...(audit ? { modelUsage: audit.modelUsage, costUSD: audit.costUSD } : {}),
        },
      });
      await tx.projectPhaseState.updateMany({
        where: { projectId, phase: DOCUMENTATION_PHASE, activeRunId: run.id },
        data: { activeRunId: null, stateVersion: { increment: 1 } },
      });
      return updated;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  private async recoverOrReject(tx: Prisma.TransactionClient, state: ProjectPhaseState): Promise<ProjectPhaseState> {
    if (!state.activeRunId) return state;
    const active = await tx.workflowRun.findUnique({ where: { id: state.activeRunId } });
    const stale = active?.status === "running" && Date.now() - active.startedAt.getTime() > DOCUMENTATION_ACTIVE_RUN_STALE_MS;
    if (active?.status === "running" && !stale) {
      throw new PlanningDomainError("PLANNING_GENERATION_IN_PROGRESS", "A Documentation AI operation is already in progress.", 409, { activeRunId: active.id });
    }
    if (active && stale) {
      await tx.workflowRun.update({
        where: { id: active.id },
        data: {
          status: "failed",
          completedAt: new Date(),
          errorCode: "PLANNING_STALE_RUN_RECOVERED",
          errorMessage: failureJson({ code: "PLANNING_STALE_RUN_RECOVERED", message: "The abandoned Documentation run lease expired and was recovered by a later request." }),
        },
      });
    }
    return tx.projectPhaseState.update({ where: { id: state.id }, data: { activeRunId: null, stateVersion: { increment: 1 } } });
  }
}
