import fs from "fs";
import os from "os";
import path from "path";
import { RepositoryEvidenceStore } from "../repository/RepositoryEvidenceStore";
import { TaskRootedAuthorizationVerifier } from "../contracts/TaskRootedAuthorizationProof";
import { TaskAnchorResolver } from "../repository/TaskAnchorResolver";
import { PolicyContract } from "../contracts/PolicyContract";
import { TaskIntentSpec, createTaskIntentSpec } from "../shared/TaskIntentSpec";
import { TaskClassificationResult } from "../classification/TaskTypes";
import { EvidenceBoundWriteSetResolver } from "../contracts/EvidenceBoundWriteSetResolver";
import { DeterministicRelationEvidenceAcquirer } from "../contracts/DeterministicRelationEvidenceAcquirer";
import { PreExecutionAuthorityClosure } from "../contracts/PreExecutionAuthorityClosure";
import { DestructiveSafetyEvaluator } from "../classification/DestructiveSafetyEvaluator";
import { AgentPlanner } from "../orchestration/AgentPlanner";
import { TaskExecutionPlanManager } from "../planning/TaskExecutionPlanManager";
import { TaskExecutionPlan } from "../shared/TaskExecutionPlan";
import { RepositoryInvestigationAgent } from "../repository/RepositoryInvestigationAgent";
import { RepositoryToolEngine } from "../../services/repository-tool.engine";
import { bindBackendManifestEvidence } from "../orchestration/AgentPlanner";
import { DestructiveTargetResolver } from "../contracts/DestructiveTargetResolver";
import { AuthorizedCapabilityScope, CapabilityGuard } from "../runtime/CapabilityGuard";
import { RepositoryObservationTools } from "../repository/RepositoryObservation";
import { productionIsAuthorityEligible } from "./helpers/capability-test-harness";

describe("Constructive Create Authority and Stage-Aware Clarification", () => {
  jest.setTimeout(30000);
  let root: string;
  let store: RepositoryEvidenceStore;

  const write = (filePath: string, content: string) => {
    const absolute = path.join(root, filePath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content, "utf8");
  };

  const getFiles = (): string[] =>
    fs
      .readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => path.relative(root, path.join(d.parentPath, d.name)).replace(/\\/g, "/"));

  const defaultPolicy: PolicyContract = {
    goal: "Feature Implementation",
    taskType: "NEW_FEATURE",
    risk: "MEDIUM",
    estimatedComplexity: "MEDIUM",
    destructive: false,
    allowedActions: ["create_file", "modify_file", "delete_file"],
    forbiddenActions: [],
    maxFiles: 5,
    diffCriticEnabled: true,
    pipeline: "REPOSITORY",
    environment: "GENERIC",
    repositoryRequired: true,
    expectedFiles: [],
    validationType: "TYPESCRIPT_BUILD",
    explicitUserPaths: [],
    userConstraints: [],
    requiresClarification: false,
  };

  const constructiveClassification: TaskClassificationResult = {
    taskType: "NEW_FEATURE",
    intent: "NEW_FEATURE",
    risk: "MEDIUM",
    estimatedComplexity: "MEDIUM",
    confidence: 1,
    requiresClarification: false,
    reasoning: "Constructive task",
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "constructive-authority-test-"));
    store = new RepositoryEvidenceStore("test-repo", root);
    store.isAuthorityEligible = productionIsAuthorityEligible.bind(store);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (fs.existsSync(root)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // CASE 1: False Clarification After Verified Delete
  test("CASE 1: False Clarification After Verified Delete is suppressed when active stage is constructive", async () => {
    write("app/page.tsx", "export default function Page() { return <div>Home</div>; }");
    // Calculator was deleted in Stage 1 and is now absent from repository
    const plan: TaskExecutionPlan = {
      id: "plan-1",
      goal: "remove feature A and add feature B",
      currentStageIndex: 1,
      status: "RUNNING",
      priorVerifiedTargets: [{ path: "components/FeatureA.tsx", action: "delete" }],
      stages: [
        {
          id: "stage-1",
          name: "remove feature A",
          intent: createTaskIntentSpec("remove feature A", {
            taskType: "DELETE_FILE",
            intent: "DELETE_FILE",
            risk: "MEDIUM",
            estimatedComplexity: "SMALL",
            confidence: 1,
            requiresClarification: false,
            reasoning: "Delete stage",
          }),
          dependsOn: [],
          status: "VERIFIED",
        },
        {
          id: "stage-2",
          name: "add feature B",
          intent: createTaskIntentSpec("add feature B", constructiveClassification),
          dependsOn: ["stage-1"],
          status: "PENDING",
        },
      ],
    };

    const planning = await AgentPlanner.plan({
      request: {
        message: "remove feature A and add feature B",
        context: { taskExecutionPlan: plan },
      } as any,
      projectContext: { project: { name: "test" } } as any,
      canonicalExistingFiles: getFiles(),
    });

    expect(planning.status).toBe("READY");
    expect(planning.intentResult.requiresClarification).toBe(false);
    expect(planning.activeStage?.id).toBe("stage-2");
  });

  // CASE 2: Active Destructive Stage Still Safe
  test("CASE 2: Active Destructive Stage Still Safe - runs destructive safety evaluation fail-closed", () => {
    write("app/page.tsx", "export default function Page() { return <div>Home</div>; }");
    // Missing target must trigger clarification
    const assessment = DestructiveSafetyEvaluator.evaluate(
      "remove legacy auth component",
      getFiles(),
      { taskType: "DELETE_FILE" }
    );

    expect(assessment.isDestructive).toBe(true);
    expect(assessment.requiresClarification).toBe(true);
    expect(assessment.clarificationQuestion).toMatch(/No repository file matching/i);
  });

  // CASE 3: Cancel Deletion
  test("CASE 3: Cancel Deletion transitions target destructive stage to CANCELLED and allows sibling stage", async () => {
    const plan: TaskExecutionPlan = {
      id: "plan-1",
      goal: "remove legacy component and add modern feature",
      currentStageIndex: 0,
      status: "PENDING",
      stages: [
        {
          id: "stage-1",
          name: "remove legacy component",
          intent: createTaskIntentSpec("remove legacy component", {
            taskType: "DELETE_FILE",
            intent: "DELETE_FILE",
            risk: "MEDIUM",
            estimatedComplexity: "SMALL",
            confidence: 1,
            requiresClarification: false,
            reasoning: "Active delete stage",
          }),
          dependsOn: [],
          status: "PENDING",
        },
        {
          id: "stage-2",
          name: "add modern feature",
          intent: createTaskIntentSpec("add modern feature", constructiveClassification),
          dependsOn: ["stage-1"],
          status: "PENDING",
        },
      ],
    };

    const updated = await TaskExecutionPlanManager.reorderPlanWithClarification(
      plan,
      "Cancel deletion",
      "No repository file matching legacy component found. Please clarify."
    );

    expect(updated.stages[0].status).toBe("CANCELLED");
    expect(updated.stages[1].status).toBe("PENDING");
    expect(TaskExecutionPlanManager.isStageEligible(updated, "stage-2")).toBe(true);
    expect(updated.currentStageIndex).toBe(1);
    expect(updated.status).toBe("RUNNING");
  });

  // CASE 4: Constructive Anchor Discovery
  test("CASE 4: Constructive Anchor Discovery - deterministically discovers active UI entry point", () => {
    write("app/page.tsx", "export default function Page() { return <div>Home</div>; }");
    write("app/layout.tsx", "export default function Layout({ children }: any) { return <html><body>{children}</body></html>; }");

    const intent = createTaskIntentSpec("add a task list", constructiveClassification);
    const resolved = TaskAnchorResolver.resolve({
      intentSpec: intent,
      repositoryFiles: getFiles(),
      repositoryId: "test-repo",
      workspaceRoot: root,
      evidenceStore: store,
    });

    expect(resolved.uiAnchors).toContain("app/page.tsx");
    const roots = TaskRootedAuthorizationVerifier.roots(store, intent);
    expect(roots.some((r) => r.kind === "ENTRY_POINT" && r.filePath === "app/page.tsx")).toBe(true);
  });

  // CASE 5: Ready-To-Plan Constructive
  test("CASE 5: Ready-To-Plan Constructive - satisfiability via authentic anchor evidence without forced flag", async () => {
    write("app/page.tsx", "export default function Page() { return <div>Home</div>; }");
    const intent = createTaskIntentSpec("add a todo list", constructiveClassification);

    TaskAnchorResolver.resolve({
      intentSpec: intent,
      repositoryFiles: getFiles(),
      repositoryId: "test-repo",
      workspaceRoot: root,
      evidenceStore: store,
    });

    const snapshot = {
      repositoryId: "test-repo",
      revision: "rev-1",
      files: new Map([["app/page.tsx", { path: "app/page.tsx", content: "export default function Page() { return <div>Home</div>; }" }]]),
      branch: "main",
      timestamp: new Date(),
    };
    const toolEngine = new RepositoryToolEngine(snapshot, root);
    const investigationAgent = new RepositoryInvestigationAgent({
      toolEngine,
      evidenceStore: store,
      intentSpec: intent,
      localPath: root,
    });

    const stopCheck = (investigationAgent as any).evaluateStopConditions();
    expect(stopCheck.ready).toBe(true);
    expect(stopCheck.missing).toHaveLength(0);
  });

  // CASE 6: Natural-Language CREATE Proof
  test("CASE 6: Natural-Language CREATE Proof - derives bounded CREATE proof from verified anchor", () => {
    write("app/page.tsx", "export default function Page() { return <div>Home</div>; }");
    const intent = createTaskIntentSpec("add a todo list", constructiveClassification);

    // Initialize anchor
    TaskAnchorResolver.resolve({
      intentSpec: intent,
      repositoryFiles: getFiles(),
      repositoryId: "test-repo",
      workspaceRoot: root,
      evidenceStore: store,
    });

    const proof = TaskRootedAuthorizationVerifier.derive(
      store,
      intent,
      "components/TodoList.tsx",
      "create"
    );

    expect(proof).not.toBeNull();
    expect(proof?.action).toBe("create");
    expect(proof?.candidatePath).toBe("components/TodoList.tsx");
    expect(proof?.edgeEvidenceIds).toHaveLength(0);
    expect(TaskRootedAuthorizationVerifier.verify(store, intent, proof!)).toBe(true);
  });

  // CASE 7: Host MODIFY Proof
  test("CASE 7: Host MODIFY Proof - existing host receives independent proof, distinct from child CREATE", () => {
    write("app/page.tsx", "export default function Page() { return <div>Home</div>; }");
    const intent = createTaskIntentSpec("add a todo list", constructiveClassification);

    TaskAnchorResolver.resolve({
      intentSpec: intent,
      repositoryFiles: getFiles(),
      repositoryId: "test-repo",
      workspaceRoot: root,
      evidenceStore: store,
    });

    const childCreateProof = TaskRootedAuthorizationVerifier.derive(
      store,
      intent,
      "components/TodoList.tsx",
      "create"
    );
    const hostModifyProof = TaskRootedAuthorizationVerifier.derive(
      store,
      intent,
      "app/page.tsx",
      "modify"
    );

    expect(hostModifyProof).not.toBeNull();
    expect(hostModifyProof?.action).toBe("modify");
    expect(hostModifyProof?.candidatePath).toBe("app/page.tsx");

    expect(childCreateProof).not.toBeNull();
    expect(childCreateProof?.action).toBe("create");
    expect(childCreateProof?.candidatePath).toBe("components/TodoList.tsx");

    // Proofs are separate and non-fungible
    expect(hostModifyProof?.candidatePath).not.toBe(childCreateProof?.candidatePath);
    expect(hostModifyProof?.action).not.toBe(childCreateProof?.action);
  });

  // CASE 8: Compound CREATE + MODIFY Authorization
  test("CASE 8: Compound CREATE + MODIFY Authorization - EvidenceBoundWriteSetResolver approves both independently", () => {
    write("app/page.tsx", "export default function Page() { return <div>Home</div>; }");
    const intent = createTaskIntentSpec("add a todo list", constructiveClassification);

    const acquired = DeterministicRelationEvidenceAcquirer.acquire({
      candidatePaths: ["components/TodoList.tsx", "app/page.tsx"],
      intentSpec: intent,
      evidenceStore: store,
      repositoryId: "test-repo",
      workspaceRoot: root,
      existingFiles: getFiles(),
    });

    const plannedChanges = bindBackendManifestEvidence({
      files: [
        { path: "components/TodoList.tsx", action: "create", description: "New component", dependencies: [] },
        { path: "app/page.tsx", action: "modify", description: "Integrate component", dependencies: [] },
      ],
      obligations: [],
      acquiredEvidence: acquired,
      evidenceStore: store,
    });

    const result = EvidenceBoundWriteSetResolver.resolve({
      policy: defaultPolicy,
      intentSpec: intent,
      proposedChanges: plannedChanges,
      evidenceStore: store,
      existingFiles: getFiles(),
      targetRepositoryId: "test-repo",
      workspaceRoot: root,
    });

    expect(result.approvedPaths).toContain("components/TodoList.tsx");
    expect(result.approvedPaths).toContain("app/page.tsx");
    expect(result.rejectedPaths).toHaveLength(0);
    expect(result.evidenceAuthorization).toBeDefined();
    expect(result.evidenceAuthorization?.getApprovedGrants()).toHaveLength(2);
  });

  // CASE 9: No Anchor
  test("CASE 9: No Anchor - fails closed when repository lacks any recognized anchor", () => {
    // Only arbitrary non-UI file present
    write("notes.txt", "some notes");
    const intent = createTaskIntentSpec("add a widget", constructiveClassification);

    TaskAnchorResolver.resolve({
      intentSpec: intent,
      repositoryFiles: getFiles(),
      repositoryId: "test-repo",
      workspaceRoot: root,
      evidenceStore: store,
    });

    const proof = TaskRootedAuthorizationVerifier.derive(
      store,
      intent,
      "components/Widget.tsx",
      "create"
    );

    expect(proof).toBeNull();
  });

  // CASE 10: Outside Repository
  test("CASE 10: Outside Repository - reject path escaping workspace", () => {
    write("app/page.tsx", "export default function Page() { return null; }");
    const intent = createTaskIntentSpec("add a todo list", constructiveClassification);

    TaskAnchorResolver.resolve({
      intentSpec: intent,
      repositoryFiles: getFiles(),
      repositoryId: "test-repo",
      workspaceRoot: root,
      evidenceStore: store,
    });

    const proof = TaskRootedAuthorizationVerifier.derive(
      store,
      intent,
      "../../outside.ts",
      "create"
    );

    expect(proof).toBeNull();
  });

  // CASE 11: Unrelated Valid Repository Path
  test("CASE 11: Unrelated Valid Repository Path - reject security / sensitive path proposal", () => {
    write("app/page.tsx", "export default function Page() { return null; }");
    const intent = createTaskIntentSpec("add a todo list", constructiveClassification);

    TaskAnchorResolver.resolve({
      intentSpec: intent,
      repositoryFiles: getFiles(),
      repositoryId: "test-repo",
      workspaceRoot: root,
      evidenceStore: store,
    });

    const proof = TaskRootedAuthorizationVerifier.derive(
      store,
      intent,
      "src/security/disable-auth.ts",
      "create"
    );

    expect(proof).toBeNull();
  });

  // CASE 12: Semantic Search is Not Root
  test("CASE 12: Semantic Search is Not Root - semantic search evidence alone cannot authorize CREATE", () => {
    write("src/utils.ts", "export const x = 1;");
    const intent = createTaskIntentSpec("add a todo list", constructiveClassification);

    // Inject semantic hit
    store.observeRepository({
      kind: "FILE",
      filePath: "src/utils.ts",
      provenance: "SEMANTIC_SEARCH",
    });

    const proof = TaskRootedAuthorizationVerifier.derive(
      store,
      intent,
      "components/TodoList.tsx",
      "create"
    );

    expect(proof).toBeNull();
  });

  // CASE 13: Stale Revision
  test("CASE 13: Stale Revision - reject proof evaluated against mismatched revision", () => {
    write("app/page.tsx", "export default function Page() { return null; }");
    const intent = createTaskIntentSpec("add a todo list", constructiveClassification);

    TaskAnchorResolver.resolve({
      intentSpec: intent,
      repositoryFiles: getFiles(),
      repositoryId: "test-repo",
      workspaceRoot: root,
      evidenceStore: store,
    });

    const proof = TaskRootedAuthorizationVerifier.derive(
      store,
      intent,
      "components/TodoList.tsx",
      "create"
    );
    expect(proof).not.toBeNull();

    // Mutate repository to advance revision
    write("app/page.tsx", "export default function Page() { return <div>Updated</div>; }");

    const verified = TaskRootedAuthorizationVerifier.verify(store, intent, proof!);
    expect(verified).toBe(false);
  });

  // CASE 14: Action Mismatch
  test("CASE 14: Action Mismatch - valid CREATE proof cannot authorize MODIFY or DELETE", () => {
    write("app/page.tsx", "export default function Page() { return null; }");
    const intent = createTaskIntentSpec("add a todo list", constructiveClassification);

    TaskAnchorResolver.resolve({
      intentSpec: intent,
      repositoryFiles: getFiles(),
      repositoryId: "test-repo",
      workspaceRoot: root,
      evidenceStore: store,
    });

    const validCreateProof = TaskRootedAuthorizationVerifier.derive(
      store,
      intent,
      "components/TodoList.tsx",
      "create"
    );
    expect(validCreateProof).not.toBeNull();

    // Try verifying CREATE proof as MODIFY
    const modifyAttempt = { ...validCreateProof!, action: "modify" as const };
    expect(TaskRootedAuthorizationVerifier.verify(store, intent, modifyAttempt)).toBe(false);

    // Try verifying CREATE proof as DELETE
    const deleteAttempt = { ...validCreateProof!, action: "delete" as const };
    expect(TaskRootedAuthorizationVerifier.verify(store, intent, deleteAttempt)).toBe(false);
  });

  // CASE 15: Model File Explosion
  test("CASE 15: Model File Explosion - policy maxFiles and scope checks enforce limits", () => {
    write("app/page.tsx", "export default function Page() { return null; }");
    const intent = createTaskIntentSpec("add a todo list", constructiveClassification);

    const restrictivePolicy: PolicyContract = { ...defaultPolicy, maxFiles: 2 };
    const candidates = [
      "components/Todo1.tsx",
      "components/Todo2.tsx",
      "components/Todo3.tsx",
      "components/Todo4.tsx",
    ];

    const acquired = DeterministicRelationEvidenceAcquirer.acquire({
      candidatePaths: candidates,
      intentSpec: intent,
      evidenceStore: store,
      repositoryId: "test-repo",
      workspaceRoot: root,
      existingFiles: getFiles(),
    });

    const plannedChanges = bindBackendManifestEvidence({
      files: candidates.map((c) => ({ path: c, action: "create" as const, description: "cand", dependencies: [] })),
      obligations: [],
      acquiredEvidence: acquired,
      evidenceStore: store,
    });

    const result = EvidenceBoundWriteSetResolver.resolve({
      policy: restrictivePolicy,
      intentSpec: intent,
      proposedChanges: plannedChanges,
      evidenceStore: store,
      existingFiles: getFiles(),
      targetRepositoryId: "test-repo",
      workspaceRoot: root,
    });

    expect(result.approvedPaths.length).toBeLessThanOrEqual(2);
    expect(result.rejectedPaths.some((r) => r.reason.includes("Max allowed files exceeded"))).toBe(true);
  });

  // CASE 16: Existing Explicit Path CREATE Still Works
  test("CASE 16: Existing Explicit Path CREATE Still Works when user provides path explicitly", () => {
    write("src/App.tsx", "export default function App() { return null; }");
    const intent = createTaskIntentSpec("create a new file at src/components/NewFeature.tsx", {
      ...constructiveClassification,
      targetPath: "src/components/NewFeature.tsx",
    }, ["src/components/NewFeature.tsx"]);

    const proof = TaskRootedAuthorizationVerifier.derive(
      store,
      intent,
      "src/components/NewFeature.tsx",
      "create"
    );

    expect(proof).not.toBeNull();
    expect(proof?.action).toBe("create");
    expect(proof?.candidatePath).toBe("src/components/NewFeature.tsx");
  });

  // PRODUCTION-SHAPED INTEGRATION TEST
  test("PRODUCTION-SHAPED INTEGRATION TEST: Full compound workflow Stage A (delete) followed by Stage B (create)", async () => {
    // Setup realistic frontend repository topology
    write("app/page.tsx", "import { LegacyBanner } from '../components/LegacyBanner';\nexport default function Page() { return <LegacyBanner />; }");
    write("components/LegacyBanner.tsx", "export function LegacyBanner() { return <div>Legacy</div>; }");
    write("package.json", JSON.stringify({ name: "my-app", dependencies: { react: "^18.2.0", next: "^14.0.0" } }));

    // Stage A: Delete LegacyBanner
    const stageAIntent = createTaskIntentSpec("remove the legacy banner", {
      taskType: "DELETE_FILE",
      intent: "DELETE_FILE",
      risk: "MEDIUM",
      estimatedComplexity: "SMALL",
      confidence: 1,
      requiresClarification: false,
      reasoning: "Delete legacy banner",
    });

    const stageAResolution = DestructiveSafetyEvaluator.evaluate(
      "remove the legacy banner",
      getFiles(),
      { taskType: "DELETE_FILE", localPath: root }
    );

    expect(stageAResolution.isDestructive).toBe(true);
    expect(stageAResolution.requiresClarification).toBe(false);
    expect(stageAResolution.groundedTargets).toContain("components/LegacyBanner.tsx");

    // Simulate Stage A execution: file deletion & verification
    fs.unlinkSync(path.join(root, "components/LegacyBanner.tsx"));
    write("app/page.tsx", "export default function Page() { return <div>Cleaned</div>; }");

    const planAfterStageA: TaskExecutionPlan = {
      id: "plan-compound",
      goal: "remove the legacy banner and add modern widget",
      currentStageIndex: 1,
      status: "RUNNING",
      priorVerifiedTargets: [
        { path: "components/LegacyBanner.tsx", action: "delete" },
        { path: "app/page.tsx", action: "modify" },
      ],
      stages: [
        {
          id: "stage-1",
          name: "remove the legacy banner",
          intent: stageAIntent,
          dependsOn: [],
          status: "VERIFIED",
        },
        {
          id: "stage-2",
          name: "add modern widget",
          intent: createTaskIntentSpec("add modern widget", constructiveClassification),
          dependsOn: ["stage-1"],
          status: "PENDING",
        },
      ],
    };

    // Stage B execution against post-Stage-A worktree
    const planningStageB = await AgentPlanner.plan({
      request: {
        message: "remove the legacy banner and add modern widget",
        context: { taskExecutionPlan: planAfterStageA },
      } as any,
      projectContext: { project: { name: "my-app" } } as any,
      canonicalExistingFiles: getFiles(),
    });

    expect(planningStageB.status).toBe("READY");
    // CRITICAL: Does NOT trigger clarification asking for deleted LegacyFeature
    expect(planningStageB.intentResult.requiresClarification).toBe(false);
    expect(planningStageB.activeStage?.id).toBe("stage-2");

    // Stage B evidence acquisition & authorization
    const stageBStore = new RepositoryEvidenceStore("test-repo", root);
    stageBStore.isAuthorityEligible = productionIsAuthorityEligible.bind(stageBStore);

    const acquiredB = DeterministicRelationEvidenceAcquirer.acquire({
      candidatePaths: ["components/ModernWidget.tsx", "app/page.tsx"],
      intentSpec: planningStageB.activeStage!.intent,
      evidenceStore: stageBStore,
      repositoryId: "test-repo",
      workspaceRoot: root,
      existingFiles: getFiles(),
    });

    const plannedChangesB = bindBackendManifestEvidence({
      files: [
        { path: "components/ModernWidget.tsx", action: "create", description: "Create modern widget", dependencies: [] },
        { path: "app/page.tsx", action: "modify", description: "Integrate modern widget", dependencies: [] },
      ],
      obligations: [],
      acquiredEvidence: acquiredB,
      evidenceStore: stageBStore,
    });

    const writeSetResult = EvidenceBoundWriteSetResolver.resolve({
      policy: defaultPolicy,
      intentSpec: planningStageB.activeStage!.intent,
      proposedChanges: plannedChangesB,
      evidenceStore: stageBStore,
      existingFiles: getFiles(),
      targetRepositoryId: "test-repo",
      workspaceRoot: root,
    });

    expect(writeSetResult.approvedPaths).toContain("components/ModernWidget.tsx");
    expect(writeSetResult.approvedPaths).toContain("app/page.tsx");
    expect(writeSetResult.rejectedPaths).toHaveLength(0);
    expect(writeSetResult.evidenceAuthorization).toBeDefined();
  });

  // CASE A — UNRELATED SAFE COMPONENT
  test("CASE A: Unrelated safe component under components/ is rejected for constructive CREATE", () => {
    write("app/page.tsx", "export default function Page() { return <div>App</div>; }");
    const intentSpec = createTaskIntentSpec("add a notifications panel", constructiveClassification);
    const proof = TaskRootedAuthorizationVerifier.derive(store, intentSpec, "components/UnrelatedAdminPanel.tsx", "create");
    expect(proof).toBeNull();
  });

  // CASE B — UNRELATED FEATURE DIRECTORY
  test("CASE B: Unrelated feature directory (e.g. features/payments/DisableFraud.ts) is rejected", () => {
    write("app/page.tsx", "export default function Page() { return <div>App</div>; }");
    const intentSpec = createTaskIntentSpec("add a task list", constructiveClassification);
    const proof = TaskRootedAuthorizationVerifier.derive(store, intentSpec, "features/payments/DisableFraud.ts", "create");
    expect(proof).toBeNull();
  });

  // CASE C — AUTH-LIKE COMPONENT UNDER SAFE DIRECTORY
  test("CASE C: Auth-like component under safe directory (components/AuthBypass.tsx) is rejected", () => {
    write("app/page.tsx", "export default function Page() { return <div>App</div>; }");
    const intentSpec = createTaskIntentSpec("add a task list", constructiveClassification);
    const proof = TaskRootedAuthorizationVerifier.derive(store, intentSpec, "components/AuthBypass.tsx", "create");
    expect(proof).toBeNull();
  });

  // CASE D — TASK-RELATED CREATE
  test("CASE D: Task-related CREATE (components/NotificationPanel.tsx) with verified entry point succeeds", () => {
    write("app/page.tsx", "export default function Page() { return <div>App</div>; }");
    const intentSpec = createTaskIntentSpec("add a notifications panel", constructiveClassification);
    const proof = TaskRootedAuthorizationVerifier.derive(store, intentSpec, "components/NotificationPanel.tsx", "create");
    expect(proof).not.toBeNull();
    expect(proof?.action).toBe("create");
    expect(proof?.candidatePath).toBe("components/NotificationPanel.tsx");
  });

  // CASE E — PROSPECTIVE RECEIPT ALONE
  test("CASE E: Prospective absence receipt alone cannot satisfy EvidenceBoundWriteSetResolver without task-root authority", () => {
    write("app/page.tsx", "export default function Page() { return <div>App</div>; }");
    const intentSpec = createTaskIntentSpec("add a notifications panel", constructiveClassification);
    const receipt = RepositoryObservationTools.observeProspectiveFile(store.getRepositoryId(), root, "components/NotificationPanel.tsx")!;
    const prospectiveEvidence = store.recordObservation(receipt)!;

    const result = EvidenceBoundWriteSetResolver.resolve({
      policy: defaultPolicy,
      intentSpec,
      proposedChanges: [
        {
          path: "components/NotificationPanel.tsx",
          action: "create",
          reason: "Create panel",
          evidenceIds: [prospectiveEvidence.id],
          dependencies: [],
        },
      ],
      evidenceStore: store,
      existingFiles: getFiles(),
      targetRepositoryId: "test-repo",
      workspaceRoot: root,
    });

    expect(result.approvedPaths).not.toContain("components/NotificationPanel.tsx");
    expect(result.rejectedPaths).toContainEqual(
      expect.objectContaining({
        path: "components/NotificationPanel.tsx",
        reason: expect.stringMatching(/PROSPECTIVE_EVIDENCE_ALONE_INSUFFICIENT|NO_TASK_OR_STRUCTURAL_RELATION/),
      })
    );
  });

  // CASE F — PROSPECTIVE + TASK ROOT
  test("CASE F: Prospective absence receipt combined with authentic task root authorizes CREATE through normal chain", () => {
    write("app/page.tsx", "export default function Page() { return <div>App</div>; }");
    const intentSpec = createTaskIntentSpec("add a notifications panel", constructiveClassification);

    const acquired = DeterministicRelationEvidenceAcquirer.acquire({
      candidatePaths: ["components/NotificationPanel.tsx", "app/page.tsx"],
      intentSpec,
      evidenceStore: store,
      repositoryId: "test-repo",
      workspaceRoot: root,
      existingFiles: getFiles(),
    });

    const plannedChanges = bindBackendManifestEvidence({
      files: [
        { path: "components/NotificationPanel.tsx", action: "create", description: "Create panel", dependencies: [] },
        { path: "app/page.tsx", action: "modify", description: "Integrate panel", dependencies: [] },
      ],
      obligations: [],
      acquiredEvidence: acquired,
      evidenceStore: store,
    });

    const result = EvidenceBoundWriteSetResolver.resolve({
      policy: defaultPolicy,
      intentSpec,
      proposedChanges: plannedChanges,
      evidenceStore: store,
      existingFiles: getFiles(),
      targetRepositoryId: "test-repo",
      workspaceRoot: root,
    });

    expect(result.approvedPaths).toContain("components/NotificationPanel.tsx");
    expect(result.approvedPaths).toContain("app/page.tsx");
    expect(result.rejectedPaths).toHaveLength(0);
  });

  // CASE G — FUZZY PRIOR TARGET
  test("CASE G: Fuzzy prior target AuthSettings.tsx does not satisfy remove Auth", () => {
    const resolution = DestructiveTargetResolver.resolve(
      "remove Auth",
      ["app/page.tsx"],
      {
        isDestructive: true,
        priorVerifiedTargets: [{ path: "components/AuthSettings.tsx", action: "delete" }],
      }
    );

    // Must NOT be considered satisfied / RESOLVED
    expect(resolution.status).not.toBe("RESOLVED");
    expect(resolution.requiresClarification).toBe(true);
  });

  // CASE H — EXACT PRIOR TARGET
  test("CASE H: Exact canonical prior target suppresses re-clarification with grounded target identity", () => {
    const resolution = DestructiveTargetResolver.resolve(
      "remove Calculator",
      ["app/page.tsx"],
      {
        isDestructive: true,
        priorVerifiedTargets: [{ path: "components/calculator/Calculator.tsx", action: "delete" }],
      }
    );

    expect(resolution.status).toBe("RESOLVED");
    expect(resolution.requiresClarification).toBe(false);
    expect(resolution.candidatePaths).toEqual(["components/calculator/Calculator.tsx"]);
  });

  // CASE I — EMPTY RESOLVED FALLBACK
  test("CASE I: No live target and no exact prior identity fails closed to NOT_FOUND, never empty RESOLVED", () => {
    const resolution = DestructiveTargetResolver.resolve(
      "delete completelyNonexistentWidget",
      ["app/page.tsx"],
      {
        isDestructive: true,
        priorVerifiedTargets: [{ path: "components/UnrelatedOldFile.tsx", action: "modify" }],
      }
    );

    expect(resolution.status).toBe("NOT_FOUND");
    expect(resolution.requiresClarification).toBe(true);
    expect(resolution.candidatePaths).toEqual([]);
  });

  // CASE J — BARE NO
  test("CASE J: Bare 'no' in clarification answer does not cancel an unrelated or constructive stage", async () => {
    const plan: TaskExecutionPlan = {
      id: "plan-j",
      goal: "add notification panel",
      currentStageIndex: 0,
      status: "PENDING",
      stages: [
        {
          id: "stage-1",
          name: "add notification panel",
          intent: createTaskIntentSpec("add notification panel", constructiveClassification),
          dependsOn: [],
          status: "PENDING",
        },
      ],
    };

    const updated = await TaskExecutionPlanManager.reorderPlanWithClarification(
      plan,
      "no",
      "Do you prefer standard or compact view?"
    );

    expect(updated.stages[0].status).toBe("PENDING");
  });

  // CASE K — EXPLICIT STAGE CANCELLATION
  test("CASE K: Explicit cancellation cancels exact destructive stage and preserves constructive sibling", async () => {
    const plan: TaskExecutionPlan = {
      id: "plan-k",
      goal: "delete legacy banner and add new widget",
      currentStageIndex: 0,
      status: "PENDING",
      stages: [
        {
          id: "stage-1",
          name: "delete legacy banner",
          intent: createTaskIntentSpec("delete legacy banner", {
            taskType: "DELETE_FILE",
            intent: "DELETE_FILE",
            confidence: 1,
            risk: "HIGH",
            estimatedComplexity: "SMALL",
            requiresClarification: false,
            reasoning: "Delete banner",
          }),
          dependsOn: [],
          status: "PENDING",
        },
        {
          id: "stage-2",
          name: "add new widget",
          intent: createTaskIntentSpec("add new widget", constructiveClassification),
          dependsOn: ["stage-1"],
          status: "PENDING",
        },
      ],
    };

    const updated = await TaskExecutionPlanManager.reorderPlanWithClarification(
      plan,
      "cancel deletion",
      "Multiple candidates found. Which legacy banner file to delete?"
    );

    expect(updated.stages[0].status).toBe("CANCELLED");
    expect(updated.stages[1].status).toBe("PENDING");
    expect(TaskExecutionPlanManager.isStageEligible(updated, "stage-2")).toBe(true);
    expect(updated.currentStageIndex).toBe(1);
  });

  // CASE L — NEGATED CANCELLATION
  test("CASE L: Negated cancellation 'do not cancel deletion' does not cancel the stage", async () => {
    const plan: TaskExecutionPlan = {
      id: "plan-l",
      goal: "delete legacy banner",
      currentStageIndex: 0,
      status: "PENDING",
      stages: [
        {
          id: "stage-1",
          name: "delete legacy banner",
          intent: createTaskIntentSpec("delete legacy banner", {
            taskType: "DELETE_FILE",
            intent: "DELETE_FILE",
            confidence: 1,
            risk: "HIGH",
            estimatedComplexity: "SMALL",
            requiresClarification: false,
            reasoning: "Delete banner",
          }),
          dependsOn: [],
          status: "PENDING",
        },
      ],
    };

    const updated = await TaskExecutionPlanManager.reorderPlanWithClarification(
      plan,
      "do not cancel deletion",
      "Specify which legacy banner file to delete."
    );

    expect(updated.stages[0].status).toBe("PENDING");
  });

  // CASE M — ADVANCE PLAN
  test("CASE M: advancePlanStage never selects a CANCELLED stage and advances to next eligible stage", () => {
    const plan: TaskExecutionPlan = {
      id: "plan-m",
      goal: "compound task",
      currentStageIndex: 0,
      status: "RUNNING",
      stages: [
        {
          id: "stage-1",
          name: "cancelled delete",
          intent: createTaskIntentSpec("cancelled delete", { taskType: "DELETE_FILE", intent: "DELETE_FILE", confidence: 1, risk: "HIGH", estimatedComplexity: "SMALL", requiresClarification: false, reasoning: "" }),
          dependsOn: [],
          status: "CANCELLED",
        },
        {
          id: "stage-2",
          name: "runnable independent stage",
          intent: createTaskIntentSpec("add notification panel", constructiveClassification),
          dependsOn: [],
          status: "PENDING",
        },
      ],
    };

    const advanced = TaskExecutionPlanManager.advancePlanStage(plan);
    expect(advanced.nextStage).not.toBeNull();
    expect(advanced.nextStage?.id).toBe("stage-2");
    expect(advanced.plan.currentStageIndex).toBe(1);
    expect(advanced.plan.stages[0].status).toBe("CANCELLED");
    expect(advanced.plan.status).toBe("RUNNING");
  });

  // CASE N — CANCELLED DEPENDENCY
  test("CASE N: If Stage 2 requires Stage 1 and Stage 1 was CANCELLED, Stage 2 is blocked from running", () => {
    const plan: TaskExecutionPlan = {
      id: "plan-n",
      goal: "dependent workflow",
      currentStageIndex: 0,
      status: "RUNNING",
      stages: [
        {
          id: "stage-1",
          name: "prerequisite stage",
          intent: createTaskIntentSpec("prerequisite stage", { taskType: "DELETE_FILE", intent: "DELETE_FILE", confidence: 1, risk: "HIGH", estimatedComplexity: "SMALL", requiresClarification: false, reasoning: "" }),
          dependsOn: [],
          status: "CANCELLED",
        },
        {
          id: "stage-2",
          name: "dependent stage",
          intent: createTaskIntentSpec("dependent stage", constructiveClassification),
          dependsOn: ["stage-1"],
          status: "PENDING",
        },
      ],
    };

    // Stage 2 must NOT be eligible because Stage 1 is CANCELLED (not VERIFIED)
    expect(TaskExecutionPlanManager.isStageEligible(plan, "stage-2")).toBe(false);
    expect(TaskExecutionPlanManager.getNextEligibleStage(plan)).toBeNull();

    const advanced = TaskExecutionPlanManager.advancePlanStage(plan);
    expect(advanced.nextStage).toBeNull();
    // Plan must not falsely succeed when dependent stage is blocked
    expect(advanced.plan.status).toBe("FAILED");
  });

  // CASE O — COMPLETION
  test("CASE O: Completion handles VERIFIED + CANCELLED as COMPLETED and CANCELLED + blocked as FAILED without infinite loop", () => {
    // 1. VERIFIED + CANCELLED
    const planCompleted: TaskExecutionPlan = {
      id: "plan-o1",
      goal: "partial success",
      currentStageIndex: 1,
      status: "RUNNING",
      stages: [
        {
          id: "stage-1",
          name: "verified stage",
          intent: createTaskIntentSpec("verified stage", constructiveClassification),
          dependsOn: [],
          status: "VERIFIED",
        },
        {
          id: "stage-2",
          name: "cancelled stage",
          intent: createTaskIntentSpec("cancelled stage", { taskType: "DELETE_FILE", intent: "DELETE_FILE", confidence: 1, risk: "HIGH", estimatedComplexity: "SMALL", requiresClarification: false, reasoning: "" }),
          dependsOn: [],
          status: "CANCELLED",
        },
      ],
    };

    const advancedCompleted = TaskExecutionPlanManager.advancePlanStage(planCompleted);
    expect(advancedCompleted.nextStage).toBeNull();
    expect(advancedCompleted.plan.status).toBe("COMPLETED");

    // 2. CANCELLED + blocked dependent stage
    const planBlocked: TaskExecutionPlan = {
      id: "plan-o2",
      goal: "blocked failure",
      currentStageIndex: 0,
      status: "RUNNING",
      stages: [
        {
          id: "stage-1",
          name: "cancelled prerequisite",
          intent: createTaskIntentSpec("cancelled prerequisite", { taskType: "DELETE_FILE", intent: "DELETE_FILE", confidence: 1, risk: "HIGH", estimatedComplexity: "SMALL", requiresClarification: false, reasoning: "" }),
          dependsOn: [],
          status: "CANCELLED",
        },
        {
          id: "stage-2",
          name: "blocked dependent",
          intent: createTaskIntentSpec("blocked dependent", constructiveClassification),
          dependsOn: ["stage-1"],
          status: "PENDING",
        },
      ],
    };

    const advancedBlocked = TaskExecutionPlanManager.advancePlanStage(planBlocked);
    expect(advancedBlocked.nextStage).toBeNull();
    expect(advancedBlocked.plan.status).toBe("FAILED");
  });

  // CASE P — FULL CREATE AUTHORITY PATH THROUGH CAPABILITYGUARD
  test("CASE P: Full production CREATE authority chain through EvidenceBoundWriteSetResolver and CapabilityGuard", () => {
    write("app/page.tsx", "export default function Page() { return <div>Home</div>; }");
    const intentSpec = createTaskIntentSpec("add a notifications panel", constructiveClassification);

    // 1. Task relation + anchor discovery + prospective observation
    const acquired = DeterministicRelationEvidenceAcquirer.acquire({
      candidatePaths: ["components/NotificationPanel.tsx", "app/page.tsx"],
      intentSpec,
      evidenceStore: store,
      repositoryId: "test-repo",
      workspaceRoot: root,
      existingFiles: getFiles(),
    });

    // 2. Manifest evidence binding
    const plannedChanges = bindBackendManifestEvidence({
      files: [
        { path: "components/NotificationPanel.tsx", action: "create", description: "Create panel", dependencies: [] },
        { path: "app/page.tsx", action: "modify", description: "Integrate panel", dependencies: [] },
      ],
      obligations: [],
      acquiredEvidence: acquired,
      evidenceStore: store,
    });

    // 3. EvidenceBoundWriteSetResolver
    const writeSetResult = EvidenceBoundWriteSetResolver.resolve({
      policy: defaultPolicy,
      intentSpec,
      proposedChanges: plannedChanges,
      evidenceStore: store,
      existingFiles: getFiles(),
      targetRepositoryId: "test-repo",
      workspaceRoot: root,
      stageId: "stage-create",
      runId: "run-create",
    });

    expect(writeSetResult.approvedPaths).toContain("components/NotificationPanel.tsx");
    expect(writeSetResult.approvedPaths).toContain("app/page.tsx");
    expect(writeSetResult.evidenceAuthorization).toBeDefined();

    // 4. CapabilityGuard validation and authorization check
    const baseScope = AuthorizedCapabilityScope.fromIsolatedWorktree({
      workspaceRoot: root,
      authorityId: "base-auth",
      repositoryId: "test-repo",
      runId: "run-create",
      grants: [],
    })!;

    const executionScope = baseScope.deriveExecutionScope(
      writeSetResult.evidenceAuthorization,
      { stageId: "stage-create" }
    )!;

    expect(executionScope).not.toBeNull();

    const guard = CapabilityGuard.create({
      workspaceRoot: root,
      scopeId: "stage-create",
      authorizedScope: executionScope,
    });

    // Valid CREATE is allowed
    expect(
      guard.authorize({
        path: "components/NotificationPanel.tsx",
        action: "FILE_CREATE",
        scopeId: "stage-create",
      }).allowed
    ).toBe(true);

    // Valid MODIFY is allowed
    expect(
      guard.authorize({
        path: "app/page.tsx",
        action: "FILE_MODIFY",
        scopeId: "stage-create",
      }).allowed
    ).toBe(true);

    // Unrelated path is denied by CapabilityGuard
    expect(
      guard.authorize({
        path: "components/UnrelatedAdminPanel.tsx",
        action: "FILE_CREATE",
        scopeId: "stage-create",
      }).allowed
    ).toBe(false);
  });
});
