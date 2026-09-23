import type { TaskIntentSpec } from "../shared/TaskIntentSpec";
import type { UserAuthorizedClause } from "../contracts/UserClauseAuthority";

const userRequests = new WeakMap<TaskIntentSpec, string>();
const stageAuthorizationContexts = new WeakMap<TaskIntentSpec, string>();
const stageAuthorizationClauses = new WeakMap<TaskIntentSpec, UserAuthorizedClause>();
const stageAuthorizationIds = new WeakMap<TaskIntentSpec, string>();

/** Backend request ingress only. Preserves original user request for audit and provenance. */
export function bindUserRequest(intent: TaskIntentSpec, originalRequest: string): void {
  userRequests.set(intent, originalRequest);
}

export function trustedUserRequest(intent: TaskIntentSpec): string | undefined {
  return userRequests.get(intent);
}

/** Deterministically derived active stage authorization context. */
export function bindStageAuthorizationContext(intent: TaskIntentSpec, stageContext: string): void {
  stageAuthorizationContexts.set(intent, stageContext);
}

export function trustedStageAuthorizationContext(intent: TaskIntentSpec): string | undefined {
  return stageAuthorizationContexts.get(intent);
}

/** Deterministically bound user-authorized clause for this stage. */
export function bindStageAuthorizationClause(intent: TaskIntentSpec, clause: UserAuthorizedClause): void {
  stageAuthorizationClauses.set(intent, clause);
  stageAuthorizationContexts.set(intent, clause.sourceText);
}

export function trustedStageAuthorizationClause(intent: TaskIntentSpec): UserAuthorizedClause | undefined {
  return stageAuthorizationClauses.get(intent);
}

/** Backend-owned execution-stage identity used to bind revision-scoped authorization facts. */
export function bindStageAuthorizationId(intent: TaskIntentSpec, stageId: string): void {
  if (stageId.trim()) stageAuthorizationIds.set(intent, stageId);
}

export function trustedStageAuthorizationId(intent: TaskIntentSpec): string | undefined {
  return stageAuthorizationIds.get(intent);
}
