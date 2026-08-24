import {
  GeneratedChangeProposal,
  resolveGenerationProposals,
} from "../generation/GenerationProposalResolver";

describe("GenerationProposalResolver — Deterministic Proposal Resolution", () => {
  const makeFileContext = (files: Record<string, string>): Readonly<Record<string, string>> =>
    Object.freeze({ ...files });

  // ── TEST A: Valid MODIFY patch resolves to complete AgentFileChange content ──
  test("TEST A: Valid MODIFY patch resolves to complete AgentFileChange content", () => {
    const fileContext = makeFileContext({
      "src/auth.ts": "const timeout = 5000;\nconst retries = 3;\n",
    });
    const proposals: GeneratedChangeProposal[] = [
      {
        path: "src/auth.ts",
        action: "modify",
        edits: [{ oldText: "const timeout = 5000;", newText: "const timeout = 10000;" }],
        description: "Increase timeout",
      },
    ];

    const result = resolveGenerationProposals(proposals, fileContext);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.changes).toHaveLength(1);
      expect(result.changes[0].path).toBe("src/auth.ts");
      expect(result.changes[0].action).toBe("modify");
      expect(result.changes[0].content).toBe("const timeout = 10000;\nconst retries = 3;\n");
    }
  });

  // ── TEST B: Untouched regions remain unchanged ──
  test("TEST B: Untouched regions remain byte-for-byte unchanged after patch", () => {
    const HEADER = "// header\nimport foo from 'bar';\n\n";
    const FOOTER = "\n// footer\nexport default {};\n";
    const original = `${HEADER}const x = 1;${FOOTER}`;
    const fileContext = makeFileContext({ "src/main.ts": original });

    const proposals: GeneratedChangeProposal[] = [
      {
        path: "src/main.ts",
        action: "modify",
        edits: [{ oldText: "const x = 1;", newText: "const x = 99;" }],
        description: "Update x",
      },
    ];

    const result = resolveGenerationProposals(proposals, fileContext);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.changes[0].content).toContain(HEADER);
      expect(result.changes[0].content).toContain(FOOTER);
      expect(result.changes[0].content).toContain("const x = 99;");
    }
  });

  // ── TEST C: CREATE passes complete content through ──
  test("TEST C: CREATE passes complete content through unchanged", () => {
    const fileContext = makeFileContext({});
    const proposals: GeneratedChangeProposal[] = [
      {
        path: "src/new-file.ts",
        action: "create",
        content: "export const newModule = true;\n",
        description: "New module",
      },
    ];

    const result = resolveGenerationProposals(proposals, fileContext);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.changes).toHaveLength(1);
      expect(result.changes[0].path).toBe("src/new-file.ts");
      expect(result.changes[0].action).toBe("create");
      expect(result.changes[0].content).toBe("export const newModule = true;\n");
    }
  });

  // ── TEST D: DELETE resolves correctly ──
  test("TEST D: DELETE resolves correctly with isDeleted and empty content", () => {
    const fileContext = makeFileContext({ "src/old.ts": "old content" });
    const proposals: GeneratedChangeProposal[] = [
      {
        path: "src/old.ts",
        action: "delete",
        content: "",
        description: "Remove old module",
        isDeleted: true,
      },
    ];

    const result = resolveGenerationProposals(proposals, fileContext);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.changes).toHaveLength(1);
      expect(result.changes[0].action).toBe("delete");
      expect(result.changes[0].isDeleted).toBe(true);
      expect(result.changes[0].content).toBe("");
    }
  });

  // ── TEST E: MODIFY without edits fails: MODIFY_PATCH_REQUIRED ──
  test("TEST E: MODIFY without edits fails with MODIFY_PATCH_REQUIRED", () => {
    const fileContext = makeFileContext({ "src/auth.ts": "original" });
    const proposals: GeneratedChangeProposal[] = [
      {
        path: "src/auth.ts",
        action: "modify",
        edits: [],
        description: "No edits provided",
      },
    ];

    const result = resolveGenerationProposals(proposals, fileContext);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("MODIFY_PATCH_REQUIRED");
      expect(result.error.path).toBe("src/auth.ts");
      expect(result.error.proposalIndex).toBe(0);
    }
  });

  // ── TEST F: MODIFY with full content but no edits fails ──
  test("TEST F: MODIFY with missing edits array fails with MODIFY_PATCH_REQUIRED", () => {
    const fileContext = makeFileContext({ "src/auth.ts": "original" });

    // Simulate a raw proposal that has content but no edits
    const proposals: GeneratedChangeProposal[] = [
      {
        path: "src/auth.ts",
        action: "modify",
        edits: undefined as any, // LLM forgot edits
        description: "Full content without edits",
      },
    ];

    const result = resolveGenerationProposals(proposals, fileContext);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("MODIFY_PATCH_REQUIRED");
    }
  });

  // ── TEST G: Source file missing fails: PATCH_SOURCE_FILE_NOT_FOUND ──
  test("TEST G: Source file missing fails with PATCH_SOURCE_FILE_NOT_FOUND", () => {
    const fileContext = makeFileContext({}); // Empty context
    const proposals: GeneratedChangeProposal[] = [
      {
        path: "src/missing.ts",
        action: "modify",
        edits: [{ oldText: "old", newText: "new" }],
        description: "Modify missing file",
      },
    ];

    const result = resolveGenerationProposals(proposals, fileContext);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("PATCH_SOURCE_FILE_NOT_FOUND");
      expect(result.error.path).toBe("src/missing.ts");
    }
  });

  // ── TEST H: Ambiguous patch propagates: AMBIGUOUS_PATCH_TARGET ──
  test("TEST H: Ambiguous patch propagates AMBIGUOUS_PATCH_TARGET from PatchApplicator", () => {
    const fileContext = makeFileContext({
      "src/dup.ts": "foo();\nbar();\nfoo();\n",
    });
    const proposals: GeneratedChangeProposal[] = [
      {
        path: "src/dup.ts",
        action: "modify",
        edits: [{ oldText: "foo();", newText: "baz();" }],
        description: "Replace foo",
      },
    ];

    const result = resolveGenerationProposals(proposals, fileContext);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("AMBIGUOUS_PATCH_TARGET");
      expect(result.error.path).toBe("src/dup.ts");
    }
  });

  // ── TEST I: Missing target propagates: PATCH_TARGET_NOT_FOUND ──
  test("TEST I: Missing target propagates PATCH_TARGET_NOT_FOUND from PatchApplicator", () => {
    const fileContext = makeFileContext({
      "src/config.ts": "const PORT = 3000;\n",
    });
    const proposals: GeneratedChangeProposal[] = [
      {
        path: "src/config.ts",
        action: "modify",
        edits: [{ oldText: "const HOST = 'localhost';", newText: "const HOST = '0.0.0.0';" }],
        description: "Fix host",
      },
    ];

    const result = resolveGenerationProposals(proposals, fileContext);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("PATCH_TARGET_NOT_FOUND");
    }
  });

  // ── TEST J: One failed proposal fails entire multi-file resolution ──
  test("TEST J: One failed proposal fails the entire multi-file resolution (all-or-nothing)", () => {
    const fileContext = makeFileContext({
      "src/a.ts": "const a = 1;\n",
      "src/b.ts": "const b = 1;\n",
      "src/c.ts": "const c = 1;\nconst c = 1;\n", // Ambiguous target
    });
    const proposals: GeneratedChangeProposal[] = [
      {
        path: "src/a.ts",
        action: "create",
        content: "new a content",
        description: "New a",
      },
      {
        path: "src/b.ts",
        action: "modify",
        edits: [{ oldText: "const b = 1;", newText: "const b = 2;" }],
        description: "Valid modify",
      },
      {
        path: "src/c.ts",
        action: "modify",
        edits: [{ oldText: "const c = 1;", newText: "const c = 2;" }],
        description: "Ambiguous modify",
      },
    ];

    const result = resolveGenerationProposals(proposals, fileContext);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("AMBIGUOUS_PATCH_TARGET");
      expect(result.error.path).toBe("src/c.ts");
      expect(result.error.proposalIndex).toBe(2);
    }
  });

  // ── TEST K: Windows/POSIX paths resolve canonically ──
  test("TEST K: Windows/POSIX paths resolve canonically", () => {
    const fileContext = makeFileContext({
      "src\\auth.ts": "const x = 1;\n",
    });
    const proposals: GeneratedChangeProposal[] = [
      {
        path: "src/auth.ts",
        action: "modify",
        edits: [{ oldText: "const x = 1;", newText: "const x = 2;" }],
        description: "Cross-platform path",
      },
    ];

    const result = resolveGenerationProposals(proposals, fileContext);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.changes).toHaveLength(1);
      expect(result.changes[0].content).toBe("const x = 2;\n");
    }
  });

  // ── TEST L: Resolver does not mutate input proposals or context ──
  test("TEST L: Resolver does not mutate input proposals or context", () => {
    const fileContext = { "src/x.ts": "const x = 1;\n" };
    const proposals: GeneratedChangeProposal[] = [
      {
        path: "src/x.ts",
        action: "modify",
        edits: [{ oldText: "const x = 1;", newText: "const x = 2;" }],
        description: "Update x",
      },
    ];

    const contextCopy = JSON.parse(JSON.stringify(fileContext));
    const proposalsCopy = JSON.parse(JSON.stringify(proposals));

    resolveGenerationProposals(proposals, fileContext);

    expect(fileContext).toEqual(contextCopy);
    expect(proposals).toEqual(proposalsCopy);
  });

  // ── TEST M: Resolver records expectedSourceHashes for MODIFY only ──
  test("TEST M: Resolver records expectedSourceHashes for MODIFY files and not CREATE/DELETE", () => {
    const fileContent = "const timeout = 5000;\n";
    const fileContext = makeFileContext({
      "src/auth.ts": fileContent,
      "src/delete-me.ts": "legacy",
    });

    const proposals: GeneratedChangeProposal[] = [
      {
        path: "src/auth.ts",
        action: "modify",
        edits: [{ oldText: "const timeout = 5000;", newText: "const timeout = 10000;" }],
        description: "Update timeout",
      },
      {
        path: "src/new.ts",
        action: "create",
        content: "new",
        description: "New file",
      },
      {
        path: "src/delete-me.ts",
        action: "delete",
        content: "",
        description: "Delete file",
        isDeleted: true,
      },
    ];

    const result = resolveGenerationProposals(proposals, fileContext);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.expectedSourceHashes).toBeDefined();
      expect(Object.keys(result.expectedSourceHashes)).toEqual(["src/auth.ts"]);
      expect(result.expectedSourceHashes["src/auth.ts"]).toHaveLength(64);
    }
  });
});
