import { PhaseArtifact, Prisma, PrismaClient, WorkflowRun } from "@prisma/client";
import { LLMCallResult, LLMGateway, LLMProviderAttempt } from "../ai/gateway/LLMGateway";
import { LLMError, LLMRetryExhaustedError } from "../ai/gateway/LLMError";
import { PipelineStages } from "../ai/gateway/PipelineStage";
import {
  buildInitialDocumentationMessages, DOCUMENTATION_PROVIDER_JSON_SCHEMA,
  DOCUMENTATION_STRUCTURED_REPAIR_POLICY, validateGeneratedDocumentation,
} from "../ai/prompts/documentation";
import { assembleDocumentationContent } from "../planning/documentation-assembly";
import { DocumentationProviderDraft, DocumentationValidationError } from "../planning/documentation-schema";
import {
  DOCUMENTATION_MAX_OUTPUT_TOKENS, DOCUMENTATION_PROMPT_VERSION,
  DOCUMENTATION_PROVIDER_SCHEMA_VERSION,
} from "../planning/documentation-run-config";
import { PlanningDomainError, PlanningErrorCode } from "../planning/planning-errors";
import { PlanningAuthorizationService } from "./planning-authorization.service";
import { PlanningDocumentationArtifactService } from "./planning-documentation-artifact.service";
import { DocumentationReadiness, PlanningDocumentationReadinessService } from "./planning-documentation-readiness.service";
import {
  DocumentationGenerationAudit, DocumentationRunFailure,
  PlanningDocumentationRunService, StartDocumentationRunResult,
} from "./planning-documentation-run.service";

type DocumentationGateway = Pick<LLMGateway, "callStructured">;

export interface GenerateInitialDocumentationInput {
  projectId: string;
  actorId: string;
  idempotencyKey: string;
  includeMemory?: boolean;
}

export interface GenerateInitialDocumentationResult {
  run: WorkflowRun;
  artifact: PhaseArtifact | null;
  readiness: DocumentationReadiness | null;
  reused: boolean;
  httpStatus: 200 | 201 | 202;
}

const MODEL_RATES: Readonly<Record<string, { prompt: number; completion: number }>> = Object.freeze({
  "gpt-4o": { prompt: 2.5 / 1_000_000, completion: 10 / 1_000_000 },
  "gpt-4o-mini": { prompt: 0.15 / 1_000_000, completion: 0.6 / 1_000_000 },
});

function actualLLMError(error: unknown): LLMError | null {
  if (error instanceof LLMRetryExhaustedError && error.lastError instanceof LLMError) return error.lastError;
  return error instanceof LLMError ? error : null;
}

function providerError(error: unknown): PlanningDomainError {
  const llm = actualLLMError(error);
  const details = llm ? { gatewayCode: llm.code, ...(llm.stage ? { stage: llm.stage } : {}), ...(llm.model ? { model: llm.model } : {}) } : undefined;
  switch (llm?.code) {
    case "LLM_TIMEOUT": return new PlanningDomainError("PLANNING_AI_TIMEOUT", "Documentation generation timed out.", 504, details);
    case "LLM_NETWORK_ERROR": return new PlanningDomainError("PLANNING_AI_NETWORK_ERROR", "Documentation generation could not reach the model provider.", 503, details);
    case "LLM_RATE_LIMIT": return new PlanningDomainError("PLANNING_AI_RATE_LIMITED", "Documentation generation was rate limited.", 429, details);
    case "LLM_BUDGET_EXHAUSTED":
    case "LLM_BUDGET_INVALID": return new PlanningDomainError("PLANNING_AI_BUDGET_EXHAUSTED", "Documentation generation exceeded its model budget.", 429, details);
    case "LLM_CONTEXT_OVERFLOW": return new PlanningDomainError("PLANNING_AI_CONTEXT_TOO_LARGE", "Documentation generation context is too large.", 413, details);
    case "LLM_INVALID_JSON":
    case "LLM_SCHEMA_INVALID": return new PlanningDomainError("PLANNING_AI_INVALID_RESPONSE", "The model returned invalid Documentation content.", 502, details);
    case "LLM_REFUSAL": return new PlanningDomainError("PLANNING_AI_REFUSED", "The model refused to generate Documentation.", 422, details);
    case "LLM_CONTENT_FILTER": return new PlanningDomainError("PLANNING_AI_CONTENT_FILTERED", "Documentation generation was blocked by the provider content filter.", 422, details);
    case "LLM_TRUNCATED": return new PlanningDomainError("PLANNING_AI_TRUNCATED", "The model response was truncated.", 502, details);
    default: return new PlanningDomainError("PLANNING_AI_PROVIDER_ERROR", "Documentation generation failed at the model provider.", 502, details);
  }
}

export class PlanningDocumentationGenerationService {
  private readonly authorization: PlanningAuthorizationService;
  private readonly artifacts: PlanningDocumentationArtifactService;
  private readonly readiness: PlanningDocumentationReadinessService;
  private readonly runs: PlanningDocumentationRunService;
  private readonly gateway: DocumentationGateway;

  constructor(private readonly prisma: PrismaClient, dependencies: {
    authorization?: PlanningAuthorizationService;
    artifacts?: PlanningDocumentationArtifactService;
    readiness?: PlanningDocumentationReadinessService;
    runs?: PlanningDocumentationRunService;
    gateway?: DocumentationGateway;
  } = {}) {
    this.authorization = dependencies.authorization ?? new PlanningAuthorizationService(prisma);
    this.artifacts = dependencies.artifacts ?? new PlanningDocumentationArtifactService(prisma, this.authorization);
    this.readiness = dependencies.readiness ?? new PlanningDocumentationReadinessService();
    this.runs = dependencies.runs ?? new PlanningDocumentationRunService(prisma, {
      authorization: this.authorization, artifacts: this.artifacts, readiness: this.readiness,
    });
    this.gateway = dependencies.gateway ?? LLMGateway.getInstance();
  }

  async generateInitial(input: GenerateInitialDocumentationInput): Promise<GenerateInitialDocumentationResult> {
    let started: StartDocumentationRunResult;
    try {
      started = await this.runs.start({ ...input, includeMemory: input.includeMemory === true });
    } catch (error) {
      if (error instanceof PlanningDomainError) throw error;
      throw new PlanningDomainError("PLANNING_PERSISTENCE_FAILED", "Planning state could not be persisted. Please retry.", 503);
    }
    if (started.reused) return this.replay(input, started.run);

    let completion: LLMCallResult<DocumentationProviderDraft>;
    try {
      completion = await this.gateway.callStructured<DocumentationProviderDraft>({
        stage: PipelineStages.DOCUMENTATION_PLANNING,
        messages: buildInitialDocumentationMessages(started.context.payload),
        schema: {
          name: "anka_initial_documentation", description: "Initial Anka OS Documentation & Specs provider draft",
          schema: DOCUMENTATION_PROVIDER_JSON_SCHEMA, strict: true, validate: validateGeneratedDocumentation,
        },
        structuredRepair: { instructions: DOCUMENTATION_STRUCTURED_REPAIR_POLICY },
        maxTokens: DOCUMENTATION_MAX_OUTPUT_TOKENS,
        maxRetries: 1,
        context: { runId: started.run.id, projectId: input.projectId },
      });
    } catch (error) {
      const mapped = providerError(error);
      await this.tryFinish(input.projectId, started.run.id, "failed", mapped, this.auditForError(error));
      throw mapped;
    }

    const audit = this.audit(this.attempts(completion));
    let content: unknown;
    try {
      content = assembleDocumentationContent(
        completion.content,
        {
          artifactId: started.context.payload.sourceRequirements.artifactId,
          version: started.context.payload.sourceRequirements.version,
          contentHash: started.context.payload.sourceRequirements.contentHash,
        },
        started.context.payload.sourceRequirements.content,
      );
    } catch (error) {
      const size = error instanceof DocumentationValidationError && error.code === "DOCUMENTATION_SIZE_EXCEEDED";
      const mapped = new PlanningDomainError(
        size ? "PLANNING_AI_OUTPUT_TOO_LARGE" : "PLANNING_AI_INVALID_RESPONSE",
        size ? "Generated Documentation exceeds the canonical size limit." : "The model returned invalid Documentation content.",
        502,
      );
      await this.tryFinish(input.projectId, started.run.id, "failed", mapped, audit);
      throw mapped;
    }

    try {
      const finalized = await this.runs.finalize({
        projectId: input.projectId, runId: started.run.id, actorId: input.actorId,
        structuredContent: content, audit,
      });
      return { ...finalized, reused: false, httpStatus: 201 };
    } catch (error) {
      const mapped = error instanceof PlanningDomainError ? error : new PlanningDomainError("PLANNING_PERSISTENCE_FAILED", "Generated Documentation could not be persisted atomically.", 503);
      const status = mapped.code === "PLANNING_CONTEXT_CHANGED" || mapped.code === "PLANNING_CONCURRENT_UPDATE" ? "conflicted" : mapped.code === "PLANNING_PROJECT_NOT_FOUND" ? "cancelled" : "failed";
      await this.tryFinish(input.projectId, started.run.id, status, mapped, audit);
      throw mapped;
    }
  }

  private async replay(input: GenerateInitialDocumentationInput, run: WorkflowRun): Promise<GenerateInitialDocumentationResult> {
    if (run.status === "running") return { run, artifact: null, readiness: null, reused: true, httpStatus: 202 };
    if (run.status === "completed") {
      if (!run.outputArtifactId) throw new PlanningDomainError("PLANNING_RUN_INVARIANT", "Completed Documentation run is missing its output artifact.", 500, { runId: run.id });
      await this.authorization.assertCanRead(input.projectId, input.actorId);
      const result = await this.prisma.$transaction(async (tx) => {
        const artifact = await tx.phaseArtifact.findUnique({ where: { id: run.outputArtifactId! } });
        if (!artifact || artifact.projectId !== input.projectId) throw new PlanningDomainError("PLANNING_RUN_INVARIANT", "Completed Documentation run references a missing artifact.", 500, { runId: run.id });
        const validated = await this.artifacts.validatePersistedArtifactInTransaction(tx, input.projectId, artifact);
        return { artifact, readiness: this.readiness.evaluateDocumentation({ artifact, historicalRequirements: validated.historicalRequirements, currentApprovedRequirements: validated.currentApprovedRequirements }) };
      });
      return { run, ...result, reused: true, httpStatus: 200 };
    }
    const statusByCode: Record<string, number> = {
      PLANNING_AI_TIMEOUT: 504, PLANNING_AI_NETWORK_ERROR: 503, PLANNING_AI_PROVIDER_ERROR: 502,
      PLANNING_AI_RATE_LIMITED: 429, PLANNING_AI_BUDGET_EXHAUSTED: 429, PLANNING_AI_CONTEXT_TOO_LARGE: 413,
      PLANNING_AI_INVALID_RESPONSE: 502, PLANNING_AI_REFUSED: 422, PLANNING_AI_CONTENT_FILTERED: 422,
      PLANNING_AI_TRUNCATED: 502, PLANNING_AI_OUTPUT_TOO_LARGE: 502, PLANNING_PERSISTENCE_FAILED: 503,
      PLANNING_CONTEXT_CHANGED: 409, PLANNING_CONCURRENT_UPDATE: 409, PLANNING_STALE_RUN_RECOVERED: 409,
      PLANNING_AUTHORIZATION_CHANGED: 409,
    };
    const httpStatus = run.errorCode ? statusByCode[run.errorCode] : undefined;
    const expectedStatus = run.errorCode === "PLANNING_CONTEXT_CHANGED" || run.errorCode === "PLANNING_CONCURRENT_UPDATE"
      ? "conflicted"
      : run.errorCode === "PLANNING_AUTHORIZATION_CHANGED"
        ? "cancelled"
        : "failed";
    if (!run.errorCode || !httpStatus || run.status !== expectedStatus) {
      throw new PlanningDomainError("PLANNING_RUN_INVARIANT", "The stored Documentation run cannot be replayed safely.", 500, { runId: run.id, reused: true });
    }
    let message = "The previous Documentation generation attempt failed.";
    try {
      const value = run.errorMessage ? JSON.parse(run.errorMessage) as { message?: unknown } : null;
      if (typeof value?.message === "string" && value.message.trim()) message = value.message;
    } catch {
      throw new PlanningDomainError(
        "PLANNING_RUN_INVARIANT",
        "The stored Documentation run cannot be replayed safely.",
        500,
        { runId: run.id, reused: true },
      );
    }
    const replayCode: PlanningErrorCode = run.errorCode === "PLANNING_AUTHORIZATION_CHANGED"
      ? "PLANNING_RUN_CANCELLED"
      : run.errorCode as PlanningErrorCode;
    throw new PlanningDomainError(replayCode, message, httpStatus, { runId: run.id, reused: true });
  }

  private attempts(completion: LLMCallResult<DocumentationProviderDraft>): LLMProviderAttempt[] {
    if (completion.providerAttempts?.length) return completion.providerAttempts.map((attempt) => ({ ...attempt }));
    return [{ attemptNumber: completion.attemptCount ?? 1, kind: "initial", providerResponseId: null,
      providerRequestId: null, model: completion.model, finishReason: completion.finishReason ?? null,
      promptTokens: completion.usage?.promptTokens ?? null, completionTokens: completion.usage?.completionTokens ?? null,
      totalTokens: completion.usage?.totalTokens ?? null, usageSource: completion.usage ? "provider" : "unavailable", latencyMs: completion.latencyMs }];
  }

  private auditForError(error: unknown): DocumentationGenerationAudit | undefined {
    const llm = actualLLMError(error);
    return llm?.providerAttempts?.length ? this.audit([...llm.providerAttempts]) : undefined;
  }

  private audit(attempts: LLMProviderAttempt[]): DocumentationGenerationAudit {
    const provider = attempts.filter((attempt) => attempt.usageSource === "provider");
    const complete = attempts.length > 0 && provider.length === attempts.length && attempts.every((attempt) => attempt.promptTokens !== null && attempt.completionTokens !== null && attempt.totalTokens !== null);
    const total = (key: "promptTokens" | "completionTokens" | "totalTokens") => {
      const values = provider.map((attempt) => attempt[key]).filter((value): value is number => value !== null);
      return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
    };
    const promptTokens = total("promptTokens");
    const completionTokens = total("completionTokens");
    const totalTokens = total("totalTokens");
    const final = attempts[attempts.length - 1];
    const modelUsage: Prisma.InputJsonObject = {
      provider: "openai", model: final?.model ?? "unknown", providerResponseId: final?.providerResponseId ?? null,
      providerRequestId: final?.providerRequestId ?? null, promptTokens, completionTokens, totalTokens,
      usageSource: complete ? "provider" : provider.length ? "partial_provider" : "unavailable",
      providerUsageAttemptCount: provider.length, attempts: attempts as unknown as Prisma.InputJsonArray,
      attemptCount: attempts.length, finishReason: final?.finishReason ?? null,
      promptVersion: DOCUMENTATION_PROMPT_VERSION, schemaVersion: DOCUMENTATION_PROVIDER_SCHEMA_VERSION,
    };
    const costUSD = complete && attempts.every((attempt) => Boolean(MODEL_RATES[attempt.model]))
      ? attempts.reduce((sum, attempt) => sum + (attempt.promptTokens ?? 0) * MODEL_RATES[attempt.model].prompt + (attempt.completionTokens ?? 0) * MODEL_RATES[attempt.model].completion, 0)
      : null;
    return { modelUsage, costUSD };
  }

  private async tryFinish(projectId: string, runId: string, status: "failed" | "conflicted" | "cancelled", error: PlanningDomainError, audit?: DocumentationGenerationAudit): Promise<void> {
    const failure: DocumentationRunFailure = { code: status === "cancelled" ? "PLANNING_AUTHORIZATION_CHANGED" : error.code, message: error.message, details: error.details };
    try {
      await this.runs.finish(projectId, runId, status, failure, audit);
    } catch (cleanupError) {
      console.error("Failed to terminalize Documentation generation; stale-run recovery may be required", {
        projectId,
        runId,
        reason: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      });
    }
  }
}
