import fs from "fs";
import os from "os";
import path from "path";
import { bindUserRequest } from "../repository/TrustedTaskContext";
import { productionIsAuthorityEligible } from "./helpers/capability-test-harness";
import { RepositoryEvidenceStore } from "../repository/RepositoryEvidenceStore";
import { PreExecutionAuthorityClosure } from "../contracts/PreExecutionAuthorityClosure";
import { EvidenceBoundWriteSetResolver } from "../contracts/EvidenceBoundWriteSetResolver";
import { TaskRootedAuthorizationVerifier } from "../contracts/TaskRootedAuthorizationProof";
import { DeterministicRelationEvidenceAcquirer } from "../contracts/DeterministicRelationEvidenceAcquirer";
import { PolicyContract } from "../contracts/PolicyContract";
import { TaskIntentSpec } from "../shared/TaskIntentSpec";
import { RepositoryObservationTools } from "../repository/RepositoryObservation";
import { authoritySnapshot, withAuthoritySnapshot } from "../repository/AuthorityWorktree";

describe("Authenticated Transitive Reverse-Cleanup Authority (Cases 1-12)", () => {
  let workspace: string;

  const write = (file: string, content: string) => {
    const abs = path.join(workspace, file);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  };

  const getFiles = (): string[] =>
    fs
      .readdirSync(workspace, { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => path.relative(workspace, path.join(d.parentPath, d.name)).replace(/\\/g, "/"));

  const createStrictStore = () => {
    const store = new RepositoryEvidenceStore("test-repo", workspace);
    store.isAuthorityEligible = productionIsAuthorityEligible.bind(store);
    return store;
  };

  const deletePolicy: PolicyContract = {
    goal: "remove the target feature",
    taskType: "DELETE_FILE",
    risk: "MEDIUM",
    estimatedComplexity: "MEDIUM",
    destructive: true,
    pipeline: "REPOSITORY",
    environment: "REACT_TS",
    allowedActions: ["delete_file", "modify_file"],
    forbiddenActions: [],
    maxFiles: 10,
    diffCriticEnabled: true,
    repositoryRequired: true,
    requiresClarification: false,
    expectedFiles: [],
    validationType: "TYPESCRIPT_BUILD",
    explicitUserPaths: [],
    userConstraints: [],
  };

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "anka-reverse-auth-"));
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  // CASE 1 — DIRECT REVERSE CLEANUP
  test("Case 1: Direct reverse cleanup acquires authentic edge and authorizes importer modify", () => {
    write("src/Target.ts", "export const target = 1;");
    write("src/Importer.ts", "import { target } from './Target'; export const imp = target;");

    const intent: TaskIntentSpec = {
      goal: "delete Target.ts",
      operations: [{ kind: "DELETE", subject: "src/Target.ts" }],
      constraints: [],
      acceptanceCriteria: [],
      destructive: true,
      requiresClarification: false,
      taskType: "DELETE_FILE",
      risk: "MEDIUM",
      estimatedComplexity: "SMALL",
      explicitUserPaths: ["src/Target.ts"],
    };
    bindUserRequest(intent, "delete Target.ts");

    const store = createStrictStore();
    const existing = getFiles();

    const acquired = DeterministicRelationEvidenceAcquirer.acquire({
      candidatePaths: ["src/Target.ts", "src/Importer.ts"],
      intentSpec: intent,
      evidenceStore: store,
      repositoryId: "test-repo",
      workspaceRoot: workspace,
      existingFiles: existing,
    });

    const targetEv = store.getEvidenceForFile("src/Target.ts");
    expect(targetEv.some((e) => e.kind === "FILE" && store.isAuthorityEligible(e))).toBe(true);

    const impEdges = store
      .getAllEvidence()
      .filter((e) => e.kind === "IMPORT" && e.sourceFile === "src/Importer.ts" && e.filePath === "src/Target.ts");
    expect(impEdges).toHaveLength(1);
    expect(store.isAuthorityEligible(impEdges[0])).toBe(true);
    expect(impEdges[0].id).toMatch(/^evi_/);

    const proof = TaskRootedAuthorizationVerifier.derive(store, intent, "src/Importer.ts", "modify");
    expect(proof).not.toBeNull();
    expect(proof?.action).toBe("modify");
    expect(proof?.candidatePath).toBe("src/Importer.ts");
    expect(proof?.edgeEvidenceIds).toContain(impEdges[0].id);

    const closure = PreExecutionAuthorityClosure.close({
      changes: [
        { path: "src/Target.ts", action: "delete", content: "", description: "delete target" },
        { path: "src/Importer.ts", action: "modify", content: "export const imp = 0;", description: "clean import" },
      ],
      policy: deletePolicy,
      intentSpec: intent,
      evidenceStore: store,
      existingFiles: existing,
      repositoryId: "test-repo",
      workspaceRoot: workspace,
      stageId: "test-stage",
    });
    expect(closure.valid).toBe(true);
    expect(closure.result.approvedPaths).toEqual(expect.arrayContaining(["src/Target.ts", "src/Importer.ts"]));
  });

  // CASE 2 — TRANSITIVE REVERSE CLEANUP
  test("Case 2: Transitive reverse cleanup authorizes bounded 3-hop chain independently", () => {
    write("src/Target.ts", "export const target = 1;");
    write("src/barrel.ts", "import { target } from './Target'; export const b = target;");
    write("src/app.ts", "import { b } from './barrel'; export const a = b;");
    write("src/index.ts", "import { a } from './app'; export const i = a;");

    const intent: TaskIntentSpec = {
      goal: "delete Target.ts",
      operations: [{ kind: "DELETE", subject: "src/Target.ts" }],
      constraints: [],
      acceptanceCriteria: [],
      destructive: true,
      requiresClarification: false,
      taskType: "DELETE_FILE",
      risk: "MEDIUM",
      estimatedComplexity: "SMALL",
      explicitUserPaths: ["src/Target.ts"],
      resolvedTarget: {
        logicalTargetId: "target",
        featureName: "target",
        evidenceIds: [],
        resolutionSource: "DETERMINISTIC_ACTIVE_GRAPH",
        status: "RESOLVED",
        candidatePaths: ["src/Target.ts"],
        importerPaths: ["src/barrel.ts", "src/app.ts", "src/index.ts"],
        actionObligations: [
          { path: "src/Target.ts", role: "PRIMARY_TARGET", requiredAction: "delete", evidenceIds: [] },
          { path: "src/barrel.ts", role: "DEPENDENCY_CLEANUP", requiredAction: "modify", evidenceIds: [] },
          { path: "src/app.ts", role: "DEPENDENCY_CLEANUP", requiredAction: "modify", evidenceIds: [] },
          { path: "src/index.ts", role: "DEPENDENCY_CLEANUP", requiredAction: "modify", evidenceIds: [] },
        ],
      },
    };
    bindUserRequest(intent, "delete Target.ts");

    const store = createStrictStore();
    const existing = getFiles();

    const closure = PreExecutionAuthorityClosure.close({
      changes: [
        { path: "src/Target.ts", action: "delete", content: "", description: "delete target" },
        { path: "src/barrel.ts", action: "modify", content: "export const b = 0;", description: "cleanup barrel" },
        { path: "src/app.ts", action: "modify", content: "export const a = 0;", description: "cleanup app" },
        { path: "src/index.ts", action: "modify", content: "export const i = 0;", description: "cleanup index" },
      ],
      policy: deletePolicy,
      intentSpec: intent,
      evidenceStore: store,
      existingFiles: existing,
      repositoryId: "test-repo",
      workspaceRoot: workspace,
      stageId: "test-stage",
    });

    expect(closure.valid).toBe(true);
    expect(closure.result.approvedPaths).toEqual(
      expect.arrayContaining(["src/Target.ts", "src/barrel.ts", "src/app.ts", "src/index.ts"]),
    );
    expect(closure.result.rejectedPaths).toHaveLength(0);

    const barrelProof = TaskRootedAuthorizationVerifier.derive(store, intent, "src/barrel.ts", "modify");
    const appProof = TaskRootedAuthorizationVerifier.derive(store, intent, "src/app.ts", "modify");
    const indexProof = TaskRootedAuthorizationVerifier.derive(store, intent, "src/index.ts", "modify");

    expect(barrelProof?.edgeEvidenceIds).toHaveLength(1);
    expect(appProof?.edgeEvidenceIds).toHaveLength(2);
    expect(indexProof?.edgeEvidenceIds).toHaveLength(3);
  });

  // CASE 3 — MISSING INTERMEDIATE EDGE
  test("Case 3: Missing intermediate edge fails closed and rejects downstream and delete closure", () => {
    write("src/Target.ts", "export const target = 1;");
    write("src/barrel.ts", "import { target } from './Target'; export const b = target;");
    // app.ts does NOT import barrel.ts! Broken intermediate edge!
    write("src/app.ts", "export const a = 1;");
    write("src/index.ts", "import { a } from './app'; export const i = a;");

    const intent: TaskIntentSpec = {
      goal: "delete Target.ts",
      operations: [{ kind: "DELETE", subject: "src/Target.ts" }],
      constraints: [],
      acceptanceCriteria: [],
      destructive: true,
      requiresClarification: false,
      taskType: "DELETE_FILE",
      risk: "MEDIUM",
      estimatedComplexity: "SMALL",
      explicitUserPaths: ["src/Target.ts"],
    };
    bindUserRequest(intent, "delete Target.ts");

    const store = createStrictStore();
    const existing = getFiles();

    DeterministicRelationEvidenceAcquirer.acquire({
      candidatePaths: ["src/Target.ts", "src/barrel.ts", "src/app.ts", "src/index.ts"],
      intentSpec: intent,
      evidenceStore: store,
      repositoryId: "test-repo",
      workspaceRoot: workspace,
      existingFiles: existing,
    });

    // barrel.ts imports Target.ts -> valid
    expect(TaskRootedAuthorizationVerifier.derive(store, intent, "src/barrel.ts", "modify")).not.toBeNull();
    // app.ts does not import barrel.ts -> null
    expect(TaskRootedAuthorizationVerifier.derive(store, intent, "src/app.ts", "modify")).toBeNull();
    // index.ts imports app.ts, but app.ts is ungrounded -> null
    expect(TaskRootedAuthorizationVerifier.derive(store, intent, "src/index.ts", "modify")).toBeNull();

    const closure = PreExecutionAuthorityClosure.close({
      changes: [
        { path: "src/Target.ts", action: "delete", content: "", description: "delete target" },
        { path: "src/barrel.ts", action: "modify", content: "export const b = 0;", description: "cleanup barrel" },
        { path: "src/app.ts", action: "modify", content: "x", description: "unauthorized modify" },
        { path: "src/index.ts", action: "modify", content: "x", description: "unauthorized modify" },
      ],
      policy: deletePolicy,
      intentSpec: intent,
      evidenceStore: store,
      existingFiles: existing,
      repositoryId: "test-repo",
      workspaceRoot: workspace,
      stageId: "test-stage",
    });
    expect(closure.valid).toBe(false);
    expect(closure.result.rejectedPaths.some((r) => r.path === "src/app.ts")).toBe(true);
    expect(closure.result.rejectedPaths.some((r) => r.path === "src/index.ts")).toBe(true);
  });

  // CASE 4 — UNRELATED GENERATED CANDIDATE
  test("Case 4: Unrelated generated candidate importing other file cannot self-authorize", () => {
    write("src/Target.ts", "export const target = 1;");
    write("src/other.ts", "export const other = 2;");
    write("src/unrelated.ts", "import { other } from './other'; export const u = other;");

    const intent: TaskIntentSpec = {
      goal: "delete Target.ts",
      operations: [{ kind: "DELETE", subject: "src/Target.ts" }],
      constraints: [],
      acceptanceCriteria: [],
      destructive: true,
      requiresClarification: false,
      taskType: "DELETE_FILE",
      risk: "MEDIUM",
      estimatedComplexity: "SMALL",
      explicitUserPaths: ["src/Target.ts"],
    };
    bindUserRequest(intent, "delete Target.ts");

    const store = createStrictStore();
    const existing = getFiles();

    DeterministicRelationEvidenceAcquirer.acquire({
      candidatePaths: ["src/Target.ts", "src/unrelated.ts"],
      intentSpec: intent,
      evidenceStore: store,
      repositoryId: "test-repo",
      workspaceRoot: workspace,
      existingFiles: existing,
    });

    expect(TaskRootedAuthorizationVerifier.derive(store, intent, "src/unrelated.ts", "modify")).toBeNull();

    const closure = PreExecutionAuthorityClosure.close({
      changes: [
        { path: "src/Target.ts", action: "delete", content: "", description: "delete" },
        { path: "src/unrelated.ts", action: "modify", content: "export const u = 0;", description: "model proposed" },
      ],
      policy: deletePolicy,
      intentSpec: intent,
      evidenceStore: store,
      existingFiles: existing,
      repositoryId: "test-repo",
      workspaceRoot: workspace,
      stageId: "test-stage",
    });
    expect(closure.valid).toBe(false);
    expect(closure.result.rejectedPaths.find((r) => r.path === "src/unrelated.ts")?.reason).toContain(
      "NO_TASK_OR_STRUCTURAL_RELATION",
    );
  });

  // CASE 5 — PLANNING METADATA IS NOT AUTHORITY
  test("Case 5: Planning metadata (actionObligation / ScopeEvidenceType) without real worktree edge fails closed", () => {
    write("src/Target.ts", "export const target = 1;");
    // No import in Importer.ts in active worktree!
    write("src/Importer.ts", "export const imp = 0;");

    const intent: TaskIntentSpec = {
      goal: "delete Target.ts",
      operations: [{ kind: "DELETE", subject: "src/Target.ts" }],
      constraints: [],
      acceptanceCriteria: [],
      destructive: true,
      requiresClarification: false,
      taskType: "DELETE_FILE",
      risk: "MEDIUM",
      estimatedComplexity: "SMALL",
      explicitUserPaths: ["src/Target.ts"],
      resolvedTarget: {
        logicalTargetId: "target",
        featureName: "target",
        evidenceIds: [],
        resolutionSource: "DETERMINISTIC_ACTIVE_GRAPH",
        status: "RESOLVED",
        candidatePaths: ["src/Target.ts"],
        importerPaths: ["src/Importer.ts"],
        actionObligations: [
          { path: "src/Target.ts", role: "PRIMARY_TARGET", requiredAction: "delete", evidenceIds: [] },
          { path: "src/Importer.ts", role: "DEPENDENCY_CLEANUP", requiredAction: "modify", evidenceIds: ["IMPORT_RELATION"] },
        ],
      },
    };
    bindUserRequest(intent, "delete Target.ts");

    const store = createStrictStore();
    const existing = getFiles();

    DeterministicRelationEvidenceAcquirer.acquire({
      candidatePaths: ["src/Target.ts", "src/Importer.ts"],
      intentSpec: intent,
      evidenceStore: store,
      repositoryId: "test-repo",
      workspaceRoot: workspace,
      existingFiles: existing,
    });

    expect(TaskRootedAuthorizationVerifier.derive(store, intent, "src/Importer.ts", "modify")).toBeNull();

    const closure = PreExecutionAuthorityClosure.close({
      changes: [
        { path: "src/Target.ts", action: "delete", content: "", description: "delete" },
        { path: "src/Importer.ts", action: "modify", content: "x", description: "planning claims cleanup" },
      ],
      policy: deletePolicy,
      intentSpec: intent,
      evidenceStore: store,
      existingFiles: existing,
      repositoryId: "test-repo",
      workspaceRoot: workspace,
      stageId: "test-stage",
    });
    expect(closure.valid).toBe(false);
  });

  // CASE 6 — AUTHENTIC EVIDENCE ONLY
  test("Case 6: Advisory evidence cannot authorize; authentic RepositoryObservationReceipt succeeds", () => {
    write("src/Target.ts", "export const target = 1;");
    write("src/Importer.ts", "export const imp = 0;");

    const intent: TaskIntentSpec = {
      goal: "delete Target.ts",
      operations: [{ kind: "DELETE", subject: "src/Target.ts" }],
      constraints: [],
      acceptanceCriteria: [],
      destructive: true,
      requiresClarification: false,
      taskType: "DELETE_FILE",
      risk: "MEDIUM",
      estimatedComplexity: "SMALL",
      explicitUserPaths: ["src/Target.ts"],
    };
    bindUserRequest(intent, "delete Target.ts");

    const store = createStrictStore();

    // 1. Add advisory / non-receipted evidence
    store.addEvidence({
      kind: "IMPORT",
      sourceFile: "src/Importer.ts",
      filePath: "src/Target.ts",
      provenance: "REFERENCE_SEARCH",
    });
    expect(TaskRootedAuthorizationVerifier.derive(store, intent, "src/Importer.ts", "modify")).toBeNull();

    // 2. Now establish worktree import and record canonical observation receipt
    write("src/Importer.ts", "import { target } from './Target'; export const imp = target;");
    withAuthoritySnapshot(workspace, () => {
      const receipt = RepositoryObservationTools.observeReference(
        "test-repo",
        workspace,
        "src/Importer.ts",
        "src/Target.ts",
      );
      expect(receipt).not.toBeNull();
      store.recordObservation(receipt!);
      const fileReceipt = RepositoryObservationTools.observeFile("test-repo", workspace, "src/Target.ts");
      store.recordObservation(fileReceipt!);
    });

    const proof = TaskRootedAuthorizationVerifier.derive(store, intent, "src/Importer.ts", "modify");
    expect(proof).not.toBeNull();
  });

  // CASE 7 — REVISION BINDING
  test("Case 7: Stale evidence from older revision fails closed", () => {
    write("src/Target.ts", "export const target = 1;");
    write("src/Importer.ts", "import { target } from './Target'; export const imp = target;");

    const intent: TaskIntentSpec = {
      goal: "delete Target.ts",
      operations: [{ kind: "DELETE", subject: "src/Target.ts" }],
      constraints: [],
      acceptanceCriteria: [],
      destructive: true,
      requiresClarification: false,
      taskType: "DELETE_FILE",
      risk: "MEDIUM",
      estimatedComplexity: "SMALL",
      explicitUserPaths: ["src/Target.ts"],
    };
    bindUserRequest(intent, "delete Target.ts");

    const store = createStrictStore();
    const existing = getFiles();

    DeterministicRelationEvidenceAcquirer.acquire({
      candidatePaths: ["src/Target.ts", "src/Importer.ts"],
      intentSpec: intent,
      evidenceStore: store,
      repositoryId: "test-repo",
      workspaceRoot: workspace,
      existingFiles: existing,
    });

    expect(TaskRootedAuthorizationVerifier.derive(store, intent, "src/Importer.ts", "modify")).not.toBeNull();

    // Change the relevant import relation before final verification
    write("src/Importer.ts", "export const imp = 0; // import removed");

    // Stale evidence must not authorize the candidate
    withAuthoritySnapshot(workspace, () => {
      const staleProof = TaskRootedAuthorizationVerifier.derive(store, intent, "src/Importer.ts", "modify");
      expect(staleProof).toBeNull();
    });
  });

  // CASE 8 — DEPTH BOUND
  test("Case 8: Reverse chain exceeding MAX_STRUCTURAL_DEPTH (3) is rejected", () => {
    // Target (0) <- c1 (1) <- c2 (2) <- c3 (3) <- c4 (4)
    write("src/Target.ts", "export const t = 0;");
    write("src/c1.ts", "import { t } from './Target'; export const v1 = t;");
    write("src/c2.ts", "import { v1 } from './c1'; export const v2 = v1;");
    write("src/c3.ts", "import { v2 } from './c2'; export const v3 = v2;");
    write("src/c4.ts", "import { v3 } from './c3'; export const v4 = v3;");

    const intent: TaskIntentSpec = {
      goal: "delete Target.ts",
      operations: [{ kind: "DELETE", subject: "src/Target.ts" }],
      constraints: [],
      acceptanceCriteria: [],
      destructive: true,
      requiresClarification: false,
      taskType: "DELETE_FILE",
      risk: "MEDIUM",
      estimatedComplexity: "SMALL",
      explicitUserPaths: ["src/Target.ts"],
      resolvedTarget: {
        logicalTargetId: "target",
        featureName: "target",
        evidenceIds: [],
        resolutionSource: "DETERMINISTIC_ACTIVE_GRAPH",
        status: "RESOLVED",
        candidatePaths: ["src/Target.ts"],
        importerPaths: ["src/c1.ts", "src/c2.ts", "src/c3.ts", "src/c4.ts"],
        actionObligations: [
          { path: "src/Target.ts", role: "PRIMARY_TARGET", requiredAction: "delete", evidenceIds: [] },
          { path: "src/c1.ts", role: "DEPENDENCY_CLEANUP", requiredAction: "modify", evidenceIds: [] },
          { path: "src/c2.ts", role: "DEPENDENCY_CLEANUP", requiredAction: "modify", evidenceIds: [] },
          { path: "src/c3.ts", role: "DEPENDENCY_CLEANUP", requiredAction: "modify", evidenceIds: [] },
          { path: "src/c4.ts", role: "DEPENDENCY_CLEANUP", requiredAction: "modify", evidenceIds: [] },
        ],
      },
    };
    bindUserRequest(intent, "delete Target.ts");

    const store = createStrictStore();
    const existing = getFiles();

    DeterministicRelationEvidenceAcquirer.acquire({
      candidatePaths: ["src/Target.ts", "src/c1.ts", "src/c2.ts", "src/c3.ts", "src/c4.ts"],
      intentSpec: intent,
      evidenceStore: store,
      repositoryId: "test-repo",
      workspaceRoot: workspace,
      existingFiles: existing,
    });

    expect(TaskRootedAuthorizationVerifier.derive(store, intent, "src/c1.ts", "modify")).not.toBeNull();
    expect(TaskRootedAuthorizationVerifier.derive(store, intent, "src/c2.ts", "modify")).not.toBeNull();
    expect(TaskRootedAuthorizationVerifier.derive(store, intent, "src/c3.ts", "modify")).not.toBeNull();
    // c4 is at depth 4 -> REJECTED
    expect(TaskRootedAuthorizationVerifier.derive(store, intent, "src/c4.ts", "modify")).toBeNull();
  });

  // CASE 9 — CYCLE
  test("Case 9: Cyclic imports terminate deterministically without infinite loop or unbounded evidence", () => {
    write("src/Target.ts", "export const t = 0;");
    write("src/a.ts", "import { t } from './Target'; import { c } from './c'; export const a = t + c;");
    write("src/b.ts", "import { a } from './a'; export const b = a;");
    write("src/c.ts", "import { b } from './b'; export const c = b;");

    const intent: TaskIntentSpec = {
      goal: "delete Target.ts",
      operations: [{ kind: "DELETE", subject: "src/Target.ts" }],
      constraints: [],
      acceptanceCriteria: [],
      destructive: true,
      requiresClarification: false,
      taskType: "DELETE_FILE",
      risk: "MEDIUM",
      estimatedComplexity: "SMALL",
      explicitUserPaths: ["src/Target.ts"],
      resolvedTarget: {
        logicalTargetId: "target",
        featureName: "target",
        evidenceIds: [],
        resolutionSource: "DETERMINISTIC_ACTIVE_GRAPH",
        status: "RESOLVED",
        candidatePaths: ["src/Target.ts"],
        importerPaths: ["src/a.ts", "src/b.ts", "src/c.ts"],
        actionObligations: [
          { path: "src/Target.ts", role: "PRIMARY_TARGET", requiredAction: "delete", evidenceIds: [] },
          { path: "src/a.ts", role: "DEPENDENCY_CLEANUP", requiredAction: "modify", evidenceIds: [] },
          { path: "src/b.ts", role: "DEPENDENCY_CLEANUP", requiredAction: "modify", evidenceIds: [] },
          { path: "src/c.ts", role: "DEPENDENCY_CLEANUP", requiredAction: "modify", evidenceIds: [] },
        ],
      },
    };
    bindUserRequest(intent, "delete Target.ts");

    const store = createStrictStore();
    const existing = getFiles();

    DeterministicRelationEvidenceAcquirer.acquire({
      candidatePaths: ["src/Target.ts", "src/a.ts", "src/b.ts", "src/c.ts"],
      intentSpec: intent,
      evidenceStore: store,
      repositoryId: "test-repo",
      workspaceRoot: workspace,
      existingFiles: existing,
    });

    const proofA1 = TaskRootedAuthorizationVerifier.derive(store, intent, "src/a.ts", "modify");
    const proofA2 = TaskRootedAuthorizationVerifier.derive(store, intent, "src/a.ts", "modify");
    expect(proofA1).not.toBeNull();
    expect(proofA1).toEqual(proofA2);
  });

  // CASE 10 — EXISTING FORWARD PROOF REGRESSION
  test("Case 10: Forward structural authority continues to work unchanged", () => {
    write("app/projects/[id]/page.tsx", "import '../../../a'; export default function Page() { return null; }");
    write("a.ts", "import './b'; export const a = 1;");
    write("b.ts", "import './c'; export const b = 1;");
    write("c.ts", "export const c = 1;");

    const intent: TaskIntentSpec = {
      goal: "Repair /projects/proj-1",
      operations: [{ kind: "REPAIR", subject: "Opening /projects/proj-1 is broken" }],
      constraints: [],
      acceptanceCriteria: [],
      destructive: false,
      requiresClarification: false,
      taskType: "BUG_FIX",
      risk: "MEDIUM",
      estimatedComplexity: "SMALL",
      explicitUserPaths: [],
    };
    bindUserRequest(intent, "Repair /projects/proj-1");

    const store = createStrictStore();
    const existing = getFiles();

    const closure = PreExecutionAuthorityClosure.close({
      changes: [
        { path: "a.ts", action: "modify", content: "x", description: "forward modify" },
        { path: "c.ts", action: "modify", content: "x", description: "forward modify" },
      ],
      policy: { ...deletePolicy, destructive: false, allowedActions: ["modify_file"] },
      intentSpec: intent,
      evidenceStore: store,
      existingFiles: existing,
      repositoryId: "test-repo",
      workspaceRoot: workspace,
      stageId: "test-stage",
    });
    expect(closure.valid).toBe(true);
    expect(closure.result.approvedPaths).toEqual(expect.arrayContaining(["a.ts", "c.ts"]));
  });

  // CASE 11 — PRODUCTION-SHAPED REGRESSION
  test("Case 11: Production-shaped calculator removal with index barrel, app, and root index", () => {
    write("src/components/calculator/Calculator.tsx", "export const Calculator = () => null;");
    write("src/components/calculator/index.ts", "export { Calculator } from './Calculator';");
    write("src/app.ts", "import { Calculator } from './components/calculator'; export const App = Calculator;");
    write("src/index.ts", "import { App } from './app'; export const Root = App;");

    const intent: TaskIntentSpec = {
      goal: "remove the calculator and add a todo list",
      operations: [
        { kind: "DELETE", subject: "calculator" },
        { kind: "CREATE", subject: "todo list" },
      ],
      constraints: [],
      acceptanceCriteria: [],
      destructive: true,
      requiresClarification: false,
      taskType: "NEW_FEATURE",
      risk: "MEDIUM",
      estimatedComplexity: "MEDIUM",
      explicitUserPaths: [],
      resolvedTarget: {
        logicalTargetId: "calculator",
        featureName: "calculator",
        evidenceIds: [],
        resolutionSource: "DETERMINISTIC_ACTIVE_GRAPH",
        status: "RESOLVED",
        candidatePaths: ["src/components/calculator/Calculator.tsx"],
        importerPaths: [
          "src/components/calculator/index.ts",
          "src/app.ts",
          "src/index.ts",
        ],
        actionObligations: [
          { path: "src/components/calculator/Calculator.tsx", role: "PRIMARY_TARGET", requiredAction: "delete", evidenceIds: [] },
          { path: "src/components/calculator/index.ts", role: "DEPENDENCY_CLEANUP", requiredAction: "modify", evidenceIds: [] },
          { path: "src/app.ts", role: "DEPENDENCY_CLEANUP", requiredAction: "modify", evidenceIds: [] },
          { path: "src/index.ts", role: "DEPENDENCY_CLEANUP", requiredAction: "modify", evidenceIds: [] },
        ],
      },
    };
    bindUserRequest(intent, "remove the calculator and add a todo list");

    const store = createStrictStore();
    const existing = getFiles();

    const closure = PreExecutionAuthorityClosure.close({
      changes: [
        { path: "src/components/calculator/Calculator.tsx", action: "delete", content: "", description: "remove calculator" },
        { path: "src/components/calculator/index.ts", action: "modify", content: "export {};", description: "cleanup barrel" },
        { path: "src/app.ts", action: "modify", content: "export const App = null;", description: "cleanup app" },
        { path: "src/index.ts", action: "modify", content: "import { App } from './app'; export const Root = App;", description: "cleanup index" },
      ],
      policy: { ...deletePolicy, allowedActions: ["delete_file", "modify_file", "create_files"] },
      intentSpec: intent,
      evidenceStore: store,
      existingFiles: existing,
      repositoryId: "test-repo",
      workspaceRoot: workspace,
      stageId: "test-stage",
    });

    expect(closure.valid).toBe(true);
    expect(closure.result.approvedPaths).toEqual(
      expect.arrayContaining([
        "src/components/calculator/Calculator.tsx",
        "src/components/calculator/index.ts",
        "src/app.ts",
        "src/index.ts",
      ]),
    );
    expect(closure.result.rejectedPaths).toHaveLength(0);
  });

  // CASE 12 — DELETE SECURITY
  test("Case 12: Reverse cleanup MODIFY proof never confers DELETE authority", () => {
    write("src/Target.ts", "export const target = 1;");
    write("src/Importer.ts", "import { target } from './Target'; export const imp = target;");

    const intent: TaskIntentSpec = {
      goal: "delete Target.ts",
      operations: [{ kind: "DELETE", subject: "src/Target.ts" }],
      constraints: [],
      acceptanceCriteria: [],
      destructive: true,
      requiresClarification: false,
      taskType: "DELETE_FILE",
      risk: "MEDIUM",
      estimatedComplexity: "SMALL",
      explicitUserPaths: ["src/Target.ts"],
    };
    bindUserRequest(intent, "delete Target.ts");

    const store = createStrictStore();
    const existing = getFiles();

    DeterministicRelationEvidenceAcquirer.acquire({
      candidatePaths: ["src/Target.ts", "src/Importer.ts"],
      intentSpec: intent,
      evidenceStore: store,
      repositoryId: "test-repo",
      workspaceRoot: workspace,
      existingFiles: existing,
    });

    // Proposing DELETE for Importer.ts must be rejected!
    const deleteProof = TaskRootedAuthorizationVerifier.derive(store, intent, "src/Importer.ts", "delete");
    expect(deleteProof).toBeNull();

    const closure = PreExecutionAuthorityClosure.close({
      changes: [
        { path: "src/Target.ts", action: "delete", content: "", description: "delete target" },
        { path: "src/Importer.ts", action: "delete", content: "", description: "importer cannot be deleted" },
      ],
      policy: deletePolicy,
      intentSpec: intent,
      evidenceStore: store,
      existingFiles: existing,
      repositoryId: "test-repo",
      workspaceRoot: workspace,
      stageId: "test-stage",
    });
    expect(closure.valid).toBe(false);
    expect(closure.result.rejectedPaths.some((r) => r.path === "src/Importer.ts")).toBe(true);
  });

  // CASE 13 — ADVERSARIAL CANDIDATE ISOLATION
  test("Case 13: Model-proposed candidate importing proven cleanup node without deterministic cleanup eligibility fails closed", () => {
    write("src/Target.ts", "export const target = 1;");
    write("src/barrel.ts", "import { target } from './Target'; export const b = target;");
    write("src/app.ts", "import { b } from './barrel'; export const a = b;");
    write("src/attacker.ts", "import { a } from './app'; export const atk = a;");

    const intent: TaskIntentSpec = {
      goal: "delete Target.ts",
      operations: [{ kind: "DELETE", subject: "src/Target.ts" }],
      constraints: [],
      acceptanceCriteria: [],
      destructive: true,
      requiresClarification: false,
      taskType: "DELETE_FILE",
      risk: "MEDIUM",
      estimatedComplexity: "SMALL",
      explicitUserPaths: ["src/Target.ts"],
      resolvedTarget: {
        logicalTargetId: "target",
        featureName: "target",
        evidenceIds: [],
        resolutionSource: "DETERMINISTIC_ACTIVE_GRAPH",
        status: "RESOLVED",
        candidatePaths: ["src/Target.ts"],
        importerPaths: ["src/barrel.ts", "src/app.ts"],
        actionObligations: [
          { path: "src/Target.ts", role: "PRIMARY_TARGET", requiredAction: "delete", evidenceIds: [] },
          { path: "src/barrel.ts", role: "DEPENDENCY_CLEANUP", requiredAction: "modify", evidenceIds: [] },
          { path: "src/app.ts", role: "DEPENDENCY_CLEANUP", requiredAction: "modify", evidenceIds: [] },
        ],
      },
    };
    bindUserRequest(intent, "delete Target.ts");

    const store = createStrictStore();
    const existing = getFiles();

    // Acquirer is presented with all candidates including attacker.ts
    DeterministicRelationEvidenceAcquirer.acquire({
      candidatePaths: ["src/Target.ts", "src/barrel.ts", "src/app.ts", "src/attacker.ts"],
      intentSpec: intent,
      evidenceStore: store,
      repositoryId: "test-repo",
      workspaceRoot: workspace,
      existingFiles: existing,
    });

    // barrel.ts and app.ts are cleanup-eligible and have authentic edges -> PASS
    expect(TaskRootedAuthorizationVerifier.derive(store, intent, "src/barrel.ts", "modify")).not.toBeNull();
    expect(TaskRootedAuthorizationVerifier.derive(store, intent, "src/app.ts", "modify")).not.toBeNull();

    // attacker.ts has authentic physical edge to app.ts, BUT is not cleanup-eligible -> REJECT
    const attackerProof = TaskRootedAuthorizationVerifier.derive(store, intent, "src/attacker.ts", "modify");
    expect(attackerProof).toBeNull();

    const closure = PreExecutionAuthorityClosure.close({
      changes: [
        { path: "src/Target.ts", action: "delete", content: "", description: "delete target" },
        { path: "src/barrel.ts", action: "modify", content: "export const b = 0;", description: "cleanup barrel" },
        { path: "src/app.ts", action: "modify", content: "export const a = 0;", description: "cleanup app" },
        { path: "src/attacker.ts", action: "modify", content: "export const atk = 0;", description: "unauthorized modify" },
      ],
      policy: deletePolicy,
      intentSpec: intent,
      evidenceStore: store,
      existingFiles: existing,
      repositoryId: "test-repo",
      workspaceRoot: workspace,
      stageId: "test-stage",
    });

    expect(closure.valid).toBe(false);
    expect(closure.result.approvedPaths).toEqual(
      expect.arrayContaining(["src/Target.ts", "src/barrel.ts", "src/app.ts"]),
    );
    expect(closure.result.rejectedPaths.some((r) => r.path === "src/attacker.ts")).toBe(true);
    expect(
      closure.result.rejectedPaths.find((r) => r.path === "src/attacker.ts")?.reason,
    ).toContain("NO_TASK_OR_STRUCTURAL_RELATION");
  });

  // CASE 14 — CREATE PROPOSAL ON CLEANUP CANDIDATE
  test("Case 14: Cleanup candidate proposed as CREATE fails closed", () => {
    write("src/Target.ts", "export const target = 1;");
    write("src/barrel.ts", "import { target } from './Target'; export const b = target;");

    const intent: TaskIntentSpec = {
      goal: "delete Target.ts",
      operations: [{ kind: "DELETE", subject: "src/Target.ts" }],
      constraints: [],
      acceptanceCriteria: [],
      destructive: true,
      requiresClarification: false,
      taskType: "DELETE_FILE",
      risk: "MEDIUM",
      estimatedComplexity: "SMALL",
      explicitUserPaths: ["src/Target.ts"],
      resolvedTarget: {
        logicalTargetId: "target",
        featureName: "target",
        evidenceIds: [],
        resolutionSource: "DETERMINISTIC_ACTIVE_GRAPH",
        status: "RESOLVED",
        candidatePaths: ["src/Target.ts"],
        importerPaths: ["src/barrel.ts"],
        actionObligations: [
          { path: "src/Target.ts", role: "PRIMARY_TARGET", requiredAction: "delete", evidenceIds: [] },
          { path: "src/barrel.ts", role: "DEPENDENCY_CLEANUP", requiredAction: "modify", evidenceIds: [] },
        ],
      },
    };
    bindUserRequest(intent, "delete Target.ts");

    const store = createStrictStore();
    const existing = getFiles();

    DeterministicRelationEvidenceAcquirer.acquire({
      candidatePaths: ["src/Target.ts", "src/barrel.ts"],
      intentSpec: intent,
      evidenceStore: store,
      repositoryId: "test-repo",
      workspaceRoot: workspace,
      existingFiles: existing,
    });

    const createProof = TaskRootedAuthorizationVerifier.derive(store, intent, "src/barrel.ts", "create");
    expect(createProof).toBeNull();
  });
});
