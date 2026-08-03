import {
  FileManifest,
  FileDeclaration,
  ValidationError,
  ValidationResult,
  ExecutionContract,
} from "../types";
import path from "path";

export interface RepositoryContext {
  existingFiles: string[];
}

export class ManifestValidator {
  private contract: ExecutionContract;
  private existingFiles: Set<string>;

  constructor(contract: ExecutionContract, repoContext?: RepositoryContext | string[]) {
    this.contract = contract;
    if (Array.isArray(repoContext)) {
      this.existingFiles = new Set(repoContext.map((f) => this.normalizePath(f)));
    } else if (repoContext && Array.isArray(repoContext.existingFiles)) {
      this.existingFiles = new Set(repoContext.existingFiles.map((f) => this.normalizePath(f)));
    } else {
      this.existingFiles = new Set();
    }
  }

  /**
   * Main entry point to validate a FileManifest against all rules.
   */
  public validate(manifest: FileManifest, options?: { isSubTask?: boolean }): ValidationResult {
    const errors: ValidationError[] = [];

    // Rule 1: Schema Conformance
    errors.push(...this.validateSchema(manifest));

    // If basic schema is broken, return early to prevent downstream crashes
    if (errors.some((e) => e.type === "schema")) {
      return { valid: false, errors };
    }

    // Special Case: Standalone HTML/CSS/JS Applications
    if (this.contract.pipeline === "STANDALONE" || this.contract.environment === "HTML_CSS_JS") {
      errors.push(...this.validateStandalone(manifest));
    } else {
      // Rule 2: File Limit Enforcement
      errors.push(...this.validateFileLimit(manifest, this.contract.maxFiles));
    }

    // Rule 3: Import Resolution
    errors.push(...this.validateImports(manifest));

    // Rule 4: Orphan Detection (bypassed if in sub-task mode)
    if (!options?.isSubTask) {
      errors.push(...this.detectOrphans(manifest));
    }

    // Rule 5: Path Constraints
    errors.push(...this.validatePaths(manifest, this.contract.targetPaths));

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Validates manifest structure, totalFiles equality, and valid action enumerations.
   */
  public validateSchema(manifest: FileManifest): ValidationError[] {
    const errors: ValidationError[] = [];

    if (!manifest || typeof manifest !== "object") {
      return [
        {
          type: "schema",
          affectedFiles: [],
          message: "Manifest must be a non-null object",
          suggestion: "Ensure the LLM output conforms to the JSON schema for FileManifest.",
        },
      ];
    }

    if (!Array.isArray(manifest.files)) {
      errors.push({
        type: "schema",
        affectedFiles: [],
        message: "Manifest 'files' property must be an array",
        suggestion: "Include a 'files' array in the manifest.",
      });
    }

    if (typeof manifest.totalFiles !== "number") {
      errors.push({
        type: "schema",
        affectedFiles: [],
        message: "Manifest 'totalFiles' property must be a number",
        suggestion: "Include a numeric 'totalFiles' property.",
      });
    } else if (Array.isArray(manifest.files) && manifest.totalFiles !== manifest.files.length) {
      errors.push({
        type: "schema",
        affectedFiles: manifest.files.map((f) => f.path || "unknown"),
        message: `Manifest totalFiles count (${manifest.totalFiles}) does not match files array length (${manifest.files.length})`,
        suggestion: "Ensure totalFiles matches the exact length of the files array.",
      });
    }

    if (!manifest.manifestVersion) {
      errors.push({
        type: "schema",
        affectedFiles: [],
        message: "Manifest missing 'manifestVersion' field",
        suggestion: "Set manifestVersion to '1.0.0'.",
      });
    }

    if (Array.isArray(manifest.files)) {
      manifest.files.forEach((file, index) => {
        if (!file.path || typeof file.path !== "string") {
          errors.push({
            type: "schema",
            affectedFiles: [`file[${index}]`],
            message: `File declaration at index ${index} missing valid 'path'`,
            suggestion: "Specify relative file path for every declaration.",
          });
        }
        if (!["create", "modify", "delete"].includes(file.action)) {
          errors.push({
            type: "schema",
            affectedFiles: [file.path || `file[${index}]`],
            message: `Invalid action '${file.action}' for file '${file.path}'. Must be 'create', 'modify', or 'delete'.`,
            suggestion: "Use valid action: 'create', 'modify', or 'delete'.",
          });
        }
        if (!Array.isArray(file.dependencies)) {
          errors.push({
            type: "schema",
            affectedFiles: [file.path || `file[${index}]`],
            message: `File '${file.path}' missing 'dependencies' array`,
            suggestion: "Include dependencies array (empty if none).",
          });
        }
      });
    }

    return errors;
  }

  /**
   * Validates that manifest totalFiles does not exceed maxFiles cap.
   */
  public validateFileLimit(manifest: FileManifest, maxFiles: number): ValidationError[] {
    const errors: ValidationError[] = [];

    if (maxFiles && maxFiles > 0 && manifest.files.length > maxFiles) {
      errors.push({
        type: "file_limit",
        affectedFiles: manifest.files.map((f) => f.path),
        message: `Manifest contains ${manifest.files.length} files, exceeding the maximum allowed limit of ${maxFiles}`,
        suggestion: `Reduce file modifications to under ${maxFiles} files, or decompose the feature into smaller sub-tasks.`,
      });
    }

    return errors;
  }

  /**
   * Validates that all imported local modules resolve to an existing repo file or a file in the manifest.
   */
  public validateImports(manifest: FileManifest): ValidationError[] {
    const errors: ValidationError[] = [];
    const manifestFilesMap = new Map<string, FileDeclaration>();

    // Build map of normalized manifest file paths
    manifest.files.forEach((f) => {
      if (f.path) {
        manifestFilesMap.set(this.normalizePath(f.path), f);
      }
    });

    for (const file of manifest.files) {
      if (!file.path || !Array.isArray(file.dependencies)) continue;
      if (file.action === "delete") continue;

      const fileDir = path.dirname(file.path);

      for (const dep of file.dependencies) {
        // Skip external package imports (e.g., 'react', 'express', 'lucide-react')
        if (this.isExternalPackage(dep)) continue;

        // Resolve local file path
        let resolvedPath = "";
        if (dep.startsWith("@/")) {
          resolvedPath = dep.substring(2);
        } else if (dep.startsWith("./") || dep.startsWith("../")) {
          resolvedPath = path.normalize(path.join(fileDir, dep)).replace(/\\/g, "/");
        } else {
          // Absolute path or root-relative path
          resolvedPath = dep.replace(/^[\/\\]/, "");
        }

        const isResolved = this.checkPathExists(resolvedPath, manifestFilesMap);
        if (!isResolved) {
          errors.push({
            type: "import_resolution",
            affectedFiles: [file.path],
            message: `Unresolved import dependency '${dep}' in file '${file.path}'`,
            suggestion: `Ensure '${dep}' is added to the manifest as a file to create/modify, or exists in the repository.`,
          });
        }
      }
    }

    return errors;
  }

  /**
   * Identifies newly created files that are not imported by any other file or entry point.
   */
  public detectOrphans(manifest: FileManifest): ValidationError[] {
    const errors: ValidationError[] = [];

    // Collect all created files
    const createdFiles = manifest.files.filter((f) => f.action === "create");
    if (createdFiles.length === 0) return errors;

    // Collect all declared dependency targets across all manifest files
    const manifestDependencies = new Set<string>();
    manifest.files.forEach((f) => {
      const fileDir = path.dirname(f.path);
      (f.dependencies || []).forEach((dep) => {
        if (!this.isExternalPackage(dep)) {
          if (dep.startsWith("@/")) {
            manifestDependencies.add(this.normalizePath(dep.substring(2)));
          } else if (dep.startsWith("./") || dep.startsWith("../")) {
            const resolved = path.normalize(path.join(fileDir, dep)).replace(/\\/g, "/");
            manifestDependencies.add(this.normalizePath(resolved));
          } else {
            manifestDependencies.add(this.normalizePath(dep));
          }
        }
      });
    });

    for (const createdFile of createdFiles) {
      const normalized = this.normalizePath(createdFile.path);

      // Check if entry point or config file
      if (this.isEntryPointOrConfig(createdFile.path)) continue;

      // Check if imported anywhere in manifest dependencies
      const isImportedInManifest = Array.from(manifestDependencies).some(
        (depPath) => this.pathsMatch(depPath, normalized)
      );

      if (!isImportedInManifest) {
        errors.push({
          type: "orphan",
          affectedFiles: [createdFile.path],
          message: `Orphaned file detected: '${createdFile.path}' is created but not imported by any other file in the manifest`,
          suggestion: `Add an import statement referencing '${createdFile.path}' in an entry point or parent component manifest entry.`,
        });
      }
    }

    return errors;
  }

  /**
   * Validates file path bounds against ExecutionContract targetPaths.
   */
  public validatePaths(manifest: FileManifest, targetPaths: string[]): ValidationError[] {
    const errors: ValidationError[] = [];

    // Standalone pipeline operates in root dir, bypass path constraint checking
    if (this.contract.pipeline === "STANDALONE" || this.contract.environment === "HTML_CSS_JS") {
      return errors;
    }

    if (!targetPaths || targetPaths.length === 0) return errors;
    if (targetPaths.includes("project-wide") || targetPaths.includes("*")) return errors;

    const normalizedTargets = targetPaths.map((t) => this.normalizePath(t).replace(/\/$/, ""));

    for (const file of manifest.files) {
      const normalizedFilePath = this.normalizePath(file.path);
      const isWithinTarget = normalizedTargets.some(
        (target) => normalizedFilePath === target || normalizedFilePath.startsWith(target + "/")
      );

      if (!isWithinTarget) {
        errors.push({
          type: "path_constraint",
          affectedFiles: [file.path],
          message: `Path constraint violation: '${file.path}' is outside designated target paths [${targetPaths.join(", ")}]`,
          suggestion: `Restrict file changes to paths under ${targetPaths.join(", ")}, or expand contract targetPaths.`,
        });
      }
    }

    return errors;
  }

  /**
   * Standalone application manifest validation (Requirement 13).
   */
  public validateStandalone(manifest: FileManifest): ValidationError[] {
    const errors: ValidationError[] = [];
    const filePaths = manifest.files.map((f) => this.normalizePath(f.path));

    const hasHtml = filePaths.some((p) => p.endsWith("index.html") || p.endsWith(".html"));
    const hasCss = filePaths.some((p) => p.endsWith("style.css") || p.endsWith("styles.css") || p.endsWith(".css"));
    const hasJs = filePaths.some((p) => p.endsWith("script.js") || p.endsWith("app.js") || p.endsWith(".js"));

    if (!hasHtml) {
      errors.push({
        type: "schema",
        affectedFiles: [],
        message: "Standalone application manifest must include index.html",
        suggestion: "Add index.html to manifest files.",
      });
    }

    // Verify index.html dependencies include css & js
    const htmlFile = manifest.files.find((f) => f.path.endsWith("index.html"));
    if (htmlFile) {
      const deps = (htmlFile.dependencies || []).map((d) => this.normalizePath(d));
      const hasCssDep = deps.some((d) => d.includes("css"));
      const hasJsDep = deps.some((d) => d.includes("js"));

      if (hasCss && !hasCssDep) {
        errors.push({
          type: "import_resolution",
          affectedFiles: [htmlFile.path],
          message: "index.html manifest declaration must list style.css in its dependencies",
          suggestion: "Add './style.css' to index.html dependencies.",
        });
      }

      if (hasJs && !hasJsDep) {
        errors.push({
          type: "import_resolution",
          affectedFiles: [htmlFile.path],
          message: "index.html manifest declaration must list script.js in its dependencies",
          suggestion: "Add './script.js' to index.html dependencies.",
        });
      }
    }

    return errors;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Helper Utility Methods
  // ──────────────────────────────────────────────────────────────────────────

  private normalizePath(p: string): string {
    return p.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
  }

  private isExternalPackage(importPath: string): boolean {
    if (importPath.startsWith(".") || importPath.startsWith("/") || importPath.startsWith("@/")) {
      return false;
    }
    return true;
  }

  private isEntryPointOrConfig(filePath: string): boolean {
    const norm = this.normalizePath(filePath);
    const basename = path.basename(norm);

    const entryBasenames = [
      "index.html",
      "app.tsx",
      "app.jsx",
      "app.js",
      "app.ts",
      "main.tsx",
      "main.jsx",
      "main.js",
      "main.ts",
      "page.tsx",
      "page.jsx",
      "page.js",
      "page.ts",
      "layout.tsx",
      "layout.jsx",
      "index.ts",
      "index.js",
      "server.ts",
      "server.js",
    ];

    const configNames = [
      "package.json",
      "tsconfig.json",
      ".env",
      "tailwind.config.js",
      "tailwind.config.ts",
      "next.config.js",
      "next.config.mjs",
      "vite.config.ts",
      "vite.config.js",
      "schema.prisma",
    ];

    return entryBasenames.includes(basename) || configNames.includes(basename);
  }

  private checkPathExists(resolvedPath: string, manifestMap: Map<string, FileDeclaration>): boolean {
    const norm = this.normalizePath(resolvedPath);

    // 1. Direct match in manifest
    if (manifestMap.has(norm)) return true;

    // 2. Direct match in existing repository files
    if (this.existingFiles.has(norm)) return true;

    // 3. Match with common extension fallbacks (.ts, .tsx, .js, .jsx, .css, /index.ts, etc.)
    const extensions = [".ts", ".tsx", ".js", ".jsx", ".css", "/index.ts", "/index.tsx", "/index.js"];

    for (const ext of extensions) {
      if (manifestMap.has(norm + ext) || this.existingFiles.has(norm + ext)) {
        return true;
      }
    }

    return false;
  }

  private pathsMatch(pathA: string, pathB: string): boolean {
    const normA = this.normalizePath(pathA);
    const normB = this.normalizePath(pathB);
    if (normA === normB) return true;
    const extensions = [".ts", ".tsx", ".js", ".jsx", ".css"];
    for (const ext of extensions) {
      if (normA + ext === normB || normB + ext === normA) return true;
    }
    return false;
  }
}
