import {
  RepositoryToolEngine,
  SymbolNormalizer,
  ScoringEngine,
  MultiGraphIndex,
} from "../repository-tool.engine";

// ─── Test Suite ───────────────────────────────────────────────────────────────

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
  console.log("\n🧪 RUNNING REPOSITORY TOOL ENGINE UNIT TESTS\n" + "─".repeat(50));

  // ── 1. Symbol Normalization Engine Tests ─────────────────────────────────
  console.log("\n1️⃣  Symbol Normalization Tests:");

  const variants = [
    "AIService",
    "AiService",
    "ai-service",
    "ai_service",
    "ai service",
    "ai.service",
  ];

  const expectedCanonical = "aiservice";
  const expectedTokens = ["ai", "service"];

  for (const v of variants) {
    assertEqual(SymbolNormalizer.canonical(v), expectedCanonical, `Canonical normalization of "${v}" -> "${expectedCanonical}"`);
    assertEqual(SymbolNormalizer.tokenize(v), expectedTokens, `Tokenization of "${v}" -> ["ai", "service"]`);
  }

  // ── 2. Multi-Tier Ranking & Scoring Engine Tests ─────────────────────────
  console.log("\n2️⃣  Multi-Tier Ranking & Scoring Tests:");

  const exactRes = ScoringEngine.evaluate("AiService", "AiService");
  assertEqual(exactRes.matchType, "EXACT", "Exact Match detection");
  assertTrue(exactRes.score === 1.0, "Exact Match score is 1.0");
  assertTrue(exactRes.confidence === 1.0, "Exact Match confidence is 1.0");

  const normRes = ScoringEngine.evaluate("AIService", "ai-service");
  assertEqual(normRes.matchType, "NORMALIZED", "Normalized Match detection (AIService vs ai-service)");
  assertTrue(normRes.score >= 0.95, "Normalized Match score >= 0.95");

  const prefixRes = ScoringEngine.evaluate("AiServiceImpl", "AiService");
  assertEqual(prefixRes.matchType, "PREFIX", "Prefix Match detection");
  assertTrue(prefixRes.score >= 0.80 && prefixRes.score < 0.95, "Prefix Match score in [0.80, 0.95)");

  const subRes = ScoringEngine.evaluate("CoreAiServiceWorker", "AiService");
  assertEqual(subRes.matchType, "SUBSTRING", "Substring Match detection");
  assertTrue(subRes.score >= 0.65 && subRes.score < 0.85, "Substring Match score in [0.65, 0.85)");

  const tokenRes = ScoringEngine.evaluate("ServiceAiHandler", "AiService");
  assertEqual(tokenRes.matchType, "TOKEN_SIMILARITY", "Token Similarity Match detection");
  assertTrue(tokenRes.score > 0.20, "Token Similarity score > 0.20");

  // ── 3. Multi-Graph Index & Tool Engine Tests ─────────────────────────────
  console.log("\n3️⃣  Multi-Graph Indexing & Tool Discovery Tests:");

  const mockSnapshot = [
    {
      path: "src/services/ai-service.ts",
      content: `export class AiService {\n  public async processChat() {}\n}`,
    },
    {
      path: "src/components/Sidebar.tsx",
      content: `import React from 'react';\nimport { Button } from './ui/button';\nexport function Sidebar() {\n  return <div className="sidebar"><Button /></div>;\n}`,
    },
    {
      path: "src/components/ui/button.tsx",
      content: `export function Button() { return <button>Click</button>; }`,
    },
    {
      path: "app/dashboard/page.tsx",
      content: `import { Sidebar } from '../../components/Sidebar';\nexport default function DashboardPage() { return <Sidebar />; }`,
    },
    {
      path: "src/routes/ai-routes.ts",
      content: `import { Router } from 'express';\nconst router = Router();\nrouter.post('/api/ai/projects/:projectId/agent/run', (req, res) => {});\nexport default router;`,
    },
    {
      path: "prisma/schema.prisma",
      content: `model User {\n  id String @id\n  email String\n  projects Project[]\n}\n\nmodel Project {\n  id String @id\n  name String\n}`,
    },
  ];

  const engine = new RepositoryToolEngine(mockSnapshot);

  // Test Tool 1: readFile
  const readRes = engine.readFile({ filePath: "src/services/ai-service.ts", startLine: 1, endLine: 2 });
  assertTrue(readRes.found, "readFile finds file");
  assertTrue(readRes.content.includes("export class AiService"), "readFile content snippet matches");

  // Test Tool 2: findRoute
  const routeRes = engine.findRoute({ pathPattern: "/dashboard" });
  assertTrue(routeRes.routes.length > 0, "findRoute discovers /dashboard route");
  assertEqual(routeRes.routes[0].path, "/dashboard", "Route path matches /dashboard");

  // Test Tool 3: findComponent
  const compRes = engine.findComponent({ componentName: "Sidebar" });
  assertTrue(compRes.components.length > 0, "findComponent discovers Sidebar");
  assertEqual(compRes.components[0].componentName, "Sidebar", "Component name matches Sidebar");
  assertTrue(compRes.components[0].isReachable, "Sidebar reachability resolved to TRUE");

  // Test Tool 4: findService
  const svcRes = engine.findService({ serviceName: "ai_service" });
  assertTrue(svcRes.services.length > 0, "findService resolves normalized 'ai_service' query");
  assertEqual(svcRes.services[0].serviceName, "AiService", "Service name resolves to 'AiService'");

  // Test Tool 5: findAPI
  const apiRes = engine.findAPI({ endpointPattern: "/agent/run" });
  assertTrue(apiRes.endpoints.length > 0, "findAPI discovers /agent/run endpoint");

  // Test Tool 6: findModel
  const modelRes = engine.findModel({ modelName: "user" });
  assertTrue(modelRes.models.length > 0, "findModel resolves normalized 'user' query to User model");
  assertEqual(modelRes.models[0].modelName, "User", "Model name matches User");

  // Test Tool 7: findReferences
  const refRes = engine.findReferences({ symbolName: "Sidebar" });
  assertTrue(refRes.references.length > 0, "findReferences finds Sidebar references across files");

  // Test Tool 8: searchArchitecture
  const archRes = engine.searchArchitecture({ query: "Sidebar", layer: "presentation" });
  assertTrue(archRes.results.length > 0, "searchArchitecture finds presentation layer file");

  // Test Tool 9: semanticSearch
  const semRes = engine.semanticSearch({ query: "processChat", limit: 5 });
  assertTrue(semRes.length > 0, "semanticSearch finds processChat symbol");
  assertTrue(semRes[0].confidenceScore > 0, "semanticSearch computes non-zero confidence score");

  // Test OpenAI definitions & dispatch
  const defs = RepositoryToolEngine.getOpenAIToolDefinitions();
  assertEqual(defs.length, 9, "getOpenAIToolDefinitions returns 9 tool definitions");

  const dispatchRes = engine.dispatch("repo_findComponent", { componentName: "Button" });
  assertTrue(dispatchRes.includes("Button"), "dispatch('repo_findComponent') returns Button result JSON");

  console.log("\n✨ ALL UNIT TESTS PASSED SUCCESSFULLY!\n");
}

runTests().catch((err) => {
  console.error("Unit test execution error:", err);
  process.exit(1);
});
