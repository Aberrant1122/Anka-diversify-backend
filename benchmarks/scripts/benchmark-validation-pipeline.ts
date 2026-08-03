import fs from "fs";
import path from "path";
import { performance } from "perf_hooks";
import { AutomatedValidationPipelineEngine } from "../../src/services/automated-validation-pipeline.engine";

async function runBenchmark() {
  console.log("🚀 STARTING AUTOMATED FEATURE VALIDATION PIPELINE BENCHMARK\n" + "═".repeat(65));

  const sampleChanges = [
    {
      path: "src/services/BenchmarkService.ts",
      content: `export class BenchmarkService {\n  public compute() { return "OK"; }\n}`,
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
    snapshotFiles: sampleChanges,
  });

  const start = performance.now();
  const result = await pipeline.executePipeline(sampleChanges);
  const totalMs = performance.now() - start;

  console.log(`⏱️ Total Pipeline Latency          : ${totalMs.toFixed(2)} ms`);
  console.log(`✅ Overall Status                  : ${result.passed ? "PASSED (ACCEPTED)" : "FAILED (REJECTED)"}`);
  console.log(`📈 Stage Pass Rate                 : ${result.metrics.passRatePct}% (${result.stageResults.filter((s) => s.passed).length} / ${result.stageResults.length} stages)`);
  console.log(`🔄 Execution Attempts              : ${result.attempts}`);
  console.log(`🔧 Surgical Repair Success         : ${result.metrics.repairSuccess ? "YES" : "N/A"}`);

  console.log("\n📊 Stage Execution Times:");
  for (const sr of result.stageResults) {
    console.log(`  • ${sr.stage.padEnd(28)} : ${sr.durationMs.toFixed(2)} ms (${sr.passed ? "PASS" : "FAIL"})`);
  }

  // Save Benchmark JSON & Summary
  const benchmarkData = {
    runDate: new Date().toISOString(),
    metrics: {
      totalTimeMs: totalMs,
      passRatePct: result.metrics.passRatePct,
      stagesCount: result.stageResults.length,
      attempts: result.attempts,
      stageDurations: result.metrics.stageDurations,
    },
  };

  const outputDir = path.join(process.cwd(), "benchmarks");
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(
    path.join(outputDir, "validation-pipeline-results.json"),
    JSON.stringify(benchmarkData, null, 2),
    "utf8",
  );

  const reportMarkdown = `# AUTOMATED FEATURE VALIDATION PIPELINE BENCHMARK REPORT

**Run Date**: ${benchmarkData.runDate}  
**Stages Configured**: ${result.stageResults.length} / 7 stages  
**Overall Status**: ${result.passed ? "✅ **ACCEPTED (100% PASSED)**" : "❌ **REJECTED**"}  

---

## ⚡ Stage Latency & Pass Rate Metrics

| Stage | Command Executed | Status | Duration | Failure Log |
| :--- | :--- | :--- | :--- | :--- |
` + result.stageResults.map((sr) => `| **\`${sr.stage}\`** | \`${sr.commandExecuted}\` | ${sr.passed ? "✅ PASS" : "❌ FAIL"} | ${sr.durationMs.toFixed(2)} ms | ${sr.passed ? "None" : `\`${(sr.failureCause || "").slice(0, 50)}\``} |`).join("\n") + `

---

## 🔍 Key Quality Assurance Features

1. **Automatic 7-Stage Pipeline**: Ensures every generated feature passes Compile, Lint, Unit, Integration, Playwright E2E, API, and Static Feature Validation before acceptance.
2. **Deterministic Gate Control**: Success is **NEVER declared** if any active validation stage fails.
3. **Automated Surgical Repair Loop**: On stage failure, error diagnostics are automatically parsed and minimal AST patches are applied before re-running validation.
4. **Configurable Test Runners**: Enables custom runners for each stage (\`npm test\`, \`npx playwright test\`, \`jest\`, \`vitest\`).
`;

  fs.writeFileSync(path.join(outputDir, "validation-pipeline-summary.md"), reportMarkdown, "utf8");
  console.log(`\n💾 Saved benchmark report to benchmarks/validation-pipeline-summary.md`);
}

runBenchmark().catch((err) => {
  console.error("Benchmark error:", err);
  process.exit(1);
});
