import { buildGroundedSemanticQueries } from "../repository/RetrievalQueryBuilder";

describe("RetrievalQueryBuilder — Grounded Semantic Query Generation", () => {
  const baseMessage = "Fix redirect when JWT expires";

  test("TEST A: Original request is always present as query #1", () => {
    const queries = buildGroundedSemanticQueries({
      message: baseMessage,
    });

    expect(queries.length).toBe(1);
    expect(queries[0]).toBe(baseMessage);
  });

  test("TEST B: targetPath produces an additional grounded query", () => {
    const queries = buildGroundedSemanticQueries({
      message: baseMessage,
      targetPath: "src/auth/middleware.ts",
    });

    expect(queries.length).toBe(2);
    expect(queries[0]).toBe(baseMessage);
    expect(queries[1]).toBe("Fix redirect when JWT expires src/auth/middleware.ts");
  });

  test("TEST C: discovered symbols are incorporated (max 3 symbols)", () => {
    const queries = buildGroundedSemanticQueries({
      message: baseMessage,
      discoveredSymbols: ["AuthMiddleware", "verifyToken", "jwtSession", "extraSymbolIgnored"],
    });

    expect(queries.length).toBe(2);
    expect(queries[0]).toBe(baseMessage);
    expect(queries[1]).toBe("Fix redirect when JWT expires AuthMiddleware verifyToken jwtSession");
  });

  test("TEST D: discovered services/models/routes can produce one combined entity query (max 4 entities)", () => {
    const queries = buildGroundedSemanticQueries({
      message: baseMessage,
      discoveredServices: ["AuthService"],
      discoveredModels: ["User", "Session"],
      discoveredRoutes: ["POST /api/auth/refresh", "GET /api/user/profile"],
    });

    expect(queries.length).toBe(2);
    expect(queries[0]).toBe(baseMessage);
    expect(queries[1]).toBe("Fix redirect when JWT expires AuthService User Session POST /api/auth/refresh");
  });

  test("TEST E: maximum query count is strictly capped at 4", () => {
    const queries = buildGroundedSemanticQueries({
      message: baseMessage,
      targetPath: "src/auth/middleware.ts",
      discoveredSymbols: ["AuthMiddleware", "verifyToken", "jwtSession"],
      discoveredServices: ["AuthService"],
      discoveredModels: ["User"],
      discoveredRoutes: ["POST /api/auth/refresh"],
    });

    expect(queries.length).toBe(4);
    expect(queries[0]).toBe(baseMessage);
    expect(queries[1]).toBe("Fix redirect when JWT expires src/auth/middleware.ts");
    expect(queries[2]).toBe("Fix redirect when JWT expires AuthMiddleware verifyToken jwtSession");
    expect(queries[3]).toBe("Fix redirect when JWT expires AuthService User POST /api/auth/refresh");
  });

  test("TEST F: duplicate/empty inputs do not create duplicate or empty queries", () => {
    const queries = buildGroundedSemanticQueries({
      message: `  ${baseMessage}   `,
      targetPath: "   ",
      discoveredSymbols: ["", "   ", "AuthMiddleware", "AuthMiddleware"],
      discoveredServices: ["", "  "],
      discoveredModels: [],
      discoveredRoutes: ["   "],
    });

    expect(queries.length).toBe(2);
    expect(queries[0]).toBe(baseMessage);
    expect(queries[1]).toBe("Fix redirect when JWT expires AuthMiddleware");
  });

  test("TEST G: when no repository discoveries exist, the result is simply [originalMessage]", () => {
    const queries = buildGroundedSemanticQueries({
      message: baseMessage,
      targetPath: undefined,
      discoveredSymbols: [],
      discoveredServices: [],
      discoveredModels: [],
      discoveredRoutes: [],
    });

    expect(queries).toEqual([baseMessage]);
  });

  test("returns empty array when message is empty or whitespace", () => {
    expect(buildGroundedSemanticQueries({ message: "" })).toEqual([]);
    expect(buildGroundedSemanticQueries({ message: "   \n\t  " })).toEqual([]);
  });
});
