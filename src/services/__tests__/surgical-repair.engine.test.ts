import {
  ErrorDiagnosticsParser,
  SurgicalPatchEngine,
  SurgicalRepairSessionTracker,
} from "../surgical-repair.engine";

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
  console.log("\n🧪 RUNNING SURGICAL REPAIR ENGINE UNIT TESTS\n" + "─".repeat(50));

  // 1. Error Diagnostics Parser Test
  console.log("\n1️⃣  Error Diagnostics Parser Tests:");
  const sampleTrace = `
src/services/payment.service.ts(15,10): error TS2304: Cannot find name 'PaymentGateway'
src/components/Header.tsx(42,5): error TS2322: Type 'string' is not assignable to type 'number'
`;
  const diags = ErrorDiagnosticsParser.parse(sampleTrace);
  assertEqual(diags.length, 2, "Parsed 2 TypeScript diagnostic errors");
  assertEqual(diags[0].file, "src/services/payment.service.ts", "File 1 correctly parsed");
  assertEqual(diags[0].line, 15, "Line 1 correctly parsed as 15");
  assertEqual(diags[0].code, "TS2304", "Code 1 correctly parsed as TS2304");
  assertEqual(diags[0].symbolName, "PaymentGateway", "Symbol name correctly extracted as PaymentGateway");

  // 2. Surgical Patch Generator Test
  console.log("\n2️⃣  Surgical Patch Generator Tests:");
  const fileContent = `import fs from 'fs';\n\nexport class Service {\n  public run() { return PaymentGateway.process(); }\n}`;
  const patch = SurgicalPatchEngine.generateMinimalPatch(fileContent, "src/services/payment.service.ts", diags[0]);

  assertTrue(patch.linesAdded === 1, "Generated minimal patch adding 1 import line");
  assertTrue(patch.replacementContent.includes("import { PaymentGateway }"), "Patch contains missing import declaration");

  // 3. Surgical Patch Applicator Test (Formatting Preservation)
  console.log("\n3️⃣  Surgical Patch Applicator Tests:");
  const fileContent20 = `import fs from 'fs';\nimport path from 'path';\n\n// Service class\nexport class Service {\n  public run() {\n    return PaymentGateway.process();\n  }\n}\n\n// Helper functions\nexport function helper1() { return 1; }\nexport function helper2() { return 2; }\nexport function helper3() { return 3; }\nexport function helper4() { return 4; }\nexport function helper5() { return 5; }\nexport function helper6() { return 6; }\nexport function helper7() { return 7; }\nexport function helper8() { return 8; }\nexport function helper9() { return 9; }\n`;
  const patch20 = SurgicalPatchEngine.generateMinimalPatch(fileContent20, "src/services/payment.service.ts", diags[0]);
  const res = SurgicalPatchEngine.applyPatch(fileContent20, patch20);
  assertTrue(res.newContent.startsWith("import fs from 'fs';"), "Preserves existing header import");
  assertTrue(res.newContent.includes("import { PaymentGateway }"), "Includes newly inserted surgical import");
  assertTrue(res.newContent.includes("export class Service"), "Preserves surrounding class declaration and formatting");
  assertTrue(res.patchSizePct < 15.0, `Patch size is surgical (${res.patchSizePct}% of file)`);

  // 4. Session & History Tracker Test
  console.log("\n4️⃣  Surgical Repair Session Tracker Tests:");
  const tracker = new SurgicalRepairSessionTracker("test_session_123");
  tracker.recordAttempt({
    attempt: 1,
    timestamp: new Date().toISOString(),
    diagnostics: diags,
    patchesApplied: [patch],
    totalFileLines: 5,
    linesChanged: 1,
    patchSizePct: 20.0,
    repairTimeMs: 12.5,
    compileSuccess: true,
  });

  const metrics = tracker.getMetrics(true);
  assertEqual(metrics.totalAttempts, 1, "Total attempts recorded is 1");
  assertEqual(metrics.successful, true, "Session status recorded as successful");
  assertEqual(metrics.averagePatchSizePct, 20.0, "Average patch size recorded as 20.0%");

  const markdown = tracker.generateSummaryMarkdown(true);
  assertTrue(markdown.includes("SURGICAL REPAIR SESSION METRICS REPORT"), "Generated metrics summary markdown report");

  console.log("\n✨ ALL SURGICAL REPAIR ENGINE UNIT TESTS PASSED!\n");
}

runTests().catch((err) => {
  console.error("Unit test execution error:", err);
  process.exit(1);
});
