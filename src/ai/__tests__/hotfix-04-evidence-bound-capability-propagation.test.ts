process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-key-that-is-long-enough-32-chars";
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import fs from "fs";
import path from "path";
import os from "os";
import { execFileSync } from "child_process";
import * as CapabilityRuntime from "../runtime/CapabilityGuard";
import { AgentPipeline } from "../orchestration/AgentPipeline";
import { MemoryPersistence } from "../memory/MemoryPersistence";
import { RepositoryContextBuilder } from "../repository/RepositoryContextBuilder";
import { RepositoryScanner } from "../repository/RepositoryScanner";
import { IntentClassifier } from "../classification/IntentClassifier";
import { RepositorySearch } from "../repository/RepositorySearch";
import { CodeGenerator } from "../generation/CodeGenerator";
import { ValidationPlanner } from "../validation/ValidationPlanner";
import { SelfHealingEngine } from "../repair/SelfHealingEngine";
import { SecurityAuditor } from "../review/SecurityAuditor";
import { ValidationDetector } from "../validation/ValidationDetector";
import { ManifestGenerator } from "../../services/manifest-generator";
import { ManifestValidator } from "../../services/manifest-validator";
import { ChatRequest } from "../shared/types";
import { AuthorizedCapabilityScope, CapabilityGuard, CapabilityGrant } from "../runtime/CapabilityGuard";
import { EvidenceBoundAuthorization, EvidenceBoundWriteSetResolver } from "../contracts/EvidenceBoundWriteSetResolver";
import { RepositoryEvidenceStore } from "../repository/RepositoryEvidenceStore";
import { CompletionEvaluator } from "../runtime/CompletionEvaluator";
import { FileSystemStateManager } from "../validation/FileSystemStateManager";
import { StageExecutionTransaction } from "../orchestration/StageExecutionTransaction";
import { ActionGroup, ActionGroupExecutor } from "../orchestration/ActionGroup";
import { ValidationCoordinator } from "../orchestration/ValidationCoordinator";
import { VerifiedCheckpointJournal } from "../runtime/VerifiedCheckpointJournal";
import { TaskRuntime } from "../runtime/TaskRuntime";
import { AgentWorkspaceState } from "../runtime/AgentWorkspaceState";
import { AiController } from "../../controllers/ai-controller";
import { AiService } from "../application/AiService";
import { CodingAgent } from "../application/CodingAgent";
import { productionAddEvidence } from "./helpers/capability-test-harness";

// Mock PrismaClient to prevent DB connection attempts
jest.mock("@prisma/client", () => {
  return {
    PrismaClient: jest.fn().mockImplementation(() => ({
      project: {
        findUnique: jest.fn().mockResolvedValue({
          localPath: "/tmp/mock",
          githubUrl: "https://github.com/mock/mock",
          githubToken: "mock-token",
        }),
      },
      phaseArtifact: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      taskDecomposition: {
        create: jest.fn().mockResolvedValue({}),
      },
      agentManifest: {
        create: jest.fn().mockResolvedValue({}),
      },
    })),
  };
});

describe("Hotfix 04: Authentic Evidence-Bound Capability Issuance & Policy Propagation", () => {
  let tempDir: string;
  let targetFilePath: string;
  let targetEvidenceIds: string[] = [];
  const originalApiKey = process.env.OPENAI_API_KEY;

  function issueAuthorization(input: {
    repositoryId: string;
    workspaceRoot: string;
    baseRevision?: string;
    stageId?: string;
    runId?: string;
    approvedGrants: readonly CapabilityGrant[];
    evidenceIds?: readonly string[];
    authorizationId?: string;
  }): EvidenceBoundAuthorization {
    const runId = input.runId ?? "run-1";
    const stageId = input.stageId ?? "stage-1";
    const store = new RepositoryEvidenceStore(input.repositoryId, input.workspaceRoot);
    const proposedChanges = input.approvedGrants.map((grant, index) => {
      const absolute = path.join(input.workspaceRoot, grant.path);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      if (!fs.existsSync(absolute)) fs.writeFileSync(absolute, `export const observed${index} = true;`, "utf8");
      const evidence = store.observeRepository({ kind: "FILE", filePath: grant.path, provenance: "REPO_READ" });
      return {
        path: grant.path,
        action: grant.action === "FILE_CREATE" ? "create" as const : grant.action === "FILE_DELETE" ? "delete" as const : "modify" as const,
        reason: "test resolver issuance",
        evidenceIds: [evidence.id],
        dependencies: [],
      };
    });
    return EvidenceBoundWriteSetResolver.resolve({
      policy: {
        maxFiles: 20,
        allowedActions: ["create", "modify", "delete"],
        forbiddenActions: [],
        requiresClarification: false,
        taskType: "BUG_FIX",
        risk: "LOW",
        pipeline: "STANDARD",
        repositoryRequired: true,
      } as any,
      intentSpec: {
        taskType: "BUG_FIX",
        description: "test",
        riskLevel: "LOW",
        destructive: input.approvedGrants.some((grant) => grant.action === "FILE_DELETE"),
        explicitUserPaths: input.approvedGrants.map((grant) => grant.path),
      } as any,
      proposedChanges,
      evidenceStore: store,
      existingFiles: input.approvedGrants.map((grant) => grant.path),
      targetRepositoryId: input.repositoryId,
      workspaceRoot: input.workspaceRoot,
      baseRevision: input.baseRevision,
      stageId,
      runId,
    }).evidenceAuthorization;
  }

  beforeEach(() => {
    process.env.OPENAI_API_KEY = "test-mock-api-key";
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hotfix04-test-"));
    jest.spyOn(process, "cwd").mockReturnValue(tempDir);
    targetFilePath = path.join(tempDir, "src", "index.ts");
    fs.mkdirSync(path.dirname(targetFilePath), { recursive: true });
    fs.writeFileSync(targetFilePath, "console.log('original');", "utf8");

    // Base stubs
    jest.spyOn(MemoryPersistence, "getOrCreateSession").mockResolvedValue({ id: "sess-1", title: "test" } as any);
    jest.spyOn(MemoryPersistence, "saveMessage").mockResolvedValue(undefined as any);
    jest.spyOn(MemoryPersistence, "persistProjectMemory").mockResolvedValue(undefined as any);
    jest.spyOn(MemoryPersistence, "updateSessionTitle").mockResolvedValue(undefined as any);

    const snapshotMock = {
      repoName: "test-repo",
      defaultBranch: "main",
      fileTree: ["src/index.ts"],
      keyFiles: [{ path: "src/index.ts", content: "console.log('original');" }],
      revision: { contentHash: "hash-1" },
    };

    jest.spyOn(RepositoryContextBuilder, "buildProjectContext").mockResolvedValue({
      project: { id: "proj-1", name: "test-project" },
      activeTasks: [],
      repoSnapshot: snapshotMock,
    } as any);

    jest.spyOn(RepositoryScanner, "ensureLocalWorkspace").mockResolvedValue(tempDir);
    jest.spyOn(RepositoryScanner, "getEffectiveSnapshot").mockReturnValue(snapshotMock as any);

    jest.spyOn(ValidationPlanner, "detectValidationCommands").mockReturnValue([]);
    jest.spyOn(SelfHealingEngine, "runSelfHealingLoop").mockImplementation(async (changes: any[], localPath: any, _cmds: any, _sp: any, _msg: any, fsManager: any) => {
      if (fsManager && localPath) {
        await fsManager.apply(changes, localPath);
      }
      return {
        success: true,
        attempts: 1,
        finalChanges: changes,
        errorLog: "",
        infrastructureError: false,
      };
    });
    jest.spyOn(SecurityAuditor, "runReflectionAndSecurityAudit").mockResolvedValue({
      securityPass: true,
      findings: [],
    } as any);
    jest.spyOn(ValidationDetector, "runFeatureValidation").mockResolvedValue({
      overallPassed: true,
      checks: [],
      failedChecks: [],
      repairActions: [],
      reason: "verified",
    } as any);
    jest.spyOn(ManifestValidator.prototype, "validate").mockReturnValue({
      valid: true,
      errors: [],
    } as any);
  });

  afterEach(() => {
    process.env.OPENAI_API_KEY = originalApiKey;
    jest.restoreAllMocks();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  // A. Authentic zero-write base scope works for discovery
  test("A: authentic zero-write base scope works for discovery", async () => {
    const zeroWriteScope = AuthorizedCapabilityScope.fromIsolatedWorktree({
      workspaceRoot: tempDir,
      authorityId: "isolated-worktree:run-discovery",
      repositoryId: "proj-1",
      runId: "run-1",
      grants: [],
      baseRevision: "rev-1",
    });

    expect(zeroWriteScope).not.toBeNull();
    expect(zeroWriteScope!.isAuthentic()).toBe(true);
    expect(zeroWriteScope!.mode.grants.length).toBe(0);

    const guard = CapabilityGuard.create({
      workspaceRoot: tempDir,
      scopeId: "stage-1",
      authorizedScope: zeroWriteScope!,
    });

    // Write fails with CAPABILITY_PATH_NOT_DECLARED (never CAPABILITY_POLICY_MISSING)
    const decision = guard.authorize({
      action: "FILE_MODIFY",
      path: "src/index.ts",
      scopeId: "stage-1",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("CAPABILITY_PATH_NOT_DECLARED");
  });

  // B. Missing scope rejects with CAPABILITY_POLICY_MISSING
  test("B: missing scope rejects with CAPABILITY_POLICY_MISSING", async () => {
    const guard = CapabilityGuard.denyAll();
    const decision = guard.authorize({
      action: "FILE_MODIFY",
      path: "src/index.ts",
      scopeId: "stage-1",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("CAPABILITY_POLICY_MISSING");
  });

  // C. Forged scope rejects
  test("C: forged scope rejects", async () => {
    const forgedScope = {
      authorityId: "forged-id",
      workspaceRoot: tempDir,
      source: "ISOLATED_GIT_WORKTREE",
      mode: { kind: "EXACT_PATHS", grants: [{ path: "src/index.ts", action: "FILE_MODIFY" }] },
      isAuthentic: () => true,
    } as any;

    const guard = CapabilityGuard.create({
      workspaceRoot: tempDir,
      scopeId: "stage-1",
      authorizedScope: forgedScope,
    });
    expect(guard.authorize({ action: "FILE_MODIFY", path: "src/index.ts", scopeId: "stage-1" }))
      .toMatchObject({ allowed: false, code: "CAPABILITY_POLICY_MISSING" });
  });

  // D. Raw CapabilityGrant[] cannot mint capability (arbitrary caller attack rejects)
  test("D: raw CapabilityGrant[] cannot mint capability", () => {
    const baseScope = AuthorizedCapabilityScope.fromIsolatedWorktree({
      workspaceRoot: tempDir,
      authorityId: "isolated-worktree:run-raw-attack",
      repositoryId: "proj-1",
      runId: "run-1",
      grants: [],
      baseRevision: "rev-1",
    });

    // Caller attempts to pass raw grants array directly to deriveExecutionScope
    const rawGrants = [{ path: "scripts/deploy.sh", action: "FILE_MODIFY" as const }];
    const derived = (baseScope as any).deriveExecutionScope(rawGrants);

    expect(derived).toBeNull();
  });

  // E. Plain fake evidence authorization cannot mint capability
  test("E: plain fake evidence authorization cannot mint capability", () => {
    const baseScope = AuthorizedCapabilityScope.fromIsolatedWorktree({
      workspaceRoot: tempDir,
      authorityId: "isolated-worktree:run-fake-auth",
      repositoryId: "proj-1",
      runId: "run-1",
      grants: [],
      baseRevision: "rev-1",
    });

    const fakeAuthorization = {
      authorizationId: "fake-auth-id",
      repositoryId: "proj-1",
      isAuthentic: () => true,
      getApprovedGrants: () => [{ path: "scripts/deploy.sh", action: "FILE_MODIFY" }],
      getEvidenceIds: () => ["fake-evidence"],
      getWorkspaceRoot: () => tempDir,
      getBaseRevision: () => "rev-1",
    } as any;

    const derived = baseScope!.deriveExecutionScope(fakeAuthorization);
    expect(derived).toBeNull();
  });

  // F. Authentic EvidenceBoundAuthorization can derive exact approved capability
  test("F: authentic EvidenceBoundAuthorization can derive exact approved capability", () => {
    const baseScope = AuthorizedCapabilityScope.fromIsolatedWorktree({
      workspaceRoot: tempDir,
      authorityId: "isolated-worktree:run-f",
      repositoryId: "proj-1",
      runId: "run-1",
      grants: [],
      baseRevision: "rev-1",
    });

    const authenticAuth = issueAuthorization({
      repositoryId: "proj-1",
      workspaceRoot: tempDir,
      baseRevision: "rev-1",
      stageId: "stage-1",
      approvedGrants: [{ path: "src/index.ts", action: "FILE_MODIFY" }],
      evidenceIds: ["evi-1"],
    });

    expect(authenticAuth.isAuthentic()).toBe(true);

    const derived = baseScope!.deriveExecutionScope(authenticAuth, {
      stageId: "stage-1",
      workspaceRoot: tempDir,
      baseRevision: "rev-1",
    });

    expect(derived).not.toBeNull();
    expect(derived!.isAuthentic()).toBe(true);
    expect(derived!.mode.grants).toEqual([{ action: "FILE_MODIFY", path: "src/index.ts" }]);
  });

  // G. Authorization artifact grant mutation attack fails (TOCTOU)
  test("G: authorization artifact grant mutation attack fails (TOCTOU)", () => {
    const mutableGrants = [{ path: "src/index.ts", action: "FILE_MODIFY" as const }];
    const authenticAuth = issueAuthorization({
      repositoryId: "proj-1",
      workspaceRoot: tempDir,
      baseRevision: "rev-1",
      approvedGrants: mutableGrants,
      evidenceIds: ["evi-g"],
    });

    // Caller mutates the array after issuance
    mutableGrants.push({ path: "scripts/deploy.sh", action: "FILE_MODIFY" as const });
    (mutableGrants[0] as any).path = "scripts/malicious.sh";

    const baseScope = AuthorizedCapabilityScope.fromIsolatedWorktree({
      workspaceRoot: tempDir,
      authorityId: "isolated-worktree:run-g",
      repositoryId: "proj-1",
      runId: "run-1",
      grants: [],
      baseRevision: "rev-1",
    });

    const derived = baseScope!.deriveExecutionScope(authenticAuth, { stageId: "stage-1" });
    expect(derived).not.toBeNull();
    // Only the original frozen grant is present
    expect(derived!.mode.grants).toEqual([{ action: "FILE_MODIFY", path: "src/index.ts" }]);
  });

  // H. Approved A + attempted B authorizes only A
  test("H: approved A + attempted B authorizes only A", () => {
    const baseScope = AuthorizedCapabilityScope.fromIsolatedWorktree({
      workspaceRoot: tempDir,
      authorityId: "isolated-worktree:run-h",
      repositoryId: "proj-1",
      runId: "run-1",
      grants: [],
      baseRevision: "rev-1",
    });

    const authenticAuth = issueAuthorization({
      repositoryId: "proj-1",
      workspaceRoot: tempDir,
      approvedGrants: [{ path: "src/index.ts", action: "FILE_MODIFY" }],
      evidenceIds: ["evi-h"],
    });

    const derived = baseScope!.deriveExecutionScope(authenticAuth, { stageId: "stage-1" });
    const guard = CapabilityGuard.create({
      workspaceRoot: tempDir,
      scopeId: "stage-1",
      authorizedScope: derived!,
    });

    expect(guard.authorize({ action: "FILE_MODIFY", path: "src/index.ts", scopeId: "stage-1" }))
      .toMatchObject({ allowed: true, code: "CAPABILITY_ALLOWED" });

    expect(guard.authorize({ action: "FILE_CREATE", path: "src/unauthorized.ts", scopeId: "stage-1" }))
      .toMatchObject({ allowed: false, code: "CAPABILITY_PATH_NOT_DECLARED" });
  });

  // I, J, K, L. Model proposal, semantic search, manifest, or repo existence alone cannot produce authorization artifact
  test("I, J, K, L: resolver produces empty authorization artifact when evidence is ungrounded", () => {
    const evidenceStore = new RepositoryEvidenceStore("proj-1");
    // Semantic search hit exists in text, but no authentic SYMBOL / AST evidence added to store

    const result = EvidenceBoundWriteSetResolver.resolve({
      policy: {
        maxFiles: 5,
        allowedActions: ["modify"],
        forbiddenActions: [],
        requiresClarification: false,
        taskType: "BUG_FIX",
        risk: "LOW",
        pipeline: "STANDARD",
        repositoryRequired: true,
      } as any,
      intentSpec: { taskType: "BUG_FIX", description: "fix", riskLevel: "LOW", primaryTarget: undefined } as any,
      proposedChanges: [{
        path: "src/index.ts",
        action: "modify",
        reason: "model hallucinated fix",
        evidenceIds: ["invented-fake-id"],
        dependencies: [],
      }],
      evidenceStore,
      existingFiles: ["src/index.ts"],
      workspaceRoot: tempDir,
      baseRevision: "rev-1",
    });

    expect(result.approvedPaths.length).toBe(0);
    expect(result.authorizedChanges.length).toBe(0);
    expect(result.evidenceAuthorization.getApprovedGrants().length).toBe(0);
  });

  // M & N. HTTP /agent/run and /agent/stream authorizedCapabilities injection gives zero authority
  test("M & N: HTTP /agent/run and /agent/stream authorizedCapabilities injection gives zero authority", async () => {
    const aiController = new AiController();
    const runSpy = jest.spyOn(AiService.prototype, "runCodingAgent").mockResolvedValue({
      explanation: "done",
      changes: [],
      commitMessage: "test",
      sessionId: "sess-1",
      intent: "BUG_FIX",
      taskType: "BUG_FIX",
      risk: "LOW",
      estimatedComplexity: "SMALL",
      confidence: 1,
      buildVerified: true,
    } as any);

    const req = {
      user: { userId: "user-1" },
      params: { projectId: "proj-1" },
      body: {
        message: "fix issue",
        authorizedCapabilities: [{ path: "scripts/deploy.sh", action: "FILE_MODIFY" }],
      },
      headers: {},
      query: {},
    } as any;

    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    } as any;

    await aiController.runAgent(req, res);

    expect(runSpy).toHaveBeenCalled();
    // Verify AiService.runCodingAgent was called without any injected authorizedCapabilities
    expect(runSpy).toHaveBeenCalledWith("user-1", "proj-1", { message: "fix issue" }, undefined);
  });

  // O. Repo A capability/proof cannot be used in repo B
  test("O: repo A capability/proof cannot be used in repo B", () => {
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), "hotfix04-repoB-"));
    try {
      const baseScopeA = AuthorizedCapabilityScope.fromIsolatedWorktree({
        workspaceRoot: tempDir,
        authorityId: "isolated-worktree:run-repoA",
        repositoryId: "proj-1",
        runId: "run-1",
        grants: [],
        baseRevision: "rev-1",
      });

      const authB = issueAuthorization({
        repositoryId: "proj-2",
        workspaceRoot: otherDir, // Repo B workspace
        baseRevision: "rev-1",
        approvedGrants: [{ path: "src/index.ts", action: "FILE_MODIFY" }],
        evidenceIds: ["evi-1"],
      });

      // Derivation must reject cross-repo replay
      const derived = baseScopeA!.deriveExecutionScope(authB);
      expect(derived).toBeNull();
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true });
    }
  });

  // P. Run A capability/proof cannot be used in run B
  test("P: run A capability/proof cannot be used in run B", () => {
    const baseScopeA = AuthorizedCapabilityScope.fromIsolatedWorktree({
      workspaceRoot: tempDir,
      authorityId: "isolated-worktree:run-A",
      repositoryId: "proj-1",
      runId: "run-1",
      grants: [],
      baseRevision: "rev-1",
    });

    const derivedA = baseScopeA!.deriveExecutionScope(
      issueAuthorization({
        repositoryId: "proj-1",
        workspaceRoot: tempDir,
        stageId: "stage-A",
        approvedGrants: [{ path: "src/index.ts", action: "FILE_MODIFY" }],
        evidenceIds: ["evi-1"],
      }),
      { stageId: "stage-A" }
    );

    // Guard created for run B scopeId must reject request signed with stage-A
    const guardB = CapabilityGuard.create({
      workspaceRoot: tempDir,
      scopeId: "stage-B",
      authorizedScope: derivedA!,
    });

    const decision = guardB.authorize({
      action: "FILE_MODIFY",
      path: "src/index.ts",
      scopeId: "stage-A",
    });

    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("CAPABILITY_SCOPE_MISMATCH");
  });

  // Q. Stale/incompatible revision replay rejected
  test("Q: stale/incompatible revision replay rejected", () => {
    const baseScopeRev1 = AuthorizedCapabilityScope.fromIsolatedWorktree({
      workspaceRoot: tempDir,
      authorityId: "isolated-worktree:run-rev1",
      repositoryId: "proj-1",
      runId: "run-1",
      grants: [],
      baseRevision: "commit-sha-1111",
    });

    const authRev2 = issueAuthorization({
      repositoryId: "proj-1",
      workspaceRoot: tempDir,
      baseRevision: "commit-sha-2222", // Incompatible revision!
      approvedGrants: [{ path: "src/index.ts", action: "FILE_MODIFY" }],
      evidenceIds: ["evi-1"],
    });

    const derived = baseScopeRev1!.deriveExecutionScope(authRev2);
    expect(derived).toBeNull();
  });

  // R. Cross-iteration authority does not accumulate
  test("R: cross-iteration authority does not accumulate", () => {
    const baseScope = AuthorizedCapabilityScope.fromIsolatedWorktree({
      workspaceRoot: tempDir,
      authorityId: "isolated-worktree:base-run",
      repositoryId: "proj-1",
      runId: "run-1",
      grants: [],
      baseRevision: "rev-1",
    });

    // Iteration 1: evidence approves file A
    const auth1 = issueAuthorization({
      repositoryId: "proj-1",
      workspaceRoot: tempDir,
      stageId: "stage-1",
      approvedGrants: [{ path: "src/a.ts", action: "FILE_MODIFY" }],
      evidenceIds: ["evi-a"],
    });
    const derivedStage1 = baseScope!.deriveExecutionScope(auth1, { stageId: "stage-1" });
    expect(derivedStage1!.mode.grants).toEqual([{ action: "FILE_MODIFY", path: "src/a.ts" }]);

    // Iteration 2: model proposes file B without new evidence -> resolver returns empty auth
    const auth2Empty = issueAuthorization({
      repositoryId: "proj-1",
      workspaceRoot: tempDir,
      stageId: "stage-2",
      approvedGrants: [],
      evidenceIds: [],
    });

    // Iteration 2 must derive from baseScope, NOT derivedStage1
    const derivedStage2 = baseScope!.deriveExecutionScope(auth2Empty, { stageId: "stage-2" });
    expect(derivedStage2!.mode.grants.length).toBe(0);
  });

  // S. Full behavioral-task evidence-bound propagation succeeds
  test("S: full behavioral-task evidence-bound propagation succeeds", async () => {
    jest.spyOn(IntentClassifier, "classifyIntentAndAmbiguity").mockResolvedValue({
      intent: "BUG_FIX",
      taskType: "BUG_FIX",
      risk: "LOW",
      estimatedComplexity: "SMALL",
      targetPath: undefined, // no explicit file!
      requiresClarification: false,
      confidence: 0.9,
    } as any);

    jest.spyOn(RepositorySearch, "runIterativeRepositorySearch").mockImplementation(async (...args: any[]) => {
      const evidenceStore = args[7];
      const fileEvidence = evidenceStore.observeRepository({
        kind: "FILE",
        filePath: "src/index.ts",
        provenance: "REPO_READ",
      });
      const symbolEvidence = evidenceStore.observeRepository({
        kind: "SYMBOL",
        filePath: "src/index.ts",
        provenance: "AST_GRAPH",
        symbol: "console",
      });
      targetEvidenceIds = [fileEvidence.id, symbolEvidence.id];
      return {
        optimizedContext: { fileContext: {} },
        executionMemory: { inspectedFiles: new Set(["src/index.ts"]) },
        finalConfidence: 0.9,
        searchSummary: "discovered implementation area",
      } as any;
    });

    jest.spyOn(ManifestGenerator.prototype, "generateManifest").mockImplementation(async () => ({
      files: [{ path: "src/index.ts", action: "modify", description: "fix discovered bug", evidenceIds: targetEvidenceIds }],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    } as any));

    jest.spyOn(CodeGenerator, "buildAgentSystemPrompt").mockReturnValue("system prompt");
    jest.spyOn(CodeGenerator, "generateRoadmapAndDiffs").mockResolvedValue({
      changes: [{ path: "src/index.ts", action: "modify", content: "console.log('behavioral fix');", description: "fix discovered bug" }],
      roadmap: [],
    } as any);

    const initialScope = AuthorizedCapabilityScope.fromIsolatedWorktree({
      workspaceRoot: tempDir,
      authorityId: "isolated-worktree:run-behavioral-s",
      repositoryId: "proj-1",
      runId: "run-1",
      grants: [],
      baseRevision: "hash-1",
    });

    const sampleRequest: ChatRequest = { message: "Opening a record detail page shows zero associated items", sessionId: "sess-1" };
    const response = await AgentPipeline.runCodingAgent("user-1", "proj-1", sampleRequest, undefined, {
      effectiveLocalPath: tempDir,
      authorizedCapabilityScope: initialScope!,
      baseCommitSha: "hash-1",
    });

    expect(response.buildVerified).toBe(true);
    expect(fs.readFileSync(targetFilePath, "utf8")).toBe("console.log('behavioral fix');");
  });

  // T & U. Authorization failure cannot create VERIFIED checkpoint or completion success
  test("T & U: authorization failure cannot create VERIFIED checkpoint or completion success", async () => {
    const journal = new VerifiedCheckpointJournal();
    const deniedScope = AuthorizedCapabilityScope.fromIsolatedWorktree({
      workspaceRoot: tempDir,
      authorityId: "isolated-worktree:run-denied-tu",
      repositoryId: "proj-1",
      runId: "run-1",
      grants: [], // zero write grants
    });

    const guard = CapabilityGuard.create({
      workspaceRoot: tempDir,
      scopeId: "stage-denied",
      authorizedScope: deniedScope!,
    });

    const transaction = await StageExecutionTransaction.startTransaction("stage-denied", tempDir, guard);
    const actionGroup = ActionGroup.create({
      stageId: "stage-denied",
      authorizedScopeReference: deniedScope!.authorityId,
      actions: [{ path: "src/index.ts", action: "modify", content: "denied", description: "unauthorized" }],
    });

    await expect(ActionGroupExecutor.execute({
      group: actionGroup,
      transaction,
      journal,
      executeActions: async () => {},
      validate: () => ({ passed: true, checks: [] } as any),
    })).rejects.toThrow();

    const snapshot = journal.snapshot();
    expect(snapshot.length).toBe(1);
    expect(snapshot[0].status).toBe("ROLLED_BACK");
    expect(snapshot[0].failureCode).toBe("AUTHORIZATION_FAILED");

    const taskRuntime = TaskRuntime.create({
      taskId: "task-tu",
      originalGoal: "fix bug",
      workspace: AgentWorkspaceState.create({ projectId: "proj-1", root: tempDir, revision: "baseline" }),
    });
    taskRuntime.start();
    const entry = snapshot[0];
    taskRuntime.updateWorkspace(taskRuntime.workspaceState().withCheckpointReference({
      id: entry.journalId,
      sequence: entry.sequence,
      actionGroupId: entry.actionGroupId,
      status: entry.status,
      source: "VERIFIED_CHECKPOINT_JOURNAL",
    }));

    const evaluation = CompletionEvaluator.evaluate({
      runtime: taskRuntime,
      handoff: { outcome: "MAX_ITERATIONS_REACHED", workingPlanId: "plan-1", workingPlanRevision: 1 },
      journal,
      repository: { root: tempDir, revision: "baseline", changedPaths: [], source: "MATERIALIZED_REPOSITORY", coverage: "FULL_REPOSITORY_DELTA" },
      validation: { passed: false, repositoryRevision: "baseline", source: "VALIDATION_COORDINATOR" },
      requirements: [],
    });

    expect(evaluation.outcome).not.toBe("COMPLETE");
  });

  test("public runtime cannot mint EvidenceBoundAuthorization from raw fields", () => {
    const runtimeExports = CapabilityRuntime as unknown as Record<string, unknown>;
    expect(runtimeExports.EvidenceBoundAuthorization).toBeUndefined();
  });

  test.each(["REFERENCE", "SYMBOL", "DIAGNOSTIC"] as const)(
    "caller-shaped %s evidence is never authority eligible",
    (kind) => {
      const store = new RepositoryEvidenceStore("proj-1", tempDir);
      const fake = productionAddEvidence.call(store, {
        kind,
        filePath: "src/index.ts",
        sourceFile: kind === "REFERENCE" ? "src/index.ts" : undefined,
        symbol: kind === "SYMBOL" ? "original" : undefined,
        provenance: kind === "DIAGNOSTIC" ? "BUILD_DIAGNOSTIC" : kind === "REFERENCE" ? "REFERENCE_SEARCH" : "AST_GRAPH",
      });
      expect(store.isAuthorityEligible(fake)).toBe(false);

      const result = EvidenceBoundWriteSetResolver.resolve({
        policy: {
          goal: "fix src/index.ts",
          maxFiles: 1,
          allowedActions: ["modify_file"],
          forbiddenActions: [],
          requiresClarification: false,
          taskType: "BUG_FIX",
          risk: "LOW",
          estimatedComplexity: "SMALL",
          destructive: false,
          diffCriticEnabled: true,
          pipeline: "REPOSITORY",
          environment: "NODE_JS",
          repositoryRequired: true,
          expectedFiles: ["src/index.ts"],
          validationType: "TYPESCRIPT_BUILD",
          explicitUserPaths: ["src/index.ts"],
          userConstraints: [],
        },
        intentSpec: {
          goal: "fix src/index.ts",
          operations: [],
          constraints: [],
          acceptanceCriteria: [],
          destructive: false,
          requiresClarification: false,
          taskType: "BUG_FIX",
          risk: "LOW",
          estimatedComplexity: "SMALL",
          explicitUserPaths: ["src/index.ts"],
        },
        proposedChanges: [{ path: "src/index.ts", action: "modify", reason: "attack", evidenceIds: [fake.id], dependencies: [] }],
        evidenceStore: store,
        existingFiles: ["src/index.ts"],
        targetRepositoryId: "proj-1",
        workspaceRoot: tempDir,
        runId: "run-1",
        stageId: "stage-1",
      });
      expect(result.approvedPaths).toEqual([]);
      expect(result.evidenceAuthorization.getApprovedGrants()).toEqual([]);
    },
  );

  test("authentic observation survives only as the original runtime object", () => {
    const store = new RepositoryEvidenceStore("proj-1", tempDir);
    const evidence = store.observeRepository({ kind: "FILE", filePath: "src/index.ts", provenance: "REPO_READ" });
    expect(store.isAuthorityEligible(evidence)).toBe(true);

    const copied = { ...evidence, filePath: "src/other.ts" };
    const serialized = JSON.parse(JSON.stringify(evidence)) as unknown;
    expect(store.isAuthorityEligible(copied)).toBe(false);
    expect(store.isAuthorityEligible(serialized as object as typeof evidence)).toBe(false);
    expect(store.getEvidence(evidence.id)).toBe(evidence);
  });

  test("repository, run, and stage context replay is rejected", () => {
    const base = AuthorizedCapabilityScope.fromIsolatedWorktree({
      workspaceRoot: tempDir,
      authorityId: "base-run-a",
      repositoryId: "repo-a",
      runId: "run-a",
      grants: [],
      baseRevision: "rev-a",
    });
    const auth = issueAuthorization({
      repositoryId: "repo-a",
      workspaceRoot: tempDir,
      runId: "run-a",
      baseRevision: "rev-a",
      stageId: "stage-a",
      approvedGrants: [{ path: "src/index.ts", action: "FILE_MODIFY" }],
    });
    expect(base?.deriveExecutionScope(auth, { stageId: "stage-a", baseRevision: "rev-a" })).not.toBeNull();

    const repoB = AuthorizedCapabilityScope.fromIsolatedWorktree({ workspaceRoot: tempDir, authorityId: "repo-b", repositoryId: "repo-b", runId: "run-a", grants: [], baseRevision: "rev-a" });
    const runB = AuthorizedCapabilityScope.fromIsolatedWorktree({ workspaceRoot: tempDir, authorityId: "run-b", repositoryId: "repo-a", runId: "run-b", grants: [], baseRevision: "rev-a" });
    expect(repoB?.deriveExecutionScope(auth, { stageId: "stage-a", baseRevision: "rev-a" })).toBeNull();
    expect(runB?.deriveExecutionScope(auth, { stageId: "stage-a", baseRevision: "rev-a" })).toBeNull();
    expect(base?.deriveExecutionScope(auth, { stageId: "stage-b", baseRevision: "rev-a" })).toBeNull();
  });

  test("live HEAD replay is rejected while dirtiness on the same HEAD is accepted", () => {
    execFileSync("git", ["init"], { cwd: tempDir });
    execFileSync("git", ["config", "user.email", "hotfix04@example.invalid"], { cwd: tempDir });
    execFileSync("git", ["config", "user.name", "Hotfix 04"], { cwd: tempDir });
    execFileSync("git", ["add", "src/index.ts"], { cwd: tempDir });
    execFileSync("git", ["commit", "-m", "head-a"], { cwd: tempDir });
    const headA = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tempDir, encoding: "utf8" }).trim();
    const base = AuthorizedCapabilityScope.fromIsolatedWorktree({
      workspaceRoot: tempDir,
      authorityId: "live-head-run",
      repositoryId: "repo-live",
      runId: "run-live",
      grants: [],
      baseRevision: headA,
    });
    const auth = issueAuthorization({
      repositoryId: "repo-live",
      workspaceRoot: tempDir,
      runId: "run-live",
      baseRevision: headA,
      stageId: "stage-live",
      approvedGrants: [{ path: "src/index.ts", action: "FILE_MODIFY" }],
    });
    const derived = base?.deriveExecutionScope(auth, { stageId: "stage-live", baseRevision: headA });
    expect(derived).not.toBeNull();

    fs.appendFileSync(targetFilePath, "\n// dirty", "utf8");
    const dirtyGuard = CapabilityGuard.create({ workspaceRoot: tempDir, scopeId: "stage-live", authorizedScope: derived! });
    expect(dirtyGuard.authorize({ path: "src/index.ts", action: "FILE_MODIFY", scopeId: "stage-live" }).allowed).toBe(true);

    execFileSync("git", ["add", "src/index.ts"], { cwd: tempDir });
    execFileSync("git", ["commit", "-m", "head-b"], { cwd: tempDir });
    const staleGuard = CapabilityGuard.create({ workspaceRoot: tempDir, scopeId: "stage-live", authorizedScope: derived! });
    expect(staleGuard.authorize({ path: "src/index.ts", action: "FILE_MODIFY", scopeId: "stage-live" }))
      .toMatchObject({ allowed: false, code: "CAPABILITY_POLICY_MISSING" });
  });
});
