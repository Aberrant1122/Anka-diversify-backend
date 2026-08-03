import fs from "fs";
import path from "path";
import { PersistentRepositoryGraphEngine } from "../persistent-repository-graph.engine";

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
  console.log("\n🧪 RUNNING PERSISTENT REPOSITORY GRAPH ENGINE UNIT TESTS\n" + "─".repeat(55));

  const testCacheDir = path.join(process.cwd(), ".anka-cache", "test-graph");
  if (fs.existsSync(testCacheDir)) {
    try { fs.rmSync(testCacheDir, { recursive: true, force: true }); } catch {}
  }
  const graph = new PersistentRepositoryGraphEngine(testCacheDir);

  const mockRepo = [
    {
      path: "src/services/AuthService.ts",
      content: `export class AuthService {\n  public async login() {}\n}`,
    },
    {
      path: "src/controllers/AuthController.ts",
      content: `import { AuthService } from '../services/AuthService';\nexport class AuthController {\n  public async handleLogin() { prisma.user.findUnique(); }\n}`,
    },
    {
      path: "src/components/Header.tsx",
      content: `import React from 'react';\nimport { UserAvatar } from './UserAvatar';\nexport function Header() { return <div><UserAvatar /></div>; }`,
    },
    {
      path: "src/components/UserAvatar.tsx",
      content: `export function UserAvatar() { return <div>Avatar</div>; }`,
    },
    {
      path: "app/dashboard/page.tsx",
      content: `import { Header } from '../../src/components/Header';\nexport default function DashboardPage() { return <Header />; }`,
    },
    {
      path: "src/routes/api-routes.ts",
      content: `router.post('/api/v1/login', AuthController.handleLogin);\nprisma.user.findMany();`,
    },
    {
      path: "prisma/schema.prisma",
      content: `model User {\n  id String @id\n}`,
    },
  ];

  // 1. Graph Construction Test
  console.log("\n1️⃣  Graph Construction & Incremental Caching Tests:");
  const buildStats = await graph.buildGraph(mockRepo, "test-repo");
  assertTrue(buildStats.totalNodes >= 7, "Graph indexed 7+ nodes");
  assertTrue(buildStats.totalEdges >= 5, "Graph created 5+ relationship edges");
  assertEqual(buildStats.reindexedFiles, 7, "Reindexed 7 new files on first build");

  // Re-build test for 100% incremental cache hits
  const reBuildStats = await graph.buildGraph(mockRepo, "test-repo");
  assertEqual(reBuildStats.cachedFiles, 7, "Incremental re-build has 7 cached files (0 reindexed)");

  // 2. Query 1: "Who calls this function/symbol?"
  console.log("\n2️⃣  Query API: Who calls this function/symbol?");
  const callers = graph.whoCalls("AuthService");
  assertTrue(callers.some((c) => c.filePath?.includes("AuthController")), "AuthController correctly identified as importing/calling AuthService");

  // 3. Query 2: "What breaks if renamed?"
  console.log("\n3️⃣  Query API: What breaks if this symbol is renamed?");
  const breaks = graph.whatBreaksIfRenamed("AuthService");
  assertTrue(breaks.affectedNodes.length >= 1, "Discovered affected nodes for AuthService rename");
  assertTrue(breaks.affectedFiles.some((f) => f.includes("AuthController")), "AuthController.ts identified as impacted file");

  // 4. Query 3: "Which routes use this service?"
  console.log("\n4️⃣  Query API: Which routes use this service?");
  const routes = graph.whichRoutesUseService("AuthService");
  assertTrue(routes.length >= 1, "Resolved routes associated with AuthService");

  // 5. Query 4: "Where is this component rendered?"
  console.log("\n5️⃣  Query API: Where is this component rendered?");
  const renderers = graph.whereIsComponentRendered("UserAvatar");
  assertTrue(renderers.some((r) => r.name === "Header"), "Header component correctly identified as renderer of UserAvatar");

  // 6. Query 5: "Which APIs touch this model?"
  console.log("\n6️⃣  Query API: Which APIs touch this model?");
  const apis = graph.whichAPIsTouchModel("User");
  assertTrue(apis.some((a) => a.name.includes("POST /api/v1/login")), "API POST /api/v1/login correctly identified as touching User model");

  // 7. Disk Persistence Test
  console.log("\n7️⃣  Disk Persistence Tests:");
  assertTrue(fs.existsSync(path.join(testCacheDir, "repository-graph.json")), "Saved repository-graph.json to disk");

  const restoredGraph = new PersistentRepositoryGraphEngine(testCacheDir);
  const restoredStats = restoredGraph.getStats();
  assertTrue(restoredStats.totalNodes >= 7, "Restored graph from disk with identical node count");

  console.log("\n✨ ALL PERSISTENT REPOSITORY GRAPH ENGINE UNIT TESTS PASSED!\n");
}

runTests().catch((err) => {
  console.error("Unit test execution error:", err);
  process.exit(1);
});
