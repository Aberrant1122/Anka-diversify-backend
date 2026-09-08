import { detectReferenceCleanupIntent, buildExecutionContract } from "../contracts/ExecutionContractBuilder";
import { TargetPathExtractor } from "../contracts/TargetPathExtractor";
import { TargetScopeExpander } from "../contracts/TargetScopeExpander";
import { ManifestValidator } from "../../services/manifest-validator";
import { ExecutionContract, FileManifest } from "../../types";
import { TaskClassificationResult } from "../shared/types";

describe("Constructive UI Execution Contract Targeting Regression Suite", () => {
  const repoFiles = [
    "src/App.css",
    "src/App.tsx",
    "src/components/layout/AppLayout/AppLayout.css",
    "src/components/layout/AppLayout/AppLayout.tsx",
    "src/components/layout/Header/Header.css",
    "src/components/layout/Header/Header.tsx",
    "src/components/layout/Sidebar/Sidebar.css",
    "src/components/layout/Sidebar/Sidebar.tsx",
    "src/components/ui/Button/Button.tsx",
    "src/components/ui/Button/Button.css",
    "src/pages/DashboardPage/DashboardPage.css",
    "src/pages/DashboardPage/DashboardPage.tsx",
    "src/types/common.ts",
    "src/types/dashboard.ts",
    "package.json",
    "tsconfig.json",
    "vite.config.ts",
  ];

  const dashboardPrompt =
    'Update the dashboard header title to "ANKA Verified Dashboard" and add a subtitle directly below it.';

  // 1. "Update the dashboard header title..." -> detectReferenceCleanupIntent = false
  test("Requirement 1: Constructive prompt does not trigger reference cleanup detection", () => {
    expect(detectReferenceCleanupIntent(dashboardPrompt)).toBe(false);
    expect(detectReferenceCleanupIntent("update the dashboard")).toBe(false);
    expect(detectReferenceCleanupIntent("update dashboard title")).toBe(false);
    expect(detectReferenceCleanupIntent("improve dashboard UI")).toBe(false);
    expect(detectReferenceCleanupIntent("change dashboard layout")).toBe(false);
    expect(detectReferenceCleanupIntent("add subtitle directly below it")).toBe(false);
  });

  // 2. Constructive dashboard task must NOT expand reverse reference cleanup
  test("Requirement 2: Constructive dashboard task refuses reverse reference cleanup", () => {
    const classification: TaskClassificationResult = {
      taskType: "NEW_FEATURE",
      risk: "LOW",
      estimatedComplexity: "SMALL",
      intent: "NEW_FEATURE",
      confidence: 0.95,
      requiresClarification: false,
      reasoning: "Update dashboard header",
    };
    const contract = buildExecutionContract(classification, dashboardPrompt, repoFiles);

    const cleanupResult = TargetScopeExpander.expandReverseReferenceCleanupTargets({
      contract,
      manifestFiles: [
        { path: "src/App.tsx", action: "modify" },
        { path: "src/pages/DashboardPage/DashboardPage.tsx", action: "modify" },
      ],
    });

    expect(cleanupResult.approvedExpansions).toHaveLength(0);
    expect(cleanupResult.expandedTargetPaths).not.toContain("src/App.tsx");
  });

  // 3. Genuine destructive tasks still trigger cleanup detection
  test("Requirement 3: Genuine destructive/cleanup language still triggers cleanup detection", () => {
    expect(
      detectReferenceCleanupIntent("Remove the deprecated dashboard widget and clean every reference")
    ).toBe(true);
    expect(detectReferenceCleanupIntent("delete Calculator and update importers")).toBe(true);
    expect(detectReferenceCleanupIntent("remove unused imports")).toBe(true);
    expect(detectReferenceCleanupIntent("clean up references to LegacyWidget")).toBe(true);
  });

  // 4. UI entity: dashboard with src/types/dashboard.ts and src/pages/DashboardPage/DashboardPage.tsx -> DashboardPage selected for UI task
  test("Requirement 4: UI task prefers UI page/component over type file for entity token", () => {
    const grounded = TargetPathExtractor.extractGroundedEntitiesWithProvenance(
      dashboardPrompt,
      repoFiles
    );
    const paths = grounded.map((g) => g.path);

    expect(paths).toContain("src/pages/DashboardPage/DashboardPage.tsx");
    expect(paths).not.toContain("src/types/dashboard.ts");
  });

  // 5. Same repository candidates for a type/data intent: type-file behavior remains valid
  test("Requirement 5: Explicit type/data intent retains type-file matching", () => {
    const typePrompt = "Update the dashboard types to add lastLogin timestamp to dashboard schema";
    const grounded = TargetPathExtractor.extractGroundedEntitiesWithProvenance(
      typePrompt,
      repoFiles
    );
    const paths = grounded.map((g) => g.path);

    expect(paths).toContain("src/types/dashboard.ts");
  });

  // 6. DashboardPage suffix grounding: dashboard -> DashboardPage.tsx
  test("Requirement 6: DashboardPage suffix grounding", () => {
    const prompt = "Improve the dashboard UI styling";
    const grounded = TargetPathExtractor.extractGroundedEntitiesWithProvenance(prompt, [
      "src/pages/DashboardPage/DashboardPage.tsx",
      "src/pages/SettingsPage/SettingsPage.tsx",
    ]);

    expect(grounded.map((g) => g.path)).toContain("src/pages/DashboardPage/DashboardPage.tsx");
  });

  // 7. DashboardView suffix grounding: dashboard -> DashboardView.tsx
  test("Requirement 7: DashboardView suffix grounding", () => {
    const prompt = "Update the dashboard with new statistics";
    const grounded = TargetPathExtractor.extractGroundedEntitiesWithProvenance(prompt, [
      "src/views/DashboardView.tsx",
      "src/views/UserView.tsx",
    ]);

    expect(grounded.map((g) => g.path)).toContain("src/views/DashboardView.tsx");
  });

  // 8. Unrelated filename: dashboard must NOT match src/components/DashboardMetricsArchiveUtility.tsx
  test("Requirement 8: Unrelated utility filename does not match entity token", () => {
    const prompt = "Update the dashboard";
    const grounded = TargetPathExtractor.extractGroundedEntitiesWithProvenance(prompt, [
      "src/components/DashboardMetricsArchiveUtility.tsx",
    ]);

    expect(grounded.map((g) => g.path)).not.toContain("src/components/DashboardMetricsArchiveUtility.tsx");
  });

  // 9. Active entry: src/App.tsx must not become writable merely because it is active
  test("Requirement 9: Active entry App.tsx is not automatically added to targetPaths for UI refinement", () => {
    const classification: TaskClassificationResult = {
      taskType: "NEW_FEATURE",
      risk: "LOW",
      estimatedComplexity: "SMALL",
      intent: "NEW_FEATURE",
      confidence: 0.95,
      requiresClarification: false,
      reasoning: "Update dashboard",
    };
    const contract = buildExecutionContract(classification, dashboardPrompt, repoFiles);

    expect(contract.targetPaths).not.toContain("src/App.tsx");
  });

  // 10. Semantic result alone must NOT become write authority
  test("Requirement 10: Semantic result without entity or import relation does not gain write authority", () => {
    const contract: ExecutionContract = {
      goal: "Update dashboard",
      taskType: "NEW_FEATURE",
      risk: "LOW",
      estimatedComplexity: "SMALL",
      pipeline: "REPOSITORY",
      environment: "REACT_TS",
      repositoryRequired: true,
      expectedFiles: ["src/pages/DashboardPage/DashboardPage.tsx"],
      validationType: "TYPESCRIPT_BUILD",
      targetPaths: ["src/pages/DashboardPage/DashboardPage.tsx"],
      allowedActions: ["modify_file"],
      forbiddenActions: [],
      maxFiles: 5,
      searchScope: ["src/pages/DashboardPage/DashboardPage.tsx"],
      contextScope: ["src/pages/DashboardPage/DashboardPage.tsx"],
      diffCriticEnabled: true,
    };

    const result = TargetScopeExpander.expandDirectUIReferences({
      contract,
      manifestFiles: [{ path: "src/components/ui/Button/Button.tsx", action: "modify" }],
      snapshotFiles: [
        {
          path: "src/pages/DashboardPage/DashboardPage.tsx",
          content: 'import React from "react"; import "./DashboardPage.css"; export const DashboardPage = () => null;',
        },
        {
          path: "src/components/ui/Button/Button.tsx",
          content: 'export const Button = () => null;',
        },
      ],
    });

    expect(result.expandedTargetPaths).not.toContain("src/components/ui/Button/Button.tsx");
    expect(result.rejectedCandidates.some((r) => r.path === "src/components/ui/Button/Button.tsx")).toBe(true);
  });

  // 11. Directly related Header.tsx may be added only with deterministic component/import relationship
  test("Requirement 11: Directly imported child component is expandable", () => {
    const contract: ExecutionContract = {
      goal: "Update dashboard",
      taskType: "NEW_FEATURE",
      risk: "LOW",
      estimatedComplexity: "SMALL",
      pipeline: "REPOSITORY",
      environment: "REACT_TS",
      repositoryRequired: true,
      expectedFiles: ["src/pages/DashboardPage/DashboardPage.tsx"],
      validationType: "TYPESCRIPT_BUILD",
      targetPaths: ["src/pages/DashboardPage/DashboardPage.tsx"],
      allowedActions: ["modify_file"],
      forbiddenActions: [],
      maxFiles: 5,
      searchScope: ["src/pages/DashboardPage/DashboardPage.tsx"],
      contextScope: ["src/pages/DashboardPage/DashboardPage.tsx"],
      diffCriticEnabled: true,
    };

    const result = TargetScopeExpander.expandDirectUIReferences({
      contract,
      manifestFiles: [{ path: "src/components/layout/Header/Header.tsx", action: "modify" }],
      snapshotFiles: [
        {
          path: "src/pages/DashboardPage/DashboardPage.tsx",
          content: 'import { Header } from "../../components/layout/Header/Header"; export const DashboardPage = () => <Header />;',
        },
        {
          path: "src/components/layout/Header/Header.tsx",
          content: 'export const Header = () => null;',
        },
      ],
    });

    expect(result.expandedTargetPaths).toContain("src/components/layout/Header/Header.tsx");
    expect(result.approvedExpansions.some((e) => e.path === "src/components/layout/Header/Header.tsx")).toBe(true);
  });

  // 12. Sibling CSS may be added only when directly imported by an authorized UI file
  test("Requirement 12: Sibling CSS is authorized when directly imported by authorized UI component", () => {
    const contract: ExecutionContract = {
      goal: "Update header",
      taskType: "NEW_FEATURE",
      risk: "LOW",
      estimatedComplexity: "SMALL",
      pipeline: "REPOSITORY",
      environment: "REACT_TS",
      repositoryRequired: true,
      expectedFiles: ["src/components/layout/Header/Header.tsx"],
      validationType: "TYPESCRIPT_BUILD",
      targetPaths: ["src/components/layout/Header/Header.tsx"],
      allowedActions: ["modify_file"],
      forbiddenActions: [],
      maxFiles: 5,
      searchScope: ["src/components/layout/Header/Header.tsx"],
      contextScope: ["src/components/layout/Header/Header.tsx"],
      diffCriticEnabled: true,
    };

    const result = TargetScopeExpander.expandDirectUIReferences({
      contract,
      manifestFiles: [{ path: "src/components/layout/Header/Header.css", action: "modify" }],
      snapshotFiles: [
        {
          path: "src/components/layout/Header/Header.tsx",
          content: 'import React from "react"; import "./Header.css"; export const Header = () => null;',
        },
      ],
    });

    expect(result.expandedTargetPaths).toContain("src/components/layout/Header/Header.css");
  });

  // 13. ManifestValidator still rejects a truly unauthorized file
  test("Requirement 13: ManifestValidator rejects unauthorized files", () => {
    const contract: ExecutionContract = {
      goal: "Update dashboard",
      taskType: "NEW_FEATURE",
      risk: "LOW",
      estimatedComplexity: "SMALL",
      pipeline: "REPOSITORY",
      environment: "REACT_TS",
      repositoryRequired: true,
      expectedFiles: ["src/pages/DashboardPage/DashboardPage.tsx"],
      validationType: "TYPESCRIPT_BUILD",
      targetPaths: [
        "src/pages/DashboardPage/DashboardPage.tsx",
        "src/components/layout/Header/Header.tsx",
      ],
      allowedActions: ["modify_file"],
      forbiddenActions: [],
      maxFiles: 5,
      searchScope: ["src/pages/DashboardPage/DashboardPage.tsx"],
      contextScope: ["src/pages/DashboardPage/DashboardPage.tsx"],
      diffCriticEnabled: true,
    };

    const validator = new ManifestValidator(contract, { existingFiles: repoFiles });
    const invalidManifest: FileManifest = {
      files: [
        {
          path: "src/pages/DashboardPage/DashboardPage.tsx",
          action: "modify",
          description: "Update dashboard",
          dependencies: [],
        },
        {
          path: "src/components/layout/Sidebar/Sidebar.tsx",
          action: "modify",
          description: "Unauthorized sidebar change",
          dependencies: [],
        },
      ],
      totalFiles: 2,
      manifestVersion: "1.0.0",
    };

    const valRes = validator.validate(invalidManifest);
    expect(valRes.valid).toBe(false);
    expect(valRes.errors.some((e) => e.type === "path_constraint")).toBe(true);
    expect(valRes.errors.some((e) => e.affectedFiles?.includes("src/components/layout/Sidebar/Sidebar.tsx"))).toBe(true);
  });
});
