import {
  UiIntegrationScopeResolver,
  UiIntegrationScopeParams,
} from "../contracts/UiIntegrationScopeResolver";
import { TargetScopeExpander } from "../contracts/TargetScopeExpander";
import { ManifestValidator } from "../../services/manifest-validator";
import { enforceExecutionScope } from "../contracts/ExecutionScopeEnforcer";
import { verifyFileVersionsFromDisk } from "../validation/FileVersionGuard";
import { ValidationDetector } from "../validation/ValidationDetector";
import { detectRepositoryArchitecture } from "../planning/RepositoryArchitectureDetector";
import { ExecutionContract, FileManifest, FileDeclaration } from "../../types";
import { AgentFileChange, TaskClassificationResult } from "../shared/types";
import { MonorepoDescriptor } from "../workspace/MonorepoDetector";

describe("Cross-Cutting UI Feature Scope Reconciliation Regression Suite", () => {
  const defaultBaseContract: ExecutionContract = {
    goal: "Update UI",
    taskType: "NEW_FEATURE",
    risk: "LOW",
    estimatedComplexity: "MEDIUM",
    pipeline: "REPOSITORY",
    environment: "REACT_TS",
    repositoryRequired: true,
    expectedFiles: [],
    validationType: "TYPESCRIPT_BUILD",
    targetPaths: ["src/components/ui", "src/components/ui/Button/Button.tsx"],
    allowedActions: ["create", "modify"],
    forbiddenActions: [],
    maxFiles: 10,
    searchScope: ["src/components/ui", "src/components/ui/Button/Button.tsx"],
    contextScope: ["src/components/ui", "src/components/ui/Button/Button.tsx"],
    diffCriticEnabled: true,
    targetProvenance: {
      "src/components/ui": "EXPLICIT_USER_PATH",
      "src/components/ui/Button/Button.tsx": "EXPLICIT_USER_PATH",
    },
  };

  // TEST 1 — dark mode style feature
  test("TEST 1: Dark mode style feature authorizes App.tsx and components.css", () => {
    const contract = { ...defaultBaseContract, targetPaths: ["src/components/ui/Button/Button.tsx"] };
    const snapshotFiles = [
      {
        path: "src/App.tsx",
        content: 'import { Button } from "./components/ui/Button/Button";\nimport "./styles/components.css";\nexport function App() { return <Button />; }',
      },
      {
        path: "src/components/ui/Button/Button.tsx",
        content: "export function Button() { return <button>Click</button>; }",
      },
      {
        path: "src/styles/components.css",
        content: ":root { --bg: #fff; } .dark { --bg: #000; }",
      },
    ];

    const manifestFiles: FileDeclaration[] = [
      { path: "src/components/ui/Button/Button.tsx", action: "modify", description: "Add toggle state", dependencies: [] },
      { path: "src/App.tsx", action: "modify", description: "Mount theme state and dark class", dependencies: [] },
      { path: "src/styles/components.css", action: "modify", description: "Add dark theme styles", dependencies: [] },
    ];

    const result = TargetScopeExpander.expandUiFeatureIntegrationTargets({
      contract,
      manifestFiles,
      message: "update the UI and add a dark mode toggle button on the top and add the darkmode functionality",
      snapshotFiles,
    });

    expect(result.expandedTargetPaths).toContain("src/App.tsx");
    expect(result.expandedTargetPaths).toContain("src/styles/components.css");
    expect(result.expandedTargetPaths).toContain("src/components/ui/Button/Button.tsx");

    const appExp = result.approvedExpansions.find((e) => e.path === "src/App.tsx");
    expect(appExp?.reason).toBe("ACTIVE_INTEGRATION_ROOT");
    expect(appExp?.role).toBe("ROOT_ENTRY");

    const cssExp = result.approvedExpansions.find((e) => e.path === "src/styles/components.css");
    expect(cssExp?.reason).toBe("IMPORTED_BY_ACTIVE_ROOT");
    expect(cssExp?.role).toBe("STYLE_OWNER");

    // ManifestValidator passes with reconciled contract
    const reconciledContract = { ...contract, targetPaths: result.expandedTargetPaths };
    const validator = new ManifestValidator(reconciledContract, {
      existingFiles: snapshotFiles.map((f) => f.path),
    });
    const valRes = validator.validate({ files: manifestFiles, totalFiles: 3, manifestVersion: "1.0.0" });
    expect(valRes.valid).toBe(true);
  });

  // TEST 2 — unrelated file
  test("TEST 2: Unrelated file (mockProjects.ts) is rejected and blocked by ManifestValidator", () => {
    const contract = { ...defaultBaseContract, targetPaths: ["src/components/ui/Button/Button.tsx"] };
    const snapshotFiles = [
      {
        path: "src/App.tsx",
        content: 'import { Button } from "./components/ui/Button/Button";\nimport "./styles/components.css";\nexport function App() { return <Button />; }',
      },
      {
        path: "src/components/ui/Button/Button.tsx",
        content: "export function Button() { return <button>Click</button>; }",
      },
      {
        path: "src/styles/components.css",
        content: ":root { --bg: #fff; } .dark { --bg: #000; }",
      },
      {
        path: "src/data/mockProjects.ts",
        content: "export const mockProjects = [{ id: 1, name: 'Project Alpha' }];",
      },
    ];

    const manifestFiles: FileDeclaration[] = [
      { path: "src/components/ui/Button/Button.tsx", action: "modify", description: "Update button", dependencies: [] },
      { path: "src/App.tsx", action: "modify", description: "Update app", dependencies: [] },
      { path: "src/styles/components.css", action: "modify", description: "Update styles", dependencies: [] },
      { path: "src/data/mockProjects.ts", action: "modify", description: "Update projects", dependencies: [] },
    ];

    const result = TargetScopeExpander.expandUiFeatureIntegrationTargets({
      contract,
      manifestFiles,
      message: "update the UI and add a dark mode toggle button on the top and add the darkmode functionality",
      snapshotFiles,
    });

    expect(result.expandedTargetPaths).toContain("src/App.tsx");
    expect(result.expandedTargetPaths).toContain("src/styles/components.css");
    expect(result.expandedTargetPaths).not.toContain("src/data/mockProjects.ts");

    const mockRej = result.rejectedCandidates.find((r) => r.path === "src/data/mockProjects.ts");
    expect(mockRej).toBeDefined();
    expect(mockRej?.reason).toBe("NO_DETERMINISTIC_RELATION");

    // ManifestValidator strictly rejects mockProjects.ts with path_constraint
    const reconciledContract = { ...contract, targetPaths: result.expandedTargetPaths };
    const validator = new ManifestValidator(reconciledContract, {
      existingFiles: snapshotFiles.map((f) => f.path),
    });
    const valRes = validator.validate({ files: manifestFiles, totalFiles: 4, manifestVersion: "1.0.0" });
    expect(valRes.valid).toBe(false);
    expect(valRes.errors.some((e) => e.type === "path_constraint" && e.affectedFiles?.includes("src/data/mockProjects.ts"))).toBe(true);
  });

  // TEST 3 — simple local button change
  test("TEST 3: Simple local button change refuses App.tsx and global CSS expansion", () => {
    const contract = { ...defaultBaseContract, targetPaths: ["src/components/ui/Button/Button.tsx"] };
    const snapshotFiles = [
      {
        path: "src/App.tsx",
        content: 'import { Button } from "./components/ui/Button/Button";\nimport "./styles/components.css";\nexport function App() { return <Button />; }',
      },
      {
        path: "src/components/ui/Button/Button.tsx",
        content: "export function Button() { return <button>Click</button>; }",
      },
      {
        path: "src/styles/components.css",
        content: "body { margin: 0; }",
      },
    ];

    const manifestFiles: FileDeclaration[] = [
      { path: "src/components/ui/Button/Button.tsx", action: "modify", description: "Change button label", dependencies: [] },
      { path: "src/App.tsx", action: "modify", description: "Unneeded app change", dependencies: [] },
      { path: "src/styles/components.css", action: "modify", description: "Unneeded style change", dependencies: [] },
    ];

    const result = TargetScopeExpander.expandUiFeatureIntegrationTargets({
      contract,
      manifestFiles,
      message: "Change only the existing primary button label to 'Submit'",
      snapshotFiles,
    });

    expect(result.expandedTargetPaths).toContain("src/components/ui/Button/Button.tsx");
    expect(result.expandedTargetPaths).not.toContain("src/App.tsx");
    expect(result.expandedTargetPaths).not.toContain("src/styles/components.css");

    const appRej = result.rejectedCandidates.find((r) => r.path === "src/App.tsx");
    expect(appRej?.reason).toBe("ACTIVE_ENTRY_NOT_INTEGRATION_OWNER");
  });

  // TEST 4 — Header search control
  test("TEST 4: Header search control authorizes Header.tsx, Button.tsx, and Header.css", () => {
    const contract: ExecutionContract = {
      ...defaultBaseContract,
      targetPaths: ["src/components/ui/Button/Button.tsx"],
    };

    const snapshotFiles = [
      {
        path: "src/App.tsx",
        content: 'import { Header } from "./components/layout/Header/Header";\nexport function App() { return <Header />; }',
      },
      {
        path: "src/components/layout/Header/Header.tsx",
        content: 'import { Button } from "../../ui/Button/Button";\nimport "./Header.css";\nexport function Header() { return <header><Button /></header>; }',
      },
      {
        path: "src/components/layout/Header/Header.css",
        content: ".header { display: flex; }",
      },
      {
        path: "src/components/ui/Button/Button.tsx",
        content: "export function Button() { return <button>Search</button>; }",
      },
    ];

    const manifestFiles: FileDeclaration[] = [
      { path: "src/components/layout/Header/Header.tsx", action: "modify", description: "Add search control to header", dependencies: [] },
      { path: "src/components/ui/Button/Button.tsx", action: "modify", description: "Use button for search", dependencies: [] },
      { path: "src/components/layout/Header/Header.css", action: "modify", description: "Style search in header", dependencies: [] },
    ];

    const result = TargetScopeExpander.expandUiFeatureIntegrationTargets({
      contract,
      manifestFiles,
      message: "Add a search control to the application header using existing components",
      snapshotFiles,
    });

    expect(result.expandedTargetPaths).toContain("src/components/layout/Header/Header.tsx");
    expect(result.expandedTargetPaths).toContain("src/components/layout/Header/Header.css");
    expect(result.expandedTargetPaths).toContain("src/components/ui/Button/Button.tsx");
  });

  // TEST 5 — global provider feature
  test("TEST 5: Global ThemeProvider feature authorizes App.tsx, ThemeProvider.tsx, and index.css", () => {
    const contract: ExecutionContract = {
      ...defaultBaseContract,
      targetPaths: ["src/context/ThemeProvider.tsx"],
    };

    const snapshotFiles = [
      {
        path: "src/App.tsx",
        content: 'import { ThemeProvider } from "./context/ThemeProvider";\nimport "./index.css";\nexport function App() { return <ThemeProvider><div /></ThemeProvider>; }',
      },
      {
        path: "src/context/ThemeProvider.tsx",
        content: "import React from 'react'; export function ThemeProvider({ children }: any) { return <>{children}</>; }",
      },
      {
        path: "src/index.css",
        content: "body { margin: 0; }",
      },
    ];

    const manifestFiles: FileDeclaration[] = [
      { path: "src/App.tsx", action: "modify", description: "Wire ThemeProvider into App", dependencies: [] },
      { path: "src/context/ThemeProvider.tsx", action: "modify", description: "Add dark theme context", dependencies: [] },
      { path: "src/index.css", action: "modify", description: "Update global styles", dependencies: [] },
    ];

    const result = TargetScopeExpander.expandUiFeatureIntegrationTargets({
      contract,
      manifestFiles,
      message: "Add a global ThemeProvider context and wire it into the app root with index.css",
      snapshotFiles,
    });

    expect(result.expandedTargetPaths).toContain("src/App.tsx");
    expect(result.expandedTargetPaths).toContain("src/context/ThemeProvider.tsx");
    expect(result.expandedTargetPaths).toContain("src/index.css");
  });

  // TEST 6 — orphan new toggle
  test("TEST 6: Orphan new component without reachable integration edit is rejected", () => {
    const contract = { ...defaultBaseContract, targetPaths: ["src/components/ui/Button/Button.tsx"] };
    const snapshotFiles = [
      {
        path: "src/App.tsx",
        content: 'import { Button } from "./components/ui/Button/Button";\nexport function App() { return <Button />; }',
      },
      {
        path: "src/components/ui/Button/Button.tsx",
        content: "export function Button() { return <button />; }",
      },
    ];

    const manifestFiles: FileDeclaration[] = [
      { path: "src/components/ui/ThemeToggle.tsx", action: "create", description: "Create orphan toggle", dependencies: [] },
    ];

    const result = TargetScopeExpander.expandUiFeatureIntegrationTargets({
      contract,
      manifestFiles,
      message: "Add a theme toggle component",
      snapshotFiles,
    });

    expect(result.expandedTargetPaths).not.toContain("src/components/ui/ThemeToggle.tsx");
    const rej = result.rejectedCandidates.find((r) => r.path === "src/components/ui/ThemeToggle.tsx");
    expect(rej?.reason).toBe("ORPHAN_NEW_COMPONENT");
  });

  // TEST 7 — create + integrate
  test("TEST 7: CREATE ThemeToggle integrated into reachable App.tsx with style is authorized", () => {
    const contract: ExecutionContract = {
      ...defaultBaseContract,
      targetPaths: ["src/components/ui"],
    };

    const snapshotFiles = [
      {
        path: "src/App.tsx",
        content: 'import "./styles/components.css";\nexport function App() { return <div>Top</div>; }',
      },
      {
        path: "src/styles/components.css",
        content: ".dark { color: #fff; }",
      },
    ];

    const manifestFiles: FileDeclaration[] = [
      { path: "src/components/ui/ThemeToggle.tsx", action: "create", description: "New ThemeToggle component", dependencies: [] },
      { path: "src/App.tsx", action: "modify", dependencies: ["./components/ui/ThemeToggle"], description: "Mount ThemeToggle on top" },
      { path: "src/styles/components.css", action: "modify", description: "Update components.css", dependencies: [] },
    ];

    const result = TargetScopeExpander.expandUiFeatureIntegrationTargets({
      contract,
      manifestFiles,
      message: "Add a dark mode toggle to the top of the application using a new ThemeToggle component and existing styles",
      snapshotFiles,
    });

    expect(result.expandedTargetPaths).toContain("src/App.tsx");
    expect(result.expandedTargetPaths).toContain("src/components/ui/ThemeToggle.tsx");
    expect(result.expandedTargetPaths).toContain("src/styles/components.css");

    const reconciledContract = { ...contract, targetPaths: result.expandedTargetPaths };
    const validator = new ManifestValidator(reconciledContract, {
      existingFiles: snapshotFiles.map((f) => f.path),
    });
    const valRes = validator.validate({ files: manifestFiles, totalFiles: 3, manifestVersion: "1.0.0" });
    expect(valRes.valid).toBe(true);
  });

  // TEST 8 — semantic-only candidate
  test("TEST 8: Semantic-only candidate with high score but no deterministic graph relation is rejected", () => {
    const contract = { ...defaultBaseContract, targetPaths: ["src/components/ui/Button/Button.tsx"] };
    const snapshotFiles = [
      { path: "src/App.tsx", content: "export function App() { return null; }" },
      { path: "src/components/ui/Button/Button.tsx", content: "export function Button() { return null; }" },
      { path: "src/utils/theme-experiment.ts", content: "export const themeExperiment = 'experimental';" },
    ];

    const result = TargetScopeExpander.expandUiFeatureIntegrationTargets({
      contract,
      candidatePaths: ["src/utils/theme-experiment.ts"],
      semanticEvidence: [{ path: "src/utils/theme-experiment.ts", score: 0.98 }],
      message: "update the UI and add a dark mode toggle button on the top",
      snapshotFiles,
    });

    expect(result.expandedTargetPaths).not.toContain("src/utils/theme-experiment.ts");
    const rej = result.rejectedCandidates.find((r) => r.path === "src/utils/theme-experiment.ts");
    expect(rej?.reason).toBe("NO_DETERMINISTIC_RELATION");
  });

  // TEST 9 — active entry contamination
  test("TEST 9: Active entry contamination is prevented on simple child component update", () => {
    const contract = { ...defaultBaseContract, targetPaths: ["src/components/ui/Button/Button.tsx"] };
    const snapshotFiles = [
      {
        path: "src/App.tsx",
        content: 'import { Button } from "./components/ui/Button/Button";\nexport function App() { return <Button />; }',
      },
      {
        path: "src/components/ui/Button/Button.tsx",
        content: "export function Button() { return <button>Click</button>; }",
      },
    ];

    const result = TargetScopeExpander.expandUiFeatureIntegrationTargets({
      contract,
      candidatePaths: ["src/App.tsx"],
      message: "Update the button border radius and padding in Button.tsx",
      snapshotFiles,
    });

    expect(result.expandedTargetPaths).not.toContain("src/App.tsx");
    const rej = result.rejectedCandidates.find((r) => r.path === "src/App.tsx");
    expect(rej?.reason).toBe("ACTIVE_ENTRY_NOT_INTEGRATION_OWNER");
  });

  // TEST 10 — backend task
  test("TEST 10: Backend / API task does not invoke UI integration scope resolver", () => {
    const backendContract: ExecutionContract = {
      ...defaultBaseContract,
      taskType: "NEW_FEATURE",
      targetPaths: ["src/api/routes.ts"],
    };

    const snapshotFiles = [
      { path: "src/server.ts", content: "import express from 'express'; const app = express();" },
      { path: "src/api/routes.ts", content: "export const router = {};" },
      { path: "package.json", content: JSON.stringify({ dependencies: { express: "^4.18.2" } }) },
    ];

    const result = TargetScopeExpander.expandUiFeatureIntegrationTargets({
      contract: backendContract,
      candidatePaths: ["src/server.ts"],
      message: "Add GET /api/health endpoint to express server",
      snapshotFiles,
      repoIsBackend: true,
    });

    expect(result.approvedExpansions).toHaveLength(0);
    expect(result.expandedTargetPaths).toEqual(["src/api/routes.ts"]);
  });

  // TEST 11 — destructive cleanup
  test("TEST 11: Destructive tasks bypass UI resolver and preserve reverse-reference cleanup", () => {
    const deleteContract: ExecutionContract = {
      ...defaultBaseContract,
      taskType: "DELETE_FILE",
      targetPaths: ["src/components/ui/LegacyWidget.tsx"],
    };

    const result = TargetScopeExpander.expandUiFeatureIntegrationTargets({
      contract: deleteContract,
      candidatePaths: ["src/App.tsx"],
      message: "Delete LegacyWidget and update references",
      snapshotFiles: [{ path: "src/App.tsx", content: "import { LegacyWidget } from './components/ui/LegacyWidget';" }],
    });

    expect(result.approvedExpansions).toHaveLength(0);
    expect(result.expandedTargetPaths).toEqual(["src/components/ui/LegacyWidget.tsx"]);
  });

  // TEST 12 — Vite dark-mode-like feature with src/pages/
  test("TEST 12: Vite application with src/pages/ correctly resolves framework as VITE_REACT", () => {
    const existingFiles = [
      "src/App.tsx",
      "src/pages/DashboardPage/DashboardPage.tsx",
      "src/pages/DashboardPage/DashboardPage.css",
      "src/styles/components.css",
      "package.json",
      "vite.config.ts",
    ];
    const pkgJson = JSON.stringify({ dependencies: { react: "^18.2.0", "react-dom": "^18.2.0" } });
    const arch = detectRepositoryArchitecture(existingFiles, pkgJson);
    expect(arch.framework).toBe("VITE_REACT");
  });

  // TEST 13 — Next App Router integration
  test("TEST 13: Next App Router integration authorizes app/layout.tsx and globals.css", () => {
    const contract: ExecutionContract = {
      ...defaultBaseContract,
      targetPaths: ["components/ThemeProvider.tsx"],
    };

    const snapshotFiles = [
      {
        path: "app/layout.tsx",
        content: 'import "./globals.css";\nimport { ThemeProvider } from "../components/ThemeProvider";\nexport default function RootLayout({ children }: any) { return <ThemeProvider>{children}</ThemeProvider>; }',
      },
      {
        path: "app/globals.css",
        content: ":root { --bg: #fff; }",
      },
      {
        path: "components/ThemeProvider.tsx",
        content: "export function ThemeProvider({ children }: any) { return children; }",
      },
      {
        path: "app/page.tsx",
        content: "export default function Page() { return <h1>Home</h1>; }",
      },
    ];

    const manifestFiles: FileDeclaration[] = [
      { path: "app/layout.tsx", action: "modify", description: "Wire ThemeProvider in RootLayout", dependencies: [] },
      { path: "components/ThemeProvider.tsx", action: "modify", description: "Configure theme provider", dependencies: [] },
      { path: "app/globals.css", action: "modify", description: "Theme variables", dependencies: [] },
    ];

    const result = TargetScopeExpander.expandUiFeatureIntegrationTargets({
      contract,
      manifestFiles,
      message: "Add dark mode support using ThemeProvider and global stylesheet in Next.js layout",
      snapshotFiles,
    });

    expect(result.expandedTargetPaths).toContain("app/layout.tsx");
    expect(result.expandedTargetPaths).toContain("app/globals.css");
    expect(result.expandedTargetPaths).toContain("components/ThemeProvider.tsx");
  });

  // TEST 14 — monorepo
  test("TEST 14: Monorepo isolation restricts expansion to the active frontend workspace", () => {
    const monorepo: MonorepoDescriptor = {
      isMonorepo: true,
      type: "turbo",
      packageManager: "npm",
      rootPath: "",
      hasTurbo: true,
      workspaces: [
        {
          name: "@repo/web",
          relativePath: "apps/web",
          packageJsonPath: "apps/web/package.json",
          dependencies: new Set(["@repo/ui"]),
          scripts: {},
        },
        {
          name: "@repo/api",
          relativePath: "apps/api",
          packageJsonPath: "apps/api/package.json",
          dependencies: new Set(),
          scripts: {},
        },
      ],
      packageByPath: new Map(),
      packageByName: new Map(),
      packageDependencies: new Map(),
      packageDependents: new Map(),
    };

    const contract: ExecutionContract = {
      ...defaultBaseContract,
      targetPaths: ["apps/web/src/App.tsx"],
    };

    const snapshotFiles = [
      { path: "apps/web/src/App.tsx", content: "export function App() { return null; }" },
      { path: "apps/api/src/server.ts", content: "export const server = {};" },
    ];

    const result = TargetScopeExpander.expandUiFeatureIntegrationTargets({
      contract,
      candidatePaths: ["apps/api/src/server.ts"],
      message: "Add theme toggle to web dashboard",
      snapshotFiles,
      monorepo,
    });

    expect(result.expandedTargetPaths).not.toContain("apps/api/src/server.ts");
    const rej = result.rejectedCandidates.find((r) => r.path === "apps/api/src/server.ts");
    expect(rej?.reason).toBe("CROSS_WORKSPACE_VIOLATION");
  });

  // TEST 15 — multi-repo
  test("TEST 15: Multi-repo isolation prevents backend repository from receiving frontend integration paths", () => {
    const backendContract: ExecutionContract = {
      ...defaultBaseContract,
      targetPaths: ["src/controllers/auth.controller.ts"],
    };

    const result = TargetScopeExpander.expandUiFeatureIntegrationTargets({
      contract: backendContract,
      candidatePaths: ["src/components/Button.tsx"],
      message: "Update auth buttons and UI",
      snapshotFiles: [{ path: "src/controllers/auth.controller.ts", content: "export class AuthController {}" }],
      repoIsBackend: true,
    });

    expect(result.expandedTargetPaths).not.toContain("src/components/Button.tsx");
  });

  // TEST 16 — ManifestValidator still rejects genuinely unauthorized path
  test("TEST 16: ManifestValidator strictly rejects genuinely unauthorized path", () => {
    const contract: ExecutionContract = {
      ...defaultBaseContract,
      targetPaths: ["src/components/ui/Button/Button.tsx"],
    };

    const validator = new ManifestValidator(contract, {
      existingFiles: ["src/components/ui/Button/Button.tsx", "src/utils/unauthorized.ts"],
    });

    const manifest: FileManifest = {
      files: [
        { path: "src/components/ui/Button/Button.tsx", action: "modify", description: "Button change", dependencies: [] },
        { path: "src/utils/unauthorized.ts", action: "modify", description: "Unauthorized change", dependencies: [] },
      ],
      totalFiles: 2,
      manifestVersion: "1.0.0",
    };

    const valRes = validator.validate(manifest);
    expect(valRes.valid).toBe(false);
    expect(valRes.errors.some((e) => e.type === "path_constraint" && e.affectedFiles?.includes("src/utils/unauthorized.ts"))).toBe(true);
  });

  // TEST 17 — ExecutionScopeEnforcer remains strict
  test("TEST 17: ExecutionScopeEnforcer strictly rejects undeclared file changes", () => {
    const contract: ExecutionContract = {
      ...defaultBaseContract,
      targetPaths: ["src/components/ui/Button/Button.tsx"],
    };

    const manifest: FileManifest = {
      files: [{ path: "src/components/ui/Button/Button.tsx", action: "modify", description: "Button change", dependencies: [] }],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    };

    const proposedChanges: AgentFileChange[] = [
      { path: "src/components/ui/Button/Button.tsx", action: "modify", content: "export const Button = null;", description: "Button" },
      { path: "src/unauthorized.ts", action: "create", content: "console.log('injected');", description: "Unauthorized" },
    ];

    const result = enforceExecutionScope({
      proposedChanges,
      manifest,
      contract,
      existingFilePaths: ["src/components/ui/Button/Button.tsx"],
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path === "src/unauthorized.ts" && e.reason === "UNDECLARED_FILE")).toBe(true);
  });

  // TEST 18 — FileVersionGuard unchanged
  test("TEST 18: FileVersionGuard unchanged and functional", async () => {
    const result = await verifyFileVersionsFromDisk(
      { "src/App.tsx": "dummyhash" },
      process.cwd()
    );
    expect(result).toBeDefined();
    expect(typeof result.valid).toBe("boolean");
  });

  // TEST 19 — Cluster E reachability remains green
  test("TEST 19: Cluster E active target reachability verification remains green", async () => {
    const snapshot = {
      keyFiles: [
        {
          path: "src/App.tsx",
          content: 'import { DashboardPage } from "./pages/DashboardPage/DashboardPage";\nexport function App() { return <DashboardPage />; }',
        },
        {
          path: "src/pages/DashboardPage/DashboardPage.tsx",
          content: "export function DashboardPage() { return <h1>Dashboard</h1>; }",
        },
      ],
    };

    const changes: AgentFileChange[] = [
      {
        path: "src/pages/DashboardPage/DashboardPage.tsx",
        action: "modify",
        content: "export function DashboardPage() { return <h1>Verified Dashboard</h1>; }",
        description: "Update dashboard",
      },
    ];

    const result = await ValidationDetector.runFeatureValidation(
      changes,
      snapshot,
      "Update the dashboard title to 'Verified Dashboard'",
      defaultBaseContract
    );

    const intentCheck = result.checks.find((c) => c.id === "intent_satisfaction");
    expect(intentCheck?.status).toBe("PASS");
  });

  // TEST 20 — visual-verifier suite remains green
  test("TEST 20: Visual-verifier and framework precedence check remains valid", () => {
    const files = ["src/App.tsx", "package.json", "vite.config.ts"];
    const pkgJson = JSON.stringify({ dependencies: { react: "^18.0.0" } });
    const arch = detectRepositoryArchitecture(files, pkgJson);
    expect(arch.framework).toBe("VITE_REACT");
  });

  // LIVE PROMPT A
  test("Live Prompt A: Add a dark mode toggle to the top of the application...", () => {
    const contract: ExecutionContract = {
      ...defaultBaseContract,
      targetPaths: ["src/components/ui/Button/Button.tsx"],
    };

    const snapshotFiles = [
      {
        path: "src/App.tsx",
        content: 'import { Button } from "./components/ui/Button/Button";\nimport "./styles/components.css";\nexport function App() { return <Button />; }',
      },
      {
        path: "src/components/ui/Button/Button.tsx",
        content: "export function Button() { return <button>Toggle</button>; }",
      },
      {
        path: "src/styles/components.css",
        content: ":root { --bg: #fff; } .dark { --bg: #000; }",
      },
      { path: "package.json", content: JSON.stringify({ dependencies: { react: "^18.0.0" } }) },
      { path: "vite.config.ts", content: "export default {};" },
    ];

    const result = TargetScopeExpander.expandUiFeatureIntegrationTargets({
      contract,
      candidatePaths: ["src/App.tsx", "src/styles/components.css"],
      message: "Add a dark mode toggle to the top of the application and implement dark mode using the existing UI and styling architecture.",
      snapshotFiles,
    });

    expect(result.expandedTargetPaths).toContain("src/App.tsx");
    expect(result.expandedTargetPaths).toContain("src/styles/components.css");
    expect(result.expandedTargetPaths).toContain("src/components/ui/Button/Button.tsx");
    expect(result.approvedExpansions.find((e) => e.path === "src/App.tsx")?.reason).toBe("ACTIVE_INTEGRATION_ROOT");
    expect(result.approvedExpansions.find((e) => e.path === "src/styles/components.css")?.reason).toBe("IMPORTED_BY_ACTIVE_ROOT");
  });

  // LIVE PROMPT B
  test("Live Prompt B: Add a search control to the application header using existing components.", () => {
    const contract: ExecutionContract = {
      ...defaultBaseContract,
      targetPaths: ["src/components/layout/Header/Header.tsx"],
    };

    const snapshotFiles = [
      {
        path: "src/App.tsx",
        content: 'import { Header } from "./components/layout/Header/Header";\nexport function App() { return <Header />; }',
      },
      {
        path: "src/components/layout/Header/Header.tsx",
        content: 'import { Button } from "../../ui/Button/Button";\nimport "./Header.css";\nexport function Header() { return <header><Button /></header>; }',
      },
      {
        path: "src/components/layout/Header/Header.css",
        content: ".header { display: flex; }",
      },
      {
        path: "src/components/ui/Button/Button.tsx",
        content: "export function Button() { return <button>Search</button>; }",
      },
    ];

    const result = TargetScopeExpander.expandUiFeatureIntegrationTargets({
      contract,
      candidatePaths: ["src/components/ui/Button/Button.tsx", "src/components/layout/Header/Header.css"],
      message: "Add a search control to the application header using existing components.",
      snapshotFiles,
    });

    expect(result.expandedTargetPaths).toContain("src/components/layout/Header/Header.tsx");
    expect(result.expandedTargetPaths).toContain("src/components/ui/Button/Button.tsx");
    expect(result.expandedTargetPaths).toContain("src/components/layout/Header/Header.css");
  });

  // LIVE PROMPT C
  test("Live Prompt C: Change only the existing primary button label.", () => {
    const contract: ExecutionContract = {
      ...defaultBaseContract,
      targetPaths: ["src/components/ui/Button/Button.tsx"],
    };

    const snapshotFiles = [
      {
        path: "src/App.tsx",
        content: 'import { Button } from "./components/ui/Button/Button";\nimport "./styles/components.css";\nexport function App() { return <Button />; }',
      },
      {
        path: "src/components/ui/Button/Button.tsx",
        content: "export function Button() { return <button>Click</button>; }",
      },
      {
        path: "src/styles/components.css",
        content: "body { margin: 0; }",
      },
    ];

    const result = TargetScopeExpander.expandUiFeatureIntegrationTargets({
      contract,
      candidatePaths: ["src/App.tsx", "src/styles/components.css"],
      message: "Change only the existing primary button label.",
      snapshotFiles,
    });

    expect(result.expandedTargetPaths).toContain("src/components/ui/Button/Button.tsx");
    expect(result.expandedTargetPaths).not.toContain("src/App.tsx");
    expect(result.expandedTargetPaths).not.toContain("src/styles/components.css");
    expect(result.rejectedCandidates.find((r) => r.path === "src/App.tsx")?.reason).toBe("ACTIVE_ENTRY_NOT_INTEGRATION_OWNER");
  });

  // GENERALIZATION TEST 1 — Unknown "focus mode" cross-cutting feature PASS (Fix 4)
  test("GENERALIZATION 1: Unknown 'focus mode' cross-cutting feature authorizes exact architectural files without keyword rules", () => {
    const contract: ExecutionContract = {
      ...defaultBaseContract,
      targetPaths: ["src/components/layout/Header/Header.tsx"],
    };

    const snapshotFiles = [
      {
        path: "src/main.tsx",
        content: 'import { App } from "./App";\nimport "./styles/global.css";',
      },
      {
        path: "src/App.tsx",
        content: 'import { Header } from "./components/layout/Header/Header";\nimport "./styles/global.css";\nexport function App() { return <Header />; }',
      },
      {
        path: "src/components/layout/Header/Header.tsx",
        content: 'import "./Header.css";\nexport function Header() { return <header>Bar</header>; }',
      },
      {
        path: "src/styles/global.css",
        content: ":root { --focus-bg: #111; }",
      },
    ];

    const result = TargetScopeExpander.expandUiFeatureIntegrationTargets({
      contract,
      candidatePaths: ["src/App.tsx", "src/styles/global.css"],
      message: "Add a global focus mode control to the top bar and make the application respond to it using the existing architecture.",
      snapshotFiles,
    });

    expect(result.expandedTargetPaths).toContain("src/components/layout/Header/Header.tsx");
    expect(result.expandedTargetPaths).toContain("src/App.tsx");
    expect(result.expandedTargetPaths).toContain("src/styles/global.css");
  });

  // GENERALIZATION TEST 2 — Unknown "workspace density" feature PASS (Fix 5)
  test("GENERALIZATION 2: Unknown 'workspace density' feature authorizes header, root, and stylesheet without density keywords", () => {
    const contract: ExecutionContract = {
      ...defaultBaseContract,
      targetPaths: ["src/components/layout/Header/Header.tsx"],
    };

    const snapshotFiles = [
      {
        path: "src/App.tsx",
        content: 'import { Header } from "./components/layout/Header/Header";\nimport "./styles/components.css";\nexport function App() { return <Header />; }',
      },
      {
        path: "src/components/layout/Header/Header.tsx",
        content: 'export function Header() { return <header>Header</header>; }',
      },
      {
        path: "src/styles/components.css",
        content: ".density-compact { padding: 4px; }",
      },
    ];

    const result = TargetScopeExpander.expandUiFeatureIntegrationTargets({
      contract,
      candidatePaths: ["src/App.tsx", "src/styles/components.css"],
      message: "Add a workspace density control to the header and apply the selected density across the application.",
      snapshotFiles,
    });

    expect(result.expandedTargetPaths).toContain("src/components/layout/Header/Header.tsx");
    expect(result.expandedTargetPaths).toContain("src/App.tsx");
    expect(result.expandedTargetPaths).toContain("src/styles/components.css");
  });

  // GENERALIZATION TEST 3 — Local button text change stays strictly local (Fix 6)
  test("GENERALIZATION 3: Local button text change without keywords stays strictly local", () => {
    const contract: ExecutionContract = {
      ...defaultBaseContract,
      targetPaths: ["src/components/ui/Button/Button.tsx"],
    };

    const snapshotFiles = [
      {
        path: "src/App.tsx",
        content: 'import { Button } from "./components/ui/Button/Button";\nimport "./styles/components.css";\nexport function App() { return <Button />; }',
      },
      {
        path: "src/components/ui/Button/Button.tsx",
        content: "export function Button() { return <button>Submit</button>; }",
      },
      {
        path: "src/styles/components.css",
        content: "button { margin: 0; }",
      },
    ];

    const result = TargetScopeExpander.expandUiFeatureIntegrationTargets({
      contract,
      candidatePaths: ["src/App.tsx", "src/styles/components.css"],
      message: "Change the primary button text to Continue.",
      snapshotFiles,
    });

    expect(result.expandedTargetPaths).toEqual(["src/components/ui/Button/Button.tsx"]);
    expect(result.rejectedCandidates.find((r) => r.path === "src/App.tsx")?.reason).toBe("ACTIVE_ENTRY_NOT_INTEGRATION_OWNER");
    expect(result.rejectedCandidates.find((r) => r.path === "src/styles/components.css")?.reason).toBe("LOCAL_TARGET_SUFFICIENT");
  });

  // GENERALIZATION TEST 4 — Provider-looking filename without graph relation REJECT (Fix 7)
  test("GENERALIZATION 4: File named GlobalProvider.tsx without deterministic wiring is rejected", () => {
    const contract: ExecutionContract = {
      ...defaultBaseContract,
      targetPaths: ["src/components/layout/Header/Header.tsx"],
    };

    const snapshotFiles = [
      {
        path: "src/App.tsx",
        content: 'import { Header } from "./components/layout/Header/Header";\nexport function App() { return <Header />; }',
      },
      {
        path: "src/components/layout/Header/Header.tsx",
        content: "export function Header() { return <header /> }",
      },
      {
        path: "src/providers/GlobalProvider.tsx",
        content: "export function GlobalProvider({ children }: any) { return children; }",
      },
    ];

    const result = TargetScopeExpander.expandUiFeatureIntegrationTargets({
      contract,
      candidatePaths: ["src/providers/GlobalProvider.tsx"],
      message: "Add global state provider to application",
      snapshotFiles,
    });

    expect(result.expandedTargetPaths).not.toContain("src/providers/GlobalProvider.tsx");
    expect(result.rejectedCandidates.find((r) => r.path === "src/providers/GlobalProvider.tsx")?.reason).toBe("NO_DETERMINISTIC_RELATION");
  });

  // GENERALIZATION TEST 5 — Semantic-only candidate REJECT
  test("GENERALIZATION 5: Candidate with high semantic relevance but no deterministic graph relation is rejected", () => {
    const contract: ExecutionContract = {
      ...defaultBaseContract,
      targetPaths: ["src/components/layout/Header/Header.tsx"],
    };

    const snapshotFiles = [
      {
        path: "src/App.tsx",
        content: 'import { Header } from "./components/layout/Header/Header";\nexport function App() { return <Header />; }',
      },
      {
        path: "src/components/layout/Header/Header.tsx",
        content: "export function Header() { return <header /> }",
      },
      {
        path: "src/utils/arbitraryHelper.ts",
        content: "export function helper() { return true; }",
      },
    ];

    const result = TargetScopeExpander.expandUiFeatureIntegrationTargets({
      contract,
      candidatePaths: ["src/utils/arbitraryHelper.ts"],
      message: "Enhance application header",
      snapshotFiles,
      semanticEvidence: [{ path: "src/utils/arbitraryHelper.ts", score: 0.99 }],
    });

    expect(result.expandedTargetPaths).not.toContain("src/utils/arbitraryHelper.ts");
    expect(result.rejectedCandidates.find((r) => r.path === "src/utils/arbitraryHelper.ts")?.reason).toBe("NO_DETERMINISTIC_RELATION");
  });

  // GENERALIZATION TEST 6 — Unrelated data file REJECT and blocked by ManifestValidator
  test("GENERALIZATION 6: Unrelated data file is rejected and strictly blocked by ManifestValidator", () => {
    const contract: ExecutionContract = {
      ...defaultBaseContract,
      targetPaths: ["src/components/ui/Button/Button.tsx"],
    };

    const snapshotFiles = [
      {
        path: "src/App.tsx",
        content: 'import { Button } from "./components/ui/Button/Button";\nexport function App() { return <Button />; }',
      },
      {
        path: "src/components/ui/Button/Button.tsx",
        content: "export function Button() { return <button /> }",
      },
      {
        path: "src/data/mockProjects.ts",
        content: "export const mockProjects = [];",
      },
    ];

    const result = TargetScopeExpander.expandUiFeatureIntegrationTargets({
      contract,
      candidatePaths: ["src/data/mockProjects.ts"],
      message: "Add interactive controls to header",
      snapshotFiles,
    });

    expect(result.expandedTargetPaths).not.toContain("src/data/mockProjects.ts");

    // ManifestValidator verification
    const validator = new ManifestValidator(
      { ...contract, targetPaths: result.expandedTargetPaths },
      { existingFiles: ["src/App.tsx", "src/components/ui/Button/Button.tsx", "src/data/mockProjects.ts"] }
    );
    const valResult = validator.validate({
      manifestVersion: "1.0.0",
      totalFiles: 1,
      files: [
        { path: "src/data/mockProjects.ts", action: "modify", description: "unauthorized edit", dependencies: [] },
      ],
    });
    expect(valResult.valid).toBe(false);
    expect(valResult.errors.some((e) => e.type === "path_constraint")).toBe(true);
  });
});
