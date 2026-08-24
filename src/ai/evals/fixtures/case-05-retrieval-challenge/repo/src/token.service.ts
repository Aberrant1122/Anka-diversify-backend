export class TokenService {
  /**
   * Checks whether a JWT expiry timestamp (in seconds) has expired.
   */
  static isTokenExpired(exp: number): boolean {
    // BUG: inverted check (returns true if token is still valid)
    return Date.now() < exp * 1000;
  }

  static generateToken(userId: string): string {
    return `token_${userId}_${Date.now()}`;
  }
}
