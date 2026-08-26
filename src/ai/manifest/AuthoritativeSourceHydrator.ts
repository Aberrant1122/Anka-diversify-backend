import fs from "fs";
import path from "path";
import crypto from "crypto";
import { FileManifest } from "../../types";

export interface HydratedSource {
  path: string;
  content: string;
  sha256: string;
}

export interface ManifestSourceHydrationResult {
  success: boolean;
  authoritativeModifySources: Record<string, HydratedSource>;
  mergedSourceMap: Record<string, string>;
  modifyTargetsCount: number;
  hydratedCount: number;
  missingCount: number;
  error?: string;
}

export class AuthoritativeSourceHydrator {
  /**
   * Hydrates authoritative file contents for every approved manifest entry where action === "modify".
   * Reads from the active execution worktree (effectiveLocalPath).
   *
   * Invariant:
   * EVERY approved manifest MODIFY target must have an authoritative hydrated source
   * before code generation proceeds.
   */
  public static hydrateModifySources(
    manifest: FileManifest | null | undefined,
    effectiveLocalPath: string | null | undefined,
    canonicalExistingFiles: string[] = [],
    semanticFileContext: Record<string, string> = {},
  ): ManifestSourceHydrationResult {
    const authoritativeModifySources: Record<string, HydratedSource> = {};
    const mergedSourceMap: Record<string, string> = { ...semanticFileContext };

    if (!manifest || !Array.isArray(manifest.files) || manifest.files.length === 0) {
      return {
        success: true,
        authoritativeModifySources: {},
        mergedSourceMap,
        modifyTargetsCount: 0,
        hydratedCount: 0,
        missingCount: 0,
      };
    }

    const modifyEntries = manifest.files.filter((f) => f && (f.action || "modify").toLowerCase() === "modify");
    const normalizedCanonical = new Set(
      canonicalExistingFiles.map((f) => f.replace(/\\/g, "/").replace(/^\.\//, ""))
    );

    let missingCount = 0;

    for (const entry of modifyEntries) {
      const normPath = entry.path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\//, "");

      let fileContent: string | null = null;

      // 1. Authoritative source: Read directly from active worktree on disk
      if (effectiveLocalPath) {
        const absPath = path.resolve(effectiveLocalPath, normPath);
        if (fs.existsSync(absPath)) {
          try {
            const stat = fs.statSync(absPath);
            if (stat.isFile()) {
              fileContent = fs.readFileSync(absPath, "utf8");
            }
          } catch (err: any) {
            console.warn(`[AuthoritativeSourceHydrator] Error reading "${absPath}": ${err?.message}`);
          }
        }
      }

      // 2. Fallback: If not accessible on disk but already present in semanticFileContext or snapshot
      if (fileContent === null && typeof semanticFileContext[normPath] === "string") {
        fileContent = semanticFileContext[normPath];
      }

      // If source still cannot be found/read for an approved MODIFY action, fail closed
      if (fileContent === null) {
        missingCount++;
        console.error(
          `[MANIFEST_SOURCE] FAILED to hydrate source for approved modify target "${normPath}". localPath=${effectiveLocalPath || "none"}`
        );
        return {
          success: false,
          authoritativeModifySources: {},
          mergedSourceMap: {},
          modifyTargetsCount: modifyEntries.length,
          hydratedCount: Object.keys(authoritativeModifySources).length,
          missingCount,
          error: `[MANIFEST_SOURCE_HYDRATION_FAILED] Cannot hydrate authoritative source for approved modify target "${normPath}". The file does not exist or is unreadable in the active worktree.`,
        };
      }

      const sha256 = crypto.createHash("sha256").update(fileContent, "utf8").digest("hex");

      authoritativeModifySources[normPath] = {
        path: normPath,
        content: fileContent,
        sha256,
      };

      // Always populate/override into merged source map
      mergedSourceMap[normPath] = fileContent;
    }

    const hydratedCount = Object.keys(authoritativeModifySources).length;

    // Structured Telemetry
    console.log(`[MANIFEST_SOURCE] modifyTargets=${modifyEntries.length}`);
    console.log(`[MANIFEST_SOURCE] hydrated=${hydratedCount}`);
    console.log(`[MANIFEST_SOURCE] missing=0`);
    console.log(`[MANIFEST_SOURCE] semanticContextFiles=${Object.keys(semanticFileContext).length}`);
    console.log(`[MANIFEST_SOURCE] authoritativeModifyFiles=${hydratedCount}`);

    return {
      success: true,
      authoritativeModifySources,
      mergedSourceMap,
      modifyTargetsCount: modifyEntries.length,
      hydratedCount,
      missingCount: 0,
    };
  }
}
