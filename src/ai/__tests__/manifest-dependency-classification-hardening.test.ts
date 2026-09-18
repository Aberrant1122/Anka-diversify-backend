import { ManifestDependencyResolver } from "../planning/ManifestDependencyResolver";
import { ManifestValidator } from "../../services/manifest-validator";
import { ExecutionContract, FileManifest } from "../../types";
import { MonorepoDescriptor, WorkspacePackage } from "../workspace/MonorepoDetector";
import { normalizeManifestDependencyIntent } from "../planning/ManifestCorrectionEngine";

const contract: ExecutionContract = {
  goal: "Update repository files",
  taskType: "NEW_FEATURE",
  risk: "LOW",
  estimatedComplexity: "SMALL",
  pipeline: "REPOSITORY",
  environment: "REACT_TS",
  repositoryRequired: true,
  expectedFiles: [],
  validationType: "TYPESCRIPT_BUILD",
  allowedActions: ["modify_file", "create_file", "delete_file"],
  forbiddenActions: [],
  maxFiles: 10,
  targetPaths: [],
  searchScope: [],
  contextScope: [],
  diffCriticEnabled: true,
};

function resolver(options: {
  existingFiles?: string[];
  manifestFiles?: string[];
  installedPackages?: string[];
  configurationFiles?: Array<{ path: string; content: string }>;
  monorepo?: MonorepoDescriptor;
} = {}): ManifestDependencyResolver {
  return new ManifestDependencyResolver({
    existingFiles: options.existingFiles || [],
    manifestFiles: options.manifestFiles || [],
    installedPackages: options.installedPackages || [],
    configurationFiles: options.configurationFiles,
    monorepo: options.monorepo,
  });
}

function manifestWithDependency(dependency: string): FileManifest {
  return {
    files: [{ path: "app/page.tsx", action: "modify", dependencies: [dependency], description: "Update page" }],
    totalFiles: 1,
    manifestVersion: "1.0.0",
  };
}

function workspaceDescriptor(): MonorepoDescriptor {
  const workspace: WorkspacePackage = {
    name: "@workspace/ui",
    relativePath: "packages/ui",
    packageJsonPath: "packages/ui/package.json",
    dependencies: new Set(),
    scripts: {},
    tsconfigPath: "packages/ui/tsconfig.json",
  };
  return {
    isMonorepo: true,
    type: "npm",
    packageManager: "npm",
    rootPath: "",
    hasTurbo: false,
    workspaces: [workspace],
    packageByPath: new Map([[workspace.relativePath, workspace]]),
    packageByName: new Map([[workspace.name, workspace]]),
    packageDependencies: new Map([[workspace.name, new Set()]]),
    packageDependents: new Map([[workspace.name, new Set()]]),
  };
}

describe("manifest dependency classification hardening", () => {
  test.each([
    ["components/ExistingWidget.tsx", "components/ExistingWidget.tsx", "app/page.tsx"],
    ["src/components/Foo.tsx", "src/components/Foo.tsx", "app/page.tsx"],
    ["./Foo", "src/features/Foo.svelte", "src/features/Host.ts"],
    ["../lib/tasks", "src/lib/tasks.mjs", "src/features/Host.ts"],
  ])("resolves repository dependency %s before package validation", (value, existingFile, owner) => {
    const result = resolver({ existingFiles: [existingFile] }).resolve(owner, { value, intent: "LEGACY" });
    expect(result.classification).toBe("REPOSITORY");
  });

  test("resolves only aliases proven by repository configuration", () => {
    const configured = resolver({
      existingFiles: ["src/shared/Foo.ts"],
      configurationFiles: [{
        path: "tsconfig.json",
        content: JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@shared/*": ["src/shared/*"] } } }),
      }],
    });
    expect(configured.resolve("src/App.ts", { value: "@shared/Foo", intent: "EXTERNAL" }).classification).toBe("REPOSITORY");

    const validator = new ManifestValidator(contract, {
      existingFiles: ["app/page.tsx", "tsconfig.json"],
      installedPackages: ["react"],
      configurationFiles: [{
        path: "tsconfig.json",
        content: JSON.stringify({ compilerOptions: { paths: { "@shared/*": ["src/shared/*"] } } }),
      }],
    });
    const result = validator.validateImports(manifestWithDependency("@shared/Missing"));
    expect(result.some((error) => error.type === "import_resolution")).toBe(true);
    expect(result.some((error) => error.type === "external-dependency-missing")).toBe(false);
  });

  test.each(["create", "delete"] as const)("same-manifest %s target remains a repository entity", (action) => {
    const manifest: FileManifest = {
      files: [
        { path: "app/page.tsx", action: "modify", dependencies: ["components/PlannedWidget.tsx"], description: "Integrate widget" },
        { path: "components/PlannedWidget.tsx", action, dependencies: [], description: "Planned repository entity" },
      ],
      totalFiles: 2,
      manifestVersion: "1.0.0",
    };
    const validator = new ManifestValidator(contract, { existingFiles: ["app/page.tsx"], installedPackages: ["react"] });
    expect(validator.validateImports(manifest)).toEqual([]);
  });

  test.each([
    ["next/link", "next"],
    ["lucide-react", "lucide-react"],
    ["@scope/package", "@scope/package"],
    ["@scope/package/subpath", "@scope/package"],
  ])("normalizes external package %s to %s", (value, packageName) => {
    const result = resolver({ installedPackages: ["next", "lucide-react"] }).resolve("src/App.ts", { value, intent: "LEGACY" });
    expect(result).toMatchObject({ classification: "EXTERNAL", packageName });
  });

  test("genuine uninstalled package remains rejected", () => {
    const validator = new ManifestValidator(contract, { existingFiles: ["app/page.tsx"], installedPackages: ["react"] });
    const errors = validator.validateImports(manifestWithDependency("some-uninstalled-package"));
    expect(errors).toEqual(expect.arrayContaining([expect.objectContaining({ type: "external-dependency-missing" })]));
  });

  test("externalPackages cannot override an existing repository file", () => {
    const manifest: FileManifest = {
      files: [{
        path: "app/page.tsx",
        action: "modify",
        dependencies: [],
        externalPackages: [{ packageName: "components/ExistingWidget.tsx" }],
        description: "Replace existing widget",
      }],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    };
    const validator = new ManifestValidator(contract, {
      existingFiles: ["app/page.tsx", "components/ExistingWidget.tsx"],
      installedPackages: ["react"],
    });
    const errors = validator.validateImports(manifest);
    expect(errors.some((error) => error.type === "external-dependency-missing" || error.message.includes("package 'components'"))).toBe(false);
  });

  test("repositoryDependencies cannot override a known external package", () => {
    const result = resolver({ installedPackages: ["lucide-react"] }).resolve("src/App.ts", {
      value: "lucide-react",
      intent: "REPOSITORY",
    });
    expect(result).toMatchObject({ classification: "EXTERNAL", packageName: "lucide-react" });
  });

  test("correction normalization deterministically repairs inverted typed intent", () => {
    const manifest: FileManifest = {
      files: [{
        path: "app/page.tsx",
        action: "modify",
        dependencies: [],
        repositoryDependencies: [{ path: "lucide-react" }],
        externalPackages: [{ packageName: "components/ExistingWidget.tsx" }],
        description: "Normalize dependency intent",
      }],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    };
    const normalized = normalizeManifestDependencyIntent(manifest, {
      existingFiles: ["app/page.tsx", "components/ExistingWidget.tsx"],
      architecture: {
        framework: "VITE_REACT",
        router: "NONE",
        hasAppRouter: false,
        hasPagesRouter: false,
        hasTailwind: false,
        existingEntryPoints: [],
        primaryActiveEntryPoint: null,
        existingUIComponents: [],
        existingStyleFiles: [],
        installedUILibraries: [],
        guidelines: [],
        installedPackages: ["lucide-react"],
        packageVersions: {},
      },
    });
    expect(normalized.files[0].repositoryDependencies).toEqual([{ path: "components/ExistingWidget.tsx" }]);
    expect(normalized.files[0].externalPackages).toEqual([{ packageName: "lucide-react" }]);
    expect(normalized.files[0].dependencies).toEqual([]);
  });

  test("ambiguous unresolved strings fail closed without guessing", () => {
    const result = resolver().resolve("src/App.ts", { value: "unknown/subpath", intent: "LEGACY" });
    expect(result.classification).toBe("UNRESOLVED");
  });

  test("workspace package and subpath resolve as repository dependencies", () => {
    const monorepo = workspaceDescriptor();
    const rootResult = resolver({ monorepo, existingFiles: ["packages/ui/package.json", "packages/ui/src/Button.tsx"] })
      .resolve("apps/web/page.tsx", { value: "@workspace/ui", intent: "EXTERNAL" });
    const subpathResult = resolver({ monorepo, existingFiles: ["packages/ui/package.json", "packages/ui/src/Button.tsx"] })
      .resolve("apps/web/page.tsx", { value: "@workspace/ui/Button", intent: "EXTERNAL" });
    expect(rootResult.classification).toBe("REPOSITORY");
    expect(subpathResult.classification).toBe("REPOSITORY");
  });

  test.each(["../../outside/file.ts", "C:\\outside\\file.ts", "..\\..\\outside\\file.ts"])(
    "rejects traversal or absolute Windows dependency %s",
    (value) => {
      const result = resolver({ existingFiles: ["src/App.ts"] }).resolve("src/App.ts", { value, intent: "LEGACY" });
      expect(result.classification).toBe("UNRESOLVED_LOCAL");
    },
  );

  test("normalizes bounded Windows separators without escaping", () => {
    const result = resolver({ existingFiles: ["components/Foo.tsx"] }).resolve("app/page.tsx", {
      value: "components\\Foo.tsx",
      intent: "EXTERNAL",
    });
    expect(result.classification).toBe("REPOSITORY");
  });

  test("replacement planning never sends a root-relative repository path to external validation", () => {
    const manifest: FileManifest = {
      files: [
        { path: "app/page.tsx", action: "modify", dependencies: ["ui/LegacyPanel.tsx"], description: "Replace old panel" },
        { path: "ui/LegacyPanel.tsx", action: "delete", dependencies: [], description: "Remove old panel" },
        { path: "ui/NewPanel.tsx", action: "create", dependencies: [], description: "Add replacement panel" },
      ],
      totalFiles: 3,
      manifestVersion: "1.0.0",
    };
    const validator = new ManifestValidator(contract, {
      existingFiles: ["app/page.tsx", "ui/LegacyPanel.tsx"],
      installedPackages: ["react"],
    });
    const errors = validator.validateImports(manifest);
    expect(errors.some((error) => error.type === "external-dependency-missing")).toBe(false);
  });
});
