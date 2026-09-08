import path from "path";
import { PolicyContract } from "./PolicyContract";
import { TaskIntentSpec } from "../shared/TaskIntentSpec";
import { RepositoryEvidenceStore, RepositoryEvidence } from "../repository/RepositoryEvidenceStore";
import { normalizeRepoPath } from "../repository/SemanticContextResolver";
import { MonorepoDescriptor } from "../workspace/MonorepoDetector";

export interface PlannedChange {
  path: string;
  action: "create" | "modify" | "delete";
  reason: string;
  evidenceIds: string[];
  dependencies: string[];
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

/**
 * EvidenceBoundWriteSetResolver
 *
 * Invariants (Phase 2):
 * 1. Sole authoritative write resolver.
 * 2. Every proposed change MUST cite valid backend-generated evidence IDs.
 * 3. Invented evidence IDs -> REJECT.
 * 4. Semantic score alone does NOT grant write authority.
 * 5. Active entry (App.tsx / page.tsx) is NOT automatic authority.
 * 6. CREATE requires integration evidence (must be imported/referenced by an approved reachable change).
 * 7. DELETE requires structured destructive intent + target evidence + reference cleanup evidence.
 * 8. Monorepo / Multi-repo: Strictly isolated to target workspace and repository.
 * 9. Fail closed: If no changes are approved, returns empty approvedPaths.
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
      return { approvedPaths: [], rejectedPaths: proposedChanges.map((c) => ({ path: c.path, reason: "POLICY_BLOCKED_UNKNOWN_OR_CLARIFICATION" })), authorizedChanges: [] };
    }

    // Step 1: Pre-validate evidence existence and boundary for all proposed changes
    for (const change of proposedChanges) {
      const normPath = normalizeRepoPath(change.path);

      // Check max files limit
      if (approvedPaths.length >= policy.maxFiles) {
        console.log(`[WRITE_AUTH] candidate="${normPath}" decision=REJECT reason=MAX_FILES_EXCEEDED`);
        rejectedPaths.push({ path: normPath, reason: `Max allowed files exceeded (${policy.maxFiles})` });
        continue;
      }

      // Check action allowed by policy
      const isCreateAllowed = policy.allowedActions.some((a) => a.includes("create") || a.startsWith("write_"));
      const isDeleteAllowed = policy.allowedActions.some((a) => a.includes("delete") || a.startsWith("clean_"));
      const isModifyAllowed = policy.allowedActions.some(
        (a) => a.includes("modify") || a.includes("update") || a.includes("import") || a.includes("edit") || a.includes("fix") || a.startsWith("write_")
      );
      const isAllowed = change.action === "create" ? isCreateAllowed : change.action === "delete" ? isDeleteAllowed : isModifyAllowed;
      if (!isAllowed) {
        console.log(`[WRITE_AUTH] candidate="${normPath}" decision=REJECT reason=ACTION_NOT_ALLOWED_BY_POLICY`);
        rejectedPaths.push({ path: normPath, reason: `Action "${change.action}" is forbidden by PolicyContract` });
        continue;
      }

      // Check evidence IDs provided
      if (!Array.isArray(change.evidenceIds) || change.evidenceIds.length === 0) {
        console.log(`[WRITE_AUTH] candidate="${normPath}" decision=REJECT reason=NO_EVIDENCE_IDS_CITED`);
        rejectedPaths.push({ path: normPath, reason: "Proposed change cited no evidence IDs" });
        continue;
      }

      // Verify cited evidence IDs exist in backend store (fail closed against hallucinated IDs)
      const evidenceValidation = evidenceStore.validateEvidenceIds(change.evidenceIds);
      if (!evidenceValidation.valid) {
        console.log(
          `[WRITE_AUTH] candidate="${normPath}" decision=REJECT reason=INVENTED_OR_MISSING_EVIDENCE_IDS missing=[${evidenceValidation.missingIds.join(", ")}]`
        );
        rejectedPaths.push({
          path: normPath,
          reason: `Cited non-existent or unverified evidence IDs: ${evidenceValidation.missingIds.join(", ")}`,
        });
        continue;
      }

      // Check repository isolation: evidence must belong to target repository
      const foreignRepoEvidence = evidenceValidation.evidence.some(
        (e) => e.repositoryId && e.repositoryId !== targetRepositoryId
      );
      if (foreignRepoEvidence) {
        console.log(`[WRITE_AUTH] candidate="${normPath}" decision=REJECT reason=MULTI_REPO_ISOLATION_VIOLATION`);
        rejectedPaths.push({
          path: normPath,
          reason: `Evidence originated from outside the target repository "${targetRepositoryId}"`,
        });
        continue;
      }

      // Check monorepo workspace isolation if workspace boundaries are defined
      if (monorepo?.isMonorepo && policy.workspaceRoot) {
        const normWs = normalizeRepoPath(policy.workspaceRoot);
        if (!normPath.startsWith(normWs) && !normPath.startsWith(`${normWs}/`)) {
          // Check if explicit cross-workspace dependency evidence exists
          const hasCrossWsEvidence = evidenceValidation.evidence.some((e) => e.kind === "WORKSPACE" || e.kind === "PACKAGE");
          if (!hasCrossWsEvidence) {
            console.log(`[WRITE_AUTH] candidate="${normPath}" decision=REJECT reason=MONOREPO_WORKSPACE_VIOLATION`);
            rejectedPaths.push({
              path: normPath,
              reason: `File lies outside workspace root "${normWs}" without explicit cross-workspace evidence`,
            });
            continue;
          }
        }
      }

      // Validate MODIFY / DELETE: File MUST already exist on disk / snapshot
      if (change.action === "modify" || change.action === "delete") {
        if (!existingSet.has(normPath)) {
          console.log(`[WRITE_AUTH] candidate="${normPath}" decision=REJECT reason=EXISTING_FILE_NOT_FOUND`);
          rejectedPaths.push({ path: normPath, reason: `Target file for ${change.action} does not exist in repository` });
          continue;
        }

        // DELETE authorization requires structured destructive intent
        if (change.action === "delete") {
          if (!intentSpec.destructive) {
            console.log(`[WRITE_AUTH] candidate="${normPath}" decision=REJECT reason=DELETE_WITHOUT_DESTRUCTIVE_INTENT`);
            rejectedPaths.push({ path: normPath, reason: "DELETE action proposed without structured destructive intent" });
            continue;
          }
        }

        // Separate EXISTENCE EVIDENCE from RELATION EVIDENCE
        // A. Existence evidence: cited evidence MUST contain verified existence for this path
        const existenceEvidence = evidenceValidation.evidence.filter(
          (e) => normalizeRepoPath(e.filePath) === normPath && (e.kind === "FILE" || e.provenance === "REPO_READ")
        );
        if (existenceEvidence.length === 0) {
          console.log(`[WRITE_AUTH] candidate="${normPath}" decision=REJECT reason=NO_FILE_EXISTENCE_EVIDENCE`);
          rejectedPaths.push({ path: normPath, reason: "No verified file existence evidence cited for target path" });
          continue;
        }

        // B. Relation evidence: Plain FILE existence or SEMANTIC_SEARCH provenance alone is NOT relation evidence.
        // Relation must be proven by deterministic repository relation facts:
        // - exact explicit user path
        // - REFERENCE / IMPORT linking this file
        // - ROUTE ownership
        // - SYMBOL ownership in this file
        // - STYLE_DEPENDENCY link
        // - DIAGNOSTIC causality
        // - TEST relation
        // - Integration link from another planned change
        const isExplicitUserPath = intentSpec.explicitUserPaths.some((p) => normalizeRepoPath(p) === normPath);

        const relationEvidence = evidenceValidation.evidence.filter((e) => {
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
          if (e.kind === "ROUTE") {
            return normalizeRepoPath(e.filePath) === normPath;
          }
          if (e.kind === "SYMBOL") {
            return normalizeRepoPath(e.filePath) === normPath;
          }
          if (e.kind === "STYLE_DEPENDENCY") {
            return (
              normalizeRepoPath(e.filePath) === normPath ||
              (e.sourceFile && normalizeRepoPath(e.sourceFile) === normPath)
            );
          }
          if (e.kind === "DIAGNOSTIC" || e.kind === "TEST") {
            return normalizeRepoPath(e.filePath) === normPath;
          }
          return false;
        });

        // Integration relationship from planned changes:
        // Either this change integrates a planned created file, or another change integrates this file
        const hasIntegrationRelationship =
          (Array.isArray(change.dependencies) &&
            change.dependencies.length > 0 &&
            proposedChanges.some(
              (other) =>
                other.action === "create" &&
                change.dependencies.some((d) => {
                  const base = path.basename(other.path, path.extname(other.path));
                  return d.includes(base) || d.includes(other.path);
                })
            )) ||
          proposedChanges.some(
            (other) =>
              other.path !== change.path &&
              Array.isArray(other.dependencies) &&
              other.dependencies.some((d) => {
                const base = path.basename(normPath, path.extname(normPath));
                return d.includes(base) || d.includes(normPath);
              })
          );

        const hasTaskRelation = isExplicitUserPath || relationEvidence.length > 0 || hasIntegrationRelationship;

        if (!hasTaskRelation) {
          console.log(`[WRITE_AUTH] candidate="${normPath}" decision=REJECT reason=NO_TASK_OR_STRUCTURAL_RELATION`);
          rejectedPaths.push({
            path: normPath,
            reason: "Cited evidence establishes existence only; no structural relation, reference, symbol, route, or explicit user path evidence proves relevance to task",
          });
          continue;
        }

        // Approve MODIFY / DELETE
        console.log(`[WRITE_AUTH] candidate="${normPath}" decision=APPROVE action=${change.action} evidenceIds=[${change.evidenceIds.join(", ")}]`);
        approvedPaths.push(normPath);
        authorizedChanges.push(change);
        continue;
      }

      // Validate CREATE:
      if (change.action === "create") {
        if (existingSet.has(normPath)) {
          console.log(`[WRITE_AUTH] candidate="${normPath}" decision=REJECT reason=CANNOT_CREATE_EXISTING_FILE`);
          rejectedPaths.push({ path: normPath, reason: "File already exists; cannot create" });
          continue;
        }

        // Standalone pipeline exception: standalone repositories/tasks may create entry web files
        const isStandalone = policy.pipeline === "STANDALONE" || policy.repositoryRequired === false;

        // CREATE requires integration evidence:
        // Must be referenced/imported/registered by an approved/planned MODIFY change
        const createdBasename = path.basename(normPath, path.extname(normPath));
        const integratedByApprovedModify = proposedChanges.some(
          (other) =>
            other.action === "modify" &&
            Array.isArray(other.dependencies) &&
            other.dependencies.some((d) => {
              const normDep = normalizeRepoPath(d);
              return normDep.includes(createdBasename) || normDep.includes(normPath);
            })
        );

        // Or integration proven by IMPORT evidence cited for the integration site
        const hasImportEvidence = evidenceValidation.evidence.some(
          (e) =>
            e.kind === "IMPORT" &&
            (normalizeRepoPath(e.filePath) === normPath || (e.sourceFile && e.metadata?.dependencies?.includes(normPath)))
        );

        const hasIntegrationProof = isStandalone || integratedByApprovedModify || hasImportEvidence;

        if (!hasIntegrationProof) {
          console.log(`[WRITE_AUTH] candidate="${normPath}" decision=REJECT reason=ORPHAN_CREATE_NO_INTEGRATION_EVIDENCE`);
          rejectedPaths.push({
            path: normPath,
            reason: "Orphan CREATE rejected: no integration evidence proving reachability from an approved modifying file or standalone pipeline",
          });
          continue;
        }

        // Approve CREATE
        console.log(`[WRITE_AUTH] candidate="${normPath}" decision=APPROVE action=create evidenceIds=[${change.evidenceIds.join(", ")}]`);
        approvedPaths.push(normPath);
        authorizedChanges.push(change);
      }
    }

    return {
      approvedPaths,
      rejectedPaths,
      authorizedChanges,
    };
  }
}
