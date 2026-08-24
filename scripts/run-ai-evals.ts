import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { AgentEvalCase, RealEvalRunOptions } from "../src/ai/evals/types";
import { EvalRunner } from "../src/ai/evals/EvalRunner";

dotenv.config();

function parseArgs(): RealEvalRunOptions & { all?: boolean } {
  const args = process.argv.slice(2);
  const options: RealEvalRunOptions & { all?: boolean } = {
    caseIds: [],
    runsPerCase: 1,
    saveResults: true,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--case" && i + 1 < args.length) {
      options.caseIds!.push(args[++i]);
    } else if (arg === "--all") {
      options.all = true;
    } else if (arg === "--max" && i + 1 < args.length) {
      options.maxCases = parseInt(args[++i], 10);
    } else if (arg === "--output" && i + 1 < args.length) {
      options.outputDir = args[++i];
    }
  }

  return options;
}

async function main() {
  const options = parseArgs();

  console.log("\n=======================================================");
  console.log(" ANKA OS — Real-Model Evaluation Harness (Step 10D1)");
  console.log("=======================================================\n");

  if (!process.env.OPENAI_API_KEY) {
    console.error("❌ ERROR: OPENAI_API_KEY environment variable is not set.");
    console.error("Real-model evaluations require a valid OpenAI API key.\n");
    process.exit(1);
  }

  const fixturesBaseDir = path.resolve(__dirname, "../src/ai/evals/fixtures");
  const availableFixtureDirs = fs
    .readdirSync(fixturesBaseDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(fixturesBaseDir, d.name, "case.json")))
    .map((d) => d.name)
    .sort();

  if (!options.all && (!options.caseIds || options.caseIds.length === 0)) {
    console.log("⚠️  SAFETY NOTICE: No case specified.");
    console.log("To run real-model evaluations, you must explicitly specify a case or use --all.");
    console.log("\nUsage examples:");
    console.log("  npm run eval:real -- --case case-01-pagination-bug");
    console.log("  npm run eval:real -- --case case-05-retrieval-challenge");
    console.log("  npm run eval:real -- --all\n");
    console.log("Available fixture cases:");
    availableFixtureDirs.forEach((dir) => console.log(`  - ${dir}`));
    console.log();
    process.exit(0);
  }

  const selectedDirs = options.all
    ? availableFixtureDirs
    : availableFixtureDirs.filter((d) => options.caseIds!.includes(d));

  if (selectedDirs.length === 0) {
    console.error(`❌ ERROR: None of the requested case IDs [${options.caseIds?.join(", ")}] match available fixtures.`);
    process.exit(1);
  }

  const finalDirs = options.maxCases ? selectedDirs.slice(0, options.maxCases) : selectedDirs;
  const cases: AgentEvalCase[] = finalDirs.map((d) =>
    JSON.parse(fs.readFileSync(path.join(fixturesBaseDir, d, "case.json"), "utf8")),
  );

  console.log(`Running REAL_MODEL evaluation on ${cases.length} case(s):`);
  cases.forEach((c) => console.log(`  • [${c.id}] ${c.name}`));
  console.log("\nExecuting pipeline...\n");

  const summary = await EvalRunner.runSuite(cases, fixturesBaseDir, {
    mode: "REAL_MODEL",
    saveResults: true,
    outputDir: options.outputDir,
  });

  console.log("\n=======================================================");
  console.log(" REAL-MODEL EVALUATION SUMMARY");
  console.log("=======================================================");
  console.log(`Run ID:                 ${summary.runId}`);
  console.log(`Timestamp:              ${summary.timestamp}`);
  console.log(`Git Commit:             ${summary.gitCommit || "N/A"}`);
  console.log(`Mode:                   ${summary.mode}`);
  console.log(`Total Cases:            ${summary.totalCases}`);
  console.log(`Passed:                 ${summary.passedCases}`);
  console.log(`Failed:                 ${summary.failedCases}`);
  console.log(`Pass Rate:              ${summary.passRatePct}%`);
  console.log(`First-Pass Success:     ${summary.firstPassSuccessRatePct}%`);
  console.log(`Avg Duration:           ${summary.avgDurationMs} ms`);
  console.log("-------------------------------------------------------");
  console.log(" RAG Retrieval Metrics");
  console.log("-------------------------------------------------------");
  console.log(`Raw Avg Recall@5:       ${summary.rawAvgRecallAt5}`);
  console.log(`Raw Avg MRR:            ${summary.rawAvgMRR}`);
  console.log(`Reranked Avg Recall@5:  ${summary.rerankedAvgRecallAt5}`);
  console.log(`Reranked Avg MRR:       ${summary.rerankedAvgMRR}`);
  console.log(`MRR Delta:              ${summary.avgMrrDelta >= 0 ? "+" : ""}${summary.avgMrrDelta}`);
  console.log(`Context Inclusion Rate: ${summary.avgContextInclusionRate}`);
  console.log("-------------------------------------------------------");
  console.log(" Model Profile & Actual Token Usage");
  console.log("-------------------------------------------------------");
  console.log(`Embedding Provider:     ${summary.modelProfile.embeddingProvider}`);
  console.log(`Models Observed:        ${summary.modelProfile.modelsObserved.join(", ") || "None"}`);
  console.log(`Total Model Calls:      ${summary.modelProfile.callCount}`);
  if (summary.modelProfile.callsByModel) {
    Object.entries(summary.modelProfile.callsByModel).forEach(([m, count]) => {
      console.log(`  - ${m}: ${count} call(s)`);
    });
  }
  if (summary.actualTokenUsage) {
    console.log(`Prompt Tokens:          ${summary.actualTokenUsage.promptTokens.toLocaleString()}`);
    console.log(`Completion Tokens:      ${summary.actualTokenUsage.completionTokens.toLocaleString()}`);
    console.log(`Total Tokens:           ${summary.actualTokenUsage.totalTokens.toLocaleString()}`);
  }
  console.log("=======================================================\n");

  const exitCode = summary.failedCases > 0 ? 1 : 0;
  process.exit(exitCode);
}

main().catch((err) => {
  console.error("Unhandled error during real evaluation run:", err);
  process.exit(1);
});
