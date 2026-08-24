export class AuthService {
  static hashPassword(password: string): string {
    return `hashed_${password}`;
  }

  static verifyPassword(password: string, hash: string): boolean {
    return `hashed_${password}` === hash;
  }
}
