export class AuthService {
  static validateSession(token: string): boolean {
    return token.startsWith("admin_");
  }
}
