import fs from "fs";
import path from "path";
import crypto from "crypto";
import { FileManifest, ExecutionContract, FileActionObligation } from "../../types";
import { normalizeRepoPath } from "../repository/SemanticContextResolver";
import { repositoryPath } from "../repository/RepositoryBoundary";
import { assertSafeWorktreePath } from "../validation/FileSystemStateManager";

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
   * Safely reads a candidate file from the active worktree with strict repository containment,
   * sensitive path exclusion, and regular-file verification.
   *
   * Security Invariant:
   * READ ONLY. This read grants zero write authority and zero capability.
   */
  public static readWorktreeSource(
    candidatePath: string,
    effectiveLocalPath: string | null | undefined,
  ): HydratedSource | null {
    if (!effectiveLocalPath || !candidatePath || typeof candidatePath !== "string") {
      return null;
    }

    if (candidatePath.includes("\0")) {
      return null;
    }

    const normPath = normalizeRepoPath(candidatePath);
    if (!normPath) {
      return null;
    }

    // Enforce repository boundary and sensitive/excluded path policy
    try {
      assertSafeWorktreePath(normPath, effectiveLocalPath);
    } catch {
      return null;
    }

    const repoAbsPath = repositoryPath(effectiveLocalPath, normPath);
    if (!repoAbsPath) {
      return null;
    }

    if (!fs.existsSync(repoAbsPath)) {
      return null;
    }

    try {
      const stat = fs.statSync(repoAbsPath);
      if (!stat.isFile()) {
        return null;
      }

      const content = fs.readFileSync(repoAbsPath, "utf8");
      const sha256 = crypto.createHash("sha256").update(content, "utf8").digest("hex");

      return {
        path: normPath,
        content,
        sha256,
      };
    } catch (err: any) {
      console.warn(`[AuthoritativeSourceHydrator] Error reading source "${normPath}": ${err?.message}`);
      return null;
    }
  }

  /**
   * Hydrates one or more late MODIFY candidates after generation, before proposal validation/resolution.
   *
   * Deduplicates candidate paths, ensures containment, and inserts exact worktree bytes into
   * the resolution source map.
   *
   * Security Invariant:
   * READ != WRITE. Hydration provisions source context for patch evaluation ONLY.
   */
  public static hydrateLateModifyCandidates(
    candidates: string[],
    effectiveLocalPath: string | null | undefined,
    resolutionSourceMap: Record<string, string>,
    authoritativeModifySources?: Record<string, HydratedSource>,
  ): {
    hydratedCount: number;
    hydratedSources: Record<string, HydratedSource>;
  } {
    const hydratedSources: Record<string, HydratedSource> = {};
    let hydratedCount = 0;

    if (!effectiveLocalPath || !Array.isArray(candidates) || candidates.length === 0) {
      return { hydratedCount: 0, hydratedSources };
    }

    const uniquePaths = Array.from(new Set(candidates.map((p) => normalizeRepoPath(p)).filter(Boolean)));

    for (const normPath of uniquePaths) {
      // If already present in resolutionSourceMap, skip duplicate read
      const alreadyPresent = Object.entries(resolutionSourceMap).some(
        ([k]) => normalizeRepoPath(k) === normPath
      );
      if (alreadyPresent) {
        continue;
      }

      const hydrated = this.readWorktreeSource(normPath, effectiveLocalPath);
      if (hydrated) {
        resolutionSourceMap[normPath] = hydrated.content;
        if (authoritativeModifySources) {
          authoritativeModifySources[normPath] = hydrated;
        }
        hydratedSources[normPath] = hydrated;
        hydratedCount++;
        console.log(
          `[MANIFEST_SOURCE] lateHydrated="${normPath}" sha256=${hydrated.sha256.slice(0, 8)}...`
        );
      }
    }

    return { hydratedCount, hydratedSources };
  }

  /**
   * Uses manifest and deterministic contract modify requests to select context, then hydrates source bytes
   * from current materialized disk reality.
   *
   * Invariant:
   * A semantic snapshot is only a fallback when no materialized repository is available.
   */
  public static hydrateModifySources(
    manifest: FileManifest | null | undefined,
    effectiveLocalPath: string | null | undefined,
    _canonicalExistingFiles: string[] = [],
    semanticFileContext: Record<string, string> = {},
    contract?: ExecutionContract | { actionObligations?: FileActionObligation[]; targetPaths?: string[]; targetProvenance?: Record<string, string> } | null,
  ): ManifestSourceHydrationResult {
    const authoritativeModifySources: Record<string, HydratedSource> = {};
    const mergedSourceMap: Record<string, string> = { ...semanticFileContext };

    // 1. Gather planned manifest MODIFY entries
    const manifestModifyEntries = (manifest && Array.isArray(manifest.files))
      ? manifest.files.filter((f) => f && (f.action || "modify").toLowerCase() === "modify")
      : [];

    // 2. Gather deterministic contract MODIFY targets (action-aware: exclude CREATE/DELETE)
    const contractModifyPaths = new Set<string>();
    if (contract) {
      if (Array.isArray(contract.actionObligations)) {
        for (const ob of contract.actionObligations) {
          if (ob && typeof ob.path === "string" && (ob.requiredAction || "").toLowerCase() === "modify") {
            contractModifyPaths.add(normalizeRepoPath(ob.path));
          }
        }
      }
      if (contract.targetProvenance) {
        for (const [p, prov] of Object.entries(contract.targetProvenance)) {
          if (prov === "DETERMINISTIC_REFERENCE_CLEANUP" && typeof p === "string") {
            const ob = contract.actionObligations?.find((o) => normalizeRepoPath(o.path) === normalizeRepoPath(p));
            if (!ob || (ob.requiredAction || "").toLowerCase() === "modify") {
              contractModifyPaths.add(normalizeRepoPath(p));
            }
          }
        }
      }
    }

    // 3. Union of all deterministic modify target paths
    const allModifyTargetPaths = new Set<string>();
    for (const entry of manifestModifyEntries) {
      allModifyTargetPaths.add(normalizeRepoPath(entry.path));
    }
    for (const p of contractModifyPaths) {
      allModifyTargetPaths.add(p);
    }

    if (allModifyTargetPaths.size === 0) {
      return {
        success: true,
        authoritativeModifySources: {},
        mergedSourceMap,
        modifyTargetsCount: 0,
        hydratedCount: 0,
        missingCount: 0,
      };
    }

    let missingCount = 0;

    for (const normPath of allModifyTargetPaths) {
      const isManifestEntry = manifestModifyEntries.some((e) => normalizeRepoPath(e.path) === normPath);

      let fileContent: string | null = null;
      let fileSha: string | null = null;

      // 1. Authoritative source: Read directly from active worktree on disk
      if (effectiveLocalPath) {
        const hydrated = this.readWorktreeSource(normPath, effectiveLocalPath);
        if (hydrated) {
          fileContent = hydrated.content;
          fileSha = hydrated.sha256;
        }
      }

      // A snapshot must not override current materialized disk reality.
      if (!effectiveLocalPath && fileContent === null && typeof semanticFileContext[normPath] === "string") {
        fileContent = semanticFileContext[normPath];
        fileSha = crypto.createHash("sha256").update(fileContent, "utf8").digest("hex");
      }

      // Current disk says the planned MODIFY source is absent; never resurrect it from stale context.
      if (fileContent === null) {
        if (isManifestEntry) {
          missingCount++;
          console.error(
            `[MANIFEST_SOURCE] FAILED to hydrate source for approved modify target "${normPath}". localPath=${effectiveLocalPath || "none"}`
          );
          return {
            success: false,
            authoritativeModifySources: {},
            mergedSourceMap: {},
            modifyTargetsCount: allModifyTargetPaths.size,
            hydratedCount: Object.keys(authoritativeModifySources).length,
            missingCount,
            error: `[MANIFEST_SOURCE_HYDRATION_FAILED] Cannot hydrate current disk source for planned modify target "${normPath}". The file does not exist or is unreadable in the active worktree.`,
          };
        } else {
          // Contract target not found on disk: do not crash Tier 1; do not invent action or hydrate
          continue;
        }
      }

      authoritativeModifySources[normPath] = {
        path: normPath,
        content: fileContent,
        sha256: fileSha || crypto.createHash("sha256").update(fileContent, "utf8").digest("hex"),
      };

      // Always populate/override into merged source map
      mergedSourceMap[normPath] = fileContent;
    }

    const hydratedCount = Object.keys(authoritativeModifySources).length;
    const modifyTargetsCount = allModifyTargetPaths.size;

    // Structured Telemetry
    console.log(`[MANIFEST_SOURCE] modifyTargets=${modifyTargetsCount}`);
    console.log(`[MANIFEST_SOURCE] hydrated=${hydratedCount}`);
    console.log(`[MANIFEST_SOURCE] missing=0`);
    console.log(`[MANIFEST_SOURCE] semanticContextFiles=${Object.keys(semanticFileContext).length}`);
    console.log(`[MANIFEST_SOURCE] authoritativeModifyFiles=${hydratedCount}`);

    return {
      success: true,
      authoritativeModifySources,
      mergedSourceMap,
      modifyTargetsCount,
      hydratedCount,
      missingCount: 0,
    };
  }
}
