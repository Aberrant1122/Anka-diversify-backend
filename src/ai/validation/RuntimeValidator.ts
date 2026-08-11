export class RuntimeValidator {
  static checkRuntimeIntegrity(changes: any[]): boolean {
    return changes.length > 0;
  }
}
