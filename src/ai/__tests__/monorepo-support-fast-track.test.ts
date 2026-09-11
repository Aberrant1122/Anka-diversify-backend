import fs from "fs";
import path from "path";
import os from "os";
import { MonorepoDetector, MonorepoDescriptor } from "../workspace/MonorepoDetector";
import { ValidationPlanner } from "../validation/ValidationPlanner";
import { ManifestValidator } from "../../services/manifest-validator";
import { enforceExecutionScope } from "../contracts/ExecutionScopeEnforcer";
import { TargetPathExtractor } from "../contracts/TargetPathExtractor";
import {
  detectPrimaryActiveEntryPoint,
  detectRepositoryArchitecture,
} from "../planning/RepositoryArchitectureDetector";
import { WorktreeDependencyService } from "../../services/worktree-dependency.service";
import { ExecutionContract, FileManifest } from "../../types";

describe("Monorepo Support Fast Track MVP Tests", () => {
  let tempDir: string;

  // Reusable Monorepo Snapshot Files
  const monorepoSnapshotFiles = [
    {
      path: "package.json",
      content: JSON.stringify({
        name: "my-monorepo-root",
        private: true,
        workspaces: ["apps/*", "packages/*"],
      }),
    },
    {
      path: "turbo.json",
      content: JSON.stringify({
        $schema: "https://turbo.build/schema.json",
        pipeline: {
          build: { dependsOn: ["^build"] },
          test: {},
        },
      }),
    },
    {
      path: "apps/web/package.json",
      content: JSON.stringify({
        name: "@repo/web",
        version: "1.0.0",
        dependencies: {
          "@repo/ui": "*",
          "@repo/types": "*",
          react: "^18.0.0",
        },
        scripts: {
          build: "next build",
          test: "jest",
        },
      }),
    },
    {
      path: "apps/web/src/App.tsx",
      content: "import { Button } from '@repo/ui';\nexport function App() { return <Button label=\"Go\" />; }",
    },
    {
      path: "apps/api/package.json",
      content: JSON.stringify({
        name: "@repo/api",
        version: "1.0.0",
        dependencies: {
          "@repo/types": "*",
          express: "^4.18.0",
        },
        scripts: {
          build: "tsc",
          test: "jest",
        },
      }),
    },
    {
      path: "apps/api/src/index.ts",
      content: "import { User } from '@repo/types';\nconsole.log('API running');",
    },
    {
      path: "packages/ui/package.json",
      content: JSON.stringify({
        name: "@repo/ui",
        version: "1.0.0",
        dependencies: {
          react: "^18.0.0",
        },
        scripts: {
          build: "tsc",
          test: "jest",
        },
      }),
    },
    {
      path: "packages/ui/src/Button.tsx",
      content: "export function Button(props: { label: string }) { return <button>{props.label}</button>; }",
    },
    {
      path: "packages/types/package.json",
      content: JSON.stringify({
        name: "@repo/types",
        version: "1.0.0",
        scripts: {
          build: "tsc",
        },
      }),
    },
    {
      path: "packages/types/src/index.ts",
      content: "export interface User { id: string; name: string; }",
    },
  ];

  const baseContract: ExecutionContract = {
    goal: "Monorepo test goal",
    taskType: "BUG_FIX",
    risk: "LOW",
    estimatedComplexity: "SMALL",
    pipeline: "REPOSITORY",
    environment: "REACT_TS",
    repositoryRequired: true,
    expectedFiles: [],
    validationType: "TYPESCRIPT_BUILD",
    targetPaths: [],
    allowedActions: ["modify", "create"],
    forbiddenActions: ["delete"],
    maxFiles: 5,
    searchScope: [],
    contextScope: [],
    diffCriticEnabled: true,
  };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "monorepo-test-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  // Helper to write snapshot files to disk
  function materializeSnapshotToDisk(dir: string, files: typeof monorepoSnapshotFiles) {
    for (const f of files) {
      const fullPath = path.join(dir, f.path);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, f.content, "utf8");
    }
  }

  // 1. Detect all 4 workspaces
  test("1. Detect all 4 workspaces", () => {
    const descriptor = MonorepoDetector.detectMonorepo(null, monorepoSnapshotFiles);
    expect(descriptor.isMonorepo).toBe(true);
    expect(descriptor.workspaces.length).toBe(4);

    const names = descriptor.workspaces.map((w) => w.name).sort();
    expect(names).toEqual(["@repo/api", "@repo/types", "@repo/ui", "@repo/web"]);
  });

  // 2. Detect package manager correctly
  test("2. Detect package manager correctly", () => {
    // npm
    const npmDescriptor = MonorepoDetector.detectMonorepo(null, [
      ...monorepoSnapshotFiles,
      { path: "package-lock.json", content: "{}" },
    ]);
    expect(npmDescriptor.packageManager).toBe("npm");

    // pnpm
    const pnpmFiles = [
      {
        path: "pnpm-workspace.yaml",
        content: "packages:\n  - 'apps/*'\n  - 'packages/*'",
      },
      {
        path: "pnpm-lock.yaml",
        content: "lockfileVersion: '6.0'",
      },
      ...monorepoSnapshotFiles.filter((f) => f.path !== "package.json" && f.path !== "turbo.json"),
    ];
    const pnpmDescriptor = MonorepoDetector.detectMonorepo(null, pnpmFiles);
    expect(pnpmDescriptor.isMonorepo).toBe(true);
    expect(pnpmDescriptor.packageManager).toBe("pnpm");
    expect(pnpmDescriptor.workspaces.length).toBe(4);

    // yarn
    const yarnFiles = [
      {
        path: "package.json",
        content: JSON.stringify({
          name: "yarn-monorepo",
          private: true,
          workspaces: ["apps/*", "packages/*"],
          packageManager: "yarn@3.6.0",
        }),
      },
      { path: "yarn.lock", content: "" },
      ...monorepoSnapshotFiles.filter((f) => f.path !== "package.json" && f.path !== "turbo.json"),
    ];
    const yarnDescriptor = MonorepoDetector.detectMonorepo(null, yarnFiles);
    expect(yarnDescriptor.isMonorepo).toBe(true);
    expect(yarnDescriptor.packageManager).toBe("yarn");
  });

  // 3. Detect turbo.json
  test("3. Detect turbo.json", () => {
    const descriptor = MonorepoDetector.detectMonorepo(null, monorepoSnapshotFiles);
    expect(descriptor.hasTurbo).toBe(true);
    expect(descriptor.type).toBe("turbo");
  });

  // 4. Construct: web -> ui, web -> types, api -> types
  test("4. Construct package dependency graph: web -> ui, web -> types, api -> types", () => {
    const descriptor = MonorepoDetector.detectMonorepo(null, monorepoSnapshotFiles);

    const webDeps = MonorepoDetector.getDependencies(descriptor, "@repo/web");
    expect(webDeps.has("@repo/ui")).toBe(true);
    expect(webDeps.has("@repo/types")).toBe(true);
    expect(webDeps.has("react")).toBe(false); // only internal workspace packages

    const apiDeps = MonorepoDetector.getDependencies(descriptor, "@repo/api");
    expect(apiDeps.has("@repo/types")).toBe(true);
    expect(apiDeps.has("@repo/ui")).toBe(false);

    const uiDeps = MonorepoDetector.getDependencies(descriptor, "@repo/ui");
    expect(uiDeps.size).toBe(0);
  });

  // 5. Reverse dependents: types -> web, types -> api, ui -> web
  test("5. Reverse dependents: types -> web, types -> api, ui -> web", () => {
    const descriptor = MonorepoDetector.detectMonorepo(null, monorepoSnapshotFiles);

    const typesDependents = MonorepoDetector.getDependents(descriptor, "@repo/types");
    expect(typesDependents.has("@repo/web")).toBe(true);
    expect(typesDependents.has("@repo/api")).toBe(true);

    const uiDependents = MonorepoDetector.getDependents(descriptor, "@repo/ui");
    expect(uiDependents.has("@repo/web")).toBe(true);
    expect(uiDependents.has("@repo/api")).toBe(false);
  });

  // 6. File packages/ui/src/Button.tsx maps to @repo/ui
  test("6. File packages/ui/src/Button.tsx maps to @repo/ui", () => {
    const descriptor = MonorepoDetector.detectMonorepo(null, monorepoSnapshotFiles);

    const ws = MonorepoDetector.getWorkspaceForFile(descriptor, "packages/ui/src/Button.tsx");
    expect(ws).not.toBeNull();
    expect(ws?.name).toBe("@repo/ui");
    expect(ws?.relativePath).toBe("packages/ui");

    const wsWeb = MonorepoDetector.getWorkspaceForFile(descriptor, "apps/web/src/App.tsx");
    expect(wsWeb?.name).toBe("@repo/web");
    expect(wsWeb?.relativePath).toBe("apps/web");
  });

  // 7. Prompt / exact symbol Button resolves to packages/ui without unrelated package authority
  test("7. Prompt / exact symbol Button resolves to packages/ui without unrelated package authority", () => {
    const repoFiles = [
      "packages/ui/src/Button.tsx",
      "apps/web/src/App.tsx",
      "apps/api/src/index.ts",
      "packages/types/src/index.ts",
    ];

    const targets = TargetPathExtractor.extractGroundedEntitiesWithProvenance(
      "Update the Button component in the shared UI package",
      repoFiles
    );

    expect(targets.length).toBe(1);
    expect(targets[0].path).toBe("packages/ui/src/Button.tsx");
    expect(targets[0].provenance).toBe("UNIQUE_NAMED_ENTITY");
  });

  // 8. Internal import @repo/ui is accepted as workspace dependency
  test("8. Internal import @repo/ui is accepted as workspace dependency", () => {
    const descriptor = MonorepoDetector.detectMonorepo(null, monorepoSnapshotFiles);

    const contract: ExecutionContract = {
      ...baseContract,
      taskType: "NEW_FEATURE",
      goal: "Import Button from @repo/ui",
      allowedActions: ["create", "modify"],
      forbiddenActions: ["delete"],
      targetPaths: ["apps/web/src/App.tsx"],
      maxFiles: 5,
    };

    const validator = new ManifestValidator(contract, {
      existingFiles: monorepoSnapshotFiles.map((f) => f.path),
      monorepo: descriptor,
    });

    const manifest: FileManifest = {
      manifestVersion: "1.0.0",
      totalFiles: 1,
      files: [
        {
          path: "apps/web/src/App.tsx",
          action: "modify",
          description: "Use button component",
          dependencies: ["@repo/ui", "react"],
        },
      ],
    };

    const result = validator.validate(manifest);
    expect(result.valid).toBe(true);
    expect(result.errors.length).toBe(0);
  });

  // 9. Semantic retrieval result from unrelated package does NOT grant authority
  test("9. Semantic retrieval result from unrelated package does NOT grant authority", () => {
    const contract: ExecutionContract = {
      ...baseContract,
      taskType: "BUG_FIX",
      goal: "Fix Button component",
      allowedActions: ["modify"],
      forbiddenActions: ["delete", "create"],
      targetPaths: ["packages/ui/src/Button.tsx"],
      maxFiles: 2,
    };

    const manifest: FileManifest = {
      manifestVersion: "1.0.0",
      totalFiles: 1,
      files: [
        {
          path: "packages/ui/src/Button.tsx",
          action: "modify",
          description: "Fix button",
          dependencies: [],
        },
      ],
    };

    // Agent proposes a change to an unrelated file retrieved via semantic search
    const unapprovedProposedChange = [
      {
        path: "apps/api/src/index.ts", // Not in targetPaths or manifest!
        action: "modify" as const,
        description: "modify without authority",
        content: "// modified without authority",
      },
    ];

    const scopeResult = enforceExecutionScope({
      proposedChanges: unapprovedProposedChange,
      manifest,
      contract,
      existingFilePaths: monorepoSnapshotFiles.map((f) => f.path),
    });

    expect(scopeResult.valid).toBe(false);
    expect(scopeResult.errors.some((e) => e.reason === "TARGET_PATH_VIOLATION")).toBe(true);
  });

  // 10. Package-aware npm validation
  test("10. Package-aware npm validation", () => {
    const npmMonorepo: MonorepoDescriptor = {
      isMonorepo: true,
      type: "npm",
      packageManager: "npm",
      rootPath: "/mock/repo",
      hasTurbo: false,
      workspaces: [
        {
          name: "@repo/ui",
          relativePath: "packages/ui",
          packageJsonPath: "packages/ui/package.json",
          dependencies: new Set(),
          scripts: { build: "tsc", test: "jest" },
        },
      ],
      packageByPath: new Map(),
      packageByName: new Map(),
      packageDependencies: new Map(),
      packageDependents: new Map(),
    };
    npmMonorepo.packageByPath.set("packages/ui", npmMonorepo.workspaces[0]);
    npmMonorepo.packageByName.set("@repo/ui", npmMonorepo.workspaces[0]);

    const cmds = ValidationPlanner.detectValidationCommands(null, null, undefined, {
      monorepo: npmMonorepo,
      changedFiles: ["packages/ui/src/Button.tsx"],
    });

    expect(cmds).toContain("npm run build --workspace=@repo/ui");
    expect(cmds).toContain("npm test --workspace=@repo/ui");
  });

  // 11. Package-aware pnpm validation
  test("11. Package-aware pnpm validation", () => {
    const pnpmMonorepo: MonorepoDescriptor = {
      isMonorepo: true,
      type: "pnpm",
      packageManager: "pnpm",
      rootPath: "/mock/repo",
      hasTurbo: false,
      workspaces: [
        {
          name: "@repo/ui",
          relativePath: "packages/ui",
          packageJsonPath: "packages/ui/package.json",
          dependencies: new Set(),
          scripts: { build: "tsc", test: "jest" },
        },
      ],
      packageByPath: new Map(),
      packageByName: new Map(),
      packageDependencies: new Map(),
      packageDependents: new Map(),
    };
    pnpmMonorepo.packageByPath.set("packages/ui", pnpmMonorepo.workspaces[0]);
    pnpmMonorepo.packageByName.set("@repo/ui", pnpmMonorepo.workspaces[0]);

    const cmds = ValidationPlanner.detectValidationCommands(null, null, undefined, {
      monorepo: pnpmMonorepo,
      changedFiles: ["packages/ui/src/Button.tsx"],
    });

    expect(cmds).toContain("pnpm --filter @repo/ui build");
    expect(cmds).toContain("pnpm --filter @repo/ui test");
  });

  // 12. Package-aware yarn validation
  test("12. Package-aware yarn validation", () => {
    const yarnMonorepo: MonorepoDescriptor = {
      isMonorepo: true,
      type: "yarn",
      packageManager: "yarn",
      rootPath: "/mock/repo",
      hasTurbo: false,
      workspaces: [
        {
          name: "@repo/ui",
          relativePath: "packages/ui",
          packageJsonPath: "packages/ui/package.json",
          dependencies: new Set(),
          scripts: { build: "tsc", test: "jest" },
        },
      ],
      packageByPath: new Map(),
      packageByName: new Map(),
      packageDependencies: new Map(),
      packageDependents: new Map(),
    };
    yarnMonorepo.packageByPath.set("packages/ui", yarnMonorepo.workspaces[0]);
    yarnMonorepo.packageByName.set("@repo/ui", yarnMonorepo.workspaces[0]);

    const cmds = ValidationPlanner.detectValidationCommands(null, null, undefined, {
      monorepo: yarnMonorepo,
      changedFiles: ["packages/ui/src/Button.tsx"],
    });

    expect(cmds).toContain("yarn workspace @repo/ui build");
    expect(cmds).toContain("yarn workspace @repo/ui test");
  });

  // 13. Turbo filtered validation
  test("13. Turbo filtered validation", () => {
    const turboMonorepo: MonorepoDescriptor = {
      isMonorepo: true,
      type: "turbo",
      packageManager: "npm",
      rootPath: "/mock/repo",
      hasTurbo: true,
      workspaces: [
        {
          name: "@repo/ui",
          relativePath: "packages/ui",
          packageJsonPath: "packages/ui/package.json",
          dependencies: new Set(),
          scripts: { build: "tsc", test: "jest" },
        },
      ],
      packageByPath: new Map(),
      packageByName: new Map(),
      packageDependencies: new Map(),
      packageDependents: new Map(),
    };
    turboMonorepo.packageByPath.set("packages/ui", turboMonorepo.workspaces[0]);
    turboMonorepo.packageByName.set("@repo/ui", turboMonorepo.workspaces[0]);

    const cmds = ValidationPlanner.detectValidationCommands(null, null, undefined, {
      monorepo: turboMonorepo,
      changedFiles: ["packages/ui/src/Button.tsx"],
    });

    expect(cmds).toContain("npx turbo run build --filter=@repo/ui");
    expect(cmds).toContain("npx turbo run test --filter=@repo/ui");
  });

  // 14. Types change validates direct dependents web + api
  test("14. Types change validates direct dependents web + api", () => {
    // In npm workspaces, modifying types triggers sequential validation of types + web + api
    const descriptor = MonorepoDetector.detectMonorepo(null, monorepoSnapshotFiles);
    // Switch to npm without turbo for testing sequential dependent validation
    descriptor.hasTurbo = false;
    descriptor.packageManager = "npm";

    const cmds = ValidationPlanner.detectValidationCommands(null, null, undefined, {
      monorepo: descriptor,
      changedFiles: ["packages/types/src/index.ts"],
    });

    expect(cmds).toContain("npm run build --workspace=@repo/types");
    expect(cmds).toContain("npm run build --workspace=@repo/web");
    expect(cmds).toContain("npm run build --workspace=@repo/api");
  });

  // 15. Dependent validation does NOT grant write authority
  test("15. Dependent validation does NOT grant write authority", () => {
    // Contract authorized ONLY packages/types/src/index.ts
    const contract: ExecutionContract = {
      ...baseContract,
      taskType: "BUG_FIX",
      goal: "Update User type definition",
      allowedActions: ["modify"],
      forbiddenActions: ["delete", "create"],
      targetPaths: ["packages/types/src/index.ts"],
      maxFiles: 2,
    };

    const manifest: FileManifest = {
      manifestVersion: "1.0.0",
      totalFiles: 1,
      files: [
        {
          path: "packages/types/src/index.ts",
          action: "modify",
          description: "Update User interface",
          dependencies: [],
        },
      ],
    };

    // Dependent app (apps/web/src/App.tsx) was validated, but agent attempts to edit it without authorization
    const unauthorizedEditToDependent = [
      {
        path: "apps/web/src/App.tsx",
        action: "modify" as const,
        description: "unauthorized edit to dependent",
        content: "export function App() { return <div>modified</div>; }",
      },
    ];

    const result = enforceExecutionScope({
      proposedChanges: unauthorizedEditToDependent,
      manifest,
      contract,
      existingFilePaths: monorepoSnapshotFiles.map((f) => f.path),
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.reason === "TARGET_PATH_VIOLATION")).toBe(true);
  });

  // 16. Nested app entry apps/web/src/App.tsx is recognized
  test("16. Nested app entry apps/web/src/App.tsx is recognized", () => {
    const entry = detectPrimaryActiveEntryPoint([
      "apps/web/src/App.tsx",
      "packages/ui/src/Button.tsx",
      "packages/types/src/index.ts",
    ]);
    expect(entry).toBe("apps/web/src/App.tsx");

    const arch = detectRepositoryArchitecture([
      "apps/web/app/page.tsx",
      "apps/web/app/layout.tsx",
      "packages/ui/src/Button.tsx",
    ]);
    expect(arch.hasAppRouter).toBe(true);
    expect(arch.router).toBe("APP_ROUTER");
  });

  // 17. Explicit hard target paths remain enforced
  test("17. Explicit hard target paths remain enforced", () => {
    const contract: ExecutionContract = {
      ...baseContract,
      taskType: "BUG_FIX",
      goal: "Fix Button label prop",
      allowedActions: ["modify"],
      forbiddenActions: ["delete", "create"],
      targetPaths: ["packages/ui/src/Button.tsx"],
      maxFiles: 1,
    };

    const manifest: FileManifest = {
      manifestVersion: "1.0.0",
      totalFiles: 2,
      files: [
        {
          path: "packages/ui/src/Button.tsx",
          action: "modify",
          description: "Fix button",
          dependencies: [],
        },
        {
          path: "packages/types/src/index.ts", // Violates contract maxFiles & undeclared
          action: "modify",
          description: "Sneak in a types change",
          dependencies: [],
        },
      ],
    };

    const result = enforceExecutionScope({
      proposedChanges: [
        {
          path: "packages/ui/src/Button.tsx",
          action: "modify",
          description: "button edit",
          content: "// button",
        },
        {
          path: "packages/types/src/index.ts",
          action: "modify",
          description: "types edit",
          content: "// types",
        },
      ],
      manifest,
      contract,
      existingFilePaths: monorepoSnapshotFiles.map((f) => f.path),
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.reason === "MAX_FILES_EXCEEDED")).toBe(true);
  });

  // 18. Single-repo fixture behaves exactly as before
  test("18. Single-repo fixture behaves exactly as before", () => {
    const singleRepoFiles = [
      {
        path: "package.json",
        content: JSON.stringify({
          name: "single-repo-app",
          scripts: {
            build: "next build",
            test: "jest",
          },
          dependencies: {
            next: "14.0.0",
            react: "18.0.0",
          },
        }),
      },
      { path: "src/app/page.tsx", content: "export default function Page() { return <h1>Home</h1>; }" },
    ];

    const descriptor = MonorepoDetector.detectMonorepo(null, singleRepoFiles);
    expect(descriptor.isMonorepo).toBe(false);
    expect(descriptor.type).toBe("none");

    const entry = detectPrimaryActiveEntryPoint(singleRepoFiles.map((f) => f.path));
    expect(entry).toBe("src/app/page.tsx");

    materializeSnapshotToDisk(tempDir, singleRepoFiles);
    const cmds = ValidationPlanner.detectValidationCommands(tempDir, singleRepoFiles);
    expect(cmds).toContain("npm run build");

    const installPlan = WorktreeDependencyService.resolveDependencyInstallPlan(tempDir);
    // Has dependencies in package.json but no lockfile -> requires lockfile
    expect(installPlan.needed).toBe(true);
  });
});
