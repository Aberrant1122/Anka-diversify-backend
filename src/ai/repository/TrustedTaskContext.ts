import type { TaskIntentSpec } from "../shared/TaskIntentSpec";

const userRequests = new WeakMap<TaskIntentSpec, string>();
/** Backend request ingress only. Never bind a model-authored stage goal as user input. */
export function bindUserRequest(intent: TaskIntentSpec, originalRequest: string): void {
  userRequests.set(intent, originalRequest);
}
export function trustedUserRequest(intent: TaskIntentSpec): string | undefined {
  return userRequests.get(intent);
}
