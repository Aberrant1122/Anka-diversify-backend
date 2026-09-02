import { ValidationDetector } from "../validation/ValidationDetector";
import { AgentFileChange, ExecutionContract } from "../shared/types";

describe("ValidationDetector — Operation-Aware & Delete Semantics", () => {
  const sampleSnapshot = {
    keyFiles: [
      {
        path: "app/components/Calculator.tsx",
        content: `import React from 'react';\nexport const Calculator = () => <div>Calculator</div>;`,
      },
      {
        path: "app/page.tsx",
        content: `import React from 'react';\nimport { Calculator } from './components/Calculator';\nexport default function Page() {\n  return <Calculator />;\n}`,
      },
    ],
  };

  const sampleContract: ExecutionContract = {
    goal: "Delete directory and update dashboard UI",
    taskType: "DELETE_FOLDER",
    risk: "MEDIUM",
    estimatedComplexity: "MEDIUM",
    pipeline: "REPOSITORY",
    environment: "REACT_TS",
    repositoryRequired: true,
    expectedFiles: ["app/components/Calculator.tsx"],
    validationType: "TYPESCRIPT_BUILD",
    targetPaths: ["app/components/Calculator.tsx"],
    allowedActions: ["delete_folder", "remove_imports", "update_references"],
    forbiddenActions: ["refactor", "rename"],
    maxFiles: 12,
    searchScope: ["app/components/Calculator.tsx"],
    contextScope: ["app/components/Calculator.tsx"],
    diffCriticEnabled: true,
  };

  test("5. DELETE change with undefined content completes without TypeError or .slice crash", async () => {
    const deleteChanges: AgentFileChange[] = [
      {
        path: "app/components/Calculator.tsx",
        action: "delete",
        isDeleted: true,
        description: "Delete Calculator component",
        content: undefined as any,
      },
      {
        path: "app/page.tsx",
        action: "modify",
        content: `import React from 'react';\nexport default function Page() {\n  return <div>Dashboard</div>;\n}`,
        description: "Update page to remove calculator",
      },
    ];

    const result = await ValidationDetector.runFeatureValidation(
      deleteChanges,
      sampleSnapshot,
      "Remove the calculator from the repository and enhance the dashboard UI.",
      sampleContract
    );

    expect(result).toBeDefined();
    expect(typeof result.overallPassed).toBe("boolean");
    expect(result.overallPassed).toBe(true);
    expect(Array.isArray(result.checks)).toBe(true);
    expect(result.checks.some((c) => c.id === "import_export")).toBe(true);
  });

  test("6. Mixed DELETE + MODIFY changes do not crash and handle descriptors properly", async () => {
    const mixedChanges: AgentFileChange[] = [
      {
        path: "app/components/Calculator.tsx",
        action: "delete",
        isDeleted: true,
        description: "Delete calculator",
        content: undefined as any,
      },
      {
        path: "app/styles/calculator.css",
        action: "delete",
        isDeleted: true,
        description: "Delete calculator styles",
        content: undefined as any,
      },
      {
        path: "app/page.tsx",
        action: "modify",
        content: `import React from 'react';\nexport default function Page() {\n  return <div>Enhanced Dashboard UI</div>;\n}`,
        description: "Enhance dashboard UI",
      },
    ];

    const result = await ValidationDetector.runFeatureValidation(
      mixedChanges,
      sampleSnapshot,
      "Remove the calculator from the repository and enhance the dashboard UI.",
      sampleContract
    );

    expect(result).toBeDefined();
    expect(typeof result.overallPassed).toBe("boolean");
  });

  test("Standalone pipeline with DELETE changes ignores deleted file for content-based checks", async () => {
    const standaloneContract: ExecutionContract = {
      ...sampleContract,
      pipeline: "STANDALONE",
      environment: "HTML_CSS_JS",
    };

    const standaloneChanges: AgentFileChange[] = [
      {
        path: "old_script.js",
        action: "delete",
        isDeleted: true,
        description: "Remove old script",
        content: undefined as any,
      },
      {
        path: "index.html",
        action: "create",
        content: `<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><script src="script.js"></script></body></html>`,
        description: "Main HTML",
      },
      {
        path: "style.css",
        action: "create",
        content: `body { margin: 0; }`,
        description: "Styles",
      },
      {
        path: "script.js",
        action: "create",
        content: `console.log('init'); document.addEventListener('DOMContentLoaded', () => {});`,
        description: "Script",
      },
    ];

    const result = await ValidationDetector.runFeatureValidation(
      standaloneChanges,
      null,
      "Create standalone app and remove old script",
      standaloneContract
    );

    expect(result.overallPassed).toBe(true);
    expect(result.checks.find((c) => c.id === "html_structure")?.status).toBe("PASS");
  });
});
