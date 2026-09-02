import { StaticValidationEngine } from "../../services/static-validator.engine";
import { ValidationDetector } from "../validation/ValidationDetector";
import { PipelineResultBuilder } from "../orchestration/PipelineResult";
import {
  detectPrimaryActiveEntryPoint,
  isExistingPrimaryUIRefinement,
  isFullPageDashboardRequest,
  detectRepositoryArchitecture,
} from "../planning/RepositoryArchitectureDetector";
import { ManifestGenerator } from "../../services/manifest-generator";
import { ExecutionContract, FeatureValidationResult } from "../shared/types";

describe("UI Feature Integration Quality: Stylesheet Wiring & Full-Page Dashboard Generation Safety", () => {
  const defaultContract: ExecutionContract = {
    goal: "Improve the dashboard UI and make it a professional customer support dashboard",
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

  describe("Part N & O & P & Q: Stylesheet Integration Static Validation (Task-Delta Aware)", () => {
    test("Regression 1 & Part N: Created CSS with NO import fails static validation and style_integration check", async () => {
      const snapshot = {
        keyFiles: [
          { path: "app/layout.tsx", content: "export default function Layout({ children }: any) { return <html><body>{children}</body></html>; }" },
          { path: "app/page.tsx", content: "import SupportDashboard from './components/SupportDashboard';\nexport default function Home() { return <main><SupportDashboard /></main>; }" },
        ],
      };

      const changes = [
        {
          path: "app/styles/support.css",
          action: "create" as const,
          content: ".support-dashboard { display: flex; }\n.support-sidebar { width: 250px; }",
          description: "Support stylesheet",
        },
        {
          path: "app/components/SupportDashboard.tsx",
          action: "create" as const,
          content: "export default function SupportDashboard() { return <div className=\"support-dashboard\">Dashboard</div>; }",
          description: "Support dashboard component",
        },
        {
          path: "app/page.tsx",
          action: "modify" as const,
          content: "import SupportDashboard from './components/SupportDashboard';\nexport default function Home() { return <main><SupportDashboard /></main>; }",
          description: "Home page rendering support dashboard",
        },
      ];

      // Static AST Engine check directly
      const staticResult = StaticValidationEngine.validate(snapshot.keyFiles, changes);
      expect(staticResult.passed).toBe(false);
      const styleIssue = staticResult.issues.find((i) => i.checkId === "missing_stylesheet_import");
      expect(styleIssue).toBeDefined();
      expect(styleIssue?.file).toBe("app/styles/support.css");

      // Full ValidationDetector run
      const validation = await ValidationDetector.runFeatureValidation(
        changes,
        snapshot,
        "Improve the dashboard UI and make it a professional customer support dashboard",
        defaultContract
      );

      const styleCheck = validation.checks.find((c) => c.id === "style_integration");
      expect(styleCheck).toBeDefined();
      expect(styleCheck?.status).toBe("FAIL");
      expect(validation.overallPassed).toBe(false);

      // PipelineResultBuilder checklist
      const items = PipelineResultBuilder.buildChecklist(
        defaultContract,
        validation,
        0.95,
        true
      );
      const styleItem = items.find((i) => i.label === "Stylesheets integrated");
      expect(styleItem?.checked).toBe(false);
      const featureFunctional = items.find((i) => i.label === "Feature functional & working");
      expect(featureFunctional?.checked).toBe(false);
    });

    test("Regression 2 & Part O: Created CSS imported in app/layout.tsx passes style_integration check", async () => {
      const snapshot = {
        keyFiles: [
          { path: "app/layout.tsx", content: "export default function Layout({ children }: any) { return <html><body>{children}</body></html>; }" },
          { path: "app/page.tsx", content: "export default function Home() { return <div>Home</div>; }" },
        ],
      };

      const changes = [
        {
          path: "app/styles/support.css",
          action: "create" as const,
          content: ".support-dashboard { display: flex; }",
          description: "Support stylesheet",
        },
        {
          path: "app/components/SupportDashboard.tsx",
          action: "create" as const,
          content: "export default function SupportDashboard() { return <div className=\"support-dashboard\">Dashboard</div>; }",
          description: "Support dashboard component",
        },
        {
          path: "app/layout.tsx",
          action: "modify" as const,
          content: "import './styles/support.css';\nexport default function Layout({ children }: any) { return <html><body>{children}</body></html>; }",
          description: "Layout with support stylesheet imported",
        },
        {
          path: "app/page.tsx",
          action: "modify" as const,
          content: "import SupportDashboard from './components/SupportDashboard';\nexport default function Home() { return <main><SupportDashboard /></main>; }",
          description: "Home page rendering support dashboard",
        },
      ];

      const validation = await ValidationDetector.runFeatureValidation(
        changes,
        snapshot,
        "Improve the dashboard UI and make it a professional customer support dashboard",
        defaultContract
      );

      const styleCheck = validation.checks.find((c) => c.id === "style_integration");
      expect(styleCheck?.status).toBe("PASS");
      expect(validation.overallPassed).toBe(true);

      const items = PipelineResultBuilder.buildChecklist(
        defaultContract,
        validation,
        0.95,
        true
      );
      const styleItem = items.find((i) => i.label === "Stylesheets integrated");
      expect(styleItem?.checked).toBe(true);
      const featureFunctional = items.find((i) => i.label === "Feature functional & working");
      expect(featureFunctional?.checked).toBe(true);
    });

    test("Regression 3 & Part P: CSS Module imported in component passes style_integration check", async () => {
      const snapshot = {
        keyFiles: [
          { path: "app/layout.tsx", content: "export default function Layout({ children }: any) { return <html><body>{children}</body></html>; }" },
          { path: "app/page.tsx", content: "export default function Home() { return <div>Home</div>; }" },
        ],
      };

      const changes = [
        {
          path: "app/components/Dashboard.module.css",
          action: "create" as const,
          content: ".container { display: flex; }",
          description: "Dashboard CSS module",
        },
        {
          path: "app/components/SupportDashboard.tsx",
          action: "create" as const,
          content: "import styles from './Dashboard.module.css';\nexport default function SupportDashboard() { return <div className={styles.container}>Dashboard</div>; }",
          description: "Support dashboard importing CSS module",
        },
        {
          path: "app/page.tsx",
          action: "modify" as const,
          content: "import SupportDashboard from './components/SupportDashboard';\nexport default function Home() { return <main><SupportDashboard /></main>; }",
          description: "Home page rendering support dashboard",
        },
      ];

      const validation = await ValidationDetector.runFeatureValidation(
        changes,
        snapshot,
        "Improve the dashboard UI and make it a professional customer support dashboard",
        defaultContract
      );

      const styleCheck = validation.checks.find((c) => c.id === "style_integration");
      expect(styleCheck?.status).toBe("PASS");
      expect(validation.overallPassed).toBe(true);
    });

    test("Regression 4 & Part Q: Pre-existing unrelated unused CSS file does NOT fail task-delta validation", async () => {
      const snapshot = {
        keyFiles: [
          { path: "app/layout.tsx", content: "export default function Layout({ children }: any) { return <html><body>{children}</body></html>; }" },
          { path: "app/styles/legacy-unused.css", content: ".old { display: none; }" },
          { path: "app/page.tsx", content: "export default function Home() { return <div>Home</div>; }" },
        ],
      };

      // Current change does NOT touch legacy-unused.css
      const changes = [
        {
          path: "app/components/Card.tsx",
          action: "create" as const,
          content: "export function Card() { return <div>Card</div>; }",
          description: "Card component",
        },
        {
          path: "app/page.tsx",
          action: "modify" as const,
          content: "import { Card } from './components/Card';\nexport default function Home() { return <main><Card /></main>; }",
          description: "Update home page",
        },
      ];

      const staticResult = StaticValidationEngine.validate(snapshot.keyFiles, changes);
      expect(staticResult.passed).toBe(true);
      expect(staticResult.issues.some((i) => i.checkId === "missing_stylesheet_import")).toBe(false);
    });
  });

  describe("Part R & S & T: Full-Page Dashboard Intent & Guidance Detection", () => {
    test("Regression 5 & Part R: 'Improve the dashboard UI' identifies as full-page dashboard request and receives layout guidance", async () => {
      expect(isFullPageDashboardRequest("Improve the dashboard UI and make it a professional customer support dashboard.")).toBe(true);
      expect(isFullPageDashboardRequest("Improve the dashboard UI")).toBe(true);
      expect(isFullPageDashboardRequest("Create an admin dashboard for user management")).toBe(true);
      expect(isFullPageDashboardRequest("Build an analytics dashboard")).toBe(true);

      const existingFiles = ["app/layout.tsx", "app/page.tsx"];
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
                            path: "app/page.tsx",
                            action: "modify",
                            dependencies: ["./components/SupportDashboard", "./styles/support.css"],
                            description: "Render full-width support dashboard",
                          },
                          {
                            path: "app/styles/support.css",
                            action: "create",
                            dependencies: [],
                            description: "Support styles",
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
      await generator.generateManifest(
        "Improve the dashboard UI and make it a professional customer support dashboard.",
        { existingFiles, architecture: arch },
        defaultContract
      );

      expect(sentContext).toContain("FULL-PAGE DASHBOARD LAYOUT & STYLESHEET WIRING GUIDELINES");
      expect(sentContext).toContain("Viewport & Application Shell");
      expect(sentContext).toContain("Information Architecture");
      expect(sentContext).toContain("Mandatory Stylesheet Wiring");
    });

    test("Regression 6 & Part S: 'Improve this small card component.' does NOT trigger full-page dashboard layout requirements", () => {
      expect(isFullPageDashboardRequest("Improve this small card component.")).toBe(false);
      expect(isFullPageDashboardRequest("Fix the button component style")).toBe(false);
      expect(isFullPageDashboardRequest("Add a tooltip to the avatar")).toBe(false);
    });

    test("Regression 7 & Part T: Previous active entry grounding is preserved alongside dashboard quality rules", async () => {
      const existingFiles = ["app/layout.tsx", "app/page.tsx"];
      const arch = detectRepositoryArchitecture(existingFiles, {
        dependencies: { next: "14.0.0", react: "18.0.0" },
      });

      expect(arch.primaryActiveEntryPoint).toBe("app/page.tsx");
      expect(isExistingPrimaryUIRefinement("Improve the dashboard UI and make it a professional customer support dashboard.")).toBe(true);
      expect(isFullPageDashboardRequest("Improve the dashboard UI and make it a professional customer support dashboard.")).toBe(true);
    });
  });
});
