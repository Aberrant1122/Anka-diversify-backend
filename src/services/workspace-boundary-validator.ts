import fs from "fs";
import path from "path";
import os from "os";

export class WorkspaceBoundaryError extends Error {
  constructor(public readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "WorkspaceBoundaryError";
  }
}

export class WorkspaceBoundaryValidator {
  /**
   * Resolves configured workspace roots.
   */
  static getApprovedWorkspaceRoots(): string[] {
    const roots: string[] = [];

    if (process.env.ANKA_WORKSPACE_ROOTS) {
      const split = process.env.ANKA_WORKSPACE_ROOTS.split(path.delimiter);
      for (const r of split) {
        if (r.trim()) roots.push(path.resolve(r.trim()));
      }
    }

    if (process.env.WORKSPACE_ROOT) {
      roots.push(path.resolve(process.env.WORKSPACE_ROOT.trim()));
    }

    // Default safe roots:
    // 1. Current working dir and its parent directory (workspace container)
    roots.push(path.resolve(process.cwd()));
    roots.push(path.resolve(process.cwd(), ".."));

    // 2. Temp directory for test isolation
    roots.push(path.resolve(os.tmpdir()));

    // 3. User profile desktop / evaluation folders if present
    const userProfile = process.env.USERPROFILE || process.env.HOME;
    if (userProfile) {
      roots.push(path.resolve(userProfile, "Desktop"));
      roots.push(path.resolve(userProfile, "Desktop", "anka diversity"));
      roots.push(path.resolve(userProfile, "Desktop", "anka evaluation"));
    }

    // Canonicalize all roots that exist
    return Array.from(
      new Set(
        roots.map((r) => {
          try {
            return fs.existsSync(r) ? (fs.realpathSync.native ? fs.realpathSync.native(r) : fs.realpathSync(r)) : path.resolve(r);
          } catch {
            return path.resolve(r);
          }
        })
      )
    );
  }

  /**
   * Validates and canonicalizes a path against approved workspace boundaries.
   * Checks for null bytes, path traversal sequences, and symlink escapes.
   */
  static canonicalizeAndValidate(
    targetPath: string,
    options: { forNewRepository?: boolean; allowedRoots?: string[] } = {}
  ): string {
    if (!targetPath || typeof targetPath !== "string") {
      throw new WorkspaceBoundaryError("INVALID_PATH", "Repository path must be a non-empty string.");
    }

    // Null bytes or control characters
    if (/[\0\r\n\x01-\x1f\x7f]/.test(targetPath)) {
      throw new WorkspaceBoundaryError("INVALID_PATH", "Path contains null bytes or illegal control characters.");
    }

    // Traversal components check before resolving
    const rawNormalized = targetPath.replace(/\\/g, "/");
    if (/(?:^|\/)\.\.(?:\/|$)/.test(rawNormalized)) {
      // Must not use explicit relative escape outside authorized context
      // We will also check after path.resolve against allowed roots
    }

    const resolved = path.resolve(targetPath);

    // Canonicalize if exists, or canonicalize the deepest existing parent
    let canonicalPath: string;
    if (fs.existsSync(resolved)) {
      try {
        canonicalPath = fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
      } catch (err: any) {
        throw new WorkspaceBoundaryError("CANONICALIZATION_FAILED", `Failed resolving real path: ${err?.message || err}`);
      }
    } else {
      // For a non-existent path, find deepest existing parent to canonicalize
      let current = resolved;
      const uncreatedSegments: string[] = [];
      while (!fs.existsSync(current)) {
        uncreatedSegments.unshift(path.basename(current));
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
      }
      try {
        const canonicalParent = fs.realpathSync.native ? fs.realpathSync.native(current) : fs.realpathSync(current);
        canonicalPath = path.resolve(canonicalParent, ...uncreatedSegments);
      } catch (err: any) {
        throw new WorkspaceBoundaryError("CANONICALIZATION_FAILED", `Failed resolving real path parent: ${err?.message || err}`);
      }
    }

    // Check against approved workspace roots
    const allowedRoots = options.allowedRoots || this.getApprovedWorkspaceRoots();
    const isInsideBoundary = allowedRoots.some((root) => {
      const rel = path.relative(root, canonicalPath);
      return !rel.startsWith("..") && !path.isAbsolute(rel);
    });

    if (!isInsideBoundary) {
      throw new WorkspaceBoundaryError(
        "WORKSPACE_BOUNDARY_VIOLATION",
        `Requested path "${canonicalPath}" is outside approved workspace boundaries.`
      );
    }

    // Check directory emptiness if creating a new repository
    if (options.forNewRepository) {
      if (fs.existsSync(canonicalPath)) {
        const stat = fs.statSync(canonicalPath);
        if (!stat.isDirectory()) {
          throw new WorkspaceBoundaryError("PATH_IS_NOT_DIRECTORY", `Target path "${canonicalPath}" exists and is not a directory.`);
        }
        const entries = fs.readdirSync(canonicalPath);
        if (entries.length > 0) {
          throw new WorkspaceBoundaryError(
            "DIRECTORY_NOT_EMPTY",
            `Refusing to overwrite occupied project directory "${canonicalPath}". It contains ${entries.length} file(s).`
          );
        }
      }
    }

    return canonicalPath;
  }
}
