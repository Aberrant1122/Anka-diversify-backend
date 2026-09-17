import { FileManifest } from "../../types";
import { AuthorizedCapabilityScope } from "./CapabilityGuard";
import { fingerprintBytes } from "../editing/EditingPrimitives";
import { MutationFailure } from "./MutationCompiler";

export interface ExecutionManifestUpdate {
  readonly previousVersion: string | null;
  readonly currentVersion: string;
  readonly authorizationId: string;
  readonly source: "PRE_EXECUTION_AUTHORITY_CLOSURE";
}
const updates = new WeakMap<FileManifest, ExecutionManifestUpdate>();

/** Only a freshly verified resolver-derived scope can reconcile a late manifest.
 * The approved exact grants determine membership; planning metadata grants nothing.
 */
export function reconcileExecutionManifest(scope: AuthorizedCapabilityScope, previous: FileManifest | null): FileManifest {
  const authorization = scope.currentExecutionAuthorization();
  if (!authorization) throw new MutationFailure("TRANSACTION_INVALIDATED", "Manifest reconciliation requires fresh evidence authorization.");
  const files = scope.mode.grants.map(grant => {
    const action = grant.action === "FILE_CREATE" ? "create" as const : grant.action === "FILE_DELETE" ? "delete" as const : "modify" as const;
    const prior = previous?.files.find(f => f.path === grant.path && f.action === action);
    return { path: grant.path, action, description: prior?.description || "Deterministically authorized execution target",
      dependencies: [...(prior?.dependencies ?? [])],
      repositoryDependencies: prior?.repositoryDependencies?.map(dependency => ({ ...dependency })),
      externalPackages: prior?.externalPackages?.map(dependency => ({ ...dependency })),
      evidenceIds: [...authorization.getEvidenceIds()] };
  });
  const version = fingerprintBytes(JSON.stringify({ previousVersion: previous?.manifestVersion, authorizationId: authorization.authorizationId, files }));
  const manifest: FileManifest = { files, totalFiles: files.length, manifestVersion: version };
  for (const file of files) {
    Object.freeze(file.dependencies);
    file.repositoryDependencies?.forEach(Object.freeze);
    file.externalPackages?.forEach(Object.freeze);
    if (file.repositoryDependencies) Object.freeze(file.repositoryDependencies);
    if (file.externalPackages) Object.freeze(file.externalPackages);
    Object.freeze(file.evidenceIds);
    Object.freeze(file);
  }
  Object.freeze(files); Object.freeze(manifest);
  updates.set(manifest, Object.freeze({ previousVersion: previous?.manifestVersion ?? null, currentVersion: version,
    authorizationId: authorization.authorizationId, source: "PRE_EXECUTION_AUTHORITY_CLOSURE" }));
  return manifest;
}

export function executionManifestUpdate(manifest: FileManifest): ExecutionManifestUpdate | undefined { return updates.get(manifest); }
