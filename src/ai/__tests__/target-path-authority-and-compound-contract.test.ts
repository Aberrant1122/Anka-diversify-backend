import { TargetPathExtractor } from "../contracts/TargetPathExtractor";
import { buildExecutionContract, detectCompoundIntent } from "../contracts/ExecutionContractBuilder";
import { ManifestValidator } from "../../services/manifest-validator";
import { TaskClassificationResult } from "../shared/types";

describe("Target Path Authority & Compound Operation Contract", () => {
  const repoFiles = [
    ".gitignore",
    "AGENTS.md",
    "CLAUDE.md",
    "README.md",
    "app/components/Button.tsx",
    "app/components/Calculator.tsx",
    "app/components/Card.tsx",
    "app/components/Footer.tsx",
    "app/components/Header.tsx",
    "app/components/Sidebar.tsx",
    "app/favicon.ico",
    "app/globals.css",
    "app/layout.tsx",
    "app/page.tsx",
    "app/styles/calculator.css",
    "app/styles/components.css",
    "eslint.config.mjs",
    "next.config.ts",
    "package.json",
    "tsconfig.json",
  ];

  test("Regression A (Part R): User explicitly says 'Modify app/page.tsx' -> app/page.tsx is explicit hard target; unrelated files rejected", () => {
    const message = "Modify app/page.tsx";
    const classification: TaskClassificationResult = {
      taskType: "BUG_FIX",
      risk: "LOW",
      estimatedComplexity: "SMALL",
      intent: "BUG_FIX",
      confidence: 0.95,
      requiresClarification: false,
      reasoning: "Modify page",
    };

    const contract = buildExecutionContract(classification, message, repoFiles);
    expect(contract.targetPaths).toEqual(["app/page.tsx"]);

    const validator = new ManifestValidator(contract, { existingFiles: repoFiles });
    const validManifest = {
      files: [{ path: "app/page.tsx", action: "modify" as const, description: "Update page", dependencies: [] }],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    };
    expect(validator.validate(validManifest).valid).toBe(true);

    const invalidManifest = {
      files: [
        { path: "app/page.tsx", action: "modify" as const, description: "Update page", dependencies: [] },
        { path: "lib/payments.ts", action: "modify" as const, description: "Unrelated file", dependencies: [] },
      ],
      totalFiles: 2,
      manifestVersion: "1.0.0",
    };
    const invalidResult = validator.validate(invalidManifest);
    expect(invalidResult.valid).toBe(false);
    expect(invalidResult.errors.some((e) => e.affectedFiles.includes("lib/payments.ts"))).toBe(true);
  });

  test("Regression B (Part S): User says 'Remove the calculator.' -> classifier guess 'src/calculator' is NOT hard target; pure removal preserved", () => {
    const message = "Remove the calculator.";
    const classification: TaskClassificationResult = {
      taskType: "DELETE_FOLDER",
      risk: "LOW",
      estimatedComplexity: "SMALL",
      intent: "DELETE_FOLDER",
      confidence: 0.95,
      requiresClarification: false,
      reasoning: "Remove calculator",
      targetPath: "src/calculator", // Nonexistent hallucination
    };

    const contract = buildExecutionContract(classification, message, repoFiles);
    // src/calculator must NOT be in targetPaths
    expect(contract.targetPaths).not.toContain("src/calculator");
    // Grounded files should be included
    expect(contract.targetPaths).toContain("app/components/Calculator.tsx");
    expect(contract.targetPaths).toContain("app/styles/calculator.css");
    expect(contract.targetPaths).toContain("app/page.tsx");

    // Pure removal task must NOT have constructive compound actions
    expect(contract.allowedActions).not.toContain("create_components");
    expect(contract.forbiddenActions).toContain("create_components");
  });

  test("Regression C (Part T): Classifier guesses generic broad 'src/' without user saying 'src/' -> not promoted to hard target", () => {
    const message = "Remove the calculator.";
    const classification: TaskClassificationResult = {
      taskType: "DELETE_FOLDER",
      risk: "LOW",
      estimatedComplexity: "SMALL",
      intent: "DELETE_FOLDER",
      confidence: 0.95,
      requiresClarification: false,
      reasoning: "Remove calculator",
      targetPath: "src", // Broad generic guess
    };

    const extracted = TargetPathExtractor.extract(message, {
      repoFiles,
      taskType: classification.taskType,
      classifierTarget: classification.targetPath,
    });
    expect(extracted).not.toContain("src");
  });

  test("Regression D (Part U) — Test Case 2: 'Remove the calculator from the repository and enhance the dashboard UI.' -> compound contract & valid manifest", () => {
    const message = "Remove the calculator from the repository and enhance the dashboard UI.";
    const classification: TaskClassificationResult = {
      taskType: "DELETE_FOLDER",
      risk: "MEDIUM",
      estimatedComplexity: "MEDIUM",
      intent: "DELETE_FOLDER",
      confidence: 0.95,
      requiresClarification: false,
      reasoning: "Remove calculator and update dashboard",
      targetPath: "src/calculator",
    };

    const compound = detectCompoundIntent(message);
    expect(compound.isCompound).toBe(true);
    expect(compound.hasDeletion).toBe(true);
    expect(compound.hasEnhancementOrCreation).toBe(true);

    const contract = buildExecutionContract(classification, message, repoFiles);
    expect(contract.targetPaths).not.toContain("src/calculator");
    expect(contract.targetPaths).toContain("app/components/Calculator.tsx");
    expect(contract.targetPaths).toContain("app/styles/calculator.css");
    expect(contract.targetPaths).toContain("app/page.tsx");

    // Allowed actions must include both removal and enhancement capabilities
    expect(contract.allowedActions).toContain("delete_folder");
    expect(contract.allowedActions).toContain("delete_file");
    expect(contract.allowedActions).toContain("remove_imports");
    expect(contract.allowedActions).toContain("modify_file");
    expect(contract.allowedActions).toContain("create_components");

    // Forbidden actions must NOT forbid create_components or modify_file
    expect(contract.forbiddenActions).not.toContain("create_components");
    expect(contract.forbiddenActions).not.toContain("modify_file");

    // Manifest representing BOTH user goals
    const compoundManifest = {
      files: [
        {
          path: "app/components/Calculator.tsx",
          action: "delete" as const,
          description: "Remove the Calculator component as requested",
          dependencies: [],
        },
        {
          path: "app/styles/calculator.css",
          action: "delete" as const,
          description: "Remove calculator-specific styling",
          dependencies: [],
        },
        {
          path: "app/page.tsx",
          action: "modify" as const,
          description: "Remove calculator references and enhance dashboard UI",
          dependencies: ["./components/Card", "./components/Button"],
        },
      ],
      totalFiles: 3,
      manifestVersion: "1.0.0",
    };

    const validator = new ManifestValidator(contract, { existingFiles: repoFiles });
    const validationResult = validator.validate(compoundManifest);
    expect(validationResult.valid).toBe(true);
    expect(validationResult.errors.length).toBe(0);
  });

  test("Regression E (Part V): Compound task proposing unrelated 'lib/payments.ts' fails path validation", () => {
    const message = "Remove the calculator from the repository and enhance the dashboard UI.";
    const classification: TaskClassificationResult = {
      taskType: "DELETE_FOLDER",
      risk: "MEDIUM",
      estimatedComplexity: "MEDIUM",
      intent: "DELETE_FOLDER",
      confidence: 0.95,
      requiresClarification: false,
      reasoning: "Remove calculator and update dashboard",
      targetPath: "src/calculator",
    };

    const contract = buildExecutionContract(classification, message, repoFiles);
    const validator = new ManifestValidator(contract, { existingFiles: repoFiles });

    const maliciousManifest = {
      files: [
        { path: "app/components/Calculator.tsx", action: "delete" as const, description: "Remove Calculator", dependencies: [] },
        { path: "app/styles/calculator.css", action: "delete" as const, description: "Remove styles", dependencies: [] },
        { path: "app/page.tsx", action: "modify" as const, description: "Update page", dependencies: [] },
        { path: "lib/payments.ts", action: "create" as const, description: "Unrelated file", dependencies: [] },
      ],
      totalFiles: 4,
      manifestVersion: "1.0.0",
    };

    const result = validator.validate(maliciousManifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.affectedFiles.includes("lib/payments.ts"))).toBe(true);
  });

  test("Provenance classification distinguishes explicit, grounded, and hint paths", () => {
    const message = "Modify app/page.tsx and remove calculator";
    const infos = TargetPathExtractor.extractWithProvenance(message, {
      repoFiles,
      classifierTarget: "src/calculator",
    });

    const explicit = infos.find((i) => i.path === "app/page.tsx");
    expect(explicit).toBeDefined();
    expect(explicit?.provenance).toBe("EXPLICIT_USER_PATH");

    const hint = infos.find((i) => i.path === "src/calculator");
    expect(hint).toBeUndefined(); // Nonexistent classifier hint filtered out
  });
});
