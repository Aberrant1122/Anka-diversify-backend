import { buildExecutionContract } from "../contracts/ExecutionContractBuilder";
import { ManifestValidator } from "../../services/manifest-validator";
import { FileManifest, ExecutionContract, TaskClassificationResult } from "../../types";

describe("AI Step 14 — Authoritative Manifest & Target Path Grounding", () => {
  const nextJsExistingFiles = [
    "package.json",
    "tsconfig.json",
    "app/layout.tsx",
    "app/page.tsx",
    "app/globals.css",
  ];

  test("A. Normal BUG_FIX with explicit target path sets hard targetPaths constraint", () => {
    const classification: TaskClassificationResult = {
      taskType: "BUG_FIX",
      risk: "LOW",
      estimatedComplexity: "SMALL",
      intent: "BUG_FIX",
      confidence: 0.95,
      requiresClarification: false,
      reasoning: "Fix bug in pagination",
      targetPath: "src/pagination.ts",
    };

    const contract = buildExecutionContract(
      classification,
      "Fix bug in src/pagination.ts",
      ["package.json", "src/pagination.ts"]
    );

    expect(contract.targetPaths).toContain("src/pagination.ts");
    expect(contract.maxFiles).toBe(10);
  });

  test("B. NEW_FEATURE MEDIUM receives appropriate maxFiles and empty targetPaths if not explicitly written", () => {
    const classification: TaskClassificationResult = {
      taskType: "NEW_FEATURE",
      risk: "MEDIUM",
      estimatedComplexity: "MEDIUM",
      intent: "NEW_FEATURE",
      confidence: 0.90,
      requiresClarification: false,
      reasoning: "Add dark mode toggle",
      targetPath: "components/theme/ThemeToggle.tsx", // Model suggested, not in message
    };

    const contract = buildExecutionContract(
      classification,
      "Add a dark mode toggle to the dashboard",
      nextJsExistingFiles
    );

    // Because user did not write the path and it doesn't exist yet, it must not restrict the contract targetPaths
    expect(contract.targetPaths).toEqual([]);
    expect(contract.maxFiles).toBe(7);
  });

  test("C & G & H. NEW_FEATURE LARGE/COMPLEX allows creating new component AND modifying existing page/layout", () => {
    const classification: TaskClassificationResult = {
      taskType: "NEW_FEATURE",
      risk: "HIGH",
      estimatedComplexity: "LARGE",
      intent: "NEW_FEATURE",
      confidence: 0.95,
      requiresClarification: false,
      reasoning: "Create scientific calculator",
      targetPath: "src/components/calculator", // Hallucinated/suggested future path
    };

    const contract = buildExecutionContract(
      classification,
      "i need you to create a calculator from my current repo it is basic next js but make a scientific calculator from it",
      nextJsExistingFiles
    );

    // TargetPaths must remain unrestricted (empty) for project-wide feature
    expect(contract.targetPaths).toEqual([]);
    expect(contract.maxFiles).toBe(15);

    // Validate a realistic manifest containing new component + modified app/page.tsx
    const manifest: FileManifest = {
      files: [
        {
          path: "components/Calculator.tsx",
          action: "create",
          description: "Scientific calculator component",
          dependencies: ["./CalculatorButton.tsx"],
        },
        {
          path: "components/CalculatorButton.tsx",
          action: "create",
          description: "Button subcomponent",
          dependencies: [],
        },
        {
          path: "app/page.tsx",
          action: "modify",
          description: "Embed calculator in main page",
          dependencies: ["../components/Calculator.tsx"],
        },
      ],
      totalFiles: 3,
      manifestVersion: "1.0.0",
    };

    const validator = new ManifestValidator(contract, nextJsExistingFiles);
    const result = validator.validate(manifest);

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("F. User-explicit targetPath remains a hard constraint", () => {
    const classification: TaskClassificationResult = {
      taskType: "NEW_FEATURE",
      risk: "MEDIUM",
      estimatedComplexity: "MEDIUM",
      intent: "NEW_FEATURE",
      confidence: 0.95,
      requiresClarification: false,
      reasoning: "Add widget under widgets folder",
    };

    const contract = buildExecutionContract(
      classification,
      "Add a status widget strictly inside widgets/StatusWidget.tsx",
      nextJsExistingFiles
    );

    expect(contract.targetPaths).toContain("widgets/StatusWidget.tsx");

    // Manifest attempting to modify an outside file fails validation
    const invalidManifest: FileManifest = {
      files: [
        {
          path: "widgets/StatusWidget.tsx",
          action: "create",
          description: "Widget",
          dependencies: [],
        },
        {
          path: "app/page.tsx",
          action: "modify",
          description: "Outside designated target path",
          dependencies: ["widgets/StatusWidget.tsx"],
        },
      ],
      totalFiles: 2,
      manifestVersion: "1.0.0",
    };

    const validator = new ManifestValidator(contract, nextJsExistingFiles);
    const result = validator.validate(invalidManifest);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.type === "path_constraint")).toBe(true);
  });

  test("E. Invalid authoritative manifest still fails closed on file limit or invalid schema", () => {
    const contract: ExecutionContract = {
      goal: "Test feature",
      taskType: "BUG_FIX",
      risk: "LOW",
      estimatedComplexity: "SMALL",
      pipeline: "REPOSITORY",
      environment: "NODE_JS",
      repositoryRequired: true,
      expectedFiles: [],
      validationType: "TYPESCRIPT_BUILD",
      targetPaths: [],
      allowedActions: ["modify"],
      forbiddenActions: [],
      maxFiles: 2,
      searchScope: [],
      contextScope: [],
      diffCriticEnabled: true,
    };

    const tooManyFilesManifest: FileManifest = {
      files: [
        { path: "a.ts", action: "modify", description: "a", dependencies: [] },
        { path: "b.ts", action: "modify", description: "b", dependencies: [] },
        { path: "c.ts", action: "modify", description: "c", dependencies: [] },
      ],
      totalFiles: 3,
      manifestVersion: "1.0.0",
    };

    const validator = new ManifestValidator(contract, ["a.ts", "b.ts", "c.ts"]);
    const result = validator.validate(tooManyFilesManifest);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.type === "file_limit")).toBe(true);
  });
});
