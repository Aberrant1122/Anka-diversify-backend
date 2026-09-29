import { PhaseArtifact, Prisma, PrismaClient, WorkflowRun } from "@prisma/client";
import OpenAI from "openai";
import {
  LLMCallResult,
  LLMGateway,
  LLMProviderAttempt,
} from "../ai/gateway/LLMGateway";
import { LLMError, LLMRetryExhaustedError } from "../ai/gateway/LLMError";
import { PipelineStages } from "../ai/gateway/PipelineStage";
import {
  buildInitialRequirementsMessages,
  REQUIREMENTS_STRUCTURED_REPAIR_POLICY,
} from "../ai/prompts/requirements";
import {
  buildRevisionRequirementsMessages,
  REQUIREMENTS_REVISION_STRUCTURED_REPAIR_POLICY,
} from "../ai/prompts/requirements-revision";
import { PlanningDomainError, PlanningErrorCode, isPlanningDomainError } from "../planning/planning-errors";
import {
  REQUIREMENTS_PROVIDER_JSON_SCHEMA,
  validateGeneratedRequirements,
} from "../planning/requirements-generation-schema";
import {
  canonicalJson,
  InitialRequirementsContextPayload,
  RevisionRequirementsContextPayload,
} from "../planning/requirements-context";
import {
  REQUIREMENTS_INPUT_LIMITS,
  REQUIREMENTS_PROMPT_VERSION,
  REQUIREMENTS_PROVIDER_SCHEMA_VERSION,
  REQUIREMENTS_REVISION_PROMPT_VERSION,
} from "../planning/requirements-run-config";
import { parseRequirementsContent, RequirementsContent } from "../planning/requirements-schema";
import {
  computeRequirementsDiff,
  isNoOpRequirementsRevision,
  RequirementsDeterministicDiff,
  validateRevisionStableIds,
} from "../planning/requirements-revision-policy";
import { PlanningArtifactService } from "./planning-artifact.service";
import { PlanningAuthorizationService } from "./planning-authorization.service";
import { PlanningReadinessService, RequirementsReadiness } from "./planning-readiness.service";
import {
  PlanningRequirementsRunService,
  RequirementsGenerationAudit,
  RequirementsRunFailure,
  StartRequirementsRunResult,
} from "./planning-requirements-run.service";

type RequirementsGateway = Pick<LLMGateway, "callStructured">;

export interface GenerateInitialRequirementsInput {
  projectId: string;
  actorId: string;
  idempotencyKey: string;
  brief: string;
  includeMemory?: boolean;
}

export interface GenerateInitialRequirementsResult {
  run: WorkflowRun;
  artifact: PhaseArtifact | null;
  readiness: RequirementsReadiness | null;
  reused: boolean;
  httpStatus: 200 | 201 | 202;
}

export interface ReviseRequirementsInput {
  projectId: string;
  baseArtifactId: string;
  actorId: string;
  idempotencyKey: string;
  operation: "DOCUMENT_REVISION" | "FEEDBACK_APPLICATION";
  instruction: string;
  includeMemory?: boolean;
}

export interface ReviseRequirementsResult {
  run: WorkflowRun;
  artifact: PhaseArtifact | null;
  readiness: RequirementsReadiness | null;
  diff: RequirementsDeterministicDiff | null;
  reused: boolean;
  httpStatus: 200 | 201 | 202;
}

interface PlanningGenerationDependencies {
  authorization?: PlanningAuthorizationService;
  artifacts?: PlanningArtifactService;
  readiness?: PlanningReadinessService;
  runs?: PlanningRequirementsRunService;
  gateway?: RequirementsGateway;
}

const KNOWN_MODEL_RATES: Readonly<Record<string, { prompt: number; completion: number }>> = Object.freeze({
  "gpt-4o": { prompt: 2.5 / 1_000_000, completion: 10 / 1_000_000 },
  "gpt-4o-mini": { prompt: 0.15 / 1_000_000, completion: 0.6 / 1_000_000 },
});

const REPLAY_FAILURES: Readonly<Record<string, { code: PlanningErrorCode; status: number }>> = Object.freeze({
  PLANNING_AI_TIMEOUT: { code: "PLANNING_AI_TIMEOUT", status: 504 },
  PLANNING_AI_NETWORK_ERROR: { code: "PLANNING_AI_NETWORK_ERROR", status: 503 },
  PLANNING_AI_PROVIDER_ERROR: { code: "PLANNING_AI_PROVIDER_ERROR", status: 502 },
  PLANNING_AI_RATE_LIMITED: { code: "PLANNING_AI_RATE_LIMITED", status: 429 },
  PLANNING_AI_BUDGET_EXHAUSTED: { code: "PLANNING_AI_BUDGET_EXHAUSTED", status: 429 },
  PLANNING_AI_CONTEXT_TOO_LARGE: { code: "PLANNING_AI_CONTEXT_TOO_LARGE", status: 413 },
  PLANNING_AI_INVALID_RESPONSE: { code: "PLANNING_AI_INVALID_RESPONSE", status: 502 },
  PLANNING_AI_REFUSED: { code: "PLANNING_AI_REFUSED", status: 422 },
  PLANNING_AI_CONTENT_FILTERED: { code: "PLANNING_AI_CONTENT_FILTERED", status: 422 },
  PLANNING_AI_TRUNCATED: { code: "PLANNING_AI_TRUNCATED", status: 502 },
  PLANNING_AI_OUTPUT_TOO_LARGE: { code: "PLANNING_AI_OUTPUT_TOO_LARGE", status: 502 },
  PLANNING_PERSISTENCE_FAILED: { code: "PLANNING_PERSISTENCE_FAILED", status: 503 },
  PLANNING_REVISION_NO_CHANGES: { code: "PLANNING_REVISION_NO_CHANGES", status: 422 },
});

function actualLLMError(error: unknown): LLMError | null {
  if (error instanceof LLMRetryExhaustedError && error.lastError instanceof LLMError) return error.lastError;
  return error instanceof LLMError ? error : null;
}

function planningFailureFor(error: unknown): PlanningDomainError {
  const llmError = actualLLMError(error);
  const retryDetails = error instanceof LLMRetryExhaustedError ? error.details : undefined;
  const details = llmError ? {
    gatewayCode: llmError.code,
    ...(llmError.stage ? { stage: llmError.stage } : {}),
    ...(llmError.model ? { model: llmError.model } : {}),
    attemptCount: retryDetails?.attempt ?? llmError.details.attempt ?? 1,
  } : undefined;
  switch (llmError?.code) {
    case "LLM_TIMEOUT":
      return new PlanningDomainError("PLANNING_AI_TIMEOUT", "Requirements generation timed out.", 504, details);
    case "LLM_NETWORK_ERROR":
      return new PlanningDomainError("PLANNING_AI_NETWORK_ERROR", "Requirements generation could not reach the model provider.", 503, details);
    case "LLM_RATE_LIMIT":
      return new PlanningDomainError("PLANNING_AI_RATE_LIMITED", "Requirements generation was rate limited.", 429, details);
    case "LLM_BUDGET_EXHAUSTED":
    case "LLM_BUDGET_INVALID":
      return new PlanningDomainError("PLANNING_AI_BUDGET_EXHAUSTED", "Requirements generation exceeded its model budget.", 429, details);
    case "LLM_CONTEXT_OVERFLOW":
      return new PlanningDomainError("PLANNING_AI_CONTEXT_TOO_LARGE", "Requirements generation context is too large.", 413, details);
    case "LLM_INVALID_JSON":
    case "LLM_SCHEMA_INVALID":
      return new PlanningDomainError("PLANNING_AI_INVALID_RESPONSE", "The model returned invalid Requirements content.", 502, details);
    case "LLM_REFUSAL":
      return new PlanningDomainError("PLANNING_AI_REFUSED", "The model refused to generate Requirements.", 422, details);
    case "LLM_CONTENT_FILTER":
      return new PlanningDomainError("PLANNING_AI_CONTENT_FILTERED", "Requirements generation was blocked by the provider content filter.", 422, details);
    case "LLM_TRUNCATED":
      return new PlanningDomainError("PLANNING_AI_TRUNCATED", "The model response was truncated.", 502, details);
    default:
      return new PlanningDomainError("PLANNING_AI_PROVIDER_ERROR", "Requirements generation failed at the model provider.", 502, details);
  }
}

function storedFailureMessage(run: WorkflowRun): string {
  if (!run.errorMessage) return "The previous Requirements generation attempt failed.";
  try {
    const parsed: unknown = JSON.parse(run.errorMessage);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const message = (parsed as Record<string, unknown>).message;
      if (typeof message === "string" && message.trim()) return message;
    }
  } catch (error) {
    console.warn("Could not parse stored Requirements run failure metadata", {
      runId: run.id,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  return "The previous Requirements generation attempt failed.";
}

export class PlanningGenerationService {
  private readonly artifacts: PlanningArtifactService;
  private readonly readiness: PlanningReadinessService;
  private readonly runs: PlanningRequirementsRunService;
  private readonly gateway: RequirementsGateway;

  constructor(
    private readonly prisma: PrismaClient,
    dependencies: PlanningGenerationDependencies = {},
  ) {
    const authorization = dependencies.authorization ?? new PlanningAuthorizationService(prisma);
    this.artifacts = dependencies.artifacts ?? new PlanningArtifactService(prisma, authorization);
    this.readiness = dependencies.readiness ?? new PlanningReadinessService();
    this.runs = dependencies.runs ?? new PlanningRequirementsRunService(
      prisma,
      authorization,
      undefined,
      this.artifacts,
      this.readiness,
    );
    this.gateway = dependencies.gateway ?? LLMGateway.getInstance();
  }

  async generateInitialRequirements(
    input: GenerateInitialRequirementsInput,
  ): Promise<GenerateInitialRequirementsResult> {
    let started: StartRequirementsRunResult;
    try {
      started = await this.runs.startRequirementsRun({
        projectId: input.projectId,
        actorId: input.actorId,
        operation: "INITIAL_GENERATION",
        idempotencyKey: input.idempotencyKey,
        brief: input.brief,
        includeMemory: input.includeMemory === true,
      });
    } catch (error) {
      if (isPlanningDomainError(error)) throw error;
      console.error("Failed to initialize Requirements generation state", {
        projectId: input.projectId,
        reason: error instanceof Error ? error.message : String(error),
      });
      throw new PlanningDomainError(
        "PLANNING_PERSISTENCE_FAILED",
        "Planning state could not be persisted. Please retry.",
        503,
      );
    }
    if (started.reused) return this.replay(input, started.run);

    let completion: LLMCallResult<RequirementsContent>;
    try {
      completion = await this.gateway.callStructured<RequirementsContent>({
        stage: PipelineStages.ROADMAP_PLANNING,
        messages: buildInitialRequirementsMessages(started.context.payload as InitialRequirementsContextPayload),
        schema: {
          name: "anka_initial_requirements",
          description: "Canonical initial Anka OS Requirements artifact",
          schema: REQUIREMENTS_PROVIDER_JSON_SCHEMA,
          strict: true,
          validate: validateGeneratedRequirements,
        },
        structuredRepair: { instructions: REQUIREMENTS_STRUCTURED_REPAIR_POLICY },
        maxRetries: 1,
        context: { runId: started.run.id, projectId: input.projectId },
      });
    } catch (error) {
      const planningError = planningFailureFor(error);
      await this.tryFailRun(input.projectId, started.run.id, planningError, this.buildAuditForError(error));
      throw planningError;
    }

    const audit = this.buildAudit(completion);
    let content: RequirementsContent;
    try {
      content = parseRequirementsContent(completion.content);
    } catch {
      const invalidResponse = new PlanningDomainError(
        "PLANNING_AI_INVALID_RESPONSE",
        "The model returned invalid canonical Requirements content.",
        502,
      );
      await this.tryFailRun(input.projectId, started.run.id, invalidResponse, audit);
      throw invalidResponse;
    }
    const outputBytes = Buffer.byteLength(canonicalJson(content), "utf8");
    if (outputBytes > REQUIREMENTS_INPUT_LIMITS.canonicalArtifactJsonBytes) {
      const error = new PlanningDomainError(
        "PLANNING_AI_OUTPUT_TOO_LARGE",
        "Generated Requirements exceed the configured UTF-8 byte limit.",
        502,
        { byteLength: outputBytes, maxBytes: REQUIREMENTS_INPUT_LIMITS.canonicalArtifactJsonBytes },
      );
      await this.tryFailRun(input.projectId, started.run.id, error, audit);
      throw error;
    }

    try {
      await this.runs.assertRequirementsRunCurrent(input.projectId, started.run.id, input.actorId);
      const finalized = await this.runs.finalizeInitialGeneration({
        projectId: input.projectId,
        runId: started.run.id,
        actorId: input.actorId,
        structuredContent: content,
        audit,
      });
      return { ...finalized, reused: false, httpStatus: 201 };
    } catch (error) {
      if (isPlanningDomainError(error) && error.code === "PLANNING_CONTEXT_CHANGED") {
        await this.tryConflictRun(input.projectId, started.run.id, error, audit);
        throw error;
      }
      if (isPlanningDomainError(error) && error.code === "PLANNING_PROJECT_NOT_FOUND") {
        await this.tryCancelRun(input.projectId, started.run.id, audit);
        throw error;
      }
      const persistenceError = isPlanningDomainError(error) && error.code === "PLANNING_PERSISTENCE_FAILED"
        ? error
        : new PlanningDomainError(
          "PLANNING_PERSISTENCE_FAILED",
          "Generated Requirements could not be persisted atomically.",
          503,
        );
      await this.tryFailRun(input.projectId, started.run.id, persistenceError, audit);
      throw persistenceError;
    }
  }

  async reviseRequirements(
    input: ReviseRequirementsInput,
  ): Promise<ReviseRequirementsResult> {
    let started: StartRequirementsRunResult;
    try {
      started = await this.runs.startRequirementsRun({
        projectId: input.projectId,
        actorId: input.actorId,
        operation: input.operation,
        idempotencyKey: input.idempotencyKey,
        baseArtifactId: input.baseArtifactId,
        instruction: input.instruction,
        includeMemory: input.includeMemory === true,
      });
    } catch (error) {
      if (isPlanningDomainError(error)) throw error;
      console.error("Failed to initialize Requirements revision state", {
        projectId: input.projectId,
        reason: error instanceof Error ? error.message : String(error),
      });
      throw new PlanningDomainError(
        "PLANNING_PERSISTENCE_FAILED",
        "Planning state could not be persisted. Please retry.",
        503,
      );
    }
    if (started.reused) return this.replayRevision(input, started.run);

    try {
      await this.runs.assertRequirementsRunCurrent(input.projectId, started.run.id, input.actorId);
    } catch (error) {
      // Transaction A already committed the run and its lease; terminalize before rethrowing.
      if (isPlanningDomainError(error) && error.code === "PLANNING_CONTEXT_CHANGED") {
        await this.tryConflictRun(input.projectId, started.run.id, error);
        throw error;
      }
      if (isPlanningDomainError(error) && error.code === "PLANNING_PROJECT_NOT_FOUND") {
        await this.tryCancelRun(input.projectId, started.run.id);
        throw error;
      }
      const failure = isPlanningDomainError(error)
        ? error
        : new PlanningDomainError(
          "PLANNING_PERSISTENCE_FAILED",
          "Requirements revision context could not be verified. Please retry.",
          503,
        );
      await this.tryFailRun(input.projectId, started.run.id, failure);
      throw failure;
    }

    let completion: LLMCallResult<RequirementsContent>;
    try {
      completion = await this.gateway.callStructured<RequirementsContent>({
        stage: PipelineStages.ROADMAP_PLANNING,
        messages: buildRevisionRequirementsMessages(started.context.payload as RevisionRequirementsContextPayload),
        schema: {
          name: "anka_requirements_revision",
          description: "Canonical revised Anka OS Requirements artifact",
          schema: REQUIREMENTS_PROVIDER_JSON_SCHEMA,
          strict: true,
          validate: validateGeneratedRequirements,
        },
        structuredRepair: { instructions: REQUIREMENTS_REVISION_STRUCTURED_REPAIR_POLICY },
        maxRetries: 1,
        context: { runId: started.run.id, projectId: input.projectId },
      });
    } catch (error) {
      const planningError = planningFailureFor(error);
      await this.tryFailRun(
        input.projectId,
        started.run.id,
        planningError,
        this.buildAuditForError(error, REQUIREMENTS_REVISION_PROMPT_VERSION),
      );
      throw planningError;
    }

    const audit = this.buildAudit(completion, REQUIREMENTS_REVISION_PROMPT_VERSION);
    let content: RequirementsContent;
    try {
      content = parseRequirementsContent(completion.content);
    } catch {
      const invalidResponse = new PlanningDomainError(
        "PLANNING_AI_INVALID_RESPONSE",
        "The model returned invalid canonical Requirements content.",
        502,
      );
      await this.tryFailRun(input.projectId, started.run.id, invalidResponse, audit);
      throw invalidResponse;
    }

    const outputBytes = Buffer.byteLength(canonicalJson(content), "utf8");
    if (outputBytes > REQUIREMENTS_INPUT_LIMITS.canonicalArtifactJsonBytes) {
      const error = new PlanningDomainError(
        "PLANNING_AI_OUTPUT_TOO_LARGE",
        "Generated Requirements exceed the configured UTF-8 byte limit.",
        502,
        { byteLength: outputBytes, maxBytes: REQUIREMENTS_INPUT_LIMITS.canonicalArtifactJsonBytes },
      );
      await this.tryFailRun(input.projectId, started.run.id, error, audit);
      throw error;
    }

    const baseContent = (started.context.payload as RevisionRequirementsContextPayload).baseArtifact.content;
    if (isNoOpRequirementsRevision(baseContent, content)) {
      const noChangesError = new PlanningDomainError(
        "PLANNING_REVISION_NO_CHANGES",
        "The revision produced no changes to the Requirements document.",
        422,
        { runId: started.run.id },
      );
      await this.tryFailRun(input.projectId, started.run.id, noChangesError, audit);
      throw noChangesError;
    }

    try {
      validateRevisionStableIds(baseContent, content);
    } catch (error) {
      if (isPlanningDomainError(error)) {
        await this.tryFailRun(input.projectId, started.run.id, error, audit);
        throw error;
      }
      throw error;
    }

    try {
      await this.runs.assertRequirementsRunCurrent(input.projectId, started.run.id, input.actorId);
      const finalized = await this.runs.finalizeRequirementsRevision({
        projectId: input.projectId,
        runId: started.run.id,
        actorId: input.actorId,
        structuredContent: content,
        audit,
      });
      return { ...finalized, reused: false, httpStatus: 201 };
    } catch (error) {
      if (isPlanningDomainError(error) && error.code === "PLANNING_CONTEXT_CHANGED") {
        await this.tryConflictRun(input.projectId, started.run.id, error, audit);
        throw error;
      }
      if (isPlanningDomainError(error) && error.code === "PLANNING_PROJECT_NOT_FOUND") {
        await this.tryCancelRun(input.projectId, started.run.id, audit);
        throw error;
      }
      if (isPlanningDomainError(error) && error.code === "PLANNING_REVISION_NO_CHANGES") {
        await this.tryFailRun(input.projectId, started.run.id, error, audit);
        throw error;
      }
      const persistenceError = isPlanningDomainError(error) && error.code === "PLANNING_PERSISTENCE_FAILED"
        ? error
        : new PlanningDomainError(
          "PLANNING_PERSISTENCE_FAILED",
          "Revised Requirements could not be persisted atomically.",
          503,
        );
      await this.tryFailRun(input.projectId, started.run.id, persistenceError, audit);
      throw persistenceError;
    }
  }

  private async replay(
    input: GenerateInitialRequirementsInput,
    run: WorkflowRun,
  ): Promise<GenerateInitialRequirementsResult> {
    if (run.status === "running") {
      return { run, artifact: null, readiness: null, reused: true, httpStatus: 202 };
    }
    if (run.status === "completed") {
      if (!run.outputArtifactId) {
        throw new PlanningDomainError(
          "PLANNING_RUN_INVARIANT",
          "Completed Requirements run is missing its output artifact reference.",
          500,
          { runId: run.id },
        );
      }
      let artifact: PhaseArtifact;
      try {
        artifact = await this.artifacts.getArtifact(input.projectId, run.outputArtifactId, input.actorId);
      } catch (error) {
        if (isPlanningDomainError(error) && error.code === "PLANNING_ARTIFACT_NOT_FOUND") {
          throw new PlanningDomainError(
            "PLANNING_RUN_INVARIANT",
            "Completed Requirements run references a missing output artifact.",
            500,
            { runId: run.id },
          );
        }
        throw error;
      }
      return {
        run,
        artifact,
        readiness: this.readiness.evaluateRequirements({ artifact }),
        reused: true,
        httpStatus: 200,
      };
    }
    if (run.status === "conflicted") {
      throw new PlanningDomainError(
        "PLANNING_CONTEXT_CHANGED",
        storedFailureMessage(run),
        409,
        { runId: run.id, reused: true },
      );
    }
    if (run.status === "cancelled") {
      throw new PlanningDomainError(
        "PLANNING_RUN_CANCELLED",
        storedFailureMessage(run),
        409,
        { runId: run.id, reused: true },
      );
    }
    const mapping = run.errorCode ? REPLAY_FAILURES[run.errorCode] : undefined;
    throw new PlanningDomainError(
      mapping?.code ?? "PLANNING_AI_PROVIDER_ERROR",
      storedFailureMessage(run),
      mapping?.status ?? 502,
      { runId: run.id, reused: true },
    );
  }

  private async replayRevision(
    input: ReviseRequirementsInput,
    run: WorkflowRun,
  ): Promise<ReviseRequirementsResult> {
    if (run.status === "running") {
      return { run, artifact: null, readiness: null, diff: null, reused: true, httpStatus: 202 };
    }
    if (run.status === "completed") {
      if (!run.outputArtifactId) {
        throw new PlanningDomainError(
          "PLANNING_RUN_INVARIANT",
          "Completed Requirements revision run is missing its output artifact reference.",
          500,
          { runId: run.id },
        );
      }
      if (!run.baseArtifactId) {
        throw new PlanningDomainError(
          "PLANNING_RUN_INVARIANT",
          "Completed Requirements revision run is missing its base artifact reference.",
          500,
          { runId: run.id },
        );
      }
      let artifact: PhaseArtifact;
      let base: PhaseArtifact;
      try {
        [artifact, base] = await Promise.all([
          this.artifacts.getArtifact(input.projectId, run.outputArtifactId, input.actorId),
          this.artifacts.getArtifact(input.projectId, run.baseArtifactId, input.actorId),
        ]);
      } catch (error) {
        if (isPlanningDomainError(error) && error.code === "PLANNING_ARTIFACT_NOT_FOUND") {
          throw new PlanningDomainError(
            "PLANNING_RUN_INVARIANT",
            "Completed Requirements revision run references a missing artifact.",
            500,
            { runId: run.id },
          );
        }
        throw error;
      }
      const baseContent = parseRequirementsContent(base.structuredContent);
      const outputContent = parseRequirementsContent(artifact.structuredContent);
      const diff = computeRequirementsDiff(baseContent, outputContent);
      return {
        run,
        artifact,
        readiness: this.readiness.evaluateRequirements({ artifact }),
        diff,
        reused: true,
        httpStatus: 200,
      };
    }
    if (run.status === "conflicted") {
      throw new PlanningDomainError(
        "PLANNING_CONTEXT_CHANGED",
        storedFailureMessage(run),
        409,
        { runId: run.id, reused: true },
      );
    }
    if (run.status === "cancelled") {
      throw new PlanningDomainError(
        "PLANNING_RUN_CANCELLED",
        storedFailureMessage(run),
        409,
        { runId: run.id, reused: true },
      );
    }
    const mapping = run.errorCode ? REPLAY_FAILURES[run.errorCode] : undefined;
    throw new PlanningDomainError(
      mapping?.code ?? "PLANNING_AI_PROVIDER_ERROR",
      storedFailureMessage(run),
      mapping?.status ?? 502,
      { runId: run.id, reused: true },
    );
  }

  private buildAudit(
    completion: LLMCallResult<RequirementsContent>,
    promptVersion: string = REQUIREMENTS_PROMPT_VERSION,
  ): RequirementsGenerationAudit {
    return this.buildAuditFromAttempts(this.providerAttempts(completion), promptVersion);
  }

  private buildAuditForError(
    error: unknown,
    promptVersion: string = REQUIREMENTS_PROMPT_VERSION,
  ): RequirementsGenerationAudit | undefined {
    if (!(error instanceof LLMError) || !error.providerAttempts?.length) return undefined;
    return this.buildAuditFromAttempts([...error.providerAttempts], promptVersion);
  }

  private buildAuditFromAttempts(
    attempts: LLMProviderAttempt[],
    promptVersion: string = REQUIREMENTS_PROMPT_VERSION,
  ): RequirementsGenerationAudit {
    const knownAttempts = attempts.filter((attempt) => attempt.usageSource === "provider");
    const completeUsage = knownAttempts.length === attempts.length && attempts.length > 0 && attempts.every((attempt) =>
      attempt.promptTokens !== null && attempt.completionTokens !== null && attempt.totalTokens !== null,
    );
    const promptTokens = this.knownTokenTotal(knownAttempts, "promptTokens");
    const completionTokens = this.knownTokenTotal(knownAttempts, "completionTokens");
    const totalTokens = this.knownTokenTotal(knownAttempts, "totalTokens");
    const usageSource = completeUsage
      ? "provider"
      : knownAttempts.length > 0
        ? "partial_provider"
        : "unavailable";
    const finalAttempt = attempts[attempts.length - 1];
    const model = finalAttempt?.model ?? "unknown";
    const modelUsage: Prisma.InputJsonObject = {
      provider: "openai",
      model,
      providerResponseId: finalAttempt?.providerResponseId ?? null,
      providerRequestId: finalAttempt?.providerRequestId ?? null,
      promptTokens,
      completionTokens,
      totalTokens,
      usageSource,
      providerUsageAttemptCount: knownAttempts.length,
      attempts: attempts as unknown as Prisma.InputJsonArray,
      aggregate: {
        providerRequestCount: attempts.length,
        providerUsageAttemptCount: knownAttempts.length,
        promptTokens,
        completionTokens,
        totalTokens,
        usageSource,
      },
      latencyMs: finalAttempt?.latencyMs ?? null,
      latencyScope: "final_attempt",
      attemptCount: attempts.length,
      finishReason: finalAttempt?.finishReason ?? null,
      promptVersion,
      schemaVersion: REQUIREMENTS_PROVIDER_SCHEMA_VERSION,
    };
    const costUSD = completeUsage && attempts.every((attempt) => Boolean(KNOWN_MODEL_RATES[attempt.model]))
      ? attempts.reduce((sum, attempt) => {
        const rate = KNOWN_MODEL_RATES[attempt.model];
        return sum + (attempt.promptTokens ?? 0) * rate.prompt + (attempt.completionTokens ?? 0) * rate.completion;
      }, 0)
      : null;
    return { modelUsage, costUSD };
  }

  private providerAttempts(completion: LLMCallResult<RequirementsContent>): LLMProviderAttempt[] {
    if (completion.providerAttempts && completion.providerAttempts.length > 0) {
      return completion.providerAttempts.map((attempt) => ({ ...attempt }));
    }
    const rawUsage = completion.rawResponse.usage;
    const response = completion.rawResponse as OpenAI.Chat.Completions.ChatCompletion & { _request_id?: string | null };
    return [{
      attemptNumber: completion.attemptCount ?? 1,
      kind: "initial",
      providerResponseId: response.id || null,
      providerRequestId: response._request_id ?? null,
      model: response.model || completion.model,
      finishReason: completion.finishReason || null,
      promptTokens: rawUsage?.prompt_tokens ?? null,
      completionTokens: rawUsage?.completion_tokens ?? null,
      totalTokens: rawUsage?.total_tokens ?? null,
      usageSource: rawUsage ? "provider" : "unavailable",
      latencyMs: completion.latencyMs,
    }];
  }

  private knownTokenTotal(
    attempts: LLMProviderAttempt[],
    key: "promptTokens" | "completionTokens" | "totalTokens",
  ): number | null {
    const values = attempts.map((attempt) => attempt[key]).filter((value): value is number => value !== null);
    return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) : null;
  }

  private failure(error: PlanningDomainError): RequirementsRunFailure {
    return { code: error.code, message: error.message, details: error.details };
  }

  private async tryFailRun(
    projectId: string,
    runId: string,
    error: PlanningDomainError,
    audit?: RequirementsGenerationAudit,
  ): Promise<void> {
    try {
      await this.runs.failRequirementsRun(projectId, runId, this.failure(error), audit);
    } catch (cleanupError) {
      console.error("Failed to record Requirements generation failure; stale-run recovery may be required", {
        projectId,
        runId,
        reason: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      });
    }
  }

  private async tryConflictRun(
    projectId: string,
    runId: string,
    error: PlanningDomainError,
    audit?: RequirementsGenerationAudit,
  ): Promise<void> {
    try {
      await this.runs.markRequirementsRunConflicted(projectId, runId, this.failure(error), audit);
    } catch (cleanupError) {
      console.error("Failed to record Requirements generation conflict; stale-run recovery may be required", {
        projectId,
        runId,
        reason: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      });
    }
  }

  private async tryCancelRun(
    projectId: string,
    runId: string,
    audit?: RequirementsGenerationAudit,
  ): Promise<void> {
    try {
      await this.runs.cancelRequirementsRun(projectId, runId, {
        code: "PLANNING_AUTHORIZATION_CHANGED",
        message: "Requirements generation authorization changed before persistence.",
      }, audit);
    } catch (cleanupError) {
      console.error("Failed to cancel Requirements generation after authorization changed", {
        projectId,
        runId,
        reason: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      });
    }
  }
}
