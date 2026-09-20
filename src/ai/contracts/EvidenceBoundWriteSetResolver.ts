import fs from "fs";
import { resolveLocalImportEdges } from "../repository/DeterministicImportResolver";
import { TaskRootedAuthorizationVerifier, TaskRootedAuthorizationProof } from "./TaskRootedAuthorizationProof";
import { authoritySnapshot, withAuthoritySnapshot } from "../repository/AuthorityWorktree";
import path from "path";
import { PolicyContract } from "./PolicyContract";
import { TaskIntentSpec } from "../shared/TaskIntentSpec";
import { RepositoryEvidenceStore } from "../repository/RepositoryEvidenceStore";
import { normalizeRepoPath } from "../repository/SemanticContextResolver";
import { MonorepoDescriptor } from "../workspace/MonorepoDetector";
import type { CapabilityGrant, CapabilityAction } from "../runtime/CapabilityGuard";
import { trustedUserRequest } from "../repository/TrustedTaskContext";
import { TargetPathExtractor, ExtractedPathInfo } from "./TargetPathExtractor";

export interface EvidenceBoundAuthorization {
  readonly authorizationId: string;
  readonly repositoryId: string;
  isAuthentic(): boolean;
  getApprovedGrants(): readonly CapabilityGrant[];
  getEvidenceIds(): readonly string[];
  getWorkspaceRoot(): string | undefined;
  getBaseRevision(): string | undefined;
  getStageId(): string | undefined;
  getRunId(): string | undefined;
  getWorktreeRevision(): string | undefined;
}

interface EvidenceAuthorizationDetails {
  readonly proofs?: readonly TaskRootedAuthorizationProof[];
  readonly evidenceStore?: RepositoryEvidenceStore;
  readonly intentSpec?: TaskIntentSpec;
  readonly worktreeRevision?: string;
  readonly canonicalWorkspaceRoot?: string;
  readonly workspaceRoot?: string;
  readonly baseRevision?: string;
  readonly stageId?: string;
  readonly runId?: string;
  readonly approvedGrants: readonly CapabilityGrant[];
  readonly evidenceIds: readonly string[];
}

const authenticEvidenceAuthorizations = new WeakSet<object>();
const authorizationDetails = new WeakMap<object, EvidenceAuthorizationDetails>();

class ResolverIssuedEvidenceAuthorization implements EvidenceBoundAuthorization {
  private constructor(
    public readonly authorizationId: string,
    public readonly repositoryId: string,
  ) {
    authenticEvidenceAuthorizations.add(this);
    Object.freeze(this);
  }

  public static create(input: {
    proofs?: readonly TaskRootedAuthorizationProof[];
    evidenceStore?: RepositoryEvidenceStore;
    intentSpec?: TaskIntentSpec;
    worktreeRevision?: string;
    authorizationId: string;
    repositoryId: string;
    workspaceRoot?: string;
    baseRevision?: string;
    stageId?: string;
    runId?: string;
    approvedGrants: readonly CapabilityGrant[];
    evidenceIds: readonly string[];
  }): EvidenceBoundAuthorization {
    const artifact = new ResolverIssuedEvidenceAuthorization(input.authorizationId, input.repositoryId);
    authorizationDetails.set(artifact, Object.freeze({
      proofs: input.proofs ? Object.freeze([...input.proofs]) : undefined,
      evidenceStore: input.evidenceStore,
      intentSpec: input.intentSpec,
      worktreeRevision: input.worktreeRevision,
      canonicalWorkspaceRoot: input.workspaceRoot && input.worktreeRevision ? fs.realpathSync(input.workspaceRoot) : undefined,
      workspaceRoot: input.workspaceRoot ? path.resolve(input.workspaceRoot) : undefined,
      baseRevision: input.baseRevision,
      stageId: input.stageId,
      runId: input.runId,
      approvedGrants: Object.freeze(input.approvedGrants.map((grant) => Object.freeze({ ...grant }))),
      evidenceIds: Object.freeze([...input.evidenceIds]),
    }));
    return artifact;
  }

  public isAuthentic(): boolean { return authenticEvidenceAuthorizations.has(this); }
  public getApprovedGrants(): readonly CapabilityGrant[] { return authorizationDetails.get(this)?.approvedGrants ?? Object.freeze([]); }
  public getEvidenceIds(): readonly string[] { return authorizationDetails.get(this)?.evidenceIds ?? Object.freeze([]); }
  public getWorkspaceRoot(): string | undefined { return authorizationDetails.get(this)?.workspaceRoot; }
  public getBaseRevision(): string | undefined { return authorizationDetails.get(this)?.baseRevision; }
  public getStageId(): string | undefined { return authorizationDetails.get(this)?.stageId; }
  public getWorktreeRevision(): string | undefined { return authorizationDetails.get(this)?.worktreeRevision; }
  public getRunId(): string | undefined { return authorizationDetails.get(this)?.runId; }
}

export function isAuthenticEvidenceBoundAuthorization(value: unknown): value is EvidenceBoundAuthorization {
  return typeof value === "object" && value !== null && authenticEvidenceAuthorizations.has(value);
}

export function isCurrentEvidenceAuthorization(value: EvidenceBoundAuthorization): boolean {
  const details = authorizationDetails.get(value);
  try {
    if (!details?.workspaceRoot || !details.worktreeRevision || !details.evidenceStore || !details.intentSpec || !details.proofs) return false;
    if (fs.realpathSync(details.workspaceRoot) !== details.canonicalWorkspaceRoot) return false;
    return withAuthoritySnapshot(details.workspaceRoot, () => authoritySnapshot(details.workspaceRoot!).revision === details.worktreeRevision &&
      details.proofs!.every((proof) => TaskRootedAuthorizationVerifier.verify(details.evidenceStore!, details.intentSpec!, proof)));
  } catch { return false; }
}

export interface IntegrationObligation {
  required?: boolean;
  evidenceIds?: string[];
  satisfiedBy?: string[];
}

export interface PlannedChange {
  path: string;
  action: "create" | "modify" | "delete";
  reason: string;
  evidenceIds: string[];
  dependencies: string[];
  integration?: IntegrationObligation;
}

export interface WriteAuthorizationResult {
  approvedPaths: string[];
  rejectedPaths: Array<{ path: string; reason: string }>;
  authorizedChanges: PlannedChange[];
  evidenceAuthorization: EvidenceBoundAuthorization;
}

export interface WriteSetResolverParams {
  policy: PolicyContract;
  intentSpec: TaskIntentSpec;
  proposedChanges: PlannedChange[];
  evidenceStore: RepositoryEvidenceStore;
  existingFiles: string[] | Set<string>;
  monorepo?: MonorepoDescriptor | null;
  targetRepositoryId?: string;
  workspaceRoot?: string;
  baseRevision?: string;
  stageId?: string;
  /** Server-issued execution identity, never request/model supplied. */
  runId?: string;
}

function isDependencyMatch(dep: string, targetPath: string): boolean {
  if (!dep || !targetPath) return false;
  const normDep = normalizeRepoPath(dep).replace(/^\.\//, "").replace(/^@\//, "");
  const normTarget = normalizeRepoPath(targetPath).replace(/^\.\//, "");
  if (normDep === normTarget) return true;
  if (normTarget.endsWith(`/${normDep}`) || normTarget.endsWith(normDep)) return true;
  if (normDep.endsWith(`/${normTarget}`) || normDep.endsWith(normTarget)) return true;

  const targetExt = path.extname(normTarget);
  const targetWithoutExt = targetExt ? normTarget.slice(0, -targetExt.length) : normTarget;
  const depExt = path.extname(normDep);
  const depWithoutExt = depExt ? normDep.slice(0, -depExt.length) : normDep;

  if (targetWithoutExt === depWithoutExt) return true;
  if (targetWithoutExt.endsWith(`/${depWithoutExt}`)) return true;
  if (depWithoutExt.endsWith(`/${targetWithoutExt}`)) return true;

  const targetBase = path.basename(normTarget, targetExt);
  const depBase = path.basename(normDep, depExt);
  if (targetBase && depBase && (targetBase === depBase || dep.includes(targetBase))) return true;

  return false;
}

function findMatchingPlannedChange(dep: string, allChanges: PlannedChange[]): PlannedChange | undefined {
  return allChanges.find((other) => isDependencyMatch(dep, other.path));
}

/**
 * EvidenceBoundWriteSetResolver
 *
 * Backend task-rooted write-set resolver. Its opaque artifact is revalidated
 * by CapabilityGuard before capability issuance and first use.
 *
 * Planning invariants (Phase 2 & Pass 2):
 * 1. Grounds manifest-requested paths in deterministic repository evidence.
 * 2. Every proposed change MUST cite valid backend-generated evidence IDs.
 * 3. Invented evidence IDs -> REJECT.
 * 4. Semantic score alone does NOT establish eligibility.
 * 5. Active entry (App.tsx / page.tsx) is NOT automatically eligible.
 * 6. CREATE requires an exact path independently extracted from original user input.
 * 7. Task-rooted eligibility is followed by dependency and destructive cleanup closure.
 * 8. Order-independent: evaluation produces identical results regardless of proposedChanges array ordering.
 * 9. Required dependencies and importer cleanups must remain independently approved.
 * 10. If no changes are grounded, returns empty approvedPaths for compatibility.
 */
export class EvidenceBoundWriteSetResolver {
  public static resolve(params: WriteSetResolverParams): WriteAuthorizationResult {
    const workspace = params.evidenceStore.getDefaultWorkspace();
    if (workspace && params.evidenceStore.getCanonicalWorkspaceRoot()) return withAuthoritySnapshot(workspace, () => this.resolveBatch(params));
    return this.resolveBatch(params);
  }

  private static resolveBatch(params: WriteSetResolverParams): WriteAuthorizationResult {
    const {
      policy,
      intentSpec,
      proposedChanges,
      evidenceStore,
      existingFiles,
      monorepo,
      targetRepositoryId = evidenceStore?.getRepositoryId() || "default-repo",
    } = params;

    const existingSet = new Set(
      Array.isArray(existingFiles)
        ? existingFiles.map((f) => normalizeRepoPath(f))
        : Array.from(existingFiles).map((f) => normalizeRepoPath(f))
    );

    const approvedPaths: string[] = [];
    const rejectedPaths: Array<{ path: string; reason: string }> = [];
    const authorizedChanges: PlannedChange[] = [];

    // Fast-fail if policy requires clarification or task is unknown
    if (policy.requiresClarification || policy.taskType === "UNKNOWN") {
      console.log(`[WRITE_AUTH] Blocked: policy requires clarification or task is UNKNOWN.`);
      const emptyAuth = ResolverIssuedEvidenceAuthorization.create({
        authorizationId: `auth-blocked-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        repositoryId: targetRepositoryId,
        workspaceRoot: params.workspaceRoot ?? evidenceStore.getDefaultWorkspace(),
        baseRevision: params.baseRevision,
        stageId: params.stageId,
        runId: params.runId,
        approvedGrants: [],
        evidenceIds: [],
      });
      return {
        approvedPaths: [],
        rejectedPaths: proposedChanges.map((c) => ({ path: c.path, reason: "POLICY_BLOCKED_UNKNOWN_OR_CLARIFICATION" })),
        authorizedChanges: [],
        evidenceAuthorization: emptyAuth,
      };
    }


    // Phase A: Evaluate intrinsic eligibility for every change independently
    const intrinsicallyEligible = new Map<string, PlannedChange>();
    const rejectionReasons = new Map<string, string>();
    const candidateProofs = new Map<string, TaskRootedAuthorizationProof>();

    for (const change of proposedChanges) {
      const normPath = normalizeRepoPath(change.path);

      // 1. Policy max files check (fail-closed if total proposed files exceeds policy maxFiles)
      if (proposedChanges.length > policy.maxFiles) {
        console.log(`[WRITE_AUTH] candidate="${normPath}" decision=REJECT reason=MAX_FILES_EXCEEDED`);
        rejectionReasons.set(normPath, `Max allowed files exceeded (${policy.maxFiles})`);
        continue;
      }

      // 2. Action allowed by policy
      const isCreateAllowed = policy.allowedActions.some((a) => a.includes("create") || a.startsWith("write_"));
      const isDeleteAllowed = policy.allowedActions.some((a) => a.includes("delete"));
      const isModifyAllowed = policy.allowedActions.some(
        (a) => a.includes("modify") || a.includes("update") || a.includes("import") || a.includes("edit") || a.includes("fix") || a.startsWith("write_")
      );
      const isAllowed = change.action === "create" ? isCreateAllowed : change.action === "delete" ? isDeleteAllowed : isModifyAllowed;
      const forbidden = policy.forbiddenActions.some((a) => [change.action, `${change.action}_file`, `${change.action}_files`, ...(change.action === "delete" ? ["delete_folder", "delete_folders"] : [])].includes(a.toLowerCase()));
      if (!isAllowed || forbidden) {
        console.log(`[WRITE_AUTH] candidate="${normPath}" decision=REJECT reason=ACTION_NOT_ALLOWED_BY_POLICY`);
        rejectionReasons.set(normPath, `Action "${change.action}" is forbidden by PolicyContract`);
        continue;
      }

      // 3. Evidence IDs cited
      if (!Array.isArray(change.evidenceIds) || change.evidenceIds.length === 0) {
        console.log(`[WRITE_AUTH] candidate="${normPath}" decision=REJECT reason=NO_EVIDENCE_IDS_CITED`);
        rejectionReasons.set(normPath, "Proposed change cited no evidence IDs");
        continue;
      }

      // 4. Verify cited evidence IDs exist in backend store (fail closed against hallucinated IDs)
      const evidenceValidation = evidenceStore.validateEvidenceIds(change.evidenceIds);
      if (!evidenceValidation.valid) {
        console.log(
          `[WRITE_AUTH] candidate="${normPath}" decision=REJECT reason=INVENTED_OR_MISSING_EVIDENCE_IDS missing=[${evidenceValidation.missingIds.join(", ")}]`
        );
        rejectionReasons.set(
          normPath,
          `INVENTED_OR_MISSING_EVIDENCE_IDS: Cited non-existent or unverified evidence IDs: ${evidenceValidation.missingIds.join(", ")}`
        );
        continue;
      }

      const unauthenticatedEvidenceIds = evidenceValidation.evidence
        .filter((evidence) => !evidenceStore.isAuthorityEligible(evidence))
        .map((evidence) => evidence.id);
      if (unauthenticatedEvidenceIds.length > 0) {
        console.log(`[WRITE_AUTH] candidate="${normPath}" decision=REJECT reason=UNAUTHENTICATED_REPOSITORY_EVIDENCE ids=[${unauthenticatedEvidenceIds.join(", ")}]`);
        rejectionReasons.set(normPath, "UNAUTHENTICATED_REPOSITORY_EVIDENCE: Caller-shaped or advisory evidence cannot authorize mutation");
        continue;
      }

      // Prospective-file observations carry write authority = 0 and cannot satisfy mutation evidence requirements alone
      const nonProspectiveEvidence = evidenceValidation.evidence.filter(
        (e) => !e.metadata?.prospective && (e.kind as string) !== "PROSPECTIVE_FILE"
      );
      const isExplicitCreatePath =
        change.action === "create" &&
        (intentSpec.explicitUserPaths?.some((p) => normalizeRepoPath(p) === normPath) ||
          (trustedUserRequest(intentSpec) &&
            TargetPathExtractor.extractWithProvenance(trustedUserRequest(intentSpec)!, {
              repoFiles: Array.from(existingSet),
            }).some((p: ExtractedPathInfo) => p.provenance === "EXPLICIT_USER_PATH" && normalizeRepoPath(p.path) === normPath)));

      if (nonProspectiveEvidence.length === 0 && !isExplicitCreatePath) {
        console.log(`[WRITE_AUTH] candidate="${normPath}" decision=REJECT reason=PROSPECTIVE_EVIDENCE_ALONE_INSUFFICIENT`);
        rejectionReasons.set(
          normPath,
          "PROSPECTIVE_EVIDENCE_ALONE_INSUFFICIENT: Prospective absence observation carries zero mutation authority and cannot independently satisfy evidence requirements"
        );
        continue;
      }

      // 5. Check repository isolation
      const foreignRepoEvidence = evidenceValidation.evidence.some(
        (e) => e.repositoryId && e.repositoryId !== targetRepositoryId
      );
      if (foreignRepoEvidence) {
        console.log(`[WRITE_AUTH] candidate="${normPath}" decision=REJECT reason=MULTI_REPO_ISOLATION_VIOLATION`);
        rejectionReasons.set(normPath, `Evidence originated from outside the target repository "${targetRepositoryId}"`);
        continue;
      }

      // 6. Check monorepo workspace isolation
      if (monorepo?.isMonorepo && policy.workspaceRoot) {
        const normWs = normalizeRepoPath(policy.workspaceRoot);
        if (normPath !== normWs && !normPath.startsWith(`${normWs}/`)) {
          const hasCrossWsEvidence = evidenceValidation.evidence.some((e) => e.kind === "WORKSPACE" || e.kind === "PACKAGE");
          if (!hasCrossWsEvidence) {
            console.log(`[WRITE_AUTH] candidate="${normPath}" decision=REJECT reason=MONOREPO_WORKSPACE_VIOLATION`);
            rejectionReasons.set(normPath, `File lies outside workspace root "${normWs}" without explicit cross-workspace evidence`);
            continue;
          }
        }
      }

      const storeRoot = evidenceStore.getDefaultWorkspace();
      if (!storeRoot || !evidenceStore.getCanonicalWorkspaceRoot() || (params.workspaceRoot && fs.realpathSync(storeRoot) !== fs.realpathSync(params.workspaceRoot))) {
        rejectionReasons.set(normPath, "AUTHORITY_WORKSPACE_MISMATCH");
        continue;
      }
      // Mandatory task-rooted gate. Dependencies, manifests and existence can only
      // narrow an already proven candidate; they cannot create authority.
      const proof = TaskRootedAuthorizationVerifier.derive(evidenceStore, intentSpec, normPath, change.action);
      if (!proof) {
        rejectionReasons.set(normPath, "NO_TASK_OR_STRUCTURAL_RELATION: No current task-rooted forward proof");
        continue;
      }

      candidateProofs.set(normPath, proof);

      if (evidenceValidation.evidence.some((e) => e.repositoryRevision !== proof.repositoryRevision)) {
        rejectionReasons.set(normPath, "STALE_AUTHORITY_EVIDENCE: Evidence belongs to a different worktree revision");
        continue;
      }

      // 7. Validate DELETE
      if (change.action === "delete") {
        if (!existingSet.has(normPath)) {
          console.log(`[WRITE_AUTH] candidate="${normPath}" decision=REJECT reason=EXISTING_FILE_NOT_FOUND`);
          rejectionReasons.set(normPath, `Target file for delete does not exist in repository`);
          continue;
        }
        if (!intentSpec.destructive) {
          console.log(`[WRITE_AUTH] candidate="${normPath}" decision=REJECT reason=DELETE_WITHOUT_DESTRUCTIVE_INTENT`);
          rejectionReasons.set(normPath, "DELETE_WITHOUT_DESTRUCTIVE_INTENT: DELETE action proposed without structured destructive intent");
          continue;
        }
        // Action compatibility: Importer cleanup paths are authorized for MODIFY only, never DELETE
        const isImporterCleanup =
          intentSpec.resolvedTarget?.importerPaths?.some((p) => normalizeRepoPath(p) === normPath) ||
          intentSpec.resolvedTarget?.actionObligations?.some(
            (o) => normalizeRepoPath(o.path) === normPath && (o.requiredAction === "modify" || o.role === "DEPENDENCY_CLEANUP")
          );
        if (isImporterCleanup) {
          console.log(`[WRITE_AUTH] candidate="${normPath}" decision=REJECT reason=NOT_AUTHORIZED_FOR_DELETE`);
          rejectionReasons.set(
            normPath,
            "NOT_AUTHORIZED_FOR_DELETE: Importer cleanup path is only authorized for MODIFY, not DELETE"
          );
          continue;
        }
        const existenceEvidence = evidenceValidation.evidence.filter(
          (e) =>
            normalizeRepoPath(e.filePath) === normPath &&
            !e.metadata?.prospective &&
            (e.kind === "FILE" || e.provenance === "REPO_READ") &&
            e.provenance !== "SEMANTIC_SEARCH"
        );
        if (existenceEvidence.length === 0) {
          console.log(`[WRITE_AUTH] candidate="${normPath}" decision=REJECT reason=NO_FILE_EXISTENCE_EVIDENCE`);
          rejectionReasons.set(normPath, "NO_FILE_EXISTENCE_EVIDENCE: No verified file existence evidence cited for target path; semantic search alone is not delete authority");
          continue;
        }
        intrinsicallyEligible.set(normPath, change);
        continue;
      }

      // 8. Validate MODIFY
      if (change.action === "modify") {
        if (!existingSet.has(normPath)) {
          console.log(`[WRITE_AUTH] candidate="${normPath}" decision=REJECT reason=EXISTING_FILE_NOT_FOUND`);
          rejectionReasons.set(normPath, "EXISTING_FILE_NOT_FOUND: Target file for modify does not exist in repository");
          continue;
        }
        // Action compatibility: Primary destructive targets must be DELETED, not MODIFIED
        const isPrimaryDestructiveTarget =
          (intentSpec.destructive && intentSpec.resolvedTarget?.candidatePaths?.some((p) => normalizeRepoPath(p) === normPath)) ||
          intentSpec.resolvedTarget?.actionObligations?.some(
            (o) => normalizeRepoPath(o.path) === normPath && (o.requiredAction === "delete" || o.role === "PRIMARY_TARGET")
          );
        if (isPrimaryDestructiveTarget) {
          console.log(`[WRITE_AUTH] candidate="${normPath}" decision=REJECT reason=ACTION_MISMATCH_WITH_INTENT`);
          rejectionReasons.set(
            normPath,
            "ACTION_MISMATCH_WITH_INTENT: Primary destructive target must be DELETED, not MODIFIED"
          );
          continue;
        }

        const existenceEvidence = evidenceValidation.evidence.filter(
          (e) =>
            normalizeRepoPath(e.filePath) === normPath &&
            !e.metadata?.prospective &&
            (e.kind === "FILE" || e.provenance === "REPO_READ" || (e.kind === "DIAGNOSTIC" && !e.metadata?.stale))
        );
        if (existenceEvidence.length === 0) {
          console.log(`[WRITE_AUTH] candidate="${normPath}" decision=REJECT reason=NO_FILE_EXISTENCE_EVIDENCE`);
          rejectionReasons.set(normPath, "NO_FILE_EXISTENCE_EVIDENCE: No verified file existence evidence cited for target path");
          continue;
        }

        intrinsicallyEligible.set(normPath, change);
        continue;
      }

      // 9. Validate CREATE
      if (change.action === "create") {
        if (existingSet.has(normPath)) {
          console.log(`[WRITE_AUTH] candidate="${normPath}" decision=REJECT reason=CANNOT_CREATE_EXISTING_FILE`);
          rejectionReasons.set(normPath, "CANNOT_CREATE_EXISTING_FILE: File already exists; cannot create");
          continue;
        }

        // Prospective creates reached this point only through an independently
        // explicit user path. Model-supplied integration/dependency metadata is
        // never a substitute for that root.
        intrinsicallyEligible.set(normPath, change);
        continue;
      }
    }

    // Phase B: Fixed-Point Dependency Closure & Rejection Propagation
    let fixedPointChanged = true;
    while (fixedPointChanged) {
      fixedPointChanged = false;

      for (const [normPath, change] of Array.from(intrinsicallyEligible.entries())) {
        // Integration declarations only restrict independently rooted CREATEs.
        // A rejected integrating parent cannot leave its dependent create behind.
        if (change.action === "create" && change.integration?.required !== false) {
          const integrators = proposedChanges.filter((other) => normalizeRepoPath(other.path) !== normPath && (
            change.integration?.satisfiedBy?.some((p) => normalizeRepoPath(p) === normalizeRepoPath(other.path)) ||
            other.dependencies?.some((dep) => isDependencyMatch(dep, normPath))
          ));
          if ((change.integration?.required === true || integrators.length > 0) &&
              !integrators.some((other) => other.action !== "delete" && intrinsicallyEligible.has(normalizeRepoPath(other.path)))) {
            intrinsicallyEligible.delete(normPath);
            rejectionReasons.set(normPath, "REJECT_INTEGRATION_DEPENDENCY: Required integrating change is not independently authorized");
            fixedPointChanged = true;
            continue;
          }
        }

        // Condition 2: Forward dependencies check
        if (Array.isArray(change.dependencies) && change.dependencies.length > 0) {
          let rejectedDependencyPath: string | null = null;
          for (const dep of change.dependencies) {
            const matching = findMatchingPlannedChange(dep, proposedChanges);
            if (matching && normalizeRepoPath(matching.path) !== normPath) {
              const normMatching = normalizeRepoPath(matching.path);
              if (!intrinsicallyEligible.has(normMatching)) {
                rejectedDependencyPath = matching.path;
                break;
              }
            }
          }

          if (rejectedDependencyPath) {
            const depReason = rejectionReasons.get(normalizeRepoPath(rejectedDependencyPath)) || "unapproved";
            const reason = `REJECT_DEPENDENCY: Required dependency '${rejectedDependencyPath}' was rejected (${depReason})`;
            console.log(`[WRITE_AUTH] candidate="${normPath}" decision=REJECT reason=${reason}`);
            intrinsicallyEligible.delete(normPath);
            rejectionReasons.set(normPath, reason);
            fixedPointChanged = true;
            continue;
          }
        }

        // Condition 4: Destructive dependency closure — DELETE target requires all incoming importer cleanups to remain approved
        if (change.action === "delete") {
          const workspace = evidenceStore.getDefaultWorkspace();
          const incoming = workspace ? [...authoritySnapshot(workspace).files.keys()].filter((file) =>
            /\.[cm]?[jt]sx?$/.test(file) && resolveLocalImportEdges(workspace, file).some((edge) => edge.targetFile === normPath)) : [];
          const missingCleanup = incoming.find((file) => !intrinsicallyEligible.has(file));
          if (missingCleanup) {
            intrinsicallyEligible.delete(normPath);
            rejectionReasons.set(normPath, `REJECT_DEPENDENCY: Required importer cleanup '${missingCleanup}' is not independently authorized`);
            fixedPointChanged = true;
            continue;
          }

        }
      }
    }

    // Build final deterministic results
    for (const [normPath, change] of intrinsicallyEligible.entries()) {
      console.log(`[WRITE_AUTH] candidate="${normPath}" decision=APPROVE action=${change.action} evidenceIds=[${change.evidenceIds.join(", ")}]`);
      approvedPaths.push(normPath);
      authorizedChanges.push(change);
    }

    for (const change of proposedChanges) {
      const normPath = normalizeRepoPath(change.path);
      if (!intrinsicallyEligible.has(normPath)) {
        rejectedPaths.push({
          path: normPath,
          reason: rejectionReasons.get(normPath) || "Failed dependency closure or write authorization",
        });
      }
    }

    const approvedGrants: CapabilityGrant[] = authorizedChanges.map((change) => ({
      path: normalizeRepoPath(change.path),
      action: change.action === "create"
        ? ("FILE_CREATE" as CapabilityAction)
        : change.action === "delete"
          ? ("FILE_DELETE" as CapabilityAction)
          : ("FILE_MODIFY" as CapabilityAction),
    }));

    const proofs = authorizedChanges.map((change) => candidateProofs.get(normalizeRepoPath(change.path))!);
    const allEvidenceIds: string[] = [...new Set(proofs.flatMap((proof) => [proof.rootEvidenceId, ...proof.edgeEvidenceIds]))];
    for (const change of authorizedChanges) {
      for (const id of change.evidenceIds || []) {
        if (id && !allEvidenceIds.includes(id)) {
          allEvidenceIds.push(id);
        }
      }
    }

    const evidenceAuthorization = ResolverIssuedEvidenceAuthorization.create({
      proofs, evidenceStore, intentSpec,
      worktreeRevision: params.evidenceStore.getDefaultWorkspace() && params.evidenceStore.getCanonicalWorkspaceRoot() ? authoritySnapshot(params.evidenceStore.getDefaultWorkspace()!).revision : undefined,
      authorizationId: `auth-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      repositoryId: targetRepositoryId,
      workspaceRoot: params.workspaceRoot ?? evidenceStore.getDefaultWorkspace(),
      baseRevision: params.baseRevision,
      stageId: params.stageId,
      runId: params.runId,
      approvedGrants,
      evidenceIds: allEvidenceIds,
    });

    return {
      approvedPaths,
      rejectedPaths,
      authorizedChanges,
      evidenceAuthorization,
    };
  }
}
