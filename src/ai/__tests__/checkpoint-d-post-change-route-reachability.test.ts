import {
  detectAllActiveEntryRoots,
  detectRepositoryArchitecture,
  RepositoryArchitectureSummary,
} from "../planning/RepositoryArchitectureDetector";
import { ValidationDetector } from "../validation/ValidationDetector";
import type { ExecutionContract } from "../shared/types";

const contract: ExecutionContract = {
  goal: "Add a new report view",
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
  maxFiles: 5,
  targetPaths: ["app/", "pages/", "src/"],
  searchScope: ["app/", "pages/", "src/"],
  contextScope: ["app/", "pages/", "src/"],
  diffCriticEnabled: true,
};

describe("Checkpoint D post-change framework route reachability", () => {
  test("existing Next App routes remain roots", () => {
    const files = ["app/layout.tsx", "app/page.tsx", "app/archive/page.tsx"];
    const architecture = detectRepositoryArchitecture(files, { dependencies: { next: "15.0.0" } });
    expect(detectAllActiveEntryRoots(files, architecture)).toEqual(expect.arrayContaining(["app/page.tsx", "app/archive/page.tsx"]));
  });

  test("a newly created App Router page participates in post-change reachability", async () => {
    const result = await ValidationDetector.runFeatureValidation([
      {
        path: "app/reports/page.tsx",
        action: "create",
        content: "export default function ReportsPage() { return <main>Reports</main>; }",
        description: "Create the reports route",
      },
    ], {
      keyFiles: [
        { path: "package.json", content: JSON.stringify({ dependencies: { next: "15.0.0", react: "19.0.0" } }) },
        { path: "app/layout.tsx", content: "export default function Layout({children}: {children: unknown}) { return <>{children}</>; }" },
        { path: "app/page.tsx", content: "export default function Home() { return <main>Home</main>; }" },
      ],
    }, "Add a new report view", contract);
    expect(result.checks.find((check) => check.id === "intent_satisfaction")?.status).toBe("PASS");
  });

  test("a newly created Pages Router page is a root", () => {
    const existing = ["pages/_app.tsx", "pages/index.tsx"];
    const architecture = detectRepositoryArchitecture(existing, { dependencies: { next: "15.0.0" } });
    expect(detectAllActiveEntryRoots([...existing, "pages/reports.tsx"], architecture)).toContain("pages/reports.tsx");
  });

  test("an arbitrary file below app is not a route root", () => {
    const existing = ["app/layout.tsx", "app/page.tsx"];
    const architecture = detectRepositoryArchitecture(existing, { dependencies: { next: "15.0.0" } });
    expect(detectAllActiveEntryRoots([...existing, "app/reports/helpers.ts"], architecture)).not.toContain("app/reports/helpers.ts");
  });

  test("a Vite component still requires composition reachability", () => {
    const existing = ["src/main.tsx", "src/App.tsx"];
    const architecture = detectRepositoryArchitecture(existing, { dependencies: { vite: "7.0.0", react: "19.0.0" } });
    expect(detectAllActiveEntryRoots([...existing, "src/components/Reports.tsx"], architecture)).not.toContain("src/components/Reports.tsx");
  });

  test("ambiguous Next router detection does not elevate new filesystem candidates", () => {
    const architecture: RepositoryArchitectureSummary = {
      ...detectRepositoryArchitecture(["app/page.tsx", "pages/index.tsx"], { dependencies: { next: "15.0.0" } }),
      framework: "NEXT_JS",
      router: "HYBRID",
      existingEntryPoints: [],
      primaryActiveEntryPoint: null,
    };
    expect(detectAllActiveEntryRoots(["app/reports/page.tsx", "pages/reports.tsx"], architecture)).toEqual([]);
  });
});
