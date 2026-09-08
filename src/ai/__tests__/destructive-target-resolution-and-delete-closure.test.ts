import fs from "fs";
import path from "path";
import os from "os";
import { DestructiveTargetResolver } from "../contracts/DestructiveTargetResolver";
import { TargetScopeExpander } from "../contracts/TargetScopeExpander";
import {
  EvidenceBoundWriteSetResolver,
  PlannedChange,
} from "../contracts/EvidenceBoundWriteSetResolver";
import { RepositoryEvidenceStore } from "../repository/RepositoryEvidenceStore";
import { PolicyContract } from "../contracts/PolicyContract";
import { TaskIntentSpec } from "../shared/TaskIntentSpec";
import { ManifestValidator } from "../../services/manifest-validator";
import { buildFinalExecutionContract } from "../contracts/ExecutionContractBuilder";
import { TaskExecutionPlanManager } from "../planning/TaskExecutionPlanManager";
import { StageExecutionTransaction } from "../orchestration/StageExecutionTransaction";
import { TaskClassificationResult, FileManifest, AgentFileChange } from "../../types";
import { ManifestGenerator } from "../../services/manifest-generator";

describe("Strict Implementation — Destructive Target Resolution + Delete Dependency Closure", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "destructive-test-"));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
  const repoSnapshot = [
    "src/app.ts",
    "components/calculator/Calculator.tsx",
    "components/calculator/index.ts",
    "components/calculator/Calculator.css",
    "components/todo/TodoList.tsx",
    "components/todo/index.ts",
    "admin/Calculator.tsx",
    "customer/Calculator.tsx",
    "services/standaloneService.ts",
    "utils/intermediate.ts",
    "deep/consumer.ts",
  ];

  const defaultDeletePolicy: PolicyContract = {
    goal: "remove the calculator",
    taskType: "DELETE_FOLDER",
    risk: "MEDIUM",
    estimatedComplexity: "MEDIUM",
    destructive: true,
    pipeline: "REPOSITORY",
    environment: "REACT_TS",
    allowedActions: [
      "delete_folder",
      "delete_file",
      "remove_imports",
      "update_references",
      "clean_barrel_exports",
      "modify_file",
    ],
    forbiddenActions: ["create_files"],
    maxFiles: 12,
    repositoryRequired: true,
    requiresClarification: false,
    expectedFiles: [],
    validationType: "TYPESCRIPT_BUILD",
    explicitUserPaths: [],
    userConstraints: [],
    diffCriticEnabled: true,
  };

  const defaultDeleteIntent: TaskIntentSpec = {
    goal: "remove the calculator",
    taskType: "DELETE_FOLDER",
    operations: [{ kind: "DELETE", subject: "calculator" }],
    constraints: [],
    acceptanceCriteria: ["Calculator removed"],
    destructive: true,
    requiresClarification: false,
    risk: "MEDIUM",
    estimatedComplexity: "MEDIUM",
    explicitUserPaths: [],
  };

  // Test 1: Unique feature resolved without explicit path
  test("1. Unique feature resolved without explicit path", () => {
    const singleFeatureRepo = [
      "src/app.ts",
      "components/calculator/Calculator.tsx",
      "components/calculator/index.ts",
    ];

    const resolution = DestructiveTargetResolver.resolve(
      "remove the calculator",
      singleFeatureRepo
    );

    expect(resolution.status).toBe("RESOLVED");
    expect(resolution.requiresClarification).toBe(false);
    expect(resolution.targetCertainty).toBe("GROUNDED_UNIQUE");
    expect(resolution.candidatePaths).toContain("components/calculator/Calculator.tsx");
    expect(resolution.candidatePaths).toContain("components/calculator/index.ts");
  });

  // Test 2: Ambiguous feature asks clarification
  test("2. Ambiguous feature asks clarification", () => {
    const ambiguousRepo = [
      "admin/Calculator.tsx",
      "customer/Calculator.tsx",
      "src/app.ts",
    ];

    const resolution = DestructiveTargetResolver.resolve(
      "remove the calculator",
      ambiguousRepo
    );

    expect(resolution.status).toBe("AMBIGUOUS");
    expect(resolution.requiresClarification).toBe(true);
    expect(resolution.targetCertainty).toBe("AMBIGUOUS");
    expect(resolution.candidatePaths).toEqual([]);
    expect(resolution.clarificationQuestion).toBeDefined();
  });

  // Test 3: Reverse importer discovered before delete
  test("3. Reverse importer discovered before delete", () => {
    const executionContract: any = {
      targetPaths: [
        "components/calculator/Calculator.tsx",
        "components/calculator/index.ts",
      ],
      targetProvenance: {
        "components/calculator/Calculator.tsx": "UNIQUE_NAMED_ENTITY",
        "components/calculator/index.ts": "UNIQUE_NAMED_ENTITY",
      },
      taskType: "DELETE_FOLDER",
      allowedActions: ["delete_folder", "modify_file"],
      goal: "remove the calculator",
    };

    const fileContext: Record<string, string> = {
      "src/app.ts": "import { Calculator } from './components/calculator'; export const App = () => null;",
      "components/calculator/index.ts": "export * from './Calculator';",
      "components/calculator/Calculator.tsx": "export const Calculator = () => null;",
    };

    const cleanupResult = TargetScopeExpander.expandReverseReferenceCleanupTargets({
      contract: executionContract,
      manifestFiles: [
        { path: "components/calculator/Calculator.tsx", action: "delete" },
        { path: "components/calculator/index.ts", action: "delete" },
      ],
      candidatePaths: ["src/app.ts"],
      fileContext,
    });

    expect(cleanupResult.approvedExpansions.length).toBeGreaterThan(0);
    const importerExp = cleanupResult.approvedExpansions.find(
      (e) => e.path === "src/app.ts"
    );
    expect(importerExp).toBeDefined();
    expect(importerExp?.action).toBe("modify");
  });

  // Test 4: Importer cleanup authorized structurally
  test("4. Importer cleanup authorized structurally", () => {
    const evidenceStore = new RepositoryEvidenceStore("test-repo");
    const evApp = evidenceStore.addEvidence({
      kind: "FILE",
      filePath: "src/app.ts",
      provenance: "REPO_READ",
    });
    const evCalc = evidenceStore.addEvidence({
      kind: "FILE",
      filePath: "components/calculator/Calculator.tsx",
      provenance: "REPO_READ",
    });
    const evRel = evidenceStore.addEvidence({
      kind: "IMPORT",
      filePath: "src/app.ts",
      sourceFile: "components/calculator/Calculator.tsx",
      provenance: "REFERENCE_SEARCH",
    });

    const proposed: PlannedChange[] = [
      {
        path: "components/calculator/Calculator.tsx",
        action: "delete",
        reason: "Remove calculator component",
        evidenceIds: [evCalc.id],
        dependencies: [],
      },
      {
        path: "src/app.ts",
        action: "modify",
        reason: "Clean up import to deleted calculator",
        evidenceIds: [evApp.id, evRel.id],
        dependencies: ["components/calculator/Calculator.tsx"],
      },
    ];

    const authRes = EvidenceBoundWriteSetResolver.resolve({
      policy: defaultDeletePolicy,
      intentSpec: defaultDeleteIntent,
      proposedChanges: proposed,
      evidenceStore,
      existingFiles: ["src/app.ts", "components/calculator/Calculator.tsx"],
    });

    expect(authRes.approvedPaths).toContain("components/calculator/Calculator.tsx");
    expect(authRes.approvedPaths).toContain("src/app.ts");
    expect(authRes.rejectedPaths).toEqual([]);
  });

  // Test 5: Rejected importer cascades delete rejection
  test("5. Rejected importer cascades delete rejection", () => {
    const evidenceStore = new RepositoryEvidenceStore("test-repo");
    const evApp = evidenceStore.addEvidence({
      kind: "FILE",
      filePath: "src/app.ts",
      provenance: "REPO_READ",
    });
    const evCalc = evidenceStore.addEvidence({
      kind: "FILE",
      filePath: "components/calculator/Calculator.tsx",
      provenance: "REPO_READ",
    });

    // Make src/app.ts cite NO direct relation evidence and invent an ID -> REJECT
    const proposed: PlannedChange[] = [
      {
        path: "components/calculator/Calculator.tsx",
        action: "delete",
        reason: "Remove calculator component",
        evidenceIds: [evCalc.id],
        dependencies: [],
      },
      {
        path: "src/app.ts",
        action: "modify",
        reason: "Cleanup without valid relation evidence",
        evidenceIds: [evApp.id, "invented_evi_id"],
        dependencies: ["components/calculator/Calculator.tsx"],
      },
    ];

    const authRes = EvidenceBoundWriteSetResolver.resolve({
      policy: defaultDeletePolicy,
      intentSpec: defaultDeleteIntent,
      proposedChanges: proposed,
      evidenceStore,
      existingFiles: ["src/app.ts", "components/calculator/Calculator.tsx"],
    });

    expect(authRes.approvedPaths).toEqual([]);
    const calcReject = authRes.rejectedPaths.find((r) => r.path === "components/calculator/Calculator.tsx");
    expect(calcReject).toBeDefined();
    expect(calcReject?.reason).toContain("REJECT_DEPENDENCY");
  });

  // Test 6: Multi-level reference cleanup
  test("6. Multi-level reference cleanup", () => {
    const executionContract: any = {
      targetPaths: ["components/calculator/Calculator.tsx"],
      targetProvenance: {
        "components/calculator/Calculator.tsx": "UNIQUE_NAMED_ENTITY",
      },
      taskType: "DELETE_FOLDER",
      allowedActions: ["delete_folder", "modify_file"],
      goal: "remove the calculator",
    };

    const fileContext: Record<string, string> = {
      "src/app.ts": "import { Feature } from './utils/intermediate'; export const App = Feature;",
      "utils/intermediate.ts": "export * from '../components/calculator/Calculator';",
      "components/calculator/Calculator.tsx": "export const Calculator = () => null;",
    };

    const cleanupResult = TargetScopeExpander.expandReverseReferenceCleanupTargets({
      contract: executionContract,
      manifestFiles: [{ path: "components/calculator/Calculator.tsx", action: "delete" }],
      candidatePaths: ["src/app.ts", "utils/intermediate.ts"],
      fileContext,
    });

    const approved = cleanupResult.approvedExpansions.map((e) => e.path);
    expect(approved).toContain("utils/intermediate.ts");
    expect(approved).toContain("src/app.ts");
  });

  // Test 7: Standalone explicit deletion
  test("7. Standalone explicit deletion", () => {
    const evidenceStore = new RepositoryEvidenceStore("test-repo");
    const evService = evidenceStore.addEvidence({
      kind: "FILE",
      filePath: "services/standaloneService.ts",
      provenance: "REPO_READ",
    });

    const standalonePolicy: PolicyContract = {
      ...defaultDeletePolicy,
      goal: "delete services/standaloneService.ts",
      taskType: "DELETE_FILE",
      explicitUserPaths: ["services/standaloneService.ts"],
    };

    const standaloneIntent: TaskIntentSpec = {
      ...defaultDeleteIntent,
      goal: "delete services/standaloneService.ts",
      taskType: "DELETE_FILE",
      explicitUserPaths: ["services/standaloneService.ts"],
      operations: [{ kind: "DELETE", subject: "services/standaloneService.ts" }],
    };

    const proposed: PlannedChange[] = [
      {
        path: "services/standaloneService.ts",
        action: "delete",
        reason: "Remove standalone file",
        evidenceIds: [evService.id],
        dependencies: [],
      },
    ];

    const authRes = EvidenceBoundWriteSetResolver.resolve({
      policy: standalonePolicy,
      intentSpec: standaloneIntent,
      proposedChanges: proposed,
      evidenceStore,
      existingFiles: ["services/standaloneService.ts"],
    });

    expect(authRes.approvedPaths).toEqual(["services/standaloneService.ts"]);
    expect(authRes.rejectedPaths).toEqual([]);
  });

  // Test 8: No partial destructive transaction
  test("8. No partial destructive transaction", () => {
    const evidenceStore = new RepositoryEvidenceStore("test-repo");
    const evCalc = evidenceStore.addEvidence({
      kind: "FILE",
      filePath: "components/calculator/Calculator.tsx",
      provenance: "REPO_READ",
    });

    // Importer requires cleanup, but importer change was rejected or missing
    const proposed: PlannedChange[] = [
      {
        path: "components/calculator/Calculator.tsx",
        action: "delete",
        reason: "Delete calculator",
        evidenceIds: [evCalc.id],
        dependencies: [],
      },
      {
        path: "src/app.ts",
        action: "modify",
        reason: "Importer cleanup",
        evidenceIds: [], // missing evidence IDs -> rejected
        dependencies: ["components/calculator/Calculator.tsx"],
      },
    ];

    const authRes = EvidenceBoundWriteSetResolver.resolve({
      policy: defaultDeletePolicy,
      intentSpec: defaultDeleteIntent,
      proposedChanges: proposed,
      evidenceStore,
      existingFiles: ["src/app.ts", "components/calculator/Calculator.tsx"],
    });

    // Destructive transaction must not partially succeed
    expect(authRes.approvedPaths).toEqual([]);
  });

  // Test 9: Compound remove -> create sequencing
  test("9. Compound remove -> create sequencing", () => {
    const compoundMessage = "remove the calculator and add a todo list";
    const classification: TaskClassificationResult = {
      taskType: "DELETE_FOLDER",
      risk: "MEDIUM",
      estimatedComplexity: "MEDIUM",
      intent: "DELETE_FOLDER",
      confidence: 0.95,
      requiresClarification: false,
      reasoning: "Compound request with deletion followed by feature addition",
      stages: [
        {
          id: "stage-1",
          taskType: "DELETE_FOLDER",
          goal: "remove the calculator",
          dependsOn: [],
        },
        {
          id: "stage-2",
          taskType: "NEW_FEATURE",
          goal: "add a todo list",
          dependsOn: ["stage-1"],
        },
      ],
    };

    const plan = TaskExecutionPlanManager.createTaskExecutionPlan(compoundMessage, classification);

    expect(plan.stages.length).toBe(2);
    expect(plan.stages[0].intent.taskType).toBe("DELETE_FOLDER");
    expect(plan.stages[0].dependsOn).toEqual([]);
    expect(plan.stages[1].intent.taskType).toBe("NEW_FEATURE");
    expect(plan.stages[1].dependsOn).toEqual(["stage-1"]);
  });

  // Test 10: Failed removal blocks Stage 2
  test("10. Failed removal blocks Stage 2", () => {
    const compoundMessage = "remove the calculator and add a todo list";
    const classification: TaskClassificationResult = {
      taskType: "DELETE_FOLDER",
      risk: "MEDIUM",
      estimatedComplexity: "MEDIUM",
      intent: "DELETE_FOLDER",
      confidence: 0.95,
      requiresClarification: false,
      reasoning: "Compound request with delete stage followed by add stage",
      stages: [
        {
          id: "stage-1",
          taskType: "DELETE_FOLDER",
          goal: "remove the calculator",
          dependsOn: [],
        },
        {
          id: "stage-2",
          taskType: "NEW_FEATURE",
          goal: "add a todo list",
          dependsOn: ["stage-1"],
        },
      ],
    };

    const plan = TaskExecutionPlanManager.createTaskExecutionPlan(compoundMessage, classification);
    // Mark stage-1 as FAILED
    plan.stages[0].status = "FAILED";

    const nextStage = TaskExecutionPlanManager.getNextEligibleStage(plan);
    expect(nextStage).toBeNull();
  });

  // Test 11: Rollback restores deleted files
  test("11. Rollback restores deleted files", async () => {
    const calcFile = path.join(tempDir, "components/calculator/Calculator.tsx");
    const appFile = path.join(tempDir, "src/app.ts");

    fs.mkdirSync(path.dirname(calcFile), { recursive: true });
    fs.mkdirSync(path.dirname(appFile), { recursive: true });

    fs.writeFileSync(calcFile, "export const Calculator = () => 42;", "utf8");
    fs.writeFileSync(appFile, "import { Calculator } from './components/calculator/Calculator';", "utf8");

    // Capture checkpoint
    const tx = await StageExecutionTransaction.startTransaction("stage-1", tempDir);

    // Apply delete mutation to Calculator.tsx and modify src/app.ts
    const changes: AgentFileChange[] = [
      {
        path: "components/calculator/Calculator.tsx",
        action: "delete",
        content: "",
        description: "Delete calculator",
      },
      {
        path: "src/app.ts",
        action: "modify",
        content: "// Cleaned app without calculator",
        description: "Clean up app importer",
      },
    ];

    await tx.apply(changes);

    expect(fs.existsSync(calcFile)).toBe(false);
    expect(fs.readFileSync(appFile, "utf8")).toBe("// Cleaned app without calculator");

    // Stage verification fails -> Rollback
    await tx.rollback();

    // Verify rollback restored the deleted file and modified file
    expect(fs.existsSync(calcFile)).toBe(true);
    expect(fs.readFileSync(calcFile, "utf8")).toBe("export const Calculator = () => 42;");
    expect(fs.readFileSync(appFile, "utf8")).toBe("import { Calculator } from './components/calculator/Calculator';");
    expect(tx.isRolledBack()).toBe(true);
  });

  // Test 12: Semantic-only destructive candidate rejected
  test("12. Semantic-only destructive candidate rejected", () => {
    const evidenceStore = new RepositoryEvidenceStore("test-repo");
    // Semantic search returns candidate but NO FILE existence or repo evidence
    const semEv = evidenceStore.addEvidence({
      kind: "FILE",
      filePath: "components/legacy-cache.ts",
      provenance: "SEMANTIC_SEARCH",
    });

    const proposed: PlannedChange[] = [
      {
        path: "components/legacy-cache.ts",
        action: "delete",
        reason: "Delete candidate found via semantic search only",
        evidenceIds: [semEv.id],
        dependencies: [],
      },
    ];

    const authRes = EvidenceBoundWriteSetResolver.resolve({
      policy: defaultDeletePolicy,
      intentSpec: defaultDeleteIntent,
      proposedChanges: proposed,
      evidenceStore,
      existingFiles: ["components/legacy-cache.ts"],
    });

    expect(authRes.approvedPaths).toEqual([]);
    expect(authRes.rejectedPaths[0].reason).toContain("NO_FILE_EXISTENCE_EVIDENCE");
  });

  // Focused 1: feature with component + barrel auto-resolves
  test("13. feature with component + barrel auto-resolves", () => {
    const files = [
      "src/components/calculator/Calculator.tsx",
      "src/components/calculator/index.ts",
      "src/components/calculator/Calculator.css",
      "src/app.ts",
    ];
    const res = DestructiveTargetResolver.resolve("remove the calculator", files, {
      isDestructive: true,
    });
    expect(res.status).toBe("RESOLVED");
    expect(res.requiresClarification).toBe(false);
    expect(res.candidatePaths).toContain("src/components/calculator/Calculator.tsx");
    expect(res.candidatePaths).toContain("src/components/calculator/index.ts");
    expect(res.candidatePaths).toContain("src/components/calculator/Calculator.css");
  });

  // Focused 2: component family does not create file-level clarification
  test("14. component family does not create file-level clarification", () => {
    const files = [
      "components/Calculator.tsx",
      "components/CalculatorButton.tsx",
      "components/CalculatorDisplay.tsx",
      "app/page.tsx",
    ];
    const res = DestructiveTargetResolver.resolve("remove the calculator", files, {
      isDestructive: true,
    });
    expect(res.status).toBe("RESOLVED");
    expect(res.requiresClarification).toBe(false);
    expect(res.candidatePaths).toEqual([
      "components/Calculator.tsx",
      "components/CalculatorButton.tsx",
      "components/CalculatorDisplay.tsx",
    ]);
  });

  // Focused 3: active implementation resolved structurally
  test("15. active implementation resolved structurally", () => {
    const files = [
      "components/Calculator.tsx",
      "components/CalculatorButton.tsx",
      "components/CalculatorDisplay.tsx",
      "src/components/calculator/Calculator.tsx",
      "src/components/calculator/index.ts",
      "src/app.ts",
      "app/page.tsx",
    ];
    const fileContext = {
      "src/app.ts": "import { Calculator } from './components/calculator';\nexport default Calculator;",
      "app/page.tsx": "export default function Page() { return <div>Home</div>; }",
    };
    const res = DestructiveTargetResolver.resolve("remove the calculator", files, {
      isDestructive: true,
      fileContext,
    });
    expect(res.status).toBe("RESOLVED");
    expect(res.requiresClarification).toBe(false);
    expect(res.resolvedTarget?.resolutionSource).toBe("DETERMINISTIC_ACTIVE_GRAPH");
    expect(res.candidatePaths).toEqual([
      "src/components/calculator/Calculator.tsx",
      "src/components/calculator/index.ts",
    ]);
  });

  // Focused 4 & 5: deterministic FILE and importer REFERENCE evidence hydrated before planner
  test("16 & 17. deterministic FILE and importer REFERENCE evidence hydrated before planner", () => {
    const files = [
      "src/components/calculator/Calculator.tsx",
      "src/components/calculator/index.ts",
      "src/app.ts",
    ];
    const fileContext = {
      "src/app.ts": "import { Calculator } from './components/calculator';\nexport default Calculator;",
      "src/components/calculator/Calculator.tsx": "export const Calculator = () => 42;",
      "src/components/calculator/index.ts": "export * from './Calculator';",
    };
    const evidenceStore = new RepositoryEvidenceStore("test-repo");
    const res = DestructiveTargetResolver.resolve("remove the calculator", files, {
      isDestructive: true,
      fileContext,
      evidenceStore,
    });
    expect(res.status).toBe("RESOLVED");
    expect(res.resolvedTarget).toBeDefined();

    // Check target FILE evidence (REPO_READ, verified existence)
    const calcFileEv = evidenceStore.getEvidenceForFile("src/components/calculator/Calculator.tsx");
    expect(calcFileEv.some((e) => e.kind === "FILE" && e.provenance === "REPO_READ")).toBe(true);

    // Check importer FILE and IMPORT evidence
    const appEv = evidenceStore.getEvidenceForFile("src/app.ts");
    expect(appEv.some((e) => e.kind === "FILE" && e.provenance === "REPO_READ")).toBe(true);
    expect(appEv.some((e) => e.kind === "IMPORT" && e.provenance === "REPO_READ")).toBe(true);
    expect(res.resolvedTarget?.importerPaths).toContain("src/app.ts");
  });

  // Focused 6: planner cites hydrated evidenceIds itself
  test("18. planner cites hydrated evidenceIds itself", () => {
    const evidenceStore = new RepositoryEvidenceStore("test-repo");
    const files = [
      "src/components/calculator/Calculator.tsx",
      "src/components/calculator/index.ts",
      "src/app.ts",
    ];
    const fileContext = {
      "src/app.ts": "import { Calculator } from './components/calculator';\nexport default Calculator;",
      "src/components/calculator/Calculator.tsx": "export const Calculator = () => 42;",
      "src/components/calculator/index.ts": "export * from './Calculator';",
    };
    const res = DestructiveTargetResolver.resolve("remove the calculator", files, {
      isDestructive: true,
      fileContext,
      evidenceStore,
    });

    const manifestGen = new ManifestGenerator();
    const contract = buildFinalExecutionContract(
      defaultDeletePolicy,
      [...res.candidatePaths, ...(res.resolvedTarget?.importerPaths || [])],
      files
    );
    const manifest = manifestGen.buildFallbackManifest("remove the calculator", contract, {
      existingFiles: files,
      evidenceStore,
      resolvedTarget: res.resolvedTarget,
    });

    expect(manifest.files.some((f) => f.path === "src/components/calculator/Calculator.tsx" && f.action === "delete" && (f.evidenceIds || []).length > 0)).toBe(true);
    expect(manifest.files.some((f) => f.path === "src/app.ts" && f.action === "modify" && (f.evidenceIds || []).length > 0)).toBe(true);
  });

  // Focused 7: semantic-only candidate remains unauthorized
  test("19. semantic-only candidate remains unauthorized", () => {
    const evidenceStore = new RepositoryEvidenceStore("test-repo");
    const semEv = evidenceStore.addEvidence({
      kind: "FILE",
      filePath: "components/CalculatorLegacy.tsx",
      provenance: "SEMANTIC_SEARCH",
    });

    const proposed: PlannedChange[] = [
      {
        path: "components/CalculatorLegacy.tsx",
        action: "delete",
        reason: "Discovered solely via semantic search",
        evidenceIds: [semEv.id],
        dependencies: [],
      },
    ];

    const authRes = EvidenceBoundWriteSetResolver.resolve({
      policy: defaultDeletePolicy,
      intentSpec: defaultDeleteIntent,
      proposedChanges: proposed,
      evidenceStore,
      existingFiles: ["components/CalculatorLegacy.tsx"],
    });

    expect(authRes.approvedPaths).not.toContain("components/CalculatorLegacy.tsx");
    expect(authRes.rejectedPaths[0].reason).toContain("NO_FILE_EXISTENCE_EVIDENCE");
  });

  // Focused 8: planner cannot invent related calculator files
  test("20. planner cannot invent related calculator files without structural evidence", () => {
    const evidenceStore = new RepositoryEvidenceStore("test-repo");
    const targetEv = evidenceStore.addEvidence({
      kind: "FILE",
      filePath: "src/components/calculator/Calculator.tsx",
      provenance: "REPO_READ",
      metadata: { exists: true },
    });

    const proposed: PlannedChange[] = [
      {
        path: "src/components/calculator/Calculator.tsx",
        action: "delete",
        reason: "Valid delete target",
        evidenceIds: [targetEv.id],
        dependencies: [],
      },
      {
        path: "components/CalculatorDisplay.tsx",
        action: "delete",
        reason: "Hallucinated sibling file",
        evidenceIds: ["invented_evi_id"],
        dependencies: [],
      },
    ];

    const authRes = EvidenceBoundWriteSetResolver.resolve({
      policy: defaultDeletePolicy,
      intentSpec: defaultDeleteIntent,
      proposedChanges: proposed,
      evidenceStore,
      existingFiles: ["src/components/calculator/Calculator.tsx", "components/CalculatorDisplay.tsx"],
    });

    expect(authRes.approvedPaths).toContain("src/components/calculator/Calculator.tsx");
    expect(authRes.approvedPaths).not.toContain("components/CalculatorDisplay.tsx");
    expect(authRes.rejectedPaths.some((r) => r.path === "components/CalculatorDisplay.tsx")).toBe(true);
  });

  // Focused 9 & 10: true independent product features may clarify with logical options, not paths
  test("21 & 22. true independent product features clarify with logical options, not paths", () => {
    const files = [
      "components/AdminTaxCalculator.tsx",
      "components/CustomerMortgageCalculator.tsx",
      "app/page.tsx",
    ];
    const res = DestructiveTargetResolver.resolve("remove the calculator", files, {
      isDestructive: true,
    });
    expect(res.status).toBe("AMBIGUOUS");
    expect(res.requiresClarification).toBe(true);
    expect(res.clarificationOptions).toContain("Admin Tax Calculator");
    expect(res.clarificationOptions).toContain("Customer Mortgage Calculator");
    expect(res.clarificationOptions).not.toContain("components/AdminTaxCalculator.tsx");
    expect(res.clarificationOptions).not.toContain("components/CustomerMortgageCalculator.tsx");
  });

  // Focused 11: clarification state stored structurally
  test("23. clarification state stored structurally as ResolvedTaskTarget", () => {
    const files = [
      "components/AdminTaxCalculator.tsx",
      "components/CustomerMortgageCalculator.tsx",
      "app/page.tsx",
    ];
    const evidenceStore = new RepositoryEvidenceStore("test-repo");
    const res = DestructiveTargetResolver.resolve("remove the calculator", files, {
      isDestructive: true,
      selectedLogicalTarget: "Admin Tax Calculator",
      evidenceStore,
    });
    expect(res.status).toBe("RESOLVED");
    expect(res.requiresClarification).toBe(false);
    expect(res.resolvedTarget).toBeDefined();
    expect(res.resolvedTarget?.resolutionSource).toBe("USER_CLARIFICATION");
    expect(res.resolvedTarget?.featureName).toBe("Admin Tax Calculator");
    expect(res.candidatePaths).toEqual(["components/AdminTaxCalculator.tsx"]);
  });

  // Focused 12: no raw file-picker flow for ordinary feature deletion
  test("24. no raw file-picker flow for ordinary feature deletion", () => {
    const files = [
      "components/Calculator.tsx",
      "components/CalculatorButton.tsx",
      "components/CalculatorDisplay.tsx",
      "app/page.tsx",
    ];
    const res = DestructiveTargetResolver.resolve("remove the calculator", files, {
      isDestructive: true,
    });
    expect(res.requiresClarification).toBe(false);
    expect(res.clarificationOptions).toBeUndefined();
  });

  // Focused 13: write-authority failure has correct error taxonomy
  test("25. write-authority failure has correct error taxonomy", () => {
    const evidenceStore = new RepositoryEvidenceStore("test-repo");
    const proposed: PlannedChange[] = [
      {
        path: "components/Calculator.tsx",
        action: "delete",
        reason: "Invalid change citing non-existent evidence",
        evidenceIds: ["fake_id"],
        dependencies: [],
      },
    ];
    const authRes = EvidenceBoundWriteSetResolver.resolve({
      policy: defaultDeletePolicy,
      intentSpec: defaultDeleteIntent,
      proposedChanges: proposed,
      evidenceStore,
      existingFiles: ["components/Calculator.tsx"],
    });
    expect(authRes.approvedPaths).toHaveLength(0);
    expect(authRes.rejectedPaths).toHaveLength(1);
    expect(authRes.rejectedPaths[0].reason).toContain("INVENTED_OR_MISSING_EVIDENCE_IDS");
  });

  // Focused 14: compound REMOVE -> CREATE succeeds
  test("26. compound REMOVE -> CREATE succeeds with dependency closure", async () => {
    const compoundMessage = "remove the calculator and add a todo list";
    const classification: TaskClassificationResult = {
      taskType: "NEW_FEATURE",
      risk: "MEDIUM",
      estimatedComplexity: "MEDIUM",
      intent: "NEW_FEATURE",
      confidence: 0.95,
      requiresClarification: false,
      reasoning: "Compound task: delete calculator, create todo list",
      stages: [
        {
          id: "stage-1",
          name: "remove the calculator",
          taskType: "DELETE_FOLDER",
          goal: "remove the calculator",
          targetPath: "components/calculator/Calculator.tsx",
          dependsOn: [],
        },
        {
          id: "stage-2",
          name: "add a todo list",
          taskType: "NEW_FEATURE",
          goal: "add a todo list",
          targetPath: "components/todo/TodoList.tsx",
          dependsOn: ["stage-1"],
        },
      ],
    };

    let plan = TaskExecutionPlanManager.createTaskExecutionPlan(compoundMessage, classification);
    expect(TaskExecutionPlanManager.isStageEligible(plan, "stage-1")).toBe(true);
    expect(TaskExecutionPlanManager.isStageEligible(plan, "stage-2")).toBe(false);

    const { plan: advancedPlan, nextStage } = TaskExecutionPlanManager.advancePlanStage(plan);
    expect(advancedPlan.stages[0].status).toBe("VERIFIED");
    expect(nextStage?.id).toBe("stage-2");
    expect(TaskExecutionPlanManager.isStageEligible(advancedPlan, "stage-2")).toBe(true);
  });
});
