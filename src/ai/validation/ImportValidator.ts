import { AgentFileChange } from "../../types";
import {
  extractPackageRoot,
  isAllowedBuiltinOrInstalled,
} from "../planning/RepositoryArchitectureDetector";

export interface ImportViolation {
  path: string;
  specifier: string;
  packageRoot: string;
  message: string;
}

export interface ImportValidationResult {
  valid: boolean;
  errors: ImportViolation[];
}

export class ImportValidator {
  private static readonly STATIC_IMPORT_REGEX =
    /(?:import|export)\s+(?:[\w*\s{},$]+\s+from\s+)?["']([^"']+)["']/g;
  private static readonly REQUIRE_REGEX =
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;
  private static readonly DYNAMIC_IMPORT_REGEX =
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

  /**
   * Extract all external and internal import specifiers from a source file.
   */
  public static extractImportSpecifiers(source: string): string[] {
    const specifiers = new Set<string>();

    let match: RegExpExecArray | null;
    const staticRe = new RegExp(this.STATIC_IMPORT_REGEX.source, "g");
    while ((match = staticRe.exec(source)) !== null) {
      if (match[1]) specifiers.add(match[1]);
    }

    const reqRe = new RegExp(this.REQUIRE_REGEX.source, "g");
    while ((match = reqRe.exec(source)) !== null) {
      if (match[1]) specifiers.add(match[1]);
    }

    const dynRe = new RegExp(this.DYNAMIC_IMPORT_REGEX.source, "g");
    while ((match = dynRe.exec(source)) !== null) {
      if (match[1]) specifiers.add(match[1]);
    }

    return Array.from(specifiers);
  }

  /**
   * Validates that all external package imports in the source are either Node builtins
   * or declared in the installedPackages inventory.
   */
  public static validateCodeImports(
    content: string,
    filePath: string,
    installedPackages: string[] | Set<string>
  ): ImportValidationResult {
    const errors: ImportViolation[] = [];
    const specifiers = this.extractImportSpecifiers(content);
    const installedSet = installedPackages instanceof Set ? installedPackages : new Set(installedPackages);

    for (const specifier of specifiers) {
      // Skip internal, relative, and alias imports
      if (
        specifier.startsWith(".") ||
        specifier.startsWith("/") ||
        specifier.startsWith("@/") ||
        specifier.startsWith("~/") ||
        specifier.startsWith("#")
      ) {
        continue;
      }

      const allowed = isAllowedBuiltinOrInstalled(specifier, installedSet);
      if (!allowed) {
        const root = extractPackageRoot(specifier);
        errors.push({
          path: filePath,
          specifier,
          packageRoot: root,
          message: `[UNDECLARED_EXTERNAL_DEPENDENCY] File "${filePath}" imports uninstalled external package "${specifier}" (package "${root}"). Allowed installed packages: [${Array.from(installedSet).join(", ") || "none"}].`,
        });
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Validates all proposed file changes against the installed packages inventory.
   */
  public static validateChangesImports(
    changes: readonly AgentFileChange[],
    installedPackages: string[] | Set<string>
  ): ImportValidationResult {
    const allErrors: ImportViolation[] = [];
    const installedSet = installedPackages instanceof Set ? installedPackages : new Set(installedPackages);

    if (installedSet.size === 0) {
      return { valid: true, errors: [] };
    }

    for (const change of changes) {
      if (change.action === "delete" || change.isDeleted) continue;
      if (!/\.(tsx|jsx|ts|js|mjs|cjs)$/.test(change.path)) continue;

      const res = this.validateCodeImports(change.content || "", change.path, installedSet);
      if (!res.valid) {
        allErrors.push(...res.errors);
      }
    }

    return {
      valid: allErrors.length === 0,
      errors: allErrors,
    };
  }
}
