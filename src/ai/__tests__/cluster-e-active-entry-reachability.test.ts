import { ValidationDetector } from "../validation/ValidationDetector";
import { StaticValidationEngine } from "../../services/static-validator.engine";
import { AgentFileChange, ExecutionContract } from "../shared/types";

describe("Cluster E — Active Entry Reachability Validation", () => {
  const defaultContract: ExecutionContract = {
    goal: "Test UI task",
    taskType: "NEW_FEATURE",
    risk: "LOW",
    estimatedComplexity: "MEDIUM",
    pipeline: "REPOSITORY",
    environment: "REACT_TS",
    repositoryRequired: true,
    expectedFiles: [],
    validationType: "TYPESCRIPT_BUILD",
    targetPaths: ["src/", "app/"],
    allowedActions: ["create", "modify"],
    forbiddenActions: [],
    maxFiles: 10,
    searchScope: ["src/", "app/"],
    contextScope: ["src/", "app/"],
    diffCriticEnabled: true,
  };

  // 1. Vite direct reachability: App.tsx -> DashboardPage.tsx, modify DashboardPage.tsx -> PASS
  test("1. Vite: App.tsx -> DashboardPage.tsx, modify DashboardPage.tsx succeeds without App.tsx change", async () => {
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
        content: "export function DashboardPage() { return <h1>ANKA Verified Dashboard</h1>; }",
        description: "Update dashboard header",
      },
    ];

    const result = await ValidationDetector.runFeatureValidation(
      changes,
      snapshot,
      "Update the dashboard header title to 'ANKA Verified Dashboard' and add a subtitle.",
      defaultContract
    );

    const intentCheck = result.checks.find((c) => c.id === "intent_satisfaction");
    expect(intentCheck?.status).toBe("PASS");
    expect(intentCheck?.details).toBe("Active target reachability verified");
    expect(result.overallPassed).toBe(true);
  });

  // 2. Vite transitive reachability: App.tsx -> DashboardPage.tsx -> Header.tsx, modify Header.tsx -> PASS
  test("2. Vite transitive: App.tsx -> DashboardPage.tsx -> Header.tsx, modify Header.tsx succeeds", async () => {
    const snapshot = {
      keyFiles: [
        {
          path: "src/App.tsx",
          content: 'import { DashboardPage } from "./pages/DashboardPage";\nexport function App() { return <DashboardPage />; }',
        },
        {
          path: "src/pages/DashboardPage.tsx",
          content: 'import { Header } from "../components/Header";\nexport function DashboardPage() { return <div><Header /></div>; }',
        },
        {
          path: "src/components/Header.tsx",
          content: "export function Header() { return <header>Title</header>; }",
        },
      ],
    };

    const changes: AgentFileChange[] = [
      {
        path: "src/components/Header.tsx",
        action: "modify",
        content: "export function Header() { return <header>ANKA Header</header>; }",
        description: "Update header component",
      },
    ];

    const result = await ValidationDetector.runFeatureValidation(
      changes,
      snapshot,
      "Improve the dashboard UI and redesign header",
      defaultContract
    );

    const intentCheck = result.checks.find((c) => c.id === "intent_satisfaction");
    expect(intentCheck?.status).toBe("PASS");
    expect(result.overallPassed).toBe(true);
  });

  // 3. Vite orphan: UnusedWidget.tsx not imported, modify/create it -> FAIL
  test("3. Vite orphan: UnusedWidget.tsx not imported anywhere fails as orphan/unreachable target", async () => {
    const snapshot = {
      keyFiles: [
        {
          path: "src/App.tsx",
          content: "export function App() { return <div>App Root</div>; }",
        },
      ],
    };

    const changes: AgentFileChange[] = [
      {
        path: "src/components/UnusedWidget.tsx",
        action: "create",
        content: "export function UnusedWidget() { return <div>Unused</div>; }",
        description: "Create unused widget",
      },
    ];

    const result = await ValidationDetector.runFeatureValidation(
      changes,
      snapshot,
      "Improve dashboard UI with modern widgets",
      defaultContract
    );

    const intentCheck = result.checks.find((c) => c.id === "intent_satisfaction");
    expect(intentCheck?.status).toBe("FAIL");
    expect(intentCheck?.details).toBe("Modified UI target is not reachable from any active frontend entry point.");
    expect(result.overallPassed).toBe(false);
  });

  // 4. CREATE + integration: App -> DashboardPage -> NewBanner -> PASS
  test("4. CREATE + integration: App -> DashboardPage -> NewBanner succeeds", async () => {
    const snapshot = {
      keyFiles: [
        {
          path: "src/App.tsx",
          content: 'import { DashboardPage } from "./pages/DashboardPage";\nexport function App() { return <DashboardPage />; }',
        },
        {
          path: "src/pages/DashboardPage.tsx",
          content: "export function DashboardPage() { return <div>Dashboard</div>; }",
        },
      ],
    };

    const changes: AgentFileChange[] = [
      {
        path: "src/components/NewBanner.tsx",
        action: "create",
        content: "export function NewBanner() { return <aside>Important Announcement</aside>; }",
        description: "New banner component",
      },
      {
        path: "src/pages/DashboardPage.tsx",
        action: "modify",
        content: 'import { NewBanner } from "../components/NewBanner";\nexport function DashboardPage() { return <div><NewBanner />Dashboard Content</div>; }',
        description: "Integrate NewBanner into DashboardPage",
      },
    ];

    const result = await ValidationDetector.runFeatureValidation(
      changes,
      snapshot,
      "Improve the dashboard UI with an announcement banner",
      defaultContract
    );

    const intentCheck = result.checks.find((c) => c.id === "intent_satisfaction");
    expect(intentCheck?.status).toBe("PASS");
    expect(result.overallPassed).toBe(true);
  });

  // 5. Next App Router: app/page.tsx -> components/Hero.tsx, modify Hero.tsx -> PASS
  test("5. Next App Router: app/page.tsx -> components/Hero.tsx, modify Hero.tsx succeeds", async () => {
    const snapshot = {
      keyFiles: [
        {
          path: "app/layout.tsx",
          content: "export default function RootLayout({ children }: any) { return <html><body>{children}</body></html>; }",
        },
        {
          path: "app/page.tsx",
          content: 'import { Hero } from "../components/Hero";\nexport default function HomePage() { return <Hero />; }',
        },
        {
          path: "components/Hero.tsx",
          content: "export function Hero() { return <section>Welcome Hero</section>; }",
        },
      ],
    };

    const changes: AgentFileChange[] = [
      {
        path: "components/Hero.tsx",
        action: "modify",
        content: "export function Hero() { return <section>ANKA Next Hero</section>; }",
        description: "Update Hero component",
      },
    ];

    const result = await ValidationDetector.runFeatureValidation(
      changes,
      snapshot,
      "Update the homepage layout and modernize hero",
      defaultContract
    );

    const intentCheck = result.checks.find((c) => c.id === "intent_satisfaction");
    expect(intentCheck?.status).toBe("PASS");
    expect(result.overallPassed).toBe(true);
  });

  // 6. Next nested route: app/dashboard/page.tsx -> DashboardHeader.tsx, modify DashboardHeader.tsx -> PASS
  test("6. Next nested route: app/dashboard/page.tsx -> DashboardHeader.tsx, modify DashboardHeader.tsx succeeds", async () => {
    const snapshot = {
      keyFiles: [
        {
          path: "app/layout.tsx",
          content: "export default function RootLayout({ children }: any) { return <html><body>{children}</body></html>; }",
        },
        {
          path: "app/page.tsx",
          content: "export default function HomePage() { return <div>Home</div>; }",
        },
        {
          path: "app/dashboard/page.tsx",
          content: 'import { DashboardHeader } from "./DashboardHeader";\nexport default function DashboardRoute() { return <DashboardHeader />; }',
        },
        {
          path: "app/dashboard/DashboardHeader.tsx",
          content: "export function DashboardHeader() { return <h2>Dashboard</h2>; }",
        },
      ],
    };

    const changes: AgentFileChange[] = [
      {
        path: "app/dashboard/DashboardHeader.tsx",
        action: "modify",
        content: "export function DashboardHeader() { return <h2>Verified Dashboard Header</h2>; }",
        description: "Update dashboard header",
      },
    ];

    const result = await ValidationDetector.runFeatureValidation(
      changes,
      snapshot,
      "Improve the dashboard UI and refine dashboard header",
      defaultContract
    );

    const intentCheck = result.checks.find((c) => c.id === "intent_satisfaction");
    expect(intentCheck?.status).toBe("PASS");
    expect(result.overallPassed).toBe(true);
  });

  // 7. Unreachable Next component -> FAIL
  test("7. Unreachable Next component not connected to any route fails intent satisfaction", async () => {
    const snapshot = {
      keyFiles: [
        {
          path: "app/layout.tsx",
          content: "export default function RootLayout({ children }: any) { return <html><body>{children}</body></html>; }",
        },
        {
          path: "app/page.tsx",
          content: "export default function HomePage() { return <div>Home</div>; }",
        },
      ],
    };

    const changes: AgentFileChange[] = [
      {
        path: "components/DeadWidget.tsx",
        action: "create",
        content: "export function DeadWidget() { return <div>Dead</div>; }",
        description: "Dead widget",
      },
    ];

    const result = await ValidationDetector.runFeatureValidation(
      changes,
      snapshot,
      "Improve the dashboard UI",
      defaultContract
    );

    const intentCheck = result.checks.find((c) => c.id === "intent_satisfaction");
    expect(intentCheck?.status).toBe("FAIL");
    expect(intentCheck?.details).toBe("Modified UI target is not reachable from any active frontend entry point.");
    expect(result.overallPassed).toBe(false);
  });

  // 8. Cycle in import graph does not infinite-loop
  test("8. Cycle in import graph (A -> B -> A) terminates safely and resolves reachability", () => {
    const graph = new Map<string, string[]>([
      ["src/App.tsx", ["src/ComponentA.tsx"]],
      ["src/ComponentA.tsx", ["src/ComponentB.tsx"]],
      ["src/ComponentB.tsx", ["src/ComponentA.tsx", "src/Target.tsx"]],
    ]);

    const reachable = StaticValidationEngine.computeReachableFiles(["src/App.tsx"], graph);
    expect(reachable.has("src/target.tsx")).toBe(true);
    expect(reachable.has("src/componenta.tsx")).toBe(true);
    expect(reachable.has("src/componentb.tsx")).toBe(true);
  });

  // 9. Backend/API task behavior unchanged
  test("9. Backend/API task behavior unchanged (activeTargetSatisfied is true)", async () => {
    const snapshot = {
      keyFiles: [
        {
          path: "package.json",
          content: JSON.stringify({ dependencies: { express: "^4.18.2" } }),
        },
        {
          path: "src/server.ts",
          content: 'import express from "express";\nconst app = express();\nexport default app;',
        },
        {
          path: "src/routes/users.ts",
          content: 'import { Router } from "express";\nexport const router = Router();',
        },
      ],
    };

    const changes: AgentFileChange[] = [
      {
        path: "src/routes/users.ts",
        action: "modify",
        content: 'import { Router } from "express";\nexport const router = Router();\nrouter.get("/status", (req, res) => res.json({ ok: true }));',
        description: "Add user status endpoint",
      },
    ];

    const result = await ValidationDetector.runFeatureValidation(
      changes,
      snapshot,
      "Add user status support to the backend API and dashboard statistics",
      { ...defaultContract, environment: "NODE_JS" }
    );

    const intentCheck = result.checks.find((c) => c.id === "intent_satisfaction");
    expect(intentCheck?.status).toBe("PASS");
    expect(result.overallPassed).toBe(true);
  });
});
