import { rerankSemanticResults } from "../repository/CodeAwareReranker";
import { SemanticSearchResult } from "../../services/semantic-retrieval.engine";

describe("CodeAwareReranker — Deterministic Grounded Reranking", () => {
  function createMockCandidate(
    filePath: string,
    name: string,
    chunkType: any = "function",
    content = "export function test() {}",
    hybridScore = 0.5,
    similarityScore = 0.5
  ): SemanticSearchResult {
    return {
      chunk: {
        id: `${filePath}:${chunkType}:${name}:1`,
        filePath,
        chunkType,
        name,
        content,
        startLine: 1,
        endLine: 20,
        hash: `hash-${filePath}-${name}`,
      },
      similarityScore,
      keywordScore: hybridScore,
      hybridScore,
      confidenceScore: hybridScore,
      matchedBy: "HYBRID",
    };
  }

  test("TEST A: Base order preserved with no grounded signals", () => {
    const candidates = [
      createMockCandidate("src/a.ts", "fnA", "function", "", 0.8),
      createMockCandidate("src/b.ts", "fnB", "function", "", 0.6),
      createMockCandidate("src/c.ts", "fnC", "function", "", 0.4),
    ];

    const reranked = rerankSemanticResults(candidates, {});

    expect(reranked.map((r) => r.chunk.name)).toEqual(["fnA", "fnB", "fnC"]);
    expect(reranked[0].rerankScore).toBe(0.8);
    expect(reranked[0].rerankReasons).toEqual([]);
  });

  test("TEST B: Target path wins", () => {
    const candidates = [
      createMockCandidate("src/services/generic.ts", "GenericFn", "function", "", 0.7),
      createMockCandidate("src/services/target.ts", "TargetFn", "function", "", 0.5),
    ];

    const reranked = rerankSemanticResults(candidates, {
      targetPath: "src/services/target.ts",
    });

    // TargetFn base 0.5 + 0.25 = 0.75 > GenericFn 0.70
    expect(reranked[0].chunk.name).toBe("TargetFn");
    expect(reranked[0].rerankScore).toBeCloseTo(0.75);
    expect(reranked[0].rerankReasons).toContain("target-path");
  });

  test("TEST C: Exact symbol improves ranking (+0.20)", () => {
    const candidates = [
      createMockCandidate("src/services/other.ts", "OtherFn", "function", "", 0.65),
      createMockCandidate("src/services/auth.service.ts", "AuthService", "service", "", 0.5),
    ];

    const discoveredSymbols = new Map([
      ["AuthService", { filePath: "src/services/auth.service.ts", line: 1 }],
    ]);

    const reranked = rerankSemanticResults(candidates, {
      discoveredSymbols,
    });

    // AuthService base 0.5 + 0.20 = 0.70 > OtherFn 0.65
    expect(reranked[0].chunk.name).toBe("AuthService");
    expect(reranked[0].rerankScore).toBeCloseTo(0.70);
    expect(reranked[0].rerankReasons).toContain("exact-symbol");
  });

  test("TEST D: Bonus cap (+0.40 maximum)", () => {
    const candidate = createMockCandidate(
      "src/services/auth.service.ts",
      "AuthService",
      "service",
      "class AuthService { login() {} }",
      0.5
    );

    const discoveredSymbols = new Map([
      ["AuthService", { filePath: "src/services/auth.service.ts", line: 1 }],
    ]);

    const reranked = rerankSemanticResults([candidate], {
      targetPath: "src/services/auth.service.ts", // +0.25
      discoveredSymbols, // +0.20
      discoveredServices: ["AuthService"], // +0.10
      // Total potential = 0.55 -> capped at +0.40
    });

    expect(reranked[0].rerankScore).toBeCloseTo(0.90); // 0.50 + 0.40
    expect(reranked[0].rerankReasons).toEqual(["target-path", "exact-symbol", "entity-match"]);
  });

  test("TEST E: Determinism with identical inputs", () => {
    const candidates = [
      createMockCandidate("src/a.ts", "ItemA", "function", "", 0.6),
      createMockCandidate("src/b.ts", "ItemB", "function", "", 0.6),
    ];

    const run1 = rerankSemanticResults(candidates, { targetPath: "src/b.ts" });
    const run2 = rerankSemanticResults(candidates, { targetPath: "src/b.ts" });

    expect(run1).toEqual(run2);
  });

  test("TEST F: Path normalization matches backslashes and slashes", () => {
    const candidate = createMockCandidate(
      "src\\services\\auth.ts",
      "AuthFn",
      "function",
      "",
      0.5
    );

    const reranked = rerankSemanticResults([candidate], {
      targetPath: "src/services/auth.ts",
    });

    expect(reranked[0].rerankReasons).toContain("target-path");
    expect(reranked[0].rerankScore).toBeCloseTo(0.75);
  });

  test("TEST G: Explainability exposes accurate rerankReasons", () => {
    const candidate = createMockCandidate(
      "src/models/user.ts",
      "User",
      "model",
      "model User {}",
      0.4
    );

    const reranked = rerankSemanticResults([candidate], {
      targetPath: "src/models/user.ts",
      discoveredModels: ["User"],
    });

    expect(reranked[0].rerankReasons).toEqual(["target-path", "entity-match"]);
  });

  test("TEST H: No mutation of original candidate objects", () => {
    const originalCandidate = createMockCandidate(
      "src/auth.ts",
      "login",
      "function",
      "",
      0.5,
      0.6
    );
    const frozenCandidate = Object.freeze({ ...originalCandidate });

    const reranked = rerankSemanticResults([frozenCandidate], {
      targetPath: "src/auth.ts",
    });

    expect(frozenCandidate.hybridScore).toBe(0.5);
    expect(frozenCandidate.similarityScore).toBe(0.6);
    expect((frozenCandidate as any).rerankScore).toBeUndefined();
    expect(reranked[0].rerankScore).toBeCloseTo(0.75);
  });

  test("TEST I: Same symbol name in wrong file does not receive exact-symbol bonus", () => {
    const candidateA = createMockCandidate(
      "src/services/auth.service.ts",
      "AuthService",
      "service",
      "",
      0.5
    );
    const candidateB = createMockCandidate(
      "src/examples/auth.service.ts",
      "AuthService",
      "service",
      "",
      0.5
    );

    const discoveredSymbols = new Map([
      ["AuthService", { filePath: "src/services/auth.service.ts", line: 1 }],
    ]);

    const reranked = rerankSemanticResults([candidateA, candidateB], {
      discoveredSymbols,
    });

    const resA = reranked.find((r) => r.chunk.filePath === "src/services/auth.service.ts")!;
    const resB = reranked.find((r) => r.chunk.filePath === "src/examples/auth.service.ts")!;

    expect(resA.rerankReasons).toContain("exact-symbol");
    expect(resA.rerankScore).toBeCloseTo(0.70);

    expect(resB.rerankReasons).not.toContain("exact-symbol");
    // Candidate B should not receive exact symbol bonus because filePath does not match
    expect(resB.rerankScore).toBeCloseTo(0.50);
  });

  test("TEST J: Symbol-content respects discovered symbol filePath", () => {
    // candidateA belongs to auth.service.ts, mentions TokenValidator in body
    const candidateA = createMockCandidate(
      "src/services/auth.service.ts",
      "AuthService",
      "service",
      "function helper() { return TokenValidator.check(); }",
      0.5
    );

    // candidateB belongs to unrelated.ts, also mentions TokenValidator in body
    const candidateB = createMockCandidate(
      "src/components/unrelated.tsx",
      "Unrelated",
      "component",
      "function render() { return TokenValidator.check(); }",
      0.5
    );

    // TokenValidator was discovered in src/services/auth.service.ts
    const discoveredSymbols = new Map([
      ["TokenValidator", { filePath: "src/services/auth.service.ts", line: 10 }],
    ]);

    const reranked = rerankSemanticResults([candidateA, candidateB], {
      discoveredSymbols,
    });

    const resA = reranked.find((r) => r.chunk.filePath === "src/services/auth.service.ts")!;
    const resB = reranked.find((r) => r.chunk.filePath === "src/components/unrelated.tsx")!;

    expect(resA.rerankReasons).toContain("symbol-content");
    expect(resA.rerankScore).toBeCloseTo(0.58);

    expect(resB.rerankReasons).not.toContain("symbol-content");
    expect(resB.rerankScore).toBeCloseTo(0.50);
  });
});
