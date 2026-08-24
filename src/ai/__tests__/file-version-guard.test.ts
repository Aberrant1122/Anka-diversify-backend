import {
  sha256,
  verifyExpectedFileVersions,
  verifyFileVersionsFromDisk,
} from "../validation/FileVersionGuard";
import fs from "fs";
import path from "path";
import os from "os";

describe("FileVersionGuard — Stale Source / File Version Protection Tests", () => {
  // ── TEST A: Matching hash passes ─────────────────────────────────────────
  test("TEST A: Matching hash passes validation", () => {
    const sourceContent = "const value = 1;\n";
    const expectedHashes = {
      "src/config.ts": sha256(sourceContent),
    };
    const currentFiles = {
      "src/config.ts": sourceContent,
    };

    const result = verifyExpectedFileVersions(expectedHashes, currentFiles);

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.verifiedFiles).toBe(1);
    }
  });

  // ── TEST B: Changed file rejects with STALE_SOURCE_FILE ──────────────────
  test("TEST B: Changed file rejects with STALE_SOURCE_FILE", () => {
    const originalContent = "const value = 1;\n";
    const modifiedContent = "const value = 2;\n";

    const expectedHashes = {
      "src/config.ts": sha256(originalContent),
    };
    const currentFiles = {
      "src/config.ts": modifiedContent,
    };

    const result = verifyExpectedFileVersions(expectedHashes, currentFiles);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error.code).toBe("STALE_SOURCE_FILE");
      expect(result.error.path).toBe("src/config.ts");
      expect(result.error.expectedHashPrefix).toBe(sha256(originalContent).slice(0, 12));
      expect(result.error.actualHashPrefix).toBe(sha256(modifiedContent).slice(0, 12));
    }
  });

  // ── TEST C: Unrelated file change still rejects ──────────────────────────
  test("TEST C: Unrelated file change still rejects even if patch target is untouched", () => {
    const originalContent = "function target() {}\nconst unrelated = 1;\n";
    const changedContent = "function target() {}\nconst unrelated = 2;\n";

    const expectedHashes = {
      "src/app.ts": sha256(originalContent),
    };
    const currentFiles = {
      "src/app.ts": changedContent,
    };

    const result = verifyExpectedFileVersions(expectedHashes, currentFiles);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error.code).toBe("STALE_SOURCE_FILE");
      expect(result.error.path).toBe("src/app.ts");
    }
  });

  // ── TEST D: Line-ending change rejects ───────────────────────────────────
  test("TEST D: Line-ending change (CRLF vs LF) produces hash mismatch and rejects", () => {
    const crlfContent = "const x = 1;\r\nconst y = 2;\r\n";
    const lfContent = "const x = 1;\nconst y = 2;\n";

    const expectedHashes = {
      "src/format.ts": sha256(crlfContent),
    };
    const currentFiles = {
      "src/format.ts": lfContent,
    };

    const result = verifyExpectedFileVersions(expectedHashes, currentFiles);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error.code).toBe("STALE_SOURCE_FILE");
    }
  });

  // ── TEST E: Missing file rejects ─────────────────────────────────────────
  test("TEST E: Missing file rejects with SOURCE_FILE_DISAPPEARED", () => {
    const expectedHashes = {
      "src/missing.ts": sha256("some content"),
    };
    const currentFiles = {
      "src/missing.ts": null,
    };

    const result = verifyExpectedFileVersions(expectedHashes, currentFiles);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error.code).toBe("SOURCE_FILE_DISAPPEARED");
      expect(result.error.path).toBe("src/missing.ts");
    }
  });

  // ── TEST F: Multiple files all match ─────────────────────────────────────
  test("TEST F: Multiple files all matching passes with full count", () => {
    const fileA = "export const A = 1;\n";
    const fileB = "export const B = 2;\n";
    const fileC = "export const C = 3;\n";

    const expectedHashes = {
      "src/a.ts": sha256(fileA),
      "src/b.ts": sha256(fileB),
      "src/c.ts": sha256(fileC),
    };
    const currentFiles = {
      "src/a.ts": fileA,
      "src/b.ts": fileB,
      "src/c.ts": fileC,
    };

    const result = verifyExpectedFileVersions(expectedHashes, currentFiles);

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.verifiedFiles).toBe(3);
    }
  });

  // ── TEST G: One of multiple files mismatches (all-or-nothing) ─────────────
  test("TEST G: One mismatch among multiple files fails the entire validation", () => {
    const fileA = "export const A = 1;\n";
    const fileB = "export const B = 2;\n";
    const fileC = "export const C = 3;\n";
    const fileCChanged = "export const C = 999;\n";

    const expectedHashes = {
      "src/a.ts": sha256(fileA),
      "src/b.ts": sha256(fileB),
      "src/c.ts": sha256(fileC),
    };
    const currentFiles = {
      "src/a.ts": fileA,
      "src/b.ts": fileB,
      "src/c.ts": fileCChanged,
    };

    const result = verifyExpectedFileVersions(expectedHashes, currentFiles);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error.code).toBe("STALE_SOURCE_FILE");
      expect(result.error.path).toBe("src/c.ts");
    }
  });

  // ── TEST H: Windows/POSIX paths resolve canonically ──────────────────────
  test("TEST H: Windows/POSIX paths resolve canonically to one identity", () => {
    const content = "const auth = true;\n";
    const expectedHashes = {
      "src\\auth\\service.ts": sha256(content),
    };
    const currentFiles = {
      "src/auth/service.ts": content,
    };

    const result = verifyExpectedFileVersions(expectedHashes, currentFiles);

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.verifiedFiles).toBe(1);
    }
  });

  // ── TEST I: Deterministic hashes ─────────────────────────────────────────
  test("TEST I: Same exact content produces identical SHA-256 digest", () => {
    const str = "exact content string with special chars: { [ ( $ # @ ! \n \t";
    const h1 = sha256(str);
    const h2 = sha256(str);
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64);
  });

  // ── TEST J: No mutation of input metadata ────────────────────────────────
  test("TEST J: Resolver/guard does not mutate input metadata", () => {
    const expectedHashes = { "src/file.ts": sha256("test") };
    const currentFiles = { "src/file.ts": "test" };

    const expectedCopy = JSON.parse(JSON.stringify(expectedHashes));
    const currentCopy = JSON.parse(JSON.stringify(currentFiles));

    verifyExpectedFileVersions(expectedHashes, currentFiles);

    expect(expectedHashes).toEqual(expectedCopy);
    expect(currentFiles).toEqual(currentCopy);
  });

  // ── Disk-Reading Integration ─────────────────────────────────────────────
  test("verifyFileVersionsFromDisk: Reads actual files from bounded repository", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "file-version-guard-test-"));
    try {
      const filePath = path.join(tempDir, "src", "index.ts");
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, "console.log('hello');\n", "utf8");

      const expectedHashes = {
        "src/index.ts": sha256("console.log('hello');\n"),
      };

      const result = await verifyFileVersionsFromDisk(expectedHashes, tempDir);
      expect(result.valid).toBe(true);

      // Now modify the file on disk
      fs.writeFileSync(filePath, "console.log('modified');\n", "utf8");
      const staleResult = await verifyFileVersionsFromDisk(expectedHashes, tempDir);
      expect(staleResult.valid).toBe(false);
      if (!staleResult.valid) {
        expect(staleResult.error.code).toBe("STALE_SOURCE_FILE");
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
