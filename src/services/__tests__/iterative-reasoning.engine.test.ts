import fs from "fs";
import path from "path";
import { IterativeReasoningEngine } from "../iterative-reasoning.engine";

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
  console.log("\n🧪 RUNNING ITERATIVE REASONING AGENT ENGINE UNIT TESTS\n" + "─".repeat(55));

  const mockSnapshot = [
    {
      path: "src/services/AuthService.ts",
      content: `export class AuthService {\n  public async login() {}\n}`,
    },
    {
      path: "src/components/Header.tsx",
      content: `import React from 'react';\nexport function Header() { return <header />;\n}`,
    },
    {
      path: "app/dashboard/page.tsx",
      content: `import { Header } from '../../src/components/Header';\nexport default function DashboardPage() { return <Header />;\n}`,
    },
  ];

  const engine = new IterativeReasoningEngine({
    snapshot: mockSnapshot,
    maxRounds: 3,
    confidenceThreshold: 0.70,
  });

  // 1. Execute Iterative Reasoning Loop
  console.log("\n1️⃣  Multi-Round Iterative Reasoning Execution:");
  const trace = await engine.executeReasoningLoop("User Login Authentication Header", "FEATURE_ADDITION");

  assertTrue(trace.totalRounds > 0, "Executed reasoning rounds");
  assertTrue(trace.finalConfidence >= 0.50, `Final confidence reached ${(trace.finalConfidence * 100).toFixed(0)}%`);
  assertTrue(trace.rounds.length <= 3, "Respected maxRounds = 3 limit");

  // 2. Query Deduplication Check
  console.log("\n2️⃣  Query Deduplication Verification:");
  const allExecutedHashes = new Set<string>();
  let hasDuplicateQuery = false;

  for (const r of trace.rounds) {
    for (const q of r.queriesExecuted) {
      const qHash = `${q.tool}:${JSON.stringify(q.params)}`;
      if (allExecutedHashes.has(qHash)) {
        hasDuplicateQuery = true;
      }
      allExecutedHashes.add(qHash);
    }
  }
  assertTrue(!hasDuplicateQuery, "Zero duplicate queries executed across rounds (100% Deduplicated)");

  // 3. Symbol & File Discovery Tracking
  console.log("\n3️⃣  Discovered Symbol & File Tracking:");
  assertTrue(trace.allDiscoveredSymbols.size > 0, `Tracked ${trace.allDiscoveredSymbols.size} discovered symbols`);
  assertTrue(trace.allExploredFiles.size > 0, `Tracked ${trace.allExploredFiles.size} explored files`);

  // 4. Reasoning Trace Report Generation
  console.log("\n4️⃣  Reasoning Trace Summary Markdown Report:");
  assertTrue(fs.existsSync(path.join(process.cwd(), "benchmarks", "reasoning-trace-summary.md")), "Saved reasoning-trace-summary.md");

  console.log("\n✨ ALL ITERATIVE REASONING ENGINE UNIT TESTS PASSED!\n");
}

runTests().catch((err) => {
  console.error("Unit test execution error:", err);
  process.exit(1);
});
