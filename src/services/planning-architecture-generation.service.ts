import { PhaseArtifact, Prisma, PrismaClient, WorkflowRun } from "@prisma/client";
import { LLMCallResult, LLMGateway, LLMProviderAttempt } from "../ai/gateway/LLMGateway";
import { LLMError, LLMRetryExhaustedError } from "../ai/gateway/LLMError";
import { PipelineStages } from "../ai/gateway/PipelineStage";
import {
  ARCHITECTURE_PROVIDER_JSON_SCHEMA, ARCHITECTURE_STRUCTURED_REPAIR_POLICY,
  buildInitialArchitectureMessages, validateGeneratedArchitecture,
} from "../ai/prompts/architecture";
import { ARCHITECTURE_REVISION_REPAIR_POLICY, buildRevisionArchitectureMessages } from "../ai/prompts/architecture-revision";
import { assertArchitectureCapacity } from "../planning/architecture-capacity";
import { ArchitectureAuthoredDraft, ArchitectureValidationError } from "../planning/architecture-schema";
import { ArchitectureDeterministicDiff, ArchitectureRevisionOperation, ComponentRetirement, IdentityRetirement } from "../planning/architecture-revision-policy";
import { ARCHITECTURE_MAX_OUTPUT_TOKENS, ARCHITECTURE_PROVIDER_SCHEMA_VERSION } from "../planning/architecture-run-config";
import { PlanningDomainError, PlanningErrorCode } from "../planning/planning-errors";
import { ArchitectureReadiness } from "./planning-architecture-readiness.service";
import { ArchitectureRunAudit, PlanningArchitectureRunService } from "./planning-architecture-run.service";

type ArchitectureGateway = Pick<LLMGateway, "callStructured">;
export interface GenerateInitialArchitectureInput {
  projectId: string; actorId: string; idempotencyKey: string; includeMemory?: boolean;
}
export interface GenerateInitialArchitectureResult {
  run: WorkflowRun; artifact: PhaseArtifact | null; readiness: ArchitectureReadiness | null;
  reused: boolean; httpStatus: 200 | 201 | 202;
}
export interface ReviseArchitectureInput {
  projectId: string; actorId: string; idempotencyKey: string; operation: ArchitectureRevisionOperation;
  baseArtifactId: string; baseVersion: number; baseContentHash: string; instruction: string;
  includeMemory?: boolean; rebaseToCurrentAuthorities?: boolean; componentRetirements?: ComponentRetirement[]; identityRetirements?: IdentityRetirement[];
}
export interface ReviseArchitectureResult extends GenerateInitialArchitectureResult { diff: ArchitectureDeterministicDiff | null }
const MODEL_RATES: Readonly<Record<string, { prompt: number; completion: number }>> = Object.freeze({
  "gpt-4o": { prompt: 2.5 / 1_000_000, completion: 10 / 1_000_000 },
  "gpt-4o-mini": { prompt: 0.15 / 1_000_000, completion: 0.6 / 1_000_000 },
  "gpt-6-astra": { prompt: 10 / 1_000_000, completion: 50 / 1_000_000 },
  "gpt-6.1-sol": { prompt: 2 / 1_000_000, completion: 10 / 1_000_000 },
});
function actualLLMError(error: unknown): LLMError | null {
  if (error instanceof LLMRetryExhaustedError && error.lastError instanceof LLMError) return error.lastError;
  return error instanceof LLMError ? error : null;
}
function providerError(error: unknown): PlanningDomainError {
  const code = actualLLMError(error)?.code;
  switch (code) {
    case "LLM_TIMEOUT": return new PlanningDomainError("PLANNING_AI_TIMEOUT", "Architecture generation timed out.", 504);
    case "LLM_NETWORK_ERROR": return new PlanningDomainError("PLANNING_AI_NETWORK_ERROR", "Architecture generation could not reach the model provider.", 503);
    case "LLM_RATE_LIMIT": return new PlanningDomainError("PLANNING_AI_RATE_LIMITED", "Architecture generation was rate limited.", 429);
    case "LLM_BUDGET_EXHAUSTED":
    case "LLM_BUDGET_INVALID": return new PlanningDomainError("PLANNING_AI_BUDGET_EXHAUSTED", "Architecture generation exceeded its model budget.", 429);
    case "LLM_CONTEXT_OVERFLOW": return new PlanningDomainError("PLANNING_AI_CONTEXT_TOO_LARGE", "Architecture generation context is too large.", 413);
    case "LLM_INVALID_JSON":
    case "LLM_SCHEMA_INVALID": return new PlanningDomainError("PLANNING_AI_INVALID_RESPONSE", "The model returned invalid Architecture content.", 502);
    case "LLM_REFUSAL": return new PlanningDomainError("PLANNING_AI_REFUSED", "The model refused to generate Architecture.", 422);
    case "LLM_CONTENT_FILTER": return new PlanningDomainError("PLANNING_AI_CONTENT_FILTERED", "Architecture generation was blocked by the provider content filter.", 422);
    case "LLM_TRUNCATED": return new PlanningDomainError("PLANNING_AI_TRUNCATED", "The Architecture response was truncated.", 502);
    default: return new PlanningDomainError("PLANNING_AI_PROVIDER_ERROR", "Architecture generation failed at the model provider.", 502);
  }
}

export class PlanningArchitectureGenerationService {
  private readonly runs: PlanningArchitectureRunService;
  private readonly gateway: ArchitectureGateway;
  constructor(prisma: PrismaClient, dependencies: { runs?: PlanningArchitectureRunService; gateway?: ArchitectureGateway } = {}) {
    this.runs = dependencies.runs ?? new PlanningArchitectureRunService(prisma);
    this.gateway = dependencies.gateway ?? LLMGateway.getInstance();
  }

  async generateInitial(input: GenerateInitialArchitectureInput): Promise<GenerateInitialArchitectureResult> {
    let started: Awaited<ReturnType<PlanningArchitectureRunService["start"]>>;
    try {
      started = await this.runs.start({ ...input, includeMemory: input.includeMemory === true });
    } catch (error) {
      if (error instanceof PlanningDomainError) throw error;
      throw new PlanningDomainError("PLANNING_PERSISTENCE_FAILED", "Planning state could not be persisted. Please retry.", 503);
    }
    if (started.reused) return this.replay(input, started.run);
    const { payload, manifest } = started.context;
    const messages = buildInitialArchitectureMessages(payload);
    let completion: LLMCallResult<ArchitectureAuthoredDraft>;
    try {
      assertArchitectureCapacity(messages, ARCHITECTURE_PROVIDER_JSON_SCHEMA, ARCHITECTURE_STRUCTURED_REPAIR_POLICY);
      completion = await this.gateway.callStructured<ArchitectureAuthoredDraft>({
        stage: PipelineStages.ARCHITECTURE_GENERATION,
        messages,
        schema: { name: "anka_initial_architecture", description: "Initial Anka OS Architecture provider draft",
          schema: ARCHITECTURE_PROVIDER_JSON_SCHEMA, strict: true, validate: validateGeneratedArchitecture },
        structuredRepair: { instructions: ARCHITECTURE_STRUCTURED_REPAIR_POLICY },
        maxTokens: ARCHITECTURE_MAX_OUTPUT_TOKENS, maxRetries: 1,
        context: { runId: started.run.id, projectId: input.projectId },
      });
    } catch (error) {
      const mapped = error instanceof PlanningDomainError ? error : providerError(error);
      await this.tryFinish(input.projectId, started.run.id, "failed", mapped, this.auditForError(error, manifest.promptVersion));
      throw mapped;
    }
    const audit = this.audit(this.attempts(completion), manifest.promptVersion);
    // Defend against mocks and gateways that bypass their structured validator.
    const validation = validateGeneratedArchitecture(completion.content);
    if (!validation.valid || !validation.data || completion.finishReason === "length") {
      const mapped = new PlanningDomainError(completion.finishReason === "length" ? "PLANNING_AI_TRUNCATED" : "PLANNING_AI_INVALID_RESPONSE",
        completion.finishReason === "length" ? "The Architecture response was truncated." : "The model returned invalid Architecture content.", 502);
      await this.tryFinish(input.projectId, started.run.id, "failed", mapped, audit);
      throw mapped;
    }
    try {
      const finalized = await this.runs.finalize({ projectId: input.projectId, runId: started.run.id,
        actorId: input.actorId, structuredContent: validation.data, audit });
      return { ...finalized, reused: false, httpStatus: 201 };
    } catch (error) {
      let mapped: PlanningDomainError;
      if (error instanceof PlanningDomainError &&
          (error.code === "PLANNING_ARTIFACT_INVALID" || error.code === "PLANNING_INPUT_TOO_LARGE")) {
        mapped = new PlanningDomainError(error.code === "PLANNING_INPUT_TOO_LARGE" ? "PLANNING_AI_OUTPUT_TOO_LARGE" : "PLANNING_AI_INVALID_RESPONSE",
          error.code === "PLANNING_INPUT_TOO_LARGE" ? "Generated Architecture exceeds the canonical size limit." : "The model returned invalid Architecture content.", 502);
      } else if (error instanceof ArchitectureValidationError) {
        mapped = new PlanningDomainError("PLANNING_AI_INVALID_RESPONSE", "The model returned invalid Architecture content.", 502);
      } else {
        mapped = error instanceof PlanningDomainError ? error :
          new PlanningDomainError("PLANNING_PERSISTENCE_FAILED", "Generated Architecture could not be persisted atomically.", 503);
      }
      const status = mapped.code === "PLANNING_CONTEXT_CHANGED" || mapped.code === "PLANNING_CONCURRENT_UPDATE" ||
        mapped.code === "PLANNING_ACTION_LOCKED" ? "conflicted" : mapped.code === "PLANNING_PROJECT_NOT_FOUND" ? "cancelled" : "failed";
      await this.tryFinish(input.projectId, started.run.id, status, mapped, audit);
      throw mapped;
    }
  }

  async reviseArchitecture(input: ReviseArchitectureInput): Promise<ReviseArchitectureResult> {
    let started: Awaited<ReturnType<PlanningArchitectureRunService["startRevision"]>>;
    try {
      started = await this.runs.startRevision({ ...input, includeMemory: input.includeMemory === true,
        rebaseToCurrentAuthorities: input.rebaseToCurrentAuthorities === true });
    } catch (error) {
      if (error instanceof PlanningDomainError) throw error;
      throw new PlanningDomainError("PLANNING_PERSISTENCE_FAILED", "Planning state could not be persisted. Please retry.", 503);
    }
    if (started.reused) {
      if (started.run.status === "running") return { run: started.run, artifact: null, readiness: null, diff: null, reused: true, httpStatus: 202 };
      if (started.run.status === "completed") {
        const result = await this.runs.historicalRevisionResult(input.projectId, started.run);
        return { ...result, reused: true, httpStatus: 200 };
      }
      await this.replay(input, started.run);
      throw new PlanningDomainError("PLANNING_RUN_INVARIANT", "Stored Architecture revision cannot be replayed safely.", 500);
    }
    const { payload, manifest } = started.context;
    const format = { name: "anka_revise_architecture", description: "Anka OS Architecture revision provider draft" };
    let completion: LLMCallResult<ArchitectureAuthoredDraft>;
    try {
      const messages = buildRevisionArchitectureMessages(payload);
      assertArchitectureCapacity(messages, ARCHITECTURE_PROVIDER_JSON_SCHEMA, ARCHITECTURE_REVISION_REPAIR_POLICY, undefined, format, PipelineStages.ARCHITECTURE_REVISION);
      completion = await this.gateway.callStructured<ArchitectureAuthoredDraft>({
        stage: PipelineStages.ARCHITECTURE_REVISION, messages,
        schema: { ...format, schema: ARCHITECTURE_PROVIDER_JSON_SCHEMA, strict: true, validate: validateGeneratedArchitecture },
        structuredRepair: { instructions: ARCHITECTURE_REVISION_REPAIR_POLICY },
        maxTokens: ARCHITECTURE_MAX_OUTPUT_TOKENS, maxRetries: 1,
        context: { runId: started.run.id, projectId: input.projectId },
      });
    } catch (error) {
      const mapped = error instanceof PlanningDomainError ? error : providerError(error);
      await this.tryFinish(input.projectId, started.run.id, "failed", mapped, this.auditForError(error, manifest.promptVersion));
      throw mapped;
    }
    const baseAudit = this.audit(this.attempts(completion), manifest.promptVersion);
    const audit = { ...baseAudit, modelUsage: { ...baseAudit.modelUsage,
      componentRetirements: manifest.componentRetirements as unknown as Prisma.InputJsonArray,
      identityRetirements: manifest.identityRetirements as unknown as Prisma.InputJsonArray } };
    const validation = validateGeneratedArchitecture(completion.content);
    if (!validation.valid || !validation.data || completion.finishReason === "length") {
      const mapped = new PlanningDomainError(completion.finishReason === "length" ? "PLANNING_AI_TRUNCATED" : "PLANNING_AI_INVALID_RESPONSE",
        completion.finishReason === "length" ? "The Architecture response was truncated." : "The model returned invalid Architecture content.", 502);
      await this.tryFinish(input.projectId, started.run.id, "failed", mapped, audit);
      throw mapped;
    }
    try {
      const result = await this.runs.finalizeRevision({ projectId: input.projectId, runId: started.run.id,
        actorId: input.actorId, structuredContent: validation.data, audit });
      return { ...result, reused: false, httpStatus: 201 };
    } catch (error) {
      const mapped = error instanceof PlanningDomainError ? error :
        new PlanningDomainError("PLANNING_PERSISTENCE_FAILED", "Revised Architecture could not be persisted atomically.", 503);
      const status = mapped.code === "PLANNING_CONTEXT_CHANGED" || mapped.code === "PLANNING_CONCURRENT_UPDATE" ||
        mapped.code === "PLANNING_ACTION_LOCKED" ? "conflicted" : mapped.code === "PLANNING_PROJECT_NOT_FOUND" ? "cancelled" : "failed";
      await this.tryFinish(input.projectId, started.run.id, status, mapped, audit);
      throw mapped;
    }
  }

  private async replay(input: GenerateInitialArchitectureInput, run: WorkflowRun): Promise<GenerateInitialArchitectureResult> {
    if (run.status === "running") return { run, artifact: null, readiness: null, reused: true, httpStatus: 202 };
    if (run.status === "completed") {
      const result = await this.runs.historicalResult(input.projectId, run);
      return { ...result, reused: true, httpStatus: 200 };
    }
    const statusByCode: Record<string, number> = {
      PLANNING_AI_TIMEOUT: 504, PLANNING_AI_NETWORK_ERROR: 503, PLANNING_AI_PROVIDER_ERROR: 502,
      PLANNING_AI_RATE_LIMITED: 429, PLANNING_AI_BUDGET_EXHAUSTED: 429,
      PLANNING_AI_CONTEXT_TOO_LARGE: 413, PLANNING_AI_INVALID_RESPONSE: 502,
      PLANNING_AI_REFUSED: 422, PLANNING_AI_CONTENT_FILTERED: 422,
      PLANNING_AI_TRUNCATED: 502, PLANNING_AI_OUTPUT_TOO_LARGE: 502,
      PLANNING_REVISION_NO_CHANGES: 422,
      PLANNING_PERSISTENCE_FAILED: 503, PLANNING_CONTEXT_CHANGED: 409,
      PLANNING_CONCURRENT_UPDATE: 409, PLANNING_STALE_RUN_RECOVERED: 409,
      PLANNING_AUTHORIZATION_CHANGED: 409, PLANNING_ACTION_LOCKED: 409,
    };
    const status = run.errorCode && statusByCode[run.errorCode];
    const expected = run.errorCode === "PLANNING_CONTEXT_CHANGED" || run.errorCode === "PLANNING_CONCURRENT_UPDATE" ||
      run.errorCode === "PLANNING_ACTION_LOCKED" ? "conflicted" :
      run.errorCode === "PLANNING_AUTHORIZATION_CHANGED" ? "cancelled" : "failed";
    if (!status || run.status !== expected) throw new PlanningDomainError(
      "PLANNING_RUN_INVARIANT", "Stored Architecture run cannot be replayed safely.", 500);
    let message = "The previous Architecture generation attempt failed.";
    try {
      const stored = run.errorMessage ? JSON.parse(run.errorMessage) as { message?: unknown } : null;
      if (typeof stored?.message === "string") message = stored.message;
    } catch { throw new PlanningDomainError("PLANNING_RUN_INVARIANT", "Stored Architecture run cannot be replayed safely.", 500); }
    throw new PlanningDomainError(run.errorCode === "PLANNING_AUTHORIZATION_CHANGED" ? "PLANNING_RUN_CANCELLED" : run.errorCode! as PlanningErrorCode,
      message, status, { runId: run.id, reused: true });
  }

  private attempts(completion: LLMCallResult<ArchitectureAuthoredDraft>): LLMProviderAttempt[] {
    if (completion.providerAttempts?.length) return completion.providerAttempts.map((attempt) => ({ ...attempt }));
    return [{ attemptNumber: completion.attemptCount ?? 1, kind: "initial", providerResponseId: null,
      providerRequestId: null, model: completion.model, finishReason: completion.finishReason ?? null,
      promptTokens: null, completionTokens: null,
      totalTokens: null, usageSource: "unavailable",
      latencyMs: completion.latencyMs }];
  }
  private auditForError(error: unknown, promptVersion: string): ArchitectureRunAudit | undefined {
    const attempts = actualLLMError(error)?.providerAttempts;
    return attempts?.length ? this.audit([...attempts], promptVersion) : undefined;
  }
  private audit(attempts: LLMProviderAttempt[], promptVersion: string): ArchitectureRunAudit {
    const provider = attempts.filter((attempt) => attempt.usageSource === "provider");
    const complete = attempts.length > 0 && provider.length === attempts.length && attempts.every((attempt) =>
      attempt.promptTokens !== null && attempt.completionTokens !== null && attempt.totalTokens !== null);
    const total = (key: "promptTokens" | "completionTokens" | "totalTokens") => {
      const values = provider.map((attempt) => attempt[key]).filter((value): value is number => value !== null);
      return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
    };
    const final = attempts[attempts.length - 1];
    const modelUsage: Prisma.InputJsonObject = {
      provider: "openai", model: final?.model ?? "unknown", providerResponseId: final?.providerResponseId ?? null,
      providerRequestId: final?.providerRequestId ?? null, promptTokens: total("promptTokens"),
      completionTokens: total("completionTokens"), totalTokens: total("totalTokens"),
      usageSource: complete ? "provider" : provider.length ? "partial_provider" : "unavailable",
      providerUsageAttemptCount: provider.length, attempts: attempts as unknown as Prisma.InputJsonArray,
      attemptCount: attempts.length, finishReason: final?.finishReason ?? null,
      routeId: final?.routeId ?? null, reasoningEffort: final?.reasoningEffort ?? null,
      configuredMaxOutputTokens: final?.maxOutputTokens ?? null,
      promptVersion, schemaVersion: ARCHITECTURE_PROVIDER_SCHEMA_VERSION,
    };
    const costUSD = complete && attempts.every((attempt) => Boolean(MODEL_RATES[attempt.model]))
      ? attempts.reduce((sum, attempt) => sum + (attempt.promptTokens ?? 0) * MODEL_RATES[attempt.model].prompt +
        (attempt.completionTokens ?? 0) * MODEL_RATES[attempt.model].completion, 0) : null;
    return { modelUsage, costUSD };
  }
  private async tryFinish(projectId: string, runId: string, status: "failed" | "conflicted" | "cancelled",
    error: PlanningDomainError, audit?: ArchitectureRunAudit): Promise<void> {
    try { await this.runs.finish(projectId, runId, status,
      { code: status === "cancelled" ? "PLANNING_AUTHORIZATION_CHANGED" : error.code,
        message: status === "cancelled" ? "Architecture generation was cancelled because access changed." : error.message }, audit); }
    catch (cleanupError) { console.error("Failed to terminalize Architecture generation", {
      projectId, runId, reason: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
    }); }
  }
}
