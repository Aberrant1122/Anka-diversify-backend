import { SemanticRetrievalEngine } from "../../services/semantic-retrieval.engine";
import { rerankSemanticResults } from "../repository/CodeAwareReranker";
import { enrichFileContextWithSemanticResults } from "../repository/SemanticContextResolver";
import { buildGroundedSemanticQueries } from "../repository/RetrievalQueryBuilder";

describe("RAG Pipeline Step 5 Integration — searchMany -> Reranker -> FullFile Context", () => {
  const fullAuthServiceContent = `import { jwt } from "jsonwebtoken";

export class AuthService {
  public async login() { return "token"; }
}

export function authHelper() {}
`;

  const fullMiddlewareContent = `export function authMiddleware(req: any, res: any, next: any) {
  next();
}
`;

  const fullThemeContent = `export function ThemeToggle() {
  return <button>Toggle</button>;
}
`;

  const mockRepo = [
    { path: "src/services/auth.service.ts", content: fullAuthServiceContent },
    { path: "src/middleware/auth.middleware.ts", content: fullMiddlewareContent },
    { path: "src/components/ThemeToggle.tsx", content: fullThemeContent },
  ];

  test("End-to-End Pipeline: query builder -> searchMany -> reranker -> full file context enrichment", async () => {
    const engine = new SemanticRetrievalEngine();
    await engine.indexCodebase(mockRepo);

    // 1. Build Grounded Queries
    const userMessage = "Fix token authentication in auth middleware";
    const queries = buildGroundedSemanticQueries({
      message: userMessage,
      targetPath: "src/middleware/auth.middleware.ts",
      discoveredSymbols: ["authMiddleware"],
      discoveredServices: ["AuthService"],
    });

    expect(queries.length).toBeGreaterThanOrEqual(2);

    // 2. searchMany candidates
    const candidates = await engine.searchMany(queries, 10, 10);
    expect(candidates.length).toBeGreaterThan(0);

    // 3. Code-Aware Reranking
    const discoveredSymbols = new Map([
      ["authMiddleware", { filePath: "src/middleware/auth.middleware.ts", line: 1 }],
      ["AuthService", { filePath: "src/services/auth.service.ts", line: 3 }],
    ]);

    const reranked = rerankSemanticResults(candidates, {
      targetPath: "src/middleware/auth.middleware.ts",
      discoveredSymbols,
      discoveredServices: ["AuthService"],
    });

    expect(reranked.length).toBe(candidates.length);
    // Target path and exact symbol should boost auth.middleware.ts to the top
    expect(reranked[0].chunk.filePath).toBe("src/middleware/auth.middleware.ts");
    expect(reranked[0].rerankReasons).toContain("target-path");
    expect(reranked[0].rerankReasons).toContain("exact-symbol");

    // 4. Enrich fileContext with full repository file contents
    const fileContext: Record<string, string> = {};
    enrichFileContextWithSemanticResults({
      fileContext,
      semanticResults: reranked,
      rawSnapshotFiles: mockRepo,
      similarityThreshold: 0.4,
      hybridThreshold: 0.35,
    });

    // Verify canonical path and full file content
    expect(fileContext["src/middleware/auth.middleware.ts"]).toBe(fullMiddlewareContent);
    if (fileContext["src/services/auth.service.ts"]) {
      expect(fileContext["src/services/auth.service.ts"]).toBe(fullAuthServiceContent);
    }
  });
});
