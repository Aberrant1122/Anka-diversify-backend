export class SessionService {
  private static sessions = new Map<string, any>();

  static setSession(sessionId: string, data: any) {
    this.sessions.set(sessionId, data);
  }

  static getSession(sessionId: string) {
    return this.sessions.get(sessionId);
  }
}
