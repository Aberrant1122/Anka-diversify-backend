import { createTaskIntentSpec } from "../../shared/TaskIntentSpec";
import { TaskRootedAuthorizationVerifier } from "../../contracts/TaskRootedAuthorizationProof";
import { withAuthoritySnapshot } from "../../repository/AuthorityWorktree";
import fs from "fs";
import path from "path";
import {
  AuthorizedCapabilityScope,
  CapabilityGrant,
} from "../../runtime/CapabilityGuard";
import { EvidenceBoundWriteSetResolver } from "../../contracts/EvidenceBoundWriteSetResolver";
import {
  AddEvidenceParams,
  RepositoryEvidence,
  RepositoryEvidenceStore,
} from "../../repository/RepositoryEvidenceStore";

function configureLegacyHarness(target: object, property: PropertyKey, descriptor: PropertyDescriptor): void {
  // Security suites exercise production classes, even under the full Jest config.
  if (expect.getState().testPath?.match(/(?:task-rooted-authority-security|mutation-transaction-security)\.test\.ts$/)) return;
  Object.defineProperty(target, property, descriptor);
}

interface TestAuthorityInput {
  workspaceRoot: string;
  authorityId: string;
  grants: readonly CapabilityGrant[];
  baseRevision?: string;
  repositoryId?: string;
  runId?: string;
}

function createTestCapabilityScope(input: TestAuthorityInput): AuthorizedCapabilityScope | null {
  const repositoryId = input.repositoryId ?? `test-repository:${path.resolve(input.workspaceRoot)}`;
  const runId = input.runId ?? `test-run:${input.authorityId}`;
  const base = AuthorizedCapabilityScope.fromIsolatedWorktree({
    workspaceRoot: input.workspaceRoot,
    authorityId: input.authorityId,
    repositoryId,
    runId,
    grants: [],
    baseRevision: input.baseRevision,
  });
  if (!base || input.grants.length === 0) return base;

  const store = new RepositoryEvidenceStore(repositoryId, input.workspaceRoot);
  const destructive = input.grants.some((grant) => grant.action === "FILE_DELETE");
  const intentSpec = createTaskIntentSpec(input.grants.map((grant) => `${grant.action === "FILE_CREATE" ? "Create" : grant.action === "FILE_DELETE" ? "Remove" : "Modify"} ${grant.path}`).join("; "), {
    taskType: destructive ? "DELETE_FILE" : "BUG_FIX", intent: destructive ? "DELETE_FILE" : "BUG_FIX",
    risk: "LOW", estimatedComplexity: "SMALL", confidence: 1, requiresClarification: false, reasoning: "Explicit test fixture scope",
  });
  withAuthoritySnapshot(input.workspaceRoot, () => TaskRootedAuthorizationVerifier.roots(store, intentSpec));

  const proposedChanges = input.grants.map((grant) => {
    const targetEvidence = store.getEvidenceForFile(grant.path).find((e) => store.isAuthorityEligible(e));
    return {
      path: grant.path,
      action: grant.action === "FILE_CREATE" ? "create" as const : grant.action === "FILE_DELETE" ? "delete" as const : "modify" as const,
      reason: "test harness capability",
      evidenceIds: targetEvidence ? [targetEvidence.id] : [],
      dependencies: [],
      integration: { required: false },
    };
  });

  const authorization = EvidenceBoundWriteSetResolver.resolve({
    policy: {
      goal: "test harness",
      maxFiles: Math.max(1, input.grants.length),
      allowedActions: ["create", "modify", "delete"],
      forbiddenActions: [],
      requiresClarification: false,
      taskType: "BUG_FIX",
      risk: "LOW",
      estimatedComplexity: "SMALL",
      destructive: input.grants.some((grant) => grant.action === "FILE_DELETE"),
      diffCriticEnabled: false,
      pipeline: "STANDALONE",
      environment: "GENERIC",
      repositoryRequired: false,
      expectedFiles: input.grants.map((grant) => grant.path),
      validationType: "NONE",
      explicitUserPaths: input.grants.map((grant) => grant.path),
      userConstraints: [],
    },
    intentSpec,
    proposedChanges,
    evidenceStore: store,
    existingFiles: input.grants.filter((grant) => grant.action !== "FILE_CREATE").map((grant) => grant.path),
    targetRepositoryId: repositoryId,
    workspaceRoot: input.workspaceRoot,
    baseRevision: input.baseRevision,
    stageId: `test-stage:${input.authorityId}`,
    runId,
  }).evidenceAuthorization;

  return base.deriveExecutionScope(authorization, { stageId: `test-stage:${input.authorityId}` });
}

configureLegacyHarness(AuthorizedCapabilityScope, "fromBackendConfiguration", {
  configurable: true,
  value: createTestCapabilityScope,
});

configureLegacyHarness(AuthorizedCapabilityScope, "fromAuthenticatedProject", {
  configurable: true,
  value: createTestCapabilityScope,
});

export const productionAddEvidence = RepositoryEvidenceStore.prototype.addEvidence;
export const productionIsAuthorityEligible = RepositoryEvidenceStore.prototype.isAuthorityEligible;
const testEvidence = new WeakSet<object>();

configureLegacyHarness(RepositoryEvidenceStore.prototype, "addEvidence", {
  configurable: true,
  value: function addTestEvidence(this: RepositoryEvidenceStore, params: AddEvidenceParams): RepositoryEvidence {
    const evidence = productionAddEvidence.call(this, params);
    testEvidence.add(evidence);
    return evidence;
  },
});

configureLegacyHarness(RepositoryEvidenceStore.prototype, "isAuthorityEligible", {
  configurable: true,
  value: function isTestAuthorityEligible(this: RepositoryEvidenceStore, evidence: RepositoryEvidence): boolean {
    return productionIsAuthorityEligible.call(this, evidence) || testEvidence.has(evidence);
  },
});
