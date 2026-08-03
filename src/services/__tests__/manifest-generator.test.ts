import { ManifestGenerator } from "../manifest-generator";
import { ExecutionContract } from "../../types";

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
  goal: "Build User Dashboard",
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
  console.log("\n🧪 RUNNING MANIFEST GENERATOR UNIT TESTS\n" + "─".repeat(50));

  // 1. Mock OpenAI Response Test
  console.log("\n1️⃣  Mock LLM Response Parsing Test:");
  const mockOpenAI: any = {
    chat: {
      completions: {
        create: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  files: [
                    {
                      path: "src/components/UserCard.tsx",
                      action: "create",
                      dependencies: ["react", "lucide-react"],
                      description: "User card component",
                      estimatedLines: 50,
                    },
                  ],
                  totalFiles: 1,
                  manifestVersion: "1.0.0",
                }),
              },
            },
          ],
        }),
      },
    },
  };

  const generator = new ManifestGenerator(mockOpenAI);
  const manifest = await generator.generateManifest(
    "Create user card component",
    { existingFiles: ["src/index.ts"] },
    mockContract
  );

  assertEqual(manifest.totalFiles, 1, "Total files correctly extracted");
  assertEqual(manifest.files[0].path, "src/components/UserCard.tsx", "File path correctly parsed");
  assertEqual(manifest.files[0].action, "create", "File action correctly parsed");
  assertTrue(Array.isArray(manifest.files[0].dependencies), "Dependencies parsed as array");

  // 2. Fallback Generation Test
  console.log("\n2️⃣  Fallback Generation Test (LLM Error Recovery):");
  const failingOpenAI: any = {
    chat: {
      completions: {
        create: async () => {
          throw new Error("OpenAI API rate limit exceeded");
        },
      },
    },
  };

  const failingGenerator = new ManifestGenerator(failingOpenAI);
  const fallbackManifest = await failingGenerator.generateManifest(
    "Build HTML App",
    {},
    { ...mockContract, pipeline: "STANDALONE", environment: "HTML_CSS_JS" }
  );

  assertEqual(fallbackManifest.totalFiles, 3, "Standalone fallback includes 3 files");
  assertTrue(
    fallbackManifest.files.some((f) => f.path === "index.html"),
    "Standalone fallback includes index.html"
  );
  assertTrue(
    fallbackManifest.files.some((f) => f.path === "style.css"),
    "Standalone fallback includes style.css"
  );
  assertTrue(
    fallbackManifest.files.some((f) => f.path === "script.js"),
    "Standalone fallback includes script.js"
  );

  console.log("\n✨ ALL MANIFEST GENERATOR UNIT TESTS PASSED!\n");
}

runTests().catch((err) => {
  console.error("Test runner threw error:", err);
  process.exitCode = 1;
});
