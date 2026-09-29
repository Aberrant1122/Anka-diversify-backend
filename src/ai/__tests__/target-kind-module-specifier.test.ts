import type { ExecutionContract, FileManifest, ProspectiveFeatureGraphProposal } from "../../types";
import { ManifestValidator } from "../../services/manifest-validator";
import { canonicalizeProspectiveFeatureGraph } from "../planning/ProspectiveFeatureGraph";
import { detectRepositoryArchitecture } from "../planning/RepositoryArchitectureDetector";
import { ManifestDependencyResolver } from "../planning/ManifestDependencyResolver";
import { MonorepoDetector } from "../workspace/MonorepoDetector";

function resolverFor(existingFiles: string[], manifestFiles: string[] = []): ManifestDependencyResolver {
  return new ManifestDependencyResolver({ existingFiles, manifestFiles, installedPackages: [] });
}

function expectRoundTrip(resolver: ManifestDependencyResolver, owner: string, target: string, expected: string): void {
  const specifier = resolver.canonicalSpecifierFor(owner, target);
  expect(specifier).toBe(expected);
  expect(resolver.resolve(owner, { value: specifier!, intent: "REPOSITORY" })).toMatchObject({
    classification: "REPOSITORY",
    resolvedPath: target,
  });
}

describe("target-kind-aware canonical module specifiers", () => {
  test.each([
    ["app/items/ItemList.tsx", "app/items/items.module.css", "./items.module.css"],
    ["components/items/ItemList.tsx", "components/items/items.module.css", "./items.module.css"],
    ["src/App.tsx", "src/styles.css", "./styles.css"],
    ["src/App.tsx", "src/theme.scss", "./theme.scss"],
    ["app/items/page.tsx", "app/items/items.types.ts", "./items.types"],
    ["app/items/page.tsx", "app/items/api.server.ts", "./api.server"],
    ["src/App.tsx", "src/foo.ts", "./foo"],
    ["src/App.tsx", "src/Foo.tsx", "./Foo"],
    ["src/App.tsx", "src/lib/index.ts", "./lib"],
    ["src/App.tsx", "src/widgets/index.tsx", "./widgets"],
    ["app/items/page.tsx", "components/ItemList.tsx", "../../components/ItemList"],
    ["src/components/ItemList.tsx", "app/items/items.module.css", "../../app/items/items.module.css"],
    ["src/App.tsx", "src/data/config.json", "./data/config.json"],
    ["src/App.tsx", "src/theme/index.css", "./theme/index.css"],
    ["src/App.tsx", "src/types.d.ts", "./types.d"],
    ["src/App.tsx", "src/worker.mjs", "./worker"],
  ])("%s -> %s projects %s and round-trips to the exact target", (owner, target, expected) => {
    expectRoundTrip(resolverFor([owner, target]), owner, target, expected);
  });

  test("prospective manifest targets round-trip like existing files", () => {
    const resolver = resolverFor([], ["app/items/ItemList.tsx", "app/items/items.module.css"]);
    expectRoundTrip(resolver, "app/items/ItemList.tsx", "app/items/items.module.css", "./items.module.css");
  });

  test("a same-stem stylesheet does not shadow the code module target", () => {
    const resolver = resolverFor(["src/Button.css", "src/Button.tsx", "src/App.tsx"]);
    expectRoundTrip(resolver, "src/App.tsx", "src/Button.tsx", "./Button");
    expectRoundTrip(resolver, "src/App.tsx", "src/Button.css", "./Button.css");
  });

  test("asset extensions are never guessed from a dotted specifier", () => {
    const resolver = resolverFor(["app/items/ItemList.tsx", "app/items/items.module.css"]);
    expect(resolver.resolve("app/items/ItemList.tsx", { value: "./items.module", intent: "REPOSITORY" }).classification)
      .toBe("UNRESOLVED_LOCAL");
  });

  test("a dotted code specifier cannot resolve to a stylesheet sharing its stem", () => {
    const resolver = resolverFor(["src/App.tsx", "src/items.module.css", "src/items.module.ts"]);
    expect(resolver.resolve("src/App.tsx", { value: "./items.module", intent: "REPOSITORY" })).toMatchObject({
      classification: "REPOSITORY",
      resolvedPath: "src/items.module.ts",
    });
    expectRoundTrip(resolver, "src/App.tsx", "src/items.module.css", "./items.module.css");
  });

  test("outside-repository targets are rejected", () => {
    const resolver = resolverFor(["app/page.tsx", "app/styles.css"]);
    expect(resolver.canonicalSpecifierFor("app/page.tsx", "../other/styles.css")).toBeNull();
    expect(resolver.canonicalSpecifierFor("app/page.tsx", "../../outside/Widget.tsx")).toBeNull();
  });

  test("unknown or missing targets are rejected", () => {
    const resolver = resolverFor(["app/page.tsx", "app/items.module.css"]);
    expect(resolver.canonicalSpecifierFor("app/page.tsx", "app/missing.module.css")).toBeNull();
    expect(resolver.canonicalSpecifierFor("app/page.tsx", "app/items.module.scss")).toBeNull();
    expect(resolver.canonicalSpecifierFor("app/page.tsx", "app/items.module")).toBeNull();
  });

  test.each([
    [["src/App.tsx", "src/format.ts", "src/format/index.ts"], "src/format.ts"],
    [["src/App.tsx", "src/format/index.ts", "src/format.ts"], "src/format.ts"],
    [["src/App.tsx", "src/Widget.ts", "src/Widget.tsx"], "src/Widget.tsx"],
    [["src/App.tsx", "src/Widget.tsx", "src/Widget.ts"], "src/Widget.tsx"],
  ])("ambiguous extensionless code targets are rejected regardless of file order (%j)", (files, target) => {
    const resolver = resolverFor(files);
    expect(resolver.canonicalSpecifierFor("src/App.tsx", target)).toBeNull();
    expect(resolver.resolve("src/App.tsx", { value: `./${target.slice(4).replace(/\.tsx?$/, "")}`, intent: "REPOSITORY" }).classification)
      .toBe("UNRESOLVED_LOCAL");
  });

  test("legacy extensionless framework component resolution is preserved", () => {
    const resolver = resolverFor(["src/features/Foo.svelte"]);
    expect(resolver.resolve("src/features/Host.ts", { value: "./Foo", intent: "LEGACY" })).toMatchObject({
      classification: "REPOSITORY",
      resolvedPath: "src/features/Foo.svelte",
    });
  });
});

describe("target-kind-aware specifiers across workspaces", () => {
  function monorepoResolver(webDependencies: Record<string, string>) {
    const snapshot = [
      { path: "package.json", content: JSON.stringify({ private: true, workspaces: ["apps/*", "packages/*"] }) },
      { path: "apps/web/package.json", content: JSON.stringify({ name: "@repo/web", dependencies: webDependencies }) },
      { path: "apps/web/src/page.tsx", content: "" },
      { path: "packages/ui/package.json", content: JSON.stringify({ name: "@repo/ui" }) },
      { path: "packages/ui/src/Button.tsx", content: "" },
      { path: "packages/ui/src/button.module.css", content: "" },
      { path: "packages/ui/src/button.types.ts", content: "" },
    ];
    return new ManifestDependencyResolver({
      existingFiles: snapshot.map((file) => file.path),
      manifestFiles: [],
      installedPackages: [],
      monorepo: MonorepoDetector.detectMonorepo(null, snapshot),
    });
  }

  test("declared workspace dependency preserves stylesheet extensions and strips code extensions", () => {
    const resolver = monorepoResolver({ "@repo/ui": "*" });
    expect(resolver.canonicalSpecifierFor("apps/web/src/page.tsx", "packages/ui/src/button.module.css")).toBe("@repo/ui/button.module.css");
    expect(resolver.canonicalSpecifierFor("apps/web/src/page.tsx", "packages/ui/src/button.types.ts")).toBe("@repo/ui/button.types");
    expect(resolver.canonicalSpecifierFor("apps/web/src/page.tsx", "packages/ui/src/Button.tsx")).toBe("@repo/ui/Button");
  });

  test("undeclared workspace targets stay rejected even though a relative path exists", () => {
    const resolver = monorepoResolver({});
    expect(resolver.canonicalSpecifierFor("apps/web/src/page.tsx", "packages/ui/src/button.module.css")).toBeNull();
    expect(resolver.canonicalSpecifierFor("apps/web/src/page.tsx", "packages/ui/src/button.types.ts")).toBeNull();
  });
});

describe("prospective feature graph with stylesheet and multi-dot targets", () => {
  const nextExisting = ["package.json", "app/layout.tsx", "app/page.tsx", "lib/format.ts", "lib/format/index.ts"];
  const nextArchitecture = detectRepositoryArchitecture(nextExisting, { dependencies: { next: "15.0.0", react: "19.0.0" } });
  const binding = {
    stageId: "stage-items",
    userClauseId: "clause-items",
    workspaceRoot: "C:/workspace/application",
    repositoryRevision: "revision-1",
  };
  const nextContext = { ...binding, existingFiles: nextExisting, architecture: nextArchitecture, installedPackages: nextArchitecture.installedPackages };

  function manifestFor(paths: string[], topology: ProspectiveFeatureGraphProposal): FileManifest {
    return {
      files: paths.map((path) => ({ path, action: "create" as const, dependencies: [], description: path })),
      totalFiles: paths.length,
      manifestVersion: "1.0.0",
      prospectiveTopology: topology,
    };
  }

  function featureGraph(listPath: string, stylePath: string, typesPath = "app/items/items.types.ts"): ProspectiveFeatureGraphProposal {
    return {
      nodes: [
        { temporaryId: "route", path: "app/items/page.tsx", kind: "PROSPECTIVE", role: "ROUTE" },
        { temporaryId: "list", path: listPath, kind: "PROSPECTIVE", role: "COMPONENT", symbol: "ItemList" },
        { temporaryId: "style", path: stylePath, kind: "PROSPECTIVE", role: "MODULE" },
        { temporaryId: "types", path: typesPath, kind: "PROSPECTIVE", role: "MODULE" },
      ],
      edges: [
        { sourceId: "route", targetId: "list", relation: "RENDERS" },
        { sourceId: "route", targetId: "types", relation: "IMPORTS" },
        { sourceId: "list", targetId: "style", relation: "IMPORTS" },
        { sourceId: "list", targetId: "types", relation: "IMPORTS" },
      ],
      featureRoots: ["route"],
    };
  }

  function canonicalize(listPath: string, stylePath: string) {
    const graph = featureGraph(listPath, stylePath);
    const manifest = manifestFor(graph.nodes.map((node) => node.path), graph);
    return { manifest, result: canonicalizeProspectiveFeatureGraph(graph, manifest, nextContext) };
  }

  function specifierFor(result: ReturnType<typeof canonicalizeProspectiveFeatureGraph>, source: string, target: string) {
    const sourceId = result.graph?.nodes.find((node) => node.path === source)?.id;
    return result.graph?.edges.find((edge) => edge.sourceId === sourceId && edge.canonicalTargetPath === target)?.canonicalSpecifier;
  }

  test("Next App Router feature-local component imports a prospective CSS module", () => {
    const { result } = canonicalize("app/items/ItemList.tsx", "app/items/items.module.css");
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
    expect(specifierFor(result, "app/items/ItemList.tsx", "app/items/items.module.css")).toBe("./items.module.css");
    expect(specifierFor(result, "app/items/ItemList.tsx", "app/items/items.types.ts")).toBe("./items.types");
    expect(specifierFor(result, "app/items/page.tsx", "app/items/ItemList.tsx")).toBe("./ItemList");
    expect(specifierFor(result, "app/items/page.tsx", "app/items/items.types.ts")).toBe("./items.types");
  });

  test("shared component with a colocated CSS module is valid", () => {
    const { result } = canonicalize("components/items/ItemList.tsx", "components/items/items.module.css");
    expect(result.valid).toBe(true);
    expect(specifierFor(result, "app/items/page.tsx", "components/items/ItemList.tsx")).toBe("../../components/items/ItemList");
    expect(specifierFor(result, "components/items/ItemList.tsx", "components/items/items.module.css")).toBe("./items.module.css");
  });

  test("cross-region CSS module import is valid with a deterministic relative specifier", () => {
    const { result } = canonicalize("src/components/ItemList.tsx", "app/items/items.module.css");
    expect(result.errors).toEqual([]);
    expect(specifierFor(result, "src/components/ItemList.tsx", "app/items/items.module.css")).toBe("../../app/items/items.module.css");
  });

  test("ManifestValidator accepts the canonical CSS module edge", () => {
    const contract: ExecutionContract = {
      goal: "Add items feature",
      taskType: "NEW_FEATURE",
      risk: "MEDIUM",
      estimatedComplexity: "MEDIUM",
      pipeline: "REPOSITORY",
      environment: "REACT_TS",
      repositoryRequired: true,
      expectedFiles: [],
      validationType: "TYPESCRIPT_BUILD",
      allowedActions: ["create", "modify"],
      forbiddenActions: [],
      maxFiles: 8,
      targetPaths: ["project-wide"],
      searchScope: ["project-wide"],
      contextScope: ["project-wide"],
      diffCriticEnabled: true,
    };
    const { manifest } = canonicalize("app/items/ItemList.tsx", "app/items/items.module.css");
    const result = new ManifestValidator(contract, { existingFiles: nextExisting, architecture: nextArchitecture, graphBinding: binding }).validate(manifest);
    expect(result.errors).toEqual([]);
    expect(result.verifiedTopology?.edges.some((edge) => edge.canonicalSpecifier === "./items.module.css")).toBe(true);
  });

  test("disconnected CSS module node is rejected", () => {
    const graph = featureGraph("app/items/ItemList.tsx", "app/items/items.module.css");
    graph.edges = graph.edges.filter((edge) => edge.targetId !== "style");
    const result = canonicalizeProspectiveFeatureGraph(graph, manifestFor(graph.nodes.map((node) => node.path), graph), nextContext);
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.message.includes("disconnected") && error.affectedFiles.includes("app/items/items.module.css"))).toBe(true);
  });

  test("missing stylesheet targets are rejected", () => {
    const graph = featureGraph("app/items/ItemList.tsx", "app/items/items.module.css");
    const undeclared = manifestFor(graph.nodes.map((node) => node.path).filter((path) => !path.endsWith(".css")), graph);
    expect(canonicalizeProspectiveFeatureGraph(graph, undeclared, nextContext).valid).toBe(false);

    const existingClaim = featureGraph("app/items/ItemList.tsx", "app/items/items.module.css");
    existingClaim.nodes[2] = { ...existingClaim.nodes[2], kind: "EXISTING", role: "EXISTING_DEPENDENCY" };
    const existingManifest = manifestFor(existingClaim.nodes.filter((node) => node.kind === "PROSPECTIVE").map((node) => node.path), existingClaim);
    const result = canonicalizeProspectiveFeatureGraph(existingClaim, existingManifest, nextContext);
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.message.includes("does not exist"))).toBe(true);
  });

  test("ambiguous code dependency is rejected", () => {
    const graph = featureGraph("app/items/ItemList.tsx", "app/items/items.module.css");
    graph.nodes.push({ temporaryId: "format", path: "lib/format.ts", kind: "EXISTING", role: "EXISTING_DEPENDENCY" });
    graph.edges.push({ sourceId: "list", targetId: "format", relation: "IMPORTS" });
    const result = canonicalizeProspectiveFeatureGraph(graph, manifestFor(["app/items/page.tsx", "app/items/ItemList.tsx", "app/items/items.module.css", "app/items/items.types.ts"], graph), nextContext);
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.message.includes("No deterministic module specifier") && error.affectedFiles.includes("lib/format.ts"))).toBe(true);
  });

  test("Vite component imports a colocated CSS module and plain stylesheet", () => {
    const viteFiles = ["package.json", "src/main.tsx", "src/App.tsx", "src/index.css"];
    const viteArchitecture = detectRepositoryArchitecture(viteFiles, { dependencies: { vite: "7.0.0", react: "19.0.0" } });
    const graph: ProspectiveFeatureGraphProposal = {
      nodes: [
        { temporaryId: "root", path: "src/App.tsx", kind: "EXISTING", role: "INTEGRATION_ROOT" },
        { temporaryId: "panel", path: "src/components/Panel.tsx", kind: "PROSPECTIVE", role: "COMPONENT" },
        { temporaryId: "panel-style", path: "src/components/Panel.module.css", kind: "PROSPECTIVE", role: "MODULE" },
        { temporaryId: "theme", path: "src/components/theme.scss", kind: "PROSPECTIVE", role: "MODULE" },
        { temporaryId: "global", path: "src/index.css", kind: "EXISTING", role: "EXISTING_DEPENDENCY" },
      ],
      edges: [
        { sourceId: "root", targetId: "panel", relation: "RENDERS" },
        { sourceId: "panel", targetId: "panel-style", relation: "IMPORTS" },
        { sourceId: "panel", targetId: "theme", relation: "IMPORTS" },
        { sourceId: "panel", targetId: "global", relation: "IMPORTS" },
      ],
      featureRoots: ["root"],
    };
    const manifest = manifestFor(["src/components/Panel.tsx", "src/components/Panel.module.css", "src/components/theme.scss"], graph);
    const result = canonicalizeProspectiveFeatureGraph(graph, manifest, { ...binding, existingFiles: viteFiles, architecture: viteArchitecture });
    expect(result.errors).toEqual([]);
    expect(specifierFor(result, "src/App.tsx", "src/components/Panel.tsx")).toBe("./components/Panel");
    expect(specifierFor(result, "src/components/Panel.tsx", "src/components/Panel.module.css")).toBe("./Panel.module.css");
    expect(specifierFor(result, "src/components/Panel.tsx", "src/components/theme.scss")).toBe("./theme.scss");
    expect(specifierFor(result, "src/components/Panel.tsx", "src/index.css")).toBe("../index.css");
  });
});
