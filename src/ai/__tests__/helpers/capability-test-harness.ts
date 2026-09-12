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
  const anchorPath = ".anka-test-observation-anchor";
  const anchorAbsolutePath = path.join(input.workspaceRoot, anchorPath);
  fs.mkdirSync(input.workspaceRoot, { recursive: true });
  const anchorExisted = fs.existsSync(anchorAbsolutePath);
  if (!anchorExisted) fs.writeFileSync(anchorAbsolutePath, "test observation anchor", "utf8");
  const anchorEvidence = store.observeRepository({ kind: "FILE", filePath: anchorPath, provenance: "REPO_READ" });

  const syntheticTargets: string[] = [];
  for (const grant of input.grants) {
    if (grant.action === "FILE_CREATE") continue;
    const absoluteTarget = path.join(input.workspaceRoot, grant.path);
    if (!fs.existsSync(absoluteTarget)) {
      fs.mkdirSync(path.dirname(absoluteTarget), { recursive: true });
      fs.writeFileSync(absoluteTarget, "test observation target", "utf8");
      syntheticTargets.push(absoluteTarget);
    }
  }

  const proposedChanges = input.grants.map((grant) => {
    const targetEvidence = store.observeRepository({ kind: "FILE", filePath: grant.path, provenance: "REPO_READ" });
    return {
      path: grant.path,
      action: grant.action === "FILE_CREATE" ? "create" as const : grant.action === "FILE_DELETE" ? "delete" as const : "modify" as const,
      reason: "test harness capability",
      evidenceIds: [grant.action === "FILE_CREATE" ? anchorEvidence.id : targetEvidence.id],
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
    intentSpec: {
      goal: "test harness",
      operations: [],
      constraints: [],
      acceptanceCriteria: [],
      taskType: "BUG_FIX",
      risk: "LOW",
      estimatedComplexity: "SMALL",
      destructive: input.grants.some((grant) => grant.action === "FILE_DELETE"),
      requiresClarification: false,
      explicitUserPaths: input.grants.map((grant) => grant.path),
    },
    proposedChanges,
    evidenceStore: store,
    existingFiles: input.grants.filter((grant) => grant.action !== "FILE_CREATE").map((grant) => grant.path),
    targetRepositoryId: repositoryId,
    workspaceRoot: input.workspaceRoot,
    baseRevision: input.baseRevision,
    stageId: `test-stage:${input.authorityId}`,
    runId,
  }).evidenceAuthorization;

  if (!anchorExisted) fs.rmSync(anchorAbsolutePath, { force: true });
  for (const syntheticTarget of syntheticTargets) fs.rmSync(syntheticTarget, { force: true });
  return base.deriveExecutionScope(authorization, { stageId: `test-stage:${input.authorityId}` });
}

Object.defineProperty(AuthorizedCapabilityScope, "fromBackendConfiguration", {
  configurable: true,
  value: createTestCapabilityScope,
});

Object.defineProperty(AuthorizedCapabilityScope, "fromAuthenticatedProject", {
  configurable: true,
  value: createTestCapabilityScope,
});

export const productionAddEvidence = RepositoryEvidenceStore.prototype.addEvidence;
export const productionIsAuthorityEligible = RepositoryEvidenceStore.prototype.isAuthorityEligible;
const testEvidence = new WeakSet<object>();

Object.defineProperty(RepositoryEvidenceStore.prototype, "addEvidence", {
  configurable: true,
  value: function addTestEvidence(this: RepositoryEvidenceStore, params: AddEvidenceParams): RepositoryEvidence {
    const evidence = productionAddEvidence.call(this, params);
    testEvidence.add(evidence);
    return evidence;
  },
});

Object.defineProperty(RepositoryEvidenceStore.prototype, "isAuthorityEligible", {
  configurable: true,
  value: function isTestAuthorityEligible(this: RepositoryEvidenceStore, evidence: RepositoryEvidence): boolean {
    return productionIsAuthorityEligible.call(this, evidence) || testEvidence.has(evidence);
  },
});
