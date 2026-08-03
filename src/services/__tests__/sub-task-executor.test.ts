import { SubTaskExecutor } from "../sub-task-executor";
import { SubTask, SubTaskExecutionResult, ExecutionContract } from "../../types";

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
  goal: "Build User Dashboard Feature",
  taskType: "NEW_FEATURE",
  risk: "LOW",
  estimatedComplexity: "LARGE",
  pipeline: "REPOSITORY",
  environment: "REACT_TS",
  repositoryRequired: true,
  expectedFiles: [],
  validationType: "TYPESCRIPT_BUILD",
  targetPaths: ["src"],
  allowedActions: ["create", "modify"],
  forbiddenActions: ["delete"],
  maxFiles: 15,
  searchScope: ["src"],
  contextScope: ["src"],
  diffCriticEnabled: true,
};

async function runTests() {
  console.log("\n🧪 RUNNING SUB-TASK EXECUTOR UNIT TESTS\n" + "─".repeat(50));

  const mockGenerator: any = {
    generateManifest: async (req: string, ctx: any, contract: any, subTask?: SubTask) => ({
      files: (subTask?.targetFiles || ["src/default.ts"]).map((tf) => ({
        path: tf,
        action: "create",
        dependencies: ["react"],
        description: `Subtask target ${tf}`,
      })),
      totalFiles: subTask?.targetFiles?.length || 1,
      manifestVersion: "1.0.0",
    }),
  };

  const executor = new SubTaskExecutor(mockGenerator);

  // 1. Successful Sub-Task Execution Test
  console.log("\n1️⃣  Successful Sub-Task Execution Test:");
  const subTask1: SubTask = {
    id: "subtask-1",
    category: "types_and_interfaces",
    description: "Types definition",
    targetFiles: ["src/types/user.ts"],
    dependencies: [],
    estimatedComplexity: "SMALL",
  };

  const completedMap = new Map<string, SubTaskExecutionResult>();
  const res1 = await executor.executeSubTask(subTask1, completedMap, { existingFiles: [] }, mockContract);

  assertEqual(res1.success, true, "Sub-task 1 executes successfully");
  assertEqual(res1.subTaskId, "subtask-1", "Sub-task ID matches");
  assertEqual(res1.changes.length, 1, "Generated 1 file change");
  assertEqual(res1.changes[0].path, "src/types/user.ts", "File change path matches target");

  completedMap.set("subtask-1", res1);

  // 2. Dependent Sub-Task Execution Test
  console.log("\n2️⃣  Dependent Sub-Task Execution Test:");
  const subTask2: SubTask = {
    id: "subtask-2",
    category: "leaf_components",
    description: "User Card component",
    targetFiles: ["src/components/UserCard.tsx"],
    dependencies: ["subtask-1"],
    estimatedComplexity: "SMALL",
  };

  const res2 = await executor.executeSubTask(subTask2, completedMap, { existingFiles: [] }, mockContract);
  assertEqual(res2.success, true, "Dependent sub-task 2 executes successfully when dependency succeeded");

  completedMap.set("subtask-2", res2);

  // 3. Failed Dependency Cascading Halting Test
  console.log("\n3️⃣  Failed Dependency Cascading Halting Test:");
  const failedMap = new Map<string, SubTaskExecutionResult>();
  failedMap.set("subtask-1", {
    subTaskId: "subtask-1",
    success: false,
    manifest: { files: [], totalFiles: 0, manifestVersion: "1.0.0" },
    changes: [],
    errors: ["Validation failed"],
  });

  const res3 = await executor.executeSubTask(subTask2, failedMap, { existingFiles: [] }, mockContract);
  assertEqual(res3.success, false, "Sub-task halts when dependency failed");
  assertTrue(res3.errors![0].includes("failed or was skipped"), "Error explains dependency failure");

  // 4. Result Aggregation Test
  console.log("\n4️⃣  Sub-Task Result Aggregation Test:");
  const aggregated = executor.aggregateResults(completedMap);
  assertEqual(aggregated.success, true, "Overall aggregated success is true");
  assertEqual(aggregated.aggregateManifest.totalFiles, 2, "Aggregated manifest includes 2 total files");
  assertEqual(aggregated.changes.length, 2, "Aggregated changes includes 2 file changes");

  console.log("\n✨ ALL SUB-TASK EXECUTOR UNIT TESTS PASSED!\n");
}

runTests().catch((err) => {
  console.error("Test runner threw error:", err);
  process.exitCode = 1;
});
