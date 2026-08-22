import {
  enrichFileContextWithSemanticResults,
  buildFullFileLookup,
  normalizeRepoPath,
} from "../repository/SemanticContextResolver";
import { SemanticSearchResult } from "../../services/semantic-retrieval.engine";

describe("SemanticContextResolver — Full File Resolution vs Partial Chunks", () => {
  const fullAuthServiceContent = `import { jwt } from "jsonwebtoken";

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export class AuthService {
  public async login(user: string): Promise<AuthTokens> {
    return { accessToken: "tok", refreshToken: "ref" };
  }
}

export function verifyHelper(token: string): boolean {
  return Boolean(token);
}
`;

  const partialAuthChunkContent = `export class AuthService {
  public async login(user: string): Promise<AuthTokens> {
    return { accessToken: "tok", refreshToken: "ref" };
  }
}`;

  const mockSnapshotFiles = [
    {
      path: "src/services/auth.service.ts",
      content: fullAuthServiceContent,
    },
    {
      path: "src/middleware/auth.middleware.ts",
      content: `export function authMiddleware() {}`,
    },
  ];

  function createMockSemanticResult(
    filePath: string,
    chunkContent: string,
    hybridScore = 0.8,
    similarityScore = 0.8
  ): SemanticSearchResult {
    return {
      chunk: {
        id: `${filePath}:class:AuthService:8`,
        filePath,
        chunkType: "service",
        name: "AuthService",
        content: chunkContent,
        startLine: 8,
        endLine: 14,
        hash: "mock-hash",
      },
      similarityScore,
      keywordScore: 0.8,
      hybridScore,
      confidenceScore: 0.9,
      matchedBy: "HYBRID",
    };
  }

  test("TEST A: Partial semantic chunk resolves to complete snapshot file", () => {
    const fileContext: Record<string, string> = {};
    const semanticResults = [
      createMockSemanticResult("src/services/auth.service.ts", partialAuthChunkContent),
    ];

    enrichFileContextWithSemanticResults({
      fileContext,
      semanticResults,
      rawSnapshotFiles: mockSnapshotFiles,
    });

    expect(fileContext["src/services/auth.service.ts"]).toBeDefined();
    // Must contain the full file content (with imports, interface, helper), NOT the partial chunk!
    expect(fileContext["src/services/auth.service.ts"]).toBe(fullAuthServiceContent);
    expect(fileContext["src/services/auth.service.ts"]).toContain("export interface AuthTokens");
    expect(fileContext["src/services/auth.service.ts"]).toContain("export function verifyHelper");
  });

  test("TEST B: Existing partial fileContext entry is upgraded/replaced with the full snapshot file", () => {
    const fileContext: Record<string, string> = {
      "src/services/auth.service.ts": partialAuthChunkContent, // Stale/partial entry
    };

    const semanticResults = [
      createMockSemanticResult("src/services/auth.service.ts", partialAuthChunkContent),
    ];

    enrichFileContextWithSemanticResults({
      fileContext,
      semanticResults,
      rawSnapshotFiles: mockSnapshotFiles,
    });

    // The partial entry must be replaced with the authoritative full snapshot content
    expect(fileContext["src/services/auth.service.ts"]).toBe(fullAuthServiceContent);
    expect(fileContext["src/services/auth.service.ts"]).toContain("import { jwt } from \"jsonwebtoken\";");
  });

  test("TEST C: Existing full fileContext entry remains correct and is not duplicated", () => {
    const fileContext: Record<string, string> = {
      "src/services/auth.service.ts": fullAuthServiceContent,
    };

    const semanticResults = [
      createMockSemanticResult("src/services/auth.service.ts", partialAuthChunkContent),
    ];

    enrichFileContextWithSemanticResults({
      fileContext,
      semanticResults,
      rawSnapshotFiles: mockSnapshotFiles,
    });

    expect(Object.keys(fileContext)).toEqual(["src/services/auth.service.ts"]);
    expect(fileContext["src/services/auth.service.ts"]).toBe(fullAuthServiceContent);
  });

  test("TEST D: Missing full snapshot file does not insert the semantic chunk", () => {
    const fileContext: Record<string, string> = {
      "src/existing/file.ts": "existing content",
    };

    const semanticResults = [
      createMockSemanticResult("src/untracked/orphan.service.ts", "class Orphan {}"),
    ];

    enrichFileContextWithSemanticResults({
      fileContext,
      semanticResults,
      rawSnapshotFiles: mockSnapshotFiles, // does NOT contain orphan.service.ts
    });

    // orphan.service.ts must NOT be added to fileContext because no full file exists in snapshot
    expect(fileContext["src/untracked/orphan.service.ts"]).toBeUndefined();
    expect(fileContext["src/existing/file.ts"]).toBe("existing content");
    expect(Object.keys(fileContext)).toEqual(["src/existing/file.ts"]);
  });

  test("TEST E: Windows/POSIX path variants resolve to one canonical snapshot path and create only one fileContext entry", () => {
    const fileContext: Record<string, string> = {
      "src\\services\\auth.service.ts": "partial windows content",
    };

    // Semantic result with Windows backslashes
    const semanticResults = [
      createMockSemanticResult("src\\services\\auth.service.ts", partialAuthChunkContent),
    ];

    enrichFileContextWithSemanticResults({
      fileContext,
      semanticResults,
      rawSnapshotFiles: mockSnapshotFiles, // Has canonical path: "src/services/auth.service.ts"
    });

    // The Windows backslash key must be cleaned up, and only canonical snapshot path exists
    expect(fileContext["src\\services\\auth.service.ts"]).toBeUndefined();
    expect(fileContext["src/services/auth.service.ts"]).toBe(fullAuthServiceContent);
    expect(Object.keys(fileContext)).toEqual(["src/services/auth.service.ts"]);
  });

  test("ignores results below similarity and hybrid score thresholds", () => {
    const fileContext: Record<string, string> = {};
    const lowScoreResult = createMockSemanticResult("src/services/auth.service.ts", partialAuthChunkContent, 0.1, 0.1);

    enrichFileContextWithSemanticResults({
      fileContext,
      semanticResults: [lowScoreResult],
      rawSnapshotFiles: mockSnapshotFiles,
    });

    expect(fileContext["src/services/auth.service.ts"]).toBeUndefined();
  });
});
