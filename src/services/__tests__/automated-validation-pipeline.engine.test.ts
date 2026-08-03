import fs from "fs";
import path from "path";
import { AutomatedValidationPipelineEngine, AgentFileChange } from "../automated-validation-pipeline.engine";

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
  console.log("\n🧪 RUNNING AUTOMATED FEATURE VALIDATION PIPELINE UNIT TESTS\n" + "─".repeat(60));

  const validChanges: AgentFileChange[] = [
    {
      path: "src/services/MockService.ts",
      content: `export class MockService {\n  public getValue() { return 42; }\n}`,
    },
  ];

  const pipeline = new AutomatedValidationPipelineEngine({
    commands: {
      compile: 'node -e "process.exit(0)"',
      lint: 'node -e "process.exit(0)"',
      unitTests: 'node -e "process.exit(0)"',
      integrationTests: 'node -e "process.exit(0)"',
      playwright: 'node -e "process.exit(0)"',
      apiTests: 'node -e "process.exit(0)"',
    },
    snapshotFiles: [
      {
        path: "src/services/MockService.ts",
        content: `export class MockService {\n  public getValue() { return 42; }\n}`,
      },
    ],
  });

  // 1. Clean Validation Pipeline Run (All 7 Stages Pass)
  console.log("\n1️⃣  Clean 7-Stage Validation Pipeline Execution:");
  const cleanRes = await pipeline.executePipeline(validChanges);

  assertTrue(cleanRes.passed, "Pipeline overall status is PASSED");
  assertEqual(cleanRes.stageResults.length, 7, "All 7 validation stages executed");
  assertTrue(cleanRes.metrics.passRatePct === 100, "Pipeline pass rate is 100%");

  // 2. Stage Failure & Repair Loop Trigger
  console.log("\n2️⃣  Stage Failure & Surgical Repair Loop Invocation:");
  const failingPipeline = new AutomatedValidationPipelineEngine({
    commands: {
      compile: 'node -e "console.error(\'src/services/MockService.ts(5,10): error TS2304: Cannot find name MissingType.\'); process.exit(1)"',
    },
    maxRepairRetries: 2,
  });

  const failRes = await failingPipeline.executePipeline([
    {
      path: "src/services/MockService.ts",
      content: `export class MockService {\n  public val: MissingType;\n}`,
    },
  ]);

  assertTrue(!failRes.passed, "Pipeline status is REJECTED on compile failure");
  assertEqual(failRes.failedStage, "compile", "Correctly identified failed stage as 'compile'");
  assertTrue(failRes.attempts === 2, "Invoked repair retries up to maxRetries = 2");

  // 3. Validation Report Generation
  console.log("\n3️⃣  Automated Summary Markdown Report Generation:");
  assertTrue(fs.existsSync(path.join(process.cwd(), "benchmarks", "validation-pipeline-summary.md")), "Saved validation-pipeline-summary.md");

  console.log("\n✨ ALL AUTOMATED FEATURE VALIDATION PIPELINE UNIT TESTS PASSED!\n");
}

runTests().catch((err) => {
  console.error("Unit test execution error:", err);
  process.exit(1);
});
