import { LLMBudgetConfigurationError, LLMBudgetExhaustedError } from "./LLMError";
import { PipelineStage } from "./PipelineStage";

export interface BudgetLimits {
  maxRequests: number;
  maxTokens: number;
}

export interface BudgetAttemptInput {
  scopeId: string;
  stage: PipelineStage;
  model: string;
  estimatedInputTokens: number;
  maxOutputTokens: number;
}

export interface BudgetReservation {
  id: string;
  scopeId: string;
  stage: PipelineStage;
  model: string;
  reservedTokens: number;
}

export interface BudgetSnapshot {
  scopeId: string;
  requestLimit: number;
  tokenLimit: number;
  requestsUsed: number;
  tokensUsed: number;
  tokensReserved: number;
  requestsRemaining: number;
  tokensRemaining: number;
}

export interface BudgetSettlement {
  outcome: "ACCOUNTED" | "ALREADY_ACCOUNTED";
  accountedTokens: number;
  overBudget: boolean;
  snapshot: BudgetSnapshot;
}

interface MutableBudgetState {
  requestsUsed: number;
  tokensUsed: number;
  tokensReserved: number;
}

interface MutableReservation extends BudgetReservation {
  settled: boolean;
  accountedTokens: number;
  overBudget: boolean;
}

function finiteNonNegativeInteger(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    throw new LLMBudgetConfigurationError(`${field} must be a finite non-negative integer`, {
      field,
      receivedValue: value,
    });
  }
  return value;
}

/** Runtime-local, deterministic request/token accounting. It has no persistence. */
export class BudgetManager {
  private readonly limits: BudgetLimits;
  private readonly states = new Map<string, MutableBudgetState>();
  private readonly reservations = new Map<string, MutableReservation>();
  private reservationSequence = 0;
  private operationSequence = 0;

  constructor(limits: Partial<BudgetLimits> = {}) {
    const maxRequests = finiteNonNegativeInteger(limits.maxRequests ?? 100, "maxRequests");
    const maxTokens = finiteNonNegativeInteger(limits.maxTokens ?? 500_000, "maxTokens");
    if (maxRequests < 1 || maxTokens < 1) {
      throw new LLMBudgetConfigurationError("Budget limits must be greater than zero", {
        maxRequests,
        maxTokens,
      });
    }
    this.limits = { maxRequests, maxTokens };
  }

  public createOperationScope(): string {
    this.operationSequence += 1;
    return `llm-operation-${this.operationSequence}`;
  }

  public beginAttempt(input: BudgetAttemptInput): BudgetReservation {
    if (!input.scopeId || !input.scopeId.trim()) {
      throw new LLMBudgetConfigurationError("Budget scopeId is required", { stage: input.stage });
    }
    const estimatedInputTokens = finiteNonNegativeInteger(input.estimatedInputTokens, "estimatedInputTokens");
    const maxOutputTokens = finiteNonNegativeInteger(input.maxOutputTokens, "maxOutputTokens");
    const requiredTokens = estimatedInputTokens + maxOutputTokens;
    const state = this.stateFor(input.scopeId);
    const snapshot = this.snapshot(input.scopeId);

    if (snapshot.requestsRemaining < 1 || snapshot.tokensRemaining < requiredTokens) {
      throw new LLMBudgetExhaustedError("LLM operation exceeds the remaining runtime budget", {
        stage: input.stage,
        model: input.model,
        requiredTokens,
        ...snapshot,
      });
    }

    state.requestsUsed += 1;
    state.tokensReserved += requiredTokens;
    this.reservationSequence += 1;
    const reservation: MutableReservation = {
      id: `budget-attempt-${this.reservationSequence}`,
      scopeId: input.scopeId,
      stage: input.stage,
      model: input.model,
      reservedTokens: requiredTokens,
      settled: false,
      accountedTokens: 0,
      overBudget: false,
    };
    this.reservations.set(reservation.id, reservation);
    return this.publicReservation(reservation);
  }

  public completeAttempt(reservation: BudgetReservation, totalTokens: number): BudgetSettlement {
    return this.settle(reservation, finiteNonNegativeInteger(totalTokens, "totalTokens"));
  }

  /**
   * A provider attempt that fails without usage data is charged its finite
   * reservation. This conservative policy makes retries budget-visible.
   */
  public failAttempt(reservation: BudgetReservation): BudgetSettlement {
    const stored = this.requireReservation(reservation);
    return this.settle(reservation, stored.reservedTokens);
  }

  public snapshot(scopeId: string): BudgetSnapshot {
    const state = this.stateFor(scopeId);
    return {
      scopeId,
      requestLimit: this.limits.maxRequests,
      tokenLimit: this.limits.maxTokens,
      requestsUsed: state.requestsUsed,
      tokensUsed: state.tokensUsed,
      tokensReserved: state.tokensReserved,
      requestsRemaining: Math.max(0, this.limits.maxRequests - state.requestsUsed),
      tokensRemaining: Math.max(0, this.limits.maxTokens - state.tokensUsed - state.tokensReserved),
    };
  }

  public releaseScope(scopeId: string): void {
    const hasActiveReservation = [...this.reservations.values()].some(
      (reservation) => reservation.scopeId === scopeId && !reservation.settled
    );
    if (hasActiveReservation) return;
    this.states.delete(scopeId);
    for (const [reservationId, reservation] of this.reservations) {
      if (reservation.scopeId === scopeId) this.reservations.delete(reservationId);
    }
  }

  private settle(reservation: BudgetReservation, accountedTokens: number): BudgetSettlement {
    const stored = this.requireReservation(reservation);
    if (stored.settled) {
      return {
        outcome: "ALREADY_ACCOUNTED",
        accountedTokens: stored.accountedTokens,
        overBudget: stored.overBudget,
        snapshot: this.snapshot(stored.scopeId),
      };
    }

    const state = this.stateFor(stored.scopeId);
    state.tokensReserved = Math.max(0, state.tokensReserved - stored.reservedTokens);
    state.tokensUsed += accountedTokens;
    stored.settled = true;
    stored.accountedTokens = accountedTokens;
    stored.overBudget = state.tokensUsed > this.limits.maxTokens;

    const snapshot = this.snapshot(stored.scopeId);
    return {
      outcome: "ACCOUNTED",
      accountedTokens,
      overBudget: stored.overBudget,
      snapshot,
    };
  }

  private requireReservation(reservation: BudgetReservation): MutableReservation {
    const stored = this.reservations.get(reservation.id);
    if (!stored || stored.scopeId !== reservation.scopeId) {
      throw new LLMBudgetConfigurationError("Unknown or mismatched budget reservation", {
        reservationId: reservation.id,
        scopeId: reservation.scopeId,
      });
    }
    return stored;
  }

  private stateFor(scopeId: string): MutableBudgetState {
    let state = this.states.get(scopeId);
    if (!state) {
      state = { requestsUsed: 0, tokensUsed: 0, tokensReserved: 0 };
      this.states.set(scopeId, state);
    }
    return state;
  }

  private publicReservation(reservation: MutableReservation): BudgetReservation {
    return {
      id: reservation.id,
      scopeId: reservation.scopeId,
      stage: reservation.stage,
      model: reservation.model,
      reservedTokens: reservation.reservedTokens,
    };
  }
}
