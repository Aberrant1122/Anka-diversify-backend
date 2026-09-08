import path from "path";
import { PolicyContract } from "./PolicyContract";
import { TaskIntentSpec } from "../shared/TaskIntentSpec";
import { RepositoryEvidenceStore, RepositoryEvidence } from "../repository/RepositoryEvidenceStore";
import { normalizeRepoPath } from "../repository/SemanticContextResolver";
import { MonorepoDescriptor } from "../workspace/MonorepoDetector";

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
}

export interface WriteSetResolverParams {
  policy: PolicyContract;
  intentSpec: TaskIntentSpec;
  proposedChanges: PlannedChange[];
  evidenceStore: RepositoryEvidenceStore;
  existingFiles: string[] | Set<string>;
  monorepo?: MonorepoDescriptor | null;
  targetRepositoryId?: string;
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

function findCandidateIntegrators(
  createChange: PlannedChange,
  allChanges: PlannedChange[],
  evidenceStore: RepositoryEvidenceStore
): PlannedChange[] {
  const normCreatePath = normalizeRepoPath(createChange.path);
  const integrators: PlannedChange[] = [];

  for (const other of allChanges) {
    if (normalizeRepoPath(other.path) === normCreatePath) continue;
    const normOtherPath = normalizeRepoPath(other.path);

    // 1. Explicitly designated in integration.satisfiedBy
    if (
      Array.isArray(createChange.integration?.satisfiedBy) &&
      createChange.integration.satisfiedBy.some(
        (s) => normalizeRepoPath(s) === normOtherPath || isDependencyMatch(s, normOtherPath)
      )
    ) {
      integrators.push(other);
      continue;
    }

    // 2. Incoming reverse edge: other change declares dependency on createChange
    if (
      Array.isArray(other.dependencies) &&
      other.dependencies.some((d) => isDependencyMatch(d, normCreatePath))
    ) {
      integrators.push(other);
      continue;
    }

    // 3. Deterministic repository evidence cited: IMPORT or REFERENCE connecting other and createChange
    const otherValidation = evidenceStore.validateEvidenceIds(other.evidenceIds || []);
    if (otherValidation.valid) {
      const hasRelation = otherValidation.evidence.some(
        (e) =>
          (e.kind === "IMPORT" || e.kind === "REFERENCE" || e.kind === "ROUTE" || e.kind === "SYMBOL") &&
          ((normalizeRepoPath(e.filePath) === normCreatePath && e.sourceFile && normalizeRepoPath(e.sourceFile) === normOtherPath) ||
            (normalizeRepoPath(e.filePath) === normOtherPath && e.sourceFile && normalizeRepoPath(e.sourceFile) === normCreatePath) ||
            (e.metadata?.dependencies && Array.isArray(e.metadata.dependencies) && e.metadata.dependencies.some((d: string) => isDependencyMatch(d, normCreatePath))))
      );
      if (hasRelation) {
        integrators.push(other);
        continue;
      }
    }
  }

  return integrators;
}

function hasDirectImportEvidence(
  change: PlannedChange,
  evidenceStore: RepositoryEvidenceStore
): boolean {
  const normPath = normalizeRepoPath(change.path);
  const validation = evidenceStore.validateEvidenceIds(change.evidenceIds || []);
  if (!validation.valid) return false;
  return validation.evidence.some(
    (e) =>
      e.kind === "IMPORT" &&
      (normalizeRepoPath(e.filePath) === normPath ||
        (e.sourceFile && Array.isArray(e.metadata?.dependencies) && e.metadata.dependencies.includes(normPath)))
  );
}

function findMatchingPlannedChange(
  dep: string,
  allChanges: PlannedChange[]
): PlannedChange | undefined {
  return allChanges.find((other) => isDependencyMatch(dep, other.path));
}

function findCreatedChangesIntegratedBy(
  modifyChange: PlannedChange,
  allChanges: PlannedChange[]
): PlannedChange[] {
  const normModPath = normalizeRepoPath(modifyChange.path);
  return allChanges.filter((other) => {
    if (other.action !== "create") return false;
    const normOther = normalizeRepoPath(other.path);
    // 1. modifyChange explicitly lists other in dependencies
    if (Array.isArray(modifyChange.dependencies) && modifyChange.dependencies.some((d) => isDependencyMatch(d, normOther))) {
      return true;
    }
    // 2. other declares satisfiedBy modifyChange
    if (
      Array.isArray(other.integration?.satisfiedBy) &&
      other.integration.satisfiedBy.some((s) => normalizeRepoPath(s) === normModPath || isDependencyMatch(s, normModPath))
    ) {
      return true;
    }
    return false;
  });
}

function hasDirectRelationEvidence(
  change: PlannedChange,
  evidenceStore: RepositoryEvidenceStore,
  intentSpec: TaskIntentSpec
): boolean {
  const normPath = normalizeRepoPath(change.path);
  if (intentSpec.explicitUserPaths.some((p) => normalizeRepoPath(p) === normPath)) {
    return true;
  }
  const validation = evidenceStore.validateEvidenceIds(change.evidenceIds || []);
  if (!validation.valid) return false;
  return validation.evidence.some((e) => {
    // FILE kind alone is existence only, NEVER relation
    if (e.kind === "FILE") return false;
    // ENTRY_POINT alone is role only, not blanket authority to modify unless task has explicit user path
    if (e.kind === "ENTRY_POINT") {
      return false;
    }
    if (e.kind === "REFERENCE" || e.kind === "IMPORT") {
      return (
        normalizeRepoPath(e.filePath) === normPath ||
        (e.sourceFile && normalizeRepoPath(e.sourceFile) === normPath)
      );
    }
    if (e.kind === "DIAGNOSTIC") {
      if (e.metadata?.stale === true) {
        return false;
      }
      return normalizeRepoPath(e.filePath) === normPath;
    }
    if (e.kind === "ROUTE" || e.kind === "SYMBOL" || e.kind === "TEST") {
      return normalizeRepoPath(e.filePath) === normPath;
    }
    if (e.kind === "STYLE_DEPENDENCY") {
      return (
        normalizeRepoPath(e.filePath) === normPath ||
        (e.sourceFile && normalizeRepoPath(e.sourceFile) === normPath)
      );
    }
    return false;
  });
}

/**
 * EvidenceBoundWriteSetResolver
 *
 * Invariants (Phase 2 & Pass 2):
 * 1. Sole authoritative write resolver.
 * 2. Every proposed change MUST cite valid backend-generated evidence IDs.
 * 3. Invented evidence IDs -> REJECT.
 * 4. Semantic score alone does NOT grant write authority.
 * 5. Active entry (App.tsx / page.tsx) is NOT automatic authority.
 * 6. CREATE requires integration evidence (must be imported/referenced by an approved reachable change).
 * 7. Two-phase evaluation: intrinsic eligibility followed by fixed-point dependency/integration closure.
 * 8. Order-independent: evaluation produces identical results regardless of proposedChanges array ordering.
 * 9. Rejections cascade through reverse integration edges and forward dependency edges until stable.
 * 10. Fail closed: If no changes are approved, returns empty approvedPaths.
 */
export class EvidenceBoundWriteSetResolver {
  public static resolve(params: WriteSetResolverParams): WriteAuthorizationResult {
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
      return {
        approvedPaths: [],
        rejectedPaths: proposedChanges.map((c) => ({ path: c.path, reason: "POLICY_BLOCKED_UNKNOWN_OR_CLARIFICATION" })),
        authorizedChanges: [],
      };
    }

    const isStandalone = policy.pipeline === "STANDALONE" || policy.repositoryRequired === false;

    // Phase A: Evaluate intrinsic eligibility for every change independently
    const intrinsicallyEligible = new Map<string, PlannedChange>();
    const rejectionReasons = new Map<string, string>();

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
      const isDeleteAllowed = policy.allowedActions.some((a) => a.includes("delete") || a.startsWith("clean_"));
      const isModifyAllowed = policy.allowedActions.some(
        (a) => a.includes("modify") || a.includes("update") || a.includes("import") || a.includes("edit") || a.includes("fix") || a.startsWith("write_")
      );
      const isAllowed = change.action === "create" ? isCreateAllowed : change.action === "delete" ? isDeleteAllowed : isModifyAllowed;
      if (!isAllowed) {
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
        rejectionReasons.set(normPath, `Cited non-existent or unverified evidence IDs: ${evidenceValidation.missingIds.join(", ")}`);
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
        if (!normPath.startsWith(normWs) && !normPath.startsWith(`${normWs}/`)) {
          const hasCrossWsEvidence = evidenceValidation.evidence.some((e) => e.kind === "WORKSPACE" || e.kind === "PACKAGE");
          if (!hasCrossWsEvidence) {
            console.log(`[WRITE_AUTH] candidate="${normPath}" decision=REJECT reason=MONOREPO_WORKSPACE_VIOLATION`);
            rejectionReasons.set(normPath, `File lies outside workspace root "${normWs}" without explicit cross-workspace evidence`);
            continue;
          }
        }
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
        const existenceEvidence = evidenceValidation.evidence.filter(
          (e) => normalizeRepoPath(e.filePath) === normPath && (e.kind === "FILE" || e.provenance === "REPO_READ")
        );
        if (existenceEvidence.length === 0) {
          console.log(`[WRITE_AUTH] candidate="${normPath}" decision=REJECT reason=NO_FILE_EXISTENCE_EVIDENCE`);
          rejectionReasons.set(normPath, "NO_FILE_EXISTENCE_EVIDENCE: No verified file existence evidence cited for target path");
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

        const existenceEvidence = evidenceValidation.evidence.filter(
          (e) =>
            normalizeRepoPath(e.filePath) === normPath &&
            (e.kind === "FILE" || e.provenance === "REPO_READ" || (e.kind === "DIAGNOSTIC" && !e.metadata?.stale))
        );
        if (existenceEvidence.length === 0) {
          console.log(`[WRITE_AUTH] candidate="${normPath}" decision=REJECT reason=NO_FILE_EXISTENCE_EVIDENCE`);
          rejectionReasons.set(normPath, "NO_FILE_EXISTENCE_EVIDENCE: No verified file existence evidence cited for target path");
          continue;
        }

        const hasDirectRelation = hasDirectRelationEvidence(change, evidenceStore, intentSpec);
        const createdChangesIntegrated = findCreatedChangesIntegratedBy(change, proposedChanges);
        const hasIntegrationCandidate =
          intentSpec.taskType !== "BUG_FIX" &&
          createdChangesIntegrated.length > 0 &&
          Array.isArray(change.dependencies) &&
          change.dependencies.length > 0;

        if (!hasDirectRelation && !hasIntegrationCandidate) {
          console.log(`[WRITE_AUTH] candidate="${normPath}" decision=REJECT reason=NO_TASK_OR_STRUCTURAL_RELATION`);
          rejectionReasons.set(
            normPath,
            "NO_TASK_OR_STRUCTURAL_RELATION: Cited evidence establishes existence only; no structural relation, reference, symbol, route, or explicit user path evidence proves relevance to task"
          );
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

        const requiresIntegration = !isStandalone && change.integration?.required !== false;
        if (requiresIntegration) {
          const candidateIntegrators = findCandidateIntegrators(change, proposedChanges, evidenceStore);
          const hasImportEv = hasDirectImportEvidence(change, evidenceStore);

          if (candidateIntegrators.length === 0 && !hasImportEv) {
            console.log(`[WRITE_AUTH] candidate="${normPath}" decision=REJECT reason=ORPHAN_CREATE_NO_INTEGRATION_EVIDENCE`);
            rejectionReasons.set(
              normPath,
              "ORPHAN_CREATE_NO_INTEGRATION_EVIDENCE: Orphan CREATE rejected: no integration evidence proving reachability from an approved modifying file or standalone pipeline"
            );
            continue;
          }
        }

        intrinsicallyEligible.set(normPath, change);
        continue;
      }
    }

    // Phase B: Fixed-Point Dependency Closure & Rejection Propagation
    let fixedPointChanged = true;
    while (fixedPointChanged) {
      fixedPointChanged = false;

      for (const [normPath, change] of Array.from(intrinsicallyEligible.entries())) {
        // Condition 1: If CREATE requires integration, at least one candidate integrator must remain eligible
        const requiresIntegration = !isStandalone && change.integration?.required !== false;
        if (change.action === "create" && requiresIntegration) {
          const candidateIntegrators = findCandidateIntegrators(change, proposedChanges, evidenceStore);
          const approvedIntegrators = candidateIntegrators.filter((p) => intrinsicallyEligible.has(normalizeRepoPath(p.path)));
          const hasImportEv = hasDirectImportEvidence(change, evidenceStore);

          if (approvedIntegrators.length === 0 && !hasImportEv) {
            const rejectedNames = candidateIntegrators
              .map((p) => `${p.path} (${rejectionReasons.get(normalizeRepoPath(p.path)) || "unapproved"})`)
              .join(", ");
            const reason =
              candidateIntegrators.length > 0
                ? `REJECT_INTEGRATION_DEPENDENCY: Integrating parent change was rejected or unapproved: ${rejectedNames}`
                : "REJECT_INTEGRATION: Orphan CREATE rejected: no approved integrating change";

            console.log(`[WRITE_AUTH] candidate="${normPath}" decision=REJECT reason=${reason}`);
            intrinsicallyEligible.delete(normPath);
            rejectionReasons.set(normPath, reason);
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

        // Condition 3: If MODIFY's ONLY relation was integrating a CREATE change, that CREATE must remain eligible
        if (change.action === "modify") {
          const hasDirectRelation = hasDirectRelationEvidence(change, evidenceStore, intentSpec);
          if (!hasDirectRelation) {
            const integratedCreates = findCreatedChangesIntegratedBy(change, proposedChanges);
            const approvedCreates = integratedCreates.filter((c) => intrinsicallyEligible.has(normalizeRepoPath(c.path)));
            if (approvedCreates.length === 0) {
              const reason = "NO_TASK_OR_STRUCTURAL_RELATION: Integrating created change was rejected or none approved";
              console.log(`[WRITE_AUTH] candidate="${normPath}" decision=REJECT reason=${reason}`);
              intrinsicallyEligible.delete(normPath);
              rejectionReasons.set(normPath, reason);
              fixedPointChanged = true;
              continue;
            }
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

    return {
      approvedPaths,
      rejectedPaths,
      authorizedChanges,
    };
  }
}
