import {
  CodeChunkExtractor,
  CosineSimilarityEngine,
  EmbeddingCacheManager,
  LocalDeterministicEmbeddingProvider,
  PluggableEmbeddingProvider,
  SemanticRetrievalEngine,
} from "../semantic-retrieval.engine";

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
  console.log("\n🧪 RUNNING SEMANTIC RETRIEVAL ENGINE UNIT TESTS\n" + "─".repeat(50));

  // 1. Code Chunk Extractor Test
  console.log("\n1️⃣  Code Chunk Extractor Tests:");
  const testFileContent = `
export class PaymentService {
  public async chargeCard() {}
}
export interface ChargeRequest { amount: number; }
export function calculateTax(amount: number) { return amount * 0.1; }
`;
  const chunks = CodeChunkExtractor.extractChunks("src/services/payment.service.ts", testFileContent);
  assertTrue(chunks.length >= 3, "Extracted 3+ structured code chunks");
  assertTrue(chunks.some((c) => c.chunkType === "service" && c.name === "PaymentService"), "Extracted PaymentService service chunk");
  assertTrue(chunks.some((c) => c.chunkType === "interface" && c.name === "ChargeRequest"), "Extracted ChargeRequest interface chunk");
  assertTrue(chunks.some((c) => c.chunkType === "function" && c.name === "calculateTax"), "Extracted calculateTax function chunk");

  // 2. Cosine Similarity Mathematics Test
  console.log("\n2️⃣  Cosine Similarity Engine Tests:");
  const vecA = [1, 0, 0, 1];
  const vecB = [1, 0, 0, 1];
  const vecC = [0, 1, 1, 0];

  const simIdentical = CosineSimilarityEngine.compute(vecA, vecB);
  const simOrthogonal = CosineSimilarityEngine.compute(vecA, vecC);

  assertTrue(Math.abs(simIdentical - 1.0) < 0.001, "Cosine similarity of identical vectors is 1.0");
  assertTrue(Math.abs(simOrthogonal - 0.0) < 0.001, "Cosine similarity of orthogonal vectors is 0.0");

  // 3. Embedding Provider Test
  console.log("\n3️⃣  Pluggable Embedding Provider Tests:");
  const provider = new PluggableEmbeddingProvider();
  const vec = await provider.embedQuery("test authentication service");
  assertTrue(vec.length === provider.dimension, `Embedding query returns ${provider.dimension}D vector`);

  // 4. End-to-End Hybrid Semantic Retrieval Test
  console.log("\n4️⃣  End-to-End Hybrid Semantic Retrieval Tests:");
  const engine = new SemanticRetrievalEngine();
  const mockRepo = [
    {
      path: "src/services/auth.service.ts",
      content: "export class AuthService { public async login() {} }",
    },
    {
      path: "src/components/Button.tsx",
      content: "export function Button() { return <button>Click</button>; }",
    },
  ];

  const idxStats = await engine.indexCodebase(mockRepo);
  assertTrue(idxStats.totalChunks >= 2, "Indexed codebase and created chunks");

  const searchRes = await engine.search("login user authentication", 5);
  assertTrue(searchRes.length > 0, "Semantic search returns relevant chunks");
  assertEqual(searchRes[0].chunk.filePath, "src/services/auth.service.ts", "Top result maps to AuthService");

  console.log("\n✨ ALL SEMANTIC RETRIEVAL UNIT TESTS PASSED!\n");
}

runTests().catch((err) => {
  console.error("Unit test execution error:", err);
  process.exit(1);
});
