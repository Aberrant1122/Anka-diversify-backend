import type { ExecutionContract, FileManifest, ProspectiveFeatureGraphProposal } from "../../types";
import { ManifestValidator } from "../../services/manifest-validator";
import { findVerifiedTopologyIssues } from "../generation/CodeGenerator";
import {
  canonicalizeProspectiveFeatureGraph,
  closeProspectiveGraphAfterAuthorization,
  validateProspectiveGraphBinding,
} from "../planning/ProspectiveFeatureGraph";
import { detectRepositoryArchitecture } from "../planning/RepositoryArchitectureDetector";
import { ManifestDependencyResolver } from "../planning/ManifestDependencyResolver";
import { MonorepoDetector } from "../workspace/MonorepoDetector";

const existingFiles = ["package.json", "app/layout.tsx", "app/page.tsx", "src/report-data.ts"];
const architecture = detectRepositoryArchitecture(existingFiles, { dependencies: { next: "15.0.0", react: "19.0.0" } });
const binding = {
  stageId: "stage-reporting",
  userClauseId: "clause-reporting",
  workspaceRoot: "C:/workspace/application",
  repositoryRevision: "revision-1",
};
const context = {
  ...binding,
  existingFiles,
  architecture,
  installedPackages: architecture.installedPackages,
};

const files: FileManifest["files"] = [
  { path: "app/reports/page.tsx", action: "create", dependencies: ["../wrong-location"], description: "Route" },
  { path: "app/reports/ReportList.tsx", action: "create", dependencies: [], description: "List" },
  { path: "app/reports/ReportRow.tsx", action: "create", dependencies: [], description: "Row" },
  { path: "app/reports/ReportForm.tsx", action: "create", dependencies: [], description: "Form" },
];

function proposal(rawImportHint = "../wrong-location"): ProspectiveFeatureGraphProposal {
  return {
    nodes: [
      { temporaryId: "model-route", path: "app/reports/page.tsx", kind: "PROSPECTIVE", role: "ROUTE" },
      { temporaryId: "model-list", path: "app/reports/ReportList.tsx", kind: "PROSPECTIVE", role: "COMPONENT", symbol: "ReportList" },
      { temporaryId: "model-row", path: "app/reports/ReportRow.tsx", kind: "PROSPECTIVE", role: "CHILD_COMPONENT", symbol: "ReportRow" },
      { temporaryId: "model-form", path: "app/reports/ReportForm.tsx", kind: "PROSPECTIVE", role: "CHILD_COMPONENT", symbol: "ReportForm" },
      { temporaryId: "model-data", path: "src/report-data.ts", kind: "EXISTING", role: "EXISTING_DEPENDENCY", symbol: "Report" },
    ],
    edges: [
      { sourceId: "model-route", targetId: "model-list", relation: "RENDERS", rawImportHint },
      { sourceId: "model-list", targetId: "model-row", relation: "RENDERS" },
      { sourceId: "model-list", targetId: "model-form", relation: "RENDERS" },
      { sourceId: "model-list", targetId: "model-data", relation: "IMPORTS", rawImportHint },
    ],
    featureRoots: ["model-route"],
  };
}

function manifest(graph = proposal()): FileManifest {
  return { files: files.map((file) => ({ ...file, dependencies: [...file.dependencies] })), totalFiles: files.length, manifestVersion: "1.0.0", prospectiveTopology: graph };
}

const contract: ExecutionContract = {
  goal: "Add reporting feature",
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

describe("Checkpoint D authority-zero prospective feature graph", () => {
  test("canonicalizes a coherent multi-file Next feature and existing dependency", () => {
    const result = canonicalizeProspectiveFeatureGraph(proposal(), manifest(), context);
    expect(result.valid).toBe(true);
    expect(result.graph?.authority).toBe(0);
    expect(result.graph?.nodes).toHaveLength(5);
    expect(result.graph?.edges).toHaveLength(4);
    expect(result.graph?.edges.find((edge) => edge.canonicalTargetPath === "src/report-data.ts")?.canonicalSpecifier).toBe("../../src/report-data");
  });

  test("backend canonical identity does not use model temporary IDs", () => {
    const result = canonicalizeProspectiveFeatureGraph(proposal(), manifest(), context);
    expect(result.graph?.nodes.every((node) => node.id.startsWith("node:") && !node.id.includes("model-"))).toBe(true);
  });

  test("wrong raw model import is non-authoritative and excluded from fingerprint", () => {
    const first = canonicalizeProspectiveFeatureGraph(proposal("../incorrect"), manifest(proposal("../incorrect")), context);
    const second = canonicalizeProspectiveFeatureGraph(proposal("@/also-incorrect"), manifest(proposal("@/also-incorrect")), context);
    expect(first.graph?.fingerprint).toBe(second.graph?.fingerprint);
    expect(first.graph?.edges.some((edge) => edge.canonicalSpecifier === "../incorrect")).toBe(false);
  });

  test("rejects an orphan supporting node before authorization", () => {
    const graph = proposal();
    graph.edges = graph.edges.filter((edge) => edge.targetId !== "model-row");
    const result = canonicalizeProspectiveFeatureGraph(graph, manifest(graph), context);
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.message.includes("disconnected"))).toBe(true);
  });

  test("accepts a valid parent renders child edge", () => {
    const result = canonicalizeProspectiveFeatureGraph(proposal(), manifest(), context);
    expect(result.graph?.edges.some((edge) => edge.relation === "RENDERS" && edge.canonicalTargetPath.endsWith("ReportRow.tsx"))).toBe(true);
  });

  test("rejects arbitrary app files declared as route roots", () => {
    const graph = proposal();
    graph.nodes[0] = { ...graph.nodes[0], path: "app/reports/helper.ts" };
    const changed = manifest(graph);
    changed.files[0] = { ...changed.files[0], path: "app/reports/helper.ts" };
    expect(canonicalizeProspectiveFeatureGraph(graph, changed, context).valid).toBe(false);
  });

  test("rejects wrong-workspace and stale-revision reuse", () => {
    const graph = canonicalizeProspectiveFeatureGraph(proposal(), manifest(), context).graph!;
    expect(validateProspectiveGraphBinding(graph, { ...binding, workspaceRoot: "C:/workspace/other" }).valid).toBe(false);
    expect(validateProspectiveGraphBinding(graph, { ...binding, repositoryRevision: "revision-2" }).disposition).toBe("FULL_STAGE_REINVESTIGATION");
  });

  test("authorization filtering cannot leave a child without its parent", () => {
    const graph = canonicalizeProspectiveFeatureGraph(proposal(), manifest(), context).graph!;
    const closure = closeProspectiveGraphAfterAuthorization(graph, [
      "app/reports/ReportList.tsx", "app/reports/ReportRow.tsx", "app/reports/ReportForm.tsx",
    ]);
    expect(closure.valid).toBe(false);
    expect(closure.disposition).toBe("FRESH_AUTHORIZATION");
  });

  test("fully authorized graph remains closed", () => {
    const graph = canonicalizeProspectiveFeatureGraph(proposal(), manifest(), context).graph!;
    expect(closeProspectiveGraphAfterAuthorization(graph, files.map((file) => file.path)).valid).toBe(true);
  });

  test("cycles remain bounded by visited canonical node identity", () => {
    const graph = proposal();
    graph.edges.push({ sourceId: "model-row", targetId: "model-list", relation: "DEPENDS_ON" });
    expect(canonicalizeProspectiveFeatureGraph(graph, manifest(graph), context).valid).toBe(true);
  });

  test("ManifestValidator treats canonical graph dependencies as primary", () => {
    const validator = new ManifestValidator(contract, {
      existingFiles,
      architecture,
      graphBinding: binding,
    });
    const result = validator.validate(manifest());
    expect(result.valid).toBe(true);
    expect(result.verifiedTopology?.authority).toBe(0);
  });

  test("generated code audit checks imports and render relationships", () => {
    const canonical = canonicalizeProspectiveFeatureGraph(proposal(), manifest(), context).graph!;
    const planned = { ...manifest(), verifiedTopology: canonical };
    const changes = [
      { path: "app/reports/page.tsx", action: "create" as const, content: 'import ReportList from "./ReportList"; export default function Page(){ return <ReportList />; }', description: "route" },
      { path: "app/reports/ReportList.tsx", action: "create" as const, content: 'import ReportRow from "./ReportRow"; import ReportForm from "./ReportForm"; import { Report } from "../../src/report-data"; export default function ReportList(){ return <><ReportRow /><ReportForm /></>; }', description: "list" },
      { path: "app/reports/ReportRow.tsx", action: "create" as const, content: "export default function ReportRow(){ return <div />; }", description: "row" },
      { path: "app/reports/ReportForm.tsx", action: "create" as const, content: "export default function ReportForm(){ return <form />; }", description: "form" },
    ];
    expect(findVerifiedTopologyIssues({ "src/report-data.ts": "export interface Report { id: string }" }, changes, planned)).toEqual([]);
    expect(findVerifiedTopologyIssues({ "src/report-data.ts": "export interface Report { id: string }" }, changes.slice(1), planned).length).toBeGreaterThan(0);
  });

  test("Vite prospective components need an existing integration root edge", () => {
    const viteFiles = ["src/main.tsx", "src/App.tsx"];
    const viteArchitecture = detectRepositoryArchitecture(viteFiles, { dependencies: { vite: "7.0.0", react: "19.0.0" } });
    const viteManifest: FileManifest = {
      files: [{ path: "src/components/ReportPanel.tsx", action: "create", dependencies: [], description: "Panel" }],
      totalFiles: 1,
      manifestVersion: "1.0.0",
      prospectiveTopology: {
        nodes: [
          { temporaryId: "root", path: "src/App.tsx", kind: "EXISTING", role: "INTEGRATION_ROOT" },
          { temporaryId: "panel", path: "src/components/ReportPanel.tsx", kind: "PROSPECTIVE", role: "COMPONENT" },
        ],
        edges: [],
        featureRoots: ["root"],
      },
    };
    const viteContext = { ...binding, existingFiles: viteFiles, architecture: viteArchitecture };
    expect(canonicalizeProspectiveFeatureGraph(viteManifest.prospectiveTopology!, viteManifest, viteContext).valid).toBe(false);
    viteManifest.prospectiveTopology!.edges.push({ sourceId: "root", targetId: "panel", relation: "RENDERS" });
    expect(canonicalizeProspectiveFeatureGraph(viteManifest.prospectiveTopology!, viteManifest, viteContext).valid).toBe(true);
  });

  test("Express prospective modules require a deterministic registration edge", () => {
    const apiFiles = ["server.ts", "src/routes/health.ts"];
    const apiArchitecture = detectRepositoryArchitecture(apiFiles, { dependencies: { express: "5.0.0" } });
    const apiManifest: FileManifest = {
      files: [{ path: "src/routes/reports.ts", action: "create", dependencies: [], description: "Reports API" }],
      totalFiles: 1,
      manifestVersion: "1.0.0",
      prospectiveTopology: {
        nodes: [
          { temporaryId: "server", path: "server.ts", kind: "EXISTING", role: "INTEGRATION_ROOT" },
          { temporaryId: "route", path: "src/routes/reports.ts", kind: "PROSPECTIVE", role: "MODULE" },
        ],
        edges: [{ sourceId: "server", targetId: "route", relation: "REGISTERS" }],
        featureRoots: ["server"],
      },
    };
    expect(canonicalizeProspectiveFeatureGraph(apiManifest.prospectiveTopology!, apiManifest, {
      ...binding, existingFiles: apiFiles, architecture: apiArchitecture,
    }).valid).toBe(true);
  });

  test("cross-workspace specifiers require a declared package dependency", () => {
    const snapshot = [
      { path: "package.json", content: JSON.stringify({ private: true, workspaces: ["apps/*", "packages/*"] }) },
      { path: "apps/web/package.json", content: JSON.stringify({ name: "@repo/web", dependencies: { "@repo/ui": "*" } }) },
      { path: "apps/web/src/page.tsx", content: "" },
      { path: "packages/ui/package.json", content: JSON.stringify({ name: "@repo/ui" }) },
      { path: "packages/ui/src/Button.tsx", content: "" },
    ];
    const monorepo = MonorepoDetector.detectMonorepo(null, snapshot);
    const resolver = new ManifestDependencyResolver({
      existingFiles: snapshot.map((file) => file.path),
      manifestFiles: [],
      installedPackages: [],
      monorepo,
    });
    expect(resolver.canonicalSpecifierFor("apps/web/src/page.tsx", "packages/ui/src/Button.tsx")).toBe("@repo/ui/Button");
  });

  test("undeclared cross-workspace dependencies fail closed", () => {
    const snapshot = [
      { path: "package.json", content: JSON.stringify({ private: true, workspaces: ["apps/*", "packages/*"] }) },
      { path: "apps/web/package.json", content: JSON.stringify({ name: "@repo/web", dependencies: {} }) },
      { path: "apps/web/src/page.tsx", content: "" },
      { path: "packages/ui/package.json", content: JSON.stringify({ name: "@repo/ui" }) },
      { path: "packages/ui/src/Button.tsx", content: "" },
    ];
    const monorepo = MonorepoDetector.detectMonorepo(null, snapshot);
    const resolver = new ManifestDependencyResolver({
      existingFiles: snapshot.map((file) => file.path),
      manifestFiles: [],
      installedPackages: [],
      monorepo,
    });
    expect(resolver.canonicalSpecifierFor("apps/web/src/page.tsx", "packages/ui/src/Button.tsx")).toBeNull();
  });

  test("legacy one-file manifests remain supported without graph metadata", () => {
    const legacy: FileManifest = {
      files: [{ path: "app/page.tsx", action: "modify", dependencies: [], description: "Update root" }],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    };
    expect(new ManifestValidator(contract, { existingFiles, architecture }).validate(legacy).valid).toBe(true);
  });
});
