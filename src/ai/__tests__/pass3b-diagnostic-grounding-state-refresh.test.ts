import fs from "fs";
import path from "path";
import os from "os";
import { DiagnosticNormalizer } from "../validation/DiagnosticNormalizer";
import { RepositoryStateRefresher } from "../repository/RepositoryStateRefresher";
import { RepositoryEvidenceStore } from "../repository/RepositoryEvidenceStore";
import { EvidenceBoundWriteSetResolver } from "../contracts/EvidenceBoundWriteSetResolver";
import { PolicyContract } from "../contracts/PolicyContract";
import { TaskIntentSpec } from "../shared/TaskIntentSpec";
import { sha256, verifyFileVersionsFromDisk } from "../validation/FileVersionGuard";

describe("Strict Implementation Pass 3B — Diagnostic Grounding + Repository State Refresh", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pass3b-test-"));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // Test 1: Source diagnostic normalization
  test("1. Source diagnostic normalizes with exact file, line, column, and code provenance", () => {
    const rawError = "app/page.tsx(17,5): error TS2322: Type 'string' is not assignable to type 'number'.";
    const diags = DiagnosticNormalizer.normalize(rawError, {
      repositoryId: "test-repo",
      checkpointId: "chk-1",
    });

    expect(diags.length).toBe(1);
    expect(diags[0].category).toBe("SOURCE_DIAGNOSTIC");
    expect(diags[0].filePath).toBe("app/page.tsx");
    expect(diags[0].line).toBe(17);
    expect(diags[0].column).toBe(5);
    expect(diags[0].code).toBe("TS2322");
    expect(diags[0].message).toContain("Type 'string' is not assignable to type 'number'");
  });

  // Test 2: Environment failure does not produce source authority
  test("2. Environment and toolchain failures do not produce source file paths or authority", () => {
    const toolchainErrors = [
      "npm: command not found",
      "'pnpm' is not recognized as an internal or external command",
      "spawn ENOENT: executable not found",
      "exit code 127: build command missing",
    ];

    for (const err of toolchainErrors) {
      const diags = DiagnosticNormalizer.normalize(err);
      expect(diags.length).toBe(1);
      expect(diags[0].category).toBe("TOOLCHAIN_FAILURE");
      expect(diags[0].filePath).toBeUndefined();

      const store = new RepositoryEvidenceStore("repo-1");
      const added = DiagnosticNormalizer.ingestSourceDiagnostics(diags, store);
      expect(added.length).toBe(0);
      expect(store.getAllEvidence().length).toBe(0);
    }

    const envErrors = [
      "missing required environment variable: DATABASE_URL",
      "network unavailable: getaddrinfo ENOTFOUND api.internal",
      "permission denied: EACCES /var/run",
    ];

    for (const err of envErrors) {
      const diags = DiagnosticNormalizer.normalize(err);
      expect(diags.length).toBe(1);
      expect(diags[0].category).toBe("ENVIRONMENT_FAILURE");
      expect(diags[0].filePath).toBeUndefined();

      const store = new RepositoryEvidenceStore("repo-1");
      const added = DiagnosticNormalizer.ingestSourceDiagnostics(diags, store);
      expect(added.length).toBe(0);
    }
  });

  // Test 3: Dependency failure does not produce source authority
  test("3. Dependency failures do not produce source file paths or authority", () => {
    const depError = "Cannot resolve installed dependency because node_modules is absent";
    const diags = DiagnosticNormalizer.normalize(depError);

    expect(diags.length).toBe(1);
    expect(diags[0].category).toBe("DEPENDENCY_FAILURE");
    expect(diags[0].filePath).toBeUndefined();

    const store = new RepositoryEvidenceStore("repo-1");
    const added = DiagnosticNormalizer.ingestSourceDiagnostics(diags, store);
    expect(added.length).toBe(0);
  });

  // Test 4: Planner-cited diagnostic can authorize repair
  test("4. Valid source diagnostic cited by planner authorizes repair MODIFY", () => {
    const rawError = "app/page.tsx(17,5): error TS2322: Type 'string' is not assignable to type 'number'.";
    const diags = DiagnosticNormalizer.normalize(rawError, { checkpointId: "stage-1" });

    const store = new RepositoryEvidenceStore("repo-1");
    const fileEvidence = store.addEvidence({
      kind: "FILE",
      filePath: "app/page.tsx",
      provenance: "REPO_READ",
    });

    const diagEvidence = DiagnosticNormalizer.ingestSourceDiagnostics(diags, store, "stage-1")[0];
    expect(diagEvidence).toBeDefined();

    const policy: PolicyContract = {
      maxFiles: 5,
      allowedActions: ["modify", "create"],
      forbiddenActions: [],
      risk: "MEDIUM",
      estimatedComplexity: "SMALL",
      destructive: false,
      environment: "REACT_TS",
      pipeline: "REPOSITORY",
      validationType: "TYPESCRIPT_BUILD",
      diffCriticEnabled: false,
      repositoryRequired: true,
      requiresClarification: false,
      expectedFiles: [],
      explicitUserPaths: [],
      userConstraints: [],
      goal: "fix TS2322 error",
      taskType: "BUG_FIX",
    };

    const intentSpec: TaskIntentSpec = {
      goal: "fix TS2322 in app/page.tsx",
      taskType: "BUG_FIX",
      explicitUserPaths: [],
      operations: [{ kind: "REPAIR", subject: "app/page.tsx" }],
      constraints: [],
      acceptanceCriteria: [],
      destructive: false,
      requiresClarification: false,
      risk: "MEDIUM",
      estimatedComplexity: "SMALL",
    };

    const result = EvidenceBoundWriteSetResolver.resolve({
      policy,
      intentSpec,
      proposedChanges: [
        {
          path: "app/page.tsx",
          action: "modify",
          reason: "Fix TS2322 type error",
          dependencies: [],
          evidenceIds: [fileEvidence.id, diagEvidence.id],
        },
      ],
      evidenceStore: store,
      existingFiles: ["app/page.tsx"],
      targetRepositoryId: "repo-1",
    });

    expect(result.approvedPaths).toEqual(["app/page.tsx"]);
    expect(result.rejectedPaths.length).toBe(0);
  });

  // Test 5: Stale diagnostic rejected after repository state changes
  test("5. Stale diagnostic from prior stage cannot authorize modification in next stage", () => {
    const rawError = "app/page.tsx(17,5): error TS2322: Type 'string' is not assignable to type 'number'.";
    const diags = DiagnosticNormalizer.normalize(rawError, { checkpointId: "stage-1" });

    const store = new RepositoryEvidenceStore("repo-1");
    const fileEvidence = store.addEvidence({
      kind: "FILE",
      filePath: "app/page.tsx",
      provenance: "REPO_READ",
    });
    const diagEvidence = DiagnosticNormalizer.ingestSourceDiagnostics(diags, store, "stage-1")[0];

    // Stage 1 verifies -> invalidate stale diagnostics
    const invalidated = RepositoryStateRefresher.invalidateStaleDiagnostics(store, "stage-1");
    expect(invalidated).toBe(1);

    const policy: PolicyContract = {
      maxFiles: 5,
      allowedActions: ["modify", "create"],
      forbiddenActions: [],
      risk: "MEDIUM",
      estimatedComplexity: "SMALL",
      destructive: false,
      environment: "REACT_TS",
      pipeline: "REPOSITORY",
      validationType: "TYPESCRIPT_BUILD",
      diffCriticEnabled: false,
      repositoryRequired: true,
      requiresClarification: false,
      expectedFiles: [],
      explicitUserPaths: [],
      userConstraints: [],
      goal: "stage 2 work",
      taskType: "BUG_FIX",
    };

    const intentSpecStage2: TaskIntentSpec = {
      goal: "stage 2 work",
      taskType: "BUG_FIX",
      explicitUserPaths: [],
      operations: [{ kind: "MODIFY", subject: "app/page.tsx" }],
      constraints: [],
      acceptanceCriteria: [],
      destructive: false,
      requiresClarification: false,
      risk: "MEDIUM",
      estimatedComplexity: "SMALL",
    };

    // Planner in Stage 2 attempts to cite old stale diagnostic
    const result = EvidenceBoundWriteSetResolver.resolve({
      policy,
      intentSpec: intentSpecStage2,
      proposedChanges: [
        {
          path: "app/page.tsx",
          action: "modify",
          reason: "Attempted edit using stale diagnostic",
          dependencies: [],
          evidenceIds: [fileEvidence.id, diagEvidence.id],
        },
      ],
      evidenceStore: store,
      existingFiles: ["app/page.tsx"],
      targetRepositoryId: "repo-1",
    });

    // Must be REJECTED because diagnostic is stale
    expect(result.approvedPaths).toEqual([]);
    expect(result.rejectedPaths.length).toBe(1);
    expect(result.rejectedPaths[0].path).toBe("app/page.tsx");
  });

  // Test 6: Stage 2 sees Stage 1 new file content
  test("6. Stage 2 repository refresh sees Stage 1 verified file content", async () => {
    const pageFile = path.join(tempDir, "app/page.tsx");
    fs.mkdirSync(path.dirname(pageFile), { recursive: true });
    fs.writeFileSync(pageFile, "const Page = () => 'OLD_CONTENT';", "utf8");

    // Stage 1 modifies file
    fs.writeFileSync(pageFile, "const Page = () => 'FIXED_CONTENT';", "utf8");

    const refreshed = await RepositoryStateRefresher.refreshRepositoryState({
      projectId: "proj-test",
      localPath: tempDir,
    });

    const updatedKeyFile = refreshed.snapshot.keyFiles.find((f) => f.path === "app/page.tsx");
    expect(updatedKeyFile).toBeDefined();
    expect(updatedKeyFile!.content).toBe("const Page = () => 'FIXED_CONTENT';");
  });

  // Test 7: Graph refresh after import change
  test("7. Graph refresh detects newly added import edge after stage commit", async () => {
    const pageFile = path.join(tempDir, "app/page.tsx");
    const calcFile = path.join(tempDir, "components/Calculator.tsx");
    fs.mkdirSync(path.dirname(pageFile), { recursive: true });
    fs.mkdirSync(path.dirname(calcFile), { recursive: true });
    fs.writeFileSync(calcFile, "export const Calculator = () => null;", "utf8");
    fs.writeFileSync(pageFile, "const Page = () => null;", "utf8");

    // Pre-change graph
    const initial = await RepositoryStateRefresher.refreshRepositoryState({
      projectId: "proj-graph",
      localPath: tempDir,
    });
    const initialDeps = initial.knowledgeGraph.dependencyGraph?.["app/page.tsx"] || [];
    expect(initialDeps.length).toBe(0);

    // Stage 1 adds import
    fs.writeFileSync(
      pageFile,
      "import { Calculator } from './components/Calculator';\nexport const Page = () => <Calculator />;",
      "utf8"
    );

    const refreshed = await RepositoryStateRefresher.refreshRepositoryState({
      projectId: "proj-graph",
      localPath: tempDir,
    });

    expect(refreshed.revisionHash).not.toBe(initial.revisionHash);
    const deps = refreshed.knowledgeGraph.dependencyGraph?.["app/page.tsx"] || [];
    expect(deps.some((d: string) => d.includes("Calculator"))).toBe(true);
  });

  // Test 8: Semantic chunk refresh
  test("8. Semantic chunk refresh generates new revision and updated content", async () => {
    const utilsFile = path.join(tempDir, "src/utils.ts");
    fs.mkdirSync(path.dirname(utilsFile), { recursive: true });
    fs.writeFileSync(utilsFile, "export function calculateOld() { return 1; }", "utf8");

    const state1 = await RepositoryStateRefresher.refreshRepositoryState({
      projectId: "proj-sem",
      localPath: tempDir,
    });

    // Modify file
    fs.writeFileSync(utilsFile, "export function calculateNew() { return 2; }", "utf8");

    const state2 = await RepositoryStateRefresher.refreshRepositoryState({
      projectId: "proj-sem",
      localPath: tempDir,
    });

    expect(state2.revisionHash).not.toBe(state1.revisionHash);
    const refreshedUtil = state2.snapshot.keyFiles.find((f) => f.path === "src/utils.ts");
    expect(refreshedUtil!.content).toContain("calculateNew");
    expect(refreshedUtil!.content).not.toContain("calculateOld");
  });

  // Test 9: FileVersionGuard receives refreshed state
  test("9. FileVersionGuard receives refreshed state and flags pre-stage hash as mismatch", async () => {
    const pageFile = path.join(tempDir, "app/page.tsx");
    fs.mkdirSync(path.dirname(pageFile), { recursive: true });
    fs.writeFileSync(pageFile, "const Page = () => 'old content';", "utf8");

    const oldHash = sha256("const Page = () => 'old content';");

    // Stage 1 writes new content
    fs.writeFileSync(pageFile, "const Page = () => 'new verified content';", "utf8");
    const newHash = sha256("const Page = () => 'new verified content';");

    // Verifying with new hash passes
    const passResult = await verifyFileVersionsFromDisk({ "app/page.tsx": newHash }, tempDir);
    expect(passResult.valid).toBe(true);

    // Verifying with stale pre-Stage-1 hash fails
    const failResult = await verifyFileVersionsFromDisk({ "app/page.tsx": oldHash }, tempDir);
    expect(failResult.valid).toBe(false);
  });

  // Test 10: Failed-stage rollback restores matching analysis state
  test("10. Failed-stage rollback restores exact initial analysis state", async () => {
    const pageFile = path.join(tempDir, "app/page.tsx");
    fs.mkdirSync(path.dirname(pageFile), { recursive: true });
    fs.writeFileSync(pageFile, "const Page = () => 'initial clean content';", "utf8");

    const initialRev = RepositoryStateRefresher.computeRepositoryRevision(tempDir, "proj-rb");

    // Temporary mutation
    fs.writeFileSync(pageFile, "const Page = () => 'temporary broken content';", "utf8");
    const mutatedRev = RepositoryStateRefresher.computeRepositoryRevision(tempDir, "proj-rb");
    expect(mutatedRev).not.toBe(initialRev);

    // Rollback restores initial file
    fs.writeFileSync(pageFile, "const Page = () => 'initial clean content';", "utf8");
    const restored = await RepositoryStateRefresher.onRollback({
      projectId: "proj-rb",
      localPath: tempDir,
    });

    expect(restored.revisionHash).toBe(initialRev);
  });

  // Test 11: Monorepo diagnostic isolation
  test("11. Monorepo diagnostic isolation: workspace A diagnostic does not authorize workspace B change", () => {
    const store = new RepositoryEvidenceStore("monorepo-proj");
    const fileEvidenceA = store.addEvidence({
      kind: "FILE",
      filePath: "packages/app/src/index.ts",
      provenance: "REPO_READ",
      workspace: "packages/app",
    });
    const fileEvidenceB = store.addEvidence({
      kind: "FILE",
      filePath: "packages/lib/src/index.ts",
      provenance: "REPO_READ",
      workspace: "packages/lib",
    });

    const diagA = store.addEvidence({
      kind: "DIAGNOSTIC",
      filePath: "packages/app/src/index.ts",
      provenance: "BUILD_DIAGNOSTIC",
      workspace: "packages/app",
      metadata: { code: "TS2322" },
    });

    const policy: PolicyContract = {
      maxFiles: 5,
      allowedActions: ["modify"],
      forbiddenActions: [],
      risk: "MEDIUM",
      estimatedComplexity: "SMALL",
      destructive: false,
      environment: "REACT_TS",
      pipeline: "REPOSITORY",
      validationType: "TYPESCRIPT_BUILD",
      diffCriticEnabled: false,
      repositoryRequired: true,
      requiresClarification: false,
      expectedFiles: [],
      explicitUserPaths: [],
      userConstraints: [],
      goal: "repair lib",
      taskType: "BUG_FIX",
    };

    const intentSpec: TaskIntentSpec = {
      goal: "repair lib",
      taskType: "BUG_FIX",
      explicitUserPaths: [],
      operations: [{ kind: "REPAIR", subject: "packages/lib/src/index.ts" }],
      constraints: [],
      acceptanceCriteria: [],
      destructive: false,
      requiresClarification: false,
      risk: "MEDIUM",
      estimatedComplexity: "SMALL",
    };

    // Attempting to use diagA (packages/app) to modify packages/lib
    const result = EvidenceBoundWriteSetResolver.resolve({
      policy,
      intentSpec,
      proposedChanges: [
        {
          path: "packages/lib/src/index.ts",
          action: "modify",
          reason: "Cross-workspace repair attempt",
          dependencies: [],
          evidenceIds: [fileEvidenceB.id, diagA.id],
        },
      ],
      evidenceStore: store,
      existingFiles: ["packages/app/src/index.ts", "packages/lib/src/index.ts"],
      targetRepositoryId: "monorepo-proj",
    });

    expect(result.approvedPaths).toEqual([]);
    expect(result.rejectedPaths.length).toBe(1);
    expect(result.rejectedPaths[0].path).toBe("packages/lib/src/index.ts");
  });

  // Test 12: Multi-repo diagnostic isolation
  test("12. Multi-repo diagnostic isolation: Repo A diagnostic does not authorize Repo B write", () => {
    const store = new RepositoryEvidenceStore("repo-A");
    const fileEvidenceA = store.addEvidence({
      kind: "FILE",
      filePath: "src/main.ts",
      provenance: "REPO_READ",
      repositoryId: "repo-A",
    });
    const diagA = store.addEvidence({
      kind: "DIAGNOSTIC",
      filePath: "src/main.ts",
      provenance: "BUILD_DIAGNOSTIC",
      repositoryId: "repo-A",
      metadata: { code: "TS2304" },
    });

    const policy: PolicyContract = {
      maxFiles: 5,
      allowedActions: ["modify"],
      forbiddenActions: [],
      risk: "MEDIUM",
      estimatedComplexity: "SMALL",
      destructive: false,
      environment: "REACT_TS",
      pipeline: "REPOSITORY",
      validationType: "TYPESCRIPT_BUILD",
      diffCriticEnabled: false,
      repositoryRequired: true,
      requiresClarification: false,
      expectedFiles: [],
      explicitUserPaths: [],
      userConstraints: [],
      goal: "repair repo-B",
      taskType: "BUG_FIX",
    };

    const intentSpec: TaskIntentSpec = {
      goal: "repair repo-B",
      taskType: "BUG_FIX",
      explicitUserPaths: [],
      operations: [{ kind: "REPAIR", subject: "src/main.ts" }],
      constraints: [],
      acceptanceCriteria: [],
      destructive: false,
      requiresClarification: false,
      risk: "MEDIUM",
      estimatedComplexity: "SMALL",
    };

    // Target repository is repo-B, but evidence is from repo-A
    const result = EvidenceBoundWriteSetResolver.resolve({
      policy,
      intentSpec,
      proposedChanges: [
        {
          path: "src/main.ts",
          action: "modify",
          reason: "Cross-repo attack attempt",
          dependencies: [],
          evidenceIds: [fileEvidenceA.id, diagA.id],
        },
      ],
      evidenceStore: store,
      existingFiles: ["src/main.ts"],
      targetRepositoryId: "repo-B",
    });

    expect(result.approvedPaths).toEqual([]);
    expect(result.rejectedPaths.length).toBe(1);
    expect(result.rejectedPaths[0].reason).toContain("outside the target repository");
  });
});
