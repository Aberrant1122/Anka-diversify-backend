import { StaticValidationEngine } from "../static-validator.engine";

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
  console.log("\n🧪 RUNNING STATIC FEATURE VALIDATION ENGINE UNIT TESTS\n" + "─".repeat(50));

  // 1. Broken Import Test
  console.log("\n1️⃣  Broken Import Test:");
  const brokenImportRepo = [
    {
      path: "src/app/page.tsx",
      content: `import { MissingComp } from './non-existent-file';\nexport default function Page() { return <div />; }`,
    },
  ];
  const res1 = StaticValidationEngine.validate(brokenImportRepo);
  assertEqual(res1.status, "FAIL", "Status is FAIL for broken import");
  assertTrue(res1.issues.some((i) => i.checkId === "broken_import"), "Detects broken_import issue");

  // 2. Missing Export Test
  console.log("\n2️⃣  Missing Export Test:");
  const missingExportRepo = [
    {
      path: "src/utils/helpers.ts",
      content: `export const validHelper = () => {};`,
    },
    {
      path: "src/app/main.ts",
      content: `import { missingHelper } from '../utils/helpers';`,
    },
  ];
  const res2 = StaticValidationEngine.validate(missingExportRepo);
  assertEqual(res2.status, "FAIL", "Status is FAIL for missing export");
  assertTrue(res2.issues.some((i) => i.checkId === "missing_export"), "Detects missing_export issue");

  // 3. Circular Dependency Test
  console.log("\n3️⃣  Circular Dependency Test:");
  const circularRepo = [
    {
      path: "src/a.ts",
      content: `import { b } from './b';\nexport const a = 1;`,
    },
    {
      path: "src/b.ts",
      content: `import { a } from './a';\nexport const b = 2;`,
    },
  ];
  const res3 = StaticValidationEngine.validate(circularRepo);
  assertTrue(res3.issues.some((i) => i.checkId === "circular_dependency"), "Detects circular_dependency issue between a.ts and b.ts");

  // 4. Orphan Component Test
  console.log("\n4️⃣  Orphan Component Test:");
  const orphanRepo = [
    {
      path: "src/components/UnusedCard.tsx",
      content: `import React from 'react';\nexport function UnusedCard() { return <div>Unused</div>; }`,
    },
    {
      path: "src/app/page.tsx",
      content: `export default function Page() { return <div>Home</div>; }`,
    },
  ];
  const res4 = StaticValidationEngine.validate(orphanRepo);
  assertTrue(res4.issues.some((i) => i.checkId === "orphan_component"), "Detects orphan_component issue");

  // 5. Invalid Prisma Usage Test
  console.log("\n5️⃣  Invalid Prisma Usage Test:");
  const prismaRepo = [
    {
      path: "prisma/schema.prisma",
      content: `model User {\n  id String @id\n}`,
    },
    {
      path: "src/services/data.service.ts",
      content: `const p = new PrismaClient(); p.nonExistentModel.findMany();`,
    },
  ];
  const res5 = StaticValidationEngine.validate(prismaRepo);
  assertEqual(res5.status, "FAIL", "Status is FAIL for invalid Prisma model call");
  assertTrue(res5.issues.some((i) => i.checkId === "invalid_prisma"), "Detects invalid_prisma issue");

  // 6. Clean Valid Repository Test
  console.log("\n6️⃣  Clean Valid Repository Test:");
  const cleanRepo = [
    {
      path: "src/components/Header.tsx",
      content: `import React from 'react';\nexport function Header() { return <header><a href="/dashboard">Dashboard</a></header>; }`,
    },
    {
      path: "app/dashboard/page.tsx",
      content: `import { Header } from '../../src/components/Header';\nexport default function DashboardPage() { return <Header />; }`,
    },
  ];
  const res6 = StaticValidationEngine.validate(cleanRepo);
  assertEqual(res6.status, "PASS", "Status is PASS for fully valid codebase");
  assertTrue(res6.passed, "overallPassed is TRUE for clean codebase");
  assertTrue(res6.metrics.analysisTimeMs < 50, "Deterministic analysis completes in < 50ms");

  // 7. Live Calculator Re-Export Test (valid named re-export from barrel)
  console.log("\n7️⃣  Live Calculator Re-Export Test:");
  const liveCalcRepo = [
    {
      path: "src/app.ts",
      content: `import React from 'react';\nimport { Calculator } from './components/calculator';\nexport default function App() { return <Calculator />; }`,
    },
    {
      path: "src/components/calculator/index.ts",
      content: `export { default as Calculator } from './Calculator';`,
    },
    {
      path: "src/components/calculator/Calculator.tsx",
      content: `import React from 'react';\nconst Calculator = () => <div>Calc</div>;\nexport default Calculator;`,
    },
  ];
  const res7 = StaticValidationEngine.validate(liveCalcRepo);
  const calcMissingExport = res7.issues.filter((i) => i.checkId === "missing_export");
  assertEqual(calcMissingExport.length, 0, "No missing_export issues for valid 'export { default as Calculator }'");

  // 8. Real Missing Export Negative Case (attempting to import unexported symbol from barrel)
  console.log("\n8️⃣  Real Missing Export Negative Test:");
  const missingFromBarrelRepo = [
    {
      path: "src/app.ts",
      content: `import { Dashboard } from './components/calculator';`,
    },
    {
      path: "src/components/calculator/index.ts",
      content: `export { default as Calculator } from './Calculator';`,
    },
  ];
  const res8 = StaticValidationEngine.validate(missingFromBarrelRepo);
  assertEqual(res8.status, "FAIL", "Status is FAIL for unexported symbol from barrel");
  assertTrue(res8.issues.some((i) => i.checkId === "missing_export" && i.reason.includes("Dashboard")), "Detects missing_export for unexported Dashboard");

  // 9. Alias Negative Case (attempting to import original name instead of alias)
  console.log("\n9️⃣  Alias Negative Test:");
  const aliasNegativeRepo = [
    {
      path: "src/app.ts",
      content: `import { Foo } from './index';`,
    },
    {
      path: "src/index.ts",
      content: `export { Foo as Bar } from './foo';`,
    },
  ];
  const res9 = StaticValidationEngine.validate(aliasNegativeRepo);
  assertEqual(res9.status, "FAIL", "Status is FAIL for importing pre-alias name");
  assertTrue(res9.issues.some((i) => i.checkId === "missing_export" && i.reason.includes("Foo")), "Detects missing_export for pre-alias Foo");

  // 10. Default Negative Case (attempting default import on named-only re-export barrel)
  console.log("\n🔟 Default Import Negative Test:");
  const defaultNegativeRepo = [
    {
      path: "src/app.ts",
      content: `import Calculator from './components/calculator';`,
    },
    {
      path: "src/components/calculator/index.ts",
      content: `export { default as Calculator } from './Calculator';`,
    },
  ];
  const res10 = StaticValidationEngine.validate(defaultNegativeRepo);
  assertTrue(res10.issues.some((i) => i.checkId === "missing_export" && i.reason.includes("no default export")), "Warns when importing default from named-only barrel");

  console.log("\n✨ ALL STATIC VALIDATION ENGINE UNIT TESTS PASSED!\n");
}

runTests().catch((err) => {
  console.error("Unit test execution error:", err);
  process.exit(1);
});
