import { bindUserRequest } from "../repository/TrustedTaskContext";
import fs from "fs";
import os from "os";
import path from "path";
import { PreExecutionAuthorityClosure } from "../contracts/PreExecutionAuthorityClosure";
import { PolicyContract } from "../contracts/PolicyContract";
import { TaskIntentSpec } from "../shared/TaskIntentSpec";
import { RepositoryEvidenceStore } from "../repository/RepositoryEvidenceStore";
import { DiagnosticNormalizer } from "../validation/DiagnosticNormalizer";
import { InvestigationToolCall, RepositoryInvestigationAgent } from "../repository/RepositoryInvestigationAgent";
import { RepositoryToolEngine } from "../../services/repository-tool.engine";
import { productionIsAuthorityEligible } from "./helpers/capability-test-harness";
import { TaskAnchorResolver } from "../repository/TaskAnchorResolver";
import { LLMGateway } from "../gateway/LLMGateway";
import { PipelineStages } from "../gateway/PipelineStage";
import { describeFrameworkRoute, frameworkRouteMatches } from "../repository/FrameworkRouteMatcher";
import { EvidenceBoundWriteSetResolver } from "../contracts/EvidenceBoundWriteSetResolver";
import { TaskRootedAuthorizationVerifier } from "../contracts/TaskRootedAuthorizationProof";
import { DeterministicRelationEvidenceAcquirer } from "../contracts/DeterministicRelationEvidenceAcquirer";

const policy: PolicyContract = { goal: "Repair observed behaviour", taskType: "BUG_FIX", risk: "MEDIUM", estimatedComplexity: "MEDIUM", destructive: false, allowedActions: ["modify_file"], forbiddenActions: ["delete_file"], maxFiles: 4, diffCriticEnabled: true, pipeline: "REPOSITORY", environment: "GENERIC", repositoryRequired: true, expectedFiles: [], validationType: "TYPESCRIPT_BUILD", explicitUserPaths: [], userConstraints: [], requiresClarification: false };
const intent: TaskIntentSpec = { goal: policy.goal, operations: [{ kind: "REPAIR", subject: "observed behaviour" }], constraints: [], acceptanceCriteria: [], destructive: false, requiresClarification: false, taskType: "BUG_FIX", risk: "MEDIUM", estimatedComplexity: "MEDIUM", explicitUserPaths: [] };

describe("Hotfix 06 — deterministic late relation acquisition", () => {
  let workspace: string;
  beforeEach(() => { bindUserRequest(intent, intent.goal); workspace = fs.mkdtempSync(path.join(os.tmpdir(), "anka-hf06-")); fs.mkdirSync(path.join(workspace, "src")); });
  afterEach(() => { jest.restoreAllMocks(); fs.rmSync(workspace, { recursive: true, force: true }); });
  const close = (evidence: RepositoryEvidenceStore, changes: any[]) => PreExecutionAuthorityClosure.close({ changes, policy, intentSpec: intent, evidenceStore: evidence, existingFiles: ["src/anchor.ts", "src/target.ts", "src/unrelated.ts"], repositoryId: "repo", workspaceRoot: workspace, stageId: "stage" });
  const addDiagnosticAnchor = (evidence: RepositoryEvidenceStore) => DiagnosticNormalizer.ingestSourceDiagnostics(DiagnosticNormalizer.normalize("src/anchor.ts(1,1): error TS2322: observed failure", { workspaceRoot: workspace }), evidence, "checkpoint");
  const strictStore = () => {
    const store = new RepositoryEvidenceStore("repo", workspace);
    Object.defineProperty(store, "isAuthorityEligible", { value: productionIsAuthorityEligible.bind(store) });
    return store;
  };

  test("acquires a real relation from a task-grounded diagnostic source for a late candidate", () => {
    fs.writeFileSync(path.join(workspace, "src/anchor.ts"), "import { repair } from './target'; repair();");
    fs.writeFileSync(path.join(workspace, "src/target.ts"), "export const repair = () => 1;");
    const evidence = strictStore(); addDiagnosticAnchor(evidence);
    const result = close(evidence, [{ path: "src/target.ts", action: "modify", content: "x", description: "generated" }]);
    expect(result.valid).toBe(true);
    expect(evidence.getEvidenceForFile("src/target.ts").some((e) => (e.kind === "REFERENCE" || e.kind === "IMPORT") && e.sourceFile === "src/anchor.ts" && evidence.isAuthorityEligible(e))).toBe(true);
  });

  test("file, semantic, codegen, forged metadata, and unrelated incoming references cannot self-authorize", () => {
    fs.writeFileSync(path.join(workspace, "src/anchor.ts"), "export const anchor = 1;");
    fs.writeFileSync(path.join(workspace, "src/target.ts"), "export const proposed = 1;");
    fs.writeFileSync(path.join(workspace, "src/unrelated.ts"), "import { proposed } from './target'; proposed;");
    const evidence = strictStore(); addDiagnosticAnchor(evidence);
    const forged = evidence.addEvidence({ kind: "REFERENCE", filePath: "src/target.ts", sourceFile: "src/forged.ts", provenance: "REFERENCE_SEARCH", metadata: { forged: true } });
    expect(evidence.isAuthorityEligible(forged)).toBe(false);
    evidence.addEvidence({ kind: "FILE", filePath: "src/target.ts", provenance: "SEMANTIC_SEARCH" });
    const result = close(evidence, [{ path: "src/target.ts", action: "modify", content: "proposed", description: "model says relation" }]);
    expect(result.valid).toBe(false);
    expect(result.result.rejectedPaths[0].reason).toContain("NO_TASK_OR_STRUCTURAL_RELATION");
  });

  test("rejects the full action group when one late candidate lacks a relation", () => {
    fs.writeFileSync(path.join(workspace, "src/anchor.ts"), "import { repair } from './target'; repair();");
    fs.writeFileSync(path.join(workspace, "src/target.ts"), "export const repair = () => 1;");
    fs.writeFileSync(path.join(workspace, "src/unrelated.ts"), "export const unrelated = 1;");
    const evidence = strictStore(); addDiagnosticAnchor(evidence);
    const result = close(evidence, [{ path: "src/target.ts", action: "modify", content: "x", description: "generated" }, { path: "src/unrelated.ts", action: "modify", content: "x", description: "generated" }]);
    expect(result.valid).toBe(false); expect(result.result.rejectedPaths).toHaveLength(1);
  });

  test("repo_findReferences materializes a validated structural relation, never FILE fallback", async () => {
    fs.writeFileSync(path.join(workspace, "src/anchor.ts"), "import { repair } from './target'; repair();");
    fs.writeFileSync(path.join(workspace, "src/target.ts"), "export const repair = () => 1;");
    const evidence = strictStore();
    const engine = new RepositoryToolEngine([{ path: "src/anchor.ts", content: fs.readFileSync(path.join(workspace, "src/anchor.ts"), "utf8") }, { path: "src/target.ts", content: fs.readFileSync(path.join(workspace, "src/target.ts"), "utf8") }] as any, workspace);
    const agent = new RepositoryInvestigationAgent({ toolEngine: engine, evidenceStore: evidence, intentSpec: intent, maxRounds: 1 });
    const materialize = (agent as any).executeToolAndMaterializeEvidence.bind(agent);
    await materialize("repo_findReferences", { symbolName: "repair", sourceFilePath: "src/target.ts" }, new Set<string>());
    const reference = evidence.getAllEvidence().find((e) => (e.kind === "REFERENCE" || e.kind === "IMPORT") && e.sourceFile === "src/anchor.ts");
    expect(reference).toBeDefined(); expect(evidence.isAuthorityEligible(reference!)).toBe(true);
  });

  test("repo_findReferences rejects source context that does not define the queried symbol", async () => {
    fs.writeFileSync(path.join(workspace, "src/anchor.ts"), "import { repair } from './target'; repair();");
    fs.writeFileSync(path.join(workspace, "src/target.ts"), "export const repair = () => 1;");
    const evidence = strictStore();
    const engine = new RepositoryToolEngine([
      { path: "src/anchor.ts", content: fs.readFileSync(path.join(workspace, "src/anchor.ts"), "utf8") },
      { path: "src/target.ts", content: fs.readFileSync(path.join(workspace, "src/target.ts"), "utf8") },
    ] as never, workspace);
    const agent = new RepositoryInvestigationAgent({ toolEngine: engine, evidenceStore: evidence, intentSpec: intent, maxRounds: 1 });
    const materialize = (agent as any).executeToolAndMaterializeEvidence.bind(agent);
    await materialize("repo_findReferences", { symbolName: "repair", sourceFilePath: "src/anchor.ts" }, new Set<string>());
    expect(evidence.getAllEvidence().some((item) => item.kind === "IMPORT" || item.kind === "REFERENCE")).toBe(false);
  });

  test("resolves a unique runtime route as a non-mutating anchor and traverses bounded imports", () => {
    fs.mkdirSync(path.join(workspace, "app/projects/[id]"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "features"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "data"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "tsconfig.json"), JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["*"] } } }));
    fs.writeFileSync(path.join(workspace, "app/projects/[id]/page.tsx"), "import { loadProject } from '@/features/project-loader'; export default function Page() { return loadProject(); }");
    fs.writeFileSync(path.join(workspace, "features/project-loader.ts"), "import { tasksForProject } from '../data/task-store'; export const loadProject = () => tasksForProject('current');");
    fs.writeFileSync(path.join(workspace, "data/task-store.ts"), "export const tasksForProject = (id: string) => [id];");

    const routeIntent: TaskIntentSpec = { ...intent, goal: "Opening /projects/proj-1 shows no associated records", operations: [{ kind: "REPAIR", subject: "Opening /projects/proj-1 shows no associated records" }] };
    bindUserRequest(routeIntent, routeIntent.goal);
    expect(routeIntent.explicitUserPaths).toEqual([]);
    expect(TaskAnchorResolver.extractRuntimeRouteHints(routeIntent)).toEqual(["/projects/proj-1"]);

    const evidence = strictStore();
    const existingFiles = ["app/projects/[id]/page.tsx", "features/project-loader.ts", "data/task-store.ts", "tsconfig.json"];
    const result = PreExecutionAuthorityClosure.close({
      changes: [{ path: "data/task-store.ts", action: "modify", content: "x", description: "generated" }],
      policy, intentSpec: routeIntent, evidenceStore: evidence, existingFiles,
      repositoryId: "repo", workspaceRoot: workspace, stageId: "stage",
    });

    expect(result.valid).toBe(true);
    expect(evidence.getEvidenceForFile("app/projects/[id]/page.tsx")).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "ENTRY_POINT", metadata: expect.objectContaining({ deterministicTaskAnchor: true, runtimeRoute: "/projects/proj-1" }) }),
    ]));
    expect(evidence.getEvidenceForFile("data/task-store.ts")).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "IMPORT", sourceFile: "features/project-loader.ts" }),
    ]));
  });

  test("matches App and Pages Router dynamic and catch-all segments deterministically", () => {
    expect(describeFrameworkRoute("src/app/(site)/projects/[id]/page.tsx")?.routePattern).toBe("/projects/[id]");
    expect(describeFrameworkRoute("pages/projects/[slug].tsx")?.routePattern).toBe("/projects/[slug]");
    expect(frameworkRouteMatches("/projects/[id]", "/projects/proj-1")).toBe(true);
    expect(frameworkRouteMatches("/projects/[id]", "/projects/proj-1/tasks")).toBe(false);
    expect(frameworkRouteMatches("/docs/[...slug]", "/docs/guides/start")).toBe(true);
    expect(frameworkRouteMatches("/docs/[...slug]", "/docs")).toBe(false);
    expect(frameworkRouteMatches("/docs/[[...slug]]", "/docs")).toBe(true);
  });

  test("a unique runtime route authorizes a focused modification of its route source", () => {
    fs.mkdirSync(path.join(workspace, "app/projects/[id]"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "app/projects/[id]/page.tsx"), "export default function Page() { return null; }");
    const routeIntent: TaskIntentSpec = { ...intent, goal: "Opening /projects/proj-1 is broken" };
    bindUserRequest(routeIntent, routeIntent.goal);
    const evidence = strictStore();
    const result = PreExecutionAuthorityClosure.close({
      changes: [{ path: "app/projects/[id]/page.tsx", action: "modify", content: "x", description: "generated" }],
      policy, intentSpec: routeIntent, evidenceStore: evidence, existingFiles: ["app/projects/[id]/page.tsx"],
      repositoryId: "repo", workspaceRoot: workspace, stageId: "stage",
    });
    expect(result.valid).toBe(true);
    expect(result.result.approvedPaths).toEqual(["app/projects/[id]/page.tsx"]);
    expect(result.result.evidenceAuthorization.getEvidenceIds()).toEqual(expect.arrayContaining([
      expect.stringMatching(/^evi_/),
    ]));
  });

  test("ambiguous dynamic runtime routes fail closed", () => {
    fs.mkdirSync(path.join(workspace, "app/projects/[id]"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "pages/projects"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "app/projects/[id]/page.tsx"), "import { target } from '../../../src/target'; export default function Page() { return target; }");
    fs.writeFileSync(path.join(workspace, "pages/projects/[slug].tsx"), "export default function Page() { return null; }");
    fs.writeFileSync(path.join(workspace, "src/target.ts"), "export const target = 1;");
    const routeIntent: TaskIntentSpec = { ...intent, goal: "Opening /projects/proj-1 is broken" };
    bindUserRequest(routeIntent, routeIntent.goal);
    const evidence = strictStore();
    const result = PreExecutionAuthorityClosure.close({
      changes: [{ path: "src/target.ts", action: "modify", content: "x", description: "generated" }],
      policy, intentSpec: routeIntent, evidenceStore: evidence,
      existingFiles: ["app/projects/[id]/page.tsx", "pages/projects/[slug].tsx", "src/target.ts"],
      repositoryId: "repo", workspaceRoot: workspace, stageId: "stage",
    });
    expect(result.valid).toBe(false);
    expect(evidence.getAllEvidence().some((item) => item.metadata?.deterministicTaskAnchor === true)).toBe(false);
  });

  test("semantic-only evidence and model-ready-without-tools remain not ready", async () => {
    jest.spyOn(LLMGateway.getInstance(), "callStructured").mockResolvedValue({
      content: { readyToPlan: true, reason: "ready", toolCalls: [] }, rawResponse: {}, finishReason: "stop",
      latencyMs: 1, model: "test", stage: PipelineStages.REPOSITORY_REASONING,
    } as never);
    const evidence = strictStore();
    evidence.addEvidence({ kind: "FILE", filePath: "src/target.ts", provenance: "SEMANTIC_SEARCH" });
    const engine = new RepositoryToolEngine([{ path: "src/target.ts", content: "export const target = 1;" }] as never, workspace);
    const agent = new RepositoryInvestigationAgent({ toolEngine: engine, evidenceStore: evidence, intentSpec: intent, maxRounds: 1, localPath: workspace });
    const result = await agent.investigate();
    expect(result.readyToPlan).toBe(false);
    expect(result.missingEvidence.join(" ")).toContain("deterministic task-grounded evidence");
  });

  test("plain-language UI refinement is rooted at one verified composition entry and reaches its existing imports", () => {
    fs.writeFileSync(path.join(workspace, "src/main.tsx"), "import { createRoot } from 'react-dom/client'; import App from './App'; import './styles/global.css'; createRoot(document.getElementById('root')!).render(<App />);");
    fs.writeFileSync(path.join(workspace, "src/App.tsx"), "export default function App() { return <main>Dashboard</main>; }");
    fs.mkdirSync(path.join(workspace, "src/styles"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "src/styles/global.css"), ":root { color-scheme: light; }");

    const uiIntent: TaskIntentSpec = {
      ...intent,
      goal: "Update the UI and add a dark mode toggle button on the top",
      operations: [{ kind: "MODIFY", subject: "Update the UI and add a dark mode toggle button on the top" }],
      taskType: "NEW_FEATURE",
    };
    bindUserRequest(uiIntent, uiIntent.goal);
    const evidence = strictStore();
    const existingFiles = ["src/main.tsx", "src/App.tsx", "src/styles/global.css"];

    const appSymbol = evidence.observeRepository({
      kind: "SYMBOL",
      filePath: "src/App.tsx",
      symbol: "App",
      provenance: "AST_GRAPH",
    });
    const acquiredEvidence = DeterministicRelationEvidenceAcquirer.acquire({
      candidatePaths: ["src/App.tsx", "src/styles/global.css", "src/components/ThemeToggle.tsx"],
      intentSpec: uiIntent,
      evidenceStore: evidence,
      repositoryId: "repo",
      workspaceRoot: workspace,
      existingFiles,
    });

    const evidenceIds = (filePath: string) => Array.from(new Set([
      appSymbol.id,
      ...(acquiredEvidence.get(filePath) || []),
    ]));
    const result = EvidenceBoundWriteSetResolver.resolve({
      policy: { ...policy, taskType: "NEW_FEATURE", allowedActions: ["modify_file", "create_files"] },
      intentSpec: uiIntent,
      evidenceStore: evidence,
      existingFiles,
      targetRepositoryId: "repo",
      workspaceRoot: workspace,
      proposedChanges: [
        { path: "src/App.tsx", action: "modify", reason: "Integrate the control", evidenceIds: evidenceIds("src/App.tsx"), dependencies: [] },
        { path: "src/styles/global.css", action: "modify", reason: "Add theme tokens", evidenceIds: evidenceIds("src/styles/global.css"), dependencies: [] },
        { path: "src/components/ThemeToggle.tsx", action: "create", reason: "Planner-proposed component", evidenceIds: [appSymbol.id], dependencies: [] },
      ],
    });

    expect(result.approvedPaths).toEqual(expect.arrayContaining(["src/App.tsx", "src/styles/global.css"]));
    expect(result.rejectedPaths.find((item) => item.path === "src/components/ThemeToggle.tsx")?.reason).toContain("NO_TASK_OR_STRUCTURAL_RELATION");
  });

  test("UI composition rooting fails closed when more than one application bootstrap is present", () => {
    for (const app of ["one", "two"]) {
      fs.mkdirSync(path.join(workspace, "apps", app, "src"), { recursive: true });
      fs.writeFileSync(path.join(workspace, "apps", app, "src/main.tsx"), "import { createRoot } from 'react-dom/client'; createRoot(document.getElementById('root')!).render(null);");
    }
    const uiIntent: TaskIntentSpec = { ...intent, goal: "Update the current UI", taskType: "NEW_FEATURE" };
    bindUserRequest(uiIntent, uiIntent.goal);
    const evidence = strictStore();
    const resolution = TaskAnchorResolver.resolve({
      intentSpec: uiIntent,
      repositoryFiles: ["apps/one/src/main.tsx", "apps/two/src/main.tsx"],
      repositoryId: "repo",
      workspaceRoot: workspace,
      evidenceStore: evidence,
    });
    expect(resolution.uiAnchors).toEqual([]);
    expect(TaskRootedAuthorizationVerifier.roots(evidence, uiIntent)).toEqual([]);
  });

  test("plain-language API work is rooted at the uniquely registered resource route", () => {
    for (const directory of ["src/routes", "src/controllers", "src/services", "tests"]) {
      fs.mkdirSync(path.join(workspace, directory), { recursive: true });
    }
    fs.writeFileSync(path.join(workspace, "src/routes/index.ts"), "import userRoutes from './user.routes'; const router = { use() {} }; router.use('/users', userRoutes); export default router;");
    fs.writeFileSync(path.join(workspace, "src/routes/user.routes.ts"), "import { userController } from '../controllers/user.controller'; export const route = () => userController.getAllUsers();");
    fs.writeFileSync(path.join(workspace, "src/controllers/user.controller.ts"), "import { userService } from '../services/user.service'; export const userController = { getAllUsers: () => userService.getAllUsers() }; ");
    fs.writeFileSync(path.join(workspace, "src/services/user.service.ts"), "export const userService = { getAllUsers: () => [] }; ");
    fs.writeFileSync(path.join(workspace, "src/services/team.service.ts"), "export const teamService = { getAllTeams: () => [] }; ");
    fs.writeFileSync(path.join(workspace, "src/app.ts"), "import routes from './routes'; export default routes;");
    fs.writeFileSync(path.join(workspace, "tests/users.test.ts"), "import app from '../src/app'; void app; request(app).get('/users');");

    const apiIntent: TaskIntentSpec = {
      ...intent,
      goal: "Add a service method for retrieving active users and expose it through the existing API architecture.",
      operations: [{ kind: "MODIFY", subject: "Add a service method for retrieving active users and expose it through the existing API architecture." }],
      taskType: "NEW_FEATURE",
    };
    bindUserRequest(apiIntent, apiIntent.goal);
    const apiPolicy: PolicyContract = { ...policy, goal: apiIntent.goal, taskType: "NEW_FEATURE" };
    const evidence = strictStore();
    const existingFiles = ["src/app.ts", "src/routes/index.ts", "src/routes/user.routes.ts", "src/controllers/user.controller.ts", "src/services/user.service.ts", "src/services/team.service.ts", "tests/users.test.ts"];
    const resolution = TaskAnchorResolver.resolve({ intentSpec: apiIntent, repositoryFiles: existingFiles, repositoryId: "repo", workspaceRoot: workspace, evidenceStore: evidence });

    expect(resolution.apiAnchors).toEqual(["src/routes/user.routes.ts"]);
    expect(resolution.testAnchors).toEqual(["tests/users.test.ts"]);
    const result = PreExecutionAuthorityClosure.close({
      changes: [
        { path: "src/routes/user.routes.ts", action: "modify", content: "route", description: "Expose endpoint" },
        { path: "src/controllers/user.controller.ts", action: "modify", content: "controller", description: "Handle request" },
        { path: "src/services/user.service.ts", action: "modify", content: "service", description: "Retrieve active users" },
        { path: "tests/users.test.ts", action: "modify", content: "test", description: "Cover endpoint" },
      ],
      policy: apiPolicy, intentSpec: apiIntent, evidenceStore: evidence, existingFiles,
      repositoryId: "repo", workspaceRoot: workspace, stageId: "stage",
    });
    expect(result.valid).toBe(true);
    expect(result.result.approvedPaths).toEqual(expect.arrayContaining([
      "src/routes/user.routes.ts", "src/controllers/user.controller.ts", "src/services/user.service.ts", "tests/users.test.ts",
    ]));

    const unrelated = PreExecutionAuthorityClosure.close({
      changes: [{ path: "src/services/team.service.ts", action: "modify", content: "team", description: "Unrelated model proposal" }],
      policy: apiPolicy, intentSpec: apiIntent, evidenceStore: evidence, existingFiles,
      repositoryId: "repo", workspaceRoot: workspace, stageId: "stage",
    });
    expect(unrelated.valid).toBe(false);
    expect(unrelated.result.rejectedPaths[0].reason).toContain("NO_TASK_OR_STRUCTURAL_RELATION");
  });

  test("deterministic investigation fallback selects API architecture rather than a UI component probe", () => {
    const apiIntent: TaskIntentSpec = { ...intent, goal: "Expose active users through the API service architecture", taskType: "NEW_FEATURE" };
    bindUserRequest(apiIntent, apiIntent.goal);
    const evidence = strictStore();
    const engine = new RepositoryToolEngine([] as never, workspace);
    const agent = new RepositoryInvestigationAgent({ toolEngine: engine, evidenceStore: evidence, intentSpec: apiIntent, maxRounds: 1, localPath: workspace });
    const plan = (agent as unknown as { fallbackToolPlanner(round: number, hashes: Set<string>): { toolCalls: InvestigationToolCall[] } })
      .fallbackToolPlanner(1, new Set<string>());
    expect(plan.toolCalls.some((call) => call.tool === "repo_searchArchitecture" && call.params.layer === "business")).toBe(true);
    expect(plan.toolCalls.some((call) => call.tool === "repo_findComponent")).toBe(false);
  });

  test("API resource rooting fails closed when the task matches multiple route modules", () => {
    fs.mkdirSync(path.join(workspace, "src/routes"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "src/routes/index.ts"), "import publicUsers from './public-users'; import adminUsers from './admin-users'; const router = { use() {} }; router.use('/users', publicUsers); router.use('/admin/users', adminUsers);");
    fs.writeFileSync(path.join(workspace, "src/routes/public-users.ts"), "export default {}; ");
    fs.writeFileSync(path.join(workspace, "src/routes/admin-users.ts"), "export default {}; ");
    const apiIntent: TaskIntentSpec = { ...intent, goal: "Add a users API service method", taskType: "NEW_FEATURE" };
    bindUserRequest(apiIntent, apiIntent.goal);
    const evidence = strictStore();
    const resolution = TaskAnchorResolver.resolve({
      intentSpec: apiIntent,
      repositoryFiles: ["src/routes/index.ts", "src/routes/public-users.ts", "src/routes/admin-users.ts"],
      repositoryId: "repo", workspaceRoot: workspace, evidenceStore: evidence,
    });
    expect(resolution.apiAnchors).toEqual([]);
    expect(resolution.ambiguousApiResources).toContain("users");
    expect(TaskRootedAuthorizationVerifier.roots(evidence, apiIntent)).toEqual([]);
  });
});
