import { applyPatchToFile, FilePatchEdit, PatchResult } from "../patch/PatchApplicator";

describe("PatchApplicator — Deterministic Search/Replace Patch Engine", () => {
  // ── TEST A: Simple single-line replacement ──────────────────────────────
  test("TEST A: Simple single-line replacement", () => {
    const original = `const timeout = 5000;\nconst retries = 3;\n`;
    const edits: FilePatchEdit[] = [
      { oldText: "const timeout = 5000;", newText: "const timeout = 10000;" },
    ];

    const result = applyPatchToFile(original, edits);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.content).toBe(`const timeout = 10000;\nconst retries = 3;\n`);
      expect(result.appliedEdits).toBe(1);
    }
  });

  // ── TEST B: Multiline replacement ───────────────────────────────────────
  test("TEST B: Multiline replacement", () => {
    const original = [
      "function greet(name: string) {",
      '  return "Hello, " + name;',
      "}",
      "",
      "export default greet;",
    ].join("\n");

    const edits: FilePatchEdit[] = [
      {
        oldText: 'function greet(name: string) {\n  return "Hello, " + name;\n}',
        newText: 'function greet(name: string, greeting = "Hi") {\n  return `${greeting}, ${name}`;\n}',
      },
    ];

    const result = applyPatchToFile(original, edits);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.content).toBe(
        [
          'function greet(name: string, greeting = "Hi") {',
          "  return `${greeting}, ${name}`;",
          "}",
          "",
          "export default greet;",
        ].join("\n"),
      );
      expect(result.content).toContain("export default greet;");
    }
  });

  // ── TEST C: Multiple non-overlapping edits ──────────────────────────────
  test("TEST C: Multiple non-overlapping edits", () => {
    const original = [
      'const HOST = "localhost";',
      "const PORT = 3000;",
      'const DB = "postgres";',
    ].join("\n");

    const edits: FilePatchEdit[] = [
      { oldText: '"localhost"', newText: '"0.0.0.0"' },
      { oldText: "3000", newText: "8080" },
      { oldText: '"postgres"', newText: '"mysql"' },
    ];

    const result = applyPatchToFile(original, edits);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.content).toBe(
        ['const HOST = "0.0.0.0";', "const PORT = 8080;", 'const DB = "mysql";'].join("\n"),
      );
      expect(result.appliedEdits).toBe(3);
    }
  });

  // ── TEST D: Reverse-position safety ─────────────────────────────────────
  test("TEST D: Reverse-position safety with different replacement lengths", () => {
    const original = "AAA\nBBBBBBBBBB\nCCC\nDDDDDDDDDDDDDD\nEEE";
    const edits: FilePatchEdit[] = [
      { oldText: "AAA", newText: "A" }, // shorter replacement near top
      { oldText: "DDDDDDDDDDDDDD", newText: "DDDDDDDDDDDDDDDDDDDDDDDDDDDDD" }, // longer replacement near bottom
    ];

    const result = applyPatchToFile(original, edits);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.content).toBe("A\nBBBBBBBBBB\nCCC\nDDDDDDDDDDDDDDDDDDDDDDDDDDDDD\nEEE");
      // Verify untouched regions
      expect(result.content).toContain("BBBBBBBBBB");
      expect(result.content).toContain("CCC");
      expect(result.content).toContain("EEE");
    }
  });

  // ── TEST E: Target not found ────────────────────────────────────────────
  test("TEST E: PATCH_TARGET_NOT_FOUND when oldText is absent", () => {
    const original = "const x = 1;\nconst y = 2;\n";
    const edits: FilePatchEdit[] = [
      { oldText: "const z = 99;", newText: "const z = 100;" },
    ];

    const result = applyPatchToFile(original, edits);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("PATCH_TARGET_NOT_FOUND");
      expect(result.error.editIndex).toBe(0);
    }
  });

  // ── TEST F: Ambiguous target ────────────────────────────────────────────
  test("TEST F: AMBIGUOUS_PATCH_TARGET when oldText matches multiple locations", () => {
    const original = "foo();\nbar();\nfoo();\n";
    const edits: FilePatchEdit[] = [{ oldText: "foo();", newText: "baz();" }];

    const result = applyPatchToFile(original, edits);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("AMBIGUOUS_PATCH_TARGET");
      expect(result.error.editIndex).toBe(0);
    }
  });

  // ── TEST G: Overlapping edits ───────────────────────────────────────────
  test("TEST G: OVERLAPPING_PATCH_EDITS when source ranges overlap", () => {
    const original = "const value = computeResult(input);";
    const edits: FilePatchEdit[] = [
      { oldText: "value = computeResult", newText: "result = compute" },
      { oldText: "computeResult(input)", newText: "getResult(data)" },
    ];

    const result = applyPatchToFile(original, edits);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("OVERLAPPING_PATCH_EDITS");
    }
  });

  // ── TEST H: Empty oldText ───────────────────────────────────────────────
  test("TEST H: EMPTY_PATCH_TARGET when oldText is empty", () => {
    const original = "some content";
    const edits: FilePatchEdit[] = [{ oldText: "", newText: "inserted" }];

    const result = applyPatchToFile(original, edits);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("EMPTY_PATCH_TARGET");
      expect(result.error.editIndex).toBe(0);
    }
  });

  // ── TEST I: Empty edit list ─────────────────────────────────────────────
  test("TEST I: NO_PATCH_EDITS when edits array is empty", () => {
    const original = "some content";
    const edits: FilePatchEdit[] = [];

    const result = applyPatchToFile(original, edits);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("NO_PATCH_EDITS");
    }
  });

  // ── TEST J: No-op patch ─────────────────────────────────────────────────
  test("TEST J: NO_OP_PATCH_EDIT when oldText === newText", () => {
    const original = "const x = 1;";
    const edits: FilePatchEdit[] = [{ oldText: "const x = 1;", newText: "const x = 1;" }];

    const result = applyPatchToFile(original, edits);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("NO_OP_PATCH_EDIT");
      expect(result.error.editIndex).toBe(0);
    }
  });

  // ── TEST K: newText may be empty (targeted deletion) ────────────────────
  test("TEST K: newText empty performs targeted deletion within a file", () => {
    const original = "line1\nconsole.log(debugValue);\nline3\n";
    const edits: FilePatchEdit[] = [
      { oldText: "console.log(debugValue);\n", newText: "" },
    ];

    const result = applyPatchToFile(original, edits);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.content).toBe("line1\nline3\n");
      expect(result.appliedEdits).toBe(1);
    }
  });

  // ── TEST L: Full-file integrity ─────────────────────────────────────────
  test("TEST L: HEADER, MIDDLE, FOOTER remain exactly unchanged after patching", () => {
    const HEADER = "// === HEADER ===\nimport React from 'react';\n\n";
    const TARGET1 = "const DEFAULT_TIMEOUT = 5000;\n";
    const MIDDLE = "\n// === MIDDLE SECTION ===\nfunction helper() { return true; }\n\n";
    const TARGET2 = 'const API_URL = "http://localhost:3000";\n';
    const FOOTER = "\n// === FOOTER ===\nexport default { DEFAULT_TIMEOUT, API_URL };\n";

    const original = HEADER + TARGET1 + MIDDLE + TARGET2 + FOOTER;

    const edits: FilePatchEdit[] = [
      { oldText: "const DEFAULT_TIMEOUT = 5000;", newText: "const DEFAULT_TIMEOUT = 10000;" },
      { oldText: 'const API_URL = "http://localhost:3000";', newText: 'const API_URL = "https://api.production.com";' },
    ];

    const result = applyPatchToFile(original, edits);

    expect(result.success).toBe(true);
    if (result.success) {
      // Verify untouched regions are byte-for-byte identical
      expect(result.content).toContain(HEADER);
      expect(result.content).toContain(MIDDLE);
      expect(result.content).toContain(FOOTER);

      // Verify edits applied
      expect(result.content).toContain("const DEFAULT_TIMEOUT = 10000;");
      expect(result.content).toContain('const API_URL = "https://api.production.com";');

      // Verify old text is gone
      expect(result.content).not.toContain("const DEFAULT_TIMEOUT = 5000;");
      expect(result.content).not.toContain('"http://localhost:3000"');
    }
  });

  // ── TEST M: Determinism ─────────────────────────────────────────────────
  test("TEST M: Same inputs produce identical output across multiple invocations", () => {
    const original = "alpha\nbeta\ngamma\n";
    const edits: FilePatchEdit[] = [{ oldText: "beta", newText: "BETA_REPLACED" }];

    const results: PatchResult[] = [];
    for (let i = 0; i < 10; i++) {
      results.push(applyPatchToFile(original, edits));
    }

    for (const r of results) {
      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.content).toBe("alpha\nBETA_REPLACED\ngamma\n");
      }
    }
  });

  // ── TEST N: No mutation ─────────────────────────────────────────────────
  test("TEST N: Input edits array and edit objects are not mutated", () => {
    const original = "const x = 1;\nconst y = 2;\n";
    const edits: FilePatchEdit[] = [
      { oldText: "const x = 1;", newText: "const x = 99;" },
      { oldText: "const y = 2;", newText: "const y = 88;" },
    ];

    // Deep copy to compare afterwards
    const editsCopy = JSON.parse(JSON.stringify(edits));

    applyPatchToFile(original, edits);

    // Verify no mutation
    expect(edits).toEqual(editsCopy);
    expect(edits.length).toBe(2);
    expect(edits[0].oldText).toBe("const x = 1;");
    expect(edits[0].newText).toBe("const x = 99;");
    expect(edits[1].oldText).toBe("const y = 2;");
    expect(edits[1].newText).toBe("const y = 88;");
  });

  // ── TEST O: CRLF preservation ───────────────────────────────────────────
  test("TEST O: CRLF line endings are preserved exactly in untouched regions", () => {
    const original = "line1\r\ntarget_value\r\nline3\r\nline4\r\n";
    const edits: FilePatchEdit[] = [
      { oldText: "target_value", newText: "replaced_value" },
    ];

    const result = applyPatchToFile(original, edits);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.content).toBe("line1\r\nreplaced_value\r\nline3\r\nline4\r\n");
      // Verify CRLF is preserved exactly
      const crlfCount = (result.content.match(/\r\n/g) || []).length;
      expect(crlfCount).toBe(4);
    }
  });
});
