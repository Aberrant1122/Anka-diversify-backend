import { SemanticRetrievalEngine } from "../../services/semantic-retrieval.engine";
import { rerankSemanticResults } from "../repository/CodeAwareReranker";
import { enrichFileContextWithSemanticResults } from "../repository/SemanticContextResolver";
import { packFileContext } from "../context/ContextPacker";
import { buildGroundedSemanticQueries } from "../repository/RetrievalQueryBuilder";

describe("RAG Pipeline Step 6 Integration — End-to-End Search -> Rerank -> Resolve -> Pack", () => {
  const targetFileContent = `import { jwt } from "jsonwebtoken";

export function authMiddleware(req: any, res: any, next: any) {
  const token = req.headers.authorization;
  if (!token) throw new Error("Unauthorized");
  next();
}
`;

  const authServiceContent = `export class AuthService {
  public async login() { return "token"; }
}
`;

  const themeToggleContent = `export function ThemeToggle() {
  return <button>Toggle</button>;
}
`;

  const mockRepo = [
    { path: "src/middleware/auth.middleware.ts", content: targetFileContent },
    { path: "src/services/auth.service.ts", content: authServiceContent },
    { path: "src/components/ThemeToggle.tsx", content: themeToggleContent },
  ];

  test("Pipeline: searchMany -> rerank -> full-file context -> context packer tight budget", async () => {
    const engine = new SemanticRetrievalEngine();
    await engine.indexCodebase(mockRepo);

    // 1. Grounded query generation
    const queries = buildGroundedSemanticQueries({
      message: "fix auth token middleware",
      targetPath: "src/middleware/auth.middleware.ts",
      discoveredSymbols: ["authMiddleware"],
      discoveredServices: ["src/services/auth.service.ts"],
    });

    // 2. searchMany
    const candidates = await engine.searchMany(queries, 10, 10);
    expect(candidates.length).toBeGreaterThan(0);

    // 3. Rerank
    const discoveredSymbols = new Map([
      ["authMiddleware", { filePath: "src/middleware/auth.middleware.ts", line: 3 }],
    ]);

    const reranked = rerankSemanticResults(candidates, {
      targetPath: "src/middleware/auth.middleware.ts",
      discoveredSymbols,
      discoveredServices: ["src/services/auth.service.ts"],
    });

    // 4. Enrich full-file context
    const fileContext: Record<string, string> = {};
    enrichFileContextWithSemanticResults({
      fileContext,
      semanticResults: reranked,
      rawSnapshotFiles: mockRepo,
      similarityThreshold: 0.35,
      hybridThreshold: 0.30,
    });

    expect(fileContext["src/middleware/auth.middleware.ts"]).toBe(targetFileContent);

    // 5. Context Packer with limited token budget (allows target file + 1 primary, excludes extra)
    const packed = packFileContext({
      fileContext,
      targetPath: "src/middleware/auth.middleware.ts",
      semanticResults: reranked,
      maxTokens: 80, // Tight budget: keeps target file, drops lower priority
    });

    // Target file is strictly guaranteed and preserved complete
    expect(packed.includedFiles).toContain("src/middleware/auth.middleware.ts");
    expect(packed.fileContext["src/middleware/auth.middleware.ts"]).toBe(targetFileContent);
    expect(packed.telemetry.contextFilesAfterPacking).toBeLessThanOrEqual(packed.telemetry.contextFilesBeforePacking);
  });
});
