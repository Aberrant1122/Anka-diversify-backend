import { TargetScopeExpander } from "../contracts/TargetScopeExpander";
import { ManifestValidator } from "../../services/manifest-validator";
import { ExecutionContract, FileManifest, BaselineDiagnostic } from "../../types";
import { ExtendedKnowledgeGraph } from "../shared/types";

describe("TargetScopeExpander — Evidence-Backed Target Path Expansion for Broad Build Repair", () => {
  const baseContract: ExecutionContract = {
    goal: "Repair all build errors",
    taskType: "BUG_FIX",
    risk: "LOW",
    estimatedComplexity: "SMALL",
    pipeline: "REPOSITORY",
    environment: "REACT_TS",
    repositoryRequired: true,
    expectedFiles: ["components/Calculator.tsx"],
    validationType: "TYPESCRIPT_BUILD",
    targetPaths: ["components/Calculator.tsx"],
    allowedActions: ["modify", "create"],
    forbiddenActions: [],
    maxFiles: 5,
    searchScope: ["components/Calculator.tsx"],
    contextScope: ["components/Calculator.tsx"],
    diffCriticEnabled: true,
  };

  test("Regression Test 1: Broad build repair with verified import relation expands targetPaths and passes ManifestValidator", () => {
    const contract: ExecutionContract = { ...baseContract };

    const snapshotFiles = [
      {
        path: "components/Calculator.tsx",
        content: `
"use client";
import React from 'react';
import { CalculatorButton } from './CalculatorButton';
export function Calculator() { return <CalculatorButton />; }
`,
      },
      {
        path: "components/CalculatorButton.tsx",
        content: `
import React from 'react';
export function CalculatorButton() { return <button>Click</button>; }
`,
      },
    ];

    const plannerProposedFiles = [
      "components/Calculator.tsx",
      "components/CalculatorButton.tsx",
    ];

    const result = TargetScopeExpander.expandBroadRepairTargetPaths({
      contract,
      candidatePaths: plannerProposedFiles,
      snapshotFiles,
    });

    expect(result.approvedExpansions.length).toBe(1);
    expect(result.approvedExpansions[0].path).toBe("components/CalculatorButton.tsx");
    expect(result.approvedExpansions[0].evidence).toBe("IMPORT_RELATION");
    expect(result.expandedTargetPaths).toContain("components/Calculator.tsx");
    expect(result.expandedTargetPaths).toContain("components/CalculatorButton.tsx");

    // Verify ManifestValidator passes with expanded contract
    contract.targetPaths = result.expandedTargetPaths;
    const validator = new ManifestValidator(contract, {
      existingFiles: ["components/Calculator.tsx", "components/CalculatorButton.tsx"],
    });

    const manifest: FileManifest = {
      files: [
        {
          path: "components/Calculator.tsx",
          action: "modify",
          dependencies: ["./CalculatorButton"],
          description: "Update calculator",
        },
        {
          path: "components/CalculatorButton.tsx",
          action: "modify",
          dependencies: [],
          description: "Update button",
        },
      ],
      totalFiles: 2,
      manifestVersion: "1.0.0",
    };

    const valRes = validator.validate(manifest);
    expect(valRes.valid).toBe(true);
    expect(valRes.errors).toHaveLength(0);
  });

  test("Regression Test 2: Broad build repair with unrelated proposal rejects expansion and ManifestValidator blocks it", () => {
    const contract: ExecutionContract = { ...baseContract };

    const snapshotFiles = [
      {
        path: "components/Calculator.tsx",
        content: `
"use client";
export function Calculator() { return <div>Calc</div>; }
`,
      },
      {
        path: "src/unrelated/Dashboard.tsx",
        content: `
export function Dashboard() { return <div>Dashboard</div>; }
`,
      },
    ];

    const plannerProposedFiles = [
      "components/Calculator.tsx",
      "src/unrelated/Dashboard.tsx",
    ];

    const result = TargetScopeExpander.expandBroadRepairTargetPaths({
      contract,
      candidatePaths: plannerProposedFiles,
      snapshotFiles,
    });

    expect(result.approvedExpansions).toHaveLength(0);
    expect(result.rejectedCandidates).toHaveLength(1);
    expect(result.rejectedCandidates[0].path).toBe("src/unrelated/Dashboard.tsx");
    expect(result.expandedTargetPaths).toEqual(["components/Calculator.tsx"]);

    // Verify ManifestValidator blocks the unapproved file
    contract.targetPaths = result.expandedTargetPaths;
    const validator = new ManifestValidator(contract, {
      existingFiles: ["components/Calculator.tsx", "src/unrelated/Dashboard.tsx"],
    });

    const manifest: FileManifest = {
      files: [
        {
          path: "components/Calculator.tsx",
          action: "modify",
          dependencies: [],
          description: "Update calculator",
        },
        {
          path: "src/unrelated/Dashboard.tsx",
          action: "modify",
          dependencies: [],
          description: "Speculative dashboard change",
        },
      ],
      totalFiles: 2,
      manifestVersion: "1.0.0",
    };

    const valRes = validator.validate(manifest);
    expect(valRes.valid).toBe(false);
    expect(valRes.errors.some((e) => e.type === "path_constraint" && e.affectedFiles.includes("src/unrelated/Dashboard.tsx"))).toBe(true);
  });

  test("Regression Test 3: Narrow repair request remains protected and does not expand scope", () => {
    const narrowContract: ExecutionContract = {
      ...baseContract,
      goal: 'Repair bug in "components/Calculator.tsx" — fix useState error in components/Calculator.tsx',
      targetPaths: ["components/Calculator.tsx"],
    };

    // Narrow tasks should not trigger broad repair expansion
    const { BaselineDeltaVerifier } = require("../../services/baseline-delta.verifier");
    const isBroad = BaselineDeltaVerifier.isBroadBuildRepairTask(
      "fix the useState error in components/Calculator.tsx",
      narrowContract
    );

    expect(isBroad).toBe(false);

    // ManifestValidator blocks any extra file
    const validator = new ManifestValidator(narrowContract, {
      existingFiles: ["components/Calculator.tsx", "src/unrelated/Dashboard.tsx"],
    });

    const manifest: FileManifest = {
      files: [
        {
          path: "components/Calculator.tsx",
          action: "modify",
          dependencies: [],
          description: "Fix useState",
        },
        {
          path: "src/unrelated/Dashboard.tsx",
          action: "modify",
          dependencies: [],
          description: "Extra file",
        },
      ],
      totalFiles: 2,
      manifestVersion: "1.0.0",
    };

    const valRes = validator.validate(manifest);
    expect(valRes.valid).toBe(false);
    expect(valRes.errors.some((e) => e.type === "path_constraint")).toBe(true);
  });

  test("Regression Test 4: Multi-file transitive dependency chain A -> B -> C expands controlled chain while rejecting unrelated D", () => {
    const contract: ExecutionContract = {
      ...baseContract,
      targetPaths: ["components/Calculator.tsx"],
    };

    const snapshotFiles = [
      {
        path: "components/Calculator.tsx",
        content: `
import { CalculatorButton } from './CalculatorButton';
export function Calculator() { return <CalculatorButton />; }
`,
      },
      {
        path: "components/CalculatorButton.tsx",
        content: `
import { THEME_COLOR } from './CalculatorTheme';
export function CalculatorButton() { return <button style={{ color: THEME_COLOR }}>Btn</button>; }
`,
      },
      {
        path: "components/CalculatorTheme.ts",
        content: `
export const THEME_COLOR = "#ff0000";
`,
      },
      {
        path: "src/utils/unrelatedHelper.ts",
        content: `
export function unrelated() { return 42; }
`,
      },
    ];

    const plannerProposedFiles = [
      "components/Calculator.tsx",
      "components/CalculatorButton.tsx",
      "components/CalculatorTheme.ts",
      "src/utils/unrelatedHelper.ts",
    ];

    const result = TargetScopeExpander.expandBroadRepairTargetPaths({
      contract,
      candidatePaths: plannerProposedFiles,
      snapshotFiles,
    });

    expect(result.expandedTargetPaths).toContain("components/Calculator.tsx");
    expect(result.expandedTargetPaths).toContain("components/CalculatorButton.tsx");
    expect(result.expandedTargetPaths).toContain("components/CalculatorTheme.ts");
    expect(result.expandedTargetPaths).not.toContain("src/utils/unrelatedHelper.ts");

    expect(result.approvedExpansions).toHaveLength(2);
    expect(result.rejectedCandidates).toHaveLength(1);
    expect(result.rejectedCandidates[0].path).toBe("src/utils/unrelatedHelper.ts");
  });

  test("Regression Test 5: Healthy normal feature request with broad target paths is completely unaffected", () => {
    const featureContract: ExecutionContract = {
      goal: 'Implement feature "src/components" — create user profile',
      taskType: "NEW_FEATURE",
      risk: "LOW",
      estimatedComplexity: "MEDIUM",
      pipeline: "REPOSITORY",
      environment: "REACT_TS",
      repositoryRequired: true,
      expectedFiles: [],
      validationType: "TYPESCRIPT_BUILD",
      targetPaths: ["src/components", "src/App.tsx"],
      allowedActions: ["create", "modify"],
      forbiddenActions: ["delete"],
      maxFiles: 5,
      searchScope: ["src"],
      contextScope: ["src"],
      diffCriticEnabled: true,
    };

    const validator = new ManifestValidator(featureContract, {
      existingFiles: ["src/components/Avatar.tsx", "src/App.tsx"],
    });

    const manifest: FileManifest = {
      files: [
        {
          path: "src/App.tsx",
          action: "modify",
          dependencies: ["./components/UserProfile"],
          description: "Mount UserProfile in App",
        },
        {
          path: "src/components/UserProfile.tsx",
          action: "create",
          dependencies: ["./Avatar"],
          description: "New user profile component",
        },
      ],
      totalFiles: 2,
      manifestVersion: "1.0.0",
    };

    const valRes = validator.validate(manifest);
    expect(valRes.valid).toBe(true);
    expect(valRes.errors).toHaveLength(0);
  });
});
