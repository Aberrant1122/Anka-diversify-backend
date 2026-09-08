import {
  EvidenceBoundWriteSetResolver,
  PlannedChange,
} from "../contracts/EvidenceBoundWriteSetResolver";
import { RepositoryEvidenceStore } from "../repository/RepositoryEvidenceStore";
import { PolicyContract } from "../contracts/PolicyContract";
import { TaskIntentSpec } from "../shared/TaskIntentSpec";
import { ManifestValidator } from "../../services/manifest-validator";
import { buildFinalExecutionContract } from "../contracts/ExecutionContractBuilder";
import { normalizeRepoPath } from "../repository/SemanticContextResolver";
import { FileManifest } from "../../types";

describe("Strict Implementation Pass 2 — Dependency-Closed Write Authority & Manifest Reconciliation", () => {
  const defaultPolicy: PolicyContract = {
    goal: "Implement calculator feature",
    taskType: "NEW_FEATURE",
    risk: "MEDIUM",
    estimatedComplexity: "MEDIUM",
    destructive: false,
    pipeline: "REPOSITORY",
    environment: "REACT_TS",
    allowedActions: ["create", "modify", "create_files", "modify_file"],
    forbiddenActions: ["delete_file"],
    maxFiles: 10,
    repositoryRequired: true,
    requiresClarification: false,
    expectedFiles: [],
    validationType: "TYPESCRIPT_BUILD",
    explicitUserPaths: [],
    userConstraints: [],
    diffCriticEnabled: false,
  };

  const defaultIntent: TaskIntentSpec = {
    goal: "Implement calculator feature",
    taskType: "NEW_FEATURE",
    operations: [{ kind: "CREATE", subject: "Calculator" }],
    constraints: [],
    acceptanceCriteria: ["Calculator renders"],
    destructive: false,
    requiresClarification: false,
    risk: "MEDIUM",
    estimatedComplexity: "MEDIUM",
    explicitUserPaths: [],
  };

  // Section 16 — TEST: EXACT DEADLOCK
  test("Section 16: Exact deadlock reproduction — child CREATE rejected when parent lacks task relation", () => {
    const evidenceStore = new RepositoryEvidenceStore("test-repo");
    const evApp = evidenceStore.addEvidence({
      kind: "FILE",
      filePath: "app/page.tsx",
      provenance: "REPO_READ",
    });
    const evCalc = evidenceStore.addEvidence({
      kind: "FILE",
      filePath: "components/Calculator.tsx",
      provenance: "REPO_READ",
    });

    // app/page.tsx has FILE existence only, lacks task relation evidence (and intent is BUG_FIX or no direct relation)
    const bugIntent: TaskIntentSpec = {
      ...defaultIntent,
      taskType: "BUG_FIX",
      goal: "Solve errors in repository",
      operations: [{ kind: "MODIFY", subject: "errors" }],
    };
    const bugPolicy: PolicyContract = {
      ...defaultPolicy,
      taskType: "BUG_FIX",
      allowedActions: ["create", "modify", "create_files", "modify_file"],
    };

    const proposed: PlannedChange[] = [
      {
        path: "components/Calculator.tsx",
        action: "create",
        reason: "New calculator",
        evidenceIds: [evCalc.id],
        dependencies: [],
        integration: {
          required: true,
          satisfiedBy: ["app/page.tsx"],
        },
      },
      {
        path: "app/page.tsx",
        action: "modify",
        reason: "Import and render calculator",
        evidenceIds: [evApp.id],
        dependencies: ["./components/Calculator"],
      },
    ];

    const res = EvidenceBoundWriteSetResolver.resolve({
      policy: bugPolicy,
      intentSpec: bugIntent,
      proposedChanges: proposed,
      evidenceStore,
      existingFiles: ["app/page.tsx"],
    });

    // Both must be rejected: app/page.tsx for no task relation in BUG_FIX, and Calculator.tsx for rejected integration dependency
    expect(res.approvedPaths).toHaveLength(0);
    expect(res.approvedPaths).not.toContain("components/Calculator.tsx");
    expect(res.approvedPaths).not.toContain("app/page.tsx");

    const pageRejection = res.rejectedPaths.find((r) => r.path === "app/page.tsx");
    expect(pageRejection).toBeDefined();
    expect(pageRejection!.reason).toContain("NO_TASK_OR_STRUCTURAL_RELATION");

    const calcRejection = res.rejectedPaths.find((r) => r.path === "components/Calculator.tsx");
    expect(calcRejection).toBeDefined();
    expect(calcRejection!.reason).toContain("REJECT_INTEGRATION_DEPENDENCY");

    // ManifestValidator must NOT receive Calculator.tsx alone
    const executionContract = buildFinalExecutionContract(bugPolicy, res.approvedPaths, ["app/page.tsx"]);
    expect(executionContract.targetPaths).toEqual([]);

    const coherentManifest: FileManifest = {
      files: proposed.filter((f) => res.approvedPaths.includes(f.path)).map((f) => ({
        path: f.path,
        action: f.action,
        dependencies: f.dependencies,
        description: f.reason,
      })),
      totalFiles: res.approvedPaths.length,
      manifestVersion: "1.0.0",
    };
    expect(coherentManifest.files).toHaveLength(0);

    // No Catch-22: targetPaths is empty and coherent manifest is empty (no path_constraint or orphan)
    const validator = new ManifestValidator(executionContract, { existingFiles: ["app/page.tsx"] });
    const valRes = validator.validate(coherentManifest);
    expect(valRes.valid).toBe(true);
  });

  // Section 17 — TEST: REVERSE IMPORT DIRECTION & ORDER INDEPENDENCE
  test("Section 17: Reverse import direction produces identical results regardless of proposedChanges array order", () => {
    const evidenceStore = new RepositoryEvidenceStore("test-repo");
    const evApp = evidenceStore.addEvidence({
      kind: "FILE",
      filePath: "app/page.tsx",
      provenance: "REPO_READ",
    });
    const evAppSymbol = evidenceStore.addEvidence({
      kind: "SYMBOL",
      filePath: "app/page.tsx",
      symbol: "Page",
      provenance: "AST_GRAPH",
    });

    const createChange: PlannedChange = {
      path: "components/Calculator.tsx",
      action: "create",
      reason: "Create Calculator",
      evidenceIds: [evApp.id],
      dependencies: [],
      integration: {
        required: true,
        satisfiedBy: ["app/page.tsx"],
      },
    };

    const modifyChange: PlannedChange = {
      path: "app/page.tsx",
      action: "modify",
      reason: "Mount Calculator",
      evidenceIds: [evApp.id, evAppSymbol.id],
      dependencies: ["./components/Calculator"],
    };

    // Order 1: CREATE first, MODIFY second
    const res1 = EvidenceBoundWriteSetResolver.resolve({
      policy: defaultPolicy,
      intentSpec: defaultIntent,
      proposedChanges: [createChange, modifyChange],
      evidenceStore,
      existingFiles: ["app/page.tsx"],
    });

    // Order 2: MODIFY first, CREATE second
    const res2 = EvidenceBoundWriteSetResolver.resolve({
      policy: defaultPolicy,
      intentSpec: defaultIntent,
      proposedChanges: [modifyChange, createChange],
      evidenceStore,
      existingFiles: ["app/page.tsx"],
    });

    expect(new Set(res1.approvedPaths)).toEqual(new Set(res2.approvedPaths));
    expect(new Set(res1.approvedPaths)).toEqual(new Set(["app/page.tsx", "components/Calculator.tsx"]));
    expect(res1.rejectedPaths).toHaveLength(0);
    expect(res2.rejectedPaths).toHaveLength(0);
  });

  // Section 18 — TEST: VALID PARENT + CHILD
  test("Section 18: Valid parent (with existence + SYMBOL relation) + child CREATE are both approved", () => {
    const evidenceStore = new RepositoryEvidenceStore("test-repo");
    const evApp = evidenceStore.addEvidence({
      kind: "FILE",
      filePath: "app/page.tsx",
      provenance: "REPO_READ",
    });
    const evAppRoute = evidenceStore.addEvidence({
      kind: "ROUTE",
      filePath: "app/page.tsx",
      provenance: "AST_GRAPH",
    });

    const proposed: PlannedChange[] = [
      {
        path: "components/Calculator.tsx",
        action: "create",
        reason: "New calculator",
        evidenceIds: [evApp.id],
        dependencies: [],
        integration: {
          required: true,
          satisfiedBy: ["app/page.tsx"],
        },
      },
      {
        path: "app/page.tsx",
        action: "modify",
        reason: "Mount calculator on page",
        evidenceIds: [evApp.id, evAppRoute.id],
        dependencies: ["./components/Calculator"],
      },
    ];

    const res = EvidenceBoundWriteSetResolver.resolve({
      policy: defaultPolicy,
      intentSpec: defaultIntent,
      proposedChanges: proposed,
      evidenceStore,
      existingFiles: ["app/page.tsx"],
    });

    expect(res.approvedPaths).toContain("app/page.tsx");
    expect(res.approvedPaths).toContain("components/Calculator.tsx");
    expect(res.rejectedPaths).toHaveLength(0);
  });

  // Section 19 — TEST: FIXED-POINT CASCADE
  test("Section 19: Fixed-point cascade propagates multi-level rejections (C -> B -> A) until stable", () => {
    const evidenceStore = new RepositoryEvidenceStore("test-repo");
    const evA = evidenceStore.addEvidence({
      kind: "FILE",
      filePath: "src/A.tsx",
      provenance: "REPO_READ",
    });
    const evB = evidenceStore.addEvidence({
      kind: "FILE",
      filePath: "src/B.tsx",
      provenance: "REPO_READ",
    });

    // Graph:
    // A (CREATE) integrated by B
    // B (MODIFY) forward-depends on C
    // C (MODIFY) lacks existence on disk -> C rejected
    const proposed: PlannedChange[] = [
      {
        path: "src/A.tsx",
        action: "create",
        reason: "Component A",
        evidenceIds: [evA.id],
        dependencies: [],
        integration: {
          required: true,
          satisfiedBy: ["src/B.tsx"],
        },
      },
      {
        path: "src/B.tsx",
        action: "modify",
        reason: "Component B",
        evidenceIds: [evB.id],
        dependencies: ["./C", "./A"],
      },
      {
        path: "src/C.tsx",
        action: "modify",
        reason: "Component C",
        evidenceIds: [evB.id],
        dependencies: [],
      },
    ];

    const res = EvidenceBoundWriteSetResolver.resolve({
      policy: defaultPolicy,
      intentSpec: defaultIntent,
      proposedChanges: proposed,
      evidenceStore,
      existingFiles: ["src/B.tsx"], // C does not exist on disk!
    });

    expect(res.approvedPaths).toHaveLength(0);
    expect(res.rejectedPaths.find((r) => r.path === "src/C.tsx")?.reason).toContain("EXISTING_FILE_NOT_FOUND");
    expect(res.rejectedPaths.find((r) => r.path === "src/B.tsx")?.reason).toContain("REJECT_DEPENDENCY");
    expect(res.rejectedPaths.find((r) => r.path === "src/A.tsx")?.reason).toContain("REJECT_INTEGRATION_DEPENDENCY");
  });

  // Section 20 — TEST: PARTIAL INDEPENDENT PLAN
  test("Section 20: Independent authorized change survives while dependent chain is rejected", () => {
    const evidenceStore = new RepositoryEvidenceStore("test-repo");
    const evUtils = evidenceStore.addEvidence({
      kind: "FILE",
      filePath: "src/utils.ts",
      provenance: "REPO_READ",
    });
    const evUtilsSym = evidenceStore.addEvidence({
      kind: "SYMBOL",
      filePath: "src/utils.ts",
      symbol: "formatDate",
      provenance: "AST_GRAPH",
    });

    const evBroken = evidenceStore.addEvidence({
      kind: "FILE",
      filePath: "src/broken.ts",
      provenance: "REPO_READ",
    });

    const proposed: PlannedChange[] = [
      // A: Independent change with verified existence + SYMBOL relation
      {
        path: "src/utils.ts",
        action: "modify",
        reason: "Fix date utility",
        evidenceIds: [evUtils.id, evUtilsSym.id],
        dependencies: [],
      },
      // B: CREATE widget integrated by C
      {
        path: "src/widget.tsx",
        action: "create",
        reason: "New widget",
        evidenceIds: [evBroken.id],
        dependencies: [],
        integration: {
          required: true,
          satisfiedBy: ["src/broken.ts"],
        },
      },
      // C: Broken modify (cites invented evidence ID)
      {
        path: "src/broken.ts",
        action: "modify",
        reason: "Broken integrator",
        evidenceIds: ["evi_invented_404"],
        dependencies: ["./widget"],
      },
    ];

    const res = EvidenceBoundWriteSetResolver.resolve({
      policy: defaultPolicy,
      intentSpec: defaultIntent,
      proposedChanges: proposed,
      evidenceStore,
      existingFiles: ["src/utils.ts", "src/broken.ts"],
    });

    // A remains approved; B and C are rejected
    expect(res.approvedPaths).toEqual(["src/utils.ts"]);
    expect(res.authorizedChanges.map((c) => c.path)).toEqual(["src/utils.ts"]);
    expect(res.rejectedPaths.find((r) => r.path === "src/broken.ts")).toBeDefined();
    expect(res.rejectedPaths.find((r) => r.path === "src/widget.tsx")?.reason).toContain("REJECT_INTEGRATION_DEPENDENCY");
  });

  // Section 21 — TEST: SEMANTIC AUTHORITY REGRESSION
  test("Section 21: High semantic score candidate with FILE existence only is rejected without task relation", () => {
    const evidenceStore = new RepositoryEvidenceStore("test-repo");
    const evSemantic = evidenceStore.addEvidence({
      kind: "FILE",
      filePath: "src/unrelated/Dashboard.tsx",
      provenance: "SEMANTIC_SEARCH",
    });

    const proposed: PlannedChange[] = [
      {
        path: "src/unrelated/Dashboard.tsx",
        action: "modify",
        reason: "High vector similarity unrelated dashboard",
        evidenceIds: [evSemantic.id],
        dependencies: [],
      },
    ];

    const res = EvidenceBoundWriteSetResolver.resolve({
      policy: defaultPolicy,
      intentSpec: defaultIntent,
      proposedChanges: proposed,
      evidenceStore,
      existingFiles: ["src/unrelated/Dashboard.tsx"],
    });

    expect(res.approvedPaths).toHaveLength(0);
    expect(res.rejectedPaths.find((r) => r.path === "src/unrelated/Dashboard.tsx")?.reason).toContain(
      "NO_TASK_OR_STRUCTURAL_RELATION"
    );
  });

  // Section 22 — TEST: ENTRY POINT REGRESSION
  test("Section 22: ENTRY_POINT evidence alone cannot authorize MODIFY or CREATE integration", () => {
    const evidenceStore = new RepositoryEvidenceStore("test-repo");
    const evEntry = evidenceStore.addEvidence({
      kind: "ENTRY_POINT",
      filePath: "app/page.tsx",
      provenance: "ARCHITECTURE_DETECTOR",
    });

    const proposed: PlannedChange[] = [
      {
        path: "components/Calculator.tsx",
        action: "create",
        reason: "Calculator component",
        evidenceIds: [evEntry.id],
        dependencies: [],
        integration: {
          required: true,
          satisfiedBy: ["app/page.tsx"],
        },
      },
      {
        path: "app/page.tsx",
        action: "modify",
        reason: "Entry point modify",
        evidenceIds: [evEntry.id],
        dependencies: ["./components/Calculator"],
      },
    ];

    const res = EvidenceBoundWriteSetResolver.resolve({
      policy: defaultPolicy,
      intentSpec: defaultIntent,
      proposedChanges: proposed,
      evidenceStore,
      existingFiles: ["app/page.tsx"],
    });

    // ENTRY_POINT alone lacks file existence evidence (NO_FILE_EXISTENCE_EVIDENCE)
    expect(res.approvedPaths).toHaveLength(0);
    expect(res.rejectedPaths.find((r) => r.path === "app/page.tsx")?.reason).toContain("NO_FILE_EXISTENCE_EVIDENCE");
    expect(res.rejectedPaths.find((r) => r.path === "components/Calculator.tsx")?.reason).toContain(
      "REJECT_INTEGRATION_DEPENDENCY"
    );
  });

  // Section 23 — TEST: MANIFEST INPUT EXACTNESS
  test("Section 23: Manifest input boundary before ManifestValidator matches targetPaths exactly without rejected raw paths", () => {
    const evidenceStore = new RepositoryEvidenceStore("test-repo");
    const evValid = evidenceStore.addEvidence({
      kind: "FILE",
      filePath: "src/valid.ts",
      provenance: "REPO_READ",
    });
    const evValidSym = evidenceStore.addEvidence({
      kind: "SYMBOL",
      filePath: "src/valid.ts",
      symbol: "validFunction",
      provenance: "AST_GRAPH",
    });

    const rawManifest: FileManifest = {
      files: [
        {
          path: "src/valid.ts",
          action: "modify",
          dependencies: [],
          description: "Valid file update",
          evidenceIds: [evValid.id, evValidSym.id],
        },
        {
          path: "src/rejected.ts",
          action: "modify",
          dependencies: [],
          description: "Unauthorized file update",
          evidenceIds: ["evi_fake_id"],
        },
      ],
      totalFiles: 2,
      manifestVersion: "1.0.0",
    };

    const proposed: PlannedChange[] = rawManifest.files.map((f) => ({
      path: f.path,
      action: f.action,
      reason: f.description,
      evidenceIds: f.evidenceIds || [],
      dependencies: f.dependencies || [],
    }));

    const writeAuthResult = EvidenceBoundWriteSetResolver.resolve({
      policy: defaultPolicy,
      intentSpec: defaultIntent,
      proposedChanges: proposed,
      evidenceStore,
      existingFiles: ["src/valid.ts", "src/rejected.ts"],
    });

    const approvedSet = new Set(writeAuthResult.approvedPaths.map((p) => normalizeRepoPath(p)));
    const coherentFiles = rawManifest.files.filter((f) => approvedSet.has(normalizeRepoPath(f.path)));
    const coherentAuthorizedManifest: FileManifest = {
      files: coherentFiles,
      totalFiles: coherentFiles.length,
      manifestVersion: rawManifest.manifestVersion || "1.0.0",
    };

    const finalExecutionContract = buildFinalExecutionContract(
      defaultPolicy,
      writeAuthResult.approvedPaths,
      ["src/valid.ts", "src/rejected.ts"]
    );

    // Boundary invariant: set(manifest.files.paths) === set(finalExecutionContract.targetPaths)
    const manifestPaths = new Set(coherentAuthorizedManifest.files.map((f) => normalizeRepoPath(f.path)));
    const contractPaths = new Set(finalExecutionContract.targetPaths.map((p) => normalizeRepoPath(p)));

    expect(manifestPaths).toEqual(contractPaths);
    expect(manifestPaths.has("src/rejected.ts")).toBe(false);
    expect(manifestPaths.has("src/valid.ts")).toBe(true);

    const validator = new ManifestValidator(finalExecutionContract, {
      existingFiles: ["src/valid.ts", "src/rejected.ts"],
    });
    const valRes = validator.validate(coherentAuthorizedManifest);
    expect(valRes.valid).toBe(true);
    expect(valRes.errors).toHaveLength(0);
  });
});
