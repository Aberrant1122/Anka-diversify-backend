import path from "path";
import fs from "fs";
import os from "os";
import { TargetPathExtractor } from "../contracts/TargetPathExtractor";
import {
  buildExecutionContract,
  buildPolicyContract,
  buildFinalExecutionContract,
} from "../contracts/ExecutionContractBuilder";
import { EvidenceBoundWriteSetResolver, PlannedChange } from "../contracts/EvidenceBoundWriteSetResolver";
import { RepositoryEvidenceStore } from "../repository/RepositoryEvidenceStore";
import { CapabilityGuard, AuthorizedCapabilityScope } from "../runtime/CapabilityGuard";
import { enforceExecutionScope } from "../contracts/ExecutionScopeEnforcer";
import { TaskClassificationResult } from "../classification/TaskTypes";
import { TaskIntentSpec } from "../shared/TaskIntentSpec";
import { AgentPlanner } from "../orchestration/AgentPlanner";
import { IntentClassifier } from "../classification/IntentClassifier";

describe("Hotfix 03: Route References Must Not Become Filesystem Write Authority", () => {
  const sampleRepoFiles = [
    "app/projects/[id]/page.tsx",
    "app/projects/page.tsx",
    "lib/mock-data.ts",
    "src/services/user.ts",
    "packages/api/src/routes/users.ts",
    "components/ProjectDetail.tsx",
    "scripts/deploy-production.sh",
  ];

  const baseClassification: TaskClassificationResult = {
    intent: "BUG_FIX",
    reasoning: "Fix project detail backlog loading",
    taskType: "BUG_FIX",
    risk: "MEDIUM",
    estimatedComplexity: "MEDIUM",
    confidence: 0.9,
    requiresClarification: false,
  };

  describe("A. Runtime Route Reference (/projects/proj-1)", () => {
    it("does not extract /projects/proj-1 as a filesystem target", () => {
      const message =
        "When opening a project from the dashboard or projects directory, for example Cloud Infrastructure Modernization at /projects/proj-1, the Associated Tasks section shows Associated Tasks (0)...";
      const targets = TargetPathExtractor.extract(message, { repoFiles: sampleRepoFiles });
      expect(targets).not.toContain("projects/proj-1");
      expect(targets).not.toContain("/projects/proj-1");
      expect(targets.length).toBe(0);

      const contract = buildExecutionContract(baseClassification, message, sampleRepoFiles);
      expect(contract.targetPaths).not.toContain("projects/proj-1");
      expect(contract.targetPaths).not.toContain("/projects/proj-1");
      expect(contract.targetPaths.length).toBe(0);
    });

    it("identifies /projects/proj-1 as an HTTP route identifier", () => {
      expect(TargetPathExtractor.isHttpRouteIdentifier("/projects/proj-1", "at /projects/proj-1", sampleRepoFiles)).toBe(true);
      expect(TargetPathExtractor.isHttpRouteIdentifier("projects/proj-1", "at /projects/proj-1", sampleRepoFiles)).toBe(true);
      expect(TargetPathExtractor.isValidPathCandidate("projects/proj-1", sampleRepoFiles, "at /projects/proj-1")).toBe(false);
    });
  });

  describe("B. API Route Reference (/users/123)", () => {
    it("does not extract /users/123 or api/users/42 as filesystem targets", () => {
      const message = "The API call to /users/123 returns 500 instead of 404";
      const targets = TargetPathExtractor.extract(message, { repoFiles: sampleRepoFiles });
      expect(targets).not.toContain("users/123");
      expect(targets).not.toContain("/users/123");
      expect(targets.length).toBe(0);

      const contract = buildExecutionContract(baseClassification, message, sampleRepoFiles);
      expect(contract.targetPaths).not.toContain("users/123");
      expect(contract.targetPaths.length).toBe(0);
    });

    it("identifies /users/123 and /api/users/42 as route identifiers", () => {
      expect(TargetPathExtractor.isHttpRouteIdentifier("/users/123", "call to /users/123", sampleRepoFiles)).toBe(true);
      expect(TargetPathExtractor.isHttpRouteIdentifier("users/123", "call to /users/123", sampleRepoFiles)).toBe(true);
      expect(TargetPathExtractor.isHttpRouteIdentifier("/api/users/42", "call to /api/users/42", sampleRepoFiles)).toBe(true);
      expect(TargetPathExtractor.isValidPathCandidate("users/123", sampleRepoFiles, "call to /users/123")).toBe(false);
    });
  });

  describe("C. Full URL (https://example.com/projects/proj-1)", () => {
    it("does not extract full URL or its path as filesystem target", () => {
      const message = "Investigate error at https://example.com/projects/proj-1 on production";
      const targets = TargetPathExtractor.extract(message, { repoFiles: sampleRepoFiles });
      expect(targets).not.toContain("projects/proj-1");
      expect(targets).not.toContain("example.com/projects/proj-1");
      expect(targets).not.toContain("https://example.com/projects/proj-1");
      expect(targets.length).toBe(0);

      const contract = buildExecutionContract(baseClassification, message, sampleRepoFiles);
      expect(contract.targetPaths.length).toBe(0);
    });

    it("identifies full URLs as HTTP route / URL identifiers", () => {
      expect(TargetPathExtractor.isHttpRouteIdentifier("https://example.com/projects/proj-1")).toBe(true);
      expect(TargetPathExtractor.isHttpRouteIdentifier("http://localhost:3000/projects/proj-1")).toBe(true);
      expect(TargetPathExtractor.isValidPathCandidate("https://example.com/projects/proj-1", sampleRepoFiles)).toBe(false);
    });
  });

  describe("D. HTTP Expression (GET /users/:id)", () => {
    it("does not extract HTTP expression as filesystem target", () => {
      const message = "Endpoint GET /users/:id fails to authenticate";
      const targets = TargetPathExtractor.extract(message, { repoFiles: sampleRepoFiles });
      expect(targets).not.toContain("users/:id");
      expect(targets).not.toContain("GET /users/:id");
      expect(targets.length).toBe(0);

      const contract = buildExecutionContract(baseClassification, message, sampleRepoFiles);
      expect(contract.targetPaths.length).toBe(0);
    });

    it("identifies parameterized routes as route identifiers", () => {
      expect(TargetPathExtractor.isHttpRouteIdentifier("GET /users/:id", "GET /users/:id", sampleRepoFiles)).toBe(true);
      expect(TargetPathExtractor.isHttpRouteIdentifier("/users/:id", "GET /users/:id", sampleRepoFiles)).toBe(true);
      expect(TargetPathExtractor.isHttpRouteIdentifier("users/:id", "GET /users/:id", sampleRepoFiles)).toBe(true);
      expect(TargetPathExtractor.isValidPathCandidate("users/:id", sampleRepoFiles, "GET /users/:id")).toBe(false);
    });
  });

  describe("E. Explicit Real Repository File (lib/mock-data.ts)", () => {
    it("preserves explicit real repository file as valid narrow target", () => {
      const message = "Fix the bug in lib/mock-data.ts";
      const targets = TargetPathExtractor.extract(message, { repoFiles: sampleRepoFiles });
      expect(targets).toContain("lib/mock-data.ts");
      expect(targets.length).toBe(1);

      const contract = buildExecutionContract(baseClassification, message, sampleRepoFiles);
      expect(contract.targetPaths).toContain("lib/mock-data.ts");
    });

    it("preserves other genuine repository files with code extensions", () => {
      expect(TargetPathExtractor.isHttpRouteIdentifier("lib/mock-data.ts", "Fix lib/mock-data.ts", sampleRepoFiles)).toBe(false);
      expect(TargetPathExtractor.isHttpRouteIdentifier("src/services/user.ts", "modify src/services/user.ts", sampleRepoFiles)).toBe(false);
      expect(TargetPathExtractor.isHttpRouteIdentifier("app/projects/[id]/page.tsx", "fix app/projects/[id]/page.tsx", sampleRepoFiles)).toBe(false);
      expect(TargetPathExtractor.isHttpRouteIdentifier("packages/api/src/routes/users.ts", "edit packages/api/src/routes/users.ts", sampleRepoFiles)).toBe(false);

      expect(TargetPathExtractor.isValidPathCandidate("lib/mock-data.ts", sampleRepoFiles)).toBe(true);
      expect(TargetPathExtractor.isValidPathCandidate("src/services/user.ts", sampleRepoFiles)).toBe(true);
      expect(TargetPathExtractor.isValidPathCandidate("app/projects/[id]/page.tsx", sampleRepoFiles)).toBe(true);
    });
  });

  describe("Windows vs POSIX Path Disambiguation", () => {
    it("normalizes Windows backslashes for legitimate repository paths", () => {
      const message = "Fix the bug in lib\\mock-data.ts";
      const targets = TargetPathExtractor.extract(message, { repoFiles: sampleRepoFiles });
      expect(targets).toContain("lib/mock-data.ts");
    });

    it("rejects OS absolute paths from becoming repo targetPaths", () => {
      expect(TargetPathExtractor.isValidPathCandidate("C:\\Users\\PCC\\Desktop\\anka\\lib\\mock-data.ts", sampleRepoFiles)).toBe(false);
      expect(TargetPathExtractor.isValidPathCandidate("C:/Users/PCC/Desktop/anka/lib/mock-data.ts", sampleRepoFiles)).toBe(false);
    });
  });

  describe("F. Behavioral Bug with No Explicit File (Investigation Allowed)", () => {
    it("initializes empty targetPaths and open searchScope when prompt contains route examples", () => {
      const message =
        "Associated backlog tasks are not displaying. When opening a project at /projects/proj-1, tasks are missing. Investigate and fix the issue.";
      const behavioralRepoFiles = ["app/projects/[id]/page.tsx", "lib/mock-data.ts"];
      const intentSpec: TaskIntentSpec = {
        goal: message,
        taskType: "BUG_FIX",
        risk: "MEDIUM",
        estimatedComplexity: "MEDIUM",
        operations: [],
        acceptanceCriteria: [],
        destructive: false,
        explicitUserPaths: [],
        constraints: [],
        requiresClarification: false,
      };

      const policyContract = buildPolicyContract(intentSpec, behavioralRepoFiles);
      expect(policyContract.explicitUserPaths).toEqual([]);

      const initialExecutionContract = buildExecutionContract(baseClassification, message, behavioralRepoFiles);
      expect(initialExecutionContract.targetPaths).toEqual([]);
      // Open searchScope enables open repository investigation
      expect(initialExecutionContract.searchScope).toEqual([]);
    });
  });

  describe("G. Evidence-Supported Implementation File Authorized via Backend Mechanism", () => {
    it("authorizes discovered file when backed by authentic repository evidence", () => {
      const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "hotfix03-evidence-"));
      fs.mkdirSync(path.join(workspace, "lib"), { recursive: true });
      fs.writeFileSync(path.join(workspace, "lib", "mock-data.ts"), "export function getTasksByProject() {}", "utf8");
      const evidenceStore = new RepositoryEvidenceStore("proj-1", workspace);
      const fileEvidence = evidenceStore.observeRepository({
        kind: "FILE",
        filePath: "lib/mock-data.ts",
        provenance: "REPO_READ",
      });
      const ev1 = evidenceStore.observeRepository({
        kind: "SYMBOL",
        filePath: "lib/mock-data.ts",
        provenance: "AST_GRAPH",
        symbol: "getTasksByProject",
      });

      const intentSpec: TaskIntentSpec = {
        goal: "Fix associated backlog tasks rendering at /projects/proj-1",
        taskType: "BUG_FIX",
        risk: "MEDIUM",
        estimatedComplexity: "MEDIUM",
        operations: [],
        acceptanceCriteria: [],
        destructive: false,
        explicitUserPaths: [],
        constraints: [],
        requiresClarification: false,
      };

      const policy = buildPolicyContract(intentSpec, sampleRepoFiles);

      const proposedChanges: PlannedChange[] = [
        {
          path: "lib/mock-data.ts",
          action: "modify",
          reason: "Fix getTasksByProject filtering logic",
          evidenceIds: [fileEvidence.id, ev1.id],
          dependencies: [],
        },
      ];

      const writeSetResult = EvidenceBoundWriteSetResolver.resolve({
        policy,
        intentSpec,
        proposedChanges,
        evidenceStore,
        existingFiles: sampleRepoFiles,
      });

      expect(writeSetResult.approvedPaths).toContain("lib/mock-data.ts");
      expect(writeSetResult.authorizedChanges.length).toBe(1);
      fs.rmSync(workspace, { recursive: true, force: true });

      // Final contract successfully incorporates evidence-grounded planning path
      const finalContract = buildFinalExecutionContract(
        policy,
        writeSetResult.approvedPaths,
        sampleRepoFiles
      );
      expect(finalContract.targetPaths).toEqual(["lib/mock-data.ts"]);

      // ExecutionScopeEnforcer confirms changes are now within contract targetPaths
      const enforcement = enforceExecutionScope({
        proposedChanges: [{ path: "lib/mock-data.ts", action: "modify", content: "// fixed", description: "Fix mock data filter" }],
        existingFilePaths: sampleRepoFiles,
        contract: finalContract,
      });
      expect(enforcement.valid).toBe(true);
      expect(enforcement.errors.length).toBe(0);
    });
  });

  describe("H. Model-Only Proposed File (Zero Authority)", () => {
    it("rejects file proposed by model with invalid / fabricated evidence ID", () => {
      const evidenceStore = new RepositoryEvidenceStore("proj-1");
      const intentSpec: TaskIntentSpec = {
        goal: "Fix associated backlog tasks rendering at /projects/proj-1",
        taskType: "BUG_FIX",
        risk: "MEDIUM",
        estimatedComplexity: "MEDIUM",
        operations: [],
        acceptanceCriteria: [],
        destructive: false,
        explicitUserPaths: [],
        constraints: [],
        requiresClarification: false,
      };

      const policy = buildPolicyContract(intentSpec, sampleRepoFiles);

      const proposedChanges: PlannedChange[] = [
        {
          path: "lib/mock-data.ts",
          action: "modify",
          reason: "Model guessed edit without evidence",
          evidenceIds: ["fabricated-evidence-id-999"],
          dependencies: [],
        },
      ];

      const writeSetResult = EvidenceBoundWriteSetResolver.resolve({
        policy,
        intentSpec,
        proposedChanges,
        evidenceStore,
        existingFiles: sampleRepoFiles,
      });

      expect(writeSetResult.approvedPaths).not.toContain("lib/mock-data.ts");
      expect(writeSetResult.rejectedPaths.some((r) => r.path === "lib/mock-data.ts")).toBe(true);
    });
  });

  describe("I. Unrelated Discovered File (Fail-Closed)", () => {
    it("rejects unrelated file (e.g. scripts/deploy-production.sh) without trusted relationship", () => {
      const evidenceStore = new RepositoryEvidenceStore("proj-1");
      const intentSpec: TaskIntentSpec = {
        goal: "Fix project detail view task rendering",
        taskType: "BUG_FIX",
        risk: "MEDIUM",
        estimatedComplexity: "MEDIUM",
        operations: [],
        acceptanceCriteria: [],
        destructive: false,
        explicitUserPaths: [],
        constraints: [],
        requiresClarification: false,
      };

      const policy = buildPolicyContract(intentSpec, sampleRepoFiles);

      const proposedChanges: PlannedChange[] = [
        {
          path: "scripts/deploy-production.sh",
          action: "modify",
          reason: "Unauthorized production script change",
          evidenceIds: [],
          dependencies: [],
        },
      ];

      const writeSetResult = EvidenceBoundWriteSetResolver.resolve({
        policy,
        intentSpec,
        proposedChanges,
        evidenceStore,
        existingFiles: sampleRepoFiles,
      });

      expect(writeSetResult.approvedPaths).not.toContain("scripts/deploy-production.sh");
      expect(writeSetResult.rejectedPaths.some((r) => r.path === "scripts/deploy-production.sh")).toBe(true);
    });
  });

  describe("J. CapabilityGuard Still Rejects Genuine Scope Violation", () => {
    it("denies access when CapabilityGuard scope excludes target path", () => {
      const mockWorkspace = __dirname;
      const authorizedPath = path.basename(__filename);
      const authorizedScope = AuthorizedCapabilityScope.fromBackendConfiguration({
        authorityId: "auth-scope-test",
        workspaceRoot: mockWorkspace,
        grants: [
          { action: "FILE_MODIFY", path: authorizedPath },
        ],
      });
      expect(authorizedScope).not.toBeNull();

      const guard = CapabilityGuard.create({
        workspaceRoot: mockWorkspace,
        scopeId: "stage-1",
        authorizedScope: authorizedScope!,
      });

      const allowedDecision = guard.authorize({
        action: "FILE_MODIFY",
        path: authorizedPath,
        scopeId: "stage-1",
      });
      expect(allowedDecision.allowed).toBe(true);

      const deniedDecision = guard.authorize({
        action: "FILE_MODIFY",
        path: "lib/mock-data.ts",
        scopeId: "stage-1",
      });
      expect(deniedDecision.allowed).toBe(false);
      expect(deniedDecision.code).toBe("CAPABILITY_PATH_NOT_DECLARED");
    });
  });

  describe("K. Real Existing File Classifier Attack (Section 10 & 18A)", () => {
    it("does not grant write authority when classifier returns real relevant file (lib/mock-data.ts) for route-only prompt", () => {
      const message = "Opening /projects/proj-1 does not display tasks. Investigate and fix.";
      const classifierResult: TaskClassificationResult = {
        ...baseClassification,
        targetPath: "lib/mock-data.ts",
      };

      // 1. TargetPathExtractor.extract must NOT include classifier target
      const targets = TargetPathExtractor.extract(message, {
        repoFiles: sampleRepoFiles,
        classifierTarget: classifierResult.targetPath,
      });
      expect(targets).not.toContain("lib/mock-data.ts");
      expect(targets).toEqual([]);

      // 2. TargetPathExtractor.extractWithProvenance marks classifier target as CLASSIFIER_HINT
      const infos = TargetPathExtractor.extractWithProvenance(message, {
        repoFiles: sampleRepoFiles,
        classifierTarget: classifierResult.targetPath,
      });
      const mockDataInfo = infos.find((i) => i.path === "lib/mock-data.ts");
      expect(mockDataInfo).toBeDefined();
      expect(mockDataInfo?.provenance).toBe("CLASSIFIER_HINT");

      // 3. ExecutionContractBuilder targetPaths must NOT gain write authority
      const contract = buildExecutionContract(classifierResult, message, sampleRepoFiles);
      expect(contract.targetPaths).not.toContain("lib/mock-data.ts");
      expect(contract.targetPaths).toEqual([]);

      // 4. Search scope may retain advisory hint with zero write authority
      expect(contract.searchScope).toEqual(["lib"]);

      // 5. CapabilityGuard confirms no write authority
      const mockWorkspace = __dirname;
      const authorizedScope = AuthorizedCapabilityScope.fromBackendConfiguration({
        authorityId: "auth-scope-test",
        workspaceRoot: mockWorkspace,
        grants: contract.targetPaths.map((tp) => ({ action: "FILE_MODIFY", path: tp })),
      });
      const guard = CapabilityGuard.create({
        workspaceRoot: mockWorkspace,
        scopeId: "stage-1",
        authorizedScope: authorizedScope!,
      });
      const writeDecision = guard.authorize({
        action: "FILE_MODIFY",
        path: "lib/mock-data.ts",
        scopeId: "stage-1",
      });
      expect(writeDecision.allowed).toBe(false);
      expect(writeDecision.code).toBe("CAPABILITY_PATH_NOT_DECLARED");
    });
  });

  describe("L. Unrelated Existing File Attack (Section 11 & 18B)", () => {
    it("rejects write authority when classifier maliciously returns unrelated real existing file (scripts/deploy-production.sh)", () => {
      const message = "Opening /projects/proj-1 does not display tasks.";
      const maliciousClassification: TaskClassificationResult = {
        ...baseClassification,
        confidence: 0.99,
        targetPath: "scripts/deploy-production.sh",
      };

      const targets = TargetPathExtractor.extract(message, {
        repoFiles: sampleRepoFiles,
        classifierTarget: maliciousClassification.targetPath,
      });
      expect(targets).not.toContain("scripts/deploy-production.sh");
      expect(targets).toEqual([]);

      const contract = buildExecutionContract(maliciousClassification, message, sampleRepoFiles);
      expect(contract.targetPaths).not.toContain("scripts/deploy-production.sh");
      expect(contract.targetPaths).toEqual([]);

      const mockWorkspace = __dirname;
      const authorizedScope = AuthorizedCapabilityScope.fromBackendConfiguration({
        authorityId: "auth-scope-test",
        workspaceRoot: mockWorkspace,
        grants: contract.targetPaths.map((tp) => ({ action: "FILE_MODIFY", path: tp })),
      });
      const guard = CapabilityGuard.create({
        workspaceRoot: mockWorkspace,
        scopeId: "stage-1",
        authorizedScope: authorizedScope!,
      });
      const writeDecision = guard.authorize({
        action: "FILE_MODIFY",
        path: "scripts/deploy-production.sh",
        scopeId: "stage-1",
      });
      expect(writeDecision.allowed).toBe(false);
    });
  });

  describe("M. Classifier Matches User Path (Section 12 & 18C)", () => {
    it("authorizes path ONLY from user provenance; authority remains if classifier result is absent", () => {
      const message = "Fix lib/mock-data.ts.";
      const classificationWithMatch: TaskClassificationResult = {
        ...baseClassification,
        targetPath: "lib/mock-data.ts",
      };

      const contractWithClassifier = buildExecutionContract(classificationWithMatch, message, sampleRepoFiles);
      expect(contractWithClassifier.targetPaths).toContain("lib/mock-data.ts");
      expect(contractWithClassifier.targetProvenance?.["lib/mock-data.ts"]).toBe("EXPLICIT_USER_PATH");

      // Prove authority remains when classifier returns no targetPath
      const classificationWithoutTarget: TaskClassificationResult = {
        ...baseClassification,
        targetPath: undefined,
      };
      const contractWithoutClassifier = buildExecutionContract(classificationWithoutTarget, message, sampleRepoFiles);
      expect(contractWithoutClassifier.targetPaths).toContain("lib/mock-data.ts");
      expect(contractWithoutClassifier.targetProvenance?.["lib/mock-data.ts"]).toBe("EXPLICIT_USER_PATH");
    });
  });

  describe("N. Classifier Disagrees with User (Section 13 & 18D)", () => {
    it("retains explicit user scope and prevents classifier from widening or replacing scope", () => {
      const message = "Fix lib/mock-data.ts.";
      const disagreeingClassification: TaskClassificationResult = {
        ...baseClassification,
        targetPath: "scripts/deploy-production.sh",
      };

      const contract = buildExecutionContract(disagreeingClassification, message, sampleRepoFiles);
      expect(contract.targetPaths).toEqual(["lib/mock-data.ts"]);
      expect(contract.targetPaths).not.toContain("scripts/deploy-production.sh");
      expect(contract.targetProvenance?.["lib/mock-data.ts"]).toBe("EXPLICIT_USER_PATH");
      expect(contract.targetProvenance?.["scripts/deploy-production.sh"]).toBe("CLASSIFIER_HINT");
    });
  });

  describe("O. No User Path + Correct Model Guess (Section 14 & 18E)", () => {
    it("leaves targetPaths empty even if model correctly guesses the implementation file", () => {
      const message = "Backlog task count does not update on status change.";
      const correctGuessClassification: TaskClassificationResult = {
        ...baseClassification,
        targetPath: "lib/mock-data.ts",
      };

      const contract = buildExecutionContract(correctGuessClassification, message, sampleRepoFiles);
      // Immediate write authority must be 0
      expect(contract.targetPaths).toEqual([]);
      // Advisory hint may inform searchScope only
      expect(contract.searchScope).toEqual(["lib"]);
    });
  });

  describe("P. Repository Existence Laundering Attacks (Section 15 & 18F, 18G, 18H)", () => {
    const extendedRepoFiles = [
      ...sampleRepoFiles,
      "Dockerfile",
      "Makefile",
      "packages/api",
    ];

    it.each([
      ["src/services/user.ts", "code extension file"],
      ["scripts/deploy-production.sh", "shell script"],
      ["Dockerfile", "extensionless dockerfile"],
      ["Makefile", "extensionless makefile"],
      ["packages/api", "directory object"],
    ])("denies write authority to %s (%s) when provided solely by classifier", (repoObject) => {
      const message = "The dashboard summary is broken. Investigate.";
      const classification: TaskClassificationResult = {
        ...baseClassification,
        targetPath: repoObject,
      };

      const targets = TargetPathExtractor.extract(message, {
        repoFiles: extendedRepoFiles,
        classifierTarget: repoObject,
      });
      expect(targets).not.toContain(repoObject);

      const contract = buildExecutionContract(classification, message, extendedRepoFiles);
      expect(contract.targetPaths).not.toContain(repoObject);
    });
  });

  describe("Q. Manifest and Semantic Search Write Authority Invariants (Section 18K, 18L)", () => {
    it("rejects manifest modification when file exists in repo but is not in contract targetPaths", () => {
      const contract = buildExecutionContract(baseClassification, "Fix the issue", sampleRepoFiles);
      expect(contract.targetPaths).toEqual([]);

      const mockWorkspace = __dirname;
      const authorizedScope = AuthorizedCapabilityScope.fromBackendConfiguration({
        authorityId: "auth-scope-test",
        workspaceRoot: mockWorkspace,
        grants: contract.targetPaths.map((tp) => ({ action: "FILE_MODIFY", path: tp })),
      });
      const guard = CapabilityGuard.create({
        workspaceRoot: mockWorkspace,
        scopeId: "stage-1",
        authorizedScope: authorizedScope!,
      });

      // Attempt mutation on existing file not in contract targetPaths
      const decision = guard.authorize({
        action: "FILE_MODIFY",
        path: "lib/mock-data.ts",
        scopeId: "stage-1",
      });
      expect(decision.allowed).toBe(false);
      expect(decision.code).toBe("CAPABILITY_PATH_NOT_DECLARED");
    });
  });

  describe("R. AgentPlanner Explicit User Paths Provenance (Section 5)", () => {
    it("does not alias intentResult.targetPath into explicitUserPaths in AgentPlanner", async () => {
      const message = "Opening /projects/proj-1 does not display tasks. Investigate and fix.";
      const mockClassify = jest.spyOn(IntentClassifier, "classifyIntentAndAmbiguity").mockResolvedValueOnce({
        ...baseClassification,
        targetPath: "lib/mock-data.ts",
      });

      const planning = await AgentPlanner.plan({
        request: {
          message,
          conversationId: "test-conv",
        } as any,
        projectContext: { project: { id: "test-proj", name: "Test" } } as any,
        canonicalExistingFiles: sampleRepoFiles,
      });

      mockClassify.mockRestore();

      expect(planning.status).toBe("READY");
      // explicitUserPaths must be empty, NOT aliased from intentResult.targetPath
      expect(planning.explicitUserPaths).toEqual([]);
      if (planning.status === "READY") {
        expect(planning.taskExecutionPlan.stages[0].intent.explicitUserPaths).toEqual([]);
      }
    });
  });
});
