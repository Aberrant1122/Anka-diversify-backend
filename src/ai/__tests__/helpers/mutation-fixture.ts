import { AgentFileChange } from "../../../types";
import { AuthorizedCapabilityScope } from "../../runtime/CapabilityGuard";
import { PreExecutionAuthorityClosure } from "../../contracts/PreExecutionAuthorityClosure";
import { PolicyContract } from "../../contracts/PolicyContract";
import { createTaskIntentSpec } from "../../shared/TaskIntentSpec";
import { RepositoryEvidenceStore } from "../../repository/RepositoryEvidenceStore";
import { captureAuthoritySnapshot } from "../../repository/AuthorityWorktree";

/** Explicit fixture task, actual disk state, and the production authorization closure. */
export function mutationFixtureScope(root: string, changes: AgentFileChange[], repositoryId = "fixture-project", stageId = "fixture-stage") {
  const request = changes.map(c => `${c.action === "create" ? "Create" : c.action === "delete" ? "Remove" : "Modify"} ${c.path}`).join("; ");
  const destructive = changes.some(c => c.action === "delete");
  const taskType = destructive ? "DELETE_FILE" : "BUG_FIX";
  const intentSpec = createTaskIntentSpec(request, { taskType, intent: taskType, risk: "MEDIUM", estimatedComplexity: "MEDIUM",
    confidence: 1, requiresClarification: false, reasoning: "Explicit fixture task" });
  const policy: PolicyContract = { goal: request, taskType, risk: "MEDIUM", estimatedComplexity: "MEDIUM", destructive,
    allowedActions: ["modify_file", "create_file", "delete_file"], forbiddenActions: [], maxFiles: changes.length, diffCriticEnabled: true,
    pipeline: "REPOSITORY", environment: "GENERIC", repositoryRequired: true, expectedFiles: [], validationType: "TYPESCRIPT_BUILD",
    explicitUserPaths: [], userConstraints: [], requiresClarification: false };
  const closure = PreExecutionAuthorityClosure.close({ changes, policy, intentSpec, repositoryId, workspaceRoot: root, stageId,
    runId: "fixture-run", evidenceStore: new RepositoryEvidenceStore(repositoryId, root), existingFiles: [...captureAuthoritySnapshot(root).files.keys()] });
  if (!closure.valid) throw new Error(`Fixture task authorization failed: ${JSON.stringify({ rejected: closure.result.rejectedPaths, authorized: closure.result.authorizedChanges })}`);
  const base = AuthorizedCapabilityScope.fromIsolatedWorktree({ workspaceRoot: root, repositoryId, authorityId: "fixture-base", runId: "fixture-run", grants: [] });
  const scope = base?.deriveExecutionScope(closure.result.evidenceAuthorization, { stageId });
  if (!scope) throw new Error("Fixture execution scope could not be derived.");
  return scope;
}
