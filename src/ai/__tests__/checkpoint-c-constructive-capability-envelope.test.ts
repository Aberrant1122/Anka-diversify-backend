import fs from "fs";
import os from "os";
import path from "path";
import { authoritySnapshot } from "../repository/AuthorityWorktree";
import { RepositoryEvidenceStore } from "../repository/RepositoryEvidenceStore";
import { TaskAnchorResolver, isConstructiveFeatureRequest } from "../repository/TaskAnchorResolver";
import { createTaskIntentSpec } from "../shared/TaskIntentSpec";
import { TaskClassificationResult } from "../classification/TaskTypes";
import { detectRepositoryArchitecture } from "../planning/RepositoryArchitectureDetector";
import {
  ConstructiveCapabilityEnvelopeBuilder,
  deriveConstructiveCandidateRelation,
} from "../contracts/ConstructiveCapabilityEnvelope";
import { TaskRootedAuthorizationVerifier } from "../contracts/TaskRootedAuthorizationProof";
import { productionIsAuthorityEligible } from "./helpers/capability-test-harness";

const classification: TaskClassificationResult = {
  taskType: "NEW_FEATURE",
  intent: "NEW_FEATURE",
  risk: "LOW",
  estimatedComplexity: "SMALL",
  confidence: 1,
  requiresClarification: false,
  reasoning: "checkpoint C fixture",
};

describe("Checkpoint C constructive capability envelope", () => {
  let root: string;
  let store: RepositoryEvidenceStore;

  const write = (relativePath: string, content: string) => {
    const absolutePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content, "utf8");
  };

  const files = () => fs.readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)).replace(/\\/g, "/"));

  const intentFor = (request: string) => createTaskIntentSpec(request, classification);

  const resolveAnchors = (intent: ReturnType<typeof intentFor>) => TaskAnchorResolver.resolve({
    intentSpec: intent,
    repositoryFiles: files(),
    repositoryId: "checkpoint-c",
    workspaceRoot: root,
    evidenceStore: store,
  });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "checkpoint-c-"));
    store = new RepositoryEvidenceStore("checkpoint-c", root);
    store.isAuthorityEligible = productionIsAuthorityEligible.bind(store);
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  test("envelope is authority-zero and bound to stage, clause, workspace, and revision", () => {
    write("app/page.tsx", "export default function Page() { return null; }");
    const intent = intentFor("add a settings page");
    const snapshot = authoritySnapshot(root);
    const architecture = detectRepositoryArchitecture(files(), { dependencies: { next: "15.0.0" } });
    const envelope = ConstructiveCapabilityEnvelopeBuilder.build({
      intentSpec: intent,
      workspaceRoot: root,
      repositoryRevision: snapshot.revision,
      architecture,
    });

    expect(envelope).toMatchObject({
      directWriteAuthority: 0,
      stageId: "stage-1",
      repositoryRevision: snapshot.revision,
      userClauseId: "clause-1",
      workspaceRoot: path.resolve(root),
    });
    expect(envelope?.facts.integrationSurfaces).toContain("app/page.tsx");
  });

  test("Next App Router derives an exact ROUTE proof for a greenfield feature", () => {
    write("app/page.tsx", "export default function Page() { return null; }");
    write("app/layout.tsx", "export default function Layout({ children }: any) { return children; }");
    write("package.json", JSON.stringify({ dependencies: { next: "15.0.0" } }));
    const intent = intentFor("add a settings page");
    resolveAnchors(intent);

    const proof = TaskRootedAuthorizationVerifier.derive(store, intent, "app/settings/page.tsx", "create");

    expect(proof?.constructiveRelation).toMatchObject({
      candidatePath: "app/settings/page.tsx",
      role: "ROUTE",
      architectureRoot: "app",
      integrationSurface: "app/page.tsx",
      semanticTokens: ["setting"],
    });
    expect(proof?.rootEvidenceId).toBeTruthy();
    expect(TaskRootedAuthorizationVerifier.verify(store, intent, proof!)).toBe(true);
  });

  test("component CREATE survives through a typed COMPONENT relation", () => {
    write("app/page.tsx", "export default function Page() { return null; }");
    const intent = intentFor("add a todo list");
    resolveAnchors(intent);

    const proof = TaskRootedAuthorizationVerifier.derive(store, intent, "app/components/TodoList.tsx", "create");
    expect(proof?.constructiveRelation).toMatchObject({ role: "COMPONENT", semanticTokens: ["todo"] });
  });

  test("Vite uses the same generic COMPONENT relation", () => {
    write("src/App.tsx", "export const App = () => null;");
    write("src/main.tsx", "import { App } from './App'; void App;");
    write("package.json", JSON.stringify({ devDependencies: { vite: "7.0.0" } }));
    const intent = intentFor("add a todo list");
    resolveAnchors(intent);

    const proof = TaskRootedAuthorizationVerifier.derive(store, intent, "src/components/TodoList.tsx", "create");
    expect(proof?.constructiveRelation).toMatchObject({ role: "COMPONENT", architectureRoot: "src/components" });
  });

  test("Express exposes only an observed route directory as a MODULE region", () => {
    write("src/index.ts", "import express from 'express'; express();");
    write("src/routes/health.ts", "export const health = true;");
    write("package.json", JSON.stringify({ dependencies: { express: "5.0.0" } }));
    const intent = intentFor("add a todos API endpoint");
    expect(isConstructiveFeatureRequest(intent)).toBe(true);
    resolveAnchors(intent);

    const architecture = detectRepositoryArchitecture(files(), fs.readFileSync(path.join(root, "package.json"), "utf8"));
    const envelope = ConstructiveCapabilityEnvelopeBuilder.build({
      intentSpec: intent,
      workspaceRoot: root,
      repositoryRevision: authoritySnapshot(root).revision,
      architecture,
    });
    expect(architecture.constructiveFacts?.moduleRegions).toHaveLength(1);
    expect(deriveConstructiveCandidateRelation(envelope!, "src/routes/todos.ts")?.role).toBe("MODULE");
    expect(TaskRootedAuthorizationVerifier.roots(store, intent).map((rootEvidence) => rootEvidence.filePath)).toContain("src/index.ts");

    const proof = TaskRootedAuthorizationVerifier.derive(store, intent, "src/routes/todos.ts", "create");
    expect(proof?.constructiveRelation).toMatchObject({
      role: "MODULE",
      architectureRoot: "src/routes",
      integrationSurface: "src/index.ts",
      semanticTokens: ["todo"],
    });
    expect(TaskRootedAuthorizationVerifier.derive(store, intent, "src/controllers/todos.ts", "create")).toBeNull();
  });

  test("source-root membership and token overlap do not grant CREATE authority", () => {
    write("src/App.tsx", "export const App = () => null;");
    write("src/main.tsx", "import { App } from './App'; void App;");
    write("package.json", JSON.stringify({ devDependencies: { vite: "7.0.0" } }));
    const intent = intentFor("add a todo list");
    resolveAnchors(intent);

    expect(TaskRootedAuthorizationVerifier.derive(store, intent, "src/admin/Todo.tsx", "create")).toBeNull();
    expect(TaskRootedAuthorizationVerifier.derive(store, intent, "src/components/TodoAnalytics.tsx", "create")).toBeNull();
    expect(TaskRootedAuthorizationVerifier.derive(store, intent, ".env", "create")).toBeNull();
  });

  test("relation depth is bounded relative to its architecture root, not repository depth", () => {
    const existing = ["apps/web/src/app/page.tsx"];
    const architecture = detectRepositoryArchitecture(existing, { dependencies: { next: "15.0.0" } });
    const intent = intentFor("add a settings page");
    const envelope = ConstructiveCapabilityEnvelopeBuilder.build({
      intentSpec: intent,
      workspaceRoot: root,
      repositoryRevision: "revision-1",
      architecture,
    });

    expect(deriveConstructiveCandidateRelation(envelope!, "apps/web/src/app/settings/page.tsx")?.role).toBe("ROUTE");
    expect(deriveConstructiveCandidateRelation(envelope!, "apps/web/src/app/a/b/c/d/e/f/g/h/page.tsx")).toBeNull();
  });

  test("CREATE is rejected when the exact candidate already exists", () => {
    write("app/page.tsx", "export default function Page() { return null; }");
    write("app/settings/page.tsx", "export default function Settings() { return null; }");
    const intent = intentFor("add a settings page");
    resolveAnchors(intent);

    expect(TaskRootedAuthorizationVerifier.derive(store, intent, "app/settings/page.tsx", "create")).toBeNull();
  });
});
