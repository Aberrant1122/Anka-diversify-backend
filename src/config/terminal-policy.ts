export const TERMINAL_DISABLED = "TERMINAL_ISOLATION_REQUIRED";
export function assertTerminalAvailable(): void {
  // No environment switch: a host shell is not an isolated execution service.
  throw new Error(TERMINAL_DISABLED);
}
