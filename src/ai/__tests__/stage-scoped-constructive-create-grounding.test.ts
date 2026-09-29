import fs from "fs";
import os from "os";
import path from "path";
import { RepositoryEvidenceStore } from "../repository/RepositoryEvidenceStore";
import { TaskRootedAuthorizationVerifier } from "../contracts/TaskRootedAuthorizationProof";
import { TaskAnchorResolver } from "../repository/TaskAnchorResolver";
import { PolicyContract } from "../contracts/PolicyContract";
import { createTaskIntentSpec, TaskIntentSpec } from "../shared/TaskIntentSpec";
import { TaskClassificationResult } from "../classification/TaskTypes";
import { EvidenceBoundWriteSetResolver } from "../contracts/EvidenceBoundWriteSetResolver";
import { DeterministicRelationEvidenceAcquirer } from "../contracts/DeterministicRelationEvidenceAcquirer";
import { AgentPlanner, bindBackendManifestEvidence } from "../orchestration/AgentPlanner";
import { TaskExecutionPlanManager } from "../planning/TaskExecutionPlanManager";
import { ManifestGenerator } from "../../services/manifest-generator";
import { ManifestValidator } from "../../services/manifest-validator";
import { trustedUserRequest, trustedStageAuthorizationContext, trustedStageAuthorizationClause, bindUserRequest, bindStageAuthorizationContext, bindStageAuthorizationClause } from "../repository/TrustedTaskContext";
import { UserClauseExtractor } from "../contracts/UserClauseAuthority";
import { productionIsAuthorityEligible } from "./helpers/capability-test-harness";
import { FileManifest } from "../../types";

describe("Stage-Scoped Constructive CREATE Grounding Regression & Authority Hardening", () => {
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
    environment: "REACT_TS",
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
    root = fs.mkdtempSync(path.join(os.tmpdir(), "stage-scoped-create-"));
    store = new RepositoryEvidenceStore("test-repo", root);
    store.isAuthorityEligible = productionIsAuthorityEligible.bind(store);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (fs.existsSync(root)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // PART G / F: REAL PIPELINE REGRESSION TEST (LIVE CASE)
  // =========================================================================
  test("PART G & F: Real pipeline regression for compound 'remove calculator and add todo list' Stage 2", async () => {
    // 1. Setup real repository files: app/page.tsx exists as entry point anchor
    write(
      "app/page.tsx",
      `import React from "react";\nexport default function Page() { return <div>Home</div>; }`
    );
    write("package.json", JSON.stringify({ name: "test-app", dependencies: { react: "^18.0.0" } }));

    // 2. Compound request and classification producing 2 stages
    const compoundMessage = "remove the calculator and add a todo list";
    const classification: TaskClassificationResult = {
      taskType: "NEW_FEATURE",
      risk: "MEDIUM",
      estimatedComplexity: "MEDIUM",
      intent: "NEW_FEATURE",
      confidence: 1,
      requiresClarification: false,
      reasoning: "Compound request: Stage 1 removes calculator, Stage 2 creates todo list",
      stages: [
        {
          id: "stage-1",
          name: "remove calculator",
          taskType: "DELETE_FILE",
          goal: "Remove the calculator",
          targetPath: "components/Calculator.tsx",
          dependsOn: [],
        },
        {
          id: "stage-2",
          name: "add todo list",
          taskType: "NEW_FEATURE",
          goal: "Create a new todo list feature in the project.",
          dependsOn: ["stage-1"],
        },
      ],
    };

    // 3. Create real TaskExecutionPlan
    const plan = TaskExecutionPlanManager.createTaskExecutionPlan(compoundMessage, classification);
    expect(plan.stages).toHaveLength(2);

    const stage2 = plan.stages[1];
    expect(stage2.id).toBe("stage-2");
    expect(stage2.intent.taskType).toBe("NEW_FEATURE");
    expect(stage2.intent.goal).toBe("Create a new todo list feature in the project.");

    // Provenance check: Original compound request is preserved for audit
    expect(trustedUserRequest(stage2.intent)).toBe(compoundMessage);
    // Stage-scoped context is bound to active user clause
    expect(trustedStageAuthorizationContext(stage2.intent)).toBe("add a todo list");
    expect(stage2.intent.stageAuthorizationContext).toBe("add a todo list");

    // 4. Controlled seam: ManifestGenerator returns proposed manifest without calling external LLM
    const plannedManifest: FileManifest = {
      manifestVersion: "1.0.0",
      totalFiles: 2,
      files: [
        {
          path: "app/components/TodoList.tsx",
          action: "create",
          description: "Create new TodoList component",
          dependencies: [],
        },
        {
          path: "app/page.tsx",
          action: "modify",
          description: "Integrate TodoList component into page",
          dependencies: ["./components/TodoList"],
        },
      ],
    };

    jest.spyOn(ManifestGenerator.prototype, "generateManifest").mockResolvedValue(plannedManifest);

    const repoFiles = getFiles();
    const stage2Policy: PolicyContract = {
      ...defaultPolicy,
      goal: stage2.intent.goal,
    };
    const stage2Contract = {
      ...stage2Policy,
      targetPaths: [],
      contextScope: [],
      searchScope: [],
      targetProvenance: {},
    };

    // 5. Execute AgentPlanner.planManifest through the real pipeline orchestration
    // Notice: NO prospective evidence was manually primed; NO acquisition was manually pre-invoked
    const manifestResult = await AgentPlanner.planManifest({
      projectId: "test-repo",
      sessionId: "test-session",
      request: { message: compoundMessage } as any,
      projectContext: { project: { name: "test" } } as any,
      canonicalExistingFiles: repoFiles,
      rawSnapshotFiles: [
        { path: "app/page.tsx", content: fs.readFileSync(path.join(root, "app/page.tsx"), "utf8") },
        { path: "package.json", content: fs.readFileSync(path.join(root, "package.json"), "utf8") },
      ],
      pipelineSnapshotFiles: [] as any,
      optimizedContext: { fileContext: {}, skeletonContext: {}, tokenEstimate: 0 } as any,
      monorepo: { isMonorepo: false, packages: [] } as any,
      effectiveLocalPath: root,
      diagnosticTargetPaths: [],
      baselineDiagnosticsList: [],
      activeStage: stage2,
      taskIntentSpec: stage2.intent,
      intentResult: classification,
      executionContract: stage2Contract as any,
      evidenceStore: store,
      effectiveGoal: stage2.intent.goal,
      policyContract: stage2Policy,
      knowledgeGraph: { nodes: [], edges: [] } as any,
      clarificationData: null,
      finalConfidence: 0.95,
    });

    // 6. Verify full pipeline outcome
    const planRes = manifestResult as any;
    expect(planRes.errorCode).toBeUndefined();
    expect(planRes.lifecycleStage).not.toBe("ManifestValidationFailed");

    // Both files must be retained in the validated coherent manifest
    const manifest = planRes.approvedManifest as FileManifest;
    expect(manifest).toBeDefined();
    expect(manifest.files).toHaveLength(2);

    const createEntry = manifest.files.find((f) => f.path === "app/components/TodoList.tsx");
    const modifyEntry = manifest.files.find((f) => f.path === "app/page.tsx");

    expect(createEntry).toBeDefined();
    expect(createEntry?.action).toBe("create");
    expect(createEntry?.evidenceIds?.length).toBeGreaterThan(0);

    expect(modifyEntry).toBeDefined();
    expect(modifyEntry?.action).toBe("modify");
    expect(modifyEntry?.evidenceIds?.length).toBeGreaterThan(0);

    // Verify ManifestValidator passes cleanly with import resolution
    const validator = new ManifestValidator(planRes.executionContract!, {
      existingFiles: repoFiles,
      installedPackages: ["react"],
      packageVersions: { react: "^18.0.0" },
      monorepo: { isMonorepo: false, rootPackageJson: null, packages: [] } as any,
      configurationFiles: [],
    });
    const valResult = validator.validate(manifest);
    expect(valResult.valid).toBe(true);
    expect(valResult.errors).toHaveLength(0);
  });

  // =========================================================================
  // PART J: STAGE ISOLATION TEST
  // =========================================================================
  test("PART J: Stage 1 'calculator' does not contaminate Stage 2 CREATE domain tokens", () => {
    const compoundMessage = "remove calculator and add todo list";
    const classification: TaskClassificationResult = {
      taskType: "NEW_FEATURE",
      risk: "MEDIUM",
      estimatedComplexity: "MEDIUM",
      intent: "NEW_FEATURE",
      confidence: 1,
      requiresClarification: false,
      reasoning: "Compound request",
      stages: [
        {
          id: "stage-1",
          name: "remove calculator",
          taskType: "DELETE_FILE",
          goal: "Remove calculator",
          targetPath: "components/Calculator.tsx",
          dependsOn: [],
        },
        {
          id: "stage-2",
          name: "add todo list",
          taskType: "NEW_FEATURE",
          goal: "Create a new todo list feature in the project.",
          dependsOn: ["stage-1"],
        },
      ],
    };

    const plan = TaskExecutionPlanManager.createTaskExecutionPlan(compoundMessage, classification);
    const stage2Intent = plan.stages[1].intent;

    // Derived canonical stage entity for Stage 2
    const derived = TaskRootedAuthorizationVerifier.deriveCanonicalStageEntity(stage2Intent);

    // Required: Stage 1 'calculator' must NOT appear in Stage 2 CREATE entity tokens or domain
    expect(derived.entityTokens).not.toContain("calculator");
    expect(derived.allSubstantiveTokens).not.toContain("calculator");
    expect(derived.entityTokens).toContain("todo");
    expect(derived.entityTokens).toContain("list");

    // Provenance check: original compound message is still available for audit
    expect(trustedUserRequest(stage2Intent)).toBe(compoundMessage);
    expect(trustedStageAuthorizationContext(stage2Intent)).toBe("add todo list");
  });

  // =========================================================================
  // PART H: ADVERSARIAL TESTS
  // =========================================================================
  describe("PART H: Adversarial candidate rejection for task 'add a todo list'", () => {
    let intent: TaskIntentSpec;

    beforeEach(() => {
      write("app/page.tsx", `export default function Page() { return <div>Home</div>; }`);
      intent = createTaskIntentSpec("add a todo list", constructiveClassification);
      TaskAnchorResolver.resolve({
        intentSpec: intent,
        repositoryFiles: getFiles(),
        repositoryId: "test-repo",
        workspaceRoot: root,
        evidenceStore: store,
      });
    });

    test("Rejects WeatherWidget.tsx (foreign domain concept)", () => {
      const eligible = TaskRootedAuthorizationVerifier.isEligibleConstructiveCreateScope(
        "components/WeatherWidget.tsx",
        "app/page.tsx",
        getFiles(),
        intent
      );
      expect(eligible).toBe(false);

      const proof = TaskRootedAuthorizationVerifier.derive(store, intent, "components/WeatherWidget.tsx", "create");
      expect(proof).toBeNull();
    });

    test("Rejects AuthBypass.tsx (sensitive keyword + foreign domain)", () => {
      const eligible = TaskRootedAuthorizationVerifier.isEligibleConstructiveCreateScope(
        "components/AuthBypass.tsx",
        "app/page.tsx",
        getFiles(),
        intent
      );
      expect(eligible).toBe(false);

      const proof = TaskRootedAuthorizationVerifier.derive(store, intent, "components/AuthBypass.tsx", "create");
      expect(proof).toBeNull();
    });

    test("Rejects features/payments/DisableFraud.ts (sensitive keywords + foreign domain)", () => {
      const eligible = TaskRootedAuthorizationVerifier.isEligibleConstructiveCreateScope(
        "features/payments/DisableFraud.ts",
        "app/page.tsx",
        getFiles(),
        intent
      );
      expect(eligible).toBe(false);

      const proof = TaskRootedAuthorizationVerifier.derive(store, intent, "features/payments/DisableFraud.ts", "create");
      expect(proof).toBeNull();
    });

    test("Rejects TodoListAuthBypass.tsx (sensitive tokens fail-closed)", () => {
      const eligible = TaskRootedAuthorizationVerifier.isEligibleConstructiveCreateScope(
        "components/TodoListAuthBypass.tsx",
        "app/page.tsx",
        getFiles(),
        intent
      );
      expect(eligible).toBe(false);

      const proof = TaskRootedAuthorizationVerifier.derive(store, intent, "components/TodoListAuthBypass.tsx", "create");
      expect(proof).toBeNull();
    });

    test("Rejects ../../outside.ts (escapes repository boundary)", () => {
      const eligible = TaskRootedAuthorizationVerifier.isEligibleConstructiveCreateScope(
        "../../outside.ts",
        "app/page.tsx",
        getFiles(),
        intent
      );
      expect(eligible).toBe(false);

      const proof = TaskRootedAuthorizationVerifier.derive(store, intent, "../../outside.ts", "create");
      expect(proof).toBeNull();
    });

    test("Rejects TodoAdminDashboard.tsx (single matching token 'todo' cannot authorize foreign domain 'admin')", () => {
      const eligible = TaskRootedAuthorizationVerifier.isEligibleConstructiveCreateScope(
        "components/TodoAdminDashboard.tsx",
        "app/page.tsx",
        getFiles(),
        intent
      );
      expect(eligible).toBe(false);

      const proof = TaskRootedAuthorizationVerifier.derive(store, intent, "components/TodoAdminDashboard.tsx", "create");
      expect(proof).toBeNull();
    });
  });

  // =========================================================================
  // PART I: MULTI-WORD RELATION TESTS
  // =========================================================================
  describe("PART I: Multi-word relation tests", () => {
    beforeEach(() => {
      write("app/page.tsx", `export default function Page() { return <div>Home</div>; }`);
    });

    test("Task 'add user profile' -> components/UserProfile.tsx PASS", () => {
      const intent = createTaskIntentSpec("add user profile", constructiveClassification);
      TaskAnchorResolver.resolve({
        intentSpec: intent,
        repositoryFiles: getFiles(),
        repositoryId: "test-repo",
        workspaceRoot: root,
        evidenceStore: store,
      });

      const eligible = TaskRootedAuthorizationVerifier.isEligibleConstructiveCreateScope(
        "components/UserProfile.tsx",
        "app/page.tsx",
        getFiles(),
        intent
      );
      expect(eligible).toBe(true);

      const proof = TaskRootedAuthorizationVerifier.derive(store, intent, "components/UserProfile.tsx", "create");
      expect(proof).not.toBeNull();
      expect(proof?.action).toBe("create");
      expect(proof?.candidatePath).toBe("components/UserProfile.tsx");
    });

    test("Task 'add notification panel' -> components/NotificationPanel.tsx PASS", () => {
      const intent = createTaskIntentSpec("add notification panel", constructiveClassification);
      TaskAnchorResolver.resolve({
        intentSpec: intent,
        repositoryFiles: getFiles(),
        repositoryId: "test-repo",
        workspaceRoot: root,
        evidenceStore: store,
      });

      const eligible = TaskRootedAuthorizationVerifier.isEligibleConstructiveCreateScope(
        "components/NotificationPanel.tsx",
        "app/page.tsx",
        getFiles(),
        intent
      );
      expect(eligible).toBe(true);

      const proof = TaskRootedAuthorizationVerifier.derive(store, intent, "components/NotificationPanel.tsx", "create");
      expect(proof).not.toBeNull();
      expect(proof?.candidatePath).toBe("components/NotificationPanel.tsx");
    });

    test("Task 'create shopping cart' -> components/ShoppingCart.tsx PASS", () => {
      const intent = createTaskIntentSpec("create shopping cart", constructiveClassification);
      TaskAnchorResolver.resolve({
        intentSpec: intent,
        repositoryFiles: getFiles(),
        repositoryId: "test-repo",
        workspaceRoot: root,
        evidenceStore: store,
      });

      const eligible = TaskRootedAuthorizationVerifier.isEligibleConstructiveCreateScope(
        "components/ShoppingCart.tsx",
        "app/page.tsx",
        getFiles(),
        intent
      );
      expect(eligible).toBe(true);

      const proof = TaskRootedAuthorizationVerifier.derive(store, intent, "components/ShoppingCart.tsx", "create");
      expect(proof).not.toBeNull();
      expect(proof?.candidatePath).toBe("components/ShoppingCart.tsx");
    });

    test("Task 'add user profile' -> components/WeatherProfile.tsx REJECT (foreign token 'weather')", () => {
      const intent = createTaskIntentSpec("add user profile", constructiveClassification);
      TaskAnchorResolver.resolve({
        intentSpec: intent,
        repositoryFiles: getFiles(),
        repositoryId: "test-repo",
        workspaceRoot: root,
        evidenceStore: store,
      });

      const eligible = TaskRootedAuthorizationVerifier.isEligibleConstructiveCreateScope(
        "components/WeatherProfile.tsx",
        "app/page.tsx",
        getFiles(),
        intent
      );
      expect(eligible).toBe(false);

      const proof = TaskRootedAuthorizationVerifier.derive(store, intent, "components/WeatherProfile.tsx", "create");
      expect(proof).toBeNull();
    });

    test("Task 'add user profile' -> components/AdminUserProfile.tsx REJECT (foreign token 'admin')", () => {
      const intent = createTaskIntentSpec("add user profile", constructiveClassification);
      TaskAnchorResolver.resolve({
        intentSpec: intent,
        repositoryFiles: getFiles(),
        repositoryId: "test-repo",
        workspaceRoot: root,
        evidenceStore: store,
      });

      const eligible = TaskRootedAuthorizationVerifier.isEligibleConstructiveCreateScope(
        "components/AdminUserProfile.tsx",
        "app/page.tsx",
        getFiles(),
        intent
      );
      expect(eligible).toBe(false);

      const proof = TaskRootedAuthorizationVerifier.derive(store, intent, "components/AdminUserProfile.tsx", "create");
      expect(proof).toBeNull();
    });
  });

  // =========================================================================
  // PART K: SINGLE-STAGE BACKWARD COMPATIBILITY
  // =========================================================================
  describe("PART K: Single-stage backward compatibility", () => {
    beforeEach(() => {
      write("app/page.tsx", `export default function Page() { return <div>Home</div>; }`);
    });

    test("Single-stage 'add a todo list' -> components/TodoList.tsx PASS", () => {
      const intent = createTaskIntentSpec("add a todo list", constructiveClassification);
      TaskAnchorResolver.resolve({
        intentSpec: intent,
        repositoryFiles: getFiles(),
        repositoryId: "test-repo",
        workspaceRoot: root,
        evidenceStore: store,
      });

      const eligible = TaskRootedAuthorizationVerifier.isEligibleConstructiveCreateScope(
        "components/TodoList.tsx",
        "app/page.tsx",
        getFiles(),
        intent
      );
      expect(eligible).toBe(true);

      const proof = TaskRootedAuthorizationVerifier.derive(store, intent, "components/TodoList.tsx", "create");
      expect(proof).not.toBeNull();
      expect(proof?.candidatePath).toBe("components/TodoList.tsx");
    });

    test("Single-stage 'add notification panel' -> components/NotificationPanel.tsx PASS", () => {
      const intent = createTaskIntentSpec("add notification panel", constructiveClassification);
      TaskAnchorResolver.resolve({
        intentSpec: intent,
        repositoryFiles: getFiles(),
        repositoryId: "test-repo",
        workspaceRoot: root,
        evidenceStore: store,
      });

      const eligible = TaskRootedAuthorizationVerifier.isEligibleConstructiveCreateScope(
        "components/NotificationPanel.tsx",
        "app/page.tsx",
        getFiles(),
        intent
      );
      expect(eligible).toBe(true);

      const proof = TaskRootedAuthorizationVerifier.derive(store, intent, "components/NotificationPanel.tsx", "create");
      expect(proof).not.toBeNull();
    });

    test("Explicit CREATE path in intent is always authorized", () => {
      const intent = createTaskIntentSpec("create custom component", constructiveClassification, ["components/CustomFoo.tsx"]);
      const eligible = TaskRootedAuthorizationVerifier.isEligibleConstructiveCreateScope(
        "components/CustomFoo.tsx",
        "app/page.tsx",
        getFiles(),
        intent
      );
      expect(eligible).toBe(true);
    });
  });

  // =========================================================================
  // PART 9 — ADVERSARIAL TESTS (ORIGINAL USER AUTHORITY CEILING ENFORCEMENT)
  // =========================================================================
  describe("PART 9: Adversarial Regressions (Originating User Clause Authority Enforcement)", () => {
    beforeEach(() => {
      write("app/page.tsx", `export default function Page() { return <div>Home</div>; }`);
    });

    // CASE A — ADMIN BELONGS TO SIBLING USER CLAUSE
    test("CASE A: 'remove the admin panel and add a todo list' -> Stage 2 'create admin todo dashboard' -> AdminTodoDashboard.tsx REJECTED", () => {
      const userRequest = "remove the admin panel and add a todo list";
      const intent = createTaskIntentSpec("create admin todo dashboard", constructiveClassification);
      bindUserRequest(intent, userRequest);

      // Verify clause extraction and stage binding
      const userClauses = UserClauseExtractor.extractClauses(userRequest);
      expect(userClauses).toHaveLength(2);
      expect(userClauses[0].sourceText).toBe("remove the admin panel");
      expect(userClauses[0].entityTokens).toContain("admin");
      expect(userClauses[1].sourceText).toBe("add a todo list");
      expect(userClauses[1].entityTokens).toContain("todo");
      expect(userClauses[1].entityTokens).not.toContain("admin");

      TaskAnchorResolver.resolve({
        intentSpec: intent,
        repositoryFiles: getFiles(),
        repositoryId: "test-repo",
        workspaceRoot: root,
        evidenceStore: store,
      });

      const eligible = TaskRootedAuthorizationVerifier.isEligibleConstructiveCreateScope(
        "app/components/AdminTodoDashboard.tsx",
        "app/page.tsx",
        getFiles(),
        intent
      );
      expect(eligible).toBe(false);

      const proof = TaskRootedAuthorizationVerifier.derive(store, intent, "app/components/AdminTodoDashboard.tsx", "create");
      expect(proof).toBeNull();
    });

    // CASE B — WEATHER BELONGS TO SIBLING USER CLAUSE
    test("CASE B: 'remove the weather widget and add a todo list' -> Stage 2 'create weather todo widget' -> WeatherTodoWidget.tsx REJECTED", () => {
      const userRequest = "remove the weather widget and add a todo list";
      const intent = createTaskIntentSpec("create weather todo widget", constructiveClassification);
      bindUserRequest(intent, userRequest);

      TaskAnchorResolver.resolve({
        intentSpec: intent,
        repositoryFiles: getFiles(),
        repositoryId: "test-repo",
        workspaceRoot: root,
        evidenceStore: store,
      });

      const eligible = TaskRootedAuthorizationVerifier.isEligibleConstructiveCreateScope(
        "app/components/WeatherTodoWidget.tsx",
        "app/page.tsx",
        getFiles(),
        intent
      );
      expect(eligible).toBe(false);

      const proof = TaskRootedAuthorizationVerifier.derive(store, intent, "app/components/WeatherTodoWidget.tsx", "create");
      expect(proof).toBeNull();
    });

    // CASE C — PAYMENT BELONGS TO SIBLING USER CLAUSE
    test("CASE C: 'remove payments dashboard and add user profile' -> Stage 2 'create payment user profile' -> PaymentUserProfile.tsx REJECTED", () => {
      const userRequest = "remove payments dashboard and add user profile";
      const intent = createTaskIntentSpec("create payment user profile", constructiveClassification);
      bindUserRequest(intent, userRequest);

      TaskAnchorResolver.resolve({
        intentSpec: intent,
        repositoryFiles: getFiles(),
        repositoryId: "test-repo",
        workspaceRoot: root,
        evidenceStore: store,
      });

      const eligible = TaskRootedAuthorizationVerifier.isEligibleConstructiveCreateScope(
        "app/components/PaymentUserProfile.tsx",
        "app/page.tsx",
        getFiles(),
        intent
      );
      expect(eligible).toBe(false);

      const proof = TaskRootedAuthorizationVerifier.derive(store, intent, "app/components/PaymentUserProfile.tsx", "create");
      expect(proof).toBeNull();
    });

    // CASE D — AUTH BELONGS TO SIBLING USER CLAUSE (REJECTED BY CLAUSE AUTHORITY)
    test("CASE D: 'remove auth settings and add notification panel' -> Stage 2 'create auth notification panel' -> AuthNotificationPanel.tsx REJECTED by clause authority", () => {
      const userRequest = "remove auth settings and add notification panel";
      const intent = createTaskIntentSpec("create auth notification panel", constructiveClassification);
      bindUserRequest(intent, userRequest);

      TaskAnchorResolver.resolve({
        intentSpec: intent,
        repositoryFiles: getFiles(),
        repositoryId: "test-repo",
        workspaceRoot: root,
        evidenceStore: store,
      });

      const eligible = TaskRootedAuthorizationVerifier.isEligibleConstructiveCreateScope(
        "app/components/AuthNotificationPanel.tsx",
        "app/page.tsx",
        getFiles(),
        intent
      );
      expect(eligible).toBe(false);

      const proof = TaskRootedAuthorizationVerifier.derive(store, intent, "app/components/AuthNotificationPanel.tsx", "create");
      expect(proof).toBeNull();
    });

    // CONTROL E — VALID STAGE 2
    test("CONTROL E: 'remove admin panel and add todo list' -> Stage 2 'add todo list' -> TodoList.tsx PASS", () => {
      const userRequest = "remove admin panel and add todo list";
      const intent = createTaskIntentSpec("add todo list", constructiveClassification);
      bindUserRequest(intent, userRequest);

      TaskAnchorResolver.resolve({
        intentSpec: intent,
        repositoryFiles: getFiles(),
        repositoryId: "test-repo",
        workspaceRoot: root,
        evidenceStore: store,
      });

      const eligible = TaskRootedAuthorizationVerifier.isEligibleConstructiveCreateScope(
        "app/components/TodoList.tsx",
        "app/page.tsx",
        getFiles(),
        intent
      );
      expect(eligible).toBe(true);

      const proof = TaskRootedAuthorizationVerifier.derive(store, intent, "app/components/TodoList.tsx", "create");
      expect(proof).not.toBeNull();
      expect(proof?.candidatePath).toBe("app/components/TodoList.tsx");
    });

    // CONTROL F — VALID STAGE 2
    test("CONTROL F: 'remove weather widget and add user profile' -> Stage 2 'add user profile' -> UserProfile.tsx PASS", () => {
      const userRequest = "remove weather widget and add user profile";
      const intent = createTaskIntentSpec("add user profile", constructiveClassification);
      bindUserRequest(intent, userRequest);

      TaskAnchorResolver.resolve({
        intentSpec: intent,
        repositoryFiles: getFiles(),
        repositoryId: "test-repo",
        workspaceRoot: root,
        evidenceStore: store,
      });

      const eligible = TaskRootedAuthorizationVerifier.isEligibleConstructiveCreateScope(
        "app/components/UserProfile.tsx",
        "app/page.tsx",
        getFiles(),
        intent
      );
      expect(eligible).toBe(true);

      const proof = TaskRootedAuthorizationVerifier.derive(store, intent, "app/components/UserProfile.tsx", "create");
      expect(proof).not.toBeNull();
      expect(proof?.candidatePath).toBe("app/components/UserProfile.tsx");
    });

    // PART 10 — MODEL-INVENTED NEW DOMAIN
    test("PART 10: Model-invented new domain - user 'remove calculator and add todo list', Stage 2 'create weather widget' -> WeatherWidget.tsx REJECTED", () => {
      const userRequest = "remove calculator and add todo list";
      const intent = createTaskIntentSpec("create weather widget", constructiveClassification);
      bindUserRequest(intent, userRequest);

      TaskAnchorResolver.resolve({
        intentSpec: intent,
        repositoryFiles: getFiles(),
        repositoryId: "test-repo",
        workspaceRoot: root,
        evidenceStore: store,
      });

      const eligible = TaskRootedAuthorizationVerifier.isEligibleConstructiveCreateScope(
        "components/WeatherWidget.tsx",
        "app/page.tsx",
        getFiles(),
        intent
      );
      expect(eligible).toBe(false);

      const proof = TaskRootedAuthorizationVerifier.derive(store, intent, "components/WeatherWidget.tsx", "create");
      expect(proof).toBeNull();
    });

    // PART 16 — EXPLICIT CLAUSE-BINDING PROOF
    test("PART 16: Explicit clause-binding proof: 'remove admin panel AND add todo list' -> Stage 2 'todo' bound clause has 'todo', not 'admin', rejects AdminTodoDashboard.tsx", () => {
      const userRequest = "remove admin panel AND add todo list";
      const intent = createTaskIntentSpec("todo", constructiveClassification);
      bindUserRequest(intent, userRequest);

      const clauses = UserClauseExtractor.extractClauses(userRequest);
      expect(clauses).toHaveLength(2);

      const boundResult = UserClauseExtractor.bindStageToClause(
        { taskType: "NEW_FEATURE", goal: "todo" },
        clauses
      );
      expect(boundResult.clause).toBeDefined();
      const boundClause = boundResult.clause!;
      expect(boundClause.entityTokens).toContain("todo");
      expect(boundClause.entityTokens).not.toContain("admin");

      TaskAnchorResolver.resolve({
        intentSpec: intent,
        repositoryFiles: getFiles(),
        repositoryId: "test-repo",
        workspaceRoot: root,
        evidenceStore: store,
      });

      const eligible = TaskRootedAuthorizationVerifier.isEligibleConstructiveCreateScope(
        "app/components/AdminTodoDashboard.tsx",
        "app/page.tsx",
        getFiles(),
        intent
      );
      expect(eligible).toBe(false);

      const proof = TaskRootedAuthorizationVerifier.derive(store, intent, "app/components/AdminTodoDashboard.tsx", "create");
      expect(proof).toBeNull();
    });

    // PART 17 — AMBIGUOUS BINDING FAILS CLOSED
    test("PART 17: Ambiguous stage-to-clause binding FAILS CLOSED without falling back to global tokens", () => {
      // User specifies two creation targets with overlapping ambiguous phrasing
      const userRequest = "create user profile and create user settings";
      const clauses = UserClauseExtractor.extractClauses(userRequest);
      expect(clauses).toHaveLength(2);

      // Model creates an ambiguous stage "create user" that matches both clauses equally
      const binding = UserClauseExtractor.bindStageToClause(
        { taskType: "NEW_FEATURE", goal: "create user" },
        clauses
      );
      expect(binding.isAmbiguous).toBe(true);
      expect(binding.clause).toBeUndefined();

      const intent = createTaskIntentSpec("create user", constructiveClassification);
      bindUserRequest(intent, userRequest);
      // Notice: NO clause is bound because binding is ambiguous

      TaskAnchorResolver.resolve({
        intentSpec: intent,
        repositoryFiles: getFiles(),
        repositoryId: "test-repo",
        workspaceRoot: root,
        evidenceStore: store,
      });

      // Must FAIL CLOSED even though "user" and "profile" exist in the global request
      const eligible = TaskRootedAuthorizationVerifier.isEligibleConstructiveCreateScope(
        "app/components/UserProfile.tsx",
        "app/page.tsx",
        getFiles(),
        intent
      );
      expect(eligible).toBe(false);

      const proof = TaskRootedAuthorizationVerifier.derive(store, intent, "app/components/UserProfile.tsx", "create");
      expect(proof).toBeNull();
    });

    // CASE G — PUBLIC PROPERTY TAMPERING
    test("CASE G: Public property tampering - trustedStageAuthorizationContext must not treat mutated public property as trusted", () => {
      const intent = createTaskIntentSpec("create todo list", constructiveClassification);
      bindUserRequest(intent, "create todo list");
      bindStageAuthorizationContext(intent, "create todo list");

      // Verify authentic binding
      expect(trustedStageAuthorizationContext(intent)).toBe("create todo list");

      // Attacker mutates public property
      intent.stageAuthorizationContext = "create weather widget";

      // Trusted context must NOT be affected by public property mutation
      expect(trustedStageAuthorizationContext(intent)).toBe("create todo list");

      // And an un-bound intent must not trust public property either
      const untrustedIntent = { ...intent, stageAuthorizationContext: "create weather widget" } as TaskIntentSpec;
      expect(trustedStageAuthorizationContext(untrustedIntent)).toBeUndefined();
    });
  });
});


