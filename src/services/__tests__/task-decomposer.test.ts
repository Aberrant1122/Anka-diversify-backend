import { TaskDecomposer } from "../task-decomposer";
import { DependencyExecutionGraph } from "../../types";

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

async function runTests() {
  console.log("\n🧪 RUNNING TASK DECOMPOSER UNIT TESTS\n" + "─".repeat(50));

  const decomposer = new TaskDecomposer();

  // 1. DAG Validation Test (Acyclic vs Cyclic)
  console.log("\n1️⃣  DAG Acyclicity Validation:");

  const validDAG: DependencyExecutionGraph = {
    nodes: [
      { id: "subtask-1", category: "types_and_interfaces", description: "Types", targetFiles: ["t.ts"], dependencies: [], estimatedComplexity: "SMALL" },
      { id: "subtask-2", category: "leaf_components", description: "UI", targetFiles: ["c.tsx"], dependencies: ["subtask-1"], estimatedComplexity: "SMALL" },
      { id: "subtask-3", category: "routing_and_navigation", description: "Page", targetFiles: ["p.tsx"], dependencies: ["subtask-2"], estimatedComplexity: "SMALL" },
    ],
    executionOrder: [],
    graphVersion: "1.0.0",
  };
  assertTrue(decomposer.validateDAG(validDAG), "Valid linear DAG passes validation");

  const cyclicGraph: DependencyExecutionGraph = {
    nodes: [
      { id: "subtask-1", category: "leaf_components", description: "Comp 1", targetFiles: ["c1.tsx"], dependencies: ["subtask-2"], estimatedComplexity: "SMALL" },
      { id: "subtask-2", category: "leaf_components", description: "Comp 2", targetFiles: ["c2.tsx"], dependencies: ["subtask-1"], estimatedComplexity: "SMALL" },
    ],
    executionOrder: [],
    graphVersion: "1.0.0",
  };
  assertEqual(decomposer.validateDAG(cyclicGraph), false, "Cyclic graph fails DAG validation");

  // 2. Topological Sort Test
  console.log("\n2️⃣  Topological Sort Execution Ordering:");
  const complexDAG: DependencyExecutionGraph = {
    nodes: [
      { id: "subtask-4", category: "routing_and_navigation", description: "Route", targetFiles: ["page.tsx"], dependencies: ["subtask-2", "subtask-3"], estimatedComplexity: "SMALL" },
      { id: "subtask-1", category: "types_and_interfaces", description: "Types", targetFiles: ["types.ts"], dependencies: [], estimatedComplexity: "SMALL" },
      { id: "subtask-2", category: "leaf_components", description: "Card", targetFiles: ["card.tsx"], dependencies: ["subtask-1"], estimatedComplexity: "SMALL" },
      { id: "subtask-3", category: "api_integration", description: "API", targetFiles: ["api.ts"], dependencies: ["subtask-1"], estimatedComplexity: "SMALL" },
    ],
    executionOrder: [],
    graphVersion: "1.0.0",
  };

  const order = decomposer.topologicalSort(complexDAG);
  assertTrue(order.indexOf("subtask-1") < order.indexOf("subtask-2"), "subtask-1 comes before dependent subtask-2");
  assertTrue(order.indexOf("subtask-1") < order.indexOf("subtask-3"), "subtask-1 comes before dependent subtask-3");
  assertTrue(order.indexOf("subtask-2") < order.indexOf("subtask-4"), "subtask-2 comes before dependent subtask-4");
  assertTrue(order.indexOf("subtask-3") < order.indexOf("subtask-4"), "subtask-3 comes before dependent subtask-4");

  // 3. Mock OpenAI LLM Decomposition Test
  console.log("\n3️⃣  Mock LLM Task Decomposition Test:");
  const mockOpenAI: any = {
    chat: {
      completions: {
        create: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  nodes: [
                    { id: "subtask-1", category: "types_and_interfaces", description: "Types", targetFiles: ["src/types/user.ts"], dependencies: [], estimatedComplexity: "SMALL" },
                    { id: "subtask-2", category: "container_components", description: "User Dashboard", targetFiles: ["src/components/UserDash.tsx"], dependencies: ["subtask-1"], estimatedComplexity: "MEDIUM" },
                  ],
                  graphVersion: "1.0.0",
                }),
              },
            },
          ],
        }),
      },
    },
  };

  const mockDecomposer = new TaskDecomposer(mockOpenAI);
  const resultGraph = await mockDecomposer.decomposeTask(
    "Build full user management dashboard",
    { existingFiles: [] },
    { taskType: "NEW_FEATURE", intent: "NEW_FEATURE", risk: "HIGH", estimatedComplexity: "LARGE", confidence: 0.95, reasoning: "New feature request", requiresClarification: false }
  );

  assertEqual(resultGraph.nodes.length, 2, "Graph contains expected 2 sub-tasks");
  assertEqual(resultGraph.executionOrder, ["subtask-1", "subtask-2"], "Execution order correctly calculated");

  console.log("\n✨ ALL TASK DECOMPOSER UNIT TESTS PASSED!\n");
}

runTests().catch((err) => {
  console.error("Test runner threw error:", err);
  process.exitCode = 1;
});
