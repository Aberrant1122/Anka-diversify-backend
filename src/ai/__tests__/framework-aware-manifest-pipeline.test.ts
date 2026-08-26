import { detectRepositoryArchitecture } from "../planning/RepositoryArchitectureDetector";
import { ManifestValidator } from "../../services/manifest-validator";
import { ManifestCorrectionEngine } from "../planning/ManifestCorrectionEngine";
import { FileManifest, ExecutionContract } from "../../types";

describe("AI Step 16 — Framework-Aware Router Constraints & Deterministic Manifest Validation", () => {
  const nextJsAppRouterFiles = [
    "package.json",
    "tsconfig.json",
    "app/layout.tsx",
    "app/page.tsx",
    "app/globals.css",
    "components/Calculator.tsx",
    "components/CalculatorButton.tsx",
    "components/CalculatorDisplay.tsx",
  ];

  const nextJsPagesRouterFiles = [
    "package.json",
    "tsconfig.json",
    "pages/_app.tsx",
    "pages/index.tsx",
    "styles/globals.css",
  ];

  const nextJsHybridFiles = [
    "package.json",
    "tsconfig.json",
    "app/layout.tsx",
    "app/page.tsx",
    "pages/api/health.ts",
    "pages/legacy.tsx",
  ];

  const dummyContract: ExecutionContract = {
    goal: "Implement feature",
    taskType: "NEW_FEATURE",
    risk: "MEDIUM",
    estimatedComplexity: "MEDIUM",
    pipeline: "REPOSITORY",
    environment: "NODE_JS",
    repositoryRequired: true,
    expectedFiles: [],
    validationType: "TYPESCRIPT_BUILD",
    targetPaths: [],
    allowedActions: ["create", "modify"],
    forbiddenActions: [],
    maxFiles: 10,
    searchScope: [],
    contextScope: [],
    diffCriticEnabled: false,
  };

  test("A. App Router-only repo is detected correctly", () => {
    const arch = detectRepositoryArchitecture(nextJsAppRouterFiles, JSON.stringify({ dependencies: { next: "^14.0.0" } }));
    expect(arch.framework).toBe("NEXT_JS");
    expect(arch.router).toBe("APP_ROUTER");
    expect(arch.hasAppRouter).toBe(true);
    expect(arch.hasPagesRouter).toBe(false);
    expect(arch.existingEntryPoints).toContain("app/layout.tsx");
    expect(arch.existingEntryPoints).toContain("app/page.tsx");
  });

  test("B. Pages Router-only repo is detected correctly", () => {
    const arch = detectRepositoryArchitecture(nextJsPagesRouterFiles, JSON.stringify({ dependencies: { next: "^14.0.0" } }));
    expect(arch.framework).toBe("NEXT_JS");
    expect(arch.router).toBe("PAGES_ROUTER");
    expect(arch.hasAppRouter).toBe(false);
    expect(arch.hasPagesRouter).toBe(true);
    expect(arch.existingEntryPoints).toContain("pages/index.tsx");
  });

  test("C. Hybrid repo is detected correctly", () => {
    const arch = detectRepositoryArchitecture(nextJsHybridFiles, JSON.stringify({ dependencies: { next: "^14.0.0" } }));
    expect(arch.framework).toBe("NEXT_JS");
    expect(arch.router).toBe("HYBRID");
    expect(arch.hasAppRouter).toBe(true);
    expect(arch.hasPagesRouter).toBe(true);
  });

  test("D. App Router-only manifest creating src/pages/calculator.tsx fails with router-architecture error", () => {
    const validator = new ManifestValidator(dummyContract, nextJsAppRouterFiles);
    const manifestWithInventedPages: FileManifest = {
      files: [
        {
          path: "src/pages/calculator.tsx",
          action: "create",
          description: "Invented pages router page",
          dependencies: [],
        },
      ],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    };

    const result = validator.validate(manifestWithInventedPages);
    expect(result.valid).toBe(false);
    const routerErr = result.errors.find((e) => (e.type as string) === "router-architecture");
    expect(routerErr).toBeDefined();
    expect(routerErr?.message).toContain("App-Router-only project");
  });

  test("E. App Router route app/calculator/page.tsx can be a valid entrypoint", () => {
    const validator = new ManifestValidator(dummyContract, nextJsAppRouterFiles);
    const manifestWithAppRoute: FileManifest = {
      files: [
        {
          path: "app/calculator/page.tsx",
          action: "create",
          description: "Legitimate App Router page",
          dependencies: [],
        },
      ],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    };

    const result = validator.validate(manifestWithAppRoute);
    expect(result.valid).toBe(true);
  });

  test("F. Existing Calculator.tsx is preferred/surfaced in planning guidelines", () => {
    const arch = detectRepositoryArchitecture(nextJsAppRouterFiles, JSON.stringify({ dependencies: { next: "^14.0.0" } }));
    expect(arch.guidelines.some((g) => g.includes("Prefer reusing and modifying existing components"))).toBe(true);
    expect(arch.guidelines.some((g) => g.includes("Do NOT invent pages/ or src/pages/"))).toBe(true);
  });

  test("G & H. One invalid manifest receives exactly ONE correction attempt and corrected manifest passes", async () => {
    const rejectedManifest: FileManifest = {
      files: [
        {
          path: "src/pages/calculator.tsx",
          action: "create",
          description: "Pages router page",
          dependencies: [],
        },
      ],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    };

    const validationErrors = [
      {
        type: "router-architecture" as any,
        affectedFiles: ["src/pages/calculator.tsx"],
        message: "[router-architecture] Manifest attempts to create Pages Router file 'src/pages/calculator.tsx' in an App-Router-only project.",
        suggestion: "Use verified App Router structure instead (e.g. app/**/page.tsx or embed in existing app/page.tsx).",
      },
    ];

    const mockOpenAI: any = {
      chat: {
        completions: {
          create: jest.fn().mockResolvedValue({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    files: [
                      {
                        path: "components/Calculator.tsx",
                        action: "modify",
                        description: "Upgrade existing calculator to scientific calculator",
                        dependencies: ["react", "./CalculatorButton", "./CalculatorDisplay"],
                      },
                      {
                        path: "app/page.tsx",
                        action: "modify",
                        description: "Render updated scientific calculator",
                        dependencies: ["../components/Calculator"],
                      },
                    ],
                    totalFiles: 2,
                    manifestVersion: "1.0.0",
                  }),
                },
              },
            ],
          }),
        },
      },
    };

    const corrected = await ManifestCorrectionEngine.attemptCorrection(
      rejectedManifest,
      validationErrors,
      "make a scientific calculator",
      {
        existingFiles: nextJsAppRouterFiles,
        architecture: detectRepositoryArchitecture(nextJsAppRouterFiles),
      },
      dummyContract,
      mockOpenAI
    );

    expect(corrected).not.toBeNull();
    expect(mockOpenAI.chat.completions.create).toHaveBeenCalledTimes(1);

    const validator = new ManifestValidator(dummyContract, nextJsAppRouterFiles);
    const reval = validator.validate(corrected!);
    expect(reval.valid).toBe(true);
  });

  test("I. Second invalid correction fails closed", async () => {
    const mockOpenAI: any = {
      chat: {
        completions: {
          create: jest.fn().mockResolvedValue({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    files: [
                      {
                        path: "src/pages/stillInvalid.tsx",
                        action: "create",
                        description: "Still invalid pages router",
                        dependencies: [],
                      },
                    ],
                    totalFiles: 1,
                    manifestVersion: "1.0.0",
                  }),
                },
              },
            ],
          }),
        },
      },
    };

    const corrected = await ManifestCorrectionEngine.attemptCorrection(
      { files: [], totalFiles: 0, manifestVersion: "1.0.0" },
      [],
      "test",
      {
        existingFiles: nextJsAppRouterFiles,
        architecture: detectRepositoryArchitecture(nextJsAppRouterFiles),
      },
      dummyContract,
      mockOpenAI
    );

    const validator = new ManifestValidator(dummyContract, nextJsAppRouterFiles);
    const reval = validator.validate(corrected!);
    expect(reval.valid).toBe(false);
  });

  test("J. Existing orphan-helper detection remains intact", () => {
    const validator = new ManifestValidator(dummyContract, nextJsAppRouterFiles);
    const orphanHelperManifest: FileManifest = {
      files: [
        {
          path: "lib/orphanHelper.ts",
          action: "create",
          description: "Helper not imported anywhere",
          dependencies: [],
        },
      ],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    };

    const result = validator.validate(orphanHelperManifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.type === "orphan")).toBe(true);
  });
});
