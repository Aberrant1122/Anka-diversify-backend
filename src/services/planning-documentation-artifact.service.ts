import {
  ArtifactActorType,
  ArtifactChangeKind,
  ArtifactLifecycleStatus,
  PhaseArtifact,
  Prisma,
  PrismaClient,
  ProjectPhaseState,
} from "@prisma/client";
import {
  traceabilityMatches,
  validateDocumentationGraph,
} from "../planning/documentation-assembly";
import {
  DOCUMENTATION_ARTIFACT_TYPE,
  DOCUMENTATION_CANONICAL_JSON_MAX_BYTES,
  DOCUMENTATION_SCHEMA_VERSION,
  DocumentationContent,
  DocumentationValidationError,
  hashDocumentationContent,
  parseDocumentationContent,
  renderDocumentationMarkdown,
} from "../planning/documentation-schema";
import { PlanningDomainError } from "../planning/planning-errors";
import { canonicalJson } from "../planning/requirements-context";
import {
  hashRequirementsContent,
  parseRequirementsContent,
  renderRequirementsMarkdown,
  REQUIREMENTS_ARTIFACT_TYPE,
  REQUIREMENTS_PHASE,
  REQUIREMENTS_SCHEMA_VERSION,
  RequirementsContent,
} from "../planning/requirements-schema";
import { PlanningAuthorizationService } from "./planning-authorization.service";

export const DOCUMENTATION_PHASE = "documentation" as const;

const MAX_TRANSACTION_ATTEMPTS = 3;
const INITIAL_CHANGE_KINDS = new Set<ArtifactChangeKind>([
  ArtifactChangeKind.INITIAL_GENERATION,
  ArtifactChangeKind.IMPORT,
]);
const SUCCESSOR_CHANGE_KINDS = new Set<ArtifactChangeKind>([
  ArtifactChangeKind.MANUAL_EDIT,
  ArtifactChangeKind.AI_DOCUMENT_REVISION,
  ArtifactChangeKind.AI_SECTION_REVISION,
  ArtifactChangeKind.AI_SECTION_REGENERATION,
  ArtifactChangeKind.FEEDBACK_APPLICATION,
  ArtifactChangeKind.IMPORT,
]);

export interface CreateInitialDocumentationArtifactInput {
  projectId: string;
  actorId: string;
  title: string;
  structuredContent: unknown;
  createdByType?: ArtifactActorType;
  changeKind?: ArtifactChangeKind;
}

export interface CreateDocumentationSuccessorInput {
  projectId: string;
  actorId: string;
  baseArtifactId: string;
  baseContentHash: string;
  title?: string;
  structuredContent: unknown;
  createdByType?: ArtifactActorType;
  changeKind?: ArtifactChangeKind;
}

export interface ValidatedDocumentationArtifact {
  content: DocumentationContent;
  historicalRequirements: RequirementsContent;
  currentApprovedRequirements: {
    artifactId: string;
    version: number;
    contentHash: string;
  };
}

function isRetryableTransactionError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError
    && (error.code === "P2002" || error.code === "P2034");
}

export class PlanningDocumentationArtifactService {
  private readonly authorization: PlanningAuthorizationService;

  constructor(
    private readonly prisma: PrismaClient,
    authorization?: PlanningAuthorizationService,
  ) {
    this.authorization = authorization ?? new PlanningAuthorizationService(prisma);
  }

  async createInitialArtifact(input: CreateInitialDocumentationArtifactInput): Promise<PhaseArtifact> {
    return this.withVersionRetry(() => this.prisma.$transaction(async (tx) => {
      await this.authorization.assertCanEditInTransaction(tx, input.projectId, input.actorId);
      const { artifact, state } = await this.createInitialArtifactInTransaction(tx, input);

      const advanced = await tx.projectPhaseState.updateMany({
        where: { id: state.id, stateVersion: state.stateVersion, status: state.status },
        data: {
          status: "in_progress",
          startedAt: state.startedAt ?? new Date(),
          currentArtifactId: artifact.id,
          stateVersion: { increment: 1 },
        },
      });
      if (advanced.count !== 1) this.concurrentUpdate();
      await tx.project.update({ where: { id: input.projectId }, data: { currentPhase: DOCUMENTATION_PHASE } });
      return artifact;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
  }

  /** Transaction-aware primitive shared by synchronous creation and WorkflowRun finalization. */
  async createInitialArtifactInTransaction(
    tx: Prisma.TransactionClient,
    input: CreateInitialDocumentationArtifactInput,
  ): Promise<{ artifact: PhaseArtifact; state: ProjectPhaseState }> {
    const content = await this.validateCanonicalContentInTransaction(tx, input.projectId, input.structuredContent);
    const state = await tx.projectPhaseState.upsert({
      where: { projectId_phase: { projectId: input.projectId, phase: DOCUMENTATION_PHASE } },
      update: {},
      create: { projectId: input.projectId, phase: DOCUMENTATION_PHASE },
    });
    this.assertAction(state.status, "create_initial_artifact");
    const existing = await tx.phaseArtifact.findFirst({
      where: { projectId: input.projectId, phase: DOCUMENTATION_PHASE, type: DOCUMENTATION_ARTIFACT_TYPE },
      select: { id: true },
    });
    if (existing) {
      throw new PlanningDomainError(
        "PLANNING_INITIAL_ARTIFACT_EXISTS",
        "Documentation already has an initial artifact; create a successor version instead.",
        409,
        { currentArtifactId: state.currentArtifactId ?? existing.id },
      );
    }
    const changeKind = input.changeKind ?? ArtifactChangeKind.INITIAL_GENERATION;
    this.assertChangeKind(changeKind, INITIAL_CHANGE_KINDS, "initial Documentation artifact");
    const artifact = await this.createVersion(tx, {
      projectId: input.projectId,
      actorId: input.actorId,
      title: input.title,
      content,
      version: 1,
      previousVersionId: null,
      basedOnArtifactId: null,
      createdByType: input.createdByType ?? ArtifactActorType.HUMAN,
      changeKind,
    });
    return { artifact, state };
  }

  async createSuccessorVersion(input: CreateDocumentationSuccessorInput): Promise<PhaseArtifact> {
    return this.withVersionRetry(() => this.prisma.$transaction(async (tx) => {
      await this.authorization.assertCanEditInTransaction(tx, input.projectId, input.actorId);
      const { artifact, base, state } = await this.createSuccessorVersionInTransaction(tx, input);

      const advanced = await tx.projectPhaseState.updateMany({
        where: { id: state.id, stateVersion: state.stateVersion, currentArtifactId: base.id },
        data: {
          status: "in_progress",
          currentArtifactId: artifact.id,
          approvalCandidateArtifactId: null,
          notes: null,
          stateVersion: { increment: 1 },
        },
      });
      if (advanced.count !== 1) this.concurrentUpdate();
      await tx.project.update({ where: { id: input.projectId }, data: { currentPhase: DOCUMENTATION_PHASE } });
      return artifact;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
  }

  /** Transaction-aware primitive used by manual creation and WorkflowRun revision finalization. */
  async createSuccessorVersionInTransaction(
    tx: Prisma.TransactionClient,
    input: CreateDocumentationSuccessorInput,
  ): Promise<{ artifact: PhaseArtifact; base: PhaseArtifact; state: ProjectPhaseState; latest: { id: string; version: number } }> {
    const content = await this.validateCanonicalContentInTransaction(tx, input.projectId, input.structuredContent);
    const state = await tx.projectPhaseState.findUnique({
      where: { projectId_phase: { projectId: input.projectId, phase: DOCUMENTATION_PHASE } },
    });
    if (!state) {
      throw new PlanningDomainError("PLANNING_ARTIFACT_NOT_FOUND", "Documentation has no current artifact to revise.", 404);
    }
    this.assertAction(state.status, "create_revision");

    const base = await tx.phaseArtifact.findUnique({ where: { id: input.baseArtifactId } });
    this.assertDocumentationArtifactScope(base, input.projectId);
    if (state.currentArtifactId !== base.id || base.contentHash !== input.baseContentHash) {
      throw new PlanningDomainError(
        "PLANNING_ARTIFACT_BASE_CHANGED",
        "The Documentation base artifact is no longer current.",
        409,
        { expectedBaseArtifactId: input.baseArtifactId, currentArtifactId: state.currentArtifactId },
      );
    }
    await this.validatePersistedArtifactInTransaction(tx, input.projectId, base, {
      expectedHash: input.baseContentHash,
      requireCurrentRequirements: false,
    });
    const latest = await tx.phaseArtifact.findFirst({
      where: { projectId: input.projectId, phase: DOCUMENTATION_PHASE, type: DOCUMENTATION_ARTIFACT_TYPE },
      orderBy: [{ version: "desc" }, { id: "desc" }],
      select: { id: true, version: true },
    });
    if (!latest || latest.id !== base.id) {
      throw new PlanningDomainError(
        "PLANNING_ARTIFACT_BASE_CHANGED",
        "A newer Documentation version already exists.",
        409,
        { expectedBaseArtifactId: base.id, latestArtifactId: latest?.id },
      );
    }

    const changeKind = input.changeKind ?? ArtifactChangeKind.MANUAL_EDIT;
    this.assertChangeKind(changeKind, SUCCESSOR_CHANGE_KINDS, "Documentation successor");
    const artifact = await this.createVersion(tx, {
      projectId: input.projectId,
      actorId: input.actorId,
      title: input.title ?? base.title,
      content,
      version: latest.version + 1,
      previousVersionId: base.id,
      basedOnArtifactId: base.id,
      createdByType: input.createdByType ?? ArtifactActorType.HUMAN,
      changeKind,
    });

    return { artifact, base, state, latest };
  }


  async validatePersistedArtifactInTransaction(
    tx: Prisma.TransactionClient,
    projectId: string,
    artifact: PhaseArtifact,
    options: { expectedHash?: string; requireCurrentRequirements?: boolean } = {},
  ): Promise<ValidatedDocumentationArtifact> {
    this.assertDocumentationArtifactScope(artifact, projectId);
    if (artifact.schemaVersion !== DOCUMENTATION_SCHEMA_VERSION || artifact.structuredContent === null) {
      this.invalidArtifact("The Documentation artifact is not canonical.");
    }
    const content = this.parseDocumentation(artifact.structuredContent);
    this.assertCanonicalSize(content);
    const actualHash = hashDocumentationContent(content);
    if (!artifact.contentHash || artifact.contentHash !== actualHash) {
      this.invalidArtifact("The Documentation artifact content hash is invalid.");
    }
    if (options.expectedHash !== undefined && artifact.contentHash !== options.expectedHash) {
      throw new PlanningDomainError(
        "PLANNING_ARTIFACT_HASH_MISMATCH",
        "The Documentation artifact content hash does not match the expected hash.",
        409,
        { artifactId: artifact.id, expectedHash: options.expectedHash, actualHash: artifact.contentHash },
      );
    }
    if (artifact.content !== renderDocumentationMarkdown(content)) {
      this.invalidArtifact("The Documentation artifact Markdown is invalid.");
    }
    const source = await this.loadRequirementsAuthority(
      tx,
      projectId,
      content,
      options.requireCurrentRequirements !== false,
    );
    this.validateGraphAndTraceability(content, source.content);
    return {
      content,
      historicalRequirements: source.content,
      currentApprovedRequirements: {
        artifactId: source.artifact.id,
        version: source.artifact.version,
        contentHash: source.artifact.contentHash as string,
      },
    };
  }

  private async validateCanonicalContentInTransaction(
    tx: Prisma.TransactionClient,
    projectId: string,
    value: unknown,
  ): Promise<DocumentationContent> {
    try {
      const content = parseDocumentationContent(value);
      this.assertCanonicalSize(content);
      const source = await this.loadRequirementsAuthority(tx, projectId, content, true);
      this.validateGraphAndTraceability(content, source.content);
      return content;
    } catch (error) {
      this.rethrowValidation(error);
    }
  }

  private async loadRequirementsAuthority(
    tx: Prisma.TransactionClient,
    projectId: string,
    documentation: DocumentationContent,
    requireCurrent: boolean,
  ): Promise<{ artifact: PhaseArtifact; content: RequirementsContent }> {
    const sourceId = documentation.sourceRequirements.artifactId;
    const [state, artifact] = await Promise.all([
      tx.projectPhaseState.findUnique({
        where: { projectId_phase: { projectId, phase: REQUIREMENTS_PHASE } },
      }),
      tx.phaseArtifact.findUnique({ where: { id: sourceId } }),
    ]);
    if (!state || !artifact
      || artifact.projectId !== projectId
      || artifact.phase !== REQUIREMENTS_PHASE
      || artifact.type !== REQUIREMENTS_ARTIFACT_TYPE
      || artifact.schemaVersion !== REQUIREMENTS_SCHEMA_VERSION
      || artifact.structuredContent === null
      || artifact.lifecycleStatus !== ArtifactLifecycleStatus.APPROVED
      || !artifact.approved
      || !artifact.approvedAt
      || (requireCurrent && state.currentApprovedArtifactId !== artifact.id)) {
      this.invalidArtifact("The Documentation source Requirements authority is invalid.");
    }

    const requirements = parseRequirementsContent(artifact.structuredContent);
    const actualHash = hashRequirementsContent(requirements);
    if (!artifact.contentHash
      || artifact.contentHash !== actualHash
      || artifact.content !== renderRequirementsMarkdown(requirements)
      || documentation.sourceRequirements.contentHash !== actualHash
      || documentation.sourceRequirements.version !== artifact.version) {
      this.invalidArtifact("The Documentation source Requirements authority is corrupted or stale.");
    }
    const approval = await tx.phaseApproval.findFirst({
      where: {
        projectId,
        phase: REQUIREMENTS_PHASE,
        artifactId: artifact.id,
        artifactVersion: artifact.version,
        artifactContentHash: actualHash,
        decision: "approved",
        legacyUnverified: false,
      },
      select: { id: true },
    });
    if (!approval) this.invalidArtifact("The Documentation source Requirements approval record is invalid.");
    return { artifact, content: requirements };
  }

  private async createVersion(
    tx: Prisma.TransactionClient,
    input: {
      projectId: string;
      actorId: string;
      title: string;
      content: DocumentationContent;
      version: number;
      previousVersionId: string | null;
      basedOnArtifactId: string | null;
      createdByType: ArtifactActorType;
      changeKind: ArtifactChangeKind;
    },
  ): Promise<PhaseArtifact> {
    this.assertCanonicalSize(input.content);
    return tx.phaseArtifact.create({
      data: {
        projectId: input.projectId,
        phase: DOCUMENTATION_PHASE,
        type: DOCUMENTATION_ARTIFACT_TYPE,
        title: input.title.trim() || `Documentation v${input.version}`,
        content: renderDocumentationMarkdown(input.content),
        structuredContent: input.content as unknown as Prisma.InputJsonValue,
        schemaVersion: DOCUMENTATION_SCHEMA_VERSION,
        contentHash: hashDocumentationContent(input.content),
        version: input.version,
        previousVersionId: input.previousVersionId,
        basedOnArtifactId: input.basedOnArtifactId,
        changeKind: input.changeKind,
        createdBy: input.actorId,
        createdByType: input.createdByType,
        lifecycleStatus: ArtifactLifecycleStatus.DRAFT,
        approved: false,
      },
    });
  }

  private parseDocumentation(value: unknown): DocumentationContent {
    try {
      return parseDocumentationContent(value);
    } catch (error) {
      this.rethrowValidation(error);
    }
  }

  private validateGraphAndTraceability(
    content: DocumentationContent,
    requirements: RequirementsContent,
  ): void {
    try {
      validateDocumentationGraph(content, requirements);
    } catch (error) {
      this.rethrowValidation(error);
    }
    if (!traceabilityMatches(content, requirements)) {
      this.invalidArtifact("The Documentation Requirements traceability is invalid.");
    }
  }

  private assertCanonicalSize(content: DocumentationContent): void {
    const byteLength = Buffer.byteLength(canonicalJson(content), "utf8");
    if (byteLength > DOCUMENTATION_CANONICAL_JSON_MAX_BYTES) {
      throw new PlanningDomainError(
        "PLANNING_INPUT_TOO_LARGE",
        "Canonical Documentation JSON exceeds the 128 KiB UTF-8 limit.",
        413,
        { input: "canonicalArtifactJson", byteLength, maxBytes: DOCUMENTATION_CANONICAL_JSON_MAX_BYTES },
      );
    }
  }

  private rethrowValidation(error: unknown): never {
    if (error instanceof PlanningDomainError) throw error;
    if (error instanceof DocumentationValidationError) {
      if (error.code === "DOCUMENTATION_SIZE_EXCEEDED") {
        throw new PlanningDomainError("PLANNING_INPUT_TOO_LARGE", "Canonical Documentation JSON exceeds the 128 KiB UTF-8 limit.", 413);
      }
      throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", "The Documentation artifact is invalid.", 422);
    }
    throw error;
  }

  private assertDocumentationArtifactScope(
    artifact: PhaseArtifact | null,
    projectId: string,
  ): asserts artifact is PhaseArtifact {
    if (!artifact
      || artifact.projectId !== projectId
      || artifact.phase !== DOCUMENTATION_PHASE
      || artifact.type !== DOCUMENTATION_ARTIFACT_TYPE) {
      throw new PlanningDomainError(
        "PLANNING_ARTIFACT_PROJECT_MISMATCH",
        "Documentation artifact was not found in this project.",
        404,
      );
    }
  }

  private assertChangeKind(
    changeKind: ArtifactChangeKind,
    allowed: ReadonlySet<ArtifactChangeKind>,
    operation: string,
  ): void {
    if (!allowed.has(changeKind)) {
      throw new PlanningDomainError(
        "PLANNING_ARTIFACT_INVALID",
        `Change kind '${changeKind}' is not valid for an ${operation}.`,
        422,
      );
    }
  }

  private assertAction(status: string, action: "create_initial_artifact" | "create_revision"): void {
    const allowed = action === "create_initial_artifact"
      ? status === "not_started"
      : status === "in_progress" || status === "changes_requested" || status === "approved";
    if (!allowed) {
      throw new PlanningDomainError(
        "PLANNING_ACTION_LOCKED",
        `Action '${action}' is locked while Documentation is '${status}'.`,
        409,
        { status, action },
      );
    }
  }

  private invalidArtifact(message: string): never {
    throw new PlanningDomainError("PLANNING_ARTIFACT_INVALID", message, 422);
  }

  private async withVersionRetry<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        if (error instanceof PlanningDomainError || !isRetryableTransactionError(error)) throw error;
      }
    }
    throw new PlanningDomainError(
      "PLANNING_CONCURRENT_UPDATE",
      "Documentation changed concurrently; reload the current version and retry.",
      409,
    );
  }

  private concurrentUpdate(): never {
    throw new PlanningDomainError(
      "PLANNING_CONCURRENT_UPDATE",
      "Documentation changed concurrently; reload the current version and retry.",
      409,
    );
  }
}
