import { TargetPathExtractor } from "../contracts/TargetPathExtractor";
import { DestructiveTargetResolver } from "../contracts/DestructiveTargetResolver";
import { TargetScopeExpander } from "../contracts/TargetScopeExpander";
import { TaskExecutionPlanManager } from "../planning/TaskExecutionPlanManager";
import { AgentPlanner } from "../orchestration/AgentPlanner";
import { RepositoryEvidenceStore } from "../repository/RepositoryEvidenceStore";
import { EvidenceBoundWriteSetResolver } from "../contracts/EvidenceBoundWriteSetResolver";
import { PolicyContract } from "../contracts/PolicyContract";
import { TaskIntentSpec, createTaskIntentSpec } from "../shared/TaskIntentSpec";
import { TaskClassificationResult } from "../classification/TaskTypes";
import { MemoryPersistence } from "../memory/MemoryPersistence";
import { ManifestGenerator } from "../../services/manifest-generator";
import { productionIsAuthorityEligible } from "./helpers/capability-test-harness";
import fs from "fs";
import path from "path";
import os from "os";

describe("Compound Stage Isolation and Clarification Input Hardening", () => {
  jest.setTimeout(30000);
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "compound-isolation-test-"));
    jest.spyOn(MemoryPersistence, "saveMessage").mockResolvedValue(undefined as any);
    jest.spyOn(MemoryPersistence, "persistProjectMemory").mockResolvedValue(undefined as any);
    jest.spyOn(MemoryPersistence, "updateSessionTitle").mockResolvedValue(undefined as any);
    jest.spyOn(ManifestGenerator.prototype, "generateManifest").mockImplementation(async (_goal: string, _ctx: any, contract?: any) => {
      const paths = contract?.targetPaths || [];
      return {
        manifestVersion: "1.0",
        files: paths.length > 0
          ? paths.map((p: string) => ({ path: p, action: "modify" as const }))
          : [{ path: "src/featureB/index.ts", action: "modify" as const }],
        totalFiles: 1,
        confidence: 0.95,
      };
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function writeFiles(files: Record<string, string>) {
    for (const [file, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(tempDir, file)), { recursive: true });
      fs.writeFileSync(path.join(tempDir, file), content);
    }
  }

  function createStore() {
    const store = new RepositoryEvidenceStore("test-repo", tempDir);
    store.isAuthorityEligible = productionIsAuthorityEligible.bind(store);
    return store;
  }

  function createPolicy(overrides: Partial<PolicyContract>): PolicyContract {
    return {
      goal: "test goal",
      taskType: "NEW_FEATURE",
      risk: "MEDIUM",
      estimatedComplexity: "MEDIUM",
      destructive: false,
      pipeline: "REPOSITORY",
      environment: "REACT_TS",
      allowedActions: ["modify_file", "create_file"],
      forbiddenActions: [],
      maxFiles: 10,
      repositoryRequired: true,
      requiresClarification: false,
      expectedFiles: [],
      validationType: "TYPESCRIPT_BUILD",
      explicitUserPaths: [],
      userConstraints: [],
      diffCriticEnabled: true,
      ...overrides,
    };
  }

  // =========================================================================
  // CASE 1 — COMPOUND STAGE ISOLATION
  // =========================================================================
  test("CASE 1: Compound stage isolation: Stage A destructive vs Stage B non-destructive", async () => {
    const message = "remove feature A and add feature B";
    const classification: TaskClassificationResult = {
      taskType: "DELETE_FOLDER",
      risk: "MEDIUM",
      estimatedComplexity: "MEDIUM",
      intent: "DELETE_FOLDER",
      confidence: 0.95,
      requiresClarification: false,
      reasoning: "Compound delete and create",
      stages: [
        {
          id: "stage-1",
          name: "remove feature A",
          taskType: "DELETE_FOLDER",
          goal: "remove feature A",
          dependsOn: [],
        },
        {
          id: "stage-2",
          name: "add feature B",
          taskType: "NEW_FEATURE",
          goal: "add feature B",
          dependsOn: ["stage-1"],
        },
      ],
    };

    const plan = TaskExecutionPlanManager.createTaskExecutionPlan(message, classification);
    expect(plan.stages.length).toBe(2);

    const stageA = plan.stages[0];
    const stageB = plan.stages[1];

    // Stage A is destructive
    expect(stageA.intent.destructive).toBe(true);
    expect(stageA.intent.taskType).toBe("DELETE_FOLDER");

    // Stage B is non-destructive
    expect(stageB.intent.destructive).toBe(false);
    expect(stageB.intent.taskType).toBe("NEW_FEATURE");

    // DestructiveTargetResolver spy
    const resolveSpy = jest.spyOn(DestructiveTargetResolver, "resolve");

    const repoFiles = ["src/featureA/index.ts", "src/featureB/index.ts"];
    const evidenceStore = createStore();

    const stageBPolicy = createPolicy({
      goal: stageB.intent.goal,
      taskType: stageB.intent.taskType,
      destructive: false,
      allowedActions: ["modify_file", "create_file"],
      forbiddenActions: ["delete_file", "delete_folder"],
    });

    const stageBContract = {
      ...stageBPolicy,
      targetPaths: [],
      contextScope: [],
      searchScope: [],
      targetProvenance: {},
    };

    await AgentPlanner.planManifest({
      projectId: "test-repo",
      sessionId: "test-sess",
      request: { message } as any, // Original compound message containing "remove"
      projectContext: {} as any,
      canonicalExistingFiles: repoFiles,
      rawSnapshotFiles: [],
      pipelineSnapshotFiles: [] as any,
      optimizedContext: { fileContext: {}, skeletonContext: {}, tokenEstimate: 0 } as any,
      monorepo: { isMonorepo: false, packages: [] } as any,
      effectiveLocalPath: tempDir,
      diagnosticTargetPaths: [],
      baselineDiagnosticsList: [],
      activeStage: stageB, // Active stage is Stage B (NEW_FEATURE)
      taskIntentSpec: stageB.intent,
      intentResult: classification,
      executionContract: stageBContract as any,
      evidenceStore,
      effectiveGoal: stageB.intent.goal,
      policyContract: stageBPolicy,
      knowledgeGraph: { nodes: [], edges: [] } as any,
      clarificationData: null,
      finalConfidence: 0.95,
    });

    // DestructiveTargetResolver was NOT invoked for Stage B despite compound hasDeletion = true
    expect(resolveSpy).not.toHaveBeenCalled();
    resolveSpy.mockRestore();
  });

  // =========================================================================
  // CASE 2 — ORIGINAL LIVE FAILURE SHAPE
  // =========================================================================
  test("CASE 2: Original live failure shape: 'remove calculator and add todo list' -> Stage 2 goal 'Implement the todo list feature.' is NOT destructive and never passes 'Implement' to destructive resolver", async () => {
    const compoundMessage = "remove the calculator and add a todo list";
    const classification: TaskClassificationResult = {
      taskType: "DELETE_FOLDER",
      risk: "MEDIUM",
      estimatedComplexity: "MEDIUM",
      intent: "DELETE_FOLDER",
      confidence: 0.95,
      requiresClarification: false,
      reasoning: "Compound remove and add",
      stages: [
        {
          id: "stage-1",
          name: "remove the calculator",
          taskType: "DELETE_FOLDER",
          goal: "remove the calculator",
          dependsOn: [],
        },
        {
          id: "stage-2",
          name: "implement todo list",
          taskType: "NEW_FEATURE",
          goal: "Implement the todo list feature.",
          dependsOn: ["stage-1"],
        },
      ],
    };

    const plan = TaskExecutionPlanManager.createTaskExecutionPlan(compoundMessage, classification);
    const stage2 = plan.stages[1];
    expect(stage2.intent.taskType).toBe("NEW_FEATURE");
    expect(stage2.intent.destructive).toBe(false);

    const resolveSpy = jest.spyOn(DestructiveTargetResolver, "resolve");
    const repoFiles = ["src/components/calculator/Calculator.tsx", "src/app.ts"];
    const evidenceStore = createStore();

    const stage2Policy = createPolicy({
      goal: stage2.intent.goal,
      taskType: stage2.intent.taskType,
      destructive: false,
      allowedActions: ["modify_file", "create_file"],
      forbiddenActions: ["delete_file", "delete_folder"],
    });

    const stage2Contract = {
      ...stage2Policy,
      targetPaths: [],
      contextScope: [],
      searchScope: [],
      targetProvenance: {},
    };

    const manifestResult = await AgentPlanner.planManifest({
      projectId: "test-repo",
      sessionId: "test-sess",
      request: { message: compoundMessage } as any,
      projectContext: {} as any,
      canonicalExistingFiles: repoFiles,
      rawSnapshotFiles: [],
      pipelineSnapshotFiles: [] as any,
      optimizedContext: { fileContext: {}, skeletonContext: {}, tokenEstimate: 0 } as any,
      monorepo: { isMonorepo: false, packages: [] } as any,
      effectiveLocalPath: tempDir,
      diagnosticTargetPaths: [],
      baselineDiagnosticsList: [],
      activeStage: stage2,
      taskIntentSpec: stage2.intent,
      intentResult: classification,
      executionContract: stage2Contract as any,
      evidenceStore,
      effectiveGoal: stage2.intent.goal,
      policyContract: stage2Policy,
      knowledgeGraph: { nodes: [], edges: [] } as any,
      clarificationData: null,
      finalConfidence: 0.95,
    });

    // DestructiveTargetResolver was never invoked, so "Implement" was never passed into destructive target resolution
    expect(resolveSpy).not.toHaveBeenCalled();
    expect((manifestResult as any).errorCode).not.toBe("INSUFFICIENT_REPOSITORY_EVIDENCE");
    resolveSpy.mockRestore();
  });

  // =========================================================================
  // CASE 3 — SINGLE DESTRUCTIVE REQUEST REGRESSION
  // =========================================================================
  test("CASE 3: Single destructive request regression: 'remove calculator' preserves existing destructive resolution", async () => {
    const singleMessage = "remove the calculator";
    const classification: TaskClassificationResult = {
      taskType: "DELETE_FOLDER",
      risk: "MEDIUM",
      estimatedComplexity: "MEDIUM",
      intent: "DELETE_FOLDER",
      confidence: 0.95,
      requiresClarification: false,
      reasoning: "Single destructive request",
    };

    const plan = TaskExecutionPlanManager.createTaskExecutionPlan(singleMessage, classification);
    expect(plan.stages.length).toBe(1);
    const stage = plan.stages[0];
    expect(stage.intent.destructive).toBe(true);
    expect(stage.intent.taskType).toBe("DELETE_FOLDER");

    const repoFiles = [
      "src/components/calculator/Calculator.tsx",
      "src/components/calculator/index.ts",
      "src/app.ts",
    ];
    writeFiles({
      "src/components/calculator/Calculator.tsx": "export const Calculator = () => null;",
      "src/components/calculator/index.ts": "export * from './Calculator';",
      "src/app.ts": "import { Calculator } from './components/calculator'; export const App = Calculator;",
    });

    const evidenceStore = createStore();
    const resolveSpy = jest.spyOn(DestructiveTargetResolver, "resolve");

    const policy = createPolicy({
      goal: stage.intent.goal,
      taskType: stage.intent.taskType,
      destructive: true,
      allowedActions: ["delete_file", "delete_folder", "modify_file"],
      forbiddenActions: [],
    });

    const contract = {
      ...policy,
      targetPaths: [],
      contextScope: [],
      searchScope: [],
      targetProvenance: {},
    };

    await AgentPlanner.planManifest({
      projectId: "test-repo",
      sessionId: "test-sess",
      request: { message: singleMessage } as any,
      projectContext: {} as any,
      canonicalExistingFiles: repoFiles,
      rawSnapshotFiles: [
        { path: "src/components/calculator/Calculator.tsx", content: "export const Calculator = () => null;" },
      ],
      pipelineSnapshotFiles: [] as any,
      optimizedContext: { fileContext: {}, skeletonContext: {}, tokenEstimate: 0 } as any,
      monorepo: { isMonorepo: false, packages: [] } as any,
      effectiveLocalPath: tempDir,
      diagnosticTargetPaths: [],
      baselineDiagnosticsList: [],
      activeStage: stage,
      taskIntentSpec: stage.intent,
      intentResult: classification,
      executionContract: contract as any,
      evidenceStore,
      effectiveGoal: stage.intent.goal,
      policyContract: policy,
      knowledgeGraph: { nodes: [], edges: [] } as any,
      clarificationData: null,
      finalConfidence: 0.95,
    });

    // DestructiveTargetResolver WAS invoked for single destructive stage
    expect(resolveSpy).toHaveBeenCalled();
    expect(resolveSpy).toHaveBeenCalledWith(
      "remove the calculator",
      repoFiles,
      expect.objectContaining({ isDestructive: true, taskType: "DELETE_FOLDER" })
    );
    resolveSpy.mockRestore();
  });

  // =========================================================================
  // CASE 4 — VALID PATH CLARIFICATION
  // =========================================================================
  test("CASE 4: Valid path clarification: 'src/components/example.tsx' satisfies target semantics", () => {
    const repoFiles = ["src/components/example.tsx", "src/app.ts"];
    const answer = "src/components/example.tsx";

    // 1. Validator recognises valid path
    expect(TargetPathExtractor.isValidTargetClarificationAnswer(answer, repoFiles)).toBe(true);
    expect(TargetPathExtractor.isValidPathCandidate(answer, repoFiles)).toBe(true);

    // 2. DestructiveTargetResolver accepts it as explicit candidate
    const res = DestructiveTargetResolver.resolve("delete component", repoFiles, {
      isDestructive: true,
      selectedLogicalTarget: answer,
    });

    expect(res.status).toBe("RESOLVED");
    expect(res.targetCertainty).toBe("EXPLICIT");
    expect(res.candidatePaths).toEqual(["src/components/example.tsx"]);
    expect(res.resolvedTarget?.resolutionSource).toBe("EXPLICIT_PATH");
  });

  // =========================================================================
  // CASE 5 — UI ACTION LABEL
  // =========================================================================
  test("CASE 5: UI action label 'Specify target file path' is rejected and does not become a target", () => {
    const repoFiles = ["src/components/example.tsx", "src/app.ts"];
    const directive = "Specify target file path";

    // 1. Validator rejects interaction directive
    expect(TargetPathExtractor.isValidTargetClarificationAnswer(directive, repoFiles)).toBe(false);

    // 2. DestructiveTargetResolver ignores it and does not resolve it as a target
    const res = DestructiveTargetResolver.resolve("delete component", repoFiles, {
      isDestructive: true,
      selectedLogicalTarget: directive,
    });

    expect(res.status).not.toBe("RESOLVED");
    expect(res.candidatePaths).toEqual([]);
    expect(res.resolvedTarget).toBeUndefined();
  });

  // =========================================================================
  // CASE 6 — ANOTHER ACTION DIRECTIVE
  // =========================================================================
  test("CASE 6: Generic action directives ('Choose a file', 'Cancel deletion', 'Enter path') are rejected fail-closed", () => {
    const repoFiles = ["src/components/example.tsx", "src/app.ts"];
    const directives = [
      "Choose a file",
      "Cancel deletion",
      "Enter path",
      "Specify target files or components",
      "Select an option",
      "Pick a target",
    ];

    for (const directive of directives) {
      expect(TargetPathExtractor.isValidTargetClarificationAnswer(directive, repoFiles)).toBe(false);

      const res = DestructiveTargetResolver.resolve("remove", repoFiles, {
        isDestructive: true,
        selectedLogicalTarget: directive,
      });

      expect(res.status).not.toBe("RESOLVED");
      expect(res.candidatePaths).toEqual([]);
      expect(res.resolvedTarget).toBeUndefined();
    }
  });

  // =========================================================================
  // CASE 7 — COMMAND VERB FILTERING
  // =========================================================================
  test("CASE 7: Command verb filtering: 'Implement the todo list feature.' does NOT treat 'Implement' as an entity", () => {
    const tokens = TargetPathExtractor.extractNamedEntityTokens("Implement the todo list feature.");
    expect(tokens).not.toContain("Implement");
    expect(tokens).not.toContain("implement");
    // Verifies that legitimate target extraction still works
    expect(tokens.some((t) => t.includes("todo"))).toBe(true);
  });

  // =========================================================================
  // CASE 8 — OTHER IMPERATIVE VERBS
  // =========================================================================
  test("CASE 8: Other imperative verbs ('Build', 'Create', 'Update') at sentence start are not extracted as entities", () => {
    const commands = [
      { input: "Build the dashboard.", verb: "Build", target: "dashboard" },
      { input: "Create the notification panel.", verb: "Create", target: "notification" },
      { input: "Update the profile page.", verb: "Update", target: "profile" },
      { input: "Refactor the auth service.", verb: "Refactor", target: "auth" },
    ];

    for (const { input, verb, target } of commands) {
      const tokens = TargetPathExtractor.extractNamedEntityTokens(input);
      expect(tokens).not.toContain(verb);
      expect(tokens).not.toContain(verb.toLowerCase());
      expect(tokens.some((t) => t.toLowerCase().includes(target))).toBe(true);
    }
  });

  // =========================================================================
  // CASE 9 — EXPLICIT REPOSITORY ENTITY WITH VERB-LIKE NAME
  // =========================================================================
  test("CASE 9: Explicit repository entity with verb-like name ('src/components/Build.tsx') remains fully addressable", () => {
    const repoFiles = ["src/components/Build.tsx", "src/components/CreateModal.tsx", "src/app.ts"];

    // 1. Explicit path extraction works
    const extracted = TargetPathExtractor.extractWithProvenance("remove src/components/Build.tsx", { repoFiles });
    expect(extracted.some((p) => p.path === "src/components/Build.tsx" && p.provenance === "EXPLICIT_USER_PATH")).toBe(true);

    // 2. DestructiveTargetResolver resolves explicit path even though basename is 'Build'
    const res = DestructiveTargetResolver.resolve("remove src/components/Build.tsx", repoFiles, {
      isDestructive: true,
      targetPath: "src/components/Build.tsx",
    });
    expect(res.status).toBe("RESOLVED");
    expect(res.targetCertainty).toBe("EXPLICIT");
    expect(res.candidatePaths).toEqual(["src/components/Build.tsx"]);
  });

  // =========================================================================
  // CASE 10 — CLARIFICATION ANSWER DOES NOT BECOME AUTHORITY
  // =========================================================================
  test("CASE 10: Clarification answer does not grant direct write authority without verified evidence", () => {
    const evidenceStore = createStore();
    const repoFiles = ["src/components/example.tsx", "src/app.ts"];

    const policy = createPolicy({
      goal: "delete example component",
      taskType: "DELETE_FILE",
      risk: "LOW",
      estimatedComplexity: "MEDIUM",
      allowedActions: ["delete_file"],
      expectedFiles: ["src/components/example.tsx"],
    });

    const intentSpec: TaskIntentSpec = createTaskIntentSpec(
      "delete example component",
      {
        taskType: "DELETE_FILE",
        intent: "DELETE_FILE",
        requiresClarification: false,
        reasoning: "Delete example",
        risk: "LOW",
        estimatedComplexity: "MEDIUM",
        confidence: 0.95,
      },
      ["src/components/example.tsx"]
    );

    // Proposed change claiming authority purely from clarification answer without authentic evidence
    const unauthenticatedProposed = [
      {
        path: "src/components/example.tsx",
        action: "delete" as const,
        reason: "User specified in clarification",
        evidenceIds: ["unauthenticated_answer_text"],
        dependencies: [],
      },
    ];

    const authRes = EvidenceBoundWriteSetResolver.resolve({
      policy,
      intentSpec,
      proposedChanges: unauthenticatedProposed,
      evidenceStore,
      existingFiles: repoFiles,
    });

    // Write authority is REJECTED (0 approved paths) because clarification text != evidence
    expect(authRes.approvedPaths).toEqual([]);
    expect(authRes.rejectedPaths.length).toBe(1);
    expect(authRes.rejectedPaths[0].reason).toContain("INVENTED_OR_MISSING_EVIDENCE_IDS");
  });

  // =========================================================================
  // CASE 11 — DIRECT UI NEIGHBOR EXPANSION IN COMPOUND TASK
  // =========================================================================
  test("CASE 11: Compound task UI neighbor expansion: non-destructive active stage permits UI expansion, destructive stage suppresses it", async () => {
    const compoundMessage = "remove feature A and add feature B";
    const classification: TaskClassificationResult = {
      taskType: "DELETE_FOLDER",
      risk: "MEDIUM",
      estimatedComplexity: "MEDIUM",
      intent: "DELETE_FOLDER",
      confidence: 0.95,
      requiresClarification: false,
      reasoning: "Compound remove and add",
      stages: [
        {
          id: "stage-1",
          name: "remove feature A",
          taskType: "DELETE_FOLDER",
          goal: "remove feature A",
          dependsOn: [],
        },
        {
          id: "stage-2",
          name: "add feature B",
          taskType: "NEW_FEATURE",
          goal: "add feature B",
          dependsOn: ["stage-1"],
        },
      ],
    };

    const plan = TaskExecutionPlanManager.createTaskExecutionPlan(compoundMessage, classification);
    const stage1 = plan.stages[0]; // DELETE_FOLDER
    const stage2 = plan.stages[1]; // NEW_FEATURE

    const repoFiles = ["src/featureA/index.ts", "src/featureB/index.ts", "src/featureB/Button.tsx"];
    const evidenceStore = createStore();
    const uiSpy = jest.spyOn(TargetScopeExpander, "expandDirectUIReferences");

    const stage2Policy = createPolicy({
      goal: stage2.intent.goal,
      taskType: stage2.intent.taskType,
      destructive: false,
      environment: "REACT_TS",
      allowedActions: ["modify_file", "create_file"],
      forbiddenActions: ["delete_file", "delete_folder"],
    });

    const stage2Contract = {
      ...stage2Policy,
      targetPaths: [],
      contextScope: [],
      searchScope: [],
      targetProvenance: {},
    };

    // 1. Stage 2 (NEW_FEATURE): Direct UI neighbor expansion must NOT be suppressed by top-level deletion
    await AgentPlanner.planManifest({
      projectId: "test-repo",
      sessionId: "test-sess",
      request: { message: compoundMessage } as any,
      projectContext: {} as any,
      canonicalExistingFiles: repoFiles,
      rawSnapshotFiles: [],
      pipelineSnapshotFiles: [] as any,
      optimizedContext: { fileContext: {}, skeletonContext: {}, tokenEstimate: 0 } as any,
      monorepo: { isMonorepo: false, packages: [] } as any,
      effectiveLocalPath: tempDir,
      diagnosticTargetPaths: [],
      baselineDiagnosticsList: [],
      activeStage: stage2,
      taskIntentSpec: stage2.intent,
      intentResult: classification,
      executionContract: stage2Contract as any,
      evidenceStore,
      effectiveGoal: stage2.intent.goal,
      policyContract: stage2Policy,
      knowledgeGraph: { nodes: [], edges: [] } as any,
      clarificationData: null,
      finalConfidence: 0.95,
    });

    expect(uiSpy).toHaveBeenCalled();

    // 2. Stage 1 (DELETE_FOLDER): Direct UI neighbor expansion MUST be suppressed for destructive active stage
    uiSpy.mockClear();

    const stage1Policy = createPolicy({
      goal: stage1.intent.goal,
      taskType: stage1.intent.taskType,
      destructive: true,
      environment: "REACT_TS",
      allowedActions: ["delete_file", "delete_folder", "modify_file"],
      forbiddenActions: [],
    });

    const stage1Contract = {
      ...stage1Policy,
      targetPaths: [],
      contextScope: [],
      searchScope: [],
      targetProvenance: {},
    };

    await AgentPlanner.planManifest({
      projectId: "test-repo",
      sessionId: "test-sess",
      request: { message: compoundMessage } as any,
      projectContext: {} as any,
      canonicalExistingFiles: repoFiles,
      rawSnapshotFiles: [],
      pipelineSnapshotFiles: [] as any,
      optimizedContext: { fileContext: {}, skeletonContext: {}, tokenEstimate: 0 } as any,
      monorepo: { isMonorepo: false, packages: [] } as any,
      effectiveLocalPath: tempDir,
      diagnosticTargetPaths: [],
      baselineDiagnosticsList: [],
      activeStage: stage1,
      taskIntentSpec: stage1.intent,
      intentResult: classification,
      executionContract: stage1Contract as any,
      evidenceStore,
      effectiveGoal: stage1.intent.goal,
      policyContract: stage1Policy,
      knowledgeGraph: { nodes: [], edges: [] } as any,
      clarificationData: null,
      finalConfidence: 0.95,
    });

    expect(uiSpy).not.toHaveBeenCalled();
    uiSpy.mockRestore();
  });
});
