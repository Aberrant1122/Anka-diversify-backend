import { AsyncLocalStorage } from "async_hooks";

export interface ActiveTaskRuntimeScope {
  budgetScopeId: string;
  contextScopeId: string;
}

const storage = new AsyncLocalStorage<ActiveTaskRuntimeScope>();

/** Propagates CP3 scope identity without giving TaskRuntime provider or mutation authority. */
export function runWithTaskRuntimeScope<T>(scope: ActiveTaskRuntimeScope, operation: () => Promise<T>): Promise<T> {
  return storage.run(Object.freeze({ ...scope }), operation);
}

export function getActiveTaskRuntimeScope(): ActiveTaskRuntimeScope | undefined {
  return storage.getStore();
}
