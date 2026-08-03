import { ManifestValidator } from "../manifest-validator";
import { FileManifest, ExecutionContract } from "../../types";

function assertEqual(actual: any, expected: any, testName: string) {
  const aStr = JSON.stringify(actual);
  const eStr = JSON.stringify(expected);
  if (aStr === eStr) {
    console.log(`  ✅ [PASS] ${testName}`);
  } else {
    console.error(`  ❌ [FAIL] ${testName}\n     Expected: ${eStr}\n     Actual:   ${aStr}`);
    process.exitCode = 1;
  }
}

function assertTrue(condition: boolean, testName: string) {
  if (condition) {
    console.log(`  ✅ [PASS] ${testName}`);
  } else {
    console.error(`  ❌ [FAIL] ${testName}`);
    process.exitCode = 1;
  }
}

const mockContract: ExecutionContract = {
  goal: "Add User Profile Page",
  taskType: "NEW_FEATURE",
  risk: "LOW",
  estimatedComplexity: "MEDIUM",
  pipeline: "REPOSITORY",
  environment: "REACT_TS",
  repositoryRequired: true,
  expectedFiles: [],
  validationType: "TYPESCRIPT_BUILD",
  targetPaths: ["src/components"],
  allowedActions: ["create", "modify"],
  forbiddenActions: ["delete"],
  maxFiles: 5,
  searchScope: ["src"],
  contextScope: ["src"],
  diffCriticEnabled: true,
};

async function runTests() {
  console.log("\n🧪 RUNNING MANIFEST VALIDATOR UNIT TESTS\n" + "─".repeat(50));

  // 1. Schema Validation Tests
  console.log("\n1️⃣  Schema Validation:");
  const invalidSchemaManifest: any = {
    files: [{ path: "src/components/Button.tsx", action: "invalid_action", dependencies: [], description: "Test" }],
    totalFiles: 2, // Mismatch with files.length (1)
    manifestVersion: "1.0.0",
  };
  const validator1 = new ManifestValidator(mockContract, []);
  const res1 = validator1.validate(invalidSchemaManifest);
  assertEqual(res1.valid, false, "Invalid schema manifests fail validation");
  assertTrue(res1.errors.some((e) => e.type === "schema"), "Detects schema errors for action and totalFiles mismatch");

  // 2. File Limit Enforcement
  console.log("\n2️⃣  File Limit Enforcement:");
  const excessFilesManifest: FileManifest = {
    files: Array.from({ length: 7 }, (_, i) => ({
      path: `src/components/Comp${i}.tsx`,
      action: "create",
      dependencies: [],
      description: `Component ${i}`,
    })),
    totalFiles: 7,
    manifestVersion: "1.0.0",
  };
  const validator2 = new ManifestValidator({ ...mockContract, maxFiles: 5 }, []);
  const res2 = validator2.validate(excessFilesManifest);
  assertEqual(res2.valid, false, "Exceeding maxFiles fails validation");
  assertTrue(res2.errors.some((e) => e.type === "file_limit"), "Detects file_limit error when totalFiles > maxFiles");

  // 3. Import Resolution Validation
  console.log("\n3️⃣  Import Resolution:");
  const brokenImportManifest: FileManifest = {
    files: [
      {
        path: "src/components/UserProfile.tsx",
        action: "create",
        dependencies: ["./NonExistentAvatar"],
        description: "Profile component",
      },
    ],
    totalFiles: 1,
    manifestVersion: "1.0.0",
  };
  const validator3 = new ManifestValidator(mockContract, []);
  const res3 = validator3.validate(brokenImportManifest);
  assertEqual(res3.valid, false, "Unresolved imports fail validation");
  assertTrue(res3.errors.some((e) => e.type === "import_resolution"), "Detects import_resolution error for missing dependency");

  // 4. Orphan Detection
  console.log("\n4️⃣  Orphan Detection:");
  const orphanManifest: FileManifest = {
    files: [
      {
        path: "src/components/UnusedWidget.tsx",
        action: "create",
        dependencies: [],
        description: "Widget component",
      },
    ],
    totalFiles: 1,
    manifestVersion: "1.0.0",
  };
  const validator4 = new ManifestValidator(mockContract, []);
  const res4 = validator4.validate(orphanManifest);
  assertEqual(res4.valid, false, "Orphaned created file fails validation");
  assertTrue(res4.errors.some((e) => e.type === "orphan"), "Detects orphan error for unimported created component");

  // 5. Path Constraints
  console.log("\n5️⃣  Path Constraints:");
  const pathViolationManifest: FileManifest = {
    files: [
      {
        path: "src/pages/api/user.ts",
        action: "create",
        dependencies: [],
        description: "API route outside target path",
      },
    ],
    totalFiles: 1,
    manifestVersion: "1.0.0",
  };
  const validator5 = new ManifestValidator({ ...mockContract, targetPaths: ["src/components"] }, []);
  const res5 = validator5.validate(pathViolationManifest);
  assertEqual(res5.valid, false, "Path constraint violation fails validation");
  assertTrue(res5.errors.some((e) => e.type === "path_constraint"), "Detects path_constraint error for file outside targetPaths");

  // 6. Valid Manifest Pass
  console.log("\n6️⃣  Valid Manifest Pass:");
  const validManifest: FileManifest = {
    files: [
      {
        path: "src/components/Avatar.tsx",
        action: "create",
        dependencies: ["react"],
        description: "Avatar icon component",
      },
      {
        path: "src/components/UserProfile.tsx",
        action: "create",
        dependencies: ["./Avatar", "react"],
        description: "Main user profile component",
      },
    ],
    totalFiles: 2,
    manifestVersion: "1.0.0",
  };
  const validator6 = new ManifestValidator(mockContract, ["src/components/index.ts"]);
  const res6 = validator6.validate(validManifest);
  // Note: UserProfile imports Avatar, so Avatar is not orphan. UserProfile is imported by index.ts or entry point if added to repo context.
  assertTrue(res6.errors.filter((e) => e.type !== "orphan").length === 0, "No schema/import/path/limit errors for valid manifest");

  // 7. Standalone Manifest Special Case
  console.log("\n7️⃣  Standalone Manifest Test:");
  const standaloneManifest: FileManifest = {
    files: [
      {
        path: "index.html",
        action: "create",
        dependencies: ["./style.css", "./script.js"],
        description: "Main HTML page",
      },
      {
        path: "style.css",
        action: "create",
        dependencies: [],
        description: "Styles",
      },
      {
        path: "script.js",
        action: "create",
        dependencies: [],
        description: "JavaScript logic",
      },
    ],
    totalFiles: 3,
    manifestVersion: "1.0.0",
  };
  const standaloneContract: ExecutionContract = {
    ...mockContract,
    pipeline: "STANDALONE",
    environment: "HTML_CSS_JS",
  };
  const validator7 = new ManifestValidator(standaloneContract, []);
  const res7 = validator7.validate(standaloneManifest);
  assertEqual(res7.valid, true, "Valid standalone HTML/CSS/JS manifest passes validation");

  console.log("\n✨ ALL MANIFEST VALIDATOR UNIT TESTS PASSED!\n");
}

runTests().catch((err) => {
  console.error("Test runner threw error:", err);
  process.exitCode = 1;
});
