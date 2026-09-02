import {
  detectRepositoryArchitecture,
  detectExistingUIComponents,
  detectExistingStyleFiles,
  detectInstalledUILibraries,
  isUITask,
  isFullPageDashboardRequest,
  buildRepositoryUISystemPromptSection,
} from "../planning/RepositoryArchitectureDetector";

describe("Repository Design-System Grounding & Reusable UI Component Inventory", () => {
  const sampleRepoFiles = [
    "package.json",
    "tsconfig.json",
    "app/layout.tsx",
    "app/page.tsx",
    "app/globals.css",
    "app/styles/components.css",
    "app/components/Button.tsx",
    "app/components/Card.tsx",
    "app/components/Header.tsx",
    "app/components/Sidebar.tsx",
    "app/components/Footer.tsx",
    "app/components/Badge.tsx",
    "app/components/Modal.tsx",
    "src/utils/math.ts",
    "src/services/api.ts",
    "app/components/Button.test.tsx",
  ];

  const samplePkgJson = JSON.stringify({
    name: "anka-test-app",
    dependencies: {
      next: "14.2.0",
      react: "18.2.0",
      "react-dom": "18.2.0",
      "lucide-react": "^0.300.0",
      "framer-motion": "^11.0.0",
    },
    devDependencies: {
      tailwindcss: "^3.4.0",
    },
  });

  // ── TEST 1: COMPONENT INVENTORY DETECTION ──────────────────────────────────
  test("1. detectExistingUIComponents extracts valid UI components and categories", () => {
    const components = detectExistingUIComponents(sampleRepoFiles);
    const names = components.map((c) => c.name);

    expect(names).toContain("Button");
    expect(names).toContain("Card");
    expect(names).toContain("Header");
    expect(names).toContain("Sidebar");
    expect(names).toContain("Footer");
    expect(names).toContain("Badge");
    expect(names).toContain("Modal");

    // Non-UI files and test files should be excluded
    expect(names).not.toContain("math");
    expect(names).not.toContain("api");
    expect(names).not.toContain("Button.test");
    expect(names).not.toContain("page");
    expect(names).not.toContain("layout");

    const buttonComp = components.find((c) => c.name === "Button");
    expect(buttonComp?.category).toBe("primitive");

    const sidebarComp = components.find((c) => c.name === "Sidebar");
    expect(sidebarComp?.category).toBe("navigation");

    const modalComp = components.find((c) => c.name === "Modal");
    expect(modalComp?.category).toBe("feedback");
  });

  // ── TEST 2: STYLE / THEME INVENTORY DETECTION ──────────────────────────────
  test("2. detectExistingStyleFiles extracts CSS and style configuration files", () => {
    const styles = detectExistingStyleFiles(sampleRepoFiles);
    expect(styles).toContain("app/globals.css");
    expect(styles).toContain("app/styles/components.css");
    expect(styles).not.toContain("package.json");
    expect(styles).not.toContain("app/components/Button.tsx");
  });

  // ── TEST 3: INSTALLED VISUAL LIBRARY DETECTION ─────────────────────────────
  test("3. detectInstalledUILibraries detects icon and UI packages from package.json", () => {
    const arch = detectRepositoryArchitecture(sampleRepoFiles, samplePkgJson);
    expect(arch.installedUILibraries).toContain("lucide-react");
    expect(arch.installedUILibraries).toContain("framer-motion");
  });

  // ── TEST 4: UI TASK DETECTION VS BACKEND/BUILD TASKS ───────────────────────
  test("4. isUITask returns true for UI features and false for pure build/backend tasks", () => {
    // UI Tasks
    expect(isUITask("Improve the dashboard UI and make it a professional customer support dashboard.")).toBe(true);
    expect(isUITask("Build a user profile card and settings form.")).toBe(true);
    expect(isUITask("Add a small status badge to the existing card.")).toBe(true);
    expect(isUITask("Center the calculator on screen and update styles.")).toBe(true);

    // Non-UI / Backend / Build tasks
    expect(isUITask("Fix all TypeScript build errors.")).toBe(false);
    expect(isUITask("Repair broken dependencies in package.json (ETARGET).")).toBe(false);
    expect(isUITask("Fix prisma schema migration and database queries.")).toBe(false);
    expect(isUITask("Resolve TS2614 diagnostic in backend controller.")).toBe(false);
  });

  // ── TEST 5: REPOSITORY UI SYSTEM PROMPT SECTION GENERATION ─────────────────
  test("5. buildRepositoryUISystemPromptSection generates structured bounded context", () => {
    const arch = detectRepositoryArchitecture(sampleRepoFiles, samplePkgJson);
    const section = buildRepositoryUISystemPromptSection(arch, {
      isDashboard: true,
      isSmallComponent: false,
    });

    expect(section).toContain("REPOSITORY DESIGN SYSTEM & REUSABLE UI ASSETS");
    expect(section).toContain("Button — app/components/Button.tsx");
    expect(section).toContain("Card — app/components/Card.tsx");
    expect(section).toContain("app/globals.css");
    expect(section).toContain("app/styles/components.css");
    expect(section).toContain("lucide-react");
    expect(section).toContain("PREFER REUSE");
    expect(section).toContain("ADAPTIVE COMPOSITION");
    expect(section).toContain("FULL-PAGE DASHBOARD LAYOUT & STYLESHEET WIRING GUIDELINES");
    expect(section).toContain("Realistic Mock Data");
  });

  // ── TEST 6: SMALL COMPONENT CASE OMITS DASHBOARD RULES ─────────────────────
  test("6. Small component task includes component inventory but omits full-page dashboard rules", () => {
    const arch = detectRepositoryArchitecture(sampleRepoFiles, samplePkgJson);
    const section = buildRepositoryUISystemPromptSection(arch, {
      isDashboard: false,
      isSmallComponent: true,
    });

    expect(section).toContain("REPOSITORY DESIGN SYSTEM & REUSABLE UI ASSETS");
    expect(section).toContain("Badge — app/components/Badge.tsx");
    expect(section).not.toContain("FULL-PAGE DASHBOARD LAYOUT & STYLESHEET WIRING GUIDELINES");
    expect(section).not.toContain("Realistic Mock Data");
  });

  // ── TEST 7: EMPTY DESIGN SYSTEM REPOSITORY ─────────────────────────────────
  test("7. Empty repository with no UI components generates gracefully without errors", () => {
    const emptyRepoFiles = ["package.json", "tsconfig.json", "src/index.ts"];
    const arch = detectRepositoryArchitecture(emptyRepoFiles, JSON.stringify({ name: "cli-tool" }));

    expect(arch.existingUIComponents).toEqual([]);
    expect(arch.existingStyleFiles).toEqual([]);
    expect(arch.installedUILibraries).toEqual([]);

    const nonDashboardSection = buildRepositoryUISystemPromptSection(arch, {
      isDashboard: false,
    });
    expect(nonDashboardSection).toBe("");
  });

  // ── TEST 8: BOUNDED CONTEXT LIMITS ─────────────────────────────────────────
  test("8. buildRepositoryUISystemPromptSection enforces upper bounds on components and styles", () => {
    const massiveFiles: string[] = [];
    for (let i = 0; i < 50; i++) {
      massiveFiles.push(`app/components/Widget${i}.tsx`);
      massiveFiles.push(`app/styles/style${i}.css`);
    }
    const arch = detectRepositoryArchitecture(massiveFiles, samplePkgJson);
    const section = buildRepositoryUISystemPromptSection(arch);

    // Max 12 components in prompt section
    const componentMatches = section.match(/- Widget\d+ —/g);
    expect(componentMatches?.length).toBeLessThanOrEqual(12);

    // Max 6 styles in prompt section
    const styleMatches = section.match(/- app\/styles\/style\d+\.css/g);
    expect(styleMatches?.length).toBeLessThanOrEqual(6);
  });
});
