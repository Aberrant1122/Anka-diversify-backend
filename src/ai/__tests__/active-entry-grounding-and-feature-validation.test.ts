import {
  detectPrimaryActiveEntryPoint,
  isExistingPrimaryUIRefinement,
  detectRepositoryArchitecture,
} from "../planning/RepositoryArchitectureDetector";
import { ManifestGenerator } from "../../services/manifest-generator";
import { PipelineResultBuilder } from "../orchestration/PipelineResult";
import { ValidationDetector } from "../validation/ValidationDetector";
import { ExecutionContract, FeatureValidationResult } from "../shared/types";

describe("Active Entry-Point Grounding & Feature Validation Truthfulness", () => {
  const defaultContract: ExecutionContract = {
    goal: "Improve the dashboard UI",
    taskType: "NEW_FEATURE",
    risk: "MEDIUM",
    estimatedComplexity: "MEDIUM",
    pipeline: "REPOSITORY",
    environment: "REACT_TS",
    repositoryRequired: true,
    expectedFiles: [],
    validationType: "TYPESCRIPT_BUILD",
    allowedActions: ["create", "modify", "delete"],
    forbiddenActions: [],
    maxFiles: 10,
    targetPaths: ["app/", "src/"],
    searchScope: ["app/", "src/"],
    contextScope: ["app/", "src/"],
    diffCriticEnabled: true,
  };

  describe("Part A & B & C: Active Entry-Point Detection and Prompt Semantics", () => {
    test("Regression 1 & Part A: Next.js App Router detects app/page.tsx as primary active entry point", () => {
      const files = [
        "app/layout.tsx",
        "app/page.tsx",
        "app/components/Card.tsx",
        "package.json",
      ];
      const entry = detectPrimaryActiveEntryPoint(files);
      expect(entry).toBe("app/page.tsx");
    });

    test("Next.js Pages Router detects pages/index.tsx as primary active entry point", () => {
      const files = [
        "pages/_app.tsx",
        "pages/index.tsx",
        "components/Header.tsx",
        "package.json",
      ];
      const entry = detectPrimaryActiveEntryPoint(files);
      expect(entry).toBe("pages/index.tsx");
    });

    test("Vite React detects src/App.tsx as primary active entry point", () => {
      const files = [
        "src/main.tsx",
        "src/App.tsx",
        "src/components/Dashboard.tsx",
        "package.json",
      ];
      const entry = detectPrimaryActiveEntryPoint(files);
      expect(entry).toBe("src/App.tsx");
    });

    test("Part C & Regression 1: 'Improve the dashboard UI' identifies as existing primary UI refinement", () => {
      expect(isExistingPrimaryUIRefinement("Improve the dashboard UI.")).toBe(true);
      expect(isExistingPrimaryUIRefinement("Enhance the dashboard UI and make a professional customer support dashboard")).toBe(true);
      expect(isExistingPrimaryUIRefinement("Redesign the homepage with modern widgets")).toBe(true);
      expect(isExistingPrimaryUIRefinement("update the main page layout")).toBe(true);
    });

    test("Part C & Regression 2: 'Create a customer support page' does NOT trigger primary UI refinement", () => {
      expect(isExistingPrimaryUIRefinement("Create a customer support page.")).toBe(false);
      expect(isExistingPrimaryUIRefinement("Add an authentication login view")).toBe(false);
      expect(isExistingPrimaryUIRefinement("Build a billing settings endpoint")).toBe(false);
    });
  });

  describe("Part D & E & F: Manifest Generator Active Entry Grounding Context", () => {
    test("Manifest Generator includes active primary entry point grounding when user asks to improve dashboard", async () => {
      const existingFiles = [
        "app/layout.tsx",
        "app/page.tsx",
        "app/components/Card.tsx",
      ];
      const arch = detectRepositoryArchitecture(existingFiles, {
        dependencies: { next: "14.0.0", react: "18.0.0" },
      });

      expect(arch.primaryActiveEntryPoint).toBe("app/page.tsx");

      let sentContext = "";
      const mockOpenAI: any = {
        chat: {
          completions: {
            create: async (args: any) => {
              sentContext = args.messages[1]?.content || "";
              return {
                choices: [
                  {
                    message: {
                      content: JSON.stringify({
                        files: [
                          {
                            path: "app/page.tsx",
                            action: "modify",
                            dependencies: ["./components/SupportDashboard"],
                            description: "Render support dashboard on root view",
                          },
                          {
                            path: "app/components/SupportDashboard.tsx",
                            action: "create",
                            dependencies: [],
                            description: "Support dashboard component",
                          },
                        ],
                        totalFiles: 2,
                        manifestVersion: "1.0.0",
                      }),
                    },
                  },
                ],
              };
            },
          },
        },
      };

      const generator = new ManifestGenerator(mockOpenAI);
      const manifest = await generator.generateManifest(
        "Improve the dashboard UI. and make a professional customer support dashboard",
        { existingFiles, architecture: arch },
        defaultContract
      );

      expect(sentContext).toContain("ACTIVE PRIMARY ENTRY POINT GROUNDING");
      expect(sentContext).toContain('Verified Primary Active UI File: "app/page.tsx"');
      expect(manifest.files.some((f) => f.path === "app/page.tsx" && f.action === "modify")).toBe(true);
    });

    test("Manifest Generator does not force active entry point grounding for standalone new page creation", async () => {
      const existingFiles = [
        "app/layout.tsx",
        "app/page.tsx",
      ];
      const arch = detectRepositoryArchitecture(existingFiles, {
        dependencies: { next: "14.0.0", react: "18.0.0" },
      });

      let sentContext = "";
      const mockOpenAI: any = {
        chat: {
          completions: {
            create: async (args: any) => {
              sentContext = args.messages[1]?.content || "";
              return {
                choices: [
                  {
                    message: {
                      content: JSON.stringify({
                        files: [
                          {
                            path: "app/support/page.tsx",
                            action: "create",
                            dependencies: [],
                            description: "Standalone support page",
                          },
                        ],
                        totalFiles: 1,
                        manifestVersion: "1.0.0",
                      }),
                    },
                  },
                ],
              };
            },
          },
        },
      };

      const generator = new ManifestGenerator(mockOpenAI);
      await generator.generateManifest(
        "Create a customer support page.",
        { existingFiles, architecture: arch },
        defaultContract
      );

      expect(sentContext).not.toContain("ACTIVE PRIMARY ENTRY POINT GROUNDING");
    });
  });

  describe("Part H & I & J & K: Evidence-Positive Checklist and Navigation Validation", () => {
    test("Regression 4 & Part P: Missing nav_integration check evaluates to checked: false (not PASS)", () => {
      const emptyValidation: FeatureValidationResult = {
        overallPassed: true,
        checks: [
          { id: "import_export", label: "Import/Export", status: "PASS", checked: true, details: "OK" },
          { id: "route_reachability", label: "Route", status: "PASS", checked: true, details: "OK" },
        ],
        failedChecks: [],
        repairActions: [],
      };

      const items = PipelineResultBuilder.buildChecklist(
        defaultContract,
        emptyValidation,
        0.95,
        true
      );

      const navItem = items.find((i) => i.label === "Navigation updated");
      expect(navItem).toBeDefined();
      expect(navItem?.checked).toBe(false);
    });

    test("Regression 5 & Part Q: Positive nav_integration PASS evaluates to checked: true (✅)", () => {
      const passValidation: FeatureValidationResult = {
        overallPassed: true,
        checks: [
          { id: "import_export", label: "Import/Export", status: "PASS", checked: true, details: "OK" },
          { id: "nav_integration", label: "Navigation Integration", status: "PASS", checked: true, details: "Link added" },
        ],
        failedChecks: [],
        repairActions: [],
      };

      const items = PipelineResultBuilder.buildChecklist(
        defaultContract,
        passValidation,
        0.95,
        true
      );

      const navItem = items.find((i) => i.label === "Navigation updated");
      expect(navItem?.checked).toBe(true);
    });

    test("Regression 6 & Part R: nav_integration FAIL evaluates to checked: false (❌)", () => {
      const failValidation: FeatureValidationResult = {
        overallPassed: false,
        checks: [
          { id: "import_export", label: "Import/Export", status: "PASS", checked: true, details: "OK" },
          { id: "nav_integration", label: "Navigation Integration", status: "FAIL", checked: true, details: "Missing link" },
        ],
        failedChecks: ["Missing link"],
        repairActions: [],
      };

      const items = PipelineResultBuilder.buildChecklist(
        defaultContract,
        failValidation,
        0.95,
        true
      );

      const navItem = items.find((i) => i.label === "Navigation updated");
      expect(navItem?.checked).toBe(false);
    });

    test("Regression 7 & Part S: Target mismatch (user asked to improve dashboard but only created /support) fails intent satisfaction", async () => {
      const snapshot = {
        keyFiles: [
          { path: "app/layout.tsx", content: "export default function Layout({ children }: any) { return <html><body>{children}</body></html>; }" },
          { path: "app/page.tsx", content: "export default function Home() { return <div>My App</div>; }" },
        ],
      };

      const changes = [
        {
          path: "app/components/SupportDashboard.tsx",
          action: "create" as const,
          content: "export function SupportDashboard() { return <div>Support</div>; }",
          description: "Support component",
        },
        {
          path: "app/support/page.tsx",
          action: "create" as const,
          content: 'import { SupportDashboard } from "../components/SupportDashboard";\nexport default function SupportPage() { return <SupportDashboard />; }',
          description: "Support page",
        },
      ];

      const validation = await ValidationDetector.runFeatureValidation(
        changes,
        snapshot,
        "Improve the dashboard UI. and make a professional customer support dashboard",
        defaultContract
      );

      const intentCheck = validation.checks.find((c) => c.id === "intent_satisfaction");
      expect(intentCheck).toBeDefined();
      expect(intentCheck?.status).toBe("FAIL");
      expect(validation.overallPassed).toBe(false);

      const items = PipelineResultBuilder.buildChecklist(
        defaultContract,
        validation,
        0.95,
        true
      );

      const featureFunctionalItem = items.find((i) => i.label === "Feature functional & working");
      expect(featureFunctionalItem?.checked).toBe(false);
    });

    test("Modifying active entry point app/page.tsx satisfies intent validation", async () => {
      const snapshot = {
        keyFiles: [
          { path: "app/layout.tsx", content: "export default function Layout({ children }: any) { return <html><body>{children}</body></html>; }" },
          { path: "app/page.tsx", content: "export default function Home() { return <div>My App</div>; }" },
        ],
      };

      const changes = [
        {
          path: "app/components/SupportDashboard.tsx",
          action: "create" as const,
          content: "export function SupportDashboard() { return <div>Support Dashboard</div>; }",
          description: "Support component",
        },
        {
          path: "app/page.tsx",
          action: "modify" as const,
          content: 'import { SupportDashboard } from "./components/SupportDashboard";\nexport default function Home() { return <main><SupportDashboard /></main>; }',
          description: "Update home page with support dashboard",
        },
      ];

      const validation = await ValidationDetector.runFeatureValidation(
        changes,
        snapshot,
        "Improve the dashboard UI. and make a professional customer support dashboard",
        defaultContract
      );

      const intentCheck = validation.checks.find((c) => c.id === "intent_satisfaction");
      expect(intentCheck?.status).toBe("PASS");
      expect(validation.overallPassed).toBe(true);

      const items = PipelineResultBuilder.buildChecklist(
        defaultContract,
        validation,
        0.95,
        true
      );

      const featureFunctionalItem = items.find((i) => i.label === "Feature functional & working");
      expect(featureFunctionalItem?.checked).toBe(true);
    });
  });
});
