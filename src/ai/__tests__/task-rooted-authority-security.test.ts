import fs from "fs";
import os from "os";
import path from "path";
import { RepositoryEvidenceStore } from "../repository/RepositoryEvidenceStore";
import { PreExecutionAuthorityClosure } from "../contracts/PreExecutionAuthorityClosure";
import { EvidenceBoundWriteSetResolver } from "../contracts/EvidenceBoundWriteSetResolver";
import { TaskRootedAuthorizationVerifier } from "../contracts/TaskRootedAuthorizationProof";
import { PolicyContract } from "../contracts/PolicyContract";
import { createTaskIntentSpec } from "../shared/TaskIntentSpec";
import { TaskClassificationResult } from "../classification/TaskTypes";
import { AuthorizedCapabilityScope, CapabilityGuard } from "../runtime/CapabilityGuard";
import { repositoryPath } from "../repository/RepositoryBoundary";
import { fileDefinesSymbol, resolveLocalImportEdges } from "../repository/DeterministicImportResolver";
import { describeFrameworkRoute, frameworkRouteMatches, selectFrameworkRoutes } from "../repository/FrameworkRouteMatcher";
import { DestructiveTargetResolver } from "../contracts/DestructiveTargetResolver";
import { DiagnosticNormalizer } from "../validation/DiagnosticNormalizer";
import { RepositoryInvestigationAgent } from "../repository/RepositoryInvestigationAgent";
import { RepositoryToolEngine } from "../../services/repository-tool.engine";
import { TaskAnchorResolver } from "../repository/TaskAnchorResolver";
import { FileSystemStateManager } from "../validation/FileSystemStateManager";

const policy: PolicyContract = { goal: "Repair", taskType: "BUG_FIX", risk: "MEDIUM", estimatedComplexity: "MEDIUM", destructive: false, allowedActions: ["modify_file", "delete_file", "create_file"], forbiddenActions: [], maxFiles: 10, diffCriticEnabled: true, pipeline: "REPOSITORY", environment: "GENERIC", repositoryRequired: true, expectedFiles: [], validationType: "TYPESCRIPT_BUILD", explicitUserPaths: [], userConstraints: [], requiresClarification: false };
const classification: TaskClassificationResult = { taskType: "BUG_FIX", intent: "BUG_FIX", risk: "MEDIUM", estimatedComplexity: "MEDIUM", confidence: 1, requiresClarification: false, reasoning: "test" };

describe("Production task-rooted authority (no eligibility patches)", () => {
  let root: string;
  let store: RepositoryEvidenceStore;
  const write = (file: string, content: string) => { const absolute = path.join(root, file); fs.mkdirSync(path.dirname(absolute), { recursive: true }); fs.writeFileSync(absolute, content); };
  const intent = (text = "Repair /projects/proj-1") => createTaskIntentSpec(text, classification);
  const close = (candidate: string, action: "modify" | "create" | "delete" = "modify", task = intent()) => PreExecutionAuthorityClosure.close({
    changes: [{ path: candidate, action, content: "changed", description: "generated" }], policy, intentSpec: task, evidenceStore: store,
    existingFiles: files(), repositoryId: "repo", workspaceRoot: root, stageId: "stage", runId: "run",
  });
  const files = (): string[] => fs.readdirSync(root, { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).map((d) => path.relative(root, path.join(d.parentPath, d.name)).replace(/\\/g, "/"));
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "anka-authority-"));
    write("app/projects/[id]/page.tsx", "import '../../../a'; export default function Page() { return null; }");
    write("a.ts", "import './b'; export const a = 1;");
    write("b.ts", "import './c'; export const b = 1;");
    write("c.ts", "import './d'; export const c = 1;");
    write("d.ts", "export const d = 1;");
    write("unrelated.ts", "import './billing';");
    write("billing.ts", "export const billing = 1;");
    store = new RepositoryEvidenceStore("repo", root);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  test("P1 P2 P7: unrelated authentic import and forged lineage cannot authorize", () => {
    store.observeRepository({ kind: "IMPORT", sourceFile: "unrelated.ts", filePath: "billing.ts", provenance: "AST_GRAPH", metadata: { rootEvidenceId: "fake", parentEvidenceId: "fake", depth: 1 } });
    expect(close("billing.ts").valid).toBe(false);
  });
  test("manifest membership and invented evidence IDs cannot authorize unrelated candidates", () => {
    const result = PreExecutionAuthorityClosure.close({
      changes: [{ path: "billing.ts", action: "modify", content: "model", description: "manifest candidate" }],
      policy, intentSpec: intent(), evidenceStore: store, existingFiles: files(), repositoryId: "repo", workspaceRoot: root, stageId: "stage",
      manifest: { totalFiles: 1, manifestVersion: "1.0.0", files: [{ path: "billing.ts", action: "modify", description: "unrelated", evidenceIds: ["fake"], dependencies: [] }] },
    });
    expect(result.valid).toBe(false);
  });
  test("P3 P7: semantic rank and REPO_READ never imply MODIFY or DELETE", () => {
    store.addEvidence({ kind: "FILE", filePath: "billing.ts", provenance: "SEMANTIC_SEARCH", metadata: { relevanceScore: 1 } });
    store.observeRepository({ kind: "FILE", filePath: "billing.ts", provenance: "REPO_READ" });
    expect(close("billing.ts").valid).toBe(false);
    const task = intent(); task.destructive = true;
    expect(close("billing.ts", "delete", task).valid).toBe(false);
  });
  test.each(["app/projects/[id]/page", "b"])("P4: reverse candidate import of %s never authorizes", (target) => {
    write("billing.ts", `import './${target}';`);
    store.observeRepository({ kind: "IMPORT", sourceFile: "billing.ts", filePath: `${target}${target.endsWith("page") ? ".tsx" : ".ts"}`, provenance: "AST_GRAPH" });
    expect(close("billing.ts").valid).toBe(false);
  });
  test("P1: direct route chain and depth three authorize; depth four rejects", () => {
    expect(close("a.ts").valid).toBe(true);
    expect(close("c.ts").valid).toBe(true);
    expect(close("d.ts").valid).toBe(false);
  });
  test("P2: caller-shaped intent and candidate membership cannot create roots", () => {
    const forged = { ...intent(), explicitUserPaths: ["billing.ts"], goal: "Modify billing.ts" };
    expect(close("billing.ts", "modify", forged).valid).toBe(false);
  });
  test("cycles terminate without resetting depth; multiple paths are deterministic", () => {
    write("b.ts", "import './a'; import './c'; import './app/projects/[id]/page';");
    expect(close("c.ts").valid).toBe(true);
    expect(close("d.ts").valid).toBe(false);
    const task = intent();
    expect(TaskRootedAuthorizationVerifier.derive(store, task, "c.ts", "modify")).toEqual(TaskRootedAuthorizationVerifier.derive(store, task, "c.ts", "modify"));
  });
  test("multiple valid forward paths select one proof without duplicate edges", () => {
    write("a.ts", "import './b'; import './c';");
    expect(close("c.ts").valid).toBe(true);
    const task = intent();
    const proof = TaskRootedAuthorizationVerifier.derive(store, task, "c.ts", "modify")!;
    expect(proof.edgeEvidenceIds).toHaveLength(2);
    expect(new Set(proof.edgeEvidenceIds).size).toBe(2);
    expect(TaskRootedAuthorizationVerifier.verify(store, task, { ...proof, rootEvidenceId: "forged" })).toBe(false);
    expect(TaskRootedAuthorizationVerifier.verify(store, task, { ...proof, edgeEvidenceIds: [...proof.edgeEvidenceIds].reverse() })).toBe(false);
  });
  test("P6 P8: stale chain and stale capability issuance fail closed", () => {
    const task = intent();
    const result = close("c.ts", "modify", task);
    expect(result.valid).toBe(true);
    const proof = TaskRootedAuthorizationVerifier.derive(store, task, "c.ts", "modify")!;
    write("b.ts", "export const b = 2;");
    expect(TaskRootedAuthorizationVerifier.verify(store, task, proof)).toBe(false);
    const base = AuthorizedCapabilityScope.fromIsolatedWorktree({ workspaceRoot: root, authorityId: "base", repositoryId: "repo", runId: "run", grants: [] })!;
    expect(base.deriveExecutionScope(result.result.evidenceAuthorization, { stageId: "stage" })).toBeNull();
  });
  test("P6: revision change after guard creation rejects first use", () => {
    const result = close("c.ts");
    const base = AuthorizedCapabilityScope.fromIsolatedWorktree({ workspaceRoot: root, authorityId: "base", repositoryId: "repo", runId: "run", grants: [] })!;
    const scope = base.deriveExecutionScope(result.result.evidenceAuthorization, { stageId: "stage" })!;
    const guard = CapabilityGuard.create({ workspaceRoot: root, scopeId: "scope", authorizedScope: scope });
    write("a.ts", "export const a = 9;");
    expect(guard.authorize({ path: "c.ts", action: "FILE_MODIFY", scopeId: "scope" }).allowed).toBe(false);
  });
  test("P6: mutation boundary rejects changes after successful authorization preflight", () => {
    const result = close("c.ts");
    const base = AuthorizedCapabilityScope.fromIsolatedWorktree({ workspaceRoot: root, authorityId: "base", repositoryId: "repo", runId: "run", grants: [] })!;
    const scope = base.deriveExecutionScope(result.result.evidenceAuthorization, { stageId: "stage" })!;
    const guard = CapabilityGuard.create({ workspaceRoot: root, scopeId: "scope", authorizedScope: scope });
    expect(guard.authorize({ path: "c.ts", action: "FILE_MODIFY", scopeId: "scope" }).allowed).toBe(true);
    write("a.ts", "export const a = 7;");
    expect(guard.beginMutation()).toBe(false);
  });
  test("verified route proof reaches the production filesystem writer", async () => {
    const result = close("c.ts");
    const base = AuthorizedCapabilityScope.fromIsolatedWorktree({ workspaceRoot: root, authorityId: "base", repositoryId: "repo", runId: "run", grants: [] })!;
    const scope = base.deriveExecutionScope(result.result.evidenceAuthorization, { stageId: "stage" })!;
    const guard = CapabilityGuard.create({ workspaceRoot: root, scopeId: "scope", authorizedScope: scope });
    const manager = new FileSystemStateManager(guard, "scope");
    await manager.apply([{ path: "c.ts", action: "modify", content: "export const c = 2;", description: "rooted repair" }], root);
    expect(fs.readFileSync(path.join(root, "c.ts"), "utf8")).toBe("export const c = 2;");
    expect(fs.readFileSync(path.join(root, "billing.ts"), "utf8")).toBe("export const billing = 1;");
  });
  test("P9: delete requires destructive policy and independently explicit target", () => {
    write("unrelated.ts", "export const unrelated = 1;");
    expect(close("billing.ts", "delete", intent("Delete billing.ts")).valid).toBe(false);
    const task = createTaskIntentSpec("Delete billing.ts", { ...classification, taskType: "DELETE_FILE", intent: "DELETE_FILE" });
    expect(close("billing.ts", "delete", task).valid).toBe(true);
  });
  test("DELETE rejects a missing or unrooted importer cleanup", () => {
    const task = createTaskIntentSpec("Delete billing.ts", { ...classification, taskType: "DELETE_FILE", intent: "DELETE_FILE" });
    expect(close("billing.ts", "delete", task).result.rejectedPaths[0].reason).toContain("REJECT_DEPENDENCY");
  });
  test("CREATE is limited to independently explicit prospective scope", () => {
    expect(close("new.ts", "create").valid).toBe(false);
    expect(close("new.ts", "create", intent("Create new.ts")).valid).toBe(true);
  });
  test("filesystem paths in user text do not also become runtime route hints", () => {
    expect(TaskAnchorResolver.extractRuntimeRouteHints(intent("Modify src/app/projects/page.tsx"))).toEqual([]);
  });
  test("advisory deduplication cannot promote forged metadata", () => {
    const advisory = store.addEvidence({ kind: "FILE", filePath: "a.ts", provenance: "REPO_READ", metadata: { deterministicTaskAnchor: true } });
    const observed = store.observeRepository({ kind: "FILE", filePath: "a.ts", provenance: "REPO_READ" });
    expect(observed.id).not.toBe(advisory.id);
    expect(store.isAuthorityEligible(advisory)).toBe(false);
    expect(observed.metadata?.deterministicTaskAnchor).toBeUndefined();
  });
  test("P5: junction/symlink escape rejects observations, imports and prospective creates", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "anka-outside-"));
    try {
      fs.writeFileSync(path.join(outside, "secret.ts"), "export const secret = 1;");
      fs.symlinkSync(outside, path.join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
      write("a.ts", "import './linked/secret';");
      expect(repositoryPath(root, "linked/secret.ts")).toBeNull();
      expect(repositoryPath(root, "linked/new/deep.ts", true)).toBeNull();
      expect(repositoryPath(root, `../${path.basename(outside)}/secret.ts`)).toBeNull();
      expect(resolveLocalImportEdges(root, "a.ts")).toEqual([]);
      expect(store.isAuthorityEligible(store.observeRepository({ kind: "FILE", filePath: "linked/secret.ts", provenance: "REPO_READ" }))).toBe(false);
    } finally {
      fs.unlinkSync(path.join(root, "linked"));
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
  test("P5: aliases and inherited configs cannot escape the repository", () => {
    write("tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@bad/*": ["../outside/*"] } } }));
    write("a.ts", "import '@bad/secret';");
    expect(resolveLocalImportEdges(root, "a.ts")).toEqual([]);
    write("tsconfig.json", JSON.stringify({ extends: "../tsconfig.json" }));
    write("a.ts", "import './b';");
    expect(resolveLocalImportEdges(root, "a.ts")).toEqual([]);
  });
  test("nearest config supports TypeScript extends, inherited aliases and fallback paths", () => {
    write("config/base.json", JSON.stringify({ compilerOptions: { baseUrl: "..", paths: { "@data/*": ["missing/*", "*"] } } }));
    write("packages/feature/tsconfig.json", JSON.stringify({ extends: "../../config/base.json" }));
    write("packages/feature/main.ts", "import '@data/b';");
    expect(resolveLocalImportEdges(root, "packages/feature/main.ts").map((e) => e.targetFile)).toEqual(["b.ts"]);
  });
  test.each([
    ["app/projects/fixed/page.tsx", "app/projects/[id]/page.tsx", "/projects/fixed", "app/projects/fixed/page.tsx"],
    ["app/projects/[id]/page.tsx", "app/projects/[...slug]/page.tsx", "/projects/a", "app/projects/[id]/page.tsx"],
  ])("P10: deterministic route precedence %s over %s", (a, b, route, selected) => {
    expect(selectFrameworkRoutes([describeFrameworkRoute(a)!, describeFrameworkRoute(b)!], route).map((d) => d.filePath)).toEqual([selected]);
  });
  test("P10: parallel slots and special Pages files are not independent URL anchors", () => {
    for (const file of ["app/projects/@modal/page.tsx", "pages/404.tsx", "pages/500.js", "pages/_app.tsx", "pages/_document.js", "pages/_error.tsx"]) expect(describeFrameworkRoute(file)).toBeNull();
  });
  test("P10: equal route precedence fails closed through production closure", () => {
    write("app/(other)/projects/[slug]/page.tsx", "import '../../../../a';");
    expect(close("a.ts").valid).toBe(false);
  });
  test.each([
    ["middleware.ts", "export default function middleware() {}"],
    ["next.config.js", "module.exports = { rewrites: [] }"],
    ["next.config.ts", "const config = {}; config.rewrites = []; export default config;"],
    ["next.config.mjs", "export default withPlugin({});"],
    ["next.config.js", "import './custom-routing'; export default {};"],
    ["next.config.js", "const config = {}; config.basePath += '/prefix'; export default config;"],
    ["next.config.js", "export default { __proto__: { basePath: '/prefix' } };"],
  ])("unsupported routing configuration fails closed: %s", (file, content) => {
    write(file, content);
    expect(close("a.ts").valid).toBe(false);
  });
  test("ordinary static Next config preserves deterministic route discovery", () => {
    write("next.config.ts", "import type { NextConfig } from 'next'; const config: NextConfig = { reactStrictMode: true }; export default config;");
    expect(close("a.ts").valid).toBe(true);
  });
  test("route precedence does not guess between separate monorepo applications", () => {
    write("packages/other/app/projects/proj-1/page.tsx", "export default function Page() { return null; }");
    expect(close("a.ts").valid).toBe(false);
  });
  test("route normalization preserves segment semantics", () => {
    expect(frameworkRouteMatches("/projects/[id]", "https://example.test/projects/abc/?q=x#item")).toBe(true);
    expect(frameworkRouteMatches("/projects/[id]", "/projects/%61bc")).toBe(true);
    for (const route of ["/projects//abc", "/projects/%2F", "/projects/%5C", "/projects/%00", "/projects/%ZZ"]) expect(frameworkRouteMatches("/projects/[id]", route)).toBe(false);
  });
  test.each(["export const claimed = ;", "function outer() { const claimed = 1; }", "class Outer { claimed() {} }", "export { claimed } from './b';"])("malformed/nested/re-export ownership rejected: %s", (content) => {
    write("billing.ts", content);
    expect(fileDefinesSymbol(root, "billing.ts", "claimed")).toBe(false);
    expect(store.isAuthorityEligible(store.observeRepository({ kind: "SYMBOL", filePath: "billing.ts", symbol: "claimed", provenance: "AST_GRAPH" }))).toBe(false);
  });
  test.each(["export function claimed() {}", "export class claimed {}", "export const claimed = 1;", "export interface claimed {}", "export type claimed = string;", "export enum claimed { A }", "const own = 1; export { own as claimed };"])("module declaration accepted: %s", (content) => {
    write("billing.ts", content);
    expect(fileDefinesSymbol(root, "billing.ts", "claimed")).toBe(true);
  });
  test("same symbol in multiple modules cannot transfer authority", () => {
    write("b.ts", "export const claimed = 1;");
    write("billing.ts", "export const claimed = 2;");
    store.observeRepository({ kind: "SYMBOL", filePath: "billing.ts", symbol: "claimed", provenance: "AST_GRAPH" });
    expect(close("billing.ts").valid).toBe(false);
  });
  test("destructive hydration stores importer -> deleted target through the real store", () => {
    write("components/Calculator.tsx", "export const Calculator = () => null;");
    write("app.tsx", "import { Calculator } from './components/Calculator'; export const App = () => Calculator();");
    const result = DestructiveTargetResolver.resolve("remove the calculator", files(), { isDestructive: true, evidenceStore: store, repositoryId: "repo", localPath: root });
    expect(result.status).toBe("RESOLVED");
    expect(store.getAllEvidence().some((e) => e.kind === "IMPORT" && e.sourceFile === "app.tsx" && e.filePath === "components/Calculator.tsx" && store.isAuthorityEligible(e))).toBe(true);
  });
  test("current diagnostic roots authorize, forged or stale diagnostics do not", () => {
    const parsed = DiagnosticNormalizer.normalize("a.ts(1,1): error TS2322: Type mismatch", { workspaceRoot: root, repositoryId: "repo" });
    expect(DiagnosticNormalizer.ingestSourceDiagnostics(parsed, store)).toHaveLength(1);
    expect(close("b.ts", "modify", intent("Repair build errors")).valid).toBe(true);
    const fake = store.observeRepository({ kind: "DIAGNOSTIC", filePath: "billing.ts", provenance: "BUILD_DIAGNOSTIC", metadata: { stale: false } });
    expect(store.isAuthorityEligible(fake)).toBe(false);
    write("a.ts", "export const a = 3;");
    expect(DiagnosticNormalizer.ingestSourceDiagnostics(parsed, store)).toHaveLength(0);
    expect(close("b.ts", "modify", intent("Repair build errors")).valid).toBe(false);
  });
  test("diagnostic revocation invalidates an issued artifact without changing disk bytes", () => {
    const diagnostics = DiagnosticNormalizer.normalize("a.ts(1,1): error TS2322: Type mismatch", { workspaceRoot: root });
    DiagnosticNormalizer.ingestSourceDiagnostics(diagnostics, store);
    const result = close("b.ts", "modify", intent("Repair build errors"));
    expect(result.valid).toBe(true);
    store.markDiagnosticStale();
    const base = AuthorizedCapabilityScope.fromIsolatedWorktree({ workspaceRoot: root, authorityId: "base", repositoryId: "repo", runId: "run", grants: [] })!;
    expect(base.deriveExecutionScope(result.result.evidenceAuthorization, { stageId: "stage" })).toBeNull();
  });
  test("fresh reacquisition does not automatically cite stale receipts", () => {
    expect(close("c.ts").valid).toBe(true);
    write("a.ts", "import './b'; export const a = 2;");
    expect(close("c.ts").valid).toBe(true);
  });
  test.each(["FILE", "IMPORT", "SYMBOL"] as const)("readiness rejects unrelated %s", async (kind) => {
    store.observeRepository({ kind, filePath: "billing.ts", sourceFile: kind === "IMPORT" ? "unrelated.ts" : undefined, symbol: kind === "SYMBOL" ? "billing" : undefined, provenance: "AST_GRAPH" });
    const engine = new RepositoryToolEngine(files().map((file) => ({ path: file, content: fs.readFileSync(path.join(root, file), "utf8") })), root);
    const agent = new RepositoryInvestigationAgent({ toolEngine: engine, evidenceStore: store, intentSpec: intent("Repair records"), localPath: root, maxRounds: 1 });
    expect((await agent.investigate()).readyToPlan).toBe(false);
  });
  test("mixed-revision citations are rejected even with a fresh rooted path", () => {
    const old = store.observeRepository({ kind: "FILE", filePath: "c.ts", provenance: "REPO_READ" });
    write("a.ts", "import './b'; export const a = 7;");
    expect(close("c.ts").valid).toBe(true);
    const result = EvidenceBoundWriteSetResolver.resolve({ policy, intentSpec: intent(), evidenceStore: store, existingFiles: files(),
      proposedChanges: [{ path: "c.ts", action: "modify", reason: "mixed receipts", evidenceIds: [old.id], dependencies: [] }] });
    expect(result.approvedPaths).toEqual([]);
    expect(result.rejectedPaths[0].reason).toContain("STALE_AUTHORITY_EVIDENCE");
  });
  test("rooted CREATE preserves required integration rejection", () => {
    const task = intent("Create new.ts and update billing.ts");
    expect(close("new.ts", "create", task).valid).toBe(true);
    const evidence = store.getEvidenceForFile("new.ts").find((e) => store.isAuthorityEligible(e))!;
    const result = EvidenceBoundWriteSetResolver.resolve({ policy, intentSpec: task, evidenceStore: store, existingFiles: files(),
      proposedChanges: [
        { path: "new.ts", action: "create", reason: "new", evidenceIds: [evidence.id], dependencies: [], integration: { required: true, satisfiedBy: ["billing.ts"] } },
        { path: "billing.ts", action: "modify", reason: "integrator", evidenceIds: ["invented"], dependencies: [] },
      ] });
    expect(result.approvedPaths).toEqual([]);
    expect(result.rejectedPaths.find((r) => r.path === "new.ts")?.reason).toContain("REJECT_INTEGRATION_DEPENDENCY");
  });
  test("mutation task with an empty operation list is not ready on repository facts", async () => {
    const task = intent("Repair records"); task.operations = [];
    store.observeRepository({ kind: "FILE", filePath: "billing.ts", provenance: "REPO_READ" });
    const engine = new RepositoryToolEngine([], root);
    const agent = new RepositoryInvestigationAgent({ toolEngine: engine, evidenceStore: store, intentSpec: task, localPath: root, maxRounds: 1 });
    expect((await agent.investigate()).readyToPlan).toBe(false);
  });
  test("validation receipts do not re-stamp logs after worktree changes", async () => {
    const observation = await DiagnosticNormalizer.captureValidation(root, async () => {
      write("a.ts", "export const a = 9;");
      return { errors: "a.ts(1,1): error TS2322: Type mismatch" };
    });
    expect(DiagnosticNormalizer.ingestSourceDiagnostics(observation.diagnostics, store)).toEqual([]);
    const current = await DiagnosticNormalizer.captureValidation(root, async () => ({ errors: "a.ts(1,1): error TS2322: Type mismatch" }));
    expect(DiagnosticNormalizer.ingestSourceDiagnostics(current.diagnostics, store)).toHaveLength(1);
    write("a.ts", "export const a = 10;");
    expect(DiagnosticNormalizer.ingestSourceDiagnostics(current.diagnostics, new RepositoryEvidenceStore("repo", root))).toEqual([]);
  });
  test("private and incidental app folders cannot become route anchors", () => {
    expect(describeFrameworkRoute("app/_private/page.tsx")).toBeNull();
    expect(describeFrameworkRoute("components/app/page.tsx")).toBeNull();
    expect(describeFrameworkRoute("app/app/page.tsx")?.routePattern).toBe("/app");
  });
  test("reference search safely accepts metacharacters", () => {
    const engine = new RepositoryToolEngine([{ path: "a.ts", content: "// [ is a character" }], root);
    expect(() => engine.findReferences({ symbolName: "[" })).not.toThrow();
  });
});
