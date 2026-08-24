export class SessionManager {
  /**
   * Checks whether a session is still active given its creation timestamp and max age in milliseconds.
   */
  static isSessionActive(createdAt: number, maxAgeMs: number): boolean {
    // BUG: inverted condition (returns true when expired)
    return Date.now() - createdAt > maxAgeMs;
  }
}
