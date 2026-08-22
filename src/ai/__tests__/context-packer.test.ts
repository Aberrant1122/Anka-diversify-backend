import { packFileContext, estimateFileTokens } from "../context/ContextPacker";
import { RerankedSemanticResult } from "../repository/CodeAwareReranker";

describe("ContextPacker — Deterministic Token Budgeting and Priority Packing", () => {
  function createMockSemanticResult(
    filePath: string,
    name: string,
    rerankScore: number,
    reasons: any[] = []
  ): RerankedSemanticResult {
    return {
      chunk: {
        id: `${filePath}:function:${name}:1`,
        filePath,
        chunkType: "function",
        name,
        content: `export function ${name}() {}`,
        startLine: 1,
        endLine: 10,
        hash: `hash-${name}`,
      },
      similarityScore: 0.8,
      keywordScore: 0.8,
      hybridScore: 0.8,
      confidenceScore: 0.9,
      matchedBy: "HYBRID",
      rerankScore,
      rerankReasons: reasons,
    };
  }

  test("TEST A: Everything fits — all files remain in fileContext", () => {
    const fileContext = {
      "src/target.ts": "const x = 1;",
      "src/service.ts": "const y = 2;",
    };

    const res = packFileContext({
      fileContext,
      targetPath: "src/target.ts",
      maxTokens: 5000,
    });

    expect(res.includedFiles.length).toBe(2);
    expect(res.excludedFiles.length).toBe(0);
    expect(res.fileContext["src/target.ts"]).toBe("const x = 1;");
    expect(res.fileContext["src/service.ts"]).toBe("const y = 2;");
    expect(res.budgetExceededByRequiredFiles).toBe(false);
  });

  test("TEST B: Lower priority excluded first when budget is tight", () => {
    // 400 chars ~ 100 tokens each
    const targetContent = "A".repeat(400);
    const primaryContent = "B".repeat(400);
    const supportingContent = "C".repeat(400);
    const auxiliaryContent = "D".repeat(400);

    const fileContext = {
      "src/target.ts": targetContent,
      "src/services/auth.service.ts": primaryContent,
      "src/utils/helper.ts": supportingContent,
      "src/auxiliary/extra.ts": auxiliaryContent,
    };

    const semanticResults = [
      createMockSemanticResult("src/target.ts", "target", 1.2, ["target-path"]),
      createMockSemanticResult("src/services/auth.service.ts", "AuthService", 1.0, ["exact-symbol"]),
      createMockSemanticResult("src/utils/helper.ts", "helper", 0.6),
      createMockSemanticResult("src/auxiliary/extra.ts", "extra", 0.4),
    ];

    // Budget allows only ~2.5 files (~260 tokens)
    const res = packFileContext({
      fileContext,
      targetPath: "src/target.ts",
      discoveredServices: ["src/services/auth.service.ts"],
      semanticResults,
      maxTokens: 260,
    });

    expect(res.includedFiles).toContain("src/target.ts");
    expect(res.includedFiles).toContain("src/services/auth.service.ts");
    expect(res.excludedFiles).toContain("src/utils/helper.ts");
    expect(res.excludedFiles).toContain("src/auxiliary/extra.ts");
  });

  test("TEST C: Target file guaranteed even if lower priority files could fit instead", () => {
    const largeTarget = "T".repeat(800); // ~200 tokens
    const smallSupporting1 = "S1".repeat(50); // ~30 tokens
    const smallSupporting2 = "S2".repeat(50); // ~30 tokens

    const fileContext = {
      "src/supporting1.ts": smallSupporting1,
      "src/supporting2.ts": smallSupporting2,
      "src/target.ts": largeTarget,
    };

    // Budget: 210 tokens (fits target alone, or both supporting files)
    const res = packFileContext({
      fileContext,
      targetPath: "src/target.ts",
      maxTokens: 210,
    });

    expect(res.includedFiles).toContain("src/target.ts");
    expect(res.excludedFiles).toContain("src/supporting1.ts");
    expect(res.excludedFiles).toContain("src/supporting2.ts");
  });

  test("TEST D: Required file exceeds budget — keeps complete file and sets budgetExceededByRequiredFiles: true", () => {
    const hugeTarget = "HUGE_TARGET_CONTENT_".repeat(200); // ~1000 tokens

    const fileContext = {
      "src/target.ts": hugeTarget,
    };

    // Budget: only 100 tokens
    const res = packFileContext({
      fileContext,
      targetPath: "src/target.ts",
      maxTokens: 100,
    });

    expect(res.includedFiles).toEqual(["src/target.ts"]);
    expect(res.fileContext["src/target.ts"]).toBe(hugeTarget); // Whole file preserved!
    expect(res.budgetExceededByRequiredFiles).toBe(true);
    expect(res.excludedFiles.length).toBe(0);
  });

  test("TEST E: Whole-file integrity — included file content must exactly equal original", () => {
    const original = "export const secret = 42;\nfunction run() { return true; }";
    const fileContext = {
      "src/app.ts": original,
    };

    const res = packFileContext({
      fileContext,
      maxTokens: 1000,
    });

    expect(res.fileContext["src/app.ts"]).toBe(original);
  });

  test("TEST F: Determinism — identical inputs produce identical results", () => {
    const fileContext = {
      "src/b.ts": "content b",
      "src/a.ts": "content a",
      "src/c.ts": "content c",
    };

    const run1 = packFileContext({ fileContext, maxTokens: 50 });
    const run2 = packFileContext({ fileContext, maxTokens: 50 });

    expect(run1).toEqual(run2);
  });

  test("TEST G: No mutation of input fileContext", () => {
    const originalFileContext = {
      "src/a.ts": "a",
      "src/b.ts": "b",
    };
    const frozenContext = Object.freeze({ ...originalFileContext });

    const res = packFileContext({
      fileContext: frozenContext,
      maxTokens: 10,
    });

    expect(Object.keys(frozenContext)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(res.includedFiles.length).toBeLessThanOrEqual(2);
  });

  test("TEST H: Rerank order preserved within same priority", () => {
    const fileContext = {
      "src/services/second.service.ts": "content 2",
      "src/services/first.service.ts": "content 1",
    };

    const semanticResults = [
      createMockSemanticResult("src/services/first.service.ts", "First", 0.9, ["exact-symbol"]),
      createMockSemanticResult("src/services/second.service.ts", "Second", 0.8, ["exact-symbol"]),
    ];

    const res = packFileContext({
      fileContext,
      semanticResults,
      maxTokens: 1000,
    });

    // first.service.ts ranked higher in reranker -> included first in order
    expect(res.includedFiles).toEqual([
      "src/services/first.service.ts",
      "src/services/second.service.ts",
    ]);
  });

  test("TEST I: Windows/POSIX target path normalization classifies same file as TARGET", () => {
    const fileContext = {
      "src/services/auth.service.ts": "auth content",
    };

    const res = packFileContext({
      fileContext,
      targetPath: "src\\services\\auth.service.ts", // Windows backslash
      maxTokens: 500,
    });

    expect(res.includedFiles).toEqual(["src/services/auth.service.ts"]);
    expect(res.budgetExceededByRequiredFiles).toBe(false);
  });
});
